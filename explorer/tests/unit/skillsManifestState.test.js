import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import syncFs from 'node:fs';

import { syncManagedSkillExports } from '../../utils/server/managed-skill-exports.mjs';
import * as transaction from '../../utils/server/skill-export-transaction.mjs';
import { createToolHandlers } from '../../utils/server/tool-handlers.mjs';

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

function parseJsonResponse(response) {
  return JSON.parse(response.content.find((entry) => entry.type === 'text').text);
}

function objectSchema(requiredKeys) {
  return {
    safeParse(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { success: false, error: 'Expected object.' };
      }
      for (const key of requiredKeys) {
        if (typeof value[key] !== 'string') {
          return { success: false, error: `Expected string property ${key}.` };
        }
      }
      return { success: true, data: value };
    }
  };
}

function createMinimalSchemas() {
  const AnyObjectSchema = { safeParse: (value) => ({ success: true, data: value || {} }) };
  return {
    ReadTextFileArgsSchema: AnyObjectSchema,
    ReadMediaFileArgsSchema: AnyObjectSchema,
    ReadMultipleFilesArgsSchema: AnyObjectSchema,
    WriteFileArgsSchema: AnyObjectSchema,
    WriteBinaryFileArgsSchema: AnyObjectSchema,
    EditFileArgsSchema: AnyObjectSchema,
    CreateDirectoryArgsSchema: AnyObjectSchema,
    DeleteFileArgsSchema: AnyObjectSchema,
    DeleteDirectoryArgsSchema: AnyObjectSchema,
    ListDirectoryArgsSchema: AnyObjectSchema,
    ListDirectoryWithSizesArgsSchema: AnyObjectSchema,
    ListDirectoryDetailedArgsSchema: AnyObjectSchema,
    DirectoryTreeArgsSchema: AnyObjectSchema,
    MoveFileArgsSchema: AnyObjectSchema,
    CopyFileArgsSchema: AnyObjectSchema,
    SearchFilesArgsSchema: AnyObjectSchema,
    SearchTextArgsSchema: AnyObjectSchema,
    SearchTextStatusArgsSchema: AnyObjectSchema,
    SearchTextCancelArgsSchema: AnyObjectSchema,
    ReplaceTextArgsSchema: AnyObjectSchema,
    GetFileInfoArgsSchema: AnyObjectSchema,
    CollectIDEPluginsArgsSchema: AnyObjectSchema,
    GetPluginSettingsArgsSchema: AnyObjectSchema,
    SetPluginEnabledArgsSchema: AnyObjectSchema,
    ReadSkillsManifestStateArgsSchema: objectSchema(['folderPath']),
    AddSkillsManifestRepoArgsSchema: AnyObjectSchema,
    SetSkillsManifestSkillEnabledArgsSchema: AnyObjectSchema,
    RemoveSkillsManifestRepoArgsSchema: AnyObjectSchema
  };
}

