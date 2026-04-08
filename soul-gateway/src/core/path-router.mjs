/**
 * Lightweight path router.
 *
 * Supports:
 *   - static paths:   GET /healthz
 *   - param paths:    GET /management/models/:modelId
 *   - wildcard paths: GET /management/static/*
 *   - method filtering
 *
 * Usage:
 *   const router = createRouter();
 *   router.add('GET', '/healthz', handleHealth);
 *   router.add('POST', '/v1/chat/completions', handleChat);
 *   router.add('GET', '/management/models/:modelId', handleGetModel);
 *
 *   const match = router.match('GET', '/management/models/abc-123');
 *   // => { handler, params: { modelId: 'abc-123' }, path: '/management/models/:modelId' }
 */
export function createRouter() {
    const routes = [];

    function add(method, pattern, handler) {
        const segments = pattern.split('/').filter(Boolean);
        routes.push({
            method: method.toUpperCase(),
            pattern,
            segments,
            handler,
        });
    }

    function match(method, pathname) {
        const reqSegments = pathname.split('/').filter(Boolean);

        for (const route of routes) {
            if (route.method !== method) continue;
            const params = matchSegments(route.segments, reqSegments);
            if (params !== null) {
                return { handler: route.handler, params, path: route.pattern };
            }
        }
        return null;
    }

    return { add, match };
}

function matchSegments(routeSegs, reqSegs) {
    // Wildcard: last segment is '*' — matches any remaining path
    const hasWildcard =
        routeSegs.length > 0 && routeSegs[routeSegs.length - 1] === '*';

    if (hasWildcard) {
        if (reqSegs.length < routeSegs.length - 1) return null;
    } else {
        if (reqSegs.length !== routeSegs.length) return null;
    }

    const params = {};
    const checkLen = hasWildcard ? routeSegs.length - 1 : routeSegs.length;

    for (let i = 0; i < checkLen; i++) {
        const seg = routeSegs[i];
        if (seg.startsWith(':')) {
            params[seg.slice(1)] = decodeURIComponent(reqSegs[i]);
        } else if (seg !== reqSegs[i]) {
            return null;
        }
    }

    if (hasWildcard) {
        params['*'] = reqSegs.slice(routeSegs.length - 1).join('/');
    }

    return params;
}

/**
 * Parse a request URL into pathname and query object.
 * Avoids the overhead of the full URL constructor for relative paths.
 */
export function parseUrl(req) {
    const raw = req.url || '/';
    const qIdx = raw.indexOf('?');
    const pathname = qIdx < 0 ? raw : raw.slice(0, qIdx);
    const search = qIdx < 0 ? '' : raw.slice(qIdx + 1);

    const query = {};
    if (search) {
        for (const pair of search.split('&')) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx < 0) {
                query[decodeURIComponent(pair)] = '';
            } else {
                query[decodeURIComponent(pair.slice(0, eqIdx))] =
                    decodeURIComponent(pair.slice(eqIdx + 1));
            }
        }
    }

    return { pathname, query };
}
