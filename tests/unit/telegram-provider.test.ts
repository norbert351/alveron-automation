import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/integrations/alveron/config.js';
import { createLogger } from '../../src/integrations/alveron/logger.js';
import { parseOrder } from '../../src/integrations/alveron/schemas.js';
import { AppError } from '../../src/integrations/alveron/errors.js';
import { SqliteLedger, type Ledger } from '../../src/ledger/sqlite-ledger.js';
import { NotificationNotSent } from '../../src/providers/notification-delivery.js';
import {
  paidOrderNotification,
  referralRewardNotification,
  renderTelegramHtml,
  type AdminNotificationProvider,
} from '../../src/providers/admin/index.js';
import { AdminNotificationService } from '../../src/providers/admin/service.js';
import { TelegramAdminNotificationProvider } from '../../src/providers/telegram.js';

const token = ['1234567890', 'synthetic-test-token-not-real'].join(':');
const order = parseOrder({
  id: '00000000-0000-4000-8000-000000000001', order_number: 1042, status: 'paid', payment_status: 'SUCCESS',
  customer_email: 'fixture@example.invalid', customer_name: '<Admin> & Customer', total: 85000,
  subtotal: 85000, shipping: 0, discount: 0, currency: 'NGN',
  items: [{ title: 'Synthetic dress', variant_title: 'M', quantity: 2, price: 42500 }], payments: [],
});
const timing = () => {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
};

const okResponse = () => Response.json({ ok: true, result: { message_id: 12345 } });

test('Telegram HTML escapes customer-controlled values and renders actual paid-order data', () => {
  const html = renderTelegramHtml(paidOrderNotification(order));
  assert.match(html, /NEW PAID ORDER/);
  assert.match(html, /#1042/);
  assert.match(html, /₦85,000/);
  assert.match(html, /&lt;Admin&gt; &amp; Customer/);
  assert.equal(html.includes('<Admin>'), false);
});

test('Telegram renderer truncates escaped oversized values inside the byte-safe limit', () => {
  const rendered = renderTelegramHtml({
    kind: 'TELEGRAM_TEST', eventKey: 'oversized', resourceId: 'oversized', severity: 'INFO',
    heading: 'Oversized test', fields: [{ label: 'Value', value: '&<>'.repeat(1000) }],
  });
  assert.equal(Buffer.byteLength(rendered, 'utf8') <= 4096, true);
  assert.match(rendered, /&amp;&lt;&gt;/);
});

test('mocked Telegram send uses official HTTPS sendMessage, configured chat, and HTML without a real API call', async () => {
  let requestedUrl = '';
  let requestBody: Record<string, unknown> = {};
  const provider = new TelegramAdminNotificationProvider(token, '-1001234567890', 1000, async (input, init) => {
    requestedUrl = input.toString();
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return okResponse();
  }, timing());
  const receipt = await provider.send(paidOrderNotification(order), 'telegram:paid-order:test');
  assert.deepEqual(receipt, { messageId: '12345', simulated: false });
  const url = new URL(requestedUrl);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'api.telegram.org');
  assert.equal(url.pathname.endsWith('/sendMessage'), true);
  assert.equal(requestBody['chat_id'], '-1001234567890');
  assert.equal(requestBody['parse_mode'], 'HTML');
  assert.equal(String(requestBody['text']).includes('&lt;Admin&gt;'), true);
});

test('Telegram failures distinguish definite non-delivery from ambiguous transport failure', async () => {
  let rateLimitedCalls = 0;
  const definite = new TelegramAdminNotificationProvider(token, '12345', 1000, async () => {
    rateLimitedCalls++;
    return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 });
  }, timing());
  await assert.rejects(definite.send(paidOrderNotification(order), 'test'), NotificationNotSent);
  assert.equal(rateLimitedCalls, 2);
  const ambiguous = new TelegramAdminNotificationProvider(token, '12345', 1000, async () => {
    throw new Error('synthetic network failure');
  }, timing());
  await assert.rejects(ambiguous.send(paidOrderNotification(order), 'test'), (error: unknown) =>
    !(error instanceof NotificationNotSent));
});

test('Telegram namespace is destination-specific and never contains the bot token or chat ID', () => {
  const first = new TelegramAdminNotificationProvider(token, '12345', 1000, async () => okResponse(), timing());
  const second = new TelegramAdminNotificationProvider(token, '-1001234567890', 1000, async () => okResponse(), timing());
  assert.match(first.namespace, /^telegram:[0-9a-f]{16}$/);
  assert.notEqual(first.namespace, second.namespace);
  assert.equal(first.namespace.includes(token.split(':')[0]!), false);
  assert.equal(first.namespace.includes('12345'), false);
});

