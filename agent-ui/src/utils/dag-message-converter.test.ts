import { describe, expect, it } from 'vitest'
import { convertDagMessages } from './dag-message-converter'

describe('convertDagMessages', () => {
  it('pairs a tool result with its tool call by tool-use id', () => {
    const messages = convertDagMessages([
      {
        role: 'assistant',
        type: 'tool_use',
        content: '',
        message_id: 'tool-1',
        tool_name: 'handoff',
        tool_input: { port: 'done' },
      },
      {
        role: 'assistant',
        type: 'tool_result',
        content: '',
        message_id: 'tool-1',
        tool_name: 'tool_result',
        tool_result: 'accepted',
      },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'tool-1', status: 'success' })
    expect(messages[0]?.tool_calls?.[0]).toMatchObject({
      id: 'tool-1',
      name: 'handoff',
      status: 'success',
      result: { text: 'accepted' },
    })
  })

  it('pairs id-less results with same-name tool calls in FIFO order', () => {
    const messages = convertDagMessages([
      {
        role: 'assistant',
        type: 'tool_use',
        content: '',
        message_id: 'tool-1',
        tool_name: 'handoff',
        tool_input: { port: 'first' },
      },
      {
        role: 'assistant',
        type: 'tool_use',
        content: '',
        message_id: 'tool-2',
        tool_name: 'handoff',
        tool_input: { port: 'second' },
      },
      {
        role: 'assistant',
        type: 'tool_result',
        content: '',
        tool_name: 'handoff',
        tool_result: 'first accepted',
      },
      {
        role: 'assistant',
        type: 'tool_result',
        content: '',
        tool_name: 'handoff',
        tool_result: 'second accepted',
      },
    ])

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: 'tool-1', status: 'success' })
    expect(messages[0]?.tool_calls?.[0]).toMatchObject({
      id: 'tool-1',
      status: 'success',
      result: { text: 'first accepted' },
    })
    expect(messages[1]).toMatchObject({ id: 'tool-2', status: 'success' })
    expect(messages[1]?.tool_calls?.[0]).toMatchObject({
      id: 'tool-2',
      status: 'success',
      result: { text: 'second accepted' },
    })
  })
})
