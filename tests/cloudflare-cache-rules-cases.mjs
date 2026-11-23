import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { entry, fixture, foreign, host, id, inventoryPath, prepared, requestPhase, responsePhase, r1, r2,
    tokenEnv, zone } from './cloudflare-cache-rules-fixture.mjs';

const operations = [['check'], ['ensure-r1'], ['r2-off'], ['r2-on'], ['r2-off', '--if-present']];
const pageParameters = { cache: true, edge_ttl: { mode: 'bypass_by_default' }, browser_ttl: { mode: 'respect_origin' } };
const toggle = (api, enabled) => ({ method: 'PATCH',
    path: `/rulesets/${api.state.request.id}/rules/${api.owned(r2).id}`, body: { enabled } });

async function rejects(api, promise, message, expected) {
    await assert.rejects(promise, error => {
        assert.ok(error instanceof Error && !(error instanceof assert.AssertionError), 'fixture rejected an API request');
        assert.ok(!String(error.stack).includes(api.token), 'token was disclosed in diagnostics');
        if (expected) assert.match(error.message, expected);
        return true;
    }, message);
}

// Both worktrees register these same cases against their own local script.
export function registerCacheRulesTests(run, scriptUrl) {
    const check = (name, callback) => test(`shared cache rules - ${name}`, callback);
    check('the local reconciler matches the canonical SHA-256', () => {
        assert.equal(createHash('sha256').update(readFileSync(scriptUrl)).digest('hex'),
            '1cd22bb8149e242c139bc5accf7939dbb4de649f8d15c4896468e3a7d184a241',
            "The other repository's reconciler copy must change too. Update both copies and their SHA-256 pins together.");
    });

    check('creation, exact rule definitions, precedence and repeat runs', async () => {
        const api = fixture(run);
        api.state.response.rules[0].expression = '(http.host eq "other.example.test" and (http.request.uri.path eq "/docs" or http.cookie ne ""))';
        api.state.response.rules[1].expression = '(http.host in {"ONE.example.test" "two.example.test"}) or (http.host eq "three.example.test")';
        const original = structuredClone(api.state.response);
        for (const operation of ['check', '--check', 'r2-on']) {
            await rejects(api, api.invoke(operation));
            assert.deepEqual(api.writes(), []);
            assert.ok(api.state.calls.some(call => call.path === inventoryPath(requestPhase)));
            assert.ok(api.state.calls.some(call => call.path === inventoryPath(responsePhase)));
            api.state.calls.length = 0;
        }
        assert.equal(await api.invoke('ensure-r1'), 'applied');
        const bypass = api.owned(r1);
        assert.deepEqual(api.state.request.rules, [bypass]);
        assert.equal(bypass.enabled, true);
        assert.equal(bypass.action, 'set_cache_settings');
        assert.deepEqual(bypass.action_parameters, { cache: false });
        assert.equal(bypass.expression, `(http.host eq "${host}" and (http.cookie ne "" or has_key(http.request.headers, "authorization")))`);
        await rejects(api, api.invoke('r2-on'));
        assert.equal(await api.invoke('r2-off'), 'applied');
        const page = api.owned(r2);
        assert.deepEqual(api.state.request.rules, [page, bypass]);
        assert.equal(page.enabled, false);
        assert.equal(page.action, 'set_cache_settings');
        assert.equal(page.expression, `(http.host eq "${host}")`);
        assert.deepEqual(page.action_parameters, pageParameters);
        assert.deepEqual(api.writes().map(call => [call.method, call.path]), [
            ['POST', '/rulesets'], ['POST', `/rulesets/${api.state.request.id}/rules`],
        ]);
        assert.equal(api.writes()[1].body.enabled, false);
        api.state.calls.length = 0;
        for (const op of ['check', '--check', 'ensure-r1', 'r2-off']) assert.equal(await api.invoke(op), 'unchanged');
        assert.deepEqual(api.writes(), []);
        assert.equal(await api.invoke('r2-on'), 'applied');
        assert.equal(await api.invoke('r2-on'), 'unchanged');
        assert.equal(await api.invoke('check'), 'unchanged');
        assert.equal(await api.invoke('r2-off'), 'applied');
        assert.deepEqual(api.writes(), [toggle(api, true), toggle(api, false)]);
        assert.deepEqual(api.state.response, original);
    });

    check('ensure-r1 replaces the legacy header-name check on its existing host-scoped rule', async () => {
        const api = await prepared(run);
        const bypass = api.owned(r1);
        const originalId = bypass.id;
        bypass.expression = `(http.host eq "${host}" and (http.cookie ne "" or any(http.request.headers.names[*] eq "authorization")))`;
        await rejects(api, api.invoke('check'));
        await rejects(api, api.invoke('r2-on'));
        assert.deepEqual(api.writes(), []);
        assert.equal(await api.invoke('ensure-r1'), 'applied');
        assert.deepEqual(api.writes().map(call => [call.method, call.path]), [
            ['PATCH', `/rulesets/${api.state.request.id}/rules/${originalId}`],
        ]);
        assert.equal(await api.invoke('check'), 'unchanged');
    });

    check('existing empty entrypoints receive individual POSTs and drift is repaired while disabled', async () => {
        const api = fixture(run);
        api.state.request = entry(requestPhase, []);
        await api.invoke('ensure-r1');
        await api.invoke('r2-off');
        assert.ok(api.writes().every(call => call.method === 'POST' && call.path.endsWith('/rules')));
        const [page, bypass] = api.state.request.rules;
        api.state.request.rules.reverse();
        Object.assign(bypass, { enabled: false, expression: `(http.host eq "${host}" and http.cookie ne "")`,
            action_parameters: { cache: true } });
        page.enabled = true;
        page.action_parameters = { cache: true, edge_ttl: { mode: 'override_origin', default: 86400 } };
        api.state.calls.length = 0;
        for (const op of ['check', 'r2-on']) await rejects(api, api.invoke(op));
        assert.deepEqual(api.writes(), []);
        await api.invoke('ensure-r1');
        assert.deepEqual(api.writes()[0].body.position, { after: page.id });
        await rejects(api, api.invoke('r2-on'));
        assert.equal(api.writes().length, 1);
        api.state.calls.length = 0;
        assert.equal(await api.invoke('r2-off'), 'applied');
        const [disable, repair] = api.writes();
        assert.deepEqual(disable, toggle(api, false));
        assert.equal(api.writes().length, 2);
        assert.equal(repair.method, 'PATCH');
        assert.equal(repair.path, disable.path);
        assert.equal(repair.body.enabled, false);
        assert.deepEqual(repair.body.action_parameters, pageParameters);
        const between = api.state.calls.slice(api.state.calls.indexOf(disable) + 1, api.state.calls.indexOf(repair));
        for (const phase of [requestPhase, responsePhase]) assert.ok(between.some(call => call.path === inventoryPath(phase)));
        await api.invoke('r2-on');
        assert.deepEqual(api.state.request.rules.map(rule => [rule.ref, rule.enabled]), [[r2, true], [r1, true]]);
    });

    check('destroy mode does not create or repair rules, and disables only a present enabled page', async () => {
        const api = fixture(run);
        for (const request of [null, entry(requestPhase, [])]) {
            api.state.request = request;
            assert.equal(await api.invoke('r2-off', '--if-present'), 'unchanged');
            assert.deepEqual(api.writes(), []);
        }
        await api.invoke('ensure-r1');
        api.state.calls.length = 0;
        assert.equal(await api.invoke('r2-off', '--if-present'), 'unchanged');
        assert.deepEqual(api.writes(), []);
        await api.invoke('r2-off');
        api.state.request.rules.reverse();
        const page = api.owned(r2);
        page.action_parameters = { cache: false };
        page.enabled = true;
        const expected = structuredClone(api.state.request);
        expected.rules.find(rule => rule.ref === r2).enabled = false;
        api.state.calls.length = 0;
        assert.equal(await api.invoke('r2-off', '--if-present'), 'applied');
        assert.equal(await api.invoke('r2-off', '--if-present'), 'unchanged');
        assert.deepEqual(api.state.request, expected);
        assert.deepEqual(api.writes(), [toggle(api, false)]);
    });

    check('all foreign request rules and overlapping or unprovable response expressions refuse every operation', async () => {
        const expressions = ['true', `http.host eq "${host}"`, 'starts_with(http.request.uri.path, "/")',
            '(http.host eq "other.example" and http.cookie ne "") or true', 'http.host eq "other.example" and true OR true',
            'not (http.host eq "other.example")', `http.host in {"other.example" "${host}"}`,
            'http.host eq "foreign.example" && true || true', 'http.request.uri.path eq "http.host eq other.example"',
            'http.host eq "foreign.example" and true xor true'];
        for (const [phase, key] of [[requestPhase, 'request'], [responsePhase, 'response']]) {
            for (const expression of key === 'request' ? [...expressions, foreign(1).expression] : expressions) {
                const api = await prepared(run);
                api.state[key].rules.push({ ...foreign(1), expression, enabled: false });
                for (const args of operations) await rejects(api, api.invoke(...args), `${phase} ${expression}`);
                assert.deepEqual(api.writes(), []);
            }
        }
    });

    check('missing, duplicate, cross-phase and ambiguous identities fail before any mutation', async () => {
        const changes = [
            s => { delete s.request.rules[0].ref; },
            s => { delete s.response.rules[0].id; },
            s => { s.response.rules[0].ref = ''; },
            s => { s.request.rules[0].id = 'malformed'; },
            s => { s.request.phase = responsePhase; },
            s => { s.request.kind = 'custom'; },
            s => s.request.rules.push({ ...s.request.rules[0], id: id(30) }),
            s => { s.request.rules[1].id = s.request.rules[0].id; },
            s => { s.response.rules[1].ref = s.response.rules[0].ref; },
            s => { s.response.rules[0].ref = r1; },
            s => { s.response.rules[0].id = s.request.rules[0].id; },
            s => { s.response.rules[0].description = s.request.rules[1].description; },
            s => { s.response.rules[0].description = `Credentialed request cache bypass for ${host}`; },
            s => { s.response.rules[0].description = `Origin-controlled cache for ${host}`; },
            s => { s.request.rules[0].description = s.request.rules[1].description; },
            s => { s.request.rules[0].expression = '(http.host eq "other.example.test")'; },
            s => { s.request.rules[0].expression = 'true'; },
            s => { s.request.rules[0].action = 'execute'; },
            s => { delete s.request.rules[1].enabled; },
        ];
        for (const change of changes) {
            const api = await prepared(run);
            change(api.state);
            for (const args of operations) await rejects(api, api.invoke(...args), String(change));
            assert.deepEqual(api.writes(), []);
        }
    });

    check('the Free limit accounts for both owned rules before writing', async () => {
        const api = fixture(run);
        api.state.request = entry(requestPhase, Array.from({ length: 9 }, (_, n) => foreign(n + 30)));
        await rejects(api, api.invoke('ensure-r1'), undefined, /capacity|limit/i);
        assert.deepEqual(api.writes(), []);
    });

    check('check and enable both require exact definitions, ready bypass and precedence', async () => {
        const changes = [
            s => s.request.rules.reverse(), s => s.request.rules.shift(), s => s.request.rules.pop(),
            s => { s.request.rules[1].enabled = false; }, s => { s.request.rules[1].action_parameters.cache = true; },
            s => { s.request.rules[0].action_parameters.cache_key = { custom_key: {} }; },
            s => { s.request.rules[0].logging = { enabled: true }; },
        ];
        for (const change of changes) {
            const api = await prepared(run);
            change(api.state);
            for (const op of ['check', 'r2-on']) await rejects(api, api.invoke(op), String(change));
            assert.deepEqual(api.writes(), []);
        }
    });

    check('an unaccepted or ineffective repair leaves the drifted page disabled', async () => {
        for (const fault of ['refusal', 'ineffective']) {
            const api = await prepared(run);
            const page = api.owned(r2);
            page.enabled = true;
            page.action_parameters.cache_key = { custom_key: {} };
            if (fault === 'refusal') {
                api.state.before = call => call.method === 'PATCH' && call.body.ref
                    && Response.json({ success: false, errors: [{ message: api.token }] }, { status: 403 });
            } else {
                api.state.afterWrite = call => { if (call.body.ref) page.action_parameters.cache = false; };
            }
            await rejects(api, api.invoke('r2-off'));
            assert.equal(page.enabled, false);
            assert.equal(api.writes().length, 2);
            assert.deepEqual(api.writes()[0], toggle(api, false));
            assert.equal(api.writes()[1].body.enabled, false);
        }
    });

    check('only 404 plus the single numeric missing-entrypoint error authorizes creation', async () => {
        for (const phase of [requestPhase, responsePhase]) {
            const api = fixture(run);
            const bad = [
                () => new Response('invalid'), () => new Response(null, { status: 404 }),
                ...[[200, true, null], [200, true, {}], [200, false, null], [403, false, null], [429, false, null],
                    [404, true, null, [10003]], [404, false, null, []], [404, false, null, [19999]],
                    [404, false, null, ['10003']], [404, false, null, [10003, 19999]]]
                    .map(([status, success, result, codes = [10003]]) => () => Response.json({ success, result,
                        errors: codes.map(code => ({ code, message: api.token })) }, { status })),
            ];
            for (const response of bad) {
                api.state.before = call => call.path === inventoryPath(phase) && response();
                await rejects(api, api.invoke('ensure-r1'));
                assert.deepEqual(api.writes(), []);
            }
        }
        const api = fixture(run);
        api.state.response = null;
        assert.equal(await api.invoke('ensure-r1'), 'applied');
        assert.deepEqual(api.writes().map(call => [call.method, call.path]), [['POST', '/rulesets']]);
    });

    check('zone ownership, explicit credential selection, malformed configuration and arguments', async () => {
        const api = fixture(run);
        for (const badZone of [{ id: id(5), name: 'example.test' }, { id: zone, name: 'ample.test' }]) {
            api.state.before = call => !call.path && Response.json({ success: true, result: badZone });
            await rejects(api, api.invoke('ensure-r1'));
            assert.deepEqual(api.writes(), []);
        }
        api.state.calls.length = 0;
        const args = ['ensure-r1', '--token-env', tokenEnv];
        for (const changes of [{ PUBLIC_HOST: 'bad" or true' }, { CLOUDFLARE_CACHE_R2_REF: r1 },
            { CLOUDFLARE_ZONE_ID: 'unknown' }, { CLOUDFLARE_CACHE_R1_REF: '' },
            { [tokenEnv]: '', EXPLORER_QA_CLOUDFLARE_CACHE_RULES_TOKEN: api.token, BIZANSO_COM_CLOUDFLARE_API_TOKEN: api.token }]) {
            await rejects(api, api.argv(args, { ...api.env, ...changes }));
        }
        const offArgs = ['r2-off', '--token-env', tokenEnv];
        for (const invalid of [['check'], [...args, '--token-env', tokenEnv], ['check', '--token-env'],
            [...args, '--if-present'], [...args, '--unexpected'], ['r2-on', '--token-env', 'INVALID-NAME'],
            [...args, '--activation-receipt', 'receipt'], [...offArgs, '--activation-receipt'],
            [...offArgs, '--activation-receipt', 'a', '--activation-receipt', 'b'],
            [...offArgs, '--activation-receipt', 'receipt', '--if-present']]) {
            await rejects(api, api.argv(invalid));
        }
        assert.deepEqual(api.state.calls, []);
    });

    check('the CLI exits zero for an absent destroy target and one for an unready check', () => {
        const api = fixture(run);
        const base = `https://api.cloudflare.com/client/v4/zones/${zone}`;
        const preload = `globalThis.fetch = async (url, options) => {
            if (options.method !== "GET") throw Error("Unexpected write");
            if (url === ${JSON.stringify(base)}) return Response.json({success:true,result:{id:"${zone}",name:"example.test"}});
            if (${JSON.stringify([requestPhase, responsePhase].map(p => base + inventoryPath(p)))}.includes(url))
                return Response.json({success:false,errors:[{code:10003}]},{status:404});
            throw Error("Unexpected URL");
        };`;
        for (const [args, status] of [[['r2-off', '--if-present'], 0], [['--check'], 1]]) {
            const child = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload),
                fileURLToPath(scriptUrl), ...args, '--token-env', tokenEnv], { env: api.env, encoding: 'utf8' });
            assert.equal(child.error, undefined);
            assert.equal(child.status, status);
            assert.ok(!(child.stdout + child.stderr).includes(api.token));
        }
    });

    check('readbacks catch changes to the other phase, sibling, precedence and an ineffective activation', async () => {
        const changes = [
            s => { s.response.rules[0].description = 'concurrent edit'; }, s => s.response.rules.reverse(),
            s => { s.response.id = id(63); }, s => { s.request.rules[1].enabled = false; },
            s => { s.request.rules[0].enabled = false; }, s => s.request.rules.reverse(),
        ];
        for (const change of changes) {
            const api = await prepared(run);
            api.state.afterWrite = call => { if (call.body.enabled) change(api.state); };
            await rejects(api, api.invoke('r2-on'), String(change));
            assert.deepEqual(api.writes()[0], toggle(api, true));
            assert.deepEqual(api.writes().slice(1), api.writes().length === 1 ? [] : [toggle(api, false)]);
            assert.equal(api.owned(r2).enabled, false);
        }
    });

    check('recovery pins the original page through new conflicts and lost acknowledgements', async () => {
        for (const failure of ['lost enable', 'lost disable', 'request conflict', 'response conflict']) {
            const api = await prepared(run);
            const conflict = { ...foreign(30), expression: 'true' };
            api.state.afterWrite = ({ body }) => {
                if (body.enabled) {
                    if (failure === 'request conflict') api.state.request.rules.push(conflict);
                    if (failure === 'response conflict') api.state.response.rules.push(conflict);
                    if (failure.startsWith('lost')) throw new Error(api.token);
                } else if (failure === 'lost disable') throw new Error(api.token);
            };
            await rejects(api, api.invoke('r2-on'), undefined, /original R2 confirmed off/i);
            assert.deepEqual(api.writes(), [toggle(api, true), toggle(api, false)]);
            assert.equal(api.owned(r2).enabled, false);
            const afterDisable = api.state.calls.slice(api.state.calls.indexOf(api.writes()[1]) + 1);
            assert.ok(afterDisable.some(call => call.method === 'GET' && call.path === inventoryPath(requestPhase)));
            if (failure.endsWith('conflict')) {
                const phase = failure.startsWith('request') ? 'request' : 'response';
                assert.deepEqual(api.state[phase].rules.at(-1), { ...foreign(30), expression: 'true' });
                await rejects(api, api.invoke('r2-off'));
                assert.equal(api.writes().length, 2);
            }
        }
    });

    check('a lost enable that never applied needs no PATCH, and an unsuccessful disable is explicitly unconfirmed', async () => {
        for (const applied of [false, true]) {
            const api = await prepared(run);
            api.state.before = call => {
                if (call.method === 'PATCH' && (!applied || !call.body.enabled)) throw new Error(api.token);
            };
            api.state.afterWrite = () => { throw new Error(api.token); };
            await rejects(api, api.invoke('r2-on'), undefined, applied ? /unconfirmed|unable to confirm/i : /original R2 confirmed off/i);
            assert.equal(api.owned(r2).enabled, applied);
            assert.deepEqual(api.writes(), applied ? [toggle(api, true), toggle(api, false)] : [toggle(api, true)]);
        }
    });

    check('no compensation for a replaced, retargeted, changed or ambiguously claimed page', async () => {
        const changes = [
            s => { s.request.id = id(60); }, s => { s.request.rules[0].id = id(61); },
            s => { s.request.rules[0].ref = 'replaced'; }, s => { s.request.rules[0].expression = 'true'; },
            s => { s.request.rules[0].action_parameters.cache = false; },
            s => { s.request.rules[0].description += ' revised'; },
            s => s.request.rules.push({ ...s.request.rules[0], id: id(62) }),
            s => { s.request.rules[1].id = s.request.rules[0].id; },
            s => s.request.rules.push({ ...foreign(63), description: s.request.rules[0].description }),
            s => { s.response.rules[0].ref = r2; }, s => { s.response.rules[0].id = s.request.rules[0].id; },
            s => { s.response.rules[0].description = s.request.rules[0].description; },
        ];
        for (const change of changes) {
            const api = await prepared(run);
            const enable = toggle(api, true);
            api.state.afterWrite = () => { change(api.state); throw new Error(api.token); };
            await rejects(api, api.invoke('r2-on'), String(change), /unconfirmed|unable to confirm/i);
            assert.deepEqual(api.writes(), [enable]);
        }
    });

    check('a separate cancellation step uses the activation receipt and cannot disable a replacement', async t => {
        const directory = mkdtempSync(fileURLToPath(new URL('../.cache-rule-receipt-test-', import.meta.url)));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const path = join(directory, 'activation.json');
        const flags = ['--activation-receipt', path];
        const api = await prepared(run);
        await rejects(api, api.invoke('r2-off', ...flags));
        assert.deepEqual(api.writes(), []);
        writeFileSync(path, 'invalid', { flag: 'wx' });
        await rejects(api, api.invoke('r2-on', ...flags));
        await rejects(api, api.invoke('r2-off', ...flags));
        assert.equal(readFileSync(path, 'utf8'), 'invalid');
        assert.deepEqual(api.writes(), []);
        const expected = { zone, host, r1, r2, entryId: api.state.request.id, ruleId: api.owned(r2).id };
        for (const change of [{ host: 'elsewhere.test' }, { zone: id(53) }, { r2: 'different' }, { ruleId: null },
            { entryId: 'bad' }, { unknown: 'field' }]) {
            writeFileSync(path, JSON.stringify({ ...expected, ...change }));
            await rejects(api, api.invoke('r2-off', ...flags));
            assert.deepEqual(api.writes(), []);
        }
        rmSync(path);
        let observed;
        api.state.before = call => {
            if (call.method === 'PATCH' && call.body.enabled && existsSync(path)) observed = JSON.parse(readFileSync(path, 'utf8'));
        };
        assert.equal(await api.invoke('r2-on', ...flags), 'applied');
        assert.deepEqual(observed, expected);
        assert.deepEqual(api.writes(), [toggle(api, true)]);
        const conflict = { ...foreign(30), expression: 'true' };
        api.state.request.rules.push(conflict);
        assert.equal(await api.invoke('r2-off', ...flags), 'applied');
        assert.equal(api.owned(r2).enabled, false);
        assert.deepEqual(api.state.request.rules.at(-1), { ...foreign(30), expression: 'true' });
        assert.deepEqual(api.writes(), [toggle(api, true), toggle(api, false)]);
        api.state.calls.length = 0;
        api.owned(r2).enabled = true;
        api.owned(r2).id = id(99);
        await rejects(api, api.invoke('r2-off', ...flags));
        assert.equal(api.owned(r2).enabled, true);
        assert.deepEqual(api.writes(), []);
    });
}
