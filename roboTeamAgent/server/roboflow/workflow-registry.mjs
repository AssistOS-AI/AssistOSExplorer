import path from 'node:path';
import {
    DEFAULT_WORKFLOW_ID, EXECUTION_TYPES, MAX_DESCRIPTION_LENGTH, MAX_MEMBERS, MAX_NAME_LENGTH,
    MAX_SELECTION_LENGTH, MEMBER_ID_PATTERN, WORKFLOW_ID_PATTERN, WORKFLOWS_DIR,
} from './constants.mjs';
import { ensureDirectory, listFiles, readJson, removePath, withLock, writeJsonAtomic } from './storage.mjs';

const SCHEMA = 'roboflow-workflow-v1';

function invalid(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeName(value, field = 'name') {
    const name = String(value ?? '').trim();
    if (!name) throw invalid(`workflow ${field} is required`);
    if (name.length > MAX_NAME_LENGTH) throw invalid(`workflow ${field} must be at most ${MAX_NAME_LENGTH} characters`);
    return name;
}

function normalizeDescription(value) {
    const description = String(value ?? '').trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) throw invalid(`workflow description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
    return description;
}

function normalizeSelection(value, field) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw invalid(`${field} must be an array`);
    const entries = value.map((entry) => String(entry ?? '').trim()).filter(Boolean);
    if (entries.length > 100) throw invalid(`${field} allows at most 100 entries`);
    if (entries.join(',').length > MAX_SELECTION_LENGTH) throw invalid(`${field} is too long`);
    return [...new Set(entries)];
}

export function slugifyWorkflow(value) {
    const slug = String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || 'workflow';
}

function normalizeMember(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('workflow member must be an object');
    const robotName = String(raw.robotName ?? '').trim();
    if (!robotName || robotName.length > 80) throw invalid('workflow member robotName is required');
    const executionType = String(raw.executionType ?? '').trim();
    if (!EXECUTION_TYPES.includes(executionType)) {
        throw invalid(`workflow member executionType must be one of ${EXECUTION_TYPES.join(', ')}`);
    }
    const id = String(raw.id ?? '').trim() || `${slugifyWorkflow(robotName)}-${index + 1}`;
    if (!MEMBER_ID_PATTERN.test(id)) throw invalid('workflow member id is invalid');
    return {
        id,
        robotName,
        role: String(raw.role ?? '').trim().slice(0, 500),
        executionType,
        skillSets: normalizeSelection(raw.skillSets ?? raw.skillsets, 'member skillSets'),
        skills: normalizeSelection(raw.skills, 'member skills'),
        decisionMaker: raw.decisionMaker === true || raw.decision === true,
    };
}

export function normalizeWorkflow(input, { id } = {}) {
    const name = normalizeName(input?.name);
    const description = normalizeDescription(input?.description);
    const requestedId = String(input?.id ?? id ?? '').trim();
    const workflowId = requestedId || slugifyWorkflow(name);
    if (!WORKFLOW_ID_PATTERN.test(workflowId)) throw invalid('workflow id is invalid');
    const rawMembers = input?.members;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) throw invalid('workflow must declare at least one member');
    if (rawMembers.length > MAX_MEMBERS) throw invalid(`workflow allows at most ${MAX_MEMBERS} members`);
    const members = rawMembers.map((member, index) => normalizeMember(member, index));
    const ids = new Set();
    for (const member of members) {
        if (ids.has(member.id)) throw invalid(`duplicate workflow member id: ${member.id}`);
        ids.add(member.id);
    }
    const requestedDecision = String(input?.decisionMemberId ?? '').trim();
    const flagged = members.filter((member) => member.decisionMaker);
    let decisionMemberId = requestedDecision;
    if (!decisionMemberId) {
        if (flagged.length > 1) throw invalid('workflow must select exactly one decision member');
        decisionMemberId = flagged[0]?.id || '';
    }
    if (!decisionMemberId) throw invalid('workflow must select a decision member');
    if (!ids.has(decisionMemberId)) throw invalid(`decision member is not part of this workflow: ${decisionMemberId}`);
    return { id: workflowId, name, description, decisionMemberId,
        members: members.map(({ decisionMaker, ...member }) => member) };
}

/** Public catalog projection handed to the front copilot instead of robot discovery. */
export function workflowCatalogEntry(workflow) {
    return {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description || '',
        decisionMemberId: workflow.decisionMemberId
            || workflow.members?.find((member) => member.decisionMaker)?.id
            || workflow.members?.[0]?.id || '',
        members: (workflow.members || []).map((member) => ({
            id: member.id,
            robotName: member.robotName,
            role: member.role || '',
            executionType: member.executionType,
            decisionMaker: member.id === workflow.decisionMemberId,
        })),
    };
}

export class WorkflowRegistry {
    constructor(options = {}) {
        this.directory = path.resolve(options.directory || WORKFLOWS_DIR);
    }

    async initialize() {
        await ensureDirectory(this.directory);
    }

    file(workflowId) {
        if (!WORKFLOW_ID_PATTERN.test(String(workflowId || ''))) throw invalid('invalid workflow id');
        const resolved = path.resolve(this.directory, `${workflowId}.json`);
        if (path.dirname(resolved) !== this.directory) throw invalid('invalid workflow path');
        return resolved;
    }

    async _read(workflowId) {
        const record = await readJson(this.file(workflowId));
        if (!record) return null;
        if (record.schema !== SCHEMA || record.id !== workflowId) throw new Error(`workflow record is invalid for ${workflowId}`);
        return record;
    }

    async list() {
        await this.initialize();
        const records = [];
        for (const name of (await listFiles(this.directory, '.json'))) {
            const workflowId = name.slice(0, -'.json'.length);
            if (!WORKFLOW_ID_PATTERN.test(workflowId)) continue;
            try {
                records.push(await this._read(workflowId));
            } catch {
                // Corrupt records stay private and are omitted from listings.
            }
        }
        return records.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    }

    async get(workflowId) {
        await this.initialize();
        return this._read(workflowId);
    }

    async create(input) {
        await this.initialize();
        const normalized = normalizeWorkflow(input);
        return withLock(`workflow:${normalized.id}`, async () => {
            if (await this._read(normalized.id)) throw Object.assign(invalid('workflow id already exists'), { statusCode: 409 });
            const now = new Date().toISOString();
            const record = { schema: SCHEMA, ...normalized, createdAt: now, updatedAt: now };
            await writeJsonAtomic(this.file(normalized.id), record);
            return record;
        });
    }

    /** Idempotently installs a workflow record only when the id is absent. */
    async ensure(input) {
        await this.initialize();
        const normalized = normalizeWorkflow(input);
        return withLock(`workflow:${normalized.id}`, async () => {
            const existing = await this._read(normalized.id);
            if (existing) return existing;
            const now = new Date().toISOString();
            const record = { schema: SCHEMA, ...normalized, createdAt: now, updatedAt: now };
            await writeJsonAtomic(this.file(normalized.id), record);
            return record;
        });
    }

    async remove(workflowId) {
        await this.initialize();
        if (workflowId === DEFAULT_WORKFLOW_ID) {
            throw Object.assign(invalid('the default workflow cannot be deleted'), { statusCode: 409 });
        }
        const record = await this._read(workflowId);
        if (!record) return false;
        await withLock(`workflow:${workflowId}`, () => removePath(this.file(workflowId)));
        return true;
    }

    // Replaces a workflow record in place with a new normalized definition.
    // Identity and creation time are preserved; the caller owns the not-found check.
    async update(workflowId, input) {
        await this.initialize();
        if (workflowId === DEFAULT_WORKFLOW_ID) {
            throw Object.assign(invalid('the default workflow cannot be edited'), { statusCode: 409 });
        }
        const normalized = normalizeWorkflow(input, { id: workflowId });
        return withLock(`workflow:${workflowId}`, async () => {
            const existing = await this._read(workflowId);
            if (!existing) return null;
            const record = { schema: SCHEMA, ...normalized, id: workflowId,
                createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
            await writeJsonAtomic(this.file(workflowId), record);
            return record;
        });
    }
}

export const workflowRegistryInternals = { SCHEMA, normalizeMember, slugifyWorkflow, invalid };
