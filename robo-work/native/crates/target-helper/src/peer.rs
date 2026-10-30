//! Authenticated mailbox sessions (Linux, slice P6b): the helper's connection handler (`serve_session`) and the
//! worker-side peer (`WorkerSession`, the native worker-side role of decision B4).
//!
//! One connection carries one session for one operation: the A11 handshake of [`crate::session`], then frames that
//! pass `frame::validate_target_frame` in both directions (T0 section 8). The helper validates the ticket with
//! `ticket::verify_helper_ticket` after checking that the binding it carries names this helper incarnation and this
//! journal store: that binding is then the binding the helper holds for the session, and every frame header must match it
//! (`frame_binding`). Ticket identifiers (reservation, operation, request digest) are Router-attested by the signature and
//! become the frame expectations; the helper nonce is the helper's own challenge.
//!
//! Operations served (worker-to-target `messageKind`, body, reply):
//!
//! | Kind | Body (canonical JSON) | Journal request | Reply kind |
//! |---|---|---|---|
//! | `prepare` | `{version:1, resources:[{resourceId, kind, locatorDigest}]}`; SHA-256 of the body must be the ticket's `requestDigest` | `prepare {key, targetBindingDigest, reservationId, requestDigest, leaseId, journalStoreIdentity, resources}` | `prepared` (the receipt) |
//! | `commit` | `{version:1, workerCommitDigest, preparedReceiptSequence, preparedResourcesDigest}` | `commit` with the same fields plus key, binding digest and reservation | `receipt` |
//! | `lookup` | `{version:1}` | `lookup {key, targetBindingDigest}` | `lookup-result` |
//! | `stop` (P8) | `{version:1}` | `stop {key}` (then `observe_exit` once the tree is verified gone) | `receipt` |
//! | `release` (P8) | `{version:1, evidence:{resources:[{resourceId, kind, evidenceDigest?}]}}` | `release {key, evidence}` (the launcher verifies absence itself) | `receipt` |
//!
//! Since slice P8 a prepare body may also carry `workload: {executable, args}` (`workload`), covered by the ticketed
//! request digest; the keeper supervisor requires it. A commit must come from the lease that prepared the record
//! (`binding_mismatch` otherwise); stop, release and lookup are also open to a recovery lease of the same binding scope.
//!
//! A journal or permission refusal is an authenticated `failure` frame with body `{version:1, code}`; the session stays
//! open. A frame that fails validation closes the connection (its descriptors are closed with it) and gets no reply.
//! Descriptor import is not part of this slice: a frame carrying descriptors is refused `descriptor_role`. The lease is
//! the verified ticket claim `leaseId` (A11.1).
//!
//! Lease renewal (P8; T0 `leaseTtlMs`, `challengeTimeoutMs`): every accepted handshake for a lease is its renewal (a
//! fresh helper nonce, a strictly greater channel epoch and the 5 s challenge deadline) and moves the lease's
//! helper-local monotonic deadline to now + [`LEASE_TTL_MS`]. At the deadline the lease is retired: only its unsettled
//! records are stopped and journaled exited (`service::TargetService::expire_lease`), its open session's next frame is
//! refused `lease_retired`, and no ticket can reopen it. Recovery uses another lease.
//! Per-lease channel epochs live in helper memory (A11.5): a new helper incarnation starts with none, which is safe
//! because the ticket audience binds the incarnation. A ticket must carry a strictly greater epoch than the one held for
//! its lease, and the new epoch is recorded only after `accepted` was sent (A11.2). The map holds at most
//! [`EPOCH_LEASES`] leases; when full, leases idle longer than an execution lifetime are pruned, otherwise a new lease
//! is refused `capacity_exceeded` (a held epoch is never evicted while it can matter).

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::Code;
use crate::canon::{self, Value, obj, s};
use crate::contract;
use crate::crypto::{b64url_decode, sha256_hex};
use crate::frame::{self, Ancillary, ExpectedIds, FrameLimits, FrameState};
use crate::keeper::KeeperLauncher;
use crate::mailbox::{Connection, RecvError, RecvLimits};
use crate::service::TargetService;
use crate::session::{
    self, BootstrapMessage, ChallengeMessage, HANDSHAKE_BYTES, TARGET_TO_WORKER, TicketKey, WORKER_TO_TARGET, accepted_message, decode_message,
    encode_message, possession_proof, proof_matches, refused_message,
};
use crate::ticket::{self, ChannelState, Expected, ReplayStore, TICKET_REPLAY_ENTRIES, TicketOptions};

