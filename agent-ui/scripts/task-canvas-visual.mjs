import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const baseUrl = process.env.TASK_CANVAS_BASE_URL || 'http://127.0.0.1:4177'
const outputDir = path.resolve('test-results/task-canvas-visual')
const baseTime = 1_789_000_000_000
const actors = ['build', 'research', 'verify']
const surface = {
  version: 'v1.0',
  catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1',
  components: [
    { id: 'root', component: 'Column', children: ['header', 'summary', 'progress', 'findings'] },
    { id: 'header', component: 'Row', children: ['title', 'status'], justify: 'spaceBetween', align: 'center' },
    { id: 'title', component: 'Text', text: { path: '/data/title' } },
    { id: 'status', component: 'HrStatusBadge', text: { path: '/data/state/label' }, tone: { path: '/data/state/tone' } },
    { id: 'summary', component: 'Text', text: { path: '/data/state/summary' }, variant: 'body' },
    { id: 'progress', component: 'HrProgress', value: { path: '/data/state/progress' }, tone: { path: '/data/state/tone' } },
    {
      id: 'findings',
      component: 'HrList',
      source: { path: '/data/findings' },
      maxItems: 14,
      itemTitlePath: '/title',
      itemDetailPath: '/detail',
    },
  ],
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function actorLabel(actor) {
  return actor === 'build' ? 'Implementation Worker'
    : actor === 'research' ? 'Research Worker'
      : 'Verification Worker'
}

function activityMeta(activity) {
  if (activity === 'completed') {
    return { phase: 'succeeded', label: 'Completed', tone: 'positive', progress: 100 }
  }
  if (activity === 'failed') {
    return { phase: 'failed', label: 'Failed', tone: 'critical', progress: 86 }
  }
  if (activity === 'finding') {
    return { phase: 'running', label: 'Finding evidence', tone: 'info', progress: 62 }
  }
  return { phase: 'running', label: 'In progress', tone: 'info', progress: 38 }
}

function modeSpecs(mode) {
  const specs = {
    build: { revision: 1, activity: 'progress', visibility: 'visible' },
    research: { revision: 2, activity: 'finding', visibility: 'visible' },
    verify: { revision: 3, activity: 'progress', visibility: 'visible' },
  }
  if (mode === 'focus') {
    specs.research = {
      revision: 4,
      activity: 'finding',
      visibility: 'focused',
      focusedUntil: Date.now() + 1800,
    }
  }
  if (mode === 'complete') {
    specs.build = { revision: 5, activity: 'completed', visibility: 'visible' }
    specs.research = { revision: 5, activity: 'progress', visibility: 'visible' }
  }
  if (mode === 'fail' || mode === 'remove') {
    specs.build = { revision: 5, activity: 'completed', visibility: 'visible' }
    specs.research = {
      revision: mode === 'remove' ? 6 : 5,
      activity: 'progress',
      visibility: mode === 'remove' ? 'removed' : 'visible',
    }
    specs.verify = { revision: 6, activity: 'failed', visibility: 'visible' }
  }
  return specs
}

function makeNode(actor, spec) {
  const meta = activityMeta(spec.activity)
  const actorIndex = actors.indexOf(actor)
  const updatedAt = baseTime + spec.revision * 100 + actorIndex
  const findings = Array.from({ length: actor === 'research' ? 14 : 11 }, (_, index) => ({
    id: actor + ':' + index,
    title: actor === 'build'
      ? 'Module ' + (index + 1) + ' compiled'
      : actor === 'research'
        ? 'Evidence source ' + (index + 1)
        : 'Scenario ' + (index + 1) + ' checked',
    detail: spec.activity === 'failed' && index === 0
      ? 'Viewport assertion needs attention'
      : 'Latest projector state is preserved',
  }))
  const summary = spec.activity === 'completed'
    ? 'All implementation checkpoints are complete.'
    : spec.activity === 'failed'
      ? 'Mobile viewport verification reported a blocking mismatch.'
      : actor === 'research'
        ? 'Comparing projector evidence and recovered activity history.'
        : actor === 'build'
          ? 'Applying the task canvas integration without interrupting other Blocks.'
          : 'Checking desktop, touch, reconnect, and motion behavior.'
  return {
    ir_version: 1,
    id: 'surface:' + actor,
    kind: 'com.homerail.core/generated_view',
    kind_version: 2,
    owner: { id: 'com.homerail.core', version: '0.1.0' },
    surface: 'execution',
    importance: spec.visibility === 'focused' ? 'critical' : 'primary',
    status: { phase: meta.phase, label: meta.label, progress: meta.progress },
    content: {
      data: {
        projector: { id: 'dag-live-surface-projector', version: 1 },
        actor: {
          id: actor,
          role: 'Worker',
          node_id: 'node:' + actor,
          generation: 1,
        },
        title: actorLabel(actor),
        state: {
          activity: spec.activity,
          visibility: spec.visibility,
          label: meta.label,
          summary,
          tone: meta.tone,
          progress: meta.progress,
          event_id: 'event:' + actor + ':' + spec.revision,
          round_id: 'round:visual',
          sequence: spec.revision,
          updated_at: updatedAt,
          surface_revision: spec.revision,
          ...(spec.focusedUntil === undefined ? {} : { focused_until: spec.focusedUntil }),
        },
        findings,
      },
    },
    a2ui: surface,
    presentation: {
      density: 'summary',
      canvas_size: '1x2',
      motion_profile: 'standard',
    },
    lifecycle: { persistence: 'session', removable: true },
    fallback: { title: actorLabel(actor), summary },
    provenance: { actor: 'agent', actor_id: actor, run_id: 'run:visual' },
    revision: spec.revision,
    updated_at: new Date(updatedAt).toISOString(),
  }
}

function makeProjection(actor, spec) {
  const actorIndex = actors.indexOf(actor)
  return {
    run_id: 'run:visual',
    actor_id: actor,
    node_id: 'node:' + actor,
    surface_id: 'surface:' + actor,
    document_id: 'document:run:visual',
    generation: 1,
    last_activity_sequence: spec.revision,
    journal_cursor: spec.revision,
    surface_revision: spec.revision,
    activity_state: spec.activity,
    visibility_state: spec.visibility,
    last_event_id: 'event:' + actor + ':' + spec.revision,
    ...(spec.focusedUntil === undefined ? {} : { focused_until: spec.focusedUntil }),
    created_at: baseTime,
    updated_at: baseTime + spec.revision * 100 + actorIndex,
  }
}

function makeSnapshot(mode) {
  const specs = modeSpecs(mode)
  const documentRevision = {
    initial: 3,
    focus: 4,
    complete: 5,
    fail: 6,
    remove: 7,
  }[mode]
  return {
    run_id: 'run:visual',
    projections: actors.map(actor => makeProjection(actor, specs[actor])),
    document: {
      ir_version: 1,
      document_id: 'document:run:visual',
      scope: { type: 'run', id: 'run:visual' },
      revision: documentRevision,
      nodes: actors.flatMap(actor => (
        specs[actor].visibility === 'removed' ? [] : [makeNode(actor, specs[actor])]
      )),
      updated_at: new Date(baseTime + documentRevision * 100).toISOString(),
    },
  }
}

async function installSnapshotRoute(page, initialMode, holdInitial = false) {
  const controller = {
    mode: initialMode,
    snapshot: makeSnapshot(initialMode),
    holdInitial,
    release: null,
  }
  let releaseGate
  const gate = new Promise(resolve => { releaseGate = resolve })
  controller.release = () => {
    controller.holdInitial = false
    releaseGate()
  }
  controller.setMode = mode => {
    controller.mode = mode
    controller.snapshot = makeSnapshot(mode)
  }
  await page.route('**/api/runs/**/live-surfaces', async route => {
    if (controller.holdInitial) await gate
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        message: 'visual fixture',
        data: controller.snapshot,
      }),
    })
  })
  return controller
}

