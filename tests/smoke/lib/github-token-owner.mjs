import { createHash } from 'node:crypto';

// Input comes from readAuthenticatedPrincipal after /auth/token has matched the
// configured account. Neither the Git result nor DPU storage supplies an oracle.
export function expectedGitTokenOwnership(principal) {
  const id = principal?.id;
  if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
    throw new Error('An exact authenticated Router user ID is required.');
  }
  const email = principal.email;
  if (typeof email !== 'string' || email !== email.trim().toLowerCase()
    || (email && !/^[^\s@]+@[^\s@]+$/.test(email))) {
    throw new Error('The authenticated Router email projection is invalid.');
  }
  // Git keys retain the opaque signed ID, including its case. DPU ownership
  // prefers the signed email; installations without an email use user:<id>.
  const subject = `user:${id}`;
  const suffix = createHash('sha256').update(subject).digest('hex').slice(0, 16).toUpperCase();
  return Object.freeze({ key: `GIT_GITHUB_TOKEN_${suffix}`, ownerId: email || subject });
}
