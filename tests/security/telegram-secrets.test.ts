import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const root = process.cwd();
const syntheticBotToken = ['1234567890', 'synthetic-test-token-not-real'].join(':');
const tokenPattern = /\d{5,16}:[A-Za-z0-9_-]{20,100}/g;
const trackedAndProposed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean);

test('no Bot API token or populated Telegram secret is present in Git-visible project files', () => {
  const leakedPaths: string[] = [];
  for (const relative of trackedAndProposed) {
    const absolute = resolve(root, relative);
    if (!statSync(absolute).isFile() || statSync(absolute).size > 2_000_000) continue;
    const content = readFileSync(absolute, 'utf8');
    tokenPattern.lastIndex = 0;
    if (tokenPattern.test(content)) leakedPaths.push(relative);
    if (/^[ \t]*TELEGRAM_(?:BOT_TOKEN|ADMIN_CHAT_ID)[ \t]*=[ \t]*\S+/m.test(content)) leakedPaths.push(relative);
  }
  assert.equal(leakedPaths.includes('deploy/gateway.env.example'), false);
  assert.deepEqual(leakedPaths, []);
});

test('Telegram Bot API token stays out of every n8n workflow', () => {
  const workflowFiles = trackedAndProposed.filter(path => path.startsWith('n8n/workflows/') && extname(path) === '.json');
  for (const relative of workflowFiles) {
    const content = readFileSync(resolve(root, relative), 'utf8');
    assert.equal(content.includes('api.telegram.org'), false, relative);
    assert.equal(/TELEGRAM_BOT_TOKEN|TELEGRAM_ADMIN_CHAT_ID/.test(content), false, relative);
    assert.equal(tokenPattern.test(content), false, relative);
    tokenPattern.lastIndex = 0;
  }
});

test('error workflow remains inactive and never fails on notification delivery', () => {
  const workflow = JSON.parse(readFileSync(resolve(root, 'n8n/workflows/error-handler.json'), 'utf8')) as {
    active: boolean;
    nodes: Array<{ type: string; parameters?: Record<string, unknown>; onError?: string }>;
  };
  assert.equal(workflow.active, false);
  const request = workflow.nodes.find(node => node.type === 'n8n-nodes-base.httpRequest');
  assert.ok(request);
  assert.equal(request.onError, 'continueRegularOutput');
  assert.equal(JSON.stringify(request.parameters).includes('neverError'), true);
});

test('workflow Code nodes compile and preserve structured failure classification', () => {
  // Order matters: codeNodes[2] below is error-handler's classifier (first code node of the third file).
  const workflowNames = ['paid-order-confirmation', 'referral-qualification', 'error-handler',
    'product-request-notification', 'low-stock-notification', 'order-operations',
    'payment-reconciliation', 'shipping-sla', 'system-health'];
  const codeNodes: string[] = [];
  for (const name of workflowNames) {
    const workflow = JSON.parse(readFileSync(resolve(root, `n8n/workflows/${name}.json`), 'utf8')) as {
      nodes: Array<{ type: string; parameters?: { jsCode?: string } }>;
    };
    for (const node of workflow.nodes) if (node.type === 'n8n-nodes-base.code' && node.parameters?.jsCode) {
      codeNodes.push(node.parameters.jsCode);
    }
  }
  for (const code of codeNodes) assert.doesNotThrow(() => new Function('$input', code));
  const classifier = codeNodes[2]!;
  const run = (json: Record<string, unknown>) => {
    const result = new Function('$input', classifier)({ first: () => ({ json }) }) as Array<{ json: Record<string, unknown> }>;
    return result[0]!.json;
  };
  const gateway = run({ workflow: { name: 'Paid Order' }, execution: { id: 'exec-1',
    error: { message: 'GATEWAY_RUN_FAILED|ALVERON_API_FAILURE|NETWORK_ERROR|true' } } });
  assert.equal(gateway['errorCode'], 'ALVERON_API_FAILURE');
  assert.equal(gateway['category'], 'NETWORK_ERROR');
  assert.equal(gateway['transient'], true);
  const trigger = run({ workflow: {}, trigger: { error: { message: 'ECONNREFUSED' } } });
  assert.equal(String(trigger['executionId']).length > 0, true);
  assert.equal(trigger['category'], 'NETWORK_ERROR');
});

test('credential-stage fixture remains non-secret and test command is not part of the automated suite', () => {
  const env = readFileSync(resolve(root, 'deploy/gateway.env.example'), 'utf8');
  assert.equal(env.includes(`TELEGRAM_BOT_TOKEN=${syntheticBotToken}`), false);
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.ok(packageJson.scripts['test:telegram']);
  assert.equal(packageJson.scripts['test']?.includes('test:telegram'), false);
});
