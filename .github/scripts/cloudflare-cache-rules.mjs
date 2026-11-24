#!/usr/bin/env node
// Runner CLI. Exit 0 means the requested state was verified, 1 means refusal or failure.
// The caller supplies only the token's environment variable name on the command line.
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const cachePhase = 'http_request_cache_settings';
const responsePhase = 'http_response_cache_settings';
const hexId = /^[a-f0-9]{32}$/;
const dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const stableRef = /^[a-zA-Z0-9_-]{1,128}$/;
// Free Cache Rules support for has_key is undocumented. T3 decides whether to use this fallback.
const AUTHORIZATION_FALLBACK = 'any(lower(http.request.headers.names[*])[*] eq "authorization")';
const R1_EXPRESSION = host => `(http.host eq "${host}" and (http.cookie ne "" or has_key(http.request.headers, "authorization")))`;
const R2_EXPRESSION = host => `(http.host eq "${host}")`;

function requireState(ok, message) {
    if (!ok) throw new Error(message);
}

const usage = 'usage: cloudflare-cache-rules.mjs check|--check|ensure-r1|r2-off|r2-on --token-env NAME [--if-present | --activation-receipt FILE] [--existing-only]';

function configuration([operation, ...args], env) {
    if (operation === '--check') operation = 'check';
    let values;
    try {
        ({ values } = parseArgs({ args, options: {
            'token-env': { type: 'string', multiple: true },
            'if-present': { type: 'boolean', multiple: true },
            'activation-receipt': { type: 'string', multiple: true },
            'existing-only': { type: 'boolean', multiple: true },
        } }));
    } catch { throw new Error(usage); }
    requireState(['check', 'ensure-r1', 'r2-off', 'r2-on'].includes(operation)
        && Object.values(values).every(items => items.length === 1), usage);
    const tokenName = values['token-env']?.[0];
    const ifPresent = values['if-present']?.[0];
    const receipt = values['activation-receipt']?.[0];
    const existingOnly = values['existing-only']?.[0] === true;
    requireState(typeof tokenName === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenName)
        && (!ifPresent || operation === 'r2-off')
        && (receipt === undefined || (receipt && !ifPresent && ['r2-off', 'r2-on'].includes(operation)))
        // The first creation of the owned rules needs approval (D19), so this option never
        // combines with a recovery or a disable that cannot create.
        && (!existingOnly || operation === 'ensure-r1' || operation === 'r2-on'
            || (operation === 'r2-off' && !ifPresent && receipt === undefined)), usage);

    const { PUBLIC_HOST: host, CLOUDFLARE_ZONE_ID: zone, CLOUDFLARE_CACHE_R1_REF: r1, CLOUDFLARE_CACHE_R2_REF: r2 } = env;
    requireState(typeof zone === 'string' && hexId.test(zone) && typeof host === 'string' && dnsName.test(host),
        'Invalid cache target');
    requireState([r1, r2].every(ref => typeof ref === 'string' && stableRef.test(ref)) && r1 !== r2,
        'Invalid or ambiguous rule refs');
    const token = Object.hasOwn(env, tokenName) && env[tokenName];
    requireState(typeof token === 'string' && token.length > 0 && token.length <= 512
        && !/[\s\x00-\x1f\x7f]/.test(token) && !token.startsWith('cfk_'), 'Missing or invalid scoped runner token');
    return { operation, ifPresent, receipt, existingOnly, zone, host, r1, r2, token };
}

function ruleDefinitions({ host, r1, r2 }) {
    return {
        r1: {
            ref: r1,
            description: `Bypass credentialed requests to ${host}`,
            expression: R1_EXPRESSION(host),
            action: 'set_cache_settings',
            action_parameters: { cache: false },
            enabled: true,
        },
        r2: {
            ref: r2,
            description: `Respect origin cache policy on ${host}`,
            expression: R2_EXPRESSION(host),
            action: 'set_cache_settings',
            action_parameters: {
                cache: true,
                edge_ttl: { mode: 'bypass_by_default' },
                browser_ttl: { mode: 'respect_origin' },
            },
            enabled: false,
        },
    };
}

