import path from 'node:path';
import { getPermissionMode } from './achillesSettings.mjs';
import { normalizePermissionMode, PERMISSION_MODES } from '../permissions/protocol.mjs';

export function parseCliOptions(args, { env = process.env, cwd = process.cwd() } = {}) {
    const options = {
        workingDir: cwd, skillRoots: [], prompt: null, singleShot: false,
        verbose: false, debug: false, renderMarkdown: true,
        uiStyle: env.ACHILLES_CLI_UI || 'claude-code', requestedPermissionMode: null,
        help: false, version: false,
    };
    const valueAfter = (index, flag) => {
        const value = args[index + 1];
        if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
        return value;
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--version') options.version = true;
        else if (arg === '--dir' || arg === '-d') options.workingDir = path.resolve(cwd, valueAfter(index++, arg));
        else if (arg.startsWith('--dir=')) options.workingDir = path.resolve(cwd, arg.slice(6) || '.');
        else if (arg === '--skill-root' || arg === '-r') options.skillRoots.push(path.resolve(cwd, valueAfter(index++, arg)));
        else if (arg.startsWith('--skill-root=')) {
            if (!arg.slice(13)) throw new Error('--skill-root requires a value.');
            options.skillRoots.push(path.resolve(cwd, arg.slice(13)));
        } else if (arg === '--verbose' || arg === '-v') options.verbose = true;
        else if (arg === '--debug') options.debug = true;
        else if (arg === '--raw' || arg === '--no-markdown') options.renderMarkdown = false;
        else if (arg === '--ui-minimal') options.uiStyle = 'minimal';
        else if (arg === '--ui-claude-code') options.uiStyle = 'claude-code';
        else if (arg === '--ui' || arg === '--ui-style') options.uiStyle = valueAfter(index++, arg);
        else if (arg.startsWith('--ui=') || arg.startsWith('--ui-style=')) options.uiStyle = arg.slice(arg.indexOf('=') + 1);
        else if (arg === '--skip-permissions') options.requestedPermissionMode = PERMISSION_MODES.FULL;
        else if (arg === '--permissions' || arg.startsWith('--permissions=')) {
            const value = arg === '--permissions' ? valueAfter(index++, arg) : arg.slice(14);
            options.requestedPermissionMode = normalizePermissionMode(value);
            if (!options.requestedPermissionMode) throw new Error('Use --permissions ask-for-approval or --permissions full-access.');
        } else if (arg === '--pageInstanceId' || arg.startsWith('--pageInstanceId=')) {
            // Router-owned transport metadata, not a native ALA session or prompt.
            const value = arg === '--pageInstanceId' ? valueAfter(index++, arg) : arg.slice(17);
            if (!value.trim() || value.length > 128) throw new Error('--pageInstanceId requires a non-empty value of at most 128 characters.');
        } else if (arg === '--forward-envelope' || arg.startsWith('--forward-envelope=')) {
            let value = '1';
            if (arg.includes('=')) value = arg.slice(arg.indexOf('=') + 1);
            else if (/^(?:0|1|true|false)$/i.test(args[index + 1] || '')) value = args[++index];
            if (!/^(?:0|1|true|false)$/i.test(value)) throw new Error('--forward-envelope requires 0, 1, true or false.');
            // Ploinky owns envelope serialization; the runtime reads stdin envelopes.
        } else if (arg.startsWith('--sso-')) {
            if (!arg.includes('=') && args[index + 1] && !args[index + 1].startsWith('-')) index += 1;
        } else if (arg === '--' || !arg.startsWith('-')) {
            options.prompt = args.slice(arg === '--' ? index + 1 : index).join(' ');
            options.singleShot = Boolean(options.prompt);
            break;
        } else throw new Error(`Unknown option: ${arg}`);
    }
    options.permissionMode = options.requestedPermissionMode || getPermissionMode(options.workingDir);
    return options;
}

export function isWebchatRuntime(args = process.argv.slice(2), env = process.env) {
    return ['SSO_USER', 'SSO_USER_ID', 'SSO_EMAIL', 'SSO_ROLES', 'SSO_SESSION_ID']
        .some((key) => String(env[key] || '').trim()) || args.some((arg) => arg.startsWith('--sso-'));
}