pub const CHALLENGE_WAIT: Duration = Duration::from_millis(5000);
pub const IDLE_TIMEOUT: Duration = Duration::from_millis(300_000);
pub const REPLY_WAIT: Duration = Duration::from_millis(30_000);
/// How often an idle session runs the serve loop's housekeeping.
pub const HOUSEKEEPING_INTERVAL: Duration = Duration::from_millis(1000);
/// Leases whose channel epoch one helper incarnation remembers.
pub const EPOCH_LEASES: usize = 4096;
/// `TARGET_LIMITS_V1.executionLifetimeMs`: a lease idle longer than this cannot belong to a live execution.
pub const EPOCH_IDLE_PRUNE_MS: i64 = 86_400_000;
/// `TARGET_LIMITS_V1.leaseTtlMs`: an unrenewed lease expires this long after its last accepted handshake.
pub const LEASE_TTL_MS: i64 = 15_000;

/// The helper-local monotonic deadline of one lease, and whether it was retired (expired; never reopened).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseClock {
    pub deadline_mono_ms: i64,
    pub retired: bool,
    pub renewed_ms: i64,
}

/// The epoch last accepted for one lease and when.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseEpoch {
    pub epoch: String,
    pub accepted_ms: i64,
}

pub trait Clock {
    fn now_ms(&self) -> i64;
    fn mono_ms(&self) -> i64;
}

pub struct SystemClock {
    start: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        SystemClock { start: Instant::now() }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock::new()
    }
}

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
    }
    fn mono_ms(&self) -> i64 {
        self.start.elapsed().as_millis() as i64
    }
}

/// Helper-side state shared by the sessions of one helper incarnation.
pub struct HelperState {
    pub ticket_key: TicketKey,
    pub helper_incarnation: String,
    pub store_identity: String,
    pub replay: ReplayStore,
    /// Verified leaseId -> the epoch last accepted for it.
    pub epochs: HashMap<String, LeaseEpoch>,
    /// Verified leaseId -> its renewal deadline (slice P8).
    pub leases: HashMap<String, LeaseClock>,
    pub lease_ttl_ms: i64,
    pub clock_uncertainty_ms: i64,
}

impl HelperState {
    pub fn new(ticket_key: TicketKey, helper_incarnation: &str, store_identity: &str) -> Self {
        HelperState {
            ticket_key,
            helper_incarnation: helper_incarnation.to_string(),
            store_identity: store_identity.to_string(),
            replay: ReplayStore::new(),
            epochs: HashMap::new(),
            leases: HashMap::new(),
            lease_ttl_ms: LEASE_TTL_MS,
            clock_uncertainty_ms: 0,
        }
    }
}

/// How one session ended (diagnostics only; never carries secrets or frame contents).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionEnd {
    /// The handshake was refused with this code (a `refused` message was sent when the peer was still reachable).
    Refused(Code),
    /// The handshake transport failed before a refusal could be decided.
    HandshakeLost(&'static str),
    /// A frame failed validation; the connection was closed without a reply.
    FrameRefused(Code),
    /// The peer closed the connection after `frames` served frames.
    Closed { frames: u64 },
    /// A reply could not be sent (the peer is gone); the operation's effect, if any, is durable.
    ReplyLost { frames: u64 },
    /// A frame carrying descriptors was answered with a failure and the connection closed.
    DescriptorsRefused,
}

fn need(condition: bool, code: Code) -> Result<(), Code> {
    if condition { Ok(()) } else { Err(code) }
}

fn recv_error_name(error: &RecvError) -> &'static str {
    match error {
        RecvError::Closed => "closed",
        RecvError::Truncated => "truncated",
        RecvError::Oversize => "oversize",
        RecvError::Timeout => "timeout",
        RecvError::Ancillary(_) => "ancillary",
        RecvError::Io(_) => "io",
    }
}

fn recv_error_code(error: &RecvError) -> Code {
    match error {
        RecvError::Ancillary(_) => Code::DescriptorCount,
        RecvError::Oversize => Code::CapacityExceeded,
        _ => Code::FrameLayout,
    }
}

