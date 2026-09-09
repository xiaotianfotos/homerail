import fs from "node:fs";

/** The parent treats the final path as a readiness signal across processes. */
export function publishFixtureJson(file: string, serialized: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, serialized);
  fs.renameSync(temporary, file);
}
