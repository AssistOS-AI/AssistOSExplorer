import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { siblingPath } from '../../helpers/sibling-roots.mjs';

test('WebMeet public creation handles the real native invitation confirmation', { timeout: 60_000 }, async (t) => {
    const source = await readFile(siblingPath('webmeet', 'webmeetAgent', 'IDE-plugins', 'webmeet-tool-button',
        'components', 'webmeet-dashboard', 'controllers', 'meeting-action-methods.js'), 'utf8');
    // Execute the product method with fixture-owned UI, backend and clipboard sinks.
    const method = source.slice(source.indexOf('    async createMeeting() {'), source.indexOf('    buildRoomLink(meetingId) {'));
    assert.ok(method.includes('Public meeting created! Share this link:'));
    const id = 'room_11111111-1111-4111-8111-111111111111';
    const otherId = 'room_22222222-2222-4222-8222-222222222222';
    let title = 'Fixture public "room"';
    let mode = 'public';
    let rooms = [];
    const creations = [];
    const server = http.createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://fixture.test').pathname;
        if (pathname === '/auth/token') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ user: { id: 'owner-id', username: 'owner', roles: ['admin'] } }));
        } else if (pathname === '/create') {
            let body = '';
            for await (const chunk of request) body += chunk;
            const payload = JSON.parse(body);
            creations.push(payload);
            rooms.push({ id, title: payload.name });
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(rooms[0]));
        } else if (pathname === '/rooms') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(rooms));
        } else if (pathname === '/webmeetAgent/roomLoader.html') {
            response.setHeader('content-type', 'text/html');
            response.end(`<div class="webmeet-dashboard"><button id="webmeetCreateRoomButton">Create room</button>
                <div id="webmeetMeetingList"></div></div><script>
                const mode = ${JSON.stringify(mode)};
                window.promptResults = [];
                window.copyAttempts = [];
                Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value) => window.copyAttempts.push(value) } });
                const runTool = async (name, payload) => {
                    if (name !== 'webmeet_room_create') throw new Error('Unexpected fixture tool');
                    const result = await fetch('/create', { method: 'POST', body: JSON.stringify(payload) });
                    return result.json();
                };
                const assistOS = { UI: { async showModal(name, payload = {}) {
                    if (name === 'create-room-modal') return new Promise(resolve => {
                        const dialog = document.createElement('dialog');
                        dialog.innerHTML = '<create-room-modal><label class="room-type-option"><input name="roomType" type="radio" value="team" data-id="roomTypeTeam" checked>Team Room</label><label class="room-type-option"><input name="roomType" type="radio" value="guest" data-id="roomTypeGuest">Public meeting</label><input data-id="roomTitleInput"><button data-local-action="confirmCreate">Create Room</button></create-room-modal>';
                        document.body.append(dialog); dialog.showModal();
                        if (mode === 'wrong-title') dialog.querySelector('[data-id="roomTitleInput"]').oninput = (event) => { event.target.value = 'different room'; };
                        if (mode === 'wrong-type-selection') dialog.querySelector('[data-id="roomTypeGuest"]').onclick = () => { dialog.querySelector('[data-id="roomTypeTeam"]').checked = true; };
                        if (mode === 'click-failure') dialog.querySelector('button').disabled = true;
                        dialog.querySelector('button').onclick = () => {
                            const result = { roomTitle: dialog.querySelector('[data-id="roomTitleInput"]').value.trim(), roomType: dialog.querySelector('input:checked').value };
                            dialog.close(); dialog.remove(); resolve(result);
                        };
                    });
                    if (name !== 'confirm-action-modal') throw new Error('Unexpected fixture modal');
                    if (mode === 'no-prompt') return false;
                    if (mode === 'late-prompt') await new Promise(resolve => setTimeout(resolve, 900));
                    const message = mode === 'unexpected' ? 'Continue with unrelated action?' : payload.message;
                    const result = mode === 'wrong-dialog-type' ? prompt(message) : confirm(message);
                    window.promptResults.push(result);
                    if (mode === 'duplicate') window.promptResults.push(confirm(message));
                    return result;
                } } };
                const methods = ({${method}});
                const controller = {
                    ...methods, state: {}, canManageRooms: () => true, setError() {},
                    buildRoomLink(roomId) {
                        if (mode === 'foreign-link') return 'https://foreign.invalid/webmeetAgent/roomLoader.html?roomId=' + roomId;
                        const url = new URL('/webmeetAgent/roomLoader.html', location.origin);
                        url.searchParams.set('roomId', mode === 'wrong-room-link' ? ${JSON.stringify(otherId)} : roomId);
                        return url.href;
                    },
                    async loadMeetings() {
                        if (mode === 'team-unexpected') window.promptResults.push(confirm('Unexpected team-room prompt'));
                        this.rooms = await (await fetch('/rooms')).json();
                    },
                    renderAll() {
                        const list = document.querySelector('#webmeetMeetingList');
                        for (const room of this.rooms) {
                            const item = document.createElement('div'); item.className = 'webmeet-list-item'; item.dataset.id = room.id;
                            const name = document.createElement('span'); name.textContent = room.title + (mode === 'title-suffix' ? ' unexpected suffix' : ''); item.append(name);
                            const settings = document.createElement('button'); settings.textContent = 'Room settings';
                            settings.onclick = () => {
                                const dialog = document.createElement('dialog');
                                dialog.innerHTML = '<webmeet-room-settings-modal><span data-role="roomLinkText"></span><button class="close" aria-label="Close">Close</button></webmeet-room-settings-modal>';
                                dialog.querySelector('span').textContent = new URL('/webmeetAgent/roomLoader.html?roomId=' + room.id, location.origin).href;
                                dialog.querySelector('button').onclick = () => { dialog.close(); dialog.remove(); };
                                document.body.append(dialog); dialog.showModal();
                            };
                            item.append(settings); list.append(item);
                        }
                    },
                };
                document.querySelector('#webmeetCreateRoomButton').onclick = () => { window.creationDone = controller.createMeeting(); };
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
    let browser;
    try {
        const { openWebMeet, webMeetSurface, createRoom, readRoomShareLink } = await import('./webmeet.mjs');
        browser = await chromium.launch();
        for (const scenario of ['public', 'public-unicode', 'title-suffix', 'team', 'team-unexpected', 'unexpected', 'wrong-dialog-type', 'foreign-link', 'wrong-room-link',
            'no-prompt', 'duplicate', 'late-prompt', 'wrong-title', 'wrong-type-selection', 'click-failure']) {
            await t.test(scenario, async () => {
                mode = scenario; rooms = []; creations.length = 0;
                title = scenario === 'public-unicode' ? 'Întâlnire 日本語 "cameră" 🗣️' : 'Fixture public "room"';
                const page = await browser.newPage({ baseURL });
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                page.on('requestfailed', request => errors.push(request.failure()?.errorText));
                page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
                try {
                    await openWebMeet(page, { username: 'owner' }, { requireConfiguredPrincipal: true });
                    const surface = webMeetSurface(page);
                    const listenerCount = page.listenerCount('dialog');
                    const roomType = scenario.startsWith('team') ? 'team' : 'guest';
                    if (scenario.startsWith('public') || scenario === 'team') {
                        try {
                            assert.equal(await createRoom(page, title, { roomType }), id);
                        } finally {
                            t.diagnostic(`${scenario}: create calls ${creations.length}`);
                            t.diagnostic(`${scenario}: fixture copy attempts ${await surface.evaluate(() => window.copyAttempts.length)}`);
                        }
                        assert.equal(await readRoomShareLink(page, title), `${baseURL}/webmeetAgent/roomLoader.html?roomId=${id}`);
                    } else {
                        await assert.rejects(createRoom(page, title, { roomType }));
                    }
                    const submitted = !['wrong-title', 'wrong-type-selection', 'click-failure'].includes(scenario);
                    assert.equal(creations.length, submitted ? 1 : 0, 'no retries or extra creation attempts');
                    if (submitted) {
                        await surface.evaluate(() => window.creationDone);
                        assert.deepEqual(creations[0], { name: title, roomType });
                    }
                    const results = await surface.evaluate(() => window.promptResults);
                    assert.deepEqual(results, scenario === 'duplicate' ? [false, false]
                        : scenario === 'wrong-dialog-type' ? [null]
                        : submitted && scenario !== 'team' && scenario !== 'no-prompt' ? [false] : []);
                    const attempts = await surface.evaluate(() => window.copyAttempts);
                    t.diagnostic(`${scenario}: fixture copy attempts ${attempts.length}`);
                    // Observe the pinned product's copy attempt without prescribing it as desired behavior.
                    if (roomType === 'team' || !submitted) assert.deepEqual(attempts, []);
                    assert.equal(page.listenerCount('dialog'), listenerCount);
                    assert.equal(await surface.evaluate(() => confirm('unrelated later confirmation')), false);
                    assert.deepEqual(errors, []);
                } finally {
                    await page.close();
                }
            });
        }
    } finally {
        await browser?.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
