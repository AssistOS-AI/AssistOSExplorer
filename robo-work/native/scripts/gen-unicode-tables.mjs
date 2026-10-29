// Generates the Unicode tables of the Rust protected-name fold, and its differential vectors, from the running Node's
// ICU. The fold is Ploinky's `foldPathName` (NFKC, toLowerCase, trailing dots and spaces stripped) as copied into
// robo-work/server/views/protectedNames.mjs, plus the default-ignorable hardening layer.
//
// Usage: node native/scripts/gen-unicode-tables.mjs <robo-work-dir> <tables.rs> <vectors.json>
//
// Requirement (review R4-4 item 4): the Rust fold must pin the Unicode version of the vectors. The vectors record
// Unicode 17.0 / ICU 78.2; this script refuses to run on another Unicode version. Rust std's own tables (used for
// to_lowercase) are Unicode 17.0.0 in Rust 1.99.1 (`char::UNICODE_VERSION`); the Rust tests check that too.
//
// Derivation (no UCD files are available offline; everything comes from ICU through standard JS APIs):
//   decomposition  NFKD of each code point (full, canonically ordered). Hangul syllables are algorithmic and omitted.
//   ccc            only its order matters for canonical ordering and for the composition "blocked" rule, so a RANK is
//                  derived: c has ccc > 0 iff NFD reorders it against U+0301 (ccc 230) or U+0334 (ccc 1); two marks
//                  are ordered by whether NFD swaps them. Ranks preserve the order and the zero/non-zero split.
//   composition    for each primary composite P (NFC(P) == P and NFD(P) has length >= 2): L = NFC(NFD(P) minus its last
//                  code point), C = that last code point, checked by NFC(L + C) == P. Any P that does not fit fails the run.
//   ignorable      /\p{Default_Ignorable_Code_Point}/u over every code point, as ranges.
// The Rust tests then compare every single code point against NFKC and toLowerCase from Node, and a seeded random
// corpus of multi-code-point strings against the Node fold, explicitly and through a hash.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [roboWork, tablesOut, vectorsOut] = process.argv.slice(2);
if (!roboWork || !tablesOut || !vectorsOut) throw new Error('usage: gen-unicode-tables.mjs <robo-work-dir> <tables.rs> <vectors.json>');
if (process.versions.unicode !== '17.0') throw new Error(`Unicode ${process.versions.unicode}: the vectors were generated with 17.0`);
const names = await import(pathToFileURL(path.join(roboWork, 'server/views/protectedNames.mjs')).href);

const MAX = 0x10FFFF;
const isSurrogate = (cp) => cp >= 0xD800 && cp <= 0xDFFF;
const S_BASE = 0xAC00, S_COUNT = 11172;
const isHangulSyllable = (cp) => cp >= S_BASE && cp < S_BASE + S_COUNT;
const str = (cp) => String.fromCodePoint(cp);
const cps = (text) => [...text].map((ch) => ch.codePointAt(0));
const nfd = (text) => text.normalize('NFD');

// ---- decomposition ---------------------------------------------------------------------------------------------------
const decomposition = [];
for (let cp = 0; cp <= MAX; cp += 1) {
    if (isSurrogate(cp) || isHangulSyllable(cp)) continue;
    const kd = str(cp).normalize('NFKD');
    if (kd !== str(cp)) decomposition.push([cp, cps(kd)]);
}

// ---- ccc rank --------------------------------------------------------------------------------------------------------
const stable = (cp) => { const s = str(cp); return s.normalize('NFKD') === s; };
const ACUTE = '\u0301';
const OVERLAY = '\u0334';
const marks = [];
for (let cp = 0; cp <= MAX; cp += 1) {
    if (isSurrogate(cp) || !stable(cp)) continue;
    const c = str(cp);
    if (nfd(ACUTE + c) === c + ACUTE || nfd(c + ACUTE) === ACUTE + c || nfd(c + OVERLAY) === OVERLAY + c) marks.push(cp);
}
const compareCcc = (x, y) => {
    if (x === y) return 0;
    const a = str(x), b = str(y);
    if (nfd(a + b) === b + a) return 1;
    if (nfd(b + a) === a + b) return -1;
    return 0;
};
const sortedMarks = [...marks].sort(compareCcc);
const rank = new Map();
let current = 0;
sortedMarks.forEach((cp, index) => {
    if (index === 0 || compareCcc(sortedMarks[index - 1], cp) !== 0) current += 1;
    rank.set(cp, current);
});
if (current > 255) throw new Error('too many ccc classes for u8');
// Consistency: the comparator must agree with the ranks on every pair of class representatives.
const reps = [];
sortedMarks.forEach((cp) => { if (!reps.length || rank.get(reps.at(-1)) !== rank.get(cp)) reps.push(cp); });
for (const x of reps) for (const y of reps) {
    const want = Math.sign(rank.get(x) - rank.get(y));
    if (compareCcc(x, y) !== want) throw new Error(`ccc rank inconsistent for ${x.toString(16)} ${y.toString(16)}`);
}

