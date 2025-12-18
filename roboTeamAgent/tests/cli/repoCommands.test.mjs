/**
 * Tests for Repository Management Slash Commands.
 *
 * Tests /repos, /add-repo, /remove-repo, /update-repo, /enable-repo, /disable-repo commands.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// Repository Commands Definition Tests
// ============================================================================

describe('SlashCommandHandler - Repository Commands', () => {
    let SlashCommandHandler;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');
        SlashCommandHandler = module.SlashCommandHandler;
    });

    describe('Command Definitions', () => {
        it('should have /repos command defined', () => {
            assert.ok(SlashCommandHandler.COMMANDS.repos, 'Should have repos command');
            assert.strictEqual(SlashCommandHandler.COMMANDS.repos.skill, null);
            assert.strictEqual(SlashCommandHandler.COMMANDS.repos.args, 'none');
        });

        it('should have /add-repo command defined', () => {
            assert.ok(SlashCommandHandler.COMMANDS['add-repo'], 'Should have add-repo command');
            assert.strictEqual(SlashCommandHandler.COMMANDS['add-repo'].skill, null);
            assert.strictEqual(SlashCommandHandler.COMMANDS['add-repo'].args, 'required');
        });

        it('should have /remove-repo command defined', () => {
            assert.ok(SlashCommandHandler.COMMANDS['remove-repo'], 'Should have remove-repo command');
            assert.strictEqual(SlashCommandHandler.COMMANDS['remove-repo'].skill, null);
            assert.strictEqual(SlashCommandHandler.COMMANDS['remove-repo'].args, 'required');
        });

        it('should have /update-repo command defined', () => {
            assert.ok(SlashCommandHandler.COMMANDS['update-repo'], 'Should have update-repo command');
            assert.strictEqual(SlashCommandHandler.COMMANDS['update-repo'].skill, null);
            assert.strictEqual(SlashCommandHandler.COMMANDS['update-repo'].args, 'optional');
        });

        it('should have /enable-repo command defined', () => {
            assert.ok(SlashCommandHandler.COMMANDS['enable-repo'], 'Should have enable-repo command');
            assert.strictEqual(SlashCommandHandler.COMMANDS['enable-repo'].skill, null);
            assert.strictEqual(SlashCommandHandler.COMMANDS['enable-repo'].args, 'required');
        });

        it('should have /disable-repo command defined', () => {
            assert.ok(SlashCommandHandler.COMMANDS['disable-repo'], 'Should have disable-repo command');
            assert.strictEqual(SlashCommandHandler.COMMANDS['disable-repo'].skill, null);
            assert.strictEqual(SlashCommandHandler.COMMANDS['disable-repo'].args, 'required');
        });
    });

    describe('Command Parsing', () => {
        let handler;

        beforeEach(() => {
            handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => [],
            });
        });

        it('should parse /repos command', () => {
            const parsed = handler.parseSlashCommand('/repos');
            assert.strictEqual(parsed.command, 'repos');
            assert.strictEqual(parsed.args, '');
        });

        it('should parse /add-repo with URL', () => {
            const parsed = handler.parseSlashCommand('/add-repo https://github.com/user/repo.git');
            assert.strictEqual(parsed.command, 'add-repo');
            assert.strictEqual(parsed.args, 'https://github.com/user/repo.git');
        });

        it('should parse /add-repo with URL and name', () => {
            const parsed = handler.parseSlashCommand('/add-repo https://github.com/user/repo.git my-repo');
            assert.strictEqual(parsed.command, 'add-repo');
            assert.strictEqual(parsed.args, 'https://github.com/user/repo.git my-repo');
        });

        it('should parse /remove-repo with name', () => {
            const parsed = handler.parseSlashCommand('/remove-repo my-repo');
            assert.strictEqual(parsed.command, 'remove-repo');
            assert.strictEqual(parsed.args, 'my-repo');
        });

        it('should parse /remove-repo with --delete flag', () => {
            const parsed = handler.parseSlashCommand('/remove-repo my-repo --delete');
            assert.strictEqual(parsed.command, 'remove-repo');
            assert.strictEqual(parsed.args, 'my-repo --delete');
        });

        it('should parse /update-repo all', () => {
            const parsed = handler.parseSlashCommand('/update-repo all');
            assert.strictEqual(parsed.command, 'update-repo');
            assert.strictEqual(parsed.args, 'all');
        });

        it('should parse /enable-repo with name', () => {
            const parsed = handler.parseSlashCommand('/enable-repo my-repo');
            assert.strictEqual(parsed.command, 'enable-repo');
            assert.strictEqual(parsed.args, 'my-repo');
        });

        it('should parse /disable-repo with name', () => {
            const parsed = handler.parseSlashCommand('/disable-repo my-repo');
            assert.strictEqual(parsed.command, 'disable-repo');
            assert.strictEqual(parsed.args, 'my-repo');
        });
    });
});

// ============================================================================
// Repository Command Execution Tests
// ============================================================================

describe('SlashCommandHandler - Repository Command Execution', () => {
    let SlashCommandHandler;
    let RepoManager;
    let tempDir;
    let globalReposDir;

    beforeEach(async () => {
        const slashModule = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');
        SlashCommandHandler = slashModule.SlashCommandHandler;

        const repoModule = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = repoModule.RepoManager;

        // Create temp directories
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-cmd-test-'));
        globalReposDir = path.join(tempDir, 'global-repos');
        fs.mkdirSync(globalReposDir, { recursive: true });
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('/repos command', () => {
        it('should return error when repoManager not available', async () => {
            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => [],
            });

            const result = await handler.executeSlashCommand('repos', '', {
                context: {},
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.error.includes('not available'));
        });

        it('should return message when no repositories configured', async () => {
            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('repos', '', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('No external repositories'));
        });

        it('should list configured repositories', async () => {
            // Create config with repos
            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'repo-1', source: '/path/1', type: 'local', localPath: '/path/1', enabled: true },
                    { name: 'repo-2', source: 'https://git.com/repo', type: 'git', localPath: '~/.skill-manager/repos/repo-2', enabled: false },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('repos', '', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('repo-1'));
            assert.ok(result.result.includes('repo-2'));
            assert.ok(result.result.includes('enabled'));
            assert.ok(result.result.includes('disabled'));
        });
    });

    describe('/add-repo command', () => {
        it('should return error when source not provided', async () => {
            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => [],
            });

            const result = await handler.executeSlashCommand('add-repo', '', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.error.includes('Usage'));
        });

        it('should add local path repository', async () => {
            // Create a valid local repo
            const localRepo = path.join(tempDir, 'local-skills');
            fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'skill'), { recursive: true });

            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            // Mock skilledAgent for reload
            const mockAgent = {
                reloadSkills: () => 5,
            };

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('add-repo', localRepo, {
                context: { repoManager, skilledAgent: mockAgent },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('added'));
            assert.ok(result.result.includes('reloaded'));
        });

        it('should add with custom name', async () => {
            const localRepo = path.join(tempDir, 'my-skills');
            fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'skill'), { recursive: true });

            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('add-repo', `${localRepo} custom-name`, {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('custom-name'));
        });

        it('should return error for invalid path', async () => {
            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => [],
            });

            const result = await handler.executeSlashCommand('add-repo', '/non/existent/path', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.error);
        });
    });

    describe('/remove-repo command', () => {
        it('should remove repository', async () => {
            // Create config with a repo
            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'test-repo', source: '/path', type: 'local', localPath: '/path', enabled: true },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('remove-repo', 'test-repo', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('removed'));
        });

        it('should return error for non-existent repository', async () => {
            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => [],
            });

            const result = await handler.executeSlashCommand('remove-repo', 'non-existent', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.error.includes('not found'));
        });

        it('should parse --delete flag', async () => {
            // Create a cloned repo directory
            const repoDir = path.join(globalReposDir, 'cloned-repo');
            fs.mkdirSync(repoDir, { recursive: true });
            fs.writeFileSync(path.join(repoDir, 'file.txt'), 'test');

            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'cloned-repo', source: 'https://git.com/repo', type: 'git', localPath: repoDir, enabled: true },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('remove-repo', 'cloned-repo --delete', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('deleted'));
            assert.strictEqual(fs.existsSync(repoDir), false);
        });
    });

    describe('/enable-repo command', () => {
        it('should enable a disabled repository', async () => {
            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'test-repo', source: '/path', type: 'local', enabled: false },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('enable-repo', 'test-repo', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('enabled'));
        });

        it('should return error for non-existent repository', async () => {
            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => [],
            });

            const result = await handler.executeSlashCommand('enable-repo', 'non-existent', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.error.includes('not found'));
        });
    });

    describe('/disable-repo command', () => {
        it('should disable an enabled repository', async () => {
            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'test-repo', source: '/path', type: 'local', enabled: true },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('disable-repo', 'test-repo', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('disabled'));
        });
    });

    describe('/update-repo command', () => {
        it('should return message when no git repos to update', async () => {
            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('update-repo', 'all', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('No git repositories'));
        });

        it('should return message for local path repos', async () => {
            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'local-repo', source: '/path', type: 'local', enabled: true },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const repoManager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const handler = new SlashCommandHandler({
                executeSkill: async () => {},
                getUserSkills: () => [],
                getSkills: () => [],
                getRepositories: () => repoManager.listRepositories(),
            });

            const result = await handler.executeSlashCommand('update-repo', 'local-repo', {
                context: { repoManager },
            });

            assert.strictEqual(result.handled, true);
            assert.ok(result.result.includes('local path'));
        });
    });
});

// ============================================================================
// Repository Command Completions Tests
// ============================================================================

describe('SlashCommandHandler - Repository Completions', () => {
    let SlashCommandHandler;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');
        SlashCommandHandler = module.SlashCommandHandler;
    });

    it('should suggest repository names for /remove-repo', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [
                { name: 'achilles-cli' },
                { name: 'shared-skills' },
                { name: 'local-skills' },
            ],
        });

        const [completions] = handler.getCompletions('/remove-repo ');

        assert.ok(completions.some(c => c.includes('achilles-cli')));
        assert.ok(completions.some(c => c.includes('shared-skills')));
        assert.ok(completions.some(c => c.includes('local-skills')));
    });

    it('should filter repository suggestions by prefix', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [
                { name: 'achilles-cli' },
                { name: 'shared-skills' },
                { name: 'local-skills' },
            ],
        });

        const [completions] = handler.getCompletions('/remove-repo sha');

        assert.strictEqual(completions.length, 1);
        assert.ok(completions[0].includes('shared-skills'));
    });

    it('should suggest "all" for /update-repo', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [
                { name: 'achilles-cli' },
            ],
        });

        const [completions] = handler.getCompletions('/update-repo ');

        assert.ok(completions.some(c => c.includes('all')));
        assert.ok(completions.some(c => c.includes('achilles-cli')));
    });

    it('should suggest repository names for /enable-repo', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [
                { name: 'disabled-repo' },
            ],
        });

        const [completions] = handler.getCompletions('/enable-repo ');

        assert.ok(completions.some(c => c.includes('disabled-repo')));
    });

    it('should suggest repository names for /disable-repo', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [
                { name: 'enabled-repo' },
            ],
        });

        const [completions] = handler.getCompletions('/disable-repo ');

        assert.ok(completions.some(c => c.includes('enabled-repo')));
    });

    it('should include repo commands in command completions', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [],
        });

        const [completions] = handler.getCompletions('/');

        assert.ok(completions.some(c => c.includes('repos')));
        assert.ok(completions.some(c => c.includes('add-repo')));
        assert.ok(completions.some(c => c.includes('remove-repo')));
        assert.ok(completions.some(c => c.includes('update-repo')));
    });
});

// ============================================================================
// Integration Test with RepoManager
// ============================================================================

describe('SlashCommandHandler + RepoManager Integration', () => {
    let SlashCommandHandler;
    let RepoManager;
    let tempDir;
    let globalReposDir;

    beforeEach(async () => {
        const slashModule = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');
        SlashCommandHandler = slashModule.SlashCommandHandler;

        const repoModule = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = repoModule.RepoManager;

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
        globalReposDir = path.join(tempDir, 'global-repos');
        fs.mkdirSync(globalReposDir, { recursive: true });
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should complete full workflow: add, list, disable, enable, remove', async () => {
        // Create a valid local repo
        const localRepo = path.join(tempDir, 'local-skills');
        fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'skill-1'), { recursive: true });
        fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'skill-2'), { recursive: true });

        const repoManager = new RepoManager({
            workingDir: tempDir,
            globalReposDir,
        });

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => repoManager.listRepositories(),
        });

        const context = { repoManager };

        // 1. Add repo
        const addResult = await handler.executeSlashCommand('add-repo', `${localRepo} my-skills`, { context });
        assert.strictEqual(addResult.handled, true);
        assert.ok(addResult.result.includes('added'));
        assert.ok(addResult.result.includes('2 skill(s)'));

        // 2. List repos - should show the new repo
        const listResult1 = await handler.executeSlashCommand('repos', '', { context });
        assert.ok(listResult1.result.includes('my-skills'));
        assert.ok(listResult1.result.includes('enabled'));

        // 3. Disable repo
        const disableResult = await handler.executeSlashCommand('disable-repo', 'my-skills', { context });
        assert.ok(disableResult.result.includes('disabled'));

        // 4. List repos - should show disabled
        const listResult2 = await handler.executeSlashCommand('repos', '', { context });
        assert.ok(listResult2.result.includes('disabled'));

        // 5. Enable repo
        const enableResult = await handler.executeSlashCommand('enable-repo', 'my-skills', { context });
        assert.ok(enableResult.result.includes('enabled'));

        // 6. Remove repo
        const removeResult = await handler.executeSlashCommand('remove-repo', 'my-skills', { context });
        assert.ok(removeResult.result.includes('removed'));

        // 7. List repos - should be empty
        const listResult3 = await handler.executeSlashCommand('repos', '', { context });
        assert.ok(listResult3.result.includes('No external repositories'));
    });
});

// ============================================================================
// /ls --repo Filter Tests
// ============================================================================

describe('SlashCommandHandler - /ls --repo filter', () => {
    let SlashCommandHandler;
    let RepoManager;
    let tempDir;
    let globalReposDir;

    beforeEach(async () => {
        const slashModule = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');
        SlashCommandHandler = slashModule.SlashCommandHandler;

        const repoModule = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = repoModule.RepoManager;

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-repo-test-'));
        globalReposDir = path.join(tempDir, 'global-repos');
        fs.mkdirSync(globalReposDir, { recursive: true });
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should filter skills by repository with /ls --repo', async () => {
        // Create a repo with skills
        const localRepo = path.join(tempDir, 'my-repo');
        const skillsPath = path.join(localRepo, '.AchillesSkills');
        fs.mkdirSync(path.join(skillsPath, 'repo-skill-1'), { recursive: true });
        fs.mkdirSync(path.join(skillsPath, 'repo-skill-2'), { recursive: true });

        // Create config with the repo
        const configPath = path.join(tempDir, '.skill-manager.json');
        const config = {
            version: 1,
            repositories: [{
                name: 'my-repo',
                source: localRepo,
                type: 'local',
                localPath: localRepo,
                skillsPath: skillsPath,
                enabled: true,
            }],
        };
        fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

        const repoManager = new RepoManager({
            workingDir: tempDir,
            globalReposDir,
        });

        // Mock skills - some from repo, some not
        const mockSkills = [
            { name: 'repo-skill-1', shortName: 'repo-skill-1', type: 'cskill', skillDir: `${skillsPath}/repo-skill-1`, summary: 'Repo skill 1' },
            { name: 'repo-skill-2', shortName: 'repo-skill-2', type: 'cskill', skillDir: `${skillsPath}/repo-skill-2`, summary: 'Repo skill 2' },
            { name: 'local-skill', shortName: 'local-skill', type: 'cskill', skillDir: '/some/other/path/local-skill', summary: 'Local skill' },
        ];

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => mockSkills,
            getSkills: () => mockSkills,
            getRepositories: () => repoManager.listRepositories(),
        });

        const result = await handler.executeSlashCommand('ls', '--repo my-repo', {
            context: { repoManager },
        });

        assert.strictEqual(result.handled, true);
        assert.ok(result.result.includes('repo-skill-1'), 'Should include repo-skill-1');
        assert.ok(result.result.includes('repo-skill-2'), 'Should include repo-skill-2');
        assert.ok(!result.result.includes('local-skill'), 'Should NOT include local-skill');
        assert.ok(result.result.includes('my-repo'), 'Should include repo name in header');
        assert.ok(result.result.includes('2'), 'Should show count of 2 skills');
    });

    it('should return error for non-existent repository', async () => {
        const repoManager = new RepoManager({
            workingDir: tempDir,
            globalReposDir,
        });

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [],
        });

        const result = await handler.executeSlashCommand('ls', '--repo non-existent', {
            context: { repoManager },
        });

        assert.strictEqual(result.handled, true);
        assert.ok(result.error.includes('not found'));
    });

    it('should return error for disabled repository', async () => {
        const configPath = path.join(tempDir, '.skill-manager.json');
        const config = {
            version: 1,
            repositories: [{
                name: 'disabled-repo',
                source: '/some/path',
                type: 'local',
                enabled: false,
            }],
        };
        fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

        const repoManager = new RepoManager({
            workingDir: tempDir,
            globalReposDir,
        });

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => repoManager.listRepositories(),
        });

        const result = await handler.executeSlashCommand('ls', '--repo disabled-repo', {
            context: { repoManager },
        });

        assert.strictEqual(result.handled, true);
        assert.ok(result.error.includes('disabled'));
    });

    it('should return message when no skills found in repository', async () => {
        const localRepo = path.join(tempDir, 'empty-repo');
        const skillsPath = path.join(localRepo, '.AchillesSkills');
        fs.mkdirSync(skillsPath, { recursive: true });

        const configPath = path.join(tempDir, '.skill-manager.json');
        const config = {
            version: 1,
            repositories: [{
                name: 'empty-repo',
                source: localRepo,
                type: 'local',
                localPath: localRepo,
                skillsPath: skillsPath,
                enabled: true,
            }],
        };
        fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

        const repoManager = new RepoManager({
            workingDir: tempDir,
            globalReposDir,
        });

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => repoManager.listRepositories(),
        });

        const result = await handler.executeSlashCommand('ls', '--repo empty-repo', {
            context: { repoManager },
        });

        assert.strictEqual(result.handled, true);
        assert.ok(result.result.includes('No skills found'));
    });

    it('should require repo name after --repo flag', async () => {
        const repoManager = new RepoManager({
            workingDir: tempDir,
            globalReposDir,
        });

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [],
        });

        const result = await handler.executeSlashCommand('ls', '--repo', {
            context: { repoManager },
        });

        assert.strictEqual(result.handled, true);
        assert.ok(result.error.includes('Usage'));
    });
});

// ============================================================================
// /ls --repo Completion Tests
// ============================================================================

describe('SlashCommandHandler - /ls --repo completions', () => {
    let SlashCommandHandler;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');
        SlashCommandHandler = module.SlashCommandHandler;
    });

    it('should suggest --repo option for /ls', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [{ name: 'my-repo', enabled: true }],
        });

        const [completions] = handler.getCompletions('/ls -');

        assert.ok(completions.some(c => c.includes('--repo')));
    });

    it('should suggest repository names after /ls --repo', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [
                { name: 'achilles-cli', enabled: true },
                { name: 'shared-skills', enabled: true },
                { name: 'disabled-repo', enabled: false },
            ],
        });

        const [completions] = handler.getCompletions('/ls --repo ');

        // Should only suggest enabled repos
        assert.ok(completions.some(c => c.includes('achilles-cli')));
        assert.ok(completions.some(c => c.includes('shared-skills')));
        assert.ok(!completions.some(c => c.includes('disabled-repo')));
    });

    it('should filter repository suggestions by prefix', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [
                { name: 'achilles-cli', enabled: true },
                { name: 'achilles-tools', enabled: true },
                { name: 'other-repo', enabled: true },
            ],
        });

        const [completions] = handler.getCompletions('/ls --repo ach');

        assert.ok(completions.some(c => c.includes('achilles-cli')));
        assert.ok(completions.some(c => c.includes('achilles-tools')));
        assert.ok(!completions.some(c => c.includes('other-repo')));
    });

    it('should suggest --repo after "all" option', () => {
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => [{ name: 'my-repo', enabled: true }],
        });

        const [completions] = handler.getCompletions('/ls all ');

        assert.ok(completions.some(c => c.includes('--repo')));
    });
});

// ============================================================================
// _syncAgentSkillRoots Tests
// ============================================================================

describe('SlashCommandHandler - _syncAgentSkillRoots', () => {
    let SlashCommandHandler;
    let RepoManager;
    let tempDir;
    let globalReposDir;

    beforeEach(async () => {
        const slashModule = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');
        SlashCommandHandler = slashModule.SlashCommandHandler;

        const repoModule = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = repoModule.RepoManager;

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-roots-test-'));
        globalReposDir = path.join(tempDir, 'global-repos');
        fs.mkdirSync(globalReposDir, { recursive: true });
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should add new repo skill roots to agent', async () => {
        // Create a repo with skills
        const localRepo = path.join(tempDir, 'new-repo');
        const skillsPath = path.join(localRepo, '.AchillesSkills');
        fs.mkdirSync(path.join(skillsPath, 'skill-1'), { recursive: true });

        const repoManager = new RepoManager({
            workingDir: tempDir,
            globalReposDir,
        });

        // Add repo
        await repoManager.addRepository({ source: localRepo, name: 'new-repo' });

        // Mock agent with getAdditionalSkillRoots
        const agentRoots = ['/built-in/.AchillesSkills'];
        const mockAgent = {
            getAdditionalSkillRoots: () => agentRoots,
            reloadSkills: () => {},
        };

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => repoManager.listRepositories(),
        });

        // Sync should add the new skill root
        handler._syncAgentSkillRoots(mockAgent, repoManager);

        assert.ok(agentRoots.includes(skillsPath), 'Agent roots should include new repo skills path');
        assert.strictEqual(agentRoots.length, 2, 'Should have 2 roots (built-in + repo)');
    });

    it('should remove disabled repo skill roots from agent', async () => {
        // Create a repo with skills
        const localRepo = path.join(tempDir, 'disabled-repo');
        const skillsPath = path.join(localRepo, '.AchillesSkills');
        fs.mkdirSync(path.join(skillsPath, 'skill-1'), { recursive: true });

        // Create config with disabled repo
        const configPath = path.join(tempDir, '.skill-manager.json');
        const config = {
            version: 1,
            repositories: [{
                name: 'disabled-repo',
                source: localRepo,
                type: 'local',
                localPath: localRepo,
                skillsPath: skillsPath,
                enabled: false, // disabled
            }],
        };
        fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

        const repoManager = new RepoManager({
            workingDir: tempDir,
            globalReposDir,
        });

        // Mock agent with the disabled repo already in roots
        const agentRoots = ['/built-in/.AchillesSkills', skillsPath];
        const mockAgent = {
            getAdditionalSkillRoots: () => agentRoots,
            reloadSkills: () => {},
        };

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => repoManager.listRepositories(),
        });

        // Sync should remove the disabled repo root
        handler._syncAgentSkillRoots(mockAgent, repoManager);

        assert.ok(!agentRoots.includes(skillsPath), 'Agent roots should NOT include disabled repo');
        assert.strictEqual(agentRoots.length, 1, 'Should have only built-in root');
    });

    it('should not duplicate existing skill roots', async () => {
        // Create a repo with skills
        const localRepo = path.join(tempDir, 'existing-repo');
        const skillsPath = path.join(localRepo, '.AchillesSkills');
        fs.mkdirSync(path.join(skillsPath, 'skill-1'), { recursive: true });

        const repoManager = new RepoManager({
            workingDir: tempDir,
            globalReposDir,
        });

        await repoManager.addRepository({ source: localRepo, name: 'existing-repo' });

        // Mock agent already has this root
        const agentRoots = ['/built-in/.AchillesSkills', skillsPath];
        const mockAgent = {
            getAdditionalSkillRoots: () => agentRoots,
            reloadSkills: () => {},
        };

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            getRepositories: () => repoManager.listRepositories(),
        });

        // Sync should not add duplicate
        handler._syncAgentSkillRoots(mockAgent, repoManager);

        assert.strictEqual(agentRoots.length, 2, 'Should still have 2 roots (no duplicates)');
    });
});
