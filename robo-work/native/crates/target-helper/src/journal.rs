//! The management-private durable operation journal (plan section 5.6; T0 base sections 9 and 10), the native
//! counterpart of the helper side of `journalModel.mjs` (`prepare`, `commit`, `lookup`, `input`, `stop`, `observeExit`,
//! `release`, `retire`). Request checks, their order, refusal codes, receipt contents, receipt sequences and journal
//! revisions follow the model exactly; `tests/vectors/journal-differential.json` (generated from the model) proves it.
//!
//! # Storage
//!
//! Ploinky provisions a helper-only directory `<root>` before the target starts. Provisioning (never `open`) calls
//! [`Journal::create`], which mints a fresh store identity from the kernel CSPRNG, builds `<root>/.creating-<storeId>/`
//! completely (witness, `head.json`, `lock`, `records/`), fsyncs it, renames it to `<root>/journal` and returns the
//! identity and directory device/inode for Ploinky to record. `open` never creates anything: a missing journal, a witness
//! naming another store, or a lock held by another incarnation is `journal_unavailable`, never absence. A journal that
//! is lost and provisioned again gets a new identity, so it can never answer for the old store.
//!
//! | File | Content |
//! |---|---|
//! | `journal/journal-store.json` | Witness `{version:1, journalStoreIdentity}`, written once |
//! | `journal/head.json` | `{version:1, journalStoreIdentity, revision, entries}`, rewritten after every revision |
//! | `journal/lock` | `flock(LOCK_EX)` held for the handle's lifetime: one writer per journal |
//! | `journal/records/<sha256(keyText)>.json` | One canonical entry per operation key: a full record or a tombstone |
//!
//! A new key is published with `link(2)` from a fsynced temporary file, so the unique key is atomic (an existing file is
//! never overwritten by a new key); updates use `rename(2)`; the directory is fsynced after each. Opening scans every
//! entry and reconciles `head.json` (at most one revision ahead after a crash); a missing, extra, foreign or malformed
//! entry is `state_corrupt`. The handle keeps the set of key hashes it loaded or created, so a key file that vanishes
//! under it is `state_corrupt` (never absence) and a file that appears from elsewhere is refused. Every operation
//! re-checks the journal, witness and `records/` directory identities: a deleted, moved or replaced journal is
//! `journal_unavailable` for that handle.
//!
//! # Effects and crash safety
//!
//! Effects go through [`Hooks`]. The key and exact request are durable before the gated create; a record in `reserved`
//! state therefore means "create may have happened", so `Hooks::create` must be idempotent per key (the keeper launch
//! reconciles by its deterministic locator, P8). The gate-release intent is durable before the release effect and is
//! never replayed. Stop is idempotent and is sent before `stopping` is recorded. A hook failure is `outcome_unknown`.
//!
//! # Bounds
//!
//! `journalEntries` counts records and tombstones. `journalBytes` is enforced by reserving [`RECORD_BUDGET_BYTES`] for
//! every live record (its encoded size can never exceed that) plus the actual size of each tombstone; exhaustion refuses
//! new work and never evicts. Existing identical work still reconciles at capacity.
//!
//! # Deliberate differences from the model (each excluded from the differential vector and covered by native tests)
//!
//! | Case | Model | Here |
//! |---|---|---|
//! | Retried `prepare` of a stopped record that was never created | creates it and reports `prepared` | no create; returns the `stopping` receipt |
//! | Refused `input` that opened a new connection cursor | leaves a phantom cursor `{0, acknowledged}` | nothing persists |
//! | Input chunk history beyond the per-record budget | unbounded | `capacity_exceeded`, judged on the record's projected settled size |

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::Code;
use crate::canon::{self, Value, obj, s};
use crate::contract::{is_digest, is_digest_text, is_id, is_id_text, is_opaque_identity, is_operation_id, is_u64_text};
use crate::crypto::sha256_hex;

pub const RESOURCE_KINDS: [&str; 9] = ["keeper", "gate", "descriptor", "filtered-view", "listener", "connection", "namespace", "process-tree", "cgroup"];
/// Every encoded journal entry stays below this; a live record reserves it against `journalBytes`.
pub const RECORD_BUDGET_BYTES: usize = 256 * 1024;
const DIGEST_RESOURCES_BYTES: usize = 1 << 20;
const DATA_BYTES_PER_FRAME: i64 = 65_536;
const CONNECTIONS_PER_EXECUTION: usize = 64;
const SETTLED_RECEIPT_RETENTION_MS: i64 = 604_800_000;

/// Admitted journal bounds (`TARGET_LIMITS_V1.journalEntries/journalBytes/resourcesPerOperation`,
/// `TARGET_POLICY_V1.settledReceiptRetentionMs`).
#[derive(Clone, Copy, Debug)]
pub struct JournalLimits {
    pub journal_entries: usize,
    pub journal_bytes: u64,
    pub resources_per_operation: usize,
    pub retention_ms: i64,
}

impl Default for JournalLimits {
    fn default() -> Self {
        JournalLimits { journal_entries: 65_536, journal_bytes: 268_435_456, resources_per_operation: 512, retention_ms: SETTLED_RECEIPT_RETENTION_MS }
    }
}

impl JournalLimits {
    fn valid(&self) -> bool {
        let ceiling = JournalLimits::default();
        (1..=ceiling.journal_entries).contains(&self.journal_entries)
            && (1..=ceiling.journal_bytes).contains(&self.journal_bytes)
            && (1..=ceiling.resources_per_operation).contains(&self.resources_per_operation)
            && self.retention_ms >= SETTLED_RECEIPT_RETENTION_MS
    }
}

/// Named points where a test can simulate a process crash (production hooks never crash).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrashPoint {
    /// `prepare`: the key and request are durable; the gated create has not run.
    PrepareAfterPersist,
    /// `commit`: the release intent is durable; the gate release has not run.
    CommitAfterIntent,
}

/// An effect that could not be confirmed. The operation reports `outcome_unknown`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HookFailure;

/// One resource of a prepare request, in record (resourceId) order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceSpec {
    pub resource_id: String,
    pub kind: String,
    pub locator_digest: String,
}

/// The journal's effects. `create` must be idempotent per key (see the module documentation).
pub trait Hooks {
    /// The gated create. Returns one identity digest per resource, in order.
    fn create(&mut self, key_text: &str, resources: &[ResourceSpec]) -> Result<Vec<String>, HookFailure>;
    /// The one gate release of a committed operation.
    fn release_gate(&mut self, key_text: &str) -> Result<(), HookFailure>;
    /// Exact-tree cancellation; idempotent. Called for every not-yet-stopped record, created or possibly created.
    fn stop(&mut self, key_text: &str) -> Result<(), HookFailure>;
    /// Records the verified release of one resource. Each success is persisted before the next resource is handled, so
    /// a release retried after a failure calls this only for resources not yet released. It must still be idempotent per
    /// (key, resource): a crash between the hook and that write repeats the call once.
    fn release(&mut self, key_text: &str, resource_id: &str) -> Result<(), HookFailure>;
    /// Test seam: true simulates a crash at `point` (the operation stops and reports `outcome_unknown`).
    fn crash_at(&mut self, _point: CrashPoint) -> bool {
        false
    }
}

/// What provisioning records for a created journal store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreInfo {
    pub journal_store_identity: String,
    pub device: u64,
    pub inode: u64,
}

#[derive(Clone, Debug)]
struct Resource {
    resource_id: String,
    kind: String,
    locator_digest: String,
    identity_digest: Option<String>,
    state: String,
    absence_evidence_digest: Option<String>,
}

#[derive(Clone, Debug)]
struct Chunk {
    offset: String,
    bytes_digest: String,
    byte_length: i64,
}

