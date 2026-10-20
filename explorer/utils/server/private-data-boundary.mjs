const PRIVATE_ROOT_SEGMENTS = Object.freeze(['.data', 'explorer']);

function privateDataPolicyError(message) {
  const error = new Error(message);
  error.code = 'PLOINKY_AGENT_DATA_POLICY_VIOLATION';
  error.statusCode = 422;
  return error;
}

function normalizeSegments(pathApi, segments) {
  const list = Array.isArray(segments) ? segments : [segments];
  return list.map((segment) => {
    const value = String(segment || '').trim();
    if (!value || value === '.' || value === '..' || pathApi.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
      throw privateDataPolicyError(`Invalid Explorer private data path segment: ${value || '<empty>'}`);
    }
    return value;
  });
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

// `agentName` selects another `.data/<agent>` root of this same agent runtime,
// such as the Router-staged WebMeet blobs of a renamed Explorer instance; by
// default the boundary is `.data/explorer`.
export function createExplorerPrivateDataBoundary({ fs, path, workspaceRoot, agentName = '' }) {
  const fsApi = fs?.promises || fs;
  const lexicalWorkspaceRoot = path.resolve(String(workspaceRoot || ''));
  const rootSegments = agentName
    ? ['.data', ...normalizeSegments(path, [agentName])]
    : PRIVATE_ROOT_SEGMENTS;
  const lexicalPrivateRoot = path.join(lexicalWorkspaceRoot, ...rootSegments);

  async function canonicalWorkspaceRoot() {
    const stats = await fsApi.stat(lexicalWorkspaceRoot);
    if (!stats.isDirectory()) throw privateDataPolicyError('Explorer workspace root must be a directory.');
    return fsApi.realpath(lexicalWorkspaceRoot);
  }

  async function resolveDirectory(segments = [], { create = false } = {}) {
    const privateSegments = normalizeSegments(path, segments);
    const allSegments = [...rootSegments, ...privateSegments];
    const canonicalWorkspace = await canonicalWorkspaceRoot();
    let lexicalCurrent = lexicalWorkspaceRoot;
    let canonicalCurrent = canonicalWorkspace;

    for (const segment of allSegments) {
      lexicalCurrent = path.join(lexicalCurrent, segment);
      const expectedCanonical = path.join(canonicalCurrent, segment);
      let stats;
      try {
        stats = await fsApi.lstat(lexicalCurrent);
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (!create) return path.join(lexicalPrivateRoot, ...privateSegments);
        await fsApi.mkdir(lexicalCurrent).catch((mkdirError) => {
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
        });
        stats = await fsApi.lstat(lexicalCurrent);
      }
      if (stats.isSymbolicLink()) {
        throw privateDataPolicyError(`Explorer private data path must not contain symbolic links: ${lexicalCurrent}`);
      }
      if (!stats.isDirectory()) {
        throw privateDataPolicyError(`Explorer private data directory is not a directory: ${lexicalCurrent}`);
      }
      const resolvedCurrent = await fsApi.realpath(lexicalCurrent);
      if (resolvedCurrent !== expectedCanonical) {
        throw privateDataPolicyError(`Explorer private data path escapes its canonical workspace boundary: ${lexicalCurrent}`);
      }
      canonicalCurrent = resolvedCurrent;
    }
    return path.join(lexicalPrivateRoot, ...privateSegments);
  }

  async function resolveFile(segments, { createParent = false } = {}) {
    const fileSegments = normalizeSegments(path, segments);
    if (fileSegments.length === 0) throw privateDataPolicyError('Explorer private data file path is required.');
    const fileName = fileSegments.at(-1);
    const parentSegments = fileSegments.slice(0, -1);
    const parentPath = await resolveDirectory(parentSegments, { create: createParent });
    const filePath = path.join(parentPath, fileName);
    let stats;
    try {
      stats = await fsApi.lstat(filePath);
    } catch (error) {
      if (isMissing(error)) return filePath;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw privateDataPolicyError(`Explorer private data file must not be a symbolic link: ${filePath}`);
    }
    if (!stats.isFile()) {
      throw privateDataPolicyError(`Explorer private data file is not a regular file: ${filePath}`);
    }
    const [canonicalParent, canonicalFile] = await Promise.all([
      fsApi.realpath(parentPath),
      fsApi.realpath(filePath),
    ]);
    if (canonicalFile !== path.join(canonicalParent, fileName)) {
      throw privateDataPolicyError(`Explorer private data file escapes its canonical workspace boundary: ${filePath}`);
    }
    return filePath;
  }

  return {
    privateRoot: lexicalPrivateRoot,
    resolveDirectory,
    resolveFile,
  };
}
