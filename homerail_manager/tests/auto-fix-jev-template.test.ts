import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const load = (name: string) => parse(fs.readFileSync(path.join(root, `assets/orchestrations/${name}.yaml.template`), "utf8"));

it("keeps the generated Jev variant current and preserves every acceptance gate", () => {
  const check = spawnSync(process.execPath, [path.join(root, "scripts/generate-auto-fix-jev-template.mjs"), "--check"], { encoding: "utf8" });
  expect(check.status, check.stderr).toBe(0);
  const base = load("auto-fix-v2"), jev = load("auto-fix-jev");
  expect(jev.metadata.id).toBe("auto-fix-jev");
  expect(jev.metadata.labels.experimental).toBe("true");
  expect(jev.spec.edges).toEqual(base.spec.edges);
  expect(jev.spec.policies).toEqual(base.spec.policies);
  expect(jev.spec.artifacts).toEqual(base.spec.artifacts);
  expect(jev.spec.agents.reviewer).toEqual(base.spec.agents.reviewer);
  const fix = jev.spec.nodes.fix;
  expect(fix.config.worker_policy.credentials.filter((c: any) => c.credential_ref === "jev-autofix"))
    .toEqual([{ credential_ref: "jev-autofix", purpose: "experimental factual advice before repair",
      inject: { mode: "manager_broker", broker: "typesafe", allowed_actions: ["system_one"] } }]);
  fix.config.worker_policy.credentials = fix.config.worker_policy.credentials.filter((c: any) => c.credential_ref !== "jev-autofix");
  fix.config.result_required_broker_actions = fix.config.result_required_broker_actions.filter((c: any) => c.credential_ref !== "jev-autofix");
  expect(jev.spec.nodes).toEqual(base.spec.nodes);
  delete jev.spec.contracts.FixResult.properties.jev_advice;
  jev.spec.contracts.FixResult.required = jev.spec.contracts.FixResult.required.filter((v: string) => v !== "jev_advice");
  expect(jev.spec.contracts).toEqual(base.spec.contracts);
});
