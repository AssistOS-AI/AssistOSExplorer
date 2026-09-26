import { fileURLToPath } from 'node:url';

import * as livekitAgents from '@livekit/agents';
import { RoomEvent } from '@livekit/rtc-node';

import { EncryptedSessionJournal } from '../lib/encrypted-journal.mjs';
import { HolisticMeetingNotesAnalyzer } from '../lib/holistic-analyzer.mjs';
import {
    bindJobToLiveKitWorkerTransport,
    LIVEKIT_WORKER_MAX_RETRY,
    resolveWorkerPort,
} from '../lib/runtime-config.mjs';
import { startRouterWebSocketAuthorityProxy } from '../lib/router-websocket-authority-proxy.mjs';
import {
    createMeetingAnalysisSnapshot,
    selectMeetingAnalysisTargetCount,
    selectMeetingMemoryCompaction,
} from '../lib/context-window.mjs';

const AGENT_NAME = String(process.env.WEBMEET_SCRIBE_AGENT_NAME || 'webmeet-meeting-secretary').trim();
const ANALYSIS_MS = Math.max(5, Number(process.env.WEBMEET_SCRIBE_ANALYSIS_SECONDS || 45)) * 1000;
const ANALYSIS_WORDS = Math.max(20, Number(process.env.WEBMEET_SCRIBE_ANALYSIS_WORDS || 300));
const EMPTY_GRACE_MS = Math.max(10, Number(process.env.WEBMEET_SCRIBE_EMPTY_GRACE_SECONDS || 120)) * 1000;
const HEARTBEAT_MS = 25_000;
const FINALIZED_RETENTION_MS = 15 * 60 * 1000;
const FAILED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RAW_CONTEXT_BYTES = Math.max(4_000, Number(process.env.WEBMEET_SCRIBE_MAX_RAW_CONTEXT_BYTES || 180_000));
const MAX_COMPACTION_BATCH_BYTES = Math.min(
    Math.max(1_000, Number(process.env.WEBMEET_SCRIBE_COMPACTION_BATCH_BYTES || 60_000)),
    MAX_RAW_CONTEXT_BYTES,
);
// The delegated MCP client has no deadline of its own.  In particular, a
// stuck task-status poll must not keep `analysisPromise` alive forever: that
// would prevent every later transcript checkpoint from being considered.
const MCP_CALL_TIMEOUT_MS = Math.max(
    5,
    Number(process.env.WEBMEET_SCRIBE_MCP_TIMEOUT_SECONDS || 30),
) * 1000;
const DOCUMENT_APPLY_RETRY_MS = Math.max(
    1,
    Number(process.env.WEBMEET_SCRIBE_DOCUMENT_APPLY_RETRY_SECONDS || 10),
) * 1000;
const ANALYSIS_RETRY_DELAYS_MS = Object.freeze([10_000, 30_000, 90_000]);
const MAX_ANALYSIS_RETRIES = Math.min(
    ANALYSIS_RETRY_DELAYS_MS.length,
    Math.max(0, Number(process.env.WEBMEET_SCRIBE_LLM_RETRY_COUNT || ANALYSIS_RETRY_DELAYS_MS.length)),
);

function isTransientAnalysisError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return /provider_(?:server_error|timeout)|\b(?:429|5\d\d)\b|rate.?limit|\b(?:fetch failed|network|socket|econnreset|econnrefused|enotfound|eai_again)\b/.test(message);
}

function retryDelayMs(retryCount) {
    return ANALYSIS_RETRY_DELAYS_MS[Math.max(0, Number(retryCount || 1) - 1)] || ANALYSIS_RETRY_DELAYS_MS.at(-1);
}

function withDeadline(operation, timeoutMs, description) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${description} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
    });
    return Promise.race([Promise.resolve().then(operation), timeout])
        .finally(() => clearTimeout(timer));
}

const livekitRouterProxy = await startRouterWebSocketAuthorityProxy();
process.env.LIVEKIT_URL = livekitRouterProxy.livekitUrl;
process.once('exit', () => void livekitRouterProxy.close());

function safeJson(value) {
    try { return JSON.parse(String(value || '')); } catch { return null; }
}

function jobMetadata(ctx) {
    return safeJson(ctx?.job?.metadata || ctx?.info?.job?.metadata || ctx?.info?.acceptArguments?.metadata) || {};
}

