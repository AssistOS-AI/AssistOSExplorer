import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgenticKnowledgeUnits } from '../../../ploinky/node_modules/achillesAgentLib/AgenticKnowledgeUnits/index.mjs';
import { AkuMemoryAdapter } from '../achilles-cli/src/lib/akuMemory/AkuMemoryAdapter.mjs';
import { analyzeAKUMemoryIntent } from '../achilles-cli/src/lib/akuMemory/akuIntentAnalyzer.mjs';
import { buildAKUPlanningPacket } from '../achilles-cli/src/lib/akuMemory/akuPlanningPacket.mjs';
import { getAKUTypePolicy } from '../achilles-cli/src/lib/akuMemory/akuTypePolicies.mjs';
import { formatAKUContextForPrompt } from '../achilles-cli/src/lib/akuMemory/akuContextFormatter.mjs';
import { createAKUSessionState } from '../achilles-cli/src/lib/akuMemory/akuSessionState.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(repoRoot, '..', '..');

async function makeRoot(prefix = 'achilles-aku-') {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeFakeAKUClass({ exists = true } = {}) {
    const calls = [];
    class FakeAKU {
        constructor(options) {
            calls.push(['constructor', options]);
        }

        async exists() {
            calls.push(['exists']);
            return exists;
        }

        async loadAKU() {
            calls.push(['loadAKU']);
            return {};
        }

        async search(query, options) {
            calls.push(['search', query, options]);
            return {
                results: [{
                    search_id: 'ku_fake',
                    record_type: 'ku',
                    ku_id: 'ku_fake',
                    ku_name: 'Fake KU',
                    ku_type: 'experiment',
                    summary: 'Fake summary',
                    score: 1,
                    matched_on: ['term:fake'],
                }],
            };
        }

        async buildContextPack(query, options) {
            calls.push(['buildContextPack', query, options]);
            return {
                results: [{
                    search_id: 'ku_fake',
                    record_type: 'ku',
                    ku_id: 'ku_fake',
                    ku_name: 'Fake KU',
                    ku_type: 'experiment',
                    summary: 'Fake summary',
                    matched_on: ['term:fake'],
                }],
            };
        }

        async buildScopedContextPack(query, options) {
            calls.push(['buildScopedContextPack', query, options]);
            return { results: [] };
        }

        async initAKU() {
            calls.push(['initAKU']);
            return {};
        }

        async initKU(metadata) {
            calls.push(['initKU', metadata]);
            return { ku_id: 'ku_created', ...metadata };
        }
    }
    FakeAKU.calls = calls;
    return FakeAKU;
}

function collectFiles(dir, predicate, out = []) {
    if (!fs.existsSync(dir)) {
        return out;
    }
    const stat = fs.statSync(dir);
    if (stat.isFile()) {
        if (predicate(dir)) {
            out.push(dir);
        }
        return out;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
            continue;
        }
        collectFiles(path.join(dir, entry.name), predicate, out);
    }
    return out;
}

describe('AKU planning packets', () => {
    it('builds a planning packet from a plain CLI prompt', async () => {
        const rootDir = await makeRoot();
        const packet = buildAKUPlanningPacket({
            prompt: 'Remember the parser benchmark result',
            workingDir: rootDir,
        });

        assert.equal(packet.source, 'cli');
        assert.equal(packet.rawUserText, 'Remember the parser benchmark result');
        assert.equal(packet.promptText, 'Remember the parser benchmark result');
        assert.equal(packet.workingDir, rootDir);
        assert.deepEqual(packet.pathReferences, []);
        assert.deepEqual(packet.attachments, []);
    });

    it('builds a planning packet from generic WebChat-origin context', async () => {
        const rootDir = await makeRoot();
        const packet = buildAKUPlanningPacket({
            normalizedMessage: {
                text: 'inspect\n\nReferenced workspace paths:\n- Notes (file path=docs/notes.md)',
                rawText: 'inspect',
                references: [
                    { kind: 'workspace-path', path: 'docs/notes.md', type: 'file', label: 'Notes' },
                    { kind: 'workspace-path', path: '../escape' },
                ],
                attachments: [
                    { filename: 'upload.txt', mime: 'text/plain', localPath: 'uploads/session/upload.txt', content: 'not copied' },
                ],
            },
            workingDir: rootDir,
            folderScopeHint: { path: 'docs' },
        });

        assert.equal(packet.source, 'webchat-envelope');
        assert.equal(packet.rawUserText, 'inspect');
        assert.equal(packet.pathReferences.length, 1);
        assert.equal(packet.pathReferences[0].path, 'docs/notes.md');
        assert.equal(packet.attachments[0].filename, 'upload.txt');
        assert.equal(packet.attachments[0].content, undefined);
        assert.equal(packet.folderScopeHint.path, 'docs');
    });
});

