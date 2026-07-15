import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('the Showcase remains an explicit asset rather than a Manager or Skill intent route', () => {
  const forbiddenProductSources = [
    'skills/homerail-dag-ops/SKILL.md',
    'homerail_protocol/src/manager-agent-tools.ts',
    'homerail_manager/src/server/host-codex-manager-agent.ts',
  ]
  for (const relative of forbiddenProductSources) {
    const source = read(relative)
    assert.doesNotMatch(source, /three-worker-game-copilot/i, relative)
    assert.doesNotMatch(source, /game[- ]copilot.*(?:route|routing|select)/i, relative)
  }
})

test('the real-model adapter is manual-only and keeps secrets outside the repository', () => {
  const workflow = read('.github/workflows/three-worker-showcase.yml')
  const eventBlock = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'))
  assert.match(eventBlock, /workflow_dispatch:/)
  assert.doesNotMatch(eventBlock, /pull_request:|push:/)
  assert.match(workflow, /secrets\.HOMERAIL_PATTERN_MODEL_BASE_URL/)
  assert.doesNotMatch(workflow, /api[_-]?key:\s*['"]?sk-/i)
  assert.match(workflow, /validate:three-worker-showcase-runner/)
})

test('the scenario has no total expiry and the live adapter uses the public idle TTL', () => {
  const asset = read('assets/orchestrations/three-worker-game-copilot.yaml.template')
  const runner = read('scripts/run-dag-patterns-live-runner.sh')
  const showcaseRunner = runner.slice(
    runner.indexOf('if [ "$LIVE_TASK" = "three-worker-showcase" ]; then', runner.indexOf('SETTING_ID=')),
    runner.indexOf('if [ "$LIVE_TASK" = "pr-review" ]; then'),
  )
  assert.doesNotMatch(asset, /expires_after_ms/)
  assert.match(runner, /HOMERAIL_DAG_WORKER_IDLE_TTL_MS/)
  assert.match(showcaseRunner, /--phase prepare/)
  assert.match(showcaseRunner, /--phase resume/)
  assert.match(showcaseRunner, /--restart-evidence/)
  assert.doesNotMatch(showcaseRunner, /--workflow-suffix/)
  assert.match(showcaseRunner, /runtime restart[\s\\]+\n[\s\S]*--manager-only/)
  assert.match(showcaseRunner, /test:three-worker-showcase-visual/)
})
