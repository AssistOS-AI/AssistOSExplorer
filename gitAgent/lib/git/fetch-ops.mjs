import { isGithubHttpsRemote, toBasicAuthHeader } from './github-remotes.mjs';
import { runGit } from './run-git.mjs';

export function createFetchOps({ resolveRepoWorkTreePath, getGitBinary }) {
    async function gitFetch({ path: repoPathArg, token = null }) {
        const repoPath = await resolveRepoWorkTreePath(repoPathArg);
        const gitBinary = await getGitBinary(repoPath);
        const { stdout: branchOutput } = await runGit(repoPath,
            [gitBinary, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1] });
        const branch = branchOutput.trim();
        if (!branch) throw new Error('Cannot check remote updates without a named branch.');
        const { stdout: upstreamOutput } = await runGit(repoPath,
            [gitBinary, 'rev-parse', '--verify', '--symbolic-full-name', '@{u}'], { okCodes: [0, 128] });
        if (!upstreamOutput.trim()) return { ok: true, skipped: true, reason: 'no_upstream' };
        const { stdout: remoteOutput } = await runGit(repoPath,
            [gitBinary, 'config', '--get', `branch.${branch}.remote`]);
        const remote = remoteOutput.trim();
        if (!remote) throw new Error('The upstream branch has no configured remote.');
        const { stdout: mergeOutput } = await runGit(repoPath,
            [gitBinary, 'config', '--get', `branch.${branch}.merge`]);
        const remoteBranch = mergeOutput.trim();
        if (!remoteBranch) throw new Error('The upstream branch has no configured source reference.');
        let remoteUrl = '';
        if (remote !== '.') {
            const result = await runGit(repoPath, [gitBinary, 'remote', 'get-url', remote]);
            remoteUrl = result.stdout.trim();
        }
        const args = [gitBinary];
        const authToken = String(token || '').trim();
        if (authToken && isGithubHttpsRemote(remoteUrl)) {
            args.push('-c', `http.extraHeader=${toBasicAuthHeader({ token: authToken })}`);
        }
        // Fetch updates metadata only; do not recurse into other working trees.
        args.push('fetch', '--no-recurse-submodules', '--no-tags', '--', remote,
            `+${remoteBranch}:${upstreamOutput.trim()}`);
        const { stdout, stderr } = await runGit(repoPath, args, { timeoutMs: 120000 });
        return { ok: true, remote, stdout, stderr };
    }

    return { gitFetch };
}
