function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function runProgressFingerprint(status) {
  return JSON.stringify(canonicalize({
    status: status?.status ?? null,
    node_states: status?.node_states ?? {},
    counters: status?.counters ?? {},
  }));
}

export function observeRunProgress(previous, status, observedAt = Date.now()) {
  const fingerprint = runProgressFingerprint(status);
  if (!previous || previous.fingerprint !== fingerprint) {
    return { fingerprint, last_progress_at: observedAt };
  }
  return previous;
}
