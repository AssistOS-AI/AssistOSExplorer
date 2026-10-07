import fs from 'node:fs';
import path from 'node:path';

export default class AcceptanceReporter {
    printsToStdio() { return false; }

    onBegin(_config, suite) { this.suite = suite; }

    onEnd(result) {
        const records = (this.suite?.allTests() || []).map(test => ({
            identity: `${path.basename(test.location.file)}::${test.title}`,
            expectedStatus: test.expectedStatus,
            outcome: test.outcome(),
            results: test.results.map(attempt => ({ status: attempt.status, retry: attempt.retry })),
        }));
        const root = process.env.SMOKE_ARTIFACT_DIR;
        if (!root) return { status: 'failed' };
        try {
            fs.mkdirSync(root, { recursive: true });
            fs.writeFileSync(path.join(root, process.env.SMOKE_DISCOVERY_ONLY === '1'
                ? 'ledger-discovery_codex.json' : 'ledger-outcomes_codex.json'), JSON.stringify({
                status: result.status, coverage: process.env.SMOKE_LEDGER_COVERAGE || 'inventory-only', records,
            }, null, 2), { flag: 'wx' });
        } catch {
            console.error('Smoke ledger artifact write failed; acceptance is refused.');
            return { status: 'failed' };
        }
    }
}
