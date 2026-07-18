import { http, type ApiResponse } from '@/api/clients/http-client'

export interface DetectedManagerSkill {
  id: string
  name: string
  description: string
  relative_path: string
  source: 'home' | 'repo'
  enabled: true
}

export interface DetectedManagerSkillCatalog {
  skills: DetectedManagerSkill[]
  total: number
  root: string
}

/** Read-only catalog of static SKILL.md assets; plugin-projected Skills are excluded. */
export function listDetectedManagerSkills(): Promise<ApiResponse<DetectedManagerSkillCatalog>> {
  return http.get<DetectedManagerSkillCatalog>('/api/skills?local_only=1')
}
