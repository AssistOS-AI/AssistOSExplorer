// Stage 0 collectors are implemented. S1 registrations are explicit blocked preparation stubs; they cannot qualify
// a runtime until the native held-reference observer and complete subcheck collectors are implemented and reviewed.
import * as t001 from './t0-01-survey.mjs';
import * as t002 from './t0-02-one-stage.mjs';
import * as t003 from './t0-03-controls.mjs';
import * as t004 from './t0-04-udp-listener.mjs';
import { createFirstCheckpointProbe, S1_REQUIRED } from './firstCheckpoint.mjs';

export const PROBES = Object.freeze({ 'T0-01': t001, 'T0-02': t002, 'T0-03': t003, 'T0-04': t004,
    ...Object.fromEntries(S1_REQUIRED.map((id) => [id, createFirstCheckpointProbe(id)])) });
export const STAGE_REQUIRED = Object.freeze({ S0: Object.freeze(['T0-01', 'T0-02', 'T0-03', 'T0-04']), S1: S1_REQUIRED });
export const GRADERS = Object.freeze(Object.fromEntries(Object.entries(PROBES).map(([id, probe]) => [id, probe.grade])));
