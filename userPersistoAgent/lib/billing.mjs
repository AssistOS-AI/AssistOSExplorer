import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getStore, flush } from './store.mjs';
import { getSecret, saveSettings } from './settings.mjs';
import { applyPurchase } from './credits.mjs';
import { recordAudit } from './audit.mjs';
import { serialize } from './serial.mjs';
import { assertRedirectUriAllowed } from './policy.mjs';

function parseStripeSignature(signatureHeader) {
    const parts = {};
    for (const part of String(signatureHeader || '').split(',')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        const key = part.slice(0, separator);
        const value = part.slice(separator + 1);
        (parts[key] ||= []).push(value);
    }
    return parts;
}

function positiveInteger(value, fallback = null, label = 'value') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    if (fallback !== null && (value === undefined || value === null || String(value).trim() === '')) return fallback;
    throw Object.assign(new Error(`${label} must be a positive safe integer.`), {
        code: `invalid_${label}`,
        statusCode: 400,
    });
}

function normalizeIdempotencyKey(value) {
    const normalized = String(value || '').trim() || randomUUID();
    if (normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)) {
        throw Object.assign(new Error('idempotencyKey must contain 1-255 printable characters.'), {
            code: 'invalid_idempotency_key',
            statusCode: 400,
        });
    }
    return normalized;
}

function scopedStripeIdempotencyKey({ userId, kind, requestKey }) {
    return createHash('sha256')
        .update(`userpersisto-checkout-v1\0${userId}\0${kind}\0${requestKey}`)
        .digest('base64url');
}

function requiredUrl(value, name) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch {
        throw new Error(`${name} must be configured as an absolute http(s) URL.`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${name} must be configured as an absolute http(s) URL without credentials.`);
    }
    return url.toString();
}

function requiredHttpsUrl(value, name) {
    const normalized = requiredUrl(value, name);
    if (new URL(normalized).protocol !== 'https:') {
        throw new Error(`${name} must use HTTPS.`);
    }
    return normalized;
}

export function verifyStripeSignature(rawBody, signatureHeader, secret) {
    const parts = parseStripeSignature(signatureHeader);
    const timestamp = parts.t?.[0] || '';
    const signatures = parts.v1 || [];
    if (!/^\d+$/.test(timestamp) || signatures.length === 0 || !secret) return false;
    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;
    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const expectedBytes = Buffer.from(expected);
    return signatures.some((signature) => {
        const actualBytes = Buffer.from(String(signature));
        return actualBytes.length === expectedBytes.length && timingSafeEqual(expectedBytes, actualBytes);
    });
}

async function stripeRequest(path, form, { idempotencyKey = '', method = 'POST', apiVersion = '' } = {}) {
    const key = await getSecret('STRIPE_SECRET_KEY');
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured.');
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(`https://api.stripe.com/v1/${path}`, {
            method,
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
                ...(apiVersion ? { 'Stripe-Version': apiVersion } : {}),
            },
            ...(form ? { body: new URLSearchParams(form) } : {}),
        });
        // The same deadline covers the response body, which can stall even
        // after headers arrive. Never turn an aborted body into success data.
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.message || `Stripe ${path} failed (${response.status})`);
        return data;
    } catch (error) {
        if (controller.signal.aborted) {
            throw Object.assign(new Error('Stripe request timed out.'), { code: 'stripe_timeout', statusCode: 504 });
        }
        throw error;
    } finally {
        clearTimeout(deadline);
    }
}

async function upsertPayment(store, record) {
    const existing = await store.getPaymentTransactionByProviderKey(record.providerKey);
    if (existing) {
        for (const field of ['provider', 'providerObjectId', 'userId', 'kind', 'credits']) {
            if (String(existing[field] || '') !== String(record[field] || '')) {
                throw Object.assign(new Error(`Payment identity conflict for ${record.providerKey}.`), {
                    code: 'payment_identity_conflict',
                    statusCode: 409,
                });
            }
        }
        if (existing.status === 'paid' || record.status === 'checkout_created') return existing;
        return store.updatePaymentTransaction(existing.id, {
            ...record,
            createdAt: existing.createdAt,
            updatedAt: new Date().toISOString(),
        });
    }
    return store.createPaymentTransaction(record);
}