// Prove positive host restrictions only. For AND one required operand suffices.
// For OR every branch needs its own proof. Opaque predicates provide no proof.
// Reject unfamiliar quoting/operators rather than interpreting their contents.
function hostRestricted(expression, accepts) {
    if (typeof expression !== 'string' || expression.length > 8192) return false;
    const lexer = /\s+|"[^"\\\x00-\x1f]*"|[A-Za-z0-9_.:-]+|==|!=|[()[\]{},*<>]/gy;
    const tokens = [];
    const groups = [];
    const closing = { '(': ')', '[': ']', '{': '}' };
    for (let i = 0; i < expression.length;) {
        const token = lexer.exec(expression)?.[0];
        if (!token) return false;
        i = lexer.lastIndex;
        if (!token.trim()) continue;
        if (Object.hasOwn(closing, token)) groups.push(closing[token]);
        if ([')', ']', '}'].includes(token) && groups.pop() !== token) return false;
        tokens.push(token.startsWith('"') ? token : token.toLowerCase());
    }
    if (groups.length || tokens.includes('xor')) return false;

    function prove(start, end) {
        let depth = 0;
        let firstClose = end;
        const disjunctions = [];
        const conjunctions = [];
        for (let i = start; i < end; i++) {
            const token = tokens[i];
            if (Object.hasOwn(closing, token)) depth++;
            if ([')', ']', '}'].includes(token) && --depth === 0) firstClose = Math.min(firstClose, i);
            if (depth === 0 && token === 'or') disjunctions.push(i);
            if (depth === 0 && token === 'and') conjunctions.push(i);
        }
        const cuts = disjunctions.length ? disjunctions : conjunctions;
        if (cuts.length) {
            const operands = [...cuts, end];
            const restricted = (stop, i) => prove(i ? cuts[i - 1] + 1 : start, stop);
            return disjunctions.length ? operands.every(restricted) : operands.some(restricted);
        }
        if (tokens[start] === '(' && firstClose === end - 1) return prove(start + 1, end - 1);
        if (tokens[start] !== 'http.host') return false;
        let literals;
        if (['eq', '=='].includes(tokens[start + 1]) && end === start + 3) {
            literals = [tokens[start + 2]];
        } else if (tokens[start + 1] === 'in' && tokens[start + 2] === '{' && tokens[end - 1] === '}') {
            literals = tokens.slice(start + 3, end - 1);
        } else {
            return false;
        }
        return literals.length > 0 && literals.every(literal => {
            if (!literal.startsWith('"')) return false;
            const name = literal.slice(1, -1).toLowerCase().replace(/\.$/, '');
            return dnsName.test(name) && accepts(name);
        });
    }
    return prove(0, tokens.length);
}

