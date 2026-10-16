import { invalid } from './graph.mjs';

function responseError(detail) {
    return invalid(`Error parsing response: "${detail}"`);
}

const keyOf = value => value.toLowerCase().replace(/[\s_-]+/g, '');
const heading = line => /^[ \t]*#{1,6}[ \t]*([^#\n]+?)[ \t]*(?:#+[ \t]*)?$/.exec(line)?.[1].replace(/:\s*$/, '');
const fenceOf = line => /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
const closes = (match, fence) => match && match[1][0] === fence[1][0] && match[1].length >= fence[1].length && !match[2].trim();
const trimBlankLines = text => text.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');

// Remove only a fence enclosing the whole value. Shorter, nested fences stay literal.
function unfence(text) {
    const lines = trimBlankLines(text).split('\n');
    const fence = fenceOf(lines[0]);
    if (!fence) return text;
    const end = lines.findIndex((line, index) => index > 0 && closes(fenceOf(line), fence));
    return end === lines.length - 1 ? lines.slice(1, -1).join('\n') : text;
}

function scalar(text) {
    let value = unfence(text).trim();
    const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)'|(`+)([\s\S]*?)\3)$/.exec(value);
    if (quoted) value = (quoted[1] ?? quoted[2] ?? quoted[4]).trim();
    return value;
}

function put(object, key, value, location) {
    if (Object.hasOwn(object, key) && JSON.stringify(object[key]) !== JSON.stringify(value)) {
        throw responseError(`Conflicting ${key} in ${location}`);
    }
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

function fieldsOf(fields) {
    return new Map(Object.entries(fields).flatMap(([name, definition]) => {
        const field = typeof definition === 'string' ? { type: definition } : definition;
        return [name, ...(field.aliases || [])].map(alias => [keyOf(alias), { ...field, name }]);
    }));
}

function readValue(section, field) {
    if (field.type === 'text') return trimBlankLines(unfence(section.body));
    if (field.type === 'list') {
        const value = unfence(section.body).trim();
        if (!value || value === '[]') return [];
        return value.split('\n').filter(line => line.trim()).map(line => {
            const item = scalar(line.replace(/^\s*(?:[-*+] |\d+[.)] )/, ''));
            if (!item) throw responseError(`Empty item in ${field.name} at line ${section.line}`);
            return item;
        });
    }
    const value = scalar(section.body);
    if (value.includes('\n')) throw responseError(`${field.name} must have one value at line ${section.line}`);
    if (field.type === 'boolean') {
        if (!/^(true|false)$/i.test(value)) throw responseError(`${field.name} must be true or false at line ${section.line}`);
        return value.toLowerCase() === 'true';
    }
    if (field.type === 'number') {
        if (!value || !Number.isFinite(Number(value))) throw responseError(`${field.name} must be a finite number at line ${section.line}`);
        return Number(value);
    }
    return value;
}

function sectionsOf(text, known) {
    const sections = [];
    let current = null;
    let fence = null;
    for (const [index, line] of text.split('\n').entries()) {
        const marker = fenceOf(line);
        if (marker) {
            if (!fence) fence = marker;
            else if (closes(marker, fence)) fence = null;
        }
        const label = !fence && !marker ? heading(line) : null;
        const key = label && keyOf(label);
        if (key && known.has(key)) {
            current = { key, body: [], line: index + 1 };
            sections.push(current);
        } else {
            // Unknown headings belong to prose only; never swallow a misspelled scalar field.
            if (label && current && !known.get(current.key)?.prose) {
                throw responseError(`Unknown field ${label} at line ${index + 1}`);
            }
            if (current) current.body.push(line);
        }
    }
    if (fence && sections.length) throw responseError('Unclosed code fence in structured response');
    return sections.map(section => ({ ...section, body: section.body.join('\n') }));
}

export function parseJsonObject(source) {
    const text = String(source).trim();
    let value;
    try { value = JSON.parse(text); } catch {
        const blocks = [];
        let fence = null;
        let body = [];
        for (const line of text.split('\n')) {
            const marker = fenceOf(line);
            if (!fence && marker) { fence = marker; body = []; }
            else if (fence && closes(marker, fence)) {
                if (/^(json)?\s*$/i.test(fence[2])) blocks.push(body.join('\n'));
                fence = null;
            } else if (fence) body.push(line);
        }
        if (blocks.length === 1) {
            try { value = JSON.parse(blocks[0]); } catch { /* Report the contract failure below. */ }
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw responseError('Expected Markdown fields or one JSON object');
    return value;
}

function normalizeJson(input, fields, groups = []) {
    const output = {};
    for (const [key, value] of Object.entries(input)) {
        const group = groups.find(entry => keyOf(entry.collection) === keyOf(key));
        const field = fields.get(keyOf(key));
        const name = group?.collection || field?.name || key;
        const normalized = group && !group.keyed && Array.isArray(value)
            ? value.map(item => item && typeof item === 'object' && !Array.isArray(item) ? normalizeJson(item, group.fields) : item)
            : field?.normalizeJson && typeof value === 'string' ? scalar(value) : value;
        put(output, name, normalized, 'JSON response');
    }
    return output;
}

// Schema controls field types and repeated records; heading depth never controls scope.
// The return value has the same shape for Markdown and the legacy JSON fallback.
export function parseStructuredResponse(source, schema) {
    const text = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    const fields = fieldsOf(schema.fields);
    const groups = (schema.groups || []).map(group => ({ ...group, fields: fieldsOf(group.fields) }));
    const known = new Map([...fields, ...groups.flatMap(group => [...group.fields])]
        .map(([key, field]) => [key, { prose: field.type === 'text' }]));
    for (const group of groups) {
        known.set(keyOf(group.heading), {});
        known.set(keyOf(group.collection), {});
    }
    const sections = sectionsOf(unfence(text), known);
    if (!sections.length) return normalizeJson(parseJsonObject(text), fields, groups);
    const output = {};
    for (const group of groups) output[group.collection] = group.keyed ? {} : [];
    let active = null;
    let record = null;
    const finish = () => {
        if (!active) return;
        if (!record[active.identity]) throw responseError(`${active.heading} requires ${active.identity}`);
        if (active.keyed) {
            const { [active.identity]: id, ...value } = record;
            if (Object.hasOwn(output[active.collection], id)) throw responseError(`Duplicate ${active.heading}: ${id}`);
            put(output[active.collection], id, value, active.heading);
        }
    };
    for (const section of sections) {
        const group = groups.find(entry => keyOf(entry.heading) === section.key);
        const container = groups.find(entry => keyOf(entry.collection) === section.key);
        if (group || container) {
            finish();
            active = group || null;
            record = group ? {} : null;
            if (container && section.body.trim() && section.body.trim() !== '[]') throw responseError(`${container.collection} must contain repeated # ${container.heading} sections`);
            if (group) {
                if (section.body.trim()) put(record, group.identity, readValue(section, { name: group.identity, type: 'scalar' }), group.heading);
                if (!group.keyed) output[group.collection].push(record);
            }
            continue;
        }
        const local = active?.fields.get(section.key);
        const field = local || fields.get(section.key);
        if (!field) throw responseError(`Unexpected field at line ${section.line}; start its record first`);
        put(local ? record : output, field.name, readValue(section, field), `line ${section.line}`);
    }
    finish();
    return output;
}
