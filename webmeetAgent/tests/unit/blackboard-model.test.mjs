import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    Blackboard,
    BlackboardWidget,
    createBlackboardWidget
} from '../../lib/blackboard/model.mjs';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
    parseWebMeetEvent
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import {
    ROOM_EVENT_TYPES,
    WebMeetRoomEvents
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-events.js';
import {
    applyRoomBlackboardChange,
    applyRoomBlackboardEvents,
    authorizeMeetingParticipant,
    createMeeting,
    createStoreContext,
    getRoomBlackboard,
    getRoomBlackboardForCommand,
    joinMeeting,
    listMeetingEvents,
    publishRoomAttachment
} from '../../lib/webmeetStore.mjs';
import { installEdgeJoinFixture } from './edge-join-fixture.mjs';
import {
    decryptRoomPayload,
    loadRoomRecord
} from '../../lib/store/roomRecords.mjs';
import { dispatch } from '../../tools/webmeet_tool.mjs';
import {
    encodeBlackboardProtocolMessage,
    parseBlackboardProtocolMessage
} from '../../lib/blackboard/protocol.mjs';
import { BlackboardNetworkAdapter } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/blackboard/blackboard-network-adapter.js';
import {
    getBlackboardTheme,
    getBlackboardThemeOptions
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-theme-presets.js';
import { blackboardScriptaActionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-scripta-actions.js';
import { expandCompositeSelectionWidgetIds } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-groups.js';
import { blackboardRenderingMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-rendering.js';
import { blackboardReconciliationMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-reconciliation.js';

const BLACKBOARD_PANEL_MODULES = [
    'webmeet-blackboard-panel.js',
    'webmeet-blackboard-actions.js',
    'webmeet-blackboard-geometry.js',
    'webmeet-blackboard-graphics-rendering.js',
    'webmeet-blackboard-attachment-rendering.js',
    'webmeet-blackboard-interactions.js',
    'webmeet-blackboard-reconciliation.js',
    'webmeet-blackboard-rendering.js',
    'webmeet-blackboard-collaboration-rendering.js',
    'webmeet-blackboard-scripta-actions.js',
    'webmeet-blackboard-scripta-rendering.js'
];

test('composite selection expands every selected rigid group', () => {
    const widgets = [
        { id: 'a', groupId: 'group-1' },
        { id: 'b', groupId: 'group-1' },
        { id: 'c', groupId: 'group-2' },
        { id: 'd', groupId: 'group-2' },
        { id: 'e', groupId: '' },
    ];
    assert.deepEqual(expandCompositeSelectionWidgetIds(widgets, ['a', 'd', 'e']), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(expandCompositeSelectionWidgetIds(widgets, ['e']), ['e']);
});

async function readBlackboardPanelSource() {
    const panelDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel'
    );
    const sources = await Promise.all(
        BLACKBOARD_PANEL_MODULES.map((fileName) => fs.readFile(path.join(panelDir, fileName), 'utf8'))
    );
    return sources.join('\n');
}

test('blackboard applies final create, patch and delete operations', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.applyFinalChange({
        changeType: 'create',
        targetType: 'widget',
        widget: createBlackboardWidget('shape', {
            geometry: { x: 10, y: 20, width: 100, height: 50 }
        }, { id: 'shape_1' }).serializePrivileged()
    });

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'shape_1',
        reason: 'drag',
        patch: { properties: { geometry: { x: 40 } } }
    });

    assert.equal(blackboard.getWidget('shape_1').properties.geometry.x, 40);
    assert.equal(blackboard.getWidget('shape_1').properties.geometry.y, 20);

    blackboard.applyFinalChange({
        changeType: 'delete',
        targetType: 'widget',
        targetRef: 'shape_1'
    });

    assert.equal(blackboard.getWidget('shape_1'), null);
});

test('file widget geometry cannot become smaller than its card content', () => {
    const widget = new BlackboardWidget({
        id: 'file-minimum',
        type: 'file',
        properties: {geometry: {x: 20, y: 30, width: 80, height: 40}},
    });
    assert.deepEqual(widget.properties.geometry, {x: 20, y: 30, width: 160, height: 100});
    widget.patchProperties({geometry: {width: 120, height: 60}});
    assert.deepEqual(widget.properties.geometry, {x: 20, y: 30, width: 160, height: 100});
});

test('blackboard applies final background changes to board metadata', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'blackboard',
        reason: 'background',
        patch: {
            metadata: {
                background: {
                    color: '#f8fafc',
                    gridColor: '#dbe4ef',
                    gridSize: 20
                }
            }
        }
    });

    assert.deepEqual(blackboard.metadata.background, {
        color: '#f8fafc',
        gridColor: '#dbe4ef',
        gridSize: 20
    });
    assert.equal(blackboard.revision, 1);
});

test('blackboard theme changes reset only widget color style fields', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'shape_1',
        type: 'shape',
        properties: {
            style: { fill: '#ffffff', stroke: '#334155', strokeWidth: 2 }
        }
    }), { record: false });
    blackboard.addWidget(new BlackboardWidget({
        id: 'line_1',
        type: 'line',
        properties: {
            style: { stroke: '#334155', strokeWidth: 3 }
        }
    }), { record: false });
    blackboard.addWidget(new BlackboardWidget({
        id: 'text_1',
        type: 'text',
        properties: {
            style: {
                fill: '#ffffff',
                stroke: '#cbd5e1',
                textColor: '#172033',
                fontFamily: 'Georgia',
                fontSize: 24,
                fontWeight: '700',
                fontStyle: 'italic'
            }
        }
    }), { record: false });

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'blackboard',
        reason: 'theme',
        patch: {
            metadata: { theme: { id: 'leadership' } },
            resetThemeStyles: true
        }
    });

    assert.deepEqual(blackboard.metadata.theme, { id: 'leadership' });
    assert.deepEqual(blackboard.serialize().metadata, { theme: { id: 'leadership' } });
    assert.deepEqual(blackboard.getWidget('shape_1').properties.style, { strokeWidth: 2 });
    assert.deepEqual(blackboard.getWidget('line_1').properties.style, { strokeWidth: 3 });
    assert.deepEqual(blackboard.getWidget('text_1').properties.style, {
        fontFamily: 'Georgia',
        fontSize: 24,
        fontWeight: '700',
        fontStyle: 'italic'
    });
});

test('blackboard public projection exposes only safe theme metadata', () => {
    const blackboard = new Blackboard({
        roomId: 'room_1',
        metadata: {
            theme: { id: 'paper', internalToken: 'not-public' },
            privateState: { secret: true }
        }
    });

    assert.deepEqual(blackboard.serialize().metadata, { theme: { id: 'paper' } });
    assert.deepEqual(blackboard.serializePrivileged().metadata, {
        theme: { id: 'paper', internalToken: 'not-public' },
        privateState: { secret: true }
    });
});

test('blackboard filters participant data for normal participants and exposes it to moderators', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'card_1',
        type: 'card',
        properties: {
            text: '2 + 2',
            correctAnswer: '4',
            participantData: {
                alice: { answer: '4' },
                bob: { answer: '5' }
            },
            aggregation: { counts: { 4: 1, 5: 1 } },
            resultsVisibility: 'moderators'
        }
    }));

    const alice = blackboard.serialize({ participantId: 'alice', roles: [] });
    const moderator = blackboard.serialize({ participantId: 'mod', roles: ['moderator'] });

    assert.deepEqual(alice.widgets[0].properties.participantData, { alice: { answer: '4' } });
    assert.equal(alice.widgets[0].properties.aggregation, undefined);
    assert.equal(alice.widgets[0].properties.correctAnswer, undefined);
    assert.deepEqual(moderator.widgets[0].properties.participantData, {
        alice: { answer: '4' },
        bob: { answer: '5' }
    });
    assert.deepEqual(moderator.widgets[0].properties.aggregation, { counts: { 4: 1, 5: 1 } });
});

test('blackboard supports document visibility and results visibility variants', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'poll_1',
        type: 'poll',
        visibility: 'user:alice',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            resultsVisibility: 'afterPoll',
            anonymous: true
        }
    }));
    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' }, participantName: 'Alice Smith' }
    });
    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'bob',
        data: { answers: { q1: 'B' } }
    });

    const alice = blackboard.serialize({ participantId: 'alice', roles: [] });
    const bob = blackboard.serialize({ participantId: 'bob', roles: [] });
    const moderator = blackboard.serialize({ participantId: 'mod', roles: ['moderator'] });

    assert.equal(alice.widgets.length, 1);
    assert.deepEqual(alice.widgets[0].properties.participantData, {});
    assert.deepEqual(alice.widgets[0].properties.aggregation, {
        questions: { q1: { counts: { A: 1, B: 1 }, total: 2 } },
        totalParticipants: 2
    });
    assert.equal(bob.widgets.length, 0);
    assert.equal(moderator.widgets.length, 1);
});

test('blackboard poll submit validates options and computes aggregation', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'poll_1',
        type: 'poll',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            resultsVisibility: 'public'
        }
    }));

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' }, participantName: 'Alice Smith' }
    });
    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'bob',
        data: { answers: { q1: 'B' } }
    });

    const poll = blackboard.getWidget('poll_1');
    assert.deepEqual(poll.properties.participantData, {
        alice: { answers: { q1: 'A' }, participantName: 'Alice Smith' },
        bob: { answers: { q1: 'B' } }
    });
    assert.deepEqual(poll.properties.aggregation, {
        questions: { q1: { counts: { A: 1, B: 1 }, total: 2 } },
        totalParticipants: 2
    });
});

test('blackboard poll rejects invalid options and locked poll changes', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'poll_1',
        type: 'poll',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            allowPollChange: false
        }
    }));

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'C' } }
    }), /Invalid poll option/);

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' } }
    });

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'B' } }
    }), /Poll cannot be changed/);
});

test('blackboard poll can allow participant poll changes', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'poll_1',
        type: 'poll',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            allowPollChange: true
        }
    }));

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' } }
    });
    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'B' } }
    });

    const poll = blackboard.getWidget('poll_1');
    assert.deepEqual(poll.properties.participantData, { alice: { answers: { q1: 'B' } } });
    assert.deepEqual(poll.properties.aggregation, {
        questions: { q1: { counts: { A: 0, B: 1 }, total: 1 } },
        totalParticipants: 1
    });
});

test('blackboard poll supports rating mode aggregation', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.applyFinalChange({
        changeType: 'create',
        targetType: 'widget',
        participantId: 'owner',
        widget: {
            id: 'poll_1',
            type: 'poll',
            properties: {
                description: 'Rate',
                questions: [{ id: 'q1', prompt: 'Rate one', pollMode: 'rating', ratingMax: 5 }]
            }
        }
    });

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: '5' } }
    });

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'bob',
        data: { answers: { q1: '6' } }
    }), /Invalid poll option/);

    const poll = blackboard.getWidget('poll_1');
    assert.deepEqual(poll.properties.questions[0].options, ['1', '2', '3', '4', '5']);
    assert.deepEqual(poll.properties.aggregation, {
        questions: { q1: { counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 }, total: 1 } },
        totalParticipants: 1
    });
});

test('blackboard poll owner and admin can manage but participants cannot', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.applyFinalChange({
        changeType: 'create',
        targetType: 'widget',
        participantId: 'owner',
        widget: {
            id: 'poll_1',
            type: 'poll',
            properties: {
                description: 'Pick',
                questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }]
            }
        }
    });

    const poll = blackboard.getWidget('poll_1');
    assert.equal(poll.createdBy, 'owner');
    assert.equal(poll.properties.ownerParticipantId, 'owner');

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'other',
        patch: { properties: { description: 'Nope' } }
    }), /Only the poll creator or an admin/);

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'owner',
        patch: { properties: { description: 'Updated by owner' } }
    });
    assert.equal(blackboard.getWidget('poll_1').properties.description, 'Updated by owner');

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'admin',
        patch: { properties: { description: 'Updated by admin' } }
    }, { canManagePoll: true });
    assert.equal(blackboard.getWidget('poll_1').properties.description, 'Updated by admin');
});

test('blackboard bullets widget is collaborative and normalizes items', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'bullets_1',
        type: 'bullets',
        properties: {
            title: 'Daily Standup',
            items: [
                { id: 'n1', text: 'Ship release', status: 'done', priority: 'high' },
                { id: 'n2', text: 'Needs design input', status: 'blocked', priority: 'low' },
                { id: 'empty', text: '', status: 'bad', priority: 'bad' }
            ]
        }
    }), { participantId: 'owner' });

    const created = blackboard.getWidget('bullets_1');
    assert.equal(created.properties.title, 'Daily Standup');
    assert.ok(created.createdAt);
    assert.equal(Object.prototype.hasOwnProperty.call(created.properties, 'participantCount'), false);
    assert.deepEqual(created.properties.items, [
        { id: 'n1', text: 'Ship release', status: 'done', priority: 'high' },
        { id: 'n2', text: 'Needs design input', status: 'blocked', priority: 'low' }
    ]);

    blackboard.patchWidget('bullets_1', {
        properties: {
            items: [
                { id: 'n1', text: 'Ship release', status: 'done', priority: 'high' },
                { id: 'n3', text: 'Follow up with QA', status: 'inProgress', priority: 'medium' },
                { id: 'n4', text: 'Bad values normalize', status: 'unknown', priority: 'urgent' }
            ]
        }
    }, { participantId: 'alice' });

    assert.deepEqual(blackboard.getWidget('bullets_1').properties.items, [
        { id: 'n1', text: 'Ship release', status: 'done', priority: 'high' },
        { id: 'n3', text: 'Follow up with QA', status: 'inProgress', priority: 'medium' },
        { id: 'n4', text: 'Bad values normalize', status: 'todo', priority: 'medium' }
    ]);

    blackboard.removeWidget('bullets_1', { participantId: 'bob' });
    assert.equal(blackboard.getWidget('bullets_1'), null);
});

test('blackboard poll timer start close and expiry rules', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.applyFinalChange({
        changeType: 'create',
        targetType: 'widget',
        participantId: 'owner',
        widget: {
            id: 'poll_1',
            type: 'poll',
            properties: {
                description: 'Timed',
                questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
                durationSeconds: 120
            }
        }
    });

    assert.equal(blackboard.getWidget('poll_1').properties.status, 'draft');
    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' } }
    }), /Poll is not open/);

    blackboard.applyFinalChange({
        changeType: 'start',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'owner'
    }, { nowIso: '2026-06-19T10:00:00.000Z' });
    assert.equal(blackboard.getWidget('poll_1').properties.status, 'open');
    assert.equal(blackboard.getWidget('poll_1').properties.closesAt, '2026-06-19T10:02:00.000Z');

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' } }
    }, { nowMs: Date.parse('2026-06-19T10:01:00.000Z') });

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'bob',
        data: { answers: { q1: 'B' } }
    }, { nowMs: Date.parse('2026-06-19T10:03:00.000Z') }), /Poll is closed/);
    assert.equal(blackboard.getWidget('poll_1').properties.status, 'closed');
});

test('blackboard poll updates cannot overwrite participant data or aggregation', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'poll_1',
        type: 'poll',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            participantData: { alice: { answers: { q1: 'A' } } },
            aggregation: {
                questions: { q1: { counts: { A: 99, B: 0 }, total: 99 } },
                totalParticipants: 99
            }
        }
    }));

    blackboard.patchWidget('poll_1', {
        properties: {
            participantData: { mallory: { answers: { q1: 'B' } } },
            aggregation: {
                questions: { q1: { counts: { A: 0, B: 99 }, total: 99 } },
                totalParticipants: 99
            },
            description: 'Changed'
        }
    }, { canManagePoll: true });

    const poll = blackboard.getWidget('poll_1');
    assert.equal(poll.properties.description, 'Changed');
    assert.deepEqual(poll.properties.participantData, {});
    assert.deepEqual(poll.properties.aggregation, {
        questions: { q1: { counts: { A: 0, B: 0 }, total: 0 } },
        totalParticipants: 0
    });
});

test('blackboard undo and redo keep a bounded final-operation history', () => {
    const blackboard = new Blackboard({ roomId: 'room_1', maxHistoryDepth: 3 });
    blackboard.addWidget(createBlackboardWidget('text', { text: 'a' }, { id: 'text_1' }));
    blackboard.patchWidget('text_1', { properties: { text: 'b' } });
    blackboard.patchWidget('text_1', { properties: { text: 'c' } });
    blackboard.patchWidget('text_1', { properties: { text: 'd' } });

    assert.equal(blackboard.history.undoStack.length, 3);
    blackboard.undo();
    assert.equal(blackboard.getWidget('text_1').properties.text, 'c');
    blackboard.redo();
    assert.equal(blackboard.getWidget('text_1').properties.text, 'd');
});

