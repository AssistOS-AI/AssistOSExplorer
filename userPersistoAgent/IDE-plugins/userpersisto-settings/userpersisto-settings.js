import {
    callAgentTool,
    ensureSuccess,
    parseToolResult
} from "/explorer/services/infrastructure/explorerApi.js";

const PANELS = new Set(["users", "auth", "policy", "applications"]);
const SECRET_KEYS = new Set(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
const SETTING_KEYS = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_PRICE_CREDITS",
    "STRIPE_PRICE_SUBSCRIPTION",
    "USERPERSISTO_CREDITS_PER_UNIT",
    "USERPERSISTO_BILLING_SUCCESS_URL",
    "USERPERSISTO_BILLING_CANCEL_URL"
];

async function callUserPersistoTool(name, args = {}) {
    const raw = await callAgentTool("userPersistoAgent", name, args, { raw: true });
    ensureSuccess(raw);
    const parsed = parseToolResult(raw) || {};
    if (parsed?.ok === false || parsed?.error) {
        const error = new Error(parsed.error || `${name} failed.`);
        error.payload = parsed;
        throw error;
    }
    return parsed;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function settingValue(settings, key) {
    return String(settings?.[key] || "");
}

function userRoles(user = {}) {
    if (Array.isArray(user.roles) && user.roles.length) {
        return user.roles.map((role) => String(role || "").trim()).filter(Boolean);
    }
    const role = String(user.role || "").trim();
    return role ? [role] : [];
}

function primaryRole(user = {}) {
    const roles = userRoles(user);
    return roles.find((role) => ["admin", "user", "selfRegistered"].includes(role)) || roles[0] || "user";
}

export class UserpersistoSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            activePanel: "auth",
            status: "",
            statusType: "",
            settings: {},
            users: [],
            usersStart: 0,
            usersPageSize: 100,
            usersTotal: 0,
            usersLoading: false,
            authProfile: null,
            applications: [],
            applicationsStart: 0,
            applicationsPageSize: 100,
            applicationsTotal: 0,
            applicationsLoading: false,
            applicationBusy: false,
            applicationEditId: null,
            oidcStatus: null
        };
        this.settingsRequestId = 0;
        this.invalidate();
    }

    beforeRender() {
        this.clearEnrollment();
    }

    afterRender() {
        this.cacheElements();
        this.bindEvents();
        this.syncPanelFromAttributes();
        this.renderPanels();
        void this.refreshAuthProfile();
    }

    cacheElements() {
        this.statusEl = this.element.querySelector("#userpersistoStatus");
        this.panelTabs = Array.from(this.element.querySelectorAll("[data-panel]"));
        this.usersListEl = this.element.querySelector("#usersList");
        this.userSearchInput = this.element.querySelector("#userSearchInput");
        this.usersPageLabel = this.element.querySelector("#usersPageLabel");
        this.usersPreviousButton = this.element.querySelector("#usersPreviousButton");
        this.usersNextButton = this.element.querySelector("#usersNextButton");
        this.createUserEmailInput = this.element.querySelector("#createUserEmail");
        this.createUserDisplayNameInput = this.element.querySelector("#createUserDisplayName");
        this.createUserPasswordInput = this.element.querySelector("#createUserPassword");
        this.createUserRoleInput = this.element.querySelector("#createUserRole");
        this.authProfileEl = this.element.querySelector("#authProfileSummary");
        this.enrollmentMountEl = this.element.querySelector("#authEnrollment");
        this.profileUsernameInput = this.element.querySelector("#profileUsername");
        this.profileDisplayNameInput = this.element.querySelector("#profileDisplayName");
        this.authMethodInputs = Object.fromEntries(["password", "emailCode", "passkey", "totp"].map((method) => [
            method,
            this.element.querySelector(`[data-auth-method="${method}"]`)
        ]));
        this.selfRegistrationInput = this.element.querySelector("#selfRegistrationEnabled");
        this.defaultRegistrationRoleInput = this.element.querySelector("#defaultRegistrationRole");
        this.allowedRedirectOriginsInput = this.element.querySelector("#allowedRedirectOrigins");
        this.applicationsListEl = this.element.querySelector("#applicationsList");
        this.applicationsPageLabel = this.element.querySelector("#applicationsPageLabel");
        this.applicationsPreviousButton = this.element.querySelector("#applicationsPreviousButton");
        this.applicationsNextButton = this.element.querySelector("#applicationsNextButton");
        this.oidcStatusEl = this.element.querySelector("#oidcProviderStatus");
        this.applicationEditorTitle = this.element.querySelector("#applicationEditorTitle");
        this.applicationSecretBox = this.element.querySelector("#applicationSecretBox");
        this.applicationSecretInput = this.element.querySelector("#applicationSecret");
        this.applicationInputs = Object.fromEntries([
            "client_id", "client_name", "redirect_uris", "post_logout_redirect_uris",
            "token_endpoint_auth_method", "scope", "enabled"
        ].map((key) => [key, this.element.querySelector(`[data-client-field="${key}"]`)]));
        this.applicationGrantInputs = Object.fromEntries([
            "authorization_code", "refresh_token", "client_credentials"
        ].map((grant) => [grant, this.element.querySelector(`[data-client-grant="${grant}"]`)]));
        this.inputs = {
            STRIPE_SECRET_KEY: this.element.querySelector("#stripeSecretKey"),
            STRIPE_WEBHOOK_SECRET: this.element.querySelector("#stripeWebhookSecret"),
            STRIPE_PUBLISHABLE_KEY: this.element.querySelector("#stripePublishableKey"),
            STRIPE_PRICE_CREDITS: this.element.querySelector("#stripePriceCredits"),
            STRIPE_PRICE_SUBSCRIPTION: this.element.querySelector("#stripePriceSubscription"),
            USERPERSISTO_CREDITS_PER_UNIT: this.element.querySelector("#creditsPerUnit"),
            USERPERSISTO_BILLING_SUCCESS_URL: this.element.querySelector("#billingSuccessUrl"),
            USERPERSISTO_BILLING_CANCEL_URL: this.element.querySelector("#billingCancelUrl")
        };
        for (const key of SECRET_KEYS) {
            const input = this.inputs[key];
            if (!input) continue;
            input.value = "";
            input.placeholder = "Leave unchanged";
            input.autocomplete = "off";
        }
    }

    bindEvents() {
        if (this.element.dataset.userpersistoBound === "true") return;
        this.element.dataset.userpersistoBound = "true";
        this.userSearchInput?.addEventListener("input", () => this.renderUsers());
        this.element.addEventListener("userpersisto-panel-change", (event) => {
            this.switchPanel(null, event.detail?.panel);
        });
    }

    syncPanelFromAttributes() {
        const panel = this.element.getAttribute("data-active-panel") || this.element.getAttribute("data-initial-panel");
        if (this.allowedPanels().has(panel)) {
            this.state.activePanel = panel;
        }
    }

    async callTool(name, args = {}) {
        return callUserPersistoTool(name, args);
    }

    setStatus(message, type = "") {
        this.state.status = message || "";
        this.state.statusType = type || "";
        if (this.statusEl) {
            this.statusEl.textContent = this.state.status;
            this.statusEl.classList.toggle("error", this.state.statusType === "error");
        }
    }

    allowedPanels() {
        const scope = this.element.getAttribute?.("data-settings-scope");
        if (scope === "account") return new Set(["auth"]);
        if (scope === "administration") return new Set(["applications"]);
        return PANELS;
    }

    switchPanel(_target, panel) {
        if (!this.allowedPanels().has(panel)) return;
        if (panel !== "auth" && !this.isAdministrator()) return;
        if (panel !== this.state.activePanel) this.clearApplicationSecret();
        this.state.activePanel = PANELS.has(panel) ? panel : "users";
        this.renderPanels();
        if (this.state.activePanel === "users") void this.refreshUsers();
        if (this.state.activePanel === "auth") void this.refreshAuthProfile();
        if (this.state.activePanel === "applications") void this.refreshApplications();
    }

    renderPanels() {
        if (this.state.activePanel !== "auth") this.clearEnrollment();
        else void this.renderEnrollment();
        this.panelTabs?.forEach((tab) => {
            const isActive = tab.dataset.panel === this.state.activePanel;
            tab.classList.toggle("active", isActive);
            tab.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        this.element.querySelectorAll("[data-section]").forEach((section) => {
            const accountPolicy = this.element.getAttribute?.("data-settings-scope") === "account"
                && this.state.activePanel === "auth" && section.dataset.section === "policy";
            section.classList.toggle("hidden", !accountPolicy && section.dataset.section !== this.state.activePanel);
        });
    }

    applySettings(payload = {}) {
        const settings = payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
        this.state.settings = settings || {};
        for (const key of SETTING_KEYS) {
            const value = settingValue(this.state.settings, key);
            const mask = this.element.querySelector(`[data-mask-for="${key}"]`);
            if (mask) {
                mask.textContent = value ? `Current: ${value}` : "Not configured";
            }
            const input = this.inputs[key];
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
            const payload = await this.callTool("userpersisto_config_get");
            if (requestId !== this.settingsRequestId) return;
            this.applySettings(payload);
            this.setStatus("");
        } catch (error) {
            if (requestId !== this.settingsRequestId) return;
            this.setStatus(error?.message || "Failed to load settings.", "error");
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

    async saveProviderSettings() {
        const patch = this.collectSettingsPatch();
        if (!Object.keys(patch).length) {
            this.setStatus("Enter at least one setting to save.");
            return;
        }
        const requestId = ++this.settingsRequestId;
        try {
            const payload = await this.callTool("userpersisto_config_set", patch);
            if (requestId !== this.settingsRequestId) return;
            this.applySettings(payload);
            this.setStatus("Account settings saved.");
        } catch (error) {
            if (requestId !== this.settingsRequestId) return;
            this.setStatus(error?.message || "Failed to save settings.", "error");
        }
    }

    async removeSecret(_target, key) {
        const settingKey = String(key || "").trim();
        if (!SECRET_KEYS.has(settingKey)) return;
        const requestId = ++this.settingsRequestId;
        try {
            const payload = await this.callTool("userpersisto_config_set", { remove: [settingKey] });
            if (requestId !== this.settingsRequestId) return;
            this.applySettings(payload);
            this.setStatus("Secret removed.");
        } catch (error) {
            if (requestId !== this.settingsRequestId) return;
            this.setStatus(error?.message || "Failed to remove secret.", "error");
        }
    }

    async refreshAuthProfile() {
        try {
            const profile = await this.callTool("userpersisto_profile_get");
            this.state.authProfile = profile;
            this.renderAuthProfile();
            if (this.profileUsernameInput) this.profileUsernameInput.value = profile.user?.username || "";
            if (this.profileDisplayNameInput) this.profileDisplayNameInput.value = profile.user?.displayName || "";
            const isAdmin = Array.isArray(profile.roles) && profile.roles.includes("admin");
            this.element.querySelectorAll("[data-admin-only]").forEach((node) => {
                node.hidden = !isAdmin;
            });
            if (!isAdmin) this.clearApplications();
            if (!isAdmin && this.state.activePanel !== "auth") {
                this.state.activePanel = "auth";
                this.renderPanels();
            }
            if (isAdmin && !this.state.settingsLoaded) {
                this.state.settingsLoaded = true;
                if (this.allowedPanels().has("policy")
                    || this.element.getAttribute?.("data-settings-scope") === "account") void this.refreshAuthPolicy();
            }
            if (isAdmin && this.state.activePanel === "applications") void this.refreshApplications();
            this.setStatus("");
        } catch (error) {
            this.state.authProfile = null;
            this.clearApplications();
            this.element.querySelectorAll("[data-admin-only]").forEach((node) => { node.hidden = true; });
            this.renderAuthProfile();
            this.setStatus(error?.message || "Failed to load profile.", "error");
        }
    }

    async saveProfile() {
        try {
            const profile = await this.callTool("userpersisto_profile_update", {
                username: this.profileUsernameInput?.value || "",
                displayName: this.profileDisplayNameInput?.value || ""
            });
            this.state.authProfile = profile;
            this.renderAuthProfile();
            this.setStatus("Profile saved.");
        } catch (error) {
            this.setStatus(error?.message || "Failed to save profile.", "error");
        }
    }

    async refreshAuthPolicy() {
        try {
            const policy = await this.callTool("userpersisto_auth_policy_get");
            const enabled = new Set(Array.isArray(policy.enabledAuthMethods) ? policy.enabledAuthMethods : []);
            for (const [method, input] of Object.entries(this.authMethodInputs || {})) {
                if (input) input.checked = enabled.has(method);
            }
            if (this.selfRegistrationInput) this.selfRegistrationInput.checked = policy.selfRegistrationEnabled !== false;
            if (this.defaultRegistrationRoleInput) this.defaultRegistrationRoleInput.value = policy.defaultRegistrationRole || "selfRegistered";
            if (this.allowedRedirectOriginsInput) this.allowedRedirectOriginsInput.value = (policy.allowedRedirectOrigins || []).join("\n");
        } catch (error) {
            this.setStatus(error?.message || "Failed to load authentication policy.", "error");
        }
    }

    async saveAuthPolicy() {
        const enabledAuthMethods = Object.entries(this.authMethodInputs || {})
            .filter(([, input]) => input?.checked)
            .map(([method]) => method);
        if (!enabledAuthMethods.length) {
            this.setStatus("Enable at least one authentication method.", "error");
            return;
        }
        try {
            await this.callTool("userpersisto_auth_policy_set", {
                enabledAuthMethods,
                selfRegistrationEnabled: this.selfRegistrationInput?.checked === true,
                defaultRegistrationRole: this.defaultRegistrationRoleInput?.value || "selfRegistered",
                allowedRedirectOrigins: String(this.allowedRedirectOriginsInput?.value || "")
                    .split(/\r?\n|,/)
                    .map((value) => value.trim())
                    .filter(Boolean)
            });
            await this.refreshAuthPolicy();
            await this.refreshAuthProfile();
            this.setStatus("Authentication policy saved.");
        } catch (error) {
            this.setStatus(error?.message || "Failed to save authentication policy.", "error");
        }
    }

    renderAuthProfile() {
        void this.renderEnrollment();
        if (!this.authProfileEl) return;
        const profile = this.state.authProfile;
        if (!profile?.user) {
            this.authProfileEl.innerHTML = '<div class="userpersisto-result">No authenticated account profile loaded.</div>';
            return;
        }
        const roles = Array.isArray(profile.roles) ? profile.roles : [];
        const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : [];
        this.authProfileEl.innerHTML = `
            <div class="userpersisto-row">
                <div>
                    <div class="userpersisto-row-title">${escapeHtml(profile.user.email || profile.user.id)}</div>
                    <div class="userpersisto-row-meta">Roles: ${escapeHtml(roles.join(", ") || "none")}</div>
                    <div class="userpersisto-row-meta">Capabilities: ${escapeHtml(capabilities.join(", ") || "none")}</div>
                </div>
            </div>
        `;
    }

    async renderEnrollment() {
        const mount = this.enrollmentMountEl;
        if (!mount || mount.isConnected === false || this.state.activePanel !== "auth") return;
        if (!this.state.authProfile?.user) {
            this.clearEnrollment();
            return;
        }
        if (this.enrollmentWidget?.element === mount) {
            this.enrollmentWidget.updateProfile(this.state.authProfile);
            return;
        }
        const loadId = this.enrollmentLoadId = (this.enrollmentLoadId || 0) + 1;
        try {
            const { AccountEnrollment } = await import("/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/enrollment.js");
            if (loadId !== this.enrollmentLoadId || mount !== this.enrollmentMountEl
                || mount.isConnected === false || this.state.activePanel !== "auth") return;
            this.enrollmentWidget = new AccountEnrollment(mount, {
                callTool: (name, args) => this.callTool(name, args),
                onEnrolled: () => this.refreshAuthProfile(),
            });
            this.enrollmentWidget.updateProfile(this.state.authProfile);
        } catch (_) {
            if (loadId === this.enrollmentLoadId && mount.isConnected !== false) {
                mount.textContent = "Unable to load sign-in settings. Refresh your profile to try again.";
            }
        }
    }

    clearEnrollment() {
        this.enrollmentLoadId = (this.enrollmentLoadId || 0) + 1;
        this.enrollmentWidget?.dispose();
        this.enrollmentWidget = null;
    }

    afterUnload() {
        this.clearEnrollment();
        this.enrollmentMountEl = null;
        this.clearApplicationSecret();
    }

    async refreshUsers() {
        return this.loadUsersPage(this.state.usersStart);
    }

    async loadUsersPage(start = 0) {
        if (this.state.usersLoading) return;
        this.state.usersLoading = true;
        this.renderUsersPagination();
        try {
            const payload = await this.callTool("userpersisto_user_list", {
                start,
                pageSize: this.state.usersPageSize,
            });
            this.state.users = Array.isArray(payload.users)
                ? payload.users
                : Array.isArray(payload.objects)
                    ? payload.objects
                    : [];
            this.state.usersStart = start;
            this.state.usersTotal = Number.isSafeInteger(payload.totalCount) ? payload.totalCount : start + this.state.users.length;
            this.renderUsers();
            this.setStatus("");
        } catch (error) {
            this.setStatus(error?.message || "Failed to load users.", "error");
        } finally {
            this.state.usersLoading = false;
            this.renderUsersPagination();
        }
    }

    previousUsersPage() {
        return this.loadUsersPage(Math.max(0, this.state.usersStart - this.state.usersPageSize));
    }

    nextUsersPage() {
        if (this.state.usersStart + this.state.users.length >= this.state.usersTotal) return;
        return this.loadUsersPage(this.state.usersStart + this.state.usersPageSize);
    }

    renderUsersPagination() {
        const { usersStart, usersPageSize, usersTotal, usersLoading, users } = this.state;
        if (this.usersPreviousButton) this.usersPreviousButton.disabled = usersLoading || usersStart === 0;
        if (this.usersNextButton) this.usersNextButton.disabled = usersLoading || usersStart + usersPageSize >= usersTotal;
        if (this.usersPageLabel) this.usersPageLabel.textContent = usersLoading
            ? "Loading users…"
            : `${users.length ? usersStart + 1 : 0}–${usersStart + users.length} of ${usersTotal} users`;
    }

    filteredUsers() {
        const query = String(this.userSearchInput?.value || "").trim().toLowerCase();
        if (!query) return this.state.users;
        return this.state.users.filter((user) => {
            const haystack = [
                user.id,
                user.email,
                user.displayName,
                user.status,
                ...userRoles(user)
            ].join(" ").toLowerCase();
            return haystack.includes(query);
        });
    }

    async createUser() {
        try {
            const role = this.createUserRoleInput?.value || "user";
            await this.callTool("userpersisto_user_create", {
                email: this.createUserEmailInput?.value || "",
                displayName: this.createUserDisplayNameInput?.value || "",
                password: this.createUserPasswordInput?.value || "",
                roles: [role]
            });
            [this.createUserEmailInput, this.createUserDisplayNameInput, this.createUserPasswordInput].forEach((input) => {
                if (input) input.value = "";
            });
            if (this.userSearchInput) {
                this.userSearchInput.value = "";
            }
            await this.loadUsersPage(0);
            this.setStatus("User created.");
        } catch (error) {
            this.setStatus(error?.message || "Failed to create user.", "error");
        }
    }

    renderUsers() {
        if (!this.usersListEl) return;
        const users = this.filteredUsers();
        if (!users.length) {
            this.usersListEl.innerHTML = '<div class="userpersisto-result">No users found.</div>';
            return;
        }
        this.usersListEl.innerHTML = users.map((user) => {
            const roles = userRoles(user);
            const selectedRole = primaryRole(user);
            return `
                <div class="userpersisto-row">
                    <div>
                        <div class="userpersisto-row-title">${escapeHtml(user.email || user.id)}</div>
                        <div class="userpersisto-row-meta">${escapeHtml(user.displayName || "No display name")} · Roles: ${escapeHtml(roles.join(", ") || "unknown")} · Status: ${escapeHtml(user.status || "unknown")}</div>
                        <div class="userpersisto-access">${roles.includes("selfRegistered") && !roles.includes("user") && !roles.includes("admin") ? "Self-registered app only" : "Explorer access depends on explorer.access capability"}</div>
                    </div>
                    <div class="userpersisto-row-controls">
                        <select class="form-input" data-user-role="${escapeHtml(user.id)}" data-local-action="changeUserRole ${escapeHtml(user.id)}">
                            ${["admin", "user", "selfRegistered"].map((role) => `<option value="${role}" ${role === selectedRole ? "selected" : ""}>${role}</option>`).join("")}
                        </select>
                    </div>
                </div>
            `;
        }).join("");
        this.usersListEl.querySelectorAll("[data-user-role]").forEach((select) => {
            select.addEventListener("change", () => this.changeUserRole(select, select.dataset.userRole));
        });
    }

    async changeUserRole(target, userId) {
        const role = target?.value;
        if (!userId || !role) return;
        try {
            await this.callTool("userpersisto_user_roles_update", { userId, roles: [role] });
            await this.refreshUsers();
            this.setStatus("User role updated.");
        } catch (error) {
            this.setStatus(error?.message || "Failed to update role.", "error");
        }
    }

    isAdministrator() {
        return this.state.authProfile?.roles?.includes("admin") === true;
    }

    clearApplicationSecret() {
        if (this.applicationSecretInput) this.applicationSecretInput.value = "";
        if (this.applicationSecretBox) this.applicationSecretBox.hidden = true;
    }

    showApplicationSecret(secret) {
        this.clearApplicationSecret();
        if (!secret || !this.isAdministrator() || this.state.activePanel !== "applications") return;
        if (this.applicationSecretInput) this.applicationSecretInput.value = secret;
        if (this.applicationSecretBox) this.applicationSecretBox.hidden = false;
    }

    clearApplications() {
        this.clearApplicationSecret();
        this.state.applications = [];
        this.state.applicationsStart = 0;
        this.state.applicationsTotal = 0;
        this.state.oidcStatus = null;
        this.resetApplicationForm();
        this.renderApplications();
        this.renderOidcStatus();
    }

    resetApplicationForm() {
        this.state.applicationEditId = null;
        const values = {
            client_id: "", client_name: "", redirect_uris: "", post_logout_redirect_uris: "",
            token_endpoint_auth_method: "client_secret_basic", scope: "openid profile email"
        };
        for (const [key, input] of Object.entries(this.applicationInputs || {})) {
            if (!input) continue;
            if (key === "enabled") input.checked = true;
            else input.value = values[key];
        }
        if (this.applicationInputs?.client_id) this.applicationInputs.client_id.disabled = false;
        for (const [grant, input] of Object.entries(this.applicationGrantInputs || {})) {
            if (input) input.checked = grant === "authorization_code";
        }
        if (this.applicationEditorTitle) this.applicationEditorTitle.textContent = "Create application";
    }

    newApplication() {
        if (!this.isAdministrator() || this.state.applicationBusy) return;
        this.clearApplicationSecret();
        this.resetApplicationForm();
    }

    editApplication(_target, clientId) {
        if (!this.isAdministrator() || this.state.applicationBusy) return;
        const client = this.state.applications.find((item) => item.client_id === clientId);
        if (!client) return;
        this.clearApplicationSecret();
        this.state.applicationEditId = clientId;
        for (const [key, input] of Object.entries(this.applicationInputs || {})) {
            if (!input) continue;
            if (key === "enabled") input.checked = client.enabled !== false;
            else input.value = Array.isArray(client[key]) ? client[key].join("\n") : client[key] || "";
        }
        if (this.applicationInputs?.client_id) this.applicationInputs.client_id.disabled = true;
        for (const [grant, input] of Object.entries(this.applicationGrantInputs || {})) {
            if (input) input.checked = client.grant_types.includes(grant);
        }
        if (this.applicationEditorTitle) this.applicationEditorTitle.textContent = "Edit application";
        this.applicationInputs?.client_name?.focus?.();
    }

    collectApplication() {
        const input = this.applicationInputs || {};
        const lines = (value) => String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const payload = {
            client_name: String(input.client_name?.value || "").trim(),
            redirect_uris: lines(input.redirect_uris?.value),
            post_logout_redirect_uris: lines(input.post_logout_redirect_uris?.value),
            token_endpoint_auth_method: input.token_endpoint_auth_method?.value || "client_secret_basic",
            grant_types: Object.entries(this.applicationGrantInputs || {}).filter(([, node]) => node?.checked).map(([grant]) => grant),
            scope: String(input.scope?.value || "").trim(),
            enabled: input.enabled?.checked === true
        };
        const clientId = this.state.applicationEditId || String(input.client_id?.value || "").trim();
        if (clientId) payload.client_id = clientId;
        return payload;
    }

    async refreshApplications() {
        if (!this.isAdministrator()) return;
        this.clearApplicationSecret();
        await Promise.all([this.refreshOidcStatus(), this.loadApplicationsPage(this.state.applicationsStart)]);
    }

    async refreshOidcStatus() {
        try {
            const status = await this.callTool("userpersisto_oidc_status");
            if (!this.isAdministrator()) return;
            this.state.oidcStatus = { enabled: status.enabled === true, issuer: status.issuer, discoveryUrl: status.discoveryUrl };
            this.renderOidcStatus();
        } catch (error) {
            this.setStatus(error?.message || "Failed to load OAuth provider status.", "error");
        }
    }

    renderOidcStatus() {
        if (!this.oidcStatusEl) return;
        const status = this.state.oidcStatus;
        this.oidcStatusEl.textContent = !status ? "Loading provider…" : status.enabled
            ? `Issuer: ${status.issuer}\nDiscovery: ${status.discoveryUrl}`
            : "OAuth/OIDC is disabled. Configure USERPERSISTO_OIDC_ISSUER with the public issuer URL and restart UserPersisto to enable it.";
    }

    async loadApplicationsPage(start = 0) {
        if (!this.isAdministrator() || this.state.applicationsLoading) return false;
        this.state.applicationsLoading = true;
        this.renderApplicationsPagination();
        try {
            let payload = await this.callTool("userpersisto_oidc_clients_list", { start, pageSize: this.state.applicationsPageSize });
            if (!this.isAdministrator()) return false;
            if (start > 0 && !payload.items?.length && payload.total < start + 1) {
                start = Math.max(0, Math.floor((Math.max(1, payload.total) - 1) / this.state.applicationsPageSize) * this.state.applicationsPageSize);
                payload = await this.callTool("userpersisto_oidc_clients_list", { start, pageSize: this.state.applicationsPageSize });
                if (!this.isAdministrator()) return false;
            }
            // Retain only display metadata, even if a provider accidentally includes a secret.
            this.state.applications = (payload.items || []).map((client) => ({
                client_id: client.client_id,
                client_name: client.client_name,
                redirect_uris: client.redirect_uris || [],
                post_logout_redirect_uris: client.post_logout_redirect_uris || [],
                token_endpoint_auth_method: client.token_endpoint_auth_method,
                grant_types: client.grant_types || [],
                scope: client.scope,
                enabled: client.enabled !== false
            }));
            this.state.applicationsStart = start;
            this.state.applicationsTotal = payload.total;
            this.renderApplications();
            return true;
        } catch (error) {
            this.setStatus(error?.message || "Failed to load applications.", "error");
            return false;
        } finally {
            this.state.applicationsLoading = false;
            this.renderApplicationsPagination();
        }
    }

    previousApplicationsPage() {
        this.clearApplicationSecret();
        return this.loadApplicationsPage(Math.max(0, this.state.applicationsStart - this.state.applicationsPageSize));
    }

    nextApplicationsPage() {
        if (this.state.applicationsStart + this.state.applicationsPageSize >= this.state.applicationsTotal) return;
        this.clearApplicationSecret();
        return this.loadApplicationsPage(this.state.applicationsStart + this.state.applicationsPageSize);
    }

    renderApplicationsPagination() {
        const { applicationsStart: start, applicationsPageSize: size, applicationsTotal: total, applicationsLoading: loading, applicationBusy: busy, applications } = this.state;
        this.element.querySelectorAll?.("[data-oidc-control]").forEach((node) => { node.disabled = loading || busy; });
        if (this.applicationInputs?.client_id) this.applicationInputs.client_id.disabled = loading || busy || !!this.state.applicationEditId;
        if (this.applicationsPreviousButton) this.applicationsPreviousButton.disabled = loading || busy || start === 0;
        if (this.applicationsNextButton) this.applicationsNextButton.disabled = loading || busy || start + size >= total;
        if (this.applicationsPageLabel) this.applicationsPageLabel.textContent = loading
            ? "Loading applications…"
            : `${applications.length ? start + 1 : 0}–${start + applications.length} of ${total} applications`;
    }

    renderApplications() {
        if (!this.applicationsListEl) return;
        this.applicationsListEl.innerHTML = this.state.applications.length ? this.state.applications.map((client) => `
            <div class="userpersisto-row">
                <div>
                    <div class="userpersisto-row-title">${escapeHtml(client.client_name || client.client_id)}</div>
                    <div class="userpersisto-row-meta">${escapeHtml(client.client_id)} · ${client.enabled ? "Enabled" : "Disabled"}</div>
                    <div class="userpersisto-row-meta">${escapeHtml(client.token_endpoint_auth_method)} · ${escapeHtml(client.grant_types.join(", "))}</div>
                </div>
                <div class="userpersisto-actions">
                    <button type="button" class="gray-button" data-oidc-control data-client-action="edit" data-client-id="${escapeHtml(client.client_id)}">Edit</button>
                    <button type="button" class="gray-button" data-oidc-control data-client-action="toggle" data-client-id="${escapeHtml(client.client_id)}">${client.enabled ? "Disable" : "Enable"}</button>
                    ${client.token_endpoint_auth_method !== "none" ? `<button type="button" class="gray-button" data-oidc-control data-client-action="rotate" data-client-id="${escapeHtml(client.client_id)}">Rotate secret</button>` : ""}
                    <button type="button" class="gray-button" data-oidc-control data-client-action="delete" data-client-id="${escapeHtml(client.client_id)}">Delete</button>
                </div>
            </div>`).join("") : '<div class="userpersisto-result">No applications registered.</div>';
        this.applicationsListEl.querySelectorAll("[data-client-action]").forEach((button) => {
            button.addEventListener("click", () => {
                const actions = { edit: "editApplication", toggle: "toggleApplication", rotate: "rotateApplicationSecret", delete: "deleteApplication" };
                void this[actions[button.dataset.clientAction]](button, button.dataset.clientId);
            });
        });
        this.renderApplicationsPagination();
    }

    async mutateApplication(tool, args, success, { reset = false, firstPage = false } = {}) {
        if (!this.isAdministrator() || this.state.applicationBusy || this.state.applicationsLoading) return;
        this.state.applicationBusy = true;
        this.clearApplicationSecret();
        this.renderApplicationsPagination();
        try {
            const result = await this.callTool(tool, args);
            if (!this.isAdministrator()) return;
            if (reset) this.resetApplicationForm();
            const loaded = await this.loadApplicationsPage(firstPage ? 0 : this.state.applicationsStart);
            this.showApplicationSecret(result.client_secret);
            if (loaded) this.setStatus(success);
        } catch (error) {
            this.setStatus(error?.message || "Failed to update application.", "error");
        } finally {
            this.state.applicationBusy = false;
            this.renderApplicationsPagination();
        }
    }

    saveApplication() {
        const editing = !!this.state.applicationEditId;
        return this.mutateApplication(editing ? "userpersisto_oidc_client_update" : "userpersisto_oidc_client_create",
            this.collectApplication(), editing ? "Application updated." : "Application created.", { reset: true, firstPage: !editing });
    }

    toggleApplication(_target, clientId) {
        const client = this.state.applications.find((item) => item.client_id === clientId);
        if (!client) return;
        return this.mutateApplication("userpersisto_oidc_client_update", { client_id: clientId, enabled: !client.enabled }, client.enabled ? "Application disabled." : "Application enabled.");
    }

    async confirmApplicationAction(message) {
        return assistOS.UI.showModal("confirm-action-modal", { message }, true);
    }

    async rotateApplicationSecret(_target, clientId) {
        if (!this.isAdministrator() || this.state.applicationBusy) return;
        if (!await this.confirmApplicationAction("Rotate this application's secret? Its current secret will stop working immediately.")) return;
        return this.mutateApplication("userpersisto_oidc_client_rotate_secret", { client_id: clientId }, "Secret rotated.");
    }

    async deleteApplication(_target, clientId) {
        if (!this.isAdministrator() || this.state.applicationBusy) return;
        if (!await this.confirmApplicationAction("Delete this application? Its clients will no longer be able to sign in.")) return;
        return this.mutateApplication("userpersisto_oidc_client_delete", { client_id: clientId }, "Application deleted.", { reset: this.state.applicationEditId === clientId });
    }

    closeModal() {
        this.clearEnrollment();
        this.clearApplicationSecret();
        assistOS.UI.closeModal(this.element, null);
    }
}
