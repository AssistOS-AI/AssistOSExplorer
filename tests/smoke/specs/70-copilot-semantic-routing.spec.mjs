import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { signIn } from '../lib/auth.mjs';
import { createCopilotDiagnostics } from '../lib/copilot-terminal-diagnostics.mjs';

const diagnostics = new WeakMap();

test.beforeEach(async ({ page }) => { diagnostics.set(page, createCopilotDiagnostics()); });
test.afterEach(async ({ page }, testInfo) => {
    await testInfo.attach('copilot-terminal_codex.json', {
        body: Buffer.from(JSON.stringify(diagnostics.get(page)?.evidence || {}, null, 2)),
        contentType: 'application/json',
    });
});

async function observeTerminal(page) {
    diagnostics.get(page).observe(await page.locator(BOT_MSG).allTextContents());
}

const BOT_MSG = '#chatList > .wa-message.in:not(.wa-typing):not(.wa-task-item) .wa-message-bubble';

function copilotWebchatPath() {
    const params = new URLSearchParams({
        agent: smokeConfig.webchatAgent,
        'forward-envelope': '1',
        'workspace-dir': '.',
    });
    return `/webchat?${params.toString()}`;
}

async function openCopilotWebchat(page, account = smokeConfig.primaryUser) {
    await signIn(page, account, copilotWebchatPath());
    await expect(page.locator('#cmd')).toBeVisible();
    await expect(page.locator('#send')).toBeVisible();
}

async function waitForIntro(page) {
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(3_000);
        await observeTerminal(page);
        const count = await page.locator(BOT_MSG).count();
        const hidden = await typingHidden(page);
        if (count >= 1 && hidden) return count;
    }
    return page.locator(BOT_MSG).count();
}

async function typingHidden(page) {
    return page.evaluate(
        () => document.querySelector('#typingIndicator')?.getAttribute('aria-hidden') === 'true',
    );
}

