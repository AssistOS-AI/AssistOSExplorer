import {
    AVATAR_COMMON_OPTIONS,
    AVATAR_SOURCE_MODES,
    buildAvatarFieldState,
    deriveAvatarSourceMode,
    formatAvatarOptionLabel,
    normalizeAvatarForSourceMode,
    normalizeAvatarPackList,
    normalizeGeneratedPaletteList,
    normalizeGeneratedStyleList
} from './avatar-settings-model.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function renderAxiFaceMarkup(config = {}) {
    const attrs = [];
    const add = (name, value) => {
        const raw = String(value ?? '').trim();
        if (raw) attrs.push(`${name}="${escapeHtml(raw)}"`);
    };
    add('agent-id', config.agentId);
    add('emotion', config.emotion);
    add('size', config.size);
    add('thought', config.thought);
    add('thought-mode', config.thoughtMode);
    add('mode', config.mode);
    add('shape', config.shape);
    add('theme', config.theme);
    add('asset-mode', config.assetMode);
    add('seed', config.seed);
    add('data-axi-style', config.style);
    add('palette', config.palette);
    add('complexity', config.complexity);
    add('src', config.src);
    add('pack-src', config.packSrc);
    if (config.generated !== false) attrs.push('generated');
    if (config.animated !== false) attrs.push('animated');
    if (config.listen) attrs.push('listen');
    return `<axi-face ${attrs.join(' ')}></axi-face>`;
}

function encodeOptions(values = [], labels = {}) {
    return encodeURIComponent(JSON.stringify(values.map((value) => {
        const raw = String(value ?? '');
        return {
            value: raw,
            label: labels[raw] || formatAvatarOptionLabel(raw)
        };
    })));
}

function renderInput({ key, label, value = '', type = 'text', min = '', max = '', step = '' }) {
    const attrs = [
        `class="form-input avatar-settings-input"`,
        `data-avatar-field="${escapeHtml(key)}"`,
        `type="${escapeHtml(type)}"`,
        `value="${escapeHtml(value)}"`
    ];
    if (min !== '') attrs.push(`min="${escapeHtml(min)}"`);
    if (max !== '') attrs.push(`max="${escapeHtml(max)}"`);
    if (step !== '') attrs.push(`step="${escapeHtml(step)}"`);
    return `
        <label class="avatar-settings-field">
            <span>${escapeHtml(label)}</span>
            <input ${attrs.join(' ')}>
        </label>
    `;
}

function renderSelect({ key, label, value = '', values = [], labels = {}, disabled = false }) {
    return `
        <label class="avatar-settings-field">
            <span>${escapeHtml(label)}</span>
            <custom-select class="avatar-settings-input"
                           data-presenter="custom-select"
                           data-avatar-field="${escapeHtml(key)}"
                           data-name="${escapeHtml(key)}"
                           data-options="${encodeOptions(values, labels)}"
                           data-selected="${escapeHtml(value)}"
                           ${disabled ? 'disabled' : ''}></custom-select>
        </label>
    `;
}

function renderCheckbox({ key, label, checked = false }) {
    return `
        <label class="avatar-settings-check">
            <input type="checkbox" data-avatar-field="${escapeHtml(key)}" ${checked ? 'checked' : ''}>
            <span>${escapeHtml(label)}</span>
        </label>
    `;
}

function renderPreviewMarkup(config = {}, { enabled = true, fallback = '' } = {}) {
    if (enabled === false) {
        const text = String(fallback ?? '').trim();
        return text ? `<span class="avatar-settings-preview-fallback">${escapeHtml(text)}</span>` : '';
    }
    return renderAxiFaceMarkup(config);
}

function normalizeSourceModes(values = Object.values(AVATAR_SOURCE_MODES)) {
    const allowed = new Set(Object.values(AVATAR_SOURCE_MODES));
    const normalized = (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter((value) => allowed.has(value));
    return normalized.length ? [...new Set(normalized)] : Object.values(AVATAR_SOURCE_MODES);
}

function stableKey(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return '';
    }
}

