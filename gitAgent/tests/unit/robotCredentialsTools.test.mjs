import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
    ROBOTEAM_DELEGATION_KEY,
    extractRoboTeamDelegationToken,
    listRobotCredentialTargets,
    saveRobotCredentials,
    deleteRobotCredentials,
    mapRoboTeamFailure
} from '../../lib/robot-credentials.mjs';

const TOKEN = 'ghp_robotSecretToken123';

function userAuthInfo(overrides = {}) {
    return {
        user: { id: 'user:alice', username: 'alice', email: 'alice@example.com', roles: ['user'] },
        invocationToken: 'router-invocation-jwt',
        delegations: {
            dpuGitSecrets: { token: 'dpu-delegation', targetAgentId: 'agent:AchillesIDE/dpuAgent' },
            [ROBOTEAM_DELEGATION_KEY]: { token: 'roboteam-delegation', targetAgentId: 'agent:AchillesIDE/roboTeamAgent' }
        },
        ...overrides
    };
}

function jsonResult(payload, extra = {}) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...extra };
}

function fakeAgentClient(respond) {
    const calls = [];
    const factory = async (route, options) => {
        const entry = { route, options, closed: false, tool: null, args: null };
        calls.push(entry);
        return {
            async callTool(tool, args) {
                entry.tool = tool;
                entry.args = args;
                return respond(tool, args);
            },
            async close() {
                entry.closed = true;
            }
        };
    };
    return { factory, calls };
}

test('the RoboTeam delegation token is picked by its key among several delegations', () => {
    assert.equal(extractRoboTeamDelegationToken(userAuthInfo()), 'roboteam-delegation');
    assert.equal(extractRoboTeamDelegationToken({
        delegations: {
            dpuGitSecrets: { token: 'dpu-delegation', targetAgentId: 'agent:AchillesIDE/dpuAgent' },
            other: { token: 'by-target', targetAgentId: 'agent:AchillesIDE/roboTeamAgent' }
        }
    }), 'by-target');
    assert.equal(extractRoboTeamDelegationToken({
        delegations: { dpuGitSecrets: { token: 'dpu-delegation', targetAgentId: 'agent:AchillesIDE/dpuAgent' } }
    }), '');
});

test('targets proxies robot_git_credentials_targets with the RoboTeam delegation and normalizes the reply', async () => {
    const { factory, calls } = fakeAgentClient(() => jsonResult({
        ok: true,
        canAdmin: false,
        userId: 'alice',
        robots: [
            { id: 'r1', name: 'default', isDefault: true, credentials: { configured: false } },
            {
                id: 'r2', name: 'builder', isDefault: false,
                credentials: { configured: true, readable: true, githubLogin: 'bob-gh', savedBy: { id: 'bob', username: 'bob' }, savedAt: '2026-11-01T10:00:00.000Z', token: 'must-not-leak' }
            }
        ]
    }));
    const result = await listRobotCredentialTargets({ authInfo: userAuthInfo(), createAgentClient: factory });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, 'roboTeamAgent');
    assert.equal(calls[0].options.userDelegationToken, 'roboteam-delegation');
    assert.equal(calls[0].tool, 'robot_git_credentials_targets');
    assert.deepEqual(calls[0].args, {});
    assert.equal(calls[0].closed, true);
    assert.equal(result.ok, true);
    assert.equal(result.available, true);
    assert.equal(result.canAdmin, false);
    assert.equal(result.userId, 'alice');
    assert.deepEqual(result.robots[1].credentials, {
        configured: true, readable: true, githubLogin: 'bob-gh', savedBy: { id: 'bob', username: 'bob' }, savedAt: '2026-11-01T10:00:00.000Z'
    });
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});

test('targets reports RoboTeam as unavailable without failing when the delegation or the agent is missing', async () => {
    const noDelegation = await listRobotCredentialTargets({
        authInfo: userAuthInfo({ delegations: {} }),
        createAgentClient: async () => { throw new Error('should not be called'); }
    });
    assert.equal(noDelegation.ok, false);
    assert.equal(noDelegation.code, 'ROBOTEAM_UNAVAILABLE');
    assert.equal(noDelegation.available, false);

    const inactive = await listRobotCredentialTargets({
        authInfo: userAuthInfo(),
        createAgentClient: async () => ({
            async callTool() {
                throw Object.assign(new Error('agent-to-agent target is inactive'), { code: 'TARGET_INACTIVE', statusCode: 503 });
            },
            async close() {}
        })
    });
    assert.equal(inactive.code, 'ROBOTEAM_UNAVAILABLE');
});

test('guests cannot list, save or remove robot credentials', async () => {
    const guest = userAuthInfo({ user: { id: 'guest-1', username: 'guest', roles: ['guest'] } });
    const factory = async () => { throw new Error('should not be called'); };
    assert.equal((await listRobotCredentialTargets({ authInfo: guest, createAgentClient: factory })).code, 'GIT_SIGN_IN_REQUIRED');
    assert.equal((await saveRobotCredentials({ authInfo: guest, robotName: 'default', createAgentClient: factory })).code, 'GIT_SIGN_IN_REQUIRED');
    assert.equal((await deleteRobotCredentials({ authInfo: guest, robotName: 'default', createAgentClient: factory })).code, 'GIT_SIGN_IN_REQUIRED');
});

