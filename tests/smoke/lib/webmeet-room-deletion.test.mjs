import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { siblingPath } from '../../helpers/sibling-roots.mjs';

test('WebMeet native room deletion follows the selected settings action', { timeout: 60_000 }, async (t) => {
    const title = 'Owned "fixture" room';
    const roomId = 'room_11111111-1111-4111-8111-111111111111';
    const settingsSource = await readFile(siblingPath('webmeet', 'webmeetAgent', 'IDE-plugins',
        'webmeet-tool-button', 'components', 'webmeet-room-settings-modal', 'webmeet-room-settings-modal.js'), 'utf8');
    assert.ok(settingsSource.includes('message: `Permanently delete "${this.roomTitle}" and all of its WebMeet history? This cannot be undone.`'));
    assert.ok(settingsSource.includes('if (confirmed !== true) return;'));
    const loaderSource = await readFile(siblingPath('webmeet', 'webmeetAgent', 'static-files', 'roomLoader.js'), 'utf8');
    assert.ok(loaderSource.includes("return window.confirm(String(payload?.message || 'Continue?'));"));
    let mode = 'normal';
    let mutations = 0;
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://fixture.test').pathname;
        if (pathname === '/auth/token') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ user: { id: 'owner-id', username: 'owner', roles: ['admin'] } }));
        } else if (pathname === '/delete') {
            mutations += 1;
            response.end('deleted');
        } else if (pathname === '/webmeetAgent/roomLoader.html') {
            response.setHeader('content-type', 'text/html');
            response.end(`<div class="webmeet-dashboard"><button id="webmeetCreateRoomButton">Create room</button>
                <div id="webmeetMeetingList"><div class="webmeet-list-item" data-id="${roomId}">
                <span id="roomTitle"></span><button onclick="openSettings()">Room settings</button></div></div></div>
                <script>
                const title = ${JSON.stringify(title)}, mode = ${JSON.stringify(mode)};
                document.querySelector('#roomTitle').textContent = title;
                window.promptResults = [];
                window.deleteClicks = 0;
                function openSettings() {
                    const dialog = document.createElement('dialog');
                    dialog.innerHTML = '<webmeet-room-settings-modal><button role="tab">Lifecycle</button><button id="deleteRoom">Delete room</button></webmeet-room-settings-modal>';
                    const component = dialog.firstElementChild;
                    component.setAttribute('data-room-id', mode === 'wrong-room' ? 'different-room' : ${JSON.stringify(roomId)});
                    component.setAttribute('data-room-title', mode === 'wrong-title' ? 'different-title' : title);
                    document.body.append(dialog);
                    dialog.showModal();
                    component.querySelector('[role="tab"]').onclick = () => {
                        if (mode === 'click-failure') document.querySelector('#deleteRoom').disabled = true;
                    };
                    document.querySelector('#deleteRoom').onclick = async () => {
                        window.deleteClicks += 1;
                        if (mode === 'no-prompt') return;
                        const message = 'Permanently delete "' + title + '" and all of its WebMeet history? This cannot be undone.';
                        const confirmed = mode === 'unexpected' ? confirm('Delete everything?')
                            : mode === 'wrong-type' ? prompt(message) : confirm(message);
                        window.promptResults.push(confirmed);
                        if (confirmed !== true || mode === 'deletion-refused') return;
                        if (mode === 'duplicate') {
                            const second = confirm(message);
                            window.promptResults.push(second);
                            if (second !== true) return;
                        }
                        const deletion = await fetch('/delete', { method: 'POST' });
                        await deletion.text();
                        document.querySelector('.webmeet-list-item').remove();
                        dialog.close(); dialog.remove();
                    };
                }
                </script>`);
        } else {
            response.setHeader('content-type', 'text/html');
            response.end(`<button aria-label="WebMeet" onclick="openMeeting()">WebMeet</button><script>
                function openMeeting() {
                    const dialog = document.createElement('dialog');
                    dialog.innerHTML = '<expanded-modal><iframe class="expanded-modal-frame" title="WebMeet" src="/webmeetAgent/roomLoader.html"></iframe></expanded-modal>';
                    document.body.append(dialog); dialog.showModal();
                }</script>`);
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    process.env.SMOKE_BASE_URL = baseURL;
    process.env.SMOKE_NAVIGATION_TIMEOUT_MS = '600';
    process.env.SMOKE_EXPECT_TIMEOUT_MS = '600';
    let browser;
    try {
        const { openWebMeet, openStandaloneWebMeet, webMeetSurface, deleteRoomIfPresent } = await import('./webmeet.mjs');
        browser = await chromium.launch();
        for (const scenario of ['normal', 'standalone', 'unexpected', 'wrong-type', 'wrong-room', 'wrong-title',
            'no-prompt', 'click-failure', 'deletion-refused', 'duplicate']) {
            await t.test(scenario, async () => {
                mode = scenario;
                mutations = 0;
                const page = await browser.newPage({ baseURL });
                const errors = [];
                page.on('console', (message) => {
                    if (message.type() === 'error') errors.push(message.text());
                });
                page.on('pageerror', (error) => errors.push(error.message));
                page.on('requestfailed', (request) => errors.push(request.failure()?.errorText));
                try {
                    await openWebMeet(page, { username: 'owner' }, { requireConfiguredPrincipal: true });
                    if (scenario === 'standalone') await openStandaloneWebMeet(page);
                    const surface = webMeetSurface(page);
                    const listeners = page.listenerCount('dialog');
                    if (scenario === 'normal' || scenario === 'standalone') {
                        try {
                            assert.equal(await deleteRoomIfPresent(page, title), true);
                        } finally {
                            t.diagnostic(`normal deletion mutations: ${mutations}`);
                        }
                        assert.equal(mutations, 1);
                        assert.deepEqual(await surface.evaluate(() => window.promptResults), [true]);
                        assert.equal(await deleteRoomIfPresent(page, title), false, 'absent room causes no extra mutation');
                        assert.equal(mutations, 1);
                    } else {
                        await assert.rejects(deleteRoomIfPresent(page, title));
                        assert.equal(mutations, 0);
                        assert.equal(await surface.locator('.webmeet-list-item').count(), 1);
                        const results = await surface.evaluate(() => window.promptResults);
                        assert.deepEqual(results, scenario === 'deletion-refused' ? [true]
                            : scenario === 'duplicate' ? [true, false]
                            : scenario === 'unexpected' ? [false] : scenario === 'wrong-type' ? [null] : []);
                        if (scenario === 'wrong-room' || scenario === 'wrong-title' || scenario === 'click-failure') {
                            assert.equal(await surface.evaluate(() => window.deleteClicks), 0);
                        }
                    }
                    assert.equal(page.listenerCount('dialog'), listeners, 'scoped native handler is removed');
                    assert.equal(await surface.evaluate(() => window.confirm('unrelated later confirmation')), false,
                        'later dialogs keep browser default dismissal');
                    assert.deepEqual(errors, []);
                } finally {
                    await page.close();
                }
            });
        }
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
