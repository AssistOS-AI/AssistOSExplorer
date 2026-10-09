import test from 'node:test';
import assert from 'node:assert/strict';
import { AgenticKnowledgeUnits, LLMAgent } from 'achillesAgentLib';

import { createWebAssistAgent } from '../src/index.mjs';
import { LOCAL_OPERATOR_ACCESS } from '../src/runtime/sessionAccess.mjs';
import { createWebAssistSandbox, ensureSiteAku, plannerDecision } from './helpers.mjs';
import { loadAkuContext } from '../src/runtime/load-aku-context.mjs';

const SITE_ID = 'demo-site';

class FakeWebAssistLLM extends LLMAgent {
    constructor() {
        super({
            name: 'FakeWebAssistLLM',
            invokerStrategy: async () => '',
        });
        this.calls = [];
    }

    async complete({ prompt, history, context }) {
        this.calls.push({ type: 'complete', prompt, context });

        if (context?.intent !== 'agentic-session-planner') {
            throw new Error(`Unexpected complete intent: ${context?.intent}`);
        }

        const runtimePrompt = String(context?.userPrompt ?? '');
        const sessionId = runtimePrompt.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1] || 'visitor-42';
        const siteId = runtimePrompt.match(/Site ID:\n([^\n]+)/)?.[1] || SITE_ID;

        const plannerContext = history.find((entry) => entry.role === 'system')?.message || '';
        if (!plannerContext.includes('TOOL[webassist-lead]')) {
            return plannerDecision({
                tool: 'webassist-lead',
                toolPrompt: JSON.stringify({
                    siteId,
                    sessionId,
                    contactInfo: {
                        email: 'alice@example.com',
                        name: 'Alice Example',
                    },
                    profile: 'Developer',
                    mandatoryConditionsSatisfied: true,
                    matchExplanation: 'High-intent developer asking for an API integration discussion.',
                    summary: 'High-intent developer asking for an API integration discussion.',
                }),
                reason: 'Create qualified lead.',
            });
        }

        if (!plannerContext.includes('TOOL[webassist-session]')) {
            return plannerDecision({
                tool: 'webassist-session',
                toolPrompt: JSON.stringify({
                    siteId,
                    sessionId,
                    profileDetails: ['Evaluating an API integration', 'Provided email address'],
                    contactInformation: {
                        name: 'Alice Example',
                        email: 'alice@example.com',
                    },
                }),
                reason: 'Persist profiling updates.',
            });
        }

        return plannerDecision({
            tool: 'final_answer',
            toolPrompt: 'Sigur — va putem ajuta cu integrarea API-ului. Mai jos gasiti linkul de programare.',
            reason: 'Return final runtime payload.',
        });
    }
}

test('webAssist agent loads AchillesAgentLib and executes a full visitor turn', async (t) => {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());

    await ensureSiteAku({
        siteId: SITE_ID,
    });
    const setupAku = new AgenticKnowledgeUnits({
        rootDir: `${sandbox.webAssistDataDir}/sites/${SITE_ID}`,
        actor: `webassist/${SITE_ID}`,
    });
    await setupAku.loadAKU();
    await setupAku.initKU({
        ku_id: 'ku_profile_developer',
        ku_name: 'Profile: Developer',
        ku_type: 'profile',
        tags: ['profile', 'developer'],
        keywords: ['developer'],
        summary: 'Developer target profile',
        state: 'Developers need API integration details and implementation guidance.',
    });

    const llmAgent = new FakeWebAssistLLM();
    const agent = await createWebAssistAgent({
        llmAgent,
    });

    const result = await agent.handleMessage({
        siteId: SITE_ID,
        sessionId: 'visitor-42',
        message: 'Buna, vreau sa integrez API-ul vostru. Sunt Alice, alice@example.com. Putem programa o discutie?',
        access: LOCAL_OPERATOR_ACCESS,
    });

    assert.equal(agent.achilles.libraryName, 'achillesAgentLib');
    assert.match(result.response, /integrarea API-ului/);
    assert.equal(result.sessionId, 'visitor-42');
    assert.ok(llmAgent.calls.length >= 3);
    assert.match(String(llmAgent.calls[0]?.context?.userPrompt ?? ''), /Predefined target profiles \(always loaded from AKU\):/);
    assert.match(String(llmAgent.calls[0]?.context?.userPrompt ?? ''), /Developers need API integration details/);
    assert.match(String(llmAgent.calls[0]?.context?.userPrompt ?? ''), /Conversation History \(last 10 messages\):/);

    const context = await loadAkuContext({
        siteId: SITE_ID,
        sessionId: 'visitor-42',
        message: 'verify context',
    });

    assert.equal(context.currentLead.exists, true);
    assert.equal(context.currentLead.profile, 'Developer');
    assert.equal(context.currentLead.contactInfo.email, 'alice@example.com');
    assert.match(context.currentLead.state, /Alice Example/);
    assert.match(context.currentLead.state, /Developer/);

    assert.equal(context.sessionProfile.contactInformation.email, 'alice@example.com');
    assert.equal(context.sessionProfile.contactInformation.name, 'Alice Example');
    assert.match(context.sessionProfileText, /Evaluating an API integration/);
    assert.match(context.conversationHistoryText, /Buna, vreau sa integrez API-ul vostru/);
    assert.match(context.conversationHistoryText, /Mai jos gasiti linkul de programare/);
});