/// The header of one frame of this session (everything except `bodyBytes` and `bodyDigest`, set by `encode_frame`).
pub fn frame_header(binding: &Value, ids: &ExpectedIds, channel_epoch: &str, sequence: u128, direction: &str, message_kind: &str) -> Result<Value, Code> {
    let scope = binding.get("scope").ok_or(Code::InvalidRequest)?;
    let field = |value: &Value, key: &str| value.get(key).cloned().unwrap_or(Value::Null);
    Ok(obj(vec![
        ("version", Value::Int(1)),
        ("direction", s(direction)),
        ("workspaceId", field(scope, "workspaceId")),
        ("boxIdentity", field(scope, "boxIdentity")),
        ("boxGeneration", field(scope, "boxGeneration")),
        ("workerGeneration", field(scope, "workerGeneration")),
        ("executionId", field(binding, "executionId")),
        ("attemptId", field(binding, "attemptId")),
        ("leaseId", s(&ids.lease_id)),
        ("reservationId", s(&ids.reservation_id)),
        ("targetBindingDigest", s(&canon::digest_of(binding)?)),
        ("operationId", s(&ids.operation_id)),
        ("requestDigest", s(&ids.request_digest)),
        ("channelEpoch", s(channel_epoch)),
        ("sequence", s(&sequence.to_string())),
        ("messageKind", s(message_kind)),
        ("channelId", Value::Null),
        ("connectionId", Value::Null),
        ("processId", Value::Null),
        ("bodyBytes", Value::Int(0)),
        ("bodyDigest", s("")),
        ("descriptors", Value::Arr(Vec::new())),
    ]))
}

/// The OperationKey of a session operation.
pub fn operation_key(binding: &Value, operation_id: &str) -> Value {
    let scope = binding.get("scope").cloned().unwrap_or(Value::Null);
    let field = |value: &Value, key: &str| value.get(key).cloned().unwrap_or(Value::Null);
    obj(vec![
        ("workspaceId", field(&scope, "workspaceId")),
        ("workerGeneration", field(&scope, "workerGeneration")),
        ("executionId", field(binding, "executionId")),
        ("attemptId", field(binding, "attemptId")),
        ("operationId", s(operation_id)),
    ])
}

fn send_message(connection: &Connection, value: &Value) -> Result<(), &'static str> {
    let bytes = encode_message(value).map_err(|_| "encode")?;
    connection.send_frame(&bytes, &[]).map_err(|_| "send")
}

fn handshake_limits(wait: Duration) -> RecvLimits {
    RecvLimits { frame_bytes: HANDSHAKE_BYTES, descriptors_per_frame: 8, idle_timeout: Some(wait), partial_timeout: wait }
}

struct Established {
    key: [u8; 32],
    claims_canonical: Vec<u8>,
    claims: Value,
    binding: Value,
    ids: ExpectedIds,
    epoch: String,
}