async function waitForReady(page) {
  await page.locator('[data-state="ready"]').waitFor()
  await page.locator('[data-generative-ui-node]').first().waitFor()
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-generative-ui-node]').length === 3
  ))
  await page.waitForFunction(() => (
    document.querySelectorAll('.homerail-a2ui, .generative-ui-fallback--unavailable').length === 3
  ))
  const a2uiCount = await page.locator('.homerail-a2ui').count()
  const fallbackText = await page.locator('.generative-ui-fallback--unavailable').allTextContents()
  assert(
    a2uiCount === 3,
    'A2UI content did not render for all Workers; rendered=' + a2uiCount
      + '; fallback=' + JSON.stringify(fallbackText),
  )
  assert(fallbackText.length === 0, 'A Worker fell back to unavailable rendering')
}

async function screenshot(page, name) {
  await page.screenshot({
    path: path.join(outputDir, name),
    fullPage: false,
    animations: 'allow',
  })
}

async function layoutMetrics(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#app')
    const blocks = [...document.querySelectorAll('[data-generative-ui-node]')]
    const horizontalScrollers = [document.documentElement, document.body, ...document.querySelectorAll('*')]
      .filter(element => {
        const style = getComputedStyle(element)
        return element.scrollWidth > element.clientWidth + 2
          && (style.overflowX === 'auto' || style.overflowX === 'scroll')
      })
      .map(element => element.id ? '#' + element.id : '.' + [...element.classList].slice(0, 2).join('.'))
    return {
      viewport: { width: innerWidth, height: innerHeight },
      blockCount: blocks.length,
      blockWidths: blocks.map(block => Math.round(block.getBoundingClientRect().width)),
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      documentOverflowX: document.documentElement.scrollWidth - innerWidth,
      documentOverflowY: document.documentElement.scrollHeight - innerHeight,
      horizontalScrollers,
      internalVerticalScrollers: blocks.filter(block => {
        const body = block.querySelector('.generative-ui-node-host__body')
        return body && body.scrollHeight > body.clientHeight + 2
      }).length,
    }
  })
}

