import {
    ASSISTANT_MODES,
    SCENARIO_OPTIONS,
    BLACKBOARD_VISIBILITY_OPTIONS,
    DOCUMENT_PURPOSE_OPTIONS,
    DOCUMENT_TONE_OPTIONS,
    BOT_ROLES,
    DEFAULT_ROBO_TEAM_SETTINGS,
    normalizeRoboTeamSettings,
    isRoboTeamActive
} from './robo-team-settings-model.js';

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function encodeOptions(options) {
    return encodeURIComponent(JSON.stringify(options || []));
}

const ROBO_TEAM_TABS = Object.freeze([
    { key: 'generalSettings', label: 'General settings' },
    { key: 'meetingNotes', label: 'Meeting Notes' },
    { key: 'blackboard', label: 'Blackboard' },
    { key: 'documentBuilder', label: 'Document Builder' },
    { key: 'moderation', label: 'Moderation' },
    { key: 'bots', label: 'Bots' },
    { key: 'adaptation', label: 'Adaptation' }
]);

function readRequiredAttribute(element, name) {
    const value = element.getAttribute(`data-${name}`);
    if (value === null) {
        throw new Error(`Missing required modal property: ${name}`);
    }
    return String(value).trim();
}

function readJsonAttribute(element, name) {
    return JSON.parse(decodeURIComponent(readRequiredAttribute(element, name)));
}

export class WebmeetRoomSettingsModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.roomId = readRequiredAttribute(element, 'room-id');
        this.roomTitle = readRequiredAttribute(element, 'room-title');
        this.roomLink = readRequiredAttribute(element, 'room-link');
        this.activeTab = 'general';
        this.activeRoboTeamTab = 'generalSettings';
        this.roboTeamSettings = normalizeRoboTeamSettings(
            readJsonAttribute(element, 'robo-team-settings')
        );
        this.dialogState = { isFullscreen: false, previous: null };
        this.result = null;
        this.invalidate();
    }

    beforeRender() {
        this.safeRoomId = this.roomId;
    }

    afterRender() {
        this.titleInput = this.element.querySelector('[data-role="roomTitleInput"]');
        this.copyButton = this.element.querySelector('[data-role="copyLinkButton"]');
        this.roomLinkText = this.element.querySelector('[data-role="roomLinkText"]');
        this.roboTeamContent = this.element.querySelector('[data-role="roboTeamContent"]');
        this.fullscreenButton = this.element.querySelector('.webmeet-room-settings-window-action-button');
        if (this.titleInput) {
            this.titleInput.value = this.roomTitle;
        }
        if (this.roomLinkText) {
            this.roomLinkText.textContent = this.roomLink;
        }
        if (this.fullscreenButton) {
            this.fullscreenButton.addEventListener('click', () => this.toggleFullscreen());
        }
        this.renderRoboTeamContent();
        this.bindRoboTeamToggleVisibility();
        this.updateTabVisibility();
        this.ensureResizable();
    }

    getDialogElement() {
        return this.element?.closest?.('dialog') || null;
    }

    ensureDialogPositioning() {
        const dialog = this.getDialogElement();
        if (!dialog || dialog.dataset.webmeetRoomSettingsPositioned === 'true') return dialog;
        const rect = dialog.getBoundingClientRect();
        dialog.style.left = `${rect.left}px`;
        dialog.style.top = `${rect.top}px`;
        dialog.classList.add('webmeet-room-settings-positioned');
        dialog.dataset.webmeetRoomSettingsPositioned = 'true';
        dialog.dataset.webmeetRoomSettingsUserSized = 'false';
        return dialog;
    }

    startResize(event, direction) {
        const dialog = this.ensureDialogPositioning();
        if (!dialog || dialog.classList.contains('is-fullscreen')) return;
        event.preventDefault();
        event.stopPropagation();

        const startRect = dialog.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const minWidth = 560;
        const minHeight = 480;

        const onMove = (moveEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            let left = startRect.left;
            let top = startRect.top;
            let width = startRect.width;
            let height = startRect.height;

            if (direction.includes('e')) width = startRect.width + dx;
            if (direction.includes('s')) height = startRect.height + dy;
            if (direction.includes('w')) {
                width = startRect.width - dx;
                left = startRect.left + dx;
            }
            if (direction.includes('n')) {
                height = startRect.height - dy;
                top = startRect.top + dy;
            }

            width = Math.max(minWidth, width);
            height = Math.max(minHeight, height);
            if (direction.includes('w') && width === minWidth) left = startRect.right - minWidth;
            if (direction.includes('n') && height === minHeight) top = startRect.bottom - minHeight;

            dialog.style.left = `${left}px`;
            dialog.style.top = `${top}px`;
            dialog.style.width = `${width}px`;
            dialog.style.height = `${height}px`;
            dialog.dataset.webmeetRoomSettingsUserSized = 'true';
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
        };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
    }

    ensureResizable() {
        const dialog = this.getDialogElement();
        if (!dialog || dialog.dataset.webmeetRoomSettingsResizable === 'true') return;
        for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
            const handle = document.createElement('div');
            handle.className = `webmeet-room-settings-resize-handle ${direction}`;
            handle.addEventListener('pointerdown', (event) => this.startResize(event, direction));
            this.element.querySelector('.webmeet-room-settings-modal')?.appendChild(handle);
        }
        dialog.dataset.webmeetRoomSettingsResizable = 'true';
    }

    toggleFullscreen() {
        const dialog = this.ensureDialogPositioning();
        if (!dialog) return;
        const shouldEnter = !dialog.classList.contains('is-fullscreen');
        if (shouldEnter) {
            const rect = dialog.getBoundingClientRect();
            this.dialogState.previous = {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                userSized: dialog.dataset.webmeetRoomSettingsUserSized === 'true'
            };
            dialog.classList.add('is-fullscreen');
            this.dialogState.isFullscreen = true;
            return;
        }
        dialog.classList.remove('is-fullscreen');
        const previous = this.dialogState.previous;
        if (previous) {
            dialog.style.left = `${previous.left}px`;
            dialog.style.top = `${previous.top}px`;
            if (previous.userSized) {
                dialog.style.width = `${previous.width}px`;
                dialog.style.height = `${previous.height}px`;
            } else {
                dialog.style.removeProperty('width');
                dialog.style.removeProperty('height');
            }
        }
        this.dialogState.isFullscreen = false;
    }

    bindRoboTeamToggleVisibility() {
        if (!this.roboTeamContent) return;
        this.roboTeamContent.addEventListener('change', (event) => {
            const target = event.target;
            if (!target?.matches?.('[data-robo-toggle]')) return;
            const toggleKey = String(target.dataset?.roboToggle || '').trim();
            if (toggleKey === 'moderation.speakingTimeLimitEnabled') {
                const conditional = this.roboTeamContent.querySelector('[data-robo-conditional="moderation.speakingTimeLimitEnabled"]');
                if (conditional) conditional.hidden = !target.checked;
            }
        });
    }

    setRoomSettingsTab(target) {
        const source = target?.target || target;
        const tabElement = source?.closest?.('[data-room-settings-tab]') || source;
        const tab = String(tabElement?.dataset?.roomSettingsTab || '').trim();
        if (!['general', 'lifecycle', 'roboteam'].includes(tab)) return;
        this.activeTab = tab;
        this.updateTabVisibility();
    }

    updateTabVisibility() {
        for (const button of this.element.querySelectorAll('[data-room-settings-tab]')) {
            const tab = String(button.dataset?.roomSettingsTab || '').trim();
            const isActive = tab === this.activeTab;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        }
        for (const panel of this.element.querySelectorAll('[data-room-settings-panel]')) {
            const panelTab = String(panel.dataset?.roomSettingsPanel || '').trim();
            panel.hidden = panelTab !== this.activeTab;
        }
    }

    setRoboTeamTab(target) {
        const source = target?.target || target;
        const tabElement = source?.closest?.('[data-robo-team-tab]') || source;
        const tab = String(tabElement?.dataset?.roboTeamTab || '').trim();
        if (!ROBO_TEAM_TABS.some((entry) => entry.key === tab)) return;
        this.activeRoboTeamTab = tab;
        this.updateRoboTeamTabVisibility();
    }

    updateRoboTeamTabVisibility() {
        if (!this.roboTeamContent) return;
        for (const button of this.roboTeamContent.querySelectorAll('[data-robo-team-tab]')) {
            const tab = String(button.dataset?.roboTeamTab || '').trim();
            const isActive = tab === this.activeRoboTeamTab;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        }
        for (const panel of this.roboTeamContent.querySelectorAll('[data-robo-team-panel]')) {
            const panelTab = String(panel.dataset?.roboTeamPanel || '').trim();
            panel.hidden = panelTab !== this.activeRoboTeamTab;
        }
    }

    closeModal() {
        this.closed = true;
        assistOS.UI.closeModal(this.element, null);
    }

    showError(message) {
        const target = this.element.querySelector('[data-role="roomSettingsError"]');
        if (!target) return;
        target.textContent = String(message || '').trim();
        target.hidden = !target.textContent;
    }

    async copyRoomLink() {
        if (!this.roomLink) {
            this.showError('Room link is unavailable.');
            return;
        }
        try {
            await navigator.clipboard.writeText(this.roomLink);
            const status = this.element.querySelector('[data-role="copyLinkStatus"]');
            if (status) {
                status.textContent = 'Copied';
                window.setTimeout(() => {
                    status.textContent = '';
                }, 1500);
            }
        } catch {
            this.showError(`Room link: ${this.roomLink}`);
        }
    }

    archiveRoom() {
        assistOS.UI.closeModal(this.element, {
            roomId: this.roomId,
            archive: true
        });
    }

    async deleteRoom() {
        const confirmed = await assistOS.UI.showModal('confirm-action-modal', {
            message: `Permanently delete "${this.roomTitle}" and all of its WebMeet history? This cannot be undone.`
        }, true);
        if (confirmed !== true) return;
        assistOS.UI.closeModal(this.element, {
            roomId: this.roomId,
            delete: true,
            confirmed: true
        });
    }

    async isSecretaryDisabled() {
        try {
            const response = await fetch('/api/marketplace', {
                credentials: 'include',
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) return false;
            const data = await response.json();
            if (data?.ok === false || !Array.isArray(data?.marketplace?.agents)) return false;
            const secretary = data.marketplace.agents.find((agent) =>
                (agent.ref || `${agent.repo}/${agent.name}`) === 'AchillesIDE/webmeetScribeAgent');
            return secretary?.active === false;
        } catch {
            // Availability is advisory; the owning agent still validates settings updates.
            return false;
        }
    }

    async saveSettings() {
        if (this.savePending || this.closed) return;
        this.savePending = true;
        try {
            const name = String(this.titleInput?.value || '').trim();
            if (!name) {
                this.showError('Room name is required.');
                this.activeTab = 'general';
                this.updateTabVisibility();
                return;
            }
            const roboTeam = this.collectRoboTeamSettings();
            if (!this.validateRoboTeamSettings(roboTeam)) {
                return;
            }
            const secretaryDisabled = roboTeam.meetingNotes.enabled && !this.roboTeamSettings.meetingNotes.enabled
                && await this.isSecretaryDisabled();
            if (this.closed || this.element?.isConnected === false) return;
            if (secretaryDisabled) {
                this.showError('Enable webmeetScribeAgent in Marketplace before enabling Meeting Notes.');
                this.activeTab = 'roboteam';
                this.activeRoboTeamTab = 'meetingNotes';
                this.updateTabVisibility();
                this.updateRoboTeamTabVisibility();
                return;
            }
            this.closed = true;
            assistOS.UI.closeModal(this.element, {
                roomId: this.roomId,
                name,
                roboTeam: {
                    active: isRoboTeamActive(roboTeam),
                    assistant: roboTeam.assistant,
                    meetingNotes: roboTeam.meetingNotes,
                    blackboard: roboTeam.blackboard,
                    documentBuilder: roboTeam.documentBuilder,
                    moderation: roboTeam.moderation,
                    bots: roboTeam.bots,
                    adaptation: roboTeam.adaptation
                }
            });
        } finally {
            this.savePending = false;
        }
    }

    collectRoboTeamSettings() {
        const settings = normalizeRoboTeamSettings(this.roboTeamSettings);
        const get = (selector) => this.roboTeamContent?.querySelector(selector);
        const getAll = (selector) => Array.from(this.roboTeamContent?.querySelectorAll(selector) || []);

        const assistantName = get('[data-robo-field="assistant.name"]');
        if (assistantName) settings.assistant.name = String(assistantName.value || '').trim();

        const assistantMode = get('[data-robo-field="assistant.mode"]');
        if (assistantMode) settings.assistant.mode = String(assistantMode.value || '').trim();

        const assistantInstructions = get('[data-robo-field="assistant.instructions"]');
        if (assistantInstructions) settings.assistant.instructions = String(assistantInstructions.value || '').trim();

        const assistantScenario = get('[data-robo-field="assistant.scenarioOrObjective"]');
        if (assistantScenario) settings.assistant.scenarioOrObjective = String(assistantScenario.value || '').trim();

        for (const section of ['meetingNotes', 'blackboard', 'documentBuilder', 'moderation', 'bots', 'adaptation']) {
            const enabledToggle = get(`[data-robo-toggle="${section}.enabled"]`);
            if (enabledToggle) settings[section].enabled = enabledToggle.checked;
        }

        const notesStructurePrompt = get('[data-robo-field="meetingNotes.structurePrompt"]');
        if (notesStructurePrompt) settings.meetingNotes.structurePrompt = String(notesStructurePrompt.value || '').trim();

        const bbVisibility = get('[data-robo-field="blackboard.visibility"]');
        if (bbVisibility) settings.blackboard.visibility = String(bbVisibility.value || '').trim();
        const bbAutoUpdate = get('[data-robo-toggle="blackboard.autoUpdateFromConversation"]');
        if (bbAutoUpdate) settings.blackboard.autoUpdateFromConversation = bbAutoUpdate.checked;
        const bbParticipantRequests = get('[data-robo-toggle="blackboard.participantRequestsEnabled"]');
        if (bbParticipantRequests) settings.blackboard.participantRequestsEnabled = bbParticipantRequests.checked;

        const docPurpose = get('[data-robo-field="documentBuilder.purpose"]');
        if (docPurpose) settings.documentBuilder.purpose = String(docPurpose.value || '').trim();
        const docStructure = get('[data-robo-field="documentBuilder.structureInstructions"]');
        if (docStructure) settings.documentBuilder.structureInstructions = String(docStructure.value || '').trim();
        const docTone = get('[data-robo-field="documentBuilder.toneInstructions"]');
        if (docTone) settings.documentBuilder.toneInstructions = String(docTone.value || '').trim();
        const docCorrections = get('[data-robo-toggle="documentBuilder.participantCorrectionsEnabled"]');
        if (docCorrections) settings.documentBuilder.participantCorrectionsEnabled = docCorrections.checked;

        const modRules = get('[data-robo-field="moderation.rules"]');
        if (modRules) settings.moderation.rules = String(modRules.value || '').trim();
        const modSpeakingOrder = get('[data-robo-toggle="moderation.speakingOrderEnabled"]');
        if (modSpeakingOrder) settings.moderation.speakingOrderEnabled = modSpeakingOrder.checked;
        const modTimeLimit = get('[data-robo-toggle="moderation.speakingTimeLimitEnabled"]');
        if (modTimeLimit) settings.moderation.speakingTimeLimitEnabled = modTimeLimit.checked;
        const modTimeLimitMinutes = get('[data-robo-field="moderation.speakingTimeLimitMinutes"]');
        if (modTimeLimitMinutes) settings.moderation.speakingTimeLimitMinutes = Number(modTimeLimitMinutes.value) || 5;
        const modMicControl = get('[data-robo-toggle="moderation.microphoneControlAllowed"]');
        if (modMicControl) settings.moderation.microphoneControlAllowed = modMicControl.checked;

        settings.bots.allowedRoles = getAll('[data-robo-check="bots.allowedRoles"]')
            .filter((el) => el.checked)
            .map((el) => String(el.value || '').trim())
            .filter(Boolean);

        const botInstructions = get('[data-robo-field="bots.roleInstructions"]');
        if (botInstructions) settings.bots.roleInstructions = String(botInstructions.value || '').trim();
        const botPersonality = get('[data-robo-field="bots.personalityAndObjectives"]');
        if (botPersonality) settings.bots.personalityAndObjectives = String(botPersonality.value || '').trim();

        const adaptParticipantRequests = get('[data-robo-toggle="adaptation.participantRequestsEnabled"]');
        if (adaptParticipantRequests) settings.adaptation.participantRequestsEnabled = adaptParticipantRequests.checked;
        const adaptSilence = get('[data-robo-toggle="adaptation.silenceAsAcceptanceForMinorChanges"]');
        if (adaptSilence) settings.adaptation.silenceAsAcceptanceForMinorChanges = adaptSilence.checked;

        return settings;
    }

    validateRoboTeamSettings(settings) {
        const invalid = [];
        const requireText = (value, label, tab) => {
            if (!String(value || '').trim()) invalid.push({ label, tab });
        };
        const requireArray = (value, label, tab) => {
            if (!Array.isArray(value) || value.length === 0) invalid.push({ label, tab });
        };

        requireText(settings.assistant.name, 'Assistant name', 'generalSettings');
        requireText(settings.assistant.mode, 'Assistant mode', 'generalSettings');
        requireText(settings.assistant.instructions, 'Assistant instructions', 'generalSettings');
        requireText(settings.assistant.scenarioOrObjective, 'Scenario / Objective', 'generalSettings');

        if (settings.meetingNotes.enabled) {
            requireText(settings.meetingNotes.structurePrompt, 'Meeting Notes document structure', 'meetingNotes');
        }
        if (settings.blackboard.enabled) {
            requireText(settings.blackboard.visibility, 'Blackboard visibility', 'blackboard');
        }
        if (settings.documentBuilder.enabled) {
            requireText(settings.documentBuilder.purpose, 'Document Builder purpose', 'documentBuilder');
            requireText(settings.documentBuilder.structureInstructions, 'Document Builder structure instructions', 'documentBuilder');
            requireText(settings.documentBuilder.toneInstructions, 'Document Builder tone', 'documentBuilder');
        }
        if (settings.moderation.enabled) {
            requireText(settings.moderation.rules, 'Moderation rules', 'moderation');
            if (settings.moderation.speakingTimeLimitEnabled && !Number.isFinite(Number(settings.moderation.speakingTimeLimitMinutes))) {
                invalid.push({ label: 'Moderation time limit', tab: 'moderation' });
            }
        }
        if (settings.bots.enabled) {
            requireArray(settings.bots.allowedRoles, 'Bot allowed roles', 'bots');
            requireText(settings.bots.roleInstructions, 'Bot role instructions', 'bots');
            requireText(settings.bots.personalityAndObjectives, 'Bot personality & objectives', 'bots');
        }

        if (invalid.length === 0) return true;
        this.activeTab = 'roboteam';
        this.activeRoboTeamTab = invalid[0].tab;
        this.updateTabVisibility();
        this.updateRoboTeamTabVisibility();
        this.showError(`${invalid[0].label} is required.`);
        return false;
    }

    renderRoboTeamContent() {
        if (!this.roboTeamContent) return;
        const s = normalizeRoboTeamSettings(this.roboTeamSettings);
        this.roboTeamContent.innerHTML = `
            <div class="webmeet-robo-tabs" role="tablist" aria-label="Robo Team sections">
                ${ROBO_TEAM_TABS.map((tab) => `
                    <button type="button" class="webmeet-robo-tab${tab.key === this.activeRoboTeamTab ? ' is-active' : ''}"
                            data-local-action="setRoboTeamTab" data-robo-team-tab="${escapeHtml(tab.key)}"
                            role="tab" aria-selected="${tab.key === this.activeRoboTeamTab ? 'true' : 'false'}">
                        ${escapeHtml(tab.label)}
                    </button>
                `).join('')}
            </div>
            <div class="webmeet-robo-tab-panels">
                ${this.renderRoboPanel('generalSettings', this.renderAssistantSection(s.assistant))}
                ${this.renderRoboPanel('meetingNotes', this.renderFeatureSection({
                    key: 'meetingNotes',
                    title: 'Meeting Notes',
                    description: 'Generate structured notes from conversations.',
                    enabled: s.meetingNotes.enabled,
                    content: this.renderMeetingNotesFields(s.meetingNotes)
                }))}
                ${this.renderRoboPanel('blackboard', this.renderFeatureSection({
                    key: 'blackboard',
                    title: 'Blackboard',
                    description: 'Visual representations of the discussion.',
                    enabled: s.blackboard.enabled,
                    content: this.renderBlackboardFields(s.blackboard)
                }))}
                ${this.renderRoboPanel('documentBuilder', this.renderFeatureSection({
                    key: 'documentBuilder',
                    title: 'Document Builder',
                    description: 'Generate or update working documents from conversations.',
                    enabled: s.documentBuilder.enabled,
                    content: this.renderDocumentBuilderFields(s.documentBuilder)
                }))}
                ${this.renderRoboPanel('moderation', this.renderFeatureSection({
                    key: 'moderation',
                    title: 'Moderation',
                    description: 'AI assistance for room moderation.',
                    enabled: s.moderation.enabled,
                    content: this.renderModerationFields(s.moderation)
                }))}
                ${this.renderRoboPanel('bots', this.renderFeatureSection({
                    key: 'bots',
                    title: 'Bots',
                    description: 'AI bots with specific roles in the room.',
                    enabled: s.bots.enabled,
                    content: this.renderBotsFields(s.bots)
                }))}
                ${this.renderRoboPanel('adaptation', this.renderFeatureSection({
                    key: 'adaptation',
                    title: 'Adaptation & Consensus',
                    description: 'Allow the assistant to adapt based on conversation and chat.',
                    enabled: s.adaptation.enabled,
                    content: this.renderAdaptationFields(s.adaptation)
                }))}
            </div>
        `;
        this.updateRoboTeamTabVisibility();
    }

    renderRoboPanel(key, content) {
        return `
            <section class="webmeet-robo-tab-panel" data-robo-team-panel="${escapeHtml(key)}"${key === this.activeRoboTeamTab ? '' : ' hidden'}>
                ${content}
            </section>
        `;
    }

    renderRoboSelect({ field, label, options, value, required = false }) {
        const requiredMark = required ? ' <span class="webmeet-robo-required" aria-label="required">*</span>' : '';
        return `
            <div class="webmeet-room-settings-field">
                <span>${escapeHtml(label)}${requiredMark}</span>
                <custom-select data-presenter="custom-select"
                               data-robo-field="${escapeHtml(field)}"
                               data-options="${encodeOptions(options)}"
                               data-selected="${escapeHtml(value)}"></custom-select>
            </div>
        `;
    }

    renderAssistantSection(assistant) {
        return `
            <div class="webmeet-robo-section" data-robo-section="generalSettings">
                <h3 class="webmeet-robo-section-title">General settings</h3>
                <p class="webmeet-robo-section-description">Common settings for the room's main Assistant.</p>
                <div class="webmeet-robo-fields">
                    <label class="webmeet-room-settings-field">
                        <span>Name <span class="webmeet-robo-required" aria-label="required">*</span></span>
                        <input type="text" data-robo-field="assistant.name" value="${escapeHtml(assistant.name)}" placeholder="Assistant name" autocomplete="off" required>
                    </label>
                    ${this.renderRoboSelect({ field: 'assistant.mode', label: 'Mode', options: ASSISTANT_MODES, value: assistant.mode, required: true })}
                    <label class="webmeet-room-settings-field">
                        <span>Instructions <span class="webmeet-robo-required" aria-label="required">*</span></span>
                        <textarea data-robo-field="assistant.instructions" rows="3" placeholder="Describe the assistant's purpose, tone, and limits" required>${escapeHtml(assistant.instructions)}</textarea>
                    </label>
                    ${this.renderRoboSelect({ field: 'assistant.scenarioOrObjective', label: 'Scenario / Objective', options: SCENARIO_OPTIONS, value: assistant.scenarioOrObjective, required: true })}
                </div>
            </div>
        `;
    }

    renderFeatureSection({ key, title, description, enabled, content }) {
        return `
            <div class="webmeet-robo-section" data-robo-section="${escapeHtml(key)}">
                <div class="webmeet-robo-section-header">
                    <div class="webmeet-robo-section-header-text">
                        <h3 class="webmeet-robo-section-title">${escapeHtml(title)}</h3>
                        <p class="webmeet-robo-section-description">${escapeHtml(description)}</p>
                    </div>
                    <label class="webmeet-robo-toggle-label">
                        <input type="checkbox" data-robo-toggle="${escapeHtml(key)}.enabled"${enabled ? ' checked' : ''}>
                        <span>Enable</span>
                    </label>
                </div>
                <div class="webmeet-robo-fields">
                    ${content}
                </div>
            </div>
        `;
    }

    renderMeetingNotesFields(notes) {
        return `
            <label class="webmeet-room-settings-field">
                <span>Document structure <span class="webmeet-robo-required" aria-label="required">*</span></span>
                <textarea data-robo-field="meetingNotes.structurePrompt" rows="9" placeholder="Describe the title and chapters to maintain" required>${escapeHtml(notes.structurePrompt)}</textarea>
            </label>
        `;
    }

    renderBlackboardFields(bb) {
        return `
            ${this.renderRoboSelect({ field: 'blackboard.visibility', label: 'Visibility', options: BLACKBOARD_VISIBILITY_OPTIONS, value: bb.visibility, required: true })}
            <label class="webmeet-robo-toggle-row">
                <input type="checkbox" data-robo-toggle="blackboard.autoUpdateFromConversation"${bb.autoUpdateFromConversation ? ' checked' : ''}>
                <span>Auto-update from conversation</span>
            </label>
            <label class="webmeet-robo-toggle-row">
                <input type="checkbox" data-robo-toggle="blackboard.participantRequestsEnabled"${bb.participantRequestsEnabled ? ' checked' : ''}>
                <span>Allow participant requests</span>
            </label>
        `;
    }

    renderDocumentBuilderFields(doc) {
        return `
            ${this.renderRoboSelect({ field: 'documentBuilder.purpose', label: 'Purpose', options: DOCUMENT_PURPOSE_OPTIONS, value: doc.purpose, required: true })}
            <label class="webmeet-room-settings-field">
                <span>Structure instructions <span class="webmeet-robo-required" aria-label="required">*</span></span>
                <textarea data-robo-field="documentBuilder.structureInstructions" rows="3" placeholder="Describe sections, order, detail level" required>${escapeHtml(doc.structureInstructions)}</textarea>
            </label>
            ${this.renderRoboSelect({ field: 'documentBuilder.toneInstructions', label: 'Tone', options: DOCUMENT_TONE_OPTIONS, value: doc.toneInstructions, required: true })}
            <label class="webmeet-robo-toggle-row">
                <input type="checkbox" data-robo-toggle="documentBuilder.participantCorrectionsEnabled"${doc.participantCorrectionsEnabled ? ' checked' : ''}>
                <span>Allow participant corrections</span>
            </label>
            <label class="webmeet-robo-toggle-row is-locked">
                <input type="checkbox" checked disabled>
                <span>Require approval before export <span class="webmeet-robo-locked-badge">Locked on</span></span>
            </label>
        `;
    }

    renderModerationFields(mod) {
        return `
            <label class="webmeet-room-settings-field">
                <span>Rules <span class="webmeet-robo-required" aria-label="required">*</span></span>
                <textarea data-robo-field="moderation.rules" rows="3" placeholder="Participation rules, behavior, intervention triggers" required>${escapeHtml(mod.rules)}</textarea>
            </label>
            <label class="webmeet-robo-toggle-row">
                <input type="checkbox" data-robo-toggle="moderation.speakingOrderEnabled"${mod.speakingOrderEnabled ? ' checked' : ''}>
                <span>Manage speaking order</span>
            </label>
            <label class="webmeet-robo-toggle-row">
                <input type="checkbox" data-robo-toggle="moderation.speakingTimeLimitEnabled"${mod.speakingTimeLimitEnabled ? ' checked' : ''}>
                <span>Speaking time limit</span>
            </label>
            <div class="webmeet-robo-inline-field" data-robo-conditional="moderation.speakingTimeLimitEnabled"${mod.speakingTimeLimitEnabled ? '' : ' hidden'}>
                <label class="webmeet-room-settings-field">
                    <span>Time limit (minutes) <span class="webmeet-robo-required" aria-label="required">*</span></span>
                    <input type="number" data-robo-field="moderation.speakingTimeLimitMinutes" value="${mod.speakingTimeLimitMinutes}" min="1" max="60" required>
                </label>
            </div>
            <label class="webmeet-robo-toggle-row">
                <input type="checkbox" data-robo-toggle="moderation.microphoneControlAllowed"${mod.microphoneControlAllowed ? ' checked' : ''}>
                <span>Allow microphone control</span>
            </label>
            <label class="webmeet-robo-toggle-row is-locked">
                <input type="checkbox" checked disabled>
                <span>Require approval for sensitive actions <span class="webmeet-robo-locked-badge">Locked on</span></span>
            </label>
        `;
    }

    renderBotsFields(bots) {
        return `
            <div class="webmeet-robo-field-group">
                <span class="webmeet-robo-field-group-label">Allowed roles <span class="webmeet-robo-required" aria-label="required">*</span></span>
                <div class="webmeet-robo-checklist">
                    ${BOT_ROLES.map((opt) => `
                        <label class="webmeet-robo-check-item">
                            <input type="checkbox" data-robo-check="bots.allowedRoles" value="${escapeHtml(opt.value)}"${bots.allowedRoles.includes(opt.value) ? ' checked' : ''}>
                            <span>${escapeHtml(opt.label)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
            <label class="webmeet-room-settings-field">
                <span>Role instructions <span class="webmeet-robo-required" aria-label="required">*</span></span>
                <textarea data-robo-field="bots.roleInstructions" rows="3" placeholder="What roles should do and how to interact" required>${escapeHtml(bots.roleInstructions)}</textarea>
            </label>
            <label class="webmeet-room-settings-field">
                <span>Personality & objectives <span class="webmeet-robo-required" aria-label="required">*</span></span>
                <textarea data-robo-field="bots.personalityAndObjectives" rows="3" placeholder="Personality, objectives, and limits" required>${escapeHtml(bots.personalityAndObjectives)}</textarea>
            </label>
            <label class="webmeet-robo-toggle-row is-locked">
                <input type="checkbox" checked disabled>
                <span>Require organizer approval <span class="webmeet-robo-locked-badge">Locked on</span></span>
            </label>
        `;
    }

    renderAdaptationFields(adapt) {
        return `
            <label class="webmeet-robo-toggle-row">
                <input type="checkbox" data-robo-toggle="adaptation.participantRequestsEnabled"${adapt.participantRequestsEnabled ? ' checked' : ''}>
                <span>Allow participant requests</span>
            </label>
            <label class="webmeet-robo-toggle-row">
                <input type="checkbox" data-robo-toggle="adaptation.silenceAsAcceptanceForMinorChanges"${adapt.silenceAsAcceptanceForMinorChanges ? ' checked' : ''}>
                <span>Treat silence as acceptance for minor changes</span>
            </label>
            <label class="webmeet-robo-toggle-row is-locked">
                <input type="checkbox" checked disabled>
                <span>Require explicit approval for sensitive actions <span class="webmeet-robo-locked-badge">Locked on</span></span>
            </label>
        `;
    }
}
