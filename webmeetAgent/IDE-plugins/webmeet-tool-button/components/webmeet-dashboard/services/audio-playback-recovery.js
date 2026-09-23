export function collectAudioElements(root) {
    if (!root?.querySelectorAll) return [];
    return Array.from(root.querySelectorAll('audio'));
}

export async function recoverMediaElementPlayback(elements = []) {
    const playable = Array.from(elements).filter((element) => element && typeof element.play === 'function');
    if (!playable.length) {
        return { total: 0, played: 0, blocked: false };
    }
    let played = 0;
    await Promise.all(playable.map(async (element) => {
        try {
            await element.play();
            played += 1;
        } catch (_) {
            // Playback stays blocked until the next user gesture.
        }
    }));
    return { total: playable.length, played, blocked: played < playable.length };
}

export async function resumeRemoteAudioPlayback(root) {
    return recoverMediaElementPlayback(collectAudioElements(root));
}