fn handshake(connection: &Connection, state: &mut HelperState, clock: &dyn Clock) -> Result<Established, SessionEnd> {
    let refuse = |code: Code| {
        let _ = send_message(connection, &refused_message(code));
        SessionEnd::Refused(code)
    };
    let challenge = ChallengeMessage {
        challenge_id: session::random_nonce().map_err(|_| SessionEnd::HandshakeLost("random"))?,
        helper_nonce: session::random_nonce().map_err(|_| SessionEnd::HandshakeLost("random"))?,
        helper_incarnation: state.helper_incarnation.clone(),
    };
    let issued_mono_ms = clock.mono_ms();
    send_message(connection, &challenge.to_value()).map_err(SessionEnd::HandshakeLost)?;
    let received = match connection.recv_frame(handshake_limits(CHALLENGE_WAIT)) {
        Ok(received) => received,
        Err(RecvError::Closed) => return Err(SessionEnd::HandshakeLost("closed")),
        Err(RecvError::Timeout) => return Err(refuse(Code::TicketLifetime)),
        Err(error) => return Err(refuse(recv_error_code(&error))),
    };
    let message = decode_message(&received.bytes, received.descriptors.len());
    // Any descriptor received with a handshake message is closed here, before anything else.
    drop(received);
    let message = message.map_err(refuse)?;
    let bootstrap = BootstrapMessage::parse(&message).map_err(refuse)?;
    let (claims_canonical, claims) = session::unverified_claims(&bootstrap.ticket).map_err(refuse)?;
    let binding = claims.get("binding").cloned().ok_or_else(|| refuse(Code::TicketFormat))?;
    contract::validate_target_binding(&binding).map_err(|_| refuse(Code::TicketBinding))?;
    // The binding must name this helper incarnation and this journal store before it can become the held binding.
    let scope = binding.get("scope").cloned().unwrap_or(Value::Null);
    if scope.str_at("helperIncarnation") != Some(state.helper_incarnation.as_str())
        || binding.str_at("journalStoreIdentity") != Some(state.store_identity.as_str())
    {
        return Err(refuse(Code::TicketBinding));
    }
    let text = |key: &str| claims.str_at(key).unwrap_or_default().to_string();
    // The lease named by the claims (verified below together with the signature); never a bootstrap field.
    let lease = text("leaseId");
    if !state.epochs.contains_key(&lease) && state.epochs.len() >= EPOCH_LEASES {
        let horizon = clock.now_ms().saturating_sub(EPOCH_IDLE_PRUNE_MS);
        state.epochs.retain(|_, held| held.accepted_ms > horizon);
        state.leases.retain(|_, held| held.renewed_ms > horizon);
        if state.epochs.len() >= EPOCH_LEASES {
            return Err(refuse(Code::CapacityExceeded));
        }
    }
    let expected = Expected {
        reservation_id: text("reservationId"),
        lease_id: None,
        operation_id: text("operationId"),
        request_digest: text("requestDigest"),
        helper_nonce: challenge.helper_nonce.clone(),
    };
    // A retired (expired) lease cannot be reopened by any ticket.
    let lease_active = !state.leases.get(&lease).is_some_and(|held| held.retired);
    let channel = ChannelState { current_epoch: state.epochs.get(&lease).map(|held| held.epoch.clone()), lease_active };
    let challenge_record = ticket::Challenge { id: challenge.challenge_id.clone(), issued_mono_ms };
    let secret = state.ticket_key.secret.clone();
    let verified = ticket::verify_helper_ticket(
        &bootstrap.ticket,
        TicketOptions {
            secret: secret.expose(),
            kid: &state.ticket_key.kid,
            binding: &binding,
            expected: &expected,
            channel: &channel,
            challenge: &challenge_record,
            now_ms: clock.now_ms(),
            now_mono_ms: clock.mono_ms(),
            clock_uncertainty_ms: state.clock_uncertainty_ms,
            replay: &mut state.replay,
            replay_capacity: TICKET_REPLAY_ENTRIES,
        },
    );
    if let Err(code) = verified {
        return Err(refuse(code));
    }
    let key = session::session_key(secret.expose(), &claims_canonical);
    let worker_proof = possession_proof(&key, WORKER_TO_TARGET, &claims_canonical, &challenge.helper_nonce, &challenge.challenge_id, &state.helper_incarnation, &lease);
    if !proof_matches(&worker_proof, &bootstrap.proof) {
        return Err(refuse(Code::FrameAuthentication));
    }
    let epoch = text("channelEpoch");
    let helper_proof = possession_proof(&key, TARGET_TO_WORKER, &claims_canonical, &challenge.helper_nonce, &challenge.challenge_id, &state.helper_incarnation, &lease);
    send_message(connection, &accepted_message(&helper_proof)).map_err(SessionEnd::HandshakeLost)?;
    // A11.2: recorded only once `accepted` is on its way; a failed send leaves the held epoch unchanged.
    state.epochs.insert(lease.clone(), LeaseEpoch { epoch: epoch.clone(), accepted_ms: clock.now_ms() });
    // The accepted handshake renews the lease (P8).
    state.leases.insert(lease.clone(), LeaseClock { deadline_mono_ms: clock.mono_ms().saturating_add(state.lease_ttl_ms), retired: false, renewed_ms: clock.now_ms() });
    let ids = ExpectedIds { lease_id: lease, reservation_id: expected.reservation_id, operation_id: expected.operation_id, request_digest: expected.request_digest };
    Ok(Established { key, claims_canonical, claims, binding, ids, epoch })
}

fn permitted(claims: &Value, permission: &str) -> bool {
    claims.get("permissions").and_then(Value::arr).unwrap_or_default().iter().any(|entry| entry.str() == Some(permission))
}

fn body_object(body: &[u8], keys: &[&str]) -> Result<Value, Code> {
    let value = canon::parse_canonical(body, canon::RECEIPT_BYTES)?;
    need(value.is_obj(), Code::InvalidRequest)?;
    need(value.get("version") == Some(&Value::Int(1)), Code::UnsupportedVersion)?;
    need(value.has_exact_keys(keys), Code::InvalidRequest)?;
    Ok(value)
}

