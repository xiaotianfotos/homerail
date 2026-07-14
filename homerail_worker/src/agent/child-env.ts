/**
 * Keep Manager-wide authority in the Worker control plane. Agent runtimes and
 * agent-invoked shells receive provider credentials they need, but never the
 * credential that can mutate every Manager API.
 */
export function sanitizedAgentChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source };
  delete env.HOMERAIL_MANAGER_ADMIN_TOKEN;
  delete env.HOMERAIL_PLUGIN_CAPABILITY_SECRET;
  return env;
}
