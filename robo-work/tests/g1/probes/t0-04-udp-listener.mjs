// T0-04: nothing listens on 17971/udp inside the Box (plan g4-apparatus-target-plan R1.8, A3 wildcard UDP condition).
// The Box may lack `ss`, so the operator tool captures /proc/net/{udp,udp6,tcp,tcp6} from the Box's own network
// namespace (podman exec <box-id> cat …) while a task-owned UDP sentinel is bound to 127.0.0.1:17972 inside the Box,
// and pipes the capture to this probe on stdin. 17971 itself is never bound by the task: it is published on the
// wildcard address. Expected: no socket bound to 17971. Negative control: the same parser finds the 17972 sentinel.
import { boundOnPort, parseProcNet } from '../lib/procScan.mjs';

export const id = 'T0-04';
export const planRefs = ['g4-apparatus-target-plan-2026-10-28_claude.md R1.8 (A3 wildcard UDP)', 'ploinky AGENTS.md:19'];
export const rows = [];
export const MEDIA_PORT = 17971;
export const SENTINEL_PORT = 17972;
export const expected = `No UDP socket (IPv4 or IPv6) bound to ${MEDIA_PORT} in the Box network namespace`;
export const controlExpected = `The task-owned UDP sentinel on 127.0.0.1:${SENTINEL_PORT} appears in the same capture`;

export function analyse(capture) {
    const unreadable = [];
    const tables = {};
    for (const proto of ['udp', 'udp6', 'tcp', 'tcp6']) {
        const text = capture?.tables?.[proto];
        if (typeof text !== 'string') {
            unreadable.push({ path: `box:/proc/net/${proto}`, code: 'MISSING' });
            continue;
        }
        try {
            tables[proto] = parseProcNet(text, proto);
        } catch (error) {
            unreadable.push({ path: `box:/proc/net/${proto}`, code: `PARSE: ${error.message}` });
        }
    }
    const udp = [...(tables.udp ?? []), ...(tables.udp6 ?? [])];
    const tcp = [...(tables.tcp ?? []), ...(tables.tcp6 ?? [])];
    return {
        unreadable,
        observed: {
            mediaPortBound: boundOnPort(udp, MEDIA_PORT),
            tcp8080Listening: boundOnPort(tcp, 8080).length > 0,
            udpSocketCount: udp.length,
            capturedAt: capture?.capturedAt ?? null,
            boxId: capture?.boxId ?? null,
        },
        control: {
            sentinel: capture?.sentinel ?? null,
            sentinelBound: boundOnPort(udp, SENTINEL_PORT).filter((entry) => entry.local.addr === '127.0.0.1'),
        },
    };
}

export async function collect(ctx) {
    const capture = ctx.stdinJson;
    const { unreadable, observed, control } = analyse(capture);
    return {
        observed,
        negativeControl: {
            command: `box: node UDP sentinel bound to 127.0.0.1:${SENTINEL_PORT}, then cat /proc/net/udp{,6}`,
            expected: controlExpected,
            observed: control,
        },
        measurements: {},
        unreadable,
    };
}

export function grade(observedValues, control) {
    const notes = [];
    const mediaClear = Array.isArray(observedValues?.mediaPortBound) && observedValues.mediaPortBound.length === 0;
    if (!mediaClear) notes.push(`${MEDIA_PORT}/udp bound inside the Box: ${JSON.stringify(observedValues?.mediaPortBound ?? null)}`);
    const sentinelSeen = Array.isArray(control?.sentinelBound) && control.sentinelBound.length > 0;
    if (!sentinelSeen) notes.push(`sentinel ${SENTINEL_PORT}/udp not found in the capture`);
    return { expectedMet: mediaClear, controlOppositeMet: sentinelSeen, notes };
}
