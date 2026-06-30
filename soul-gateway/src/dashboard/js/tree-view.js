(function () {
    const root = globalThis.window || globalThis;
    const AGENT_PREFIX = 'agent:';

    function asText(value) {
        if (value === null || value === undefined) {
            return '';
        }
        return String(value);
    }

    function compareText(left, right) {
        return asText(left).localeCompare(asText(right), undefined, {
            sensitivity: 'base',
            numeric: true,
        });
    }

    function normalizeExpanded(expanded) {
        if (expanded instanceof Set) {
            return expanded;
        }
        if (Array.isArray(expanded)) {
            return new Set(expanded.map(asText));
        }
        return new Set();
    }

    function isEnabled(item) {
        return item?.enabled !== false;
    }

    function stripPloinkyAgentPrefix(value) {
        const text = asText(value);
        return text.startsWith(AGENT_PREFIX)
            ? text.slice(AGENT_PREFIX.length)
            : text;
    }

    function providerDisplayKey(provider) {
        return stripPloinkyAgentPrefix(provider?.provider_key);
    }

    function providerDisplayName(provider) {
        const displayName = asText(provider?.display_name).replaceAll(
            AGENT_PREFIX,
            ''
        );
        return displayName || providerDisplayKey(provider);
    }

    function splitPath(value) {
        const segments = asText(value)
            .split('/')
            .map((segment) => segment.trim())
            .filter(Boolean);
        return segments.length > 0 ? segments : ['unknown'];
    }

    function matchesQuery(query, values) {
        const needle = asText(query).trim().toLowerCase();
        if (!needle) {
            return true;
        }

        return values.some((value) => asText(value).toLowerCase().includes(needle));
    }

    function filterProvidersForTree(providers, query) {
        const rows = Array.isArray(providers) ? providers : [];
        return rows.filter((provider) =>
            matchesQuery(query, [
                provider?.provider_key,
                providerDisplayKey(provider),
                provider?.display_name,
                providerDisplayName(provider),
                provider?.adapter_key,
                provider?.base_url,
            ])
        );
    }

    function modelTags(model) {
        if (Array.isArray(model?.tags)) {
            return model.tags;
        }
        if (model?.tags === null || model?.tags === undefined) {
            return [];
        }
        return [model.tags];
    }

    function filterModelsForTree(models, query) {
        const rows = Array.isArray(models) ? models : [];
        return rows.filter((model) =>
            matchesQuery(query, [
                model?.model_key,
                model?.display_name,
                model?.provider_key,
                model?.provider_model_id,
                ...modelTags(model),
            ])
        );
    }

    function makeProviderLeaf(provider, label, displayPath, depth) {
        const rawKey = asText(provider?.provider_key) || displayPath;
        return {
            rowType: 'leaf',
            key: rawKey,
            path: rawKey,
            label,
            displayPath,
            depth,
            item: provider,
        };
    }

    function providerLeafLabel(provider, segments) {
        const rawKey = asText(provider?.provider_key);
        if (rawKey.startsWith(AGENT_PREFIX)) {
            return segments.join('/');
        }
        return providerDisplayName(provider) || segments.join('/');
    }

    function buildProviderTreeRows(providers, options = {}) {
        const expanded = normalizeExpanded(options.expanded);
        const forceExpanded = options.forceExpanded === true;
        const groups = new Map();
        const singles = [];

        for (const provider of Array.isArray(providers) ? providers : []) {
            const displayPath = providerDisplayKey(provider);
            const segments = splitPath(displayPath);

            if (segments.length >= 2) {
                const groupPath = segments[0];
                if (!groups.has(groupPath)) {
                    groups.set(groupPath, []);
                }
                groups.get(groupPath).push({
                    provider,
                    displayPath: segments.join('/'),
                    label: segments.slice(1).join('/'),
                });
            } else {
                singles.push(
                    makeProviderLeaf(
                        provider,
                        providerLeafLabel(provider, segments),
                        segments.join('/'),
                        0
                    )
                );
            }
        }

        const entries = [
            ...[...groups.entries()].map(([path, leaves]) => ({
                type: 'group',
                path,
                label: path,
                leaves,
            })),
            ...singles.map((row) => ({
                type: 'leaf',
                label: row.label,
                row,
            })),
        ].sort((left, right) => compareText(left.label, right.label));

        const rows = [];
        for (const entry of entries) {
            if (entry.type === 'leaf') {
                rows.push(entry.row);
                continue;
            }

            const leaves = entry.leaves.sort((left, right) =>
                compareText(left.label, right.label)
            );
            const isExpanded = forceExpanded || expanded.has(entry.path);
            rows.push({
                rowType: 'group',
                key: entry.path,
                path: entry.path,
                label: entry.label,
                depth: 0,
                count: leaves.length,
                enabledCount: leaves.filter((leaf) => isEnabled(leaf.provider))
                    .length,
                expanded: isExpanded,
            });

            if (!isExpanded) {
                continue;
            }

            for (const leaf of leaves) {
                rows.push(
                    makeProviderLeaf(
                        leaf.provider,
                        leaf.label,
                        leaf.displayPath,
                        1
                    )
                );
            }
        }

        return rows;
    }

    function createModelNode(segment, pathSegments) {
        return {
            segment,
            pathSegments,
            children: new Map(),
            leaves: [],
            count: 0,
            enabledCount: 0,
        };
    }

    function insertModelNode(rootNode, entry) {
        let node = rootNode;
        entry.segments.forEach((segment, index) => {
            const pathSegments = entry.segments.slice(0, index + 1);
            if (!node.children.has(segment)) {
                node.children.set(segment, createModelNode(segment, pathSegments));
            }
            node = node.children.get(segment);
        });
        node.leaves.push(entry);
    }

    function computeModelCounts(node) {
        node.count = node.leaves.length;
        node.enabledCount = node.leaves.filter((entry) => isEnabled(entry.item))
            .length;

        for (const child of node.children.values()) {
            computeModelCounts(child);
            node.count += child.count;
            node.enabledCount += child.enabledCount;
        }
    }

    function modelLeafRow(entry, label, depth) {
        const rawKey = asText(entry.item?.model_key) || entry.displayPath;
        return {
            rowType: 'leaf',
            key: rawKey,
            path: rawKey,
            label,
            displayPath: entry.displayPath,
            depth,
            item: entry.item,
        };
    }

    function onlyModelLeaf(node) {
        if (node.leaves.length > 0) {
            return node.leaves[0];
        }

        for (const child of node.children.values()) {
            const leaf = onlyModelLeaf(child);
            if (leaf) {
                return leaf;
            }
        }

        return null;
    }

    function modelLeafLabel(entry, parentDepth) {
        const remaining = entry.segments.slice(parentDepth);
        return remaining.length > 0
            ? remaining.join('/')
            : asText(entry.item?.display_name) || entry.displayPath;
    }

    function appendModelChildren(rows, node, depth, expanded, forceExpanded) {
        const parentDepth = node.pathSegments.length;
        const entries = [
            ...node.leaves.map((leaf) => ({
                type: 'leaf',
                label: modelLeafLabel(leaf, parentDepth),
                leaf,
            })),
            ...[...node.children.values()].map((child) => {
                if (child.count >= 2) {
                    return {
                        type: 'group',
                        label: child.segment,
                        node: child,
                    };
                }

                const leaf = onlyModelLeaf(child);
                return {
                    type: 'leaf',
                    label: leaf ? modelLeafLabel(leaf, parentDepth) : child.segment,
                    leaf,
                };
            }),
        ].sort((left, right) => compareText(left.label, right.label));

        for (const entry of entries) {
            if (entry.type === 'leaf') {
                if (entry.leaf) {
                    rows.push(modelLeafRow(entry.leaf, entry.label, depth));
                }
                continue;
            }

            appendModelGroup(rows, entry.node, depth, expanded, forceExpanded);
        }
    }

    function appendModelGroup(rows, node, depth, expanded, forceExpanded) {
        const path = node.pathSegments.join('/');
        const isExpanded = forceExpanded || expanded.has(path);

        rows.push({
            rowType: 'group',
            key: path,
            path,
            label: node.segment,
            depth,
            count: node.count,
            enabledCount: node.enabledCount,
            expanded: isExpanded,
        });

        if (isExpanded) {
            appendModelChildren(
                rows,
                node,
                depth + 1,
                expanded,
                forceExpanded
            );
        }
    }

    function buildModelTreeRows(models, options = {}) {
        const expanded = normalizeExpanded(options.expanded);
        const forceExpanded = options.forceExpanded === true;
        const rootNode = createModelNode('', []);
        const singleLeaves = [];

        for (const model of Array.isArray(models) ? models : []) {
            const displayPath = asText(model?.model_key);
            const segments = splitPath(displayPath);
            const entry = {
                item: model,
                segments,
                displayPath: segments.join('/'),
            };

            if (segments.length === 1) {
                singleLeaves.push(entry);
            } else {
                insertModelNode(rootNode, entry);
            }
        }

        computeModelCounts(rootNode);

        const entries = [
            ...singleLeaves.map((leaf) => ({
                type: 'leaf',
                label: asText(leaf.item?.display_name) || leaf.displayPath,
                leaf,
            })),
            ...[...rootNode.children.values()].map((node) => ({
                type: 'group',
                label: node.segment,
                node,
            })),
        ].sort((left, right) => compareText(left.label, right.label));

        const rows = [];
        for (const entry of entries) {
            if (entry.type === 'leaf') {
                rows.push(modelLeafRow(entry.leaf, entry.label, 0));
                continue;
            }
            appendModelGroup(rows, entry.node, 0, expanded, forceExpanded);
        }

        return rows;
    }

    function setFromArray(values) {
        if (!Array.isArray(values)) {
            return new Set();
        }
        return new Set(values.map(asText));
    }

    function loadExpandedSet(storage, key, defaults = []) {
        const fallback = setFromArray(defaults);

        try {
            if (!storage || typeof storage.getItem !== 'function') {
                return fallback;
            }

            const raw = storage.getItem(key);
            if (!raw) {
                return fallback;
            }

            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? setFromArray(parsed) : fallback;
        } catch {
            return fallback;
        }
    }

    function saveExpandedSet(storage, key, expanded) {
        try {
            if (!storage || typeof storage.setItem !== 'function') {
                return;
            }
            storage.setItem(key, JSON.stringify([...normalizeExpanded(expanded)]));
        } catch {
            // Storage is best-effort for dashboard expansion state.
        }
    }

    function toggleExpandedPath(expanded, path) {
        const next = new Set(normalizeExpanded(expanded));
        const text = asText(path);
        if (next.has(text)) {
            next.delete(text);
        } else {
            next.add(text);
        }
        return next;
    }

    root.SoulGatewayTreeView = {
        stripPloinkyAgentPrefix,
        providerDisplayKey,
        providerDisplayName,
        buildProviderTreeRows,
        buildModelTreeRows,
        filterProvidersForTree,
        filterModelsForTree,
        loadExpandedSet,
        saveExpandedSet,
        toggleExpandedPath,
    };
})();