async function runDesktop(browser, evidence) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const controller = await installSnapshotRoute(page, 'initial', true)

  await page.goto(baseUrl + '/task-canvas-harness.html', { waitUntil: 'domcontentloaded' })
  await page.locator('[data-state="loading"]').waitFor()
  await screenshot(page, 'desktop-loading.png')
  await page.evaluate(() => {
    window.__taskCanvasTransitionClasses = []
    window.__taskCanvasTransitionObserver = new MutationObserver(records => {
      for (const record of records) {
        if (!(record.target instanceof HTMLElement)) continue
        const value = record.target.className
        if (typeof value === 'string' && value.includes('generative-ui-node-')) {
          window.__taskCanvasTransitionClasses.push(value)
        }
      }
    })
    window.__taskCanvasTransitionObserver.observe(document.querySelector('#app'), {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    })
  })
  controller.release()
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-generative-ui-node]').length === 3
  ))
  await page.waitForTimeout(32)
  const transitionClasses = await page.evaluate(() => window.__taskCanvasTransitionClasses)
  assert(
    transitionClasses.some(value => value.includes('generative-ui-node-enter-active')),
    'Initial Worker appearance transition was not observed: ' + JSON.stringify(transitionClasses),
  )
  await screenshot(page, 'desktop-enter.png')
  await waitForReady(page)
  await page.waitForTimeout(350)
  await screenshot(page, 'desktop-ready.png')

  const initialMetrics = await layoutMetrics(page)
  assert(initialMetrics.blockCount === 3, 'Desktop did not render three Worker Blocks')
  assert(initialMetrics.documentOverflowX === 0, 'Desktop page has horizontal overflow')
  assert(initialMetrics.documentOverflowY === 0, 'Desktop page has vertical overflow')
  assert(new Set(initialMetrics.blockWidths).size <= 2, 'Desktop Worker widths are inconsistent')

  controller.setMode('focus')
  const research = page.locator('[data-generative-ui-node="surface:research"]')
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node="surface:research"]')
      ?.getAttribute('data-lifecycle-motion') === 'update'
  ))
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node="surface:research"]')
      ?.getAttribute('data-attention') === 'true'
  ))
  assert(await research.getAttribute('aria-selected') === 'true', 'Manager focus did not restore selection')
  const focusStates = await page.locator('[data-generative-ui-node]').evaluateAll(blocks => (
    blocks.map(block => ({
      id: block.getAttribute('data-generative-ui-node'),
      className: block.className,
      opacity: getComputedStyle(block).opacity,
      visibility: getComputedStyle(block).visibility,
      left: Math.round(block.getBoundingClientRect().left),
      width: Math.round(block.getBoundingClientRect().width),
    }))
  ))
  assert(
    focusStates.every(state => Number(state.opacity) > 0.95 && state.visibility === 'visible'),
    'A focus update blanked a Worker Block: ' + JSON.stringify(focusStates),
  )
  await screenshot(page, 'desktop-update-focus.png')
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node="surface:research"]')
      ?.getAttribute('data-attention') === 'false'
  ), null, { timeout: 5000 })

  controller.setMode('complete')
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node="surface:build"]')
      ?.getAttribute('data-lifecycle-motion') === 'complete'
  ))
  await screenshot(page, 'desktop-complete.png')

  controller.setMode('fail')
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node="surface:verify"]')
      ?.getAttribute('data-lifecycle-motion') === 'fail'
  ))
  await screenshot(page, 'desktop-fail.png')

  const verify = page.locator('[data-generative-ui-node="surface:verify"]')
  await verify.locator('.generative-ui-node-host__expand').click()
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node="surface:verify"]')
      ?.getAttribute('data-expanded') === 'true'
  ))
  const expandedBox = await verify.boundingBox()
  assert(expandedBox && expandedBox.width > 1800 && expandedBox.height > 1000, 'Desktop fullscreen did not fill the viewport')
  await screenshot(page, 'desktop-fullscreen.png')
  await verify.locator('.generative-ui-node-host__expand').click()

  controller.setMode('remove')
  await page.locator('[data-generative-ui-node="surface:research"].generative-ui-node-leave-active').waitFor()
  await page.waitForTimeout(120)
  await screenshot(page, 'desktop-remove-exit.png')
  await page.locator('[data-generative-ui-node="surface:research"]').waitFor({ state: 'detached' })
  await page.waitForTimeout(350)
  const postRemoveStates = await page.locator('[data-generative-ui-node]').evaluateAll(blocks => (
    blocks.map(block => ({
      id: block.getAttribute('data-generative-ui-node'),
      left: Math.round(block.getBoundingClientRect().left),
      width: Math.round(block.getBoundingClientRect().width),
    }))
  ))
  assert(
    postRemoveStates.length === 2
      && postRemoveStates[0].left === 0
      && postRemoveStates[1].left - postRemoveStates[0].left
        <= postRemoveStates[0].width + 20,
    'Remaining Workers did not compact after removal: ' + JSON.stringify(postRemoveStates),
  )
  await screenshot(page, 'desktop-remove.png')
  assert(await page.locator('[aria-selected="true"]').count() === 1, 'Selection was not reconciled after removal')

  evidence.desktop = {
    initial: initialMetrics,
    afterRemoval: await layoutMetrics(page),
    focusStates,
    postRemoveStates,
    transitionClasses,
    pageErrors,
  }
  assert(pageErrors.length === 0, 'Desktop page errors: ' + pageErrors.join('; '))
  await context.close()
}

