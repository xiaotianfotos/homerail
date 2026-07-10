import type { CodexModel } from '@/api/agent'

export interface CodexOptionView {
  value: string
  label: string
  description: string
}

const reasoningLabels: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

const reasoningDescriptions: Record<string, string> = {
  minimal: 'Minimal reasoning for the fastest responses',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
  max: 'Maximum reasoning depth for the hardest problems',
  ultra: 'Maximum reasoning with automatic task delegation'
}

function findModel(models: CodexModel[], modelName: string | null | undefined): CodexModel | undefined {
  return models.find(model => model.model === modelName || model.id === modelName)
}

function fallbackModel(model: string): CodexModel {
  return {
    id: model,
    model,
    display_name: model,
    description: '',
    is_default: false,
    default_reasoning_effort: '',
    supported_reasoning_efforts: [],
    service_tiers: []
  }
}

export function resolveCodexModelOptions(
  models: CodexModel[],
  currentModel: string | null | undefined,
  catalogLoaded: boolean
): CodexModel[] {
  if (catalogLoaded) return [...models]
  return currentModel ? [fallbackModel(currentModel)] : []
}

export function resolveSelectedCodexModel(
  models: CodexModel[],
  currentModel: string | null | undefined
): string {
  if (currentModel) return currentModel
  return models.find(model => model.is_default)?.model || models[0]?.model || ''
}

export function isCodexModelUnavailable(
  models: CodexModel[],
  currentModel: string | null | undefined,
  catalogLoaded: boolean
): boolean {
  return Boolean(
    catalogLoaded &&
    currentModel &&
    !models.some(model => model.model === currentModel)
  )
}

export function resolveCodexReasoningEffortOptions(
  models: CodexModel[],
  modelName: string | null | undefined,
  currentEffort: string | null | undefined
): CodexOptionView[] {
  const model = findModel(models, modelName)
  const efforts = model?.supported_reasoning_efforts?.length
    ? model.supported_reasoning_efforts
    : currentEffort
      ? [currentEffort]
      : ['low']
  const advertisedDescriptions = new Map(
    (model?.reasoning_effort_options ?? []).map(option => [option.reasoning_effort, option.description])
  )
  return efforts.map(effort => ({
    value: effort,
    label: reasoningLabels[effort] ?? effort,
    description: advertisedDescriptions.get(effort) || reasoningDescriptions[effort] || ''
  }))
}

export function resolveCodexReasoningEffortForModel(
  models: CodexModel[],
  modelName: string,
  currentEffort: string | null | undefined
): string {
  const model = findModel(models, modelName)
  const supported = model?.supported_reasoning_efforts ?? []
  if (currentEffort && (!supported.length || supported.includes(currentEffort))) return currentEffort
  if (model?.default_reasoning_effort && supported.includes(model.default_reasoning_effort)) {
    return model.default_reasoning_effort
  }
  if (supported.includes('medium')) return 'medium'
  return supported[0] || currentEffort || 'low'
}

export function resolveCodexServiceTierOptions(
  models: CodexModel[],
  modelName: string | null | undefined
): CodexOptionView[] {
  const model = findModel(models, modelName)
  return [
    { value: '', label: 'Standard', description: 'Standard speed and usage' },
    ...(model?.service_tiers ?? []).map(tier => ({
      value: tier.id,
      label: tier.name,
      description: tier.description
    }))
  ]
}

export function resolveCodexServiceTierForModel(
  models: CodexModel[],
  modelName: string,
  currentServiceTier: string | null | undefined
): string | null {
  if (!currentServiceTier) return null
  const model = findModel(models, modelName)
  return model?.service_tiers.some(tier => tier.id === currentServiceTier)
    ? currentServiceTier
    : null
}
