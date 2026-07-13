#!/usr/bin/env node
/**
 * Manager Agent eval runner.
 *
 * For each case in cases.yaml, sends one chat turn to the Manager Agent
 * (POST /api/manager/chat) and scores the response against the case's
 * expectations (expect_run / must_call / must_not_call).
 *
 * Usage:
 *   node evals/manager-agent/run-eval.mjs [--only <id[,id...]>] [--base-url <url>] [--json <out.json>]
 *
 * Notes:
 * - Cases that legitimately start DAG runs use profile-less create_and_run;
 *   runs are NOT awaited — this eval scores planning behavior, not DAG output.
 *   Started runs are stopped afterwards to keep the machine quiet.
 * - Each case uses a fresh session (no continue_chat), so cases are independent.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const require_ = createRequire(path.join(repoRoot, 'homerail_manager', 'package.json'))
const YAML = require_('yaml')

const args = process.argv.slice(2)
function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}
const baseUrl = argValue('--base-url') || process.env.HOMERAIL_MANAGER_URL || 'http://localhost:19191'
const only = (argValue('--only') || '').split(',').map((s) => s.trim()).filter(Boolean)
const jsonOut = argValue('--json')

const spec = YAML.parse(fs.readFileSync(path.join(here, 'cases.yaml'), 'utf8'))
const cases = spec.cases.filter((c) => only.length === 0 || only.includes(c.id))
const timeoutMs = (spec.defaults?.timeout_sec ?? 300) * 1000

async function managerChat(message, projectId) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${baseUrl}/api/manager/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, message }),
      signal: controller.signal,
    })
    const body = await resp.json()
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 300)}`)
    return body.data ?? body
  } finally {
    clearTimeout(timer)
  }
}

async function stopRun(runId) {
  try {
    await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' })
  } catch { /* best effort */ }
}

function normalizeToolName(raw) {
  // Harnesses may prefix tool names (e.g. Claude SDK MCP: "mcp__dag-tools__create_and_run").
  const name = String(raw ?? '')
  const parts = name.split('__')
  return parts[parts.length - 1] || name
}

function scoreCase(c, data) {
  const toolCalls = Array.isArray(data?.tool_calls)
    ? data.tool_calls
        .map((t) => (t && typeof t === 'object' ? normalizeToolName(t.name) : ''))
        .filter(Boolean)
    : []
  const runId = typeof data?.run_id === 'string' && data.run_id ? data.run_id : null
  const failures = []

  if (c.expect_run === true && !runId) failures.push('expected a run_id but none was returned')
  if (c.expect_run === false && runId) failures.push(`should not start a run but got run_id=${runId}`)
  for (const name of c.must_call ?? []) {
    if (!toolCalls.includes(name)) failures.push(`missing required tool call: ${name}`)
  }
  for (const name of c.must_not_call ?? []) {
    if (toolCalls.includes(name)) failures.push(`called forbidden tool: ${name}`)
  }
  return { toolCalls, runId, failures, pass: failures.length === 0 }
}

const results = []
for (const c of cases) {
  const startedAt = Date.now()
  process.stdout.write(`[${c.id}] ${c.message.slice(0, 50)} ... `)
  try {
    const data = await managerChat(c.message, `eval-${c.id}`)
    const scored = scoreCase(c, data)
    if (scored.runId) await stopRun(scored.runId)
    results.push({
      id: c.id,
      category: c.category,
      pass: scored.pass,
      failures: scored.failures,
      tool_calls: scored.toolCalls,
      run_id: scored.runId,
      elapsed_ms: Date.now() - startedAt,
      text: typeof data?.text === 'string' ? data.text.slice(0, 400) : '',
    })
    console.log(scored.pass ? 'PASS' : `FAIL (${scored.failures.join('; ')})`)
  } catch (err) {
    results.push({
      id: c.id,
      category: c.category,
      pass: false,
      failures: [`error: ${err instanceof Error ? err.message : String(err)}`],
      tool_calls: [],
      run_id: null,
      elapsed_ms: Date.now() - startedAt,
      text: '',
    })
    console.log(`ERROR (${err instanceof Error ? err.message : err})`)
  }
}

const byCategory = {}
for (const r of results) {
  byCategory[r.category] ??= { pass: 0, total: 0 }
  byCategory[r.category].total += 1
  if (r.pass) byCategory[r.category].pass += 1
}
const passed = results.filter((r) => r.pass).length

console.log('\n=== Manager Agent Eval Summary ===')
for (const [cat, s] of Object.entries(byCategory)) {
  console.log(`  ${cat.padEnd(8)} ${s.pass}/${s.total}`)
}
console.log(`  TOTAL    ${passed}/${results.length}`)

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    base_url: baseUrl,
    summary: { passed, total: results.length, by_category: byCategory },
    results,
  }, null, 2))
  console.log(`\nReport written to ${jsonOut}`)
}

process.exitCode = passed === results.length ? 0 : 1
