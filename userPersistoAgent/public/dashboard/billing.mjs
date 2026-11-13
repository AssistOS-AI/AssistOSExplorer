export class UserpersistoBillingPresenter {
    constructor(element, invalidate, callTool) {
        this.element = element;
        this.callTool = callTool;
        this.requestId = 0;
        invalidate();
    }
    beforeRender() {}

    async afterRender() {
        const requestId = ++this.requestId;
        this.form = this.element.querySelector('[data-billing-form]');
        this.controls = this.element.querySelector('[data-billing-controls]');
        this.status = this.element.querySelector('[data-billing-status]');
        this.inputs = [...this.element.querySelectorAll('[data-billing-key]')];
        this.element.querySelector('[data-webhook-url]').value = new URL('/base-agent-additional-server/userPersistoAgent/7000/service/billing/stripe/webhook', location.origin).href;
        this.form.onsubmit = event => { event.preventDefault(); void this.saveConnection(); };
        this.form.hidden = true;
        this.controls.disabled = true;
        try {
            const profile = await this.callTool('userpersisto_profile_get');
            if (requestId !== this.requestId) return;
            if (!profile.capabilities?.includes('admin.agentSettings.manage')) throw new Error('Administrator access is required to configure Stripe.');
            const settings = await this.callTool('userpersisto_config_get');
            if (requestId !== this.requestId) return;
            this.apply(settings);
            this.form.hidden = false;
            this.controls.disabled = false;
            this.message('');
        } catch (error) {
            if (requestId === this.requestId) this.message(error.message, true);
        }
    }
    apply(settings) {
        for (const input of this.inputs) {
            const value = settings[input.dataset.billingKey] || '';
            if (input.type === 'password') {
                input.value = '';
                input.required = !value;
                input.placeholder = value ? 'Configured — leave empty to keep unchanged' : input.dataset.billingKey === 'STRIPE_SECRET_KEY' ? 'sk_test_… or sk_live_…' : 'whsec_…';
            } else input.value = value;
        }
    }
    message(text, error = false) {
        this.status.textContent = text;
        this.status.dataset.error = String(error);
    }
    async saveConnection() {
        if (this.controls.disabled || !this.form.reportValidity()) return;
        const patch = {};
        for (const input of this.inputs) {
            const value = input.value.trim();
            if (value) patch[input.dataset.billingKey] = value;
        }

        const requestId = this.requestId;
        this.controls.disabled = true;
        this.message('Saving connection…');
        try {
            const settings = await this.callTool('userpersisto_config_set', patch);
            if (requestId !== this.requestId) return;
            this.apply(settings);
            this.message('Stripe connection saved. New payments use these settings.');
        } catch (error) {
            if (requestId === this.requestId) this.message(error.message, true);
        } finally {
            if (requestId === this.requestId) this.controls.disabled = false;
        }
    }
    afterUnload() {
        this.requestId++;
        for (const input of this.inputs || []) if (input.type === 'password') input.value = '';
        if (this.controls) this.controls.disabled = true;
        if (this.form) this.form.hidden = true;
    }
    closeModal() {
        this.afterUnload();
        globalThis.assistOS?.UI?.closeModal(this.element, null);
    }
}
