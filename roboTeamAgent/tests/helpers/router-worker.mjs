import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_PREFIX, signedPrincipal } from './router-signed.mjs';

// Router-signed requests for RoboTeam's `/api/worker/*` routes, minted the way the Router does
// for a request it routes: the route declaration is chosen from RoboTeam's real manifest by the
// Router's first-match rule (Ploinky `edgeRoutePlan.js` conventionAuthDefinition), normalized by
// the real route-auth normalizer, and the auth-info header (invocation token and any grants) is
// built by the real HTTP-route minter. Importing router-signed.mjs configures the verifier env.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../../ploinky/', import.meta.url));
const load = (relative) => import(new URL(relative, `file://${PLOINKY_ROOT}`).href);
const { buildHttpRouteAuthInfoHeader } = await load('cli/server/routerHandlers.js');
const { normalizeHttpRouteAuthDefinition } = await load('cli/server/httpRouteAuth.js');
const { normalizeManifestHttpRouteAccess } = await load('cli/server/policy/HttpRouteProviders.js');
const { HttpRouteAccessPath } = await load('cli/server/policy/HttpRouteAccessPath.js');
const { sha256RawBodyHash } = await load('Agent/lib/requestHash.mjs');

export { EXTERNAL_PREFIX, signedPrincipal };
export const MANIFEST_PATH = fileURLToPath(new URL('../../manifest.json', import.meta.url));
export const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const ROUTE = { repo: 'AchillesIDE', agent: 'roboTeamAgent' };

// The declaration the Router uses for an authenticated request to `externalPath`.
export function routeDeclaration(externalPath, manifest = readManifest()) {
    const specs = Array.isArray(manifest?.routerAccess?.httpRoutes) ? manifest.routerAccess.httpRoutes : [];
    return specs.map((spec) => ({ spec, normalized: normalizeManifestHttpRouteAccess(spec, { routeKey: 'roboTeamAgent' }) }))
        .filter(({ normalized }) => normalized.ok && HttpRouteAccessPath.matches(externalPath, normalized.path))
        .find(({ normalized }) => normalized.access === 'authenticated')?.spec || {};
}

export function routeDefinition(externalPath, manifest = readManifest()) {
    const declaration = routeDeclaration(externalPath, manifest);
    return normalizeHttpRouteAuthDefinition('roboTeamAgent', ROUTE, {
        port: 3001, path: `${EXTERNAL_PREFIX}/`, access: 'authenticated',
        ...(Array.isArray(declaration.delegations) ? { delegations: declaration.delegations } : {}),
    });
}

// Headers for one routed request by `user` ({id, roles}) over the exact method, path and body.
export function routedHeaders(user, method, pathWithQuery, bodyString = '', { manifest } = {}) {
    const external = `${EXTERNAL_PREFIX}${pathWithQuery}`;
    const parsed = new URL(`http://127.0.0.1:8080${external}`);
    const req = { method, url: external, headers: {}, user: signedPrincipal(user) };
    return buildHttpRouteAuthInfoHeader(req, parsed, routeDefinition(parsed.pathname, manifest), {
        bodyHash: sha256RawBodyHash(Buffer.from(bodyString)), routePath: new URL(`http://127.0.0.1:8080${pathWithQuery}`).pathname,
    });
}

export function decodeJwtPayload(token) {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
}

export function authInfoOf(headers) {
    return JSON.parse(headers['x-ploinky-auth-info']);
}
