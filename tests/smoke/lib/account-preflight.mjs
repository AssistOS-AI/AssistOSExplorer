import fs from 'node:fs';
import path from 'node:path';
import { configureFreeCopilotRobots, requireFreeCopilotSetup } from './copilot-free-model.mjs';

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
        throw new Error('Smoke account preflight requires a verified administrator principal.');
    }
    if (requirements.secondary && (!secondary?.canonicalId || !Array.isArray(secondary.roles)
        || primary.canonicalId === secondary.canonicalId || !secondary.roles.includes('user')
        || secondary.roles.includes('admin') || secondary.roles.includes('guest'))) {
        throw new Error('Smoke account preflight requires a distinct verified ordinary user.');
    }
}

export function assertMarketplaceLifecycleFixture(payload) {
    const matches = payload?.marketplace?.agents?.filter(agent => agent.ref === 'UmamiAgent/umamiAgent');
    if (matches?.length !== 1) throw new Error('Smoke Marketplace preflight requires exactly one installed UmamiAgent/umamiAgent catalog fixture.');
}

export default async function accountPreflight() {
    const requirements = JSON.parse(process.env.SMOKE_PREFLIGHT_ACCOUNT_REQUIREMENTS || '{}');
    if (requirements.freeCopilotSetup) requireFreeCopilotSetup();
    if (!requirements.enabled) return;
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
                    if (!response.ok()) throw new Error('Marketplace catalog preflight failed.');
                    assertMarketplaceLifecycleFixture(await response.json());
                }
            } finally { await context.close(); }
        }
        assertAccountRoles(principals[0], principals[1], requirements);
    } catch {
        throw new Error('Smoke account preflight failed to establish required authenticated roles; private inputs are withheld.');
    } finally { await browser.close(); }
}
