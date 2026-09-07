import { clearOnlyOfficeEditor, renderOnlyOfficeEditor } from "../../../services/onlyoffice/onlyoffice-editor-host.js";
import { buildSecretPreviewMarkup } from "./file-exp-dpu-provider.js";
import { renderMarkdownDiagrams } from "./file-exp-utils.js";
import { mountAgentRuntimeLoader } from "../../../shared/ui/agent-runtime-loader/agent-runtime-loader.js";
import { tryLoadOnlyOfficePreview } from "../../../services/onlyoffice/onlyoffice-preview-service.js";

export function toggleHidden(fileExp, element, hidden = true) {
    if (!element) return;
    element.classList.toggle('hidden', Boolean(hidden));
}

function syncDpuCommentsHost(fileExp, refs) {
    if (!refs?.dpuCommentPopover) return;
    const objectId = String(fileExp.state.dpuSelectedObjectId || '');
    const shouldMount = Boolean(objectId);

    if (!shouldMount) {
        clearMountElement(refs.dpuCommentPopover);
        toggleHidden(fileExp, refs.dpuCommentPopover, true);
        return;
    }

    const context = {
        objectId,
        path: fileExp.state.selectedPath || '',
        open: fileExp.state.dpuCommentsOpen,
        canComment: Boolean(fileExp.state.dpuSelectedCanComment),
        comments: Array.isArray(fileExp.state.dpuSelectedComments) ? fileExp.state.dpuSelectedComments : []
    };

    const node = mountPresenterElement(refs.dpuCommentPopover, {
        key: `dpu-comments-popover:${objectId}`,
        tagName: 'dpu-comments-popover',
        attributes: {
            'data-presenter': 'dpu-comments-popover',
            'data-object-id': objectId,
            'data-file-path': fileExp.state.selectedPath || '',
            'data-open': fileExp.state.dpuCommentsOpen ? 'true' : 'false'
        }
    });

    const presenter = node?.webSkelPresenter;
    if (presenter && typeof presenter.updateHostContext === 'function') {
        presenter.updateHostContext(context);
    } else if (node && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
            const deferredPresenter = node.webSkelPresenter;
            if (deferredPresenter && typeof deferredPresenter.updateHostContext === 'function') {
                deferredPresenter.updateHostContext(context);
            }
        });
    }

    toggleHidden(fileExp, refs.dpuCommentPopover, !fileExp.state.dpuCommentsOpen);
}

async function ensureRuntimeComponent(componentName) {
    const ensureComponentRegistered = window.assistOS?.webSkel?.ensureComponentRegistered || window.UI?.ensureComponentRegistered;
    if (typeof ensureComponentRegistered !== 'function') {
        return null;
    }
    return ensureComponentRegistered(componentName);
}

async function ensureAndMountBacklogPanel(fileExp, refs, pathAttr, repoPath) {
    if (!customElements.get('backlog-panel')) {
        try {
            await ensureRuntimeComponent('backlog-panel');
        } catch (error) {
            console.error('Failed to register backlog panel component', error);
        }
        if ((fileExp.state.selectedPath || '') !== pathAttr || fileExp.state.backlogTextView) {
            return;
        }
    }

    mountPresenterElement(refs.componentMount, {
        key: `backlog-panel:${pathAttr}:${repoPath}`,
        tagName: 'backlog-panel',
        attributes: {
            'data-presenter': 'backlog-panel',
            'data-backlog-path': pathAttr,
            'data-repo-path': repoPath
        }
    });
}

export function createPreviewActionButton(label, action, className = 'preview-pane-action') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.localAction = action;
    button.textContent = label;
    return button;
}

export function createPreviewCloseButton(action, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'close preview-pane-close';
    button.dataset.localAction = action;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);

    const icon = document.createElement('img');
    icon.className = 'close-icon';
    icon.src = './assets/icons/x-mark.svg';
    icon.alt = 'close';
    button.appendChild(icon);
    return button;
}