fn dispatch<L: KeeperLauncher>(session: &Established, kind: &str, body: &[u8], service: &mut TargetService<L>, now: i64) -> Result<(&'static str, Value), Code> {
    let (permission, reply) = match kind {
        "prepare" => ("prepare", "prepared"),
        "commit" => ("commit", "receipt"),
        "lookup" => ("lookup", "lookup-result"),
        "stop" => ("stop", "receipt"),
        "release" => ("release", "receipt"),
        _ => return Err(Code::InvalidRequest),
    };
    // A ticket authorizes only the operations it lists.
    need(permitted(&session.claims, permission), Code::TicketBinding)?;
    let binding = &session.binding;
    let key = operation_key(binding, &session.ids.operation_id);
    let binding_digest = s(&canon::digest_of(binding)?);
    let value = match kind {
        "prepare" => {
            let request = match body_object(body, &["version", "resources", "workload"]) {
                Ok(request) => request,
                Err(Code::InvalidRequest) => body_object(body, &["version", "resources"])?,
                Err(code) => return Err(code),
            };
            // The ticket's request digest names exactly this request body; another payload needs its own ticket.
            need(sha256_hex(body) == session.ids.request_digest, Code::FrameBinding)?;
            service.prepare_workload(
                &obj(vec![
                    ("key", key),
                    ("targetBindingDigest", binding_digest),
                    ("reservationId", s(&session.ids.reservation_id)),
                    ("requestDigest", s(&session.ids.request_digest)),
                    ("leaseId", s(&session.ids.lease_id)),
                    ("journalStoreIdentity", binding.get("journalStoreIdentity").cloned().unwrap_or(Value::Null)),
                    ("resources", request.get("resources").cloned().unwrap_or(Value::Null)),
                ]),
                request.get("workload"),
                now,
            )?
        }
        "commit" => {
            let request = body_object(body, &["version", "workerCommitDigest", "preparedReceiptSequence", "preparedResourcesDigest"])?;
            // Only the lease that prepared the record releases its gate (a recovery lease may look up, stop and release).
            if let Some(lease) = service.record_lease(&key)? {
                need(lease == session.ids.lease_id, Code::BindingMismatch)?;
            }
            let field = |name: &str| request.get(name).cloned().unwrap_or(Value::Null);
            service.commit(
                &obj(vec![
                    ("key", key),
                    ("targetBindingDigest", binding_digest),
                    ("reservationId", s(&session.ids.reservation_id)),
                    ("workerCommitDigest", field("workerCommitDigest")),
                    ("preparedReceiptSequence", field("preparedReceiptSequence")),
                    ("preparedResourcesDigest", field("preparedResourcesDigest")),
                ]),
                now,
            )?
        }
        "stop" => {
            body_object(body, &["version"])?;
            service.stop(&obj(vec![("key", key)]), now)?
        }
        "release" => {
            let request = body_object(body, &["version", "evidence"])?;
            service.release(&obj(vec![("key", key), ("evidence", request.get("evidence").cloned().unwrap_or(Value::Null))]), now)?
        }
        _ => {
            body_object(body, &["version"])?;
            service.lookup(&obj(vec![("key", key), ("targetBindingDigest", binding_digest)]), now)?
        }
    };
    Ok((reply, value))
}

/// Retires every lease whose renewal deadline passed and stops only its unsettled records (slice P8). `emit` receives
/// diagnostic events (lease IDs are opaque identities, never secrets).
pub fn expire_leases<L: KeeperLauncher>(state: &mut HelperState, service: &mut TargetService<L>, clock: &dyn Clock, emit: &mut dyn FnMut(&str, Vec<(&str, Value)>)) {
    let now_mono = clock.mono_ms();
    let mut expired: Vec<String> = state.leases.iter().filter(|(_, held)| !held.retired && held.deadline_mono_ms <= now_mono).map(|(lease, _)| lease.clone()).collect();
    expired.sort();
    for lease in expired {
        if let Some(held) = state.leases.get_mut(&lease) {
            held.retired = true;
        }
        match service.expire_lease(&lease, clock.now_ms()) {
            Ok(settled) => {
                emit("lease_expired", vec![("leaseId", s(&lease)), ("records", Value::Int(settled.len() as i64))]);
                for item in settled {
                    journaled_event(&item, emit);
                }
            }
            Err(code) => emit("lease_expired", vec![("leaseId", s(&lease)), ("code", s(code.as_str()))]),
        }
    }
}

/// One `journaled` diagnostic event (the key digest, never the key's identifiers in clear).
pub fn journaled_event(item: &crate::service::Journaled, emit: &mut dyn FnMut(&str, Vec<(&str, Value)>)) {
    let mut fields = vec![("keyDigest", s(&sha256_hex(item.key_text.as_bytes()))), ("cause", s(item.cause))];
    match &item.outcome {
        Ok(state) => fields.push(("state", s(state))),
        Err(code) => fields.push(("code", s(code.as_str()))),
    }
    emit("journaled", fields);
}

/// Everything the serve loop does between frames and connections: journal what the launcher observed, then expire
/// leases.
pub fn housekeeping<L: KeeperLauncher>(state: &mut HelperState, service: &mut TargetService<L>, clock: &dyn Clock, emit: &mut dyn FnMut(&str, Vec<(&str, Value)>)) {
    for item in service.pump(clock.now_ms()) {
        journaled_event(&item, emit);
    }
    expire_leases(state, service, clock, emit);
}

