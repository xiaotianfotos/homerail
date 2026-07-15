import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const args = process.argv.slice(2)

function option(name, fallback = '') {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const uiRoot = path.resolve(scriptDir, '..')
const reportPath = path.resolve(option('--report'))
const outputDir = path.resolve(option(
  '--output',
  path.join(uiRoot, 'test-results', 'three-worker-showcase'),
))

assert(option('--report'), '--report is required')

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForServer(url, logs) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Vite did not become ready: ${lastError}; logs=${logs.join('')}`)
}

async function installRoutes(page, snapshot) {
  await page.route('**/api/runs/**/live-surfaces', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, message: 'real showcase snapshot', data: snapshot }),
  }))
  await page.route('**/api/runs/**/actors/**/surface-history**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      message: 'no history requested by the compact acceptance view',
      data: { run_id: snapshot.run_id, actor_id: '', generation_state: 'current', total: 0, history: [] },
    }),
  }))
}

async function canvasDiagnostics(page) {
  return page.evaluate(() => ({
    url: location.href,
    state: document.querySelector('[data-testid="dag-task-canvas"]')?.getAttribute('data-state') ?? 'missing',
    resolved: document.querySelector('[data-testid="dag-task-canvas"]')?.getAttribute('data-resolved') ?? 'missing',
    node_count: document.querySelectorAll('[data-generative-ui-node]').length,
    renderer_count: document.querySelectorAll('.homerail-a2ui').length,
    body_text: document.body.innerText.slice(0, 500),
  }))
}

async function waitForCanvas(page, label) {
  const failures = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.locator('[data-state="ready"]').waitFor({ timeout: 20_000 })
      await page.waitForFunction(() => document.querySelectorAll('[data-generative-ui-node]').length === 3)
      await page.waitForFunction(() => document.querySelectorAll('.homerail-a2ui').length === 3)
      return attempt
    } catch (error) {
      failures.push({
        attempt,
        error: error instanceof Error ? error.message : String(error),
        diagnostics: await canvasDiagnostics(page),
      })
      if (attempt === 2) break
      await page.screenshot({ path: path.join(outputDir, `${label}-ready-timeout.png`) })
      await page.reload({ waitUntil: 'domcontentloaded' })
    }
  }
  throw new Error(`${label} canvas did not become ready: ${JSON.stringify(failures)}`)
}

async function metrics(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#app')
    const blocks = [...document.querySelectorAll('[data-generative-ui-node]')]
    return {
      viewport: { width: innerWidth, height: innerHeight },
      node_ids: blocks.map(block => block.getAttribute('data-generative-ui-node')),
      block_count: blocks.length,
      block_boxes: blocks.map(block => {
        const box = block.getBoundingClientRect()
        return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
      }),
      root_client_width: root?.clientWidth ?? 0,
      root_scroll_width: root?.scrollWidth ?? 0,
      document_overflow_x: document.documentElement.scrollWidth - innerWidth,
      document_overflow_y: document.documentElement.scrollHeight - innerHeight,
      internal_vertical_scrollers: blocks.filter(block => {
        const body = block.querySelector('.generative-ui-node-host__body')
        return body && body.scrollHeight > body.clientHeight + 2
      }).length,
    }
  })
}

async function renderDesktop(browser, baseUrl, snapshot, evidence) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await installRoutes(page, snapshot)
  await page.goto(
    `${baseUrl}/task-canvas-harness.html?run_id=${encodeURIComponent(snapshot.run_id)}`,
    { waitUntil: 'domcontentloaded' },
  )
  const initialReadyAttempt = await waitForCanvas(page, 'desktop-initial')
  await page.waitForTimeout(350)
  const beforeRefresh = await metrics(page)
  assert(beforeRefresh.block_count === 3, 'Desktop did not render exactly three Blocks')
  assert(beforeRefresh.document_overflow_x === 0, 'Desktop document overflows horizontally')
  assert(beforeRefresh.document_overflow_y === 0, 'Desktop document overflows vertically')
  await page.screenshot({ path: path.join(outputDir, 'desktop-1920x1080.png') })

  await page.reload({ waitUntil: 'domcontentloaded' })
  const refreshReadyAttempt = await waitForCanvas(page, 'desktop-refresh')
  await page.waitForTimeout(350)
  const afterRefresh = await metrics(page)
  assert(
    JSON.stringify(afterRefresh.node_ids) === JSON.stringify(beforeRefresh.node_ids),
    'Browser refresh changed the three stable Surface ids',
  )
  await page.screenshot({ path: path.join(outputDir, 'desktop-after-refresh.png') })
  assert(pageErrors.length === 0, `Desktop page errors: ${pageErrors.join('; ')}`)
  evidence.desktop = {
    before_refresh: beforeRefresh,
    after_refresh: afterRefresh,
    ready_attempts: { initial: initialReadyAttempt, refresh: refreshReadyAttempt },
    page_errors: pageErrors,
  }
  await context.close()
}

async function renderMobile(browser, baseUrl, snapshot, evidence) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await installRoutes(page, snapshot)
  await page.goto(
    `${baseUrl}/task-canvas-harness.html?run_id=${encodeURIComponent(snapshot.run_id)}`,
    { waitUntil: 'domcontentloaded' },
  )
  const readyAttempt = await waitForCanvas(page, 'mobile')
  await page.waitForTimeout(350)
  const compact = await metrics(page)
  assert(compact.block_count === 3, 'Mobile did not render exactly three Blocks')
  assert(compact.document_overflow_x === 0, 'Mobile document overflows horizontally')
  assert(compact.document_overflow_y === 0, 'Mobile document overflows vertically')
  assert(compact.root_scroll_width > compact.root_client_width * 2.5, 'Mobile does not expose the three-Block horizontal rail')
  await page.screenshot({ path: path.join(outputDir, 'mobile-390x844.png') })

  const first = page.locator('[data-generative-ui-node]').first()
  await first.locator('.generative-ui-node-host__expand').tap()
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node]')?.getAttribute('data-expanded') === 'true'
  ))
  const expanded = await first.boundingBox()
  assert(expanded && expanded.width >= 370 && expanded.height >= 820, 'Mobile fullscreen is not viewport sized')
  await page.screenshot({ path: path.join(outputDir, 'mobile-fullscreen.png') })
  assert(pageErrors.length === 0, `Mobile page errors: ${pageErrors.join('; ')}`)
  evidence.mobile = { compact, expanded, ready_attempt: readyAttempt, page_errors: pageErrors }
  await context.close()
}

const rawReport = JSON.parse(await fs.readFile(reportPath, 'utf8'))
const snapshot = rawReport.surface_snapshot ?? rawReport.evidence?.surface_snapshot
assert(snapshot?.document?.nodes, 'Acceptance report does not contain surface_snapshot.document.nodes')
assert(snapshot.document.nodes.length === 3, 'Acceptance snapshot must contain exactly three current Surface nodes')
assert(
  snapshot.document.nodes.every(node => node.presentation?.canvas_size === '1x2'),
  'Every showcase Surface must explicitly use canvas_size 1x2',
)

await fs.mkdir(outputDir, { recursive: true })
const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const vitePath = path.join(uiRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
const logs = []
const vite = spawn(vitePath, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: uiRoot,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
vite.stdout.on('data', chunk => logs.push(chunk.toString()))
vite.stderr.on('data', chunk => logs.push(chunk.toString()))

let browser
const evidence = {
  report: path.basename(reportPath),
  run_id: snapshot.run_id,
  surface_ids: snapshot.document.nodes.map(node => node.id),
}
try {
  await waitForServer(`${baseUrl}/task-canvas-harness.html`, logs)
  browser = await chromium.launch({ headless: true })
  await renderDesktop(browser, baseUrl, snapshot, evidence)
  await renderMobile(browser, baseUrl, snapshot, evidence)
  await fs.writeFile(path.join(outputDir, 'metrics.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
}
