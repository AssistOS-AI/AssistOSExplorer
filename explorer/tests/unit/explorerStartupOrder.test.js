import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const explorerRoot = path.resolve(import.meta.dirname, '..', '..');

// The source of one named function: from its signature through the matching closing brace.
function functionSource(source, name) {
    const start = source.search(new RegExp(`function ${name}\\(`));
    assert.ok(start >= 0, `missing function ${name}`);
    let depth = 0;
    let parens = 0;
    let bodyStart = -1;
    for (let index = source.indexOf('(', start); index < source.length; index += 1) {
        const char = source[index];
        if (bodyStart < 0) {
            if (char === '(') parens += 1;
            if (char === ')') parens -= 1;
            if (char === '{' && parens === 0) {
                bodyStart = index;
                depth = 1;
            }
            continue;
        }
        if (char === '{') depth += 1;
        if (char === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    assert.fail(`unterminated function ${name}`);
}

test('file explorer mounts before runtime plugin discovery completes', () => {
    const source = fs.readFileSync(path.join(explorerRoot, 'main.js'), 'utf8');
    const mountIndex = source.indexOf('await mountInitialApplicationRoute({');
    const deferredRuntimeIndex = source.indexOf("waitForAgentRuntimeAvailability({\n                label: 'Explorer plugins'", mountIndex);

    assert.ok(mountIndex > 0);
    assert.ok(deferredRuntimeIndex > mountIndex);
    assert.match(source, /const isFileExplorerRoute = !roomEntry && pageName === 'file-exp'/);
    assert.match(source, /const \[explorerManifest, pluginPayload, pluginSettingsResult, authenticatedUser\] = await Promise\.all/);
    // The fixed 2.5 s grace is gone: `ready` follows `discovered` through the idle-scheduled readiness module.
    assert.doesNotMatch(source, /RUNTIME_PLUGIN_MOUNT_GRACE_MS/);
    assert.doesNotMatch(source, /\b2500\b/);
    assert.match(source, /import \{ scheduleRuntimePluginReady \} from '\.\/services\/runtime\/runtimePluginReadiness\.js'/);
    assert.match(source, /label: 'Explorer plugins',\s*operation: loadRuntimeContext/);
    assert.match(source, /detail: \{ phase: 'discovered' \}/);
    assert.match(source, /scheduleRuntimePluginReady\(\(event\) => window\.dispatchEvent\(event\)\)/);
    assert.ok(
        source.indexOf('scheduleRuntimePluginReady((event)') > source.indexOf("detail: { phase: 'discovered' }"),
        'ready is scheduled only after the discovered dispatch'
    );
    const readinessSource = fs.readFileSync(path.join(explorerRoot, 'services', 'runtime', 'runtimePluginReadiness.js'), 'utf8');
    assert.match(readinessSource, /detail: \{ phase: 'ready' \}/);
    assert.match(readinessSource, /requestIdleCallback\(run, \{ timeout: RUNTIME_PLUGIN_READY_IDLE_TIMEOUT_MS \}\)/);
    assert.match(readinessSource, /RUNTIME_PLUGIN_READY_IDLE_TIMEOUT_MS = 250/);
    assert.match(readinessSource, /scheduler\.setTimeout\(run, 0\)/);
    assert.doesNotMatch(source, /runtimePluginLoader\.loadComponents\(/);
});

test('initial route replaces the static spinner before WebSkel mounts its loader', () => {
    const source = fs.readFileSync(path.join(explorerRoot, 'main.js'), 'utf8');
    const removeIndex = source.indexOf('loader?.remove?.();');
    const mountIndex = source.indexOf('await mountInitialApplicationRoute({');

    assert.ok(removeIndex > 0);
    assert.ok(mountIndex > removeIndex);
});

test('W1 page-change guards are installed in order, without an inline wrapper, and the denied-route fallback stays in its branch', () => {
    const source = fs.readFileSync(path.join(explorerRoot, 'main.js'), 'utf8');
    const at = (text, from = 0) => {
        const index = source.indexOf(text, from);
        assert.ok(index >= 0, `missing: ${text}`);
        return index;
    };
    const order = [
        'installExplorerResourceLoader(webSkel);',
        'installDetachedRenderGuard(webSkel);',
        'installPageChangeGuard(webSkel,',
        'webSkel.setDomElementForPages(pageContent);',
        'await mountInitialApplicationRoute({'
    ].map((text) => at(text));

    order.forEach((index, position) => {
        if (position > 0) {
            assert.ok(index > order[position - 1], `out of order: ${position}`);
        }
    });
    assert.equal(source.includes('originalChangeToDynamicPage'), false);

    const adminBranch = at('if (routePolicy?.adminOnly && !isAdminUser(context.authenticatedUser)) {');
    const denied = at('resolveDeniedAdminRoute({', adminBranch);
    const elseBranch = at('} else {', adminBranch);
    assert.ok(denied < elseBranch, 'resolveDeniedAdminRoute must sit inside the admin-only branch');
});

test('W2 bootstrap resolves its route from the current address right after the page root is set', () => {
    const source = fs.readFileSync(path.join(explorerRoot, 'main.js'), 'utf8');
    const at = (text, from = 0) => {
        const index = source.indexOf(text, from);
        assert.ok(index >= 0, `missing: ${text}`);
        return index;
    };
    const rootSet = at('webSkel.setDomElementForPages(pageContent);');
    const resolve = at('resolveBootRoute({', rootSet);
    const fileRouteFlag = at('const isFileExplorerRoute', resolve);
    const policy = at('if (!isFileExplorerRoute) {', fileRouteFlag);
    const mount = at('await mountInitialApplicationRoute({', policy);

    assert.ok(rootSet < resolve && resolve < fileRouteFlag && fileRouteFlag < policy && policy < mount);
    // A navigation event that fires between these two points would be lost, so no await may separate them.
    assert.doesNotMatch(source.slice(rootSet, resolve), /\bawait\b/);
    const resolveCall = source.slice(resolve, at('});', resolve));
    assert.match(resolveCall, /capturedRoute: initialHashedRoute\b/);
    assert.match(resolveCall, /currentHash: window\.location\.hash/);
    assert.match(resolveCall, /^\s*roomEntry,?\s*$/m);
    assert.match(resolveCall, /isWebSkelComponent: .*webSkel\.configs\?\.components/);
    // The route policy must look up the re-resolved page, not the startup capture.
    assert.match(source.slice(policy, mount), /getRuntimeComponentPolicy\(context\.plugins, pageName\)/);
    assert.match(source, /const initialHashedRoute = resolveInitialHashedRoute\(window\.location\.hash\);/);
    assert.match(source, /initialHashedRoute\?\.pageName === 'agent-runtime-wait'/);
    assert.doesNotMatch(source, /preserveHash: suppressNavigationHash \} = initialHashedRoute\);/);
});

test('file explorer refreshes plugin slots when deferred discovery completes', () => {
    const mainSource = fs.readFileSync(path.join(explorerRoot, 'main.js'), 'utf8');
    const hostSource = fs.readFileSync(
        path.join(explorerRoot, 'web-components', 'pages', 'file-exp', 'file-exp-application-plugins.js'),
        'utf8'
    );

    assert.match(mainSource, /assistos:runtime-plugins-updated/);
    assert.match(hostSource, /assistos:runtime-plugins-updated/);
});

test('optional plugin failures do not reject file explorer rendering', () => {
    const hostSource = fs.readFileSync(
        path.join(explorerRoot, 'web-components', 'pages', 'file-exp', 'file-exp-application-plugins.js'),
        'utf8'
    );
    const layoutSource = fs.readFileSync(
        path.join(explorerRoot, 'web-components', 'pages', 'file-exp', 'file-exp-layout-controller.js'),
        'utf8'
    );

    const mountSlotSource = functionSource(hostSource, 'mountSlot');
    const stageSource = functionSource(hostSource, 'stageSlotMounts');
    const loadingClassesSource = functionSource(hostSource, 'getPluginLoadingClasses');
    const waitSource = functionSource(hostSource, 'waitForPluginPresenterRender');

    assert.match(hostSource, /stageSlotMounts\(container, slot, plugins, \{ deferMount: Boolean\(onlyKey\) \}\)/);
    assert.match(hostSource, /event\?\.detail\?\.phase === 'discovered'/);
    // Old pin `for (const plugin of plugins)`: plugin order is still walked, and the three mount steps are explicit.
    assert.match(stageSource, /for \(const plugin of plugins\)/);
    assert.match(mountSlotSource, /for \(const plugin of plugins\)/);
    const registerStep = mountSlotSource.indexOf('await Promise.allSettled(pendingPlugins.map(({ plugin }) => ensureRuntimeComponent(plugin.component)))');
    const appendStep = mountSlotSource.indexOf('for (const [index, entry] of pendingPlugins.entries())');
    const renderStep = mountSlotSource.indexOf('await Promise.allSettled(renderingPlugins.map(');
    const finalizeStep = mountSlotSource.indexOf('for (const [index, { plugin, key, mount, pluginElement, ownsLoadingState }] of renderingPlugins.entries())');
    assert.ok(registerStep > 0 && registerStep < appendStep && appendStep < renderStep && renderStep < finalizeStep, 'mountSlot registers, appends, renders, then finalizes');
    assert.doesNotMatch(mountSlotSource, /await ensureRuntimeComponent\(/, 'registration is never awaited one plugin at a time');
    // Old pins :113-:116, scoped to the functions that own them.
    assert.match(stageSource, /pluginElement\.setAttribute\('data-app-plugin-loading'/);
    assert.match(mountSlotSource, /pluginElement\.setAttribute\('data-app-plugin-loading'/);
    assert.match(loadingClassesSource, /container\?\.classList\?\.contains\('app-plugin-account-slot'\)/);
    assert.match(loadingClassesSource, /container\?\.classList\?\.contains\('app-plugin-bar'\)/);
    assert.match(stageSource, /pluginElement\.classList\.add\(\.\.\.loadingClasses, 'app-plugin-loading-state'\)/);
    assert.match(mountSlotSource, /pluginElement\.classList\.add\(\.\.\.loadingClasses, 'app-plugin-loading-state'\)/);
    // Old pins :117-:118: both createPluginMount paths.
    assert.match(stageSource, /if \(!mount && showLoadingPlaceholder\) mount = createPluginMount\(key, slot\)/);
    assert.match(mountSlotSource, /if \(!mount\) \{\s*mount = createPluginMount\(key, slot\)/);
    // Old pins :119-:120: the render waits. mountSlot waits through the shared helper, which owns both awaits.
    assert.match(mountSlotSource, /await waitForPluginPresenterRender\(pluginElement\)/);
    assert.match(waitSource, /await pluginElement\.presenterReadyPromise/);
    assert.match(waitSource, /await pluginElement\.renderCompletePromise/);
    // Old pin :121: mounts are ordered after staging, and again after all plugins finalized.
    assert.match(stageSource, /orderSlotMounts\(container, plugins, stagedMounts\)/);
    assert.ok(
        mountSlotSource.lastIndexOf('orderSlotMounts(container, plugins, stagedMounts)') > finalizeStep,
        'mountSlot orders its mounts after every plugin is finalized'
    );
    assert.match(hostSource, /const slotResults = await Promise\.allSettled\(\[/);
    assert.match(hostSource, /createLazyPluginButton\(plugin, key\)/);
    assert.match(hostSource, /data-app-plugin-trigger/);
    assert.match(hostSource, /loadToolbarPluginOnDemand\(fileExp, trigger\)/);
    assert.doesNotMatch(
        hostSource,
        /await mountSlot\(toolbarContainer, APP_PLUGIN_SLOTS\.toolbar, visibleToolbarPlugins, toolbarContext\)/
    );
    assert.match(layoutSource, /renderApplicationPluginSlots\(fileExp\)\.catch/);
    assert.doesNotMatch(layoutSource, /await renderApplicationPluginSlots\(fileExp\)/);
});