async function runMobile(browser, evidence) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await installSnapshotRoute(page, 'initial')
  await page.goto(baseUrl + '/task-canvas-harness.html', { waitUntil: 'domcontentloaded' })
  await waitForReady(page)
  await page.waitForTimeout(350)
  await page.locator('#app').evaluate(element => element.scrollTo({ left: 0, behavior: 'auto' }))
  await page.waitForTimeout(150)
  const build = page.locator('[data-generative-ui-node="surface:build"]')
  await build.click({ position: { x: 40, y: 80 } })
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node="surface:build"]')
      ?.getAttribute('aria-selected') === 'true'
  ))
  await screenshot(page, 'mobile-ready.png')

  const metrics = await layoutMetrics(page)
  assert(metrics.blockCount === 3, 'Mobile did not render three Worker Blocks')
  assert(metrics.rootScrollWidth > metrics.rootClientWidth * 2.5, 'Mobile does not expose the horizontal Worker rail')
  assert(metrics.documentOverflowX === 0, 'Mobile page has horizontal overflow')
  assert(metrics.documentOverflowY === 0, 'Mobile page has vertical overflow')
  assert(metrics.horizontalScrollers.length === 1 && metrics.horizontalScrollers[0] === '#app', 'Mobile has nested horizontal scrolling')
  assert(metrics.internalVerticalScrollers >= 1, 'Mobile Worker content does not own its vertical overflow')

  await build.locator('.generative-ui-node-host__expand').tap()
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node="surface:build"]')
      ?.getAttribute('data-expanded') === 'true'
  ))
  const expandedBox = await build.boundingBox()
  assert(expandedBox && expandedBox.width >= 370 && expandedBox.height >= 820, 'Mobile touch fullscreen is not viewport sized')
  await screenshot(page, 'mobile-fullscreen.png')
  await build.locator('.generative-ui-node-host__expand').tap()

  evidence.mobile = { metrics, pageErrors }
  assert(pageErrors.length === 0, 'Mobile page errors: ' + pageErrors.join('; '))
  await context.close()
}