function creditPrice(unitAmountMinor, currency) {
    const price = {
        unitAmountMinor: positiveInteger(unitAmountMinor, null, 'credits_unit_amount'),
        currency: String(currency || '').trim().toLowerCase(),
    };
    if (price.unitAmountMinor > 99_999_999) throw new Error('Credit price exceeds the supported payment amount.');
    if (!/^[a-z]{3}$/.test(price.currency)) throw new Error('Points currency must be a three-letter currency code.');
    if (['isk', 'ugx'].includes(price.currency) && price.unitAmountMinor % 100 !== 0) {
        throw new Error('Credit prices in ISK and UGX must be whole currency units.');
    }
    return price;
}

async function configuredCreditPrice() {
    return creditPrice(...await Promise.all([
        getSecret('USERPERSISTO_CREDIT_UNIT_AMOUNT_MINOR'),
        getSecret('USERPERSISTO_CREDITS_CURRENCY'),
    ]));
}

function creditPaymentTerms(form) {
    const unitAmount = positiveInteger(form['line_items[0][price_data][unit_amount]'], null, 'credits_unit_amount');
    const quantity = positiveInteger(form['line_items[0][quantity]'], null, 'quantity');
    const amountMinor = unitAmount * quantity;
    if (!Number.isSafeInteger(amountMinor) || amountMinor > 99_999_999) throw new Error('Points purchase exceeds the supported payment amount.');
    return { amountMinor, currency: form['line_items[0][price_data][currency]'] };
}

function verifyCreditPayment(object, expected) {
    if (!Number.isSafeInteger(object.amount_total) || object.amount_total <= 0 || object.amount_total !== expected.amountMinor) {
        throw Object.assign(new Error('Stripe checkout amount does not match the initiated transaction.'), {
            code: 'payment_amount_conflict', statusCode: 409,
        });
    }
    if (!expected.currency || object.currency !== expected.currency) {
        throw Object.assign(new Error('Stripe checkout currency does not match the initiated transaction.'), {
            code: 'payment_currency_conflict', statusCode: 409,
        });
    }
}

const validPublishableKey = value => /^pk_(test|live)_[A-Za-z0-9]+$/.test(value);

export async function getCreditOffer() {
    const [secret, webhook, publishable, amount, currency] = await Promise.all([
        getSecret('STRIPE_SECRET_KEY'), getSecret('STRIPE_WEBHOOK_SECRET'), getSecret('STRIPE_PUBLISHABLE_KEY'),
        getSecret('USERPERSISTO_CREDIT_UNIT_AMOUNT_MINOR'),
        getSecret('USERPERSISTO_CREDITS_CURRENCY'),
    ]);
    if (!secret || !webhook || !validPublishableKey(publishable) || !amount || !currency) return { available: false };
    try {
        return { available: true, ...creditPrice(amount, currency) };
    } catch {
        return { available: false };
    }
}

export async function getCreditOfferSettings() {
    const values = await Promise.all([
        getSecret('USERPERSISTO_CREDIT_UNIT_AMOUNT_MINOR'),
        getSecret('USERPERSISTO_CREDITS_CURRENCY'),
    ]);
    return { unitAmountMinor: Number(values[0]) || null, currency: values[1] };
}

export async function setCreditOfferSettings({ unitAmountMinor, currency }, actorId) {
    const price = creditPrice(unitAmountMinor, currency);
    await saveSettings({
        USERPERSISTO_CREDIT_UNIT_AMOUNT_MINOR: String(price.unitAmountMinor),
        USERPERSISTO_CREDITS_CURRENCY: price.currency,
    });
    await recordAudit({actorId, action:'billing.points-offer.update', target:'credit-price', reason:JSON.stringify(price)});
    await flush();
    return price;
}