function mcpText(result) {
    return (result?.content || []).filter((entry) => entry?.type === 'text').map((entry) => entry.text).join('\n').trim();
}

function unwrapMcp(result, tool) {
    if (!Array.isArray(result?.content)) return result;
    const text = mcpText(result);
    if (result.isError) throw new Error(text || `${tool} failed.`);
    if (!text) return result;
    const parsed = safeJson(text);
    if (parsed?.ok === false) throw new Error(parsed?.error?.message || parsed?.message || `${tool} failed.`);
    return parsed ?? result;
}

async function createWebMeetClient() {
    const { createAgentClient } = await import('/Agent/client/AgentMcpClient.mjs');
    return createAgentClient('webmeetAgent');
}

function wordCount(segments) {
    return segments.reduce((sum, segment) => sum + String(segment.text || '').split(/\s+/).filter(Boolean).length, 0);
}

function isSecretaryParticipant(participant) {
    const attrs = participant?.attributes || {};
    return String(attrs.webmeetMeetingSecretary || '').toLowerCase() === 'true'
        || String(attrs.webmeetAgentType || attrs.agentType || '').toLowerCase() === 'meeting_secretary';
}

function canonicalParticipant(participant, participants) {
    const identity = String(participant?.identity || '').trim();
    return participants.find((entry) => String(entry.participantId) === identity) || null;
}

function parseTranscriptPayload(payload) {
    const parsed = safeJson(new TextDecoder().decode(payload));
    if (!parsed || parsed.protocol !== 'webmeet.scribe.transcript.v1') return null;
    const segmentId = String(parsed.segmentId || '').trim();
    const text = String(parsed.text || '').replace(/\s+/g, ' ').trim();
    if (!segmentId || !text || text.length > 12_000 || parsed.final !== true) return null;
    return {
        segmentId,
        sequence: Number(parsed.sequence || 0),
        text,
        language: String(parsed.language || ''),
        startedAt: String(parsed.startedAt || ''),
        endedAt: String(parsed.endedAt || new Date().toISOString()),
    };
}

function isMeetingNotesSettingsEvent(payload, meetingId) {
    const encoded = new TextDecoder().decode(payload).trim();
    const prefix = `${String(meetingId || '').trim()}:meeting_notes.settings_changed:`;
    return Boolean(prefix !== ':meeting_notes.settings_changed:' && encoded.startsWith(prefix));
}

export class MeetingSecretaryRuntime {
    constructor({ ctx, metadata, client, journal, analyzer }) {
        this.ctx = ctx;
        this.room = ctx.room;
        this.metadata = metadata;
        this.client = client;
        this.journal = journal;
        this.analyzer = analyzer;
        this.session = null;
        this.settings = null;
        this.participants = [];
        this.state = null;
        this.analysisTimer = null;
        this.analysisRetryTimer = null;
        this.documentApplyTimer = null;
        this.emptyTimer = null;
        this.heartbeatTimer = null;
        this.analysisPromise = null;
        this.activityPromise = Promise.resolve();
        this.activity = '';
        this.activityPendingCount = -1;
        this.finalized = false;
    }

    async call(tool, args, { timeoutMs = MCP_CALL_TIMEOUT_MS } = {}) {
        return unwrapMcp(await withDeadline(
            () => this.client.callTool(tool, args),
            timeoutMs,
            `Delegated ${tool} call`,
        ), tool);
    }

