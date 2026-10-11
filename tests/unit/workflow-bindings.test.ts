import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.cwd(), 'n8n/workflows');
const errorWorkflowName = 'Alveron Automation — Error Classification (DEV)';

test('every repository workflow is inactive, has a stable id, and binds the shared error workflow', () => {
  const files = readdirSync(dir).filter(file => file.endsWith('.json')).sort();
  assert.ok(files.length >= 16);
  const ids = new Map<string, string>();
  for (const file of files) {
    const workflow = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as {
      name: string; id?: string; active?: boolean; settings?: { errorWorkflow?: string };
    };
    assert.equal(workflow.active, false, `${file} must be inactive`);
    assert.match(workflow.id ?? '', /^[A-Za-z0-9_-]{6,64}$/, `${file} needs a stable workflow id`);
    assert.equal(ids.has(workflow.id!), false, `${file} reuses id ${workflow.id}`);
    ids.set(workflow.id!, file);
  }
  const errorFile = files.find(file =>
    (JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as { name: string }).name === errorWorkflowName);
  assert.ok(errorFile, 'the shared error workflow must be present');
  const errorId = (JSON.parse(readFileSync(resolve(dir, errorFile!), 'utf8')) as { id: string }).id;
  for (const file of files) {
    if (file === errorFile) continue;
    const workflow = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as { settings?: { errorWorkflow?: string } };
    assert.equal(workflow.settings?.errorWorkflow, errorId,
      `${file} must bind the stable error workflow id (a fresh import reproduces the relationship)`);
  }
});