async function createLocalSkillRepo(rootDir) {
  const repoDir = path.join(rootDir, 'source-skill-repo');
  await writeFile(path.join(repoDir, 'skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\n---\n');
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
  return repoDir;
}

async function createNonAnthropicSkillRepo(rootDir) {
  const repoDir = path.join(rootDir, 'source-code-skill-repo');
  await writeFile(path.join(repoDir, 'skills', 'code-skill', 'cskill.md'), '# code-skill\n');
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
  return repoDir;
}

async function createAchillesCopilotBasicSkillsRepo(rootDir) {
  const repoDir = path.join(rootDir, 'source-AchillesCopilotBasicSkills');
  const skills = [
    'achilles-specs',
    'antropic-skill-build',
    'article-build',
    'create-akus',
    'cskill-build',
    'dgskill-build',
    'gamp-specs',
    'manage-ploinky-agents',
    'oskill-build',
    'review-specs'
  ];
  for (const skill of skills) {
    await writeFile(path.join(repoDir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
  }
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
  return { repoDir, skills };
}

function createHandlers(workspaceRoot, invalidated = []) {
  return createToolHandlers(handlerOptions(workspaceRoot, invalidated));
}

function handlerOptions(workspaceRoot, invalidated = []) {
  return {
    fs,
    path,
    schemas: createMinimalSchemas(),
    validatePath: async (value) => {
      const resolved = path.resolve(String(value || ''));
      const root = path.resolve(workspaceRoot);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error('Path is outside workspace root.');
      }
      return resolved;
    },
    workspaceRoot,
    invalidateCachesForPath(value) { invalidated.push(value); },
    readFileWithCache() {},
    listDirectoryDetailedWithCache() {},
    indexDirectory() {},
    invalidateStructureIndexSubtree() {},
    formatSize() {},
    getFileStats() {},
    applyFileEdits() {},
    tailFile() {},
    headFile() {},
    writeFileContent() {},
    copyRecursive() {},
    aggregateIdePlugins() {},
    buildDirectoryTree() {},
    directoryTreeCache: new Map(),
    buildCacheKey() {},
    searchFilesCache: new Map(),
    searchTextCache: new Map(),
    searchFilesWithinWorkspace() {},
    searchTextWithinWorkspace() {},
    replaceTextWithinWorkspace() {},
    MAX_TEXT_SEARCH_FILE_BYTES: 1024,
    SEARCH_TEXT_TIMEOUT_MS: 1000,
    REPLACE_TEXT_TIMEOUT_MS: 1000,
    DEFAULT_DIRECTORY_TREE_MAX_DEPTH: 4,
    DEFAULT_DIRECTORY_TREE_MAX_NODES: 100,
    getAllowedDirectories: () => [workspaceRoot]
  };
}

test('read_skills_manifest_state caches existing manifest repositories and lists available skills', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-manifest-'));
  try {
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    await writeFile(path.join(workspaceRoot, 'ploinky', 'cli', 'utils', 'repos.js'), `
export function getPredefinedRepos() { return {}; }
export function getRepoSources() { return {}; }
export function getInstalledRepos() { return []; }
export function classifyRepoKind() { return 'unknown'; }
`);
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'ploinky-skills-manifest.json'), JSON.stringify([{
      url: repoDir,
      name: 'local-skills',
      branch: null,
      skills: ['alpha-skill']
    }], null, 2));

    const handlers = createHandlers(workspaceRoot);
    const state = parseJsonResponse(await handlers.read_skills_manifest_state({ folderPath: projectDir }));

    assert.equal(state.repositories.length, 1);
    assert.equal(state.repositories[0].name, 'local-skills');
    assert.equal(state.repositories[0].cached, true);
    assert.deepEqual(state.repositories[0].availableSkills, ['alpha-skill']);
    assert.deepEqual(state.repositories[0].skills, ['alpha-skill']);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('read_skills_manifest_state recognizes AchillesCopilotBasicSkills from an existing manifest', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-manifest-achilles-'));
  try {
    const { repoDir, skills } = await createAchillesCopilotBasicSkillsRepo(workspaceRoot);
    await writeFile(path.join(workspaceRoot, 'ploinky', 'cli', 'utils', 'repos.js'), `
export function getPredefinedRepos() {
  return {
    AchillesCopilotBasicSkills: {
      url: '${repoDir.replaceAll('\\', '\\\\')}',
      description: 'Default Anthropic-style skill catalog (SKILL.md folders)',
      kind: 'skills'
    }
  };
}
export function getRepoSources() { return {}; }
export function getInstalledRepos() { return ['AchillesCopilotBasicSkills']; }
export function classifyRepoKind() { return 'skills'; }
`);
    const projectDir = path.join(workspaceRoot, 'achilles-cli-test');
    await fs.mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'ploinky-skills-manifest.json'), JSON.stringify([{
      url: repoDir,
      name: 'AchillesCopilotBasicSkills',
      branch: null,
      skills
    }], null, 2));

    const handlers = createHandlers(workspaceRoot);
    const state = parseJsonResponse(await handlers.read_skills_manifest_state({ folderPath: projectDir }));

    assert.equal(state.repositories.length, 1);
    assert.equal(state.repositories[0].name, 'AchillesCopilotBasicSkills');
    assert.equal(state.repositories[0].cached, true);
    assert.deepEqual(state.repositories[0].availableSkills, skills);
    assert.deepEqual(state.repositories[0].skills, skills);
    assert.equal(state.skillRepositories[0].name, 'AchillesCopilotBasicSkills');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('add_skills_manifest_repo resolves a known repository through the current Ploinky utils layout', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-manifest-add-'));
  try {
    const { repoDir, skills } = await createAchillesCopilotBasicSkillsRepo(workspaceRoot);
    await writeFile(path.join(workspaceRoot, 'ploinky', 'cli', 'utils', 'repos.js'), `
export function getPredefinedRepos() {
  return {
    AchillesCopilotBasicSkills: {
      url: '${repoDir.replaceAll('\\', '\\\\')}',
      description: 'Default Anthropic-style skill catalog (SKILL.md folders)',
      kind: 'skills'
    }
  };
}
export function getRepoSources() { return {}; }
export function getInstalledRepos() { return []; }
export function classifyRepoKind() { return 'skills'; }
`);
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    const handlers = createHandlers(workspaceRoot);
    const state = parseJsonResponse(await handlers.add_skills_manifest_repo({
      folderPath: projectDir,
      url: 'AchillesCopilotBasicSkills',
      name: 'AchillesCopilotBasicSkills'
    }));

    assert.equal(state.ok, true);
    assert.equal(state.added, true);
    assert.equal(state.cached, true);
    assert.equal(state.message, 'AchillesCopilotBasicSkills added.');
    assert.deepEqual(state.repositories[0].skills, skills);
    assert.deepEqual(state.installedSkills, skills);
    const manifest = JSON.parse(await fs.readFile(path.join(projectDir, 'ploinky-skills-manifest.json'), 'utf8'));
    assert.equal(manifest[0].url, repoDir);
    for (const skill of skills) {
      const installedSkill = await fs.stat(path.join(projectDir, '.agents', 'skills', skill, 'SKILL.md'));
      assert.equal(installedSkill.isFile(), true);
    }
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('add_skills_manifest_repo explains when a cached repository has no Anthropic skills', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-manifest-non-anthropic-'));
  try {
    const repoDir = await createNonAnthropicSkillRepo(workspaceRoot);
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });

    const handlers = createHandlers(workspaceRoot);
    const result = parseJsonResponse(await handlers.add_skills_manifest_repo({
      folderPath: projectDir,
      url: `file://${repoDir}`,
      name: 'code-skills-only'
    }));

    assert.equal(result.ok, true);
    assert.equal(result.added, false);
    assert.equal(result.cached, true);
    assert.match(result.message, /cached but was not added.*no Anthropic skills were found/i);

    const cachedRepo = await fs.stat(path.join(workspaceRoot, '.ploinky', 'repos', 'code-skills-only'));
    assert.equal(cachedRepo.isDirectory(), true);
    await assert.rejects(
      fs.stat(path.join(projectDir, 'ploinky-skills-manifest.json')),
      (error) => error?.code === 'ENOENT'
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('manifest exports preserve legacy collisions, unrelated skills and independent Claude files', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-preserve-'));
  try {
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    const projectDir = path.join(workspaceRoot, 'project');
    const localFile = path.join(projectDir, '.agents', 'skills', 'alpha-skill', 'SKILL.md');
    await writeFile(localFile, 'local alpha');
    await writeFile(path.join(projectDir, '.agents', 'skills', 'unrelated', 'SKILL.md'), 'local unrelated');
    await writeFile(path.join(projectDir, '.claude', 'skills', 'independent', 'SKILL.md'), 'independent Claude');
    const handlers = createHandlers(workspaceRoot);
    const added = parseJsonResponse(await handlers.add_skills_manifest_repo({ folderPath: projectDir, url: `file://${repoDir}`, name: 'local-skills' }));
    assert.equal(await fs.readFile(localFile, 'utf8'), 'local alpha');
    assert.equal(added.exportResult.diagnostics[0].reason, 'unrecorded-output-preserved');
    assert.equal(added.skillOutputs.find((item) => item.name === 'alpha-skill').state, 'local');
    assert.equal(await fs.readFile(path.join(projectDir, '.claude', 'skills', 'independent', 'SKILL.md'), 'utf8'), 'independent Claude');
    const removed = parseJsonResponse(await handlers.remove_skills_manifest_repo({ folderPath: projectDir, repoName: 'local-skills' }));
    assert.deepEqual(removed.installedSkills, ['alpha-skill', 'unrelated']);
    assert.equal(await fs.readFile(localFile, 'utf8'), 'local alpha');
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('edited owned descriptor and executable modes survive replacement and removal with diagnostics', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-owned-'));
  try {
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir);
    const handlers = createHandlers(workspaceRoot);
    const args = { folderPath: projectDir, url: `file://${repoDir}`, name: 'local-skills' };
    await handlers.add_skills_manifest_repo(args);
    // Recreate an owned copy from the previous export format before testing migration protection.
    await fs.unlink(path.join(projectDir, '.agents', 'skills', 'alpha-skill'));
    await fs.unlink(path.join(projectDir, '.agents', '.ploinky-skill-exports.json'));
    syncManagedSkillExports({ folder: projectDir, owner: 'manifest', sources: [{ name: 'alpha-skill', path: path.join(repoDir, 'skills/alpha-skill') }] });
    const output = path.join(projectDir, '.agents', 'skills', 'alpha-skill', 'SKILL.md');
    const original = await fs.readFile(output, 'utf8');
    await fs.chmod(output, 0o755);
    const update = parseJsonResponse(await handlers.add_skills_manifest_repo(args));
    assert.equal(update.exportResult.diagnostics[0].reason, 'edited-output-preserved');
    assert.equal((await fs.stat(output)).mode & 0o777, 0o755);
    await fs.writeFile(output, original.replace('alpha-skill', 'local-skill'));
    const removed = parseJsonResponse(await handlers.remove_skills_manifest_repo({ folderPath: projectDir, repoName: 'local-skills' }));
    assert.equal(removed.skillOutputs[0].state, 'modified');
    assert.match(await fs.readFile(output, 'utf8'), /local-skill/);
    assert.equal(removed.exportResult.diagnostics[0].reason, 'edited-output-preserved');
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('unchanged owned output is removed alone and retired content is retained outside the skill root', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-remove-'));
  try {
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    const projectDir = path.join(workspaceRoot, 'project');
    await writeFile(path.join(projectDir, '.agents', 'skills', 'local', 'SKILL.md'), 'keep');
    const handlers = createHandlers(workspaceRoot);
    await handlers.add_skills_manifest_repo({ folderPath: projectDir, url: `file://${repoDir}`, name: 'local-skills' });
    const removed = parseJsonResponse(await handlers.set_skills_manifest_skill_enabled({ folderPath: projectDir, repoName: 'local-skills', skill: 'alpha-skill', enabled: false }));
    assert.deepEqual(removed.installedSkills, ['local']);
    assert.deepEqual(removed.exportResult.removed, ['alpha-skill']);
    assert.equal(removed.exportResult.backups.length, 1);
    assert.match(await fs.readFile(path.join(removed.exportResult.backups[0], 'SKILL.md'), 'utf8'), /alpha-skill/);
    assert.equal(await fs.readFile(path.join(projectDir, '.agents', 'skills', 'local', 'SKILL.md'), 'utf8'), 'keep');
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('same-name exports from two repositories are rejected without a traversal-order winner', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-duplicate-'));
  try {
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    const secondRepo = path.join(workspaceRoot, 'second-repo');
    await fs.cp(repoDir, secondRepo, { recursive: true });
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir);
    const handlers = createHandlers(workspaceRoot);
    await handlers.add_skills_manifest_repo({ folderPath: projectDir, url: `file://${repoDir}`, name: 'first' });
    await assert.rejects(handlers.add_skills_manifest_repo({ folderPath: projectDir, url: `file://${secondRepo}`, name: 'second' }), /Duplicate exported skill name/);
    const state = parseJsonResponse(await handlers.read_skills_manifest_state({ folderPath: projectDir }));
    assert.deepEqual(state.repositories.map((entry) => entry.name), ['first']);
    assert.equal(state.skillOutputs[0].source.name, 'first');
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('skillset controls batch symlink exports, prefer workspace sources and preserve local files', async () => {
  const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skillsets-')));
  try {
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    await writeFile(path.join(repoDir, 'skills', 'beta-skill', 'SKILL.md'), '---\nname: beta-skill\n---\n');
    await writeFile(path.join(repoDir, 'skillsets.md'), '# reports\n## Description\nWrite reports\n## Skills\n- alpha-skill\n- beta-skill\n\n# reading\n## Description\nRead\n## Skills\n- alpha-skill\n');
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir);
    const invalidated = [];
    const handlers = createHandlers(workspaceRoot, invalidated);
    const add = parseJsonResponse(await handlers.add_skills_manifest_repo({ folderPath: projectDir, url: `file://${repoDir}`, name: path.basename(repoDir) }));
    assert.equal(add.repositories[0].repoPath, repoDir);
    const alpha = path.join(projectDir, '.agents/skills/alpha-skill');
    const beta = path.join(projectDir, '.agents/skills/beta-skill');
    assert.equal((await fs.lstat(alpha)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(alpha), path.relative(path.dirname(alpha), path.join(repoDir, 'skills/alpha-skill')));
    assert.equal(path.isAbsolute(await fs.readlink(alpha)), false);
    await writeFile(path.join(repoDir, 'skills/alpha-skill/helper.txt'), 'live source');
    assert.equal(await fs.readFile(path.join(alpha, 'helper.txt'), 'utf8'), 'live source');
    const args = { folderPath: projectDir, repoName: path.basename(repoDir), skillset: 'reading', enabled: false };
    invalidated.length = 0;
    const off = parseJsonResponse(await handlers.set_skills_manifest_skill_enabled(args));
    assert.equal(off.repositories[0].skillsets[0].partial, true);
    assert.ok(invalidated.includes(alpha), 'removed skill cache is invalidated');
    assert.ok(invalidated.includes(path.dirname(alpha)), 'skills listing cache is invalidated');
    await assert.rejects(fs.lstat(alpha), { code: 'ENOENT' });
    assert.equal((await fs.lstat(beta)).isSymbolicLink(), true);
    await assert.rejects(handlers.set_skills_manifest_skill_enabled({ ...args, skillset: undefined, skill: 'beta-skill' }), /skillset controls/);
    await handlers.set_skills_manifest_skill_enabled({ ...args, skillset: 'reports', enabled: true });
    assert.equal((await fs.lstat(alpha)).isSymbolicLink(), true);
    // A user replacement must survive removal of the repository registration.
    await fs.unlink(beta);
    await writeFile(path.join(beta, 'SKILL.md'), 'local replacement');
    await handlers.remove_skills_manifest_repo({ folderPath: projectDir, repoName: path.basename(repoDir) });
    await assert.rejects(fs.lstat(alpha), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(beta, 'SKILL.md'), 'utf8'), 'local replacement');
    assert.equal(await fs.readFile(path.join(repoDir, 'skills/alpha-skill/helper.txt'), 'utf8'), 'live source');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});


test('published MCP schema admits a skillset toggle without an individual skill', async () => {
  const config = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
  const tool = config.tools.find(tool => tool.name === 'set_skills_manifest_skill_enabled');
  assert.equal(tool.inputSchema.skill.optional, true);
  assert.equal(tool.inputSchema.skillset.type, 'string');
  assert.equal(tool.inputSchema.skillset.optional, true);
  assert.equal(tool.inputSchema.enabled.type, 'boolean');
});

test('a manifest changed after the handler read it is never overwritten and no links change', async () => {
  const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-snapshot-')));
  try {
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    await writeFile(path.join(repoDir, 'skills', 'beta-skill', 'SKILL.md'), '---\nname: beta-skill\n---\n');
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir);
    const repoName = path.basename(repoDir);
    await createHandlers(workspaceRoot).add_skills_manifest_repo({ folderPath: projectDir, url: `file://${repoDir}`, name: repoName });
    const manifestPath = path.join(projectDir, 'ploinky-skills-manifest.json');
    const concurrent = '[]\n';
    const racingFs = {
      ...fs,
      async readFile(file, ...rest) {
        // Another writer replaces the manifest after the snapshot was taken.
        if (String(file).endsWith('skillsets.md')) syncFs.writeFileSync(manifestPath, concurrent);
        return fs.readFile(file, ...rest);
      }
    };
    const handlers = createToolHandlers({ ...handlerOptions(workspaceRoot), fs: racingFs });
    await assert.rejects(handlers.set_skills_manifest_skill_enabled({ folderPath: projectDir, repoName, skill: 'alpha-skill', enabled: false }), /changed while this update was prepared/);
    assert.equal(await fs.readFile(manifestPath, 'utf8'), concurrent);
    assert.equal((await fs.lstat(path.join(projectDir, '.agents', 'skills', 'alpha-skill'))).isSymbolicLink(), true);
    assert.equal(await fs.readlink(path.join(projectDir, '.claude')), '.agents');
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('manifest state reports an incomplete transaction and a blocked lock is not overridden', async () => {
  const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-pending-')));
  try {
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir);
    const handlers = createHandlers(workspaceRoot);
    const repoName = path.basename(repoDir);
    await handlers.add_skills_manifest_repo({ folderPath: projectDir, url: `file://${repoDir}`, name: repoName });
    const other = path.join(workspaceRoot, 'other-skill');
    await writeFile(path.join(other, 'SKILL.md'), '---\nname: other-skill\n---\n');
    // A foreign-namespace exporter stopped after its journal was written.
    const crash = Object.assign(new Error('stopped'), { [transaction.SIMULATED_CRASH]: true });
    const foreign = { current: () => ({ pid: 4242, start: 'x', boot: 'another-boot', namespace: 'another-ns', hostname: 'box', container: true }), alive: () => false, start: () => '' };
    assert.throws(() => transaction.syncManagedSkillExports({
      folder: projectDir, owner: 'defaults:other', mode: 'symlink', sources: [{ name: 'other-skill', path: other }],
      lock: { liveness: foreign }, hooks: { crash: (point) => { if (point === 'after-journal') throw crash; } }
    }), /stopped/);
    const state = parseJsonResponse(await handlers.read_skills_manifest_state({ folderPath: projectDir }));
    assert.equal(state.exportTransaction.status, 'pending');
    assert.equal(state.exportTransaction.owner, 'defaults:other');
    assert.ok(state.diagnostics.some((item) => item.reason === 'skill-export-transaction-pending'));
    await assert.rejects(handlers.remove_skills_manifest_repo({ folderPath: projectDir, repoName }), /another boot, host or PID namespace/);
    assert.equal((await fs.lstat(path.join(projectDir, '.agents', 'skills', 'alpha-skill'))).isSymbolicLink(), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(projectDir, 'ploinky-skills-manifest.json'), 'utf8')).length, 1);
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

function spawnGitConfig(cwd, key) {
  const result = spawnSync('git', ['config', '--get', key], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

test('a marketplace mutation reports recovery failure after quarantining an interrupted publication', async () => {
  const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-quarantine-')));
  try {
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir);
    const handlers = createHandlers(workspaceRoot);
    const repoName = path.basename(repoDir);
    await handlers.add_skills_manifest_repo({ folderPath: projectDir, url: `file://${repoDir}`, name: repoName });
    const manifestPath = path.join(projectDir, 'ploinky-skills-manifest.json');
    const before = await fs.readFile(manifestPath, 'utf8');
    const crash = Object.assign(new Error('fixture publication interrupted'), { [transaction.SIMULATED_CRASH]: true });
    const deadOwner = { ...transaction.currentSkillExportIdentity(), pid: 2147483647, start: 'fixture-dead-process' };
    assert.throws(() => transaction.syncManagedSkillExports({
      folder: projectDir, owner: 'manifest', sources: [], mode: 'symlink',
      manifest: { path: manifestPath, expected: before, next: '[]\n' },
      lock: { liveness: { current: () => deadOwner } },
      hooks: { crash(point) { if (point === 'after-ledger') throw crash; } },
    }), /fixture publication interrupted/);
    // A valid user edit after the commit point must quarantine that old
    // publication. The next handler must not hide the recovery failure behind
    // a newly successful transaction.
    await fs.writeFile(manifestPath, `${before}\n`);
    await assert.rejects(handlers.remove_skills_manifest_repo({ folderPath: projectDir, repoName }), error => {
      assert.equal(error.code, 'SKILL_EXPORT_RECOVERY_REQUIRED');
      assert.equal(error.recovery.status, 'quarantined');
      assert.match(error.message, /incomplete.*recovery quarantined/);
      return true;
    });
    const state = transaction.readSkillExportTransactionState(projectDir);
    assert.equal(state.pending, null);
    assert.equal(state.quarantined.length, 1);
    assert.ok(state.quarantined[0].reasons.some(item => item.name === 'manifest'));
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test('skill changes in a Git project write no tracked rules and defer private exclusions to the host', async () => {
  const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-skills-git-')));
  const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  try {
    await fs.writeFile(path.join(workspaceRoot, 'gitconfig'), '');
    Object.assign(process.env, { XDG_CONFIG_HOME: path.join(workspaceRoot, 'xdg'), GIT_CONFIG_GLOBAL: path.join(workspaceRoot, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
    const repoDir = await createLocalSkillRepo(workspaceRoot);
    const projectDir = path.join(workspaceRoot, 'project');
    await writeFile(path.join(projectDir, 'README.md'), 'x\n');
    const git = (...args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' });
    git('init', '-q');
    git('add', 'README.md');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'initial');
    const added = parseJsonResponse(await createHandlers(workspaceRoot).add_skills_manifest_repo({ folderPath: projectDir, url: `file://${repoDir}`, name: 'local-skills' }));
    // An agent never sees the repository owner's HOME/XDG/global Git view, so
    // it cannot prove which excludes policy is live: nothing is written and
    // the host refresh (`ploinky update`) publishes the private exclusions.
    assert.equal(added.exportResult.exclusions.status, 'deferred');
    assert.equal(added.exportResult.exclusions.code, 'exclusions-executor-view-unverified');
    await assert.rejects(fs.stat(path.join(projectDir, '.gitignore')), { code: 'ENOENT' });
    assert.equal(spawnGitConfig(projectDir, 'extensions.worktreeConfig'), '', 'shared Git config untouched');
    assert.match(git('status', '--porcelain'), /\?\? ploinky-skills-manifest\.json/);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