test('blackboard.updated uses the canonical WebMeet event format', () => {
    const encoded = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_1',
        blackboardRevision: 7,
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'shape_1',
        objectKind: 'widget'
    });
    const parsed = parseWebMeetEvent(encoded);

    assert.equal(parsed.room, 'room_1');
    assert.equal(parsed.type, WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED);
    assert.equal(parsed.payload.blackboardRevision, 7);
});

test('blackboard realtime events are routed to dashboard room handlers', () => {
    const codec = new WebMeetRoomEvents();

    assert.equal(
        codec.resolveRoomEventType(WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED),
        ROOM_EVENT_TYPES.BLACKBOARD_UPDATED
    );
    assert.equal(
        codec.resolveRoomEventType(WEBMEET_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED),
        ROOM_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED
    );
});

test('blackboard protocol serializes final filtered objects with actor addresses', () => {
    const encoded = encodeBlackboardProtocolMessage({
        from: 'user:participant_1',
        to: 'ALL',
        payload: {
            kind: 'widget',
            roomId: 'room_1',
            boardId: 'agent:agent_robo_team',
            revision: 3,
            visibility: { mode: 'all' },
            object: { id: 'widget_1' }
        }
    });
    const parsed = parseBlackboardProtocolMessage(encoded);

    assert.match(encoded, /^blackboard:user:participant_1:ALL:/);
    assert.equal(parsed.from, 'user:participant_1');
    assert.equal(parsed.to, 'ALL');
    assert.equal(parsed.payload.kind, 'widget');
    assert.equal(parsed.payload.boardId, 'agent:agent_robo_team');
    assert.equal(parsed.payload.object.id, 'widget_1');
});

test('blackboard network adapter deduplicates and applies final protocol objects without resync', async () => {
    let resyncCount = 0;
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_1',
        runTool: async () => {
            resyncCount += 1;
            return { blackboard: { boardId: 'agent:agent_robo_team', revision: 1, widgets: [] } };
        }
    });
    const received = [];
    adapter.subscribe((payload) => received.push(payload));
    const blackboardMessage = encodeBlackboardProtocolMessage({
        from: 'service:webmeetAgent',
        to: 'ALL',
        payload: {
            kind: 'widget',
            roomId: 'room_1',
            boardId: 'agent:agent_robo_team',
            messageId: 'bb_msg_1',
            revision: 4,
            visibility: { mode: 'all' },
            object: { id: 'widget_1', type: 'text', properties: { text: 'Done' } }
        }
    });
    const encodedEvent = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_1',
        boardId: 'agent:agent_robo_team',
        blackboardRevision: 4,
        changeType: 'update',
        objectKind: 'widget',
        blackboardMessage
    });

    assert.equal(await adapter.handleEncodedEvent(encodedEvent), 'applied');
    assert.equal(await adapter.handleEncodedEvent(encodedEvent), 'duplicate');
    assert.equal(resyncCount, 0);
    assert.equal(received[0].kind, 'widget');
    assert.equal(received[0].object.properties.text, 'Done');
});

test('SCRIPTA realtime updates reload the authenticated viewer projection', async () => {
    let resyncCount = 0;
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_other',
        runTool: async (name) => {
            assert.equal(name, 'webmeet_blackboard_workspace_get');
            resyncCount += 1;
            return {
                workspace: {
                    activeBoardId: 'agent:agent_robo_team',
                    boardOrder: ['agent:agent_robo_team'],
                    boards: [{ boardId: 'agent:agent_robo_team', title: 'Workspace 1', revision: 5, widgetCount: 1 }],
                },
                blackboard: {
                    boardId: 'agent:agent_robo_team',
                    revision: 5,
                    widgets: [{
                        id: 'robo_scripta_document',
                        type: 'scripta-document',
                        properties: {
                            paragraph: {
                                variants: [{
                                    id: 'variant_owner',
                                    canEdit: false,
                                    canDelete: false,
                                }],
                            },
                        },
                    }],
                },
            };
        },
    });
    const received = [];
    adapter.subscribe((payload) => received.push(payload));
    const blackboardMessage = encodeBlackboardProtocolMessage({
        from: 'user:participant_owner',
        to: 'ALL',
        payload: {
            kind: 'blackboard',
            roomId: 'room_1',
            boardId: 'agent:agent_robo_team',
            messageId: 'bb_scripta_owner_projection',
            revision: 5,
            object: {
                boardId: 'agent:agent_robo_team',
                revision: 5,
                widgets: [{
                    id: 'robo_scripta_document',
                    type: 'scripta-document',
                    properties: {
                        paragraph: {
                            variants: [{
                                id: 'variant_owner',
                                canEdit: true,
                                canDelete: true,
                            }],
                        },
                    },
                }],
            },
        },
    });
    const encodedEvent = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_1',
        boardId: 'agent:agent_robo_team',
        blackboardRevision: 5,
        changeType: 'scripta-p-variant-edit',
        blackboardMessage,
    });

    assert.equal(await adapter.handleEncodedEvent(encodedEvent), 'applied');
    assert.equal(resyncCount, 1);
    const variant = received[0].object.widgets[0].properties.paragraph.variants[0];
    assert.equal(variant.canEdit, false);
    assert.equal(variant.canDelete, false);
});

test('SCRIPTA realtime broadcasts are invalidations without viewer-scoped objects', async () => {
    let published = null;
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_owner',
        runTool: async () => ({}),
        publishRealtimePayload: async (payload) => { published = payload; },
    });

    await adapter.publishFinalUpdate({
        blackboard: {
            boardId: 'agent:agent_robo_team',
            revision: 6,
            widgets: [{
                id: 'robo_scripta_document',
                type: 'scripta-document',
                properties: {
                    paragraph: {
                        variants: [{
                            id: 'variant_owner',
                            canEdit: true,
                            canDelete: true,
                        }],
                    },
                },
            }],
        },
    }, 'scripta-p-variant-edit');

    const protocol = parseBlackboardProtocolMessage(published.blackboardMessage);
    assert.equal(protocol.payload.revision, 6);
    assert.equal(protocol.payload.object, null);
});

test('SCRIPTA draft text is delivered as transient presentation state', async () => {
    let published = null;
    const sender = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_owner',
        runTool: async () => ({}),
        publishRealtimePayload: async (payload) => { published = payload; },
    });
    sender.currentRevision = 9;
    await sender.publishScriptaDraft({
        resourceId: 'resource_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        variantId: 'variant_1',
        editorParticipantId: 'participant_owner',
        text: 'Live draft',
    });

    const received = [];
    const receiver = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_other',
        runTool: async () => {
            throw new Error('Transient draft delivery must not persist or resync.');
        },
    });
    receiver.subscribe((payload) => received.push(payload));
    const encodedEvent = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, published);

    assert.equal(await receiver.handleEncodedEvent(encodedEvent), 'applied');
    assert.equal(received[0].kind, 'scripta-presentation');
    assert.equal(received[0].presentation.text, 'Live draft');
    assert.equal(received[0].presentation.variantId, 'variant_1');
});

test('blackboard network adapter maps UI changes to canonical event commands and upserts audit', async () => {
    let toolCall = null;
    let auditMessage = null;
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_1',
        onAuditMessage: (message) => { auditMessage = message; },
        runTool: async (name, args) => {
            toolCall = { name, args };
            return {
                ok: true,
                blackboard: { boardId: 'agent:agent_robo_team', revision: 5, widgets: [] },
                change: { changeType: 'update', targetType: 'widget', targetRef: 'widget_1' },
                auditMessage: { id: 'chat-event', kind: 'event', metadata: { status: 'success' } }
            };
        }
    });
    adapter.currentRevision = 4;
    await adapter.sendChange({
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'widget_1',
        patch: { properties: { text: 'Changed' } }
    });

    assert.equal(toolCall.name, 'webmeet_event_command');
    const event = JSON.parse(toolCall.args.event);
    assert.equal('version' in event, false);
    assert.equal('expectedBoardVersion' in event, false);
    assert.equal(event.target.widgetId, 'widget_1');
    assert.equal(event.action, 'update');
    assert.equal(auditMessage.id, 'chat-event');

    await adapter.sendChange({
        changeType: 'update',
        targetType: 'group',
        targetRef: 'group_1',
        patch: { transform: { translation: { x: 20, y: 10 } } },
    });
    const groupEvent = JSON.parse(toolCall.args.event);
    assert.deepEqual(groupEvent.target, { type: 'group', groupId: 'group_1' });
    assert.deepEqual(groupEvent.payload.patch.transform.translation, { x: 20, y: 10 });

    await adapter.sendChange({
        changeType: 'create', targetType: 'blackboard',
        widget: { id: 'local-id', type: 'shape', locked: true, visibility: { mode: 'private' }, properties: { label: 'Safe' } },
    });
    const createEvent = JSON.parse(toolCall.args.event);
    assert.deepEqual(createEvent.payload.widget, { type: 'shape', properties: { label: 'Safe' } });
});

test('blackboard network adapter ignores command projections older than the applied revision', async () => {
    const pending = [];
    const received = [];
    const published = [];
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_1',
        runTool: async () => new Promise((resolve) => pending.push(resolve)),
        publishRealtimePayload: async (payload) => published.push(payload),
    });
    adapter.subscribe((payload) => received.push(payload));

    const first = adapter.sendEvent('update', { patch: { properties: { text: 'Older' } } }, {
        widgetId: 'widget_1',
    });
    const second = adapter.sendEvent('update', { patch: { properties: { text: 'Newer' } } }, {
        widgetId: 'widget_1',
    });
    await Promise.resolve();

    pending[1]({
        ok: true,
        blackboard: { boardId: 'agent:agent_robo_team', revision: 2, widgets: [{ id: 'widget_1', properties: { text: 'Newer' } }] },
    });
    await second;
    pending[0]({
        ok: true,
        blackboard: { boardId: 'agent:agent_robo_team', revision: 1, widgets: [{ id: 'widget_1', properties: { text: 'Older' } }] },
    });
    await first;

    assert.equal(adapter.currentRevision, 2);
    assert.deepEqual(received.map((entry) => [entry.revision, entry.object.widgets[0].properties.text]), [[2, 'Newer']]);
    assert.equal(published.filter((entry) => entry.type === WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED).length, 1);
});

test('blackboard undo and redo publish changed projections to realtime peers', async () => {
    const published = [];
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1', boardId: 'agent:agent_robo_team', participantId: 'participant_1',
        runTool: async () => ({
            ok: true, changed: true,
            blackboard: { boardId: 'agent:agent_robo_team', revision: 7, widgets: [], interactionContext: {} },
            broadcast: { kind: 'blackboard', roomId: 'room_1', boardId: 'agent:agent_robo_team', revision: 7, object: { boardId: 'agent:agent_robo_team', revision: 7, widgets: [] } },
        }),
        publishRealtimePayload: async (payload) => { published.push(payload); },
    });
    await adapter.undo();
    await adapter.redo();
    assert.equal(published.filter((payload) => payload.type === WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED).length, 2);
});

test('SCRIPTA local navigation sends only action-compatible target fields', () => {
    const calls = [];
    const panel = {
        runScriptaEvent(action, payload) {
            calls.push({ action, payload });
        }
    };
    const invoke = (action) => blackboardScriptaActionMethods.runScriptaLocalAction.call(
        panel,
        { disabled: false },
        action,
        encodeURIComponent('chapter-1'),
        encodeURIComponent('paragraph-1'),
        '1',
        '1',
        '-'
    );

    invoke('scripta-document-view');
    invoke('scripta-paragraph-previous');
    invoke('scripta-paragraph-next');
    invoke('scripta-paragraph-open');

    assert.deepEqual(calls, [
        { action: 'scripta-document-view', payload: {} },
        { action: 'scripta-paragraph-previous', payload: {} },
        { action: 'scripta-paragraph-next', payload: {} },
        { action: 'scripta-paragraph-open', payload: { chapterId: 'chapter-1', paragraphId: 'paragraph-1' } },
    ]);
});

test('SCRIPTA edit start validates through a state-only projection without rerendering the panel', async () => {
    const calls = [];
    let renders = 0;
    const panel = {
        busy: false,
        adapter: {
            sendEvent: async (...args) => {
                calls.push(args);
                return {ok: true, blackboard: {revision: 4, widgets: []}};
            },
        },
        clearScriptaDraft() {},
        renderWidgets() { renders += 1; },
    };

    const response = await blackboardScriptaActionMethods.startScriptaVariantEdit.call(panel, null, {
        chapterId: 'chapter-1',
        paragraphId: 'paragraph-1',
        variantId: 'variant-1',
    });

    assert.equal(response.ok, true);
    assert.equal(calls[0][0], 'scripta-p-variant-edit-start');
    assert.deepEqual(calls[0][2], {
        widgetId: 'robo_scripta_document',
        targetType: 'widget',
        projectionMode: 'state',
    });
    assert.equal(renders, 0);
});

test('SCRIPTA variant image adapter sends canonical audited event commands', async () => {
    const calls = [];
    const audits = [];
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1', boardId: 'agent:agent_robo_team', participantId: 'participant_1',
        runTool: async (name, args) => {
            calls.push({ name, args });
            return {
                ok: true,
                blackboard: { boardId: 'agent:agent_robo_team', revision: calls.length, widgets: [] },
                auditMessage: {id: `audit-${calls.length}`, kind: 'event'},
            };
        },
        onAuditMessage: (message) => audits.push(message),
        publishRealtimePayload: async () => {},
    });
    const localUpdates = [];
    adapter.subscribe((payload) => localUpdates.push(payload));
    const target = {chapterId: 'chapter-1', paragraphId: 'paragraph-1', variantId: 'variant-1', variantOrdinal: 1};
    await adapter.mutateScriptaVariantImage('insert', {
        ...target, assetId: 'asset-1', alt: 'First', position: 7,
        aspectRatio: '', fit: '', alignment: '',
    });
    await adapter.mutateScriptaVariantImage('replace', {...target, imageId: 'image-1', imageOrdinal: 1, assetId: 'asset-2', alt: 'Second'});
    await adapter.mutateScriptaVariantImage('layout', {...target, imageId: 'image-1', imageOrdinal: 1, widthPercent: 55, aspectRatio: '16:9', fit: 'cover', alignment: 'right'});
    await adapter.mutateScriptaVariantImage('delete', {...target, imageId: 'image-1', imageOrdinal: 1});

    assert.deepEqual(calls.map(({name}) => name), [
        'webmeet_event_command',
        'webmeet_event_command',
        'webmeet_event_command',
        'webmeet_event_command',
    ]);
    const events = calls.map(({args}) => JSON.parse(args.event));
    assert.deepEqual(events.map(({action}) => action), [
        'scripta-p-variant-image-insert',
        'scripta-p-variant-image-replace',
        'scripta-p-variant-image-layout',
        'scripta-p-variant-image-delete',
    ]);
    assert.equal(events[0].payload.position, 7);
    assert.equal('imageId' in events[0].payload, false);
    assert.equal('aspectRatio' in events[0].payload, false);
    assert.equal(events[1].payload.imageOrdinal, 1);
    assert.equal(events[2].payload.widthPercent, 55);
    assert.equal(events[2].payload.aspectRatio, '16:9');
    assert.equal(events[3].payload.variantOrdinal, 1);
    assert.equal(audits.length, 4);
    assert.deepEqual(localUpdates.map(({kind, reason}) => ({kind, reason})), [
        {kind: 'blackboard', reason: 'scripta-p-variant-image-insert'},
        {kind: 'blackboard', reason: 'scripta-p-variant-image-replace'},
        {kind: 'blackboard-state', reason: 'scripta-p-variant-image-layout'},
        {kind: 'blackboard', reason: 'scripta-p-variant-image-delete'},
    ]);
});

test('a local SCRIPTA image layout response is not rerendered through its own realtime invalidation', async () => {
    let published = null;
    let toolCalls = 0;
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_1',
        runTool: async () => {
            toolCalls += 1;
            return {
                ok: true,
                blackboard: {boardId: 'agent:agent_robo_team', revision: 7, widgets: []},
            };
        },
        publishRealtimePayload: async (payload) => { published = payload; },
    });
    const localUpdates = [];
    adapter.subscribe((payload) => localUpdates.push(payload));

    await adapter.mutateScriptaVariantImage('layout', {
        chapterId: 'chapter-1', paragraphId: 'paragraph-1', variantOrdinal: 1, imageOrdinal: 1,
        widthPercent: 60,
    });
    assert.equal(localUpdates.length, 1);
    assert.equal(localUpdates[0].kind, 'blackboard-state');
    assert.equal(toolCalls, 1);

    const encodedEvent = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, published);
    assert.equal(await adapter.handleEncodedEvent(encodedEvent), 'applied');
    assert.equal(toolCalls, 1);
    assert.equal(localUpdates.length, 1);
});

