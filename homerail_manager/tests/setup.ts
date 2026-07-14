import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

const inheritedHome = process.env.HOMERAIL_HOME;
const realTmpDir = fs.realpathSync(os.tmpdir());
const testHome = fs.mkdtempSync(path.join(realTmpDir, "homerail-vitest-"));

// Tests must never inherit the deployment database from the invoking shell.
// macOS exposes /var as an alias for /private/var. Keep all per-test homes on
// the canonical path so secret-file tests exercise the production no-symlink policy.
process.env.TMPDIR = realTmpDir;
process.env.HOMERAIL_HOME = testHome;

afterAll(async () => {
  const { closeDb } = await import("../src/persistence/db.js");
  closeDb();
  if (inheritedHome === undefined) delete process.env.HOMERAIL_HOME;
  else process.env.HOMERAIL_HOME = inheritedHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});
