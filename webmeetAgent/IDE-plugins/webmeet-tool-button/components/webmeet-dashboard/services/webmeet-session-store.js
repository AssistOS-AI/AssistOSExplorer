const RESUME_KEY = 'webmeet.resume';

function getStorage() {
    try {
        if (globalThis.sessionStorage) {
            return globalThis.sessionStorage;
        }
    } catch (_) {
        // sessionStorage can be blocked in strict privacy modes; resume is best-effort.
    }
    return null;
}

function normalizeMedia(media = {}) {
    return {
        microphone: media?.microphone === true,
        camera: media?.camera === true
    };
}

export function readWebMeetResume() {
    const storage = getStorage();
    if (!storage) return null;
    try {
        const raw = storage.getItem(RESUME_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            open: parsed.open !== false,
            roomId: String(parsed.roomId || '').trim(),
            media: normalizeMedia(parsed.media)
        };
    } catch (_) {
        return null;
    }
}

export function writeWebMeetResume(partial = {}) {
    const storage = getStorage();
    if (!storage) return null;
    const current = readWebMeetResume() || {
        open: true,
        roomId: '',
        media: { microphone: false, camera: false }
    };
    const next = {
        open: partial.open === undefined ? current.open : Boolean(partial.open),
        roomId: partial.roomId === undefined ? current.roomId : String(partial.roomId || '').trim(),
        media: {
            microphone: partial.media?.microphone === undefined
                ? current.media.microphone
                : partial.media.microphone === true,
            camera: partial.media?.camera === undefined
                ? current.media.camera
                : partial.media.camera === true
        }
    };
    try {
        storage.setItem(RESUME_KEY, JSON.stringify(next));
    } catch (_) {
        return null;
    }
    return next;
}

export function clearWebMeetResume() {
    const storage = getStorage();
    if (!storage) return;
    try {
        storage.removeItem(RESUME_KEY);
    } catch (_) {
        // ignore storage failures
    }
}