test('rapid Telegram messages to one admin chat are serialized at the official one-per-second guidance', async () => {
  const starts: number[] = [];
  const clock = timing();
  const measuredTiming = { now: clock.now, sleep: clock.sleep };
  const provider = new TelegramAdminNotificationProvider(token, '12345', 1000, async () => {
    starts.push(measuredTiming.now());
    return okResponse();
  }, measuredTiming);
  await Promise.all([
    provider.send(paidOrderNotification(order), 'first'),
    provider.send(referralRewardNotification({
      reference: 'reward-batch:1-2', newlyRewarded: 1, rewardAmount: null,
      rewardedTotal: 2, qualifiedTotal: 0,
      observedAt: '2026-09-25T10:00:00.000Z',
    }), 'second'),
  ]);
  assert.deepEqual(starts, [0, 1100]);
});

test('Telegram limiter enforces the conservative twenty-message group ceiling', async () => {
  const starts: number[] = [];
  const clock = timing();
  const provider = new TelegramAdminNotificationProvider(token, '-1001234567890', 1000, async () => {
    starts.push(clock.now()); return okResponse();
  }, clock);
  await Promise.all(Array.from({ length: 21 }, (_, index) =>
    provider.send(paidOrderNotification(order), `rate-${index}`)));
  assert.equal(starts.length, 21);
  assert.deepEqual(starts.slice(0, 20), Array.from({ length: 20 }, (_, index) => index * 1100));
  assert.equal(starts[20], 60000);
});

test('a Telegram rate limit pauses every queued delivery until retry_after expires', async () => {
  const starts: number[] = [];
  let calls = 0;
  const clock = timing();
  const provider = new TelegramAdminNotificationProvider(token, '12345', 1000, async () => {
    calls++; starts.push(clock.now());
    return calls <= 2
      ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, { status: 429 })
      : okResponse();
  }, clock);
  await assert.rejects(provider.send(paidOrderNotification(order), 'limited'), NotificationNotSent);
  await provider.send(paidOrderNotification(order), 'after-cooldown');
  assert.deepEqual(starts, [0, 5000, 10000]);
});

test('an extreme Telegram retry_after value is bounded and cannot deadlock the queue', async () => {
  const starts: number[] = [];
  let calls = 0;
  const clock = timing();
  const provider = new TelegramAdminNotificationProvider(token, '12345', 1000, async () => {
    calls++; starts.push(clock.now());
    return calls === 1
      ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: Number.MAX_VALUE } }, { status: 429 })
      : okResponse();
  }, clock);
  await assert.rejects(provider.send(paidOrderNotification(order), 'limited'), NotificationNotSent);
  await provider.send(paidOrderNotification(order), 'after-cooldown');
  assert.deepEqual(starts, [0, 120000]);
});

test('Telegram timeout covers a response that never produces headers', async () => {
  const provider = new TelegramAdminNotificationProvider(token, '12345', 1000, async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
    }), timing());
  await assert.rejects(provider.send(paidOrderNotification(order), 'test'), (error: unknown) =>
    !(error instanceof NotificationNotSent));
});

test('Telegram caps the response body before parsing', async () => {
  const provider = new TelegramAdminNotificationProvider(token, '12345', 1000, async () =>
    new Response('x'.repeat(65537), { status: 200, headers: { 'content-type': 'application/json' } }), timing());
  await assert.rejects(provider.send(paidOrderNotification(order), 'test'), (error: unknown) =>
    !(error instanceof NotificationNotSent));
});

test('Telegram cancels a malformed successful response body', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{}')); },
    cancel() { cancelled = true; },
  });
  const provider = new TelegramAdminNotificationProvider(token, '12345', 1000, async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }), timing());
  await assert.rejects(provider.send(paidOrderNotification(order), 'test'));
  assert.equal(cancelled, true);
});

test('admin notification ledger deduplicates success across restart and retries only definite failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alveron-telegram-ledger-'));
  const path = join(dir, 'ledger.sqlite');
  let sends = 0;
  const provider: AdminNotificationProvider = {
    namespace: 'telegram', enabled: true,
    send: async () => { sends++; return { messageId: 'synthetic', simulated: true }; },
  };
  let ledger = new SqliteLedger(path);
  try {
    const service = new AdminNotificationService(ledger, provider, createLogger('silent'));
    assert.equal((await service.notify(paidOrderNotification(order))).status, 'SUCCESS');
    assert.equal((await service.notify(paidOrderNotification(order))).status, 'SKIPPED');
    ledger.close();
    ledger = new SqliteLedger(path);
    const restarted = new AdminNotificationService(ledger, provider, createLogger('silent'));
    assert.equal((await restarted.notify(paidOrderNotification(order))).status, 'SKIPPED');
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  assert.equal(sends, 1);

  const retryLedger = new SqliteLedger(':memory:');
  try {
    let fail = true;
    const retryProvider: AdminNotificationProvider = {
      namespace: 'telegram', enabled: true,
      send: async () => {
        if (fail) throw new NotificationNotSent();
        return { messageId: 'synthetic', simulated: true };
      },
    };
    const service = new AdminNotificationService(retryLedger, retryProvider, createLogger('silent'));
    assert.equal((await service.notify(paidOrderNotification(order))).status, 'FAILED');
    fail = false;
    assert.equal((await service.notify(paidOrderNotification(order))).status, 'SUCCESS');
  } finally { retryLedger.close(); }
});

