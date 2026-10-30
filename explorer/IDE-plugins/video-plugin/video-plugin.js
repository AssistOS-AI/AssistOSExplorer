import { MEDIA_UPLOAD_ERROR_CODES, processMediaUpload, readVideoMetadata } from '../document-media/mediaUpload.js';
import { buildBlobUrl } from "../document-media/blobUrl.js";
import { getContextualElement } from "../document-media/pluginUtils.js";
const documentModule = assistOS.loadModule("document");

export class VideoPlugin {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;

        this.refreshContext();
        if (!this.isParagraphContext) {
            this.ensureBackgroundVideoHydrated();
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
        this.insertVideoButton = this.element.querySelector('[data-local-action="insertVideo"]');
        this.resetFileInputListener();
        this.videoListElement = this.element.querySelector('.video-list');
        await this.populateExistingVideos();
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
        this.fileInput.addEventListener("change", this.uploadVideoAttachment.bind(this), { once: true });
    }

    async uploadVideoAttachment(event) {
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
        this.setActionBusy(this.insertVideoButton, true, 'Inserting…');
        try {
            const { uploadResult, metadata } = await processMediaUpload({
                file,
                maxFileSize: 500 * 1024 * 1024,
                metadataReader: readVideoMetadata
            });
            const duration = Number.isFinite(metadata?.duration) ? metadata.duration : 0;
            const blobId = uploadResult.id ?? uploadResult.filename ?? `video-${Date.now()}`;
            const payload = {
                id: blobId,
                loop: false,
                start: 0,
                end: duration,
                duration,
                volume: 100,
                name: uploadResult.filename || file?.name || blobId
            };
            const result = await this.persistVideoAttachment(payload);
            if (result?.identifier) {
                payload.identifier = result.identifier;
            }
            await this.invalidateCompiledVideo();
            await this.populateExistingVideos();
            assistOS.showToast("Video saved.", "success");
        } catch (error) {
            if (error?.code === MEDIA_UPLOAD_ERROR_CODES.NO_FILE) {
                return;
            }
            if (error?.code === MEDIA_UPLOAD_ERROR_CODES.TOO_LARGE) {
                showApplicationError("The file is too large.", "Maximum file size is 500MB.", "");
                return;
            }
            console.error("Failed to upload video", error);
            assistOS.showToast("Failed to upload video.", "error");
        } finally {
            this.uploadInProgress = false;
            this.setActionBusy(this.insertVideoButton, false);
            if (this.fileInput) {
                this.fileInput.value = "";
            }
            this.resetFileInputListener();
        }
    }

    insertVideo(triggerElement) {
        if (this.uploadInProgress) {
            return;
        }
        this.insertVideoButton = triggerElement || this.insertVideoButton;
        this.fileInput.click();
    }

    async closeModal() {
        assistOS.UI.closeModal(this.element);
    }

    async populateExistingVideos() {
        await this.renderVideoList();
    }

    getVideoAttachments() {
        this.refreshContext();
        const host = this.paragraph || this.chapter;
        return host?.mediaAttachments?.video || [];
    }

    async renderVideoList() {
        const container = this.videoListElement;
        if (!container) {
            return;
        }
        const attachments = this.getVideoAttachments();
        if (!attachments.length) {
            container.innerHTML = '<div class="video-empty-state">No video tracks yet.</div>';
            return;
        }
        container.innerHTML = attachments.map((item, index) => this.renderVideoItemTemplate(item, index)).join('');
        this.setupVideoItemInteractions();
    }

