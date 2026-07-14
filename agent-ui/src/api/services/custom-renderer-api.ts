import { http } from '@/api/clients/http-client'

export interface CustomRendererSourceReferenceV1 {
  plugin_id: string
  plugin_version: string
  manifest_digest: string
  renderer_id: string
  file: string
  digest: string
}

export interface CustomRendererSourceV1 extends CustomRendererSourceReferenceV1 {
  bridge_api: 1
  renderer_api: 1
  media_type: 'text/javascript'
  content: string
}

const SOURCE_KEYS = [
  'bridge_api',
  'renderer_api',
  'plugin_id',
  'plugin_version',
  'manifest_digest',
  'renderer_id',
  'file',
  'digest',
  'media_type',
  'content',
] as const

export function normalizeCustomRendererSource(
  value: unknown,
  expected: CustomRendererSourceReferenceV1,
): CustomRendererSourceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid custom Renderer source response')
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  if (keys.join('\0') !== [...SOURCE_KEYS].sort().join('\0')) {
    throw new Error('Invalid custom Renderer source response fields')
  }
  if (
    candidate.bridge_api !== 1
    || candidate.renderer_api !== 1
    || candidate.media_type !== 'text/javascript'
    || candidate.plugin_id !== expected.plugin_id
    || candidate.plugin_version !== expected.plugin_version
    || candidate.manifest_digest !== expected.manifest_digest
    || candidate.renderer_id !== expected.renderer_id
    || candidate.file !== expected.file
    || candidate.digest !== expected.digest
    || typeof candidate.content !== 'string'
    || !candidate.content.trim()
  ) {
    throw new Error('Custom Renderer source identity mismatch')
  }
  return structuredClone(candidate) as unknown as CustomRendererSourceV1
}

export async function getCustomRendererSource(
  reference: CustomRendererSourceReferenceV1,
): Promise<CustomRendererSourceV1> {
  const response = await http.get<unknown>(
    `/api/plugins/renderers/${encodeURIComponent(reference.plugin_id)}/${encodeURIComponent(reference.renderer_id)}/source`,
    {
      params: {
        plugin_version: reference.plugin_version,
        digest: reference.digest,
      },
    },
  )
  return normalizeCustomRendererSource(response.data, reference)
}
