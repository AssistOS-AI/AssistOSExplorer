import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
    collectAudioElements,
    recoverMediaElementPlayback,
    resumeRemoteAudioPlayback
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/audio-playback-recovery.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const dashboardDir = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard'
);

test('collectAudioElements returns audio elements under the given root', () => {
    const root = { querySelectorAll: (selector) => (selector === 'audio' ? [{ id: 'a' }, { id: 'b' }] : []) };
    assert.equal(collectAudioElements(root).length, 2);
    assert.deepEqual(collectAudioElements(null), []);
});

test('recoverMediaElementPlayback reports whether playback is still blocked', async () => {
    const ok = { play: async () => {} };
    const blocked = { play: async () => { throw new Error('blocked by autoplay policy'); } };

    assert.deepEqual(await recoverMediaElementPlayback([ok, ok]), { total: 2, played: 2, blocked: false });
    assert.deepEqual(await recoverMediaElementPlayback([ok, blocked]), { total: 2, played: 1, blocked: true });
    assert.deepEqual(await recoverMediaElementPlayback([]), { total: 0, played: 0, blocked: false });

    const root = { querySelectorAll: () => [ok] };
    assert.deepEqual(await resumeRemoteAudioPlayback(root), { total: 1, played: 1, blocked: false });
});

test('autoplay recovery is wired into attach, the dashboard, and the enable-sound action', async () => {
    const dashboardSource = await fs.readFile(path.join(dashboardDir, 'webmeet-dashboard.js'), 'utf8');
    const dashboardHtml = await fs.readFile(path.join(dashboardDir, 'webmeet-dashboard.html'), 'utf8');
    const participantViewSource = await fs.readFile(path.join(dashboardDir, 'controllers/participant-view-methods.js'), 'utf8');
    const roomSessionSource = await fs.readFile(path.join(dashboardDir, 'controllers/room-session-methods.js'), 'utf8');

    assert.match(dashboardHtml, /id="webmeetEnableSoundButton"[^>]*data-local-action="enableSoundPlayback"/);
    assert.match(dashboardSource, /enableSoundPlayback/);
    assert.match(dashboardSource, /webmeetEnableSoundButton/);
    assert.match(dashboardSource, /handleAudioRecoveryResumeEvent/);
    assert.match(participantViewSource, /async enableSoundPlayback\(\)/);
    assert.match(participantViewSource, /async ensureRemoteAudioPlayback\(mediaElement\)/);
    assert.match(roomSessionSource, /ensureRemoteAudioPlayback\?\.\(mediaElement\)/);
});
