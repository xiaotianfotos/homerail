import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('the live acceptance remains explicit rather than a Manager or built-in Skill intent route', () => {
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
  assert.equal(
    fs.existsSync(path.join(root, 'assets/orchestrations/three-worker-game-copilot.yaml.template')),
    false,
  )
})

test('the real-model adapter is manual-only and keeps secrets outside the repository', () => {
  const workflow = read('.github/workflows/three-worker-showcase.yml')
  const eventBlock = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'))
  assert.match(eventBlock, /workflow_dispatch:/)
  assert.doesNotMatch(eventBlock, /pull_request:|push:/)
  assert.match(eventBlock, /asset_path:[\s\S]*required: true/)
  assert.match(eventBlock, /mission:[\s\S]*required: true/)
  assert.match(workflow, /secrets\.HOMERAIL_PATTERN_MODEL_BASE_URL/)
  assert.doesNotMatch(workflow, /api[_-]?key:\s*['"]?sk-/i)
  assert.match(workflow, /validate:three-worker-showcase-runner/)
})

test('the live adapter requires an external asset and uses the public idle TTL', () => {
  const runner = read('scripts/run-dag-patterns-live-runner.sh')
  const showcaseRunner = runner.slice(
    runner.indexOf('if [ "$LIVE_TASK" = "three-worker-showcase" ]; then', runner.indexOf('SETTING_ID=')),
    runner.indexOf('if [ "$LIVE_TASK" = "pr-review" ]; then'),
  )
  assert.match(runner, /HOMERAIL_SHOWCASE_ASSET must name an external Workflow file/)
  assert.match(runner, /HOMERAIL_SHOWCASE_PROMPT is required/)
  assert.match(runner, /HOMERAIL_SHOWCASE_REQUIRED_TERMS is required/)
  assert.match(runner, /--required-surface-terms/)
  assert.match(runner, /HOMERAIL_DAG_WORKER_IDLE_TTL_MS/)
  assert.match(showcaseRunner, /--asset "\$SHOWCASE_ASSET"/)
  assert.match(showcaseRunner, /--phase prepare/)
  assert.match(showcaseRunner, /--phase resume/)
  assert.match(showcaseRunner, /--restart-evidence/)
  assert.doesNotMatch(showcaseRunner, /--workflow-suffix/)
  assert.match(showcaseRunner, /runtime restart[\s\\]+\n[\s\S]*--manager-only/)
  assert.match(showcaseRunner, /test:three-worker-showcase-visual/)
})

test('the visual harness renders the real accepted run identity', () => {
  const harness = read('agent-ui/src/task-canvas-harness.ts')
  const visual = read('agent-ui/scripts/three-worker-showcase-visual.mjs')
  assert.match(harness, /URLSearchParams\(window\.location\.search\).*run_id/)
  assert.match(visual, /run_id=\$\{encodeURIComponent\(snapshot\.run_id\)\}/)
  assert.doesNotMatch(visual, /run_id=run%3Avisual/)
})

test('the live validator consumes supervision cursors through the authenticated mutation boundary', () => {
  const validator = read('scripts/validate-three-worker-showcase.mjs')
  const start = validator.indexOf('async function fetchSupervisionDigest')
  const end = validator.indexOf('\nfunction compactRound', start)
  const supervision = validator.slice(start, end)

  assert.match(supervision, /\/supervision`,\s*\{\s*method: "POST"/)
  assert.match(supervision, /body: JSON\.stringify\(\{ consumer_id: consumerId, max_milestones: 12 \}\)/)
  assert.doesNotMatch(supervision, /supervision\?consumer_id=/)
})