    async start() {
        const started = await this.call('webmeet_scribe_session_start', {
            roomId: this.metadata.meetingId,
            jobId: String(this.ctx?.job?.id || ''),
        });
        this.session = started.session;
        this.settings = started.settings || {};
        this.participants = started.participants || [];
        this.state = await this.journal.load(this.session.sessionId) || {
            version: 1,
            roomId: this.metadata.meetingId,
            sessionId: this.session.sessionId,
            segments: [],
            currentMarkdown: String(this.session.lastMarkdown || ''),
            analysisRevision: Number(this.session.analysisRevision || 0),
            analyzedSegmentCount: 0,
            lastAnalysisAttemptedSegmentCount: 0,
            compactedSegmentCount: 0,
            discussionMemory: '',
            createdAt: new Date().toISOString(),
        };
        this.state.lastAnalysisAttemptedSegmentCount = Math.max(
            Number(this.state.analyzedSegmentCount || 0),
            Math.min(
                this.state.segments.length,
                Number(this.state.lastAnalysisAttemptedSegmentCount ?? this.state.analyzedSegmentCount ?? 0),
            ),
        );
        // Releases checkpoints rejected by the removed lexical topic-window
        // validator. Their transcript is still intact and can be reconciled
        // normally after an upgraded worker starts.
        if (
            this.state.analysisRetry?.exhaustedAt
            && /omitted substantive topic window/i.test(String(this.state.analysisRetry.lastError || ''))
        ) {
            delete this.state.analysisRetry;
            this.state.lastAnalysisAttemptedSegmentCount = Number(this.state.analyzedSegmentCount || 0);
            await this.journal.save(this.session.sessionId, this.state);
        }
        this.onData = (payload, participant) => void this.handleData(payload, participant);
        this.onParticipantChange = () => {
            this.syncEmptyRoomTimer();
            void this.heartbeat();
        };
        this.room.on(RoomEvent.DataReceived, this.onData);
        this.room.on(RoomEvent.ParticipantConnected, this.onParticipantChange);
        this.room.on(RoomEvent.ParticipantDisconnected, this.onParticipantChange);
        this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
        this.syncEmptyRoomTimer();
        await this.publishActivity(this.pendingSegmentCount() > 0 ? 'queued' : 'listening');
        if (this.state.pendingApply) {
            this.schedulePendingDocumentApply(0);
        }
        if (this.state.analysisRetry && !this.state.analysisRetry.exhaustedAt) {
            this.scheduleAnalysisRetry();
        }
        this.schedulePendingAnalysis();
    }

    pendingSegmentCount() {
        return Math.max(0, this.state.segments.length - Number(this.state.analyzedSegmentCount || 0));
    }

    async publishActivity(activity) {
        const pendingSegmentCount = this.pendingSegmentCount();
        const publish = async () => {
            if (this.activity === activity && this.activityPendingCount === pendingSegmentCount) return;
            try {
                const result = await this.call('webmeet_scribe_session_heartbeat', {
                    roomId: this.metadata.meetingId,
                    sessionId: this.session.sessionId,
                    activity,
                    pendingSegmentCount,
                });
                this.activity = activity;
                this.activityPendingCount = pendingSegmentCount;
                this.session = result.session || this.session;
                this.participants = result.participants || this.participants;
                this.settings = result.settings || this.settings;
            } catch {
                // Activity is best-effort and must never block journal recovery or analysis.
            }
        };
        this.activityPromise = this.activityPromise.catch(() => {}).then(publish);
        return this.activityPromise;
    }

    async handleData(payload, participant) {
        if (this.finalized) return;
        if (isMeetingNotesSettingsEvent(payload, this.metadata.meetingId)) {
            await this.heartbeat();
            return;
        }
        const segment = parseTranscriptPayload(payload);
        const author = segment && canonicalParticipant(participant, this.participants);
        if (!segment || !author) return;
        if (this.state.segments.some((entry) => entry.segmentId === segment.segmentId)) return;
        this.state.segments.push({
            ...segment,
            participantId: author.participantId,
            displayName: author.displayName,
            receivedAt: new Date().toISOString(),
        });
        // New speech is an explicit recovery boundary after retry exhaustion:
        // a later complete revision may include both the failed checkpoint and
        // this new segment, but an exhausted checkpoint never loops forever.
        if (this.state.analysisRetry?.exhaustedAt) delete this.state.analysisRetry;
        this.state.updatedAt = new Date().toISOString();
        await this.journal.save(this.session.sessionId, this.state);
        const pending = this.state.segments.slice(this.state.analyzedSegmentCount || 0);
        await this.publishActivity('queued');
        if (wordCount(pending) >= ANALYSIS_WORDS) this.requestAnalysis();
        else this.scheduleAnalysis();
    }

    requestAnalysis(options = {}) {
        void this.analyze(options).catch(() => {});
    }

    scheduleAnalysis(delayMs = ANALYSIS_MS) {
        if (this.analysisTimer || this.finalized) return;
        this.analysisTimer = setTimeout(() => {
            this.analysisTimer = null;
            this.requestAnalysis();
        }, Math.max(0, delayMs));
    }

