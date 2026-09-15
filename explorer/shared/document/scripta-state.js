import { createSecureUuid } from '../libs/webskel/webskel.mjs';

export const SCRIPTA_KEY = "scripta";
export const SCRIPTA_REACTION_LIKE = "like";
export const SCRIPTA_REACTION_DISLIKE = "dislike";

export function cloneJson(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

export function createScriptaVariantId() {
    return `variant-${createSecureUuid()}`;
}

export function createScriptaVariantImageId() {
    return `variant-image-${createSecureUuid()}`;
}

export function normalizeScriptaVariantImageLayout(value = {}) {
    const layout = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const aspectRatio = ["auto", "1:1", "4:3", "3:2", "16:9"].includes(String(layout.aspectRatio || ""))
        ? String(layout.aspectRatio)
        : "auto";
    const fit = ["contain", "cover"].includes(String(layout.fit || "")) ? String(layout.fit) : "contain";
    const alignment = ["left", "center", "right"].includes(String(layout.alignment || ""))
        ? String(layout.alignment)
        : "center";
    return {
        widthPercent: Math.max(20, Math.min(100, Math.round(Number(layout.widthPercent) || 100))),
        aspectRatio,
        fit,
        alignment,
        showCaption: layout.showCaption !== false,
    };
}

export function normalizeScriptaVariantImages(value = [], fallbackPosition = 0) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((image) => image && typeof image === "object")
        .map((image) => ({
            imageId: String(image.imageId || createScriptaVariantImageId()),
            assetId: String(image.assetId || ""),
            alt: String(image.alt || "Image").trim() || "Image",
            workspaceUrl: String(image.workspaceUrl || ""),
            position: Number.isInteger(Number(image.position))
                ? Math.max(0, Number(image.position))
                : Math.max(0, Number(fallbackPosition) || 0),
            layout: normalizeScriptaVariantImageLayout(image.layout),
        }))
        .filter((image) => image.assetId && /^\/WebMeet\/[a-zA-Z0-9._-]+\/assets\/asset_[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+\.(?:png|jpg|webp|gif)$/i.test(image.workspaceUrl));
}

function markdownImage(image = {}) {
    const safeAlt = String(image.alt || "Image").replace(/[\[\]\\]/g, (value) => `\\${value}`);
    const safeUrl = String(image.workspaceUrl || "").replace(/[()\s]/g, (value) => encodeURIComponent(value));
    return `![${safeAlt}](${safeUrl})`;
}

export function serializeScriptaVariant(variant = {}) {
    const text = String(variant.text || "");
    const images = normalizeScriptaVariantImages(variant.images, text.length)
        .map((image, index) => ({...image, position: Math.min(text.length, image.position), index}))
        .sort((left, right) => left.position - right.position || left.index - right.index);
    if (!images.length) return text.trimEnd();
    let cursor = 0;
    let output = "";
    for (const image of images) {
        output += text.slice(cursor, image.position);
        if (output && !output.endsWith("\n\n")) output += output.endsWith("\n") ? "\n" : "\n\n";
        output += markdownImage(image);
        if (image.position < text.length) output += text.startsWith("\n", image.position) ? "\n" : "\n\n";
        cursor = image.position;
    }
    return `${output}${text.slice(cursor)}`.trimEnd();
}

export function normalizeScriptaReactionType(value) {
    const type = String(value || "").trim().toLowerCase();
    if (!type) return "";
    if (type !== SCRIPTA_REACTION_LIKE && type !== SCRIPTA_REACTION_DISLIKE) {
        throw new Error(`Unsupported SCRIPTA reaction type "${type}".`);
    }
    return type;
}

export function normalizeScriptaPluginState(paragraph) {
    if (!paragraph.metadata || typeof paragraph.metadata !== "object") {
        paragraph.metadata = {};
    }
    if (!paragraph.pluginState || typeof paragraph.pluginState !== "object" || Array.isArray(paragraph.pluginState)) {
        paragraph.pluginState = paragraph.metadata.pluginState && typeof paragraph.metadata.pluginState === "object"
            ? paragraph.metadata.pluginState
            : {};
    }
    paragraph.metadata.pluginState = paragraph.pluginState;
    return paragraph.pluginState;
}

export function normalizeScriptaReaction(userHash, reaction) {
    const data = reaction && typeof reaction === "object" ? reaction : {};
    const type = normalizeScriptaReactionType(data.type);
    if (!type) return null;
    return {
        type,
        userHash: String(data.userHash || userHash || ""),
        userLabel: String(data.userLabel || userHash || ""),
        reactedAt: String(data.reactedAt || new Date().toISOString()),
    };
}

export function normalizeScriptaReactionsByVariant(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw)
        .filter(([variantId, reactions]) => variantId && reactions && typeof reactions === "object")
        .map(([variantId, reactions]) => {
            const normalized = {};
            if (!Array.isArray(reactions)) {
                for (const [userHash, reaction] of Object.entries(reactions)) {
                    const value = normalizeScriptaReaction(userHash, reaction);
                    if (userHash && value) normalized[userHash] = value;
                }
            }
            return [String(variantId), normalized];
        }));
}

