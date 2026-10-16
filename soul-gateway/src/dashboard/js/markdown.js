/**
 * Lightweight Markdown -> HTML renderer for the Soul Gateway dashboard.
 * Adapted from ploinky webchat markdown.js.
 * Exposes window.renderMarkdown(src) -> HTML string.
 */
(() => {
    function tokenFactory(prefix) {
        const fn = () => `@@${prefix}_${fn.__idx++}@@`;
        fn.__idx = 0;
        return fn;
    }

    function escapeHtml(str) {
        return (str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttribute(str) {
        return escapeHtml(str).replace(/`/g, '&#96;');
    }

    function extractCodeBlocks(input, store) {
        const createToken = tokenFactory('CODE_BLOCK');
        return input.replace(
            /```([^\n`]*)\n([\s\S]*?)```/g,
            (_, lang, body) => {
                const token = createToken();
                store[token] =
                    `<pre class="sg-md-code"><code${lang ? ` data-lang="${escapeAttribute(lang.trim())}"` : ''}>${escapeHtml((body || '').replace(/\s+$/g, ''))}</code></pre>`;
                return `\n\n${token}\n\n`;
            }
        );
    }

    function restorePlaceholders(value, placeholders) {
        let output = value;
        for (const token of Object.keys(placeholders)) {
            output = output.split(token).join(placeholders[token]);
        }
        return output;
    }

    const TABLE_SEPARATOR_RE = /^:?-{1,}:?$/;

    function splitTableRow(row) {
        if (!row) return [];
        const trimmed = row.trim();
        if (!trimmed) return [];
        let start = 0,
            end = trimmed.length;
        if (trimmed[start] === '|') start += 1;
        if (trimmed[end - 1] === '|') end -= 1;
        const cells = [];
        let current = '',
            escaped = false;
        for (let i = start; i < end; i++) {
            const ch = trimmed[i];
            if (escaped) {
                current += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '|') {
                cells.push(current.trim());
                current = '';
            } else current += ch;
        }
        cells.push(current.trim());
        return cells;
    }

    function parseAlignment(cell) {
        const c = cell.replace(/\s+/g, '');
        if (!TABLE_SEPARATOR_RE.test(c)) return null;
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        if (c.startsWith(':')) return 'left';
        return null;
    }

    function tryRenderTable(block, state, processInline) {
        const lines = (block || '')
            .trim()
            .split(/\n/)
            .map((l) => l.trimEnd())
            .filter((l) => l.trim());
        if (
            lines.length < 2 ||
            !lines[0].includes('|') ||
            !lines[1].includes('|')
        )
            return null;
        const headerCells = splitTableRow(lines[0]);
        const sepCells = splitTableRow(lines[1]);
        if (!headerCells.length || headerCells.length !== sepCells.length)
            return null;
        if (
            !sepCells.every((c) =>
                TABLE_SEPARATOR_RE.test(c.replace(/\s+/g, ''))
            )
        )
            return null;
        const aligns = sepCells.map(parseAlignment);
        const alignAttr = (a) => (a ? ` style="text-align:${a}"` : '');
        const head = headerCells
            .map(
                (c, i) => `<th${alignAttr(aligns[i])}>${processInline(c)}</th>`
            )
            .join('');
        const body = lines
            .slice(2)
            .map((line) => {
                if (!line.includes('|')) return '';
                const cells = splitTableRow(line);
                return `<tr>${headerCells.map((_, i) => `<td${alignAttr(aligns[i])}>${processInline(cells[i] || '')}</td>`).join('')}</tr>`;
            })
            .filter(Boolean)
            .join('');
        return `<div class="sg-md-table-wrap"><table class="sg-md-table"><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>`;
    }

    function processInlineFactory(state) {
        return function processInline(text) {
            if (!text) return '';
            const inlineToken = state.inlineCodeFactory;
            const inlineStore = {};
            let w = text.replace(/`([^`]+)`/g, (_, code) => {
                const t = inlineToken();
                inlineStore[t] =
                    `<code class="sg-md-inline-code">${escapeHtml(code)}</code>`;
                return t;
            });
            w = escapeHtml(w);
            w = w.replace(
                /\*\*([^*]+)\*\*/g,
                (_, b) => `<strong>${b}</strong>`
            );
            w = w.replace(
                /(^|\s)\*([^*]+)\*(?=\s|$)/g,
                (_, lead, it) => `${lead}<em>${it}</em>`
            );
            w = w.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
                try {
                    const u = new URL(url.trim(), window.location.origin);
                    if (u.protocol === 'http:' || u.protocol === 'https:') {
                        const t = state.linkTokenFactory();
                        state.placeholders[t] =
                            `<a href="${escapeAttribute(u.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
                        return t;
                    }
                } catch {}
                return `${label} (${url})`;
            });
            w = w.replace(/\n/g, '<br/>');
            for (const t of Object.keys(inlineStore))
                w = w.split(t).join(inlineStore[t]);
            return restorePlaceholders(w, state.placeholders);
        };
    }

    function renderList(block, type, state, processInline) {
        const re = type === 'ul' ? /^[-*+]\s+(.*)$/ : /^\d+\.\s+(.*)$/;
        const items = [];
        let cur = '';
        for (const line of block.split(/\n/)) {
            const m = line.trim().match(re);
            if (m) {
                if (cur) items.push(cur);
                cur = m[1];
            } else if (cur) cur += `\n${line.trim()}`;
        }
        if (cur) items.push(cur);
        return `<${type}>${items.map((i) => `<li>${processInline(i)}</li>`).join('')}</${type}>`;
    }

    function renderHeading(line, processInline) {
        const m = line.trim().match(/^(#{1,6})\s+(.*)$/);
        if (!m) return `<p>${processInline(line)}</p>`;
        const lvl = Math.min(m[1].length, 6);
        return `<h${lvl}>${processInline(m[2])}</h${lvl}>`;
    }

    function renderBlockquote(block) {
        const cleaned = block
            .split(/\n/)
            .map((l) => l.replace(/^\s{0,3}>\s?/, ''))
            .join('\n');
        return `<blockquote>${renderMarkdown(cleaned)}</blockquote>`;
    }

    function renderMarkdown(src) {
        if (!src) return '';
        const state = {
            placeholders: {},
            inlineCodeFactory: tokenFactory('INLINE_CODE'),
            linkTokenFactory: tokenFactory('LINK_TOKEN'),
        };
        const processInline = processInlineFactory(state);
        const codeStore = {};
        let input = extractCodeBlocks(
            String(src).replace(/\r\n?/g, '\n'),
            codeStore
        );

        // Ensure headings get their own block
        input = input.replace(/\n(#{1,6}\s+)/g, (m, h, off, str) => {
            const prev = str.slice(0, off);
            const lastNl = prev.lastIndexOf('\n');
            const prevLine = lastNl === -1 ? prev : prev.slice(lastNl + 1);
            return (!prevLine.trim() ? '\n' : '\n\n') + h;
        });
        input = input.replace(/^(#{1,6}\s+[^\n]+)\n(?!\s*\n)/gm, '$1\n\n');

        // Ensure list items get their own block
        input = input.replace(
            /\n(?!\s*\n)(\s{0,3}[-*+]\s+)/g,
            (m, b, off, str) => {
                const prev = str.slice(0, off);
                const lastNl = prev.lastIndexOf('\n');
                const prevLine = lastNl === -1 ? prev : prev.slice(lastNl + 1);
                return (/^\s{0,3}[-*+]\s+/.test(prevLine) ? '\n' : '\n\n') + b;
            }
        );
        input = input.replace(
            /\n(?!\s*\n)(\s{0,3}\d+\.\s+)/g,
            (m, b, off, str) => {
                const prev = str.slice(0, off);
                const lastNl = prev.lastIndexOf('\n');
                const prevLine = lastNl === -1 ? prev : prev.slice(lastNl + 1);
                return (/^\s{0,3}\d+\.\s+/.test(prevLine) ? '\n' : '\n\n') + b;
            }
        );

        const blocks = input.split(/\n{2,}/);
        let html = blocks
            .map((block) => {
                const t = block.trim();
                if (!t) return '';
                if (codeStore[t]) return codeStore[t];
                const tbl = tryRenderTable(t, state, processInline);
                if (tbl) return tbl;
                if (/^\s{0,3}[-*+]\s+/.test(t))
                    return renderList(t, 'ul', state, processInline);
                if (/^\s{0,3}\d+\.\s+/.test(t))
                    return renderList(t, 'ol', state, processInline);
                if (/^#{1,6}\s/.test(t)) {
                    const lines = t.split('\n');
                    const h = renderHeading(lines.shift(), processInline);
                    const rest = lines.join('\n').trim();
                    return rest ? h + renderMarkdown(rest) : h;
                }
                if (/^\s{0,3}>\s?/.test(t)) return renderBlockquote(t);
                if (/^[-*_]{3,}$/.test(t)) return '<hr/>';
                return `<p>${processInline(t)}</p>`;
            })
            .filter(Boolean)
            .join('');

        html = restorePlaceholders(html, state.placeholders);
        return html;
    }

    window.renderMarkdown = renderMarkdown;
})();
