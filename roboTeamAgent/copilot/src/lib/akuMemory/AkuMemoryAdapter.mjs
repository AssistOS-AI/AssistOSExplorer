import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { analyzeAKUMemoryIntent } from './akuIntentAnalyzer.mjs';
import { buildAKUPlanningPacket } from './akuPlanningPacket.mjs';
import { applyAKUTypePolicyDefaults } from './akuTypePolicies.mjs';
import { createAKUSessionState } from './akuSessionState.mjs';
import { assertSafeAchillesPrivatePath, resolveAchillesPrivateDataRoot } from '../privateDataRoot.mjs';
import { resolveAlaInstallation } from '../alaInstallation.mjs';

const HIGH_IMPACT_OPERATIONS = new Set([
    'updateKUState',
    'setKUStatus',
    'discardKU',
    'deleteKU',
    'update_state',
    'set_status',
    'discard',
    'delete',
]);
const SENSITIVE_KEY_RE = /(secret|password|credential|token|private[_-]?key|api[_-]?key|hidden[_-]?reasoning|chain[_-]?of[_-]?thought|raw[_-]?prompt|private[_-]?prompt|content)$/i;
const CACHE_PROMPT_STOP_WORDS = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'can',
    'for',
    'from',
    'how',
    'i',
    'in',
    'is',
    'it',
    'me',
    'of',
    'on',
    'or',
    'please',
    'the',
    'this',
    'to',
    'was',
    'what',
    'when',
    'where',
    'who',
    'why',
    'with',
]);

export class AkuMemoryAdapter {
    constructor(options = {}) {
        this.rootDir = path.resolve(options.rootDir ?? options.workingDir ?? process.cwd());
        this.workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : null;
        this.privateDataRoot = resolveAchillesPrivateDataRoot(this.workspaceRoot ?? this.rootDir);
        this.storageEnvironment = process.env.ROBOTEAM_COPILOT_ROOT
            ? { ROBOTEAM_COPILOT_ROOT: this.privateDataRoot } : {};
        this.storageWorkspaceRoot = process.env.ROBOTEAM_COPILOT_ROOT
            ? this.workspaceRoot ?? this.rootDir : path.resolve(this.privateDataRoot, '..', '..');
        this.persistenceRoot = this.assertPersistenceRoot();
        this.actor = options.actor ?? 'achilles-cli';
        this.contextBudgetChars = options.contextBudgetChars ?? 5000;
        this.AgenticKnowledgeUnitsClass = options.AgenticKnowledgeUnitsClass ?? null;
        this.logger = options.logger ?? null;
        this.sessionState = options.sessionState && typeof options.sessionState.rememberActiveKU === 'function'
            ? options.sessionState
            : createAKUSessionState(options.sessionState ?? {});
        this.akuByRoot = new Map();
    }

    async preparePromptMemory(packetInput, options = {}) {
        const packet = typeof packetInput === 'string'
            ? buildAKUPlanningPacket({
                prompt: packetInput,
                workingDir: this.rootDir,
                workspaceRoot: this.workspaceRoot ?? this.rootDir,
                previousSessionState: this.sessionState.toJSON(),
            })
            : packetInput?.promptText || packetInput?.rawUserText
            ? packetInput
            : buildAKUPlanningPacket({
                ...packetInput,
                workingDir: packetInput?.workingDir ?? this.rootDir,
                workspaceRoot: packetInput?.workspaceRoot ?? this.workspaceRoot ?? this.rootDir,
                previousSessionState: packetInput?.previousSessionState ?? this.sessionState.toJSON(),
            });
        const intentPlan = options.intentPlan ?? analyzeAKUMemoryIntent(packet);
        const rootDir = this.resolveRootDir(packet, options);
        const aku = await this.getAKU(rootDir);
        const diagnostics = [];
        let exists = false;

        try {
            exists = await aku.exists();
        } catch (error) {
            diagnostics.push(`AKU exists() failed: ${error.message}`);
            return this.emptyPreflight({ packet, intentPlan, rootDir, diagnostics, enabled: false });
        }

        const output = {
            enabled: Boolean(exists || intentPlan.shouldUseAKU || options.enabled),
            initialized: exists,
            rootDir,
            packet,
            intentPlan,
            contextPack: null,
            candidates: [],
            activeScope: this.resolveActiveScope(packet, intentPlan),
            diagnostics,
        };

        if (!exists) {
            diagnostics.push(intentPlan.shouldInitializeAKU
                ? 'AKU is not initialized; durable memory action may initialize it later.'
                : 'AKU is not initialized; ordinary prompt execution can continue.');
            return output;
        }

        try {
            await aku.loadAKU();
            const query = buildSearchQuery(packet, intentPlan);
            const hasScopedSignal = Boolean(
                output.activeScope.activeKuId
                    || output.activeScope.explicitKuIds.length
                    || output.activeScope.folderPath,
            );
            const search = query
                ? await aku.search(query, {
                    explain: true,
                    limit: options.searchLimit ?? 8,
                    maxResultsPerKU: options.maxResultsPerKU ?? 3,
                })
                : { results: [] };
            output.candidates = search.results ?? [];
            output.contextPack = query
                ? hasScopedSignal
                    ? await aku.buildScopedContextPack(query, {
                        activeKuId: output.activeScope.activeKuId,
                        explicitKuIds: output.activeScope.explicitKuIds,
                        folderPath: output.activeScope.folderPath,
                        budgetChars: options.budgetChars ?? this.contextBudgetChars,
                        explain: true,
                        maxResultsPerKU: options.maxResultsPerKU ?? 3,
                    })
                    : await aku.buildContextPack(query, {
                        budgetChars: options.budgetChars ?? this.contextBudgetChars,
                        explain: true,
                        maxResultsPerKU: options.maxResultsPerKU ?? 3,
                    })
                : null;
        } catch (error) {
            diagnostics.push(`AKU preflight failed: ${error.message}`);
        }

        return output;
    }

