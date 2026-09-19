// Launches the locally-installed, PINNED n8n runtime for development verification, detached so it
// survives the parent shell. Reads KEY=VALUE pairs from the env file passed as argv[2] (never
// committed; contains the n8n encryption key and the non-secret GATEWAY_BASE_URL).
//
// Usage: node scripts/run-n8n-dev.mjs .n8n-runtime/.env.n8n
import { readFileSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const envFile = process.argv[2];
if (!envFile) { console.error('usage: node scripts/run-n8n-dev.mjs <envfile>'); process.exit(2); }
const env = { ...process.env };
for (const line of readFileSync(resolve(envFile), 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const index = trimmed.indexOf('=');
  if (index < 0) continue;
  env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
}
if (!env.N8N_ENCRYPTION_KEY) { console.error('N8N_ENCRYPTION_KEY is required'); process.exit(2); }

const out = openSync(resolve('.n8n-runtime/n8n.out'), 'a');
const err = openSync(resolve('.n8n-runtime/n8n.err'), 'a');
const child = spawn(process.execPath, [resolve('.n8n-runtime/node_modules/n8n/bin/n8n'), 'start'], {
  env, detached: true, stdio: ['ignore', out, err], windowsHide: true,
});
child.unref();
console.log(JSON.stringify({ launched: 'n8n', pid: child.pid, version: '2.39.8', port: env.N8N_PORT ?? '5678' }));