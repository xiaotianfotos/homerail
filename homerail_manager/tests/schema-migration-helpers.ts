import { expect } from "vitest";

import { getDb } from "../src/persistence/db.js";

type MigrationDb = {
  prepare(sql: string): {
    get(): unknown;
    all(): unknown[];
  };
};

export function expectCurrentSchemaMigrationVersion(
  db: MigrationDb = getDb(),
  minLatestVersion = 30,
): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
  expect(row.version).toBeGreaterThanOrEqual(minLatestVersion);
  return row.version;
}

export function expectSchemaMigrationRange(
  startVersion: number,
  db: MigrationDb = getDb(),
  minLatestVersion = 30,
): void {
  const latestVersion = expectCurrentSchemaMigrationVersion(db, minLatestVersion);
  expect(db.prepare(
    `SELECT version FROM schema_migrations WHERE version >= ${startVersion} ORDER BY version`,
  ).all()).toEqual(
    Array.from({ length: latestVersion - startVersion + 1 }, (_, index) => ({ version: startVersion + index })),
  );
}
