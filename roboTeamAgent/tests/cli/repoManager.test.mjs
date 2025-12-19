/**
 * Tests for RepoManager module.
 *
 * Tests repository management functionality including config load/save,
 * repository validation, git operations, and skill root resolution.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// RepoManager Constructor Tests
// ============================================================================

describe('RepoManager', () => {
    let RepoManager;
    let tempDir;
    let globalReposDir;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = module.RepoManager;

        // Create temp directories for testing
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-test-'));
        globalReposDir = path.join(tempDir, 'global-repos');
        fs.mkdirSync(globalReposDir, { recursive: true });
    });

    afterEach(() => {
        // Clean up temp directory
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('Constructor', () => {
        it('should create instance with required options', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.ok(manager, 'RepoManager should be created');
            assert.strictEqual(manager.workingDir, tempDir);
            assert.strictEqual(manager.globalReposDir, globalReposDir);
        });

        it('should use default globalReposDir when not provided', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
            });

            assert.ok(manager.globalReposDir.includes('.skill-manager'));
        });

        it('should create default config when config file does not exist', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.deepStrictEqual(manager.config, {
                version: 1,
                repositories: [],
            });
        });

        it('should load existing config file', () => {
            // Create a config file first
            const configPath = path.join(tempDir, '.skill-manager.json');
            const existingConfig = {
                version: 1,
                repositories: [
                    { name: 'test-repo', source: '/some/path', type: 'local', enabled: true },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(existingConfig), 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.strictEqual(manager.config.repositories.length, 1);
            assert.strictEqual(manager.config.repositories[0].name, 'test-repo');
        });

        it('should handle corrupted config file gracefully', () => {
            // Create a corrupted config file
            const configPath = path.join(tempDir, '.skill-manager.json');
            fs.writeFileSync(configPath, 'not valid json {{{', 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            // Should fall back to default config
            assert.deepStrictEqual(manager.config, {
                version: 1,
                repositories: [],
            });
        });
    });

    describe('Config Operations', () => {
        it('should save config to file', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            manager.config.repositories.push({
                name: 'new-repo',
                source: '/path/to/repo',
                type: 'local',
                enabled: true,
            });

            manager.saveConfig();

            const configPath = path.join(tempDir, '.skill-manager.json');
            assert.ok(fs.existsSync(configPath), 'Config file should exist');

            const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assert.strictEqual(savedConfig.repositories.length, 1);
            assert.strictEqual(savedConfig.repositories[0].name, 'new-repo');
        });

        it('should preserve config version on save', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            manager.saveConfig();

            const configPath = path.join(tempDir, '.skill-manager.json');
            const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assert.strictEqual(savedConfig.version, 1);
        });
    });

    describe('isGitUrl', () => {
        it('should recognize https git URLs', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.strictEqual(manager.isGitUrl('https://github.com/user/repo.git'), true);
            assert.strictEqual(manager.isGitUrl('https://github.com/user/repo'), true);
            assert.strictEqual(manager.isGitUrl('https://gitlab.com/user/repo.git'), true);
        });

        it('should recognize SSH git URLs', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.strictEqual(manager.isGitUrl('git@github.com:user/repo.git'), true);
            assert.strictEqual(manager.isGitUrl('git@gitlab.com:user/repo.git'), true);
        });

        it('should recognize git:// protocol URLs', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.strictEqual(manager.isGitUrl('git://github.com/user/repo.git'), true);
        });

        it('should recognize URLs ending with .git', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.strictEqual(manager.isGitUrl('something.git'), true);
        });

        it('should not recognize local paths as git URLs', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.strictEqual(manager.isGitUrl('/path/to/local'), false);
            assert.strictEqual(manager.isGitUrl('./relative/path'), false);
            assert.strictEqual(manager.isGitUrl('~/home/path'), false);
            assert.strictEqual(manager.isGitUrl(''), false);
            assert.strictEqual(manager.isGitUrl(null), false);
        });
    });

    describe('generateRepoName', () => {
        it('should generate name from https git URL', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const name = manager.generateRepoName('https://github.com/OutfinityResearch/AchillesCLI.git');
            assert.strictEqual(name, 'outfinityresearch-achillescli');
        });

        it('should generate name from SSH git URL', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const name = manager.generateRepoName('git@github.com:user/my-repo.git');
            assert.strictEqual(name, 'user-my-repo');
        });

        it('should generate name from local path', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const name = manager.generateRepoName('/path/to/My-Skills_Repo');
            assert.strictEqual(name, 'my-skills-repo');
        });

        it('should sanitize special characters', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const name = manager.generateRepoName('/path/to/Skill@Repo#1.0');
            assert.ok(!name.includes('@'));
            assert.ok(!name.includes('#'));
            assert.ok(!name.includes('.'));
        });
    });

    describe('expandPath', () => {
        it('should expand ~ to home directory', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const expanded = manager.expandPath('~/some/path');
            assert.strictEqual(expanded, path.join(os.homedir(), 'some/path'));
        });

        it('should not modify absolute paths', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const expanded = manager.expandPath('/absolute/path');
            assert.strictEqual(expanded, '/absolute/path');
        });

        it('should not modify relative paths without ~', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const expanded = manager.expandPath('relative/path');
            assert.strictEqual(expanded, 'relative/path');
        });
    });

    describe('validateRepository', () => {
        it('should validate repository with .AchillesSkills at root', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            // Create a valid repo structure
            const repoPath = path.join(tempDir, 'valid-repo');
            const skillsPath = path.join(repoPath, '.AchillesSkills');
            const skillDir = path.join(skillsPath, 'my-skill');
            fs.mkdirSync(skillDir, { recursive: true });

            const result = manager.validateRepository(repoPath);
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.skillsPath, skillsPath);
            assert.strictEqual(result.skillCount, 1);
        });

        it('should validate repository with .AchillesSkills in subdirectory', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            // Create a repo with skills in a subdirectory
            const repoPath = path.join(tempDir, 'nested-repo');
            const subDir = path.join(repoPath, 'cli-project');
            const skillsPath = path.join(subDir, '.AchillesSkills');
            const skillDir = path.join(skillsPath, 'skill-one');
            fs.mkdirSync(skillDir, { recursive: true });

            const result = manager.validateRepository(repoPath);
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.skillsPath, skillsPath);
        });

        it('should return invalid for repository without .AchillesSkills', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            // Create a repo without skills
            const repoPath = path.join(tempDir, 'invalid-repo');
            fs.mkdirSync(repoPath, { recursive: true });
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });

            const result = manager.validateRepository(repoPath);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.skillsPath, null);
            assert.strictEqual(result.skillCount, 0);
        });

        it('should count skills correctly', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            // Create a repo with multiple skills
            const repoPath = path.join(tempDir, 'multi-skill-repo');
            const skillsPath = path.join(repoPath, '.AchillesSkills');
            fs.mkdirSync(path.join(skillsPath, 'skill-1'), { recursive: true });
            fs.mkdirSync(path.join(skillsPath, 'skill-2'), { recursive: true });
            fs.mkdirSync(path.join(skillsPath, 'skill-3'), { recursive: true });

            const result = manager.validateRepository(repoPath);
            assert.strictEqual(result.skillCount, 3);
        });
    });

    describe('listRepositories', () => {
        it('should return empty array when no repositories', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const repos = manager.listRepositories();
            assert.deepStrictEqual(repos, []);
        });

        it('should return list of repositories', () => {
            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'repo-1', source: '/path/1', type: 'local', enabled: true, addedAt: '2025-01-01' },
                    { name: 'repo-2', source: 'https://git.com/repo.git', type: 'git', enabled: false, addedAt: '2025-01-02' },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const repos = manager.listRepositories();
            assert.strictEqual(repos.length, 2);
            assert.strictEqual(repos[0].name, 'repo-1');
            assert.strictEqual(repos[1].name, 'repo-2');
            assert.strictEqual(repos[0].enabled, true);
            assert.strictEqual(repos[1].enabled, false);
        });
    });

    describe('setRepositoryEnabled', () => {
        it('should enable a disabled repository', () => {
            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'test-repo', source: '/path', type: 'local', enabled: false },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const result = manager.setRepositoryEnabled('test-repo', true);

            assert.strictEqual(result.success, true);
            assert.ok(result.message.includes('enabled'));
            assert.strictEqual(manager.config.repositories[0].enabled, true);
        });

        it('should disable an enabled repository', () => {
            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'test-repo', source: '/path', type: 'local', enabled: true },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const result = manager.setRepositoryEnabled('test-repo', false);

            assert.strictEqual(result.success, true);
            assert.ok(result.message.includes('disabled'));
            assert.strictEqual(manager.config.repositories[0].enabled, false);
        });

        it('should throw error for non-existent repository', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.throws(
                () => manager.setRepositoryEnabled('non-existent', true),
                /not found/
            );
        });
    });

    describe('removeRepository', () => {
        it('should remove repository from config', () => {
            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    { name: 'repo-to-remove', source: '/path', type: 'local', enabled: true },
                    { name: 'repo-to-keep', source: '/other', type: 'local', enabled: true },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const result = manager.removeRepository('repo-to-remove');

            assert.strictEqual(result.success, true);
            assert.strictEqual(manager.config.repositories.length, 1);
            assert.strictEqual(manager.config.repositories[0].name, 'repo-to-keep');
        });

        it('should delete cloned files when deleteFiles is true', () => {
            // Create a cloned repo directory
            const repoDir = path.join(globalReposDir, 'cloned-repo');
            fs.mkdirSync(repoDir, { recursive: true });
            fs.writeFileSync(path.join(repoDir, 'file.txt'), 'test');

            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    {
                        name: 'cloned-repo',
                        source: 'https://git.com/repo.git',
                        type: 'git',
                        localPath: repoDir,
                        enabled: true,
                    },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const result = manager.removeRepository('cloned-repo', true);

            assert.strictEqual(result.success, true);
            assert.ok(result.message.includes('deleted'));
            assert.strictEqual(fs.existsSync(repoDir), false);
        });

        it('should throw error for non-existent repository', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            assert.throws(
                () => manager.removeRepository('non-existent'),
                /not found/
            );
        });
    });

    describe('getEnabledSkillRoots', () => {
        it('should return empty array when no repositories', () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const roots = manager.getEnabledSkillRoots();
            assert.deepStrictEqual(roots, []);
        });

        it('should return skill paths for enabled repositories', () => {
            // Create a valid local repo
            const localRepo = path.join(tempDir, 'local-repo');
            const skillsPath = path.join(localRepo, '.AchillesSkills');
            fs.mkdirSync(path.join(skillsPath, 'skill-1'), { recursive: true });

            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    {
                        name: 'local-repo',
                        source: localRepo,
                        type: 'local',
                        localPath: localRepo,
                        skillsPath: skillsPath,
                        enabled: true,
                    },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const roots = manager.getEnabledSkillRoots();
            assert.strictEqual(roots.length, 1);
            assert.strictEqual(roots[0], skillsPath);
        });

        it('should exclude disabled repositories', () => {
            // Create valid local repos
            const enabledRepo = path.join(tempDir, 'enabled-repo');
            const disabledRepo = path.join(tempDir, 'disabled-repo');
            fs.mkdirSync(path.join(enabledRepo, '.AchillesSkills', 'skill'), { recursive: true });
            fs.mkdirSync(path.join(disabledRepo, '.AchillesSkills', 'skill'), { recursive: true });

            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    {
                        name: 'enabled-repo',
                        source: enabledRepo,
                        type: 'local',
                        localPath: enabledRepo,
                        skillsPath: path.join(enabledRepo, '.AchillesSkills'),
                        enabled: true,
                    },
                    {
                        name: 'disabled-repo',
                        source: disabledRepo,
                        type: 'local',
                        localPath: disabledRepo,
                        skillsPath: path.join(disabledRepo, '.AchillesSkills'),
                        enabled: false,
                    },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const roots = manager.getEnabledSkillRoots();
            assert.strictEqual(roots.length, 1);
            assert.ok(roots[0].includes('enabled-repo'));
        });

        it('should discover skillsPath when not set', () => {
            // Create a valid local repo without skillsPath in config
            const localRepo = path.join(tempDir, 'discover-repo');
            const skillsPath = path.join(localRepo, '.AchillesSkills');
            fs.mkdirSync(path.join(skillsPath, 'skill-1'), { recursive: true });

            const configPath = path.join(tempDir, '.skill-manager.json');
            const config = {
                version: 1,
                repositories: [
                    {
                        name: 'discover-repo',
                        source: localRepo,
                        type: 'local',
                        localPath: localRepo,
                        // Note: skillsPath not set
                        enabled: true,
                    },
                ],
            };
            fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const roots = manager.getEnabledSkillRoots();
            assert.strictEqual(roots.length, 1);
            assert.strictEqual(roots[0], skillsPath);
        });
    });

    describe('addRepository - local paths', () => {
        it('should add local path repository', async () => {
            // Create a valid local repo
            const localRepo = path.join(tempDir, 'local-skills');
            const skillsPath = path.join(localRepo, '.AchillesSkills');
            fs.mkdirSync(path.join(skillsPath, 'skill-1'), { recursive: true });
            fs.mkdirSync(path.join(skillsPath, 'skill-2'), { recursive: true });

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const result = await manager.addRepository({
                source: localRepo,
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.skillCount, 2);
            assert.strictEqual(manager.config.repositories.length, 1);
            assert.strictEqual(manager.config.repositories[0].type, 'local');
        });

        it('should add local path with custom name', async () => {
            const localRepo = path.join(tempDir, 'my-skills');
            fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'skill'), { recursive: true });

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            const result = await manager.addRepository({
                source: localRepo,
                name: 'custom-name',
            });

            assert.strictEqual(result.name, 'custom-name');
            assert.strictEqual(manager.config.repositories[0].name, 'custom-name');
        });

        it('should reject non-existent path', async () => {
            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            await assert.rejects(
                () => manager.addRepository({ source: '/non/existent/path' }),
                /does not exist/
            );
        });

        it('should reject path without .AchillesSkills', async () => {
            const noSkillsPath = path.join(tempDir, 'no-skills');
            fs.mkdirSync(noSkillsPath, { recursive: true });

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            await assert.rejects(
                () => manager.addRepository({ source: noSkillsPath }),
                /No skills found/
            );
        });

        it('should reject duplicate repository name', async () => {
            const localRepo1 = path.join(tempDir, 'repo1');
            const localRepo2 = path.join(tempDir, 'repo2');
            fs.mkdirSync(path.join(localRepo1, '.AchillesSkills', 'skill'), { recursive: true });
            fs.mkdirSync(path.join(localRepo2, '.AchillesSkills', 'skill'), { recursive: true });

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            await manager.addRepository({ source: localRepo1, name: 'same-name' });

            await assert.rejects(
                () => manager.addRepository({ source: localRepo2, name: 'same-name' }),
                /already exists/
            );
        });

        it('should allow force overwrite of existing repository', async () => {
            const localRepo1 = path.join(tempDir, 'repo1');
            const localRepo2 = path.join(tempDir, 'repo2');
            fs.mkdirSync(path.join(localRepo1, '.AchillesSkills', 'skill'), { recursive: true });
            fs.mkdirSync(path.join(localRepo2, '.AchillesSkills', 'skill-a'), { recursive: true });
            fs.mkdirSync(path.join(localRepo2, '.AchillesSkills', 'skill-b'), { recursive: true });

            const manager = new RepoManager({
                workingDir: tempDir,
                globalReposDir,
            });

            await manager.addRepository({ source: localRepo1, name: 'same-name' });
            const result = await manager.addRepository({ source: localRepo2, name: 'same-name', force: true });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.skillCount, 2); // repo2 has 2 skills
            assert.strictEqual(manager.config.repositories.length, 1);
        });
    });
});

// ============================================================================
// Git Operations Tests (mocked)
// ============================================================================

describe('RepoManager - Git URL Detection', () => {
    let RepoManager;
    let tempDir;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = module.RepoManager;
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should recognize various git URL formats', () => {
        const manager = new RepoManager({
            workingDir: tempDir,
            globalReposDir: path.join(tempDir, 'repos'),
        });

        const gitUrls = [
            'https://github.com/user/repo.git',
            'https://github.com/user/repo',
            'http://github.com/user/repo.git',
            'git@github.com:user/repo.git',
            'git://github.com/user/repo.git',
            'https://gitlab.com/group/project.git',
            'git@bitbucket.org:team/repo.git',
        ];

        for (const url of gitUrls) {
            assert.strictEqual(manager.isGitUrl(url), true, `Should recognize ${url} as git URL`);
        }
    });

    it('should not recognize local paths as git URLs', () => {
        const manager = new RepoManager({
            workingDir: tempDir,
            globalReposDir: path.join(tempDir, 'repos'),
        });

        const localPaths = [
            '/home/user/projects/skills',
            './relative/path',
            '../parent/path',
            '~/home/skills',
            'C:\\Windows\\Path',
            'just-a-name',
        ];

        for (const localPath of localPaths) {
            assert.strictEqual(manager.isGitUrl(localPath), false, `Should not recognize ${localPath} as git URL`);
        }
    });
});

// ============================================================================
// Repository Name Generation Tests
// ============================================================================

describe('RepoManager - Name Generation', () => {
    let RepoManager;
    let tempDir;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = module.RepoManager;
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'name-test-'));
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should generate consistent names from git URLs', () => {
        const manager = new RepoManager({
            workingDir: tempDir,
            globalReposDir: path.join(tempDir, 'repos'),
        });

        const testCases = [
            { url: 'https://github.com/facebook/react.git', expected: 'facebook-react' },
            { url: 'git@github.com:microsoft/vscode.git', expected: 'microsoft-vscode' },
            { url: 'https://gitlab.com/gitlab-org/gitlab.git', expected: 'gitlab-org-gitlab' },
        ];

        for (const { url, expected } of testCases) {
            const name = manager.generateRepoName(url);
            assert.strictEqual(name, expected, `Name for ${url}`);
        }
    });

    it('should generate lowercase names', () => {
        const manager = new RepoManager({
            workingDir: tempDir,
            globalReposDir: path.join(tempDir, 'repos'),
        });

        const name = manager.generateRepoName('https://github.com/User/MyRepo.git');
        assert.strictEqual(name, name.toLowerCase());
    });

    it('should replace non-alphanumeric characters with hyphens', () => {
        const manager = new RepoManager({
            workingDir: tempDir,
            globalReposDir: path.join(tempDir, 'repos'),
        });

        const name = manager.generateRepoName('/path/to/Skill_Repo@v1.0');
        assert.ok(!name.includes('_'));
        assert.ok(!name.includes('@'));
        assert.ok(!name.includes('.'));
    });
});

// ============================================================================
// Config Migration Tests
// ============================================================================

describe('RepoManager - Config Migration', () => {
    let RepoManager;
    let tempDir;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = module.RepoManager;
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should migrate config without version', () => {
        const configPath = path.join(tempDir, '.skill-manager.json');
        const oldConfig = {
            repositories: [
                { name: 'old-repo', source: '/path' },
            ],
        };
        fs.writeFileSync(configPath, JSON.stringify(oldConfig), 'utf8');

        const manager = new RepoManager({
            workingDir: tempDir,
            globalReposDir: path.join(tempDir, 'repos'),
        });

        assert.strictEqual(manager.config.version, 1);
        assert.strictEqual(manager.config.repositories.length, 1);
    });
});

// ============================================================================
// Editable Flag Tests
// ============================================================================

describe('RepoManager - Editable Flag', () => {
    let RepoManager;
    let tempDir;
    let globalReposDir;

    beforeEach(async () => {
        const module = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = module.RepoManager;
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editable-test-'));
        globalReposDir = path.join(tempDir, 'global-repos');
        fs.mkdirSync(globalReposDir, { recursive: true });
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should default editable to false when adding repository', async () => {
        const localRepo = path.join(tempDir, 'local-repo');
        fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'my-skill'), { recursive: true });

        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });
        await manager.addRepository({ source: localRepo, name: 'test-repo' });

        const repos = manager.listRepositories();
        assert.strictEqual(repos.length, 1);
        assert.strictEqual(repos[0].editable, false);
    });

    it('should set editable to true when --editable flag is passed', async () => {
        const localRepo = path.join(tempDir, 'local-repo');
        fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'my-skill'), { recursive: true });

        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });
        await manager.addRepository({ source: localRepo, name: 'test-repo', editable: true });

        const repos = manager.listRepositories();
        assert.strictEqual(repos.length, 1);
        assert.strictEqual(repos[0].editable, true);
    });

    it('should toggle editable status with setRepositoryEditable', async () => {
        const localRepo = path.join(tempDir, 'local-repo');
        fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'my-skill'), { recursive: true });

        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });
        await manager.addRepository({ source: localRepo, name: 'test-repo' });

        // Initially not editable
        let repos = manager.listRepositories();
        assert.strictEqual(repos[0].editable, false);

        // Enable editing
        const result1 = manager.setRepositoryEditable('test-repo', true);
        assert.strictEqual(result1.success, true);
        repos = manager.listRepositories();
        assert.strictEqual(repos[0].editable, true);

        // Disable editing
        const result2 = manager.setRepositoryEditable('test-repo', false);
        assert.strictEqual(result2.success, true);
        repos = manager.listRepositories();
        assert.strictEqual(repos[0].editable, false);
    });

    it('should throw error when setting editable on non-existent repo', () => {
        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });

        assert.throws(
            () => manager.setRepositoryEditable('non-existent', true),
            /not found/
        );
    });

    it('should include editable field in listRepositories output', async () => {
        const localRepo = path.join(tempDir, 'local-repo');
        fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'my-skill'), { recursive: true });

        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });
        await manager.addRepository({ source: localRepo, name: 'test-repo' });

        const repos = manager.listRepositories();
        assert.ok('editable' in repos[0], 'listRepositories should include editable field');
    });

    it('should return only editable repos from getEditableSkillRoots', async () => {
        const repo1 = path.join(tempDir, 'repo1');
        const repo2 = path.join(tempDir, 'repo2');
        fs.mkdirSync(path.join(repo1, '.AchillesSkills', 'skill1'), { recursive: true });
        fs.mkdirSync(path.join(repo2, '.AchillesSkills', 'skill2'), { recursive: true });

        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });
        await manager.addRepository({ source: repo1, name: 'repo1', editable: false });
        await manager.addRepository({ source: repo2, name: 'repo2', editable: true });

        const editableRoots = manager.getEditableSkillRoots();
        assert.strictEqual(editableRoots.length, 1);
        assert.ok(editableRoots[0].includes('repo2'));
    });

    it('should return all enabled repos from getEnabledSkillRoots', async () => {
        const repo1 = path.join(tempDir, 'repo1');
        const repo2 = path.join(tempDir, 'repo2');
        fs.mkdirSync(path.join(repo1, '.AchillesSkills', 'skill1'), { recursive: true });
        fs.mkdirSync(path.join(repo2, '.AchillesSkills', 'skill2'), { recursive: true });

        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });
        await manager.addRepository({ source: repo1, name: 'repo1', editable: false });
        await manager.addRepository({ source: repo2, name: 'repo2', editable: true });

        const enabledRoots = manager.getEnabledSkillRoots();
        assert.strictEqual(enabledRoots.length, 2); // Both are enabled, regardless of editable
    });

    it('should correctly identify skill repo info with getSkillRepoInfo', async () => {
        const localRepo = path.join(tempDir, 'local-repo');
        const skillsPath = path.join(localRepo, '.AchillesSkills');
        fs.mkdirSync(path.join(skillsPath, 'my-skill'), { recursive: true });

        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });
        await manager.addRepository({ source: localRepo, name: 'test-repo', editable: false });

        // Skill from non-editable repo
        const skillDir = path.join(skillsPath, 'my-skill');
        const info = manager.getSkillRepoInfo(skillDir);
        assert.strictEqual(info.isFromRepo, true);
        assert.strictEqual(info.repoName, 'test-repo');
        assert.strictEqual(info.editable, false);

        // Enable editing
        manager.setRepositoryEditable('test-repo', true);
        const info2 = manager.getSkillRepoInfo(skillDir);
        assert.strictEqual(info2.editable, true);
    });

    it('should treat non-repo skills as editable', () => {
        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });

        // Skill not from any repo
        const localSkillDir = path.join(tempDir, 'local-skills', 'my-skill');
        const info = manager.getSkillRepoInfo(localSkillDir);
        assert.strictEqual(info.isFromRepo, false);
        assert.strictEqual(info.editable, true);
    });

    it('should persist editable status across restarts', async () => {
        const localRepo = path.join(tempDir, 'local-repo');
        fs.mkdirSync(path.join(localRepo, '.AchillesSkills', 'my-skill'), { recursive: true });

        // First instance - add repo with editable
        const manager1 = new RepoManager({ workingDir: tempDir, globalReposDir });
        await manager1.addRepository({ source: localRepo, name: 'test-repo', editable: true });

        // Second instance - should load persisted config
        const manager2 = new RepoManager({ workingDir: tempDir, globalReposDir });
        const repos = manager2.listRepositories();
        assert.strictEqual(repos[0].editable, true);
    });

    it('should treat missing editable field as false (backward compatibility)', () => {
        // Create config without editable field
        const configPath = path.join(tempDir, '.skill-manager.json');
        const oldConfig = {
            version: 1,
            repositories: [
                { name: 'old-repo', source: '/path', type: 'local', enabled: true },
            ],
        };
        fs.writeFileSync(configPath, JSON.stringify(oldConfig), 'utf8');

        const manager = new RepoManager({ workingDir: tempDir, globalReposDir });
        const repos = manager.listRepositories();

        // Should default to false when editable field is missing
        assert.strictEqual(repos[0].editable, false);
    });
});