test('ledger write failures are reported as pending rather than falsely failed', async () => {
  const base = new SqliteLedger(':memory:');
  try {
    const failingClaim: Ledger = {
      claim: () => { throw new AppError('LEDGER_FAILURE'); },
      markSuccess: base.markSuccess.bind(base), markFailure: base.markFailure.bind(base),
      get: base.get.bind(base), has: base.has.bind(base),
      getState: base.getState.bind(base), setState: base.setState.bind(base),
    };
    const provider: AdminNotificationProvider = {
      namespace: 'telegram', enabled: true,
      send: async () => ({ messageId: 'synthetic', simulated: true }),
    };
    const claimService = new AdminNotificationService(failingClaim, provider, createLogger('silent'));
    assert.deepEqual(await claimService.notify(paidOrderNotification(order)), {
      status: 'PENDING', reason: 'LEDGER_FAILURE',
    });
    const failingMark: Ledger = {
      claim: base.claim.bind(base), markSuccess: base.markSuccess.bind(base),
      markFailure: () => { throw new AppError('LEDGER_FAILURE'); },
      get: base.get.bind(base), has: base.has.bind(base),
      getState: base.getState.bind(base), setState: base.setState.bind(base),
    };
    const markService = new AdminNotificationService(failingMark, {
      namespace: 'telegram', enabled: true, send: async () => { throw new NotificationNotSent(); },
    }, createLogger('silent'));
    assert.deepEqual(await markService.notify(paidOrderNotification(order)), {
      status: 'PENDING', reason: 'LEDGER_FAILURE',
    });
  } finally { base.close(); }
});

test('ambiguous Telegram delivery remains pending and cannot create duplicates', async () => {
  const ledger = new SqliteLedger(':memory:');
  try {
    let sends = 0;
    const provider: AdminNotificationProvider = {
      namespace: 'telegram', enabled: true,
      send: async () => { sends++; throw new Error('synthetic ambiguous failure'); },
    };
    const service = new AdminNotificationService(ledger, provider, createLogger('silent'));
    assert.equal((await service.notify(paidOrderNotification(order))).status, 'PENDING');
    assert.equal((await service.notify(paidOrderNotification(order))).status, 'SKIPPED');
    assert.equal(sends, 1);
  } finally { ledger.close(); }
});

test('Telegram config is disabled without secrets and requires both trusted values when enabled', () => {
  const env = {
    ALVERON_API_BASE_URL: 'http://127.0.0.1:4000/api', ALVERON_SERVICE_EMAIL: 'synthetic@example.invalid',
    ALVERON_SERVICE_PASSWORD: 'synthetic-password', GATEWAY_API_KEY: 'synthetic-test-key-not-a-secret-0001',
    ADMIN_ALERT_EMAIL: 'admin@example.invalid', LEDGER_DATABASE_URL: 'sqlite:synthetic.sqlite',
  };
  assert.equal(loadConfig(env).telegram.provider, 'disabled');
  const enabled = loadConfig({ ...env, TELEGRAM_PROVIDER: 'telegram', TELEGRAM_BOT_TOKEN: token, TELEGRAM_ADMIN_CHAT_ID: '-1001234567890' });
  assert.equal(enabled.telegram.provider, 'telegram');
  assert.equal(enabled.telegram.adminChatId, '-1001234567890');
  assert.throws(() => loadConfig({ ...env, TELEGRAM_PROVIDER: 'telegram', TELEGRAM_BOT_TOKEN: token }));
  assert.throws(() => loadConfig({ ...env, TELEGRAM_PROVIDER: 'telegram', TELEGRAM_ADMIN_CHAT_ID: '12345' }));
  assert.throws(() => loadConfig({ ...env, TELEGRAM_PROVIDER: 'telegram', TELEGRAM_BOT_TOKEN: token, TELEGRAM_ADMIN_CHAT_ID: 'arbitrary chat' }));
  assert.throws(() => loadConfig({ ...env, TELEGRAM_BOT_TOKEN: token }));
});