test('SCRIPTA image insertion saves the draft before applying the cursor-positioned asset', async () => {
    const calls = [];
    const panel = {
        busy: false,
        pickScriptaImage: async () => ({name: 'diagram.png'}),
        uploadPickedScriptaImage: async () => ({assetId: 'asset-diagram', alt: 'diagram.png'}),
        clearScriptaDraft: () => calls.push({operation: 'clear-draft'}),
        adapter: {
            applyScriptaVariantEdit: async (payload) => calls.push({operation: 'edit', payload}),
            mutateScriptaVariantImage: async (operation, payload) => calls.push({operation, payload}),
        },
        renderWidgets() {},
    };
    await blackboardScriptaActionMethods.insertScriptaVariantImage.call(panel, {
        resourceId: 'resource-1', chapterId: 'chapter-1', paragraphId: 'paragraph-1', variantId: 'variant-1',
        text: 'text with draft', position: 5,
    });
    assert.deepEqual(calls.map((entry) => entry.operation), ['clear-draft', 'edit', 'insert']);
    assert.equal(calls[1].payload.text, 'text with draft');
    assert.equal(calls[2].payload.position, 5);
    assert.equal(calls[2].payload.assetId, 'asset-diagram');
});

test('SCRIPTA chapter image adapter creates an image paragraph without a Blackboard widget', async () => {
    const calls = [];
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1', boardId: 'agent:agent_robo_team', participantId: 'participant_1',
        runTool: async (name, args) => {
            calls.push({name, args});
            return {ok: true, blackboard: {boardId: 'agent:agent_robo_team', revision: 1, widgets: []}};
        },
        publishRealtimePayload: async () => {},
    });

    await adapter.addScriptaImageParagraph({chapterId: 'chapter-2', assetId: 'asset-image', alt: 'Sketch'});

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'webmeet_event_command');
    const event = JSON.parse(calls[0].args.event);
    assert.equal(event.action, 'scripta-paragraph-add');
    assert.deepEqual(event.payload, {
        chapterId: 'chapter-2',
        text: '',
        assetId: 'asset-image',
        alt: 'Sketch',
    });
});

test('blackboard network adapter applies last-edit-wins without a conflict resync', async () => {
    const calls = [];
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_1',
        runTool: async (name) => {
            calls.push(name);
            return { ok: true, blackboard: { boardId: 'agent:agent_robo_team', revision: 5, widgets: [] } };
        }
    });
    adapter.currentRevision = 4;

    await adapter.sendEvent('scripta-document-view', {}, {
        widgetId: 'robo_scripta_document'
    });

    assert.deepEqual(calls, ['webmeet_event_command']);
    assert.equal(adapter.currentRevision, 5);
});

test('blackboard visibility payloads remain local and are never published by the adapter', async () => {
    const published = [];
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_1',
        runTool: async () => ({
            ok: true,
            visibilityPayload: {
                type: WEBMEET_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED,
                meetingId: 'room_1', participantId: 'participant_1', visible: true,
            },
        }),
        publishRealtimePayload: async (payload) => { published.push(payload); },
    });

    const response = await adapter.sendEvent('show', {}, { targetType: 'blackboard' });

    assert.equal(response.visibilityPayload.visible, true);
    assert.deepEqual(published, []);
});

test('blackboard theme updates are broadcast as full blackboard updates for other participants', async () => {
    const received = [];
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_2',
        runTool: async () => {
            throw new Error('Theme broadcast should not require resync.');
        }
    });
    adapter.subscribe((payload) => received.push(payload));

    const blackboardMessage = encodeBlackboardProtocolMessage({
        from: 'user:participant_1',
        to: 'ALL',
        payload: {
            kind: 'blackboard',
            roomId: 'room_1',
            boardId: 'agent:agent_robo_team',
            messageId: 'bb_theme_1',
            revision: 8,
            visibility: { mode: 'all' },
            object: {
                boardId: 'agent:agent_robo_team',
                revision: 8,
                metadata: { theme: { id: 'leadership' } },
                widgets: []
            }
        }
    });
    const encodedEvent = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_1',
        boardId: 'agent:agent_robo_team',
        blackboardRevision: 8,
        changeType: 'update',
        targetType: 'blackboard',
        objectKind: 'blackboard',
        blackboardMessage
    });

    assert.equal(await adapter.handleEncodedEvent(encodedEvent), 'applied');
    assert.equal(received[0].kind, 'blackboard');
    assert.equal(received[0].object.metadata.theme.id, 'leadership');
});

