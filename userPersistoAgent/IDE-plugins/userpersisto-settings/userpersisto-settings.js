export class UserpersistoSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.requestId = 0;
        this.invalidate();
    }

    async afterRender() {
        const requestId = ++this.requestId;
        const links = this.element.querySelectorAll('[data-capability]');
        const status = this.element.querySelector('[data-account-status]');
        links.forEach((link) => { link.hidden = true; });
        try {
            const response = await fetch('/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/api/profile', {
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            });
            const payload = await response.json().catch(() => null);
            if (requestId !== this.requestId) return;
            if (!response.ok || payload?.ok !== true || !payload.profile?.user) throw new Error('Account access could not be verified.');
            const capabilities = Array.isArray(payload.profile.capabilities) ? payload.profile.capabilities : [];
            links.forEach((link) => { link.hidden = !capabilities.includes(link.dataset.capability); });
            if (status) status.textContent = '';
        } catch (_) {
            if (requestId === this.requestId && status) status.textContent = 'Account permissions could not be loaded. Open My Account to continue.';
        }
    }

    afterUnload() {
        this.requestId += 1;
    }

    closeModal() {
        this.afterUnload();
        globalThis.assistOS?.UI?.closeModal(this.element, null);
    }
}
