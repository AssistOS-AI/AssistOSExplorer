import path from 'node:path';
import { DATA_DIR } from '../constants.mjs';

export const ROBOFLOW_DIR = path.join(DATA_DIR, 'roboflow');
export const WORKFLOWS_DIR = path.join(ROBOFLOW_DIR, 'workflows');

export const EXECUTION_TYPES = Object.freeze(['terminal', 'desktop', 'browser']);
export const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const DEFAULT_WORKFLOW_ID = 'default';
export const FLOW_ID_PATTERN = /^flow_[0-9a-f]{24}$/;
export const INVOCATION_ID_PATTERN = /^inv_[0-9a-f]{24}$/;
export const EXECUTION_TASK_TYPES = Object.freeze({ terminal: 'simple', desktop: 'desktop', browser: 'browser' });