    createActionSurface() {
        return {
            initializeAKU: (metadata) => this.initializeAKU(metadata),
            createKU: (metadata) => this.createKU(metadata),
            resolveKUCandidates: (query, options) => this.resolveKUCandidates(query, options),
            updateKUState: (kuId, update, options) => this.updateKUState(kuId, update, options),
            setKUStatus: (kuId, status, reason, options) => this.setKUStatus(kuId, status, reason, options),
            recordEvent: (kuId, event) => this.recordEvent(kuId, event),
            recordDocument: (kuId, document) => this.recordDocument(kuId, document),
            registerFile: (kuId, file) => this.registerFile(kuId, file),
            recordResult: (kuId, result) => this.recordResult(kuId, result),
            recordRun: (kuId, run) => this.recordRun(kuId, run),
            recordValidation: (kuId, validation) => this.recordValidation(kuId, validation),
            registerFolderScope: (kuId, folder) => this.registerFolderScope(kuId, folder),
            linkKU: (sourceKuId, targetKuId, link) => this.linkKU(sourceKuId, targetKuId, link),
            buildScopedContext: (query, options) => this.buildScopedContext(query, options),
            executeAction: (action, options) => this.executeAction(action, options),
            executeIntentPlan: (intentPlan, options) => this.executeIntentPlan(intentPlan, options),
        };
    }

    async executeAction(action = {}, options = {}) {
        const operation = String(action.operation ?? action.type ?? '').trim();
        if (!operation) {
            return { ok: false, error: 'Missing AKU memory action operation.' };
        }
        const disambiguation = this.checkMutationAmbiguity(operation, action, options);
        if (disambiguation) {
            return disambiguation;
        }

        try {
            switch (operation) {
                case 'initialize':
                case 'initAKU':
                    return { ok: true, result: await this.initializeAKU(action.metadata ?? action) };
                case 'create':
                case 'createKU':
                case 'initKU':
                    return { ok: true, result: await this.createKU(action.metadata ?? action) };
                case 'resolve':
                case 'search':
                    return { ok: true, result: await this.resolveKUCandidates(action.query ?? action.text ?? '', action.options ?? options) };
                case 'update':
                case 'update_state':
                case 'updateKUState':
                    return { ok: true, result: await this.updateKUState(action.kuId ?? action.ku_id, action.update ?? action, options) };
                case 'set_status':
                case 'setKUStatus':
                    return { ok: true, result: await this.setKUStatus(action.kuId ?? action.ku_id, action.status, action.reason, options) };
                case 'record_event':
                case 'recordEvent':
                    return { ok: true, result: await this.recordEvent(action.kuId ?? action.ku_id, action.event ?? action) };
                case 'record_document':
                case 'recordDocument':
                    return { ok: true, result: await this.recordDocument(action.kuId ?? action.ku_id, action.document ?? action) };
                case 'register_file':
                case 'registerFile':
                    return { ok: true, result: await this.registerFile(action.kuId ?? action.ku_id, action.file ?? action) };
                case 'record_result':
                case 'recordResult':
                    return { ok: true, result: await this.recordResult(action.kuId ?? action.ku_id, action.result ?? action) };
                case 'record_run':
                case 'recordRun':
                    return { ok: true, result: await this.recordRun(action.kuId ?? action.ku_id, action.run ?? action) };
                case 'record_validation':
                case 'recordValidation':
                    return { ok: true, result: await this.recordValidation(action.kuId ?? action.ku_id, action.validation ?? action) };
                case 'register_folder_scope':
                case 'registerFolderScope':
                    return { ok: true, result: await this.registerFolderScope(action.kuId ?? action.ku_id, action.folder ?? action) };
                case 'link':
                case 'linkKU':
                    return { ok: true, result: await this.linkKU(action.sourceKuId ?? action.source_ku_id, action.targetKuId ?? action.target_ku_id, action.link ?? action) };
                case 'build_scoped_context':
                case 'buildScopedContext':
                    return { ok: true, result: await this.buildScopedContext(action.query ?? '', action.options ?? options) };
                default:
                    return { ok: false, error: `Unsupported AKU memory action: ${operation}` };
            }
        } catch (error) {
            return {
                ok: false,
                error: error.message,
            };
        }
    }

