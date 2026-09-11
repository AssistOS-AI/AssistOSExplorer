import {
    getKeymap,
    setKeymap,
    getDefaultKeymap,
    getKeymapActions,
    eventToShortcut,
    formatShortcutForDisplay,
    normalizeShortcutString
} from "../../../utils/keymap.js";
import { getCurrentTheme, setTheme } from "../../../shared/ui/theme.js";
import {
    applyAgentRuntimeStatuses,
    buildAgentSettingsItems,
    normalizeAgentRuntimeStatus
} from "./settings-agent-model.js";
import {
    openPluginSettingsUrl,
    resolvePluginSettingsUrl,
    resolveSettingsComponentBase
} from "./settings-component-loader.js";
import { avatarController, defaultAvatarConfig } from "./settings-avatar-controller.js";
import { copilotController } from "./settings-copilot-controller.js";
import { runtimeSettingsController } from "./settings-runtime-controller.js";
import { accountController } from "./settings-account-controller.js";
import { usersController } from "./settings-users-controller.js";

const BASE_TABS = ['account', 'agents', 'plugins', 'copilot', 'keymap', 'editor', 'theme', 'avatar'];

export {
    applyAgentRuntimeStatuses,
    buildAgentSettingsItems,
    normalizeAgentRuntimeStatus,
    openPluginSettingsUrl,
    resolvePluginSettingsUrl,
    resolveSettingsComponentBase
};

