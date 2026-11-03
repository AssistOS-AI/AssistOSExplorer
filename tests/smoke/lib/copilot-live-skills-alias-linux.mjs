import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createLiveSkillsFixture, liveSkillSources, validateLiveSkillReceiptSource } from './copilot-live-skills.mjs';

// Explicit provider-free Linux check, never selected by node --test. The operator runs it
// in the pinned RoboWork runtime with its already installed ALA and Bubblewrap.
export async function checkLiveSkillAliases({ alaCommand, bwrap }) {
    assert.equal(process.platform, 'linux', 'Real source aliases require the selected Linux runtime; this check was not run.');
    assert.ok(path.isAbsolute(alaCommand || '') && path.isAbsolute(bwrap || ''), 'Select exact existing ALA and Bubblewrap paths.');
    const command = fs.realpathSync(alaCommand), wrapper = fs.realpathSync(bwrap);
    fs.accessSync(wrapper, fs.constants.X_OK);
    const alaRoot = path.dirname(path.dirname(command));
    assert.equal(path.basename(command), 'ala.mjs');
    assert.equal(JSON.parse(fs.readFileSync(`${alaRoot}/package.json`, 'utf8')).name, 'advanced-language-agent');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-skill-alias-')));
    const previousHome = process.env.ALA_SANDBOX_HOME;
    const robotId = 'owned-alias-robot', homeTarget = `/home/${robotId}`;
    process.env.ALA_SANDBOX_HOME = homeTarget;
    try {
        const { buildSandboxArgs } = await import(pathToFileURL(`${alaRoot}/src/coding-agents/sandbox.mjs`).href);
        const fixture = createLiveSkillsFixture(root); fixture.robotId = robotId;
        const skill = fixture.control, sources = liveSkillSources(fixture, skill, root);
        const canonicalDirectory = `${fixture.repositoryRoot}/skills/${skill.name}`, canonicalSource = `${canonicalDirectory}/receipt.mjs`;
        const alias = '/workspace/roboteam-skill-0', skillsDirectory = `${root}/session-skills`, homeSource = `${root}/owned-home`, otherHome = `${root}/other-home`;
        for (const directory of [canonicalDirectory, skillsDirectory, homeSource, otherHome, `${fixture.workspace}/.agents/skills`, `${fixture.workspace}/.receipts`]) fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(`${canonicalDirectory}/SKILL.md`, sources.descriptor); fs.writeFileSync(canonicalSource, sources.helper);
        fs.symlinkSync(alias, `${skillsDirectory}/${skill.name}`);
        const copy = `${root}/copied-source`; fs.cpSync(canonicalDirectory, copy, { recursive: true });
        const identity = file => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode'].map(key => [key, String(fs.statSync(file, { bigint: true })[key])]));
        const homeBinding = { homeTarget, identity: identity(homeSource) }, results = [];
        for (const name of ['readonly exact alias', 'same-byte copied alias', 'writable alias', 'different native home']) {
            const phase = randomUUID(), source = name === 'same-byte copied alias' ? copy : canonicalDirectory;
            const args = buildSandboxArgs({ workspace: fixture.workspace, backend: 'codex', binary: process.execPath,
                args: [`${fixture.workspace}/.agents/skills/${skill.name}/receipt.mjs`, phase], bwrap: wrapper,
                home: name === 'different native home' ? otherHome : homeSource,
                env: { HOME: homeSource, PATH: '/usr/local/bin:/usr/bin:/bin' }, folders: [
                    { source: fixture.repositoryRoot, target: fixture.repositoryRoot, expose: true },
                    { source, target: alias, expose: true },
                    { source: skillsDirectory, target: `${fixture.workspace}/.agents/skills`, expose: true },
                ] });
            if (name === 'writable alias') {
                const index = args.findIndex((value, index) => value === '--ro-bind' && args[index + 1] === source && args[index + 2] === alias);
                assert.ok(index >= 0); args[index] = '--bind';
            }
            const run = spawnSync(wrapper, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
                env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
            assert.equal(run.error, undefined, 'Existing Bubblewrap execution could not finish.');
            const file = `${fixture.workspace}/.receipts/${phase}-${skill.name}.json`;
            if (name === 'same-byte copied alias' || name === 'writable alias') {
                assert.notEqual(run.status, 0, `${name} was accepted by the real helper.`);
                assert.match(run.stderr, name === 'writable alias' ? /effectively read-only/ : /canonical source file object/);
                assert.equal(fs.existsSync(file), false, 'Rejected source wrote a receipt.');
            } else {
                assert.equal(run.status, 0, 'Real alias helper did not execute successfully.');
                assert.equal(run.stdout.trim(), skill.helperMarker);
                const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
                const validate = () => validateLiveSkillReceiptSource({ receipt, link: { target: alias }, canonicalSource,
                    canonicalIdentity: identity(canonicalSource), helperSha256: sources.helperSha256, homeBinding });
                if (name === 'different native home') assert.throws(validate, /owned RoboWork home/);
                else validate();
            }
            results.push({ name, nativeExit: run.status, expectedOutcomeObserved: true });
        }
        return { kind: 'live-skill-real-linux-alias', cases: results, modelCalls: 0 };
    } finally {
        if (previousHome === undefined) delete process.env.ALA_SANDBOX_HOME;
        else process.env.ALA_SANDBOX_HOME = previousHome;
        assert.ok(root.startsWith(`${fs.realpathSync(os.tmpdir())}/live-skill-alias-`));
        fs.rmSync(root, { recursive: true, force: true });
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        assert.equal(process.argv.length, 6, 'Usage: node copilot-live-skills-alias-linux.mjs --ala-command <absolute> --bwrap <absolute>');
        assert.equal(process.argv[2], '--ala-command'); assert.equal(process.argv[4], '--bwrap');
        console.log(JSON.stringify(await checkLiveSkillAliases({ alaCommand: process.argv[3], bwrap: process.argv[5] })));
    } catch (error) {
        console.error(error.message); process.exitCode = 1;
    }
}