export function clearMountElement(mount) {
    if (!mount) return;
    clearOnlyOfficeEditor(mount);
    mount.textContent = '';
    if (mount.dataset) {
        delete mount.dataset.presenterKey;
    }
}

export function mountPresenterElement(mount, { key, tagName, attributes = {} }) {
    if (!mount || !tagName) return null;
    const normalizedTag = String(tagName).toLowerCase();
    const normalizedKey = String(key || normalizedTag);
    const currentKey = mount.dataset?.presenterKey || '';
    const currentNode = mount.firstElementChild;
    const currentTag = currentNode?.tagName?.toLowerCase() || '';
    const shouldReplace = !currentNode || currentTag !== normalizedTag || currentKey !== normalizedKey;

    let node = currentNode;
    if (shouldReplace) {
        // The mount may still host a live OnlyOffice editor; destroy it
        // before wiping its DOM so the editor runtime does not go stale.
        clearOnlyOfficeEditor(mount);
        mount.textContent = '';
        node = document.createElement(normalizedTag);
        mount.appendChild(node);
        if (mount.dataset) {
            mount.dataset.presenterKey = normalizedKey;
        }
    }

    Object.entries(attributes).forEach(([attr, value]) => {
        if (value === undefined || value === null || value === '') {
            node.removeAttribute(attr);
        } else {
            node.setAttribute(attr, String(value));
        }
    });

    return node;
}

export function ensurePreviewDom(fileExp, previewContent) {
    const cached = fileExp.previewDom;
    if (cached && cached.host === previewContent && previewContent.contains(cached.standardPane) && previewContent.contains(cached.htmlSplit)) {
        return cached;
    }

    const standardPane = document.createElement('div');
    standardPane.className = 'preview-standard-pane';

    const filePreview = document.createElement('div');
    filePreview.id = 'filePreview';
    filePreview.className = 'code-preview';

    const mediaPreview = document.createElement('div');
    mediaPreview.className = 'media-preview hidden';

    const componentMount = document.createElement('div');
    componentMount.className = 'preview-component-mount hidden';

    const dpuCommentPopover = document.createElement('div');
    dpuCommentPopover.className = 'dpu-comment-popover hidden';

    standardPane.appendChild(filePreview);
    standardPane.appendChild(mediaPreview);
    standardPane.appendChild(componentMount);
    standardPane.appendChild(dpuCommentPopover);

    const htmlSplit = document.createElement('div');
    htmlSplit.className = 'preview-split hidden';

    const codePane = document.createElement('div');
    codePane.className = 'preview-pane';
    const codePaneShell = document.createElement('div');
    codePaneShell.className = 'preview-pane-shell';
    const codePaneHeader = document.createElement('div');
    codePaneHeader.className = 'preview-pane-header';
    const codePaneTitle = document.createElement('span');
    codePaneTitle.className = 'preview-pane-title';
    codePaneTitle.textContent = 'Code';
    const codePaneActions = document.createElement('div');
    codePaneActions.className = 'preview-pane-actions';
    const hideCodeButton = createPreviewCloseButton('setPreviewViewMode web', 'Hide Code');
    codePaneActions.appendChild(hideCodeButton);
    codePaneHeader.appendChild(codePaneTitle);
    codePaneHeader.appendChild(codePaneActions);
    const codePaneBody = document.createElement('div');
    codePaneBody.className = 'preview-pane-body';
    const splitCodeComponentMount = document.createElement('div');
    splitCodeComponentMount.className = 'preview-component-mount hidden';
    codePaneBody.appendChild(splitCodeComponentMount);
    codePaneShell.appendChild(codePaneHeader);
    codePaneShell.appendChild(codePaneBody);
    codePane.appendChild(codePaneShell);

    const webPane = document.createElement('div');
    webPane.className = 'preview-pane';
    const webPaneShell = document.createElement('div');
    webPaneShell.className = 'preview-pane-shell';
    const webPaneHeader = document.createElement('div');
    webPaneHeader.className = 'preview-pane-header';
    const webUrlLabel = document.createElement('span');
    webUrlLabel.className = 'html-web-view-url';
    const webPaneActions = document.createElement('div');
    webPaneActions.className = 'preview-pane-actions';
    const webActionGroup = document.createElement('div');
    webActionGroup.className = 'html-web-view-actions';
    const refreshWebButton = createPreviewActionButton('Refresh', 'refreshWebPreviewPane');
    const openWebTabButton = createPreviewActionButton('Open in tab', 'openWebPreviewInTab');
    webActionGroup.appendChild(refreshWebButton);
    webActionGroup.appendChild(openWebTabButton);
    const hideWebButton = createPreviewCloseButton('setPreviewViewMode code', 'Hide Web');
    webPaneActions.appendChild(webActionGroup);
    webPaneActions.appendChild(hideWebButton);
    webPaneHeader.appendChild(webUrlLabel);
    webPaneHeader.appendChild(webPaneActions);
    const webPaneBody = document.createElement('div');
    webPaneBody.className = 'preview-pane-body';
    const webPlaceholder = document.createElement('div');
    webPlaceholder.className = 'preview-placeholder hidden';
    webPlaceholder.textContent = 'Web preview is unavailable for this file.';
    const webMount = document.createElement('div');
    webMount.className = 'preview-web-mount hidden';
    webPaneBody.appendChild(webPlaceholder);
    webPaneBody.appendChild(webMount);
    webPaneShell.appendChild(webPaneHeader);
    webPaneShell.appendChild(webPaneBody);
    webPane.appendChild(webPaneShell);

    htmlSplit.appendChild(codePane);
    htmlSplit.appendChild(webPane);

    previewContent.replaceChildren(standardPane, htmlSplit);

    fileExp.previewDom = {
        host: previewContent,
        standardPane,
        filePreview,
        mediaPreview,
        componentMount,
        dpuCommentPopover,
        htmlSplit,
        codePane,
        codePaneBody,
        splitCodeComponentMount,
        hideCodeButton,
        webPane,
        webPaneBody,
        webUrlLabel,
        webActionGroup,
        refreshWebButton,
        openWebTabButton,
        hideWebButton,
        webPlaceholder,
        webMount
    };

    return fileExp.previewDom;
}