    async executeIntentPlan(intentPlan = {}, options = {}) {
        if (intentPlan.ambiguity?.requiresDisambiguation) {
            return {
                ok: false,
                requiresDisambiguation: true,
                ambiguity: intentPlan.ambiguity,
            };
        }
        const durableUnits = Array.isArray(intentPlan.durableUnits) ? intentPlan.durableUnits : [];
        if (!durableUnits.length) {
            return { ok: true, createdKUs: [], links: [], folderScopes: [] };
        }

        await this.ensureInitialized(options.initMetadata);
        const createdKUs = [];
        const reusedKUs = [];
        const links = [];
        const folderScopes = [];
        let parent = null;

        for (const unit of durableUnits) {
            const metadata = this.metadataForDurableUnit(unit, parent);
            const existing = await this.findExistingDurableKU(unit, parent);
            const manifest = existing ?? await this.createKU(metadata);
            const created = {
                ...manifest,
                ku_name: manifest.ku_name ?? manifest.title ?? metadata.ku_name,
                ku_type: manifest.ku_type ?? manifest.type ?? metadata.ku_type,
                label: unit.label,
                scopeRole: unit.scopeRole ?? null,
                folderPath: unit.folderPath ?? null,
            };
            if (existing) {
                reusedKUs.push(created);
            } else {
                createdKUs.push(created);
            }

            if (unit.scopeRole === 'folder_scoped_parent') {
                parent = created;
                if (unit.folderPath) {
                    try {
                        folderScopes.push(await this.ensureFolderScopeRegistered(manifest.ku_id, {
                            path: unit.folderPath,
                            title: `Folder scope: ${unit.folderPath}`,
                            summary: `Folder scope for ${unit.label}`,
                            tags: ['folder-scope'],
                            keywords: [unit.folderPath, unit.label],
                        }));
                    } catch (error) {
                        folderScopes.push({
                            error: error.message,
                            path: unit.folderPath,
                            ku_id: manifest.ku_id,
                        });
                    }
                }
                this.sessionState.rememberActiveKU(created, {
                    scopeRole: unit.scopeRole,
                    folderPath: unit.folderPath,
                });
                continue;
            }

            if (parent) {
                links.push(await this.ensureKULink(parent.ku_id, manifest.ku_id, {
                    relation: 'contains',
                    title: `${parent.ku_name} contains ${created.ku_name}`,
                    summary: `${parent.ku_name} contains ${created.ku_name}`,
                    tags: ['contains'],
                    keywords: [manifest.ku_type, unit.label],
                }));
            }
            if (unit.ordinal) {
                this.sessionState.rememberOrdinal(`${unit.kuType} ${unit.ordinal}`, manifest.ku_id);
            }
        }

        const outcome = {
            ok: true,
            createdKUs,
            reusedKUs,
            links,
            folderScopes,
            activeKuId: parent?.ku_id ?? createdKUs.at(-1)?.ku_id ?? reusedKUs.at(-1)?.ku_id ?? null,
        };
        this.sessionState.updateFromActionOutcome(outcome);
        return outcome;
    }

    async initializeAKU(metadata = {}) {
        const aku = await this.getAKU();
        if (await aku.exists()) {
            return { alreadyExists: true };
        }
        assertSafePayload(metadata);
        return aku.initAKU({
            name: 'AchillesCLI AKU memory',
            ...metadata,
        });
    }

    async createKU(metadata = {}) {
        await this.ensureInitialized();
        assertSafePayload(metadata);
        const aku = await this.getAKU();
        const manifest = await aku.initKU(applyAKUTypePolicyDefaults({
            ku_name: metadata.ku_name ?? metadata.title ?? metadata.label ?? 'Knowledge Unit',
            summary: metadata.summary ?? '',
            ...metadata,
        }));
        this.sessionState.rememberActiveKU(manifest);
        return manifest;
    }

    async resolveKUCandidates(query, options = {}) {
        const aku = await this.getLoadedAKU();
        return aku.search(query, {
            explain: true,
            limit: options.limit ?? 8,
            ...options,
        });
    }

    async updateKUState(kuId, update = {}, options = {}) {
        const disambiguation = this.checkMutationAmbiguity('updateKUState', { kuId, update }, options);
        if (disambiguation) {
            return disambiguation;
        }
        assertSafePayload(update);
        const aku = await this.getLoadedAKU();
        return aku.updateKUState(kuId, update);
    }

    async setKUStatus(kuId, status, reason = '', options = {}) {
        const disambiguation = this.checkMutationAmbiguity('setKUStatus', { kuId, status, reason }, options);
        if (disambiguation) {
            return disambiguation;
        }
        const aku = await this.getLoadedAKU();
        return aku.setKUStatus(kuId, status, reason);
    }