// ---- composition -----------------------------------------------------------------------------------------------------
const composition = [];
const failures = [];
for (let cp = 0; cp <= MAX; cp += 1) {
    if (isSurrogate(cp) || isHangulSyllable(cp)) continue;
    const s = str(cp);
    if (s.normalize('NFC') !== s) continue;
    const d = cps(nfd(s));
    if (d.length < 2) continue;
    const c = d.at(-1);
    const left = String.fromCodePoint(...d.slice(0, -1)).normalize('NFC');
    const leftCps = cps(left);
    if (leftCps.length !== 1 || (left + str(c)).normalize('NFC') !== s) { failures.push(cp.toString(16)); continue; }
    composition.push([leftCps[0], c, cp]);
}
if (failures.length) throw new Error(`composition derivation failed for: ${failures.join(' ')}`);
composition.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
for (let i = 1; i < composition.length; i += 1) {
    if (composition[i][0] === composition[i - 1][0] && composition[i][1] === composition[i - 1][1]) throw new Error('duplicate pair');
}

// ---- default ignorable -----------------------------------------------------------------------------------------------
const DI = /^\p{Default_Ignorable_Code_Point}$/u;
const ignorable = [];
for (let cp = 0; cp <= MAX; cp += 1) {
    if (isSurrogate(cp) || !DI.test(str(cp))) continue;
    const last = ignorable.at(-1);
    if (last && last[1] === cp - 1) last[1] = cp; else ignorable.push([cp, cp]);
}

// ---- emit Rust -------------------------------------------------------------------------------------------------------
const h = (cp) => `0x${cp.toString(16).toUpperCase()}`;
const decompIndex = [];
const decompData = [];
for (const [cp, list] of decomposition) {
    decompIndex.push(`(${h(cp)}, ${decompData.length}, ${list.length})`);
    decompData.push(...list);
}
const chunk = (items, per) => {
    const lines = [];
    for (let i = 0; i < items.length; i += per) lines.push(`    ${items.slice(i, i + per).join(', ')},`);
    return lines.join('\n');
};
const rust = `// @generated by native/scripts/gen-unicode-tables.mjs from Node ${process.version} (Unicode ${process.versions.unicode}, ICU ${process.versions.icu}).
// Do not edit by hand. Regenerate and review the diff. See fold.rs for how the tables are used.

/// The Unicode version these tables were derived from.
pub const UNICODE_VERSION: (u8, u8, u8) = (${process.versions.unicode.split('.').map(Number).concat([0]).slice(0, 3).join(', ')});
pub const ICU_VERSION: &str = "${process.versions.icu}";

/// (code point, offset into DECOMP_DATA, length): full NFKD of each non-Hangul code point whose NFKD differs.
pub static DECOMP_INDEX: [(u32, u32, u8); ${decompIndex.length}] = [
${chunk(decompIndex, 6)}
];
pub static DECOMP_DATA: [u32; ${decompData.length}] = [
${chunk(decompData.map(h), 12)}
];

/// (code point, rank) for every NFKD-stable code point with a non-zero canonical combining class. The rank preserves
/// the order of the classes (and nothing else).
pub static CCC_RANK: [(u32, u8); ${sortedMarks.length}] = [
${chunk([...marks].sort((a, b) => a - b).map((cp) => `(${h(cp)}, ${rank.get(cp)})`), 8)}
];

/// (starter, combining, primary composite), sorted by (starter, combining). Hangul is algorithmic.
pub static COMPOSE: [(u32, u32, u32); ${composition.length}] = [
${chunk(composition.map(([l, c, p]) => `(${h(l)}, ${h(c)}, ${h(p)})`), 5)}
];

/// Default_Ignorable_Code_Point ranges (inclusive).
pub static DEFAULT_IGNORABLE: [(u32, u32); ${ignorable.length}] = [
${chunk(ignorable.map(([lo, hi]) => `(${h(lo)}, ${h(hi)})`), 6)}
];
`;
fs.writeFileSync(tablesOut, rust);

// ---- differential vectors --------------------------------------------------------------------------------------------
const nfkcSingles = [];
const lowerSingles = [];
for (let cp = 0; cp <= MAX; cp += 1) {
    if (isSurrogate(cp)) continue;
    const s = str(cp);
    const k = s.normalize('NFKC');
    if (k !== s) nfkcSingles.push([cp, cps(k)]);
    const l = s.toLowerCase();
    if (l !== s) lowerSingles.push([cp, cps(l)]);
}

