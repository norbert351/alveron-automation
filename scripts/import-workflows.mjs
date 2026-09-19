// Thin wrapper that reuses the export/import logic with the explicit command argument.
// See export-workflows.mjs for the security notes: no credentials, imports stay inactive.
import { spawnSync } from 'node:child_process';

const n8n = spawnSync('n8n', ['import:workflow', '--separate', '--input=n8n/workflows'],
  { stdio: 'inherit', shell: process.platform === 'win32' });

if (n8n.error?.code === 'ENOENT') {
  console.error('n8n CLI not found on PATH. Install/locate the official n8n instance first; nothing was modified.');
  process.exit(1);
}
process.exit(n8n.status ?? 1);