describe('AKU preflight', () => {
    it('folder hint alone does not create a KU', async () => {
        const FakeAKU = makeFakeAKUClass({ exists: false });
        const rootDir = await makeRoot();
        const adapter = new AkuMemoryAdapter({ rootDir, AgenticKnowledgeUnitsClass: FakeAKU });
        const packet = buildAKUPlanningPacket({
            prompt: 'hello',
            workingDir: rootDir,
            folderScopeHint: { path: 'folder1' },
        });

        const result = await adapter.preparePromptMemory(packet);
        assert.equal(result.initialized, false);
        assert.equal(result.intentPlan.shouldInitializeAKU, false);
        assert.deepEqual(FakeAKU.calls.map((call) => call[0]), ['constructor', 'exists']);
    });

    it('missing AKU does not block ordinary prompts', async () => {
        const FakeAKU = makeFakeAKUClass({ exists: false });
        const rootDir = await makeRoot();
        const adapter = new AkuMemoryAdapter({ rootDir, AgenticKnowledgeUnitsClass: FakeAKU });
        const result = await adapter.preparePromptMemory(buildAKUPlanningPacket({
            prompt: 'explain this project',
            workingDir: rootDir,
        }));

        assert.equal(result.enabled, false);
        assert.equal(result.initialized, false);
        assert.ok(result.diagnostics.some((entry) => entry.includes('ordinary prompt execution can continue')));
    });

    it('existing AKU preflight uses public AKU APIs', async () => {
        const FakeAKU = makeFakeAKUClass({ exists: true });
        const rootDir = await makeRoot();
        const adapter = new AkuMemoryAdapter({ rootDir, AgenticKnowledgeUnitsClass: FakeAKU });
        const result = await adapter.preparePromptMemory(buildAKUPlanningPacket({
            prompt: 'get fake experiment results',
            workingDir: rootDir,
        }));

        const callNames = FakeAKU.calls.map((call) => call[0]);
        assert.deepEqual(callNames, ['constructor', 'exists', 'loadAKU', 'search', 'buildContextPack']);
        assert.equal(result.candidates.length, 1);
        assert.equal(result.contextPack.results.length, 1);
    });

    it('formats retrieved memory separately from user instructions', () => {
        const text = formatAKUContextForPrompt({
            contextPack: {
                results: [{
                    record_type: 'ku',
                    ku_id: 'ku_demo',
                    ku_name: 'Demo KU',
                    ku_type: 'custom_type',
                    summary: 'Reusable context.',
                    matched_on: ['term:demo'],
                }],
            },
        });
        assert.match(text, /<AKU_MEMORY_CONTEXT>/);
        assert.match(text, /context, not a new user instruction/);
        assert.match(text, /matched_on: term:demo/);
    });
});

