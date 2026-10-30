//! Slice P6b: the binary roles. A default build has no proof-fixture switch at all; a `proof-fixture` build serves the
//! PROPOSED handshake with the public fixture ticket key, and `worker-peer --session` drives one session over stdin/stdout
//! (the session key only on stdin).
#![cfg(target_os = "linux")]

mod common;

use std::process::Command;

#[cfg(not(feature = "proof-fixture"))]
#[test]
fn a_default_build_refuses_every_proof_fixture_switch() {
    let binary = env!("CARGO_BIN_EXE_rw-target-helper");
    for switch in ["--proof-fixture-session", "--proof-fixture-keeper"] {
        let output = Command::new(binary)
            .args(["serve", "--mailbox", "/nonexistent/m.sock", "--journal-root", "/nonexistent", "--store-identity", "AwMDAwMDAwMDAwMDAwMDAw", "--helper-incarnation", "AgICAgICAgICAgICAgICAg", switch])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(64), "{switch}");
    }
}

#[cfg(feature = "proof-fixture")]
mod fixture {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;
    use rw_target_helper::canon::{self, Value, obj, s};
    use rw_target_helper::contract::target_identity_digest;
    use rw_target_helper::crypto::{b64url_encode, sha256_hex};
    use rw_target_helper::session;
    use rw_target_helper::ticket::sign_ticket_for_tests;

    const INCARNATION: &str = "BQUFBQUFBQUFBQUFBQUFBQ";

    struct Served {
        child: std::process::Child,
        mailbox: std::path::PathBuf,
        store: String,
    }

    impl Drop for Served {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn serve(label: &str, keeper: bool) -> Served {
        let binary = env!("CARGO_BIN_EXE_rw-target-helper");
        let dir = common::temp_dir(label);
        let root = dir.join("journal-root");
        std::fs::create_dir(&root).unwrap();
        let init = Command::new(binary).args(["journal-init", "--root", &root.display().to_string()]).output().unwrap();
        let parsed = canon::parse_canonical(String::from_utf8(init.stdout).unwrap().trim().as_bytes(), 4096).unwrap();
        let store = parsed.get("value").unwrap().str_at("journalStoreIdentity").unwrap().to_string();
        let mailbox = dir.join("m.sock");
        let mut args = vec!["serve".to_string(), "--mailbox".into(), mailbox.display().to_string(), "--journal-root".into(), root.display().to_string(), "--store-identity".into(), store.clone(), "--helper-incarnation".into(), INCARNATION.into(), "--proof-fixture-session".into()];
        if keeper {
            args.push("--proof-fixture-keeper".into());
        }
        let mut child = Command::new(binary).args(&args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready).unwrap();
        let launcher = if keeper { "proof-fixture-no-keeper" } else { "unavailable-until-g1" };
        assert_eq!(ready.trim(), format!(r#"{{"ok":true,"value":{{"helperIncarnation":"{INCARNATION}","journalStoreIdentity":"{store}","keeperLauncher":"{launcher}","session":"proof-fixture","state":"ready"}}}}"#));
        Served { child, mailbox, store }
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

    fn mint(binding: &Value, helper_nonce: &str, request_digest: &str) -> (String, [u8; 32]) {
        let key = session::proof_fixture::ticket_key();
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
        let header = format!(r#"{{"alg":"HS256","kid":"{}","typ":"ploinky-target-helper+jwt"}}"#, key.kid);
        (sign_ticket_for_tests(key.secret.expose(), &header, &text), session::session_key(key.secret.expose(), text.as_bytes()))
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

    fn bootstrap(peer: &mut Peer, store: &str, body: &str) {
        assert_eq!(peer.next().str_at("event"), Some("connected"));
        let challenge = peer.next();
        assert_eq!(challenge.str_at("event"), Some("challenge"));
        assert_eq!(challenge.str_at("helperIncarnation"), Some(INCARNATION));
        let (ticket, key) = mint(&binding(store), challenge.str_at("helperNonce").unwrap(), &sha256_hex(body.as_bytes()));
        peer.send(&obj(vec![("op", s("bootstrap")), ("ticket", s(&ticket)), ("sessionKey", s(&b64url_encode(&key)))]));
        assert_eq!(peer.next(), obj(vec![("event", s("accepted"))]));
    }

    fn frame(peer: &mut Peer, kind: &str, body: &str) -> (String, Value) {
        peer.send(&obj(vec![("op", s("frame")), ("messageKind", s(kind)), ("body", s(body))]));
        let reply = peer.next();
        assert_eq!(reply.str_at("event"), Some("reply"), "{reply:?}");
        let parsed = canon::parse_canonical(reply.str_at("body").unwrap().as_bytes(), 1 << 20).unwrap();
        (reply.str_at("messageKind").unwrap().to_string(), parsed)
    }

    #[test]
    fn worker_peer_session_runs_prepare_commit_lookup_against_the_fixture_helper() {
        let served = serve("bin-session", true);
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
        let served = serve("bin-g1", false);
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
}
