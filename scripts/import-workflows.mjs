// Import wrapper. Validates the repository workflow bindings first, then imports with
// `--activeState=false` so no import can ever activate a workflow. See export-workflows.mjs for
// the security notes: no credentials are involved, and a fresh import reproduces the pinned
// stable ids + error-workflow binding.
import { spawnSync } from 'node:child_process';
import { validateWorkflowFiles } from './workflow-bindings.mjs';

const { files, problems } = validateWorkflowFiles('n8n/workflows');
if (problems.length) {
  console.error(JSON.stringify({ status: 'workflow_validation_failed', workflows: files.length, problems }));
  console.error('Refusing to import: fix the workflow bindings instead. Nothing was modified.');
  process.exit(1);
}

const n8n = spawnSync('n8n',
  ['import:workflow', '--separate', '--activeState=false', '--input=n8n/workflows'],
  { stdio: 'inherit', shell: process.platform === 'win32' });

if (n8n.error?.code === 'ENOENT') {
  console.error('n8n CLI not found on PATH. Install/locate the official n8n instance first; nothing was modified.');
  process.exit(1);
}
process.exit(n8n.status ?? 1);
