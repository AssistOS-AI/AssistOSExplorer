import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

async function loadTreeView() {
    const previousWindow = globalThis.window;
    const window = {};
    globalThis.window = window;

    try {
        await import(
            `../../dashboard/js/tree-view.js?test=${Date.now()}${Math.random()}`
        );
        return {
            tree: window.SoulGatewayTreeView,
            restore() {
                if (previousWindow === undefined) {
                    delete globalThis.window;
                } else {
                    globalThis.window = previousWindow;
                }
            },
        };
    } catch (err) {
        if (previousWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = previousWindow;
        }
        throw err;
    }
}

async function withTreeView(callback) {
    const globals = await loadTreeView();
    try {
        assert.ok(globals.tree, 'tree helper should be attached to window');
        await callback(globals.tree);
    } finally {
        globals.restore();
    }
}

describe('dashboard tree view helpers', () => {
    it('strips the Ploinky agent prefix for display without changing raw keys', async () => {
        await withTreeView((tree) => {
            const provider = {
                provider_key: 'agent:AchillesIDE/explorer',
                display_name: 'Ploinky agent agent:AchillesIDE/explorer',
                enabled: true,
            };

            assert.equal(
                tree.stripPloinkyAgentPrefix('agent:AchillesIDE/explorer'),
                'AchillesIDE/explorer'
            );
            assert.equal(
                tree.stripPloinkyAgentPrefix('ploinky:agent:AchillesIDE/explorer'),
                'ploinky:agent:AchillesIDE/explorer'
            );
            assert.equal(
                tree.providerDisplayKey(provider),
                'AchillesIDE/explorer'
            );
            assert.equal(
                tree.providerDisplayName(provider),
                'Ploinky agent AchillesIDE/explorer'
            );

            const rows = tree.buildProviderTreeRows([provider], {
                expanded: new Set(['AchillesIDE']),
            });

            assert.equal(rows.length, 2);
            assert.equal(rows[0].rowType, 'group');
            assert.equal(rows[0].key, 'AchillesIDE');
            assert.equal(rows[1].rowType, 'leaf');
            assert.equal(rows[1].key, 'agent:AchillesIDE/explorer');
            assert.equal(rows[1].path, 'agent:AchillesIDE/explorer');
            assert.equal(rows[1].displayPath, 'AchillesIDE/explorer');
            assert.equal(provider.provider_key, 'agent:AchillesIDE/explorer');
        });
    });

    it('groups Ploinky providers by repository prefix and keeps single-segment providers as leaves', async () => {
        await withTreeView((tree) => {
            const providers = [
                {
                    provider_key: 'agent:AchillesIDE/explorer',
                    display_name: 'Ploinky agent agent:AchillesIDE/explorer',
                    enabled: true,
                },
                {
                    provider_key: 'agent:AchillesIDE/tasksAgent',
                    display_name: 'Ploinky agent agent:AchillesIDE/tasksAgent',
                    enabled: false,
                },
                {
                    provider_key: 'agent:file-parser-agent',
                    display_name: 'Ploinky agent agent:file-parser-agent',
                    enabled: true,
                },
                {
                    provider_key: 'openai',
                    display_name: 'OpenAI',
                    enabled: true,
                },
            ];

            const rows = tree.buildProviderTreeRows(providers, {
                expanded: new Set(['AchillesIDE']),
            });

            assert.deepEqual(
                rows.map((row) => ({
                    type: row.rowType,
                    key: row.key,
                    path: row.path,
                    label: row.label,
                    depth: row.depth,
                })),
                [
                    {
                        type: 'group',
                        key: 'AchillesIDE',
                        path: 'AchillesIDE',
                        label: 'AchillesIDE',
                        depth: 0,
                    },
                    {
                        type: 'leaf',
                        key: 'agent:AchillesIDE/explorer',
                        path: 'agent:AchillesIDE/explorer',
                        label: 'explorer',
                        depth: 1,
                    },
                    {
                        type: 'leaf',
                        key: 'agent:AchillesIDE/tasksAgent',
                        path: 'agent:AchillesIDE/tasksAgent',
                        label: 'tasksAgent',
                        depth: 1,
                    },
                    {
                        type: 'leaf',
                        key: 'agent:file-parser-agent',
                        path: 'agent:file-parser-agent',
                        label: 'file-parser-agent',
                        depth: 0,
                    },
                    {
                        type: 'leaf',
                        key: 'openai',
                        path: 'openai',
                        label: 'OpenAI',
                        depth: 0,
                    },
                ]
            );

            assert.equal(rows[0].count, 2);
            assert.equal(rows[0].enabledCount, 1);
            assert.equal(rows[0].expanded, true);
            assert.equal(rows[1].displayPath, 'AchillesIDE/explorer');
            assert.equal(rows[2].displayPath, 'AchillesIDE/tasksAgent');
            assert.equal(rows[3].displayPath, 'file-parser-agent');
        });
    });

    it('builds nested model groups only for prefixes with at least two leaves', async () => {
        await withTreeView((tree) => {
            const models = [
                {
                    model_key: 'repo/agent/fast',
                    display_name: 'Fast',
                    enabled: true,
                },
                {
                    model_key: 'repo/agent/deep',
                    display_name: 'Deep',
                    enabled: true,
                },
                {
                    model_key: 'repo/solo/only',
                    display_name: 'Only',
                    enabled: false,
                },
                {
                    model_key: 'search/tavily',
                    display_name: 'Tavily',
                    enabled: true,
                },
                {
                    model_key: 'fast',
                    display_name: 'Fast tier',
                    enabled: true,
                },
            ];

            const rows = tree.buildModelTreeRows(models, {
                expanded: new Set(['repo', 'repo/agent', 'search']),
            });

            assert.deepEqual(
                rows.map((row) => ({
                    type: row.rowType,
                    key: row.key,
                    path: row.path,
                    label: row.label,
                    depth: row.depth,
                })),
                [
                    {
                        type: 'leaf',
                        key: 'fast',
                        path: 'fast',
                        label: 'Fast tier',
                        depth: 0,
                    },
                    {
                        type: 'group',
                        key: 'repo',
                        path: 'repo',
                        label: 'repo',
                        depth: 0,
                    },
                    {
                        type: 'group',
                        key: 'repo/agent',
                        path: 'repo/agent',
                        label: 'agent',
                        depth: 1,
                    },
                    {
                        type: 'leaf',
                        key: 'repo/agent/deep',
                        path: 'repo/agent/deep',
                        label: 'deep',
                        depth: 2,
                    },
                    {
                        type: 'leaf',
                        key: 'repo/agent/fast',
                        path: 'repo/agent/fast',
                        label: 'fast',
                        depth: 2,
                    },
                    {
                        type: 'leaf',
                        key: 'repo/solo/only',
                        path: 'repo/solo/only',
                        label: 'solo/only',
                        depth: 1,
                    },
                    {
                        type: 'group',
                        key: 'search',
                        path: 'search',
                        label: 'search',
                        depth: 0,
                    },
                    {
                        type: 'leaf',
                        key: 'search/tavily',
                        path: 'search/tavily',
                        label: 'tavily',
                        depth: 1,
                    },
                ]
            );

            const repoGroup = rows.find((row) => row.path === 'repo');
            const agentGroup = rows.find((row) => row.path === 'repo/agent');
            const searchGroup = rows.find((row) => row.path === 'search');

            assert.equal(repoGroup.count, 3);
            assert.equal(repoGroup.enabledCount, 2);
            assert.equal(repoGroup.expanded, true);
            assert.equal(agentGroup.count, 2);
            assert.equal(agentGroup.enabledCount, 2);
            assert.equal(agentGroup.expanded, true);
            assert.equal(searchGroup.count, 1);
            assert.equal(searchGroup.expanded, true);
        });
    });

    it('matches search against raw keys, display paths, names, and tags', async () => {
        await withTreeView((tree) => {
            const providers = [
                {
                    provider_key: 'agent:AchillesIDE/explorer',
                    display_name: 'Ploinky agent agent:AchillesIDE/explorer',
                    adapter_key: 'ploinky-agent-openai',
                    base_url: 'http://explorer.internal.local',
                },
                {
                    provider_key: 'openai',
                    display_name: 'OpenAI',
                    adapter_key: 'openai-api',
                    base_url: 'https://api.openai.com/v1',
                },
            ];
            const models = [
                {
                    model_key: 'AchillesIDE/explorer',
                    display_name: 'Explorer Default',
                    provider_key: 'agent:AchillesIDE/explorer',
                    provider_model_id: 'default-local-llm',
                    tags: ['coding', 'agentic'],
                },
                {
                    model_key: 'openai/gpt-4.1',
                    display_name: 'GPT 4.1',
                    provider_key: 'openai',
                    provider_model_id: 'gpt-4.1',
                    tags: ['reasoning'],
                },
            ];

            assert.deepEqual(
                tree
                    .filterProvidersForTree(providers, 'agent:AchillesIDE')
                    .map((provider) => provider.provider_key),
                ['agent:AchillesIDE/explorer']
            );
            assert.deepEqual(
                tree
                    .filterProvidersForTree(providers, 'AchillesIDE/explorer')
                    .map((provider) => provider.provider_key),
                ['agent:AchillesIDE/explorer']
            );
            assert.deepEqual(
                tree
                    .filterProvidersForTree(providers, 'Ploinky agent AchillesIDE')
                    .map((provider) => provider.provider_key),
                ['agent:AchillesIDE/explorer']
            );
            assert.deepEqual(
                tree
                    .filterProvidersForTree(providers, 'internal.local')
                    .map((provider) => provider.provider_key),
                ['agent:AchillesIDE/explorer']
            );

            assert.deepEqual(
                tree
                    .filterModelsForTree(models, 'default-local-llm')
                    .map((model) => model.model_key),
                ['AchillesIDE/explorer']
            );
            assert.deepEqual(
                tree
                    .filterModelsForTree(models, 'explorer default')
                    .map((model) => model.model_key),
                ['AchillesIDE/explorer']
            );
            assert.deepEqual(
                tree
                    .filterModelsForTree(models, 'agent:AchillesIDE')
                    .map((model) => model.model_key),
                ['AchillesIDE/explorer']
            );
            assert.deepEqual(
                tree
                    .filterModelsForTree(models, 'coding')
                    .map((model) => model.model_key),
                ['AchillesIDE/explorer']
            );
        });
    });

    it('persists expanded paths through a provided storage adapter', async () => {
        await withTreeView((tree) => {
            const writes = [];
            const values = new Map([
                ['expanded', JSON.stringify(['repo', 'repo/agent'])],
                ['invalid', '{'],
            ]);
            const storage = {
                getItem(key) {
                    return values.get(key) ?? null;
                },
                setItem(key, value) {
                    writes.push({ key, value });
                    values.set(key, value);
                },
            };

            assert.deepEqual(
                [...tree.loadExpandedSet(storage, 'expanded')].sort(),
                ['repo', 'repo/agent']
            );
            assert.deepEqual(
                [...tree.loadExpandedSet(storage, 'missing', ['default'])],
                ['default']
            );
            assert.deepEqual(
                [...tree.loadExpandedSet(storage, 'invalid', ['default'])],
                ['default']
            );
            assert.deepEqual(
                [
                    ...tree.loadExpandedSet(
                        {
                            getItem() {
                                throw new Error('unavailable');
                            },
                        },
                        'expanded',
                        ['default']
                    ),
                ],
                ['default']
            );

            const original = new Set(['repo']);
            const added = tree.toggleExpandedPath(original, 'search');
            const removed = tree.toggleExpandedPath(added, 'repo');

            assert.notEqual(added, original);
            assert.deepEqual([...original], ['repo']);
            assert.deepEqual([...added].sort(), ['repo', 'search']);
            assert.deepEqual([...removed], ['search']);

            tree.saveExpandedSet(storage, 'expanded', added);
            tree.saveExpandedSet(
                {
                    setItem() {
                        throw new Error('full');
                    },
                },
                'expanded',
                added
            );

            assert.deepEqual(writes, [
                {
                    key: 'expanded',
                    value: JSON.stringify(['repo', 'search']),
                },
            ]);
        });
    });
});
