import assert from 'node:assert/strict';
import { decodeMcpResult } from './contracts.mjs';

// Reuse the operator's private authenticated browser state. No caller,
// forwarded actor or grants are forged.
export async function explorerListing(runtime, directory) {
    assert.ok(runtime.auth, 'Authenticated controller session is required.');
    const proof = await runtime.auth.mutationHeaders('explorer');
    const initialize = await runtime.auth.request('/explorer/mcp', { method: 'POST', headers: {
        ...proof.headers, accept: 'application/json, text/event-stream',
    },
        body: { jsonrpc: '2.0', id: 'controller-init', method: 'initialize', params: {
            protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance-controller', version: '1' },
        } } });
    const session = initialize.headers['mcp-session-id'];
    assert.ok(initialize.status === 200 && session && !initialize.payload.error && initialize.payload.result?.protocolVersion,
        'Explorer MCP initialization failed.');
    const response = await runtime.auth.request('/explorer/mcp', { method: 'POST', headers: {
        ...proof.headers, accept: 'application/json, text/event-stream',
        'mcp-session-id': session, 'mcp-protocol-version': initialize.payload.result.protocolVersion,
    }, body: { jsonrpc: '2.0', id: 'controller-list', method: 'tools/call',
        params: { name: 'list_directory_detailed', arguments: { path: directory } } } });
    assert.equal(response.status, 200, 'Authenticated Explorer listing failed.');
    return { listing: decodeMcpResult(response.payload), generation: proof.generation };
}
