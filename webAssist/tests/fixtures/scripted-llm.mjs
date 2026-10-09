import { LLMAgent } from 'achillesAgentLib';

import { plannerDecision } from '../helpers.mjs';

// A planner-only fake LLM. Each `complete` call takes the next scripted step
// (an object or a function of the runtime prompt) and answers with a final
// response when the script is exhausted. Every call's full arguments are kept
// as JSON so tests can assert what reached the model.
export class ScriptedPlannerLLM extends LLMAgent {
    constructor(steps = [], { finalAnswer = 'Scripted answer.', onComplete = null } = {}) {
        super({ name: 'ScriptedPlannerLLM', invokerStrategy: async () => '' });
        this.steps = [...steps];
        this.finalAnswer = finalAnswer;
        this.onComplete = onComplete;
        this.calls = [];
    }

    async complete({ prompt, history, context }) {
        this.calls.push(JSON.stringify({ prompt, history, context }));
        if (context?.intent !== 'agentic-session-planner') {
            throw new Error(`Unexpected complete intent: ${context?.intent}`);
        }
        const userPrompt = String(context?.userPrompt ?? '');
        if (this.onComplete) {
            await this.onComplete({ userPrompt, callIndex: this.calls.length - 1 });
        }
        const next = this.steps.shift();
        const step = typeof next === 'function' ? next({ userPrompt }) : next;
        if (step) {
            return plannerDecision({ tool: step.tool, toolPrompt: step.toolPrompt, reason: step.reason || 'Scripted step.' });
        }
        return plannerDecision({ tool: 'final_answer', toolPrompt: this.finalAnswer, reason: 'Scripted final answer.' });
    }

    allCallsText() {
        return this.calls.join('\n');
    }
}

export function sessionIdFromRuntimePrompt(userPrompt) {
    return String(userPrompt).match(/Session ID:\n([^\n]+)/)?.[1] || '';
}
