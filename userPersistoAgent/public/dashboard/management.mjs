import { callManagementTool } from './api.mjs';

const PANELS = new Set(["users", "policy", "applications"]);

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function authorizationFailure(error) {
    return [401, 403].includes(Number(error?.statusCode || error?.status))
        || ["authentication_required", "invalid_session", "admin_required"].includes(error?.code || error?.payload?.code)
        || /admin access is required|authentication required/i.test(String(error?.message || ""));
}

function userRoles(user = {}) {
    if (Array.isArray(user.roles) && user.roles.length) {
        return user.roles.map((role) => String(role || "").trim()).filter(Boolean);
    }
    const role = String(user.role || "").trim();
    return role ? [role] : [];
}

export class UserpersistoSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            activePanel: "users",
            status: "",
            statusType: "",
            users: [],
            usersStart: 0,
            usersPageSize: 100,
            usersTotal: 0,
            selfRegisteredCount: 0,
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
        this.disposed = false;
        this.invalidate();
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
        this.selfRegisteredCountEl = this.element.querySelector("#selfRegisteredCount");
        this.usersPageLabel = this.element.querySelector("#usersPageLabel");
        this.usersPreviousButton = this.element.querySelector("#usersPreviousButton");
        this.usersNextButton = this.element.querySelector("#usersNextButton");
        this.policySaveButton = this.element.querySelector('[data-local-action="saveAuthPolicy"]');
        this.authMethodInputs = Object.fromEntries(["emailCode", "passkey", "totp", "google"].map((method) => [
            method,
            this.element.querySelector(`[data-auth-method="${method}"]`)
        ]));
        this.selfRegistrationInput = this.element.querySelector("#selfRegistrationEnabled");
        this.allowedRedirectOriginsInput = this.element.querySelector("#allowedRedirectOrigins");
        this.authPolicySourceEl = this.element.querySelector("#authPolicySource");
        this.googleStatusEl = this.element.querySelector("#googleProviderStatus");
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
    }

    bindEvents() {
        if (this.element.dataset.userpersistoBound === "true") return;
        this.element.dataset.userpersistoBound = "true";
        this.userSearchInput?.addEventListener("input", () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => { void this.searchUsers(); }, 250);
        });
        this.userSearchInput?.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); void this.searchUsers(); }
        });

    }

    syncPanelFromAttributes() {
        const panel = this.element.getAttribute("data-active-panel") || this.element.getAttribute("data-initial-panel");
        if (this.allowedPanels().has(panel)) {
            this.state.activePanel = panel;
        }
    }

    async callTool(name, args = {}) {
        return callManagementTool(name, args);
    }

    setStatus(message, type = "") {
        this.state.status = message || "";
        this.state.statusType = type || "";
        if (this.disposed) return;
        if (this.statusEl) {
            this.statusEl.textContent = this.state.status;
            this.statusEl.classList.toggle("error", this.state.statusType === "error");
        }
    }

    allowedPanels() {
        const panel = this.element.getAttribute?.("data-initial-panel");
        return PANELS.has(panel) ? new Set([panel]) : PANELS;
    }

    renderPanels() {
        this.element.querySelectorAll("[data-section]").forEach((section) => {
            section.classList.toggle("hidden", section.dataset.section !== this.state.activePanel);
        });
    }

    async refreshAuthProfile() {
        const requestId = this.profileRequestId = (this.profileRequestId || 0) + 1;
        try {
            const profile = await this.callTool("userpersisto_profile_get");
            if (this.disposed || requestId !== this.profileRequestId) return;
            this.state.authProfile = profile;
            const allowed = this.isAdministrator();
            this.element.querySelectorAll("[data-admin-only]").forEach((node) => { node.hidden = !allowed; });
            this.onAccessChanged?.(profile);
            if (!allowed) {
                this.clearAuthPolicy();
                this.clearApplications();
                this.clearUsers();
                this.setStatus("You do not have permission to manage this page.", "error");
                return;
            }
            this.setStatus("");
            if (this.state.activePanel === "users") await this.loadUsersPage(0);
            if (this.state.activePanel === "applications") await this.refreshApplications();
            if (this.state.activePanel === "policy") await this.refreshAuthPolicy();
        } catch (error) {
            if (this.disposed || requestId !== this.profileRequestId) return;
            this.revokeAdministrativeAccess();
            this.setStatus(error?.message || "Failed to load profile.", "error");
        }
    }

    async refreshAuthPolicy() {
        if (!this.isAdministrator()) return;
        const requestId = this.policyRequestId = (this.policyRequestId || 0) + 1;
        this.state.policyLoaded = false;
        if (this.policySaveButton) this.policySaveButton.disabled = true;
        try {
            const [policy, google] = await Promise.all([
                this.callTool("userpersisto_auth_policy_get"),
                this.callTool("userpersisto_google_status"),
            ]);
            if (requestId !== this.policyRequestId || !this.isAdministrator()) return;
            const enabled = new Set(Array.isArray(policy.enabledAuthMethods) ? policy.enabledAuthMethods : []);
            for (const [method, input] of Object.entries(this.authMethodInputs || {})) {
                if (input) input.checked = enabled.has(method);
            }
            if (this.selfRegistrationInput) this.selfRegistrationInput.checked = policy.selfRegistrationEnabled !== false;
            if (this.allowedRedirectOriginsInput) this.allowedRedirectOriginsInput.value = (policy.allowedRedirectOrigins || []).join("\n");
            if (this.authPolicySourceEl) this.authPolicySourceEl.textContent = policy.environmentOverrides?.length
                ? `Effective environment overrides: ${policy.environmentOverrides.join(", ")}. Saved policy does not replace these operator settings.`
                : "Effective policy uses the saved workspace settings or defaults.";
            if (this.googleStatusEl) this.googleStatusEl.textContent = [
                google.available ? "Google is ready." : google.enabled ? "Google is unavailable." : "Google is disabled.",
                `Configuration: ${google.configured ? "complete" : "incomplete"}; source: ${google.configurationSource || "environment"}.`,
                `Client secret: ${google.secretPresent === true ? "present" : "missing"}.`,
                google.clientId ? `Client ID: ${google.clientId}` : "",
                google.redirectUri ? `Exact callback: ${google.redirectUri}` : "",
                google.missing?.length ? `Missing settings: ${google.missing.join(", ")}.` : "",
                google.reason ? `Readiness: ${google.reason}.` : "",
            ].filter(Boolean).join("\n");
            this.state.policyLoaded = true;
            if (this.policySaveButton) this.policySaveButton.disabled = false;
        } catch (error) {
            if (requestId !== this.policyRequestId || !this.isAdministrator()) return;
            this.clearAuthPolicy();
            if (authorizationFailure(error)) this.revokeAdministrativeAccess();
            this.setStatus(error?.message || "Failed to load authentication policy.", "error");
        }
    }

    clearAuthPolicy() {
        this.policyRequestId = (this.policyRequestId || 0) + 1;
        this.state.policyLoaded = false;
        if (this.policySaveButton) this.policySaveButton.disabled = true;
        if (this.googleStatusEl) this.googleStatusEl.textContent = "Google readiness is unavailable.";
        if (this.authPolicySourceEl) this.authPolicySourceEl.textContent = "";
        for (const input of Object.values(this.authMethodInputs || {})) {
            if (input) input.checked = false;
        }
    }

    revokeAdministrativeAccess() {
        this.profileRequestId = (this.profileRequestId || 0) + 1;
        this.state.authProfile = null;
        this.onAccessChanged?.(null);
        this.clearAuthPolicy();
        this.clearApplications();
        this.clearUsers();
        this.element.querySelectorAll?.("[data-admin-only]").forEach((node) => { node.hidden = true; });
    }

    clearUsers() {
        this.usersRequestId = (this.usersRequestId || 0) + 1;
        this.state.users = [];
        this.state.usersTotal = 0;
        this.state.selfRegisteredCount = 0;
        this.state.usersLoading = false;
        this.renderUsers();
        this.renderUsersPagination();
    }

    async saveAuthPolicy() {
        if (!this.isAdministrator() || !this.state.policyLoaded || this.state.policySaving) return;
        const enabledAuthMethods = Object.entries(this.authMethodInputs || {})
            .filter(([, input]) => input?.checked)
            .map(([method]) => method);
        if (!enabledAuthMethods.length) {
            this.setStatus("Enable at least one authentication method.", "error");
            return;
        }
        this.state.policySaving = true;
        if (this.policySaveButton) this.policySaveButton.disabled = true;
        try {
            await this.callTool("userpersisto_auth_policy_set", {
                enabledAuthMethods,
                selfRegistrationEnabled: this.selfRegistrationInput?.checked === true,
                allowedRedirectOrigins: String(this.allowedRedirectOriginsInput?.value || "")
                    .split(/\r?\n|,/)
                    .map((value) => value.trim())
                    .filter(Boolean)
            });
            if (!this.isAdministrator()) return;
            await this.refreshAuthPolicy();
            if (this.state.policyLoaded) this.setStatus("Authentication policy saved.");
        } catch (error) {
            if (!this.isAdministrator()) return;
            if (authorizationFailure(error)) this.revokeAdministrativeAccess();
            this.setStatus(error?.message || "Failed to save authentication policy.", "error");
        } finally {
            this.state.policySaving = false;
            if (this.policySaveButton) this.policySaveButton.disabled = !this.state.policyLoaded;
        }
    }

    afterUnload() {
        this.disposed = true;
        clearTimeout(this.searchTimer);
        this.revokeAdministrativeAccess();
    }

    searchUsers() {
        clearTimeout(this.searchTimer);
        return this.loadUsersPage(0);
    }

    clearUserSearch() {
        if (this.userSearchInput) this.userSearchInput.value = "";
        return this.searchUsers();
    }

    async refreshUsers() {
        return this.loadUsersPage(this.state.usersStart);
    }

    async loadUsersPage(start = 0) {
        if (!this.isAdministrator()) return;
        const requestId = this.usersRequestId = (this.usersRequestId || 0) + 1;
        const search = String(this.userSearchInput?.value || "").trim();
        this.state.usersLoading = true;
        this.renderUsersPagination();
        try {
            const payload = await this.callTool("userpersisto_user_list", {
                start,
                pageSize: this.state.usersPageSize,
                search,
                excludeOnlyRole: search ? "" : "selfRegistered",
                includeRoleCounts: true,
            });
            if (requestId !== this.usersRequestId) return;
            this.state.users = Array.isArray(payload.users)
                ? payload.users
                : Array.isArray(payload.objects)
                    ? payload.objects
                    : [];
            this.state.usersStart = start;
            this.state.usersTotal = Number.isSafeInteger(payload.totalCount) ? payload.totalCount : start + this.state.users.length;
            this.state.selfRegisteredCount = Number.isSafeInteger(payload.singleRoleCounts?.selfRegistered)
                ? payload.singleRoleCounts.selfRegistered : 0;
            if (!this.state.users.length && start > 0 && this.state.usersTotal <= start) {
                return this.loadUsersPage(Math.max(0, Math.ceil(this.state.usersTotal / this.state.usersPageSize) - 1) * this.state.usersPageSize);
            }
            this.renderUsers();
            this.setStatus("");
        } catch (error) {
            if (requestId !== this.usersRequestId) return;
            if (authorizationFailure(error)) this.revokeAdministrativeAccess();
            this.setStatus(error?.message || "Failed to load users.", "error");
        } finally {
            if (requestId === this.usersRequestId) {
                this.state.usersLoading = false;
                this.renderUsersPagination();
            }
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
        if (this.selfRegisteredCountEl) this.selfRegisteredCountEl.textContent = `Self-registered users: ${this.state.selfRegisteredCount}. Search all users to find and manage them.`;
    }

    filteredUsers() {
        return this.state.users;
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
            const choices = [...new Set(["admin", "user", "selfRegistered", ...roles])];
            const textField = (label, field, type = "text", extra = "") => `<label class="form-item"><span class="form-label">${label}</span><input class="form-input" data-user-field="${field}" type="${type}" value="${escapeHtml(user[field] || "")}" ${extra}></label>`;
            return `
                <section class="userpersisto-row user-editor" data-user-id="${escapeHtml(user.id)}" aria-label="${escapeHtml(user.email || user.id)}">
                    <div>
                        <h3 class="userpersisto-row-title">${escapeHtml(user.email || user.id)}</h3>
                        <p class="userpersisto-row-meta">${escapeHtml(user.id)} · Roles: ${escapeHtml(roles.join(", ") || "none")} · Status: ${escapeHtml(user.status || "unknown")}</p>
                    </div>
                    <div class="userpersisto-user-fields">
                        <div class="form-item"><span class="form-label">Email</span><span class="userpersisto-row-meta">${escapeHtml(user.email || "")}</span></div>
                        ${textField("Username (optional)", "username", "text", 'minlength="3" maxlength="64" autocomplete="off"')}
                        ${textField("Display name", "displayName", "text", 'maxlength="200" autocomplete="off"')}
                        <label class="form-item"><span class="form-label">Status</span><select class="form-input" data-user-field="status">${["active", "blocked"].map((status) => `<option value="${status}" ${user.status === status ? "selected" : ""}>${status === "active" ? "Active" : "Blocked"}</option>`).join("")}</select></label>
                    </div>
                    <div><button type="button" class="general-button" data-user-action="details">Save details</button></div>
                    <fieldset class="userpersisto-role-choices"><legend>Roles</legend>${choices.map((role) => `<label><input type="checkbox" data-user-role value="${escapeHtml(role)}" ${roles.includes(role) ? "checked" : ""}> ${escapeHtml(role)}</label>`).join("")}</fieldset>
                    <div><button type="button" class="gray-button" data-user-action="roles">Save roles</button></div>
                </section>`;
        }).join("");
        this.usersListEl.querySelectorAll("[data-user-action]").forEach((button) => {
            button.addEventListener("click", () => {
                void this.updateUser(button.closest("[data-user-id]"), button.dataset.userAction);
            });
        });
    }

    async updateUser(row, action) {
        if (!this.isAdministrator() || this.state.userBusy || !row?.dataset.userId) return;
        const userId = row.dataset.userId;
        let name;
        let args;
        let success;
        if (action === "details") {
            const fields = [...row.querySelectorAll("[data-user-field]")];
            if (fields.some((input) => input.reportValidity?.() === false)) return;
            name = "userpersisto_user_update";
            args = { userId, ...Object.fromEntries(fields.map((input) => [input.dataset.userField, input.value.trim()])) };
            success = "User details saved.";
        } else if (action === "roles") {
            name = "userpersisto_user_roles_update";
            args = { userId, roles: [...row.querySelectorAll("[data-user-role]:checked")].map((input) => input.value) };
            success = "User roles saved.";
        } else return;
        this.state.userBusy = true;
        const buttons = [...row.querySelectorAll("button")];
        buttons.forEach((button) => { button.disabled = true; });
        try {
            await this.callTool(name, args);
            if (!this.isAdministrator()) return;
            // Recheck permissions after edits to the signed-in account, including self-demotion.
            if (userId === this.state.authProfile?.user?.id) await this.refreshAuthProfile();
            else await this.refreshUsers();
            if (this.isAdministrator()) this.setStatus(success);
        } catch (error) {
            if (authorizationFailure(error)) this.revokeAdministrativeAccess();
            this.setStatus(error?.message || "Failed to update user.", "error");
        } finally {
            this.state.userBusy = false;
            buttons.forEach((button) => { button.disabled = false; });
        }
    }

    isAdministrator() {
        const capability = this.state.activePanel === "users" ? "admin.users.manage" : "admin.agentSettings.manage";
        return !this.disposed && this.state.authProfile?.capabilities?.includes(capability) === true;
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
            if (authorizationFailure(error)) this.revokeAdministrativeAccess();
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
            if (authorizationFailure(error)) this.revokeAdministrativeAccess();
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
            if (authorizationFailure(error)) this.revokeAdministrativeAccess();
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
        return window.confirm(message);
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

}