#[derive(Clone, Debug)]
struct Cursor {
    connection_id: String,
    accepted_through: String,
    delivery: String,
    chunks: Vec<Chunk>,
}

#[derive(Clone, Debug)]
struct Record {
    key: Value,
    target_binding_digest: String,
    reservation_id: String,
    request_digest: String,
    lease_id: String,
    helper_incarnation: String,
    state: String,
    receipt_sequence: i64,
    gate_released: bool,
    created: bool,
    stopped: bool,
    worker_commit_digest: Option<String>,
    prepared_receipt_sequence: Option<i64>,
    prepared_resources_digest: Option<String>,
    resources: Vec<Resource>,
    /// Sorted by connectionId.
    cursors: Vec<Cursor>,
    created_at_ms: i64,
    updated_at_ms: i64,
    settled_at_ms: Option<i64>,
}

#[derive(Clone, Debug)]
struct Tombstone {
    target_binding_digest: String,
    reservation_id: String,
    request_digest: String,
    lease_id: String,
    receipt: Value,
}

#[derive(Clone, Debug)]
enum Entry {
    Record(Record),
    Tombstone(Tombstone),
}

fn need(condition: bool, code: Code) -> Result<(), Code> {
    if condition { Ok(()) } else { Err(code) }
}

fn invalid(condition: bool) -> Result<(), Code> {
    need(condition, Code::InvalidRequest)
}

fn opt_str(value: &Option<String>) -> Value {
    value.as_ref().map_or(Value::Null, |text| s(text))
}

fn opt_int(value: Option<i64>) -> Value {
    value.map_or(Value::Null, Value::Int)
}

impl Resource {
    fn receipt(&self) -> Value {
        obj(vec![
            ("resourceId", s(&self.resource_id)),
            ("kind", s(&self.kind)),
            ("locatorDigest", s(&self.locator_digest)),
            ("identityDigest", opt_str(&self.identity_digest)),
            ("state", s(&self.state)),
            ("absenceEvidenceDigest", opt_str(&self.absence_evidence_digest)),
        ])
    }
}

/// `keyText`: exactly the five OperationKey fields, typed, as canonical text.
pub fn key_text(key: &Value) -> Result<String, Code> {
    invalid(key.obj().is_some_and(|entries| entries.len() == 5))?;
    let get = |name: &str| key.get(name).unwrap_or(&Value::Null);
    invalid(
        is_opaque_identity(get("workspaceId")) && is_id(get("workerGeneration")) && is_id(get("executionId")) && is_id(get("attemptId"))
            && is_operation_id(get("operationId")),
    )?;
    canon::canonical_text(key)
}

fn str_field(request: &Value, key: &str) -> Option<String> {
    request.str_at(key).map(str::to_string)
}

// ---- Persistence encoding ------------------------------------------------------------------------------------------

