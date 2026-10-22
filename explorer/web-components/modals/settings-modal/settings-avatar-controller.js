import { registerRuntimeComponent } from "../../../utils/pluginUtils.ui.js";
import {
    callExplorerTool,
    parseToolResult
} from "../../../services/infrastructure/explorerApi.js";
import {
    ensureAxiFaceLoaded,
    getCurrentProfileAvatar,
    loadAxiFaceGeneratedFacePalettes,
    loadAxiFaceGeneratedFaceStyles,
    loadAxiFacePacks,
    normalizeAvatarConfig,
    saveCurrentProfileAvatar
} from "../../../services/profile-avatar-client.js";

let avatarSettingsComponentPromise = null;

const AVATAR_SETTINGS_VISIBLE_SOURCE_MODES = Object.freeze(['generated', 'pack']);
const AVATAR_SETTINGS_HIDDEN_FIELDS = Object.freeze([
    'seed',
    'assetMode',
    'mode',
    'thoughtMode',
    'thought',
    'animated',
    'listen',
    'complexity',
    'src',
    'theme'
]);

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

async function fetchText(url, description) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
        throw new Error(`${description} (${response.status})`);
    }
    return response.text();
}

function getSharedAvatarSettingsComponentBaseUrl() {
    return '/explorer/shared/ui/avatar-settings-form/avatar-settings-form';
}

async function ensureAvatarSettingsFormRegistered() {
    if (avatarSettingsComponentPromise) return avatarSettingsComponentPromise;
    avatarSettingsComponentPromise = (async () => {
        const baseUrl = getSharedAvatarSettingsComponentBaseUrl();
        const [template, css, module] = await Promise.all([
            fetchText(`${baseUrl}.html`, 'Failed to load avatar settings template'),
            fetchText(`${baseUrl}.css`, 'Failed to load avatar settings stylesheet'),
            import(`${baseUrl}.js?cacheBust=${Date.now()}`)
        ]);
        await registerRuntimeComponent(assistOS.webSkel, {
            name: 'avatar-settings-form',
            type: 'components',
            loadedTemplate: template,
            loadedCSSs: [css],
            presenterClassName: 'AvatarSettingsForm',
            presenterModule: module
        });
    })().catch((error) => {
        avatarSettingsComponentPromise = null;
        throw error;
    });
    return avatarSettingsComponentPromise;
}

export function defaultAvatarConfig(id, size = '72') {
    return {
        agentId: id,
        generated: true,
        src: '',
        packSrc: '',
        assetMode: 'img',
        emotion: 'neutral',
        expressionMode: 'audio',
        size,
        thought: '',
        thoughtMode: 'none',
        mode: 'static',
        shape: 'circle',
        theme: 'auto',
        animated: true,
        listen: false,
        seed: id,
        style: 'robot-soft',
        palette: 'default',
        complexity: ''
    };
}