export function renderStandardPreview(fileExp, refs, previewUiState) {
    const defaultText = 'Select a file to see its contents.';
    const wrapClassName = previewUiState.wrapEnabled ? ' is-wrapped' : '';
    toggleHidden(fileExp, refs.standardPane, false);
    toggleHidden(fileExp, refs.htmlSplit, true);
    refs.htmlSplit.classList.remove('single');
    toggleHidden(fileExp, refs.mediaPreview, true);
    toggleHidden(fileExp, refs.componentMount, true);
    toggleHidden(fileExp, refs.splitCodeComponentMount, true);
    clearMountElement(refs.splitCodeComponentMount);

    if (refs.filePreview.parentElement !== refs.standardPane) {
        refs.standardPane.insertBefore(refs.filePreview, refs.mediaPreview);
    }
    toggleHidden(fileExp, refs.filePreview, false);

    if (fileExp.state.isEditing) {
        fileExp.detachPreviewAnchorHandler();
        toggleHidden(fileExp, refs.filePreview, true);
        toggleHidden(fileExp, refs.componentMount, false);
        clearMountElement(refs.dpuCommentPopover);
        toggleHidden(fileExp, refs.dpuCommentPopover, true);
        if (fileExp.state.selectedIsMarkdown && fileExp.state.documentId) {
            mountPresenterElement(refs.componentMount, {
                key: `document-view:${fileExp.state.selectedPath}:${fileExp.state.documentId}:${fileExp.state.lastExternalReloadAt || 0}`,
                tagName: 'document-view-page',
                attributes: {
                    'data-presenter': 'document-view-page',
                    'data-file-path': fileExp.state.selectedPath,
                    documentId: fileExp.state.documentId
                }
            });
        } else if (fileExp.state.selectedIsMarkdown) {
            mountPresenterElement(refs.componentMount, {
                key: `markdown-editor:${fileExp.state.selectedPath}`,
                tagName: 'markdown-editor',
                attributes: {
                    'data-presenter': 'markdown-editor',
                    'data-file-path': fileExp.state.selectedPath
                }
            });
        } else {
            mountPresenterElement(refs.componentMount, {
                key: `file-editor:${fileExp.state.selectedPath}`,
                tagName: 'file-editor',
                attributes: {
                    'data-presenter': 'file-editor',
                    'data-file-path': fileExp.state.selectedPath
                }
            });
        }
        return;
    }

    if (previewUiState.showBacklogPanel) {
        fileExp.detachPreviewAnchorHandler();
        toggleHidden(fileExp, refs.filePreview, true);
        toggleHidden(fileExp, refs.componentMount, false);
        clearMountElement(refs.dpuCommentPopover);
        toggleHidden(fileExp, refs.dpuCommentPopover, true);
        const pathAttr = fileExp.state.selectedPath || '';
        const repoPath = fileExp.parentPath(pathAttr) || '/';
        ensureAndMountBacklogPanel(fileExp, refs, pathAttr, repoPath).catch((error) => {
            console.error('Failed to mount backlog panel', error);
        });
        return;
    }

    if (fileExp.state.previewMode !== 'onlyoffice') {
        // Keep a live OnlyOffice editor when we stay in onlyoffice mode;
        // renderOnlyOfficeEditor reconciles config changes itself and a
        // destroy here would force a full editor reload on every re-render.
        clearMountElement(refs.componentMount);
    }

    if (fileExp.state.previewMode === 'pdf') {
        fileExp.detachPreviewAnchorHandler();
        toggleHidden(fileExp, refs.filePreview, true);
        toggleHidden(fileExp, refs.mediaPreview, false);
        clearMountElement(refs.dpuCommentPopover);
        toggleHidden(fileExp, refs.dpuCommentPopover, true);
        refs.mediaPreview.innerHTML = fileExp.state.previewContent || '<div class="preview-placeholder">Unable to preview PDF.</div>';
        return;
    }

    if (fileExp.state.previewMode === 'media') {
        fileExp.detachPreviewAnchorHandler();
        toggleHidden(fileExp, refs.filePreview, true);
        toggleHidden(fileExp, refs.mediaPreview, false);
        clearMountElement(refs.dpuCommentPopover);
        toggleHidden(fileExp, refs.dpuCommentPopover, true);
        const content = fileExp.state.previewContent || '<div class="preview-placeholder">Unable to preview file.</div>';
        refs.mediaPreview.innerHTML = content;
        return;
    }

    if (fileExp.state.previewMode === 'onlyoffice') {
        fileExp.detachPreviewAnchorHandler();
        toggleHidden(fileExp, refs.filePreview, true);
        toggleHidden(fileExp, refs.mediaPreview, true);
        clearMountElement(refs.dpuCommentPopover);
        toggleHidden(fileExp, refs.dpuCommentPopover, true);
        toggleHidden(fileExp, refs.componentMount, false);
        refs.componentMount.classList.add('onlyoffice-editor-host');

        if (fileExp.state.onlyOfficeConfig) {
            if (refs.componentMount.dataset?.presenterKey) {
                // The mount still holds another presenter (editor, backlog
                // panel, ...) from a previous mode; reset it before handing
                // the mount to the OnlyOffice editor.
                clearMountElement(refs.componentMount);
            }
            renderOnlyOfficeEditor(refs.componentMount, fileExp.state.onlyOfficeConfig).catch((error) => {
                console.error('OnlyOffice editor mount failed', error);
                clearMountElement(refs.componentMount);
                refs.componentMount.innerHTML = `<div class="preview-placeholder">${error?.message || 'OnlyOffice preview is unavailable.'}</div>`;
            });
        } else {
            const runtimePath = String(fileExp.state.onlyOfficeRuntimeState?.path || '');
            if (runtimePath) {
                if (refs.componentMount.firstElementChild?.tagName?.toLowerCase() !== 'agent-runtime-loader') {
                    clearMountElement(refs.componentMount);
                }
                const selectedPath = String(fileExp.state.selectedPath || '');
                void mountAgentRuntimeLoader(refs.componentMount, {
                    key: `onlyoffice:${runtimePath}`,
                    agentRef: 'AchillesIDE/onlyOffice',
                    label: 'OnlyOffice',
                    enableMode: 'global',
                    operation: async () => {
                        if (String(fileExp.state.selectedPath || '') !== selectedPath) return;
                        await tryLoadOnlyOfficePreview(fileExp, runtimePath, {
                            invalidate: true,
                            deferRuntimeStartup: false
                        });
                    }
                }).catch((error) => {
                    console.error('OnlyOffice runtime loader failed', error);
                });
            } else {
                clearMountElement(refs.componentMount);
                refs.componentMount.innerHTML = `<div class="preview-placeholder">${fileExp.state.onlyOfficeStatusText || 'OnlyOffice preview is unavailable.'}</div>`;
            }
        }
        return;
    }

    if (fileExp.state.previewMode === 'dpu-secret') {
        fileExp.detachPreviewAnchorHandler();
        toggleHidden(fileExp, refs.filePreview, false);
        toggleHidden(fileExp, refs.mediaPreview, true);
        clearMountElement(refs.dpuCommentPopover);
        toggleHidden(fileExp, refs.dpuCommentPopover, true);
        refs.filePreview.className = 'dpu-secret-preview';
        refs.filePreview.innerHTML = buildSecretPreviewMarkup(fileExp, fileExp.state.dpuSecretState) || '<div class="preview-placeholder">Secret preview is unavailable.</div>';
        return;
    }

    toggleHidden(fileExp, refs.mediaPreview, true);
    refs.mediaPreview.textContent = '';
    refs.componentMount.classList.remove('onlyoffice-editor-host');
    syncDpuCommentsHost(fileExp, refs);

    if (fileExp.state.selectedIsMarkdown) {
        if (fileExp.state.markdownTextView) {
            refs.filePreview.className = `markdown-raw-view${wrapClassName}`;
            refs.filePreview.textContent = fileExp.state.selectedPath ? fileExp.state.fileContent : defaultText;
            fileExp.detachPreviewAnchorHandler();
        } else {
            refs.filePreview.className = 'markdown-preview';
            if (fileExp.state.selectedPath) {
                const content = typeof fileExp.state.fileContent === 'string'
                    ? fileExp.renderMarkdownPreview(fileExp.prepareMarkdownPreviewContent(fileExp.state.fileContent), {
                        sourcePath: fileExp.state.selectedPath,
                        buildResourceUrl: (path) => fileExp.buildWebViewUrl(path),
                        scriptaImages: fileExp.extractScriptaPreviewImages(fileExp.state.fileContent),
                    })
                    : '';
                refs.filePreview.innerHTML = content;
                void renderMarkdownDiagrams(refs.filePreview);
            } else {
                refs.filePreview.textContent = defaultText;
            }
            fileExp.attachPreviewAnchorHandler();
        }
        syncDpuCommentsHost(fileExp, refs);
        return;
    }

    refs.filePreview.className = `code-preview${wrapClassName}`;
    if (fileExp.state.selectedPath) {
        refs.filePreview.innerHTML = fileExp.state.previewContent || '';
    } else {
        refs.filePreview.textContent = defaultText;
    }
    fileExp.detachPreviewAnchorHandler();
    syncDpuCommentsHost(fileExp, refs);
}