export async function createCheckout({ userId, kind, quantity = 1, idempotencyKey = '', returnUrl, uiMode = 'hosted' }) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) throw new Error('userId is required.');
    if (!['credits', 'subscription'].includes(kind)) throw new Error(`Unknown checkout kind: ${kind}`);
    if (!['hosted', 'elements'].includes(uiMode) || (uiMode === 'elements' && kind !== 'credits')) throw new Error('Invalid checkout interface.');
    const embedded = uiMode === 'elements';
    const publishableKey = embedded ? await getSecret('STRIPE_PUBLISHABLE_KEY') : '';
    if (embedded && !validPublishableKey(publishableKey)) throw new Error('Stripe publishable key is not configured.');
    const units = positiveInteger(quantity, null, 'quantity');
    const destination = await assertRedirectUriAllowed(requiredUrl(returnUrl, 'Checkout return URL'));
    const requestKey = normalizeIdempotencyKey(idempotencyKey);
    const providerIdempotencyKey = scopedStripeIdempotencyKey({ userId: normalizedUserId, kind, requestKey });
    const requestHash = createHash('sha256').update(JSON.stringify({ userId: normalizedUserId, kind, units, returnUrl: destination, ...(embedded ? {uiMode} : {}) })).digest('base64url');
    return serialize('stripe:billing', async () => {
        const store = await getStore();
        const user = (await store.hasUser(normalizedUserId)) ? await store.getUser(normalizedUserId) : null;
        if (!user) {
            throw Object.assign(new Error('User not found.'), { code: 'user_not_found', statusCode: 404 });
        }
        if (user.status !== 'active') {
            throw Object.assign(new Error('Authentication required.'), { code: 'invalid_session', statusCode: 401 });
        }
        let intent = await store.getCheckoutIntentByIntentKey(providerIdempotencyKey);
        if (intent && intent.requestHash !== requestHash) {
            throw Object.assign(new Error('Checkout idempotency key was reused with different purchase parameters.'), {
                code: 'checkout_idempotency_conflict', statusCode: 409,
            });
        }
        if (!intent) {
            const price = kind === 'credits' ? await configuredCreditPrice() : null;
            const subscriptionPrice = kind === 'subscription' ? await getSecret('STRIPE_PRICE_SUBSCRIPTION') : null;
            if (kind === 'subscription' && !subscriptionPrice) throw new Error('Stripe subscription price is not configured.');
            const expectedCredits = kind === 'credits'
                ? units
                : 0;
            if (!Number.isSafeInteger(expectedCredits)) throw new Error('Calculated credit amount is invalid.');
            const form = {
                mode: kind === 'credits' ? 'payment' : 'subscription',
                client_reference_id: normalizedUserId,
                ...(price ? {
                    'line_items[0][price_data][currency]': price.currency,
                    'line_items[0][price_data][unit_amount]': String(price.unitAmountMinor),
                    'line_items[0][price_data][product_data][name]': 'Credit',
                } : { 'line_items[0][price]': subscriptionPrice }),
                'line_items[0][quantity]': String(units),
                'metadata[kind]': kind,
                'metadata[units]': String(units),
                'metadata[userId]': normalizedUserId,
                'metadata[checkoutIntentKey]': providerIdempotencyKey,
                ...(embedded ? {
                    ui_mode: 'elements',
                    return_url: destination + (destination.includes('?') ? '&' : '?') + 'checkout_session_id={CHECKOUT_SESSION_ID}',
                    customer_email: user.email,
                    'adaptive_pricing[enabled]': 'false',
                } : {success_url: destination, cancel_url: destination}),
            };
            if (kind === 'subscription') form['subscription_data[metadata][userId]'] = normalizedUserId;
            else creditPaymentTerms(form);
            const timestamp = new Date().toISOString();
            intent = await store.createCheckoutIntent({
                intentKey: providerIdempotencyKey, requestHash, userId: normalizedUserId, kind, units,
                credits: expectedCredits, form, sessionId: '', checkoutUrl: '', createdAt: timestamp, updatedAt: timestamp,
            });
            // A provider effect is never attempted before its immutable local
            // purchase intent is durable. Uncertain responses reuse this form.
            await flush();
        }
        if (!embedded && intent.sessionId && intent.checkoutUrl) {
            return { url: intent.checkoutUrl, sessionId: intent.sessionId, idempotencyKey: requestKey };
        }
        // Stripe may prune idempotency keys after 24 hours. An unresolved
        // older intent must be reconciled, never submitted as a new purchase.
        const intentCreatedAt = Date.parse(intent.createdAt);
        if (!intent.sessionId && (!Number.isFinite(intentCreatedAt)
            || Date.now() - intentCreatedAt >= 23 * 60 * 60 * 1000)) {
            throw Object.assign(new Error('Checkout requires provider reconciliation before it can be retried.'), {
                code: 'checkout_reconciliation_required', statusCode: 409,
            });
        }
        const session = intent.sessionId
            ? await stripeRequest(`checkout/sessions/${encodeURIComponent(intent.sessionId)}`, null, { method: 'GET', apiVersion: embedded ? '2026-10-28.endive' : '' })
            : await stripeRequest('checkout/sessions', intent.form, { idempotencyKey: providerIdempotencyKey, apiVersion: embedded ? '2026-10-28.endive' : '' });
        if (!String(session.id || '').trim()) {
            throw new Error('Stripe returned an incomplete checkout session.');
        }
        if (intent.sessionId && intent.sessionId !== session.id) throw new Error('Stripe returned a different checkout session.');
        const checkoutUrl = embedded ? '' : session.url
            ? requiredHttpsUrl(session.url, 'Stripe checkout URL')
            : (intent.sessionId && (session.status === 'complete' || session.payment_status === 'paid')
                ? requiredUrl(intent.form.success_url, 'Stored checkout success URL')
                : '');
        if ((!embedded && !checkoutUrl) || (embedded && session.status !== 'complete' && !session.client_secret)) throw new Error('Stripe returned an incomplete checkout session.');
        const terms = kind === 'credits' ? creditPaymentTerms(intent.form) : null;
        if (terms) verifyCreditPayment(session, terms);
        const timestamp = new Date().toISOString();
        await upsertPayment(store, {
            providerKey: `stripe:checkout:${session.id}`,
            provider: 'stripe',
            providerEventId: '',
            providerObjectId: String(session.id || ''),
            userId: normalizedUserId,
            kind,
            status: 'checkout_created',
            amountMinor: terms?.amountMinor ?? (Number.isSafeInteger(session.amount_total) ? session.amount_total : 0),
            currency: terms?.currency ?? String(session.currency || '').toLowerCase(),
            credits: intent.credits,
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        await store.updateCheckoutIntent(intent.id, { sessionId: session.id, checkoutUrl, updatedAt: timestamp });
        await flush();
        await recordAudit({ actorId: normalizedUserId, action: 'billing.checkout.create', target: session.id, reason: kind });
        await flush();
        return embedded
            ? { sessionId: session.id, clientSecret: session.client_secret, publishableKey, status: session.status, idempotencyKey: requestKey,
                credits: intent.credits, createdAt: intent.createdAt, ...terms }
            : { url: checkoutUrl, sessionId: session.id, idempotencyKey: requestKey };
    });
}

async function upsertSubscription(store, snapshot, event) {
    const providerRef = String(snapshot.id || '').trim();
    if (!providerRef) throw new Error('Subscription event is missing its provider identity.');
    const existing = await store.getSubscriptionByProviderRef(providerRef);
    const snapshotUserId = String(snapshot.metadata?.userId || snapshot.client_reference_id || '').trim();
    if (existing && snapshotUserId && snapshotUserId !== existing.userId) {
        throw Object.assign(new Error(`Subscription identity conflict for ${providerRef}.`), {
            code: 'subscription_identity_conflict', statusCode: 409,
        });
    }
    // A canceled Stripe subscription cannot resume under the same identifier.
    // Keep a durable tombstone even if a later delivery contains active state.
    if (existing?.status === 'canceled') return;
    // Delivery order and second-resolution event timestamps are not versions.
    // Read Stripe's current resource under the billing serialization boundary.
    const object = await stripeRequest(`subscriptions/${encodeURIComponent(providerRef)}`, null, { method: 'GET' });
    if (object.id !== providerRef || !String(object.status || '').trim()) {
        throw new Error('Stripe returned an invalid subscription.');
    }
    const userId = String(object.metadata?.userId || existing?.userId || snapshotUserId || '').trim();
    if (!userId) throw new Error('Subscription has no linked user identity.');
    if ((snapshotUserId && snapshotUserId !== userId) || (existing && existing.userId !== userId)) {
        throw Object.assign(new Error(`Subscription identity conflict for ${providerRef}.`), {
            code: 'subscription_identity_conflict', statusCode: 409,
        });
    }
    const periodEnd = object.current_period_end || object.items?.data?.[0]?.current_period_end;
    const record = {
        providerRef,
        userId,
        provider: 'stripe',
        planId: object.items?.data?.[0]?.price?.id || '',
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : object.status,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : '',
        reconciledAt: new Date().toISOString(),
        sourceEventId: event.id,
    };
    if (!(await store.hasUser(userId))) {
        throw Object.assign(new Error('User not found.'), { code: 'user_not_found', statusCode: 404 });
    }
    if (existing) {
        if (String(existing.userId || '') !== record.userId || String(existing.provider || '') !== record.provider) {
            throw Object.assign(new Error(`Subscription identity conflict for ${record.providerRef}.`), {
                code: 'subscription_identity_conflict',
                statusCode: 409,
            });
        }
        await store.updateSubscription(existing.id, record);
    } else {
        await store.createSubscription(record);
    }
}

async function applyPaidCheckout(store, event, object) {
    const eventType = String(event.type || '');
    const paid = object.payment_status === 'paid' || eventType === 'checkout.session.async_payment_succeeded';
    if (!paid || object.metadata?.kind !== 'credits') return { credited: false };
    const metadataUserId = String(object.metadata?.userId || '').trim();
    const clientUserId = String(object.client_reference_id || '').trim();
    if (metadataUserId && clientUserId && metadataUserId !== clientUserId) {
        throw Object.assign(new Error('Stripe checkout user identity is inconsistent.'), {
            code: 'payment_identity_conflict',
            statusCode: 409,
        });
    }
    const userId = metadataUserId || clientUserId;
    const objectId = String(object.id || '').trim();
    if (!userId || !objectId) throw new Error('Paid checkout is missing user or session identity.');
    positiveInteger(object.metadata?.units, null, 'units');
    const providerKey = `stripe:checkout:${objectId}`;
    let checkout = await store.getPaymentTransactionByProviderKey(providerKey);
    // A signed webhook can arrive after Stripe accepted checkout but before
    // its response reached us. Its metadata links the durable local intent.
    if (!checkout && object.metadata?.checkoutIntentKey) {
        const intent = await store.getCheckoutIntentByIntentKey(String(object.metadata.checkoutIntentKey));
        if (intent) {
            if (intent.userId !== userId || intent.kind !== 'credits'
                || intent.units !== Number(object.metadata.units)
                || (intent.sessionId && intent.sessionId !== objectId)) {
                throw Object.assign(new Error('Stripe checkout conflicts with its local intent.'), {
                    code: 'payment_identity_conflict', statusCode: 409,
                });
            }
            const terms = creditPaymentTerms(intent.form);
            verifyCreditPayment(object, terms);
            const timestamp = new Date().toISOString();
            checkout = await upsertPayment(store, {
                providerKey, provider: 'stripe', providerEventId: '', providerObjectId: objectId,
                userId, kind: 'credits', status: 'checkout_created', credits: intent.credits,
                amountMinor: terms.amountMinor,
                currency: terms.currency, createdAt: intent.createdAt, updatedAt: timestamp,
            });
            await store.updateCheckoutIntent(intent.id, { sessionId: objectId, updatedAt: timestamp });
            await flush();
        }
    }
    if (!checkout) {
        throw Object.assign(new Error('Stripe checkout was not initiated by UserPersisto.'), {
            code: 'payment_transaction_not_found',
            statusCode: 409,
        });
    }
    const credits = Number(checkout.credits || 0);
    if (!Number.isSafeInteger(credits) || credits <= 0) {
        throw Object.assign(new Error('Stored checkout credits are invalid.'), {
            code: 'payment_transaction_invalid',
            statusCode: 409,
        });
    }
    verifyCreditPayment(object, {amountMinor: checkout.amountMinor, currency: checkout.currency});
    const amountMinor = object.amount_total, currency = object.currency;
    const timestamp = new Date().toISOString();
    await upsertPayment(store, {
        providerKey,
        provider: 'stripe',
        providerEventId: String(event.id || ''),
        providerObjectId: objectId,
        userId,
        kind: 'credits',
        status: 'paid',
        amountMinor: amountMinor || Number(checkout.amountMinor || 0),
        currency: currency || String(checkout.currency || ''),
        credits,
        createdAt: checkout.createdAt || timestamp,
        updatedAt: timestamp,
    });
    const creditResult = await applyPurchase({ userId, amount: credits, referenceId: providerKey });
    return { credited: !creditResult.idempotent, credits, userId };
}

// Browser confirmation is a request to verify; only Stripe's server response proves payment.
export async function verifyCheckout({ userId, sessionId }) {
    if (!/^cs_[A-Za-z0-9_]{1,200}$/.test(String(sessionId || ''))) throw new Error('Invalid checkout session.');
    return serialize('stripe:billing', async () => {
        const store = await getStore();
        const payment = await store.getPaymentTransactionByProviderKey(`stripe:checkout:${sessionId}`);
        if (!payment || payment.userId !== userId || payment.kind !== 'credits') {
            throw Object.assign(new Error('Checkout not found.'), { code: 'checkout_not_found', statusCode: 404 });
        }
        const details = { credits: payment.credits, amountMinor: payment.amountMinor, currency: payment.currency, createdAt: payment.createdAt };
        const unpaid = status => ({ status, credited: false, ...details });
        if (payment.status === 'failed') return unpaid('failed');
        const session = await stripeRequest(`checkout/sessions/${encodeURIComponent(sessionId)}`, undefined, { method: 'GET', apiVersion: '2026-10-28.endive' });
        if (session.id !== sessionId) throw new Error('Stripe returned a different checkout session.');
        if (session.payment_status !== 'paid') {
            if (session.status === 'expired') return unpaid('expired');
            const intentId = session.payment_intent;
            if (!intentId && session.status === 'open') return unpaid('open');
            if (/^pi_[A-Za-z0-9_]+$/.test(intentId || '')) {
                const intent = await stripeRequest(`payment_intents/${intentId}`, undefined, { method: 'GET', apiVersion: '2026-10-28.endive' });
                if (intent.id !== intentId) throw new Error('Stripe returned a different payment intent.');
                if (intent.status === 'canceled') return unpaid('failed');
                if (intent.status === 'requires_payment_method') {
                    if (session.status === 'open') return unpaid('open');
                    if (session.status === 'complete') return unpaid('failed');
                }
            }
            return unpaid('pending');
        }
        const effect = await applyPaidCheckout(store, { id: `api:${sessionId}`, type: 'checkout.session.verified' }, session);
        if (!effect.userId || effect.userId !== userId) throw new Error('Checkout payment identity is invalid.');
        if (effect.credited) await recordAudit({ actorId: userId, action: 'billing.checkout.verify', target: sessionId });
        await flush();
        return { status: 'paid', credited: effect.credited, ...details };
    });
}

async function recordFailedCheckout(store, event, session) {
    if (session.metadata?.kind !== 'credits') return;
    const payment = await store.getPaymentTransactionByProviderKey(`stripe:checkout:${session.id}`);
    if (!payment || payment.kind !== 'credits') {
        throw Object.assign(new Error('Stripe checkout was not initiated by UserPersisto.'), {
            code: 'payment_transaction_not_found', statusCode: 409,
        });
    }
    const userId = session.metadata.userId || session.client_reference_id;
    if (userId !== payment.userId || (session.client_reference_id && session.client_reference_id !== userId)) {
        throw Object.assign(new Error('Stripe checkout user identity is inconsistent.'), {
            code: 'payment_identity_conflict', statusCode: 409,
        });
    }
    verifyCreditPayment(session, { amountMinor: payment.amountMinor, currency: payment.currency });
    await upsertPayment(store, { ...payment, providerEventId: event.id, status: 'failed' });
}

// Recover an existing payment using Stripe's authenticated event API, never browser claims.
export async function reconcileCheckoutEvent({ eventId, actorId }) {
    if (!/^evt_[A-Za-z0-9]+$/.test(String(eventId || ''))) throw new Error('Invalid Stripe event id.');
    return serialize('stripe:billing', async () => {
        const event = await stripeRequest(`events/${encodeURIComponent(eventId)}`, undefined, { method: 'GET' });
        if (event.id !== eventId || !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
            throw new Error('The Stripe event does not confirm a checkout payment.');
        }
        const session = event.data?.object;
        if (!session || session.payment_status !== 'paid' || session.metadata?.kind !== 'credits') {
            return { credited: false, eventId };
        }
        const effect = await applyPaidCheckout(await getStore(), event, session);
        if (effect.credited) await recordAudit({ actorId, action: 'billing.checkout.reconcile', target: session.id, reason: eventId });
        await flush();
        return { ...effect, eventId };
    });
}

export async function processStripeWebhook({ rawBody, signatureHeader }) {
    const secret = await getSecret('STRIPE_WEBHOOK_SECRET');
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
    if (!verifyStripeSignature(rawBody, signatureHeader, secret)) {
        throw Object.assign(new Error('Invalid Stripe signature'), { statusCode: 400, code: 'invalid_stripe_signature' });
    }
    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        throw Object.assign(new Error('Invalid Stripe payload'), { statusCode: 400, code: 'invalid_stripe_payload' });
    }
    const eventId = String(event.id || '').trim();
    if (!eventId) throw new Error('Stripe event id is required.');
    const payloadHash = createHash('sha256').update(rawBody).digest('base64url');

    return serialize('stripe:billing', async () => {
        const store = await getStore();
        let eventRecord = await store.getBillingEventByStripeEventId(eventId);
        if (eventRecord?.payloadHash && eventRecord.payloadHash !== payloadHash) {
            throw Object.assign(new Error('Stripe event id was reused with a different payload.'), {
                code: 'stripe_event_payload_conflict',
                statusCode: 409,
            });
        }
        if (eventRecord?.status === 'processed') return { processed: false, duplicate: true, eventId };
        const eventData = {
            stripeEventId: eventId,
            type: String(event.type || ''),
            status: 'processing',
            payloadHash,
            processedAt: '',
        };
        if (eventRecord) await store.updateBillingEvent(eventRecord.id, eventData);
        else eventRecord = await store.createBillingEvent(eventData);
        await flush();

        try {
            const object = event.data?.object || {};
            let effect = { credited: false };
            if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
                effect = await applyPaidCheckout(store, event, object);
            } else if (event.type === 'checkout.session.async_payment_failed') {
                await recordFailedCheckout(store, event, object);
            } else if (String(event.type || '').startsWith('customer.subscription.')) {
                await upsertSubscription(store, object, event);
            }
            await store.updateBillingEvent(eventRecord.id, { status: 'processed', processedAt: new Date().toISOString() });
            await flush();
            await recordAudit({ actorId: 'stripe', action: 'billing.webhook.process', target: eventId, reason: event.type });
            await flush();
            return { processed: true, duplicate: false, eventId, ...effect };
        } catch (error) {
            await store.updateBillingEvent(eventRecord.id, { status: 'failed', processedAt: new Date().toISOString() });
            await flush();
            throw error;
        }
    });
}

export async function getSubscription(userId) {
    const store = await getStore();
    const subs = await store.getSubscriptionsObjectsByUserId(userId) || [];
    return subs.find((subscription) => subscription.status === 'active') || subs[0] || null;
}

export async function listBillingEvents({ start = 0, pageSize = 100 } = {}) {
    const store = await getStore();
    return store.select('billingEvent', {}, {
        sortBy: 'processedAt',
        descending: true,
        start: Number.isInteger(start) && start >= 0 ? start : 0,
        pageSize: Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 500) : 100,
    });
}

export async function listPaymentTransactions({ userId = '', start = 0, pageSize = 100 } = {}) {
    const store = await getStore();
    return store.select('paymentTransaction', userId ? { userId } : {}, {
        sortBy: 'updatedAt',
        descending: true,
        start: Number.isInteger(start) && start >= 0 ? start : 0,
        pageSize: Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 500) : 100,
    });
}
