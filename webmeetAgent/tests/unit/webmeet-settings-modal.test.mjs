import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const pluginRoot = path.join(repoRoot, 'IDE-plugins/webmeet-tool-button');

test('WebMeet dashboard is a page component and settings is a WebSkel modal', async () => {
    const config = JSON.parse(await fs.readFile(path.join(pluginRoot, 'config.json'), 'utf8'));
    const dashboard = config.dependencies.find((entry) => entry.component === 'webmeet-dashboard');
    const settingsModal = config.dependencies.find((entry) => entry.component === 'webmeet-settings-modal');
    const customSelect = config.dependencies.find((entry) => entry.component === 'custom-select');

    assert.ok(dashboard);
    assert.equal(dashboard.presenter, 'WebmeetDashboard');
    assert.equal(dashboard.type, undefined);
    assert.equal(settingsModal?.presenter, 'WebmeetSettingsModal');
    assert.equal(settingsModal?.type, 'modal');
    assert.equal(customSelect?.agent, 'explorer');
    assert.equal(customSelect?.path, undefined);
    assert.equal(customSelect?.baseUrl, '/explorer/web-components/components/custom-select/custom-select');
});

test('room settings passes structured RoboTeam settings through encoded modal attributes', async () => {
    const dashboardSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/controllers/meeting-action-methods.js'),
        'utf8'
    );
    const modalSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-room-settings-modal/webmeet-room-settings-modal.js'),
        'utf8'
    );
    const { WebmeetRoomSettingsModal } = await import(
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-room-settings-modal/webmeet-room-settings-modal.js'
    );
    const attributes = new Map([
        ['data-room-id', 'room-1'],
        ['data-room-title', 'Planning'],
        ['data-room-link', 'http://localhost/room-1'],
        ['data-robo-team-settings', encodeURIComponent(JSON.stringify({
            meetingNotes: {
                enabled: true,
                sections: ['ideas']
            }
        }))]
    ]);
    const element = {
        getAttribute(name) {
            return attributes.has(name) ? attributes.get(name) : null;
        }
    };
    const modal = new WebmeetRoomSettingsModal(element, () => {});

    assert.match(dashboardSource, /showModal\('webmeet-room-settings-modal'/);
    assert.doesNotMatch(dashboardSource, /createReactiveModal\('webmeet-room-settings-modal'/);
    assert.match(dashboardSource, /'robo-team-settings': encodeURIComponent\(JSON\.stringify\(roboTeamSettings\)\)/);
    assert.doesNotMatch(dashboardSource, /webmeet\.roboTeam\./);
    assert.doesNotMatch(modalSource, /readData\(/);
    assert.doesNotMatch(modalSource, /props\.roboTeamSettings/);
    assert.equal(modal.roomId, 'room-1');
    assert.equal(modal.roomTitle, 'Planning');
    assert.equal(modal.roboTeamSettings.meetingNotes.enabled, true);
    assert.equal(Object.hasOwn(modal.roboTeamSettings.meetingNotes, 'sections'), false);
    assert.match(modal.roboTeamSettings.meetingNotes.structurePrompt, /Create a meeting title followed by these chapters/);
    const notesFields = modal.renderMeetingNotesFields(modal.roboTeamSettings.meetingNotes);
    assert.match(notesFields, /data-robo-field="meetingNotes\.structurePrompt"/);
    assert.match(notesFields, /Ideas and proposals[\s\S]*Decisions[\s\S]*Questions[\s\S]*Risks[\s\S]*Actions[\s\S]*Unresolved points/);
    assert.doesNotMatch(notesFields, /meetingNotes\.sections/);
});

test('WebMeet settings modal supports resize, fullscreen, and dashboard action delegation', async () => {
    const modalSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.js'),
        'utf8'
    );
    const modalCss = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.css'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/controllers/media-settings-methods.js'),
        'utf8'
    );

    assert.match(modalSource, /ensureResizable\(\)/);
    assert.match(modalSource, /toggleFullscreen\(\)/);
    assert.match(modalSource, /webmeet:settings-modal-action/);
    assert.match(modalCss, /\.webmeet-settings-modal \.webmeet-hidden/);
    assert.match(modalCss, /\.webmeet-settings-resize-handle\.se/);
    assert.match(modalCss, /webmeet-settings-modal-dialog\.is-fullscreen/);
    const dialogRule = modalCss.match(/dialog\.modal\.webmeet-settings-modal-dialog\s*\{[^}]*\}/)?.[0] || '';
    const wrapperRule = modalCss.match(/\.webmeet-settings-modal\s*\{[^}]*\}/)?.[0] || '';
    const contentPanelRule = modalCss.match(/#webmeetMediaSettingsPanel\.webmeet-media-settings\s*\{[^}]*\}/)?.[0] || '';
    assert.doesNotMatch(dialogRule, /background: transparent/);
    assert.doesNotMatch(dialogRule, /border: none/);
    assert.doesNotMatch(wrapperRule, /background: var\(--surface\)/);
    assert.doesNotMatch(wrapperRule, /border: 1px solid var\(--border\)/);
    assert.match(contentPanelRule, /background: transparent/);
    assert.match(contentPanelRule, /box-shadow: none/);
    assert.match(dashboardSource, /showModal\?\.\('webmeet-settings-modal'\)/);
    assert.match(dashboardSource, /mountMediaSettingsModal/);
    assert.match(dashboardSource, /cacheMediaSettingsElements\(detail\.element\)/);
    assert.match(dashboardSource, /cacheMediaSettingsElements\(detail\.element\);\s*this\.registerMediaSettingsInputHandlers\(\);/);
    assert.doesNotMatch(dashboardSource, /appendChild\(this\.mediaSettingsPanel\)/);
});

