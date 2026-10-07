import { redactTraceText } from './redacted-trace.mjs';

const safeText = value => redactTraceText(String(value || '')).slice(0, 2048);

export function createReadinessDiagnostics({ now = () => new Date().toISOString() } = {}) {
    let priorSignature = '';
    const evidence = { samples: [], stableSamples: 0, lastFailure: {
        stage: 'missing-stable-samples', at: now(), message: 'No stable runtime samples have been observed.',
    } };
    function failure(error, stage) {
        evidence.stableSamples = 0;
        priorSignature = '';
        evidence.lastFailure = { stage, at: now(), message: safeText(error?.message || error) };
        if (error?.message === 'Box outer container generation is not fresh enough for the release gate.') throw error;
        return false;
    }
    return {
        evidence,
        sample(collect, validate) {
            let candidate;
            try { candidate = collect(); } catch (error) {
                return failure(error, /workspace|bind mount/i.test(error.message) ? 'workspace-binding' : 'collection');
            }
            try { validate(candidate); } catch (error) { return failure(error, 'eligibility'); }
            const identities = candidate.agents.slice(0, 64).map(agent => ({
                agentName: safeText(agent.agentName), containerId: safeText(agent.containerId),
                instanceId: safeText(agent.instanceId), enableGeneration: safeText(agent.enableGeneration),
                projectedTarget: agent.projectedTarget ? {
                    kind: agent.projectedTarget.kind, access: agent.projectedTarget.access,
                    label: safeText(agent.projectedTarget.label), detail: safeText(agent.projectedTarget.detail),
                    cwdDisplay: safeText(agent.projectedTarget.cwdDisplay),
                } : null,
            }));
            const signature = JSON.stringify(candidate.agents.map(agent => ({
                agentName: agent.agentName, containerId: agent.containerId, instanceId: agent.instanceId,
                enableGeneration: agent.enableGeneration, projectedTarget: agent.projectedTarget,
            })));
            evidence.stableSamples = signature === priorSignature ? evidence.stableSamples + 1 : 1;
            priorSignature = signature;
            evidence.samples.push({ at: now(), identities, stableSamples: evidence.stableSamples });
            evidence.samples = evidence.samples.slice(-12);
            if (evidence.stableSamples < 3) evidence.lastFailure = {
                stage: 'unstable-signatures', at: now(), message: 'Three consecutive stable runtime samples have not been observed.',
            };
            else evidence.lastFailure = null;
            return evidence.stableSamples >= 3;
        },
    };
}

export async function withFailureArtifact(operation, attach, evidence, { report = message => console.error(message) } = {}) {
    let primary = null;
    let value;
    try { value = await operation(); } catch (error) { primary = error; }
    try { await attach(Buffer.from(redactTraceText(JSON.stringify(evidence, null, 2)))); } catch (error) {
        if (!primary) throw error;
        // Keep the original assertion/collector error as the primary error.
        primary.artifactFailure = safeText(error.message);
        report(`Diagnostic artifact write failed: ${safeText(error.message)}`);
    }
    if (primary) throw primary;
    return value;
}
