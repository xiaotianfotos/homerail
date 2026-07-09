import type { CodexModel } from '@/api/agent'

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
