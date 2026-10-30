import { MEDIA_UPLOAD_ERROR_CODES, processMediaUpload, readAudioMetadata } from '../document-media/mediaUpload.js';
import { buildBlobUrl } from "../document-media/blobUrl.js";
import { getContextualElement } from "../document-media/pluginUtils.js";
const documentModule = assistOS.loadModule("document");

export class AudioPlugin {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;

        this.refreshContext();
        if (!this.isParagraphContext) {
            this.ensureBackgroundSoundHydrated();
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
        this.insertAudioButton = this.element.querySelector('[data-local-action="insertAudio"]');
        this.resetFileInputListener();
        this.audioListElement = this.element.querySelector('.audio-list');
        await this.populateExistingAudio();
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
        this.fileInput.addEventListener("change", this.uploadBackgroundSound.bind(this), { once: true });
    }

    async uploadBackgroundSound(event) {
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
        this.setActionBusy(this.insertAudioButton, true, 'Inserting…');
        try {
            const { uploadResult, metadata } = await processMediaUpload({
                file,
                maxFileSize: 100 * 1024 * 1024,
                metadataReader: readAudioMetadata
            });
            const duration = Number.isFinite(metadata?.duration) ? metadata.duration : 0;
            const blobId = uploadResult.id ?? uploadResult.filename ?? `audio-${Date.now()}`;
            const payload = {
                id: blobId,
                volume: 50,
                duration,
                loop: false,
                start: 0,
                end: duration,
                name: uploadResult.filename || file?.name || blobId
            };
            const result = await this.persistAudioAttachment(payload);
            if (result?.identifier) {
                payload.identifier = result.identifier;
            }
            await this.invalidateCompiledVideo();
            await this.populateExistingAudio();
            assistOS.showToast("Audio saved.", "success");
        } catch (error) {
            if (error?.code === MEDIA_UPLOAD_ERROR_CODES.NO_FILE) {
                return;
            }
            if (error?.code === MEDIA_UPLOAD_ERROR_CODES.TOO_LARGE) {
                showApplicationError("The file is too large.", "Maximum file size is 100MB.", "");
                return;
            }
            console.error("Failed to upload audio", error);
            assistOS.showToast("Failed to upload audio.", "error");
        } finally {
            this.uploadInProgress = false;
            this.setActionBusy(this.insertAudioButton, false);
            if (this.fileInput) {
                this.fileInput.value = "";
            }
            this.resetFileInputListener();
        }
    }

