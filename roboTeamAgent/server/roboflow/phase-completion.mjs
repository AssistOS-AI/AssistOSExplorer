import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export function completionInstruction(step, runtimeTaskId) {
    return step
        ? `Before ending phase ${step}, use the workflow completion helper with completionId=${runtimeTaskId}. This is the current attempt ID. Finish all required work in this phase. Await each native call before invoking the next. Incomplete work is a continuation: finish it here or yield normally so RoboTeam can resume this same phase. Report a blocker only for a specific failed operation that cannot be recovered and name its error and attempted recovery.`
        : '';
}

async function openEvidence(root, relative) {
    if (typeof relative !== 'string' || /[\\\0]/.test(relative)
        || relative.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Invalid completion evidence path');
    }
    const file = path.join(root, relative);
    if (await fs.realpath(file) !== file) throw new Error('Completion evidence must be inside the run without symlinks');
    return fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
}

async function readEvidence(root, relative) {
    const handle = await openEvidence(root, relative);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid completion evidence file');
        const buffer = Buffer.alloc(65537);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size) throw new Error('Completion evidence changed while reading');
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function matchesArtifact(root, artifact) {
    const handle = await openEvidence(root, artifact.path);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || (artifact.size !== undefined && stat.size !== artifact.size)) return false;
        const hash = createHash('sha256');
        let size = 0;
        for await (const bytes of handle.createReadStream({ autoClose: false, end: stat.size })) {
            size += bytes.length;
            hash.update(bytes);
        }
        return size === stat.size && hash.digest('hex') === artifact.sha256;
    } finally {
        await handle.close();
    }
}

export async function verifyPhaseCompletion(folder, node, runtimeTaskId) {
    if (!node?.requiresCompletionEvidence) return;
    try {
        const root = await fs.realpath(folder);
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runtimeTaskId)) throw new Error('Invalid completion identity');
        const receipt = JSON.parse(await readEvidence(root, `.workflow-completion/${runtimeTaskId}.json`));
        if (receipt.step !== node.id || receipt.completionId !== runtimeTaskId
            || !/^[a-f0-9]{64}$/.test(receipt.artifact?.sha256 || '')) {
            throw new Error('Completion receipt does not match this phase attempt');
        }
        if (!await matchesArtifact(root, receipt.artifact)) {
            throw new Error('The saved artifact changed after the completion check');
        }
        if (receipt.outputs !== undefined) {
            if (!Array.isArray(receipt.outputs) || receipt.outputs.length > 256
                || receipt.outputs.some(output => !Number.isSafeInteger(output?.size) || output.size < 1
                    || !/^[a-f0-9]{64}$/.test(output.sha256))) throw new Error('Invalid completion output list');
            for (const output of receipt.outputs) {
                if (!await matchesArtifact(root, output)) throw new Error('Completion artifact changed after verification');
            }
        }
        return receipt;
    } catch (error) {
        const reason = error.code === 'ENOENT' ? 'missing completion receipt or artifact' : error.message;
        throw Object.assign(new Error(`Phase ${node.id} did not complete: ${reason}`), {code: 'phase_evidence_incomplete'});
    }
}
