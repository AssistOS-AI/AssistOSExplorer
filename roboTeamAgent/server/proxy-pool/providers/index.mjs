import webshare from './webshare.mjs';
import staticList from './static.mjs';

// A provider turns one account's configuration into a list of proxies:
//   id, label, fields            identity and the configuration form ({ name, label, secret, multiline })
//   normalizeConfig(input)       validated configuration to store, or throws
//   describeConfig(config)       short non-secret summary for the dashboard
//   listProxies(config, deps)    [{ externalId, scheme, host, port, username, password, country, city, available }]
//                                throws an error with `credentialsRejected` when the account is refused
// The pool, the relay and the containers never depend on which provider supplied a proxy.
export const PROXY_PROVIDERS = Object.freeze({
    [webshare.id]: webshare,
    [staticList.id]: staticList,
});

export function proxyProvider(id) {
    const provider = Object.hasOwn(PROXY_PROVIDERS, id) ? PROXY_PROVIDERS[id] : null;
    if (!provider) throw new Error('proxy provider is invalid');
    return provider;
}

export function publicProviders() {
    return Object.values(PROXY_PROVIDERS).map(({ id, label, fields }) => ({ id, label, fields }));
}
