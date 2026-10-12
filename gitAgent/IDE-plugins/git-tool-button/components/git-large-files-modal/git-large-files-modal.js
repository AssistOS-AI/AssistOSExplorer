const escapeHTML = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export class GitLargeFilesModal {
    constructor(element, invalidate) {
        this.element = element;
        let payload = {};
        try { payload = JSON.parse(decodeURIComponent(escape(atob(element.getAttribute('data-payload') || '')))); } catch {}
        this.repoPath = escapeHTML(payload.repoPath);
        this.operation = payload.operation === 'push' ? 'push' : 'commit';
        this.files = (Array.isArray(payload.files) ? payload.files : []).map((file) =>
            `<li><span>${escapeHTML(file.path)}</span><strong>${(Number(file.sizeBytes) / 1024 / 1024).toFixed(1)} MiB</strong></li>`
        ).join('');
        this.dialog = element.closest('dialog') || element;
        this.onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this.abort();
        };
        this.dialog.addEventListener('keydown', this.onKeyDown, true);
        invalidate();
    }

    beforeRender() {}
    afterRender() { this.element.querySelector('[data-local-action="abort"]')?.focus(); }
    afterUnload() { this.dialog.removeEventListener('keydown', this.onKeyDown, true); }
    abort() { assistOS.UI.closeModal(this.element, { policy: 'abort' }); }
    continueOperation() { assistOS.UI.closeModal(this.element, { policy: 'continue' }); }
}