    schedulePendingAnalysis() {
        if (this.finalized || this.analysisPromise) return;
        if (this.state.pendingApply) {
            this.schedulePendingDocumentApply();
            return;
        }
        if (this.state.analysisRetry && !this.state.analysisRetry.exhaustedAt) {
            this.scheduleAnalysisRetry();
            return;
        }
        const pending = this.state.segments.slice(this.state.analyzedSegmentCount || 0);
        if (!pending.length) return;
        if (this.state.segments.length <= Number(this.state.lastAnalysisAttemptedSegmentCount || 0)) return;
        if (wordCount(pending) >= ANALYSIS_WORDS) queueMicrotask(() => this.requestAnalysis());
        else this.scheduleAnalysis();
    }

    scheduleAnalysisRetry(delayMs = null) {
        const retry = this.state?.analysisRetry;
        if (this.finalized || !retry || retry.exhaustedAt || this.analysisRetryTimer || this.analysisPromise) return;
        const nextAttemptAt = Date.parse(retry.nextAttemptAt || '');
        const scheduledDelay = delayMs == null
            ? (Number.isFinite(nextAttemptAt)
                ? Math.max(0, nextAttemptAt - Date.now())
                : retryDelayMs(Number(retry.retryCount || 0) + 1))
            : delayMs;
        this.analysisRetryTimer = setTimeout(() => {
            this.analysisRetryTimer = null;
            this.requestAnalysis({ retry: true });
        }, Math.max(0, scheduledDelay));
    }

    schedulePendingDocumentApply(delayMs = DOCUMENT_APPLY_RETRY_MS) {
        if (this.finalized || !this.state?.pendingApply || this.documentApplyTimer || this.analysisPromise) return;
        this.documentApplyTimer = setTimeout(() => {
            this.documentApplyTimer = null;
            void this.applyPendingDocument().catch(async (error) => {
                // This path is also used at worker startup to replay a durable
                // revision.  A failed replay must remain retryable even though
                // no LLM analysis is currently running to catch the error.
                await this.publishActivity('retrying');
                this.schedulePendingDocumentApply();
                console.error('[webmeet-scribe] Document apply failed; saved Markdown revision will retry without LLM:', String(error?.message || error));
            });
        }, Math.max(0, delayMs));
    }

    async applyPendingDocument() {
        const pending = this.state?.pendingApply;
        if (!pending) return null;
        await this.publishActivity('updating');
        const applied = await this.call('webmeet_scribe_notes_apply', {
            roomId: this.metadata.meetingId,
            sessionId: this.session.sessionId,
            analysisRevision: pending.revision,
            markdown: pending.markdown,
            ...(pending.baseStateBase64 ? { baseStateBase64: pending.baseStateBase64 } : {}),
        });
        this.state.currentMarkdown = String(applied.markdown || pending.markdown);
        this.state.analysisRevision = pending.revision;
        this.state.documentSnapshot = applied.documentSnapshot || this.state.documentSnapshot || null;
        this.state.analyzedSegmentCount = pending.targetSegmentCount;
        delete this.state.pendingApply;
        this.state.updatedAt = new Date().toISOString();
        await this.journal.save(this.session.sessionId, this.state);
        await this.publishActivity(this.pendingSegmentCount() > 0 ? 'queued' : 'listening');
        return this.state.currentMarkdown;
    }

    async prepareBoundedDiscussionContext(throughSegmentCount) {
        let targetSegmentCount = Math.min(this.state.segments.length, Number(throughSegmentCount || 0));
        const alreadyCompacted = Math.min(
            this.state.segments.length,
            Math.max(0, Number(this.state.compactedSegmentCount || 0)),
        );
        if (alreadyCompacted > 0 && String(this.state.discussionMemory || '').trim()) {
            this.pruneCompactedSegments(alreadyCompacted);
            targetSegmentCount = Math.max(0, targetSegmentCount - alreadyCompacted);
        }
        let selection = selectMeetingMemoryCompaction(this.state, {
            maxRawBytes: MAX_RAW_CONTEXT_BYTES,
            maxBatchBytes: MAX_COMPACTION_BATCH_BYTES,
            throughSegmentCount: Math.min(
                Number(this.state.analyzedSegmentCount || 0),
                targetSegmentCount,
            ),
        });
        while (selection) {
            const memory = await this.analyzer.compact({
                previousMemory: this.state.discussionMemory || '',
                segments: selection.segments,
                currentMarkdown: this.state.currentMarkdown,
                participants: this.participants,
            });
            if (!memory) throw new Error('Meeting memory compaction returned an empty result.');
            this.state.discussionMemory = memory;
            const consumedSegmentCount = selection.end;
            this.pruneCompactedSegments(consumedSegmentCount);
            targetSegmentCount = Math.max(0, targetSegmentCount - consumedSegmentCount);
            this.state.updatedAt = new Date().toISOString();
            await this.journal.save(this.session.sessionId, this.state);
            selection = selectMeetingMemoryCompaction(this.state, {
                maxRawBytes: MAX_RAW_CONTEXT_BYTES,
                maxBatchBytes: MAX_COMPACTION_BATCH_BYTES,
                throughSegmentCount: Math.min(
                    Number(this.state.analyzedSegmentCount || 0),
                    targetSegmentCount,
                ),
            });
        }
        return targetSegmentCount;
    }

