//! Slice P6b: the binary roles. `serve` verifies tickets with the per-helper-incarnation secret it consumed from
//! `--secret-file` (kid `hti1.<incarnation>`) in every build; a `proof-fixture` build with `--proof-fixture-session`
//! uses the public fixture ticket key instead. A default build has no proof-fixture switch at all. `worker-peer
//! --session` drives one session over stdin/stdout (the session key only on stdin).
#![cfg(target_os = "linux")]

mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

use rw_target_helper::canon::{self, Value, obj, s};
use rw_target_helper::contract::target_identity_digest;
use rw_target_helper::crypto::{b64url_encode, sha256_hex};
use rw_target_helper::session;
use rw_target_helper::ticket::sign_ticket_for_tests;

const INCARNATION: &str = "BQUFBQUFBQUFBQUFBQUFBQ";

#[cfg(not(feature = "proof-fixture"))]
#[test]
fn a_default_build_refuses_every_proof_fixture_switch() {
    let binary = env!("CARGO_BIN_EXE_rw-target-helper");
    for switch in ["--proof-fixture-session", "--proof-fixture-keeper"] {
        let output = Command::new(binary)
            .args(["serve", "--mailbox", "/nonexistent/m.sock", "--journal-root", "/nonexistent", "--store-identity", "AwMDAwMDAwMDAwMDAwMDAw", "--helper-incarnation", "AgICAgICAgICAgICAgICAg", "--secret-file", "/nonexistent/s", switch])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(64), "{switch}");
    }
}

#[test]
fn serve_requires_a_secret_file_and_other_roles_refuse_one() {
    let binary = env!("CARGO_BIN_EXE_rw-target-helper");
    let without = Command::new(binary).args(["serve", "--mailbox", "/nonexistent/m.sock", "--journal-root", "/nonexistent", "--store-identity", "AwMDAwMDAwMDAwMDAwMDAw", "--helper-incarnation", "AgICAgICAgICAgICAgICAg"]).output().unwrap();
    assert_eq!(without.status.code(), Some(64));
    let journal = Command::new(binary).args(["journal-init", "--root", "/nonexistent", "--secret-file", "/nonexistent/s"]).output().unwrap();
    assert_eq!(journal.status.code(), Some(64));
    let peer = Command::new(binary).args(["worker-peer", "--mailbox", "/nonexistent/m.sock", "--probe", "--secret-file", "/nonexistent/s"]).output().unwrap();
    assert_eq!(peer.status.code(), Some(64));
}

/// Which ticket key a `serve` process is started with.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// The consumed per-incarnation secret file.
    Secret,
    /// `--proof-fixture-session` (proof-fixture build only).
    #[cfg_attr(not(feature = "proof-fixture"), allow(dead_code))]
    Fixture { keeper: bool },
}

