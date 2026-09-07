function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function envelopeInputValueToTaskText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return stableJson(value);
  } catch {
    return String(value);
  }
}

export function envelopeInputsToTaskText(inputs: unknown): string {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return "";
  const sections: string[] = [];
  for (const [port, rawValues] of Object.entries(inputs as Record<string, unknown>)) {
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    for (const value of values) {
      const text = envelopeInputValueToTaskText(value).trim();
      if (!text) continue;
      sections.push(`## input:${port}\n${text}`);
    }
  }
  return sections.join("\n\n");
}

export function envelopeOutputContractsToSystemPrompt(outputContracts: unknown): string {
  if (!outputContracts || typeof outputContracts !== "object" || Array.isArray(outputContracts)) return "";
  if (Object.keys(outputContracts as Record<string, unknown>).length === 0) return "";
  return [
    "DAG output contracts are trusted control-plane instructions.",
    "Before calling handoff, select one declared port and make content match that port's JSON Schema exactly.",
    "Put contract fields only inside content. Do not add aliases or undeclared fields.",
    `Exact output contracts by port: ${stableJson(outputContracts)}`,
  ].join("\n");
}
