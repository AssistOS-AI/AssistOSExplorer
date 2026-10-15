import { createRedactor, findSecretLeaks } from './security.mjs';
import { redactTraceText, findTraceCredentialResidue } from './redacted-trace.mjs';
import { createReleaseGateFailureCollector } from './release-gate-failures.mjs';

// Read only own data descriptors. Errors and thrown objects can have hostile
// getters, toString methods, cycles, or nested AggregateError children.
export function projectLiveSessionError(error, { env = process.env, maxDepth = 8, maxNodes = 64,
    maxText = 8192, maxBytes = 65536 } = {}) {
    const secrets = Object.entries(env).filter(([key, value]) => /PASSWORD|TOKEN|SECRET|KEY|JWT|COOKIE/i.test(key)
        && typeof value === 'string' && value.length >= 6).map(([name, value]) => ({ name, value }));
    const redact = createRedactor(secrets), seen = new Set();
    let nodes = 0, remaining = maxBytes;
    const text = value => {
        const safe = redactTraceText(redact(typeof value === 'string' ? value : String(value)));
        if (findSecretLeaks(safe, secrets).length || findTraceCredentialResidue(safe).length) return '[REDACTED:RESIDUE]';
        const limit = Math.max(0, Math.min(maxText, remaining));
        let bounded = safe;
        if (Buffer.byteLength(bounded) > limit) {
            bounded = Buffer.from(bounded).subarray(0, Math.max(0, limit - 32)).toString('utf8') + '[truncated text]';
        }
        remaining -= Math.min(remaining, Buffer.byteLength(bounded));
        return bounded;
    };
    const own = (object, key) => {
        try { return Object.getOwnPropertyDescriptor(object, key); } catch { return null; }
    };
    function visit(value, depth) {
        if (depth > maxDepth || ++nodes > maxNodes || remaining <= 0) return { truncated: '[truncated error tree]' };
        if (value === null || !['object', 'function'].includes(typeof value)) {
            return { name: 'ThrownValue', message: text(['string', 'number', 'boolean', 'bigint', 'undefined'].includes(typeof value) ? value : '[unsupported primitive]') };
        }
        if (seen.has(value)) return { truncated: '[cyclic error reference]' };
        seen.add(value);
        const output = {};
        for (const key of ['name', 'message', 'stack', 'truncated']) {
            const descriptor = own(value, key);
            if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') output[key] = text(descriptor.value);
            else if (descriptor) output[key] = '[accessor omitted]';
        }
        if (!output.name) output.name = 'Error';
        const cause = own(value, 'cause');
        if (cause) output.cause = 'value' in cause ? visit(cause.value, depth + 1) : { message: '[accessor omitted]' };
        const children = own(value, 'errors');
        if (children && 'value' in children && Array.isArray(children.value)) {
            output.errors = [];
            const length = own(children.value, 'length')?.value || 0;
            for (let index = 0; index < Math.min(length, maxNodes); index += 1) {
                const descriptor = own(children.value, String(index));
                output.errors.push(descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : { message: '[accessor omitted]' });
            }
            if (length > maxNodes) output.errors.push({ truncated: '[truncated children]' });
        }
        return output;
    }
    return visit(error, 0);
}

export function createLiveSessionFinalizer({ env = process.env } = {}) {
    const collector = createReleaseGateFailureCollector({ env });
    const failures = [];
    const add = (label, error) => {
        const safe = { label, error: projectLiveSessionError(error, { env }) };
        failures.push(safe);
        collector.add(label, new Error(JSON.stringify(safe.error)));
    };
    return {
        add,
        async required(label, operation) {
            try { return await operation(); } catch (error) { add(label, error); return undefined; }
        },
        async finish(testInfo, primaryError, { hasPrimary = primaryError !== undefined } = {}) {
            const primary = hasPrimary ? { label: 'primary failure', error: projectLiveSessionError(primaryError, { env }) } : null;
            if (!primary && failures.length === 0) return;
            const payload = () => ({ ...(primary ? { primary } : {}), requiredFailures: failures });
            try { await testInfo.attach('live-session-failures.json', { body: Buffer.from(JSON.stringify(payload(), null, 2)), contentType: 'application/json' }); }
            catch (error) { add('safe failure attachment', error); }
            // Playwright omits AggregateError.errors. All projected children are
            // also in the thrown message, even if attaching evidence failed.
            collector.throwIfAny({ primaryError: primary ? new Error(JSON.stringify(payload())) : null, label: 'Live Sessions' });
        },
    };
}