    async recordEvent(kuId, event = {}) {
        assertSafePayload(event);
        const aku = await this.getLoadedAKU();
        return aku.recordEvent(kuId, event);
    }

    async recordDocument(kuId, document = {}) {
        assertSafePayload(document);
        const aku = await this.getLoadedAKU();
        return aku.recordDocument(kuId, document);
    }

    async registerFile(kuId, file = {}) {
        assertSafePayload(file);
        const aku = await this.getLoadedAKU();
        return aku.registerFile(kuId, file);
    }

    async recordResult(kuId, result = {}) {
        assertSafePayload(result);
        const aku = await this.getLoadedAKU();
        return aku.recordResult(kuId, result);
    }

    async recordRun(kuId, run = {}) {
        assertSafePayload(run);
        const aku = await this.getLoadedAKU();
        return aku.recordRun(kuId, run);
    }

    async recordValidation(kuId, validation = {}) {
        assertSafePayload(validation);
        const aku = await this.getLoadedAKU();
        return aku.recordValidation(kuId, validation);
    }

    async registerFolderScope(kuId, folder = {}) {
        assertSafePayload(folder);
        const aku = await this.getLoadedAKU();
        return aku.registerFolderScope(kuId, folder);
    }

    async linkKU(sourceKuId, targetKuId, link = {}) {
        assertSafePayload(link);
        const aku = await this.getLoadedAKU();
        return aku.linkKU(sourceKuId, targetKuId, link);
    }

    async findExistingDurableKU(unit = {}, parent = null) {
        const kuType = unit.kuType || unit.ku_type || 'knowledge_unit';
        const label = unit.label || unit.summary || kuType;
        const normalizedLabel = normalizeComparable(label);
        if (!normalizedLabel) {
            return null;
        }
        const aku = await this.getLoadedAKU();
        const records = await aku.listKUs({ kuType });
        const candidates = records.filter((record) => {
            if (parent && record.parent_ku_id !== parent.ku_id) {
                return false;
            }
            const title = record.ku_name ?? record.title ?? record.name;
            const titleMatches = normalizeComparable(title) === normalizedLabel;
            const keywordMatches = asArray(record.keywords).some((keyword) => normalizeComparable(keyword) === normalizedLabel);
            return titleMatches || keywordMatches;
        });
        return candidates
            .sort((a, b) => String(a.ku_id).localeCompare(String(b.ku_id)))[0] ?? null;
    }

    async ensureFolderScopeRegistered(kuId, folder = {}) {
        const aku = await this.getLoadedAKU();
        const expectedPath = normalizePathForCompare(folder.path);
        const existing = (await aku.listFolderScopes({ kuId }))
            .find((record) => normalizePathForCompare(record.path) === expectedPath);
        if (existing) {
            return { ...existing, reused: true };
        }
        return this.registerFolderScope(kuId, folder);
    }

    async ensureKULink(sourceKuId, targetKuId, link = {}) {
        const aku = await this.getLoadedAKU();
        const relation = String(link.relation ?? 'references').trim();
        const existing = (await aku.listKULinks(sourceKuId))
            .find((record) => record.target_ku_id === targetKuId && record.relation === relation);
        if (existing) {
            return { ...existing, reused: true };
        }
        return this.linkKU(sourceKuId, targetKuId, link);
    }

    async buildScopedContext(query, options = {}) {
        const aku = await this.getLoadedAKU();
        return aku.buildScopedContextPack(query, options);
    }

    async lookupCachedAgentResult({ prompt, backend, workingDir, ttlHintSeconds } = {}) {
        const normalized = normalizeAgentResultCacheInput({ prompt, backend, workingDir, ttlHintSeconds });
        if (!normalized.promptHash) {
            return { hit: false, reason: 'missing_cache_key' };
        }
        let aku;
        try {
            aku = await this.getLoadedAKU();
        } catch (error) {
            return { hit: false, reason: 'aku_unavailable', diagnostics: [error.message] };
        }

        const kuType = normalized.backend ? agentResultKuType(normalized.backend) : '';
        let records = [];
        try {
            records = await aku.listResults(kuType ? { kuType } : {});
        } catch (error) {
            return { hit: false, reason: 'lookup_failed', diagnostics: [error.message] };
        }

        const now = Date.now();
        const exact = records
            .filter((record) => agentResultRecordMatches(record, normalized, now, { requirePromptHash: true }))
            .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];
        if (exact) {
            const resolvedBackend = agentResultRecordBackend(exact) || normalized.backend;
            return {
                hit: true,
                backend: resolvedBackend,
                resultText: exact.metadata?.result_text || exact.summary || '',
                record: exact,
                provenance: 'aku-agent-result-cache',
            };
        }