export function renderHtmlPreview(fileExp, _refs, previewUiState, previewContent) {
    fileExp.detachPreviewAnchorHandler();
    const webViewUrl = fileExp.state.webViewUrl || fileExp.buildWebViewUrl(fileExp.state.selectedPath);
    const reloadToken = Number(fileExp.state.webViewReloadToken || 0);

    const renderPaneHeader = (leadingContent, actionsHtml, options = {}) => {
        const leadingHtml = options.rawLeading
            ? leadingContent
            : `<span class="preview-pane-title">${leadingContent}</span>`;
        return `
            <div class="preview-pane-header">
                ${leadingHtml}
                <div class="preview-pane-actions">${actionsHtml}</div>
            </div>
        `;
    };

    const renderClosePaneButton = (action, label) => `
        <button type="button" class="close preview-pane-close" data-local-action="${action}" aria-label="${label}" title="${label}">
            <img class="close-icon" src="./assets/icons/x-mark.svg" alt="close">
        </button>
    `;

    const renderWebPaneHeader = (includeCloseButton = false) => {
        const webActions = [
            `<button type="button" class="secondary preview-pane-action" data-local-action="refreshWebPreviewPane">Refresh</button>`,
            `<button type="button" class="secondary preview-pane-action" data-local-action="openWebPreviewInTab">Open in tab</button>`
        ];
        const trailingActions = [`<div class="html-web-view-actions">${webActions.join('')}</div>`];
        if (includeCloseButton) {
            trailingActions.push(renderClosePaneButton('setPreviewViewMode code', 'Hide Web'));
        }
        const urlLabel = webViewUrl || '';
        return renderPaneHeader(
            `<span class="html-web-view-url" title="${urlLabel}">${urlLabel}</span>`,
            trailingActions.join(''),
            { rawLeading: true }
        );
    };

    const renderCodePane = () => {
        const actions = [
            renderClosePaneButton('setPreviewViewMode web', 'Hide Code')
        ];
        const wrapClassName = previewUiState.wrapEnabled ? ' is-wrapped' : '';
        const body = fileExp.state.isEditing
            ? `<file-editor data-presenter="file-editor" data-file-path="${fileExp.state.selectedPath}"></file-editor>`
            : `<div id="filePreview" class="code-preview${wrapClassName}">${fileExp.state.previewContent || "Select a file to see its contents."}</div>`;
        return `
            <div class="preview-pane-shell">
                ${renderPaneHeader('Code', actions.join(''))}
                <div class="preview-pane-body">${body}</div>
            </div>
        `;
    };

    const renderWebPane = (splitControls = false) => {
        const body = !webViewUrl
            ? `<div class="preview-placeholder">Web preview is unavailable for this file.</div>`
            : `<html-web-view data-presenter="html-web-view" data-url="${webViewUrl}" data-source-path="${fileExp.state.selectedPath}" data-reload-token="${reloadToken}" data-live-source-selector=".code-input"></html-web-view>`;
        return `
            <div class="preview-pane-shell">
                ${renderWebPaneHeader(splitControls)}
                <div class="preview-pane-body" data-web-pane-body="true">${body}</div>
            </div>
        `;
    };

    if (previewUiState.viewMode === 'web') {
        previewContent.innerHTML = renderWebPane(false);
        return;
    }

    const codePaneClass = 'preview-pane';
    const webPaneClass = 'preview-pane';
    const splitClass = 'preview-split';
    previewContent.innerHTML = `
        <div class="${splitClass}">
            <div class="${codePaneClass}">${renderCodePane()}</div>
            <div class="${webPaneClass}">${renderWebPane(true)}</div>
        </div>
    `;
}

export function renderPreviewPanel(fileExp, previewContent, previewUiState) {
    if (!previewContent) return;
    if (previewUiState.isHtml && previewUiState.viewMode !== 'code') {
        renderHtmlPreview(fileExp, null, previewUiState, previewContent);
        fileExp.previewDom = null;
        return;
    }
    const refs = ensurePreviewDom(fileExp, previewContent);
    renderStandardPreview(fileExp, refs, previewUiState);
}
