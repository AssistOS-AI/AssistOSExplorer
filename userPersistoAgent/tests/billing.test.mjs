import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'userpersisto-billing-'));
process.env.PERSISTENCE_FOLDER = join(dir, 'persisto');
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
process.env.USERPERSISTO_SETTINGS_FILE = join(dir, 'settings.enc.json');

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser } = await import('../lib/users.mjs');
const { saveSettings } = await import('../lib/settings.mjs');
const billing = await import('../lib/billing.mjs');
const credits = await import('../lib/credits.mjs');
const { getStore, flush, resetStoreForTests } = await import('../lib/store.mjs');

after(async () => {
    await resetStoreForTests();
});

function sign(rawBody, secret) {
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    return `t=${t},v1=${v1}`;
}

function signWithTimestamp(rawBody, secret, timestamp) {
    const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    return `t=${timestamp},v1=${v1}`;
}

async function seedCreditCheckout({ sessionId, userId, credits, amountMinor = 0, currency = '' }) {
    const timestamp = new Date().toISOString();
    await (await getStore()).createPaymentTransaction({
        providerKey: `stripe:checkout:${sessionId}`,
        provider: 'stripe',
        providerEventId: '',
        providerObjectId: sessionId,
        userId,
        kind: 'credits',
        status: 'checkout_created',
        amountMinor,
        currency,
        credits,
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    await flush();
}

test('webhook applies credits exactly once (idempotent by stripeEventId)', async () => {
    await ensureSeedData();
    await saveSettings({ STRIPE_WEBHOOK_SECRET: 'whsec_test', USERPERSISTO_CREDITS_PER_UNIT: '10' });
    const user = await createUser({ email: 'pay@x.com', displayName: 'Pay', roles: ['user'] });
    await seedCreditCheckout({ sessionId: 'cs_001', userId: user.id, credits: 30 });
    await saveSettings({ USERPERSISTO_CREDITS_PER_UNIT: '100' });

    const event = {
        id: 'evt_001',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_001', payment_status: 'paid', client_reference_id: user.id, metadata: { kind: 'credits', units: '3' } } }
    };
    const rawBody = JSON.stringify(event);
    const signatureHeader = sign(rawBody, 'whsec_test');

    const first = await billing.processStripeWebhook({ rawBody, signatureHeader });
    assert.equal(first.processed, true);
    assert.equal(first.duplicate, false);
    assert.equal((await credits.getBalance(user.id)).balance, 30);

    const second = await billing.processStripeWebhook({ rawBody, signatureHeader });
    assert.equal(second.duplicate, true);
    assert.equal((await credits.getBalance(user.id)).balance, 30);
});

test('checkout identity conflicts fail before credits are applied', async () => {
    await saveSettings({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
    const owner = await createUser({ email: 'payment-owner@x.com', roles: ['user'] });
    const other = await createUser({ email: 'payment-other@x.com', roles: ['user'] });
    await seedCreditCheckout({ sessionId: 'cs_bound_owner', userId: owner.id, credits: 25 });
    const event = {
        id: 'evt_wrong_payment_owner',
        type: 'checkout.session.completed',
        data: {
            object: {
                id: 'cs_bound_owner',
                payment_status: 'paid',
                client_reference_id: other.id,
                metadata: { kind: 'credits', units: '1', userId: other.id },
            },
        },
    };
    const rawBody = JSON.stringify(event);
    await assert.rejects(
        () => billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_test') }),
        (error) => error?.code === 'payment_identity_conflict'
    );
    assert.equal((await credits.getBalance(owner.id)).balance, 0);
    assert.equal((await credits.getBalance(other.id)).balance, 0);
});

test('paid credit checkout requires a locally initiated transaction', async () => {
    await saveSettings({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
    const user = await createUser({ email: 'missing-checkout@x.com', roles: ['user'] });
    const event = {
        id: 'evt_missing_checkout',
        type: 'checkout.session.completed',
        data: {
            object: {
                id: 'cs_not_local',
                payment_status: 'paid',
                client_reference_id: user.id,
                metadata: { kind: 'credits', units: '1', userId: user.id },
            },
        },
    };
    const rawBody = JSON.stringify(event);
    await assert.rejects(
        () => billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_test') }),
        (error) => error?.code === 'payment_transaction_not_found'
    );
    assert.equal((await credits.getBalance(user.id)).balance, 0);
});

test('unpaid checkout completion does not grant credits', async () => {
    const user = await createUser({ email: 'unpaid@x.com', displayName: 'Unpaid', roles: ['user'] });
    const event = {
        id: 'evt_unpaid',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_unpaid', payment_status: 'unpaid', client_reference_id: user.id, metadata: { kind: 'credits', units: '50' } } }
    };
    const rawBody = JSON.stringify(event);
    const outcome = await billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_test') });
    assert.equal(outcome.credited, false);
    assert.equal((await credits.getBalance(user.id)).balance, 0);
});

test('a processed Stripe event id cannot be reused with another payload', async () => {
    const original = JSON.stringify({ id: 'evt_payload', type: 'noop', data: { object: { value: 1 } } });
    await billing.processStripeWebhook({ rawBody: original, signatureHeader: sign(original, 'whsec_test') });
    const changed = JSON.stringify({ id: 'evt_payload', type: 'noop', data: { object: { value: 2 } } });
    await assert.rejects(
        () => billing.processStripeWebhook({ rawBody: changed, signatureHeader: sign(changed, 'whsec_test') }),
        /different payload/i
    );
});

test('event idempotency survives webhook-secret rotation', async () => {
    const rawBody = JSON.stringify({ id: 'evt_secret_rotation', type: 'noop', data: { object: {} } });
    await saveSettings({ STRIPE_WEBHOOK_SECRET: 'whsec_rotation_a' });
    await billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_rotation_a') });
    await saveSettings({ STRIPE_WEBHOOK_SECRET: 'whsec_rotation_b' });
    const duplicate = await billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_rotation_b') });
    assert.equal(duplicate.duplicate, true);
});

test('webhook rejects a bad signature', async () => {
    await saveSettings({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
    const rawBody = JSON.stringify({ id: 'evt_002', type: 'checkout.session.completed', data: { object: {} } });
    await assert.rejects(() => billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'wrong-secret') }), /signature/i);
});

test('signature verification rejects a non-numeric timestamp', () => {
    const rawBody = JSON.stringify({ id: 'evt_bad_t' });
    assert.equal(billing.verifyStripeSignature(rawBody, signWithTimestamp(rawBody, 'whsec_test', 'not-a-number'), 'whsec_test'), false);
});

test('signature verification rejects fractional timestamps', () => {
    const rawBody = JSON.stringify({ id: 'evt_fractional_t' });
    const timestamp = `${Math.floor(Date.now() / 1000)}.5`;
    assert.equal(billing.verifyStripeSignature(rawBody, signWithTimestamp(rawBody, 'whsec_test', timestamp), 'whsec_test'), false);
});

test('checkout rejects invalid financial boundaries before contacting Stripe', async () => {
    await assert.rejects(
        () => billing.createCheckout({ userId: 'user-1', kind: 'credits', quantity: 0 }),
        (error) => error?.code === 'invalid_quantity'
    );
    await assert.rejects(
        () => billing.createCheckout({ userId: 'user-1', kind: 'credits', quantity: 1, idempotencyKey: 'x'.repeat(256) }),
        (error) => error?.code === 'invalid_idempotency_key'
    );
});

test('checkout rejects an unknown user before contacting Stripe', async () => {
    const originalFetch = globalThis.fetch;
    let contacted = false;
    globalThis.fetch = async () => {
        contacted = true;
        throw new Error('unexpected Stripe request');
    };
    try {
        await assert.rejects(
            () => billing.createCheckout({ userId: 'missing-user', kind: 'credits', quantity: 1 }),
            (error) => error?.code === 'user_not_found'
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(contacted, false);
});

test('checkout scopes Stripe idempotency by user and persists provider transactions', async () => {
    await saveSettings({
        STRIPE_SECRET_KEY: 'sk_test',
        STRIPE_PRICE_CREDITS: 'price_credits',
        USERPERSISTO_BILLING_SUCCESS_URL: 'https://app.example.test/billing/success',
        USERPERSISTO_BILLING_CANCEL_URL: 'https://app.example.test/billing/cancel',
    });
    const first = await createUser({ email: 'checkout-a@x.com', roles: ['user'] });
    const second = await createUser({ email: 'checkout-b@x.com', roles: ['user'] });
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
        requests.push(options);
        const index = requests.length;
        return {
            ok: true,
            async json() {
                return {
                    id: `cs_scoped_${index}`,
                    url: `https://checkout.stripe.com/c/pay/scoped-${index}`,
                    amount_total: 100,
                    currency: 'usd',
                };
            },
        };
    };
    try {
        await billing.createCheckout({ userId: first.id, kind: 'credits', quantity: 1, idempotencyKey: 'same-client-key' });
        await billing.createCheckout({ userId: second.id, kind: 'credits', quantity: 1, idempotencyKey: 'same-client-key' });
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.notEqual(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
    assert.equal((await billing.listPaymentTransactions({ userId: first.id })).objects.length, 1);
    assert.equal((await billing.listPaymentTransactions({ userId: second.id })).objects.length, 1);
});

test('subscription events upsert current provider subscription state', async (t) => {
    await saveSettings({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
    const user = await createUser({ email: 'sub@x.com', displayName: 'Sub', roles: ['user'] });
    const event = {
        id: 'evt_003',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_001', status: 'active', metadata: { userId: user.id }, items: { data: [{ price: { id: 'price_sub' } }] }, current_period_end: 1893456000 } }
    };
    const rawBody = JSON.stringify(event);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, 'https://api.stripe.com/v1/subscriptions/sub_001');
        assert.equal(options.method, 'GET');
        return { ok: true, json: async () => event.data.object };
    });
    await billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_test') });
    const sub = await billing.getSubscription(user.id);
    assert.equal(sub.status, 'active');
    assert.equal(sub.provider, 'stripe');
});

test('a Stripe subscription identity cannot move between users', async (t) => {
    await saveSettings({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
    const first = await createUser({ email: 'sub-owner-a@x.com', roles: ['user'] });
    const second = await createUser({ email: 'sub-owner-b@x.com', roles: ['user'] });
    const firstEvent = {
        id: 'evt_sub_owner_a',
        type: 'customer.subscription.created',
        data: { object: { id: 'sub_bound', status: 'active', metadata: { userId: first.id } } },
    };
    const firstBody = JSON.stringify(firstEvent);
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => firstEvent.data.object }));
    await billing.processStripeWebhook({ rawBody: firstBody, signatureHeader: sign(firstBody, 'whsec_test') });

    const movedEvent = {
        id: 'evt_sub_owner_b',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_bound', status: 'active', metadata: { userId: second.id } } },
    };
    const movedBody = JSON.stringify(movedEvent);
    await assert.rejects(
        () => billing.processStripeWebhook({ rawBody: movedBody, signatureHeader: sign(movedBody, 'whsec_test') }),
        (error) => error?.code === 'subscription_identity_conflict'
    );
});

test('checkout retries preserve the purchase snapshot and terminal payment state across restart', async (t) => {
    await saveSettings({
        STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRICE_CREDITS: 'price_original',
        USERPERSISTO_CREDITS_PER_UNIT: '10',
        USERPERSISTO_BILLING_SUCCESS_URL: 'https://app.example.test/original-success',
        USERPERSISTO_BILLING_CANCEL_URL: 'https://app.example.test/original-cancel',
    });
    const user = await createUser({ email: 'checkout-immutable@x.com', roles: ['user'] });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests++;
        const intent = await (await getStore()).getCheckoutIntentByIntentKey(options.headers['Idempotency-Key']);
        assert.equal(intent.credits, 10, 'the intent exists before any provider effect');
        return { ok: true, json: async () => ({
            id: 'cs_immutable', url: 'https://checkout.stripe.com/c/pay/immutable', amount_total: 100, currency: 'usd',
        }) };
    });
    const input = { userId: user.id, kind: 'credits', quantity: 1, idempotencyKey: 'immutable-purchase' };
    const first = await billing.createCheckout(input);
    await saveSettings({ USERPERSISTO_CREDITS_PER_UNIT: '100', STRIPE_PRICE_CREDITS: 'price_replaced' });
    assert.deepEqual(await billing.createCheckout(input), first);
    await assert.rejects(() => billing.createCheckout({ ...input, quantity: 2 }), { code: 'checkout_idempotency_conflict' });
    const rawBody = JSON.stringify({ id: 'evt_immutable_paid', type: 'checkout.session.completed', data: { object: {
        id: first.sessionId, payment_status: 'paid', client_reference_id: user.id,
        amount_total: 100, currency: 'usd', metadata: { kind: 'credits', units: '1', userId: user.id },
    } } });
    await billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_test') });
    await resetStoreForTests();
    assert.deepEqual(await billing.createCheckout(input), first);
    const payment = await (await getStore()).getPaymentTransactionByProviderKey('stripe:checkout:cs_immutable');
    assert.equal(payment.credits, 10);
    assert.equal(payment.status, 'paid');
    assert.equal(payment.providerEventId, 'evt_immutable_paid');
    assert.equal((await credits.getBalance(user.id)).balance, 10);
    assert.equal(requests, 1, 'exact retries never create another provider session');
});

test('uncertain checkout retries use the durable original request and stop before Stripe key expiry', async (t) => {
    await saveSettings({ USERPERSISTO_CREDITS_PER_UNIT: '7', STRIPE_PRICE_CREDITS: 'price_uncertain' });
    const user = await createUser({ email: 'checkout-uncertain@x.com', roles: ['user'] });
    const input = { userId: user.id, kind: 'credits', quantity: 2, idempotencyKey: 'uncertain-purchase' };
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests.push({ key: options.headers['Idempotency-Key'], form: options.body.toString() });
        throw new Error('fixture response lost');
    });
    await assert.rejects(() => billing.createCheckout(input), /fixture response lost/);
    await resetStoreForTests();
    await saveSettings({ USERPERSISTO_CREDITS_PER_UNIT: '70', STRIPE_PRICE_CREDITS: 'price_changed' });
    await assert.rejects(() => billing.createCheckout(input), /fixture response lost/);
    assert.deepEqual(requests[1], requests[0]);
    const store = await getStore();
    const intent = await store.getCheckoutIntentByIntentKey(requests[0].key);
    assert.equal(intent.credits, 14);
    await store.updateCheckoutIntent(intent.id, { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
    await flush();
    await assert.rejects(() => billing.createCheckout(input), { code: 'checkout_reconciliation_required' });
    assert.equal(requests.length, 2);
});

test('a paid webhook repairs a lost checkout response using its durable intent', async (t) => {
    await saveSettings({ USERPERSISTO_CREDITS_PER_UNIT: '9' });
    const user = await createUser({ email: 'checkout-response-lost@x.com', roles: ['user'] });
    let metadata;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        metadata = Object.fromEntries([...options.body.entries()]
            .filter(([name]) => name.startsWith('metadata[')).map(([name, value]) => [name.slice(9, -1), value]));
        throw new Error('fixture checkout accepted but response lost');
    });
    await assert.rejects(() => billing.createCheckout({
        userId: user.id, kind: 'credits', quantity: 3, idempotencyKey: 'lost-response',
    }), /response lost/);
    await resetStoreForTests();
    const rawBody = JSON.stringify({ id: 'evt_response_lost_paid', type: 'checkout.session.completed', data: { object: {
        id: 'cs_response_lost', payment_status: 'paid', client_reference_id: user.id,
        amount_total: 300, currency: 'usd', metadata,
    } } });
    const result = await billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_test') });
    assert.equal(result.credited, true);
    assert.equal((await credits.getBalance(user.id)).balance, 27);
    assert.equal((await (await getStore()).getCheckoutIntentByIntentKey(metadata.checkoutIntentKey)).sessionId, 'cs_response_lost');
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(options.method, 'GET');
        assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions/cs_response_lost');
        return { ok: true, json: async () => ({ id: 'cs_response_lost', url: null, status: 'complete', payment_status: 'paid' }) };
    });
    const replay = await billing.createCheckout({ userId: user.id, kind: 'credits', quantity: 3, idempotencyKey: 'lost-response' });
    assert.equal(replay.sessionId, 'cs_response_lost');
    assert.equal(new URL(replay.url).pathname, '/original-success');
    assert.equal((await (await getStore()).getPaymentTransactionByProviderKey('stripe:checkout:cs_response_lost')).status, 'paid');
});

