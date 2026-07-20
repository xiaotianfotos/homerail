import { describe, expect, it } from 'vitest'

import { dockerWorkspaceGuidance, readableDockerWorkspaceError } from './docker-workspace-status'

describe('Docker workspace guidance', () => {
  it('does not add guidance before probing or after success', () => {
    expect(dockerWorkspaceGuidance(null)).toBeNull()
    expect(dockerWorkspaceGuidance({ available: true, host_path: '/workspace' })).toBeNull()
  })

  it('prompts installation when no Docker-capable Node can be started', () => {
    expect(dockerWorkspaceGuidance({
      available: false,
      host_path: '/workspace',
      code: 'docker_node_unavailable',
      error: 'No connected docker-capable node available',
    })).toBe('install')
  })

  it('distinguishes a stopped daemon from a permission problem', () => {
    expect(dockerWorkspaceGuidance({
      available: false,
      host_path: '/workspace',
      error: 'Cannot connect to the Docker daemon. Is Docker running?',
    })).toBe('start')
    expect(dockerWorkspaceGuidance({
      available: false,
      host_path: '/workspace',
      error: 'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the daemon is running: The system cannot find the file specified.',
    })).toBe('start')
    expect(dockerWorkspaceGuidance({
      available: false,
      host_path: '/workspace',
      code: 'docker_daemon_unavailable',
      error: 'Docker Desktop engine is unavailable',
    })).toBe('start')
    expect(dockerWorkspaceGuidance({
      available: false,
      host_path: '/workspace',
      error: 'permission denied while trying to connect to the Docker daemon; add the user to the docker group',
    })).toBe('permission')
  })

  it('extracts plain API error objects without rendering object Object', () => {
    expect(readableDockerWorkspaceError({
      message: 'Manager mutation Origin is not trusted',
      code: 403,
    }, 'Docker check unavailable')).toBe('Manager mutation Origin is not trusted')
    expect(readableDockerWorkspaceError({
      error: { message: 'Docker daemon is unavailable' },
    }, 'Docker check unavailable')).toBe('Docker daemon is unavailable')
    expect(readableDockerWorkspaceError({}, 'Docker check unavailable')).toBe('Docker check unavailable')
  })
})