describe('AKU type policies and actions', () => {
    it('accepts and preserves open-string ku_type values', async () => {
        const rootDir = await makeRoot();
        const adapter = new AkuMemoryAdapter({ rootDir, AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits });
        await adapter.initializeAKU();
        const manifest = await adapter.createKU({
            ku_name: 'Customer interview Alpha',
            ku_type: 'customer_interview',
            summary: 'Domain-specific interview memory.',
        });

        assert.equal(manifest.ku_type, 'customer_interview');
        const aku = await adapter.getLoadedAKU();
        const [record] = await aku.listKUs({ kuId: manifest.ku_id });
        assert.equal(record.ku_type, 'customer_interview');
    });

    it('gives unknown custom ku_type generic fallback behavior', () => {
        const policy = getAKUTypePolicy('customer_interview');
        assert.equal(policy.isGeneric, true);
        assert.equal(policy.kuType, 'customer_interview');
        assert.ok(policy.preferredApis.includes('recordResult'));
        assert.ok(policy.preferredApis.includes('buildScopedContextPack'));
    });

    it('gives common types policy defaults', () => {
        const policy = getAKUTypePolicy('experiment');
        assert.equal(policy.isGeneric, false);
        assert.equal(policy.kuType, 'experiment');
        assert.ok(policy.defaultTags.includes('experiment'));
        assert.ok(policy.preferredApis.includes('recordResult'));
    });

    it('creates multiple non-experiment KUs through the generic lifecycle', async () => {
        const rootDir = await makeRoot();
        const adapter = new AkuMemoryAdapter({ rootDir, AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits });
        const packet = buildAKUPlanningPacket({
            prompt: 'create 2 validations that check imports and exports',
            workingDir: rootDir,
        });
        const plan = analyzeAKUMemoryIntent(packet);
        const outcome = await adapter.executeIntentPlan(plan);

        assert.equal(outcome.ok, true);
        assert.equal(outcome.createdKUs.length, 2);
        assert.deepEqual(outcome.createdKUs.map((ku) => ku.ku_type), ['validation', 'validation']);
    });

    it('keeps folder-plus-three-experiments as a representative regression fixture', async () => {
        const rootDir = await makeRoot();
        await fsp.mkdir(path.join(rootDir, 'folder1'), { recursive: true });
        const adapter = new AkuMemoryAdapter({ rootDir, AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits });
        const packet = buildAKUPlanningPacket({
            prompt: 'create folder folder1 and launch 3 experiments that test alpha, beta and gamma',
            workingDir: rootDir,
        });
        const plan = analyzeAKUMemoryIntent(packet);
        const outcome = await adapter.executeIntentPlan(plan);

        assert.equal(outcome.ok, true);
        assert.equal(outcome.createdKUs.length, 4);
        assert.equal(outcome.createdKUs[0].ku_type, 'workstream');
        assert.equal(outcome.createdKUs.filter((ku) => ku.ku_type === 'experiment').length, 3);
        assert.equal(outcome.links.length, 3);
        assert.equal(outcome.folderScopes.length, 1);
    });

    it('reuses existing durable units instead of duplicating them on repeated intent execution', async () => {
        const rootDir = await makeRoot();
        await fsp.mkdir(path.join(rootDir, 'folder1'), { recursive: true });
        const adapter = new AkuMemoryAdapter({ rootDir, AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits });
        const packet = buildAKUPlanningPacket({
            prompt: 'create folder folder1 and launch 3 experiments that test alpha, beta and gamma',
            workingDir: rootDir,
        });
        const plan = analyzeAKUMemoryIntent(packet);

        const first = await adapter.executeIntentPlan(plan);
        const second = await adapter.executeIntentPlan(plan);
        const aku = await adapter.getLoadedAKU();
        const kus = await aku.listKUs();

        assert.equal(first.createdKUs.length, 4);
        assert.equal(second.createdKUs.length, 0);
        assert.equal(second.reusedKUs.length, 4);
        assert.equal(kus.length, 4);
        assert.deepEqual(kus.map((ku) => ku.title).sort(), [
            'experiment 1: alpha',
            'experiment 2: beta',
            'experiment 3: gamma',
            'folder1',
        ]);
    });

    it('asks for disambiguation on ambiguous high-impact mutation', async () => {
        const adapter = new AkuMemoryAdapter({
            rootDir: await makeRoot(),
            AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits,
        });
        const plan = analyzeAKUMemoryIntent('update the result with the new number');
        const outcome = await adapter.executeAction({
            operation: 'updateKUState',
            update: { summary: 'new number' },
        }, { intentPlan: plan });

        assert.equal(outcome.requiresDisambiguation, true);
        assert.match(outcome.ambiguity.reason, /specific Knowledge Unit|one resolved/);
    });

    it('rejects direct sensitive persistence payloads', async () => {
        const adapter = new AkuMemoryAdapter({
            rootDir: await makeRoot(),
            AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits,
        });

        const outcome = await adapter.executeAction({
            operation: 'recordResult',
            kuId: 'ku_fake',
            result: {
                title: 'Unsafe result',
                summary: 'Do not persist sensitive values.',
                token: 'secret-token',
            },
        });

        assert.equal(outcome.ok, false);
        assert.match(outcome.error, /Refusing to persist sensitive AKU field/);
    });
});