        try {
            const search = await aku.search(normalized.query, {
                explain: true,
                limit: 8,
                recordTypes: ['result'],
                ...(kuType ? { kuTypes: [kuType] } : {}),
            });
            const candidate = (search.results || [])
                .find((record) => agentResultRecordMatches(record, normalized, now, { allowSimilarPrompt: true }));
            if (candidate) {
                const resolvedBackend = agentResultRecordBackend(candidate) || normalized.backend;
                return {
                    hit: true,
                    backend: resolvedBackend,
                    resultText: candidate.metadata?.result_text || candidate.summary || '',
                    record: candidate,
                    provenance: 'aku-agent-result-cache-search',
                };
            }
        } catch (error) {
            return { hit: false, reason: 'search_failed', diagnostics: [error.message] };
        }

        return { hit: false, reason: 'miss' };
    }

    async persistAgentResult({
        prompt,
        backend,
        resultText,
        workingDir,
        cacheable,
        ttlHintSeconds,
        originPaths = [],
        metadata = {},
    } = {}) {
        if (cacheable !== true) {
            return { ok: true, skipped: true, reason: 'not_cacheable' };
        }
        const normalized = normalizeAgentResultCacheInput({ prompt, backend, workingDir, ttlHintSeconds });
        if (!normalized.backend || !normalized.promptHash) {
            return { ok: false, error: 'Missing backend or prompt for cacheable agent result.' };
        }
        const safeResultText = String(resultText || '').trim();
        if (!safeResultText) {
            return { ok: false, error: 'Missing result text for cacheable agent result.' };
        }
        const kuType = agentResultKuType(normalized.backend);
        const safeMetadata = {
            ...metadata,
            prompt_hash: normalized.promptHash,
            prompt_preview: normalized.promptPreview,
            backend: normalized.backend,
            generated_at_iso: new Date().toISOString(),
            working_dir: normalized.workingDir,
            ttl_hint_seconds: normalized.ttlHintSeconds,
            origin_paths: uniqueStrings(originPaths),
            result_text: safeResultText,
        };
        assertSafePayload(safeMetadata);

        await this.ensureInitialized({
            name: 'AchillesCLI AKU memory',
            summary: 'Local memory used by AchillesCLI.',
        });
        const unit = {
            kuType,
            label: `Agent result cache: ${normalized.backend}`,
            summary: `Cached pure-information provider results for ${normalized.backend}.`,
        };
        const manifest = await this.findExistingDurableKU(unit)
            ?? await this.createKU({
                ku_name: unit.label,
                ku_type: kuType,
                summary: unit.summary,
                tags: ['agent-result-cache', normalized.backend],
                keywords: [normalized.backend, kuType],
            });
        const record = await this.recordResult(manifest.ku_id, {
            result_type: kuType,
            title: `Cached ${normalized.backend} result`,
            summary: safeResultText,
            status: 'active',
            tags: [
                'agent-result-cache',
                normalized.backend,
                `prompt:${normalized.promptHash}`,
                normalized.ttlHintSeconds ? `ttl:${normalized.ttlHintSeconds}` : null,
            ].filter(Boolean),
            keywords: [
                normalized.backend,
                normalized.promptHash,
                normalized.normalizedPrompt,
                normalized.workingDir,
                ...uniqueStrings(originPaths),
            ],
            metadata: safeMetadata,
        });
        return { ok: true, ku: manifest, record };
    }

    async recordAgentDurableOutcome({ backend, result, persistenceHint = {}, context = {} } = {}) {
        if (!persistenceHint || persistenceHint.record_result !== true) {
            return { ok: true, skipped: true, reason: 'no_durable_record_requested' };
        }
        const normalizedBackend = normalizeBackend(backend || result?.backend);
        const resultText = String(result?.result_text || result?.final_answer || result?.natural_language_output || '').trim();
        if (!normalizedBackend || !resultText) {
            return { ok: false, error: 'Missing backend or result text for durable provider outcome.' };
        }
        const kuType = normalizeKuType(persistenceHint.ku_type || 'code_work');
        await this.ensureInitialized({
            name: 'AchillesCLI AKU memory',
            summary: 'Local memory used by AchillesCLI.',
        });
        const unit = {
            kuType,
            label: `${normalizedBackend} provider outcomes`,
            summary: `Durable outcomes recorded from ${normalizedBackend}.`,
        };
        const manifest = await this.findExistingDurableKU(unit)
            ?? await this.createKU({
                ku_name: unit.label,
                ku_type: kuType,
                summary: unit.summary,
                tags: ['provider-outcome', normalizedBackend],
                keywords: [normalizedBackend, kuType],
            });
        const payload = {
            result_type: `${normalizedBackend}.outcome`,
            title: `${normalizedBackend} result`,
            summary: resultText,
            status: result?.ok === false ? 'blocked' : 'active',
            tags: ['provider-outcome', normalizedBackend],
            keywords: [normalizedBackend, kuType, String(context?.workingDir || '')].filter(Boolean),
            metadata: {
                backend: normalizedBackend,
                working_dir: String(context?.workingDir || ''),
                diagnostics: scrubAgentResultDiagnostics(result?.diagnostics),
            },
        };
        assertSafePayload(payload);
        const record = await this.recordResult(manifest.ku_id, payload);
        return { ok: true, ku: manifest, record };
    }

    async ensureInitialized(metadata = {}) {
        const aku = await this.getAKU();
        if (!(await aku.exists())) {
            await this.initializeAKU(metadata);
        } else {
            await aku.loadAKU();
        }
        return aku;
    }

    async getLoadedAKU(rootDir = this.rootDir) {
        const aku = await this.getAKU(rootDir);
        if (!(await aku.exists())) {
            throw new Error('AKU is not initialized.');
        }
        await aku.loadAKU();
        return aku;
    }

    async getAKU(rootDir = this.rootDir) {
        this.assertPersistenceRoot();
        const resolvedRoot = path.resolve(rootDir);
        if (this.akuByRoot.has(resolvedRoot)) {
            return this.akuByRoot.get(resolvedRoot);
        }
        const AgenticKnowledgeUnits = this.AgenticKnowledgeUnitsClass
            ?? await loadDefaultAgenticKnowledgeUnits();
        this.assertPersistenceRoot();
        const aku = new AgenticKnowledgeUnits({
            rootDir: resolvedRoot,
            persistenceRoot: this.persistenceRoot,
            actor: this.actor,
            contextBudgetChars: this.contextBudgetChars,
        });
        if (typeof aku.persistenceRoot !== 'string' || path.resolve(aku.persistenceRoot) !== this.persistenceRoot) {
            const error = new Error('AKU requires an AgenticKnowledgeUnits version supporting explicit persistenceRoot. '
                + 'Configure a compatible runtime package or ACHILLES_AGENT_LIB_DIR; no alternate storage root is allowed.');
            error.code = 'AKU_PERSISTENCE_ROOT_UNSUPPORTED';
            throw error;
        }
        this.akuByRoot.set(resolvedRoot, aku);
        return aku;
    }

    assertPersistenceRoot() {
        return assertSafeAchillesPrivatePath(this.storageWorkspaceRoot, 'aku', {
            env: this.storageEnvironment,
            privateDataRoot: this.privateDataRoot,
            label: 'AchillesCLI AKU persistence root',
            type: 'directory',
        });
    }

    resolveRootDir(packet, options = {}) {
        return path.resolve(
            options.rootDir
                ?? packet.workspaceRoot
                ?? packet.workingDir
                ?? this.workspaceRoot
                ?? this.rootDir,
        );
    }

    resolveActiveScope(packet, intentPlan) {
        const previous = packet.previousSessionState && typeof packet.previousSessionState === 'object'
            ? packet.previousSessionState
            : this.sessionState.toJSON();
        const activeKuId = previous.activeKuId ?? previous.active_ku_id ?? previous.activeScope?.kuId ?? null;
        const ordinalKuIds = resolveOrdinalLabelKuIds(previous, intentPlan, packet);
        const explicitKuIds = uniqueStrings([
            ...asArray(intentPlan.explicitKuIds),
            ...ordinalKuIds,
            ...asArray(previous.activeScope?.kuId),
        ]).filter((kuId) => kuId !== activeKuId);
        return {
            activeKuId,
            explicitKuIds,
            folderPath: packet.folderScopeHint?.path ?? previous.activeScope?.folderPath ?? null,
        };
    }

    metadataForDurableUnit(unit, parent) {
        const kuType = unit.kuType || unit.ku_type || 'knowledge_unit';
        const name = unit.label || unit.summary || kuType;
        return applyAKUTypePolicyDefaults({
            ku_name: name,
            ku_type: kuType,
            summary: unit.summary || `Durable ${kuType}: ${name}`,
            parent_ku_id: parent?.ku_id ?? null,
            tags: [
                unit.scopeRole === 'folder_scoped_parent' ? 'folder-scope' : null,
                unit.ordinal ? `ordinal-${unit.ordinal}` : null,
            ].filter(Boolean),
            keywords: [
                name,
                unit.folderPath,
                unit.ordinal ? `${kuType} ${unit.ordinal}` : null,
            ].filter(Boolean),
            source_operation: 'achilles_cli_memory_action',
        });
    }

    emptyPreflight({ packet, intentPlan, rootDir, diagnostics, enabled }) {
        return {
            enabled,
            initialized: false,
            rootDir,
            packet,
            intentPlan,
            contextPack: null,
            candidates: [],
            activeScope: this.resolveActiveScope(packet, intentPlan),
            diagnostics,
        };
    }

    checkMutationAmbiguity(operation, action = {}, options = {}) {
        if (!HIGH_IMPACT_OPERATIONS.has(operation)) {
            return null;
        }
        if (options.intentPlan?.ambiguity?.requiresDisambiguation) {
            return {
                ok: false,
                requiresDisambiguation: true,
                ambiguity: options.intentPlan.ambiguity,
            };
        }
        const kuId = action.kuId ?? action.ku_id;
        const targetCount = asArray(action.candidateKuIds ?? action.candidate_ku_ids).length;
        if (!kuId && targetCount !== 1) {
            return {
                ok: false,
                requiresDisambiguation: true,
                ambiguity: {
                    requiresDisambiguation: true,
                    impact: 'high',
                    reason: 'Mutation action requires one resolved Knowledge Unit target.',
                },
            };
        }
        return null;
    }
}

