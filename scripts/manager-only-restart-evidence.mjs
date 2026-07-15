#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const allowed = new Set(["before", "after", "output"]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator >= 0 ? separator : undefined);
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = separator >= 0 ? argument.slice(separator + 1) : argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    options[name] = value;
  }
  for (const name of allowed) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
  return options;
}

function preservedProcess(before, after, pidKey, runningKey) {
  if (before?.[runningKey] === true) {
    return after?.[runningKey] === true
      && Number.isSafeInteger(before?.[pidKey])
      && after?.[pidKey] === before[pidKey];
  }
  return before?.[runningKey] === false && after?.[runningKey] === false;
}

export function managerOnlyRestartEvidence(before, after) {
  const evidence = {
    schema_version: 1,
    manager_pid_changed: before?.managerPidRunning === true
      && after?.managerPidRunning === true
      && Number.isSafeInteger(before?.managerPid)
      && Number.isSafeInteger(after?.managerPid)
      && before.managerPid !== after.managerPid,
    manager_healthy: after?.managerHealthy === true,
    node_pid_preserved: preservedProcess(before, after, "nodePid", "nodePidRunning"),
    ui_processes_preserved_or_absent: preservedProcess(
      before,
      after,
      "uiHttpsPid",
      "uiHttpsPidRunning",
    ) && preservedProcess(before, after, "uiHttpPid", "uiHttpPidRunning"),
    physical_ids_redacted: true,
  };
  evidence.passed = evidence.manager_pid_changed
    && evidence.manager_healthy
    && evidence.node_pid_preserved
    && evidence.ui_processes_preserved_or_absent;
  return evidence;
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const evidence = managerOnlyRestartEvidence(
    readJson(path.resolve(options.before)),
    readJson(path.resolve(options.after)),
  );
  writeJson(path.resolve(options.output), evidence);
  if (!evidence.passed) {
    console.error("Manager-only restart did not preserve the required service boundary");
    process.exitCode = 1;
  }
}
