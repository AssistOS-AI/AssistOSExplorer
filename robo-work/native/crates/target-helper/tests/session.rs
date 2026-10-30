//! Slice P6b: the PROPOSED session handshake and the authenticated prepare/commit/lookup round trip over a real AF_UNIX
//! socket pair. The helper side (`peer::serve_session`) runs on the test thread; the worker side (`peer::WorkerSession`)
//! runs in a thread and mints its tickets with a synthetic key (the Router's role in these tests).
//!
//! Default build: the pre-G1 launcher refuses every mutation `keeper_unavailable` before any journal write, while lookup
//! answers with authenticated absence. Feature `proof-fixture`: the fixture launcher (which launches nothing) admits the
//! full round trip, the lost-reply lookup, the conflicting payload and the replaced-target refusal.
#![cfg(target_os = "linux")]

mod common;

use std::time::Duration;

use rw_target_helper::Code;
use rw_target_helper::canon::{self, Value, obj, s};
use rw_target_helper::contract::target_identity_digest;
use rw_target_helper::crypto::{Secret, b64url_encode, sha256_hex};
use rw_target_helper::journal::{Journal, JournalLimits};
use rw_target_helper::keeper::{KeeperLauncher, UnavailableUntilG1};
use rw_target_helper::mailbox::Connection;
use rw_target_helper::peer::{self, HelperState, SessionEnd, SystemClock, WorkerError, WorkerSession};
use rw_target_helper::service::TargetService;
use rw_target_helper::session::{self, ChallengeMessage, TicketKey};
use rw_target_helper::ticket::sign_ticket_for_tests;

const SECRET: [u8; 32] = [0x5a; 32];
const KID: &str = "synthetic-test-helper-key";
const INCARNATION: &str = "AgICAgICAgICAgICAgICAg";
const STORE: &str = "AwMDAwMDAwMDAwMDAwMDAw";

fn id(label: &str) -> String {
    b64url_encode(&rw_target_helper::crypto::sha256(format!("p6b-id:{label}").as_bytes())[..16])
}

/// The corpus binding with this test's helper incarnation and journal store.
fn binding(incarnation: &str, store: &str) -> Value {
    let vectors = common::load(&common::crate_dir().join("tests/vectors/transport-v1.json"));
    let mut binding = vectors.get("ticket").and_then(|ticket| ticket.get("claims")).and_then(|claims| claims.get("binding")).cloned().expect("binding");
    let mut scope = binding.get("scope").cloned().unwrap();
    scope.set("helperIncarnation", s(incarnation));
    binding.set("scope", scope);
    binding.set("journalStoreIdentity", s(store));
    binding
}

struct Mint {
    secret: Vec<u8>,
    kid: String,
    binding: Value,
    lease: String,
    operation_id: String,
    request_digest: String,
    epoch: (String, Value),
    permissions: Vec<&'static str>,
    iat_offset: i64,
}

impl Mint {
    fn new(binding: &Value, operation: &str, request_digest: &str) -> Mint {
        Mint {
            secret: SECRET.to_vec(),
            kid: KID.into(),
            binding: binding.clone(),
            lease: id("lease"),
            operation_id: id(operation),
            request_digest: request_digest.into(),
            epoch: ("1".into(), Value::Null),
            permissions: vec!["commit", "lookup", "prepare"],
            iat_offset: 0,
        }
    }

    fn lease(mut self, lease: &str) -> Mint {
        self.lease = lease.into();
        self
    }

    fn epoch(mut self, epoch: &str, previous: Option<&str>) -> Mint {
        self.epoch = (epoch.into(), previous.map_or(Value::Null, s));
        self
    }

