import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const pluginRoot = path.join(repoRoot, 'IDE-plugins/webmeet-tool-button');
const dashboardDir = path.join(pluginRoot, 'components/webmeet-dashboard');

test('refreshing restores WebMeet and re-enters the active room with media state', async () => {
    const toolButtonSource = await fs.readFile(path.join(pluginRoot, 'webmeet-tool-button.js'), 'utf8');
    const pluginConfig = JSON.parse(await fs.readFile(path.join(pluginRoot, 'config.json'), 'utf8'));
    const dashboardSource = await fs.readFile(path.join(dashboardDir, 'webmeet-dashboard.js'), 'utf8');
    const sessionSource = await fs.readFile(path.join(dashboardDir, 'controllers/dashboard-session-methods.js'), 'utf8');
    const meetingActionSource = await fs.readFile(path.join(dashboardDir, 'controllers/meeting-action-methods.js'), 'utf8');

    // The shared expanded-modal shell restores the panel after a refresh; WebMeet opts in and
    // provides a room id so the reopened roomLoader can re-enter the room.
    assert.equal(pluginConfig.toolbarModal?.resume, true);
    assert.match(toolButtonSource, /import\s*\{[^}]*readWebMeetResume[^}]*\}\s*from\s*'\.\/components\/webmeet-dashboard\/services\/webmeet-session-store\.js'/);
    assert.match(toolButtonSource, /buildRoomLoaderUrl\(roomId/);
    assert.match(toolButtonSource, /openWebMeetPanel/);
    assert.match(toolButtonSource, /writeWebMeetResume\(\{ open: false \}\)/);
    assert.match(toolButtonSource, /this\.pageUnloading/);
    assert.match(toolButtonSource, /readWebMeetResume\(\)/);
    assert.doesNotMatch(toolButtonSource, /clearWebMeetResume/);

    assert.match(dashboardSource, /writeWebMeetResume\(\{ open: true \}\)/);
    assert.match(dashboardSource, /writeWebMeetResume\(\{ media: next \}\)/);

    assert.match(sessionSource, /readWebMeetResume/);
    assert.match(sessionSource, /writeWebMeetResume\(\{ open: true, roomId/);

    assert.match(dashboardSource, /globalThis\.__onExpandedModalClose = \(\) => this\.handleExpandedModalUserClose\(\)/);
    assert.match(meetingActionSource, /handleExpandedModalUserClose\(\)/);
    assert.match(meetingActionSource, /writeWebMeetResume\(\{ roomId: '', media: \{ microphone: false, camera: false \} \}\)/);
    assert.match(meetingActionSource, /disconnectLiveKit/);
    assert.match(meetingActionSource, /async restorePersistedMediaState\(\)/);
    assert.match(meetingActionSource, /await this\.restorePersistedMediaState\(\)/);
    assert.match(meetingActionSource, /writeWebMeetResume\(\{ open: true, roomId: meeting\.id \}\)/);

    const unjoinBody = meetingActionSource.slice(
        meetingActionSource.indexOf('async unjoinCurrentSession('),
        meetingActionSource.indexOf('async sendPublicChat(')
    );
    assert.doesNotMatch(unjoinBody, /writeWebMeetResume/, 'unload cleanup must not clear the resume room id');
    assert.match(meetingActionSource, /writeWebMeetResume\(\{ roomId: '', media: \{ microphone: false, camera: false \} \}\)/);
});
