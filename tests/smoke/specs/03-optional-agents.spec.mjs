import { test, expect } from '../lib/fixtures.mjs';
import { openExplorer } from '../lib/explorer.mjs';

const optionalAgents = ['onlyOffice', 'webmeetScribeAgent', 'webmeetStt'];
const startupTimeout = 10 * 60 * 1000;

async function readRuntimeStates(page, refs) {
    const response = await page.request.get('/status/data');
    expect(response.ok(), 'Authenticated runtime snapshot succeeds').toBe(true);
    const payload = await response.json();
    expect(Array.isArray(payload.runtimes)).toBe(true);
    return refs.map((ref) => {
        const matches = payload.runtimes.filter((runtime) => (
            `${runtime.repoName}/${runtime.agentName}` === ref
        ));
        expect(matches.length, `Unambiguous runtime identity for ${ref}`).toBeLessThanOrEqual(1);
        const runtime = matches[0];
        return {
            ref,
            present: Boolean(runtime),
            enabled: runtime?.enabled === true,
            running: runtime?.state?.running === true,
            status: runtime?.state?.status || null,
        };
    });
}

test.describe('Fresh optional-agent Marketplace activation', () => {
    test.skip(process.env.SMOKE_OPTIONAL_AGENTS !== '1', 'Requires a fresh deployment with optional agents disabled');

    test('OnlyOffice, Scribe, and STT start disabled and can be enabled through Marketplace', async ({ page }, testInfo) => {
        test.setTimeout(3 * startupTimeout + 120000);
        await openExplorer(page, { hash: 'marketplace-modal' });
        const marketplace = page.locator('marketplace-modal');
        await expect(marketplace).toBeVisible();

        const response = await page.request.get('/api/marketplace');
        expect(response.ok()).toBe(true);
        const payload = await response.json();
        expect(Array.isArray(payload.marketplace?.agents)).toBe(true);
        const refs = optionalAgents.map((name) => {
            const matches = payload.marketplace.agents.filter((agent) => agent.ref?.endsWith(`/${name}`));
            expect(matches.length, `Exactly one installed Marketplace entry for ${name}`).toBe(1);
            expect(matches[0].active, `${name} starts disabled`).toBe(false);
            expect(matches[0].running, `${name} is not running by default`).not.toBe(true);
            return matches[0].ref;
        });

        const before = await readRuntimeStates(page, refs);
        for (const runtime of before) {
            expect(runtime.enabled, `${runtime.ref} is not enabled in the fresh graph`).toBe(false);
            expect(runtime.running, `${runtime.ref} is not running in the fresh graph`).toBe(false);
        }

        // Validate every default before the first mutation so transitive startup
        // cannot hide an incorrect default for another optional agent.
        for (const ref of refs) {
            const repoName = ref.slice(0, ref.lastIndexOf('/'));
            const expand = marketplace.locator(`[data-repo-tree-toggle][data-repo-name="${repoName}"]`);
            await expect(expand).toBeVisible();
            if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click();
            const row = marketplace.locator(`[data-marketplace-agent-ref="${ref}"]`);
            await expect(row.locator('.marketplace-agent-status')).toHaveText('Disabled');
            await expect(row.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
        }

        for (const ref of refs) {
            const row = marketplace.locator(`[data-marketplace-agent-ref="${ref}"]`);
            const mode = row.locator('[data-enable-mode-for]');
            const expectedMode = ref.endsWith('/onlyOffice') ? 'global' : 'isolated';
            await mode.selectOption(expectedMode);
            const mutation = page.waitForResponse((candidate) => (
                new URL(candidate.url()).pathname === '/api/marketplace'
                && candidate.request().method() === 'POST'
            ), { timeout: startupTimeout });
            await row.getByRole('button', { name: 'Enable', exact: true }).click();
            expect((await mutation).ok(), `Marketplace enables ${ref}`).toBe(true);
            await expect(row.locator('.marketplace-agent-status')).toHaveText('Running', { timeout: startupTimeout });
            await expect(row.getByRole('button', { name: 'Disable', exact: true })).toBeEnabled();
            await expect(mode).toHaveValue(expectedMode);
            await expect(mode).toBeDisabled();
            await expect.poll(async () => {
                const [runtime] = await readRuntimeStates(page, [ref]);
                return runtime.enabled && runtime.running && runtime.status === 'running';
            }, { timeout: startupTimeout, message: `${ref} has independent running runtime evidence` }).toBe(true);
        }

        const after = await readRuntimeStates(page, refs);
        expect(after.every((runtime) => runtime.enabled && runtime.running && runtime.status === 'running')).toBe(true);
        await testInfo.attach('optional-agent-lifecycle.json', {
            body: JSON.stringify({ before, after }, null, 2),
            contentType: 'application/json',
        });
        // Deliberately retain enabled services for the following real OnlyOffice
        // persistence and WebMeet release gates on this disposable deployment.
    });
});
