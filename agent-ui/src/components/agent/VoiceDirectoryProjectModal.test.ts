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

  beforeEach(() => {
    vi.clearAllMocks()
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
    app = null
    root = null
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
    expect(root.querySelector('[data-testid="voice-directory-existing-projects"]')?.textContent)
      .toContain('已有项目目录')
    expect(root.querySelector('[data-testid="voice-directory-project-root"]')?.textContent)
      .toContain('真实项目')
    expect(root.textContent).not.toContain('Macintosh HD')
    expect(root.textContent).not.toContain('HomeRail Home')
    expect(root.textContent).not.toContain('Default workspace')

    root.querySelector<HTMLButtonElement>('[data-testid="voice-directory-project-root"]')!.click()
    await vi.waitFor(() => {
      expect(apiMocks.browseProjectDirectories).toHaveBeenLastCalledWith({
        path: '/work/existing',
        server_id: 'manager',
        show_hidden: false,
        limit: 300,
      })
    })
  })
})
