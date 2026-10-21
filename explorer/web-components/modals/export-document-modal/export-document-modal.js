import { createDocumentDocx } from '../../../services/document/documentDocxExport.js';

const documentModule = assistOS.loadModule("document");

export class ExportDocumentModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.documentId = this.element.getAttribute('data-id');
        this.documentTitle = this.element.getAttribute('data-title');
        this.boundsOnCompleteExport = this.onCompleteExport.bind(this);
        this.invalidate();
    }

    async beforeRender() {
    }

    async afterRender(){

    }

    async openSettingsPage(eventTarget){
        await this.closeModal();
        await assistOS.UI.changeToDynamicPage("settings-page","settings-page",{subpage:"settingsTab"});
    }

    async closeModal() {
        await assistOS.UI.closeModal(this.element);
    }

    async onCompleteExport(status) {
        if (status === "failed") {
            showApplicationError("Export failed", data.error);
            assistOS.UI.closeModal(this.element);
        } else if (status === "completed") {
            let exportButton = this.element.querySelector('.export-button');
            exportButton.classList.remove('loading-icon');
            exportButton.innerHTML = 'Download';
            exportButton.setAttribute('data-local-action', `downloadArchive`);
        }
    }

    async downloadArchive(targetElement) {
        const url = `/documents/export/${this.taskId}`;
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        if (this.exportType === 'full') {
            a.download = `${this.documentTitle}.docai`;
        } else {
            a.download = `${this.documentTitle}_partial.docai`;
        }
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        await assistOS.UI.closeModal(this.element);
        delete this.taskId;
    }

    async exportDocument(button) {
        button.classList.add('loading-icon');
        button.innerHTML = '';

        let checkBox = this.element.querySelector('input[type="checkbox"]');
        this.exportType = checkBox.checked ? 'full' : 'partial';
        try {
            this.taskId = await documentModule.exportDocument(this.documentId, this.exportType);
            await assistOS.NotificationRouter.subscribeToWorkspace?.(this.taskId, this.boundsOnCompleteExport);
        } catch (e) {
            button.classList.remove('loading-icon');
            button.innerHTML = 'Export as AOS';
        }
    }

    async exportDOCX(button) {
        if (this.docxExportInProgress) {
            return;
        }
        this.docxExportInProgress = true;
        if (button) {
            button.disabled = true;
        }
        let url;
        let link;
        try {
            const documentModel = await documentModule.getDocument(this.documentId);
            const bytes = createDocumentDocx(documentModel);
            const blob = new Blob([bytes], {
                type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            });
            url = URL.createObjectURL(blob);
            link = document.createElement('a');
            link.href = url;
            const firstChapter = documentModel.chapters[0];
            const title = [documentModel.title, this.documentTitle, firstChapter?.headingText, firstChapter?.title]
                .find((value) => typeof value === 'string' && value.trim() && !['undefined', 'null'].includes(value));
            const fileName = (title || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
            link.download = `${fileName}.docx`;
            document.body.appendChild(link);
            link.click();
        } catch (error) {
            await window.showApplicationError('Export failed', 'The DOCX file could not be created. Please try again.');
        } finally {
            link?.remove();
            if (url) {
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
            this.docxExportInProgress = false;
            if (button) {
                button.disabled = false;
            }
        }
    }

    async exportHTML() {
        const documentId = this.documentId;

        let htmlContent;
        try {
            console.log("No settings sent to server.");

            const response = await fetch(`/documents/export/html/${documentId}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.statusText}`);
            }

            htmlContent = await response.text();
        } catch (error) {
            alert(`Error exporting document as HTML: ${error.message || error}`);
            return;
        }

        const blob = new Blob([htmlContent], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${this.documentId}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

}
