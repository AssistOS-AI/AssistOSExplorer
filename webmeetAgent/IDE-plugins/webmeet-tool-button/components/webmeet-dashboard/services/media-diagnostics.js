const MEDIA_DIAGNOSTIC_PREFIX = '[webmeet:media]';

function normalizeDebugFlag(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'debug'].includes(normalized);
}

export function isMediaDiagnosticsEnabled() {
    try {
        if (globalThis.WEBMEET_MEDIA_DEBUG === true) return true;
        if (normalizeDebugFlag(globalThis.WEBMEET_MEDIA_DEBUG)) return true;
        if (normalizeDebugFlag(globalThis.localStorage?.getItem?.('WEBMEET_MEDIA_DEBUG'))) return true;
        const href = String(globalThis.location?.href || '');
        if (!href) return false;
        const url = new URL(href);
        if (normalizeDebugFlag(url.searchParams.get('webmeetMediaDebug'))) return true;
        return normalizeDebugFlag(url.hash.match(/webmeetMediaDebug=([^&]+)/)?.[1]);
    } catch (_) {
        return false;
    }
}

function safeString(value, maxLength = 160) {
    const text = String(value ?? '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
}

function summarizeTrackSettings(mediaStreamTrack) {
    try {
        const settings = mediaStreamTrack?.getSettings?.() || {};
        return {
            width: settings.width,
            height: settings.height,
            frameRate: settings.frameRate,
            deviceId: settings.deviceId ? '<redacted>' : undefined,
            displaySurface: settings.displaySurface
        };
    } catch (_) {
        return {};
    }
}

export function summarizeTrack(track) {
    const mediaStreamTrack = track?.mediaStreamTrack || track || null;
    if (!mediaStreamTrack) return null;
    return {
        sid: safeString(track?.sid || track?.trackSid || ''),
        kind: safeString(track?.kind || mediaStreamTrack.kind || ''),
        source: safeString(track?.source || ''),
        readyState: safeString(mediaStreamTrack.readyState || ''),
        muted: Boolean(mediaStreamTrack.muted),
        enabled: Boolean(mediaStreamTrack.enabled),
        settings: summarizeTrackSettings(mediaStreamTrack)
    };
}

export function summarizePublication(publication) {
    if (!publication) return null;
    return {
        sid: safeString(publication.trackSid || publication.sid || ''),
        name: safeString(publication.trackName || publication.name || ''),
        kind: safeString(publication.kind || publication.track?.kind || ''),
        source: safeString(publication.source || ''),
        isMuted: Boolean(publication.isMuted),
        isSubscribed: Boolean(publication.isSubscribed),
        hasTrack: Boolean(publication.track),
        track: summarizeTrack(publication.track)
    };
}

export function summarizeParticipant(participant) {
    if (!participant) return null;
    return {
        identity: safeString(participant.identity || ''),
        name: safeString(participant.name || ''),
        trackPublicationCount: Number(participant.trackPublications?.size || 0)
    };
}

export function summarizeVideoElement(videoElement) {
    if (!videoElement) return null;
    const tracks = [];
    try {
        for (const track of videoElement.srcObject?.getTracks?.() || []) {
            tracks.push(summarizeTrack(track));
        }
    } catch (_) {
        // ignore inaccessible media stream state
    }
    return {
        isConnected: Boolean(videoElement.isConnected),
        readyState: Number(videoElement.readyState || 0),
        paused: Boolean(videoElement.paused),
        ended: Boolean(videoElement.ended),
        currentTime: Number(videoElement.currentTime || 0),
        videoWidth: Number(videoElement.videoWidth || 0),
        videoHeight: Number(videoElement.videoHeight || 0),
        muted: Boolean(videoElement.muted),
        srcObjectTrackCount: tracks.length,
        tracks
    };
}

function roundedNumber(value, decimals = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    const factor = 10 ** decimals;
    return Math.round(number * factor) / factor;
}

export function summarizeAudioMetrics(metrics = {}) {
    return {
        rmsDb: roundedNumber(metrics.rmsDb),
        peakDb: roundedNumber(metrics.peakDb),
        noiseFloorDb: roundedNumber(metrics.noiseFloorDb),
        clipping: Boolean(metrics.clipping),
        speaking: Boolean(metrics.speaking),
        humFrequency: ['50', '60'].includes(String(metrics.humFrequency)) ? String(metrics.humFrequency) : 'off',
        adaptiveGain: roundedNumber(metrics.adaptiveGain, 2),
        mode: safeString(metrics.mode || ''),
        health: safeString(metrics.health || '')
    };
}

export function summarizeAudioWebRtcStats(stats = []) {
    const summary = {
        inboundAudioStreams: 0,
        outboundAudioStreams: 0,
        jitterMs: undefined,
        packetsLost: 0,
        concealedSamples: 0,
        roundTripTimeMs: undefined
    };
    for (const item of stats || []) {
        const report = Array.isArray(item) && item.length === 2 ? item[1] : item;
        if (!report || report.kind !== 'audio') continue;
        if (report.type === 'inbound-rtp') {
            summary.inboundAudioStreams += 1;
            summary.packetsLost += Number(report.packetsLost || 0);
            summary.concealedSamples += Number(report.concealedSamples || 0);
            const jitterMs = Number(report.jitter) * 1000;
            if (Number.isFinite(jitterMs)) {
                summary.jitterMs = Math.max(summary.jitterMs || 0, jitterMs);
            }
        }
        if (report.type === 'outbound-rtp') {
            summary.outboundAudioStreams += 1;
        }
        if (report.type === 'remote-inbound-rtp') {
            const rttMs = Number(report.roundTripTime) * 1000;
            if (Number.isFinite(rttMs)) {
                summary.roundTripTimeMs = Math.max(summary.roundTripTimeMs || 0, rttMs);
            }
        }
    }
    summary.jitterMs = roundedNumber(summary.jitterMs);
    summary.roundTripTimeMs = roundedNumber(summary.roundTripTimeMs);
    return summary;
}

export function summarizeAudioSettings(settings = {}) {
    return {
        profile: safeString(settings.profile || ''),
        voiceProcessingMode: safeString(settings.voiceProcessingMode || ''),
        humFilter: safeString(settings.humFilter || ''),
        microphoneGain: roundedNumber(settings.microphoneGain, 2),
        outputVolume: roundedNumber(settings.outputVolume, 2),
        automaticParticipantVolume: settings.automaticParticipantVolume !== false,
        echoCancellation: settings.echoCancellation !== false,
        noiseSuppression: settings.noiseSuppression !== false,
        autoGainControl: settings.autoGainControl === true,
        voiceIsolation: settings.voiceIsolation === true
    };
}

const RELAY_CANDIDATE_TYPES = new Set(['relay']);

export function summarizeIceTransport(stats = []) {
    const byId = new Map();
    const reports = [];
    for (const item of stats || []) {
        const report = Array.isArray(item) && item.length === 2 ? item[1] : item;
        if (!report || typeof report !== 'object') continue;
        reports.push(report);
        if (report.id) byId.set(report.id, report);
    }
    const summary = {
        iceState: undefined,
        dtlsState: undefined,
        selected: 'unknown',
        localCandidateType: undefined,
        remoteCandidateType: undefined,
        protocol: undefined,
        relay: false
    };
    for (const report of reports) {
        if (report.type === 'transport') {
            if (report.iceState) summary.iceState = safeString(report.iceState);
            if (report.dtlsState) summary.dtlsState = safeString(report.dtlsState);
        }
    }
    let selectedPair = null;
    for (const report of reports) {
        if (report.type !== 'candidate-pair') continue;
        if (report.state !== 'succeeded') continue;
        if (report.nominated === false) continue;
        selectedPair = report;
        if (report.nominated === true) break;
    }
    if (selectedPair) {
        const local = byId.get(selectedPair.localCandidateId) || null;
        const remote = byId.get(selectedPair.remoteCandidateId) || null;
        summary.localCandidateType = safeString(local?.candidateType || '');
        summary.remoteCandidateType = safeString(remote?.candidateType || '');
        summary.protocol = safeString(local?.protocol || remote?.protocol || '');
        summary.relay = RELAY_CANDIDATE_TYPES.has(summary.localCandidateType)
            || RELAY_CANDIDATE_TYPES.has(summary.remoteCandidateType);
        summary.selected = summary.relay ? 'relay' : 'direct';
    }
    return summary;
}

function redactSensitive(value) {
    if (Array.isArray(value)) {
        return value.map((item) => redactSensitive(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase();
        if (
            normalizedKey.includes('token')
            || normalizedKey.includes('secret')
            || normalizedKey.includes('password')
            || normalizedKey.includes('authorization')
            || normalizedKey.includes('credential')
            || normalizedKey === 'sdp'
            || normalizedKey === 'candidate'
        ) {
            output[key] = '<redacted>';
            continue;
        }
        output[key] = redactSensitive(item);
    }
    return output;
}

export function logMediaDiagnostic(event, payload = {}) {
    if (!isMediaDiagnosticsEnabled()) return;
    try {
        const consoleRef = globalThis.console || null;
        const logger = typeof consoleRef?.info === 'function' ? consoleRef.info : consoleRef?.log;
        if (typeof logger !== 'function') return;
        logger.call(consoleRef, MEDIA_DIAGNOSTIC_PREFIX, event, redactSensitive(payload));
    } catch (_) {
        // diagnostics must not affect meeting behavior
    }
}
