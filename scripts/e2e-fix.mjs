#!/usr/bin/env node
import fs from 'node:fs';

const usage = `Usage (on the Linux Manager host, after npm run build:packages):
  node scripts/e2e-fix.mjs freeze-runtime /absolute/new/runtime
  node scripts/e2e-fix.mjs prepare /absolute/preparation-input.json

freeze-runtime prints the pinned runtime descriptor. prepare writes a private
task, native workflow, runtime profile and digest manifest; it does not start
execution. See docs/e2e-fix.md for input and admission requirements.`;

try {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (command === '--help' || command === '-h') console.log(usage);
  else {
    if (!argument || extra.length || !['freeze-runtime', 'prepare'].includes(command)) throw new Error(usage);
    const modulePath = new URL('../homerail_manager/dist/runtime/', import.meta.url);
    if (!fs.existsSync(new URL('e2e-fix-prepare.js', modulePath))) throw new Error('Build packages first: npm run build:packages');
    if (command === 'freeze-runtime') {
      const { freezeE2eFixRuntime } = await import(new URL('e2e-fix-runtime.js', modulePath));
      console.log(JSON.stringify(freezeE2eFixRuntime(argument)));
    } else {
      if (!argument.startsWith('/')) throw new Error('preparation input path must be absolute');
      const stat = fs.statSync(argument);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('preparation input must be a file at most 4 MiB');
      const { prepareE2eFix } = await import(new URL('e2e-fix-prepare.js', modulePath));
      console.log(JSON.stringify(prepareE2eFix(JSON.parse(fs.readFileSync(argument, 'utf8')))));
    }
  }
} catch (error) {
  console.error(`E2E Fix: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