// Seeded corpus (mulberry32). The Rust test rebuilds the same strings from the same pools and seed.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0);
    };
}
const sample = (list, count, seed) => { const next = mulberry32(seed); const out = []; for (let i = 0; i < count; i += 1) out.push(list[next() % list.length]); return out; };
const composites = composition.map(([, , p]) => p);
const compat = decomposition.filter(([cp]) => str(cp).normalize('NFD') === str(cp)).map(([cp]) => cp);
const pools = [
    // tokens are arrays of code points
    ['.env', '.data', '.ploinky', '.ploinky-box', '.roboteam', 'master-key', '.secrets', 'x.secrets', 'env', 'data', '.', ' ', '..', '. '].map(cps),
    [...'abcdeiklnosyzAEIKLNOSZ.- '].map((ch) => [ch.codePointAt(0)]),
    marks.map((cp) => [cp]),
    sample(composites, 400, 7).map((cp) => [cp]),
    sample(compat, 400, 11).map((cp) => [cp]),
    [0x1100, 0x1101, 0x1112, 0x1161, 0x1162, 0x1175, 0x11A7, 0x11A8, 0x11C2, 0x11C3, 0xAC00, 0xAC01, 0xD7A3, 0xAE4C].map((cp) => [cp]),
    [0x3A3, 0x3C3, 0x3C2, 0x130, 0x131, 0x1E9E, 0x2126, 0x212A, 0x212B, 0x345, 0x307, 0x0027, 0x00AD, 0x2019].map((cp) => [cp]),
    ignorable.flatMap(([lo, hi]) => (hi - lo < 4 ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [lo, lo + 1, hi])).map((cp) => [cp]),
    [0xFF0E, 0xFF45, 0xFF4E, 0xFF56, 0x2024, 0x2025, 0xFE52, 0x1D41E, 0x24D4, 0x2170, 0xFB01, 0x3392, 0x2DA, 0x1E9B].map((cp) => [cp])
];
const SEED = 0x5EED2028;
function corpusString(next) {
    const tokens = 1 + (next() % 8);
    const out = [];
    for (let i = 0; i < tokens; i += 1) {
        const pool = pools[next() % pools.length];
        out.push(...pool[next() % pool.length]);
    }
    return out;
}
const fnvOffset = 0xcbf29ce484222325n;
const fnvPrime = 0x100000001b3n;
const mask = (1n << 64n) - 1n;
function fnvUpdate(hash, numbers) {
    for (const n of numbers) {
        for (let shift = 0; shift < 32; shift += 8) {
            hash ^= BigInt((n >>> shift) & 0xFF);
            hash = (hash * fnvPrime) & mask;
        }
    }
    return hash;
}
const classOf = (name, hardening) => {
    const verdict = names.classifyGrantName(name, { hardening });
    return verdict === null ? null : [verdict.class, verdict.layer];
};
const CLASS_CODE = { controller_state: 1, agent_data: 2, host_state: 3, private_session: 4, key_material: 5 };
const LAYER_CODE = { 'ploinky-fold': 1, 'default-ignorable': 2 };
const classCode = (verdict) => (verdict === null ? [0, 0] : [CLASS_CODE[verdict[0]], LAYER_CODE[verdict[1]]]);
const explicit = [];
const EXPLICIT = 3000;
const HASHED = 300000;
let hash = fnvOffset;
const next = mulberry32(SEED);
for (let i = 0; i < HASHED; i += 1) {
    const input = corpusString(next);
    const text = String.fromCodePoint(...input);
    const fold = cps(names.foldPathName(text));
    const stripped = cps(names.foldIgnorableStripped(text));
    const hard = classOf(text, true);
    const soft = classOf(text, false);
    hash = fnvUpdate(hash, [input.length, ...input, fold.length, ...fold, stripped.length, ...stripped, ...classCode(hard), ...classCode(soft)]);
    if (i < EXPLICIT) explicit.push({ input, fold, stripped, hard, soft });
}

const vectors = {
    schema: 'robo-work.native-unicode-diff/1',
    generatedBy: 'native/scripts/gen-unicode-tables.mjs',
    node: process.version, unicode: process.versions.unicode, icu: process.versions.icu,
    counts: { decomposition: decomposition.length, marks: marks.length, cccRanks: current, composition: composition.length, ignorableRanges: ignorable.length },
    nfkcSingles, lowerSingles,
    corpus: { seed: SEED, count: HASHED, explicitCount: EXPLICIT, fnv1a64: hash.toString(16).padStart(16, '0'), pools },
    explicit
};
fs.writeFileSync(vectorsOut, JSON.stringify(vectors));
console.log(JSON.stringify(vectors.counts), 'nfkcSingles', nfkcSingles.length, 'lowerSingles', lowerSingles.length, 'hash', vectors.corpus.fnv1a64);
