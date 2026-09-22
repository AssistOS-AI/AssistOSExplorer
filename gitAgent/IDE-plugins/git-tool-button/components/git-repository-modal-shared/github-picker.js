import { callAgentTool, parseToolResult } from "/explorer/services/infrastructure/explorerApi.js";
import { createGitCommitService } from "../git-panel/git-panel-service.js";

export async function callGitTool(name, args = {}) {
    const raw = await callAgentTool('gitAgent', name, args, { raw: true });
    return parseToolResult(raw);
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function renderLoadingState(message) {
    return `
        <div class="git-new-repository-state git-new-repository-loading">
            <span class="git-new-repository-spinner" aria-hidden="true"></span>
            <span>${escapeHtml(message)}</span>
        </div>
    `.trim();
}

export function renderErrorState(message) {
    return `
        <div class="git-new-repository-state git-new-repository-state-error">
            <span>${escapeHtml(message)}</span>
            <button type="button" class="gray-button" data-local-action="reloadGithubData">Retry</button>
        </div>
    `.trim();
}

export function setContainerHtml(node, html, { auth = false } = {}) {
    if (!node) return;
    node.classList.toggle('is-auth-state', auth);
    const nextHtml = String(html || '').trim();
    if (node.innerHTML.trim() !== nextHtml) {
        node.innerHTML = nextHtml;
    }
}

export class GithubAuthController {
    constructor({ getContainer, onAuthorized, onError }) {
        this.getContainer = getContainer;
        this.onAuthorized = onAuthorized;
        this.onError = onError;
        this.pending = null;
        this.error = '';
        this.pollTimer = null;
        this.renderKey = '';
        this.startPromise = null;
        this.service = createGitCommitService({
            callTool: async () => {
                throw new Error('Explorer tool calls are not available in this modal.');
            },
            callAgentTool
        });
    }

    isPending() {
        return Boolean(this.pending);
    }

    dispose() {
        this.clearPollTimer();
    }

    renderStarting() {
        this.render(`
            <div class="git-new-repository-auth-state">
                <div class="git-new-repository-auth-title">Starting GitHub sign-in...</div>
                <div class="git-github-pending">
                    <div class="git-new-repository-state git-new-repository-loading">
                        <span class="git-new-repository-spinner" aria-hidden="true"></span>
                        <span>Preparing GitHub authorization...</span>
                    </div>
                </div>
            </div>
        `);
    }

    renderPending() {
        const pending = this.pending || {};
        const code = String(pending.userCode || '').trim();
        const renderKey = [
            'pending',
            code,
            String(pending.verificationUri || ''),
            String(pending.verificationUriComplete || ''),
            String(this.error || '')
        ].join('|');
        if (renderKey === this.renderKey) {
            return;
        }
        this.renderKey = renderKey;
        this.render(`
            <div class="git-new-repository-auth-state">
                <div class="git-new-repository-auth-title">Complete sign-in in GitHub.</div>
                <div class="git-github-warning">Enter this code in GitHub. This dialog will continue automatically after approval.</div>
                <div class="git-github-pending">
                    <div class="git-github-code-row">
                        <div class="git-github-code-card">
                            <strong class="git-github-code-value">${escapeHtml(code || 'Waiting')}</strong>
                        </div>
                    </div>
                    <div class="git-github-pending-actions">
                        <button type="button" class="gray-button" data-local-action="continueGithubAuth" ${code ? '' : 'disabled'}>Copy code and open GitHub</button>
                    </div>
                </div>
                ${this.error ? `<div class="git-github-warning">${escapeHtml(this.error)}</div>` : ''}
            </div>
        `);
    }

    render(html) {
        const container = this.getContainer?.();
        if (!container) return;
        setContainerHtml(container, html, { auth: true });
    }

    async ensureAuthorized() {
        if (this.pending) {
            this.renderPending();
            this.schedulePoll(this.pending?.interval);
            return false;
        }
        if (this.startPromise) {
            return this.startPromise;
        }
        this.error = '';
        this.renderKey = '';
        this.renderStarting();
        this.startPromise = (async () => {
            const status = await this.service.githubAuthStatus();
            const currentGithub = status?.github || {};
            if (currentGithub?.connected) {
                this.pending = null;
                return true;
            }
            if (currentGithub?.pending) {
                this.pending = currentGithub.pending;
                this.renderPending();
                this.schedulePoll(this.pending?.interval);
                return false;
            }
            const result = await this.service.startGithubDeviceFlow();
            const github = result?.github || {};
            if (github?.connected) {
                this.pending = null;
                return true;
            }
            this.pending = github.pending || null;
            if (!this.pending) {
                throw new Error('GitHub sign-in did not return a verification code.');
            }
            this.renderPending();
            this.schedulePoll(this.pending?.interval);
            return false;
        })();
        try {
            return await this.startPromise;
        } catch (error) {
            this.onError?.(error?.message || 'Could not start GitHub sign-in.');
            throw error;
        } finally {
            this.startPromise = null;
        }
    }

    async continueGithubAuth() {
        const pending = this.pending || {};
        const code = String(pending.userCode || '').trim();
        const url = String(pending.verificationUriComplete || pending.verificationUri || 'https://github.com/login/device').trim();
        if (code) {
            await this.copyText(code);
        }
        if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }

    schedulePoll(intervalSeconds) {
        this.clearPollTimer();
        const interval = Math.max(5, Number.parseInt(String(intervalSeconds || '5'), 10) || 5);
        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            this.poll();
        }, interval * 1000);
    }

    clearPollTimer() {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async poll() {
        this.error = '';
        try {
            const result = await this.service.pollGithubDeviceFlow();
            const github = result?.github || {};
            if (!github.connected) {
                this.pending = github.pending || this.pending;
                this.error = github.pending ? '' : 'GitHub sign-in was not completed.';
                this.renderPending();
                this.schedulePoll(this.pending?.interval);
                return;
            }
            this.clearPollTimer();
            this.pending = null;
            await this.onAuthorized?.();
        } catch (error) {
            this.error = error?.message || 'Could not verify GitHub sign-in.';
            this.renderPending();
            this.schedulePoll(this.pending?.interval);
        }
    }

    async copyText(value) {
        try {
            if (globalThis.navigator?.clipboard?.writeText) {
                await globalThis.navigator.clipboard.writeText(value);
                return true;
            }
        } catch {}
        try {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
            return true;
        } catch {
            return false;
        }
    }
}
