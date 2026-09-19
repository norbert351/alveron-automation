import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLedger } from '../../src/ledger/sqlite-ledger.js';
import { ConsoleEmailProvider, NotificationNotSent } from '../../src/providers/email/index.js';
import { NotificationRunner } from '../../src/workflows/notification-runner.js';

const orderId = '00000000-0000-4000-8000-000000000001';
const message = { recipient: 'fixture@example.invalid', subject: 'Synthetic unit test', text: 'Synthetic fixture, not Alveron data' };

test('successful development notification is skipped on second run and after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alveron-ledger-'));
  const path = join(dir, 'ledger.sqlite');
  const lines: string[] = [];
  const provider = new ConsoleEmailProvider(line => lines.push(line));
  let ledger = new SqliteLedger(path);
  try {
    let runner = new NotificationRunner(ledger, provider.namespace);
    const send = (key: string) => provider.sendCustomerOrderConfirmation(message, key);
    assert.deepEqual(await runner.run(orderId, 'customer', send), { status: 'SUCCESS', simulated: true });
    assert.deepEqual(await runner.run(orderId, 'customer', send), { status: 'SKIPPED' });
    ledger.close();
    ledger = new SqliteLedger(path);
    runner = new NotificationRunner(ledger, provider.namespace);
    assert.deepEqual(await runner.run(orderId, 'customer', send), { status: 'SKIPPED' });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.includes(message.recipient), false);
    assert.equal(lines[0]?.includes(message.text), false);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent calls cannot both send', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const runner = new NotificationRunner(ledger, 'test');
    let sends = 0;
    const send = async () => { sends++; await new Promise(resolve => setTimeout(resolve, 10)); return { messageId: 'synthetic', simulated: true }; };
    const results = await Promise.all([runner.run(orderId, 'customer', send), runner.run(orderId, 'customer', send)]);
    assert.equal(sends, 1);
    assert.deepEqual(results.map(result => result.status).sort(), ['SKIPPED', 'SUCCESS']);
  } finally { ledger.close(); }
});

test('definite non-delivery retries; ambiguous delivery remains pending and cannot resend', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    const runner = new NotificationRunner(ledger, 'test');
    assert.equal((await runner.run(orderId, 'customer', async () => { throw new NotificationNotSent(); })).status, 'FAILED');
    assert.equal((await runner.run(orderId, 'customer', async () => ({ messageId: 'synthetic', simulated: true }))).status, 'SUCCESS');
    assert.equal((await runner.run(orderId, 'admin', async () => { throw new Error('unknown delivery'); })).status, 'PENDING');
    assert.equal((await runner.run(orderId, 'admin', async () => { assert.fail('must not resend'); })).status, 'SKIPPED');
  } finally { ledger.close(); }
});
