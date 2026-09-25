import { generateGraph } from './workflow-generator.js';
import { endpoint } from './roboflow-api.js';

const description = document.querySelector('#generationDescription');
const generateButton = document.querySelector('#generateButton');
const cancelButton = document.querySelector('#cancelButton');
const message = document.querySelector('#generationMessage');
const skipButton = document.querySelector('#skipButton');
const logBox = document.querySelector('#generationLog');

let controller = null;

function setMessage(text, error = false) {
    message.textContent = text || '';
    message.classList.toggle('is-error', Boolean(error));
}

function setLog(text) {
    logBox.textContent = text || '';
    logBox.hidden = false;
    logBox.scrollTop = logBox.scrollHeight;
}

function goToEditor() {
    location.assign(endpoint('flow-types/new'));
}

async function generate() {
    const text = description.value.trim();
    if (!text || controller) return;
    controller = new AbortController();
    generateButton.disabled = true;
    cancelButton.hidden = false;
    setMessage('Generating…');
    setLog('');
    try {
        const result = await generateGraph(text, {
            signal: controller.signal,
            onProgress: status => setMessage(`Generating: ${status}`),
            onLog: setLog,
        });
        const graph = result?.graph ?? result;
        sessionStorage.setItem('roboflow:new-draft', JSON.stringify(graph));
        goToEditor();
    } catch (error) {
        setMessage(error.message, true);
        controller = null;
        generateButton.disabled = false;
        cancelButton.hidden = true;
    }
}

generateButton.onclick = () => void generate();
cancelButton.onclick = () => controller?.abort();
skipButton.onclick = goToEditor;
