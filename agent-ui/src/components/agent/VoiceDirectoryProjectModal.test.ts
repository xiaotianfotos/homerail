import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import VoiceDirectoryProjectModal from './VoiceDirectoryProjectModal.vue'

const apiMocks = vi.hoisted(() => ({
  browseProjectDirectories: vi.fn(),
  createProject: vi.fn(),
  listGitServerRepos: vi.fn(),
  listGitServers: vi.fn(),
  listProjectDirectoryRoots: vi.fn(),
}))

vi.mock('@/api/agent', () => ({
  browseProjectDirectories: apiMocks.browseProjectDirectories,
  createProject: apiMocks.createProject,
  listGitServerRepos: apiMocks.listGitServerRepos,
  listGitServers: apiMocks.listGitServers,
  listProjectDirectoryRoots: apiMocks.listProjectDirectoryRoots,
}))

describe('VoiceDirectoryProjectModal directory roots', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null
  let fullscreenHost: HTMLElement | null = null
  let fullscreenElement: Element | null = null
  let originalFullscreenDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    originalFullscreenDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    })
    i18n.global.locale.value = 'zh-Hans'
    apiMocks.listProjectDirectoryRoots.mockResolvedValue({
      data: {
        servers: [{ id: 'manager', name: 'Manager', kind: 'manager', can_browse: true }],
        roots: [{
          id: 'project:existing',
          name: '真实项目',
          path: '/work/existing',
          writable: true,
        }],
        default_path: '/home/tester',
      },
    })
    apiMocks.listGitServers.mockResolvedValue({ data: { servers: [] } })
    apiMocks.browseProjectDirectories.mockImplementation(async ({ path }: { path: string }) => ({
      data: {
        server_id: 'manager',
        path,
        parent: '/',
        writable: true,
        is_git_repo: false,
        entries: [],
      },
    }))
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    fullscreenHost?.remove()
    fullscreenElement = null
    if (originalFullscreenDescriptor) {
      Object.defineProperty(document, 'fullscreenElement', originalFullscreenDescriptor)
    } else {
      delete (document as Document & { fullscreenElement?: Element | null }).fullscreenElement
    }
    app = null
    root = null
    fullscreenHost = null
  })

  it('starts from the runtime default and only renders persisted project directories', async () => {
    const open = ref(false)
    const Host = defineComponent({
      setup: () => () => h(VoiceDirectoryProjectModal, {
        open: open.value,
        'onUpdate:open': (value: boolean) => { open.value = value },
      }),
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Host)
    app.use(i18n)
    app.mount(root)

    open.value = true
    await nextTick()

    await vi.waitFor(() => {
      expect(apiMocks.browseProjectDirectories).toHaveBeenCalledWith({
        path: '/home/tester',
        server_id: 'manager',
        show_hidden: false,
        limit: 300,
      })
    })
    const overlay = document.body.querySelector<HTMLElement>('[data-testid="voice-directory-modal-overlay"]')
    expect(overlay).not.toBeNull()
    expect(overlay?.parentElement).toBe(document.body)
    expect(root.contains(overlay)).toBe(false)
    expect(overlay?.querySelector('[data-testid="voice-directory-existing-projects"]')?.textContent)
      .toContain('已有项目目录')
    expect(overlay?.querySelector('[data-testid="voice-directory-project-root"]')?.textContent)
      .toContain('真实项目')
    expect(overlay?.textContent).not.toContain('Macintosh HD')
    expect(overlay?.textContent).not.toContain('HomeRail Home')
    expect(overlay?.textContent).not.toContain('Default workspace')

    overlay?.querySelector<HTMLButtonElement>('[data-testid="voice-directory-project-root"]')!.click()
    await vi.waitFor(() => {
      expect(apiMocks.browseProjectDirectories).toHaveBeenLastCalledWith({
        path: '/work/existing',
        server_id: 'manager',
        show_hidden: false,
        limit: 300,
      })
    })
  })

  it('moves the modal into an element-level fullscreen host', async () => {
    const open = ref(true)
    const Host = defineComponent({
      setup: () => () => h(VoiceDirectoryProjectModal, {
        open: open.value,
        'onUpdate:open': (value: boolean) => { open.value = value },
      }),
    })
    fullscreenHost = document.createElement('div')
    fullscreenHost.dataset.testid = 'fullscreen-host'
    document.body.appendChild(fullscreenHost)
    fullscreenElement = fullscreenHost
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Host)
    app.use(i18n)
    app.mount(root)

    await nextTick()

    const overlay = document.querySelector<HTMLElement>(
      '[data-testid="voice-directory-modal-overlay"]'
    )
    expect(overlay).not.toBeNull()
    expect(overlay?.parentElement).toBe(fullscreenHost)
    expect(fullscreenHost.contains(overlay)).toBe(true)
    const overlayZIndex = Number(overlay?.className.match(/z-\[(\d+)\]/)?.[1])
    expect(overlayZIndex).toBeGreaterThan(170)
    expect(overlayZIndex).toBeLessThan(220)
  })

  it('tracks fullscreen entry and exit while the modal is open', async () => {
    const open = ref(true)
    const Host = defineComponent({
      setup: () => () => h(VoiceDirectoryProjectModal, {
        open: open.value,
        'onUpdate:open': (value: boolean) => { open.value = value },
      }),
    })
    fullscreenHost = document.createElement('div')
    document.body.appendChild(fullscreenHost)
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Host)
    app.use(i18n)
    app.mount(root)
    await nextTick()

    const overlay = document.querySelector<HTMLElement>(
      '[data-testid="voice-directory-modal-overlay"]'
    )
    expect(overlay?.parentElement).toBe(document.body)

    fullscreenElement = fullscreenHost
    document.dispatchEvent(new Event('fullscreenchange'))
    await nextTick()
    expect(overlay?.parentElement).toBe(fullscreenHost)

    fullscreenElement = null
    document.dispatchEvent(new Event('fullscreenchange'))
    await nextTick()
    expect(overlay?.parentElement).toBe(document.body)
  })
})
