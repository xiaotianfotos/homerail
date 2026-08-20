import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const helperScriptUrl = new URL("../../scripts/configure-apt-sources.mjs", import.meta.url);
const helperScriptPath = fileURLToPath(helperScriptUrl);
const workerRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

interface BuildSourcesHelperModule {
  DEFAULT_DEB822_SOURCES_PATH: string;
  APT_MAIN_MIRROR_ENV: string;
  APT_SECURITY_MIRROR_ENV: string;
  PRINT_ENV_FLAG: string;
  normalizeMirrorValue: (rawValue: unknown) => string | undefined;
  validateMirrorUrl: (rawValue: string, key: string) => string;
  normalizedEnvSource: (
    name: string,
    env: Record<string, string | undefined>,
  ) => string | undefined;
  applyDeb822SourceOverrides: (
    content: string,
    overrides?: { mainMirror?: string; securityMirror?: string },
  ) => { output: string; changed: boolean };
  runCli: (options?: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    readFile?: (sourcesPath: string) => string;
    writeFile?: (sourcesPath: string, output: string) => void;
    fail?: (message: string) => void;
    print?: (line: string) => void;
  }) => number;
}

// The runtime-owned ESM helper intentionally ships without TypeScript declarations.
// Keep the specifier relative so Vitest resolves it consistently on Windows and POSIX.
// @ts-expect-error -- the interface below is the test-side contract for this JavaScript module.
const helper = (await import("../../scripts/configure-apt-sources.mjs")) as BuildSourcesHelperModule;

const DEBIAN_SOURCES_FIXTURE = [
  "Types: deb",
  "URIs: http://deb.debian.org/debian",
  "Suites: bookworm bookworm-updates",
  "Components: main",
  "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
  "",
  "Types: deb",
  "URIs: http://deb.debian.org/debian-security",
  "Suites: bookworm-security",
  "Components: main",
  "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
  "",
].join("\n");

// Exact /etc/apt/sources.list.d/debian.sources snapshot shipped with the
// node:22-slim base image: the snapshot comments live inside active stanzas,
// so only blank lines may delimit stanzas and the comments must survive
// replacement byte for byte.
const NODE_SLIM_SNAPSHOT_MAIN_COMMENT = "# http://snapshot.debian.org/archive/debian/20260803T000000Z";
const NODE_SLIM_SNAPSHOT_SECURITY_COMMENT = "# http://snapshot.debian.org/archive/debian-security/20260803T000000Z";
const NODE_SLIM_DEB822_FIXTURE = [
  "Types: deb",
  NODE_SLIM_SNAPSHOT_MAIN_COMMENT,
  "URIs: http://deb.debian.org/debian",
  "Suites: bookworm bookworm-updates",
  "Components: main",
  "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
  "",
  "Types: deb",
  NODE_SLIM_SNAPSHOT_SECURITY_COMMENT,
  "URIs: http://deb.debian.org/debian-security",
  "Suites: bookworm-security",
  "Components: main",
  "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
  "",
].join("\n");

const MAIN_STANZA_SECURITY_BY = "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg";

function dockerfileStages(): { header: string; lines: string[] }[] {
  const chunks = dockerfile.split(/^FROM /m).slice(1);
  return chunks.map((chunk) => {
    const [header, ...rest] = chunk.split("\n");
    return { header: header ?? "", lines: rest };
  });
}

interface DockerRunInstruction {
  lineIndex: number;
  text: string;
}

function runInstructions(lines: string[]): DockerRunInstruction[] {
  const instructions: DockerRunInstruction[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^RUN(\s|$)/.test(lines[index])) continue;
    const parts: string[] = [];
    let cursor = index;
    while (cursor < lines.length) {
      const line = lines[cursor];
      const continued = line.endsWith("\\");
      parts.push(continued ? line.slice(0, -1) : line);
      if (!continued) break;
      cursor += 1;
    }
    instructions.push({ lineIndex: index, text: parts.join(" ") });
  }
  return instructions;
}