export const avatarController = {
    switchAvatarTab(_target, tab) {
        const normalizedTab = tab === 'agent' && this.state.canManageAgentAvatars ? 'agent' : 'profile';
        this.state.activeAvatarTab = normalizedTab;
        this.renderAvatarSettings();
    },

    async callAvatarSettingsTool(name, args = {}) {
        const payload = await callExplorerTool(name, args, { raw: true, withLoader: false });
        const parsed = parseToolResult(payload) || {};
        if (parsed.ok === false) {
            throw new Error(parsed.error || "Avatar settings request failed.");
        }
        return parsed;
    },

    async loadAvatarSettingsData() {
        this.state.avatarStatus = "Loading avatar settings...";
        this.state.avatarStatusType = "";
        this.renderAvatarSettings();
        await ensureAvatarSettingsFormRegistered();
        const [me, generatedStyles, generatedPalettes, packs] = await Promise.all([
            getCurrentProfileAvatar({ force: true }),
            loadAxiFaceGeneratedFaceStyles().catch(() => []),
            loadAxiFaceGeneratedFacePalettes().catch(() => []),
            loadAxiFacePacks().catch(() => [])
        ]);
        await ensureAxiFaceLoaded();
        this.state.axiFaceGeneratedFaceStyles = generatedStyles;
        this.state.axiFaceGeneratedFacePalettes = generatedPalettes;
        this.state.axiFacePacks = packs;
        this.state.avatarUser = me.user || null;
        this.state.canManageAgentAvatars = Boolean(me.user?.canManageAgents);
        this.state.profileAvatar = normalizeAvatarConfig(me.config, me.config?.agentId || `profile:${me.user?.id || 'current-user'}`);
        this.state.profileAvatarEnabled = me.enabled !== false;
        this.state.profileAvatarSource = me.source || null;
        const agentsPayload = await this.callAvatarSettingsTool('get_avatar_settings_agents').catch(() => ({
            canManageAgents: false,
            agents: []
        }));
        this.state.canManageAgentAvatars = Boolean(agentsPayload.canManageAgents);
        this.state.agentAvatarItems = Array.isArray(agentsPayload.agents) ? agentsPayload.agents : [];
        const selectedAgent = this.state.agentAvatarItems.find((item) => item.id === this.state.selectedAvatarAgentId)
            || this.state.agentAvatarItems[0]
            || null;
        this.state.selectedAvatarAgentId = selectedAgent?.id || "";
        this.state.selectedAgentAvatar = normalizeAvatarConfig(selectedAgent?.config, selectedAgent?.id || 'agent');
        this.state.selectedAgentAvatarEnabled = selectedAgent?.enabled !== false;
        this.state.avatarDataLoaded = true;
        this.state.avatarStatus = "Avatar settings loaded.";
        this.state.avatarStatusType = "";
        this.renderAvatarSettings();
    },

    renderAvatarSettings() {
        this.renderAvatarStatus();
        this.renderAvatarControls('profile');
        this.renderAvatarControls('agent');
        this.renderAvatarAgentList();
        this.renderAvatarTabs();
        if (this.agentAvatarCardEl) {
            this.agentAvatarCardEl.hidden = !this.state.canManageAgentAvatars || this.state.activeAvatarTab !== 'agent';
        }
        if (this.agentAvatarEnabledInput) {
            this.agentAvatarEnabledInput.checked = Boolean(this.state.selectedAgentAvatarEnabled);
            this.agentAvatarEnabledInput.disabled = this.state.avatarBusy || !this.state.canManageAgentAvatars || !this.state.selectedAvatarAgentId;
        }
        if (this.profileAvatarEnabledInput) {
            this.profileAvatarEnabledInput.checked = Boolean(this.state.profileAvatarEnabled);
            this.profileAvatarEnabledInput.disabled = this.state.avatarBusy;
        }
        if (this.saveProfileAvatarButton) {
            this.saveProfileAvatarButton.disabled = this.state.avatarBusy;
        }
        if (this.saveAgentAvatarButton) {
            this.saveAgentAvatarButton.disabled = this.state.avatarBusy || !this.state.canManageAgentAvatars || !this.state.selectedAvatarAgentId;
        }
    },

    renderAvatarTabs() {
        const canManageAgentAvatars = Boolean(this.state.canManageAgentAvatars);
        if (!canManageAgentAvatars && this.state.activeAvatarTab === 'agent') {
            this.state.activeAvatarTab = 'profile';
        }
        for (const tab of this.avatarSubtabEls || []) {
            const key = String(tab.dataset.avatarTab || '').trim();
            const isAgentTab = key === 'agent';
            const active = key === this.state.activeAvatarTab;
            tab.hidden = isAgentTab && !canManageAgentAvatars;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        }
        for (const panel of this.avatarPanelEls || []) {
            const key = String(panel.dataset.avatarPanel || '').trim();
            const shouldShow = key === this.state.activeAvatarTab && (key !== 'agent' || canManageAgentAvatars);
            panel.hidden = !shouldShow;
        }
    },

    renderAvatarStatus() {
        if (!this.avatarSettingsStatusEl) return;
        this.avatarSettingsStatusEl.textContent = this.state.avatarStatus || "";
        this.avatarSettingsStatusEl.classList.toggle("error", this.state.avatarStatusType === "error");
    },

    renderAvatarControls(scope) {
        const container = scope === 'profile' ? this.profileAvatarControlsEl : this.agentAvatarControlsEl;
        if (!container) return;
        const config = scope === 'profile' ? this.state.profileAvatar : this.state.selectedAgentAvatar;
        const hasAgentSelection = Boolean(this.state.selectedAvatarAgentId);
        container.webSkelPresenter?.setData?.({
            value: config,
            packs: this.state.axiFacePacks,
            generatedStyles: this.state.axiFaceGeneratedFaceStyles,
            palettes: this.state.axiFaceGeneratedFacePalettes,
            hiddenFields: AVATAR_SETTINGS_HIDDEN_FIELDS,
            sourceModes: AVATAR_SETTINGS_VISIBLE_SOURCE_MODES,
            disabled: this.state.avatarBusy || (scope === 'agent' && (!this.state.canManageAgentAvatars || !this.state.selectedAvatarAgentId)),
            showPreview: true,
            previewEnabled: scope === 'profile' ? this.state.profileAvatarEnabled : hasAgentSelection,
            previewFallback: scope === 'profile' ? (this.state.avatarUser?.username?.[0] || '?') : ''
        });
    },

    renderAvatarAgentList() {
        if (!this.avatarAgentListEl) return;
        if (!this.state.agentAvatarItems.length) {
            this.avatarAgentListEl.innerHTML = `<div class="plugin-settings-empty">No AI agents found in manifest.</div>`;
            return;
        }
        this.avatarAgentListEl.innerHTML = this.state.agentAvatarItems.map((item) => `
            <button
                type="button"
                class="avatar-agent-button ${item.id === this.state.selectedAvatarAgentId ? 'active' : ''} ${item.missing ? 'missing' : ''}"
                data-local-action="selectAvatarAgent ${escapeHtml(item.id)}"
            >
                ${escapeHtml(item.label || item.id)}${item.missing ? ' (missing)' : ''}
            </button>
        `).join("");
    },

    readAvatarControls(scope) {
        const container = scope === 'profile' ? this.profileAvatarControlsEl : this.agentAvatarControlsEl;
        const current = scope === 'profile' ? this.state.profileAvatar : this.state.selectedAgentAvatar;
        const next = container?.webSkelPresenter?.getConfig?.() || current;
        return normalizeAvatarConfig({
            ...next,
            agentId: current.agentId,
            seed: next.seed || current.seed || current.agentId
        }, current.agentId);
    },

    handleAvatarControlsInput(scope, event = null) {
        const nextConfig = event?.detail?.config || this.readAvatarControls(scope);
        if (scope === 'profile') {
            this.state.profileAvatar = normalizeAvatarConfig({
                ...nextConfig,
                agentId: this.state.profileAvatar.agentId,
                seed: nextConfig.seed || this.state.profileAvatar.seed || this.state.profileAvatar.agentId
            }, this.state.profileAvatar.agentId);
        } else {
            this.state.selectedAgentAvatar = normalizeAvatarConfig({
                ...nextConfig,
                agentId: this.state.selectedAgentAvatar.agentId,
                seed: nextConfig.seed || this.state.selectedAgentAvatar.seed || this.state.selectedAgentAvatar.agentId
            }, this.state.selectedAgentAvatar.agentId);
        }
    },

    renderAvatarPreviews() {
        this.profileAvatarControlsEl?.webSkelPresenter?.renderPreview?.({
            enabled: this.state.profileAvatarEnabled,
            fallback: this.state.avatarUser?.username?.[0] || '?'
        });
        this.agentAvatarControlsEl?.webSkelPresenter?.renderPreview?.({
            enabled: Boolean(this.state.selectedAvatarAgentId)
        });
    },

    selectAvatarAgent(_target, agentId) {
        const item = this.state.agentAvatarItems.find((entry) => entry.id === agentId);
        if (!item) return;
        this.state.selectedAvatarAgentId = item.id;
        this.state.selectedAgentAvatar = normalizeAvatarConfig(item.config, item.id);
        this.state.selectedAgentAvatarEnabled = item.enabled !== false;
        this.renderAvatarSettings();
    },

    async saveProfileAvatar() {
        if (this.state.avatarBusy) return;
        this.state.avatarBusy = true;
        try {
            this.state.profileAvatar = this.readAvatarControls('profile');
            this.state.avatarStatus = "Saving profile avatar...";
            this.state.avatarStatusType = "";
            this.renderAvatarSettings();
            const payload = await saveCurrentProfileAvatar({
                enabled: this.state.profileAvatarEnabled,
                config: this.state.profileAvatar
            });
            this.state.profileAvatar = normalizeAvatarConfig(payload.config, this.state.profileAvatar.agentId);
            this.state.profileAvatarEnabled = payload.enabled !== false;
            this.state.profileAvatarSource = payload.source || null;
            this.state.avatarStatus = "Profile avatar saved in this browser.";
            this.state.avatarStatusType = "";
            await (assistOS.showToast || assistOS.UI?.showToast)?.("Profile avatar saved.", "success", 2500);
        } catch (error) {
            this.state.avatarStatus = error?.message || "Failed to save profile avatar.";
            this.state.avatarStatusType = "error";
        } finally {
            this.state.avatarBusy = false;
            this.renderAvatarSettings();
        }
    },

    async saveAgentAvatar() {
        if (this.state.avatarBusy || !this.state.selectedAvatarAgentId) return;
        this.state.avatarBusy = true;
        try {
            this.state.selectedAgentAvatar = this.readAvatarControls('agent');
            this.state.avatarStatus = `Saving ${this.state.selectedAvatarAgentId} avatar...`;
            this.state.avatarStatusType = "";
            this.renderAvatarSettings();
            await this.callAvatarSettingsTool('update_avatar_settings_agent', {
                agentId: this.state.selectedAvatarAgentId,
                config: this.state.selectedAgentAvatar
            });
            await this.callAvatarSettingsTool('set_avatar_settings_agent_visibility', {
                agentId: this.state.selectedAvatarAgentId,
                enabled: this.state.selectedAgentAvatarEnabled
            });
            this.state.avatarStatus = `${this.state.selectedAvatarAgentId} avatar saved.`;
            this.state.avatarStatusType = "";
            this.state.avatarDataLoaded = false;
            window.dispatchEvent(new CustomEvent('assistOS:avatar-settings-updated', {
                detail: { type: 'agent', agentId: this.state.selectedAvatarAgentId, config: this.state.selectedAgentAvatar }
            }));
            await this.loadAvatarSettingsData();
        } catch (error) {
            this.state.avatarStatus = error?.message || "Failed to save agent avatar.";
            this.state.avatarStatusType = "error";
        } finally {
            this.state.avatarBusy = false;
            this.renderAvatarSettings();
        }
    }
};