/// Serves one accepted connection: handshake, then authenticated frames until the peer closes or a frame is refused.
/// `emit` receives diagnostic events (names and codes only).
pub fn serve_session<L: KeeperLauncher>(
    connection: &Connection,
    state: &mut HelperState,
    service: &mut TargetService<L>,
    clock: &dyn Clock,
    emit: &mut dyn FnMut(&str, Vec<(&str, Value)>),
) -> SessionEnd {
    let session = match handshake(connection, state, clock) {
        Ok(session) => session,
        Err(end) => {
            match &end {
                SessionEnd::Refused(code) => emit("session_refused", vec![("code", s(code.as_str()))]),
                SessionEnd::HandshakeLost(reason) => emit("session_lost", vec![("reason", s(reason))]),
                _ => {}
            }
            return end;
        }
    };
    emit("session", vec![("channelEpoch", s(&session.epoch))]);
    let mut receive_sequence: u128 = 1;
    let mut send_sequence: u128 = 1;
    let mut frames: u64 = 0;
    loop {
        // While the session is idle, housekeeping still runs every HOUSEKEEPING_INTERVAL (keeper outcomes are journaled
        // and leases expire) until a frame starts or the idle timeout passes.
        let idle_since = Instant::now();
        loop {
            let mut entry = libc::pollfd { fd: std::os::fd::AsRawFd::as_raw_fd(connection), events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd.
            let ready = unsafe { libc::poll(&mut entry, 1, HOUSEKEEPING_INTERVAL.as_millis() as libc::c_int) };
            if ready != 0 {
                break;
            }
            if idle_since.elapsed() >= IDLE_TIMEOUT {
                emit("frame_refused", vec![("code", s(Code::FrameLayout.as_str())), ("transport", s("timeout"))]);
                return SessionEnd::FrameRefused(Code::FrameLayout);
            }
            housekeeping(state, service, clock, emit);
        }
        let remaining = IDLE_TIMEOUT.saturating_sub(idle_since.elapsed()).max(Duration::from_millis(1));
        let limits = RecvLimits { idle_timeout: Some(remaining), ..RecvLimits::default() };
        let received = match connection.recv_frame(limits) {
            Ok(received) => received,
            Err(RecvError::Closed) => {
                emit("session_closed", vec![("frames", Value::Int(frames as i64))]);
                return SessionEnd::Closed { frames };
            }
            Err(error) => {
                let code = recv_error_code(&error);
                emit("frame_refused", vec![("code", s(code.as_str())), ("transport", s(recv_error_name(&error)))]);
                return SessionEnd::FrameRefused(code);
            }
        };
        let next = receive_sequence.to_string();
        // Journal keeper outcomes and expire leases before the frame is judged: a lookup sees the current state and a
        // retired lease's frame is refused.
        housekeeping(state, service, clock, emit);
        let lease_active = !state.leases.get(&session.ids.lease_id).is_some_and(|held| held.retired);
        let frame_state = FrameState {
            direction: WORKER_TO_TARGET,
            session_key: &session.key,
            claims_canonical: &session.claims_canonical,
            binding: &session.binding,
            expected: &session.ids,
            channel_epoch: &session.epoch,
            next_sequence: &next,
            lease_active,
            ancillary: received.ancillary,
            channel_manifest: None,
            limits: FrameLimits::default(),
        };
        let accepted = match frame::validate_target_frame(&received.bytes, &frame_state) {
            Ok(accepted) => accepted,
            Err(code) => {
                let closed = received.descriptors.len();
                drop(received);
                emit("frame_refused", vec![("code", s(code.as_str())), ("descriptorsClosed", Value::Int(closed as i64))]);
                return SessionEnd::FrameRefused(code);
            }
        };
        receive_sequence += 1;
        let kind = accepted.header.str_at("messageKind").unwrap_or_default().to_string();
        let body = &received.bytes[accepted.body_offset..accepted.body_offset + accepted.body_length];
        let carried_descriptors = !received.descriptors.is_empty();
        let outcome = if carried_descriptors { Err(Code::DescriptorRole) } else { dispatch(&session, &kind, body, service, clock.now_ms()) };
        // Every received descriptor is closed before the reply.
        drop(received);
        let (reply_kind, reply_body) = match outcome {
            Ok((reply_kind, value)) => (reply_kind, value),
            Err(code) => ("failure", obj(vec![("version", Value::Int(1)), ("code", s(code.as_str()))])),
        };
        let encoded = canon::canonical(&reply_body, canon::RECEIPT_BYTES).and_then(|body_text| {
            let header = frame_header(&session.binding, &session.ids, &session.epoch, send_sequence, TARGET_TO_WORKER, reply_kind)?;
            frame::encode_frame(&header, body_text.as_bytes(), &session.key, &session.claims_canonical, FrameLimits::default())
        });
        frames += 1;
        let code = reply_body.str_at("code").map(str::to_string);
        let mut fields = vec![("messageKind", s(&kind)), ("reply", s(reply_kind))];
        if let Some(code) = &code {
            fields.push(("code", s(code)));
        }
        emit("frame", fields);
        let sent = match encoded {
            Ok(bytes) => connection.send_frame(&bytes, &[]).is_ok(),
            Err(_) => false,
        };
        if !sent {
            emit("reply_lost", vec![("messageKind", s(&kind))]);
            return SessionEnd::ReplyLost { frames };
        }
        send_sequence += 1;
        if carried_descriptors {
            return SessionEnd::DescriptorsRefused;
        }
    }
}

// ---- Worker side --------------------------------------------------------------------------------------------------

/// One reply frame as received and validated by the worker peer.
#[derive(Clone, Debug)]
pub struct Reply {
    pub message_kind: String,
    pub body: Vec<u8>,
    pub frame: Vec<u8>,
}

/// Reads the helper's challenge (the first message of every connection).
pub fn read_challenge(connection: &Connection) -> Result<ChallengeMessage, Code> {
    let received = connection.recv_frame(handshake_limits(CHALLENGE_WAIT)).map_err(|error| recv_error_code(&error))?;
    let value = decode_message(&received.bytes, received.descriptors.len())?;
    ChallengeMessage::parse(&value)
}

/// The worker side of one session.
pub struct WorkerSession {
    connection: Connection,
    key: [u8; 32],
    claims_canonical: Vec<u8>,
    binding: Value,
    ids: ExpectedIds,
    epoch: String,
    send_sequence: u128,
    receive_sequence: u128,
}

/// A worker-side failure: a local code or the helper's refusal code (text from the helper is reduced to an enumerated
/// spelling by the caller; it is never interpreted here).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkerError {
    Local(Code),
    Refused(String),
    Transport(&'static str),
}

impl WorkerError {
    pub fn code(&self) -> String {
        match self {
            WorkerError::Local(code) => code.as_str().to_string(),
            WorkerError::Refused(code) => code.clone(),
            WorkerError::Transport(reason) => format!("transport_{reason}"),
        }
    }
}

impl WorkerSession {
    /// Sends the bootstrap for `challenge` (the worker-side checks of [`WorkerSession::bootstrap`] included) and returns the
    /// still-open connection with the claims and the worker's view of the proof inputs.
    fn send_bootstrap(connection: &Connection, challenge: &ChallengeMessage, ticket: &str, session_key: &[u8; 32]) -> Result<(Vec<u8>, Value), WorkerError> {
        let (claims_canonical, claims) = session::unverified_claims(ticket).map_err(WorkerError::Local)?;
        // The worker never presents a ticket minted for another challenge or another helper incarnation.
        let binding = claims.get("binding").cloned().ok_or(WorkerError::Local(Code::TicketFormat))?;
        let scope = binding.get("scope").cloned().unwrap_or(Value::Null);
        if claims.str_at("helperNonce") != Some(challenge.helper_nonce.as_str()) || scope.str_at("helperIncarnation") != Some(challenge.helper_incarnation.as_str()) {
            return Err(WorkerError::Local(Code::TicketBinding));
        }
        let lease = claims.str_at("leaseId").unwrap_or_default().to_string();
        let proof = possession_proof(session_key, WORKER_TO_TARGET, &claims_canonical, &challenge.helper_nonce, &challenge.challenge_id, &challenge.helper_incarnation, &lease);
        let message = BootstrapMessage { ticket: ticket.to_string(), proof: crate::crypto::b64url_encode(&proof) };
        send_message(connection, &message.to_value()).map_err(WorkerError::Transport)?;
        Ok((claims_canonical, claims))
    }

    /// PROOF-FIXTURE fault (lost `accepted`): sends the bootstrap and closes without reading the answer.
    pub fn bootstrap_and_drop(connection: Connection, challenge: &ChallengeMessage, ticket: &str, session_key: [u8; 32]) -> Result<(), WorkerError> {
        WorkerSession::send_bootstrap(&connection, challenge, ticket, &session_key)?;
        drop(connection);
        Ok(())
    }

    /// Answers `challenge` with `ticket` and the session key the Router handed over with it, and checks the helper's
    /// possession proof. The binding, lease, reservation, operation, request digest and epoch come from the ticket claims.
    pub fn bootstrap(connection: Connection, challenge: &ChallengeMessage, ticket: &str, session_key: [u8; 32]) -> Result<WorkerSession, WorkerError> {
        let (claims_canonical, claims) = WorkerSession::send_bootstrap(&connection, challenge, ticket, &session_key)?;
        let lease = claims.str_at("leaseId").unwrap_or_default().to_string();
        let binding = claims.get("binding").cloned().ok_or(WorkerError::Local(Code::TicketFormat))?;
        let received = connection.recv_frame(handshake_limits(REPLY_WAIT)).map_err(|error| WorkerError::Transport(recv_error_name(&error)))?;
        let value = decode_message(&received.bytes, received.descriptors.len()).map_err(WorkerError::Local)?;
        match value.str_at("kind") {
            Some("accepted") if value.has_exact_keys(&["version", "kind", "proof"]) => {
                let expected = possession_proof(&session_key, TARGET_TO_WORKER, &claims_canonical, &challenge.helper_nonce, &challenge.challenge_id, &challenge.helper_incarnation, &lease);
                if !proof_matches(&expected, value.str_at("proof").unwrap_or_default()) {
                    return Err(WorkerError::Local(Code::FrameAuthentication));
                }
            }
            Some("refused") if value.has_exact_keys(&["version", "kind", "code"]) => {
                // A11.6: only an enumerated spelling or the generic `refused` leaves this function.
                let code = value.str_at("code").and_then(Code::from_spelling).map_or("refused", Code::as_str);
                return Err(WorkerError::Refused(code.to_string()));
            }
            _ => return Err(WorkerError::Local(Code::InvalidRequest)),
        }
        let text = |key: &str| claims.str_at(key).unwrap_or_default().to_string();
        let ids = ExpectedIds { lease_id: lease, reservation_id: text("reservationId"), operation_id: text("operationId"), request_digest: text("requestDigest") };
        Ok(WorkerSession { connection, key: session_key, claims_canonical, binding, ids, epoch: text("channelEpoch"), send_sequence: 1, receive_sequence: 1 })
    }

    fn send(&mut self, message_kind: &str, body: &[u8]) -> Result<(), WorkerError> {
        let header = frame_header(&self.binding, &self.ids, &self.epoch, self.send_sequence, WORKER_TO_TARGET, message_kind).map_err(WorkerError::Local)?;
        let bytes = frame::encode_frame(&header, body, &self.key, &self.claims_canonical, FrameLimits::default()).map_err(WorkerError::Local)?;
        self.connection.send_frame(&bytes, &[]).map_err(|_| WorkerError::Transport("send"))?;
        self.send_sequence += 1;
        Ok(())
    }

    /// Sends one frame and returns the validated reply.
    pub fn request(&mut self, message_kind: &str, body: &[u8]) -> Result<Reply, WorkerError> {
        self.send(message_kind, body)?;
        let limits = RecvLimits { idle_timeout: Some(REPLY_WAIT), ..RecvLimits::default() };
        let received = self.connection.recv_frame(limits).map_err(|error| WorkerError::Transport(recv_error_name(&error)))?;
        let next = self.receive_sequence.to_string();
        let state = FrameState {
            direction: TARGET_TO_WORKER,
            session_key: &self.key,
            claims_canonical: &self.claims_canonical,
            binding: &self.binding,
            expected: &self.ids,
            channel_epoch: &self.epoch,
            next_sequence: &next,
            lease_active: true,
            ancillary: received.ancillary,
            channel_manifest: None,
            limits: FrameLimits::default(),
        };
        let accepted = frame::validate_target_frame(&received.bytes, &state).map_err(WorkerError::Local)?;
        if received.ancillary != (Ancillary { count: 0, truncated: false, well_formed: true, on_first_byte: true }) {
            return Err(WorkerError::Local(Code::DescriptorCount));
        }
        self.receive_sequence += 1;
        let body = received.bytes[accepted.body_offset..accepted.body_offset + accepted.body_length].to_vec();
        Ok(Reply { message_kind: accepted.header.str_at("messageKind").unwrap_or_default().to_string(), body, frame: received.bytes.clone() })
    }

    /// PROOF-FIXTURE fault (lost reply): sends one frame and closes the connection without reading the reply.
    pub fn send_and_drop(mut self, message_kind: &str, body: &[u8]) -> Result<(), WorkerError> {
        self.send(message_kind, body)?;
        drop(self);
        Ok(())
    }
}

/// Parses a 32-byte base64url session key (worker stdin input).
pub fn parse_session_key(text: &str) -> Result<[u8; 32], Code> {
    let bytes = b64url_decode(text).ok_or(Code::InvalidRequest)?;
    bytes.try_into().map_err(|_| Code::InvalidRequest)
}