function npmInstructions(lines: string[]): DockerRunInstruction[] {
  return runInstructions(lines).filter((instruction) => /(^|[\s&|;(])npm([\s@]|$)/.test(instruction.text));
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Worker deb822 source override helper", () => {
  it("treats unset and whitespace-only values as unconfigured", () => {
    expect(helper.normalizeMirrorValue(undefined)).toBeUndefined();
    expect(helper.normalizeMirrorValue("")).toBeUndefined();
    expect(helper.normalizeMirrorValue("   \t ")).toBeUndefined();
    expect(helper.normalizeMirrorValue(" https://mirror.example.com/debian "))
      .toBe("https://mirror.example.com/debian");

    for (const overrides of [
      {},
      { mainMirror: "", securityMirror: "   " },
      undefined,
    ]) {
      const result = helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, overrides);
      expect(result.changed).toBe(false);
      expect(result.output).toBe(DEBIAN_SOURCES_FIXTURE);
    }
  });

  it("replaces the main stanza without touching the security stanza", () => {
    const result = helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, {
      mainMirror: "https://mirror.example.com/debian",
    });
    expect(result.changed).toBe(true);
    expect(result.output).toContain("URIs: https://mirror.example.com/debian\nSuites: bookworm bookworm-updates");
    expect(result.output).toContain("URIs: http://deb.debian.org/debian-security");
  });

  it("replaces the security stanza without touching the main stanza", () => {
    const result = helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, {
      securityMirror: "https://mirror.example.com/debian-security",
    });
    expect(result.changed).toBe(true);
    expect(result.output).toContain("URIs: https://mirror.example.com/debian-security\nSuites: bookworm-security");
    expect(result.output).toContain("URIs: http://deb.debian.org/debian\nSuites: bookworm bookworm-updates");
  });

  it("replaces both stanzas when both overrides are configured", () => {
    const result = helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, {
      mainMirror: "https://mirror.example.com/debian",
      securityMirror: "https://mirror.example.com/debian-security",
    });
    expect(result.changed).toBe(true);
    expect(result.output).not.toContain("deb.debian.org");
    expect(result.output).toContain("URIs: https://mirror.example.com/debian");
    expect(result.output).toContain("URIs: https://mirror.example.com/debian-security");
  });

  it("normalizes harmless trailing slash differences consistently", () => {
    const plain = helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, {
      mainMirror: "https://mirror.example.com/debian",
    });
    const slashed = helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, {
      mainMirror: "https://mirror.example.com/debian///",
    });
    expect(slashed.output).toBe(plain.output);
    expect(helper.validateMirrorUrl("https://mirror.example.com/debian/", helper.APT_MAIN_MIRROR_ENV))
      .toBe("https://mirror.example.com/debian");
  });

  it("normalizes default ports, scheme/host case, and bracketed IPv6 consistently", () => {
    expect(helper.validateMirrorUrl("http://mirror.example.com:80/debian", helper.APT_MAIN_MIRROR_ENV))
      .toBe("http://mirror.example.com/debian");
    expect(helper.validateMirrorUrl("https://mirror.example.com:443/", helper.APT_MAIN_MIRROR_ENV))
      .toBe("https://mirror.example.com");
    expect(helper.validateMirrorUrl("HTTP://MIRROR.EXAMPLE.COM/debian", helper.APT_MAIN_MIRROR_ENV))
      .toBe("http://mirror.example.com/debian");
    expect(helper.validateMirrorUrl("http://[2001:DB8::1]:8080/debian", helper.APT_MAIN_MIRROR_ENV))
      .toBe("http://[2001:db8::1]:8080/debian");
    expect(helper.validateMirrorUrl("https://[2001:db8::1]/debian", helper.APT_SECURITY_MIRROR_ENV))
      .toBe("https://[2001:db8::1]/debian");
  });

  it("rejects port 99999 and every prohibited URL form naming the key but never the value", () => {
    const prohibited = [
      "http://mirror.example.com:99999/debian",
      "https://mirror.example.com:port/debian",
      "https://user:password@mirror.example.com/debian",
      "https://@mirror.example.com/debian",
      "https://mirror.example.com/debian?suite=stable",
      "https://mirror.example.com/debian#fragment",
      "https://mirror.example.com/deb ian",
      "https://mirror.example.com/debian\u0000",
      "https://mirror.example.com/<script>",
      "https://mirror.example.com/deb%ian",
      "https://mirror.example.com/deb|ian",
      "https://mirror.example.com/deb^ian",
      "https://mirror.example.com/deb$(touch)/ian",
      "https://mirror.example.com/deb(ian)",
      "https://mirror.example.com/deb[ian",
      "https://mirror.example.com/deb]ian",
      "https://ex\u00e4mple.example.com/debian",
      "ftp://mirror.example.com/debian",
      "file:///etc/passwd",
      "not a url",
    ];
    for (const value of prohibited) {
      let caught: unknown;
      try {
        helper.validateMirrorUrl(value, helper.APT_SECURITY_MIRROR_ENV);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain(helper.APT_SECURITY_MIRROR_ENV);
      expect(message).not.toContain(value);
    }
  });

  it("preserves unrelated deb822 fields and stanza structure", () => {
    const result = helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, {
      mainMirror: "https://mirror.example.com/debian",
    });
    const expected = DEBIAN_SOURCES_FIXTURE.replace(
      "URIs: http://deb.debian.org/debian\n",
      "URIs: https://mirror.example.com/debian\n",
    );
    expect(result.output).toBe(expected);
    expect(result.output.match(/Signed-By: /g)).toHaveLength(2);
    expect(result.output).toContain(MAIN_STANZA_SECURITY_BY);
    expect(result.output.endsWith("\n")).toBe(true);
  });

  it("keeps a stanza untouched when only the other override is configured", () => {
    const securityOnly = helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, {
      securityMirror: "https://mirror.example.com/debian-security",
    });
    expect(securityOnly.output).toContain("URIs: http://deb.debian.org/debian\n");
  });

  it("fails closed when the requested main or security stanza class is absent", () => {
    const [mainStanza, securityStanza] = DEBIAN_SOURCES_FIXTURE.trimEnd().split("\n\n");
    expect(() => helper.applyDeb822SourceOverrides(`${securityStanza}\n`, {
      mainMirror: "https://mirror.example.com/debian",
    })).toThrow(helper.APT_MAIN_MIRROR_ENV);
    expect(() => helper.applyDeb822SourceOverrides(`${mainStanza}\n`, {
      securityMirror: "https://mirror.example.com/debian-security",
    })).toThrow(helper.APT_SECURITY_MIRROR_ENV);
  });

  it("counts an already-matching stanza as an applied override", () => {
    const result = helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, {
      mainMirror: "http://deb.debian.org/debian",
    });
    expect(result.changed).toBe(false);
    expect(result.output).toBe(DEBIAN_SOURCES_FIXTURE);
  });

  it("replaces the node:22-slim main stanza without touching the security stanza or its snapshot comment", () => {
    const result = helper.applyDeb822SourceOverrides(NODE_SLIM_DEB822_FIXTURE, {
      mainMirror: "https://mirror.example.com/debian",
    });
    expect(result.changed).toBe(true);
    expect(result.output).toBe(NODE_SLIM_DEB822_FIXTURE.replace(
      "URIs: http://deb.debian.org/debian\n",
      "URIs: https://mirror.example.com/debian\n",
    ));
    expect(result.output).toContain(
      `Types: deb\n${NODE_SLIM_SNAPSHOT_MAIN_COMMENT}\nURIs: https://mirror.example.com/debian\n`,
    );
    expect(result.output).toContain(
      `${NODE_SLIM_SNAPSHOT_SECURITY_COMMENT}\nURIs: http://deb.debian.org/debian-security\n`,
    );
  });

  it("replaces the node:22-slim security stanza without touching the main stanza or its snapshot comment", () => {
    const result = helper.applyDeb822SourceOverrides(NODE_SLIM_DEB822_FIXTURE, {
      securityMirror: "https://mirror.example.com/debian-security",
    });
    expect(result.changed).toBe(true);
    expect(result.output).toBe(NODE_SLIM_DEB822_FIXTURE.replace(
      "URIs: http://deb.debian.org/debian-security\n",
      "URIs: https://mirror.example.com/debian-security\n",
    ));
    expect(result.output).toContain(
      `${NODE_SLIM_SNAPSHOT_MAIN_COMMENT}\nURIs: http://deb.debian.org/debian\n`,
    );
  });

  it("replaces both node:22-slim stanzas independently while preserving every snapshot comment exactly", () => {
    const result = helper.applyDeb822SourceOverrides(NODE_SLIM_DEB822_FIXTURE, {
      mainMirror: "https://mirror.example.com/debian",
      securityMirror: "https://mirror.example.com/debian-security",
    });
    expect(result.changed).toBe(true);
    expect(result.output).toContain("URIs: https://mirror.example.com/debian\n");
    expect(result.output).toContain("URIs: https://mirror.example.com/debian-security\n");
    expect(result.output.split(NODE_SLIM_SNAPSHOT_MAIN_COMMENT).length).toBe(2);
    expect(result.output.split(NODE_SLIM_SNAPSHOT_SECURITY_COMMENT).length).toBe(2);
    expect(result.output).not.toContain("deb.debian.org");
  });

  it("keeps the node:22-slim snapshot byte-identical when nothing is configured", () => {
    const result = helper.applyDeb822SourceOverrides(NODE_SLIM_DEB822_FIXTURE, {});
    expect(result.changed).toBe(false);
    expect(result.output).toBe(NODE_SLIM_DEB822_FIXTURE);
  });

  it("keeps comments before any stanza as prose and comments inside stanzas exact", () => {
    const content = [
      "# leading prose comment",
      "Types: deb",
      "# in-stanza snapshot comment",
      "URIs: http://deb.debian.org/debian",
      "Suites: bookworm",
      "",
    ].join("\n");
    const result = helper.applyDeb822SourceOverrides(content, {
      mainMirror: "https://mirror.example.com/debian",
    });
    expect(result.output).toBe([
      "# leading prose comment",
      "Types: deb",
      "# in-stanza snapshot comment",
      "URIs: https://mirror.example.com/debian",
      "Suites: bookworm",
      "",
    ].join("\n"));
  });

  it("fails closed on continuation lines after an in-stanza comment", () => {
    const ambiguous = [
      "Types: deb",
      "# snapshot comment clears continuation context",
      " continuation without a field",
      "URIs: http://deb.debian.org/debian",
      "Suites: bookworm",
      "",
    ].join("\n");
    expect(() => helper.applyDeb822SourceOverrides(ambiguous, {
      mainMirror: "https://mirror.example.com/debian",
    })).toThrow(/Malformed deb822 sources/);
  });

  it("fails when an override is requested but the deb822 input is malformed", () => {
    const malformedInputs = [
      "",
      "   \n",
      "garbage line without a field\n",
      " continuation without a field\n",
      "Types: deb\nSuites: bookworm\nComponents: main\n",
      "Types: deb\nURIs: http://deb.debian.org/debian\nURIs: http://other.example.com/debian\nSuites: bookworm\n",
      "Types: deb\nURIs: http://deb.debian.org/debian\n",
    ];
    for (const content of malformedInputs) {
      expect(() => helper.applyDeb822SourceOverrides(content, {
        mainMirror: "https://mirror.example.com/debian",
      })).toThrow(/Malformed deb822 sources/);
      expect(() => helper.applyDeb822SourceOverrides(content, {
        securityMirror: "https://mirror.example.com/debian-security",
      })).toThrow(/Malformed deb822 sources/);
    }
  });

  it("rejects invalid mirror URLs naming the configuration key but not the value", () => {
    const invalidValues = [
      "ftp://mirror.example.com/debian",
      "not a url",
      "https://user:password@mirror.example.com/debian",
      "https://@mirror.example.com/debian",
      "https://mirror.example.com/debian?component=main",
      "https://mirror.example.com/debian#fragment",
      "https://mirror.example.com/deb ian",
      "https://mirror.example.com/debian\u0000",
      "https://mirror.example.com/deb%ian",
      "https://mirror.example.com/deb|ian",
      "https://mirror.example.com/deb^ian",
      "https://mirror.example.com/deb[ian",
      "https://mirror.example.com/deb]ian",
      "file:///etc/passwd",
    ];
    for (const value of invalidValues) {
      let caught: unknown;
      try {
        helper.applyDeb822SourceOverrides(DEBIAN_SOURCES_FIXTURE, { mainMirror: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain(helper.APT_MAIN_MIRROR_ENV);
      expect(message).not.toContain(value);
      expect(() => helper.validateMirrorUrl(value, helper.APT_SECURITY_MIRROR_ENV))
        .toThrow(helper.APT_SECURITY_MIRROR_ENV);
    }
  });

  it("runs entirely in-process through runCli when nothing is configured", () => {
    let written = false;
    const exitCode = helper.runCli({
      argv: [],
      env: {},
      readFile: () => {
        throw new Error("helper must not read sources when unconfigured");
      },
      writeFile: () => {
        written = true;
      },
    });
    expect(exitCode).toBe(0);
    expect(written).toBe(false);
  });
});

describe("Worker deb822 source override CLI", () => {
  function makeSourcesFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "homerail-worker-apt-sources-"));
    tempDirs.push(dir);
    const sourcesPath = join(dir, "debian.sources");
    writeFileSync(sourcesPath, content, "utf8");
    return sourcesPath;
  }

  function cliEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[helper.APT_MAIN_MIRROR_ENV];
    delete env[helper.APT_SECURITY_MIRROR_ENV];
    return { ...env, ...overrides };
  }

  it("leaves the sources file untouched when nothing is configured", async () => {
    const sourcesPath = makeSourcesFile(DEBIAN_SOURCES_FIXTURE);
    await execFileAsync(process.execPath, [helperScriptPath, sourcesPath], { env: cliEnv() });
    expect(readFileSync(sourcesPath, "utf8")).toBe(DEBIAN_SOURCES_FIXTURE);
  });

  it("rewrites only the configured stanzas in place", async () => {
    const sourcesPath = makeSourcesFile(DEBIAN_SOURCES_FIXTURE);
    await execFileAsync(process.execPath, [helperScriptPath, sourcesPath], {
      env: cliEnv({
        [helper.APT_MAIN_MIRROR_ENV]: "https://mirror.example.com/debian/",
        [helper.APT_SECURITY_MIRROR_ENV]: "https://mirror.example.com/debian-security",
      }),
    });
    const rewritten = readFileSync(sourcesPath, "utf8");
    expect(rewritten).toContain("URIs: https://mirror.example.com/debian\n");
    expect(rewritten).toContain("URIs: https://mirror.example.com/debian-security\n");
    expect(rewritten).not.toContain("deb.debian.org");
  });

  it("fails before apt when the sources file is missing and an override is requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "homerail-worker-apt-sources-"));
    tempDirs.push(dir);
    const missingPath = join(dir, "debian.sources");
    await expect(execFileAsync(process.execPath, [helperScriptPath, missingPath], {
      env: cliEnv({ [helper.APT_MAIN_MIRROR_ENV]: "https://mirror.example.com/debian" }),
    })).rejects.toMatchObject({ code: 1 });
  });

  it("fails when an override is requested for malformed deb822 input", async () => {
    const sourcesPath = makeSourcesFile("not deb822 at all\n");
    const failure = await execFileAsync(process.execPath, [helperScriptPath, sourcesPath], {
      env: cliEnv({ [helper.APT_SECURITY_MIRROR_ENV]: "https://mirror.example.com/debian-security" }),
    }).then(() => undefined, (error) => error);
    expect(failure).toBeDefined();
    expect(failure?.code).toBe(1);
    expect(String(failure?.stderr)).toContain("Malformed deb822 sources");
    expect(readFileSync(sourcesPath, "utf8")).toBe("not deb822 at all\n");
  });

  it("fails without writing when the configured stanza class is absent", async () => {
    const mainOnly = `${DEBIAN_SOURCES_FIXTURE.trimEnd().split("\n\n")[0]}\n`;
    const sourcesPath = makeSourcesFile(mainOnly);
    const failure = await execFileAsync(process.execPath, [helperScriptPath, sourcesPath], {
      env: cliEnv({
        [helper.APT_SECURITY_MIRROR_ENV]: "https://mirror.example.com/debian-security",
      }),
    }).then(() => undefined, (error) => error);
    expect(failure).toBeDefined();
    expect(failure?.code).toBe(1);
    expect(String(failure?.stderr)).toContain(helper.APT_SECURITY_MIRROR_ENV);
    expect(readFileSync(sourcesPath, "utf8")).toBe(mainOnly);
  });

  it("fails for invalid mirror values naming the key without echoing the value", async () => {
    const sourcesPath = makeSourcesFile(DEBIAN_SOURCES_FIXTURE);
    const invalidValue = "https://user:secret@mirror.example.com/debian";
    const failure = await execFileAsync(process.execPath, [helperScriptPath, sourcesPath], {
      env: cliEnv({ [helper.APT_MAIN_MIRROR_ENV]: invalidValue }),
    }).then(() => undefined, (error) => error);
    expect(failure).toBeDefined();
    expect(failure?.code).toBe(1);
    expect(String(failure?.stderr)).toContain(helper.APT_MAIN_MIRROR_ENV);
    expect(String(failure?.stderr)).not.toContain(invalidValue);
    expect(readFileSync(sourcesPath, "utf8")).toBe(DEBIAN_SOURCES_FIXTURE);
  });
});