    insertAudio(triggerElement) {
        if (this.uploadInProgress) {
            return;
        }
        this.insertAudioButton = triggerElement || this.insertAudioButton;
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

    async populateExistingAudio() {
        await this.renderAudioList();
    }

    getAudioAttachments() {
        this.refreshContext();
        const host = this.paragraph || this.chapter;
        return host?.mediaAttachments?.audio || [];
    }

    async renderAudioList() {
        const container = this.audioListElement;
        if (!container) {
            return;
        }
        const attachments = this.getAudioAttachments();
        if (!attachments.length) {
            container.innerHTML = '<div class="audio-empty-state">No audio tracks yet.</div>';
            return;
        }
        container.innerHTML = attachments.map((item, index) => this.renderAudioItemTemplate(item, index)).join('');
        this.setupAudioItemInteractions();
    }

    renderAudioItemTemplate(item, index) {
        const sanitize = (value) => typeof assistOS?.UI?.sanitize === 'function' ? assistOS.UI.sanitize(value) : value;
        const escapeAttr = (value) => {
            if (value === undefined || value === null) {
                return '';
            }
            return String(value).replace(/"/g, '&quot;');
        };
        const title = sanitize(item.name || item.filename || item.id || `Audio ${index + 1}`);
        const volume = Number.isFinite(item.volume) ? item.volume : 50;
        const start = Number.isFinite(item.start) ? item.start : 0;
        const endValue = Number.isFinite(item.end) ? item.end : (Number.isFinite(item.duration) ? item.duration : 0);
        const url = sanitize(buildBlobUrl(item.id));
        const durationLabel = Number.isFinite(item.duration) ? `${item.duration.toFixed(2)}s` : '';
        const identifier = item.identifier || item.id || item.name;
        const identifierAttr = escapeAttr(identifier);
        const saveAction = identifier ? `saveAudioItem ${identifier}` : 'saveAudioItem';
        const deleteAction = identifier ? `deleteAudioItem ${identifier}` : 'deleteAudioItem';
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
        <div class="audio-item" data-identifier="${identifierAttr}" data-initial-state="${initialStateAttr}">
            <div class="audio-item-header">
                <span>${title}</span>
                <span>${durationLabel}</span>
            </div>
            <section class="player-container">
                   <audio class="audio-plugin-player" controls preload="metadata" src="${url}"></audio>
                    <label class="audio-item-loop">Loop
                    <input type="checkbox" data-field="loop" ${item.loop ? 'checked' : ''}>
                </label>
            </section>
     
            <div class="audio-item-controls">
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
            <div class="audio-item-actions">
                <button class="general-button" type="button" data-local-action="${saveActionAttr}" disabled>Save</button>
                <button class="general-button danger audio-plugin-action" type="button" data-local-action="${deleteActionAttr}">Delete</button>
            </div>
        </div>`;
    }

    async saveAudioItem(triggerElement, identifier) {
        const container = triggerElement?.closest('.audio-item');
        const targetIdentifier = identifier || container?.dataset?.identifier;
        if (!container || !targetIdentifier) {
            return;
        }
        const attachments = this.getAudioAttachments();
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
            ...current, // Preserve all existing properties
            volume: Number.parseFloat(volumeInput?.value ?? '50'),
            start: Number.parseFloat(startInput?.value ?? '0'),
            end: Number.parseFloat(endInput?.value ?? '0'),
            loop: Boolean(loopInput?.checked)
        };
        try {
            await this.persistAudioAttachment(payload);
            await this.invalidateCompiledVideo();
            this.updateAudioAttachmentModel(current, payload);
            const nextState = {
                volume: payload.volume,
                start: payload.start,
                end: payload.end,
                loop: payload.loop
            };
            this.setAudioItemInitialState(container, nextState);
            const saveButton = container.querySelector('[data-local-action^="saveAudioItem"]');
            if (saveButton) {
                this.updateAudioItemSaveState(container, saveButton);
            }
            assistOS.showToast('Audio updated.', 'success');
        } catch (error) {
            console.error('Failed to update audio track', error);
            assistOS.showToast('Failed to update audio.', 'error');
        }
    }

    setupAudioItemInteractions() {
        if (!this.audioListElement) {
            return;
        }
        const items = Array.from(this.audioListElement.querySelectorAll('.audio-item'));
        items.forEach((item) => {
            const saveButton = item.querySelector('[data-local-action^="saveAudioItem"]');
            if (!saveButton) {
                return;
            }
            const updateState = () => this.updateAudioItemSaveState(item, saveButton);
            item.querySelectorAll('input').forEach((input) => {
                input.addEventListener('input', updateState);
                input.addEventListener('change', updateState);
            });
            updateState();
        });
    }

    updateAudioItemSaveState(container, button) {
        if (!container || !button) {
            return;
        }
        const initialState = this.getAudioItemInitialState(container);
        const currentState = this.getAudioItemCurrentState(container);
        const fields = ['volume', 'start', 'end', 'loop'];
        const isDirty = fields.some((field) => initialState[field] !== currentState[field]);
        button.disabled = !isDirty;
    }

    getAudioItemInitialState(container) {
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

    getAudioItemCurrentState(container) {
        const parseNumber = (input, fallback) => {
            const value = Number.parseFloat(input?.value ?? '');
            return Number.isFinite(value) ? value : fallback;
        };
        return {
            volume: parseNumber(container.querySelector('[data-field="volume"]'), 50),
            start: parseNumber(container.querySelector('[data-field="start"]'), 0),
            end: parseNumber(container.querySelector('[data-field="end"]'), 0),
            loop: Boolean(container.querySelector('[data-field="loop"]')?.checked)
        };
    }

    setAudioItemInitialState(container, state) {
        if (!container) {
            return;
        }
        try {
            container.dataset.initialState = JSON.stringify(state);
        } catch (_) {
            container.dataset.initialState = '';
        }
    }

    updateAudioAttachmentModel(target, payload) {
        if (!target) {
            return;
        }
        Object.assign(target, payload);
    }

    async deleteAudioItem(triggerElement, identifier) {
        if (triggerElement?.getAttribute('aria-busy') === 'true') {
            return;
        }
        const container = triggerElement?.closest('.audio-item');
        const targetIdentifier = identifier || container?.dataset?.identifier;
        if (!targetIdentifier) {
            return;
        }
        this.setActionBusy(triggerElement, true, 'Deleting…');
        try {
            this.refreshContext();
            if (this.isParagraphContext) {
                await documentModule.deleteParagraphAudioAttachment(
                    this._document.id,
                    this.chapter.id,
                    this.paragraph.id,
                    targetIdentifier
                );
            } else {
                await documentModule.deleteChapterAudioAttachment(this._document.id, this.chapter.id, targetIdentifier);
            }
            await this.invalidateCompiledVideo();
            await this.populateExistingAudio();
            assistOS.showToast('Audio removed.', 'info');
        } catch (error) {
            console.error('Failed to delete audio', error);
            assistOS.showToast('Failed to delete audio.', 'error');
        } finally {
            this.setActionBusy(triggerElement, false);
        }
    }

    async persistAudioAttachment(payload) {
        this.refreshContext();
        if (this.isParagraphContext) {
            return documentModule.setParagraphAudioAttachment(
                this._document.id,
                this.chapter.id,
                this.paragraph.id,
                payload
            );
        }
        return documentModule.setChapterAudioAttachment(
            this._document.id,
            this.chapter.id,
            payload
        );
    }

    ensureBackgroundSoundHydrated() {
        this.chapter.mediaAttachments = this.chapter.mediaAttachments || {};
        if (!Array.isArray(this.chapter.mediaAttachments.audio)) {
            this.chapter.mediaAttachments.audio = [];
        }
    }
}
