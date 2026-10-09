import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WebmeetRoomSettingsModal } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-room-settings-modal/webmeet-room-settings-modal.js';
import { applyPermanentRoomDeletion } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/permanent-room-deletion.js';
import { dashboardDataMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js';

const pluginRoot = path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button');

test('Room settings Lifecycle exposes an explicit permanent Delete room action', async () => {
    const html = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-room-settings-modal/webmeet-room-settings-modal.html'),
        'utf8'
    );
    const controller = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/controllers/meeting-action-methods.js'),
        'utf8'
    );
    assert.match(html, /data-room-settings-tab="lifecycle"/);
    assert.match(html, /data-local-action="deleteRoom"/);
    assert.match(html, />\s*Delete room\s*</);
    assert.match(html, /permanent/i);
    assert.doesNotMatch(html, /data-local-action="deleteMeeting"/);
    assert.match(controller, /applyPermanentRoomDeletion\(this,\s*meeting,\s*result,\s*runTool\)/);
});

test('Delete room closes settings only after an explicit irreversible confirmation', async () => {
    const previousAssistOS = globalThis.assistOS;
    const modalCalls = [];
    const closeCalls = [];
    let confirmation = false;
    globalThis.assistOS = {
        UI: {
            async showModal(name, data, blocking) {
                modalCalls.push({ name, data, blocking });
                return confirmation;
            },
            closeModal(_element, result) {
                closeCalls.push(result);
            }
        }
    };
    const presenter = Object.assign(Object.create(WebmeetRoomSettingsModal.prototype), {
        element: {},
        roomId: 'room_11111111-1111-4111-8111-111111111111',
        roomTitle: 'Release room'
    });
    try {
        await presenter.deleteRoom();
        assert.equal(closeCalls.length, 0);

        confirmation = true;
        await presenter.deleteRoom();
        assert.equal(modalCalls.at(-1).name, 'confirm-action-modal');
        assert.equal(modalCalls.at(-1).blocking, true);
        assert.match(modalCalls.at(-1).data.message, /Release room/);
        assert.match(modalCalls.at(-1).data.message, /cannot be undone/i);
        assert.deepEqual(closeCalls, [{
            roomId: presenter.roomId,
            delete: true,
            confirmed: true
        }]);
    } finally {
        if (previousAssistOS === undefined) delete globalThis.assistOS;
        else globalThis.assistOS = previousAssistOS;
    }
});

test('confirmed settings deletion calls MCP and refreshes the list until exact absence is represented', async () => {
    const room = {
        id: 'room_22222222-2222-4222-8222-222222222222',
        title: 'Run-scoped room',
        status: 'active'
    };
    const calls = [];
    const dashboard = {
        state: {
            meetings: [room],
            selectedMeetingId: room.id,
            session: null
        },
        selectedMeeting: room,
        getMeetingFromActionTarget: () => room,
        canManageRooms: () => true,
        loadRoboTeamSettings: async () => null,
        buildRoomLink: () => 'https://explorer.test/webmeetAgent/roomLoader.html',
        clearMeetingGetCache(roomId) {
            calls.push({ type: 'cache-clear', roomId });
        },
        async loadMeetings() {
            calls.push({ type: 'list-refresh' });
            this.state.meetings = [];
            this.state.selectedMeetingId = '';
        },
        renderAll() {
            calls.push({ type: 'render' });
        },
        setError(message) {
            calls.push({ type: 'status', message });
        }
    };
    const runTool = async (name, args) => {
        calls.push({ type: 'tool', name, args });
        return {
            ok: true,
            deleted: true,
            roomId: room.id
        };
    };

    const handled = await applyPermanentRoomDeletion(dashboard, room, {
        roomId: room.id,
        delete: true,
        confirmed: true
    }, runTool);
    const deleteCall = calls.find((entry) => entry.type === 'tool');
    assert.equal(handled, true);
    assert.deepEqual(deleteCall, {
        type: 'tool',
        name: 'webmeet_room_delete',
        args: {
            roomId: room.id,
            confirmed: true
        }
    });
    assert.ok(calls.findIndex((entry) => entry.type === 'list-refresh') > calls.indexOf(deleteCall));
    assert.equal(dashboard.state.meetings.some((entry) => entry.id === room.id), false);
    assert.equal(dashboard.state.selectedMeetingId, '');
    assert.match(calls.find((entry) => entry.type === 'status').message, /deleted permanently/i);
});

test('browser deletion rejects mismatched room confirmations and mismatched MCP results', async () => {
    const room = {
        id: 'room_33333333-3333-4333-8333-333333333333',
        title: 'Selected room'
    };
    const controller = {
        state: { meetings: [room], selectedMeetingId: room.id, session: null },
        async loadMeetings() {
            throw new Error('room list must not refresh after a rejected deletion');
        },
        renderAll() {},
        setError() {}
    };
    let toolCalls = 0;
    await assert.rejects(
        () => applyPermanentRoomDeletion(controller, room, {
            roomId: 'room_44444444-4444-4444-8444-444444444444',
            delete: true,
            confirmed: true
        }, async () => {
            toolCalls += 1;
        }),
        /does not match/
    );
    assert.equal(toolCalls, 0);

    await assert.rejects(
        () => applyPermanentRoomDeletion(controller, room, {
            roomId: room.id,
            delete: true,
            confirmed: true
        }, async () => {
            toolCalls += 1;
            return {
                ok: true,
                deleted: true,
                roomId: 'room_55555555-5555-4555-8555-555555555555'
            };
        }),
        /matching deletion result/
    );
    assert.equal(toolCalls, 1);
});

