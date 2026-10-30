// The error of an execution that cannot be set up (a refused grant, unreadable robot storage, an unavailable model channel).
// `reason` is a bounded code; the dispatcher stores it as the attempt's end reason. It lives apart from executionFactory.mjs so that
// the modules the factory uses (modelChannel.mjs) can throw it without importing the factory.
export class ExecutionSetupError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'ExecutionSetupError';
        this.reason = reason;
    }
}