describe("Worker build source environment-name CLI mode", () => {
  const NPM_REGISTRY_ENV = "HOMERAIL_WORKER_BUILD_NPM_REGISTRY";

  function printCliEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH ?? "", ...overrides };
  }

  function runPrintEnv(name: string, overrides: Record<string, string> = {}) {
    return execFileAsync(process.execPath, [helperScriptPath, helper.PRINT_ENV_FLAG, name], {
      env: printCliEnv(overrides),
    }).then(
      (result) => ({ code: 0, stdout: String(result.stdout), stderr: String(result.stderr) }),
      (error) => {
        const failure = error as { code?: number | string; stdout?: unknown; stderr?: unknown };
        return {
          code: Number(failure.code ?? 1),
          stdout: String(failure.stdout ?? ""),
          stderr: String(failure.stderr ?? ""),
        };
      },
    );
  }

  it("prints only the normalized public URL and receives only the variable name in argv", async () => {
    const result = await runPrintEnv(helper.APT_MAIN_MIRROR_ENV, {
      [helper.APT_MAIN_MIRROR_ENV]: "HTTPS://Mirror.Example.com/debian/",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("https://mirror.example.com/debian\n");
    expect(result.stderr).toBe("");
  });

  it("normalizes default ports and bracketed IPv6 identically for every source key", async () => {
    const cases: [string, string][] = [
      ["http://mirror.example.com:80/debian", "http://mirror.example.com/debian"],
      ["https://mirror.example.com:443/", "https://mirror.example.com"],
      ["http://[2001:DB8::1]:8080/debian", "http://[2001:db8::1]:8080/debian"],
    ];
    for (const name of [helper.APT_MAIN_MIRROR_ENV, helper.APT_SECURITY_MIRROR_ENV, NPM_REGISTRY_ENV]) {
      for (const [value, expected] of cases) {
        const result = await runPrintEnv(name, { [name]: value });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`${expected}\n`);
      }
    }
  });

  it("prints nothing and exits 0 for unset-equivalent values", async () => {
    for (const overrides of [{}, { [helper.APT_MAIN_MIRROR_ENV]: " \t " }]) {
      const result = await runPrintEnv(helper.APT_MAIN_MIRROR_ENV, overrides);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("fails before any consumer for prohibited values, naming the key and never echoing the value", async () => {
    const prohibited = [
      "http://mirror.example.com:99999/debian",
      "https://user:secret@mirror.example.com/debian",
      "https://@mirror.example.com/debian",
      "https://mirror.example.com/debian?suite=stable",
      "https://mirror.example.com/debian#fragment",
      "https://mirror.example.com/deb ian",
      "https://mirror.example.com/<script>",
      "https://mirror.example.com/deb%ian",
      "https://mirror.example.com/deb|ian",
      "https://mirror.example.com/deb^ian",
      "https://mirror.example.com/deb[ian",
      "https://mirror.example.com/deb]ian",
      "ftp://mirror.example.com/debian",
      "file:///etc/passwd",
      "not a url",
    ];
    // Null bytes cannot cross the process boundary in an environment value;
    // the in-process validation tests cover that rejection above.
    for (const value of prohibited) {
      const result = await runPrintEnv(NPM_REGISTRY_ENV, { [NPM_REGISTRY_ENV]: value });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(NPM_REGISTRY_ENV);
      expect(result.stderr).not.toContain(value);
    }
  });

  it("runs entirely in-process through runCli without reading the sources file", () => {
    const printed: string[] = [];
    const failures: string[] = [];
    const exitCode = helper.runCli({
      argv: [helper.PRINT_ENV_FLAG, NPM_REGISTRY_ENV],
      env: { [NPM_REGISTRY_ENV]: " https://registry.example.com/ " },
      readFile: () => {
        throw new Error("print-env mode must not read the sources file");
      },
      writeFile: () => {
        throw new Error("print-env mode must not write the sources file");
      },
      print: (line) => printed.push(line),
      fail: (message) => failures.push(message),
    });
    expect(exitCode).toBe(0);
    expect(printed).toEqual(["https://registry.example.com"]);
    expect(failures).toEqual([]);
  });

  it("allows an at-sign in a source path without treating it as userinfo", () => {
    expect(helper.validateMirrorUrl(
      "https://registry.example.com/scope/@package",
      NPM_REGISTRY_ENV,
    )).toBe("https://registry.example.com/scope/@package");
  });

  it("rejects malformed invocations without printing a URL", () => {
    for (const argv of [
      [helper.PRINT_ENV_FLAG],
      [helper.PRINT_ENV_FLAG, helper.APT_MAIN_MIRROR_ENV, "extra"],
      [helper.PRINT_ENV_FLAG, "not a variable name"],
    ]) {
      const printed: string[] = [];
      const failures: string[] = [];
      const exitCode = helper.runCli({
        argv,
        env: { [helper.APT_MAIN_MIRROR_ENV]: "https://mirror.example.com/debian" },
        print: (line) => printed.push(line),
        fail: (message) => failures.push(message),
      });
      expect(exitCode).toBe(1);
      expect(printed).toEqual([]);
      expect(failures).toHaveLength(1);
    }
  });
});

describe("Worker Dockerfile source wiring", () => {
  it("keeps exactly one canonical Worker Dockerfile", () => {
    const dockerfiles: string[] = [];
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const full = join(dir, name);
        if (lstatSync(full).isDirectory()) {
          visit(full);
          continue;
        }
        if (/^dockerfile/i.test(name)) dockerfiles.push(full);
      }
    };
    visit(workerRoot);
    expect(dockerfiles).toEqual([join(workerRoot, "Dockerfile")]);
  });

  it("wires the APT override helper into every stage before apt-get update", () => {
    const stages = dockerfileStages();
    expect(stages.length).toBeGreaterThanOrEqual(2);
    for (const stage of stages) {
      const body = stage.lines.join("\n");
      expect(body).toMatch(/^ARG HOMERAIL_WORKER_BUILD_APT_MIRROR$/m);
      expect(body).toMatch(/^ARG HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR$/m);
      expect(body).toContain(
        "COPY homerail_worker/scripts/configure-apt-sources.mjs /opt/homerail/scripts/configure-apt-sources.mjs",
      );
      const helperRunIndex = stage.lines
        .findIndex((line) => line === "RUN node /opt/homerail/scripts/configure-apt-sources.mjs");
      const aptUpdateIndex = runInstructions(stage.lines)
        .find((instruction) => instruction.text.includes("apt-get update"))?.lineIndex ?? -1;
      expect(helperRunIndex).toBeGreaterThanOrEqual(0);
      expect(aptUpdateIndex).toBeGreaterThanOrEqual(0);
      expect(helperRunIndex).toBeLessThan(aptUpdateIndex);
    }
  });

  it("keeps the APT override arguments optional with no vendor default", () => {
    expect(dockerfile).not.toMatch(/ARG HOMERAIL_WORKER_BUILD_APT_MIRROR=/);
    expect(dockerfile).not.toMatch(/ARG HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR=/);
  });

  it("declares NPM_CONFIG_REGISTRY before every npm build operation", () => {
    const stages = dockerfileStages();
    const npmStages = stages.filter((stage) => npmInstructions(stage.lines).length > 0);
    expect(npmStages.length).toBeGreaterThan(0);
    for (const stage of npmStages) {
      const argIndex = stage.lines.findIndex((line) => line === "ARG NPM_CONFIG_REGISTRY");
      expect(argIndex).toBeGreaterThanOrEqual(0);
      for (const instruction of npmInstructions(stage.lines)) {
        expect(instruction.lineIndex).toBeGreaterThan(argIndex);
      }
    }
    expect(dockerfile.match(/^ARG NPM_CONFIG_REGISTRY$/gm)).toHaveLength(npmStages.length);
  });

  it("keeps the npm registry override build-only", () => {
    expect(dockerfile).not.toMatch(/ARG NPM_CONFIG_REGISTRY=/);
    expect(dockerfile).not.toMatch(/ENV[^\n]*NPM_CONFIG_REGISTRY/);
    expect(dockerfile).not.toMatch(/ENV[^\n]*HOMERAIL_WORKER_BUILD_APT/);
  });

  it("repairs skipped optional agent platform payloads before verifying the CLIs", () => {
    const finalStage = dockerfileStages().at(-1);
    expect(finalStage).toBeDefined();
    const runs = runInstructions(finalStage?.lines ?? []);
    const installIndex = runs.findIndex((instruction) => instruction.text.includes("npm ci --ignore-scripts"));
    const repairIndex = runs.findIndex((instruction) => instruction.text.includes("codex_platform="));
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(repairIndex).toBeGreaterThan(installIndex);

    const repair = runs[repairIndex]?.text ?? "";
    expect(repair).toContain("amd64) codex_arch=x64");
    expect(repair).toContain("arm64) codex_arch=arm64");
    expect(repair).toContain("node_modules/@anthropic-ai/claude-agent-sdk/package.json");
    expect(repair).toContain("@anthropic-ai/claude-agent-sdk-linux-${codex_arch}");
    expect(repair).toContain("node_modules/@openai/codex/package.json");
    expect(repair).toContain("npm install --no-save --package-lock=false --ignore-scripts");
    expect(repair).toContain("@npm:@openai/codex@${codex_version}-linux-${codex_arch}");
    expect(repair).toContain("node_modules/${claude_platform}/claude");
    expect(repair).toContain("codex --version");
  });

  it("allows the pinned DSH fork and Corepack bootstrap to use validated mirrors", () => {
    expect(dockerfile).toContain(
      "ARG HOMERAIL_DSH_FORK_REPOSITORY=https://github.com/xiaotianfotos/deepseek-harness.git",
    );
    expect(dockerfile).toContain('git remote add origin "${HOMERAIL_DSH_FORK_REPOSITORY}"');
    const dshStage = dockerfileStages().find((stage) => stage.header.includes(" AS dsh-runtime-build"));
    expect(dshStage).toBeDefined();
    const corepackRuns = runInstructions(dshStage?.lines ?? [])
      .filter((instruction) => instruction.text.includes("corepack pnpm"));
    expect(corepackRuns.length).toBeGreaterThan(0);
    for (const instruction of corepackRuns) {
      expect(instruction.text).toContain('export COREPACK_NPM_REGISTRY="$NPM_CONFIG_REGISTRY"');
    }
  });
});

describe("Worker source fingerprint participation", () => {
  it("includes the APT sources helper in the Manager fingerprint inputs", () => {
    const dagEnvironmentSource = readFileSync(
      join(repoRoot, "homerail_manager", "src", "server", "dag-environment.ts"),
      "utf8",
    );
    expect(dagEnvironmentSource).toContain("\"homerail_worker/scripts/configure-apt-sources.mjs\"");
    const inputsMatch = /const SOURCE_INPUTS = \[(.*?)\] as const;/s.exec(dagEnvironmentSource);
    expect(inputsMatch).not.toBeNull();
    expect(inputsMatch?.[1]).toContain("homerail_worker/scripts/configure-apt-sources.mjs");
  });

  it("ships the helper file referenced by the fingerprint inputs", () => {
    expect(lstatSync(helperScriptPath).isFile()).toBe(true);
  });
});
