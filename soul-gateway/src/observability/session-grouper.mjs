/**
 * Session grouping algorithm.
 *
 * Derives a group_key and group_display from request identity:
 *  - If explicit session ID: group by that
 *  - Otherwise: group by (api_key_id, agent_name)
 */
export function deriveSessionGrouping({ apiKeyId, agentName, soulId, explicitSessionId }) {
  if (explicitSessionId) {
    return {
      groupKey: `explicit:${explicitSessionId}`,
      groupDisplay: `Session ${explicitSessionId}`,
    };
  }

  const keyPart = apiKeyId || 'unknown';
  const agentPart = agentName || 'unknown';
  return {
    groupKey: `implicit:${keyPart}:${agentPart}`,
    groupDisplay: `${agentPart} (key ${keyPart.slice(0, 8)})`,
  };
}
