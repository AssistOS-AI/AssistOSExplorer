function normalizeString(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function tryParseJsonPayload(rawText) {
    if (typeof rawText !== 'string') {
        return null;
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
        return null;
    }

    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace <= firstBrace) {
            return null;
        }
        try {
            const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }
}

function extractToolText(result) {
    if (!result) {
        return '';
    }
    if (typeof result === 'string') {
        return result;
    }
    if (Array.isArray(result.content)) {
        return result.content
            .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
            .map((entry) => entry.text)
            .join('\n')
            .trim();
    }
    if (typeof result.text === 'string') {
        return result.text;
    }
    try {
        return JSON.stringify(result, null, 2);
    } catch {
        return String(result);
    }
}

// Tool results carry stdout as the first text block and, when present, a
// separate `stderr:` block. Only the stdout block is the structured result;
// it is parsed strictly and raw tool text is never shown to the visitor,
// because the creating chat response carries the session secret.
function readToolStdoutJson(toolResult) {
    let text = '';
    if (typeof toolResult === 'string') {
        text = toolResult;
    } else if (Array.isArray(toolResult?.content)) {
        const first = toolResult.content.find((entry) => entry && entry.type === 'text' && typeof entry.text === 'string');
        text = first ? first.text : '';
    }
    try {
        const parsed = JSON.parse(String(text).trim());
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// Session credentials move together: a response that names a new session
// replaces both the id and the secret (clearing the secret when none came
// back); the same session without a secret keeps the stored secret.
export function nextChatSessionState(current, response) {
    const currentSessionId = normalizeString(current?.sessionId);
    const currentSecret = normalizeString(current?.sessionSecret);
    const nextSessionId = normalizeString(response?.sessionId);
    const nextSecret = normalizeString(response?.sessionSecret);
    if (!nextSessionId) {
        return { sessionId: currentSessionId, sessionSecret: currentSecret };
    }
    if (nextSecret) {
        return { sessionId: nextSessionId, sessionSecret: nextSecret };
    }
    if (nextSessionId === currentSessionId) {
        return { sessionId: currentSessionId, sessionSecret: currentSecret };
    }
    return { sessionId: nextSessionId, sessionSecret: '' };
}

function sanitizeAgentText(rawText) {
    const text = normalizeString(rawText);
    if (!text) {
        return '';
    }

    const lines = text.split(/\r?\n/);
    const cleaned = [];
    for (const rawLine of lines) {
        const line = String(rawLine ?? '');
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        if (/^Session ID:\s*/i.test(trimmed)) {
            continue;
        }
        if (/^Type\s+exit\s+to\s+leave\s*$/i.test(trimmed)) {
            continue;
        }
        if (/^you>\s*$/i.test(trimmed)) {
            continue;
        }
        const promptMatch = trimmed.match(/^you>\s*(.*)$/i);
        if (promptMatch) {
            const value = normalizeString(promptMatch[1]);
            if (value) {
                cleaned.push(value);
            }
            continue;
        }
        cleaned.push(trimmed);
    }

    return cleaned.join('\n').trim();
}

function loadSessionId(storageKey) {
    try {
        const value = window.localStorage.getItem(storageKey);
        return typeof value === 'string' && value.trim() ? value.trim() : '';
    } catch {
        return '';
    }
}

function persistSessionId(storageKey, sessionId) {
    try {
        if (typeof sessionId === 'string' && sessionId.trim()) {
            window.localStorage.setItem(storageKey, sessionId.trim());
            return;
        }
        window.localStorage.removeItem(storageKey);
    } catch {
        // Ignore storage failures.
    }
}

const THEME_PRESETS = Object.freeze({
    light: Object.freeze({
        chatBackground: '#f2f7ff',
        userBubble: '#1e293b',
        agentBubble: '#f8fbff',
        headerColor: '#0f172a'
    }),
    dark: Object.freeze({
        chatBackground: '#1E1F22',
        userBubble: '#33353B',
        agentBubble: '#26282C',
        headerColor: '#191A1C'
    }),
    aqua: Object.freeze({
        chatBackground: '#e6f7fb',
        userBubble: '#0b4f6c',
        agentBubble: '#d3edf5',
        headerColor: '#0f3d53'
    }),
    forest: Object.freeze({
        chatBackground: '#0f1f17',
        userBubble: '#1f4d3a',
        agentBubble: '#1a2f24',
        headerColor: '#102419'
    }),
    amethyst: Object.freeze({
        chatBackground: '#f4eeff',
        userBubble: '#5b3f8c',
        agentBubble: '#ece2ff',
        headerColor: '#3e2a66'
    }),
});

function normalizeTheme(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(THEME_PRESETS, normalized) ? normalized : 'light';
}

function detectBrowserTheme() {
    try {
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
    } catch {
        // Ignore matchMedia failures.
    }
    return 'light';
}

// Resolve the effective chat theme: an explicit ?theme= query param wins, then the
// host Explorer's applied theme class, then the browser/OS preference, then light.
function resolveChatTheme(query) {
    const requested = query.get('theme');
    if (requested) {
        return normalizeTheme(requested);
    }
    try {
        const root = typeof document !== 'undefined' ? document.documentElement : null;
        if (root && root.classList) {
            if (root.classList.contains('theme-dark')) {
                return 'dark';
            }
            if (root.classList.contains('theme-light')) {
                return 'light';
            }
        }
    } catch {
        // Ignore DOM access failures.
    }
    return detectBrowserTheme();
}

function normalizeHex(value, fallback) {
    const normalized = String(value || '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : fallback;
}

function hexToRgb(hex) {
    const value = normalizeHex(hex, '');
    if (!value) return null;
    return {
        r: Number.parseInt(value.slice(1, 3), 16),
        g: Number.parseInt(value.slice(3, 5), 16),
        b: Number.parseInt(value.slice(5, 7), 16),
    };
}

function relativeLuminance(rgb) {
    const convert = (channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const r = convert(rgb.r);
    const g = convert(rgb.g);
    const b = convert(rgb.b);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pickReadableTextColor(backgroundHex, dark = '#0f172a', light = '#f8fafc') {
    const rgb = hexToRgb(backgroundHex);
    if (!rgb) return dark;
    const luminance = relativeLuminance(rgb);
    return luminance > 0.5 ? dark : light;
}

const BROWSER_STORAGE_KEY = 'webassist-chat:sessionId';
const SECRET_STORAGE_KEY = 'webassist-chat:sessionSecret';
const VISITOR_STORAGE_KEY = 'webassist-chat:visitorId';

function generateVisitorId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `visitor-${crypto.randomUUID()}`;
    }
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 10);
    return `visitor-${timestamp}-${random}`;
}

function loadOrCreateVisitorId(storageKey) {
    const existing = loadSessionId(storageKey);
    if (existing) {
        return existing;
    }
    const created = generateVisitorId();
    persistSessionId(storageKey, created);
    return created;
}

export class WebAssistMcpChatClient {
    constructor(options = {}) {
        this.clientModuleUrl = options.clientModuleUrl || '/MCPBrowserClient.js';
        this.endpoint = options.endpoint || '/webAssist/mcp';
        this.chatToolName = options.chatToolName || 'web_cli_chat';
        this.historyToolName = options.historyToolName || 'web_cli_history';
        this.registerVisitorToolName = options.registerVisitorToolName || 'register-events';
        this.validateTools = options.validateTools === true;
        this.mcpClient = null;
        this.mcpClientPromise = null;
        this.availableTools = null;
    }

    async close() {
        if (this.mcpClient && typeof this.mcpClient.close === 'function') {
            await this.mcpClient.close();
        }
    }

    async ensureMcpClient() {
        if (this.mcpClient) {
            return this.mcpClient;
        }
        if (this.mcpClientPromise) {
            return this.mcpClientPromise;
        }
        this.mcpClientPromise = (async () => {
            const module = await import(this.clientModuleUrl);
            if (!module || typeof module.createAgentClient !== 'function') {
                throw new Error('MCP browser client module is unavailable.');
            }
            this.mcpClient = module.createAgentClient(this.endpoint);
            return this.mcpClient;
        })();
        try {
            return await this.mcpClientPromise;
        } finally {
            this.mcpClientPromise = null;
        }
    }

    async ensureNamedToolAvailable(client, toolName) {
        if (!this.validateTools) {
            return;
        }
        if (!this.availableTools) {
            const tools = await client.listTools();
            this.availableTools = new Set(
                (Array.isArray(tools) ? tools : [])
                    .map((tool) => (tool && typeof tool.name === 'string' ? tool.name : ''))
                    .filter(Boolean)
            );
        }
        if (!this.availableTools.has(toolName)) {
            throw new Error(`MCP tool ${toolName} not found. Verify webAssist/mcp-config.json.`);
        }
    }

    async invokeChat(siteId, message, sessionId = '', sessionSecret = '') {
        const client = await this.ensureMcpClient();
        await this.ensureNamedToolAvailable(client, this.chatToolName);

        const normalizedSiteId = normalizeString(siteId);
        if (!normalizedSiteId) {
            throw new Error('Missing siteId for chat.');
        }

        const args = { siteId: normalizedSiteId, message, json: true };
        const normalizedSessionId = normalizeString(sessionId);
        if (normalizedSessionId) {
            args.sessionId = normalizedSessionId;
        }
        const normalizedSecret = normalizeString(sessionSecret);
        if (normalizedSecret) {
            args.sessionSecret = normalizedSecret;
        }

        const toolResult = await client.callTool(this.chatToolName, args);
        if (toolResult?.isError === true) {
            throw new Error(`${this.chatToolName} request failed.`);
        }
        const parsed = readToolStdoutJson(toolResult);
        if (!parsed) {
            throw new Error(`${this.chatToolName} returned an unreadable payload.`);
        }
        return {
            responseText: sanitizeAgentText(parsed.message) || sanitizeAgentText(parsed.response) || '(no output)',
            siteId: normalizeString(parsed.siteId, normalizedSiteId),
            sessionId: normalizeString(parsed.sessionId),
            sessionSecret: normalizeString(parsed.sessionSecret),
        };
    }

    async invokeHistory(siteId, sessionId, sessionSecret = '') {
        const normalizedSiteId = normalizeString(siteId);
        if (!normalizedSiteId) {
            throw new Error('Missing siteId for history loading.');
        }
        const normalizedSessionId = normalizeString(sessionId);
        if (!normalizedSessionId) {
            throw new Error('Missing sessionId for history loading.');
        }

        const client = await this.ensureMcpClient();
        await this.ensureNamedToolAvailable(client, this.historyToolName);

        const args = { siteId: normalizedSiteId, sessionId: normalizedSessionId };
        const normalizedSecret = normalizeString(sessionSecret);
        if (normalizedSecret) {
            args.sessionSecret = normalizedSecret;
        }
        const toolResult = await client.callTool(this.historyToolName, args);
        const parsed = toolResult?.isError === true ? null : readToolStdoutJson(toolResult);
        if (!parsed) {
            throw new Error(`Invalid history payload returned by ${this.historyToolName}.`);
        }

        return {
            siteId: normalizeString(parsed.siteId, normalizedSiteId),
            sessionId: normalizeString(parsed.sessionId, normalizedSessionId),
            history: Array.isArray(parsed.history) ? parsed.history : [],
        };
    }

    async registerVisitor(siteId, visitorId, openedChat = false) {
        const normalizedSiteId = normalizeString(siteId);
        if (!normalizedSiteId) {
            throw new Error('Missing siteId for visitor registration.');
        }
        const normalizedVisitorId = normalizeString(visitorId);
        if (!normalizedVisitorId) {
            throw new Error('Missing visitorId for visitor registration.');
        }

        const client = await this.ensureMcpClient();
        await this.ensureNamedToolAvailable(client, this.registerVisitorToolName);

        const toolResult = await client.callTool(this.registerVisitorToolName, {
            siteId: normalizedSiteId,
            visitorId: normalizedVisitorId,
            eventType: 'visit',
            referrer: typeof document !== 'undefined' ? document.referrer || '' : '',
            openedChat,
        });
        const toolText = extractToolText(toolResult);
        const parsed = tryParseJsonPayload(toolText);
        if (!parsed || typeof parsed !== 'object') {
            return { ok: false };
        }

        return {
            ok: parsed.ok === true,
            siteId: normalizeString(parsed.siteId, normalizedSiteId),
            visitorId: normalizeString(parsed.visitorId, normalizedVisitorId),
            visitPath: normalizeString(parsed.visitPath),
        };
    }
}

function mountChatSurface(rootNode, options = {}) {
    const root = rootNode || document;
    const q = (selector) => root.querySelector(selector);

    const widgetEl = q('#chatWidget');
    const panelEl = q('#chatPanel');
    const launcherEl = q('#chatLauncher');
    const closeEl = q('#chatClose');
    const titleEl = q('#chatTitle');
    const subtitleEl = q('#chatSubtitle');
    const messagesEl = q('#chatMessages');
    const typingEl = q('#typing');
    const composerEl = q('#chatComposer');
    const inputEl = q('#chatInput');
    const sendEl = q('#chatSend');

    if (!titleEl || !subtitleEl || !messagesEl || !typingEl || !composerEl || !inputEl || !sendEl) {
        return () => {};
    }

    const query = options.query || new URLSearchParams(window.location.search);
    const siteId = normalizeString(query.get('siteId'));
    const subtitleText = options.subtitleText || 'Embedded preview';
    const enableLauncher = options.enableLauncher === true;
    const validateTools = options.validateTools === true;
    const endpoint = '/webAssist/mcp';
    const chatClient = new WebAssistMcpChatClient({ validateTools, endpoint });

    let storageKey = `${BROWSER_STORAGE_KEY}:${siteId || 'pending'}`;
    const secretStorageKey = `${SECRET_STORAGE_KEY}:${siteId || 'pending'}`;
    let visitorStorageKey = `${VISITOR_STORAGE_KEY}:${siteId || 'pending'}`;

    const theme = resolveChatTheme(query);
    const preset = THEME_PRESETS[theme];
    const headerText = normalizeString(query.get('headerText'), 'WebAssist Assistant');
    const subtitleOverride = normalizeString(query.get('subtitleText'));
    const chatBackground = normalizeHex(query.get('chatBackground'), preset.chatBackground);
    const userBubble = normalizeHex(query.get('userBubble'), preset.userBubble);
    const agentBubble = normalizeHex(query.get('agentBubble'), preset.agentBubble);
    const headerColor = normalizeHex(query.get('headerColor'), preset.headerColor);

    const agentTextColor = pickReadableTextColor(agentBubble);
    const userTextColor = pickReadableTextColor(userBubble);
    const inputTextColor = pickReadableTextColor(chatBackground);
    const sendTextColor = pickReadableTextColor(userBubble);

    const styleRoot = root === document ? document.documentElement : root;
    styleRoot.style.setProperty('--chat-bg', chatBackground);
    styleRoot.style.setProperty('--chat-user', userBubble);
    styleRoot.style.setProperty('--chat-agent', agentBubble);
    styleRoot.style.setProperty('--chat-header', headerColor);
    styleRoot.style.setProperty('--chat-agent-text', agentTextColor);
    styleRoot.style.setProperty('--chat-user-text', userTextColor);
    styleRoot.style.setProperty('--chat-composer-bg', chatBackground);
    styleRoot.style.setProperty('--chat-input-bg', chatBackground);
    styleRoot.style.setProperty('--chat-input-text', inputTextColor);
    styleRoot.style.setProperty('--chat-input-border', agentBubble);
    styleRoot.style.setProperty('--chat-send-bg', userBubble);
    styleRoot.style.setProperty('--chat-send-text', sendTextColor);
    styleRoot.style.setProperty('--chat-base-text', inputTextColor);

    titleEl.textContent = headerText;
    subtitleEl.textContent = subtitleOverride || subtitleText;

    function setPanelOpen(isOpen) {
        if (!widgetEl || !panelEl) {
            return;
        }
        widgetEl.dataset.open = isOpen ? 'true' : 'false';
        widgetEl.classList.toggle('open', isOpen);
        panelEl.hidden = !isOpen;
        if (launcherEl) {
            launcherEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        }
    }

    function appendMessage(role, text) {
        const wrapper = document.createElement('div');
        wrapper.className = `chat-message ${role}`;
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.textContent = typeof text === 'string' ? text : String(text ?? '');
        wrapper.appendChild(bubble);
        messagesEl.appendChild(wrapper);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    let isPending = false;
    let isActivated = false;
    let missingSiteMessageShown = false;
    let currentSessionId = loadSessionId(storageKey);
    let currentSessionSecret = loadSessionId(secretStorageKey);
    let visitorId = loadSessionId(visitorStorageKey);
    let hydratedHistorySessionId = '';

    function applySessionState(response) {
        const next = nextChatSessionState({ sessionId: currentSessionId, sessionSecret: currentSessionSecret }, response);
        currentSessionId = next.sessionId;
        currentSessionSecret = next.sessionSecret;
        persistSessionId(storageKey, currentSessionId);
        persistSessionId(secretStorageKey, currentSessionSecret);
    }

    function hasConversationMessages() {
        return messagesEl.querySelector('.chat-message:not(.chat-typing)') !== null;
    }

    function showTyping() {
        messagesEl.appendChild(typingEl);
        typingEl.classList.add('show');
        typingEl.setAttribute('aria-hidden', 'false');
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function hideTyping() {
        typingEl.classList.remove('show');
        typingEl.setAttribute('aria-hidden', 'true');
    }

    function buildLoadingMessages() {
        const label = siteId ? siteId.replace(/-/g, ' ') : 'this site';
        return [
            `Looking up info on ${label}`,
            `Reading page details`,
            `Almost ready`,
        ];
    }

    let loadingBubble = null;
    let loadingText = null;
    let loadingTimer = null;
    let loadingIndex = 0;

    function appendLoadingBubble({ text, datasetKey }) {
        hideTyping();
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-message agent';
        if (datasetKey) {
            wrapper.dataset[datasetKey] = 'true';
        }
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble chat-bubble-loading';
        const textNode = document.createTextNode(text);
        bubble.appendChild(textNode);
        for (let i = 0; i < 3; i += 1) {
            const dot = document.createElement('span');
            bubble.appendChild(dot);
        }
        wrapper.appendChild(bubble);
        messagesEl.appendChild(wrapper);
        messagesEl.scrollTop = messagesEl.scrollHeight;

        return { wrapper, bubble, textNode };
    }

    function showLoadingMessages() {
        const loading = appendLoadingBubble({
            text: 'Thinking',
            datasetKey: 'loading',
        });
        loadingText = loading.textNode;
        loadingBubble = loading.bubble;

        const msgs = buildLoadingMessages();
        loadingIndex = 0;
        loadingTimer = setInterval(() => {
            loadingIndex = (loadingIndex + 1) % msgs.length;
            loadingText.textContent = msgs[loadingIndex];
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }, 1500);
    }

    function hideLoadingMessages() {
        clearInterval(loadingTimer);
        loadingTimer = null;
        const el = messagesEl.querySelector('[data-loading="true"]');
        if (el) el.remove();
        loadingBubble = null;
        loadingText = null;
    }

    function refreshComposerState() {
        const disabled = isPending || !siteId;
        sendEl.disabled = disabled;
        inputEl.disabled = disabled;
    }

    function setPending(next) {
        isPending = Boolean(next);
        refreshComposerState();
    }

    function resizeInput() {
        inputEl.style.height = 'auto';
        const height = Math.min(inputEl.scrollHeight, 160);
        inputEl.style.height = `${height}px`;
    }

    async function hydrateHistoryFromSession() {
        if (!siteId || !currentSessionId) {
            return;
        }
        if (hydratedHistorySessionId === currentSessionId) {
            return;
        }
        if (hasConversationMessages()) {
            hydratedHistorySessionId = currentSessionId;
            return;
        }

        setPending(true);
        try {
            const payload = await chatClient.invokeHistory(siteId, currentSessionId, currentSessionSecret);
            applySessionState({ sessionId: normalizeString(payload.sessionId, currentSessionId) });

            const historyItems = Array.isArray(payload.history) ? payload.history : [];
            for (const entry of historyItems) {
                const role = String(entry?.role ?? '').trim().toLowerCase() === 'user' ? 'user' : 'agent';
                const rawMessage = role === 'agent'
                    ? sanitizeAgentText(entry?.message)
                    : normalizeString(entry?.message);
                const message = normalizeString(rawMessage);
                if (!message) {
                    continue;
                }
                appendMessage(role, message);
            }
        } catch (error) {
            console.error('[WebAssistChat] Failed to load history:', error);
        } finally {
            hydratedHistorySessionId = currentSessionId;
            setPending(false);
        }
    }

    async function registerVisitorActivity() {
        if (!siteId || !visitorId) {
            return;
        }
        try {
            await chatClient.registerVisitor(siteId, visitorId, widgetEl?.dataset.open === 'true');
        } catch {
        }
    }

    const onInput = () => resizeInput();
    const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            composerEl.requestSubmit();
        }
    };
    const onSubmit = async (event) => {
        event.preventDefault();
        if (isPending || !siteId) {
            return;
        }

        const message = normalizeString(inputEl.value);
        if (!message) {
            return;
        }

        appendMessage('user', message);
        inputEl.value = '';
        resizeInput();

        setPending(true);
        showLoadingMessages();
        try {
            const result = await chatClient.invokeChat(siteId, message, currentSessionId, currentSessionSecret);
            hideLoadingMessages();
            appendMessage('agent', result.responseText);
            applySessionState(result);
        } catch (error) {
            hideLoadingMessages();
            console.error('[WebAssistChat] Chat request failed:', error);
        } finally {
            setPending(false);
            inputEl.focus();
        }
    };
    const onBeforeUnload = () => {
        void chatClient.close();
    };
    const onOpenPanel = () => {
        setPanelOpen(true);
        if (!inputEl.disabled) {
            inputEl.focus();
        }
    };
    const onClosePanel = () => {
        setPanelOpen(false);
    };

    function activateChat() {
        if (!siteId) {
            if (!missingSiteMessageShown) {
                appendMessage('agent', 'This WebAssist embed is missing a siteId.');
                missingSiteMessageShown = true;
            }
            refreshComposerState();
            return;
        }

        if (widgetEl && panelEl) {
            if (enableLauncher) {
                widgetEl.classList.remove('inline-mode');
                setPanelOpen(false);
            } else {
                widgetEl.classList.add('inline-mode');
                setPanelOpen(true);
            }
        }

        if (!isActivated) {
            inputEl.addEventListener('input', onInput);
            inputEl.addEventListener('keydown', onKeyDown);
            composerEl.addEventListener('submit', onSubmit);
            window.addEventListener('beforeunload', onBeforeUnload);
            launcherEl?.addEventListener('click', onOpenPanel);
            closeEl?.addEventListener('click', onClosePanel);
            isActivated = true;
        }
        refreshComposerState();

        if (siteId) {
            void hydrateHistoryFromSession();
        }

        if (siteId && !visitorId) {
            visitorId = loadOrCreateVisitorId(visitorStorageKey);
            void registerVisitorActivity();
        }
    }

    activateChat();

    return () => {
        inputEl.removeEventListener('input', onInput);
        inputEl.removeEventListener('keydown', onKeyDown);
        composerEl.removeEventListener('submit', onSubmit);
        window.removeEventListener('beforeunload', onBeforeUnload);
        launcherEl?.removeEventListener('click', onOpenPanel);
        closeEl?.removeEventListener('click', onClosePanel);
        void chatClient.close();
    };
}

export class WebAssistChat {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.cleanup = null;
    }

    beforeRender() {}

    afterRender() {
        this.cleanup?.();
        this.cleanup = mountChatSurface(this.element, {
            subtitleText: 'Context-aware website chat',
            enableLauncher: false,
            validateTools: true,
        });
    }

    afterUnload() {
        this.cleanup?.();
        this.cleanup = null;
    }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.getElementById('chatMessages')) {
        mountChatSurface(document, {
            subtitleText: 'Embedded preview',
            enableLauncher: true,
            validateTools: false,
        });
    }
}
