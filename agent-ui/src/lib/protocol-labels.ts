export type ProtocolId =
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'dashscope_native'
  | 'volcengine_doubao_voice'
  | 'volcengine_ark_voice'
  | 'volcengine_openspeech'
  | 'custom'

type Translate = (key: string) => string

// API and product names remain untranslated; vendor-specific labels use locale resources.
const TECHNICAL_PROTOCOL_LABELS: Record<string, string> = {
  openai_compatible: 'Chat Completions',
  anthropic_compatible: 'Anthropic',
  dashscope_native: 'DashScope',
}

const PLAN_LABEL_KEYS: Record<string, string> = {
  api_billing: 'settings.models.plans.apiBilling',
  token_plan: 'settings.models.plans.tokenPlan',
  coding_plan: 'settings.models.plans.codingPlan',
  agent_plan: 'settings.models.plans.agentPlan',
  subscription: 'settings.models.plans.subscription',
}

const PROTOCOL_LABEL_KEYS: Record<string, string> = {
  volcengine_doubao_voice: 'settings.models.protocols.volcengineVoice',
  volcengine_ark_voice: 'settings.models.protocols.volcengineOpenSpeech',
  volcengine_openspeech: 'settings.models.protocols.volcengineOpenSpeech',
  custom: 'settings.models.protocols.custom',
}

export function createProtocolLabels(t: Translate) {
  function planLabel(plan?: string): string {
    return t(PLAN_LABEL_KEYS[plan ?? ''] ?? 'settings.models.plans.custom')
  }

  function protocolLabel(protocol?: string): string {
    if (!protocol) return '—'
    const technicalLabel = TECHNICAL_PROTOCOL_LABELS[protocol]
    if (technicalLabel) return technicalLabel
    const key = PROTOCOL_LABEL_KEYS[protocol]
    return key ? t(key) : protocol
  }

  return { planLabel, protocolLabel }
}