test('blackboard UI editing does not use browser prompt dialogs', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
    );
    const source = await readBlackboardPanelSource();
    const toolbarSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.js'),
        'utf8'
    );
    const editorSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.js'),
        'utf8'
    );
    const combinedSource = `${source}\n${toolbarSource}\n${editorSource}`;

    assert.doesNotMatch(combinedSource, /window\.prompt|prompt\(|alert\(/);
    assert.doesNotMatch(combinedSource, /customElements\.define|extends HTMLElement|shadowRoot|innerHTML/);
    assert.doesNotMatch(source, /webSkel\.defineComponent|BLACKBOARD_COMPONENT_DEFINITIONS|upsertWebSkelComponent/);
    assert.match(source, /contentEditable = 'true'/);
    assert.match(source, /widget\.type === 'text' \|\| widget\.type === 'card'/);
    assert.match(source, /addEventListener\('focusin'/);
    assert.match(source, /addEventListener\('blur'/);
    assert.match(source, /addEventListener\('dblclick'/);
    assert.match(source, /createContextButton\('settings', 'Widget settings'/);
    assert.match(source, /void this\.editWidget\(widget\)/);
    assert.match(source, /showModal\('webmeet-blackboard-widget-editor'/);
    assert.match(source, /getEditableWidgetProperty/);
    assert.match(source, /\[property\]: nextText/);
    assert.match(source, /return 'text'/);
    assert.doesNotMatch(source, /widget\?\.type === 'card' \? 'label' : 'text'/);
    assert.match(source, /webmeet-blackboard-toolbar/);
    assert.match(editorSource, /closeModal\(\)/);
    assert.doesNotMatch(editorSource, /blackboard-editor-save/);
});

test('RoboTeam card widgets persist inline edits into the canonical text property', async () => {
    const source = await readBlackboardPanelSource();
    const editableTextMethod = source.slice(
        source.indexOf('    getEditableWidgetText(widget)'),
        source.indexOf('\n    startInlineTextEdit(widget)', source.indexOf('    getEditableWidgetText(widget)'))
    );
    const roboTeamSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../lib/roboTeam/service.mjs'),
        'utf8'
    );

    assert.match(roboTeamSource, /id: 'robo_demo_context'[\s\S]*type: 'card'[\s\S]*text:/);
    assert.match(source, /widget\.type === 'card'[\s\S]*webmeet-blackboard-widget-title/);
    assert.match(source, /reason: 'edit'[\s\S]*patch:\s*\{\s*properties:\s*\{\s*\[property\]: nextText\s*\}\s*\}/);
    assert.match(source, /getEditableWidgetProperty\(\) \{[\s\S]*return 'text';[\s\S]*\}/);
    assert.doesNotMatch(editableTextMethod, /label/);
});

test('blackboard inline text editing survives render refresh and flushes before toolbar history actions', async () => {
    const source = await readBlackboardPanelSource();
    const renderWidgetsMethod = source.slice(
        source.indexOf('    renderWidgets()'),
        source.indexOf('\n    renderWidget(widget)', source.indexOf('    renderWidgets()'))
    );
    const startInlineTextEditMethod = source.slice(
        source.indexOf('    startInlineTextEdit(widget)'),
        source.indexOf('\n    flushInlineTextEdit()', source.indexOf('    startInlineTextEdit(widget)'))
    );
    const flushInlineTextEditMethod = source.slice(
        source.indexOf('    async flushInlineTextEdit()'),
        source.indexOf('\n    async finishInlineTextEdit', source.indexOf('    async flushInlineTextEdit()'))
    );

    assert.match(renderWidgetsMethod, /getInteractionProtectedWidgetIds\(\)/);
    assert.match(renderWidgetsMethod, /this\.pendingRenderAfterInlineEdit = deferredInlineRender/);
    assert.doesNotMatch(renderWidgetsMethod, /this\.board\.replaceChildren/);
    assert.match(source, /activeElement\?\.matches\?\.\('input, textarea, select/);
    assert.match(source, /handleBoardFocusOutEvent[\s\S]*pendingRenderAfterInteraction[\s\S]*renderWidgets\(\)/);
    assert.match(renderWidgetsMethod, /hasGroupInteraction[\s\S]*preserveGroupInteraction/);
    assert.match(startInlineTextEditMethod, /this\.inlineEditState = \{/);
    assert.match(startInlineTextEditMethod, /editable\.addEventListener\('input', onInput\)/);
    assert.match(startInlineTextEditMethod, /this\.growInlineTextBoxToFit\(widget\.id, editable\)/);
    assert.match(startInlineTextEditMethod, /void this\.finishInlineTextEdit\(true\)/);
    assert.match(flushInlineTextEditMethod, /await this\.finishInlineTextEdit\(true\)/);
    assert.match(flushInlineTextEditMethod, /await this\.inlineEditCommitPromise/);
    assert.match(source, /readInlineEditableText\(editable\)[\s\S]*innerText/);
    assert.match(source, /getInlineTextFitGeometry\(widgetId, editable\)/);
    assert.match(source, /growInlineTextBoxToFit\(widgetId, editable\)/);
    assert.match(source, /node\.style\.width = `\$\{fitGeometry\.width\}px`/);
    assert.match(source, /editable\.scrollWidth/);
    assert.match(source, /editable\.scrollHeight/);
    assert.match(source, /reason: 'resize'[\s\S]*patch:\s*\{\s*properties:\s*\{\s*geometry: fitGeometry\s*\}\s*\}/);
    assert.doesNotMatch(source, /async setTextWidgetStyle\(detail = \{\}\)/);
    assert.match(source, /async undo\(\) \{[\s\S]*await this\.flushInlineTextEdit\(\)/);
    assert.match(source, /async redo\(\) \{[\s\S]*await this\.flushInlineTextEdit\(\)/);
});

test('blackboard rendering reconciles changed widgets and preserves an active inline editor', () => {
    class FakeNode {
        constructor(id, text) {
            this.id = id;
            this.text = text;
            this.parentNode = null;
        }

        replaceWith(node) {
            const index = this.parentNode.children.indexOf(this);
            this.parentNode.children[index] = node;
            node.parentNode = this.parentNode;
            this.parentNode = null;
        }

        remove() {
            if (!this.parentNode) return;
            const index = this.parentNode.children.indexOf(this);
            if (index >= 0) this.parentNode.children.splice(index, 1);
            this.parentNode = null;
        }
    }

    const board = {
        children: [],
        append(node) {
            node.remove();
            this.children.push(node);
            node.parentNode = this;
        },
        insertBefore(node, reference) {
            node.remove();
            const index = reference ? this.children.indexOf(reference) : this.children.length;
            this.children.splice(index < 0 ? this.children.length : index, 0, node);
            node.parentNode = this;
        },
        querySelectorAll() {
            return [];
        },
    };
    let renderCount = 0;
    const context = {
        ...blackboardReconciliationMethods,
        ...blackboardRenderingMethods,
        board,
        blackboard: {
            widgets: [
                {id: 'a', type: 'text', properties: {text: 'A'}},
                {id: 'b', type: 'text', properties: {text: 'B'}},
            ],
        },
        widgetNodes: new Map(),
        widgetRenderKeys: new Map(),
        selectedWidgetIds: new Set(),
        selection: '',
        selectedGroupId: '',
        fullscreenWidgetId: '',
        inlineEditWidgetId: '',
        roboOrdinalMode: false,
        pendingWidgetType: '',
        applyBoardBackground() {},
        getRoboTargetOrdinals(widgets) {
            return {
                widgetOrdinals: new Map(widgets.map((widget, index) => [widget.id, index + 1])),
                groupOrdinals: new Map(),
            };
        },
        projectAttachedConnection(widget) {
            return widget;
        },
        getBlackboardTheme() {
            return {id: 'slate'};
        },
        renderWidget(widget) {
            renderCount += 1;
            return new FakeNode(widget.id, widget.properties.text);
        },
        renderGroupHitAreas() {},
        renderSelectionOverlay() {},
        updateToolbarState() {},
    };

    context.renderWidgets();
    const firstA = context.widgetNodes.get('a');
    const firstB = context.widgetNodes.get('b');
    assert.equal(renderCount, 2);

    context.blackboard = {
        widgets: [
            {id: 'a', type: 'text', properties: {text: 'A remote'}},
            {id: 'b', type: 'text', properties: {text: 'B'}},
        ],
    };
    context.renderWidgets();
    assert.notEqual(context.widgetNodes.get('a'), firstA);
    assert.equal(context.widgetNodes.get('b'), firstB);
    assert.equal(renderCount, 3);

    const editingA = context.widgetNodes.get('a');
    context.inlineEditWidgetId = 'a';
    context.blackboard.widgets[0] = {id: 'a', type: 'text', properties: {text: 'A newer remote'}};
    context.renderWidgets();
    assert.equal(context.widgetNodes.get('a'), editingA);
    assert.equal(context.widgetNodes.get('b'), firstB);
    assert.equal(context.pendingRenderAfterInlineEdit, true);

    context.inlineEditWidgetId = '';
    context.renderWidgets();
    assert.notEqual(context.widgetNodes.get('a'), editingA);
    assert.equal(context.widgetNodes.get('a').text, 'A newer remote');
    assert.equal(context.pendingRenderAfterInlineEdit, false);
});

test('blackboard realtime widget updates refresh the rendered panel', async () => {
    const panelSource = await readBlackboardPanelSource();
    const controllerSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/blackboard-methods.js'),
        'utf8'
    );

    assert.match(panelSource, /this\.handleUpdateEvent = \(event\) => this\.applyBlackboardUpdate\(event\.detail \|\| \{\}\)/);
    assert.match(panelSource, /applyBlackboardUpdate\(detail = \{\}\)[\s\S]*detail\?\.widget[\s\S]*this\.applyWidgetObject\(detail\.widget\)/);
    assert.match(panelSource, /adapter && adapter !== this\.adapter[\s\S]*this\.unsubscribeAdapter\?\.\(\)/);
    assert.match(controllerSource, /payload\.kind === 'widget'[\s\S]*webmeet-blackboard-update[\s\S]*widget: payload\.object/);
});

test('Robo widget ordinals are transient overlays controlled by command status', async () => {
    const panelSource = await readBlackboardPanelSource();
    const semanticSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../lib/blackboard/semantic-context.mjs'),
        'utf8'
    );
    const dashboardHtml = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.html'),
        'utf8'
    );
    const dashboardCss = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.css'),
        'utf8'
    );
    const controllerSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/blackboard-methods.js'),
        'utf8'
    );
    const config = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/config.json'),
        'utf8'
    );

    assert.match(panelSource, /this\.roboOrdinalMode/);
    assert.match(panelSource, /webmeet-blackboard-widget-ordinal/);
    assert.match(panelSource, /getRoboTargetOrdinals\(widgets\)/);
    assert.match(semanticSource, /targetType: groupId \? 'group' : 'widget'/);
    assert.match(semanticSource, /focusedGroupId/);
    assert.match(dashboardHtml, /webmeetBlackboardCommandStatus/);
    const statusRule = dashboardCss.match(/\.webmeet-blackboard-command-status\s*\{[\s\S]*?\}/)?.[0] || '';
    assert.match(statusRule, /color:\s*var\(--text-muted\)/);
    assert.match(statusRule, /font-size:\s*0\.72rem/);
    assert.doesNotMatch(statusRule, /border(?:-radius)?:/);
    assert.doesNotMatch(statusRule, /background:/);
    assert.doesNotMatch(dashboardCss, /\.webmeet-blackboard-command-status::after/);
    assert.match(controllerSource, /entry\.state === 'started'[\s\S]*webmeet-blackboard-command-status-activity[\s\S]*index < 3/);
    assert.match(dashboardCss, /webmeet-blackboard-command-status-dot:nth-child\(2\)[\s\S]*animation-delay:\s*0\.14s/);
    assert.match(dashboardCss, /webmeet-blackboard-command-status-dot:nth-child\(3\)[\s\S]*animation-delay:\s*0\.28s/);
    assert.match(dashboardCss, /@keyframes webmeet-blackboard-status-dot-wave[\s\S]*translateY\(-2px\)/);
    assert.match(dashboardCss, /@keyframes webmeet-blackboard-status-scroll/);
    assert.match(dashboardCss, /is-scrolling[\s\S]*--webmeet-status-scroll-duration/);
    assert.match(controllerSource, /travelDistance = viewportWidth \+ textWidth/);
    assert.match(controllerSource, /travelDistance \/ 45/);
    assert.match(controllerSource, /--webmeet-status-scroll-start/);
    assert.match(controllerSource, /--webmeet-status-scroll-end/);
    assert.match(controllerSource, /roboStatusErrorDurationMs\(errorMessage\)/);
    assert.match(controllerSource, /String\(message \|\| ''\)\.length \/ 6/);
    assert.match(dashboardCss, /prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none/);
    assert.doesNotMatch(config, /webmeet-robo-clarification-modal/);
});

test('blackboard panel addWidget uses connected adapter', async () => {
    const { WebMeetBlackboardPanel } = await import(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-panel.js')
    );
    const sentChanges = [];
    const listeners = new Map();
    const dispatchedEvents = [];
    const element = {
        querySelector(selector) {
            if (selector === '[data-role="board"]') {
                return {
                    style: { setProperty() {} },
                    replaceChildren() {}
                };
            }
            return null;
        },
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        removeEventListener(type, handler) {
            if (listeners.get(type) === handler) {
                listeners.delete(type);
            }
        },
        dispatchEvent(event) {
            dispatchedEvents.push(event.type);
            return true;
        }
    };
    const panel = new WebMeetBlackboardPanel(element, () => {});
    panel.renderWidgets = () => {};
    panel.updateToolbarState = () => {};
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    panel.afterRender();
    if (previousRequestAnimationFrame === undefined) {
        delete globalThis.requestAnimationFrame;
    } else {
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    }
    assert.ok(dispatchedEvents.includes('webmeet-blackboard-panel-ready'));
    listeners.get('webmeet-blackboard-connect')?.({
        detail: {
            adapter: {
                subscribe() {
                    return () => {};
                },
                async sendChange(change) {
                    sentChanges.push(change);
                    return {
                        object: change.widget,
                        blackboard: { roomId: 'room_1', version: 2, widgets: [change.widget] }
                    };
                }
            },
            blackboard: { roomId: 'room_1', version: 1, widgets: [] }
        }
    });

    await panel.addWidget('shape:ellipse');

    assert.equal(sentChanges.length, 1);
    assert.equal(sentChanges[0].changeType, 'create');
    assert.equal(sentChanges[0].widget.type, 'shape');
    assert.equal(sentChanges[0].widget.properties.shapeKind, 'ellipse');
});

test('blackboard selected toolbar widget is created at board click position', async () => {
    const { WebMeetBlackboardPanel } = await import(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-panel.js')
    );
    const previousElement = globalThis.Element;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    class MockElement {
        contains() { return true; }
        closest() { return null; }
    }
    globalThis.Element = MockElement;
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    const sentChanges = [];
    const board = new MockElement();
    board.style = { setProperty() {} };
    board.replaceChildren = () => {};
    board.addEventListener = () => {};
    board.removeEventListener = () => {};
    board.setPointerCapture = () => {};
    board.scrollLeft = 40;
    board.scrollTop = 60;
    board.getBoundingClientRect = () => ({ left: 30, top: 50, width: 640, height: 480 });
    const toolbarState = [];
    const element = {
        querySelector(selector) {
            if (selector === '[data-role="board"]') return board;
            if (selector === 'webmeet-blackboard-toolbar') {
                return {
                    setState(state) {
                        toolbarState.push(state);
                    },
                    addEventListener() {},
                    removeEventListener() {}
                };
            }
            return null;
        },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; }
    };
    const panel = new WebMeetBlackboardPanel(element, () => {});
    panel.renderWidgets = () => {};
    panel.connect({
        adapter: {
            subscribe() {
                return () => {};
            },
            async sendChange(change) {
                sentChanges.push(change);
                return {
                    object: change.widget,
                    blackboard: { roomId: 'room_1', version: 2, widgets: [change.widget] }
                };
            }
        },
        blackboard: { roomId: 'room_1', version: 1, widgets: [] }
    });
    try {
        panel.afterRender();
        panel.handleToolbarAddWidgetEvent({ detail: { type: 'shape:ellipse' } });

        panel.handleBoardPointerDownCapture({
            button: 0,
            pointerId: 1,
            target: new MockElement(),
            clientX: 330,
            clientY: 250,
            preventDefault() {},
            stopPropagation() {}
        });
        await panel.finishPendingWidgetDraw({
            clientX: 330,
            clientY: 250
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
        if (previousElement === undefined) {
            delete globalThis.Element;
        } else {
            globalThis.Element = previousElement;
        }
        if (previousRequestAnimationFrame === undefined) {
            delete globalThis.requestAnimationFrame;
        } else {
            globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        }
    }
    assert.equal(sentChanges.length, 1);
    assert.equal(sentChanges[0].widget.type, 'shape');
    assert.equal(sentChanges[0].widget.properties.shapeKind, 'ellipse');
    assert.deepEqual(sentChanges[0].widget.properties.geometry, {
        x: 250,
        y: 212,
        width: 180,
        height: 96
    });
    assert.equal(panel.pendingWidgetType, '');
    assert.ok(toolbarState.some((state) => state.pendingWidgetType === 'shape:ellipse'));
    assert.ok(toolbarState.some((state) => state.pendingWidgetType === ''));
});

test('interactive controls inside movable widgets keep their click gesture', async () => {
    const { blackboardInteractionMethods } = await import(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-interactions.js')
    );
    const interactiveTarget = {
        closest(selector) {
            if (selector === '[data-context-action="move"]') return null;
            return selector.includes('button') ? this : null;
        }
    };
    let prevented = false;
    const context = {
        isWidgetInteractiveControlEvent: blackboardInteractionMethods.isWidgetInteractiveControlEvent,
        beginGroupDrag() {
            throw new Error('An interactive control must not begin a group drag.');
        }
    };

    blackboardInteractionMethods.beginLocalDrag.call(context, {
        target: interactiveTarget,
        preventDefault() { prevented = true; },
        stopPropagation() {},
    }, {
        id: 'robo_scripta_document',
        type: 'scripta-document',
        groupId: '',
        properties: {geometry: {x: 0, y: 0, width: 600, height: 400}}
    });

    assert.equal(prevented, false);
    assert.equal(context.dragState, undefined);
    assert.equal(
        blackboardInteractionMethods.isWidgetInteractiveControlEvent({
            target: {
                closest(selector) {
                    return selector === '[data-context-action="move"]' ? this : null;
                }
            }
        }),
        false,
        'the explicit Move handle must remain a drag source'
    );
});

test('a board pointer outside the inline editor commits and releases the text draft', async () => {
    const { blackboardInteractionMethods } = await import(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-interactions.js')
    );
    const previousElement = globalThis.Element;
    class MockElement {
        constructor(parent = null) {
            this.parent = parent;
        }
        contains(node) {
            return node === this || node?.parent === this;
        }
        closest() {
            return null;
        }
    }
    globalThis.Element = MockElement;
    try {
        const board = new MockElement();
        const editable = new MockElement();
        const editableChild = new MockElement(editable);
        let blurCalls = 0;
        let commitCalls = 0;
        editable.blur = () => { blurCalls += 1; };
        const context = {
            board,
            activeTool: 'select',
            inlineEditWidgetId: 'text-1',
            inlineEditState: {editable},
            finishInlineTextEdit(commit) {
                commitCalls += Number(commit === true);
                this.inlineEditWidgetId = '';
            },
            beginMarqueeSelection() {},
        };

        blackboardInteractionMethods.handleBoardPointerDownCapture.call(context, {
            button: 0,
            target: editableChild,
        });
        assert.equal(blurCalls, 0);
        assert.equal(commitCalls, 0);

        blackboardInteractionMethods.handleBoardPointerDownCapture.call(context, {
            button: 0,
            target: board,
        });
        assert.equal(blurCalls, 1);
        assert.equal(commitCalls, 1);
    } finally {
        globalThis.Element = previousElement;
    }
});

test('an unselected shape begins selection and drag on the first pointer gesture', async () => {
    const { blackboardInteractionMethods } = await import(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-interactions.js')
    );
    const previousElement = globalThis.Element;
    class MockElement {
        constructor() {
            this.dataset = {widgetId: 'shape-1'};
            this.style = {};
            this.listeners = [];
            this.attributes = new Map();
            this.classList = {contains: (name) => name === 'webmeet-blackboard-widget'};
        }
        closest(selector) {
            return selector === '.webmeet-blackboard-widget' ? this : null;
        }
        setAttribute(name, value) { this.attributes.set(name, value); }
        focus() {}
        setPointerCapture(pointerId) { this.capturedPointerId = pointerId; }
        addEventListener(type) { this.listeners.push(type); }
    }
    globalThis.Element = MockElement;
    try {
        const widget = {id: 'shape-1', type: 'shape', properties: {geometry: {x: 40, y: 60, width: 100, height: 80}}};
        const node = new MockElement();
        let focusEvents = 0;
        let prevented = false;
        const context = {
            board: {contains: () => true},
            blackboard: {widgets: [widget]},
            selection: '',
            selectedWidgetIds: new Set(),
            widgetNodes: new Map([[widget.id, node]]),
            activeTool: 'select',
            adapter: {sendEvent: async () => { focusEvents += 1; }},
            getWidgetById: () => widget,
            isGroupableWidget: () => true,
            clearGroupSelection() {},
            updateToolbarState() {},
            canMoveWidget: () => true,
            isWidgetInteractiveControlEvent: blackboardInteractionMethods.isWidgetInteractiveControlEvent,
            beginLocalDrag(event, selectedWidget) {
                return blackboardInteractionMethods.beginLocalDrag.call(this, event, selectedWidget);
            },
        };
        const event = {
            button: 0,
            pointerId: 17,
            clientX: 120,
            clientY: 140,
            target: node,
            currentTarget: context.board,
            preventDefault() { prevented = true; },
            stopPropagation() {},
        };

        blackboardInteractionMethods.handleBoardPointerDownCapture.call(context, event);

        assert.equal(context.selection, widget.id);
        assert.equal(context.dragState?.widget, widget);
        assert.equal(context.dragState?.node, node);
        assert.equal(node.capturedPointerId, 17);
        assert.deepEqual(node.listeners, ['pointermove', 'pointerup', 'pointercancel']);
        assert.equal(prevented, true);
        assert.equal(focusEvents, 0, 'shared focus must not rerender the node during pointer capture');
    } finally {
        globalThis.Element = previousElement;
    }
});

test('blackboard draws selected shape and line widgets from pointer drag', async () => {
    const { WebMeetBlackboardPanel } = await import(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-panel.js')
    );
    const previousElement = globalThis.Element;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    class MockElement {
        contains() { return true; }
        closest() { return null; }
    }
    globalThis.Element = MockElement;
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    const sentChanges = [];
    const board = new MockElement();
    board.style = { setProperty() {} };
    board.replaceChildren = () => {};
    board.addEventListener = () => {};
    board.removeEventListener = () => {};
    board.setPointerCapture = () => {};
    board.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 480 });
    const element = {
        querySelector(selector) {
            if (selector === '[data-role="board"]') return board;
            if (selector === 'webmeet-blackboard-toolbar') {
                return {
                    setState() {},
                    addEventListener() {},
                    removeEventListener() {}
                };
            }
            return null;
        },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; }
    };
    const panel = new WebMeetBlackboardPanel(element, () => {});
    panel.renderWidgets = () => {};
    panel.connect({
        adapter: {
            subscribe() {
                return () => {};
            },
            async sendChange(change) {
                sentChanges.push(change);
                return {
                    object: change.widget,
                    blackboard: { roomId: 'room_1', version: 2, widgets: [change.widget] }
                };
            }
        },
        blackboard: { roomId: 'room_1', version: 1, widgets: [] }
    });
    try {
        panel.afterRender();
        panel.handleToolbarAddWidgetEvent({ detail: { type: 'shape:rectangle' } });
        panel.handleBoardPointerDownCapture({
            button: 0,
            pointerId: 1,
            target: new MockElement(),
            clientX: 110,
            clientY: 120,
            preventDefault() {},
            stopPropagation() {}
        });
        await panel.finishPendingWidgetDraw({ clientX: 260, clientY: 220 });

        panel.handleToolbarAddWidgetEvent({ detail: { type: 'line:arrow-end' } });
        panel.handleBoardPointerDownCapture({
            button: 0,
            pointerId: 2,
            target: new MockElement(),
            clientX: 300,
            clientY: 320,
            preventDefault() {},
            stopPropagation() {}
        });
        await panel.finishPendingWidgetDraw({ clientX: 180, clientY: 260 });
    } finally {
        if (previousElement === undefined) {
            delete globalThis.Element;
        } else {
            globalThis.Element = previousElement;
        }
        if (previousRequestAnimationFrame === undefined) {
            delete globalThis.requestAnimationFrame;
        } else {
            globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        }
    }

    assert.equal(sentChanges.length, 2);
    assert.deepEqual(sentChanges[0].widget.properties.geometry, {
        x: 100,
        y: 100,
        width: 150,
        height: 100
    });
    assert.equal(sentChanges[1].widget.type, 'line');
    assert.equal(
        Object.hasOwn(sentChanges[1].widget.properties, 'label'),
        false,
        'line and arrow create payloads must not contain the shape-only label property'
    );
    assert.deepEqual(sentChanges[1].widget.properties.geometry, {
        x: 170,
        y: 240,
        width: 120,
        height: 60
    });
    assert.deepEqual({
        x1: sentChanges[1].widget.properties.line.x1,
        y1: sentChanges[1].widget.properties.line.y1,
        x2: sentChanges[1].widget.properties.line.x2,
        y2: sentChanges[1].widget.properties.line.y2,
        markerEnd: sentChanges[1].widget.properties.line.markerEnd
    }, {
        x1: 120,
        y1: 60,
        x2: 0,
        y2: 0,
        markerEnd: 'arrow'
    });
});

test('blackboard opens as the focused item inside the participant video layout', async () => {
    const controllerSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/blackboard-methods.js'),
        'utf8'
    );
    const participantSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/participant-view-methods.js'),
        'utf8'
    );
    const dashboardCss = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.css'),
        'utf8'
    );

    assert.match(controllerSource, /applyBlackboardFocusLayout\(\)/);
    assert.match(controllerSource, /this\.videoGridAll\.prepend\(this\.blackboardSurface\)/);
    assert.match(controllerSource, /this\.videoGridAll\.classList\.add\('has-focus'\)/);
    assert.match(controllerSource, /view\.isMini = true/);
    assert.match(participantSource, /this\.applyBlackboardFocusLayout\?\.\(\)/);
    assert.match(dashboardCss, /\.webmeet-video-all\.has-focus \.webmeet-blackboard-surface\.is-focused/);
    assert.match(dashboardCss, /width: clamp\(240px, calc\(100% - 92px\), 100%\)/);
    assert.match(dashboardCss, /\.webmeet-blackboard-surface webmeet-blackboard-panel[\s\S]*display: flex[\s\S]*overflow: hidden/);
});

