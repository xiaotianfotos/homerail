import { describe, expect, it } from 'vitest'
import { buildDeclarativeRendererModel } from './declarative-renderer'

describe('declarative Renderer interpreter', () => {
  it('renders bounded text, record lists, metrics, and only safe links', () => {
    const model = buildDeclarativeRendererModel({
      renderer_version: 1,
      type: 'card',
      title_pointer: '/title',
      subtitle_pointer: '/summary',
      sections: [{
        id: 'entries', type: 'list', pointer: '/entries', item_title_pointer: '/title',
        item_detail_pointer: '/detail', item_badge_pointer: '/status', max_items: 2,
      }, {
        id: 'metrics', type: 'metrics', items: [{ label: 'Coverage', pointer: '/coverage', format: 'percent' }],
      }, {
        id: 'links', type: 'links', pointer: '/links', item_label_pointer: '/label', item_uri_pointer: '/url',
      }],
    }, {
      title: 'Release notes',
      summary: 'Safe declarative content.',
      entries: [
        { title: 'Added', detail: 'Plugin PDK', status: 'new' },
        { title: 'Fixed', detail: 'Fallback', status: 'done' },
        { title: 'Hidden by max', detail: 'third' },
      ],
      coverage: 87.5,
      links: [
        { label: 'Release', url: 'https://example.com/release' },
        { label: 'Attack', url: 'javascript:alert(1)' },
      ],
    })
    expect(model).toMatchObject({
      title: 'Release notes',
      sections: [
        { type: 'list', items: [{ title: 'Added' }, { title: 'Fixed' }] },
        { type: 'metrics', items: [{ label: 'Coverage', value: '87.5%' }] },
        { type: 'links', items: [{ label: 'Release', uri: 'https://example.com/release' }] },
      ],
    })
  })

  it('rejects duplicate sections and missing readable titles', () => {
    expect(() => buildDeclarativeRendererModel({
      renderer_version: 1,
      type: 'card',
      title_pointer: '/title',
      sections: [
        { id: 'same', type: 'text', pointer: '/one' },
        { id: 'same', type: 'text', pointer: '/two' },
      ],
    }, { title: 'Card' })).toThrow(/duplicate section/)
    expect(() => buildDeclarativeRendererModel({
      renderer_version: 1,
      type: 'card',
      title_pointer: '/title',
      sections: [{ id: 'summary', type: 'text', pointer: '/summary' }],
    }, {})).toThrow(/title pointer/)
  })
})