    pruneCompactedSegments(count) {
        const consumed = Math.min(this.state.segments.length, Math.max(0, Number(count || 0)));
        if (!consumed) return;
        this.state.segments.splice(0, consumed);
        this.state.analyzedSegmentCount = Math.max(0, Number(this.state.analyzedSegmentCount || 0) - consumed);
        this.state.lastAnalysisAttemptedSegmentCount = Math.max(
            0,
            Number(this.state.lastAnalysisAttemptedSegmentCount || 0) - consumed,
        );
        this.state.compactedSegmentCount = 0;
    }

    async analyze({ force = false, retry = false } = {}) {
        if (this.analysisPromise) return this.analysisPromise;
        if (this.state.pendingApply) {
            this.schedulePendingDocumentApply(0);
            return null;
        }
        const retryPlan = retry ? this.state.analysisRetry : null;
        if (retry && (!retryPlan || retryPlan.exhaustedAt || !retryPlan.snapshot)) return null;
        if (!retry && this.state.analysisRetry && !this.state.analysisRetry.exhaustedAt) {
            this.scheduleAnalysisRetry();
            return null;
        }
        let attemptTargetSegmentCount = retry
            ? Number(retryPlan.snapshot.targetSegmentCount || 0)
            : this.state.segments.length;
        if (!force && (
            attemptTargetSegmentCount === Number(this.state.analyzedSegmentCount || 0)
            || (!retry && attemptTargetSegmentCount <= Number(this.state.lastAnalysisAttemptedSegmentCount || 0))
        )) return null;
        this.analysisPromise = (async () => {
            try {
                clearTimeout(this.analysisTimer);
                this.analysisTimer = null;
                clearTimeout(this.analysisRetryTimer);
                this.analysisRetryTimer = null;
                let snapshot = retryPlan?.snapshot || null;
                const active = await this.refreshSession({ includeDocumentSnapshot: !snapshot });
                if (!active) return null;
                if (!snapshot) {
                    // Persist a stable, encrypted request snapshot before LLM work.
                    // A transient provider failure retries this exact revision, not
                    // a moving transcript and not a freshly generated prompt.
                    attemptTargetSegmentCount = await this.prepareBoundedDiscussionContext(attemptTargetSegmentCount);
                    attemptTargetSegmentCount = selectMeetingAnalysisTargetCount(this.state, {
                        maxRawBytes: MAX_RAW_CONTEXT_BYTES,
                        requestedTargetCount: attemptTargetSegmentCount,
                    });
                    this.state.lastAnalysisAttemptedSegmentCount = attemptTargetSegmentCount;
                    snapshot = createMeetingAnalysisSnapshot(this.state, { targetSegmentCount: attemptTargetSegmentCount });
                    this.state.analysisRetry = {
                        snapshot,
                        retryCount: 0,
                        createdAt: new Date().toISOString(),
                    };
                    await this.journal.save(this.session.sessionId, this.state);
                }
                await this.publishActivity('analyzing');
                const markdown = await this.analyzer.analyze({
                    journal: snapshot.journal,
                    newSegmentIds: snapshot.newSegmentIds,
                    discussionMemory: snapshot.discussionMemory,
                    compactedSegmentCount: snapshot.compactedSegmentCount,
                    currentMarkdown: snapshot.currentMarkdown,
                    participants: structuredClone(this.participants),
                    structurePrompt: String(this.settings.structurePrompt || ''),
                });
                const revision = Number(this.state.analysisRevision || 0) + 1;
                // The LLM result is durable before any network hop. A transient
                // router/MCP failure must retry this exact document revision,
                // never regenerate it and never spend another model call.
                this.state.pendingApply = {
                    revision,
                    markdown,
                    baseStateBase64: String(snapshot.documentSnapshot?.stateBase64 || ''),
                    targetSegmentCount: snapshot.targetSegmentCount,
                    createdAt: new Date().toISOString(),
                };
                delete this.state.analysisRetry;
                await this.journal.save(this.session.sessionId, this.state);
                return await this.applyPendingDocument();
            } catch (error) {
                if (this.state.pendingApply) {
                    await this.publishActivity('retrying');
                    this.schedulePendingDocumentApply();
                    console.error('[webmeet-scribe] Document apply failed; saved Markdown revision will retry without LLM:', String(error?.message || error));
                } else if (this.state.analysisRetry && isTransientAnalysisError(error)) {
                    const retryState = this.state.analysisRetry;
                    retryState.retryCount = Number(retryState.retryCount || 0) + 1;
                    if (retryState.retryCount <= MAX_ANALYSIS_RETRIES) {
                        const delayMs = retryDelayMs(retryState.retryCount);
                        retryState.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
                        retryState.lastError = String(error?.message || error);
                        await this.journal.save(this.session.sessionId, this.state);
                        await this.publishActivity('retrying');
                        this.scheduleAnalysisRetry(delayMs);
                        console.error(`[webmeet-scribe] Meeting-notes provider failed; retry ${retryState.retryCount}/${MAX_ANALYSIS_RETRIES} in ${Math.ceil(delayMs / 1000)} seconds:`, retryState.lastError);
                    } else {
                        retryState.exhaustedAt = new Date().toISOString();
                        retryState.lastError = String(error?.message || error);
                        delete retryState.nextAttemptAt;
                        await this.journal.save(this.session.sessionId, this.state);
                        await this.publishActivity('waiting_for_new_speech');
                        console.error('[webmeet-scribe] Meeting-notes provider retries exhausted; waiting for new speech:', retryState.lastError);
                    }
                } else {
                    if (this.state.analysisRetry) {
                        this.state.analysisRetry.exhaustedAt = new Date().toISOString();
                        this.state.analysisRetry.lastError = String(error?.message || error);
                        delete this.state.analysisRetry.nextAttemptAt;
                        await this.journal.save(this.session.sessionId, this.state);
                    }
                    await this.publishActivity('waiting_for_new_speech');
                    console.error('[webmeet-scribe] Meeting notes analysis failed; pending transcript remains queued:', String(error?.message || error));
                }
                throw error;
            } finally {
                queueMicrotask(() => {
                    this.analysisPromise = null;
                    this.schedulePendingDocumentApply();
                    this.schedulePendingAnalysis();
                });
            }
        })();
        return this.analysisPromise;
    }

