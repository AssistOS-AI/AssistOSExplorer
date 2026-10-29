// Loads the shared conformance vectors and runs an implementation against them. A runner returns the list of failing
// vector ids, so a test can assert that the real implementation fails none and that a deliberately weakened one fails
// the vectors that are meant to catch the weakening.

import fs from 'node:fs';

const vectorUrl = (name) => new URL(`../vectors/${name}`, import.meta.url);

export function loadVectors(name) {
    return JSON.parse(fs.readFileSync(vectorUrl(name), 'utf8'));
}

// classify(name) returns { class, layer } or null; classifyPath(segments) returns { index, class } or null.
export function runNameVectors(vectors, { classify, classifyPath }) {
    const failures = [];
    for (const entry of vectors.names) {
        const got = classify(entry.name);
        const ok = entry.protected
            ? got !== null && got.class === entry.class && got.layer === entry.layer
            : got === null;
        if (!ok) failures.push(entry.id);
    }
    for (const entry of vectors.paths) {
        const got = classifyPath(entry.segments);
        const ok = entry.firstProtectedIndex === null
            ? got === null
            : got !== null && got.index === entry.firstProtectedIndex && got.class === entry.class;
        if (!ok) failures.push(entry.id);
    }
    return failures;
}

// One case per listed operation.
export function expandPolicyCases(vectors) {
    const cases = [];
    for (const entry of vectors.cases) {
        for (const op of entry.ops) {
            const input = { op };
            if (entry.names !== undefined) input.names = entry.names;
            if (entry.nodes !== undefined) input.nodes = entry.nodes;
            if (entry.movesDirectory !== undefined) input.movesDirectory = entry.movesDirectory;
            if (entry.hiddenDescendants !== undefined) input.hiddenDescendants = entry.hiddenDescendants;
            if (entry.attribute !== undefined) input.attribute = entry.attribute;
            cases.push({ id: `${entry.id}:${op}`, caseId: entry.id, input, options: entry.options ?? {}, expect: entry.expect });
        }
    }
    return cases;
}

export function runPolicyVectors(vectors, decide) {
    const failures = [];
    for (const entry of expandPolicyCases(vectors)) {
        let got;
        try {
            got = decide(structuredClone(entry.input), entry.options);
        } catch (error) {
            failures.push(`${entry.id} (threw ${error.message})`);
            continue;
        }
        const { outcome, code, postCheck, noDataIo } = entry.expect;
        const ok = got.outcome === outcome && got.code === code
            && (postCheck === undefined || got.postCheck === postCheck)
            && (noDataIo === undefined || got.noDataIo === noDataIo)
            && (outcome !== 'absent' || got.errnoHint === 'ENOENT');
        if (!ok) failures.push(entry.id);
    }
    return failures;
}
