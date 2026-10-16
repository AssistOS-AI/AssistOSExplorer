import { TABS, workflowsForTab, elapsedMs, formatDuration, formatDate, executedNodes, workflowUrl, fetchWorkflows, answerHumanInput } from './workflow-model.js';

const statusLabel = value => value ? value[0].toUpperCase() + value.slice(1) : '—';
const setText = (element, value) => {
    if (element.textContent !== value) element.textContent = value;
};

export class ObservabilityPanel {
    constructor(element, invalidate) {
        this.element = element;
        this.tab = 'human';
        this.flows = [];
        this.selection = {};
        this.cards = new Map();
        this.error = '';
        this.loaded = false;
        this.closed = false;
        this.answerDrafts = new Map();
        this.revision = 0;
        invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.find = selector => this.element.querySelector(selector);
        this.element.addEventListener('click', this.onClick);
        this.element.addEventListener('keydown', this.onKeydown);
        this.element.addEventListener('change', this.onAnswerChange);
        this.element.addEventListener('input', this.onAnswerChange);
        this.element.addEventListener('submit', this.onAnswer);
        this.render();
        void this.refresh();
        this.clock = setInterval(() => this.renderDurations(), 1000);
    }

    afterUnload() {
        this.closed = true;
        clearInterval(this.clock);
        clearTimeout(this.poll);
        clearTimeout(this.deadline);
        this.controller?.abort();
        this.answerController?.abort();
        clearTimeout(this.answerDeadline);
        this.element.removeEventListener('click', this.onClick);
        this.element.removeEventListener('keydown', this.onKeydown);
        this.element.removeEventListener('change', this.onAnswerChange);
        this.element.removeEventListener('input', this.onAnswerChange);
        this.element.removeEventListener('submit', this.onAnswer);
    }

    onClick = event => {
        const tab = event.target.closest('[data-tab]');
        if (tab) this.selectTab(tab.dataset.tab);
        const card = event.target.closest('[data-flow-id]');
        if (card) {
            this.selection[this.tab] = card.dataset.flowId;
            this.render();
        }
    };

