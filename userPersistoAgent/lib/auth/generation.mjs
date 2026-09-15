import { stageAuthGenerationIncrement } from '../users.mjs';

// Credential replacement or revocation advances the account generation and
// removes the account's stored OIDC sessions, grants, tokens and codes in the
// caller's staged commit, so both land in one flush or the store fails closed.
// Router sessions minted for an older generation are refused at their next
// revalidation (at most 30 seconds); self-contained ID tokens are not stored and
// stay valid until they expire (at most 300 seconds). Callers hold the users
// lock and the persistence scope.
export async function stageCredentialGenerationAdvance(userId) {
    const updated = await stageAuthGenerationIncrement(userId);
    if (!updated) return null;
    const { revokeOidcAccountArtifacts } = await import('../oidc/adapter.mjs');
    await revokeOidcAccountArtifacts(userId, { persist: false });
    return updated;
}