    async refreshSession({ includeDocumentSnapshot = false } = {}) {
        const result = await this.call('webmeet_scribe_session_heartbeat', {
            roomId: this.metadata.meetingId, sessionId: this.session.sessionId,
            ...(includeDocumentSnapshot ? { includeDocumentSnapshot: true } : {}),
        });
        this.participants = result.participants || this.participants;
        this.settings = result.settings || this.settings;
        if (result.documentSnapshot) {
            this.state.documentSnapshot = structuredClone(result.documentSnapshot);
            this.state.currentMarkdown = String(result.documentSnapshot.markdown || '');
        }
        if (result.reset === true) {
            this.finalized = true;
            delete this.state.pendingApply;
            delete this.state.analysisRetry;
            clearTimeout(this.analysisTimer);
            clearTimeout(this.analysisRetryTimer);
            clearTimeout(this.documentApplyTimer);
            await this.journal.remove(this.session.sessionId);
            await this.room.disconnect?.();
            return false;
        }
        if (this.settings.enabled === false) void this.finalize();
        return true;
    }

    async heartbeat() {
        if (this.finalized) return;
        try {
            await this.refreshSession();
        } catch {
            // The encrypted journal remains available for recovery for at most 24 hours.
        }
    }

    humanParticipantCount() {
        return [...(this.room.remoteParticipants?.values?.() || [])]
            .filter((participant) => !isSecretaryParticipant(participant)).length;
    }