test('save reads the token from DPU, sends it only to RoboTeam and never returns it', async () => {
    const tokenReads = [];
    const { factory, calls } = fakeAgentClient((tool, args) => jsonResult({
        ok: true,
        robot: { id: 'r1', name: 'default', isDefault: true },
        metadata: {
            host: 'github.com', githubLogin: args.githubLogin, name: args.name, email: args.email,
            savedBy: { id: 'alice', username: 'alice' }, savedAt: '2026-11-10T09:00:00.000Z', token: args.token
        }
    }));
    const result = await saveRobotCredentials({
        authInfo: userAuthInfo(),
        workspaceRoot: '/workspace',
        robotName: 'default',
        name: 'Alice Doe',
        email: 'alice@example.com',
        createAgentClient: factory,
        readStoredToken: async ({ authInfo }) => {
            tokenReads.push(authInfo.delegations.dpuGitSecrets.token);
            return TOKEN;
        },
        getConnectionUser: async () => ({ source: 'github', user: { login: 'alice-gh', name: 'Alice GH', email: 'gh@example.com' } }),
        fetchProfile: async () => { throw new Error('profile lookup is not needed for a device-flow login'); }
    });
    assert.deepEqual(tokenReads, ['dpu-delegation']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'robot_git_credentials_save');
    assert.equal(calls[0].options.userDelegationToken, 'roboteam-delegation');
    assert.deepEqual(calls[0].args, {
        robotName: 'default', token: TOKEN, githubLogin: 'alice-gh', name: 'Alice Doe', email: 'alice@example.com'
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.robot, { id: 'r1', name: 'default', isDefault: true });
    assert.equal(result.metadata.githubLogin, 'alice-gh');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test('save uses the GitHub profile of a manual token and the profile name/email as defaults', async () => {
    const profileTokens = [];
    const { factory, calls } = fakeAgentClient(() => jsonResult({ ok: true, robot: { id: 'r1', name: 'default' }, metadata: {} }));
    const result = await saveRobotCredentials({
        authInfo: userAuthInfo(),
        robotName: 'default',
        createAgentClient: factory,
        readStoredToken: async () => TOKEN,
        getConnectionUser: async () => ({ source: 'token', user: { login: '', name: '', email: '' } }),
        fetchProfile: async (token) => {
            profileTokens.push(token);
            return { login: 'token-owner', name: 'Token Owner', email: 'owner@example.com' };
        }
    });
    assert.equal(result.ok, true);
    assert.deepEqual(profileTokens, [TOKEN]);
    assert.equal(calls[0].args.githubLogin, 'token-owner');
    assert.equal(calls[0].args.name, 'Token Owner');
    assert.equal(calls[0].args.email, 'owner@example.com');
});

test('save refuses without a stored token or a confirmed GitHub login, before calling RoboTeam', async () => {
    const factory = async () => { throw new Error('should not be called'); };
    const missing = await saveRobotCredentials({
        authInfo: userAuthInfo(), robotName: 'default', createAgentClient: factory, readStoredToken: async () => ''
    });
    assert.equal(missing.code, 'GIT_TOKEN_MISSING');

    const unreadable = await saveRobotCredentials({
        authInfo: userAuthInfo(), robotName: 'default', createAgentClient: factory,
        readStoredToken: async () => { throw new Error('secret-store-client: missing DPU user delegation for GitHub token secret.'); }
    });
    assert.equal(unreadable.code, 'GIT_TOKEN_MISSING');

    const unknownLogin = await saveRobotCredentials({
        authInfo: userAuthInfo(), robotName: 'default', createAgentClient: factory,
        readStoredToken: async () => TOKEN,
        getConnectionUser: async () => null,
        fetchProfile: async () => { throw new Error('Bad credentials'); }
    });
    assert.equal(unknownLogin.code, 'GITHUB_LOGIN_UNKNOWN');
    assert.doesNotMatch(JSON.stringify([missing, unreadable, unknownLogin]), new RegExp(TOKEN));
});

test('ROBOT_CREDENTIALS_OCCUPIED is returned as a structured result in every RoboTeam error shape', async () => {
    const occupiedMessage = 'Robot default already holds git credentials for GitHub user bob-gh, saved by bob on 2026-11-01T10:00:00.000Z. Only an administrator can overwrite them.';
    const shapes = [
        () => jsonResult({ ok: false, code: 'ROBOT_CREDENTIALS_OCCUPIED', error: occupiedMessage }),
        () => jsonResult({ ok: false, error: { code: 'ROBOT_CREDENTIALS_OCCUPIED', message: occupiedMessage } }),
        () => ({ isError: true, content: [{ type: 'text', text: occupiedMessage }] }),
        () => { throw Object.assign(new Error(occupiedMessage), { statusCode: 409 }); }
    ];
    for (const respond of shapes) {
        const { factory } = fakeAgentClient(respond);
        const result = await saveRobotCredentials({
            authInfo: userAuthInfo(), robotName: 'default', createAgentClient: factory,
            readStoredToken: async () => TOKEN,
            getConnectionUser: async () => ({ source: 'github', user: { login: 'alice-gh' } })
        });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'ROBOT_CREDENTIALS_OCCUPIED');
        assert.equal(result.message, occupiedMessage);
    }
});

test('a RoboTeam error that echoes the token is redacted', async () => {
    const { factory } = fakeAgentClient(() => jsonResult({ ok: false, code: 'ROBOT_CREDENTIALS_INVALID', error: `token ${TOKEN} is invalid` }));
    const result = await saveRobotCredentials({
        authInfo: userAuthInfo(), robotName: 'default', createAgentClient: factory,
        readStoredToken: async () => TOKEN,
        getConnectionUser: async () => ({ source: 'github', user: { login: 'alice-gh' } })
    });
    assert.equal(result.code, 'ROBOT_CREDENTIALS_INVALID');
    assert.doesNotMatch(result.message, new RegExp(TOKEN));
    assert.match(result.message, /\[redacted\]/);
});

test('delete proxies robot_git_credentials_delete and maps forbidden and not-found errors', async () => {
    const { factory, calls } = fakeAgentClient(() => jsonResult({ ok: true, robot: { id: 'r2', name: 'builder' }, deleted: true }));
    const deleted = await deleteRobotCredentials({ authInfo: userAuthInfo(), robotName: 'builder', createAgentClient: factory });
    assert.equal(calls[0].tool, 'robot_git_credentials_delete');
    assert.deepEqual(calls[0].args, { robotName: 'builder' });
    assert.deepEqual(deleted, { ok: true, robot: { id: 'r2', name: 'builder', isDefault: false }, deleted: true });

    const forbidden = await deleteRobotCredentials({
        authInfo: userAuthInfo(), robotName: 'builder',
        createAgentClient: fakeAgentClient(() => jsonResult({ ok: false, code: 'ROBOT_CREDENTIALS_FORBIDDEN', error: 'Only bob or an administrator can remove the git credentials of robot builder.' })).factory
    });
    assert.equal(forbidden.code, 'ROBOT_CREDENTIALS_FORBIDDEN');

    assert.equal(mapRoboTeamFailure({ ok: false, error: 'robot ghost was not found' }).code, 'ROBOT_NOT_FOUND');
    assert.equal(mapRoboTeamFailure({ ok: false, error: 'boom' }).code, 'ROBOT_CREDENTIALS_FAILED');
});

test('mcp-config declares the robot credential tools with scoped delegations', async () => {
    const config = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    const byName = new Map(config.tools.map((tool) => [tool.name, tool]));
    const expected = {
        git_robot_credentials_targets: 'robot_git_credentials_targets',
        git_robot_credentials_save: 'robot_git_credentials_save',
        git_robot_credentials_delete: 'robot_git_credentials_delete'
    };
    for (const [toolName, roboTeamTool] of Object.entries(expected)) {
        const tool = byName.get(toolName);
        assert.ok(tool, `${toolName} is declared`);
        assert.equal(tool.command, 'tools/git_tool.sh');
        assert.equal(tool.env.TOOL_NAME, toolName);
        const roboTeam = tool.delegations.find((entry) => entry.key === ROBOTEAM_DELEGATION_KEY);
        assert.equal(roboTeam.targetAgentId, 'agent:./roboTeamAgent');
        assert.deepEqual(roboTeam.tools, [roboTeamTool]);
        assert.ok(roboTeam.scopes.length > 0);
        const dpu = tool.delegations.find((entry) => entry.key === 'dpuGitSecrets');
        if (toolName === 'git_robot_credentials_save') {
            assert.deepEqual(dpu.tools, ['dpu_secret_get']);
            assert.deepEqual(dpu.scopes, ['secret:read']);
        } else {
            assert.equal(dpu, undefined);
        }
    }
    assert.equal(byName.get('git_robot_credentials_save').inputSchema.robotName.optional, false);
    assert.equal(byName.get('git_robot_credentials_save').inputSchema.token, undefined);
});

test('git_tool dispatches the robot credential tools', async () => {
    const source = await fs.readFile(new URL('../../tools/git_tool.mjs', import.meta.url), 'utf8');
    for (const name of ['git_robot_credentials_targets', 'git_robot_credentials_save', 'git_robot_credentials_delete']) {
        assert.equal(source.split(`case '${name}'`).length - 1, 2, `${name} is normalized and dispatched`);
    }
});

test('an AgentServer MCP error carrying the RoboTeam stderr envelope maps to its code and plain message', () => {
    const envelope = { ok: false, code: 'ROBOT_CREDENTIALS_OCCUPIED', statusCode: 409,
        error: 'robot default already holds git credentials of octocat saved by alice on 2026-11-10' };
    const result = mapRoboTeamFailure(new Error(`MCP error -32603: ${JSON.stringify(envelope)}`), 'ghp_secret');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ROBOT_CREDENTIALS_OCCUPIED');
    assert.equal(result.message, envelope.error);
});
