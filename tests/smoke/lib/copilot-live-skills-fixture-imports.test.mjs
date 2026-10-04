import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createLiveSkillsFixture, liveSkillsHash } from './copilot-live-skills.mjs';
import { LIVE_SKILLS_CONTRACT_FILES } from './copilot-live-skills-runtime.mjs';
import { operateLiveSkillsFixture } from './copilot-live-skills-fixture-runtime.mjs';

const imports = ['server/soul-gateway-service.mjs', 'server/soul-gateway-opencode.mjs',
    'server/soul-gateway-connection.mjs', 'server/agent-model-config.mjs'];

function productionCase(t) {
    assert.ok(process.env.SET2_ACHILLES_SOURCE, 'Pin the disposable source to SET2_ACHILLES_SOURCE.');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'set2 real imports ü ')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = `${root}/AchillesCLI`, codeRoot = `${repository}/roboTeamAgent`, dataRoot = `${root}/_data`;
    fs.mkdirSync(repository);
    fs.cpSync(`${process.env.SET2_ACHILLES_SOURCE}/roboTeamAgent`, codeRoot, { recursive: true,
        filter: source => !source.split(path.sep).some(part => ['node_modules', '.git'].includes(part)) });
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    delete process.env.PLOINKY_SKILL_SCOPE;
    const fixture = createLiveSkillsFixture(root); fixture.robotId = 'owned-import-robot';
    const ownership = { version: 1, runId: fixture.runId, workspace: fixture.workspace,
        repositoryRoot: fixture.repositoryRoot, robotName: fixture.robotName };
    for (const folder of [fixture.repositoryRoot, fixture.workspace]) {
        fs.mkdirSync(folder);
        fs.writeFileSync(`${folder}/.set2-live-fixture_codex.json`, JSON.stringify(ownership) + '\n');
    }
    const source = `${fixture.repositoryRoot}/skills/${fixture.control.name}`;
    fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(`${source}/SKILL.md`, 'synthetic owned source');
    fs.mkdirSync(`${fixture.workspace}/.agents/skills`, { recursive: true });
    const destination = `${fixture.workspace}/.agents/skills/${fixture.control.name}`;
    fs.symlinkSync(source, destination);
    fs.writeFileSync(`${fixture.workspace}/.agents/.roboteam-links.json`, JSON.stringify([{ repoName: fixture.repositoryName,
        sourcePath: `skills/${fixture.control.name}`, destination, linkTarget: source }]));
    const robotRoot = `${dataRoot}/robots/${fixture.robotId}`;
    fs.mkdirSync(`${robotRoot}/runtime/skill-policies`, { recursive: true });
    fs.writeFileSync(`${robotRoot}/metadata.json`, JSON.stringify({ schema: 'roboteam-robot-v1', id: fixture.robotId,
        name: fixture.robotName, codingAgents: ['codex'], skillsets: [{ name: fixture.repositoryName,
            source: fixture.repositoryRoot, generation: randomUUID() }] }));
    // The production branch must refuse before ensure/withRobot, native preparation, or client use.
    fs.writeFileSync(`${robotRoot}/runtime/skill-policies/existing-policy_codex.json`, '{"owned-existing-policy":true}\n');
    const contractHashes = Object.fromEntries(LIVE_SKILLS_CONTRACT_FILES.map(file => [file, liveSkillsHash(fs.readFileSync(`${codeRoot}/${file}`))]));
    const marker = `${root}/evaluation_codex.json`;
    function ownedState() {
        const entries = [];
        function visit(file) {
            const stat = fs.lstatSync(file);
            entries.push([file, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
                stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? liveSkillsHash(fs.readFileSync(file)) : null]);
            if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(`${file}/${name}`);
        }
        for (const folder of [fixture.repositoryRoot, fixture.workspace, robotRoot]) visit(folder);
        return liveSkillsHash(entries);
    }
    function instrument(file, alias = false) {
        const original = `${codeRoot}/${file}`;
        let target = original;
        if (alias) {
            const foreign = `${root}/foreign-server`;
            fs.cpSync(`${codeRoot}/server`, foreign, { recursive: true });
            target = `${foreign}/${path.basename(file)}`;
            fs.unlinkSync(original); fs.symlinkSync(target, original);
        }
        fs.appendFileSync(target, `\nimport { writeFileSync as set2EvaluationWrite } from 'node:fs';\nset2EvaluationWrite(${JSON.stringify(marker)}, ${JSON.stringify(JSON.stringify({ evaluated: file }))}, { flag: 'wx', mode: 0o600 });\n`);
        return target;
    }
    const run = async () => {
        try {
            await operateLiveSkillsFixture({ action: 'seed-defaults', fixture, workspaceRoot: root,
                expectedRepository: repository, contractHashes }, { codeRoot, dataRoot,
                emit: () => assert.fail('The existing-policy control must never reach mutation success.') });
            assert.fail('Expected the normal existing-policy refusal or the earlier source guard.');
        } catch (error) { return error; }
    };
    return { root, fixture, codeRoot, contractHashes, marker, instrument, ownedState, run };
}

test('S4-R1 pristine production imports reach the intended existing-policy refusal without state mutation', async t => {
    const c = productionCase(t), before = c.ownedState();
    const error = await c.run();
    assert.match(error.message, /Refuse an existing owned robot policy/);
    assert.equal(fs.existsSync(c.marker), false);
    assert.equal(c.ownedState(), before);
});

for (const file of imports) {
    test(`S4-R1 verified sentinel proves actual production evaluation of ${file}`, async t => {
        const c = productionCase(t), target = c.instrument(file);
        c.contractHashes[file] = liveSkillsHash(fs.readFileSync(target));
        const before = c.ownedState(), error = await c.run();
        assert.match(error.message, /Refuse an existing owned robot policy/);
        assert.deepEqual(JSON.parse(fs.readFileSync(c.marker, 'utf8')), { evaluated: file });
        assert.equal(c.ownedState(), before);
    });
    test(`S4-R1 changed bytes reject before evaluation or mutation of ${file}`, async t => {
        const c = productionCase(t); c.instrument(file);
        const before = c.ownedState(), error = await c.run();
        assert.equal(c.ownedState(), before, 'Owned policy/link state changed.');
        assert.equal(fs.existsSync(c.marker), false, 'Unverified source evaluated before the source guard.');
        assert.match(error.message, /Fixture operation source differs from the verified checkout/);
    });
    test(`S4-R1 foreign canonical alias rejects before evaluation or mutation of ${file}`, async t => {
        const c = productionCase(t), target = c.instrument(file, true);
        // Match the aliased bytes when the production table pins this file, so only canonical identity can reject it.
        if (Object.hasOwn(c.contractHashes, file)) c.contractHashes[file] = liveSkillsHash(fs.readFileSync(target));
        const before = c.ownedState(), error = await c.run();
        assert.equal(c.ownedState(), before, 'Owned policy/link state changed.');
        assert.equal(fs.existsSync(c.marker), false, 'Foreign source alias evaluated before the source guard.');
        assert.equal(error.code, 'ERR_ASSERTION');
        assert.match(error.message, /Expected values to be strictly equal/);
        assert.doesNotMatch(error.message, /existing owned robot policy/);
    });
}
