// Persisted coordinator bindings (S1x). The single module that touches the binding table.
//
// A binding is the owner half of a background flow or schedule: it records, once, the
// verified owner on whose behalf a coordinator may later admit work under
// `coordinator:<principal>` / `binding:<id>`. A root binding takes its owner from a verified
// owner grant (`evidence 'owner-grant'`); a derived binding inherits its parent's owner
// (`evidence 'derived'`). Every column except `state` and `fence_revision` is immutable and
// rows are never deleted. An admission requires both the binding and its root to be active.
//
// Schema version 5 (S6 source-only subset) adds the Part D shapes: a root created by an
// accepted obligation (`evidence 'obligation'`, kind `flow` or `generation`), the fence
// states `paused` and `cancelled` (roots only), and `fence_revision`. The only state moves
// are active->paused, active->cancelled, paused->active and paused->cancelled; `cancelled` is
// final, and every move increments `fence_revision` by one in the same statement. Only an
// accepted obligation creates an `obligation` binding, and only a fence or a continuation
// accept moves a state (workerState.mjs, Part D). `registerBinding` registers only the kinds
// below, with evidence `owner-grant` or `derived`, and never an ID with the `gen_` prefix.

export const BINDING_KINDS = Object.freeze(['flow', 'schedule']);
export const BINDING_MAX_DEPTH = 16;
export const BINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const COORDINATOR_PREFIX = 'coordinator:';
const BINDING_PREFIX = 'binding:';
const OWNER_PREFIX = 'owner:user:';

export const BINDING_SCHEMA_SQL = `
CREATE TABLE binding (
    coordinator TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('flow', 'schedule', 'generation')),
    owner_id TEXT NOT NULL,
    evidence TEXT NOT NULL CHECK (evidence IN ('owner-grant', 'derived', 'obligation')),
    parent_binding_id TEXT,
    root_binding_id TEXT NOT NULL,
    depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 16),
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'cancelled')),
    fence_revision INTEGER NOT NULL DEFAULT 0 CHECK (fence_revision >= 0),
    scope TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    generation_id TEXT NOT NULL REFERENCES generation(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (coordinator, binding_id),
    CHECK ((depth = 0) = (parent_binding_id IS NULL)),
    CHECK (depth != 0 OR (root_binding_id = binding_id AND evidence IN ('owner-grant', 'obligation'))),
    CHECK (depth = 0 OR evidence = 'derived'),
    CHECK (evidence != 'obligation' OR kind IN ('flow', 'generation')),
    CHECK (kind != 'generation' OR evidence = 'obligation'),
    CHECK (state = 'active' OR depth = 0)
);
CREATE TRIGGER binding_no_delete BEFORE DELETE ON binding BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER binding_immutable BEFORE UPDATE ON binding
WHEN NEW.coordinator IS NOT OLD.coordinator OR NEW.binding_id IS NOT OLD.binding_id OR NEW.kind IS NOT OLD.kind
    OR NEW.owner_id IS NOT OLD.owner_id OR NEW.evidence IS NOT OLD.evidence
    OR NEW.parent_binding_id IS NOT OLD.parent_binding_id OR NEW.root_binding_id IS NOT OLD.root_binding_id
    OR NEW.depth IS NOT OLD.depth OR NEW.scope IS NOT OLD.scope OR NEW.operation_id IS NOT OLD.operation_id
    OR NEW.generation_id IS NOT OLD.generation_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER binding_fence BEFORE UPDATE ON binding
WHEN NOT (
        (NEW.state IS OLD.state AND NEW.fence_revision IS OLD.fence_revision)
        OR (NEW.fence_revision = OLD.fence_revision + 1 AND (
            (OLD.state = 'active' AND NEW.state IN ('paused', 'cancelled'))
            OR (OLD.state = 'paused' AND NEW.state IN ('active', 'cancelled'))
        ))
    )
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
`;

export function isBindingId(value) {
    return typeof value === 'string' && BINDING_ID_PATTERN.test(value);
}

// The coordinator principal of a `coordinator:<principal>` namespace, or null.
export function coordinatorOf(namespace) {
    if (typeof namespace !== 'string' || !namespace.startsWith(COORDINATOR_PREFIX)) return null;
    const principal = namespace.slice(COORDINATOR_PREFIX.length);
    return principal.length > 0 ? principal : null;
}

// The binding ID of a `binding:<id>` origin key, or null.
export function bindingOf(originKey) {
    if (typeof originKey !== 'string' || !originKey.startsWith(BINDING_PREFIX)) return null;
    const id = originKey.slice(BINDING_PREFIX.length);
    return isBindingId(id) ? id : null;
}

export function isOwnerKey(originKey) {
    return typeof originKey === 'string' && originKey.startsWith(OWNER_PREFIX) && originKey.length > OWNER_PREFIX.length;
}

export function getBinding(db, coordinator, bindingId) {
    return db.prepare('SELECT * FROM binding WHERE coordinator = ? AND binding_id = ?').get(coordinator, bindingId);
}

// The binding and its root are both active (P2/P5 fences cascade through the root).
export function isActiveBinding(db, binding) {
    if (!binding || binding.state !== 'active') return false;
    if (binding.root_binding_id === binding.binding_id) return true;
    const root = getBinding(db, binding.coordinator, binding.root_binding_id);
    return root !== undefined && root.state === 'active';
}

export function countBindings(db) {
    return db.prepare('SELECT COUNT(*) AS count FROM binding').get().count;
}

export function insertBinding(db, row) {
    db.prepare(`INSERT INTO binding (coordinator, binding_id, kind, owner_id, evidence, parent_binding_id, root_binding_id, depth, state, scope, operation_id, generation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .run(row.coordinator, row.bindingId, row.kind, row.ownerId, row.evidence, row.parentBindingId, row.rootBindingId, row.depth,
            row.scope, row.operationId, row.generationId, row.now);
}

// The generation-ticket prefix: such a binding is created only by an accepted obligation.
export const GENERATION_PREFIX = 'gen_';

// One fence move of a root binding (active->paused|cancelled, paused->active|cancelled), with
// fence_revision + 1 in the same statement; the binding_fence trigger refuses anything else.
export function moveBinding(db, coordinator, bindingId, state) {
    db.prepare('UPDATE binding SET state = ?, fence_revision = fence_revision + 1 WHERE coordinator = ? AND binding_id = ?').run(state, coordinator, bindingId);
    return getBinding(db, coordinator, bindingId);
}

// A root binding and every binding derived under it, under one coordinator.
export function bindingFamily(db, coordinator, rootBindingId) {
    return db.prepare('SELECT binding_id FROM binding WHERE coordinator = ? AND root_binding_id = ? ORDER BY rowid').all(coordinator, rootBindingId)
        .map((row) => row.binding_id);
}
