import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import SkillSettings from './SkillSettings.vue'

const listDetectedManagerSkills = vi.fn()

vi.mock('@/api/services/skill-catalog-api', () => ({
  listDetectedManagerSkills: (...args: unknown[]) => listDetectedManagerSkills(...args),
}))

let app: App<Element> | null = null
let root: HTMLElement | null = null

async function mount(): Promise<HTMLElement> {
  listDetectedManagerSkills.mockResolvedValue({
    success: true,
    data: {
      total: 2,
      root: '/home/test/.homerail/skills',
      skills: [{
        id: 'homerail-cli',
        name: 'homerail-cli',
        description: 'Operate HomeRail through its local CLI.',
        relative_path: 'skills/homerail-cli/SKILL.md',
        source: 'home',
        enabled: true,
      }, {
        id: 'palquery',
        name: 'palquery',
        description: '查询幻兽帕鲁资料和配种路线。',
        relative_path: 'skills/palquery/SKILL.md',
        source: 'home',
        enabled: true,
      }],
    },
  })
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(SkillSettings)
  app.use(i18n)
  app.mount(root)
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
  return root
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
  vi.clearAllMocks()
})

describe('SkillSettings', () => {
  it('renders a read-only static catalog using SKILL.md front matter metadata', async () => {
    const mounted = await mount()

    expect(listDetectedManagerSkills).toHaveBeenCalledOnce()
    expect(mounted.querySelector('[data-testid="agent-settings-skills-count"]')?.textContent)
      .toContain('2')
    expect(mounted.textContent).toContain('Operate HomeRail through its local CLI.')
    expect(mounted.textContent).toContain('查询幻兽帕鲁资料和配种路线。')
    expect(mounted.textContent).toContain('/home/test/.homerail/skills')
    expect(mounted.querySelector('input[type="file"]')).toBeNull()
    expect(mounted.querySelector('[data-testid^="agent-settings-skill-delete-"]')).toBeNull()
  })
})
