import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLI_VERSION,
  createProgram,
  readCliPackageVersion,
} from "../src/index.js";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageMetadata = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
  version: string;
};

describe("CLI version", () => {
  it("comes from the CLI package metadata", () => {
    expect(readCliPackageVersion(packageJsonUrl)).toBe(packageMetadata.version);
    expect(CLI_VERSION).toBe(packageMetadata.version);
    expect(createProgram().version()).toBe(packageMetadata.version);
  });
});