    syncEmptyRoomTimer() {
        if (this.humanParticipantCount() > 0) {
            clearTimeout(this.emptyTimer);
            this.emptyTimer = null;
            return;
        }
        if (!this.emptyTimer && !this.finalized) {
            this.emptyTimer = setTimeout(() => {
                this.emptyTimer = null;
                void this.finalize();
            }, EMPTY_GRACE_MS);
        }
    }

    async finalize() {
        if (this.finalized) return;
        this.finalized = true;
        try {
            if (this.state.pendingApply) await this.applyPendingDocument();
            while (this.state.segments.length > Number(this.state.analyzedSegmentCount || 0)) {
                if (this.state.analysisRetry?.exhaustedAt) break;
                try {
                    await this.analyze({
                        force: true,
                        retry: Boolean(this.state.analysisRetry),
                    });
                } catch (error) {
                    if (this.state.analysisRetry?.exhaustedAt) break;
                    throw error;
                }
            }
            await this.call('webmeet_scribe_session_finalize', {
                roomId: this.metadata.meetingId, sessionId: this.session.sessionId,
            });
            this.state.finalizedAt = new Date().toISOString();
            await this.journal.save(this.session.sessionId, this.state);
            const removal = setTimeout(() => void this.journal.remove(this.session.sessionId), FINALIZED_RETENTION_MS);
            removal.unref?.();
            await this.room.disconnect?.();
        } catch {
            this.finalized = false;
            this.schedulePendingDocumentApply();
            this.schedulePendingAnalysis();
            this.syncEmptyRoomTimer();
        }
    }

    cleanup() {
        clearTimeout(this.analysisTimer);
        clearTimeout(this.analysisRetryTimer);
        clearTimeout(this.documentApplyTimer);
        clearTimeout(this.emptyTimer);
        clearInterval(this.heartbeatTimer);
        try { this.room.off?.(RoomEvent.DataReceived, this.onData); } catch {}
        try { this.room.off?.(RoomEvent.ParticipantConnected, this.onParticipantChange); } catch {}
        try { this.room.off?.(RoomEvent.ParticipantDisconnected, this.onParticipantChange); } catch {}
        this.analyzer.shutdown();
    }
}

export default livekitAgents.defineAgent({
    entry: async (ctx) => {
        const metadata = jobMetadata(ctx);
        if (!String(metadata.meetingId || '').trim()) throw new Error('Meeting Secretary dispatch is missing meetingId.');
        const journal = new EncryptedSessionJournal();
        await journal.purgeOlderThan(FAILED_RETENTION_MS);
        bindJobToLiveKitWorkerTransport(ctx);
        await ctx.connect();
        await ctx.room.localParticipant?.setAttributes?.({
            webmeetAgent: 'true',
            webmeetMeetingSecretary: 'true',
            webmeetAgentType: 'meeting_secretary',
            agentType: 'meeting_secretary',
            mode: 'cumulative_notes',
        });
        const runtime = new MeetingSecretaryRuntime({
            ctx, metadata, client: await createWebMeetClient(), journal, analyzer: new HolisticMeetingNotesAnalyzer(),
        });
        await runtime.start();
        await new Promise((resolve) => {
            ctx.room.once(RoomEvent.Disconnected, resolve);
            ctx.addShutdownCallback?.(resolve);
        });
        runtime.cleanup();
    },
});

const Options = livekitAgents.ServerOptions || livekitAgents.WorkerOptions;
const serverOptions = new Options({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    port: resolveWorkerPort(),
    logLevel: String(process.env.WEBMEET_SCRIBE_LOG_LEVEL || 'info'),
    maxRetry: LIVEKIT_WORKER_MAX_RETRY,
    requestFunc: async (request) => {
        const metadata = safeJson(request?.job?.metadata) || {};
        await request.accept('Meeting Secretary', `${AGENT_NAME}-${request.id}`, JSON.stringify({
            webmeetAgent: 'true', webmeetMeetingSecretary: 'true', webmeetAgentType: 'meeting_secretary',
        }), {
            webmeetAgent: 'true',
            webmeetMeetingSecretary: 'true',
            webmeetAgentType: 'meeting_secretary',
            agentType: 'meeting_secretary',
            mode: 'cumulative_notes',
            webmeetMeetingId: String(metadata.meetingId || ''),
        });
    },
});

if (process.argv.length < 3) process.argv.push('start');
livekitAgents.cli.runApp(serverOptions);
