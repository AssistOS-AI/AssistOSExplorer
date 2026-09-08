
export function createSanitizer(context, env) {
    const secretKey = /token|secret|password|authorization|cookie|(?:^|_)api_?key|private_?key|credential/i;
    const secrets = new Set();
    const visited = new WeakSet();
    const collect = (value) => {
        if (!value || typeof value !== 'object' || visited.has(value)) return;
        visited.add(value);
        for (const [key, child] of Object.entries(value)) {
            if (secretKey.test(key) && typeof child === 'string' && child) secrets.add(child);
            else if (child && typeof child === 'object' && key !== 'signal') collect(child);
        }
    };
    collect(context);
    collect(env);
    return function sanitize(value) {
        if (typeof value === 'string') {
            let clean = value;
            for (const secret of secrets) clean = clean.split(secret).join('[redacted]');
            return clean.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]');
        }
        if (Array.isArray(value)) return value.map(sanitize);
        if (!value || typeof value !== 'object') return value;
        const result = {};
        for (const [key, child] of Object.entries(value)) {
            if (!secretKey.test(key) && key !== '__proto__' && key !== 'constructor') result[key] = sanitize(child);
        }
        return result;
    };
}
