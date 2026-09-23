export const blackboardCollaborationRenderingMethods = {
    renderPollWidgetContent(node, widget) {
        const props = widget.properties || {};
        const currentPoll = this.getCurrentPollValue(widget);
        const canManagePoll = props.canManagePoll === true;
        const statusValue = this.getPollStatus(widget);
        const hasPolld = Boolean(currentPoll);
        const questions = this.getPollQuestions(widget);

        const summary = document.createElement('button');
        summary.type = 'button';
        summary.className = 'webmeet-blackboard-poll-summary subtle-button';
        summary.addEventListener('pointerdown', (event) => event.stopPropagation());
        summary.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (statusValue === 'closed') {
                void this.openPollResultsModal(widget);
                return;
            }
            void this.openPollModal(widget);
        });

        const title = document.createElement('span');
        title.className = 'webmeet-blackboard-widget-title';
        title.textContent = props.description || 'Poll';

        const status = document.createElement('div');
        status.className = 'webmeet-blackboard-poll-status';
        status.textContent = this.getPollStatusText(widget, currentPoll);

        const meta = document.createElement('span');
        meta.className = 'webmeet-blackboard-poll-meta';
        meta.textContent = `${questions.length} question${questions.length === 1 ? '' : 's'}${hasPolld ? ' • polld' : ''}`;

        const adminActions = this.createPollAdminActions(widget, statusValue, canManagePoll);
        summary.append(title, status, meta);
        node.append(summary);
        if (adminActions) node.append(adminActions);
    },

    renderBulletsWidgetContent(node, widget) {
        const props = widget.properties || {};
        const items = Array.isArray(props.items) ? props.items : [];

        const header = document.createElement('div');
        header.className = 'webmeet-blackboard-bullets-header';
        const headerText = document.createElement('div');
        headerText.className = 'webmeet-blackboard-bullets-header-text';
        const title = document.createElement('div');
        title.className = 'webmeet-blackboard-bullets-title';
        title.textContent = String(props.title || 'Meeting Bullets').trim() || 'Meeting Bullets';
        const meta = document.createElement('div');
        meta.className = 'webmeet-blackboard-bullets-meta';
        const dateText = String(props.meetingDateTime || widget.createdAt || '').trim();
        meta.textContent = dateText;
        headerText.append(title, meta);
        const isFullscreen = String(this.fullscreenWidgetId || '') === String(widget.id || '');
        const fullscreenButton = document.createElement('button');
        fullscreenButton.type = 'button';
        fullscreenButton.className = 'icon-button webmeet-blackboard-bullets-fullscreen-button';
        fullscreenButton.title = isFullscreen ? 'Exit full screen' : 'Full screen';
        fullscreenButton.setAttribute('aria-label', isFullscreen ? 'Exit full screen' : 'Full screen');
        fullscreenButton.setAttribute('aria-pressed', String(isFullscreen));
        const fullscreenIcon = document.createElement('img');
        fullscreenIcon.src = '/explorer/shared/assets/icons/fullscreen.svg';
        fullscreenIcon.alt = '';
        fullscreenIcon.className = 'webmeet-blackboard-bullets-fullscreen-icon';
        fullscreenIcon.setAttribute('aria-hidden', 'true');
        fullscreenButton.append(fullscreenIcon);
        fullscreenButton.addEventListener('pointerdown', (event) => event.stopPropagation());
        fullscreenButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleBulletsFullscreen(widget.id);
        });
        header.append(headerText, fullscreenButton);

        const list = document.createElement('div');
        list.className = 'webmeet-blackboard-bullets-list';
        if (items.length) {
            for (const item of items) {
                list.append(this.createBulletsItemRow(item));
            }
        } else {
            const empty = document.createElement('div');
            empty.className = 'webmeet-blackboard-bullets-empty';
            empty.textContent = 'No bullets yet';
            list.append(empty);
        }

        const footer = document.createElement('div');
        footer.className = 'webmeet-blackboard-bullets-footer';
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'subtle-button webmeet-blackboard-widget-action-button';
        editButton.textContent = 'Edit';
        editButton.addEventListener('pointerdown', (event) => event.stopPropagation());
        editButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.editWidget(widget);
        });
        footer.append(editButton);
        node.append(header, list, footer);
    },

    createBulletsItemRow(item = {}) {
        const row = document.createElement('div');
        const status = this.normalizeBulletsStatus(item.status);
        const priority = this.normalizeBulletsPriority(item.priority);
        row.className = `webmeet-blackboard-bullets-item status-${status} priority-${priority}`;

        const icon = document.createElement('span');
        icon.className = 'webmeet-blackboard-bullets-status-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = this.getBulletsStatusIcon(status);

        const text = document.createElement('span');
        text.className = 'webmeet-blackboard-bullets-text';
        text.textContent = String(item.text || '').trim();

        const badge = document.createElement('span');
        badge.className = `webmeet-blackboard-bullets-priority priority-${priority}`;
        badge.textContent = this.getBulletsPriorityLabel(priority);

        row.append(icon, text, badge);
        return row;
    },

    normalizeBulletsStatus(status = '') {
        const normalized = String(status || '').trim();
        return ['todo', 'inProgress', 'done', 'blocked'].includes(normalized) ? normalized : 'todo';
    },

    normalizeBulletsPriority(priority = '') {
        const normalized = String(priority || '').trim();
        return ['high', 'medium', 'low'].includes(normalized) ? normalized : 'medium';
    },

    getBulletsStatusIcon(status = 'todo') {
        if (status === 'inProgress') return '↯';
        if (status === 'done') return '✓';
        if (status === 'blocked') return '!';
        return '○';
    },

    getBulletsPriorityLabel(priority = 'medium') {
        if (priority === 'high') return '▲ High';
        if (priority === 'low') return '▼ Low';
        return 'Medium';
    },

    getPollQuestions(widget) {
        return Array.isArray(widget.properties?.questions) ? widget.properties.questions : [];
    },

    getPollStatus(widget) {
        const props = widget.properties || {};
        const status = String(props.status || 'open').trim();
        if (status === 'closed') return 'closed';
        if (props.closesAt && Date.now() >= Date.parse(String(props.closesAt))) return 'closed';
        if (status === 'draft') return 'draft';
        return 'open';
    },

    getPollStatusText(widget, currentPoll = '') {
        const props = widget.properties || {};
        const status = this.getPollStatus(widget);
        if (status === 'draft') return 'Poll has not started';
        if (status === 'closed') return currentPoll ? `Closed. Your poll: ${currentPoll}` : 'Poll closed';
        const closesAt = String(props.closesAt || '').trim();
        if (closesAt) {
            const secondsLeft = Math.max(0, Math.ceil((Date.parse(closesAt) - Date.now()) / 1000));
            return currentPoll ? `Your poll: ${currentPoll}. Closes in ${secondsLeft}s` : `Open. Closes in ${secondsLeft}s`;
        }
        return currentPoll ? `Your poll: ${currentPoll}` : 'No poll submitted';
    },

    createPollAdminActions(widget, statusValue, canManagePoll) {
        if (!canManagePoll) return null;
        const actions = document.createElement('div');
        actions.className = 'webmeet-blackboard-poll-admin-actions';
        if (statusValue === 'draft') {
            const startButton = document.createElement('button');
            startButton.type = 'button';
            startButton.className = 'subtle-button webmeet-blackboard-widget-action-button';
            startButton.textContent = 'Start';
            startButton.addEventListener('pointerdown', (event) => event.stopPropagation());
            startButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.startPollWidget(widget);
            });
            actions.append(startButton);
        }
        if (statusValue === 'open') {
            const closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.className = 'subtle-button webmeet-blackboard-widget-action-button';
            closeButton.textContent = 'Close';
            closeButton.addEventListener('pointerdown', (event) => event.stopPropagation());
            closeButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.closePollWidget(widget);
            });
            actions.append(closeButton);
        }
        if (statusValue === 'closed') {
            const resultsButton = document.createElement('button');
            resultsButton.type = 'button';
            resultsButton.className = 'subtle-button webmeet-blackboard-widget-action-button';
            resultsButton.textContent = 'Results';
            resultsButton.addEventListener('pointerdown', (event) => event.stopPropagation());
            resultsButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.openPollResultsModal(widget);
            });
            actions.append(resultsButton);
        }
        return actions.children.length ? actions : null;
    },

    getCurrentPollValue(widget) {
        const participantData = widget.properties?.participantData || {};
        const participantId = String(this.adapter?.participantId || '').trim();
        if (participantId && participantData[participantId]?.answers) {
            return Object.values(participantData[participantId].answers || {}).filter(Boolean).join(', ');
        }
        return '';
    },

};