test('blackboard widgets support final resize changes for shape line card text image and file', async () => {
    const source = await readBlackboardPanelSource();
    const css = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );

    assert.match(source, /canResizeWidget\(widget\)[\s\S]*\['shape', 'line', 'card', 'text', 'image', 'file', 'poll', 'bullets', 'scripta-document'\]\.includes/);
    assert.match(source, /getWidgetMinimumSize\(widget\)[\s\S]*widget\?\.type === 'file'[\s\S]*minWidth: 160, minHeight: 100[\s\S]*widget\?\.type === 'poll'[\s\S]*widget\?\.type === 'bullets'[\s\S]*widget\?\.type === 'scripta-document'/);
    assert.match(source, /const minimumSize = this\.getWidgetMinimumSize\(widget\)/);
    assert.match(source, /\.\.\.minimumSize/);
    assert.match(source, /const minWidth = Number\(state\.minWidth \|\| 48\)/);
    assert.match(source, /const minHeight = Number\(state\.minHeight \|\| 32\)/);
    assert.match(source, /renderResizeHandles\(node, widget\)/);
    assert.match(source, /data-resize-handle/);
    assert.match(source, /reason: 'resize'/);
    assert.match(source, /\.\.\.geometry/);
    assert.match(source, /event\.target\?\.closest\?\.\('\[data-resize-handle\]'\)/);
    assert.match(css, /\.webmeet-blackboard-resize-handle/);
    assert.match(css, /\.webmeet-blackboard-widget\[aria-selected="true"\] \.webmeet-blackboard-resize-handle/);
    assert.match(css, /\.webmeet-blackboard-widget\.file[\s\S]*min-width: 160px[\s\S]*min-height: 100px/);
    assert.match(source, /const minFileWidth = widget\.type === 'file' \? 160 : 1/);
    assert.match(source, /const minFileHeight = widget\.type === 'file' \? 100 : 1/);
    assert.match(css, /\.webmeet-blackboard-board[\s\S]*overflow: auto/);
    assert.match(css, /\.webmeet-blackboard-board[\s\S]*width: auto[\s\S]*min-width: 0[\s\S]*overflow: auto/);
    assert.match(css, /\.webmeet-blackboard-board[\s\S]*scrollbar-gutter: stable/);
    assert.match(css, /\.webmeet-blackboard-board:empty::before[\s\S]*Start collaborating/);
    assert.match(css, /\.webmeet-blackboard-board:empty::after[\s\S]*Choose a creation tool above/);
    assert.match(css, /background-image: radial-gradient/);
    assert.match(css, /\.webmeet-blackboard-widget[\s\S]*margin: 10px 0 0 10px/);
    assert.match(css, /\.webmeet-blackboard-widget::before[\s\S]*left: 100%[\s\S]*width: 40px[\s\S]*height: max\(100%, 128px\)/);
    assert.match(css, /\.webmeet-blackboard-widget::after[\s\S]*top: 100%[\s\S]*width: calc\(100% \+ 40px\)[\s\S]*height: 10px/);
    assert.match(css, /\.webmeet-blackboard-board[\s\S]*min-height: 0/);
    assert.doesNotMatch(css.match(/\.webmeet-blackboard-board\s*\{[^}]*\}/)?.[0] || '', /height:\s*100%/);
    assert.match(css, /\.webmeet-blackboard-widget\.scripta-document[\s\S]*overflow: visible/);
    assert.match(css, /\.webmeet-blackboard-widget\[aria-selected="true"\][\s\S]*overflow: visible/);
    assert.match(css, /\.webmeet-scripta-document[\s\S]*min-height: 0[\s\S]*overflow: auto/);
    assert.match(css, /\.webmeet-blackboard-widget\.scripta-document[\s\S]*min-width: 600px[\s\S]*min-height: 400px/);
    assert.match(source, /widget\.type === 'scripta-document' \? 600 : 1/);
    assert.match(source, /widget\.type === 'scripta-document' \? 400 : 1/);
    assert.doesNotMatch(source, /node\.style\.width = 'max\(600px, calc\(100% - 48px\)\)'/);
    assert.doesNotMatch(source, /node\.style\.height = 'max\(400px, calc\(100% - 48px\)\)'/);
    assert.match(source, /routeScriptaWheelToBlackboard\(event\)/);
    assert.match(source, /board\.scrollWidth - board\.clientWidth/);
    assert.match(source, /board\.scrollHeight - board\.clientHeight/);
    assert.match(source, /addEventListener\('wheel'[\s\S]*capture: true[\s\S]*passive: false/);
    assert.doesNotMatch(source, /updateBoardScrollExtent/);
    assert.doesNotMatch(source, /webmeet-blackboard-scroll-extent/);
    assert.match(source, /scrollLeft/);
    assert.match(source, /scrollTop/);
});

test('blackboard poll widget renders summary modal and poll settings', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
    );
    const panelSource = await readBlackboardPanelSource();
    const panelCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );
    const editorHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.html'),
        'utf8'
    );
    const editorSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.js'),
        'utf8'
    );
    const pollModalHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-modal/webmeet-blackboard-poll-modal.html'),
        'utf8'
    );
    const pollModalSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-modal/webmeet-blackboard-poll-modal.js'),
        'utf8'
    );
    const pollModalCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-modal/webmeet-blackboard-poll-modal.css'),
        'utf8'
    );
    const pollResultsModalHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-results-modal/webmeet-blackboard-poll-results-modal.html'),
        'utf8'
    );
    const pollResultsModalSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-results-modal/webmeet-blackboard-poll-results-modal.js'),
        'utf8'
    );
    const pollResultsModalCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-results-modal/webmeet-blackboard-poll-results-modal.css'),
        'utf8'
    );
    const pluginConfig = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/config.json'),
        'utf8'
    );

    assert.match(panelSource, /renderPollWidgetContent\(node, widget\)/);
    assert.doesNotMatch(
        panelSource,
        /normalizedType === 'poll'(?:(?!normalizedType === 'bullets')[\s\S])*(?:status:|startedAt:|closesAt:|participantData:|aggregation:)/
    );
    assert.match(panelSource, /void this\.openPollModal\(widget\)/);
    assert.match(panelSource, /void this\.openPollResultsModal\(widget\)/);
    assert.match(panelSource, /webmeet-blackboard-poll-summary subtle-button/);
    assert.match(panelSource, /createPollAdminActions\(widget, statusValue, canManagePoll\)/);
    assert.match(panelSource, /void this\.startPollWidget\(widget\)/);
    assert.match(panelSource, /void this\.closePollWidget\(widget\)/);
    assert.match(panelSource, /resultsButton\.textContent = 'Results'/);
    assert.doesNotMatch(panelSource, /createResultsElement\(\)/);
    assert.doesNotMatch(panelSource, /createParticipantTable\(\)/);
    assert.match(panelCss, /\.webmeet-blackboard-poll-summary/);
    assert.doesNotMatch(panelCss, /\.webmeet-blackboard-poll-results/);
    assert.doesNotMatch(panelCss, /\.webmeet-blackboard-poll-table/);
    assert.doesNotMatch(panelCss, /\.webmeet-blackboard-poll-button/);
    assert.match(pluginConfig, /"component": "webmeet-blackboard-poll-modal"/);
    assert.match(pluginConfig, /"component": "webmeet-blackboard-poll-results-modal"/);
    assert.match(pollModalHtml, /class="modal-header"/);
    assert.match(pollModalHtml, /class="general-button"/);
    assert.match(pollModalHtml, /class="webmeet-blackboard-poll-modal-layout" data-role="questions"/);
    assert.doesNotMatch(pollModalHtml, /data-role="participantsSection"/);
    assert.doesNotMatch(pollModalHtml, /data-role="resultsSection"/);
    assert.match(pollModalSource, /input\.type = 'radio'/);
    assert.match(pollModalSource, /participantName: this\.participantName \|\| this\.participantId/);
    assert.match(pollModalSource, /renderQuestion\(question\)/);
    assert.match(pollModalSource, /options\.className = 'webmeet-blackboard-poll-modal-options'/);
    assert.doesNotMatch(pollModalSource, /if \(total > 0 && count === 0\) continue/);
    assert.doesNotMatch(pollModalSource, /createParticipantTable\(\)/);
    assert.doesNotMatch(pollModalSource, /renderParticipants\(\)/);
    assert.doesNotMatch(panelSource, /Object\.values\(participantData\)/);
    assert.match(pollModalCss, /max-height: min\(72vh, 760px\)/);
    assert.match(pollModalCss, /overflow: auto/);
    assert.match(pollModalCss, /\.webmeet-blackboard-poll-modal-options/);
    assert.doesNotMatch(pollModalCss, /\.webmeet-blackboard-poll-participants-section/);
    assert.match(pollModalCss, /@media \(max-width: 720px\)/);
    assert.match(pollResultsModalHtml, /class="webmeet-blackboard-poll-results-modal"/);
    assert.match(pollResultsModalHtml, /data-role="participantsSection"/);
    assert.match(pollResultsModalSource, /questionRow\.className = 'webmeet-blackboard-poll-question-row'/);
    assert.match(pollResultsModalSource, /if \(total > 0 && count === 0\) continue/);
    assert.match(pollResultsModalSource, /createParticipantTable\(\)/);
    assert.match(pollResultsModalSource, /renderParticipants\(\)/);
    assert.match(pollResultsModalSource, /getParticipantDisplayName\(participantId, entry\)/);
    assert.match(pollResultsModalSource, /Object\.values\(entry\.answers \|\| \{\}\)\.join/);
    assert.match(pollResultsModalCss, /grid-template-columns: minmax\(160px, 0\.52fr\) minmax\(260px, 1fr\)/);
    assert.match(pollResultsModalCss, /\.webmeet-blackboard-poll-participants-section/);
    assert.match(editorHtml, /data-role="questions"/);
    assert.match(editorHtml, /data-role="addQuestion"/);
    assert.match(editorHtml, /data-role="allowPollChange"/);
    assert.match(editorHtml, /data-role="anonymous"/);
    assert.match(editorHtml, /data-role="durationSeconds"/);
    assert.match(editorSource, /patch\.properties\.description = text/);
    assert.match(editorSource, /addPollQuestion\(\)/);
    assert.match(editorSource, /renderPollQuestionInputs\(questions/);
    assert.match(editorSource, /data-role="questionPollMode"/);
    assert.match(editorSource, /data-role="questionOptions"/);
    assert.match(editorSource, /data-role="questionRatingMax"/);
    assert.match(editorSource, /patch\.properties\.questions = questions\.map/);
    assert.match(editorSource, /patch\.properties\.allowPollChange = this\.allowPollChangeInput\?\.checked === true/);
    assert.match(editorSource, /patch\.properties\.anonymous = this\.anonymousInput\?\.checked === true/);
    assert.match(editorSource, /patch\.properties\.durationSeconds/);
    assert.match(panelSource, /renderBulletsWidgetContent\(node, widget\)/);
    assert.doesNotMatch(panelSource, /normalizedType === 'bullets'[\s\S]{0,500}meetingDateTime:/);
    assert.match(panelSource, /props\.meetingDateTime \|\| widget\.createdAt/);
    assert.match(panelSource, /createBulletsItemRow\(item\)/);
    assert.match(panelSource, /if \(!isFullscreen && !widget\.groupId && !multiSelected\) this\.renderContextMenu\(node, widget\)/);
    assert.match(panelSource, /toggleBulletsFullscreen\(widget\.id\)/);
    assert.match(panelSource, /webmeet-blackboard-bullets-fullscreen-button/);
    assert.match(panelSource, /fullscreenIcon\.src = '\/explorer\/shared\/assets\/icons\/fullscreen\.svg'/);
    assert.match(panelSource, /editButton\.textContent = 'Edit'/);
    assert.doesNotMatch(panelSource, /View Full Notes/);
    assert.match(panelCss, /\.webmeet-blackboard-bullets-list[\s\S]*overflow: auto/);
    assert.match(panelCss, /\.webmeet-blackboard-bullets-fullscreen-button/);
    assert.match(panelCss, /\.webmeet-blackboard-widget\.bullets\.is-fullscreen/);
    assert.match(panelCss, /\.webmeet-blackboard-widget\.bullets/);
    assert.match(panelCss, /\.webmeet-blackboard-bullets-priority\.priority-high/);
    assert.match(panelCss, /\.webmeet-blackboard-bullets-item\.status-blocked/);
    assert.match(editorHtml, /data-role="bulletsSection"/);
    assert.match(editorHtml, /data-role="bulletsTitle"/);
    assert.doesNotMatch(editorHtml, /data-role="bulletsDateTime"/);
    assert.doesNotMatch(editorHtml, />Date \/ Time</);
    assert.doesNotMatch(editorHtml, /data-role="bulletsParticipantCount"/);
    assert.doesNotMatch(editorHtml, />Participants</);
    assert.match(editorHtml, /data-role="bulletsItems"/);
    assert.match(editorSource, /renderBulletsItemInputs\(items/);
    assert.match(editorSource, /patch\.properties\.items = this\.readBulletsItemsFromForm/);
});

test('blackboard supports image upload widgets', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
    );
    const panelSource = await readBlackboardPanelSource();
    const panelCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );
    const toolbarHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.html'),
        'utf8'
    );
    const toolbarSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.js'),
        'utf8'
    );
    assert.match(toolbarHtml, /data-local-action="uploadImageWidget"/);
    assert.match(toolbarHtml, /accept="image\/\*"/);
    assert.match(toolbarSource, /blackboard-image-upload/);
    assert.match(panelSource, /addImageWidgetFromFile\(file\)/);
    assert.match(panelSource, /createWidget\('image'\)/);
    assert.match(panelSource, /widget\.type === 'image'/);
    assert.match(panelSource, /className = 'webmeet-blackboard-image-frame'/);
    assert.match(panelSource, /className = 'webmeet-blackboard-image'/);
    assert.match(panelSource, /\['shape', 'line', 'card', 'text', 'image', 'file', 'poll', 'bullets', 'scripta-document'\]\.includes/);
    assert.match(panelCss, /\.webmeet-blackboard-image-frame/);
    assert.match(panelCss, /\.webmeet-blackboard-image-frame[\s\S]*border: var\(--stroke-width/);
});