export async function loadDefaultAgenticKnowledgeUnits() {
    const explicit = String(process.env.ACHILLES_AGENT_LIB_DIR || '').trim();
    let modulePath = explicit
        ? path.join(fs.realpathSync(path.resolve(explicit)), 'AgenticKnowledgeUnits', 'index.mjs')
        : null;
    if (!modulePath) {
        for (const name of ['achillesAgentLib/AgenticKnowledgeUnits', 'ploinky-agent-lib/AgenticKnowledgeUnits']) {
            try { modulePath = createRequire(import.meta.url).resolve(name); break; }
            catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
        }
    }
    if (!modulePath) {
        const { packageRoot } = await resolveAlaInstallation();
        modulePath = createRequire(path.join(packageRoot, 'package.json')).resolve('ploinky-agent-lib/AgenticKnowledgeUnits');
    }
    const { AgenticKnowledgeUnits } = await import(pathToFileURL(modulePath).href);
    if (typeof AgenticKnowledgeUnits !== 'function') throw new Error('The runtime dependency does not export AgenticKnowledgeUnits.');
    return AgenticKnowledgeUnits;
}

export function buildSearchQuery(packet, intentPlan) {
    return uniqueStrings([
        packet.rawUserText,
        packet.promptText,
        ...asArray(intentPlan.readQueries).map((query) => query.query),
        ...asArray(intentPlan.ordinalLabels).map((label) => label.raw || label.label),
        ...asArray(intentPlan.durableUnits).map((unit) => `${unit.label} ${unit.kuType}`),
        ...asArray(packet.pathReferences).map((reference) => `${reference.label ?? ''} ${reference.path}`),
        packet.folderScopeHint?.path,
    ]).join('\n');
}

