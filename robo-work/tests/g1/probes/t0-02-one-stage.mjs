// T0-02 one-stage feasibility (plan g4-apparatus-target-plan, Stage 0 table; plan_codex §5.5:479).
// Outer unshare stage, then one bwrap user-namespace stage, then cat /proc/self/status. Start and identity only: it is
// never graded as isolation. Expected: all five capability sets zero and NoNewPrivs 1, or an explicit failure (non-zero
// exit with a diagnostic). Negative control: the same chain without --cap-drop ALL must start and show a non-zero
// bounding set; if the control cannot start, the probe cannot tell the two apart and the record is FAIL.
import { capSetNonZero, capsAllZero, parseStatus } from '../lib/procScan.mjs';
import { run, which } from '../lib/exec.mjs';

export const id = 'T0-02';
export const planRefs = ['plan_codex.md:479', 'p0-g1-mechanism-and-g4-proposal_claude.md:167'];
export const rows = [];
export const expected = 'Main chain: caps 0 (all five sets) and NoNewPrivs 1, or an explicit failure (rc != 0 with stderr). Never graded as isolation.';
export const controlExpected = 'The same chain without --cap-drop ALL starts (rc 0) and shows a non-zero CapBnd';

export function chain({ unshare, bwrap, capDrop, disableUserns }) {
    return [unshare, ['--pid', '--fork', '--mount-proc', '--ipc', '--uts', '--net', '--',
        bwrap, '--unshare-user', '--uid', '1000', '--gid', '1000',
        ...(capDrop ? ['--cap-drop', 'ALL'] : []),
        ...(disableUserns ? ['--disable-userns'] : []),
        '--ro-bind', '/', '/', '--', '/usr/bin/cat', '/proc/self/status']];
}

function summarize(result) {
    const status = result.rc === 0 ? parseStatus(result.stdout) : null;
    return {
        command: result.command,
        rc: result.rc,
        signal: result.signal,
        error: result.error,
        stderr: result.stderr.slice(0, 4000),
        caps: status ? status.caps : null,
        noNewPrivs: status ? status.noNewPrivs : null,
        uid: status ? status.uid : null,
    };
}

export async function collect() {
    const unshare = which('unshare');
    const bwrap = which('bwrap');
    if (!unshare || !bwrap) {
        const missing = { rc: null, error: `tool missing: unshare=${unshare} bwrap=${bwrap}`, stderr: '', command: 'unshare … bwrap …' };
        return { observed: { main: missing, disableUserns: false }, negativeControl: { command: 'unshare … bwrap (no --cap-drop)', expected: controlExpected, observed: { control: missing } }, measurements: {}, unreadable: [] };
    }
    const help = run(bwrap, ['--help']);
    const disableUserns = `${help.stdout}\n${help.stderr}`.includes('--disable-userns');
    const [mainCmd, mainArgs] = chain({ unshare, bwrap, capDrop: true, disableUserns });
    const [ctlCmd, ctlArgs] = chain({ unshare, bwrap, capDrop: false, disableUserns });
    const main = summarize(run(mainCmd, mainArgs));
    const control = summarize(run(ctlCmd, ctlArgs));
    return {
        observed: { main, disableUserns },
        negativeControl: { command: control.command, expected: controlExpected, observed: { control } },
        measurements: { mechanismFlag: disableUserns ? '--disable-userns' : 'none (seccomp fallback needed later)' },
        unreadable: [],
    };
}

export function grade(observedValues, controlObserved) {
    const notes = [];
    const main = observedValues?.main;
    const started = main?.rc === 0 && capsAllZero(main.caps) && main.noNewPrivs === 1;
    const explicitFailure = main !== undefined && main !== null && main.rc !== 0 && main.rc !== null
        && typeof main.stderr === 'string' && main.stderr.trim() !== '';
    if (!started && !explicitFailure) notes.push('main chain neither started with zero capabilities and NNP 1 nor failed explicitly');
    if (main?.rc === 0 && !started) notes.push('main chain started but capabilities or NNP are not as expected');
    const control = controlObserved?.control;
    const controlOpposite = control?.rc === 0 && capSetNonZero(control?.caps?.CapBnd);
    if (!controlOpposite) notes.push(`control rc ${control?.rc ?? 'not observed'}, CapBnd ${control?.caps?.CapBnd ?? 'not observed'}`);
    return { expectedMet: started || explicitFailure, controlOppositeMet: controlOpposite, notes };
}