export class SettingsModal {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.invalidate = invalidate;
        this.props = props || {};
        const initialTab = [...BASE_TABS, 'users'].includes(this.props.tab) ? this.props.tab : 'agents';
        this.requestedInitialTab = initialTab;
        this.state = {
            activeTab: initialTab,
            selectedTheme: this.props.theme === "dark" ? "dark" : getCurrentTheme(),
            keymap: { ...(this.props.keymap || getKeymap()) },
            editorAutoSaveEnabled: Boolean(this.props.editorAutoSaveEnabled),
            editorAutoSaveIntervalSeconds: Number.isFinite(this.props.editorAutoSaveIntervalSeconds)
                ? Math.max(1, Math.round(this.props.editorAutoSaveIntervalSeconds))
                : 10,
            hasConflicts: false,
            pluginItems: [],
            pluginSettings: {},
            pluginBusyActionKey: "",
            pluginStatus: "",
            pluginStatusType: "",
            pluginDataLoaded: false,
            agentSettingsRaw: [],
            agentSettingsItems: [],
            agentSettingsStatus: "",
            agentSettingsStatusType: "",
            agentSettingsDataLoaded: false,
            agentSettingsBusyKey: "",
            agentRuntimeStatusRequestId: 0,
            copilotItems: [],
            copilotBusy: false,
            copilotPolicyVersion: null,
            copilotDiagnostics: [],
            copilotStatus: "",
            copilotStatusType: "",
            copilotDataLoaded: false,
            avatarDataLoaded: false,
            avatarStatus: "",
            avatarStatusType: "",
            avatarBusy: false,
            avatarUser: null,
            profileAvatar: defaultAvatarConfig('profile:current-user', '72'),
            profileAvatarEnabled: true,
            profileAvatarSource: null,
            activeAvatarTab: 'profile',
            axiFacePacks: [],
            axiFaceGeneratedFaceStyles: [],
            axiFaceGeneratedFacePalettes: [],
            agentAvatarItems: [],
            selectedAvatarAgentId: "",
            selectedAgentAvatar: defaultAvatarConfig('agent', '72'),
            selectedAgentAvatarEnabled: true,
            canManageAgentAvatars: false,
            usersAccessChecked: false,
            usersAccess: false,
            activeAdministrationTab: 'users'
        };
        this.invalidate();
    }

    beforeRender() {}

    async afterRender() {
        this.cacheElements();
        this.updateTabUI();
        this.renderRows();
        this.renderPluginSettings();
        this.renderAgentSettings();
        this.updateThemeSelection();
        this.bindEvents();
        this.refreshUsersAccess();
        if (this.state.activeTab === "plugins" && !this.state.pluginDataLoaded) {
            await this.loadPluginSettingsData();
        }
        if (this.state.activeTab === "agents" && !this.state.agentSettingsDataLoaded) {
            await this.loadAgentSettingsData();
        }
        if (this.state.activeTab === "copilot" && !this.state.copilotDataLoaded) {
            await this.loadCopilotSettingsData();
        }
        if (this.state.activeTab === "avatar" && !this.state.avatarDataLoaded) {
            await this.loadAvatarSettingsData();
        }
    }

    cacheElements() {
        this.keymapSection = this.element.querySelector('[data-section="keymap"]');
        this.editorSection = this.element.querySelector('[data-section="editor"]');
        this.themeSection = this.element.querySelector('[data-section="theme"]');
        this.pluginsSection = this.element.querySelector('[data-section="plugins"]');
        this.agentsSection = this.element.querySelector('[data-section="agents"]');
        this.copilotSection = this.element.querySelector('[data-section="copilot"]');
        this.avatarSection = this.element.querySelector('[data-section="avatar"]');
        this.accountSection = this.element.querySelector('[data-section="account"]');
        this.usersSection = this.element.querySelector('[data-section="users"]');
        this.applicationsSection = this.element.querySelector('[data-administration-panel="applications"]');
        this.usersTab = this.element.querySelector('[data-admin-tab]');
        this.adminSettingsPanel = this.element.querySelector('admin-settings-panel');
        this.listEl = this.element.querySelector("#keymapList");
        this.warningEl = this.element.querySelector("#keymapWarning");
        this.pluginSettingsListEl = this.element.querySelector("#pluginSettingsList");
        this.pluginSettingsStatusEl = this.element.querySelector("#pluginSettingsStatus");
        this.agentSettingsListEl = this.element.querySelector("#agentSettingsList");
        this.agentSettingsStatusEl = this.element.querySelector("#agentSettingsStatus");
        this.copilotSettingsListEl = this.element.querySelector("#copilotSettingsList");
        this.copilotSettingsStatusEl = this.element.querySelector("#copilotSettingsStatus");
        this.avatarSettingsStatusEl = this.element.querySelector("#avatarSettingsStatus");
        this.profileAvatarControlsEl = this.element.querySelector('avatar-settings-form[data-avatar-scope="profile"]');
        this.agentAvatarControlsEl = this.element.querySelector('avatar-settings-form[data-avatar-scope="agent"]');
        this.avatarSubtabEls = Array.from(this.element.querySelectorAll('[data-avatar-tab]'));
        this.avatarPanelEls = Array.from(this.element.querySelectorAll('[data-avatar-panel]'));
        this.agentAvatarCardEl = this.element.querySelector("#agentAvatarCard");
        this.avatarAgentListEl = this.element.querySelector("#avatarAgentList");
        this.profileAvatarEnabledInput = this.element.querySelector("#profileAvatarEnabled");
        this.agentAvatarEnabledInput = this.element.querySelector("#agentAvatarEnabled");
        this.saveProfileAvatarButton = this.element.querySelector("#saveProfileAvatarButton");
        this.saveAgentAvatarButton = this.element.querySelector("#saveAgentAvatarButton");
        this.editorAutoSaveEnabledInput = this.element.querySelector('#editorAutoSaveEnabled');
        this.editorAutoSaveIntervalInput = this.element.querySelector('#editorAutoSaveIntervalSeconds');
        this.actionsEl = this.element.querySelector('.modal-actions');
        this.saveButton = this.element.querySelector('[data-local-action="saveSettings"]');
        this.resetButton = this.element.querySelector('[data-role="reset-keymap"]');
    }

    bindEvents() {
        if (!this.element.dataset.boundSettingsModal) {
            this.element.addEventListener("keydown", (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    this.closeModal();
                }
            });
            this.element.dataset.boundSettingsModal = "true";
        }
        if (this.editorAutoSaveEnabledInput && !this.editorAutoSaveEnabledInput.dataset.bound) {
            this.editorAutoSaveEnabledInput.addEventListener('change', () => this.handleEditorAutoSaveToggle());
            this.editorAutoSaveEnabledInput.dataset.bound = 'true';
        }
        if (this.editorAutoSaveIntervalInput && !this.editorAutoSaveIntervalInput.dataset.bound) {
            this.editorAutoSaveIntervalInput.addEventListener('input', () => this.handleEditorAutoSaveIntervalInput());
            this.editorAutoSaveIntervalInput.dataset.bound = 'true';
        }
        if (this.profileAvatarControlsEl && !this.profileAvatarControlsEl.dataset.bound) {
            this.profileAvatarControlsEl.addEventListener('avatar-settings-change', (event) => this.handleAvatarControlsInput('profile', event));
            this.profileAvatarControlsEl.dataset.bound = 'true';
        }
        if (this.agentAvatarControlsEl && !this.agentAvatarControlsEl.dataset.bound) {
            this.agentAvatarControlsEl.addEventListener('avatar-settings-change', (event) => this.handleAvatarControlsInput('agent', event));
            this.agentAvatarControlsEl.dataset.bound = 'true';
        }
        if (this.agentAvatarEnabledInput && !this.agentAvatarEnabledInput.dataset.bound) {
            this.agentAvatarEnabledInput.addEventListener('change', () => {
                this.state.selectedAgentAvatarEnabled = Boolean(this.agentAvatarEnabledInput.checked);
            });
            this.agentAvatarEnabledInput.dataset.bound = 'true';
        }
        if (this.profileAvatarEnabledInput && !this.profileAvatarEnabledInput.dataset.bound) {
            this.profileAvatarEnabledInput.addEventListener('change', () => {
                this.state.profileAvatarEnabled = Boolean(this.profileAvatarEnabledInput.checked);
                this.renderAvatarPreviews();
            });
            this.profileAvatarEnabledInput.dataset.bound = 'true';
        }
    }

    switchAvatarTab(_target, tab) {
        const normalizedTab = tab === 'agent' && this.state.canManageAgentAvatars ? 'agent' : 'profile';
        this.state.activeAvatarTab = normalizedTab;
        this.renderAvatarSettings();
    }

    switchTab(_target, tab) {
        this.requestedInitialTab = '';
        const allowedTabs = this.getAllowedTabs();
        this.state.activeTab = allowedTabs.includes(tab) ? tab : 'agents';
        this.updateTabUI();
        if (this.state.activeTab === "plugins" && !this.state.pluginDataLoaded) {
            this.loadPluginSettingsData().catch((error) => {
                this.state.pluginStatus = error?.message || "Failed to load plugin settings.";
                this.state.pluginStatusType = "error";
                this.renderPluginSettingsStatus();
            });
        }
        if (this.state.activeTab === "agents") {
            if (!this.state.agentSettingsDataLoaded) {
                this.loadAgentSettingsData().catch((error) => {
                    this.state.agentSettingsStatus = error?.message || "Failed to load agent settings.";
                    this.state.agentSettingsStatusType = "error";
                    this.renderAgentSettingsStatus();
                });
            } else {
                void this.refreshAgentRuntimeStatuses();
            }
        }
        if (this.state.activeTab === "copilot" && !this.state.copilotDataLoaded) {
            this.loadCopilotSettingsData().catch((error) => {
                this.state.copilotStatus = error?.message || "Failed to load Copilot skills.";
                this.state.copilotStatusType = "error";
                this.renderCopilotSettingsStatus();
            });
        }
        if (this.state.activeTab === "avatar") {
            this.state.avatarDataLoaded = false;
            this.loadAvatarSettingsData().catch((error) => {
                this.state.avatarStatus = error?.message || "Failed to load avatar settings.";
                this.state.avatarStatusType = "error";
                this.renderAvatarSettings();
            });
        }
        if (this.state.activeTab === "users") {
            this.loadAdministrationPanel();
        }
    }

    getAllowedTabs() {
        return this.state.usersAccess ? [...BASE_TABS, 'users'] : BASE_TABS;
    }

    updateTabUI() {
        if (!this.getAllowedTabs().includes(this.state.activeTab)) {
            this.state.activeTab = 'agents';
        }
        this.element.dataset.activeTab = this.state.activeTab;
        const tabs = this.element.querySelectorAll(".settings-tab");
        tabs.forEach((tab) => {
            const isActive = tab.dataset.tab === this.state.activeTab;
            tab.classList.toggle("active", isActive);
            tab.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        if (this.usersTab) {
            this.usersTab.hidden = !this.state.usersAccess;
        }

        const sections = [
            { key: 'account', element: this.accountSection },
            { key: 'keymap', element: this.keymapSection },
            { key: 'editor', element: this.editorSection },
            { key: 'theme', element: this.themeSection },
            { key: 'plugins', element: this.pluginsSection },
            { key: 'agents', element: this.agentsSection },
            { key: 'copilot', element: this.copilotSection },
            { key: 'avatar', element: this.avatarSection },
            { key: 'users', element: this.usersSection }
        ];
        sections.forEach(({ key, element }) => {
            if (!element) return;
            element.classList.toggle('hidden', key !== this.state.activeTab);
        });

        if (this.resetButton) {
            this.resetButton.style.display = this.state.activeTab === "keymap" ? "" : "none";
        }
        if (this.actionsEl) {
            this.actionsEl.hidden = this.state.activeTab === "users"
                || this.state.activeTab === "avatar"
                || this.state.activeTab === "agents"
                || this.state.activeTab === "account";
        }
        this.syncEditorSettingsUi();
        this.updateAdministrationTabs();
        this.loadAdministrationPanel();
        const accountScope = this.getAccountScope();
        if (this.accountScope !== accountScope) this.unloadAccountPanel();
        if (accountScope) void this.loadAccountPanel();
    }

    renderRows() {
        if (!this.listEl) return;
        const actions = getKeymapActions();
        this.listEl.innerHTML = actions.map((action) => {
            const shortcut = this.state.keymap[action.id] || "";
            const displayValue = formatShortcutForDisplay(shortcut) || "";
            return `
                <div class="keymap-row">
                    <div class="keymap-info">
                        <div class="keymap-label">${action.label}</div>
                        <div class="keymap-meta">${action.description}</div>
                    </div>
                    <div class="keymap-input-group">
                        <input type="text" class="form-input keymap-input" data-action-id="${action.id}" value="${displayValue}" readonly>
                        <button type="button" class="gray-button keymap-clear" data-action-id="${action.id}" data-local-action="clearShortcut ${action.id}">Clear</button>
                    </div>
                </div>
            `;
        }).join("");
        this.bindRowEvents();
        this.updateConflicts();
    }

    bindRowEvents() {
        const inputs = this.element.querySelectorAll(".keymap-input");
        inputs.forEach((input) => {
            if (input.dataset.bound) return;
            input.addEventListener("keydown", (event) => {
                const actionId = event.currentTarget?.dataset?.actionId;
                if (!actionId) return;
                if (event.key === "Tab") return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") {
                    event.currentTarget.blur();
                    return;
                }
                if (event.key === "Backspace" || event.key === "Delete") {
                    this.setShortcut(actionId, "");
                    return;
                }
                const shortcut = eventToShortcut(event);
                if (!shortcut) return;
                this.setShortcut(actionId, shortcut);
            });
            input.dataset.bound = "true";
        });
    }

    clearShortcut(_target, actionId) {
        if (!actionId) return;
        this.setShortcut(actionId, "");
    }

    setShortcut(actionId, shortcut) {
        const normalized = shortcut ? normalizeShortcutString(shortcut) : "";
        this.state.keymap[actionId] = normalized;
        this.updateRowDisplay(actionId);
        this.updateConflicts();
    }

    updateRowDisplay(actionId) {
        const input = this.element.querySelector(`.keymap-input[data-action-id="${actionId}"]`);
        if (!input) return;
        const raw = this.state.keymap[actionId] || "";
        input.value = formatShortcutForDisplay(raw) || "";
    }

    updateConflicts() {
        const actions = getKeymapActions();
        const buckets = new Map();
        actions.forEach((action) => {
            const raw = this.state.keymap[action.id];
            const normalized = normalizeShortcutString(raw);
            if (!normalized) return;
            if (!buckets.has(normalized)) {
                buckets.set(normalized, []);
            }
            buckets.get(normalized).push(action.label);
        });

        const conflicts = [];
        for (const [shortcut, labels] of buckets.entries()) {
            if (labels.length > 1) {
                conflicts.push(`${formatShortcutForDisplay(shortcut)}: ${labels.join(", ")}`);
            }
        }

        this.state.hasConflicts = conflicts.length > 0;
        if (this.warningEl) {
            this.warningEl.textContent = conflicts.length
                ? `Shortcut conflicts: ${conflicts.join(" | ")}`
                : "";
        }
        if (this.saveButton) {
            this.saveButton.disabled = this.state.hasConflicts;
        }
    }

    selectTheme(_target, theme) {
        this.state.selectedTheme = theme === "dark" ? "dark" : "light";
        this.updateThemeSelection();
    }

    updateThemeSelection() {
        const options = this.element.querySelectorAll(".theme-option");
        options.forEach((option) => {
            const isActive = option.dataset.theme === this.state.selectedTheme;
            option.classList.toggle("active", isActive);
            option.setAttribute("aria-checked", isActive ? "true" : "false");
        });
    }

    syncEditorSettingsUi() {
        if (this.editorAutoSaveEnabledInput) {
            this.editorAutoSaveEnabledInput.checked = Boolean(this.state.editorAutoSaveEnabled);
        }
        if (this.editorAutoSaveIntervalInput) {
            const nextValue = String(this.state.editorAutoSaveIntervalSeconds || 10);
            if (this.editorAutoSaveIntervalInput.value !== nextValue) {
                this.editorAutoSaveIntervalInput.value = nextValue;
            }
            this.editorAutoSaveIntervalInput.disabled = !this.state.editorAutoSaveEnabled;
        }
    }

    handleEditorAutoSaveToggle() {
        this.state.editorAutoSaveEnabled = Boolean(this.editorAutoSaveEnabledInput?.checked);
        this.syncEditorSettingsUi();
    }

    handleEditorAutoSaveIntervalInput() {
        const nextValue = Number.parseInt(String(this.editorAutoSaveIntervalInput?.value ?? ''), 10);
        this.state.editorAutoSaveIntervalSeconds = Number.isFinite(nextValue) && nextValue >= 1 ? nextValue : 10;
        this.syncEditorSettingsUi();
    }

    resetDefaults() {
        this.state.keymap = { ...getDefaultKeymap() };
        this.renderRows();
    }

    saveSettings() {
        if (this.state.hasConflicts) return;
        const keymap = setKeymap(this.state.keymap);
        const theme = setTheme(this.state.selectedTheme);
        this.closeModal({
            keymap,
            theme,
            editorAutoSaveEnabled: Boolean(this.state.editorAutoSaveEnabled),
            editorAutoSaveIntervalSeconds: Number.isFinite(this.state.editorAutoSaveIntervalSeconds)
                ? Math.max(1, Math.round(this.state.editorAutoSaveIntervalSeconds))
                : 10
        });
    }

    afterUnload() {
        this.unloadAccountPanel();
        this.invalidateCopilotRequests();
    }

    closeModal(payload) {
        this.unloadAccountPanel();
        this.invalidateCopilotRequests();
        assistOS.UI.closeModal(this.element, payload);
    }
}

Object.assign(
    SettingsModal.prototype,
    runtimeSettingsController,
    copilotController,
    avatarController,
    accountController,
    usersController
);
