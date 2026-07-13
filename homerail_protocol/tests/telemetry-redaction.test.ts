import { describe, expect, it } from "vitest";
import { redactTelemetry } from "../src/telemetry-redaction.js";

describe("telemetry redaction", () => {
  it("redacts nested secret fields and credentials embedded in text", () => {
    const redacted = redactTelemetry({
      api_key: "secret-field-value",
      nested: {
        HOMERAIL_WORKER_TOKEN: "worker-control-plane-secret",
        HOMERAIL_NODE_TOKEN: "node-control-plane-secret",
        message: "Authorization: Bearer bearer-secret-123456 token=query-secret-value",
        url: "https://user:password-value@example.test/path",
      },
      output: "sk-outputsecret12345",
    });
    const text = JSON.stringify(redacted);

    expect(text).not.toContain("secret-field-value");
    expect(text).not.toContain("worker-control-plane-secret");
    expect(text).not.toContain("node-control-plane-secret");
    expect(text).not.toContain("bearer-secret-123456");
    expect(text).not.toContain("query-secret-value");
    expect(text).not.toContain("password-value");
    expect(text).not.toContain("sk-outputsecret12345");
    expect(text).toContain("***REDACTED***");
  });

  it("redacts control-plane token keys in serialized JSON text", () => {
    const redacted = redactTelemetry(
      '{"env":{"HOMERAIL_WORKER_TOKEN":"worker-secret","HOMERAIL_NODE_TOKEN":"node-secret"}}',
    );

    expect(redacted).not.toContain("worker-secret");
    expect(redacted).not.toContain("node-secret");
    expect(redacted).toContain("***REDACTED***");
  });
});
