import { uploadWorkspaceImage } from '/explorer/services/media/workspaceImageUpload.js';
import { remapScriptaVariantImagePositions } from '/explorer/shared/document/scripta-document.js';
import {
    createScriptaVariantId as createVariantId,
    createScriptaVariantImageId,
    normalizeScriptaVariantImageLayout,
    serializeScriptaVariant,
    assertScriptaVariantOwner,
    deleteScriptaVariant,
    getScriptaReactionStats as getReactionStats,
    getScriptaWinningVariant as getWinningVariant,
    normalizeScriptaReactionType as normalizeReactionType,
    normalizeScriptaState,
    setScriptaReaction as setReaction,
    SCRIPTA_REACTION_DISLIKE as REACTION_DISLIKE,
    SCRIPTA_REACTION_LIKE as REACTION_LIKE
} from "/explorer/shared/document/scripta-state.js";

function decodeContext(element) {
    try {
        return JSON.parse(decodeURIComponent(element.getAttribute("data-context") || "{}"));
    } catch (error) {
        console.error("Invalid SCRIPTA context", error);
        return {};
    }
}

function escapeHtml(value = "") {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function sanitizeText(value = "") {
    return assistOS?.UI?.sanitize ? assistOS.UI.sanitize(String(value ?? "")) : String(value ?? "");
}

function displayText(value = "") {
    return assistOS?.UI?.unsanitize ? assistOS.UI.unsanitize(String(value ?? "")) : String(value ?? "");
}

async function sha256Hex(value) {
    const input = String(value || "");
    if (!globalThis.crypto?.subtle || typeof TextEncoder === "undefined") {
        throw new Error("Secure browser hashing is required for SCRIPTA variant ownership.");
    }
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getAuthenticatedUser() {
    const user = assistOS?.user || {};
    const key = String(user.id || user.userId || user.sub || user.email || user.username || user.name || "").trim();
    const label = String(user.name || user.username || user.email || key || "").trim();
    return { key, label };
}

export class ScriptaVariants {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.context = decodeContext(element);
        this.hostElement = document.querySelector(this.context.hostSelector || "");
        this.paragraphPresenter = this.hostElement?.webSkelPresenter || null;
        this.documentPresenter = this.hostElement?.closest("document-view-page")?.webSkelPresenter
            || document.querySelector("document-view-page")?.webSkelPresenter
            || null;
        this.document = this.documentPresenter?._document || null;
        this.chapter = this.document?.chapters?.find((chapter) => chapter.id === this.context.chapterId) || null;
        this.paragraph = this.chapter?.paragraphs?.find((paragraph) => paragraph.id === this.context.paragraphId) || null;
        this.userHash = "";
        this.userLabel = "";
        this.disabledReason = "";
        this.activeTabVariantId = "";
        this.handleSharedSelect = (event) => {
            this.activeTabVariantId = String(event.detail?.variantId || "");
        };
        this.handleSharedVote = (event) => void this.reactVariant(event.detail || {});
        this.handleSharedAdd = (event) => void this.addVariant(event.detail?.text);
        this.handleSharedEdit = (event) => void this.editVariant(event.detail || {});
        this.handleSharedDelete = (event) => void this.deleteVariant(event.detail || {});
        this.imageHandlers = Object.fromEntries(['insert', 'replace', 'delete', 'layout'].map((operation) => [
            `scripta-p-variant-image-${operation}`,
            (event) => void this.mutateVariantImage(operation, event.detail || {}),
        ]));
        this.invalidate();
    }

    async beforeRender() {
        this.disabledReason = "";
        if (!this.paragraph) this.disabledReason = "Paragraph context is not available.";
        if (!this.disabledReason && !this.hostElement) this.disabledReason = "Paragraph host is not available.";
        const authUser = getAuthenticatedUser();
        if (!this.disabledReason && !authUser.key) this.disabledReason = "Authentication is required for SCRIPTA voting.";
        if (!this.disabledReason && this.hostElement?.closest("[data-virtual-provider='dpu']")) {
            this.disabledReason = "SCRIPTA is not available for DPU files.";
        }
        if (!this.userHash && !this.disabledReason) {
            try {
                this.userHash = `participant-${(await sha256Hex(authUser.key)).slice(0, 24)}`;
                this.userLabel = authUser.label || this.userHash;
            } catch (error) {
                this.disabledReason = error.message;
            }
        }
        if (this.paragraph) this.ensureInitialState();
        this.disabledNotice = this.disabledReason
            ? `<div class="scripta-disabled-notice">${escapeHtml(this.disabledReason)}</div>`
            : "";
    }

    async afterRender() {
        this.variantsView = this.element.querySelector("[data-role='scriptaVariantsView']");
        this.variantsView?.addEventListener("scripta-p-variant-select", this.handleSharedSelect);
        this.variantsView?.addEventListener("scripta-p-variant-vote", this.handleSharedVote);
        this.variantsView?.addEventListener("scripta-p-variant-add", this.handleSharedAdd);
        this.variantsView?.addEventListener("scripta-p-variant-edit", this.handleSharedEdit);
        this.variantsView?.addEventListener("scripta-p-variant-delete", this.handleSharedDelete);
        for (const [type, handler] of Object.entries(this.imageHandlers)) {
            this.variantsView?.addEventListener(type, handler);
        }
        await this.syncSharedView();
    }

    afterUnload() {
        for (const [type, handler] of Object.entries(this.imageHandlers)) {
            this.variantsView?.removeEventListener(type, handler);
        }
    }

    ensureInitialState() {
        const state = normalizeScriptaState(this.paragraph);
        if (!state.variants.length) {
            const now = new Date().toISOString();
            const initialVariant = {
                id: createVariantId(),
                text: String(this.paragraph.text || ""),
                createdBy: this.userHash,
                createdAt: now,
                updatedAt: now
            };
            state.variants.push(initialVariant);
            state.activeVariantId = initialVariant.id;
        }
        const winner = getWinningVariant(state);
        if (winner) {
            state.activeVariantId = winner.id;
            this.paragraph.text = serializeScriptaVariant(winner);
        }
        this.activeTabVariantId = state.activeVariantId || state.variants[0]?.id || "";
    }

    buildSharedViewData() {
        const state = this.paragraph
            ? normalizeScriptaState(this.paragraph)
            : { variants: [], reactionsByVariant: {}, activeVariantId: "" };
        const viewerVoteEntry = Object.entries(state.reactionsByVariant || {}).find(([, reactions]) => reactions?.[this.userHash]);
        return {
            variants: state.variants.map((variant, index) => {
                const reactions = Object.values(state.reactionsByVariant?.[variant.id] || {});
                return {
                    ...variant,
                    ordinal: index + 1,
                    canEdit: Boolean(this.userHash && variant.createdBy === this.userHash),
                    canDelete: Boolean(
                        this.userHash
                        && variant.createdBy === this.userHash
                        && state.variants.length > 1
                    ),
                    ...getReactionStats(state, variant.id),
                    voters: {
                        likes: reactions.filter((reaction) => reaction.type === REACTION_LIKE).map((reaction) => reaction.userLabel || reaction.userHash),
                        dislikes: reactions.filter((reaction) => reaction.type === REACTION_DISLIKE).map((reaction) => reaction.userLabel || reaction.userHash)
                    }
                };
            }),
            activeVariantId: state.activeVariantId,
            selectedVariantId: this.activeTabVariantId,
            viewerVote: viewerVoteEntry
                ? { variantId: viewerVoteEntry[0], type: viewerVoteEntry[1][this.userHash]?.type || "" }
                : null,
            editable: true,
            disabled: Boolean(this.disabledReason),
            allowAdd: true,
            allowReformulate: false
        };
    }

    updateMutationControls() {
        const host = this.element || this.variantsView;
        this.mutationControls ||= new Map();
        if (this.mutationBusy) {
            host?.setAttribute('aria-busy', 'true');
            this.variantsView?.setAttribute('inert', '');
            for (const control of host?.querySelectorAll('button, input, textarea, select') || []) {
                if (!this.mutationControls.has(control)) this.mutationControls.set(control, control.disabled);
                control.disabled = true;
            }
        } else {
            for (const [control, disabled] of this.mutationControls) control.disabled = disabled;
            this.mutationControls.clear();
            host?.removeAttribute('aria-busy');
            this.variantsView?.removeAttribute('inert');
        }
    }

    async syncSharedView() {
        if (!this.variantsView) return;
        await this.variantsView.presenterReadyPromise;
        this.variantsView.webSkelPresenter?.setData?.(this.buildSharedViewData());
        this.updateMutationControls();
    }

    async runMutation(operation) {
        if (this.disabledReason || this.mutationBusy) return;
        this.mutationBusy = true;
        this.mutationPersisted = false;
        this.updateMutationControls();
        const before = JSON.parse(JSON.stringify(normalizeScriptaState(this.paragraph)));
        const oldText = this.paragraph.text;
        const oldSelection = this.activeTabVariantId;
        try {
            await operation();
        } catch (error) {
            if (!this.mutationPersisted) {
                this.paragraph.pluginState.scripta = before;
                this.paragraph.metadata.pluginState = this.paragraph.pluginState;
                this.paragraph.text = oldText;
                this.activeTabVariantId = oldSelection;
            }
            try {
                await this.syncSharedView();
            } catch {
                // Controls must recover even if the closed or stale view cannot refresh.
            }
            assistOS.showToast?.(error?.message || 'The SCRIPTA change could not be saved.', 'error');
        } finally {
            this.mutationBusy = false;
            this.updateMutationControls();
        }
    }

    async addVariant(value) {
        return this.runMutation(() => this.addVariantImpl(value));
    }

    async reactVariant(payload) {
        return this.runMutation(() => this.reactVariantImpl(payload));
    }

    async editVariant(payload) {
        return this.runMutation(() => this.editVariantImpl(payload));
    }

    async deleteVariant(payload) {
        return this.runMutation(() => this.deleteVariantImpl(payload));
    }

    async mutateVariantImage(operation, payload) {
        return this.runMutation(() => this.mutateVariantImageImpl(operation, payload));
    }

    async addVariantImpl(value) {
        if (this.disabledReason) return assistOS.showToast?.(this.disabledReason, "warning");
        const text = sanitizeText(value || "").trim();
        if (!text) return assistOS.showToast?.("Variant text is required.", "warning");
        const state = normalizeScriptaState(this.paragraph);
        const now = new Date().toISOString();
        const variant = { id: createVariantId(), text, createdBy: this.userHash, createdAt: now, updatedAt: now };
        state.variants.push(variant);
        setReaction(state, variant.id, this.userHash, this.userLabel, REACTION_LIKE);
        this.activeTabVariantId = variant.id;
        await this.persistState();
        await this.syncSharedView();
        assistOS.showToast?.("Variant added.", "success");
    }

    async reactVariantImpl({ variantId, type } = {}) {
        if (this.disabledReason) return assistOS.showToast?.(this.disabledReason, "warning");
        const state = normalizeScriptaState(this.paragraph);
        if (!state.variants.some((variant) => variant.id === variantId)) {
            return assistOS.showToast?.("Variant not found.", "error");
        }
        setReaction(state, variantId, this.userHash, this.userLabel, normalizeReactionType(type));
        this.activeTabVariantId = variantId;
        await this.syncSharedView();
        await this.persistState();
        await this.syncSharedView();
    }

    async editVariantImpl({ variantId, text } = {}) {
        if (this.disabledReason) return assistOS.showToast?.(this.disabledReason, "warning");
        const state = normalizeScriptaState(this.paragraph);
        const variant = state.variants.find((entry) => entry.id === String(variantId || ""));
        if (!variant) return assistOS.showToast?.("Variant not found.", "error");
        try {
            assertScriptaVariantOwner(variant, this.userHash);
        } catch (error) {
            return assistOS.showToast?.(error.message, "error");
        }
        const nextText = sanitizeText(text);
        variant.images = remapScriptaVariantImagePositions(variant.images, variant.text, nextText);
        variant.text = nextText;
        variant.updatedAt = new Date().toISOString();
        this.activeTabVariantId = variant.id;
        await this.persistState();
        await this.syncSharedView();
    }

    async deleteVariantImpl({ variantId } = {}) {
        if (this.disabledReason) return assistOS.showToast?.(this.disabledReason, "warning");
        try {
            deleteScriptaVariant(this.paragraph, variantId, { deletedBy: this.userHash });
        } catch (error) {
            return assistOS.showToast?.(error.message, "error");
        }
        const state = normalizeScriptaState(this.paragraph);
        this.activeTabVariantId = state.activeVariantId || state.variants[0]?.id || "";
        await this.persistState();
        await this.syncSharedView();
    }

    pickVariantImage() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/webp,image/gif';
            input.hidden = true;
            const finish = (file) => { input.remove(); resolve(file); };
            input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true });
            input.addEventListener('cancel', () => finish(null), { once: true });
            document.body.appendChild(input);
            input.click();
        });
    }

    async mutateVariantImageImpl(operation, payload = {}) {
        if (this.disabledReason) return;
        const state = normalizeScriptaState(this.paragraph);
        const variant = state.variants.find((entry) => entry.id === String(payload.variantId || ''));
        if (!variant) return;
        try {
            assertScriptaVariantOwner(variant, this.userHash);
        } catch (error) {
            assistOS.showToast?.(error.message, 'error');
            return;
        }
        const imageIndex = (variant.images || []).findIndex((image) => image.imageId === payload.imageId);
        if (operation !== 'insert' && imageIndex < 0) return;
        let asset;
        if (operation === 'insert' || operation === 'replace') {
            const file = await this.pickVariantImage();
            if (!file) return;
            const path = this.documentPresenter?.element?.getAttribute('data-file-path') || this.document?.path;
            if (!path || !this.documentPresenter?.isMarkdownCrdtDocument?.()) {
                throw new Error('Image insertion requires a workspace Markdown document.');
            }
            asset = await uploadWorkspaceImage(path, file);
        }
        variant.images ||= [];
        if (payload.text !== undefined) {
            const nextText = sanitizeText(payload.text);
            variant.images = remapScriptaVariantImagePositions(variant.images, variant.text, nextText);
            variant.text = nextText;
        }
        if (operation === 'insert') {
            variant.images.push({
                ...asset, imageId: createScriptaVariantImageId(),
                position: Math.max(0, Math.min(variant.text.length, Number(payload.position) || 0)),
                layout: normalizeScriptaVariantImageLayout(),
            });
        } else if (operation === 'replace') {
            variant.images[imageIndex] = { ...variant.images[imageIndex], ...asset };
        } else if (operation === 'delete') {
            variant.images.splice(imageIndex, 1);
        } else if (operation === 'layout') {
            variant.images[imageIndex].layout = normalizeScriptaVariantImageLayout(payload.layout);
        }
        variant.updatedAt = new Date().toISOString();
        this.activeTabVariantId = variant.id;
        await this.persistState();
        await this.syncSharedView();
    }

    async persistState() {
        const state = normalizeScriptaState(this.paragraph);
        const winner = getWinningVariant(state);
        if (winner) {
            state.activeVariantId = winner.id;
            this.paragraph.text = serializeScriptaVariant(winner);
        }
        this.paragraph.metadata.pluginState = this.paragraph.pluginState;
        if (typeof this.documentPresenter?.updateParagraphModel !== "function") {
            throw new Error("Document presenter cannot persist SCRIPTA state.");
        }
        await this.documentPresenter.updateParagraphModel(this.chapter.id, this.paragraph.id, {
            text: this.paragraph.text,
            commands: this.paragraph.commands,
            comments: this.paragraph.comments,
            metadata: this.paragraph.metadata
        });
        this.mutationPersisted = true;
        if (!this.paragraphPresenter) return;
        this.paragraphPresenter.paragraph = this.paragraph;
        this.documentPresenter.element?.closest('file-exp')?.webSkelPresenter?.bumpWorkspaceVersion?.();
        const paragraphText = this.paragraphPresenter.element.querySelector(".paragraph-text");
        if (paragraphText) {
            paragraphText.innerHTML = this.paragraph.text;
            paragraphText.value = displayText(this.paragraph.text);
            paragraphText.style.height = "auto";
            paragraphText.style.height = `${paragraphText.scrollHeight}px`;
        }
        this.paragraphPresenter.renderScriptaStatus?.();
    }

    closeModal() {
        if (this.mutationBusy) return;
        assistOS.UI.closeModal(this.element);
    }
}
