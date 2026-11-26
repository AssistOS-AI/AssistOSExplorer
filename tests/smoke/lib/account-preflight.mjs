import fs from 'node:fs';
import path from 'node:path';
import { configureFreeCopilotRobots, requireFreeCopilotSetup } from './copilot-free-model.mjs';

// Errors whose text is fixed by this module and carries no private input.
function safeFailure(kind, message) {
    return Object.assign(new Error(message), { kind });
}

const NETWORK_FAILURE = /net::ERR_|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|Timeout \d+ms exceeded/i;

// Maps any failure to a safe, classified message. Only a rate limit (role and
// a numeric wait) and this module's fixed role messages are forwarded; every
// other message may embed an account name, an alert text or a command error
// and is replaced by its class.
export function classifyPreflightFailure(error) {
    if (error?.kind === 'rate_limited') return { kind: 'rate_limited', detail: error.message };
    if (error?.kind === 'roles' || error?.kind === 'fixture' || error?.kind === 'session-store') return { kind: error.kind, detail: error.message };
    if (NETWORK_FAILURE.test(`${error?.code || ''} ${error?.message || ''}`)) {
        return { kind: 'network', detail: 'The deployment was unreachable or timed out during sign-in.' };
    }
    return { kind: 'sign-in', detail: 'Sign-in or the required setup did not complete.' };
}

export function preflightError(error) {
    const { kind, detail } = classifyPreflightFailure(error);
    return Object.assign(new Error(`Smoke account preflight failed (${kind}): ${detail} Private inputs are withheld.`), { kind });
}

export async function configureRequiredCopilotModels(page, requirements, env = process.env) {
    if (!requirements.freeCopilotSetup) return;
    requireFreeCopilotSetup(env);
    const root = env.SMOKE_ARTIFACT_DIR;
    if (!root || !path.isAbsolute(root)) throw new Error('Model setup requires the external artifact directory.');
    const receipts = await configureFreeCopilotRobots(page);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'copilot-model-setup.json'), JSON.stringify({ receipts }), { flag: 'wx', mode: 0o600 });
}

export function assertAccountRoles(primary, secondary, requirements) {
    if (!primary?.canonicalId || !Array.isArray(primary.roles)
        || requirements.primaryAdmin && !primary.roles.includes('admin')) {
        throw safeFailure('roles', 'Smoke account preflight requires a verified administrator principal.');
    }
    if (requirements.secondary && (!secondary?.canonicalId || !Array.isArray(secondary.roles)
        || primary.canonicalId === secondary.canonicalId || !secondary.roles.includes('user')
        || secondary.roles.includes('admin') || secondary.roles.includes('guest'))) {
        throw safeFailure('roles', 'Smoke account preflight requires a distinct verified ordinary user.');
    }
}

export function assertMarketplaceLifecycleFixture(payload) {
    const matches = payload?.marketplace?.agents?.filter(agent => agent.ref === 'UmamiAgent/umamiAgent');
    if (matches?.length !== 1) throw safeFailure('fixture', 'Smoke Marketplace preflight requires exactly one installed UmamiAgent/umamiAgent catalog fixture.');
}

export default async function accountPreflight() {
    const requirements = JSON.parse(process.env.SMOKE_PREFLIGHT_ACCOUNT_REQUIREMENTS || '{}');
    if (requirements.freeCopilotSetup) requireFreeCopilotSetup();
    if (!requirements.enabled) return;
    // Refuse a misconfigured session store before any browser or sign-in.
    try {
        const reuse = await import('./session-reuse.mjs');
        if (reuse.sessionReuseEnabled()) reuse.prepareSessionStore();
    } catch (error) { throw preflightError(error); }
    const { chromium } = await import('@playwright/test');
    const { smokeConfig } = await import('./config.mjs');
    const { signIn, readAuthenticatedPrincipal } = await import('./auth.mjs');
    const browser = await chromium.launch({ headless: true });
    try {
        const principals = [];
        for (const account of [smokeConfig.primaryUser, ...(requirements.secondary ? [smokeConfig.secondaryUser] : [])]) {
            const context = await browser.newContext({ baseURL: smokeConfig.baseURL, ignoreHTTPSErrors: true });
            try {
                const page = await context.newPage();
                await signIn(page, account, '/explorer/index.html', { requireConfiguredPrincipal: true });
                principals.push(await readAuthenticatedPrincipal(page, account));
                if (principals.length === 1 && requirements.freeCopilotSetup) {
                    assertAccountRoles(principals[0], undefined, { primaryAdmin: true });
                    await configureRequiredCopilotModels(page, requirements);
                }
                if (principals.length === 1 && requirements.marketplaceLifecycleFixture) {
                    const response = await page.request.get('/api/marketplace/agents');
                    if (!response.ok()) throw safeFailure('fixture', 'Marketplace catalog preflight failed.');
                    assertMarketplaceLifecycleFixture(await response.json());
                }
            } finally { await context.close(); }
        }
        assertAccountRoles(principals[0], principals[1], requirements);
    } catch (error) {
        throw preflightError(error);
    } finally { await browser.close(); }
}
