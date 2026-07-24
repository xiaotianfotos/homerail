interface CodexThreadLease {
  owner: string;
  release: () => void;
}

const activeLeases = new Map<string, string>();

export function acquireCodexThreadLease(sessionId: string, owner: string): CodexThreadLease | null {
  const key = sessionId.trim();
  if (!key) throw new Error("Codex thread lease requires a session id");
  if (activeLeases.has(key)) return null;
  activeLeases.set(key, owner);
  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      released = true;
      if (activeLeases.get(key) === owner) activeLeases.delete(key);
    },
  };
}

export function codexThreadLeaseOwner(sessionId: string): string | undefined {
  return activeLeases.get(sessionId.trim());
}

export function _clearCodexThreadLeasesForTest(): void {
  activeLeases.clear();
}
