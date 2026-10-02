import { api } from './roboflow-api.js';
import {
    INVALID_LINK, INVALID_PAYLOAD, LOADED, LOADING, SAVING, STALE_RESPONSE,
    conversationSkillsEndpoint, conversationSummaryLines, failureText, normalizeConversationSkills, parseConversationSkillsPath,
    toggleDisabled, toggleRequestBody, validateConversationCatalog, validateMutationCatalog,
} from './conversation-skills-model.js';

const status = document.querySelector('#conversationSkillsStatus');
const summary = document.querySelector('#conversationSkillsSummary');
const refresh = document.querySelector('#conversationSkillsRefresh');
const list = document.querySelector('#conversationSkillsList');

const context = parseConversationSkillsPath(location.pathname, globalThis.ROBOTEAM_CONFIG?.publicBasePath || '/');
let requestId = 0;
let busy = false;
let current = null;

function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
}

function node(tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
}

function render() {
    list.replaceChildren();
    summary.replaceChildren();
    refresh.disabled = busy;
    if (!current) {
        list.dataset.loaded = 'false';
        return;
    }
    list.dataset.loaded = 'true';
    list.dataset.robotId = context.robotId;
    list.dataset.sessionId = context.sessionId;
    list.dataset.policyVersion = String(current.policyVersion);
    for (const line of conversationSummaryLines({ robotName: current.robotName, sessionId: context.sessionId,
        policyVersion: current.policyVersion, skills: current.skills, diagnostics: current.diagnostics })) summary.append(node('div', line));
    for (const item of current.skills) {
        const row = document.createElement('li');
        row.className = 'conversation-skill-row';
        Object.assign(row.dataset, { identity: item.identity, name: item.name, state: item.state, enabled: String(item.enabled) });
        const details = node('div', '', 'conversation-skill-text');
        details.append(node('span', item.name, 'conversation-skill-name'), node('p', item.identity, 'conversation-skill-identity'));
        if (item.description) details.append(node('p', item.description, 'conversation-skill-description'));
        if (item.state) details.append(node('p', item.state, 'conversation-skill-state'));
        if (item.diagnostic) details.append(node('p', item.diagnostic, 'conversation-skill-diagnostic error'));
        const toggle = node('button', item.enabled ? 'Enabled' : 'Disabled', 'button conversation-skill-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-pressed', String(item.enabled));
        toggle.setAttribute('aria-label', `${item.enabled ? 'Disable' : 'Enable'} ${item.name}`);
        toggle.disabled = toggleDisabled(item, { busy, policyVersion: current.policyVersion, mode: current.mode });
        toggle.addEventListener('click', () => void setSkill(item));
        row.append(details, toggle);
        list.append(row);
    }
}

function apply(payload) {
    current = { policyVersion: payload.policyVersion, mode: payload.policy?.mode, robotName: String(payload.robot ?? ''),
        skills: normalizeConversationSkills(payload.skills), diagnostics: payload.diagnostics };
}

async function load() {
    const id = ++requestId;
    setStatus(LOADING);
    try {
        const payload = await api(conversationSkillsEndpoint(context));
        if (id !== requestId) return;
        const verdict = validateConversationCatalog(payload, context, current?.policyVersion);
        if (!verdict.ok) {
            setStatus(verdict.reason === 'stale' ? STALE_RESPONSE : INVALID_PAYLOAD, true);
            return;
        }
        apply(payload);
        render();
        setStatus(LOADED);
    } catch (error) {
        if (id !== requestId) return;
        setStatus(error.message || 'Could not load the conversation skills.', true);
    }
}

async function setSkill(item) {
    if (busy || !current) return;
    const sent = current.policyVersion;
    const id = ++requestId;
    busy = true;
    setStatus(SAVING);
    render();
    try {
        const payload = await api(conversationSkillsEndpoint(context), { method: 'PATCH', body: toggleRequestBody(item, sent) });
        if (id !== requestId) return;
        if (!validateMutationCatalog(payload, context, sent).ok) {
            setStatus(INVALID_PAYLOAD, true);
            return;
        }
        apply(payload);
        setStatus(LOADED);
    } catch (error) {
        if (id === requestId) setStatus(failureText(error.message), true);
    } finally {
        busy = false;
        render();
    }
}

if (!context) {
    refresh.disabled = true;
    setStatus(INVALID_LINK, true);
} else {
    refresh.addEventListener('click', () => void load());
    void load();
}
