import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getHomerailHome } from "../src/config/env.js";

const originalHome = process.env.HOMERAIL_HOME;
const originalRunnerTemp = process.env.RUNNER_TEMP;
const originalUnsafe = process.env.HOMERAIL_ALLOW_UNSAFE_TEST_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOMERAIL_HOME;
  else process.env.HOMERAIL_HOME = originalHome;
  if (originalRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
  else process.env.RUNNER_TEMP = originalRunnerTemp;
  if (originalUnsafe === undefined) delete process.env.HOMERAIL_ALLOW_UNSAFE_TEST_HOME;
  else process.env.HOMERAIL_ALLOW_UNSAFE_TEST_HOME = originalUnsafe;
});

describe("test HomeRail home isolation", () => {
  it("accepts a HomeRail home under the GitHub Actions runner temp root", () => {
    const runnerTemp = path.join(os.homedir(), "actions-runner-temp");
    const home = path.join(runnerTemp, "homerail-ci");
    process.env.RUNNER_TEMP = runnerTemp;
    process.env.HOMERAIL_HOME = home;
    delete process.env.HOMERAIL_ALLOW_UNSAFE_TEST_HOME;

    expect(getHomerailHome()).toBe(home);
  });

  it("still rejects a HomeRail home outside every declared temporary root", () => {
    process.env.RUNNER_TEMP = path.join(os.tmpdir(), "actions-runner-temp");
    process.env.HOMERAIL_HOME = path.join(os.homedir(), "persistent-homerail-home");
    delete process.env.HOMERAIL_ALLOW_UNSAFE_TEST_HOME;

    expect(() => getHomerailHome()).toThrow(/refused non-temporary HOMERAIL_HOME/);
  });
});
