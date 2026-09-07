import type { ToolProviderCatalog } from 'homerail-protocol'
import { http } from '../clients/http-client'

export async function getToolProviderCatalog(): Promise<ToolProviderCatalog> {
  const response = await http.get<ToolProviderCatalog>('/api/tool-providers')
  return response.data
}