export class AvatarSettingsForm {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.invalidate = invalidate;
        this.props = props || {};
        this.state = {
            value: {},
            packs: [],
            generatedStyles: [],
            palettes: [],
            hiddenFields: [],
            sourceModes: Object.values(AVATAR_SOURCE_MODES),
            disabled: false,
            showPreview: true,
            previewEnabled: true,
            previewFallback: '',
            labels: {}
        };
        this.handleInput = (event) => this.onInput(event);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.root = this.element.querySelector('.avatar-settings-form-root');
        this.element.removeEventListener('input', this.handleInput);
        this.element.removeEventListener('change', this.handleInput);
        this.element.addEventListener('input', this.handleInput);
        this.element.addEventListener('change', this.handleInput);
        this.renderForm();
    }

    setData(data = {}) {
        const nextState = {
            ...this.state,
            ...data,
            value: data.value && typeof data.value === 'object' ? data.value : this.state.value,
            packs: Array.isArray(data.packs) ? normalizeAvatarPackList(data.packs) : this.state.packs,
            generatedStyles: Array.isArray(data.generatedStyles) ? normalizeGeneratedStyleList(data.generatedStyles) : this.state.generatedStyles,
            palettes: data.palettes ? normalizeGeneratedPaletteList(data.palettes) : this.state.palettes,
            hiddenFields: Array.isArray(data.hiddenFields)
                ? data.hiddenFields.map((field) => String(field || '').trim()).filter(Boolean)
                : this.state.hiddenFields,
            sourceModes: Array.isArray(data.sourceModes)
                ? normalizeSourceModes(data.sourceModes)
                : this.state.sourceModes
        };
        const previousKey = stableKey({
            value: this.state.value,
            packs: this.state.packs,
            generatedStyles: this.state.generatedStyles,
            palettes: this.state.palettes,
            hiddenFields: this.state.hiddenFields,
            sourceModes: this.state.sourceModes,
            disabled: this.state.disabled,
            showPreview: this.state.showPreview,
            previewEnabled: this.state.previewEnabled,
            previewFallback: this.state.previewFallback
        });
        const nextKey = stableKey({
            value: nextState.value,
            packs: nextState.packs,
            generatedStyles: nextState.generatedStyles,
            palettes: nextState.palettes,
            hiddenFields: nextState.hiddenFields,
            sourceModes: nextState.sourceModes,
            disabled: nextState.disabled,
            showPreview: nextState.showPreview,
            previewEnabled: nextState.previewEnabled,
            previewFallback: nextState.previewFallback
        });
        this.state = nextState;
        if (previousKey === nextKey) return;
        this.renderForm();
    }

    getValue() {
        return this.normalizeFromDom();
    }

    getConfig() {
        return this.getValue().config;
    }

    renderPreview({ enabled = this.state.previewEnabled, fallback = this.state.previewFallback } = {}) {
        this.state.previewEnabled = enabled;
        this.state.previewFallback = fallback;
        if (this.state.showPreview === false) return;
        const preview = this.root?.querySelector?.('.avatar-settings-preview');
        if (preview) {
            preview.innerHTML = renderPreviewMarkup(this.state.value, { enabled, fallback });
        }
    }

    normalizeFromDom() {
        const current = this.state.value && typeof this.state.value === 'object' ? this.state.value : {};
        const next = { ...current };
        const sourceModes = normalizeSourceModes(this.state.sourceModes);
        const requestedSourceMode = String(this.element.querySelector('[data-avatar-source-mode]')?.value || deriveAvatarSourceMode(current));
        const sourceMode = sourceModes.includes(requestedSourceMode) ? requestedSourceMode : sourceModes[0];
        this.element.querySelectorAll('[data-avatar-field]').forEach((input) => {
            const key = input.dataset.avatarField;
            if (!key) return;
            if (input.matches('custom-select') && input.value === undefined) return;
            if (key === 'expressionMode') {
                next[key] = input.checked ? 'audio' : 'manual';
            } else {
                next[key] = input.type === 'checkbox' ? Boolean(input.checked) : input.value;
            }
        });
        const config = normalizeAvatarForSourceMode(next, sourceMode, { packs: this.state.packs });
        return { sourceMode, config };
    }

    onInput(event) {
        if (!event.target?.matches?.('[data-avatar-field], [data-avatar-source-mode]')) return;
        const previousSourceMode = deriveAvatarSourceMode(this.state.value);
        const draft = this.normalizeFromDom();
        this.state.value = draft.config;
        const layoutChanged = event.target.matches('[data-avatar-source-mode], [data-avatar-field="expressionMode"]')
            || draft.sourceMode !== previousSourceMode;
        if (layoutChanged) {
            this.renderForm();
        } else {
            this.renderPreview();
        }
        this.element.dispatchEvent(new CustomEvent('avatar-settings-change', {
            bubbles: true,
            detail: draft
        }));
    }

    renderForm() {
        if (!this.root) return;
        const packs = normalizeAvatarPackList(this.state.packs);
        const styles = normalizeGeneratedStyleList(this.state.generatedStyles);
        const palettes = normalizeGeneratedPaletteList(this.state.palettes);
        const config = this.state.value && typeof this.state.value === 'object' ? this.state.value : {};
        const sourceModes = normalizeSourceModes(this.state.sourceModes);
        const requestedSourceMode = deriveAvatarSourceMode(config);
        const sourceMode = sourceModes.includes(requestedSourceMode) ? requestedSourceMode : sourceModes[0];
        const normalized = normalizeAvatarForSourceMode(config, sourceMode, { packs });
        const fieldState = buildAvatarFieldState(sourceMode);
        const labels = this.state.labels || {};
        const hiddenFields = new Set(Array.isArray(this.state.hiddenFields) ? this.state.hiddenFields : []);
        const expressionMode = String(normalized.expressionMode || '').trim() === 'manual' ? 'manual' : 'audio';
        const packValues = packs.map((pack) => pack.manifestSrc);
        const packLabels = Object.fromEntries(packs.map((pack) => [pack.manifestSrc, pack.label || pack.id]));
        if (normalized.packSrc && !packValues.includes(normalized.packSrc)) {
            packValues.unshift(normalized.packSrc);
            packLabels[normalized.packSrc] = 'Current pack (missing)';
        }
        const disabled = this.state.disabled ? 'disabled' : '';
        const renderWhenVisible = (fieldKey, markup) => hiddenFields.has(fieldKey) ? '' : markup;
        const sourceSpecific = fieldState.generated ? `
            ${renderWhenVisible('style', renderSelect({ key: 'style', label: labels.style || 'Generated style', value: normalized.style || 'robot-soft', values: styles }))}
            ${renderWhenVisible('palette', renderSelect({ key: 'palette', label: labels.palette || 'Generated palette', value: normalized.palette || 'default', values: palettes }))}
            ${renderWhenVisible('complexity', renderSelect({ key: 'complexity', label: labels.complexity || 'Complexity', value: normalized.complexity || '', values: AVATAR_COMMON_OPTIONS.complexity, labels: { '': 'Default' } }))}
            ${renderWhenVisible('seed', renderInput({ key: 'seed', label: labels.seed || 'Seed', value: normalized.seed || normalized.agentId || '' }))}
        ` : fieldState.pack ? `
            ${renderWhenVisible('packSrc', renderSelect({ key: 'packSrc', label: labels.packSrc || 'AxiFace pack', value: normalized.packSrc || '', values: packValues, labels: packLabels }))}
        ` : `
            ${renderWhenVisible('src', renderInput({ key: 'src', label: labels.src || 'SVG source', value: normalized.src || '' }))}
        `;
        const fieldsMarkup = `
            <div class="avatar-settings-section avatar-source-section">
                ${renderWhenVisible('sourceMode', `<label class="avatar-settings-field">
                    <span>${escapeHtml(labels.sourceMode || 'Avatar source')}</span>
                    <custom-select class="avatar-settings-input"
                                   data-presenter="custom-select"
                                   data-avatar-source-mode
                                   data-name="sourceMode"
                                   data-options="${encodeOptions(sourceModes, {
                                       [AVATAR_SOURCE_MODES.GENERATED]: 'Generated',
                                       [AVATAR_SOURCE_MODES.PACK]: 'AxiFace pack',
                                       [AVATAR_SOURCE_MODES.SVG]: 'SVG source'
                                   })}"
                                   data-selected="${escapeHtml(sourceMode)}"
                                   ${disabled}></custom-select>
                </label>`)}
            </div>
            <div class="avatar-settings-section">
                ${sourceSpecific}
            </div>
            <div class="avatar-settings-section">
                ${renderWhenVisible('emotion', renderSelect({
                    key: 'emotion',
                    label: labels.emotion || 'Manual emotion',
                    value: normalized.emotion || 'neutral',
                    values: AVATAR_COMMON_OPTIONS.emotion,
                    disabled: expressionMode === 'audio'
                }))}
                ${renderWhenVisible('assetMode', renderSelect({ key: 'assetMode', label: labels.assetMode || 'Asset mode', value: normalized.assetMode || 'img', values: AVATAR_COMMON_OPTIONS.assetMode }))}
                ${renderWhenVisible('mode', renderSelect({ key: 'mode', label: labels.mode || 'Mode', value: normalized.mode || 'static', values: AVATAR_COMMON_OPTIONS.mode }))}
                ${renderWhenVisible('shape', renderSelect({ key: 'shape', label: labels.shape || 'Shape', value: normalized.shape || 'circle', values: AVATAR_COMMON_OPTIONS.shape }))}
                ${renderWhenVisible('theme', renderSelect({ key: 'theme', label: labels.theme || 'Theme', value: normalized.theme || 'auto', values: AVATAR_COMMON_OPTIONS.theme }))}
                ${renderWhenVisible('thoughtMode', renderSelect({ key: 'thoughtMode', label: labels.thoughtMode || 'Thought mode', value: normalized.thoughtMode || 'none', values: AVATAR_COMMON_OPTIONS.thoughtMode }))}
                ${renderWhenVisible('thought', renderInput({ key: 'thought', label: labels.thought || 'Thought text', value: normalized.thought || '' }))}
                ${renderWhenVisible('size', renderInput({ key: 'size', label: labels.size || 'Size', value: normalized.size || '72', type: 'number', min: '24', max: '160', step: '4' }))}
            </div>
            <div class="avatar-settings-checks">
                ${renderWhenVisible('expressionMode', renderCheckbox({
                    key: 'expressionMode',
                    label: labels.expressionMode || 'Automatically adapt avatar to my voice',
                    checked: expressionMode === 'audio'
                }))}
                ${renderWhenVisible('animated', renderCheckbox({ key: 'animated', label: labels.animated || 'Animated', checked: normalized.animated !== false }))}
                ${renderWhenVisible('listen', renderCheckbox({ key: 'listen', label: labels.listen || 'Listen', checked: normalized.listen === true }))}
            </div>
        `;
        this.root.innerHTML = `
            <div class="avatar-settings-content">
                <div class="avatar-settings-fields" ${disabled}>
                    ${fieldsMarkup}
                </div>
                ${this.state.showPreview === false ? '' : `<div class="avatar-settings-preview-section">
                    <div class="avatar-settings-preview">${renderPreviewMarkup(normalized, {
                        enabled: this.state.previewEnabled,
                        fallback: this.state.previewFallback
                    })}</div>
                </div>`}
            </div>
        `;
        if (this.state.disabled) {
            this.root.querySelectorAll('input, custom-select').forEach((input) => {
                input.disabled = true;
                input.setAttribute('disabled', '');
            });
        }
    }
}
