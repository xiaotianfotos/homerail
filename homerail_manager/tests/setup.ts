import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

const inheritedHome = process.env.HOMERAIL_HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-vitest-"));

// Tests must never inherit the deployment database from the invoking shell.
process.env.HOMERAIL_HOME = testHome;

afterAll(async () => {
  const { closeDb } = await import("../src/persistence/db.js");
  closeDb();
  if (inheritedHome === undefined) delete process.env.HOMERAIL_HOME;
  else process.env.HOMERAIL_HOME = inheritedHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});