export function normalizeScriptaState(paragraph) {
    const pluginState = normalizeScriptaPluginState(paragraph);
    const raw = pluginState[SCRIPTA_KEY] && typeof pluginState[SCRIPTA_KEY] === "object"
        ? cloneJson(pluginState[SCRIPTA_KEY])
        : {};
    const variants = Array.isArray(raw.variants)
        ? raw.variants.filter((variant) => variant && typeof variant === "object")
        : [];
    const state = {
        ...raw,
        activeVariantId: typeof raw.activeVariantId === "string" ? raw.activeVariantId : "",
        variants: variants.map((variant) => ({
            id: String(variant.id || createScriptaVariantId()),
            text: String(variant.text ?? ""),
            images: normalizeScriptaVariantImages(variant.images, String(variant.text ?? "").length),
            createdBy: String(variant.createdBy || ""),
            createdAt: String(variant.createdAt || new Date().toISOString()),
            updatedAt: String(variant.updatedAt || variant.createdAt || new Date().toISOString()),
        })),
        reactionsByVariant: normalizeScriptaReactionsByVariant(raw.reactionsByVariant),
    };
    if (!state.variants.some((variant) => variant.id === state.activeVariantId)) {
        state.activeVariantId = "";
    }
    pluginState[SCRIPTA_KEY] = state;
    paragraph.metadata.pluginState = pluginState;
    return state;
}

export function ensureScriptaInitialVariant(paragraph, { createdBy = "", now = new Date().toISOString() } = {}) {
    const state = normalizeScriptaState(paragraph);
    if (!state.variants.length) {
        const owner = String(createdBy || "").trim();
        if (!owner) throw new Error("SCRIPTA variant creation requires an owner.");
        const variant = {
            id: createScriptaVariantId(),
            text: String(paragraph.text || ""),
            images: [],
            createdBy: owner,
            createdAt: String(now),
            updatedAt: String(now),
        };
        state.variants.push(variant);
        state.activeVariantId = variant.id;
    }
    updateScriptaActiveVariant(paragraph, state);
    return state;
}

export function getScriptaReactionStats(state, variantId) {
    const reactions = state?.reactionsByVariant?.[variantId] || {};
    const values = Object.values(reactions).filter((reaction) => reaction && typeof reaction === "object");
    const likes = values.filter((reaction) => reaction.type === SCRIPTA_REACTION_LIKE).length;
    const dislikes = values.filter((reaction) => reaction.type === SCRIPTA_REACTION_DISLIKE).length;
    return { likes, dislikes, total: likes + dislikes, score: likes - dislikes };
}

export function getScriptaTotalReactions(state) {
    return (state?.variants || []).reduce(
        (total, variant) => total + getScriptaReactionStats(state, variant.id).total,
        0,
    );
}

export function getScriptaWinningVariant(state) {
    if (!state?.variants?.length) return null;
    return state.variants
        .map((variant, index) => ({ variant, index, stats: getScriptaReactionStats(state, variant.id) }))
        .sort((left, right) => {
            if (right.stats.score !== left.stats.score) return right.stats.score - left.stats.score;
            if (right.stats.likes !== left.stats.likes) return right.stats.likes - left.stats.likes;
            if (left.stats.dislikes !== right.stats.dislikes) return left.stats.dislikes - right.stats.dislikes;
            const createdDelta = Date.parse(left.variant.createdAt || "") - Date.parse(right.variant.createdAt || "");
            if (Number.isFinite(createdDelta) && createdDelta !== 0) return createdDelta;
            return left.index - right.index;
        })[0]?.variant || state.variants[0];
}

export function getScriptaVariantOrdinal(state, variantId) {
    return (state?.variants || []).findIndex((variant) => variant.id === variantId) + 1;
}

export function getScriptaViewerVote(state, userHash) {
    for (const [variantId, reactions] of Object.entries(state?.reactionsByVariant || {})) {
        const reaction = reactions?.[userHash];
        if (reaction) return { variantId, type: reaction.type };
    }
    return null;
}

