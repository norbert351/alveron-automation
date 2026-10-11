// Wraps the official n8n Server CLI (https://docs.n8n.io/deploy/host-n8n/configure-n8n/use-the-command-line/).
// This script never modifies workflow content and never handles credentials:
// exported workflow JSON must not contain secrets, and imported workflows stay deactivated by default.
import { spawnSync } from 'node:child_process';

const command = process.argv[1]?.endsWith('import-workflows.mjs') ? 'import' : 'export';
const n8n = spawnSync('n8n', command === 'export'
  ? ['export:workflow', '--all', '--separate', '--pretty', '--output=n8n/workflows']
  : ['import:workflow', '--separate', '--activeState=false', `--input=n8n/workflows`],
  { stdio: 'inherit', shell: process.platform === 'win32' });

if (n8n.error?.code === 'ENOENT') {
  console.error('n8n CLI not found on PATH. Install/locate the official n8n instance first; nothing was modified.');
  process.exit(1);
}
process.exit(n8n.status ?? 1);
