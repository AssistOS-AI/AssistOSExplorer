import { invalid } from './graph.mjs';

const minute = 60000;
const formatters = new Map();
function formatter(timeZone) {
    if (!formatters.has(timeZone)) {
        try { formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })); }
        catch { throw invalid('Choose a valid IANA time zone'); }
    }
    return formatters.get(timeZone);
}
function localParts(timestamp, timeZone) {
    return Object.fromEntries(formatter(timeZone).formatToParts(timestamp).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
export function normalizeTiming(input) {
    if (input?.kind === 'interval') {
        if (!Number.isSafeInteger(input.everyMinutes) || input.everyMinutes < 1 || input.everyMinutes > 525600) throw invalid('Interval must be a whole number of minutes between 1 and 525600');
        return { kind: 'interval', everyMinutes: input.everyMinutes };
    }
    if (input?.kind !== 'daily') throw invalid('Choose interval or daily scheduling');
    if (typeof input.timeZone !== 'string' || !input.timeZone.trim() || input.timeZone.length > 100) throw invalid('Choose a valid IANA time zone');
    const timeZone = input.timeZone.trim(); formatter(timeZone);
    if (!Array.isArray(input.times) || !input.times.length || input.times.length > 24 || input.times.some(time => typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw invalid('Choose 1 to 24 daily times in HH:mm format');
    return { kind: 'daily', timeZone, times: [...new Set(input.times)].sort() };
}
export function nextRun(timing, after, anchor = after) {
    if (timing.kind === 'interval') {
        const period = timing.everyMinutes * minute;
        return anchor + (Math.floor(Math.max(0, after - anchor) / period) + 1) * period;
    }
    const today = localParts(after, timing.timeZone);
    const midnight = Date.UTC(today.year, today.month - 1, today.day);
    for (let day = 0; day < 4; day++) {
        const date = midnight + day * 86400000;
        // Sample offsets on either side of the date, including daylight-saving transitions.
        const offsets = new Set();
        for (let hours = -36; hours <= 36; hours += 12) {
            const instant = date + hours * 3600000, local = localParts(instant, timing.timeZone);
            offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - instant);
        }
        const candidates = [];
        for (const time of timing.times) {
            const [hour, minutes] = time.split(':').map(Number);
            const wall = date + hour * 3600000 + minutes * minute;
            const matches = [...offsets].map(offset => wall - offset).filter(instant => {
                const local = localParts(instant, timing.timeZone);
                return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) === wall;
            }).sort((a, b) => a - b);
            // A missing local time is skipped; a repeated local time runs only at its first occurrence.
            if (matches.length && matches[0] > after) candidates.push(matches[0]);
        }
        if (candidates.length) return Math.min(...candidates);
    }
    throw invalid('No upcoming daily occurrence could be calculated');
}
