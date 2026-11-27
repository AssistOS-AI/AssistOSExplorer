export function sessionAge(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 60) return 'just now';
    const [count, unit] = seconds < 3600 ? [Math.round(seconds / 60), 'minute']
        : seconds < 86400 ? [Math.round(seconds / 3600), 'hour']
            : [Math.round(seconds / 86400), 'day'];
    return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}
