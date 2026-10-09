import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMAgent } from 'achillesAgentLib';

import { createWebAssistAgent } from '../src/index.mjs';
import { LOCAL_OPERATOR_ACCESS } from '../src/runtime/sessionAccess.mjs';
import { createWebAssistSandbox, ensureSiteAku, plannerDecision } from './helpers.mjs';
import { loadAkuContext } from '../src/runtime/load-aku-context.mjs';

const SITE_ID = 'demo-site';

class FakeFlowSynthesisLLM extends LLMAgent {
    constructor() {
        super({
            name: 'FakeFlowSynthesisLLM',
            invokerStrategy: async () => '',
        });
        this.firstTurnPersisted = false;
        this.secondTurnPersisted = false;
    }

    async complete({ prompt, context }) {
        if (context?.intent !== 'agentic-session-planner') {
            throw new Error(`Unexpected complete intent: ${context?.intent}`);
        }

        const userPrompt = String(context?.userPrompt ?? '');
        const sessionId = userPrompt.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1] || 'session-flow';
        const siteId = userPrompt.match(/Site ID:\n([^\n]+)/)?.[1] || SITE_ID;
        const isSecondTurn = userPrompt.includes('I can share some papers later');

        if (isSecondTurn) {
            if (!this.secondTurnPersisted) {
                this.secondTurnPersisted = true;
                return plannerDecision({
                    tool: 'webassist-session',
                    toolPrompt: JSON.stringify({
                        siteId,
                        sessionId,
                        profileDetails: [
                            'Interested in research collaboration',
                            'Open to academic-industry partnerships',
                            'The user did not answer the question about available datasets and student resources.',
                            'The user is asked about project timeline and expected outcomes. His/her next reply should answer the question.',
                        ],
                        contactInformation: {
                            name: 'Research Visitor',
                            email: 'research.visitor@example.com',
                        },
                    }),
                    reason: 'Persist second-turn profile data.',
                });
            }

            return plannerDecision({
                tool: 'final_answer',
                toolPrompt: 'Thanks. I still need one detail: what project timeline and expected outcomes do you have?',
                reason: 'Return second turn payload.',
            });
        }

        if (!this.firstTurnPersisted) {
            this.firstTurnPersisted = true;
            return plannerDecision({
                tool: 'webassist-session',
                toolPrompt: JSON.stringify({
                    siteId,
                    sessionId,
                    profileDetails: [
                        'Interested in research collaboration',
                        'The user is asked about available datasets and student resources. His/her next reply should answer the question.',
                    ],
                    contactInformation: {
                        name: 'Research Visitor',
                    },
                }),
                reason: 'Persist first-turn profile data.',
            });
        }

        return plannerDecision({
            tool: 'final_answer',
            toolPrompt: 'Great. What available datasets and student resources can you provide for collaboration?',
            reason: 'Return first turn payload.',
        });
    }
}

test('webAssist persists orchestrator-authored conversation memory inside session KU and history', async (t) => {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());

    await ensureSiteAku({
        siteId: SITE_ID,
    });

    const agent = await createWebAssistAgent({
        llmAgent: new FakeFlowSynthesisLLM(),
    });

    const firstTurn = await agent.handleMessage({
        siteId: SITE_ID,
        sessionId: 'session-flow-1',
        message: 'Can we collaborate on AI research?',
        access: LOCAL_OPERATOR_ACCESS,
    });

    assert.equal(firstTurn.response, 'Great. What available datasets and student resources can you provide for collaboration?');

    const secondTurn = await agent.handleMessage({
        siteId: SITE_ID,
        sessionId: 'session-flow-1',
        message: 'I can share some papers later.',
        access: LOCAL_OPERATOR_ACCESS,
    });

    assert.equal(secondTurn.response, 'Thanks. I still need one detail: what project timeline and expected outcomes do you have?');

    const context = await loadAkuContext({
        siteId: SITE_ID,
        sessionId: 'session-flow-1',
        message: 'I can share some papers.',
    });

    assert.match(context.sessionProfileText, /The user did not answer the question about available datasets and student resources/);
    assert.match(context.sessionProfileText, /The user is asked about project timeline and expected outcomes/);
    assert.equal(context.sessionProfile.contactInformation.name, 'Research Visitor');
    assert.equal(context.sessionProfile.contactInformation.email, 'research.visitor@example.com');

    assert.match(context.conversationHistoryText, /Can we collaborate on AI research/);
    assert.match(context.conversationHistoryText, /I can share some papers later/);
});