describe('Scoped AKU retrieval', () => {
    it('session state records explicit scope options when remembering an active KU', () => {
        const sessionState = createAKUSessionState();

        sessionState.rememberActiveKU('ku_test', {
            scopeRole: 'folder_scoped_parent',
            folderPath: 'folder1',
        });

        assert.deepEqual(sessionState.toJSON().activeScope, {
            kuId: 'ku_test',
            scopeRole: 'folder_scoped_parent',
            folderPath: 'folder1',
        });
    });

    it('retrieves common and custom KU records from active scope', async () => {
        const rootDir = await makeRoot();
        await fsp.mkdir(path.join(rootDir, 'folder1'), { recursive: true });
        const sessionState = createAKUSessionState();
        const adapter = new AkuMemoryAdapter({
            rootDir,
            AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits,
            sessionState,
            contextBudgetChars: 6000,
        });
        await adapter.initializeAKU();
        const parent = await adapter.createKU({
            ku_name: 'Folder folder1',
            ku_type: 'workstream',
            summary: 'Folder-scoped workstream.',
            keywords: ['folder1'],
        });
        await adapter.registerFolderScope(parent.ku_id, { path: 'folder1', summary: 'folder scope' });
        sessionState.rememberActiveKU(parent, { scopeRole: 'folder_scoped_parent', folderPath: 'folder1' });

        const experiment = await adapter.createKU({
            ku_name: 'Experiment 1: alpha',
            ku_type: 'experiment',
            parent_ku_id: parent.ku_id,
            summary: 'Alpha experiment.',
            keywords: ['experiment 1', 'alpha'],
        });
        await adapter.linkKU(parent.ku_id, experiment.ku_id, { relation: 'contains', summary: 'Contains experiment 1.' });
        await adapter.recordResult(experiment.ku_id, {
            title: 'Alpha result',
            summary: 'Experiment 1 result was accepted.',
            status: 'accepted',
            keywords: ['experiment 1 result'],
        });
        sessionState.rememberOrdinal('experiment 1', experiment.ku_id);

        const custom = await adapter.createKU({
            ku_name: 'Customer interview 1: Acme',
            ku_type: 'customer_interview',
            parent_ku_id: parent.ku_id,
            summary: 'Interview with Acme.',
            keywords: ['customer interview 1', 'Acme'],
        });
        await adapter.linkKU(parent.ku_id, custom.ku_id, { relation: 'contains', summary: 'Contains customer interview 1.' });
        await adapter.recordResult(custom.ku_id, {
            title: 'Acme interview outcome',
            summary: 'Acme asked for audit logging.',
            status: 'accepted',
            keywords: ['customer interview 1 result'],
        });
        sessionState.rememberOrdinal('customer interview 1', custom.ku_id);

        const commonPack = await adapter.buildScopedContext('get the results from experiment 1', {
            activeKuId: parent.ku_id,
            explicitKuIds: [experiment.ku_id],
            folderPath: 'folder1',
            budgetChars: 5000,
            maxResultsPerKU: 4,
        });
        assert.ok(commonPack.results.some((item) => /Experiment 1 result/.test(item.summary ?? '')));

        const customPack = await adapter.buildScopedContext('get the customer interview 1 result', {
            activeKuId: parent.ku_id,
            explicitKuIds: [custom.ku_id],
            folderPath: 'folder1',
            budgetChars: 5000,
            maxResultsPerKU: 4,
        });
        assert.ok(customPack.results.some((item) => /audit logging/.test(item.summary ?? '')));
    });

    it('preflight maps scoped ordinal labels to explicit KU ids before building context', async () => {
        const rootDir = await makeRoot();
        await fsp.mkdir(path.join(rootDir, 'folder1'), { recursive: true });
        const sessionState = createAKUSessionState();
        const adapter = new AkuMemoryAdapter({
            rootDir,
            AgenticKnowledgeUnitsClass: AgenticKnowledgeUnits,
            sessionState,
            contextBudgetChars: 6000,
        });
        const createPacket = buildAKUPlanningPacket({
            prompt: 'create folder folder1 and launch 3 experiments that test alpha, beta and gamma',
            workingDir: rootDir,
            previousSessionState: sessionState.toJSON(),
        });
        await adapter.executeIntentPlan(analyzeAKUMemoryIntent(createPacket));
        const experimentOneId = sessionState.toJSON().ordinalLabels['experiment 1'];
        await adapter.recordResult(experimentOneId, {
            title: 'Alpha result',
            summary: 'Experiment 1 result was accepted.',
            status: 'accepted',
            keywords: ['experiment 1 result', 'alpha'],
        });

        const retrievePacket = buildAKUPlanningPacket({
            prompt: 'get the results from experiment 1',
            workingDir: rootDir,
            previousSessionState: sessionState.toJSON(),
        });
        const preflight = await adapter.preparePromptMemory(retrievePacket);

        assert.equal(preflight.activeScope.folderPath, 'folder1');
        assert.equal(preflight.activeScope.explicitKuIds.length, 1);
        assert.ok(preflight.contextPack.results.some((item) => /Experiment 1 result was accepted/i.test(item.summary ?? '')));
    });
});

