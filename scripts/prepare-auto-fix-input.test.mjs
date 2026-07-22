import assert from "node:assert/strict";
import test from "node:test";

import { prepareAutoFixInput } from "./prepare-auto-fix-input.mjs";

function event(overrides = {}) {
  return {
    action: "labeled",
    sender: { login: "xiaotianfotos" },
    label: { name: "auto-fix" },
    issue: {
      number: 42,
      title: "Repair this regression",
      body: "Reproduction details",
      comments: 1,
      labels: [{ name: "bug" }, { name: "auto-fix" }],
    },
    repository: {
      full_name: "xiaotianfotos/homerail",
      clone_url: "https://github.com/xiaotianfotos/homerail.git",
      default_branch: "main",
      owner: { login: "xiaotianfotos" },
    },
    ...overrides,
  };
}

test("builds bounded untrusted issue evidence from an owner label event", async () => {
  const calls = [];
  const prepared = await prepareAutoFixInput({
    event: event(),
    revision: "a".repeat(40),
    githubRepository: "xiaotianfotos/homerail",
    token: "job-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => [{ user: { login: "member" }, body: "context" }] };
    },
  });
  assert.equal(prepared.issue, 42);
  assert.equal(prepared.revision, "a".repeat(40));
  assert.deepEqual(prepared.discussion, [{ author: "member", body: "context" }]);
  assert.match(calls[0].url, /\/repos\/xiaotianfotos\/homerail\/issues\/42\/comments\?per_page=100&page=1$/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer job-token");
  assert.equal(JSON.stringify(prepared).includes("job-token"), false);
});

test("rejects unauthorized actors, PRs, and a wrong label", async () => {
  const common = {
    revision: "b".repeat(40),
    githubRepository: "xiaotianfotos/homerail",
    token: "job-token",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
  };
  await assert.rejects(() => prepareAutoFixInput({ ...common, event: event({ sender: { login: "someone" } }) }), /Only xiaotianfotos/);
  await assert.rejects(() => prepareAutoFixInput({ ...common, event: event({ label: { name: "bug" } }) }), /exact auto-fix label/);
  await assert.rejects(
    () => prepareAutoFixInput({ ...common, event: event({ issue: { ...event().issue, pull_request: {} } }) }),
    /not pull requests/,
  );
});