struct Served {
    child: std::process::Child,
    mailbox: std::path::PathBuf,
    store: String,
    secret: [u8; 32],
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn serve(label: &str, mode: Mode) -> Served {
    let binary = env!("CARGO_BIN_EXE_rw-target-helper");
    let dir = common::temp_dir(label);
    let root = dir.join("journal-root");
    std::fs::create_dir(&root).unwrap();
    let init = Command::new(binary).args(["journal-init", "--root", &root.display().to_string()]).output().unwrap();
    let parsed = canon::parse_canonical(String::from_utf8(init.stdout).unwrap().trim().as_bytes(), 4096).unwrap();
    let store = parsed.get("value").unwrap().str_at("journalStoreIdentity").unwrap().to_string();
    let mailbox = dir.join("m.sock");
    let secret: [u8; 32] = sha256_hex(label.as_bytes()).as_bytes()[..32].try_into().unwrap();
    let secret_file = dir.join("helper-secret");
    std::fs::write(&secret_file, format!("version=1\nhelperIncarnation={INCARNATION}\nkid=hti1.{INCARNATION}\nsecret={}\n", b64url_encode(&secret))).unwrap();
    std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut args = vec!["serve".to_string(), "--mailbox".into(), mailbox.display().to_string(), "--journal-root".into(), root.display().to_string(), "--store-identity".into(), store.clone(), "--helper-incarnation".into(), INCARNATION.into(), "--secret-file".into(), secret_file.display().to_string()];
    let (session_label, launcher) = match mode {
        Mode::Secret => ("helper-ticket-secret", "unavailable-until-g1"),
        Mode::Fixture { keeper } => {
            args.push("--proof-fixture-session".into());
            if keeper {
                args.push("--proof-fixture-keeper".into());
            }
            ("proof-fixture", if keeper { "proof-fixture-no-keeper" } else { "unavailable-until-g1" })
        }
    };
    let mut child = Command::new(binary).args(&args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), format!(r#"{{"ok":true,"value":{{"helperIncarnation":"{INCARNATION}","journalStoreIdentity":"{store}","keeperLauncher":"{launcher}","session":"{session_label}","state":"ready"}}}}"#));
    assert!(!secret_file.exists(), "the secret file is consumed before ready");
    Served { child, mailbox, store, secret }
}

fn binding(store: &str) -> Value {
    let vectors = common::load(&common::crate_dir().join("tests/vectors/transport-v1.json"));
    let mut binding = vectors.get("ticket").and_then(|ticket| ticket.get("claims")).and_then(|claims| claims.get("binding")).cloned().unwrap();
    let mut scope = binding.get("scope").cloned().unwrap();
    scope.set("helperIncarnation", s(INCARNATION));
    binding.set("scope", scope);
    binding.set("journalStoreIdentity", s(store));
    binding
}

/// The ticket key under which a test mints.
struct Signer<'a> {
    kid: &'a str,
    secret: &'a [u8],
}

fn mint(signer: &Signer, binding: &Value, helper_nonce: &str, request_digest: &str) -> (String, [u8; 32]) {
    let iat = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let scope = binding.get("scope").unwrap();
    let claims = obj(vec![
        ("version", Value::Int(1)),
        ("iss", s("ploinky-router")),
        ("sub", scope.get("workerPrincipal").cloned().unwrap()),
        ("purpose", s("ploinky.target-helper.v1")),
        ("aud", s(&format!("ploinky:target-helper:{}", target_identity_digest(scope).unwrap()))),
        ("binding", binding.clone()),
        ("reservationId", s("BwcHBwcHBwcHBwcHBwcHBw")),
        ("leaseId", s("CQkJCQkJCQkJCQkJCQkJCQ")),
        ("operationId", s("CAgICAgICAgICAgICAgICA")),
        ("requestDigest", s(request_digest)),
        ("helperNonce", s(helper_nonce)),
        ("jti", s(&session::random_nonce().unwrap())),
        ("iat", Value::Int(iat)),
        ("exp", Value::Int(iat + 30)),
        ("channelEpoch", s("1")),
        ("previousChannelEpoch", Value::Null),
        ("permissions", Value::Arr(vec![s("commit"), s("lookup"), s("prepare")])),
        ("limitsDigest", binding.get("limitsDigest").cloned().unwrap()),
    ]);
    let text = canon::canonical_text(&claims).unwrap();
    let header = format!(r#"{{"alg":"HS256","kid":"{}","typ":"ploinky-target-helper+jwt"}}"#, signer.kid);
    (sign_ticket_for_tests(signer.secret, &header, &text), session::session_key(signer.secret, text.as_bytes()))
}

struct Peer {
    child: std::process::Child,
    lines: std::io::Lines<BufReader<std::process::ChildStdout>>,
}

impl Peer {
    fn start(mailbox: &std::path::Path) -> Peer {
        let binary = env!("CARGO_BIN_EXE_rw-target-helper");
        let mut child = Command::new(binary).args(["worker-peer", "--mailbox", &mailbox.display().to_string(), "--session"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        Peer { child, lines }
    }
    fn next(&mut self) -> Value {
        let line = self.lines.next().unwrap().unwrap();
        canon::parse_canonical(line.as_bytes(), 8 << 20).unwrap()
    }
    fn send(&mut self, value: &Value) {
        let text = canon::canonical(value, 8 << 20).unwrap();
        writeln!(self.child.stdin.as_mut().unwrap(), "{text}").unwrap();
    }
}

fn body() -> String {
    let resources = Value::Arr(vec![obj(vec![("resourceId", s("CgoKCgoKCgoKCgoKCgoKCg")), ("kind", s("keeper")), ("locatorDigest", s(&sha256_hex(b"locator")))])]);
    canon::canonical_text(&obj(vec![("version", Value::Int(1)), ("resources", resources)])).unwrap()
}

/// Runs the handshake with a ticket from `signer` and returns the helper's answer (`accepted` or `refused`).
fn bootstrap_with(peer: &mut Peer, signer: &Signer, store: &str, body: &str) -> Value {
    assert_eq!(peer.next().str_at("event"), Some("connected"));
    let challenge = peer.next();
    assert_eq!(challenge.str_at("event"), Some("challenge"));
    assert_eq!(challenge.str_at("helperIncarnation"), Some(INCARNATION));
    let (ticket, key) = mint(signer, &binding(store), challenge.str_at("helperNonce").unwrap(), &sha256_hex(body.as_bytes()));
    peer.send(&obj(vec![("op", s("bootstrap")), ("ticket", s(&ticket)), ("sessionKey", s(&b64url_encode(&key)))]));
    peer.next()
}

fn frame(peer: &mut Peer, kind: &str, body: &str) -> (String, Value) {
    peer.send(&obj(vec![("op", s("frame")), ("messageKind", s(kind)), ("body", s(body))]));
    let reply = peer.next();
    assert_eq!(reply.str_at("event"), Some("reply"), "{reply:?}");
    let parsed = canon::parse_canonical(reply.str_at("body").unwrap().as_bytes(), 1 << 20).unwrap();
    (reply.str_at("messageKind").unwrap().to_string(), parsed)
}

/// The public fixture key (the same bytes as `session::proof_fixture`, which a default build does not contain).
const FIXTURE_KID: &str = "proof-fixture-helper-ticket-v1";
const FIXTURE_SECRET_HEX: &str = "5055424c49432053594e5448455449432070726f6f662d666978747572652076";

#[test]
fn serve_verifies_tickets_with_the_consumed_incarnation_secret_and_refuses_any_other_key() {
    let served = serve("bin-secret", Mode::Secret);
    let kid = format!("hti1.{INCARNATION}");
    let body = body();
    // The incarnation secret: accepted; keeper launch still refuses before any journal write.
    let mut peer = Peer::start(&served.mailbox);
    let answer = bootstrap_with(&mut peer, &Signer { kid: &kid, secret: &served.secret }, &served.store, &body);
    assert_eq!(answer, obj(vec![("event", s("accepted"))]));
    let (kind, refused) = frame(&mut peer, "prepare", &body);
    assert_eq!((kind.as_str(), refused.str_at("code")), ("failure", Some("keeper_unavailable")));
    let (_, absent) = frame(&mut peer, "lookup", r#"{"version":1}"#);
    assert_eq!(absent.str_at("state"), Some("absent-with-proof"));
    peer.send(&obj(vec![("op", s("close"))]));
    assert!(peer.child.wait().unwrap().success());
    // The right kid with another secret, and the public fixture key: both refused, exit 2.
    let other = [0x22u8; 32];
    let fixture = common::unhex(FIXTURE_SECRET_HEX);
    for signer in [Signer { kid: &kid, secret: &other }, Signer { kid: FIXTURE_KID, secret: &fixture }] {
        let mut peer = Peer::start(&served.mailbox);
        let answer = bootstrap_with(&mut peer, &signer, &served.store, &body);
        assert_eq!(answer.str_at("event"), Some("refused"), "{answer:?}");
        assert!(matches!(answer.str_at("code"), Some("ticket_signature" | "ticket_format" | "ticket_algorithm")), "{answer:?}");
        assert_eq!(peer.child.wait().unwrap().code(), Some(2));
    }
}

#[cfg(feature = "proof-fixture")]
mod fixture {
    use super::*;

    fn fixture_signer_key() -> session::TicketKey {
        session::proof_fixture::ticket_key()
    }

    fn bootstrap(peer: &mut Peer, store: &str, body: &str) {
        let key = fixture_signer_key();
        let answer = bootstrap_with(peer, &Signer { kid: &key.kid, secret: key.secret.expose() }, store, body);
        assert_eq!(answer, obj(vec![("event", s("accepted"))]));
    }

    #[test]
    fn worker_peer_session_runs_prepare_commit_lookup_against_the_fixture_helper() {
        let served = serve("bin-session", Mode::Fixture { keeper: true });
        let body = body();
        let mut peer = Peer::start(&served.mailbox);
        bootstrap(&mut peer, &served.store, &body);
        let (kind, prepared) = frame(&mut peer, "prepare", &body);
        assert_eq!((kind.as_str(), prepared.str_at("state")), ("prepared", Some("prepared")));
        let resources = prepared.get("resources").cloned().unwrap();
        let commit = canon::canonical_text(&obj(vec![
            ("version", Value::Int(1)),
            ("workerCommitDigest", s(&sha256_hex(b"commit"))),
            ("preparedReceiptSequence", prepared.get("receiptSequence").cloned().unwrap()),
            ("preparedResourcesDigest", s(&canon::digest(&resources, 1 << 20).unwrap())),
        ]))
        .unwrap();
        let (kind, running) = frame(&mut peer, "commit", &commit);
        assert_eq!((kind.as_str(), running.str_at("state"), running.get("gateReleased")), ("receipt", Some("running"), Some(&Value::Bool(true))));
        let (kind, lookup) = frame(&mut peer, "lookup", r#"{"version":1}"#);
        assert_eq!((kind.as_str(), lookup.str_at("state")), ("lookup-result", Some("running")));
        peer.send(&obj(vec![("op", s("close"))]));
        assert!(peer.child.wait().unwrap().success());
    }

    #[test]
    fn without_the_fixture_keeper_prepare_refuses_keeper_unavailable_and_the_key_never_appears_in_argv() {
        let served = serve("bin-g1", Mode::Fixture { keeper: false });
        let body = body();
        let mut peer = Peer::start(&served.mailbox);
        bootstrap(&mut peer, &served.store, &body);
        let (kind, refused) = frame(&mut peer, "prepare", &body);
        assert_eq!((kind.as_str(), refused.str_at("code")), ("failure", Some("keeper_unavailable")));
        let (_, absent) = frame(&mut peer, "lookup", r#"{"version":1}"#);
        assert_eq!(absent.str_at("state"), Some("absent-with-proof"));
        assert_eq!(absent.str_at("journalRevision"), Some("0"), "nothing was written");
        let cmdline = std::fs::read(format!("/proc/{}/cmdline", peer.child.id())).unwrap();
        assert!(!String::from_utf8_lossy(&cmdline).contains("sessionKey"));
        drop(peer.child.stdin.take());
        assert!(peer.child.wait().unwrap().success());
    }

    #[test]
    fn with_the_fixture_session_the_consumed_secret_is_not_a_ticket_key() {
        let served = serve("bin-fixture-not-secret", Mode::Fixture { keeper: false });
        let kid = format!("hti1.{INCARNATION}");
        let mut peer = Peer::start(&served.mailbox);
        let answer = bootstrap_with(&mut peer, &Signer { kid: &kid, secret: &served.secret }, &served.store, &body());
        assert_eq!(answer.str_at("event"), Some("refused"), "{answer:?}");
        assert_eq!(peer.child.wait().unwrap().code(), Some(2));
    }

    #[test]
    fn the_fixture_constants_here_are_the_crate_fixture_key() {
        let key = fixture_signer_key();
        assert_eq!((key.kid.as_str(), key.secret.expose()), (FIXTURE_KID, common::unhex(FIXTURE_SECRET_HEX).as_slice()));
    }
}