test('deleting the active room disconnects its local session before reporting absence', async () => {
    const room = {
        id: 'room_66666666-6666-4666-8666-666666666666',
        title: 'Active room'
    };
    const calls = [];
    const controller = {
        state: {
            meetings: [room],
            selectedMeetingId: room.id,
            session: { meeting: room }
        },
        clearMeetingGetCache(roomId) {
            calls.push(`cache:${roomId}`);
        },
        async unjoinCurrentSession(options) {
            calls.push({ unjoin: options });
            this.state.session = null;
        },
        async loadMeetings() {
            calls.push('list-refresh');
            this.state.meetings = [];
            this.state.selectedMeetingId = '';
        },
        renderAll() {
            calls.push('render');
        },
        setError(message) {
            calls.push(message);
        }
    };

    await applyPermanentRoomDeletion(controller, room, {
        roomId: room.id,
        delete: true,
        confirmed: true
    }, async () => {
        calls.push('delete-tool');
        return {
            ok: true,
            deleted: true,
            roomId: room.id
        };
    });

    assert.deepEqual(calls.find((entry) => entry?.unjoin)?.unjoin, {
        preserveDisplayName: false,
        manageTransition: false
    });
    assert.ok(calls.findIndex((entry) => entry?.unjoin) < calls.indexOf('delete-tool'));
    assert.ok(calls.indexOf('delete-tool') < calls.indexOf('list-refresh'));
    assert.equal(controller.state.session, null);
    assert.equal(controller.state.meetings.length, 0);
});

function raceFixture(t) {
    const previousWindow = globalThis.window;
    const pendingLists = [];
    globalThis.window = {
        webSkel: { appServices: { getClient: () => ({ callTool: () => new Promise((resolve) => pendingLists.push(resolve)) }) } }
    };
    t.after(() => { globalThis.window = previousWindow; });
    const workspace = { id: 'rooms' };
    const controller = {
        ...dashboardDataMethods,
        state: { meetings: [{ id: 'room_race' }, { id: 'room_other' }], selectedMeetingId: '', meetingParticipantsById: {}, session: null },
        webMeetRoom: { disposed: false, getSelectedWorkspaceId: () => workspace.id },
        isGuestSession: () => false,
        loadParticipantsForMeetings: async () => {},
        loadMeetingDetails: async () => {},
        renderAll() {},
        setError() {}
    };
    const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
    return { controller, pendingLists, workspace, flush };
}

const deleteRoom = (controller) => applyPermanentRoomDeletion(
    controller,
    { id: 'room_race' },
    { roomId: 'room_race', delete: true, confirmed: true },
    async () => ({ deleted: true, roomId: 'room_race' })
);

test('deletion verifies absence against a current list when its own load is superseded by a concurrent refresh', async (t) => {
    const { controller, pendingLists, flush } = raceFixture(t);
    const deletion = deleteRoom(controller);
    await flush();
    assert.equal(pendingLists.length, 1);
    const concurrent = controller.loadMeetings({ preserveConnectedRoomRoster: true });
    await flush();
    assert.equal(pendingLists.length, 2);
    // Deletion's load resolves first but is superseded; state must stay untouched.
    pendingLists[0]({ rooms: [{ id: 'room_other' }] });
    await flush();
    assert.equal(controller.state.meetings.some((entry) => entry.id === 'room_race'), true);
    // The deletion retries rather than trusting the stale state.
    await flush();
    assert.equal(pendingLists.length, 3);
    pendingLists[1]({ rooms: [{ id: 'room_other' }] });
    pendingLists[2]({ rooms: [{ id: 'room_other' }] });
    assert.equal(await deletion, true);
    await concurrent;
    assert.deepEqual(controller.state.meetings, [{ id: 'room_other' }]);
});

test('deletion still fails when a current list still contains the deleted room', async (t) => {
    const { controller, pendingLists, flush } = raceFixture(t);
    const deletion = deleteRoom(controller);
    await flush();
    pendingLists[0]({ rooms: [{ id: 'room_race' }] });
    await assert.rejects(() => deletion, /still present/);
});

test('deletion gives up after bounded superseded loads and does not claim success', async (t) => {
    const { controller, pendingLists, flush } = raceFixture(t);
    const deletion = deleteRoom(controller);
    deletion.catch(() => {});
    for (let i = 0; i < 5; i += 1) {
        await flush();
        assert.equal(pendingLists.length, i + 1);
        controller.meetingListLoadSeq += 1; // a newer load supersedes this one
        pendingLists[i]({ rooms: [] });
    }
    await assert.rejects(() => deletion, /Could not confirm/);
    assert.equal(controller.state.meetings.length, 2);
});

test('superseded, foreign-workspace and disposed loads never write room state', async (t) => {
    const { controller, pendingLists, workspace, flush } = raceFixture(t);
    const foreign = controller.loadMeetings();
    await flush();
    workspace.id = 'other';
    pendingLists[0]({ rooms: [] });
    assert.equal(await foreign, null);
    workspace.id = 'rooms';
    const disposed = controller.loadMeetings();
    await flush();
    controller.webMeetRoom.disposed = true;
    pendingLists[1]({ rooms: [] });
    assert.equal(await disposed, null);
    controller.webMeetRoom.disposed = false;
    const guest = controller.loadMeetings({ revalidateVisibility: true });
    await flush();
    controller.isGuestSession = () => true;
    pendingLists[2]({ rooms: [] });
    assert.equal(await guest, null);
    assert.equal(controller.state.meetings.length, 2);
});