function apiClient({ zone, token }, fetchImpl) {
    return async function request(path, method = 'GET', body, allowMissingPhase = false) {
        requireState(['GET', 'POST', 'PATCH'].includes(method), 'Invalid ruleset method');
        let response;
        let data;
        try {
            response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zone}${path}`, {
                method,
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                redirect: 'error',
                signal: AbortSignal.timeout(30_000),
                ...(body && { body: JSON.stringify(body) }),
            });
        } catch {
            throw new Error('Cloudflare cache rules API transport or response failure');
        }
        try { data = await response.json(); } catch { /* Preserve HTTP status without echoing the body. */ }
        if (allowMissingPhase && response.status === 404 && data?.success === false
            && data.result == null && Array.isArray(data.errors) && data.errors.length === 1 && data.errors[0]?.code === 10003) return null;
        const codes = Array.isArray(data?.errors) ? data.errors.map(error => error?.code).filter(Number.isSafeInteger) : [];
        requireState(response.ok && data?.success === true && data.result,
            `Cloudflare cache rules API rejected ${method} (HTTP ${response.status}, codes ${codes.join(',') || 'none'})`);
        return data.result;
    };
}

function validId(value) {
    return typeof value === 'string' && hexId.test(value);
}

async function readPhase(request, phase) {
    const set = await request(`/rulesets/phases/${phase}/entrypoint`, 'GET', undefined, true);
    if (set === null) return null;
    requireState(validId(set.id) && set.kind === 'zone' && set.phase === phase && Array.isArray(set.rules),
        `Malformed ${phase} entrypoint`);
    const refs = new Set();
    const ids = new Set();
    for (const rule of set.rules) {
        requireState(validId(rule?.id) && typeof rule.ref === 'string' && rule.ref.length > 0
            && typeof rule.expression === 'string' && (rule.enabled === undefined || typeof rule.enabled === 'boolean'),
        `Malformed ${phase} rule`);
        requireState(!ids.has(rule.id) && !refs.has(rule.ref), 'Duplicate rule id or ref makes ownership ambiguous');
        ids.add(rule.id);
        refs.add(rule.ref);
    }
    return set;
}

// Both prior implementations identified rules by ref. Reserve both sets of
// descriptions so a copy with a different ref cannot impersonate either rule.
function descriptionOwners(desired, host) {
    return new Map([
        [desired.r1.description, desired.r1.ref], [`Credentialed request cache bypass for ${host}`, desired.r1.ref],
        [desired.r2.description, desired.r2.ref], [`Origin-controlled cache for ${host}`, desired.r2.ref],
    ]);
}

async function inventory(request, target, descriptions) {
    const entry = await readPhase(request, cachePhase);
    const response = await readPhase(request, responsePhase);
    const rules = entry?.rules ?? [];
    const r1 = rules.find(rule => rule.ref === target.r1);
    const r2 = rules.find(rule => rule.ref === target.r2);
    // With --existing-only and neither owned rule present nothing is written, so neither the
    // capacity nor a foreign rule can refuse; run() then reports the absence without a write.
    const noWrite = target.existingOnly && !r1 && !r2;
    requireState(noWrite || rules.length + Number(!r1) + Number(!r2) <= 10, 'Insufficient Free-plan cache rule capacity');
    const foreign = rules.filter(rule => rule !== r1 && rule !== r2);
    for (const rule of rules) {
        if (foreign.includes(rule)) {
            // Disabling the owned R2 is always safe, so only r2-off may proceed beside a
            // foreign rule, and only while that rule claims no owned description.
            requireState(noWrite || target.operation === 'r2-off', 'Foreign rule in the request cache phase');
            requireState(!descriptions.has(rule.description), 'Ambiguous ownership of cache rule');
            continue;
        }
        requireState(rule.action === 'set_cache_settings' && typeof rule.enabled === 'boolean'
            && (!descriptions.has(rule.description) || descriptions.get(rule.description) === rule.ref)
            && hostRestricted(rule.expression, host => host === target.host), 'Ambiguous ownership of cache rule');
    }
    for (const rule of response?.rules ?? []) {
        requireState(rule.ref !== target.r1 && rule.ref !== target.r2 && !descriptions.has(rule.description)
            && !rules.some(owned => owned.id === rule.id), 'Cache Response Rule claims an owned identity');
        requireState(hostRestricted(rule.expression, host => host !== target.host), 'Cache Response Rule may match the managed host');
    }
    const ordered = !r1 || !r2 || rules.indexOf(r2) < rules.indexOf(r1);
    return { entry, response, r1, r2, ordered, foreign };
}

function ruleFields({ id, version, last_updated, ...fields }) {
    return fields;
}

// A rule update carries the full rule definition, so a switch resends the
// owned definition just read back with only `enabled` changed.
function switched({ ref, description, expression, action, action_parameters }, enabled) {
    return { ref, description, expression, action, action_parameters, enabled };
}

function sameRule(actual, desired) {
    return Boolean(actual && isDeepStrictEqual(ruleFields(actual), desired));
}

function activationIdentity({ zone, host, r1, r2 }, entryId, ruleId) {
    return { zone, host, r1, r2, entryId, ruleId };
}

async function readReceipt(target) {
    let receipt;
    try { receipt = JSON.parse(await readFile(target.receipt, 'utf8')); }
    catch { throw new Error('Unable to confirm R2 off: missing or invalid activation receipt'); }
    requireState(validId(receipt?.entryId) && validId(receipt?.ruleId)
        && isDeepStrictEqual(receipt, activationIdentity(target, receipt.entryId, receipt.ruleId)),
    'Unable to confirm R2 off: activation receipt does not match this target');
    return receipt;
}

// An enable can commit even if its reply or the subsequent inventory failed.
// Ignore unrelated scope conflicts, but refuse aliases of this exact R2 in
// either phase. A second lost acknowledgement also needs an independent read.
async function undoActivation(request, original, desired, descriptions) {
    async function readOriginal() {
        const response = await readPhase(request, responsePhase);
        const entry = await readPhase(request, cachePhase);
        const claimsR2 = rule => rule.id === original.ruleId || rule.ref === desired.ref
            || descriptions.get(rule.description) === desired.ref;
        const matches = entry?.rules.filter(claimsR2) ?? [];
        const rule = matches[0];
        requireState(entry?.id === original.entryId && matches.length === 1 && !response?.rules.some(claimsR2)
            && rule.id === original.ruleId && typeof rule.enabled === 'boolean'
            && sameRule(rule, { ...desired, enabled: rule.enabled }), 'Original R2 identity or definition changed');
        return rule;
    }
    const rule = await readOriginal();
    if (!rule.enabled) return false;
    let failure;
    try {
        await request(`/rulesets/${original.entryId}/rules/${original.ruleId}`, 'PATCH', switched(rule, false));
    } catch (error) { failure = error; }
    if ((await readOriginal()).enabled) throw failure ?? new Error('Original R2 is still enabled');
    return true;
}

export async function run(argv, { env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
    const target = configuration(argv, env);
    const { operation, host, zone } = target;
    const desired = ruleDefinitions(target);
    const descriptions = descriptionOwners(desired, host);
    const request = apiClient(target, fetchImpl);
    const recovery = operation === 'r2-off' && target.receipt ? await readReceipt(target) : null;
    const zoneInfo = await request('');
    requireState(zoneInfo.id === zone && typeof zoneInfo.name === 'string' && dnsName.test(zoneInfo.name)
        && (host === zoneInfo.name || host.endsWith(`.${zoneInfo.name}`)), 'Zone does not own the managed hostname');
    if (recovery) {
        let changed;
        try { changed = await undoActivation(request, recovery, desired.r2, descriptions); }
        catch (error) { throw new Error(`Unable to confirm R2 off: ${error.message}`); }
        log(`${host} ${target.r2}: original R2 confirmed off`);
        return changed ? 'applied' : 'unchanged';
    }

    const read = () => inventory(request, target, descriptions);
    let state = await read();
    let changed = false;
    if (target.existingOnly && !state.r1 && !state.r2) {
        // Decided from the one inventory read above: a missing entrypoint or absent refs mean the
        // first creation, which Daniel approves per zone (D19). Nothing is written, no receipt is made.
        log(`${host} ${target.r1}=absent ${target.r2}=absent; first creation needs approval (D19); nothing written`);
        return 'absent';
    }

    async function write(key, expected, payload) {
        const before = state;
        const current = before[key];
        if (!before.entry) {
            await request('/rulesets', 'POST', { name: 'Host cache settings', kind: 'zone', phase: cachePhase, rules: [expected] });
        } else {
            const rulesPath = `/rulesets/${before.entry.id}/rules`;
            await request(current ? `${rulesPath}/${current.id}` : rulesPath, current ? 'PATCH' : 'POST', payload);
        }
        state = await read();
        const other = key === 'r1' ? 'r2' : 'r1';
        requireState(isDeepStrictEqual(before.response, state.response) && isDeepStrictEqual(before[other], state[other])
            && isDeepStrictEqual(before.foreign, state.foreign) && (!before.entry || before.entry.id === state.entry?.id) && (!current || current.id === state[key]?.id),
        'Unrelated rule content, identity or order changed during reconciliation');
        requireState(sameRule(state[key], expected) && (!(before.ordered || payload.position) || state.ordered),
            'Owned cache rule write did not converge');
        changed = true;
    }

    const readyR1 = () => sameRule(state.r1, desired.r1) && state.ordered;
    if (operation === 'ensure-r1' && !readyR1()) {
        const position = state.r2 ? { position: { after: state.r2.id } } : {};
        await write('r1', desired.r1, { ...desired.r1, ...position });
    }
    if (operation === 'r2-off') {
        if (state.r2?.enabled) {
            await write('r2', { ...ruleFields(state.r2), enabled: false }, switched(state.r2, false));
        }
        if (!target.ifPresent && (!sameRule(state.r2, desired.r2) || !state.ordered)) {
            // Creating or repairing R2 is not a disable, so foreign rules still refuse it.
            requireState(!state.foreign.length, 'Foreign rule in the request cache phase');
            const position = state.r1 ? { position: { before: state.r1.id } } : {};
            await write('r2', desired.r2, { ...desired.r2, ...position });
        }
    }
    if (operation === 'r2-on' || operation === 'check') {
        requireState(readyR1() && state.r2 && sameRule(state.r2, { ...desired.r2, enabled: state.r2.enabled }),
            'Cache policy requires the configured R2 followed by active R1; a rule is absent, drifted or out of order');
        if (operation === 'r2-on' && !state.r2.enabled) {
            const original = activationIdentity(target, state.entry.id, state.r2.id);
            if (target.receipt) {
                // The next workflow step may have to recover after cancellation.
                // Never overwrite a prior activation or serialize the credential.
                try { await writeFile(target.receipt, JSON.stringify(original), { flag: 'wx', mode: 0o600 }); }
                catch { throw new Error('Unable to create exclusive activation receipt before enable'); }
            }
            try {
                await write('r2', { ...desired.r2, enabled: true }, switched(state.r2, true));
            } catch (error) {
                try { await undoActivation(request, original, desired.r2, descriptions); }
                catch (recoveryError) { throw new Error(`${error.message}; unable to confirm R2 off: ${recoveryError.message}`); }
                throw new Error(`${error.message}; original R2 confirmed off`);
            }
        }
    }
    const status = rule => !rule ? 'absent' : rule.enabled ? 'on' : 'off';
    log(`${host} ${target.r1}=${status(state.r1)} ${target.r2}=${status(state.r2)}; other rules unchanged`);
    return changed ? 'applied' : 'unchanged';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run(process.argv.slice(2)).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
