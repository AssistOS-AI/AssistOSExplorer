import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDesktopCommandPlan } from '../server/desktop-manager.mjs';

test('desktop command plan binds all applications to one profile and display', () => {
    const commands = {
        xvfb: '/usr/bin/Xvfb',
        openbox: '/usr/bin/openbox-session',
        xterm: '/usr/bin/xterm',
        chromium: '/usr/bin/chromium',
        x11vnc: '/usr/bin/x11vnc',
        websockify: '/usr/bin/websockify',
    };
    const plan = buildDesktopCommandPlan({
        profileRoot: '/data/profiles/research-a1b2c3',
        displayNumber: 101,
        rfbPort: 5901,
        websockifyPort: 6101,
        commands,
    });
    assert.deepEqual(plan.map((entry) => entry.name), ['xvfb', 'openbox', 'terminal', 'chromium', 'x11vnc', 'websockify']);
    assert.equal(plan[0].args[0], ':101');
    assert.ok(plan[3].args.includes('--user-data-dir=/data/profiles/research-a1b2c3/browser'));
    assert.deepEqual(plan[5].args, ['6101', '127.0.0.1:5901']);
});