export function setScriptaReaction(state, variantId, userHash, userLabel, nextType) {
    const targetVariantId = String(variantId || "").trim();
    const participantHash = String(userHash || "").trim();
    if (!state?.variants?.some((variant) => variant.id === targetVariantId)) {
        throw new Error("SCRIPTA variant was not found.");
    }
    if (!participantHash) throw new Error("SCRIPTA voting requires a participant identity.");
    const normalizedType = normalizeScriptaReactionType(nextType);
    const currentType = state.reactionsByVariant?.[targetVariantId]?.[participantHash]?.type || "";
    for (const reactions of Object.values(state.reactionsByVariant || {})) {
        if (reactions && typeof reactions === "object") delete reactions[participantHash];
    }
    if (!normalizedType || currentType === normalizedType) return "";
    if (!state.reactionsByVariant[targetVariantId]) state.reactionsByVariant[targetVariantId] = {};
    state.reactionsByVariant[targetVariantId][participantHash] = {
        type: normalizedType,
        userHash: participantHash,
        userLabel: String(userLabel || participantHash),
        reactedAt: new Date().toISOString(),
    };
    return normalizedType;
}

export function updateScriptaActiveVariant(paragraph, state = normalizeScriptaState(paragraph)) {
    const winner = getScriptaWinningVariant(state);
    state.activeVariantId = winner?.id || "";
    if (winner) paragraph.text = serializeScriptaVariant(winner);
    return winner;
}

export function isScriptaVariantOwner(variant, actorHash = "") {
    const owner = String(variant?.createdBy || "").trim();
    const actor = String(actorHash || "").trim();
    return Boolean(owner && actor && owner === actor);
}

export function assertScriptaVariantOwner(variant, actorHash = "") {
    if (isScriptaVariantOwner(variant, actorHash)) return;
    const error = new Error("Only the participant who added this SCRIPTA variant can modify it.");
    error.code = "scripta_variant_forbidden";
    throw error;
}

export function addScriptaVariant(paragraph, text, { createdBy = "", now = new Date().toISOString() } = {}) {
    const value = String(text ?? "").trim();
    if (!value) throw new Error("SCRIPTA alternative text is required.");
    const owner = String(createdBy || "").trim();
    if (!owner) throw new Error("SCRIPTA variant creation requires an owner.");
    const state = ensureScriptaInitialVariant(paragraph, { createdBy, now });
    const variant = {
        id: createScriptaVariantId(),
        text: value,
        images: [],
        createdBy: owner,
        createdAt: String(now),
        updatedAt: String(now),
    };
    state.variants.push(variant);
    updateScriptaActiveVariant(paragraph, state);
    return variant;
}

export function deleteScriptaVariant(paragraph, variantId, { deletedBy = "" } = {}) {
    const state = ensureScriptaInitialVariant(paragraph, { createdBy: deletedBy });
    const targetId = String(variantId || "").trim();
    const index = state.variants.findIndex((variant) => variant.id === targetId);
    if (index < 0) throw new Error("SCRIPTA variant was not found.");
    assertScriptaVariantOwner(state.variants[index], deletedBy);
    if (state.variants.length === 1) {
        throw new Error("A SCRIPTA paragraph must keep at least one variant.");
    }
    const [removed] = state.variants.splice(index, 1);
    delete state.reactionsByVariant[removed.id];
    updateScriptaActiveVariant(paragraph, state);
    return removed;
}

export function applyScriptaVote(paragraph, { variantId, userHash, userLabel = "", type = "" } = {}) {
    const state = ensureScriptaInitialVariant(paragraph, { createdBy: userHash });
    const reaction = setScriptaReaction(state, variantId, userHash, userLabel, type);
    const winner = updateScriptaActiveVariant(paragraph, state);
    return { reaction, winner, state };
}

export function getScriptaStatus(paragraph) {
    if (!paragraph) return null;
    const pluginState = paragraph.pluginState || paragraph.metadata?.pluginState;
    const state = pluginState?.[SCRIPTA_KEY];
    if (!state || !Array.isArray(state.variants) || !state.variants.length) return null;
    const activeVariant = state.variants.find((variant) => variant.id === state.activeVariantId)
        || getScriptaWinningVariant(state);
    const activeStats = activeVariant ? getScriptaReactionStats(state, activeVariant.id) : { score: 0, total: 0 };
    return {
        variants: state.variants.length,
        score: activeStats.score,
        activeScore: activeStats.score,
        activeTotal: activeStats.total,
        totalReactions: getScriptaTotalReactions(state),
        activeVariantId: activeVariant?.id || "",
    };
}