test('blackboard Insert menu opens SCRIPTA create/open through RoboTeam events', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
    );
    const panelSource = await readBlackboardPanelSource();
    const panelCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );
    const panelHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.html'),
        'utf8'
    );
    const scriptaRenderingSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-scripta-rendering.js'),
        'utf8'
    );
    const toolbarHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.html'),
        'utf8'
    );
    const toolbarSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.js'),
        'utf8'
    );
    const modalSource = await fs.readFile(
        path.join(componentDir, 'webmeet-scripta-document-modal/webmeet-scripta-document-modal.js'),
        'utf8'
    );
    const modalHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-scripta-document-modal/webmeet-scripta-document-modal.html'),
        'utf8'
    );
    const modalCss = await fs.readFile(
        path.join(componentDir, 'webmeet-scripta-document-modal/webmeet-scripta-document-modal.css'),
        'utf8'
    );
    const pluginConfig = JSON.parse(await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/config.json'),
        'utf8'
    ));

    assert.match(toolbarHtml, /data-local-action="toggleScriptaDocumentMenu"/);
    assert.match(toolbarHtml, /data-local-action="runScriptaMenuAction create"/);
    assert.match(toolbarHtml, /data-local-action="toggleScriptaOpenMenu"/);
    assert.match(toolbarHtml, />SCRIPTA Document</);
    assert.match(toolbarSource, /blackboard-scripta-document/);
    assert.match(toolbarSource, /defaultDocuments/);
    assert.match(toolbarSource, /open-other/);
    assert.match(panelSource, /handleScriptaToolbarAction/);
    assert.match(panelSource, /runScriptaEvent\('scripta-document-create'/);
    assert.match(panelSource, /runScriptaEvent\('scripta-document-open'/);
    assert.doesNotMatch(modalSource, /manage/);
    assert.match(modalSource, /filter\(\(documentPath\) => documentPath && \/\\\.md\$\/i\.test\(documentPath\)\)/);
    assert.match(modalSource, /template === 'vision' \|\| template === 'plan'/);
    assert.match(modalSource, /this\.documents\.includes\(path\)/);
    assert.match(modalHtml, /type="search" data-role="pathSearch"/);
    assert.match(modalHtml, /data-role="pathStatus"/);
    assert.match(modalHtml, /Used only to generate a Vision or Plan document\./);
    assert.match(modalCss, /\.webmeet-scripta-document-modal \[hidden\][\s\S]*display: none !important/);
    assert.doesNotMatch(toolbarHtml, /addWidget scripta-document/);
    assert.doesNotMatch(panelSource, /scripta-document-detach/);
    assert.doesNotMatch(panelSource, /Delete document file/);
    assert.doesNotMatch(panelSource, /runScriptaEvent\('scripta-document-delete'/);
    assert.match(panelSource, /canDeleteWidget\(widget\)[\s\S]*widget\.type === 'scripta-document'/);
    assert.match(panelSource, /createContextButton\('delete', 'Delete widget', 'Delete', 'delete'\)/);
    assert.match(panelHtml, /data-template="scripta-document"[\s\S]*class="webmeet-scripta-document-header"[\s\S]*class="webmeet-scripta-document-title"[\s\S]*data-local-action="runScriptaLocalAction scripta-chapter-add"[\s\S]*class="webmeet-scripta-header-action-label">Chapter</);
    assert.doesNotMatch(panelSource, /createScriptaButton\('Add chapter'/);
    assert.match(panelCss, /\.webmeet-blackboard-context-button\.webmeet-scripta-header-action\s*\{[\s\S]*width:\s*auto;[\s\S]*height:\s*28px;[\s\S]*border-color:\s*var\(--bb-widget-border\);[\s\S]*background:\s*var\(--bb-context-bg\);[\s\S]*white-space:\s*nowrap;/);
    assert.deepEqual(
        pluginConfig.dependencies.find((entry) => entry.component === 'scripta-variants-view'),
        {
            component: 'scripta-variants-view',
            presenter: 'ScriptaVariantsView',
            baseUrl: '/explorer/shared/ui/scripta-variants-view/scripta-variants-view'
        }
    );
    assert.match(panelHtml, /<scripta-variants-view data-presenter="scripta-variants-view"/);
    assert.match(scriptaRenderingSource, /node\.textContent = text/);
    assert.match(scriptaRenderingSource, /document\.createTextNode\(paragraphText\.slice\(cursor, media\.position\)\)/);
    assert.match(scriptaRenderingSource, /document\.createTextNode\(paragraphText\.slice\(cursor\)\)/);
    assert.doesNotMatch(scriptaRenderingSource, /\.innerHTML\s*=/);
    assert.match(panelSource, /await customElements\.whenDefined\('scripta-variants-view'\)/);
    assert.match(panelSource, /customElements\.upgrade\(variantsView\)/);
    assert.match(panelSource, /await variantsView\.presenterReadyPromise/);
    assert.match(panelSource, /this\.busy = false;\s*this\.renderWidgets\(\)/);
    assert.doesNotMatch(panelSource, /← Back to document/);
    assert.match(panelHtml, /class="webmeet-scripta-nav-button is-back"[\s\S]*data-local-action="runScriptaLocalAction scripta-document-view"/);
    assert.match(panelHtml, /class="webmeet-scripta-paragraph-pager"/);
    assert.match(panelHtml, /class="webmeet-scripta-paragraph-pager-label">Paragraph</);
    assert.match(panelHtml, /class="webmeet-scripta-paragraph-pager-controls"/);
    assert.match(panelHtml, /class="webmeet-scripta-context-title" data-role="chapter-title"/);
    assert.match(panelHtml, /class="webmeet-scripta-document-position webmeet-scripta-context-meta"[\s\S]*data-role="document-position"/);
    assert.match(panelSource, /documentPosition\.textContent = `Chapter \$\{paragraph\.chapterOrdinal \|\| 1\} - Paragraph \$\{paragraph\.paragraphOrdinal \|\| 1\}`/);
    assert.doesNotMatch(panelHtml, /data-role="chapter-ordinal"/);
    assert.doesNotMatch(panelHtml, /data-role="paragraph-ordinal"/);
    assert.match(panelCss, /\.webmeet-scripta-document-position\s*\{[\s\S]*left:\s*50%;[\s\S]*translate\(-50%, -50%\)/);
    const contextMetaCss = panelCss.match(/\.webmeet-scripta-context-meta\s*\{[^}]*\}/)?.[0] || '';
    assert.match(contextMetaCss, /color:\s*color-mix\(in srgb, var\(--bb-widget-text\) 44%, transparent\)/);
    assert.match(contextMetaCss, /font-family:\s*ui-monospace/);
    assert.match(contextMetaCss, /font-size:\s*9px/);
    assert.doesNotMatch(contextMetaCss, /(?:background|border|border-radius|padding|min-height):/);
    assert.match(panelHtml, /data-local-action="runScriptaLocalAction scripta-paragraph-previous"[\s\S]*<span class="webmeet-scripta-nav-label">Prev</);
    assert.match(panelHtml, /data-local-action="runScriptaLocalAction scripta-paragraph-next"[\s\S]*<span class="webmeet-scripta-nav-label">Next</);
    assert.match(panelSource, /scripta-paragraph-previous"\]'\)\.disabled = paragraphIndex <= 0/);
    assert.match(panelSource, /scripta-paragraph-next"\]'\)\.disabled = \(\s*paragraphIndex < 0 \|\| paragraphIndex >= paragraphOrder\.length - 1/);
    assert.match(panelCss, /\.webmeet-scripta-paragraph-pager\s*\{[\s\S]*flex-direction:\s*column/);
    assert.match(panelCss, /\.webmeet-scripta-paragraph-pager-label\s*\{[\s\S]*font-size:\s*14px/);
    assert.match(panelCss, /\.webmeet-scripta-paragraph-pager-controls\s*\{[\s\S]*display:\s*inline-flex/);
    assert.match(panelCss, /\.webmeet-scripta-nav-icon\.is-back::after/);
    assert.match(panelCss, /\.webmeet-scripta-nav-button\.is-back\s*\{\s*border-radius:\s*6px;\s*\}/);
    assert.doesNotMatch(panelCss, /\.webmeet-scripta-nav-button\.is-back\s*\{[^}]*background:\s*transparent/);
    assert.match(panelSource, /Empty paragraph — select to add text\./);
    assert.doesNotMatch(panelSource, /Paragraph title/);
    assert.match(panelHtml, /class="webmeet-scripta-paragraph-open"[\s\S]*<p data-role="paragraph-text"><\/p>/);
    assert.doesNotMatch(panelSource, /createScriptaButton\('Edit'/);
    assert.doesNotMatch(panelSource, /createScriptaButton\('Rename'/);
    assert.doesNotMatch(panelSource, /title\.contentEditable/);
    assert.match(panelHtml, /data-role="chapter-title-input"/);
    assert.match(panelHtml, /data-local-action="openScriptaChapterTitleEditor"/);
    assert.match(panelHtml, /data-local-action="cancelScriptaChapterTitleEditor"[\s\S]*data-role="chapter-title-cancel">Cancel/);
    assert.match(panelHtml, /data-local-action="saveScriptaChapterTitleEditor"[\s\S]*data-role="chapter-title-save">Save/);
    assert.match(panelSource, /this\.openScriptaChapterTitleEditor\(title\)/);
    assert.match(panelSource, /this\.cancelScriptaChapterTitleEditor\(input\)/);
    assert.match(panelSource, /this\.saveScriptaChapterTitleEditor\(input\)/);
    assert.match(panelSource, /runScriptaEvent\('scripta-chapter-edit'/);
    assert.match(panelHtml, /runScriptaLocalAction scripta-chapter-add/);
    assert.match(panelHtml, /data-local-action="runScriptaLocalAction scripta-paragraph-move"\s*data-move-direction="up"/);
    assert.match(panelHtml, /data-local-action="runScriptaLocalAction scripta-paragraph-move"\s*data-move-direction="down"/);
    assert.match(panelSource, /payload\.targetIndex = moveDirection === 'up' \? ordinal - 1 : ordinal \+ 1/);
    assert.match(panelSource, /payload\.targetChapterId = chapterId/);
    assert.doesNotMatch(panelSource, /payload\.targetChapterOrdinal = Number\(chapterOrdinal\)/);
    assert.doesNotMatch(panelSource, /Target chapter number/);
    assert.match(panelCss, /\.webmeet-scripta-paragraph-actions/);
    assert.match(panelCss, /\.webmeet-scripta-chapter-actions,\s*\.webmeet-scripta-paragraph-actions\s*\{[\s\S]*position:\s*absolute[\s\S]*top:\s*6px[\s\S]*right:\s*6px/);
    assert.match(panelCss, /\.webmeet-scripta-document-paragraph\s*\{[\s\S]*position:\s*relative[\s\S]*display:\s*block/);
    assert.match(panelCss, /\.webmeet-scripta-paragraph-open\s*\{[\s\S]*width:\s*100%/);
    assert.match(panelHtml, /title="Move paragraph up"[\s\S]*aria-label="Move paragraph up"[\s\S]*webmeet-blackboard-context-icon reorder-up/);
    assert.match(panelHtml, /title="Move paragraph down"[\s\S]*aria-label="Move paragraph down"[\s\S]*webmeet-blackboard-context-icon reorder-down/);
    assert.match(panelHtml, /data-local-action="runScriptaLocalAction scripta-paragraph-add"/);
    assert.match(panelHtml, /class="webmeet-scripta-inline-action-label">Paragraph<\/span>[\s\S]*webmeet-blackboard-context-icon plus/);
    assert.match(panelHtml, /class="webmeet-scripta-reorder-group"[^>]*aria-label="Reorder chapter"[\s\S]*class="webmeet-scripta-reorder-controls"/);
    assert.doesNotMatch(panelHtml, /webmeet-scripta-reorder-label/);
    assert.match(panelHtml, /webmeet-blackboard-context-icon reorder-up/);
    assert.match(panelHtml, /webmeet-blackboard-context-icon reorder-down/);
    assert.match(panelHtml, /title="Move chapter up"[\s\S]*aria-label="Move chapter up"/);
    assert.match(panelHtml, /title="Move chapter down"[\s\S]*aria-label="Move chapter down"/);
    assert.match(panelCss, /\.webmeet-scripta-chapter-actions \.webmeet-scripta-labeled-action\s*\{[\s\S]*width:\s*auto/);
    assert.match(panelCss, /\.webmeet-scripta-reorder-group\s*\{[\s\S]*display:\s*inline-flex/);
    assert.match(panelCss, /icons\/reorder-up\.svg/);
    assert.match(panelCss, /icons\/reorder-down\.svg/);
    assert.match(panelHtml, /data-local-action="runScriptaLocalAction scripta-chapter-move"\s*data-move-direction="up"/);
    assert.match(panelHtml, /data-local-action="runScriptaLocalAction scripta-chapter-move"\s*data-move-direction="down"/);
    assert.doesNotMatch(panelSource, /New chapter position/);
    assert.match(panelCss, /\.webmeet-scripta-chapter-actions/);
    assert.match(panelCss, /\.webmeet-blackboard-context-icon\.plus/);
    assert.doesNotMatch(panelCss, /\.webmeet-blackboard-context-icon\.chapter-add/);
    assert.match(panelSource, /scripta-p-variant-add'[\s\S]*chapterId: paragraph\.chapterId[\s\S]*paragraphId: paragraph\.paragraphId/);
    assert.match(panelSource, /scripta-p-variant-select'[\s\S]*chapterId: paragraph\.chapterId[\s\S]*paragraphId: paragraph\.paragraphId[\s\S]*variantId: event\.detail\?\.variantId/);
    assert.match(panelSource, /scripta-p-variant-edit-start/);
    assert.match(panelSource, /scripta-p-variant-edit-draft/);
    assert.match(panelSource, /scripta-p-variant-edit-cancel/);
    assert.match(panelSource, /scripta-p-variant-vote'[\s\S]*chapterId: paragraph\.chapterId[\s\S]*paragraphId: paragraph\.paragraphId/);
    assert.match(panelSource, /scripta-p-variant-delete'[\s\S]*chapterId: paragraph\.chapterId[\s\S]*paragraphId: paragraph\.paragraphId/);
    assert.doesNotMatch(panelSource, /className = 'webmeet-scripta-variant'/);
    assert.match(panelSource, /if \(!this\.adapter\?\.sendEvent \|\| this\.busy\) return null/);
    assert.match(panelSource, /assistOS\?\.showToast\?\.\(message, 'error'/);
});

test('blackboard supports shape variants angled lines and arrows', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
    );
    const panelSource = await readBlackboardPanelSource();
    const panelCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );
    const toolbarHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.html'),
        'utf8'
    );
    const editorSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.js'),
        'utf8'
    );
    const editorHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.html'),
        'utf8'
    );

    assert.match(toolbarHtml, /data-local-action="addWidget shape:ellipse"/);
    assert.match(toolbarHtml, /data-local-action="addWidget shape:diamond"/);
    assert.match(toolbarHtml, /data-local-action="addWidget line:arrow-end"/);
    assert.match(toolbarHtml, /data-local-action="addWidget line:arrow-both"/);
    assert.match(toolbarHtml, /data-local-action="addWidget bullets"/);
    assert.doesNotMatch(toolbarHtml, /data-widget-type=/);
    assert.match(panelSource, /createShapeSvg\(widget\)/);
    assert.match(panelSource, /shapeKind === 'triangle'/);
    assert.match(panelSource, /createLineSvg\(widget\)/);
    assert.match(panelSource, /webmeet-blackboard-line-hit-target/);
    assert.match(panelSource, /Math\.max\(12, strokeWidth\)/);
    assert.match(panelSource, /marker-end/);
    assert.match(panelSource, /marker-start/);
    assert.match(panelSource, /widget\.properties\.line = \{/);
    assert.match(panelSource, /nextProperties\.line = \{/);
    assert.match(panelSource, /getLineAngle\(line = \{\}\)/);
    assert.match(panelSource, /getLineEndpoints\(width, height, angle\)/);
    assert.match(panelSource, /angle,\s*\.\.\.this\.getLineEndpoints\(220, 80, angle\)/);
    assert.match(panelSource, /dataResizeHandle = handle\.name|dataset\.resizeHandle = handle\.name/);
    assert.match(panelSource, /line-start/);
    assert.match(panelSource, /line-end/);
    assert.match(panelSource, /getLineEndpointResize\(state, event, movingPointOverride = null\)/);
    assert.match(panelSource, /findConnectionAnchorAtEvent/);
    assert.match(panelSource, /movingEndpoint: handle === 'line-start' \? 'start' : 'end'/);
    assert.match(panelSource, /canRotateWidget\(widget\)[\s\S]*\['shape', 'line', 'text', 'image'\]\.includes/);
    assert.match(panelSource, /if \(widget\.type !== 'file' && this\.canEditWidget\(widget\)\)/);
    assert.match(panelSource, /appendFileContextDownload\(menu, widget\)/);
    assert.match(panelSource, /widget\?\.type !== 'file'[\s\S]*file-context-download[\s\S]*data-local-action="downloadBlackboardFile"/);
    assert.match(panelCss, /\.webmeet-blackboard-line-svg/);
    assert.match(panelCss, /\.webmeet-blackboard-widget\.line[\s\S]*pointer-events: none/);
    assert.match(panelCss, /\.webmeet-blackboard-line-hit-target[\s\S]*pointer-events: stroke/);
    assert.match(panelCss, /\.webmeet-blackboard-resize-handle\.line-endpoint/);
    assert.doesNotMatch(editorHtml, /data-role="shapeKind"/);
    assert.match(editorHtml, /data-role="lineMarker"/);
    assert.match(editorHtml, /data-role="strokeWidth"/);
    assert.match(editorHtml, /data-role="textColor"/);
    assert.match(editorHtml, /data-role="textSection"/);
    assert.match(editorHtml, /data-role="typographySection"/);
    assert.match(editorHtml, /data-role="fontFamily"/);
    assert.match(editorHtml, /data-role="fontSize"/);
    assert.match(editorHtml, /data-role="textStyleColor"/);
    assert.match(editorHtml, /data-role="fontBold"/);
    assert.match(editorHtml, /data-role="fontItalic"/);
    assert.match(editorHtml, /data-role="choiceSection"/);
    assert.match(editorHtml, /data-role="surfaceSection"/);
    assert.doesNotMatch(toolbarHtml, /webmeet-blackboard-text-toolbar/);
    assert.doesNotMatch(toolbarHtml, /data-text-style/);
    assert.doesNotMatch(editorHtml, /data-role="lineAngle"/);
    assert.doesNotMatch(editorSource, /patch\.properties\.shapeKind/);
    assert.match(editorSource, /SURFACE_WIDGET_TYPES/);
    assert.match(editorSource, /TEXT_COLOR_WIDGET_TYPES/);
    assert.match(panelSource, /'theme-json': encodeURIComponent\(JSON\.stringify\(this\.getBlackboardTheme\(\)\)\)/);
    assert.match(editorSource, /readJsonAttribute\(element, 'data-theme-json'\)/);
    assert.match(editorSource, /delete style\[property\]/);
    assert.match(editorSource, /sameColor\(normalizedValue, normalizedDefault\)/);
    assert.match(editorSource, /style\.fontFamily/);
    assert.match(editorSource, /style\.fontSize/);
    assert.match(editorSource, /style\.fontWeight/);
    assert.match(editorSource, /style\.fontStyle/);
    assert.match(editorHtml, /data-role="fillTransparent"/);
    assert.match(editorSource, /style\.fill = 'transparent'/);
    assert.match(editorSource, /this\.setThemedStyleValue\(style, 'fill', this\.fillInput\?\.value, typeDefaults\.fill\)/);
    assert.match(editorSource, /patch\.properties\.line/);
    assert.match(editorSource, /strokeWidth/);
    assert.match(panelCss, /border: var\(--stroke-width/);
    assert.match(panelCss, /background: var\(--fill/);
    assert.doesNotMatch(editorSource, /lineAngleInput/);
});

test('blackboard toolbar uses themes instead of manual board background controls', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
    );
    const panelSource = await readBlackboardPanelSource();
    const toolbarSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.js'),
        'utf8'
    );
    const toolbarHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.html'),
        'utf8'
    );
    const panelCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );

    assert.doesNotMatch(toolbarHtml, /data-background-color/);
    assert.doesNotMatch(toolbarSource, /blackboard-background/);
    assert.doesNotMatch(toolbarHtml, /data-local-action="setTool select"/);
    assert.doesNotMatch(toolbarHtml, /data-local-action="runToolbarAction delete"/);
    assert.doesNotMatch(toolbarHtml, /data-action=/);
    assert.doesNotMatch(toolbarSource, /setTool\(_target, tool = 'select'\)/);
    assert.match(toolbarSource, /addWidget\(_target, type = 'shape'\)/);
    assert.match(toolbarSource, /runToolbarAction\(_target, action = ''\)/);
    assert.match(toolbarSource, /constructor\(element, invalidate\)/);
    assert.doesNotMatch(toolbarSource, /registerAction/);
    assert.doesNotMatch(toolbarSource, /addEventListener\('click'/);
    assert.doesNotMatch(toolbarSource, /handleToolbarClick/);
    assert.doesNotMatch(panelSource, /setBlackboardBackground\(background = \{\}\)/);
    assert.match(panelSource, /targetType: 'blackboard'/);
    assert.doesNotMatch(panelSource, /metadata: \{[\s\S]*background:/);
    assert.match(panelSource, /applyBoardBackground\(\)/);
    assert.doesNotMatch(panelCss, /--blackboard-background-color/);
});

test('blackboard toolbar groups controls by CRAP visual hierarchy', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
    );
    const toolbarHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.html'),
        'utf8'
    );
    const toolbarCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.css'),
        'utf8'
    );
    const dashboardCss = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.css'),
        'utf8'
    );

    for (const label of ['Create', 'Collaborate', 'History', 'Appearance']) {
        assert.match(toolbarHtml, new RegExp(`webmeet-blackboard-tool-group[^>]+aria-label="${label}"`));
    }
    assert.doesNotMatch(toolbarHtml, /webmeet-blackboard-tool-group-label/);
    assert.match(toolbarCss, /\.webmeet-blackboard-tool-group \+ \.webmeet-blackboard-tool-group::before[\s\S]*width: 1px[\s\S]*height: 22px/);
    const groupRule = toolbarCss.match(/\.webmeet-blackboard-tool-group\s*\{[^}]*\}/)?.[0] || '';
    assert.doesNotMatch(groupRule, /border:|background:|box-shadow:/);
    assert.match(toolbarCss, /\.webmeet-blackboard-appearance-group[\s\S]*margin-left: auto/);
    assert.match(toolbarCss, /\.webmeet-blackboard-tool-button:hover/);
    assert.match(dashboardCss, /\.webmeet-blackboard-header > span:first-child::before/);
});

test('blackboard exposes Leadership theme extracted from the provided palette', () => {
    const options = getBlackboardThemeOptions();
    const theme = getBlackboardTheme('leadership');

    assert.ok(options.some((option) => option.id === 'leadership' && option.label === 'Leadership'));
    assert.equal(theme.tokens.boardBackground, '#f4f2f1');
    assert.equal(theme.tokens.panelBackground, '#e2dedd');
    assert.equal(theme.tokens.boardGridColor, '#d8d6d5');
    assert.equal(theme.tokens.widgetBorder, '#5d9cac');
    assert.equal(theme.tokens.selectionColor, '#6276b7');
    assert.equal(theme.defaults.shape.fill, '#d7eef0');
    assert.equal(theme.defaults.shape.stroke, '#5d9cac');
    assert.equal(theme.defaults.line.stroke, '#6276b7');
    assert.equal(theme.defaults.text.fill, 'transparent');
    assert.equal(theme.defaults.text.stroke, '#91c9c8');
    assert.equal(theme.defaults.text.textColor, '#315f86');
});

test('blackboard text widget theme defaults are transparent in every theme', () => {
    for (const option of getBlackboardThemeOptions()) {
        const theme = getBlackboardTheme(option.id);
        assert.equal(theme.defaults.text.fill, 'transparent', `${option.id} text fill`);
    }
    assert.equal(getBlackboardTheme('slate').defaults.text.textColor, '#e0f2fe');
    assert.equal(getBlackboardTheme('slate').tokens.panelText, '#e0f2fe');
    assert.equal(getBlackboardTheme('slate').tokens.widgetText, '#111827');
    assert.equal(getBlackboardTheme('contrast').tokens.widgetText, '#000000');
    assert.equal(getBlackboardTheme('contrast').defaults.text.textColor, '#ffffff');
});

test('blackboard line widget defaults are one pixel in every theme', () => {
    for (const option of getBlackboardThemeOptions()) {
        const theme = getBlackboardTheme(option.id);
        assert.equal(theme.defaults.line.strokeWidth, 1, `${option.id} line strokeWidth`);
    }
});

test('blackboard image widget defaults are transparent and borderless in every theme', () => {
    for (const option of getBlackboardThemeOptions()) {
        const theme = getBlackboardTheme(option.id);
        assert.equal(theme.defaults.image.fill, 'transparent', `${option.id} image fill`);
        assert.equal(theme.defaults.image.strokeWidth, 0, `${option.id} image strokeWidth`);
        assert.match(theme.defaults.image.stroke, /^#[0-9a-f]{6}$/i, `${option.id} image stroke`);
    }
});

test('blackboard widgets rely on theme defaults until a style is explicitly set', async () => {
    const source = await readBlackboardPanelSource();

    assert.match(source, /properties: \{\s*geometry: baseGeometry,\s*style: \{\}\s*\}/);
    assert.doesNotMatch(source, /fill: shapeDefaults\.fill/);
    assert.doesNotMatch(source, /stroke: shapeDefaults\.stroke/);
    assert.doesNotMatch(source, /stroke: lineDefaults\.stroke/);
    assert.doesNotMatch(source, /textColor: textDefaults\.textColor/);
    assert.match(source, /normalizedType === 'text'[\s\S]*fill: 'transparent'/);
    assert.match(source, /style\.fill \|\| typeDefaults\.fill/);
    assert.match(source, /style\.stroke \|\| typeDefaults\.stroke/);
    assert.match(source, /node\.style\.setProperty\('--stroke-width', `\$\{cssStrokeWidth\}px`\)/);
    assert.match(source, /widget\.type === 'text'[\s\S]*textDefaults\.textColor[\s\S]*typeDefaults\.textColor \|\| themeTokens\.widgetText/);
    assert.match(source, /node\.style\.setProperty\('--text-color', style\.textColor \|\| defaultTextColor/);
    assert.match(source, /resetThemeStyles: true/);
});

test('blackboard components are declared in WebMeet registries', async () => {
    const config = JSON.parse(await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/config.json'),
        'utf8'
    ));
    const roomLoader = await fs.readFile(
        path.resolve(import.meta.dirname, '../../static-files/roomLoader.js'),
        'utf8'
    );
    const dependencyNames = new Set((config.dependencies || []).map((entry) => entry.component));
    assert.match(roomLoader, /PLUGIN_CONFIG_URL/);
    assert.match(roomLoader, /loadComponentDefinitions/);
    assert.doesNotMatch(roomLoader, /const componentDefinitions = \[/);
    for (const componentName of [
        'webmeet-blackboard-panel',
        'webmeet-blackboard-toolbar',
        'webmeet-blackboard-widget-editor',
        'webmeet-blackboard-results-panel'
    ]) {
        const dependency = (config.dependencies || []).find((entry) => entry.component === componentName);
        assert.ok(dependencyNames.has(componentName), `${componentName} missing from plugin config dependencies`);
        assert.ok(dependency?.path, `${componentName} must declare its nested component path`);
        for (const extension of ['html', 'css', 'js']) {
            const assetPath = path.resolve(import.meta.dirname, `../../IDE-plugins/webmeet-tool-button/${dependency.path}.${extension}`);
            await fs.access(assetPath);
        }
    }
    const widgetEditor = (config.dependencies || []).find((entry) => entry.component === 'webmeet-blackboard-widget-editor');
    assert.equal(widgetEditor?.type, 'modal');
});

test('blackboard panel is a static WebSkel child driven through DOM events', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/blackboard-methods.js'),
        'utf8'
    );
    const panelSource = await readBlackboardPanelSource();
    const parentSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'),
        'utf8'
    );
    const dashboardHtml = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.html'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'),
        'utf8'
    );

    assert.match(dashboardHtml, /<webmeet-blackboard-panel\s+data-presenter="webmeet-blackboard-panel"><\/webmeet-blackboard-panel>/);
    assert.doesNotMatch(source, /webSkel\.createElement/);
    assert.doesNotMatch(source, /waitForBlackboardPanelReady/);
    assert.doesNotMatch(source, /ensureBlackboardPanel/);
    assert.doesNotMatch(source, /ensureBlackboardComponentsRegistered/);
    assert.doesNotMatch(source, /requestAnimationFrame/);
    assert.doesNotMatch(source, /\.configure\(/);
    assert.doesNotMatch(parentSource, /ensureComponentRegistered\('webmeet-blackboard-toolbar'\)/);
    assert.doesNotMatch(parentSource, /ensureComponentRegistered\('webmeet-blackboard-widget-editor'\)/);
    assert.doesNotMatch(parentSource, /ensureComponentRegistered\('webmeet-blackboard-results-panel'\)/);
    assert.doesNotMatch(parentSource, /ensureComponentRegistered\('webmeet-blackboard-panel'\)/);
    assert.match(dashboardSource, /void ensureAvatarSettingsFormRegistered\(\)/);
    assert.match(dashboardSource, /async beforeRender\(\)[\s\S]*prepareInitialRouteState/);
    assert.doesNotMatch(dashboardSource, /await this\.bootstrap\(\)/);
    assert.match(source, /webmeet-blackboard-connect/);
    assert.match(source, /webmeet-blackboard-update/);
    assert.match(source, /webmeet-blackboard-disconnect/);
    assert.match(panelSource, /handleToolbarAddWidgetEvent/);
    assert.match(panelSource, /removeEventListener\('blackboard-add-widget', this\.handleToolbarAddWidgetEvent\)/);
    assert.doesNotMatch(panelSource, /connectBlackboard/);
    assert.match(panelSource, /addEventListener\('webmeet-blackboard-connect'/);
    assert.match(panelSource, /addEventListener\('webmeet-blackboard-update'/);
    assert.match(panelSource, /addEventListener\('webmeet-blackboard-disconnect'/);
    assert.doesNotMatch(source, /this\.blackboardSurface\?\.querySelector\('webmeet-blackboard-panel'\)/);
    assert.match(source, /const panel = this\.blackboardPanel/);
});

test('blackboard rendering is split by responsibility and uses WebSkel SCRIPTA templates safely', async () => {
    const panelDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel'
    );
    const [panel, panelHtml, generic, scriptaActions, scriptaRendering, collaboration, graphics] = await Promise.all([
        fs.readFile(path.join(panelDir, 'webmeet-blackboard-panel.js'), 'utf8'),
        fs.readFile(path.join(panelDir, 'webmeet-blackboard-panel.html'), 'utf8'),
        fs.readFile(path.join(panelDir, 'webmeet-blackboard-rendering.js'), 'utf8'),
        fs.readFile(path.join(panelDir, 'webmeet-blackboard-scripta-actions.js'), 'utf8'),
        fs.readFile(path.join(panelDir, 'webmeet-blackboard-scripta-rendering.js'), 'utf8'),
        fs.readFile(path.join(panelDir, 'webmeet-blackboard-collaboration-rendering.js'), 'utf8'),
        fs.readFile(path.join(panelDir, 'webmeet-blackboard-graphics-rendering.js'), 'utf8'),
    ]);

    assert.ok(generic.split('\n').length < 350);
    assert.match(panel, /blackboardGraphicsRenderingMethods/);
    assert.match(panel, /blackboardCollaborationRenderingMethods/);
    assert.match(panel, /blackboardScriptaActionMethods/);
    assert.match(panel, /blackboardScriptaRenderingMethods/);
    assert.match(scriptaActions, /runScriptaEvent/);
    assert.match(scriptaActions, /runScriptaLocalAction\(\s*target,\s*action = '',\s*encodedChapterId/);
    assert.match(scriptaRendering, /cloneScriptaTemplate\(name\)/);
    assert.match(scriptaRendering, /focusScriptaDocumentTarget\(node, props\)/);
    assert.match(scriptaRendering, /scrollIntoView\(\{block: 'nearest', inline: 'nearest'\}\)/);
    assert.match(scriptaRendering, /focusTarget\?\.focus\?\.\(\{preventScroll: true\}\)/);
    assert.match(panel, /this\.scriptaImageInspector = null/);
    assert.match(scriptaRendering, /scripta-image-inspector-change/);
    assert.match(scriptaRendering, /selectedImageId: inspectorMatches \? inspector\.imageId : ''/);
    assert.match(scriptaRendering, /chapterNode\.dataset\.chapterId = chapter\.chapterId/);
    assert.match(scriptaRendering, /action\.dataset\.localAction = `runScriptaLocalAction \$\{eventAction\} \$\{values\.join\(' '\)\}`/);
    assert.match(scriptaRendering, /node\.textContent = text/);
    assert.doesNotMatch(scriptaRendering, /innerHTML/);
    assert.doesNotMatch(scriptaRendering, /addEventListener\('click'/);
    assert.match(panelHtml, /<template data-template="scripta-document">/);
    assert.match(panelHtml, /<template data-template="scripta-chapter">/);
    assert.match(panelHtml, /<template data-template="scripta-paragraph-card">/);
    assert.match(panelHtml, /data-local-action="runScriptaLocalAction scripta-paragraph-open"/);
    assert.match(collaboration, /renderPollWidgetContent/);
    assert.match(collaboration, /renderBulletsWidgetContent/);
    assert.match(graphics, /createShapeSvg/);
    assert.match(graphics, /createLineSvg/);
});

test('blackboard WebSkel components trigger their initial render', async () => {
    for (const componentName of [
        'webmeet-blackboard-panel',
        'webmeet-blackboard-toolbar',
        'webmeet-blackboard-widget-editor',
        'webmeet-blackboard-results-panel'
    ]) {
        const source = await fs.readFile(
            path.resolve(
                import.meta.dirname,
                `../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/${componentName}/${componentName}.js`
            ),
            'utf8'
        );
        assert.match(source, /constructor\(element,\s*invalidate(?:,\s*hostContext)?\)/, `${componentName} must accept WebSkel invalidate`);
        assert.match(source, /this\.invalidate = invalidate/, `${componentName} must store WebSkel invalidate`);
        assert.match(source, /beforeRender\(\)\s*\{\}/, `${componentName} must implement WebSkel beforeRender`);
        assert.match(source, /this\.invalidate\(\)/, `${componentName} must trigger its initial WebSkel render`);
    }
});

test('legacy blackboard visibility envelopes remain nonpersistent transport data', () => {
    const encoded = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED, {
        meetingId: 'room_1',
        participantId: 'participant_1',
        visible: true
    });
    const parsed = parseWebMeetEvent(encoded);

    assert.equal(parsed.type, WEBMEET_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED);
    assert.equal(parsed.payload.visible, true);
    assert.equal(parsed.persistent, false);
});

test('blackboard image events authorize the room before resolving Explorer media', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-blackboard-auth-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.data', 'webmeetAgent', 'data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'unit-test-master-key';
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });

    try {
        const adminAuth = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const outsiderAuth = { user: { id: 'local:outsider', username: 'outsider', roles: [] } };
        const context = await createStoreContext(root);
        let mediaGetCalls = 0;
        context.scriptaExplorerClient = async (tool, args) => {
            if (tool === 'scripta_crdt_ensure_folder') return { ok: true, folderPath: args.folderPath };
            if (tool === 'webmeet_media_get') {
                mediaGetCalls += 1;
                return { ok: true, asset: { assetId: args.assetId, workspaceUrl: '/unexpected.png' } };
            }
            throw new Error(`Unexpected Explorer tool ${tool}`);
        };
        const meeting = await createMeeting(context, { name: 'Private blackboard', authInfo: adminAuth });

        await assert.rejects(
            applyRoomBlackboardEvents(context, {
                roomId: meeting.roomId,
                boardId: 'agent:agent_robo_team',
                participantId: 'outsider',
                authInfo: outsiderAuth,
                events: [{
                    action: 'create',
                    target: { type: 'blackboard' },
                    payload: {
                        widget: {
                            type: 'image',
                            properties: { source: { kind: 'explorer-media', assetId: 'asset_private' } },
                        },
                    },
                }],
            }),
            /Access denied/,
        );
        assert.equal(mediaGetCalls, 0);
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('webmeet store persists blackboard on the RoboTeam agent and appends final event', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-blackboard-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.data', 'webmeetAgent', 'data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'unit-test-master-key';
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });

    try {
        const authInfo = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const context = installEdgeJoinFixture(await createStoreContext(root));
        let mediaRoomFolderPath = '';
        context.scriptaExplorerClient = async (tool, args) => {
            if (tool === 'scripta_crdt_ensure_folder') return { ok: true, folderPath: args.folderPath };
            if (tool === 'webmeet_media_commit') {
                mediaRoomFolderPath = args.roomFolderPath;
                assert.match(mediaRoomFolderPath, /^\/WebMeet\/blackboard-test-/);
                if (args.blobRef.id === 'c'.repeat(48)) {
                    return { ok: true, asset: {
                        assetId: 'asset_file-1', kind: 'file', filename: 'agenda.pdf', mimeType: 'application/pdf',
                        extension: 'pdf', size: 4096,
                        workspaceUrl: `${mediaRoomFolderPath}/assets/asset_file-1/report.pdf`
                    } };
                }
                assert.deepEqual(args.blobRef, {
                    id: 'b'.repeat(48),
                    agent: 'explorer',
                    localPath: `blobs/${'b'.repeat(48)}`
                });
                return { ok: true, asset: {
                    assetId: 'asset_chat-1', kind: 'image', filename: 'chat.png', mimeType: 'image/png', size: 24,
                    width: 800, height: 600,
                    workspaceUrl: `${mediaRoomFolderPath}/assets/asset_chat-1/chat.png`
                } };
            }
            if (tool === 'webmeet_media_get') {
                assert.equal(args.roomFolderPath, mediaRoomFolderPath);
                return {
                    ok: true,
                    asset: {
                        assetId: args.assetId, kind: 'image', filename: 'photo.png', mimeType: 'image/png', size: 24,
                        width: 640, height: 480,
                        workspaceUrl: `${mediaRoomFolderPath}/assets/${args.assetId}/image.png`
                    }
                };
            }
            throw new Error(`Unexpected Explorer tool ${tool}`);
        };
        const meeting = await createMeeting(context, { name: 'Blackboard test', authInfo });
        const initialProjection = await getRoomBlackboard(context, {
            roomId: meeting.roomId, participantId: 'admin', authInfo,
        });
        const boardId = initialProjection.workspace.activeBoardId;

        const publishedImage = await publishRoomAttachment(context, {
            roomId: meeting.roomId, boardId, participantId: 'admin',
            blobRef: {
                id: 'b'.repeat(48),
                agent: 'explorer',
                localPath: `blobs/${'b'.repeat(48)}`
            },
            authInfo
        });
        assert.equal(publishedImage.message.metadata.attachments[0].assetId, 'asset_chat-1');
        assert.equal(publishedImage.widget.type, 'image');
        assert.equal(publishedImage.widget.properties.geometry.width, 360);
        assert.equal(publishedImage.widget.properties.geometry.height, 270);
        assert.equal(publishedImage.widget.properties.geometry.rotation, 0);
        assert.equal(publishedImage.message.metadata.boardTitle, 'Workspace 1');

        const publishedFile = await publishRoomAttachment(context, {
            roomId: meeting.roomId, boardId, participantId: 'admin',
            blobRef: {
                id: 'c'.repeat(48),
                agent: 'explorer',
                localPath: `blobs/${'c'.repeat(48)}`
            },
            position: {x: 500, y: 400},
            authInfo
        });
        assert.equal(publishedFile.message.metadata.attachments[0].kind, 'file');
        assert.equal(publishedFile.widget.type, 'file');
        assert.deepEqual(publishedFile.widget.properties.geometry, {
            x: 340, y: 320, width: 320, height: 160, rotation: 0
        });
        assert.deepEqual(publishedFile.widget.properties.source, {
            kind: 'explorer-media',
            assetId: 'asset_file-1',
            url: `/workspace-files${mediaRoomFolderPath}/assets/asset_file-1/report.pdf`,
            name: 'agenda.pdf',
            mimeType: 'application/pdf',
            extension: 'pdf',
            size: 4096
        });

        let beforeEmptyUndo = await getRoomBlackboard(context, {
            roomId: meeting.roomId, boardId, participantId: 'admin', authInfo,
        });
        let emptyUndo;
        for (let attempt = 0; attempt < 10; attempt += 1) {
            emptyUndo = await applyRoomBlackboardEvents(context, {
                roomId: meeting.roomId, boardId, participantId: 'admin', authInfo,
                events: [{ action: 'undo', target: { type: 'blackboard' }, payload: {} }],
            });
            if (!emptyUndo.changed) break;
            beforeEmptyUndo = emptyUndo;
        }
        assert.equal(emptyUndo.changed, false);
        assert.equal(emptyUndo.blackboard.revision, beforeEmptyUndo.blackboard.revision);
        assert.equal(emptyUndo.broadcast, null);

        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo,
            change: {
                changeType: 'create',
                targetType: 'widget',
                widget: {
                    id: 'shape_1',
                    type: 'shape',
                    properties: { geometry: { x: 1, y: 2, width: 100, height: 50 } }
                }
            }
        });

        const lineCreated = await applyRoomBlackboardEvents(context, {
            roomId: meeting.roomId, boardId, participantId: 'admin', authInfo, source: 'robo',
            events: [{
                ref: 'line', action: 'create', target: { type: 'blackboard' },
                payload: { widget: { type: 'line', properties: { line: { x1: 100, y1: 200, x2: 300, y2: 200, markerEnd: 'arrow' } } } },
            }],
        });
        const lineWidget = lineCreated.blackboard.widgets.find((widget) => widget.type === 'line');
        assert.deepEqual(lineWidget.properties.geometry, { x: 99.5, y: 199.5, width: 201, height: 1, rotation: 0 });
        assert.deepEqual(lineWidget.properties.line, { x1: 0.5, y1: 0.5, x2: 200.5, y2: 0.5, markerEnd: 'arrow' });
        const lineMoved = await applyRoomBlackboardEvents(context, {
            roomId: meeting.roomId, boardId, participantId: 'admin', authInfo, source: 'robo',
            events: [{ action: 'update', target: { type: 'widget', widgetId: lineWidget.id }, payload: { patch: { properties: { geometryDelta: { x: 0, y: -50 } } } } }],
        });
        const movedLine = lineMoved.blackboard.widgets.find((widget) => widget.id === lineWidget.id);
        assert.equal(movedLine.properties.geometry.y, 149.5);
        assert.deepEqual(movedLine.properties.line, lineWidget.properties.line);

        const imageCreated = await applyRoomBlackboardEvents(context, {
            roomId: meeting.roomId, boardId, participantId: 'admin', authInfo,
            events: [{
                action: 'create', target: { type: 'blackboard' },
                payload: { widget: { type: 'image', properties: {
                    source: {
                        kind: 'explorer-media', assetId: 'asset_image-1',
                        url: '/workspace-files/document-multimedia/webmeet/forged/assets/asset_image-1.png'
                    },
                    naturalSize: { width: 1, height: 1 },
                    geometry: { x: 10, y: 10, width: 200, height: 150 }
                } } }
            }]
        });
        const imageWidget = imageCreated.blackboard.widgets.find((widget) => widget.type === 'image');
        assert.equal(imageWidget.properties.source.url, `/workspace-files${mediaRoomFolderPath}/assets/asset_image-1/image.png`);
        assert.deepEqual(imageWidget.properties.naturalSize, { width: 640, height: 480 });

        const response = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo
        });
        const commandProjection = await getRoomBlackboardForCommand(context, {
            roomId: meeting.roomId, boardId, participantId: 'admin', authInfo,
        });
        assert.equal('clarification' in commandProjection, false);
        const events = await listMeetingEvents(context, meeting.roomId);
        const record = await loadRoomRecord(context, meeting.roomId);
        const payload = decryptRoomPayload(context, record);
        const roboTeam = payload.agents.find((agent) => agent.id === 'agent_robo_team');

        assert.ok(response.blackboard.widgets.some((widget) => widget.id === 'shape_1'));
        assert.equal(response.blackboard.boardId, boardId);
        assert.equal('privateRoboContext' in response.blackboard, false);
        assert.equal(payload.blackboard, undefined);
        const persistedBoard = roboTeam.blackboardWorkspace.boards.find((board) => board.boardId === boardId);
        assert.ok(persistedBoard.widgets.some((widget) => widget.id === 'shape_1'));
        assert.equal(roboTeam.blackboardWorkspace.activeBoardId, boardId);
        assert.equal(persistedBoard.boardOwnerType, 'room');
        assert.ok(events.some((event) => parseWebMeetEvent(event).type === WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED));
        assert.ok(events.some((event) => parseWebMeetEvent(event).payload.boardId === boardId));
        const later = await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo,
            change: {
                changeType: 'update',
                targetType: 'widget',
                targetRef: 'shape_1',
                patch: { properties: { label: 'stale' } }
            }
        });
        assert.equal(later.blackboard.widgets.find((widget) => widget.id === 'shape_1').properties.label, 'stale');
        assert.ok(later.blackboard.revision > response.blackboard.revision);

        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo,
            change: {
                changeType: 'create',
                targetType: 'widget',
                widget: {
                    id: 'shape_2',
                    type: 'shape',
                    properties: { geometry: { x: 240, y: 2, width: 100, height: 50 } }
                }
            }
        });
        const grouped = await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo,
            change: {
                changeType: 'group',
                targetType: 'blackboard',
                widgetIds: ['shape_1', 'shape_2']
            }
        });
        const groupId = grouped.blackboard.widgets.find((widget) => widget.id === 'shape_1').groupId;
        assert.ok(groupId);

        const movedGroup = await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo,
            change: {
                changeType: 'update',
                targetType: 'group',
                targetRef: groupId,
                patch: { transform: { translation: { x: 20, y: 10 } } }
            }
        });
        assert.equal(movedGroup.broadcast.kind, 'blackboard');
        assert.equal(movedGroup.broadcast.object.revision, movedGroup.blackboard.revision);
        assert.deepEqual(movedGroup.object, movedGroup.blackboard);

        const ungrouped = await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo,
            change: { changeType: 'ungroup', targetType: 'group', targetRef: groupId }
        });
        assert.equal(ungrouped.broadcast.kind, 'blackboard');
        assert.deepEqual(ungrouped.object, ungrouped.blackboard);
        assert.equal(ungrouped.blackboard.widgets.find((widget) => widget.id === 'shape_1').groupId, '');

        const regrouped = await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo,
            change: {
                changeType: 'group',
                targetType: 'blackboard',
                widgetIds: ['shape_1', 'shape_2']
            }
        });
        const regroupedId = regrouped.blackboard.widgets.find((widget) => widget.id === 'shape_1').groupId;
        const deletedGroup = await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo,
            change: { changeType: 'delete', targetType: 'group', targetRef: regroupedId }
        });
        assert.equal(deletedGroup.broadcast.kind, 'blackboard');
        assert.deepEqual(deletedGroup.object, deletedGroup.blackboard);
        assert.equal(deletedGroup.blackboard.widgets.some((widget) => ['shape_1', 'shape_2'].includes(widget.id)), false);
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('webmeet event tool decodes canonical serialized blackboard events from transport', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-blackboard-tool-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    try {
        process.env.WEBMEET_DATA_DIR = path.join(root, 'data');
        process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
        const context = installEdgeJoinFixture(await createStoreContext(root));
        context.scriptaExplorerClient = async (tool, args) => {
            assert.equal(tool, 'scripta_crdt_ensure_folder');
            return { ok: true, folderPath: args.folderPath };
        };
        const authInfo = {
            user: {
                id: 'local:admin',
                username: 'admin',
                roles: ['admin']
            }
        };
        const meeting = await createMeeting(context, {
            workspaceId: 'rooms',
            title: 'Serialized blackboard tool room',
            authInfo
        });
        await assert.rejects(
            authorizeMeetingParticipant(context, { roomId: meeting.roomId, participantId: 'admin', authInfo }),
            (error) => error?.code === 'participant_not_joined',
        );
        await joinMeeting(context, {
            meetingId: meeting.roomId, participantId: 'admin', displayName: 'Admin', authInfo,
        });
        const workspaceProjection = await dispatch('webmeet_blackboard_workspace_get', {
            roomId: meeting.roomId,
            participantId: 'admin',
        }, context, authInfo);
        const boardId = workspaceProjection.workspace.activeBoardId;
        let sequence = 0;
        const dispatchEvent = async (event) => {
            sequence += 1;
            return dispatch('webmeet_event_command', {
                roomId: meeting.roomId,
                participantId: 'admin',
                boardId,
                source: 'ui',
                commandId: `command-${sequence}`,
                event: JSON.stringify(event),
            }, context, authInfo);
        };
        const created = await dispatchEvent({
            ref: 'card',
            target: { type: 'blackboard' },
            action: 'create',
            payload: {
                widget: {
                    type: 'card',
                    properties: {
                        text: 'Initial',
                        geometry: { x: 1, y: 2, width: 100, height: 50 }
                    }
                },
            },
        });
        const cardId = created.blackboard.interactionContext.focusedWidgetId;

        const response = await dispatchEvent({
            target: { type: 'widget', widgetId: cardId },
            action: 'update',
            payload: { patch: { properties: { text: 'Updated' } } },
        });

        assert.equal(response.ok, true, JSON.stringify(response));
        const widget = response.blackboard.widgets.find((entry) => entry.id === cardId);
        assert.equal(widget.properties.text, 'Updated');
        assert.equal(response.events[0].action, 'update');
        assert.equal(response.broadcast.revision, response.blackboard.revision);
        assert.equal(response.broadcast.ownerParticipantId, 'agent_robo_team');
        assert.ok(response.broadcast.blackboardId);
        assert.equal(response.broadcast.boardId, boardId);
        assert.equal(response.broadcast.boardOwnerType, 'room');
        assert.equal(response.broadcast.boardOwnerId, meeting.roomId);
        assert.equal(response.broadcast.boardVisibility, 'room');

        await assert.rejects(dispatch('webmeet_blackboard_get', {
            roomId: meeting.roomId,
            boardId: 'participant:participant-admin',
            participantId: 'participant-admin'
        }, context, authInfo), /workspace zone .* was not found/);

        const backgroundResponse = await dispatchEvent({
            action: 'update',
            target: { type: 'blackboard' },
            payload: { patch: { metadata: { background: { color: '#f8fafc' } } } },
        });

        assert.ok(backgroundResponse.blackboard.revision > response.blackboard.revision);
        assert.equal(backgroundResponse.broadcast.kind, 'blackboard');
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.WEBMEET_DATA_DIR;
        } else {
            process.env.WEBMEET_DATA_DIR = previousDataDir;
        }
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        } else {
            process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        }
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('webmeet blackboard submit derives participant authority from joined participant, not client change data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-blackboard-spoof-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.data', 'webmeetAgent', 'data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'unit-test-master-key';
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });

    try {
        const adminAuth = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const userAuth = { user: { id: 'local:user-1', username: 'user1', roles: ['user'] } };
        const context = installEdgeJoinFixture(await createStoreContext(root));
        context.scriptaExplorerClient = async (tool, args) => {
            assert.equal(tool, 'scripta_crdt_ensure_folder');
            return { ok: true, folderPath: args.folderPath };
        };
        const meeting = await createMeeting(context, { name: 'Blackboard spoof test', authInfo: adminAuth });
        const initialProjection = await getRoomBlackboard(context, {
            roomId: meeting.roomId, authInfo: adminAuth,
        });
        const boardId = initialProjection.workspace.activeBoardId;
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            participantId: 'participant_user_1',
            displayName: 'User One',
            authInfo: userAuth
        });
        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            participantId: 'participant_admin',
            authInfo: adminAuth,
            change: {
                changeType: 'create',
                targetType: 'widget',
                widget: {
                    id: 'card_1',
                    type: 'card',
                    properties: { text: 'Q', participantData: {}, resultsVisibility: 'moderators' }
                }
            }
        });

        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            participantId: 'participant_user_1',
            authInfo: userAuth,
            change: {
                changeType: 'submit',
                targetType: 'widget',
                targetRef: 'card_1',
                participantId: 'participant_admin',
                data: { answer: 'spoof attempt' }
            }
        });

        const moderatorView = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo: adminAuth
        });
        const card = moderatorView.blackboard.widgets.find((widget) => widget.id === 'card_1');
        assert.equal(card.properties.participantData.participant_admin, undefined);
        assert.deepEqual(card.properties.participantData.participant_user_1, { answer: 'spoof attempt' });
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('webmeet blackboard strips non-admin visibility authority from final changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-blackboard-visibility-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.data', 'webmeetAgent', 'data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'unit-test-master-key';
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });

    try {
        const adminAuth = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const userAuth = { user: { id: 'local:user-1', username: 'user1', roles: ['user'] } };
        const context = installEdgeJoinFixture(await createStoreContext(root));
        context.scriptaExplorerClient = async (tool, args) => {
            assert.equal(tool, 'scripta_crdt_ensure_folder');
            return { ok: true, folderPath: args.folderPath };
        };
        const meeting = await createMeeting(context, { name: 'Blackboard visibility test', authInfo: adminAuth });
        const initialProjection = await getRoomBlackboard(context, {
            roomId: meeting.roomId, authInfo: adminAuth,
        });
        const boardId = initialProjection.workspace.activeBoardId;
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            participantId: 'participant_user_1',
            displayName: 'User One',
            authInfo: userAuth
        });

        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId,
            participantId: 'participant_user_1',
            authInfo: userAuth,
            change: {
                changeType: 'create',
                targetType: 'widget',
                widget: {
                    id: 'shape_private',
                    type: 'shape',
                    visibility: { mode: 'moderators' },
                    properties: { geometry: { x: 0, y: 0, width: 20, height: 20 } }
                }
            }
        });

        const adminView = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId,
            authInfo: adminAuth
        });
        const widget = adminView.blackboard.widgets.find((entry) => entry.id === 'shape_private');
        assert.deepEqual(widget.visibility, { mode: 'all' });
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
});
