import assert from 'node:assert/strict';
import test from 'node:test';
import {
    describeGuestCookies, evaluateGuestPresence, forbiddenGuestAdmissionTools,
    mcpToolNamesFromPostData, publicRoomLoaderUrl,
} from './webmeet-public-room.mjs';

const roomId = 'room_123e4567-e89b-12d3-a456-426614174000';

test('public room URL has the roomLoader form the WebMeet UI publishes', () => {
    assert.equal(publicRoomLoaderUrl('http://127.0.0.1:8080', roomId),
        `http://127.0.0.1:8080/webmeetAgent/roomLoader.html?roomId=${roomId}`);
    assert.equal(publicRoomLoaderUrl('http://127.0.0.1:8080/explorer/', roomId),
        `http://127.0.0.1:8080/webmeetAgent/roomLoader.html?roomId=${roomId}`);
    for (const bad of ['', 'room_x', `${roomId}/../x`, '../room_x']) {
        assert.throws(() => publicRoomLoaderUrl('http://127.0.0.1:8080', bad), /Invalid WebMeet room id/);
    }
});

test('MCP tool names are read from single and batched tools/call bodies only', () => {
    const call = name => ({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name, arguments: {} } });
    assert.deepEqual(mcpToolNamesFromPostData(JSON.stringify(call('webmeet_room_public_get'))), ['webmeet_room_public_get']);
    assert.deepEqual(mcpToolNamesFromPostData(JSON.stringify([call('a'), { method: 'initialize' }, call('b')])), ['a', 'b']);
    for (const body of ['', null, undefined, 'not json', '{}', JSON.stringify({ method: 'initialize' })]) {
        assert.deepEqual(mcpToolNamesFromPostData(body), []);
    }
});

test('guest admission or guest chat tools are flagged, the room lookup is not', () => {
    assert.deepEqual(forbiddenGuestAdmissionTools(['webmeet_room_public_get']), []);
    assert.deepEqual(
        forbiddenGuestAdmissionTools(['webmeet_room_public_get', 'webmeet_room_join_guest', 'webmeet_chat_send_guest']),
        ['webmeet_room_join_guest', 'webmeet_chat_send_guest'],
    );
});

test('guest cookies must show a guest session and no signed-in session', () => {
    const webmeet = { name: 'ploinky_guest_iw2P_FBNZBzQ_b5bTDMOLe', value: 'v' };
    assert.deepEqual(describeGuestCookies([webmeet, { name: 'ploinky_browser_csrf', value: 'c' }]), {
        names: ['ploinky_browser_csrf', 'ploinky_guest_iw2P_FBNZBzQ_b5bTDMOLe'],
        hasGuestSession: true, legacyGuestCookieWithValue: false, signedInCookies: [],
    });
    assert.equal(describeGuestCookies([]).hasGuestSession, false);
    // The legacy name, another route's cookie, or an empty value is not the WebMeet guest session.
    assert.equal(describeGuestCookies([{ name: 'ploinky_guest', value: 'v' }]).hasGuestSession, false);
    assert.equal(describeGuestCookies([{ name: 'ploinky_guest_ncGyyzpdIxmPjORN_wQfqv', value: 'v' }]).hasGuestSession, false);
    assert.equal(describeGuestCookies([{ name: webmeet.name, value: '' }]).hasGuestSession, false);
    assert.equal(describeGuestCookies([webmeet, { name: 'ploinky_guest', value: 'v' }]).legacyGuestCookieWithValue, true);
    assert.equal(describeGuestCookies([webmeet, { name: 'ploinky_guest', value: '' }]).legacyGuestCookieWithValue, false);
    assert.deepEqual(describeGuestCookies([webmeet, { name: 'ploinky_jwt', value: 'j' }, { name: 'ploinky_sso', value: 's' }]).signedInCookies,
        ['ploinky_jwt', 'ploinky_sso']);
});

test('presence requires the guest card with the guest name and identity on the owner page and the owner on the guest page', () => {
    const owner = { identity: 'o1', local: true, name: 'Owner' };
    const guest = { identity: 'g1', local: true, name: 'Guest A' };
    const asRemote = row => ({ ...row, local: false });
    assert.equal(evaluateGuestPresence([owner, asRemote(guest)], [guest, asRemote(owner)], 'Guest A').ok, true);
    // Guest absent from the owner page, wrong name, wrong identity, owner not seen by guest, not joined.
    assert.equal(evaluateGuestPresence([owner], [guest, asRemote(owner)], 'Guest A').ok, false);
    assert.equal(evaluateGuestPresence([owner, { ...asRemote(guest), name: 'Participant' }], [guest, asRemote(owner)], 'Guest A').ok, false);
    assert.equal(evaluateGuestPresence([owner, { ...asRemote(guest), identity: 'g2' }], [guest, asRemote(owner)], 'Guest A').ok, false);
    assert.equal(evaluateGuestPresence([owner, asRemote(guest)], [guest], 'Guest A').ok, false);
    assert.equal(evaluateGuestPresence([owner, asRemote(guest)], [], 'Guest A').ok, false);
    assert.equal(evaluateGuestPresence([], [guest], 'Guest A').ok, false);
    // Both pages reporting the same local identity is not two participants.
    assert.equal(evaluateGuestPresence([owner, asRemote(owner)], [{ ...owner }, asRemote(owner)], 'Owner').ok, false);
});