    onKeydown = event => {
        const tab = event.target.closest('[data-tab]');
        if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = TABS.indexOf(tab.dataset.tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
        this.selectTab(TABS[next]);
        this.find(`[data-tab="${this.tab}"]`).focus();
    };

    selectTab(tab) {
        if (!TABS.includes(tab)) return;
        this.tab = tab;
        this.render();
    }

    async refresh() {
        if (this.loading || this.closed) return;
        clearTimeout(this.poll);
        this.loading = true;
        const revision = this.revision;
        this.controller = new AbortController();
        this.deadline = setTimeout(() => this.controller.abort(), 15000);
        this.render();
        let unauthorized = false;
        try {
            const flows = await fetchWorkflows({ signal: this.controller.signal });
            if (this.closed) return;
            if (revision !== this.revision) return;
            this.flows = flows;
            this.loaded = true;
            this.error = '';
        } catch (error) {
            if (this.closed) return;
            unauthorized = error.status === 401 || error.status === 403;
            if (unauthorized) this.flows = [];
            this.error = unauthorized ? 'Access to workflows was denied. Reopen Observability after access is restored.'
                : error.name === 'AbortError' ? 'Loading workflows timed out. Retrying automatically.'
                    : error.message || 'Could not load workflows. Retrying automatically.';
        } finally {
            clearTimeout(this.deadline);
            this.loading = false;
            if (!this.closed) {
                this.render();
                if (!unauthorized) this.scheduleRefresh();
            }
        }
    }

    scheduleRefresh() {
        this.poll = setTimeout(() => {
            if (this.element.ownerDocument.hidden) this.scheduleRefresh();
            else void this.refresh();
        }, 5000);
    }

    render() {
        for (const tab of TABS) {
            const button = this.find(`[data-tab="${tab}"]`);
            button.setAttribute('aria-selected', String(this.tab === tab));
            button.tabIndex = this.tab === tab ? 0 : -1;
            setText(this.find(`[data-count="${tab}"]`), String(workflowsForTab(this.flows, tab).length));
        }
        this.find('[role="tabpanel"]').setAttribute('aria-labelledby', `observability-tab-${this.tab}`);
        this.find('[data-error]').hidden = !this.error;
        setText(this.find('[data-error]'), this.error && this.loaded ? `${this.error} Displayed workflows may be out of date.` : this.error);

        const flows = workflowsForTab(this.flows, this.tab);
        const selected = flows.find(flow => flow.id === this.selection[this.tab]);
        if (!selected) delete this.selection[this.tab];
        this.renderCards(flows);
        this.find('[data-empty-list]').hidden = flows.length > 0;
        setText(this.find('[data-empty-list]'), this.tab === 'human' ? 'No paused or failed workflows.'
            : !this.loaded && this.loading ? 'Loading workflows…'
                : this.error ? 'Workflow list unavailable.'
                    : this.tab === 'running' ? 'No workflows are running.' : 'No finished workflows yet.');
        this.find('[data-detail]').hidden = !selected;
        this.find('[data-empty-detail]').hidden = Boolean(selected);
        if (selected) {
            setText(this.find('[data-name]'), selected.workflowName || selected.id);
            setText(this.find('[data-state]'), statusLabel(selected.status));
            setText(this.find('[data-started]'), selected.status === 'pending' ? 'Not started' : formatDate(selected.startedAt || selected.createdAt));
            setText(this.find('[data-nodes]'), String(executedNodes(selected)));
            setText(this.find('[data-prompt]'), selected.objective || 'No prompt recorded.');
            this.find('[data-open]').href = workflowUrl(selected.id);
            this.find('[data-flow-error]').hidden = !selected.error;
            setText(this.find('[data-flow-error]'), selected.error || '');
        }
        this.renderQuestion(selected);
        this.renderDurations();
    }

    renderCards(flows) {
        const list = this.find('[data-workflow-list]');
        const ids = new Set(flows.map(flow => flow.id));
        for (const [id, card] of this.cards) {
            if (!ids.has(id)) {
                card.item.remove();
                this.cards.delete(id);
            }
        }
        flows.forEach((flow, index) => {
            let card = this.cards.get(flow.id);
            if (!card) {
                const create = (tag, className, parent) => {
                    const node = this.element.ownerDocument.createElement(tag);
                    node.className = className;
                    parent?.append(node);
                    return node;
                };
                const item = create('li', '');
                const button = create('button', 'settings-card observability-card', item);
                button.type = 'button';
                button.dataset.flowId = flow.id;
                const heading = create('span', 'observability-card-heading', button);
                const title = create('span', 'settings-card-title', heading);
                const status = create('span', 'status-badge', heading);
                const prompt = create('span', 'settings-card-meta observability-card-prompt', button);
                const meta = create('span', 'settings-card-meta observability-card-meta', button);
                const date = create('span', '', meta);
                const duration = create('span', '', meta);
                card = { item, button, title, status, prompt, date, duration };
                this.cards.set(flow.id, card);
            }
            setText(card.title, flow.workflowName || flow.id);
            setText(card.status, statusLabel(flow.status));
            setText(card.prompt, flow.objective || 'No prompt recorded.');
            setText(card.date, formatDate(flow.startedAt || flow.createdAt));
            card.button.setAttribute('aria-pressed', String(this.selection[this.tab] === flow.id));
            if (list.children[index] !== card.item) list.insertBefore(card.item, list.children[index] || null);
        });
    }

    renderQuestion(flow) {
        const question = flow?.humanInput;
        const form = this.find('[data-answer-form]');
        form.hidden = question?.status !== 'pending';
        if (form.hidden) return;
        const draft = this.answerDrafts.get(question.id) || { option: null, text: '', error: '' };
        this.answerDrafts.set(question.id, draft);
        if (form.dataset.requestId !== question.id) {
            form.dataset.requestId = question.id;
            form.dataset.flowId = flow.id;
            setText(this.find('[data-question]'), question.question);
            const options = this.find('[data-answer-options]');
            options.replaceChildren();
            question.options.forEach((text, index) => {
                const label = this.element.ownerDocument.createElement('label');
                label.className = 'observability-answer-option';
                const radio = this.element.ownerDocument.createElement('input');
                radio.type = 'radio'; radio.name = 'human-answer'; radio.value = String(index);
                label.append(radio, this.element.ownerDocument.createTextNode(text));
                options.append(label);
            });
            for (const radio of form.querySelectorAll('[name="human-answer"]')) radio.checked = Number(radio.value) === draft.option;
            this.find('[data-custom-answer]').value = draft.text;
        }
        this.find('[data-custom-answer]').hidden = draft.option !== 3;
        const busy = this.sendingQuestion === question.id;
        form.querySelector('fieldset').disabled = busy || !question.executionEnded;
        this.find('[data-send-answer]').disabled = busy || !question.executionEnded || draft.option === null || (draft.option === 3 && !draft.text.trim());
        setText(this.find('[data-answer-status]'), busy ? 'Sending answer…' : !question.executionEnded ? 'The robot is finishing its execution…' : 'Choose an option or write your own answer.');
        this.find('[data-answer-error]').hidden = !draft.error;
        setText(this.find('[data-answer-error]'), draft.error);
    }

    onAnswerChange = event => {
        if (!event.target.matches('[name="human-answer"], [data-custom-answer]')) return;
        const form = this.find('[data-answer-form]');
        const draft = this.answerDrafts.get(form.dataset.requestId);
        if (!draft) return;
        if (event.target.name === 'human-answer') draft.option = Number(event.target.value);
        else draft.text = event.target.value;
        draft.error = '';
        this.renderQuestion(this.flows.find(flow => flow.id === form.dataset.flowId));
        if (event.type === 'change' && event.target.name === 'human-answer' && draft.option === 3) this.find('[data-custom-answer]').focus();
    };

    onAnswer = async event => {
        if (!event.target.matches('[data-answer-form]')) return;
        event.preventDefault();
        if (this.sendingQuestion) return;
        const { flowId, requestId } = event.target.dataset;
        const draft = this.answerDrafts.get(requestId);
        if (!draft || draft.option === null || (draft.option === 3 && !draft.text.trim())) return;
        this.sendingQuestion = requestId;
        this.answerController = new AbortController();
        this.answerDeadline = setTimeout(() => this.answerController.abort(), 20000);
        this.revision++;
        this.render();
        try {
            const flow = await answerHumanInput(flowId, { requestId, option: draft.option, ...(draft.option === 3 ? { text: draft.text } : {}) }, { signal: this.answerController.signal });
            if (this.closed) return;
            this.flows = this.flows.map(item => item.id === flowId ? flow : item);
            this.answerDrafts.delete(requestId);
        } catch (error) {
            if (!this.closed) draft.error = error.name === 'AbortError' ? 'Answer delivery could not be confirmed. Wait for the next automatic update before retrying.' : error.message;
        } finally {
            clearTimeout(this.answerDeadline);
            this.sendingQuestion = null;
            if (!this.closed) this.render();
        }
    };

    renderDurations() {
        const now = Date.now();
        for (const flow of this.flows) {
            const duration = formatDuration(elapsedMs(flow, now));
            const card = this.cards.get(flow.id);
            if (card) setText(card.duration, duration);
            if (flow.id === this.selection[this.tab]) setText(this.find('[data-duration]'), duration);
        }
    }
}
