import { UserpersistoBillingPresenter } from '/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/billing.mjs';
import { callAgentTool, ensureSuccess, parseToolResult } from '/explorer/services/infrastructure/explorerApi.js';

async function callBilling(name, args = {}) {
    const raw = await callAgentTool('userPersistoAgent', name, args, { raw: true });
    ensureSuccess(raw);
    const result = parseToolResult(raw) || {};
    if (result.error || result.ok === false) throw new Error(result.error || 'Payment settings request failed.');
    return result;
}

export class UserpersistoBillingSettings extends UserpersistoBillingPresenter {
    constructor(element, invalidate) { super(element, invalidate, callBilling); }
}