test('WebMeet settings fields live in the WebSkel modal template, not the dashboard page', async () => {
    const dashboardHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.html'),
        'utf8'
    );
    const modalHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.html'),
        'utf8'
    );

    assert.doesNotMatch(dashboardHtml, /id="webmeetMediaSettingsPanel"/);
    assert.match(modalHtml, /id="webmeetMediaSettingsPanel" class="webmeet-settings-modal webmeet-media-settings"/);
    assert.match(modalHtml, /id="webmeetAudioVideoSettingsTabPanel"/);
    assert.match(modalHtml, /id="webmeetVoiceCommandSettingsTabPanel"/);
    assert.match(modalHtml, /id="webmeetSpeechRecognitionLanguage"/);
    assert.match(modalHtml, /id="webmeetAvatarSettingsTabPanel"/);
    assert.match(modalHtml, /id="webmeetMediaSettingsActions"/);
    assert.match(modalHtml, /id="webmeetAvatarSettingsActions"/);
});

test('Meeting Notes settings expose only enabled state and editable document structure', async () => {
    const modalSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-room-settings-modal/webmeet-room-settings-modal.js'),
        'utf8',
    );
    const modelSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-room-settings-modal/robo-team-settings-model.js'),
        'utf8',
    );
    for (const removedSetting of ['visibleDuringMeeting', 'reviewEnabled', 'exportEnabled']) {
        assert.doesNotMatch(modalSource, new RegExp(`data-robo-(?:toggle|field)=["']meetingNotes\\.${removedSetting}`));
        assert.match(modelSource, new RegExp(`delete result\\.meetingNotes\\.${removedSetting}`));
    }
});

test('WebMeet close buttons use the shared modal icon asset from ui-common', async () => {
    const htmlFiles = [
        'components/create-room-modal/create-room-modal.html',
        'components/webmeet-dashboard/webmeet-dashboard.html',
        'components/webmeet-participant-audio-modal/webmeet-participant-audio-modal.html',
        'components/webmeet-room-settings-modal/webmeet-room-settings-modal.html'
    ];
    const commonCss = await fs.readFile(path.join(repoRoot, '../explorer/shared/ui/ui-common.css'), 'utf8');

    assert.match(commonCss, /\.close:empty::before\s*\{[\s\S]*\/explorer\/shared\/assets\/icons\/x-mark\.svg/);
    for (const file of htmlFiles) {
        const source = await fs.readFile(path.join(pluginRoot, file), 'utf8');
        assert.doesNotMatch(source, /close-icon/);
        assert.doesNotMatch(source, /x-mark\.svg/);
        assert.doesNotMatch(source, /class="close"[\s\S]{0,160}<svg/);
        assert.doesNotMatch(source, /class="close"[\s\S]{0,160}<img/);
    }
});

test('WebMeet participant audio volume defaults to 100 percent', async () => {
    const modalSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-participant-audio-modal/webmeet-participant-audio-modal.js'),
        'utf8'
    );
    const modalHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-participant-audio-modal/webmeet-participant-audio-modal.html'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/controllers/media-settings-methods.js'),
        'utf8'
    );

    assert.match(modalSource, /DEFAULT_PARTICIPANT_VOLUME = 1/);
    assert.match(modalHtml, /data-role="volumeValue">100%/);
    assert.match(dashboardSource, /DEFAULT_PARTICIPANT_VOLUME = 1/);
    assert.doesNotMatch(dashboardSource, /normalizeParticipantAudioVolume\(value\)\s*\{[\s\S]{0,120}return DEFAULT_OUTPUT_VOLUME/);
});

test('WebMeet settings tab footer actions hide inactive tab controls inside the modal', async () => {
    const modalHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.html'),
        'utf8'
    );
    const mediaSettingsSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/controllers/media-settings-methods.js'),
        'utf8'
    );
    const modalCss = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.css'),
        'utf8'
    );

    assert.match(modalHtml, /id="webmeetAvatarSettingsActions" class="webmeet-media-settings-actions webmeet-hidden"/);
    assert.match(mediaSettingsSource, /mediaSettingsActions\?\.classList\.toggle\('webmeet-hidden', activeSettingsTab === 'avatar'\)/);
    assert.match(mediaSettingsSource, /refreshMediaDevicesButton\?\.classList\.toggle\('webmeet-hidden', activeSettingsTab !== 'media'\)/);
    assert.match(mediaSettingsSource, /avatarSettingsActions\?\.classList\.toggle\('webmeet-hidden', activeSettingsTab !== 'avatar'\)/);
    assert.match(modalCss, /\.webmeet-settings-modal \.webmeet-hidden\s*\{[\s\S]*display: none !important;/);
});

test('WebMeet audio health is a microphone button badge, not a settings field', async () => {
    const dashboardHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.html'),
        'utf8'
    );
    const dashboardCss = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.css'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.js'),
        'utf8'
    );
    const settingsModalCss = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.css'),
        'utf8'
    );

    assert.doesNotMatch(dashboardHtml, /webmeetAudioHealthValue/);
    assert.doesNotMatch(dashboardHtml, />Audio health</);
    assert.match(dashboardHtml, /id="webmeetMicButton"[\s\S]*id="webmeetAudioHealthIndicator"/);
    assert.match(dashboardCss, /\.webmeet-audio-health-indicator/);
    assert.doesNotMatch(settingsModalCss, /webmeet-audio-health/);
    assert.match(dashboardSource, /updateAudioHealthIndicator/);
    assert.match(dashboardSource, /Toggle Microphone - Audio: \$\{health\}/);
});
