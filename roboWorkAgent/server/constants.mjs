export const DATA_DIR = '/root';
export const ROBOTS_DIR = '/robots';
export const TOOL_CACHE_DIR = '/root/tool-cache';
export const TOOL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
// An interactive session (Terminal, GUI) rechecks the coding agents when their last check is older than this, so a
// reopened session starts the current release; the bound keeps rapid reopening off the registries' rate limits.
export const TOOL_SESSION_CHECK_MS = 5 * 60 * 1000;
// A preparation that fell back to the last valid generation (registry unreachable, install failed) is retried after
// this, not after the full refresh interval.
export const TOOL_FALLBACK_RETRY_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_GUI_ROBOTS = 8;
export const BROWSER_IMAGE = 'docker.io/assistos/roboteam-browser:runtime';
export const DESKTOP_IMAGE = 'docker.io/assistos/roboteam-desktop:runtime';
export const PUBLIC_BASE_PATH = '/base-agent-additional-server/roboWorkAgent/3001/';
export const TIMEZONE = 'UTC';
