import { describe, expect, it } from "vitest";
import { e2eFixCiProbeSum } from "../src/runtime/e2e-fix-ci-probe.js";
describe("controlled E2E CI fault probe; never merge fixture into main", () => {
  it("adds positive values", () => expect(e2eFixCiProbeSum(2, 3)).toBe(5));
  it("CI-only contract: preserves negative signed sums", () => expect(e2eFixCiProbeSum(-2, -3)).toBe(-5));
});