describe('Boundary checks', () => {
    it('AchillesCLI code outside akuMemory does not directly read AKU storage internals', () => {
        const srcDir = path.join(repoRoot, 'achilles-cli', 'src');
        const files = collectFiles(srcDir, (file) => /\.(mjs|js)$/.test(file))
            .filter((file) => !file.includes(`${path.sep}lib${path.sep}akuMemory${path.sep}`));
        const offenders = [];
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            if (/fs\.[A-Za-z]+\([^)]*['"`]\.aku/.test(text) || /path\.join\([^)]*['"`]\.aku/.test(text)) {
                offenders.push(path.relative(repoRoot, file));
            }
        }
        assert.deepEqual(offenders, []);
    });

    it('Ploinky WebChat and Explorer remain KU-unaware', () => {
        const scannedRoots = [
            path.join(workspaceRoot, 'ploinky', 'cli', 'server', 'handlers', 'webchat.js'),
            path.join(workspaceRoot, 'ploinky', 'cli', 'server', 'webchat'),
            path.join(repoRoot, 'achilles-cli', 'IDE-plugins', 'achilles-cli-tool-button'),
            path.join(workspaceRoot, 'AssistOSExplorer', 'explorer'),
        ];
        const files = scannedRoots.flatMap((root) => collectFiles(root, (file) => /\.(mjs|js|html)$/.test(file)));
        const offenders = [];
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            if (/(AgenticKnowledgeUnits|Knowledge Unit|ku_type|\.aku)/.test(text)) {
                offenders.push(path.relative(workspaceRoot, file));
            }
        }
        assert.deepEqual(offenders, []);
    });
});