async function runReducedMotion(browser, evidence) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const controller = await installSnapshotRoute(page, 'initial')
  await page.goto(baseUrl + '/task-canvas-harness.html', { waitUntil: 'domcontentloaded' })
  await waitForReady(page)
  assert(
    await page.locator('.generative-ui-surface-host').getAttribute('data-reduced-motion') === 'true',
    'Reduced-motion preference was not detected',
  )

  controller.setMode('focus')
  await page.waitForFunction(() => (
    document.querySelector('[data-generative-ui-node="surface:research"]')
      ?.getAttribute('data-attention') === 'true'
  ))
  const animationNames = await page.locator('[data-generative-ui-node="surface:research"]').evaluate(element => ({
    host: getComputedStyle(element).animationName,
    body: getComputedStyle(element.querySelector('.generative-ui-node-host__body')).animationName,
  }))
  assert(animationNames.host === 'none' && animationNames.body === 'none', 'Reduced motion still runs attention or update animation')
  await screenshot(page, 'reduced-motion-focus.png')

  controller.setMode('remove')
  const startedAt = Date.now()
  await page.locator('[data-generative-ui-node="surface:research"]').waitFor({ state: 'detached' })
  const removeDurationMs = Date.now() - startedAt
  assert(removeDurationMs < 500, 'Reduced-motion removal remained artificially delayed')
  evidence.reducedMotion = { animationNames, removeDurationMs }
  await context.close()
}

await fs.mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ headless: true })
const evidence = {}
try {
  await runDesktop(browser, evidence)
  await runMobile(browser, evidence)
  await runReducedMotion(browser, evidence)
  await fs.writeFile(
    path.join(outputDir, 'metrics.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  )
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
} finally {
  await browser.close()
}