export function assertSafePayload(value, pathParts = []) {
    if (value === undefined || value === null) {
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertSafePayload(item, [...pathParts, String(index)]));
        return;
    }
    if (typeof value !== 'object') {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            throw new Error(`Refusing to persist sensitive AKU field: ${[...pathParts, key].join('.')}`);
        }
        assertSafePayload(child, [...pathParts, key]);
    }
}


function asArray(value) {
    if (value === undefined || value === null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values = []) {
    return [...new Set(values
        .map((value) => String(value ?? '').trim())
        .filter(Boolean))];
}

function resolveOrdinalLabelKuIds(previous = {}, intentPlan = {}, packet = {}) {
    const ordinalLabels = previous.ordinalLabels ?? previous.ordinal_labels ?? {};
    if (!ordinalLabels || typeof ordinalLabels !== 'object' || Array.isArray(ordinalLabels)) {
        return [];
    }
    const requestedLabels = new Set();
    for (const label of asArray(intentPlan.ordinalLabels)) {
        requestedLabels.add(normalizeComparable(label.label));
        requestedLabels.add(normalizeComparable(label.raw));
    }
    const promptText = normalizeComparable(`${packet.rawUserText ?? ''} ${packet.promptText ?? ''}`);
    const matches = [];
    for (const [label, kuId] of Object.entries(ordinalLabels)) {
        const normalizedLabel = normalizeComparable(label);
        if (!normalizedLabel || !kuId) {
            continue;
        }
        if (requestedLabels.has(normalizedLabel) || promptText.includes(normalizedLabel)) {
            matches.push(kuId);
        }
    }
    return matches;
}

function normalizeComparable(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ');
}

function normalizePathForCompare(value) {
    return String(value ?? '')
        .trim()
        .replace(/\\+/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
}

function normalizeAgentResultCacheInput({ prompt, backend, workingDir, ttlHintSeconds } = {}) {
    const normalizedPrompt = normalizePromptForCache(prompt);
    const normalizedBackend = normalizeBackend(backend);
    const normalizedWorkingDir = String(workingDir || '').trim();
    return {
        backend: normalizedBackend,
        normalizedPrompt,
        promptHash: normalizedPrompt ? sha256(normalizedPrompt) : '',
        promptPreview: normalizedPrompt.slice(0, 500),
        workingDir: normalizedWorkingDir,
        ttlHintSeconds: Number.isFinite(Number(ttlHintSeconds)) && Number(ttlHintSeconds) > 0
            ? Math.floor(Number(ttlHintSeconds))
            : null,
        query: uniqueStrings([normalizedBackend, normalizedPrompt]).join('\n'),
    };
}

function normalizePromptForCache(prompt) {
    return String(prompt || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function normalizeBackend(value) {
    return String(value || '')
        .trim()
        .replace(/^@+/, '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function normalizeKuType(value) {
    return String(value || 'knowledge_unit')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '') || 'knowledge_unit';
}

function agentResultKuType(backend) {
    return `agent.result.${normalizeBackend(backend)}`;
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function agentResultRecordMatches(record, normalized, nowMs, options = {}) {
    const metadata = record?.metadata && typeof record.metadata === 'object' ? record.metadata : {};
    const tags = asArray(record?.tags).map((tag) => String(tag || '').trim());
    const keywords = asArray(record?.keywords).map((keyword) => String(keyword || '').trim());
    if (!isAgentResultCacheRecord(record, tags)) {
        return false;
    }
    const resolvedBackend = agentResultRecordBackend(record, { metadata, tags, keywords });
    const backendMatches = normalized.backend
        ? resolvedBackend === normalized.backend
        || tags.includes(normalized.backend)
        || keywords.includes(normalized.backend)
        || String(record?.ku_type || record?.result_type || '').endsWith(`.${normalized.backend}`)
        : Boolean(resolvedBackend);
    if (!backendMatches) return false;
    const promptMatches = metadata.prompt_hash === normalized.promptHash
        || tags.includes(`prompt:${normalized.promptHash}`)
        || keywords.includes(normalized.promptHash);
    const recordWorkingDir = String(metadata.working_dir || '').trim();
    const workingDirMatches = recordWorkingDir
        ? recordWorkingDir === normalized.workingDir
        : keywords.includes(normalized.workingDir);
    if (!workingDirMatches) return false;
    const ttlTag = tags
        .map((tag) => /^ttl:(\d+)$/.exec(tag))
        .find(Boolean)?.[1];
    const ttl = Number(metadata.ttl_hint_seconds ?? ttlTag ?? normalized.ttlHintSeconds);
    if (Number.isFinite(ttl) && ttl > 0) {
        const generatedAt = Date.parse(metadata.generated_at_iso || record.updated_at || record.created_at || '');
        if (Number.isFinite(generatedAt) && nowMs - generatedAt > ttl * 1000) {
            return false;
        }
    }
    if (options.requirePromptHash || !options.allowSimilarPrompt || promptMatches) {
        return promptMatches;
    }
    return similarPromptMatches(record, normalized, metadata, tags, keywords);
}

function isAgentResultCacheRecord(record, tags = asArray(record?.tags).map((tag) => String(tag || '').trim())) {
    return tags.includes('agent-result-cache')
        || String(record?.ku_type || '').startsWith('agent.result.')
        || String(record?.result_type || '').startsWith('agent.result.');
}

function agentResultRecordBackend(record, cached = {}) {
    const metadata = cached.metadata || (record?.metadata && typeof record.metadata === 'object' ? record.metadata : {});
    const tags = cached.tags || asArray(record?.tags).map((tag) => String(tag || '').trim());
    const keywords = cached.keywords || asArray(record?.keywords).map((keyword) => String(keyword || '').trim());
    const metadataBackend = normalizeBackend(metadata.backend);
    if (metadataBackend) return metadataBackend;
    for (const value of [record?.ku_type, record?.result_type, record?.type]) {
        const text = String(value || '').trim();
        const match = /^agent\.result\.([a-z0-9_-]+)$/i.exec(text);
        if (match) return normalizeBackend(match[1]);
    }
    for (const value of [...tags, ...keywords]) {
        const normalized = normalizeBackend(value);
        if (normalized && normalized !== 'agent-result-cache' && !normalized.startsWith('prompt-') && !normalized.startsWith('ttl-')) {
            return normalized;
        }
    }
    return '';
}

function similarPromptMatches(record, normalized, metadata, tags, keywords) {
    const queryTerms = promptCacheTerms(normalized.normalizedPrompt);
    if (!queryTerms.length) {
        return false;
    }
    const recordTerms = promptCacheTerms([
        metadata.prompt_preview,
        metadata.prompt_text,
        metadata.normalized_prompt,
        record?.title,
        ...keywords,
        ...tags.filter((tag) => !tag.startsWith('prompt:') && !tag.startsWith('ttl:')),
    ].join(' '));
    if (!recordTerms.length) {
        return false;
    }
    let overlap = 0;
    for (const term of queryTerms) {
        if (recordTerms.includes(term)) {
            overlap += 1;
        }
    }
    if (queryTerms.length === 1) {
        return overlap === 1 && Number(record?.score ?? 0) >= 0.45;
    }
    return overlap >= 2 && overlap / queryTerms.length >= 0.6;
}

function promptCacheTerms(text) {
    return uniqueStrings(String(text || '')
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g) || [])
        .filter((term) => !CACHE_PROMPT_STOP_WORDS.has(term));
}

function scrubAgentResultDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
        return {};
    }
    const safe = {};
    for (const [key, value] of Object.entries(diagnostics)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            continue;
        }
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
            safe[key] = value;
        }
    }
    return safe;
}

export default AkuMemoryAdapter;
