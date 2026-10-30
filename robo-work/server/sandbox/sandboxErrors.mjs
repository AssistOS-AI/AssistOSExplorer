// The error type shared by the sandbox modules (plan Revision 10, section G). `code` is one of:
// sandbox_unavailable, mask_scan_limit, mask_unverified, identity_mismatch, commit_timeout, setup_failed,
// network_setup_failed, invalid_request. `detail` is a short diagnostic that never carries file content.

export class SandboxError extends Error {
    constructor(code, detail = null) {
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'SandboxError';
        this.code = code;
        this.detail = detail;
    }
}

export const sandboxError = (code, detail = null) => new SandboxError(code, detail);

// Exit codes of sandboxPrep.mjs, propagated by stage.sh (which itself uses 64, 70, 71 and 72).
export const PREP_EXIT = Object.freeze({
    ok: 0, mask_scan_limit: 20, mask_unverified: 21, setup_failed: 22, sandbox_unavailable: 23, invalid_request: 24
});
export const codeForPrepExit = (status) => Object.entries(PREP_EXIT).find(([, value]) => value === status && value !== 0)?.[0] ?? null;