fn encode_record(record: &Record) -> Value {
    obj(vec![
        ("targetBindingDigest", s(&record.target_binding_digest)),
        ("reservationId", s(&record.reservation_id)),
        ("requestDigest", s(&record.request_digest)),
        ("leaseId", s(&record.lease_id)),
        ("helperIncarnation", s(&record.helper_incarnation)),
        ("state", s(&record.state)),
        ("receiptSequence", Value::Int(record.receipt_sequence)),
        ("gateReleased", Value::Bool(record.gate_released)),
        ("created", Value::Bool(record.created)),
        ("stopped", Value::Bool(record.stopped)),
        ("workerCommitDigest", opt_str(&record.worker_commit_digest)),
        ("preparedReceiptSequence", opt_int(record.prepared_receipt_sequence)),
        ("preparedResourcesDigest", opt_str(&record.prepared_resources_digest)),
        ("resources", Value::Arr(record.resources.iter().map(Resource::receipt).collect())),
        (
            "cursors",
            Value::Arr(
                record
                    .cursors
                    .iter()
                    .map(|cursor| {
                        obj(vec![
                            ("connectionId", s(&cursor.connection_id)),
                            ("acceptedThrough", s(&cursor.accepted_through)),
                            ("delivery", s(&cursor.delivery)),
                            (
                                "chunks",
                                Value::Arr(
                                    cursor
                                        .chunks
                                        .iter()
                                        .map(|chunk| {
                                            obj(vec![
                                                ("offset", s(&chunk.offset)),
                                                ("bytesDigest", s(&chunk.bytes_digest)),
                                                ("byteLength", Value::Int(chunk.byte_length)),
                                            ])
                                        })
                                        .collect(),
                                ),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("createdAtMs", Value::Int(record.created_at_ms)),
        ("updatedAtMs", Value::Int(record.updated_at_ms)),
        ("settledAtMs", opt_int(record.settled_at_ms)),
    ])
}

/// Strict decoding of a persisted entry: any unexpected shape is `state_corrupt`.
struct Decoder<'a>(&'a Value);

impl<'a> Decoder<'a> {
    fn get(&self, key: &str) -> Result<&'a Value, Code> {
        self.0.get(key).ok_or(Code::StateCorrupt)
    }
    fn text(&self, key: &str) -> Result<String, Code> {
        self.get(key)?.str().map(str::to_string).ok_or(Code::StateCorrupt)
    }
    fn digest(&self, key: &str) -> Result<String, Code> {
        let text = self.text(key)?;
        if is_digest_text(&text) { Ok(text) } else { Err(Code::StateCorrupt) }
    }
    fn id(&self, key: &str) -> Result<String, Code> {
        let text = self.text(key)?;
        if is_id_text(&text) { Ok(text) } else { Err(Code::StateCorrupt) }
    }
    fn opt_digest(&self, key: &str) -> Result<Option<String>, Code> {
        match self.get(key)? {
            Value::Null => Ok(None),
            _ => self.digest(key).map(Some),
        }
    }
    fn int(&self, key: &str) -> Result<i64, Code> {
        self.get(key)?.int().filter(|number| *number >= 0).ok_or(Code::StateCorrupt)
    }
    fn opt_int(&self, key: &str) -> Result<Option<i64>, Code> {
        match self.get(key)? {
            Value::Null => Ok(None),
            _ => self.int(key).map(Some),
        }
    }
    fn boolean(&self, key: &str) -> Result<bool, Code> {
        self.get(key)?.bool().ok_or(Code::StateCorrupt)
    }
    fn one_of(&self, key: &str, options: &[&str]) -> Result<String, Code> {
        let text = self.text(key)?;
        if options.contains(&text.as_str()) { Ok(text) } else { Err(Code::StateCorrupt) }
    }
    fn arr(&self, key: &str) -> Result<&'a [Value], Code> {
        self.get(key)?.arr().ok_or(Code::StateCorrupt)
    }
}

const RECORD_STATES: [&str; 6] = ["reserved", "prepared", "running", "stopping", "exited", "quarantined"];
const RESOURCE_STATES: [&str; 4] = ["reserved", "committed", "released", "quarantined"];

fn decode_record(value: &Value, key: Value) -> Result<Record, Code> {
    let d = Decoder(value);
    let mut resources = Vec::new();
    for entry in d.arr("resources")? {
        let r = Decoder(entry);
        resources.push(Resource {
            resource_id: r.id("resourceId")?,
            kind: r.one_of("kind", &RESOURCE_KINDS)?,
            locator_digest: r.digest("locatorDigest")?,
            identity_digest: r.opt_digest("identityDigest")?,
            state: r.one_of("state", &RESOURCE_STATES)?,
            absence_evidence_digest: r.opt_digest("absenceEvidenceDigest")?,
        });
    }
    let mut cursors = Vec::new();
    for entry in d.arr("cursors")? {
        let c = Decoder(entry);
        let mut chunks = Vec::new();
        for chunk in c.arr("chunks")? {
            let k = Decoder(chunk);
            let offset = k.text("offset")?;
            need(is_u64_text(&Value::Str(offset.clone())), Code::StateCorrupt)?;
            chunks.push(Chunk { offset, bytes_digest: k.digest("bytesDigest")?, byte_length: k.int("byteLength")? });
        }
        let accepted_through = c.text("acceptedThrough")?;
        need(is_u64_text(&Value::Str(accepted_through.clone())), Code::StateCorrupt)?;
        cursors.push(Cursor { connection_id: c.id("connectionId")?, accepted_through, delivery: c.one_of("delivery", &["acknowledged", "unknown"])?, chunks });
    }
    Ok(Record {
        key,
        target_binding_digest: d.digest("targetBindingDigest")?,
        reservation_id: d.id("reservationId")?,
        request_digest: d.digest("requestDigest")?,
        lease_id: d.id("leaseId")?,
        helper_incarnation: d.id("helperIncarnation")?,
        state: d.one_of("state", &RECORD_STATES)?,
        receipt_sequence: d.int("receiptSequence")?,
        gate_released: d.boolean("gateReleased")?,
        created: d.boolean("created")?,
        stopped: d.boolean("stopped")?,
        worker_commit_digest: d.opt_digest("workerCommitDigest")?,
        prepared_receipt_sequence: d.opt_int("preparedReceiptSequence")?,
        prepared_resources_digest: d.opt_digest("preparedResourcesDigest")?,
        resources,
        cursors,
        created_at_ms: d.int("createdAtMs")?,
        updated_at_ms: d.int("updatedAtMs")?,
        settled_at_ms: d.opt_int("settledAtMs")?,
    })
}

fn encode_entry(entry: &Entry, key: &Value, key_text: &str, store: &str, revision: u64) -> Value {
    let (kind, body) = match entry {
        Entry::Record(record) => ("record", encode_record(record)),
        Entry::Tombstone(tombstone) => (
            "tombstone",
            obj(vec![
                ("targetBindingDigest", s(&tombstone.target_binding_digest)),
                ("reservationId", s(&tombstone.reservation_id)),
                ("requestDigest", s(&tombstone.request_digest)),
                ("leaseId", s(&tombstone.lease_id)),
                ("receipt", tombstone.receipt.clone()),
            ]),
        ),
    };
    obj(vec![
        ("version", Value::Int(1)),
        ("kind", s(kind)),
        ("journalStoreIdentity", s(store)),
        ("journalRevision", s(&revision.to_string())),
        ("keyText", s(key_text)),
        ("key", key.clone()),
        ("body", body),
    ])
}

/// Decodes a persisted entry and checks it belongs to `store` and to the file name's key hash.
fn decode_entry(value: &Value, store: &str, expected_hash: Option<&str>) -> Result<(String, Entry, u64), Code> {
    let d = Decoder(value);
    need(value.obj().is_some_and(|entries| entries.len() == 7) && d.get("version")? == &Value::Int(1), Code::StateCorrupt)?;
    need(d.text("journalStoreIdentity")? == store, Code::StateCorrupt)?;
    let revision: u64 = d.text("journalRevision")?.parse().map_err(|_| Code::StateCorrupt)?;
    let text = d.text("keyText")?;
    let key = d.get("key")?.clone();
    need(key_text(&key).ok().as_deref() == Some(text.as_str()), Code::StateCorrupt)?;
    if let Some(hash) = expected_hash {
        need(sha256_hex(text.as_bytes()) == hash, Code::StateCorrupt)?;
    }
    let body = d.get("body")?;
    let entry = match d.text("kind")?.as_str() {
        "record" => Entry::Record(decode_record(body, key)?),
        "tombstone" => {
            let b = Decoder(body);
            let receipt = b.get("receipt")?.clone();
            need(receipt.is_obj(), Code::StateCorrupt)?;
            Entry::Tombstone(Tombstone {
                target_binding_digest: b.digest("targetBindingDigest")?,
                reservation_id: b.id("reservationId")?,
                request_digest: b.digest("requestDigest")?,
                lease_id: b.id("leaseId")?,
                receipt,
            })
        }
        _ => return Err(Code::StateCorrupt),
    };
    Ok((text, entry, revision))
}

// ---- File helpers ----------------------------------------------------------------------------------------------------

fn identity_of(path: &Path) -> io::Result<(u64, u64, bool)> {
    let metadata = fs::symlink_metadata(path)?;
    Ok((metadata.dev(), metadata.ino(), metadata.file_type().is_dir()))
}

fn sync_dir(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn write_new_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn read_file(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn lock_exclusive(file: &File, wait: Duration) -> bool {
    use std::os::fd::AsRawFd;
    let start = Instant::now();
    loop {
        // SAFETY: flock on a descriptor this function borrows; no memory is passed.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return true;
        }
        if start.elapsed() >= wait {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn temp_name() -> String {
    let counter = TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!(".tmp-{}-{counter}", std::process::id())
}

fn witness_value(store: &str) -> Value {
    obj(vec![("version", Value::Int(1)), ("journalStoreIdentity", s(store))])
}

fn head_value(store: &str, revision: u64, entries: usize) -> Value {
    obj(vec![
        ("version", Value::Int(1)),
        ("journalStoreIdentity", s(store)),
        ("revision", s(&revision.to_string())),
        ("entries", Value::Int(entries as i64)),
    ])
}

// ---- Journal ---------------------------------------------------------------------------------------------------------

/// An open journal store. One handle per store (the handle holds the store's exclusive lock).
pub struct Journal {
    dir: PathBuf,
    records: PathBuf,
    store: String,
    incarnation: String,
    limits: JournalLimits,
    dir_identity: (u64, u64),
    witness_identity: (u64, u64),
    records_identity: (u64, u64),
    /// The locked file's identity: a lock file replaced under the handle would let another opener lock the replacement.
    lock_identity: (u64, u64),
    /// SHA-256 hex of every key in the store (records and tombstones), loaded at open: a key file that disappears under
    /// the handle is `state_corrupt`, never absence, and a file that appears from elsewhere is refused.
    keys: std::collections::HashSet<String>,
    _lock: File,
    revision: u64,
    entries: usize,
    live_records: usize,
    tombstone_bytes: u64,
    /// Set after an I/O failure during a write: the handle refuses everything until reopened.
    poisoned: bool,
}

impl std::fmt::Debug for Journal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Journal").field("store", &self.store).field("revision", &self.revision).field("entries", &self.entries).finish()
    }
}

impl Journal {
    /// Provisioning: creates the journal store in the provisioned directory `root` (which must exist) under a fresh
    /// identity minted from the kernel CSPRNG, and returns it for Ploinky to record. An existing store is returned as it
    /// is (never overwritten). Because the identity is never caller-chosen, a lost or deleted journal can never be
    /// re-provisioned under its old identity: bindings naming the old store stay `journal_unavailable` and absence proofs
    /// from the new store name the new identity, which the worker's reconciliation refuses.
    pub fn create(root: &Path) -> Result<StoreInfo, Code> {
        if let Some(existing) = Self::existing_store(root)? {
            return Ok(existing);
        }
        let mut bytes = [0u8; 16];
        File::open("/dev/urandom").and_then(|mut random| random.read_exact(&mut bytes)).map_err(|_| Code::JournalUnavailable)?;
        Self::build(root, &crate::crypto::b64url_encode(&bytes))
    }

    /// Fixture and test use only (the differential replays the oracle's fixed identities). Production provisioning
    /// must use [`Journal::create`], whose identity cannot be reused. Idempotent for the same identity; another identity
    /// already there is `operation_conflict`.
    #[doc(hidden)]
    pub fn create_with_identity_for_tests(root: &Path, store_identity: &str) -> Result<StoreInfo, Code> {
        invalid(is_id_text(store_identity))?;
        if let Some(existing) = Self::existing_store(root)? {
            need(existing.journal_store_identity == store_identity, Code::OperationConflict)?;
            return Ok(existing);
        }
        Self::build(root, store_identity)
    }

    fn existing_store(root: &Path) -> Result<Option<StoreInfo>, Code> {
        let root_identity = identity_of(root).map_err(|_| Code::JournalUnavailable)?;
        need(root_identity.2, Code::JournalUnavailable)?;
        let dir = root.join("journal");
        let Ok((device, inode, is_dir)) = identity_of(&dir) else {
            return Ok(None);
        };
        need(is_dir, Code::StateCorrupt)?;
        let witness = read_file(&dir.join("journal-store.json"), 4096).map_err(|_| Code::StateCorrupt)?;
        let value = canon::parse_canonical(&witness, 4096).map_err(|_| Code::StateCorrupt)?;
        need(value.get("version") == Some(&Value::Int(1)) && value.has_exact_keys(&["version", "journalStoreIdentity"]), Code::StateCorrupt)?;
        let identity = value.str_at("journalStoreIdentity").filter(|identity| is_id_text(identity)).ok_or(Code::StateCorrupt)?;
        Ok(Some(StoreInfo { journal_store_identity: identity.to_string(), device, inode }))
    }

    fn build(root: &Path, store_identity: &str) -> Result<StoreInfo, Code> {
        let dir = root.join("journal");
        let io = |_: io::Error| Code::JournalUnavailable;
        // Sweep interrupted creations (only this module's own naming).
        for entry in fs::read_dir(root).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name();
            if name.to_str().is_some_and(|name| name.starts_with(".creating-") && is_id_text(&name[".creating-".len()..])) {
                fs::remove_dir_all(entry.path()).map_err(io)?;
            }
        }
        let staging = root.join(format!(".creating-{store_identity}"));
        fs::DirBuilder::new().mode(0o700).create(&staging).map_err(io)?;
        fs::DirBuilder::new().mode(0o700).create(staging.join("records")).map_err(io)?;
        let head = canon::canonical_text(&head_value(store_identity, 0, 0))?;
        write_new_file(&staging.join("head.json"), head.as_bytes()).map_err(io)?;
        write_new_file(&staging.join("lock"), b"").map_err(io)?;
        let witness = canon::canonical_text(&witness_value(store_identity))?;
        write_new_file(&staging.join("journal-store.json"), witness.as_bytes()).map_err(io)?;
        sync_dir(&staging.join("records")).map_err(io)?;
        sync_dir(&staging).map_err(io)?;
        fs::rename(&staging, &dir).map_err(io)?;
        sync_dir(root).map_err(io)?;
        let (device, inode, _) = identity_of(&dir).map_err(io)?;
        Ok(StoreInfo { journal_store_identity: store_identity.to_string(), device, inode })
    }

    /// Opens the journal store `store_identity` in `root`. Never creates. `lock_wait` bounds waiting for the store lock
    /// (`lockWaitMs`); a lock still held after it is `journal_unavailable`.
    pub fn open(root: &Path, store_identity: &str, helper_incarnation: &str, limits: JournalLimits, lock_wait: Duration) -> Result<Journal, Code> {
        invalid(is_id_text(store_identity) && is_id_text(helper_incarnation) && limits.valid())?;
        let dir = root.join("journal");
        let unavailable = |_: io::Error| Code::JournalUnavailable;
        let (device, inode, is_dir) = identity_of(&dir).map_err(unavailable)?;
        need(is_dir, Code::JournalUnavailable)?;
        let lock = OpenOptions::new().read(true).open(dir.join("lock")).map_err(unavailable)?;
        need(lock_exclusive(&lock, lock_wait), Code::JournalUnavailable)?;
        let lock_metadata = lock.metadata().map_err(unavailable)?;
        let lock_identity = (lock_metadata.dev(), lock_metadata.ino());
        let lock_path = identity_of(&dir.join("lock")).map_err(unavailable)?;
        need((lock_path.0, lock_path.1) == lock_identity, Code::JournalUnavailable)?;
        let witness_path = dir.join("journal-store.json");
        let witness = read_file(&witness_path, 4096).map_err(unavailable)?;
        need(witness == canon::canonical_text(&witness_value(store_identity))?.as_bytes(), Code::JournalUnavailable)?;
        let (witness_device, witness_inode, _) = identity_of(&witness_path).map_err(unavailable)?;
        let (records_device, records_inode, records_dir) = identity_of(&dir.join("records")).map_err(unavailable)?;
        need(records_dir, Code::JournalUnavailable)?;
        // The directory did not change while the lock and witness were taken.
        need(identity_of(&dir).map_err(unavailable)?.0 == device && identity_of(&dir).map_err(unavailable)?.1 == inode, Code::JournalUnavailable)?;
        let mut journal = Journal {
            records: dir.join("records"),
            dir,
            store: store_identity.to_string(),
            incarnation: helper_incarnation.to_string(),
            limits,
            dir_identity: (device, inode),
            witness_identity: (witness_device, witness_inode),
            records_identity: (records_device, records_inode),
            lock_identity,
            keys: std::collections::HashSet::new(),
            _lock: lock,
            revision: 0,
            entries: 0,
            live_records: 0,
            tombstone_bytes: 0,
            poisoned: false,
        };
        journal.load()?;
        Ok(journal)
    }

    /// Scans every entry and reconciles `head.json`.
    fn load(&mut self) -> Result<(), Code> {
        let head = read_file(&self.dir.join("head.json"), 4096).map_err(|_| Code::StateCorrupt)?;
        let head = canon::parse_canonical(&head, 4096).map_err(|_| Code::StateCorrupt)?;
        need(head.get("version") == Some(&Value::Int(1)) && head.has_exact_keys(&["version", "journalStoreIdentity", "revision", "entries"]), Code::StateCorrupt)?;
        need(head.str_at("journalStoreIdentity") == Some(self.store.as_str()), Code::JournalUnavailable)?;
        let head_revision: u64 = head.str_at("revision").and_then(|text| text.parse().ok()).ok_or(Code::StateCorrupt)?;
        let head_entries = head.get("entries").and_then(Value::int).filter(|count| *count >= 0).ok_or(Code::StateCorrupt)? as usize;
        // Unpublished head temporaries of an interrupted head write.
        for item in fs::read_dir(&self.dir).map_err(|_| Code::JournalUnavailable)? {
            let item = item.map_err(|_| Code::StateCorrupt)?;
            if item.file_name().to_str().is_some_and(|name| name.starts_with(".tmp-")) {
                fs::remove_file(item.path()).map_err(|_| Code::JournalUnavailable)?;
            }
        }
        let (mut entries, mut live, mut tombstone_bytes, mut max_revision) = (0usize, 0usize, 0u64, 0u64);
        for item in fs::read_dir(&self.records).map_err(|_| Code::JournalUnavailable)? {
            let item = item.map_err(|_| Code::StateCorrupt)?;
            let name = item.file_name();
            let name = name.to_str().ok_or(Code::StateCorrupt)?.to_string();
            if name.starts_with(".tmp-") {
                // An unpublished temporary file of an interrupted write: never acknowledged.
                fs::remove_file(item.path()).map_err(|_| Code::JournalUnavailable)?;
                continue;
            }
            let hash = name.strip_suffix(".json").filter(|hash| is_digest_text(hash)).ok_or(Code::StateCorrupt)?;
            let bytes = read_file(&item.path(), RECORD_BUDGET_BYTES).map_err(|_| Code::StateCorrupt)?;
            let value = canon::parse_canonical(&bytes, RECORD_BUDGET_BYTES).map_err(|_| Code::StateCorrupt)?;
            let (_, entry, revision) = decode_entry(&value, &self.store, Some(hash))?;
            self.keys.insert(hash.to_string());
            entries += 1;
            max_revision = max_revision.max(revision);
            match entry {
                Entry::Record(_) => live += 1,
                Entry::Tombstone(_) => tombstone_bytes += bytes.len() as u64,
            }
        }
        let consistent = max_revision <= head_revision && entries == head_entries;
        let one_ahead = max_revision == head_revision + 1 && (entries == head_entries || entries == head_entries + 1);
        need(consistent || one_ahead, Code::StateCorrupt)?;
        self.revision = head_revision.max(max_revision);
        self.entries = entries;
        self.live_records = live;
        self.tombstone_bytes = tombstone_bytes;
        if one_ahead {
            self.write_head().map_err(|_| Code::JournalUnavailable)?;
        }
        sync_dir(&self.records).map_err(|_| Code::JournalUnavailable)?;
        Ok(())
    }

    pub fn store_identity(&self) -> &str {
        &self.store
    }

    pub fn helper_incarnation(&self) -> &str {
        &self.incarnation
    }

    /// Records plus tombstones.
    pub fn size(&self) -> usize {
        self.entries
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Re-checks that this handle's journal is still the one it opened: the directory and witness identities, and
    /// that no write failed. Every operation starts with it.
    pub fn verify(&self) -> Result<(), Code> {
        need(!self.poisoned, Code::JournalUnavailable)?;
        let directory = identity_of(&self.dir).map_err(|_| Code::JournalUnavailable)?;
        need(directory.2 && (directory.0, directory.1) == self.dir_identity, Code::JournalUnavailable)?;
        let witness_path = self.dir.join("journal-store.json");
        let witness = identity_of(&witness_path).map_err(|_| Code::JournalUnavailable)?;
        need((witness.0, witness.1) == self.witness_identity, Code::JournalUnavailable)?;
        let bytes = read_file(&witness_path, 4096).map_err(|_| Code::JournalUnavailable)?;
        need(bytes == canon::canonical_text(&witness_value(&self.store))?.as_bytes(), Code::JournalUnavailable)?;
        // The records directory must still be this journal's (a replaced records/ is a replaced journal).
        let records = identity_of(&self.records).map_err(|_| Code::JournalUnavailable)?;
        need(records.2 && (records.0, records.1) == self.records_identity, Code::JournalUnavailable)?;
        // The file this handle holds locked is still the journal's lock file.
        let lock = identity_of(&self.dir.join("lock")).map_err(|_| Code::JournalUnavailable)?;
        need((lock.0, lock.1) == self.lock_identity, Code::JournalUnavailable)?;
        Ok(())
    }

    fn record_path(&self, text: &str) -> PathBuf {
        self.records.join(format!("{}.json", sha256_hex(text.as_bytes())))
    }

    fn read_entry(&self, text: &str) -> Result<Option<Entry>, Code> {
        let path = self.record_path(text);
        let known = self.keys.contains(&sha256_hex(text.as_bytes()));
        let bytes = match read_file(&path, RECORD_BUDGET_BYTES) {
            Ok(bytes) => bytes,
            // A key this store holds whose file vanished is a damaged journal, never absence.
            Err(error) if error.kind() == io::ErrorKind::NotFound => return if known { Err(Code::StateCorrupt) } else { Ok(None) },
            Err(_) => return Err(Code::JournalUnavailable),
        };
        need(known, Code::StateCorrupt)?;
        let value = canon::parse_canonical(&bytes, RECORD_BUDGET_BYTES).map_err(|_| Code::StateCorrupt)?;
        let (stored_text, entry, _) = decode_entry(&value, &self.store, None)?;
        need(stored_text == text, Code::StateCorrupt)?;
        Ok(Some(entry))
    }

    fn write_head(&self) -> io::Result<()> {
        let text = canon::canonical_text(&head_value(&self.store, self.revision, self.entries)).map_err(io::Error::other)?;
        let temp = self.dir.join(temp_name());
        write_new_file(&temp, text.as_bytes())?;
        fs::rename(&temp, self.dir.join("head.json"))?;
        sync_dir(&self.dir)
    }

    /// Persists one entry. `bump` advances the journal revision. A new key is published with link(2) and never replaces
    /// an existing file.
    fn persist(&mut self, text: &str, key: &Value, entry: &Entry, new: bool, bump: bool) -> Result<(), Code> {
        let revision = if bump { self.revision + 1 } else { self.revision };
        let encoded = canon::canonical(&encode_entry(entry, key, text, &self.store, revision), RECORD_BUDGET_BYTES)?;
        let path = self.record_path(text);
        let temp = self.records.join(temp_name());
        let result = (|| -> io::Result<()> {
            write_new_file(&temp, encoded.as_bytes())?;
            if new {
                let linked = fs::hard_link(&temp, &path);
                fs::remove_file(&temp)?;
                linked?;
            } else {
                fs::rename(&temp, &path)?;
            }
            sync_dir(&self.records)
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temp);
            self.poisoned = true;
            return Err(if error.kind() == io::ErrorKind::AlreadyExists { Code::StateCorrupt } else { Code::JournalUnavailable });
        }
        self.revision = revision;
        if new {
            self.entries += 1;
            self.live_records += 1;
            self.keys.insert(sha256_hex(text.as_bytes()));
        }
        if let Entry::Tombstone(_) = entry {
            // Only retire writes a tombstone, replacing a live record (new keys are always records; tombstones are never
            // rewritten): the record's reservation is replaced by the tombstone's actual size.
            self.live_records -= 1;
            self.tombstone_bytes += encoded.len() as u64;
        }
        if self.write_head().is_err() {
            self.poisoned = true;
            return Err(Code::JournalUnavailable);
        }
        Ok(())
    }

    fn receipt(&self, record: &Record, now: i64) -> Result<Value, Code> {
        let receipt = obj(vec![
            ("version", Value::Int(1)),
            ("key", record.key.clone()),
            ("targetBindingDigest", s(&record.target_binding_digest)),
            ("reservationId", s(&record.reservation_id)),
            ("requestDigest", s(&record.request_digest)),
            ("journalStoreIdentity", s(&self.store)),
            ("helperIncarnation", s(&record.helper_incarnation)),
            ("leaseId", s(&record.lease_id)),
            ("state", s(&record.state)),
            ("receiptSequence", Value::Int(record.receipt_sequence)),
            ("gateReleased", Value::Bool(record.gate_released)),
            ("resources", Value::Arr(record.resources.iter().map(Resource::receipt).collect())),
            (
                "inputCursors",
                Value::Arr(
                    record
                        .cursors
                        .iter()
                        .map(|cursor| {
                            obj(vec![
                                ("connectionId", s(&cursor.connection_id)),
                                ("acceptedThrough", s(&cursor.accepted_through)),
                                ("delivery", s(&cursor.delivery)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("observedAtMs", Value::Int(now)),
        ]);
        // validateTargetReceipt's explicit 256 KiB bound.
        canon::canonical(&receipt, canon::RECEIPT_BYTES).map_err(|_| Code::StateCorrupt)?;
        Ok(receipt)
    }

    /// The record as it will look once settled, with every field that can still grow at its widest (released resources
    /// with evidence and identity digests, acknowledged cursors, maximal counters and times, the longest state). It must
    /// fit the per-record budget, so that stop, exit, release and acknowledgement writes can never be refused for size.
    fn settled_size_fits(&self, text: &str, key: &Value, record: &Record) -> Result<(), Code> {
        const WIDEST_DIGEST: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let mut projected = record.clone();
        projected.state = "quarantined".into();
        projected.receipt_sequence = canon::MAX_SAFE;
        projected.updated_at_ms = canon::MAX_SAFE;
        projected.settled_at_ms = Some(canon::MAX_SAFE);
        for resource in projected.resources.iter_mut() {
            resource.state = "released".into();
            resource.identity_digest = Some(WIDEST_DIGEST.into());
            resource.absence_evidence_digest = Some(WIDEST_DIGEST.into());
        }
        for cursor in projected.cursors.iter_mut() {
            cursor.delivery = "acknowledged".into();
        }
        canon::canonical(&encode_entry(&Entry::Record(projected), key, text, &self.store, u64::MAX), RECORD_BUDGET_BYTES).map(|_| ())
    }

    fn bump(&self, record: &mut Record, now: i64) {
        record.receipt_sequence += 1;
        record.updated_at_ms = now;
    }

    fn reserved_bytes(&self) -> u64 {
        self.live_records as u64 * RECORD_BUDGET_BYTES as u64 + self.tombstone_bytes
    }

    fn same_request(stored: (&str, &str, &str, &str), request: &Value) -> bool {
        request.str_at("targetBindingDigest") == Some(stored.0)
            && request.str_at("reservationId") == Some(stored.1)
            && request.str_at("requestDigest") == Some(stored.2)
            && request.str_at("leaseId") == Some(stored.3)
    }

    /// The gated create, once per key, after the key and exact request are durable.
    fn create_resources(&mut self, text: &str, record: &mut Record, now: i64, hooks: &mut dyn Hooks) -> Result<(), Code> {
        if record.created {
            return Ok(());
        }
        let specs: Vec<ResourceSpec> = record
            .resources
            .iter()
            .map(|resource| ResourceSpec { resource_id: resource.resource_id.clone(), kind: resource.kind.clone(), locator_digest: resource.locator_digest.clone() })
            .collect();
        let identities = hooks.create(text, &specs).map_err(|_| Code::OutcomeUnknown)?;
        need(identities.len() == specs.len() && identities.iter().all(|identity| is_digest_text(identity)), Code::StateCorrupt)?;
        let mut next = record.clone();
        next.created = true;
        for (resource, identity) in next.resources.iter_mut().zip(identities) {
            resource.state = "committed".into();
            resource.identity_digest = Some(identity);
        }
        next.state = "prepared".into();
        self.bump(&mut next, now);
        next.prepared_receipt_sequence = Some(next.receipt_sequence);
        let resources = Value::Arr(next.resources.iter().map(Resource::receipt).collect());
        next.prepared_resources_digest = Some(canon::digest(&resources, DIGEST_RESOURCES_BYTES)?);
        self.persist(text, &next.key.clone(), &Entry::Record(next.clone()), false, true)?;
        *record = next;
        Ok(())
    }

    /// `prepare`: persist the unique key and exact request before one gated create. Identical retries return the
    /// recorded state; changed content conflicts.
    pub fn prepare(&mut self, request: &Value, now: i64, hooks: &mut dyn Hooks) -> Result<Value, Code> {
        self.verify()?;
        invalid(request.is_obj())?;
        invalid(
            request.get("targetBindingDigest").is_some_and(is_digest) && request.get("reservationId").is_some_and(is_id)
                && request.get("requestDigest").is_some_and(is_digest) && request.get("leaseId").is_some_and(is_id),
        )?;
        // A binding naming another (replaced or recreated) journal store has no journal here.
        need(request.str_at("journalStoreIdentity") == Some(self.store.as_str()), Code::JournalUnavailable)?;
        let resources = request.get("resources").and_then(Value::arr).ok_or(Code::InvalidRequest)?;
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let text = key_text(&key)?;
        match self.read_entry(&text)? {
            Some(Entry::Tombstone(tombstone)) => {
                let stored = (&*tombstone.target_binding_digest, &*tombstone.reservation_id, &*tombstone.request_digest, &*tombstone.lease_id);
                need(Self::same_request(stored, request), Code::OperationConflict)?;
                Ok(tombstone.receipt)
            }
            Some(Entry::Record(mut record)) => {
                let stored = (&*record.target_binding_digest, &*record.reservation_id, &*record.request_digest, &*record.lease_id);
                need(Self::same_request(stored, request), Code::OperationConflict)?;
                if hooks.crash_at(CrashPoint::PrepareAfterPersist) {
                    return Err(Code::OutcomeUnknown);
                }
                // A stopped operation is never created by a retried prepare (deliberate difference from the model).
                if !record.stopped {
                    self.create_resources(&text, &mut record, now, hooks)?;
                }
                self.receipt(&record, now)
            }
            None => {
                need(resources.len() <= self.limits.resources_per_operation, Code::CapacityExceeded)?;
                for entry in resources {
                    invalid(
                        entry.is_obj() && entry.get("resourceId").is_some_and(is_id)
                            && entry.str_at("kind").is_some_and(|kind| RESOURCE_KINDS.contains(&kind))
                            && entry.get("locatorDigest").is_some_and(is_digest),
                    )?;
                }
                let mut ids: Vec<&str> = resources.iter().filter_map(|entry| entry.str_at("resourceId")).collect();
                ids.sort_unstable();
                ids.dedup();
                invalid(ids.len() == resources.len())?;
                need(self.entries < self.limits.journal_entries, Code::CapacityExceeded)?;
                need(self.reserved_bytes() + RECORD_BUDGET_BYTES as u64 <= self.limits.journal_bytes, Code::CapacityExceeded)?;
                let mut sorted: Vec<Resource> = resources
                    .iter()
                    .map(|entry| Resource {
                        resource_id: entry.str_at("resourceId").unwrap_or_default().to_string(),
                        kind: entry.str_at("kind").unwrap_or_default().to_string(),
                        locator_digest: entry.str_at("locatorDigest").unwrap_or_default().to_string(),
                        identity_digest: None,
                        state: "reserved".into(),
                        absence_evidence_digest: None,
                    })
                    .collect();
                sorted.sort_by(|left, right| left.resource_id.as_bytes().cmp(right.resource_id.as_bytes()));
                let mut record = Record {
                    key: key.clone(),
                    target_binding_digest: str_field(request, "targetBindingDigest").unwrap_or_default(),
                    reservation_id: str_field(request, "reservationId").unwrap_or_default(),
                    request_digest: str_field(request, "requestDigest").unwrap_or_default(),
                    lease_id: str_field(request, "leaseId").unwrap_or_default(),
                    helper_incarnation: self.incarnation.clone(),
                    state: "reserved".into(),
                    receipt_sequence: 1,
                    gate_released: false,
                    created: false,
                    stopped: false,
                    worker_commit_digest: None,
                    prepared_receipt_sequence: None,
                    prepared_resources_digest: None,
                    resources: sorted,
                    cursors: Vec::new(),
                    created_at_ms: now,
                    updated_at_ms: now,
                    settled_at_ms: None,
                };
                self.settled_size_fits(&text, &key, &record)?;
                self.persist(&text, &key, &Entry::Record(record.clone()), true, true)?;
                if hooks.crash_at(CrashPoint::PrepareAfterPersist) {
                    return Err(Code::OutcomeUnknown);
                }
                self.create_resources(&text, &mut record, now, hooks)?;
                self.receipt(&record, now)
            }
        }
    }

    /// `commit`: revalidate binding and reservation; journal the at-most-once release intent before releasing the gate.
    pub fn commit(&mut self, request: &Value, now: i64, hooks: &mut dyn Hooks) -> Result<Value, Code> {
        self.verify()?;
        invalid(request.is_obj())?;
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let text = key_text(&key)?;
        let mut record = match self.read_entry(&text)? {
            Some(Entry::Tombstone(tombstone)) => return Ok(tombstone.receipt),
            None => return Err(Code::NotFound),
            Some(Entry::Record(record)) => record,
        };
        need(
            request.str_at("targetBindingDigest") == Some(record.target_binding_digest.as_str())
                && request.str_at("reservationId") == Some(record.reservation_id.as_str()),
            Code::BindingMismatch,
        )?;
        invalid(request.get("workerCommitDigest").is_some_and(is_digest))?;
        let commit_digest = str_field(request, "workerCommitDigest").unwrap_or_default();
        if let Some(recorded) = &record.worker_commit_digest {
            // The release intent is journaled at most once; an uncertain release is never replayed.
            need(*recorded == commit_digest, Code::OperationConflict)?;
            return self.receipt(&record, now);
        }
        need(record.created && record.state == "prepared", Code::OperationConflict)?;
        need(
            request.get("preparedReceiptSequence").and_then(Value::int) == record.prepared_receipt_sequence
                && record.prepared_receipt_sequence.is_some()
                && request.str_at("preparedResourcesDigest") == record.prepared_resources_digest.as_deref(),
            Code::OperationConflict,
        )?;
        record.worker_commit_digest = Some(commit_digest);
        record.gate_released = true;
        record.state = "running".into();
        self.bump(&mut record, now);
        self.persist(&text, &key, &Entry::Record(record.clone()), false, true)?;
        if hooks.crash_at(CrashPoint::CommitAfterIntent) {
            return Err(Code::OutcomeUnknown);
        }
        hooks.release_gate(&text).map_err(|_| Code::OutcomeUnknown)?;
        self.receipt(&record, now)
    }

    /// `lookup`: the current receipt, a retired receipt, or authenticated absence for this complete journal. The lookup
    /// reconciles unknown input deliveries (persisted without a revision change).
    pub fn lookup(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.verify()?;
        invalid(request.is_obj() && request.get("targetBindingDigest").is_some_and(is_digest))?;
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let text = key_text(&key)?;
        match self.read_entry(&text)? {
            Some(Entry::Tombstone(tombstone)) => {
                let state = tombstone.receipt.get("state").cloned().unwrap_or(Value::Null);
                Ok(obj(vec![("state", state), ("receipt", tombstone.receipt)]))
            }
            Some(Entry::Record(mut record)) => {
                let receipt = self.receipt(&record, now)?;
                if record.cursors.iter().any(|cursor| cursor.delivery != "acknowledged") {
                    for cursor in record.cursors.iter_mut() {
                        cursor.delivery = "acknowledged".into();
                    }
                    self.persist(&text, &key, &Entry::Record(record.clone()), false, false)?;
                }
                Ok(obj(vec![("state", s(&record.state)), ("receipt", receipt)]))
            }
            None => {
                let revision = self.revision.to_string();
                let evidence = obj(vec![
                    ("version", Value::Int(1)),
                    ("journalStoreIdentity", s(&self.store)),
                    ("journalRevision", s(&revision)),
                    ("key", key.clone()),
                ]);
                Ok(obj(vec![
                    ("state", s("absent-with-proof")),
                    ("key", key),
                    ("targetBindingDigest", request.get("targetBindingDigest").cloned().unwrap_or(Value::Null)),
                    ("journalStoreIdentity", s(&self.store)),
                    ("journalRevision", s(&revision)),
                    ("absenceEvidenceDigest", s(&canon::digest_of(&evidence)?)),
                ]))
            }
        }
    }

    /// `input`: accept bytes at the exact cursor. The new cursor position is recorded with delivery `unknown` until the
    /// transport confirms the acknowledgement was sent ([`Journal::confirm_input`]); a lost acknowledgement stays unknown
    /// and is never resent automatically. Different bytes at an accepted offset conflict.
    pub fn input(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.verify()?;
        invalid(request.is_obj())?;
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let text = key_text(&key)?;
        let mut record = match self.read_entry(&text)? {
            Some(Entry::Tombstone(_)) => return Err(Code::LeaseRetired),
            None => return Err(Code::NotFound),
            Some(Entry::Record(record)) => record,
        };
        need(record.state == "running", Code::LeaseRetired)?;
        invalid(request.get("connectionId").is_some_and(is_id) && request.get("offset").is_some_and(is_u64_text) && request.get("bytesDigest").is_some_and(is_digest))?;
        let length = request.get("byteLength").and_then(Value::int).filter(|length| *length > 0 && *length <= DATA_BYTES_PER_FRAME).ok_or(Code::CapacityExceeded)?;
        let connection = str_field(request, "connectionId").unwrap_or_default();
        let offset_text = str_field(request, "offset").unwrap_or_default();
        let digest = str_field(request, "bytesDigest").unwrap_or_default();
        let position = record.cursors.iter().position(|cursor| cursor.connection_id == connection);
        if position.is_none() {
            need(record.cursors.len() < CONNECTIONS_PER_EXECUTION, Code::CapacityExceeded)?;
        }
        let (through, delivery) = match position {
            Some(index) => (record.cursors[index].accepted_through.clone(), record.cursors[index].delivery.clone()),
            None => ("0".to_string(), "acknowledged".to_string()),
        };
        need(delivery != "unknown", Code::DeliveryUnknown)?;
        let offset: u128 = offset_text.parse().map_err(|_| Code::InvalidRequest)?;
        let through_value: u128 = through.parse().map_err(|_| Code::StateCorrupt)?;
        let reply = |accepted: &str| obj(vec![("connectionId", s(&connection)), ("acceptedThrough", s(accepted))]);
        if offset < through_value {
            let chunk = position.and_then(|index| record.cursors[index].chunks.iter().find(|chunk| chunk.offset == offset_text));
            need(chunk.is_some_and(|chunk| chunk.bytes_digest == digest && chunk.byte_length == length), Code::OperationConflict)?;
            return Ok(reply(&through));
        }
        invalid(offset == through_value)?;
        let accepted = through_value + length as u128;
        need(accepted <= u64::MAX as u128, Code::CapacityExceeded)?;
        let accepted = accepted.to_string();
        let index = match position {
            Some(index) => index,
            None => {
                let insert_at = record.cursors.partition_point(|cursor| cursor.connection_id.as_bytes() < connection.as_bytes());
                record.cursors.insert(insert_at, Cursor { connection_id: connection.clone(), accepted_through: "0".into(), delivery: "acknowledged".into(), chunks: Vec::new() });
                insert_at
            }
        };
        let cursor = &mut record.cursors[index];
        cursor.chunks.push(Chunk { offset: offset_text, bytes_digest: digest, byte_length: length });
        cursor.accepted_through = accepted.clone();
        cursor.delivery = "unknown".into();
        self.bump(&mut record, now);
        // Refuse (never evict) input whose history would leave the record unable to settle within its budget.
        self.settled_size_fits(&text, &key, &record)?;
        self.persist(&text, &key, &Entry::Record(record), false, true)?;
        Ok(reply(&accepted))
    }

    /// The acknowledgement of an accepted input was delivered: its cursor becomes `acknowledged` (no revision change).
    /// A cursor that moved on or was already reconciled is left as it is.
    pub fn confirm_input(&mut self, key: &Value, connection_id: &str, accepted_through: &str) -> Result<(), Code> {
        self.verify()?;
        let text = key_text(key)?;
        let Some(Entry::Record(mut record)) = self.read_entry(&text)? else {
            return Ok(());
        };
        let Some(cursor) = record.cursors.iter_mut().find(|cursor| cursor.connection_id == connection_id) else {
            return Ok(());
        };
        if cursor.accepted_through != accepted_through || cursor.delivery == "acknowledged" {
            return Ok(());
        }
        cursor.delivery = "acknowledged".into();
        self.persist(&text, key, &Entry::Record(record), false, false)
    }

    /// `stop`: idempotent exact-tree cancellation of this operation only.
    pub fn stop(&mut self, request: &Value, now: i64, hooks: &mut dyn Hooks) -> Result<Value, Code> {
        self.verify()?;
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let text = key_text(&key)?;
        let mut record = match self.read_entry(&text)? {
            Some(Entry::Tombstone(tombstone)) => return Ok(tombstone.receipt),
            None => return Err(Code::NotFound),
            Some(Entry::Record(record)) => record,
        };
        if ["reserved", "prepared", "running"].contains(&record.state.as_str()) {
            if !record.stopped {
                // Sent for created and possibly created (reserved) operations alike; the keeper's stop is idempotent.
                hooks.stop(&text).map_err(|_| Code::OutcomeUnknown)?;
                record.stopped = true;
            }
            record.state = "stopping".into();
            self.bump(&mut record, now);
            self.persist(&text, &key, &Entry::Record(record.clone()), false, true)?;
        }
        self.receipt(&record, now)
    }

    /// The keeper observed the operation's exit.
    pub fn observe_exit(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.verify()?;
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let text = key_text(&key)?;
        let Some(Entry::Record(mut record)) = self.read_entry(&text)? else {
            return Err(Code::NotFound);
        };
        if ["running", "stopping", "prepared", "reserved"].contains(&record.state.as_str()) {
            record.state = "exited".into();
            self.bump(&mut record, now);
            self.persist(&text, &key, &Entry::Record(record.clone()), false, true)?;
        }
        self.receipt(&record, now)
    }

    /// `release`: every recorded resource is verified absent (released) or quarantined. Name, PID or inspect-404
    /// evidence is not absence: the whole release refuses with `absence_unverified` and nothing changes.
    pub fn release(&mut self, request: &Value, now: i64, hooks: &mut dyn Hooks) -> Result<Value, Code> {
        self.verify()?;
        let evidence = request.get("evidence").and_then(|evidence| if evidence.is_obj() { evidence.get("resources") } else { None });
        invalid(request.is_obj() && evidence.and_then(Value::arr).is_some())?;
        let evidence = evidence.and_then(Value::arr).unwrap_or_default();
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let text = key_text(&key)?;
        let mut record = match self.read_entry(&text)? {
            Some(Entry::Tombstone(tombstone)) => return Ok(tombstone.receipt),
            None => return Err(Code::NotFound),
            Some(Entry::Record(record)) => record,
        };
        need(["exited", "stopping", "quarantined"].contains(&record.state.as_str()), Code::OperationConflict)?;
        // `new Map(entries.map(e => [e.resourceId, e]))`: the last entry for an ID wins.
        let mut by_id: Vec<(Value, &Value)> = Vec::new();
        for entry in evidence {
            let id = entry.get("resourceId").cloned().unwrap_or(Value::Null);
            match by_id.iter_mut().find(|(known, _)| *known == id) {
                Some(slot) => slot.1 = entry,
                None => by_id.push((id, entry)),
            }
        }
        let find = |resource_id: &str| by_id.iter().find(|(id, _)| id.str() == Some(resource_id)).map(|(_, entry)| *entry);
        need(by_id.len() == record.resources.len() && record.resources.iter().all(|resource| find(&resource.resource_id).is_some()), Code::AbsenceUnverified)?;
        for resource in &record.resources {
            let entry = find(&resource.resource_id).unwrap_or(&Value::Null);
            let kind = entry.str_at("kind");
            need(matches!(kind, Some("verified-absent" | "quarantine")), Code::AbsenceUnverified)?;
            if kind == Some("verified-absent") {
                need(entry.get("evidenceDigest").is_some_and(is_digest), Code::AbsenceUnverified)?;
            }
        }
        let mut quarantined = false;
        for index in 0..record.resources.len() {
            let resource = &record.resources[index];
            if resource.state == "released" || resource.state == "quarantined" {
                continue;
            }
            let entry = find(&resource.resource_id).unwrap_or(&Value::Null);
            if entry.str_at("kind") == Some("quarantine") {
                quarantined = true;
                record.resources[index].state = "quarantined".into();
            } else {
                hooks.release(&text, &resource.resource_id).map_err(|_| Code::OutcomeUnknown)?;
                let digest = entry.str_at("evidenceDigest").unwrap_or_default().to_string();
                record.resources[index].state = "released".into();
                record.resources[index].absence_evidence_digest = Some(digest);
                // Persist the progress (no revision change): a retry after a later failure skips this resource.
                self.persist(&text, &key, &Entry::Record(record.clone()), false, false)?;
            }
        }
        record.state = if quarantined || record.resources.iter().any(|resource| resource.state == "quarantined") { "quarantined" } else { "exited" }.into();
        record.settled_at_ms = Some(now);
        self.bump(&mut record, now);
        self.persist(&text, &key, &Entry::Record(record.clone()), false, true)?;
        self.receipt(&record, now)
    }

    /// `retire`: after the settled-receipt retention, and only when no worker recovery obligation references the details,
    /// the record becomes a compact tombstone that keeps the key for the journal's lifetime.
    pub fn retire(&mut self, request: &Value, now: i64) -> Result<Value, Code> {
        self.verify()?;
        invalid(request.is_obj() && request.get("referenced").and_then(Value::bool).is_some())?;
        let key = request.get("key").cloned().unwrap_or(Value::Null);
        let text = key_text(&key)?;
        let mut record = match self.read_entry(&text)? {
            Some(Entry::Tombstone(tombstone)) => return Ok(tombstone.receipt),
            None => return Err(Code::NotFound),
            Some(Entry::Record(record)) => record,
        };
        need(
            record.settled_at_ms.is_some() && record.resources.iter().all(|resource| resource.state == "released" || resource.state == "quarantined"),
            Code::OperationConflict,
        )?;
        let settled = record.settled_at_ms.unwrap_or_default() as i128;
        need(now as i128 - settled >= self.limits.retention_ms as i128 && request.get("referenced") == Some(&Value::Bool(false)), Code::OperationConflict)?;
        self.bump(&mut record, now);
        let receipt = self.receipt(&record, now)?;
        let tombstone = Tombstone {
            target_binding_digest: record.target_binding_digest.clone(),
            reservation_id: record.reservation_id.clone(),
            request_digest: record.request_digest.clone(),
            lease_id: record.lease_id.clone(),
            receipt: receipt.clone(),
        };
        self.persist(&text, &key, &Entry::Tombstone(tombstone), false, true)?;
        Ok(receipt)
    }
}

/// Production hooks while keeper launch is not wired (before G1): every effect refuses.
pub struct NoEffects;

impl Hooks for NoEffects {
    fn create(&mut self, _key_text: &str, _resources: &[ResourceSpec]) -> Result<Vec<String>, HookFailure> {
        Err(HookFailure)
    }
    fn release_gate(&mut self, _key_text: &str) -> Result<(), HookFailure> {
        Err(HookFailure)
    }
    fn stop(&mut self, _key_text: &str) -> Result<(), HookFailure> {
        Err(HookFailure)
    }
    fn release(&mut self, _key_text: &str, _resource_id: &str) -> Result<(), HookFailure> {
        Err(HookFailure)
    }
}
