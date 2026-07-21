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
let cases = spec.cases.filter((c) => only.length === 0 || only.includes(c.id))
const defaultTimeoutMs = (spec.defaults?.timeout_sec ?? 300) * 1000

// Expand sequence cases: a case with `steps` replaces `message` and produces
// one scored sub-entry per step, sharing the same session_id.
// Each step can be a string (message only) or an object with per-step assertions:
//   { message, must_call?, must_not_call?, expect_run?, timeout_sec? }
function resolveStep(case_, step, i) {
  const entry = {
    ...case_,
    _sessionId: `eval-${case_.id}`,
    _stepIndex: i,
    continue_chat: i > 0,
  }
  if (typeof step === 'string') {
    entry.message = step
  } else {
    entry.message = String(step.message ?? '')
    // Per-step assertions override top-level ones for this step
    if (step.must_call) entry.step_must_call = step.must_call
    if (step.must_not_call) entry.step_must_not_call = step.must_not_call
    if (step.expect_run !== undefined) entry.step_expect_run = step.expect_run
    // Per-step timeout (seconds), falls back to case-level then default
    if (step.timeout_sec) entry._timeoutMs = step.timeout_sec * 1000
  }
  if (!entry._timeoutMs && case_.timeout_sec) entry._timeoutMs = case_.timeout_sec * 1000
  if (!entry._timeoutMs) entry._timeoutMs = defaultTimeoutMs
  return entry
}

function expandCase(original) {
  if (!Array.isArray(original.steps) || original.steps.length === 0) {
    return [{ ...original, _sessionId: `eval-${original.id}` }]
  }
  return original.steps.map((step, i) => resolveStep(original, step, i))
}
cases = cases.flatMap(expandCase)

async function managerChat(message, projectId, sessionId, continueChat, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs || defaultTimeoutMs)
  try {
    const resp = await fetch(`${baseUrl}/api/manager/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        session_id: sessionId,
        continue_chat: continueChat,
        message,
      }),
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
  // Per-step assertions
  for (const name of c.step_must_call ?? []) {
    if (!toolCalls.includes(name)) failures.push(`missing step-required tool call: ${name}`)
  }
  for (const name of c.step_must_not_call ?? []) {
    if (toolCalls.includes(name)) failures.push(`step called forbidden tool: ${name}`)
  }
  if (c.step_expect_run === true && !runId) failures.push('step expected a run_id but none was returned')
  if (c.step_expect_run === false && runId) failures.push(`step should not start a run but got run_id=${runId}`)
  return { toolCalls, runId, failures, pass: failures.length === 0 }
}

const results = []
for (const c of cases) {
  const startedAt = Date.now()
  const stepLabel = c._stepIndex !== undefined ? `[${c.id} step ${c._stepIndex + 1}]` : `[${c.id}]`
  process.stdout.write(`${stepLabel} ${c.message.slice(0, 50)} ... `)
  try {
    const data = await managerChat(c.message, c._sessionId, c._sessionId, c.continue_chat ?? false, c._timeoutMs)
    const scored = scoreCase(c, data)
    if (scored.runId) await stopRun(scored.runId)
    results.push({
      id: c.id,
      step: c._stepIndex ?? 0,
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
      step: c._stepIndex ?? 0,
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
