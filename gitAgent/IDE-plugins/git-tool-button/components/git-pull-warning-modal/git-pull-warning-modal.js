export class GitPullWarningModal {
    constructor(element, invalidate) {
        this.element = element;
        let repoPath = '';
        try {
            repoPath = decodeURIComponent(escape(atob(element.getAttribute('data-repoPath') || '')));
        } catch {
            // Ignore malformed display properties.
        }
        this.repoPath = repoPath.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        this.incoming = Math.max(0, Number.parseInt(element.getAttribute('data-incoming'), 10) || 0);
        this.onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this.abort();
        };
        this.dialog = element.closest('dialog') || element;
        this.dialog.addEventListener('keydown', this.onKeyDown, true);
        invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.element.querySelector('.modal-actions [data-local-action="abort"]')?.focus();
    }

    afterUnload() {
        this.dialog.removeEventListener('keydown', this.onKeyDown, true);
    }

    abort() {
        assistOS.UI.closeModal(this.element, { policy: 'abort' });
    }

    stashAndPull() {
        assistOS.UI.closeModal(this.element, { policy: 'stash' });
    }
}