    /// The Router's mint for one challenge: the ticket and the session key it hands to the worker.
    fn ticket(&self, helper_nonce: &str) -> (String, [u8; 32]) {
        let now = SystemClock::new();
        let iat = rw_target_helper::peer::Clock::now_ms(&now) / 1000 + self.iat_offset;
        let scope = self.binding.get("scope").unwrap();
        let claims = obj(vec![
            ("version", Value::Int(1)),
            ("iss", s("ploinky-router")),
            ("sub", scope.get("workerPrincipal").cloned().unwrap()),
            ("purpose", s("ploinky.target-helper.v1")),
            ("aud", s(&format!("ploinky:target-helper:{}", target_identity_digest(scope).unwrap()))),
            ("binding", self.binding.clone()),
            ("reservationId", s(&id("reservation"))),
            ("leaseId", s(&self.lease)),
            ("operationId", s(&self.operation_id)),
            ("requestDigest", s(&self.request_digest)),
            ("helperNonce", s(helper_nonce)),
            ("jti", s(&session::random_nonce().unwrap())),
            ("iat", Value::Int(iat)),
            ("exp", Value::Int(iat + 30)),
            ("channelEpoch", s(&self.epoch.0)),
            ("previousChannelEpoch", self.epoch.1.clone()),
            ("permissions", Value::Arr(self.permissions.iter().map(|entry| s(entry)).collect())),
            ("limitsDigest", self.binding.get("limitsDigest").cloned().unwrap()),
        ]);
        let claims_text = canon::canonical_text(&claims).unwrap();
        let header = format!(r#"{{"alg":"HS256","kid":"{}","typ":"ploinky-target-helper+jwt"}}"#, self.kid);
        let ticket = sign_ticket_for_tests(&self.secret, &header, &claims_text);
        (ticket, session::session_key(&self.secret, claims_text.as_bytes()))
    }
}

fn prepare_body(label: &str) -> String {
    let resources = Value::Arr(vec![obj(vec![
        ("resourceId", s(&id(&format!("resource-{label}")))),
        ("kind", s("keeper")),
        ("locatorDigest", s(&sha256_hex(format!("locator-{label}").as_bytes()))),
    ])]);
    canon::canonical_text(&obj(vec![("version", Value::Int(1)), ("resources", resources)])).unwrap()
}

fn digest_of_text(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

struct Helper<L: KeeperLauncher> {
    state: HelperState,
    service: TargetService<L>,
    clock: SystemClock,
    events: Vec<String>,
}

fn journal(dir: &std::path::Path) -> Journal {
    Journal::create_with_identity_for_tests(dir, STORE).unwrap();
    Journal::open(dir, STORE, INCARNATION, JournalLimits::default(), Duration::from_millis(1000)).unwrap()
}

fn helper<L: KeeperLauncher>(service: TargetService<L>) -> Helper<L> {
    let key = TicketKey { kid: KID.into(), secret: Secret::new(SECRET.to_vec()) };
    Helper { state: HelperState::new(key, INCARNATION, STORE), service, clock: SystemClock::new(), events: Vec::new() }
}

/// One connection: the worker closure runs in a thread against the helper's `serve_session` on this thread.
fn session<L: KeeperLauncher, T: Send + 'static>(helper: &mut Helper<L>, worker: impl FnOnce(Connection) -> T + Send + 'static) -> (SessionEnd, T) {
    let (target, worker_side) = Connection::pair().unwrap();
    let handle = std::thread::spawn(move || worker(worker_side));
    let events = &mut helper.events;
    let end = peer::serve_session(&target, &mut helper.state, &mut helper.service, &helper.clock, &mut |name, fields| {
        let mut fields = fields;
        fields.insert(0, ("event", s(name)));
        events.push(canon::canonical_text(&obj(fields)).unwrap());
    });
    drop(target);
    (end, handle.join().unwrap())
}

type Steps = Vec<(&'static str, String)>;

/// A worker that bootstraps with `mint` and sends `steps`, returning each reply's kind and body (or the error code).
fn run(mint: Mint, lease: String, steps: Steps) -> impl FnOnce(Connection) -> Result<Vec<(String, Value)>, String> + Send + 'static {
    let mint = mint.lease(&lease);
    move |connection| {
        let challenge: ChallengeMessage = peer::read_challenge(&connection).map_err(|code| code.as_str().to_string())?;
        let (ticket, key) = mint.ticket(&challenge.helper_nonce);
        let mut session = WorkerSession::bootstrap(connection, &challenge, &ticket, key).map_err(|error| error.code())?;
        let mut replies = Vec::new();
        for (kind, body) in steps {
            let reply = session.request(kind, body.as_bytes()).map_err(|error| error.code())?;
            let value = canon::parse_canonical(&reply.body, canon::RECEIPT_BYTES).unwrap();
            replies.push((reply.message_kind, value));
        }
        Ok(replies)
    }
}

fn lookup_body() -> String {
    r#"{"version":1}"#.to_string()
}

#[test]
fn pre_g1_prepare_refuses_keeper_unavailable_before_any_journal_write_and_lookup_proves_absence() {
    let dir = common::temp_dir("session-g1");
    let mut helper = helper(TargetService::new(journal(&dir), UnavailableUntilG1));
    let body = prepare_body("a");
    let revision = helper.service.journal().revision();
    let mint = Mint::new(&binding(INCARNATION, STORE), "op-a", &digest_of_text(&body));
    let (end, replies) = session(&mut helper, run(mint, id("lease"), vec![("lookup", lookup_body()), ("prepare", body), ("lookup", lookup_body())]));
    assert_eq!(end, SessionEnd::Closed { frames: 3 });
    let replies = replies.unwrap();
    assert_eq!(replies[0].0, "lookup-result");
    assert_eq!(replies[0].1.str_at("state"), Some("absent-with-proof"));
    assert_eq!(replies[1].0, "failure");
    assert_eq!(replies[1].1.str_at("code"), Some("keeper_unavailable"));
    assert_eq!(replies[2].1, replies[0].1, "the refused prepare wrote nothing: same journal revision and absence evidence");
    assert_eq!(helper.service.journal().revision(), revision);
}

#[test]
fn the_handshake_refuses_another_incarnation_another_store_a_wrong_key_or_kid_and_an_epoch_conflict() {
    let dir = common::temp_dir("session-refusals");
    let mut helper = helper(TargetService::new(journal(&dir), UnavailableUntilG1));
    let body = prepare_body("r");
    let digest = digest_of_text(&body);
    let lease = id("lease-r");
    let refused = |result: Result<Vec<(String, Value)>, String>| result.err().unwrap_or_default();
    // The worker itself never presents a ticket minted for another incarnation than the challenger's: nothing is sent.
    let (end, result) = session(&mut helper, run(Mint::new(&binding(&id("other-incarnation"), STORE), "op-r", &digest), lease.clone(), vec![]));
    assert_eq!(end, SessionEnd::HandshakeLost("closed"));
    assert_eq!(refused(result), "ticket_binding");
    // Forced past that check, the helper refuses a binding for another helper incarnation (a replaced target) ...
    let other = Mint::new(&binding(&id("other-incarnation"), STORE), "op-r", &digest).lease(&lease);
    let (end, result) = session(&mut helper, move |connection: Connection| {
        let challenge = peer::read_challenge(&connection).unwrap();
        let forced = ChallengeMessage { helper_incarnation: id("other-incarnation"), ..challenge.clone() };
        let (ticket, key) = other.ticket(&challenge.helper_nonce);
        WorkerSession::bootstrap(connection, &forced, &ticket, key).err()
    });
    assert_eq!(end, SessionEnd::Refused(Code::TicketBinding));
    assert_eq!(result, Some(WorkerError::Refused("ticket_binding".into())));
    // ... and a binding for another journal store.
    let other_store = Mint::new(&binding(INCARNATION, &id("other-store")), "op-r", &digest);
    let (end, result) = session(&mut helper, run(other_store, lease.clone(), vec![]));
    assert_eq!((end, refused(result)), (SessionEnd::Refused(Code::TicketBinding), "ticket_binding".to_string()));
    // Signed with another key: the signature fails before any claim is trusted.
    let mut wrong_key = Mint::new(&binding(INCARNATION, STORE), "op-r", &digest);
    wrong_key.secret = vec![0x11; 32];
    let (end, result) = session(&mut helper, run(wrong_key, lease.clone(), vec![]));
    assert_eq!((end, refused(result)), (SessionEnd::Refused(Code::TicketSignature), "ticket_signature".to_string()));
    let mut wrong_kid = Mint::new(&binding(INCARNATION, STORE), "op-r", &digest);
    wrong_kid.kid = "another-kid".into();
    let (end, _) = session(&mut helper, run(wrong_kid, lease.clone(), vec![]));
    assert_eq!(end, SessionEnd::Refused(Code::TicketSignature));
    // A previous epoch that is not below the new one is a conflict (A11.2).
    let (end, _) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-r", &digest).epoch("2", Some("2")), lease.clone(), vec![]));
    assert_eq!(end, SessionEnd::Refused(Code::ChannelEpochConflict));
    // Expired (iat 31 s ago, exp 1 s ago).
    let mut expired = Mint::new(&binding(INCARNATION, STORE), "op-r", &digest);
    expired.iat_offset = -31;
    let (end, _) = session(&mut helper, run(expired, lease.clone(), vec![]));
    assert_eq!(end, SessionEnd::Refused(Code::TicketLifetime));
    // A11.2: first use may start at any epoch; then only strictly greater epochs open the lease (equal or older refuse,
    // skipped epochs are fine).
    let (end, _) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-r", &digest).epoch("2", Some("1")), lease.clone(), vec![("lookup", lookup_body())]));
    assert_eq!(end, SessionEnd::Closed { frames: 1 });
    for (epoch, label) in [("2", "equal"), ("1", "older")] {
        let (end, _) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-r", &digest).epoch(epoch, None), lease.clone(), vec![]));
        assert_eq!(end, SessionEnd::Refused(Code::ChannelEpochConflict), "{label}");
    }
    let (end, _) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-r", &digest).epoch("5", Some("2")), lease.clone(), vec![("lookup", lookup_body())]));
    assert_eq!(end, SessionEnd::Closed { frames: 1 });
    // A11.1: epochs are per verified lease claim; another lease has its own (first-use) epoch.
    let (end, _) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-r", &digest), id("lease-other"), vec![("lookup", lookup_body())]));
    assert_eq!(end, SessionEnd::Closed { frames: 1 });
    assert_eq!(helper.state.epochs.get(&lease).map(|held| held.epoch.as_str()), Some("5"));
    assert_eq!(helper.state.epochs.get(&id("lease-other")).map(|held| held.epoch.as_str()), Some("1"));
}

#[test]
fn a_lost_accepted_costs_one_epoch_and_the_next_attempt_recovers() {
    let dir = common::temp_dir("session-lost-accepted");
    let mut helper = helper(TargetService::new(journal(&dir), UnavailableUntilG1));
    let lease = id("lease-la");
    let digest = digest_of_text(&prepare_body("la"));
    // The worker records attempt 1 before sending the bootstrap, then loses the answer.
    let mint = Mint::new(&binding(INCARNATION, STORE), "op-la", &digest).lease(&lease);
    let (end, dropped) = session(&mut helper, move |connection: Connection| {
        let challenge = peer::read_challenge(&connection).unwrap();
        let (ticket, key) = mint.ticket(&challenge.helper_nonce);
        WorkerSession::bootstrap_and_drop(connection, &challenge, &ticket, key).is_ok()
    });
    assert!(dropped);
    // Whether or not `accepted` reached the closed socket, the helper holds at most epoch 1 ...
    match &end {
        SessionEnd::HandshakeLost(_) => assert!(helper.state.epochs.get(&lease).is_none(), "not recorded when `accepted` was not sent"),
        SessionEnd::Closed { frames: 0 } => assert_eq!(helper.state.epochs.get(&lease).map(|held| held.epoch.as_str()), Some("1")),
        other => panic!("{other:?}"),
    }
    // ... and the worker's next attempt, max(attempt 1, accepted none) + 1 = 2, recovers with a lookup.
    let (end, replies) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-la", &digest).epoch("2", None), lease.clone(), vec![("lookup", lookup_body())]));
    assert_eq!(end, SessionEnd::Closed { frames: 1 });
    assert_eq!(replies.unwrap()[0].1.str_at("state"), Some("absent-with-proof"));
}

#[test]
fn the_epoch_map_is_capped_and_prunes_only_leases_idle_past_an_execution_lifetime() {
    let dir = common::temp_dir("session-cap");
    let mut helper = helper(TargetService::new(journal(&dir), UnavailableUntilG1));
    let now = rw_target_helper::peer::Clock::now_ms(&helper.clock);
    for index in 0..peer::EPOCH_LEASES {
        helper.state.epochs.insert(format!("lease-{index}"), peer::LeaseEpoch { epoch: "1".into(), accepted_ms: now });
    }
    let digest = digest_of_text(&prepare_body("cap"));
    let (end, _) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-cap", &digest), id("lease-new"), vec![]));
    assert_eq!(end, SessionEnd::Refused(Code::CapacityExceeded), "a full map of live leases refuses a new lease");
    // A known lease still reattaches when the map is full.
    helper.state.epochs.remove("lease-0");
    helper.state.epochs.insert(id("lease-known"), peer::LeaseEpoch { epoch: "3".into(), accepted_ms: now });
    let (end, _) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-cap", &digest).epoch("4", Some("3")), id("lease-known"), vec![("lookup", lookup_body())]));
    assert_eq!(end, SessionEnd::Closed { frames: 1 });
    // Leases idle past an execution lifetime are pruned to make room.
    helper.state.epochs.insert("lease-1".into(), peer::LeaseEpoch { epoch: "1".into(), accepted_ms: now - peer::EPOCH_IDLE_PRUNE_MS - 1 });
    let (end, _) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-cap", &digest), id("lease-new"), vec![("lookup", lookup_body())]));
    assert_eq!(end, SessionEnd::Closed { frames: 1 });
    assert!(!helper.state.epochs.contains_key("lease-1"));
    assert_eq!(helper.state.epochs.len(), peer::EPOCH_LEASES);
}

#[test]
fn a_wrong_session_key_fails_the_possession_proof_and_a_tampered_frame_closes_without_reply() {
    let dir = common::temp_dir("session-proof");
    let mut helper = helper(TargetService::new(journal(&dir), UnavailableUntilG1));
    let body = prepare_body("p");
    let digest = digest_of_text(&body);
    let mint = Mint::new(&binding(INCARNATION, STORE), "op-p", &digest).lease(&id("lease-p"));
    let (end, result) = session(&mut helper, move |connection| {
        let challenge = peer::read_challenge(&connection).unwrap();
        let (ticket, _) = mint.ticket(&challenge.helper_nonce);
        WorkerSession::bootstrap(connection, &challenge, &ticket, [9u8; 32]).err()
    });
    assert_eq!(end, SessionEnd::Refused(Code::FrameAuthentication));
    assert_eq!(result, Some(WorkerError::Refused("frame_authentication".into())));
    // A frame whose MAC does not verify: the helper closes the connection and sends nothing.
    let lease = id("lease-p2");
    let mint = Mint::new(&binding(INCARNATION, STORE), "op-p", &digest).lease(&lease);
    let (end, closed) = session(&mut helper, move |connection| {
        let challenge = peer::read_challenge(&connection).unwrap();
        let (ticket, key) = mint.ticket(&challenge.helper_nonce);
        let claims = session::unverified_claims(&ticket).unwrap();
        let worker = connection;
        // Bootstrap by hand so the raw connection stays available for the tampered frame.
        let proof = session::possession_proof(&key, session::WORKER_TO_TARGET, &claims.0, &challenge.helper_nonce, &challenge.challenge_id, &challenge.helper_incarnation, &lease);
        let message = session::BootstrapMessage { ticket: ticket.clone(), proof: b64url_encode(&proof) };
        worker.send_frame(&session::encode_message(&message.to_value()).unwrap(), &[]).unwrap();
        let accepted = worker.recv_frame(Default::default()).unwrap();
        assert!(String::from_utf8_lossy(&accepted.bytes[4..]).contains(r#""kind":"accepted""#));
        let binding = claims.1.get("binding").cloned().unwrap();
        let ids = rw_target_helper::frame::ExpectedIds {
            lease_id: lease,
            reservation_id: claims.1.str_at("reservationId").unwrap().into(),
            operation_id: claims.1.str_at("operationId").unwrap().into(),
            request_digest: claims.1.str_at("requestDigest").unwrap().into(),
        };
        let header = peer::frame_header(&binding, &ids, "1", 1, session::WORKER_TO_TARGET, "lookup").unwrap();
        let mut frame = rw_target_helper::frame::encode_frame(&header, br#"{"version":1}"#, &key, &claims.0, Default::default()).unwrap();
        let last = frame.len() - 1;
        frame[last] ^= 1;
        worker.send_frame(&frame, &[]).unwrap();
        matches!(worker.recv_frame(Default::default()), Err(rw_target_helper::mailbox::RecvError::Closed))
    });
    assert_eq!(end, SessionEnd::FrameRefused(Code::FrameAuthentication));
    assert!(closed, "no reply to an unauthenticated frame");
}

#[test]
fn a_prepare_body_that_is_not_the_ticketed_request_and_a_missing_permission_refuse_with_authenticated_failures() {
    let dir = common::temp_dir("session-body");
    let mut helper = helper(TargetService::new(journal(&dir), UnavailableUntilG1));
    let ticketed = prepare_body("t");
    let mut mint = Mint::new(&binding(INCARNATION, STORE), "op-t", &digest_of_text(&ticketed));
    mint.permissions = vec!["lookup", "prepare"];
    let (end, replies) = session(&mut helper, run(mint, id("lease-t"), vec![("prepare", prepare_body("other")), ("commit", r#"{"preparedReceiptSequence":2,"preparedResourcesDigest":"00","version":1,"workerCommitDigest":"00"}"#.into())]));
    assert_eq!(end, SessionEnd::Closed { frames: 2 });
    let replies = replies.unwrap();
    assert_eq!((replies[0].0.as_str(), replies[0].1.str_at("code")), ("failure", Some("frame_binding")));
    assert_eq!((replies[1].0.as_str(), replies[1].1.str_at("code")), ("failure", Some("ticket_binding")), "commit is not in the ticket permissions");
}

#[test]
fn a_retired_lease_is_never_reopened_and_stop_release_need_their_permissions() {
    let dir = common::temp_dir("session-p8-lease");
    let mut helper = helper(TargetService::new(journal(&dir), UnavailableUntilG1));
    let digest = digest_of_text(&prepare_body("l"));
    let lease = id("lease-retired");
    // An accepted handshake renews the lease: its deadline is one lease TTL ahead on the monotonic clock.
    let (end, _) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-l", &digest), lease.clone(), vec![("lookup", lookup_body())]));
    assert_eq!(end, SessionEnd::Closed { frames: 1 });
    let held = helper.state.leases.get(&lease).cloned().unwrap();
    assert!(!held.retired && held.deadline_mono_ms >= peer::LEASE_TTL_MS);
    // Expired: no ticket reopens it, whatever its epoch.
    helper.state.leases.get_mut(&lease).unwrap().retired = true;
    let (end, result) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-l", &digest).epoch("9", Some("1")), lease.clone(), vec![]));
    assert_eq!(end, SessionEnd::Refused(Code::LeaseRetired));
    assert_eq!(result.err(), Some("lease_retired".to_string()));
    // stop and release are served only with their permissions (the default mint lists commit, lookup and prepare).
    let (_, replies) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-l", &digest), id("lease-other"), vec![("stop", lookup_body()), ("release", r#"{"evidence":{"resources":[]},"version":1}"#.into())]));
    let replies = replies.unwrap();
    assert_eq!((replies[0].0.as_str(), replies[0].1.str_at("code")), ("failure", Some("ticket_binding")));
    assert_eq!((replies[1].0.as_str(), replies[1].1.str_at("code")), ("failure", Some("ticket_binding")));
    // With them, the refusing launcher answers before the journal.
    let mut mint = Mint::new(&binding(INCARNATION, STORE), "op-l", &digest);
    mint.permissions = vec!["release", "stop"];
    let (_, replies) = session(&mut helper, run(mint, id("lease-third"), vec![("stop", lookup_body())]));
    assert_eq!(replies.unwrap()[0].1.str_at("code"), Some("keeper_unavailable"));
}

#[test]
fn a_prepare_body_may_carry_a_workload_and_nothing_else() {
    let dir = common::temp_dir("session-p8-body");
    let mut helper = helper(TargetService::new(journal(&dir), UnavailableUntilG1));
    let with_workload = r#"{"resources":[],"version":1,"workload":{"args":[],"executable":"sh"}}"#.to_string();
    let with_extra = r#"{"extra":1,"resources":[],"version":1}"#.to_string();
    let (_, replies) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-w", &digest_of_text(&with_workload)), id("lease-w"), vec![("prepare", with_workload)]));
    assert_eq!(replies.unwrap()[0].1.str_at("code"), Some("keeper_unavailable"), "the body shape is accepted; the launcher refuses");
    let (_, replies) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-x", &digest_of_text(&with_extra)), id("lease-x"), vec![("prepare", with_extra)]));
    assert_eq!(replies.unwrap()[0].1.str_at("code"), Some("invalid_request"));
}

#[cfg(feature = "proof-fixture")]
mod proof_fixture {
    use super::*;

    fn fixture_helper(dir: &std::path::Path) -> Helper<rw_target_helper::keeper::ProofFixtureNoKeeper> {
        helper(TargetService::proof_fixture(journal(dir)))
    }

    fn commit_body(receipt: &Value) -> String {
        let resources = receipt.get("resources").cloned().unwrap();
        canon::canonical_text(&obj(vec![
            ("version", Value::Int(1)),
            ("workerCommitDigest", s(&sha256_hex(b"worker-commit"))),
            ("preparedReceiptSequence", receipt.get("receiptSequence").cloned().unwrap()),
            ("preparedResourcesDigest", s(&canon::digest(&resources, 1 << 20).unwrap())),
        ]))
        .unwrap()
    }

    #[test]
    fn prepare_commit_lookup_round_trip_with_the_fixture_launcher() {
        let dir = common::temp_dir("session-round-trip");
        let mut helper = fixture_helper(&dir);
        let body = prepare_body("rt");
        let digest = digest_of_text(&body);
        let lease = id("lease-rt");
        let (end, replies) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-rt", &digest), lease.clone(), vec![("prepare", body.clone())]));
        assert_eq!(end, SessionEnd::Closed { frames: 1 });
        let prepared = replies.unwrap().remove(0);
        assert_eq!(prepared.0, "prepared");
        assert_eq!(prepared.1.str_at("state"), Some("prepared"));
        assert_eq!(prepared.1.get("gateReleased"), Some(&Value::Bool(false)));
        assert_eq!(prepared.1.str_at("helperIncarnation"), Some(INCARNATION));
        let commit = commit_body(&prepared.1);
        let mint = Mint::new(&binding(INCARNATION, STORE), "op-rt", &digest).epoch("2", Some("1"));
        let (end, replies) = session(&mut helper, run(mint, lease.clone(), vec![("commit", commit.clone()), ("lookup", lookup_body()), ("commit", commit)]));
        assert_eq!(end, SessionEnd::Closed { frames: 3 });
        let replies = replies.unwrap();
        assert_eq!((replies[0].0.as_str(), replies[0].1.str_at("state")), ("receipt", Some("running")));
        assert_eq!(replies[0].1.get("gateReleased"), Some(&Value::Bool(true)));
        assert_eq!(replies[1].0, "lookup-result");
        assert_eq!(replies[1].1.str_at("state"), Some("running"));
        assert_eq!(replies[2].1.get("receiptSequence"), replies[0].1.get("receiptSequence"), "a repeated commit replays the recorded release intent");
    }

    #[test]
    fn a_dropped_prepare_reply_resolves_by_same_operation_lookup_and_a_conflicting_payload_refuses() {
        let dir = common::temp_dir("session-lost-reply");
        let mut helper = fixture_helper(&dir);
        let body = prepare_body("lost");
        let digest = digest_of_text(&body);
        let lease = id("lease-lost");
        let mint = Mint::new(&binding(INCARNATION, STORE), "op-lost", &digest).lease(&lease);
        let body_for_drop = body.clone();
        let (end, dropped) = session(&mut helper, move |connection| {
            let challenge = peer::read_challenge(&connection).unwrap();
            let (ticket, key) = mint.ticket(&challenge.helper_nonce);
            let session = WorkerSession::bootstrap(connection, &challenge, &ticket, key).unwrap();
            session.send_and_drop("prepare", body_for_drop.as_bytes()).is_ok()
        });
        assert!(dropped);
        // The helper performed the prepare durably and lost only the reply.
        assert!(matches!(end, SessionEnd::ReplyLost { frames: 1 } | SessionEnd::Closed { frames: 1 }), "{end:?}");
        let revision = helper.service.journal().revision();
        let mint = Mint::new(&binding(INCARNATION, STORE), "op-lost", &digest).epoch("2", Some("1"));
        let (_, replies) = session(&mut helper, run(mint, lease.clone(), vec![("lookup", lookup_body())]));
        let lookup = replies.unwrap().remove(0);
        assert_eq!(lookup.1.str_at("state"), Some("prepared"));
        assert_eq!(lookup.1.get("receipt").and_then(|receipt| receipt.str_at("requestDigest")), Some(digest.as_str()));
        // Same operation, another payload (so another request digest and its own ticket): the journal refuses it.
        let conflicting = prepare_body("conflicting");
        let mint = Mint::new(&binding(INCARNATION, STORE), "op-lost", &digest_of_text(&conflicting)).epoch("3", Some("2"));
        let (_, replies) = session(&mut helper, run(mint, lease.clone(), vec![("prepare", conflicting)]));
        let refused = replies.unwrap().remove(0);
        assert_eq!((refused.0.as_str(), refused.1.str_at("code")), ("failure", Some("operation_conflict")));
        assert_eq!(helper.service.journal().revision(), revision, "the conflicting payload changed nothing");
    }

    #[test]
    fn stop_and_release_frames_settle_the_record_and_only_the_preparing_lease_commits() {
        let dir = common::temp_dir("session-p8-stop");
        let mut helper = fixture_helper(&dir);
        let body = prepare_body("st");
        let digest = digest_of_text(&body);
        let lease = id("lease-st");
        let (_, replies) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-st", &digest), lease.clone(), vec![("prepare", body)]));
        let prepared = replies.unwrap().remove(0).1;
        // Another lease of the same binding cannot release the gate.
        let mint = Mint::new(&binding(INCARNATION, STORE), "op-st", &digest);
        let (_, replies) = session(&mut helper, run(mint, id("lease-intruder"), vec![("commit", commit_body(&prepared))]));
        assert_eq!(replies.unwrap()[0].1.str_at("code"), Some("binding_mismatch"));
        let mut mint = Mint::new(&binding(INCARNATION, STORE), "op-st", &digest).epoch("2", Some("1"));
        mint.permissions = vec!["commit", "lookup", "release", "stop"];
        let resources = prepared.get("resources").and_then(Value::arr).unwrap().to_vec();
        let evidence = Value::Arr(resources.iter().map(|resource| obj(vec![("resourceId", resource.get("resourceId").cloned().unwrap()), ("kind", s("verified-absent")), ("evidenceDigest", s(&sha256_hex(b"absent")))])).collect());
        let release = canon::canonical_text(&obj(vec![("version", Value::Int(1)), ("evidence", obj(vec![("resources", evidence)]))])).unwrap();
        let (end, replies) = session(&mut helper, run(mint, lease.clone(), vec![("commit", commit_body(&prepared)), ("stop", lookup_body()), ("stop", lookup_body()), ("release", release)]));
        assert_eq!(end, SessionEnd::Closed { frames: 4 });
        let replies = replies.unwrap();
        assert_eq!(replies[0].1.str_at("state"), Some("running"));
        assert_eq!((replies[1].0.as_str(), replies[1].1.str_at("state")), ("receipt", Some("exited")), "stop answers the exited receipt");
        assert_eq!(replies[2].1.get("receiptSequence"), replies[1].1.get("receiptSequence"), "a repeated stop changes nothing");
        assert_eq!(replies[3].1.str_at("state"), Some("exited"));
        assert!(replies[3].1.get("resources").and_then(Value::arr).unwrap().iter().all(|resource| resource.str_at("state") == Some("released")));
    }

    #[test]
    fn a_replaced_target_refuses_the_old_binding_and_the_journal_record_survives_unreleased() {
        let dir = common::temp_dir("session-replaced");
        let mut helper = fixture_helper(&dir);
        let body = prepare_body("replaced");
        let digest = digest_of_text(&body);
        let lease = id("lease-replaced");
        let (_, replies) = session(&mut helper, run(Mint::new(&binding(INCARNATION, STORE), "op-replaced", &digest), lease.clone(), vec![("prepare", body)]));
        assert_eq!(replies.unwrap().remove(0).1.str_at("state"), Some("prepared"));
        drop(helper);
        // The replacement: the same journal store under a new helper incarnation.
        let replacement = id("replacement-incarnation");
        let journal = Journal::open(&dir, STORE, &replacement, JournalLimits::default(), Duration::from_millis(1000)).unwrap();
        let key = TicketKey { kid: KID.into(), secret: Secret::new(SECRET.to_vec()) };
        let mut helper = Helper { state: HelperState::new(key, &replacement, STORE), service: TargetService::proof_fixture(journal), clock: SystemClock::new(), events: Vec::new() };
        // The worker's admitted binding names the old incarnation: its commit ticket is refused before any frame.
        let mint = Mint::new(&binding(INCARNATION, STORE), "op-replaced", &digest).lease(&lease).epoch("2", Some("1"));
        let worker = move |connection: Connection| {
            let challenge = peer::read_challenge(&connection).unwrap();
            // A forced attempt: the challenger's incarnation is substituted so the worker-side check passes.
            let forced = ChallengeMessage { helper_incarnation: INCARNATION.into(), ..challenge.clone() };
            let (ticket, key) = mint.ticket(&challenge.helper_nonce);
            WorkerSession::bootstrap(connection, &forced, &ticket, key).err()
        };
        let (end, error) = session(&mut helper, worker);
        assert_eq!(end, SessionEnd::Refused(Code::TicketBinding));
        assert_eq!(error, Some(WorkerError::Refused("ticket_binding".into())));
        // Under a binding for the replacement, the record is still there, prepared and with the gate unreleased.
        let (_, replies) = session(&mut helper, run(Mint::new(&binding(&replacement, STORE), "op-replaced", &digest), id("lease-inspect"), vec![("lookup", lookup_body())]));
        let lookup = replies.unwrap().remove(0).1;
        assert_eq!(lookup.str_at("state"), Some("prepared"));
        let receipt = lookup.get("receipt").unwrap();
        assert_eq!(receipt.get("gateReleased"), Some(&Value::Bool(false)));
        assert_eq!(receipt.str_at("helperIncarnation"), Some(INCARNATION), "the record keeps the incarnation that prepared it");
        assert_ne!(receipt.str_at("targetBindingDigest"), Some(canon::digest_of(&binding(&replacement, STORE)).unwrap().as_str()));
    }
}
