import { api, endpoint } from './roboflow-api.js';
import { createWorkflowEditor } from './workflow-editor.js';
import { initPageNavigation } from './page-navigation.js';

const generateLink = document.querySelector('#breadcrumbGenerate');
const generateSep = document.querySelector('#breadcrumbGenerateSep');
const message = document.querySelector('#workflowMessage');
const navigation = initPageNavigation({ fallbackUrl: endpoint('?tab=workflow-types') });
navigation.bindLink(generateLink);
const editor = createWorkflowEditor({ api, onClose: navigation.returnToOrigin });

try {
    const [{ canAdmin }, { workflows }] = await Promise.all([api('api/robots'), api('api/roboflow/workflows')]);
    const id = new URL(location.href).searchParams.get('id');
    const workflow = id ? workflows.find(entry => entry.id === id) : null;
    if (id && !workflow) throw new Error('Workflow type not found.');
    let draft = null;
    if (!workflow) {
        const stored = sessionStorage.getItem('roboflow:new-draft');
        if (stored) {
            sessionStorage.removeItem('roboflow:new-draft');
            try { draft = JSON.parse(stored); } catch { draft = null; }
            if (draft) delete draft.id;
        }
    }
    generateLink.hidden = Boolean(workflow);
    generateSep.hidden = Boolean(workflow);
    await editor.open(workflow || draft, { admin: canAdmin === true });
} catch (error) {
    message.textContent = error.message;
}