    renderVideoItemTemplate(item, index) {
        const sanitize = (value) => typeof assistOS?.UI?.sanitize === 'function' ? assistOS.UI.sanitize(value) : value;
        const escapeAttr = (value) => {
            if (value === undefined || value === null) {
                return '';
            }
            return String(value).replace(/"/g, '&quot;');
        };
        const title = sanitize(item.name || item.filename || item.id || `Video ${index + 1}`);
        const volume = Number.isFinite(item.volume) ? item.volume : 100;
        const start = Number.isFinite(item.start) ? item.start : 0;
        const endValue = Number.isFinite(item.end) ? item.end : (Number.isFinite(item.duration) ? item.duration : 0);
        const url = sanitize(buildBlobUrl(item.id));
        const durationLabel = Number.isFinite(item.duration) ? `${item.duration.toFixed(2)}s` : '';
        const identifier = item.identifier || item.id || item.name;
        const identifierAttr = escapeAttr(identifier);
        const saveAction = identifier ? `saveVideoItem ${identifier}` : 'saveVideoItem';
        const deleteAction = identifier ? `deleteVideoItem ${identifier}` : 'deleteVideoItem';
        const saveActionAttr = escapeAttr(saveAction);
        const deleteActionAttr = escapeAttr(deleteAction);
        const initialState = {
            volume,
            start,
            end: endValue,
            loop: Boolean(item.loop)
        };
        const initialStateAttr = escapeAttr(JSON.stringify(initialState));
        return `
        <div class="video-item" data-identifier="${identifierAttr}" data-initial-state="${initialStateAttr}">
            <div class="video-item-header">
                <span>${title}</span>
                <span>${durationLabel}</span>
            </div>
            <video controls preload="metadata" src="${url}"></video>
                            <label>Loop
                    <input type="checkbox" data-field="loop" ${item.loop ? 'checked' : ''}>
                </label>
            <div class="video-item-controls">
                <label>Volume
                    <input type="number" min="0" max="100" step="1" data-field="volume" value="${volume}">
                </label>
                <label>Start (s)
                    <input type="number" min="0" step="0.1" data-field="start" value="${start}">
                </label>
                <label>End (s)
                    <input type="number" min="0" step="0.1" data-field="end" value="${endValue}">
                </label>
            </div>
            <div class="video-item-actions">
                <button class="general-button" type="button" data-local-action="${saveActionAttr}" disabled>Save</button>
                <button class="general-button danger video-plugin-action" type="button" data-local-action="${deleteActionAttr}">Delete</button>
            </div>
        </div>`;
    }

    async saveVideoItem(triggerElement, identifier) {
        const container = triggerElement?.closest('.video-item');
        const targetIdentifier = identifier || container?.dataset?.identifier;
        if (!container || !targetIdentifier) {
            return;
        }
        const attachments = this.getVideoAttachments();
        const current = attachments.find((attachment) =>
            attachment.identifier === targetIdentifier || attachment.id === targetIdentifier || attachment.name === targetIdentifier
        );
        if (!current) {
            return;
        }
        const volumeInput = container.querySelector('[data-field="volume"]');
        const startInput = container.querySelector('[data-field="start"]');
        const endInput = container.querySelector('[data-field="end"]');
        const loopInput = container.querySelector('[data-field="loop"]');
        const payload = {
            ...current,
            volume: Number.parseFloat(volumeInput?.value ?? '100'),
            start: Number.parseFloat(startInput?.value ?? '0'),
            end: Number.parseFloat(endInput?.value ?? '0'),
            loop: Boolean(loopInput?.checked)
        };
        try {
            await this.persistVideoAttachment(payload);
            await this.invalidateCompiledVideo();
            this.updateVideoAttachmentModel(current, payload);
            const nextState = {
                volume: payload.volume,
                start: payload.start,
                end: payload.end,
                loop: payload.loop
            };
            this.setVideoItemInitialState(container, nextState);
            const saveButton = container.querySelector('[data-local-action^="saveVideoItem"]');
            if (saveButton) {
                this.updateVideoItemSaveState(container, saveButton);
            }
            assistOS.showToast('Video updated.', 'success');
        } catch (error) {
            console.error('Failed to update video track', error);
            assistOS.showToast('Failed to update video.', 'error');
        }
    }

    setupVideoItemInteractions() {
        if (!this.videoListElement) {
            return;
        }
        const items = Array.from(this.videoListElement.querySelectorAll('.video-item'));
        items.forEach((item) => {
            const saveButton = item.querySelector('[data-local-action^="saveVideoItem"]');
            if (!saveButton) {
                return;
            }
            const updateState = () => this.updateVideoItemSaveState(item, saveButton);
            item.querySelectorAll('input').forEach((input) => {
                input.addEventListener('input', updateState);
                input.addEventListener('change', updateState);
            });
            updateState();
        });
    }

    updateVideoItemSaveState(container, button) {
        if (!container || !button) {
            return;
        }
        const initialState = this.getVideoItemInitialState(container);
        const currentState = this.getVideoItemCurrentState(container);
        const fields = ['volume', 'start', 'end', 'loop'];
        const isDirty = fields.some((field) => initialState[field] !== currentState[field]);
        button.disabled = !isDirty;
    }

    getVideoItemInitialState(container) {
        const raw = container?.dataset?.initialState || '';
        if (!raw) {
            return {};
        }
        try {
            return JSON.parse(raw);
        } catch (_) {
            return {};
        }
    }

    getVideoItemCurrentState(container) {
        const parseNumber = (input, fallback) => {
            const value = Number.parseFloat(input?.value ?? '');
            return Number.isFinite(value) ? value : fallback;
        };
        return {
            volume: parseNumber(container.querySelector('[data-field="volume"]'), 100),
            start: parseNumber(container.querySelector('[data-field="start"]'), 0),
            end: parseNumber(container.querySelector('[data-field="end"]'), 0),
            loop: Boolean(container.querySelector('[data-field="loop"]')?.checked)
        };
    }

    setVideoItemInitialState(container, state) {
        if (!container) {
            return;
        }
        try {
            container.dataset.initialState = JSON.stringify(state);
        } catch (_) {
            container.dataset.initialState = '';
        }
    }

    updateVideoAttachmentModel(target, payload) {
        if (!target) {
            return;
        }
        Object.assign(target, payload);
    }

    async deleteVideoItem(triggerElement, identifier) {
        if (triggerElement?.getAttribute('aria-busy') === 'true') {
            return;
        }
        const container = triggerElement?.closest('.video-item');
        const targetIdentifier = identifier || container?.dataset?.identifier;
        if (!targetIdentifier) {
            return;
        }
        this.setActionBusy(triggerElement, true, 'Deleting…');
        try {
            this.refreshContext();
            if (this.isParagraphContext) {
                await documentModule.deleteParagraphVideoAttachment(
                    this._document.id,
                    this.chapter.id,
                    this.paragraph.id,
                    targetIdentifier
                );
            } else {
                await documentModule.deleteChapterVideoAttachment(this._document.id, this.chapter.id, targetIdentifier);
            }
            await this.invalidateCompiledVideo();
            await this.populateExistingVideos();
            assistOS.showToast('Video removed.', 'info');
        } catch (error) {
            console.error('Failed to delete video', error);
            assistOS.showToast('Failed to delete video.', 'error');
        } finally {
            this.setActionBusy(triggerElement, false);
        }
    }

    async persistVideoAttachment(payload) {
        this.refreshContext();
        if (this.isParagraphContext) {
            return documentModule.setParagraphVideoAttachment(
                this._document.id,
                this.chapter.id,
                this.paragraph.id,
                payload
            );
        }
        return documentModule.setChapterVideoAttachment(
            this._document.id,
            this.chapter.id,
            payload
        );
    }

    ensureBackgroundVideoHydrated() {
        this.chapter.mediaAttachments = this.chapter.mediaAttachments || {};
        if (!Array.isArray(this.chapter.mediaAttachments.video)) {
            this.chapter.mediaAttachments.video = [];
        }
    }

    async invalidateCompiledVideo() {
        this.refreshContext();
        if (this.isParagraphContext) {
            return;
        }
        if (this.chapter.commands?.compileVideo) {
            delete this.chapter.commands.compileVideo;
            await documentModule.updateChapterCommands(this._document.id, this.chapter.id, this.chapter.commands);
        }
    }
}
