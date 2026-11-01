// All home inspection takes place inside the confined home helper.
export function createCodingAgentStatus({ homeOperation }) {
    return {
        async logins(id) { return (await homeOperation(id, 'status', { includeLogins: true })).logins; },
        async activeAgent(id) { return (await homeOperation(id, 'status', {})).activeAgent; },
        forget() {},
    };
}
