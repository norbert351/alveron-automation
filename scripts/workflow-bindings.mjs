// Reproducible n8n workflow binding validation.
//
// The repository workflow JSON pins a stable `id` on every workflow and points each workflow's
// `settings.errorWorkflow` at the error-classification workflow by that stable id. Because n8n's
// `import:workflow --separate` preserves a supplied id, a fresh import reproduces the intended
// error-workflow relationship without anyone editing an instance id by hand. This module is the
// single source of truth for that invariant, used by the import wrapper and the test suite.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ERROR_WORKFLOW_NAME = 'Alveron Automation — Error Classification (DEV)';
const ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Validates every `*.json` workflow file in `dir`.
 * @returns {{ files: string[], errorFile: string | null, problems: string[] }}
 */
export function validateWorkflowFiles(dir) {
  const problems = [];
  const files = readdirSync(dir).filter(file => file.endsWith('.json')).sort();
  if (!files.length) problems.push(`no workflow JSON files found in ${dir}`);
  const ids = new Map();
  const parsed = new Map();
  for (const file of files) {
    let workflow;
    try { workflow = JSON.parse(readFileSync(resolve(dir, file), 'utf8')); }
    catch { problems.push(`${file}: not valid JSON`); continue; }
    parsed.set(file, workflow);
    if (workflow.active !== false) problems.push(`${file}: active must be strictly false`);
    if (typeof workflow.id !== 'string' || !ID_PATTERN.test(workflow.id)) {
      problems.push(`${file}: missing or invalid stable workflow id`);
    } else if (ids.has(workflow.id)) {
      problems.push(`${file}: duplicate id ${workflow.id} (also ${ids.get(workflow.id)})`);
    } else ids.set(workflow.id, file);
  }
  const errorFiles = files.filter(file => parsed.get(file)?.name === ERROR_WORKFLOW_NAME);
  if (errorFiles.length !== 1) problems.push(`expected exactly one error workflow named "${ERROR_WORKFLOW_NAME}", found ${errorFiles.length}`);
  const errorFile = errorFiles[0] ?? null;
  if (errorFile) {
    const errorId = parsed.get(errorFile).id;
    for (const file of files) {
      if (file === errorFile) continue;
      const reference = parsed.get(file)?.settings?.errorWorkflow;
      if (reference !== errorId) {
        problems.push(`${file}: settings.errorWorkflow must be the stable error id ${errorId}, got ${reference ?? 'none'}`);
      }
    }
  }
  return { files, errorFile, problems };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const dir = resolve(process.argv[2] ?? 'n8n/workflows');
  const { files, errorFile, problems } = validateWorkflowFiles(dir);
  console.log(JSON.stringify({ dir, workflows: files.length, errorFile, problems }, null, 2));
  if (problems.length) process.exitCode = 1;
}
