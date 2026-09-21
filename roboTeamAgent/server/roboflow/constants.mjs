import path from 'node:path';
import { DATA_DIR } from '../constants.mjs';

export const ROBOFLOW_DIR = path.join(DATA_DIR, 'roboflow');
export const WORKFLOWS_DIR = path.join(ROBOFLOW_DIR, 'workflows');
export const FLOWS_DIR = path.join(ROBOFLOW_DIR, 'flows');

export const EXECUTION_TYPES = Object.freeze(['terminal', 'desktop', 'browser']);
export const FLOW_STATUSES = Object.freeze(['active', 'done', 'stopped']);
export const INVOCATION_STATES = Object.freeze([
    'queued', 'starting', 'running', 'completed', 'failed', 'stopped', 'interrupted',
]);
export const TERMINAL_INVOCATION_STATES = Object.freeze(['completed', 'failed', 'stopped', 'interrupted']);

export const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const MEMBER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FLOW_ID_PATTERN = /^flow_[0-9a-f]{24}$/;
export const INVOCATION_ID_PATTERN = /^inv_[0-9a-f]{24}$/;

export const MAX_MEMBERS = 32;
export const MAX_INVOCATIONS = 500;
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_INSTRUCTION_LENGTH = 32768;
export const MAX_SELECTION_LENGTH = 16384;
export const MAX_RESULT_LENGTH = 65536;
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_LOG_TAIL = 8192;

export const EXECUTION_TASK_TYPES = Object.freeze({
    terminal: 'simple',
    desktop: 'desktop',
    browser: 'browser',
});
