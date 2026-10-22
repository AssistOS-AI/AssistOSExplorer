export function deriveSameRepoAgentPrincipal(agentName, env = process.env) {
  const self = String(env.PLOINKY_AGENT_ID || '').trim();
  const match = self.match(/^agent:([^/\s:]+)\/([^/\s:]+)$/);
  if (!match) return '';
  return `agent:${match[1]}/${agentName}`;
}

export function defaultAgentPolicies(env = process.env) {
  const gitAgentPrincipal = deriveSameRepoAgentPrincipal('gitAgent', env);
  const policies = {
    'agent:legacy-agents/searchAgent': {
      secrets: { allowedRoles: ['read'] },
      updatedAt: new Date(0).toISOString()
    }
  };
  if (gitAgentPrincipal) {
    policies[gitAgentPrincipal] = {
      secrets: { allowedRoles: ['read'] },
      updatedAt: new Date(0).toISOString()
    };
  }
  return policies;
}

export function applyFreshDefaultAgentPolicies(manifest, env = process.env) {
  const defaults = defaultAgentPolicies(env);
  if (!manifest.agentPolicies || typeof manifest.agentPolicies !== 'object') {
    manifest.agentPolicies = {};
  }
  for (const [principalId, policy] of Object.entries(defaults)) {
    if (!manifest.agentPolicies[principalId]) {
      manifest.agentPolicies[principalId] = policy;
    }
  }
  return manifest;
}
