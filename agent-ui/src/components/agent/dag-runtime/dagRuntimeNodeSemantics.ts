import type { DAGGatewayConfig } from '@/api/types/dag.types'

export type DagRuntimeNodeShape =
  | 'circle'
  | 'diamond'
  | 'hexagon'
  | 'rounded-rect'
  | 'octagon'
  | 'square'
  | 'triangle'
  | 'capsule'

export type DagRuntimeNodeKind =
  | 'worker'
  | 'condition'
  | 'join'
  | 'quorum'
  | 'command'
  | 'approval'
  | 'state'
  | 'fanout'
  | 'loop'
  | 'await'
  | 'control'

export interface DagRuntimeNodeSemantic {
  kind: DagRuntimeNodeKind
  shape: DagRuntimeNodeShape
  label: string
  glyph: string
  isWorker: boolean
}

const WORKER: DagRuntimeNodeSemantic = {
  kind: 'worker',
  shape: 'circle',
  label: 'WORKER',
  glyph: '',
  isWorker: true
}

/**
 * Resolve visual meaning from the runtime contract, never from a node's name.
 * Names such as `revision_gate` are user-controlled and therefore cannot be a
 * reliable source of execution semantics.
 */
export function resolveDagRuntimeNodeSemantic(
  nodeType: string | undefined,
  gatewayConfig?: DAGGatewayConfig
): DagRuntimeNodeSemantic {
  switch (nodeType) {
    case undefined:
    case '':
    case 'agent':
    case 'task':
      return WORKER
    case 'condition_gateway':
      return { kind: 'condition', shape: 'diamond', label: 'GATE', glyph: '?', isWorker: false }
    case 'join_gateway':
      return gatewayConfig?.mode === 'n_of_m'
        ? {
            kind: 'quorum',
            shape: 'hexagon',
            label: 'QUORUM',
            glyph: quorumGlyph(gatewayConfig),
            isWorker: false
          }
        : { kind: 'join', shape: 'hexagon', label: 'JOIN', glyph: '\u2229', isWorker: false }
    case 'command_gateway':
      return {
        kind: 'command',
        shape: 'rounded-rect',
        label: 'COMMAND',
        glyph: '>_',
        isWorker: false
      }
    case 'approval_gateway':
      return {
        kind: 'approval',
        shape: 'octagon',
        label: 'APPROVAL',
        glyph: '\u2713',
        isWorker: false
      }
    case 'state_gateway':
      return { kind: 'state', shape: 'square', label: 'STATE', glyph: '{}', isWorker: false }
    case 'fanout_gateway':
      return {
        kind: 'fanout',
        shape: 'triangle',
        label: 'FAN-OUT',
        glyph: '\u2197',
        isWorker: false
      }
    case 'loop_gateway':
    case 'while_gateway':
      return { kind: 'loop', shape: 'capsule', label: 'LOOP', glyph: '\u21bb', isWorker: false }
    case 'await_command_gateway':
      return { kind: 'await', shape: 'capsule', label: 'WAIT', glyph: '\u2016', isWorker: false }
    default:
      if (nodeType?.endsWith('_gateway')) {
        return {
          kind: 'control',
          shape: 'rounded-rect',
          label: 'CONTROL',
          glyph: '\u2699',
          isWorker: false
        }
      }
      return WORKER
  }
}

function quorumGlyph(config: DAGGatewayConfig): string {
  const threshold = typeof config.threshold === 'number' ? config.threshold : undefined
  return threshold === undefined ? 'Q' : `${threshold}/n`
}
