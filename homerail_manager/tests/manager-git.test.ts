import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { spawnManagerGitSync } from "../src/runtime/manager-git.js";

describe("Manager Git isolation", () => {
  let oldHome: string | undefined;
  let root: string;
  let repository: string;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-git-"));
    repository = path.join(root, "repo");
    fs.mkdirSync(repository);
    process.env.HOMERAIL_HOME = path.join(root, "homerail-home");
    expect(spawnSync("git", ["init", repository], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("git", ["-C", repository, "config", "core.hooksPath", "attacker-hooks"], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("git", ["-C", repository, "config", "core.fsmonitor", "attacker-monitor"], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("git", ["-C", repository, "config", "user.name", "HomeRail Test"], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("git", ["-C", repository, "config", "user.email", "homerail@example.invalid"], { encoding: "utf8" }).status).toBe(0);
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("overrides repository command hooks with Manager-owned safe settings", () => {
    const hooks = spawnManagerGitSync(repository, ["config", "--get", "core.hooksPath"]);
    const monitor = spawnManagerGitSync(repository, ["config", "--get", "core.fsmonitor"]);

    expect(hooks.status).toBe(0);
    expect(String(hooks.stdout).trim()).toBe(path.join(process.env.HOMERAIL_HOME!, "runtime", "disabled-git-hooks"));
    expect(monitor.status).toBe(0);
    expect(String(monitor.stdout).trim()).toBe("false");
  });

  it("does not inherit Git configuration injection variables", () => {
    const oldCount = process.env.GIT_CONFIG_COUNT;
    const oldKey = process.env.GIT_CONFIG_KEY_0;
    const oldValue = process.env.GIT_CONFIG_VALUE_0;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
    process.env.GIT_CONFIG_VALUE_0 = "injected-monitor";
    try {
      const result = spawnManagerGitSync(repository, ["config", "--get", "core.fsmonitor"]);
      expect(result.status).toBe(0);
      expect(String(result.stdout).trim()).toBe("false");
    } finally {
      if (oldCount === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = oldCount;
      if (oldKey === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = oldKey;
      if (oldValue === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = oldValue;
    }
  });

  it("prevents repository signing configuration from executing a local program", () => {
    const marker = path.join(root, "signer-executed");
    const payload = path.join(root, "attacker-signer.js");
    const signer = path.join(root, process.platform === "win32" ? "attacker-signer.cmd" : "attacker-signer.sh");
    fs.writeFileSync(payload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");process.exit(1);\n`);
    fs.writeFileSync(signer, process.platform === "win32"
      ? `@node "${payload.replace(/\\/g, "/")}" %*\r\n`
      : `#!/bin/sh\nnode ${JSON.stringify(payload)} "$@"\n`, { mode: 0o700 });
    expect(spawnSync("git", ["-C", repository, "config", "commit.gpgSign", "true"], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("git", ["-C", repository, "config", "gpg.program", signer], { encoding: "utf8" }).status).toBe(0);
    fs.writeFileSync(path.join(repository, "file.txt"), "safe\n");
    expect(spawnSync("git", ["-C", repository, "add", "--", "file.txt"], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("git", ["-C", repository, "commit", "-m", "unsafe commit"], { encoding: "utf8" }).status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);
    expect(spawnManagerGitSync(repository, ["add", "--", "file.txt"]).status).toBe(0);
    const committed = spawnManagerGitSync(repository, ["commit", "-m", "safe commit"]);

    expect(committed.status, String(committed.stderr)).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("restricts Manager network Git operations to HTTPS without credential helpers", () => {
    const marker = path.join(root, "credential-helper-executed");
    const helper = path.join(root, "attacker-credential-helper.js");
    fs.writeFileSync(helper, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");process.stdout.write("username=attacker\\npassword=attacker\\n");\n`);
    const helperCommand = `!node "${helper.replace(/\\/g, "/")}"`;
    expect(spawnSync("git", ["-C", repository, "config", "credential.helper", helperCommand], { encoding: "utf8" }).status).toBe(0);
    const input = "protocol=https\nhost=example.invalid\n\n";
    const unsafeCredential = spawnSync("git", ["-C", repository, "credential", "fill"], {
      encoding: "utf8",
      input,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    expect(unsafeCredential.status, String(unsafeCredential.stderr)).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);
    const protocol = spawnManagerGitSync(repository, ["config", "--get", "protocol.allow"]);
    const https = spawnManagerGitSync(repository, ["config", "--get", "protocol.https.allow"]);
    const credential = spawnManagerGitSync(repository, ["credential", "fill"], {
      input,
    });

    expect(String(protocol.stdout).trim()).toBe("never");
    expect(String(https.stdout).trim()).toBe("always");
    expect(credential.status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
