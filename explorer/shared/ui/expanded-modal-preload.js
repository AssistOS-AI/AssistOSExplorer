// Loads the shared expanded modal shell component at most once at a time and remembers only a success.
// A failed attempt is not kept: the next call tries again, and callers that overlap share one attempt.
export function createExpandedModalPreload(webSkel, componentName = 'expanded-modal') {
    let loaded = null;
    let attempt = null;

    return function ensureExpandedModalReady() {
        if (loaded) return loaded;
        if (attempt) return attempt;
        const config = webSkel.configs?.components?.find((component) => component.name === componentName);
        // WebSkel keeps a failed load in its registry; clear it so the retry loads the component again.
        const discardFailedEntry = () => {
            const components = webSkel.ResourceManager?.components;
            if (components?.[componentName] && !components[componentName].isPromiseFulfilled) {
                delete components[componentName];
            }
        };
        const current = new Promise((resolve) => resolve(webSkel.ResourceManager.loadComponent(config))).then(
            (result) => {
                loaded = Promise.resolve(result);
                attempt = null;
                return result;
            },
            (error) => {
                attempt = null;
                discardFailedEntry();
                throw error;
            }
        );
        attempt = current;
        return current;
    };
}