async function sendAndWaitForReply(page, prompt, introCount, timeoutMs) {
    await page.locator('#cmd').focus();
    await page.locator('#cmd').fill(prompt);
    await page.locator('#cmd').evaluate((input) => {
        input.selectionStart = input.value.length;
        input.selectionEnd = input.value.length;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#send').click();
    diagnostics.get(page).submitted();

    const polls = Math.ceil(timeoutMs / 3_000);
    for (let i = 0; i < polls; i++) {
        await page.waitForTimeout(3_000);
        await observeTerminal(page);
        const count = await page.locator(BOT_MSG).count();
        const hidden = await typingHidden(page);
        if (count > introCount && hidden) {
            const texts = [];
            const msgs = page.locator(BOT_MSG);
            for (let j = introCount; j < count; j++) {
                texts.push(await msgs.nth(j).innerText());
            }
            diagnostics.get(page).replied();
            return texts.join('\n');
        }
    }
    diagnostics.get(page).timedOut();
    throw new Error(`No copilot reply within ${Math.round(timeoutMs / 1000)}s`);
}

test.describe('AKU memory through Copilot WebChat @external', () => {
    test.skip(!smokeConfig.flags.openInterpreter, 'Set SMOKE_OPEN_INTERPRETER=1 to run Copilot semantic routing checks.');

    test('creates and resolves an AKU knowledge unit via /exec aku-memory', async ({ page }) => {
        test.setTimeout(smokeConfig.timeouts.relay + 120_000);

        await openCopilotWebchat(page);
        const introCount = await waitForIntro(page);

        const kuTag = `smoke-${smokeConfig.runId}`;
        const createPayload = JSON.stringify({
            operation: 'create',
            metadata: {
                ku_name: `Headless Smoke KU ${kuTag}`,
                ku_type: 'research_note',
                summary: 'Created by the copilot routing headless smoke test.',
                tags: ['headless-smoke', kuTag],
                keywords: ['headless-smoke', kuTag],
            },
        });

        const createReply = await sendAndWaitForReply(
            page,
            `/exec aku-memory ${createPayload}`,
            introCount,
            smokeConfig.timeouts.relay,
        );

        const createOk = /"ok"\s*:\s*true/i.test(createReply) || /created|ku_id/i.test(createReply);
        expect(
            createOk,
            `AKU create did not return ok:true or ku_id.\n${createReply.slice(0, 600)}`,
        ).toBe(true);

        const botCountAfterCreate = await page.locator(BOT_MSG).count();

        const resolvePayload = JSON.stringify({
            operation: 'resolve',
            query: `Headless Smoke KU ${kuTag}`,
            options: { limit: 5 },
        });

        const resolveReply = await sendAndWaitForReply(
            page,
            `/exec aku-memory ${resolvePayload}`,
            botCountAfterCreate,
            smokeConfig.timeouts.relay,
        );

        const resolved = /ku_id|total|results/i.test(resolveReply) && new RegExp(kuTag).test(resolveReply);
        expect(
            resolved,
            `AKU resolve did not find the created KU.\n${resolveReply.slice(0, 600)}`,
        ).toBe(true);
    });
});

test.describe('Copilot semantic routing @external', () => {
    test.skip(!smokeConfig.flags.openInterpreter, 'Set SMOKE_OPEN_INTERPRETER=1 to run Copilot semantic routing checks.');

    test('routes a natural-language execution prompt to Open Interpreter', async ({ page }) => {
        test.setTimeout(smokeConfig.timeouts.relay + 120_000);

        await openCopilotWebchat(page);
        const introCount = await waitForIntro(page);

        const reply = await sendAndWaitForReply(
            page,
            'Write a Python script that prints "COPILOT_OI_SMOKE_OK" and run it.',
            introCount,
            smokeConfig.timeouts.relay,
        );

        const launchedOI = /open.?interpreter|COPILOT_OI_SMOKE_OK|launch/i.test(reply);
        const directRefusal = /I.?(can.?t|cannot|don.?t have|unable to).*(run|execute)/i.test(reply)
            && !launchedOI;

        expect(
            directRefusal,
            `Expected copilot to route to Open Interpreter, not refuse.\n${reply.slice(0, 600)}`,
        ).toBe(false);

        expect(
            launchedOI,
            `Expected Open Interpreter dispatch evidence in reply.\n${reply.slice(0, 600)}`,
        ).toBe(true);
    });

    test('routes a natural-language web search prompt to the web-search launcher', async ({ page }) => {
        test.setTimeout(smokeConfig.timeouts.relay + 120_000);

        await openCopilotWebchat(page);
        const introCount = await waitForIntro(page);

        const reply = await sendAndWaitForReply(
            page,
            'Search online for the latest Node.js release date. Answer in one concise sentence and cite sources if available.',
            introCount,
            smokeConfig.timeouts.relay,
        );

        const placeholderStub = /not deployed for this Copilot workspace/i.test(reply);
        const directLlmRefusal = /I.?(can.?t|cannot|don.?t have) .*(access the web|search online|look up online|browse the internet)/i.test(reply);

        expect(
            placeholderStub,
            `Placeholder stub fired instead of deployed launcher.\n${reply.slice(0, 600)}`,
        ).toBe(false);

        expect(
            directLlmRefusal,
            `LLM refused without attempting the launcher.\n${reply.slice(0, 600)}`,
        ).toBe(false);

        if (/web.search.*(unavailab|not available)/i.test(reply)) {
            test.info().annotations.push({
                type: 'note',
                description: 'Routing succeeded (launcher was called), but the provider backend is unavailable — headless browser runtime not present in webSearchAgent container.',
            });
        }
    });

    test('treats @web-search token as ordinary chat, not a launcher dispatch', async ({ page }) => {
        test.setTimeout(smokeConfig.timeouts.relay + 120_000);

        await openCopilotWebchat(page);
        const introCount = await waitForIntro(page);

        const reply = await sendAndWaitForReply(
            page,
            '@web-search latest Node.js release',
            introCount,
            smokeConfig.timeouts.relay,
        );

        const placeholderDispatch = /not deployed for this Copilot workspace/i.test(reply);

        expect(
            placeholderDispatch,
            `@web-search dispatched the placeholder launcher.\n${reply.slice(0, 600)}`,
        ).toBe(false);

        if (/ordinary chat text/i.test(reply)) {
            test.info().annotations.push({
                type: 'note',
                description: 'LLM called launch-web-search despite @token rule, but the skill-level guard caught it.',
            });
        }
    });
});
