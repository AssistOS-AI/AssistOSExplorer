import { MEDIA_UPLOAD_ERROR_CODES, processMediaUpload, readImageMetadata } from '../document-media/mediaUpload.js';
import { buildBlobUrl } from "../document-media/blobUrl.js";
import { getContextualElement } from "../document-media/pluginUtils.js";
const documentModule = assistOS.loadModule("document");

const formatFileSize = (size = 0) => {
    if (!size) {
        return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
    const value = size / Math.pow(1024, index);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
};

export class ImagePlugin {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;

        this.refreshContext();
        if (!this.isParagraphContext) {
            this.ensureBackgroundImageHydrated();
        }
        this.invalidate();
    }

    beforeRender() {}

    refreshContext() {
        const { document, chapter, paragraph } = getContextualElement(this.element);
        this._document = document;
        this.chapter = chapter;
        this.paragraph = paragraph;
        this.isParagraphContext = !!this.paragraph;
    }

    async afterRender() {
        this.refreshContext();
        this.fileInput = this.element.querySelector(".file-input");
        this.insertImageButton = this.element.querySelector('[data-local-action="insertImage"]');
        this.resetFileInputListener();
        this.imageListElement = this.element.querySelector('.image-list');
        await this.populateExistingImages();
    }

    setActionBusy(button, busy, busyLabel) {
        if (!button) {
            return;
        }
        if (busy) {
            button.dataset.idleLabel = button.textContent.trim();
            button.textContent = busyLabel;
            button.classList.add('is-loading');
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            return;
        }
        button.textContent = button.dataset.idleLabel || button.textContent;
        delete button.dataset.idleLabel;
        button.classList.remove('is-loading');
        button.disabled = false;
        button.removeAttribute('aria-busy');
    }

    resetFileInputListener() {
        this.fileInput.addEventListener("change", this.uploadImageAttachment.bind(this), { once: true });
    }

    async uploadImageAttachment(event) {
        const file = event?.target?.files?.[0];
        if (!file) {
            this.fileInput.value = "";
            this.resetFileInputListener();
            return;
        }
        if (this.uploadInProgress) {
            return;
        }
        this.uploadInProgress = true;
        this.setActionBusy(this.insertImageButton, true, 'Inserting…');
        try {
            const { uploadResult, metadata } = await processMediaUpload({
                file,
                maxFileSize: 100 * 1024 * 1024,
                metadataReader: readImageMetadata
            });
            if (file?.type === 'image/svg+xml' || (file?.name || '').toLowerCase().endsWith('.svg')) {
                throw new Error('SVG images are not supported. Please upload PNG/JPG.');
            }
            const blobId = uploadResult.id ?? uploadResult.filename ?? `image-${Date.now()}`;
            const payload = {
                id: blobId,
                width: metadata?.width ?? 0,
                height: metadata?.height ?? 0,
                size: file?.size ?? 0,
                name: uploadResult.filename || file?.name || blobId
            };
            const result = await this.persistImageAttachment(payload);
            if (result?.identifier) {
                payload.identifier = result.identifier;
            }
            await this.invalidateCompiledVideo();
            await this.populateExistingImages();
            assistOS.showToast("Image saved.", "success");
        } catch (error) {
            if (error?.code === MEDIA_UPLOAD_ERROR_CODES.NO_FILE) {
                return;
            }
            if (error?.code === MEDIA_UPLOAD_ERROR_CODES.TOO_LARGE) {
                showApplicationError("The file is too large.", "Maximum file size is 100MB.", "");
                return;
            }
            console.error("Failed to upload image", error);
            assistOS.showToast("Failed to upload image.", "error");
        } finally {
            this.uploadInProgress = false;
            this.setActionBusy(this.insertImageButton, false);
            if (this.fileInput) {
                this.fileInput.value = "";
            }
            this.resetFileInputListener();
        }
    }

    insertImage(triggerElement) {
        if (this.uploadInProgress) {
            return;
        }
        this.insertImageButton = triggerElement || this.insertImageButton;
        this.fileInput.click();
    }

    async closeModal() {
        assistOS.UI.closeModal(this.element);
    }

    async invalidateCompiledVideo() {
        this.refreshContext();
        if (this.isParagraphContext) {
            return;
        }
        if (this.chapter.commands.compileVideo) {
            delete this.chapter.commands.compileVideo;
            await documentModule.updateChapterCommands(this._document.id, this.chapter.id, this.chapter.commands);
        }
    }

    async populateExistingImages() {
        await this.renderImageList();
    }

    getImageAttachments() {
        this.refreshContext();
        const host = this.paragraph || this.chapter;
        return host?.mediaAttachments?.image || [];
    }

    async renderImageList() {
        const container = this.imageListElement;
        if (!container) {
            return;
        }
        const attachments = this.getImageAttachments();
        if (!attachments.length) {
            container.innerHTML = '<div class="image-empty-state">No images yet.</div>';
            return;
        }
        container.innerHTML = attachments.map((item, index) => this.renderImageItemTemplate(item, index)).join('');
    }

    renderImageItemTemplate(item, index) {
        const sanitize = (value) => typeof assistOS?.UI?.sanitize === 'function' ? assistOS.UI.sanitize(value) : value;
        const escapeAttr = (value) => {
            if (value === undefined || value === null) {
                return '';
            }
            return String(value).replace(/"/g, '&quot;');
        };
        const title = sanitize(item.name || item.filename || item.id || `Image ${index + 1}`);
        const url = sanitize(buildBlobUrl(item.id));
        const sizeLabel = formatFileSize(item.size);
        const dimensions = item.width && item.height ? `${item.width}×${item.height}` : '--';
        const identifier = item.identifier || item.id || item.name;
        const identifierAttr = escapeAttr(identifier);
        const deleteAction = identifier ? `deleteImageItem ${identifier}` : 'deleteImageItem';
        const deleteActionAttr = escapeAttr(deleteAction);
        return `
        <div class="image-item" data-identifier="${identifierAttr}">
            <div class="image-item-header">
                <span>${title}</span>
                <span>${dimensions}</span>
            </div>
            <div class="image-item-preview">
                <img loading="lazy" src="${url}" alt="${title}">
            </div>
            <div class="image-item-details">
                ${sizeLabel !== '0 B' ? `<div><strong>Size:</strong> ${sizeLabel}</div>` : ''}
                ${dimensions !== '--' ? `<div><strong>Dimensions:</strong> ${dimensions}</div>` : ''}
            </div>
            <div class="image-item-actions">
                <button class="general-button danger image-plugin-action" type="button" data-local-action="${deleteActionAttr}">Delete</button>
            </div>
        </div>`;
    }

    async deleteImageItem(triggerElement, identifier) {
        if (triggerElement?.getAttribute('aria-busy') === 'true') {
            return;
        }
        const container = triggerElement?.closest('.image-item');
        const targetIdentifier = identifier || container?.dataset?.identifier;
        if (!targetIdentifier) {
            return;
        }
        this.setActionBusy(triggerElement, true, 'Deleting…');
        try {
            this.refreshContext();
            if (this.isParagraphContext) {
                await documentModule.deleteParagraphImageAttachment(
                    this._document.id,
                    this.chapter.id,
                    this.paragraph.id,
                    targetIdentifier
                );
            } else {
                await documentModule.deleteChapterImageAttachment(this._document.id, this.chapter.id, targetIdentifier);
            }
            await this.invalidateCompiledVideo();
            await this.populateExistingImages();
            assistOS.showToast('Image removed.', 'info');
        } catch (error) {
            console.error('Failed to delete image', error);
            assistOS.showToast('Failed to delete image.', 'error');
        } finally {
            this.setActionBusy(triggerElement, false);
        }
    }

    async persistImageAttachment(payload) {
        this.refreshContext();
        if (this.isParagraphContext) {
            return documentModule.setParagraphImageAttachment(
                this._document.id,
                this.chapter.id,
                this.paragraph.id,
                payload
            );
        }
        return documentModule.setChapterImageAttachment(
            this._document.id,
            this.chapter.id,
            payload
        );
    }

    ensureBackgroundImageHydrated() {
        this.chapter.mediaAttachments = this.chapter.mediaAttachments || {};
        if (!Array.isArray(this.chapter.mediaAttachments.image)) {
            this.chapter.mediaAttachments.image = [];
        }
    }
}
