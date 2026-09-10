import { buildSlashCommandCatalog } from '../repl/SlashCommandHandler.mjs';

const HELP_TOPICS = {
    overview: {
        title: 'Achilles CLI overview',
        content: 'Describe a coding task to execute it through ALA in the selected workspace conversation. ALA runs the native coding backend inside its sandbox. Type / for commands; Escape cancels only the active turn, not delegated worker tasks.',
    },
    skills: {
        title: 'Anthropic skills',
        content: 'Skills use SKILL.md and directly executable scripts. The three built-ins are bash, launch-gpt-researcher, launch-robot. /list skills lists the catalog; /read reads a descriptor; /exec runs an enabled skill through ALA. Disable packaged skills rather than removing them. External repository roots may override earlier roots. /reload refreshes the catalog.',
    },
    sessions: {
        title: 'Workspace conversations',
        content: 'Conversations and task history are shared by connections to the same workspace. Each connection retains its own selected session. /session selects a saved conversation; /session new creates one; /session resume <id> restores it. Distinct conversations may execute concurrently; a second turn in an already executing conversation is rejected. Native home, workspace and backend remain bound to the conversation.',
    },
    permissions: {
        title: 'Native permissions',
        content: '/permissions ask-for-approval or /permissions full-access sets the requested policy for the next turn. The native backend owns approvals and advertises its available choices. Full access remains inside the ALA sandbox. Stock Pi requires full-access and a supported version. Native policy refusals are errors; no UI approval cache is maintained.',
    },
    models: {
        title: 'Native model selection',
        content: '/model lists the selected coding backend\'s native models. /model <id> saves a backend-specific workspace selection; /model default clears only that backend override. Running turns keep their configuration snapshot. Authenticate the backend in the dedicated ALA home before executing prompts.',
    },
    tasks: {
        title: 'Persistent delegated tasks',
        content: '/tasks shows durable worker status. /task view <id> opens stored log output; /task continue <id> <prompt> continues the same worker; /task stop <id> explicitly stops it. /task model and /task login configure its worker. Stopping a copilot turn or switching sessions does not stop delegated tasks. launch-robot uses the ordinary workspace robot named default when the name is omitted.',
    },
    keyboard: {
        title: 'Keyboard controls',
        content: 'Tab completes commands and arguments. Up/Down navigate input history and selectors. Enter submits; Escape cancels a selector or the current execution. /raw toggles Markdown rendering. help, reload, list, ls, list all, ls -a, history and hist are deterministic quick commands; quit, exit and q leave the terminal.',
    },
};

export function getQuickReference() {
    return ['Achilles CLI — ALA', '', ...buildSlashCommandCatalog().map((command) =>
        `${command.usage}  ${command.description}${command.subCommands.length ? ` (${command.subCommands.map((sub) => sub.name).join(', ')})` : ''}`),
    '', 'Type /help <command or topic> for details.'].join('\n');
}

export function showHelp(topic = null) {
    if (!topic || ['commands', 'quick', 'all'].includes(topic)) return getQuickReference();
    const name = String(topic).replace(/^\//, '').toLowerCase();
    if (HELP_TOPICS[name]) return `${HELP_TOPICS[name].title}\n\n${HELP_TOPICS[name].content}`;
    const command = buildSlashCommandCatalog().find((entry) => entry.name === `/${name}`);
    if (command) return [command.usage, command.description, ...command.subCommands.map((sub) => `${sub.usage}  ${sub.description}`)].join('\n');
    return `Unknown help topic: ${topic}. Available topics: ${getHelpTopics().map((entry) => entry.name).join(', ')}.`;
}

export function getHelpTopics() {
    return Object.entries(HELP_TOPICS).map(([name, topic]) => ({ name, title: topic.title }));
}

export function getCommandHelp() {
    return buildSlashCommandCatalog().map((command) => ({ name: command.name.slice(1), title: command.description }));
}

export default { showHelp, getQuickReference, getHelpTopics, getCommandHelp };
