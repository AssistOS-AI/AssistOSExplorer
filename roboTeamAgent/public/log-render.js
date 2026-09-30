import { renderTaskLog } from '/webchat/assets/taskPresentation.js';

// RoboTeam shares the Router's Markdown log renderer with WebChat.
export function renderLog(container, log, finalResponse = '') {
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
    let start = finalResponse ? log.lastIndexOf(finalResponse) : -1;
    if (finalResponse && start < 0) {
        log = log ? `${log}\n\n` : '';
        start = log.length;
        log += finalResponse;
    }
    const task = start < 0 ? null : { finalOutputOffset: start, finalOutputLength: finalResponse.length };
    renderTaskLog(container, log, 'No log output yet.', task);
    if (atBottom) container.scrollTop = container.scrollHeight;
}
