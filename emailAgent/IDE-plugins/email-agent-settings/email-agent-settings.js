import {
    callAgentTool,
    ensureSuccess,
    parseToolResult
} from "/explorer/services/infrastructure/explorerApi.js";

const SECRET_KEYS = new Set(["MAILJET_API_KEY", "MAILJET_API_SECRET"]);
const SETTING_KEYS = [
    "MAILJET_API_KEY",
    "MAILJET_API_SECRET",
    "MAILJET_FROM_EMAIL",
    "MAILJET_FROM_NAME",
    "EMAIL_AUTH_CODE_TEMPLATE_ID"
];

async function callEmailTool(name, args = {}) {
    const raw = await callAgentTool("emailAgent", name, args, { raw: true });
    ensureSuccess(raw);
    const parsed = parseToolResult(raw) || {};
    if (parsed?.ok === false || parsed?.error) {
        throw new Error(parsed.error || `${name} failed.`);
    }
    return parsed;
}

function settingValue(settings, key) {
    return String(settings?.[key] || "");
}

export class EmailAgentSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = { status: "", statusType: "", settings: {} };
        this.settingsRequestId = 0;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        void this.loadSettings();
    }

    cacheElements() {
        this.statusEl = this.element.querySelector("#emailAgentSettingsStatus");
        this.testRecipientInput = this.element.querySelector("#emailTestRecipient");
        this.inputs = {
            MAILJET_API_KEY: this.element.querySelector("#mailjetApiKey"),
            MAILJET_API_SECRET: this.element.querySelector("#mailjetApiSecret"),
            MAILJET_FROM_EMAIL: this.element.querySelector("#mailjetFromEmail"),
            MAILJET_FROM_NAME: this.element.querySelector("#mailjetFromName"),
            EMAIL_AUTH_CODE_TEMPLATE_ID: this.element.querySelector("#emailAuthCodeTemplateId")
        };
        for (const key of SECRET_KEYS) {
            const input = this.inputs[key];
            if (!input) continue;
            input.value = "";
            input.placeholder = "Leave unchanged";
            input.autocomplete = "off";
        }
    }

    setStatus(message, type = "") {
        this.state.status = message || "";
        this.state.statusType = type || "";
        if (!this.statusEl) return;
        this.statusEl.textContent = this.state.status;
        this.statusEl.classList.toggle("error", this.state.statusType === "error");
    }

    applySettings(payload = {}) {
        const settings = payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
        this.state.settings = settings || {};
        for (const key of SETTING_KEYS) {
            const value = settingValue(this.state.settings, key);
            const input = this.inputs[key];
            const mask = this.element.querySelector(`[data-mask-for="${key}"]`);
            if (mask) {
                mask.textContent = value ? `Current: ${value}` : "Not configured";
            }
            if (!input) continue;
            if (SECRET_KEYS.has(key)) {
                input.value = "";
                input.placeholder = "Leave unchanged";
            } else {
                input.value = value;
            }
        }
    }

    async loadSettings() {
        const requestId = ++this.settingsRequestId;
        try {
            const payload = await callEmailTool("email_config_get");
            if (requestId !== this.settingsRequestId) return;
            this.applySettings(payload);
            this.setStatus("");
        } catch (error) {
            if (requestId !== this.settingsRequestId) return;
            this.setStatus(error?.message || "Failed to load EmailAgent settings.", "error");
        }
    }

    collectSettingsPatch() {
        const patch = {};
        for (const [key, input] of Object.entries(this.inputs || {})) {
            const value = String(input?.value || "").trim();
            if (!value) continue;
            patch[key] = value;
        }
        return patch;
    }

    async saveSettings() {
        const patch = this.collectSettingsPatch();
        if (!Object.keys(patch).length) {
            this.setStatus("Enter at least one setting to save.");
            return;
        }
        const requestId = ++this.settingsRequestId;
        try {
            const payload = await callEmailTool("email_config_set", patch);
            if (requestId !== this.settingsRequestId) return;
            this.applySettings(payload);
            this.setStatus("EmailAgent settings saved.");
        } catch (error) {
            if (requestId !== this.settingsRequestId) return;
            this.setStatus(error?.message || "Failed to save EmailAgent settings.", "error");
        }
    }

    async removeSecret(_target, key) {
        const settingKey = String(key || "").trim();
        if (!SECRET_KEYS.has(settingKey)) return;
        const requestId = ++this.settingsRequestId;
        try {
            const payload = await callEmailTool("email_config_set", { remove: [settingKey] });
            if (requestId !== this.settingsRequestId) return;
            this.applySettings(payload);
            this.setStatus("Secret removed.");
        } catch (error) {
            if (requestId !== this.settingsRequestId) return;
            this.setStatus(error?.message || "Failed to remove secret.", "error");
        }
    }

    async testConfiguration() {
        try {
            const patch = this.collectSettingsPatch();
            if (Object.keys(patch).length) {
                this.applySettings(await callEmailTool("email_config_set", patch));
            }
            const status = await callEmailTool("email_provider_status");
            if (!status.configured) {
                this.setStatus("Missing required Mailjet settings.", "error");
                return;
            }
            const to = String(this.testRecipientInput?.value || "").trim();
            if (!to) {
                this.setStatus("EmailAgent configuration is complete.");
                return;
            }
            await callEmailTool("email_send_test", { to });
            this.setStatus("Test email sent.");
        } catch (error) {
            this.setStatus(error?.message || "Configuration test failed.", "error");
        }
    }

    closeModal() {
        assistOS.UI.closeModal(this.element, null);
    }
}
