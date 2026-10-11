import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { ModeAwareEmailProvider, NotificationNotSent, type EmailProvider } from '../../src/providers/email/index.js';

const message = { recipient: 'customer@example.invalid', subject: 'synthetic', text: 'synthetic' };

function delegate(): EmailProvider & { customer: number; admin: number } {
  const state = {
    namespace: 'resend', customer: 0, admin: 0,
    async sendCustomerOrderConfirmation() { state.customer += 1; return { messageId: 'real', simulated: false }; },
    async sendAdminOrderAlert() { state.admin += 1; return { messageId: 'real', simulated: false }; },
    async sendCustomerTransactional() { state.customer += 1; return { messageId: 'real', simulated: false }; },
  };
  return state;
}

test('live mode delegates customer and admin sends unchanged', async () => {
  const inner = delegate();
  const provider = new ModeAwareEmailProvider(inner, 'live');
  assert.equal(provider.namespace, 'resend');
  assert.deepEqual(await provider.sendCustomerOrderConfirmation(message, 'k'), { messageId: 'real', simulated: false });
  assert.deepEqual(await provider.sendAdminOrderAlert(message, 'k'), { messageId: 'real', simulated: false });
  assert.equal(inner.customer, 1);
  assert.equal(inner.admin, 1);
});

test('test mode intercepts the customer send and keeps admin alerts running', async () => {
  const inner = delegate();
  const provider = new ModeAwareEmailProvider(inner, 'test');
  assert.equal(provider.namespace, 'resend:test');
  const receipt = await provider.sendCustomerOrderConfirmation(message, 'k');
  assert.equal(receipt.simulated, true);
  assert.equal(inner.customer, 0, 'no customer send leaves the process in test mode');
  await provider.sendAdminOrderAlert(message, 'k');
  assert.equal(inner.admin, 1, 'admin alerts are not disabled by the customer-email mode');
});

test('transactional emails honour the same mode gate as the order confirmation', async () => {
  const email = { template: 'order_shipped' as const, recipient: 'customer@example.invalid',
    subject: 'shipped', text: 'shipped', referenceId: 'order-1' };
  const live = delegate();
  assert.deepEqual(await new ModeAwareEmailProvider(live, 'live').sendCustomerTransactional(email, 'k'),
    { messageId: 'real', simulated: false });
  assert.equal(live.customer, 1);

  const testMode = delegate();
  assert.equal((await new ModeAwareEmailProvider(testMode, 'test').sendCustomerTransactional(email, 'k')).simulated, true);
  assert.equal(testMode.customer, 0);

  const disabled = delegate();
  await assert.rejects(new ModeAwareEmailProvider(disabled, 'disabled').sendCustomerTransactional(email, 'k'),
    (error: unknown) => error instanceof NotificationNotSent);
  assert.equal(disabled.customer, 0);
});

test('disabled mode never sends the customer email and fails closed', async () => {
  const inner = delegate();
  const provider = new ModeAwareEmailProvider(inner, 'disabled');
  assert.equal(provider.namespace, 'resend:disabled');
  await assert.rejects(provider.sendCustomerOrderConfirmation(message, 'k'), (error: unknown) => error instanceof NotificationNotSent);
  assert.equal(inner.customer, 0);
  await provider.sendAdminOrderAlert(message, 'k');
  assert.equal(inner.admin, 1);
});

test('mode-scoped namespaces stop a test/disabled run from suppressing a later live send', () => {
  const inner = delegate();
  assert.equal(new ModeAwareEmailProvider(inner, 'live').namespace, 'resend');
  assert.equal(new ModeAwareEmailProvider(inner, 'test').namespace, 'resend:test');
  assert.equal(new ModeAwareEmailProvider(inner, 'disabled').namespace, 'resend:disabled');
});

const baseEnv = {
  ALVERON_API_BASE_URL: 'http://127.0.0.1:4000/api',
  ALVERON_SERVICE_EMAIL: 'synthetic@example.invalid', ALVERON_SERVICE_PASSWORD: 'synthetic-password',
  GATEWAY_API_KEY: 'synthetic-test-key-not-a-secret-0001', ADMIN_ALERT_EMAIL: 'admin@example.invalid',
  LEDGER_DATABASE_URL: 'sqlite:synthetic.sqlite',
};

test('ALVERON_AUTOMATION_MODE accepts live, test and disabled only', () => {
  assert.equal(loadConfig({ ...baseEnv, ALVERON_AUTOMATION_MODE: 'live' }).automationMode, 'live');
  assert.equal(loadConfig({ ...baseEnv, ALVERON_AUTOMATION_MODE: 'test' }).automationMode, 'test');
  assert.equal(loadConfig({ ...baseEnv, ALVERON_AUTOMATION_MODE: 'disabled' }).automationMode, 'disabled');
  for (const invalid of ['off', 'production', 'true', '']) {
    assert.throws(() => loadConfig({ ...baseEnv, ALVERON_AUTOMATION_MODE: invalid }));
  }
});

test('resend provider requires an API key and a valid sender address', () => {
  assert.throws(() => loadConfig({ ...baseEnv, EMAIL_PROVIDER: 'resend' }));
  assert.throws(() => loadConfig({ ...baseEnv, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_synthetic_key' }));
  assert.throws(() => loadConfig({ ...baseEnv, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_synthetic_key', RESEND_FROM_EMAIL: 'not-an-email' }));
  const config = loadConfig({
    ...baseEnv, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_synthetic_key',
    RESEND_FROM_EMAIL: 'orders@example.invalid',
  });
  assert.equal(config.emailProvider, 'resend');
  assert.deepEqual(config.resend, {
    apiKey: 're_synthetic_key', fromEmail: 'orders@example.invalid', fromName: 'Alveron Fashion', timeoutMs: 10000,
  });
  assert.equal(loadConfig({ ...baseEnv, EMAIL_PROVIDER: 'console' }).resend, null);
});
