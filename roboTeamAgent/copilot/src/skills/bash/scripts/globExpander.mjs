import fs from 'node:fs';
import path from 'node:path';

function hasGlob(value) {
    return /[*?\[]/.test(String(value || ''));
}

function segmentToRegExp(segment) {
    let pattern = '';
    for (let index = 0; index < segment.length; index += 1) {
        const char = segment[index];
        if (char === '*') {
            pattern += '[^/]*';
        } else if (char === '?') {
            pattern += '[^/]';
        } else if (char === '[') {
            const close = segment.indexOf(']', index + 1);
            if (close > index + 1) {
                pattern += segment.slice(index, close + 1);
                index = close;
            } else {
                pattern += '\\[';
            }
        } else {
            pattern += char.replace(/[\\^$+?.()|{}]/g, '\\$&');
        }
    }
    return new RegExp(`^${pattern}$`);
}

function expandSegments(baseDir, segments, index = 0) {
    if (index >= segments.length) {
        return [baseDir];
    }

    const segment = segments[index];
    if (!hasGlob(segment)) {
        return expandSegments(path.join(baseDir, segment), segments, index + 1);
    }

    let entries = [];
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const matcher = segmentToRegExp(segment);
    const matches = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.') && !segment.startsWith('.')) {
            continue;
        }
        if (!matcher.test(entry.name)) {
            continue;
        }
        matches.push(...expandSegments(path.join(baseDir, entry.name), segments, index + 1));
    }
    return matches;
}

function expandGlobArg(arg, cwd) {
    const text = String(arg || '');
    if (!hasGlob(text)) {
        return [text];
    }

    const parsed = path.parse(text);
    const baseDir = parsed.root || cwd;
    const relative = parsed.root ? text.slice(parsed.root.length) : text;
    const segments = relative.split(/[\\/]+/).filter(Boolean);
    const matches = expandSegments(baseDir, segments);

    if (!matches.length) {
        return [text];
    }

    return matches.sort().map((match) => (
        parsed.root ? match : path.relative(cwd, match) || '.'
    ));
}

export function expandGlobsInArgs(args = [], cwd = process.cwd()) {
    if (!Array.isArray(args)) {
        return [];
    }
    return args.flatMap((arg) => expandGlobArg(arg, cwd));
}
