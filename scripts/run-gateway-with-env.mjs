// Test helper: reads KEY=VALUE pairs from an environment-file path passed as argv[2],
// sets them into process.env, then runs the compiled gateway entrypoint (dist/src/gateway/start.js).
// The env file itself is the caller's responsibility; this helper never prints or commits values.
// Used only for local development/testing so secrets never pass through a shell command line.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const envFile = process.argv[2];
if (!envFile) { console.error('usage: node scripts/run-gateway-with-env.mjs <envfile>'); process.exit(2); }
const lines = readFileSync(resolve(envFile), 'utf8').split(/\r?\n/);
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const index = trimmed.indexOf('=');
  if (index < 0) continue;
  process.env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
}
// Delegate to the compiled entrypoint in a child so config loads with the injected env.
const result = spawnSync(process.execPath, [resolve('dist/src/gateway/start.js')], {
  stdio: 'inherit', env: process.env,
});
process.exit(result.status ?? 0);