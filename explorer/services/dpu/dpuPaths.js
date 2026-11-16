export const DPU_DATA_PATH = '/.data';
export function isDpuDataPath(value) {
    const normalized = normalizeDpuPath(value);
    return normalized === DPU_DATA_PATH || normalized.startsWith(`${DPU_DATA_PATH}/`);
}

export const DPU_ROOT_PATH = '/Confidential';
export const DPU_MY_SPACE_PATH = '/Confidential/My Space';
export const DPU_SHARED_PATH = '/Confidential/Shared';
export const DPU_SECRETS_PATH = '/Confidential/Secrets';
export const DPU_AUDIT_PATH = '/Confidential/Audit';
export const DPU_RESEARCH_DATA_PATH = '/Confidential/Research Data';
export const DPU_JOBS_PATH = '/Confidential/Jobs';

export function normalizeDpuPath(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return '';
    }
    if (trimmed === '/') {
        return '/';
    }
    return `/${trimmed.replace(/^\/+/, '').replace(/\/+/g, '/')}`.replace(/\/$/, '');
}

export function splitDpuPath(path) {
    return normalizeDpuPath(path).split('/').filter(Boolean);
}

export function isDpuVirtualPath(path) {
    const normalized = normalizeDpuPath(path);
    return isDpuDataPath(normalized) || normalized === DPU_ROOT_PATH || normalized.startsWith(`${DPU_ROOT_PATH}/`);
}

export function isDpuSecretPath(path) {
    const normalized = normalizeDpuPath(path);
    return normalized === DPU_SECRETS_PATH || normalized.startsWith(`${DPU_SECRETS_PATH}/`);
}

export function isDpuAuditPath(path) {
    const normalized = normalizeDpuPath(path);
    return normalized === DPU_AUDIT_PATH || normalized.startsWith(`${DPU_AUDIT_PATH}/`);
}

export function resolveDpuSecretKey(path) {
    const normalized = normalizeDpuPath(path);
    if (!isDpuSecretPath(normalized)) {
        return '';
    }
    const segments = splitDpuPath(normalized);
    return segments.length === 3 ? segments[2] : '';
}