test('reordered and equal-time subscription events cannot restore stale active state', async (t) => {
    const user = await createUser({ email: 'subscription-reordered@x.com', roles: ['user'] });
    let current = { id: 'sub_reordered', status: 'past_due', metadata: { userId: user.id } };
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        requests++;
        return { ok: true, json: async () => current };
    });
    async function deliver(id, type, created, status) {
        const rawBody = JSON.stringify({ id, type, created, data: { object: {
            id: 'sub_reordered', status, metadata: { userId: user.id },
        } } });
        return billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_test') });
    }
    await deliver('evt_sub_stale_active', 'customer.subscription.updated', 100, 'active');
    assert.equal((await billing.getSubscription(user.id)).status, 'past_due');
    current = { ...current, status: 'canceled' };
    await deliver('evt_sub_same_second', 'customer.subscription.updated', 100, 'active');
    assert.equal((await billing.getSubscription(user.id)).status, 'canceled');
    await resetStoreForTests();
    current = { ...current, status: 'active' };
    await deliver('evt_sub_older_after_delete', 'customer.subscription.updated', 99, 'active');
    assert.equal((await billing.getSubscription(user.id)).status, 'canceled');
    assert.equal(requests, 2, 'a durable canceled subscription never resumes under the same id');
});

test('subscription reconciliation failures remain retryable without applying snapshot entitlements', async (t) => {
    const user = await createUser({ email: 'subscription-retry@x.com', roles: ['user'] });
    let available = false;
    t.mock.method(globalThis, 'fetch', async () => {
        if (!available) throw new Error('fixture provider unavailable');
        return { ok: true, json: async () => ({ id: 'sub_retry', status: 'canceled', metadata: { userId: user.id } }) };
    });
    const rawBody = JSON.stringify({ id: 'evt_sub_retry', type: 'customer.subscription.updated', data: { object: {
        id: 'sub_retry', status: 'active', metadata: { userId: user.id },
    } } });
    await assert.rejects(() => billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_test') }), /provider unavailable/);
    assert.equal(await billing.getSubscription(user.id), null);
    available = true;
    assert.equal((await billing.processStripeWebhook({ rawBody, signatureHeader: sign(rawBody, 'whsec_test') })).processed, true);
    assert.equal((await billing.getSubscription(user.id)).status, 'canceled');
});

for (const stalledPhase of ['request', 'response body']) {
    test(`Stripe ${stalledPhase} timeout releases queued billing and preserves the retry intent`, async (t) => {
        await saveSettings({
            STRIPE_SECRET_KEY: 'sk_test', STRIPE_PRICE_CREDITS: 'price_before_timeout',
            USERPERSISTO_CREDITS_PER_UNIT: '13',
            USERPERSISTO_BILLING_SUCCESS_URL: 'https://app.example.test/timeout-success',
            USERPERSISTO_BILLING_CANCEL_URL: 'https://app.example.test/timeout-cancel',
        });
        const user = await createUser({ email: `timeout-${stalledPhase.replaceAll(' ', '-')}@x.com`, roles: ['user'] });
        const input = { userId: user.id, kind: 'credits', quantity: 2, idempotencyKey: `timeout-${stalledPhase}` };
        const requests = [];
        let entered;
        const stalled = new Promise((resolve) => { entered = resolve; });
        t.mock.timers.enable({ apis: ['setTimeout'] });
        t.mock.method(globalThis, 'fetch', async (_url, options) => {
            requests.push({ key: options.headers['Idempotency-Key'], form: options.body.toString(), signal: options.signal });
            assert.ok(options.signal instanceof AbortSignal);
            if (requests.length === 1) {
                const waitForAbort = () => new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                    entered();
                });
                if (stalledPhase === 'request') return waitForAbort();
                return { ok: true, json: waitForAbort };
            }
            return { ok: true, json: async () => ({
                id: `cs_timeout_${stalledPhase.replaceAll(' ', '_')}_${requests.length}`,
                url: 'https://checkout.stripe.com/c/pay/after-timeout', amount_total: 200, currency: 'usd',
            }) };
        });
        const first = billing.createCheckout(input);
        const timedOut = assert.rejects(first, { code: 'stripe_timeout', statusCode: 504 });
        await stalled;
        const queued = billing.createCheckout({ ...input, idempotencyKey: `queued-${stalledPhase}` });
        t.mock.timers.tick(14_999);
        assert.equal(requests[0].signal.aborted, false);
        assert.equal(requests.length, 1, 'the later purchase waits for the billing mutex');
        t.mock.timers.tick(1);
        await timedOut;
        await queued;
        await saveSettings({ STRIPE_PRICE_CREDITS: 'price_after_timeout', USERPERSISTO_CREDITS_PER_UNIT: '130' });
        const retry = await billing.createCheckout(input);
        assert.equal(requests.length, 3);
        assert.equal(requests[2].key, requests[0].key);
        assert.equal(requests[2].form, requests[0].form);
        assert.equal((await (await getStore()).getPaymentTransactionByProviderKey(`stripe:checkout:${retry.sessionId}`)).credits, 26);
        t.mock.timers.tick(15_000);
        assert.equal(requests[1].signal.aborted, false, 'completed requests clear their deadlines');
        assert.equal(requests[2].signal.aborted, false);
    });
}
