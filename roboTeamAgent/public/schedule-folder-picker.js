const DEFAULT_LABEL = 'Workspace / cron-jobs-results';

export function initScheduleFolderPicker({ root = document, api, input, windowRef = window }) {
    const element = id => root.querySelector(`#${id}`);
    const dialog = element('cronFolderDialog'), trigger = element('cronChangeFolder'), label = element('cronFolderLabel');
    const list = element('cronFolderList'), breadcrumbs = element('cronFolderBreadcrumbs'), message = element('cronFolderMessage');
    const createForm = element('cronNewFolderForm'), name = element('cronNewFolderName'), use = element('cronFolderUse');
    const defaultButton = element('cronDefaultFolder');
    const labels = new Map();
    let current = null, controller = null, epoch = 0, creating = false;
    function setFolder(folder = '', text) {
        input.value = folder;
        label.textContent = text || labels.get(folder) || DEFAULT_LABEL;
        if (folder && text) labels.set(folder, text);
        defaultButton.hidden = !folder;
    }
    function busy(value) {
        for (const button of dialog.querySelectorAll('button')) button.disabled = value;
        name.disabled = value;
        use.disabled = value || !current;
        element('cronFolderUp').disabled = value || !current?.path;
        element('cronFolderClose').disabled = creating;
        element('cronFolderCancel').disabled = creating;
        dialog.setAttribute('aria-busy', String(value));
    }
    function button(text, action, className = '') {
        const item = root.createElement('button'); item.type = 'button'; item.textContent = text; item.className = className;
        item.onclick = action; return item;
    }
    function render(result) {
        current = result;
        list.replaceChildren(); breadcrumbs.replaceChildren();
        const parts = result.path ? result.path.split('/') : [];
        breadcrumbs.append(button('Workspace', () => void browse(''), 'folder-text-action'));
        parts.forEach((part, index) => {
            const separator = root.createElement('span'); separator.textContent = ' / '; separator.setAttribute('aria-hidden', 'true');
            breadcrumbs.append(separator, button(part, () => void browse(parts.slice(0, index + 1).join('/')), 'folder-text-action'));
        });
        breadcrumbs.lastElementChild.setAttribute('aria-current', 'location');
        for (const folder of result.folders) {
            const row = root.createElement('li');
            const open = button('', () => void browse(folder.path), 'folder-entry');
            const icon = element('cronFolderIcon').content.firstElementChild.cloneNode(true);
            const text = root.createElement('span'); text.textContent = folder.name;
            const arrow = root.createElement('span'); arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
            open.append(icon, text, arrow); open.setAttribute('aria-label', `Open folder ${folder.name}`); row.append(open); list.append(row);
        }
        if (!result.folders.length) {
            const empty = root.createElement('li'); empty.className = 'folder-empty'; empty.textContent = 'No subfolders. Use this folder or create a new one.'; list.append(empty);
        }
        createForm.hidden = true; createForm.reset();
    }
    async function request(operation) {
        controller?.abort(); controller = new AbortController(); const active = controller, generation = ++epoch;
        message.textContent = ''; message.className = 'message'; busy(true);
        try {
            const result = await operation(active.signal);
            if (generation !== epoch || !dialog.open) return;
            render(result);
        } catch (error) {
            if (generation === epoch && dialog.open && !active.signal.aborted) { message.textContent = error.message; message.className = 'message error'; }
        } finally { if (generation === epoch) { creating = false; busy(false); } }
    }
    function browse(path) {
        return request(signal => api(`api/roboflow/schedule-folders?path=${encodeURIComponent(path)}`, { signal }));
    }
    trigger.onclick = () => {
        if (dialog.open) return;
        current = null; list.replaceChildren(); breadcrumbs.replaceChildren(); createForm.hidden = true;
        dialog.showModal();
        void request(async signal => {
            const base = await api('api/roboflow/schedule-folders', { signal });
            if (signal.aborted || !dialog.open) return base;
            render(base); busy(true);
            const selected = input.value || base.defaultFolder;
            const key = selected.startsWith(base.folder + '/') ? selected.slice(base.folder.length + 1) : '';
            if (!key) return base;
            try { return await api(`api/roboflow/schedule-folders?path=${encodeURIComponent(key)}`, { signal }); }
            catch (error) {
                // A fresh default folder is created when the job is saved, not on browsing.
                if (!input.value && error.status === 404) return base;
                throw error;
            }
        });
    };
    const dismiss = () => { if (!creating) dialog.close(); };
    element('cronFolderClose').onclick = dismiss; element('cronFolderCancel').onclick = dismiss;
    dialog.addEventListener('cancel', event => { if (creating) event.preventDefault(); });
    dialog.addEventListener('close', () => { epoch++; controller?.abort(); creating = false; trigger.focus(); });
    element('cronFolderUp').onclick = () => void browse(current.path.split('/').slice(0, -1).join('/'));
    element('cronFolderNew').onclick = () => { createForm.hidden = false; name.focus(); };
    element('cronNewFolderCancel').onclick = () => { createForm.hidden = true; createForm.reset(); element('cronFolderNew').focus(); };
    createForm.onsubmit = event => {
        event.preventDefault(); if (creating || !current) return;
        creating = true;
        void request(signal => api('api/roboflow/schedule-folders', { method: 'POST', signal, body: { parent: current.path, name: name.value.trim() } }));
    };
    use.onclick = () => {
        if (!current || use.disabled) return;
        setFolder(current.folder, current.path ? `Workspace / ${current.path}` : 'Workspace'); dialog.close();
    };
    defaultButton.onclick = () => setFolder();
    windowRef.addEventListener('pagehide', () => { epoch++; controller?.abort(); if (dialog.open) dialog.close(); });
    return { setFolder, close: dismiss };
}
