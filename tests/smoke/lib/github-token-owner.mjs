import { createHash } from 'node:crypto';

// Input comes from readAuthenticatedPrincipal after /auth/token has matched the
// configured account. Neither the Git result nor DPU storage supplies an oracle.
export function expectedGitTokenOwnership(principal) {
  const id = principal?.id;
  if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
    throw new Error('An exact authenticated Router user ID is required.');
  }
  // Direct browser MCP grants carry the exact user actor ID, without profile
  // email. The explicit dpu_whoami precondition establishes user:<id> before
  // Git delegation; DPU's user-ID alias keeps that owner when delegation adds
  // email. Never derive the owner from displayed profile data or stored output.
  const subject = `user:${id}`;
  const suffix = createHash('sha256').update(subject).digest('hex').slice(0, 16).toUpperCase();
  return Object.freeze({ key: `GIT_GITHUB_TOKEN_${suffix}`, ownerId: subject });
}
