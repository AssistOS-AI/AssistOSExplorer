//! `rw-target-helper journal-init | serve | worker-peer` (see `usage`). The mailbox roles are Linux only; on another host
//! they refuse to run.
//!
//! Output lines are canonical JSON results or events. They never carry secrets, tokens, paths of other principals or
//! frame contents (the worker peer's `reply` event carries the reply frame back to its own worker host, which holds the
//! session key anyway).

use std::path::PathBuf;

use rw_target_helper::canon::{self, Value, obj, s};
use rw_target_helper::journal::Journal;
use rw_target_helper::{Code, ok_value};

#[cfg(feature = "proof-fixture")]
const USAGE: &str = "usage:
  rw-target-helper journal-init --root <dir>
  rw-target-helper serve --mailbox <socket> --journal-root <dir> --store-identity <Id> --helper-incarnation <Id>
                         --secret-file <path> [--proof-fixture-session [--proof-fixture-keeper]]
  rw-target-helper worker-peer --mailbox <socket> (--probe | --session)";
#[cfg(not(feature = "proof-fixture"))]
const USAGE: &str = "usage:
  rw-target-helper journal-init --root <dir>
  rw-target-helper serve --mailbox <socket> --journal-root <dir> --store-identity <Id> --helper-incarnation <Id>
                         --secret-file <path>
  rw-target-helper worker-peer --mailbox <socket> (--probe | --session)";

/// Event and reply lines can carry one receipt and one reply frame.
const LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Default)]
struct Options {
    root: Option<PathBuf>,
    mailbox: Option<PathBuf>,
    store_identity: Option<String>,
    helper_incarnation: Option<String>,
    secret_file: Option<PathBuf>,
    probe: bool,
    session: bool,
    fixture_session: bool,
    fixture_keeper: bool,
}

fn parse(arguments: &[String]) -> Result<(String, Options), String> {
    let command = arguments.first().cloned().ok_or("missing command")?;
    let mut options = Options::default();
    let mut index = 1;
    while index < arguments.len() {
        let flag = arguments[index].as_str();
        let mut value = || -> Result<String, String> {
            index += 1;
            arguments.get(index).cloned().ok_or(format!("{flag} needs a value"))
        };
        match flag {
            "--root" | "--journal-root" if options.root.is_none() => options.root = Some(PathBuf::from(value()?)),
            "--mailbox" if options.mailbox.is_none() => options.mailbox = Some(PathBuf::from(value()?)),
            "--store-identity" if options.store_identity.is_none() => options.store_identity = Some(value()?),
            "--helper-incarnation" if options.helper_incarnation.is_none() => options.helper_incarnation = Some(value()?),
            "--secret-file" if options.secret_file.is_none() => options.secret_file = Some(PathBuf::from(value()?)),
            "--probe" if !options.probe => options.probe = true,
            "--session" if !options.session => options.session = true,
            // The proof-fixture switches exist only in a build with the `proof-fixture` feature.
            #[cfg(feature = "proof-fixture")]
            "--proof-fixture-session" if !options.fixture_session => options.fixture_session = true,
            #[cfg(feature = "proof-fixture")]
            "--proof-fixture-keeper" if !options.fixture_keeper => options.fixture_keeper = true,
            _ => return Err(format!("unexpected or repeated argument {flag}")),
        }
        index += 1;
    }
    let peer_mode = options.probe != options.session;
    let required = match command.as_str() {
        "journal-init" => options.root.is_some() && options.store_identity.is_none() && options.helper_incarnation.is_none() && options.secret_file.is_none() && options.mailbox.is_none() && !options.probe && !options.session && !options.fixture_session && !options.fixture_keeper,
        "serve" => options.root.is_some() && options.mailbox.is_some() && options.store_identity.is_some() && options.helper_incarnation.is_some() && options.secret_file.is_some() && !options.probe && !options.session && (options.fixture_session || !options.fixture_keeper),
        "worker-peer" => options.mailbox.is_some() && peer_mode && options.root.is_none() && options.secret_file.is_none() && !options.fixture_session && !options.fixture_keeper,
        _ => return Err(format!("unknown command {command}")),
    };
    if !required {
        return Err(format!("missing or extra arguments for {command}"));
    }
    Ok((command, options))
}

fn emit(value: &Value) {
    match canon::canonical(value, LINE_BYTES) {
        Ok(text) => println!("{text}"),
        Err(code) => println!("{{\"ok\":false,\"error\":{{\"code\":\"{code}\"}}}}"),
    }
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let (command, options) = match parse(&arguments) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("rw-target-helper: {message}\n{USAGE}");
            std::process::exit(64);
        }
    };
    std::process::exit(match command.as_str() {
        "journal-init" => journal_init(&options),
        "serve" => roles::serve(&options),
        _ => roles::worker_peer(&options),
    });
}

/// Provisioning: creates the journal store under a freshly minted identity (or reports the existing store) and prints
/// the identity and directory device/inode for Ploinky to record.
fn journal_init(options: &Options) -> i32 {
    let root = options.root.as_deref().unwrap_or(std::path::Path::new(""));
    match Journal::create(root) {
        Ok(info) => {
            emit(&ok_value(obj(vec![
                ("journalStoreIdentity", s(&info.journal_store_identity)),
                ("device", s(&info.device.to_string())),
                ("inode", s(&info.inode.to_string())),
            ])));
            0
        }
        Err(code) => {
            emit(&code.result_value());
            if code == Code::JournalUnavailable { 75 } else { 1 }
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod roles {
    pub fn serve(_options: &super::Options) -> i32 {
        eprintln!("rw-target-helper: serve is Linux only");
        69
    }

    pub fn worker_peer(_options: &super::Options) -> i32 {
        eprintln!("rw-target-helper: worker-peer is Linux only");
        69
    }
}

#[cfg(target_os = "linux")]
mod roles {
    use std::io::BufRead;
    use std::os::fd::AsFd;
    use std::time::Duration;

    use rw_target_helper::canon::{self, Value, obj, s};
    use rw_target_helper::crypto::b64url_encode;
    use rw_target_helper::journal::{Journal, JournalLimits};
    use rw_target_helper::keeper::KeeperLauncher;
    use rw_target_helper::launch::consume_ticket_secret;
    use rw_target_helper::mailbox::{Connection, Listener, PeerCredentials, RecvError, RecvLimits, connect_error_code};
    use rw_target_helper::peer::{self, Clock, HelperState, SystemClock, WorkerSession};
    use rw_target_helper::supervisor::{KEEPER_PATH, KeeperSupervisor, ProcessSpawner, RUNTIME_BASE};
    use rw_target_helper::service::TargetService;
    use rw_target_helper::session::TicketKey;
    use rw_target_helper::{Code, ok_value};

    use super::{Options, emit};

    fn peer(credentials: &PeerCredentials) -> Value {
        obj(vec![("pid", Value::Int(credentials.pid as i64)), ("uid", Value::Int(credentials.uid as i64)), ("gid", Value::Int(credentials.gid as i64))])
    }

    fn event(name: &str, mut fields: Vec<(&str, Value)>) {
        fields.insert(0, ("event", s(name)));
        if let Ok(text) = rw_target_helper::canon::canonical_text(&obj(fields)) {
            eprintln!("{text}");
        }
    }

    /// `--proof-fixture-session` (feature `proof-fixture` only): the public fixture ticket key replaces the consumed
    /// per-incarnation secret, because the worker-side fixture minter holds only that key and Ploinky registers no mint
    /// route yet. The consumed secret is dropped (and wiped) unused.
    #[cfg(feature = "proof-fixture")]
    fn fixture_ticket_key(options: &Options) -> Option<TicketKey> {
        options.fixture_session.then(rw_target_helper::session::proof_fixture::ticket_key)
    }

    #[cfg(not(feature = "proof-fixture"))]
    fn fixture_ticket_key(_options: &Options) -> Option<TicketKey> {
        None
    }

    /// The target side: consume the single-use ticket-secret file, open the provisioned journal (never create it), bind
    /// the provisioned mailbox and serve.
    ///
    /// The secret file is read and unlinked before anything else touches the journal or the mailbox; a missing, unsafe,
    /// malformed or foreign file refuses `invalid_request` with exit 78 and nothing else happens. Every connection runs the
    /// A11 handshake (`session`, `peer`) with the ticket key of this helper incarnation: the consumed secret (kid
    /// `hti1.<incarnation>`), or in a `proof-fixture` build with `--proof-fixture-session` the public fixture key. The
    /// launcher is the keeper supervisor (one `keeper serve` per execution, `supervisor`), whatever the session key;
    /// mutations refuse `keeper_unavailable` before the journal when the keeper binary is absent. Only the test-only
    /// `--proof-fixture-keeper` (a `proof-fixture` build) replaces it with the launcher that launches nothing.
    pub fn serve(options: &Options) -> i32 {
        let root = options.root.as_deref().unwrap_or(std::path::Path::new(""));
        let store = options.store_identity.as_deref().unwrap_or_default();
        let incarnation = options.helper_incarnation.as_deref().unwrap_or_default();
        let secret_file = options.secret_file.as_deref().unwrap_or(std::path::Path::new(""));
        let consumed = match consume_ticket_secret(secret_file, incarnation) {
            Ok(key) => key,
            Err(code) => {
                emit(&code.result_value());
                return 78;
            }
        };
        let (ticket_key, session_label) = match fixture_ticket_key(options) {
            Some(fixture) => {
                drop(consumed);
                (fixture, "proof-fixture")
            }
            None => (consumed, "helper-ticket-secret"),
        };
        let journal = match Journal::open(root, store, incarnation, JournalLimits::default(), Duration::from_millis(5000)) {
            Ok(journal) => journal,
            Err(code) => {
                emit(&code.result_value());
                return if code == Code::JournalUnavailable { 75 } else { 1 };
            }
        };
        let session = Session { ticket_key, label: session_label };
        let (journal, session) = match fixture_keeper(options, journal, session) {
            Ok(status) => return status,
            Err(unused) => unused,
        };
        let supervisor = KeeperSupervisor::new(
            Box::new(ProcessSpawner::new(std::path::Path::new(KEEPER_PATH))),
            root,
            std::path::Path::new(RUNTIME_BASE),
            journal.helper_incarnation(),
            journal.store_identity(),
        );
        serve_with(options, TargetService::new(journal, supervisor), session)
    }

    /// The ticket key a `serve` process verifies tickets with, and which key it is (reported on the ready line).
    struct Session {
        ticket_key: TicketKey,
        label: &'static str,
    }

    /// `--proof-fixture-keeper`: serve with the fixture launcher (launches nothing). Returns the journal otherwise.
    #[cfg(feature = "proof-fixture")]
    fn fixture_keeper(options: &Options, journal: Journal, session: Session) -> Result<i32, (Journal, Session)> {
        if options.fixture_keeper { Ok(serve_with(options, TargetService::proof_fixture(journal), session)) } else { Err((journal, session)) }
    }

    #[cfg(not(feature = "proof-fixture"))]
    fn fixture_keeper(_options: &Options, journal: Journal, session: Session) -> Result<i32, (Journal, Session)> {
        Err((journal, session))
    }

    /// Startup reconciliation (keeper supervisor), bind, ready line, then the serve loop: one connection at a time, and
    /// between connections (at most every second) the housekeeping that journals keeper outcomes and expires leases.
    fn serve_with<L: KeeperLauncher>(options: &Options, mut service: TargetService<L>, session: Session) -> i32 {
        let clock = SystemClock::new();
        let mut emit_event = |name: &str, fields: Vec<(&str, Value)>| event(name, fields);
        if service.launcher().reconcile_on_start() {
            // Before readiness: no keeper of an earlier helper process survives it, so every unsettled record is
            // stopped (absence verified) and journaled exited; none is relaunched.
            match service.reconcile_at_start(clock.now_ms()) {
                Ok(settled) => {
                    event("startup_reconciled", vec![("records", Value::Int(settled.len() as i64))]);
                    for item in &settled {
                        peer::journaled_event(item, &mut emit_event);
                    }
                }
                Err(code) => {
                    emit(&code.result_value());
                    return if code == Code::JournalUnavailable { 75 } else { 1 };
                }
            }
        }
        let mailbox = options.mailbox.as_deref().unwrap_or(std::path::Path::new(""));
        let listener = match Listener::bind(mailbox) {
            Ok(listener) => listener,
            Err(error) => {
                event("mailbox_unavailable", vec![("kind", s(&format!("{:?}", error.kind())))]);
                return 75;
            }
        };
        emit(&ok_value(obj(vec![
            ("state", s("ready")),
            ("helperIncarnation", s(service.journal().helper_incarnation())),
            ("journalStoreIdentity", s(service.journal().store_identity())),
            ("session", s(session.label)),
            ("keeperLauncher", s(service.launcher().label())),
        ])));
        let mut state = HelperState::new(session.ticket_key, service.journal().helper_incarnation(), service.journal().store_identity());
        loop {
            peer::housekeeping(&mut state, &mut service, &clock, &mut emit_event);
            let mut fds = vec![libc::pollfd { fd: std::os::fd::AsRawFd::as_raw_fd(&listener), events: libc::POLLIN, revents: 0 }];
            fds.extend(service.poll_fds().into_iter().map(|fd| libc::pollfd { fd, events: libc::POLLIN, revents: 0 }));
            // SAFETY: a valid pollfd array of fds.len() entries.
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 1000) };
            if ready < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                event("poll_failed", vec![("kind", s(&format!("{:?}", error.kind())))]);
                return 74;
            }
            if fds[0].revents & libc::POLLIN == 0 {
                continue;
            }
            let connection = match listener.accept() {
                Ok(connection) => connection,
                Err(error) => {
                    event("accept_failed", vec![("kind", s(&format!("{:?}", error.kind())))]);
                    return 74;
                }
            };
            match connection.peer_credentials() {
                Ok(credentials) => event("connection", vec![("peer", peer(&credentials))]),
                Err(_) => event("connection", vec![("peer", Value::Null)]),
            }
            peer::serve_session(&connection, &mut state, &mut service, &clock, &mut emit_event);
            drop(connection);
        }
    }

    /// The worker side. `--probe`: connect, record the target's kernel credentials (diagnostics only), send one
    /// unauthenticated probe frame carrying one descriptor and expect the target to refuse and close. The target opens
    /// every connection with its session challenge and answers the probe (which is no bootstrap) with a handshake
    /// refusal; the probe reads at most those two messages, reports the refusal code (an enumerated spelling or
    /// `refused`, A11.6) and then requires the close. `--session`: the
    /// worker-side peer of decision B4, driven over stdin/stdout by its worker host (see `worker_session`).
    pub fn worker_peer(options: &Options) -> i32 {
        let mailbox = options.mailbox.as_deref().unwrap_or(std::path::Path::new(""));
        let connection = match Connection::connect(mailbox) {
            Ok(connection) => connection,
            Err(error) => {
                // Nothing was sent: a refused connect, never a journal fact.
                emit(&connect_error_code(&error).result_value());
                return 75;
            }
        };
        if options.session {
            return worker_session(connection);
        }
        let credentials = connection.peer_credentials().ok();
        // A minimal layout-valid frame: length 36, empty header, empty body, a zero MAC.
        let mut probe = vec![0u8; 40];
        probe[..4].copy_from_slice(&36u32.to_be_bytes());
        let null = match std::fs::File::open("/dev/null") {
            Ok(file) => file,
            Err(_) => return 1,
        };
        if connection.send_frame(&probe, &[null.as_fd()]).is_err() {
            return 1;
        }
        let limits = RecvLimits { idle_timeout: Some(Duration::from_millis(5000)), ..RecvLimits::default() };
        let mut refused = Value::Null;
        let mut closed = false;
        for _ in 0..3 {
            match connection.recv_frame(limits) {
                Err(RecvError::Closed) => {
                    closed = true;
                    break;
                }
                Ok(received) => {
                    let message = rw_target_helper::session::decode_message(&received.bytes, received.descriptors.len());
                    match message.as_ref().ok().and_then(|value| value.str_at("kind")) {
                        Some("challenge") => continue,
                        Some("refused") => {
                            let code = message.as_ref().ok().and_then(|value| value.str_at("code")).and_then(Code::from_spelling).map_or("refused", Code::as_str);
                            refused = s(code);
                        }
                        _ => break,
                    }
                }
                Err(_) => break,
            }
        }
        emit(&ok_value(obj(vec![
            ("closedByTarget", Value::Bool(closed)),
            ("refusedCode", refused),
            ("targetPeer", credentials.as_ref().map_or(Value::Null, peer)),
        ])));
        if closed { 0 } else { 1 }
    }

    fn line_event(name: &str, mut fields: Vec<(&str, Value)>) {
        fields.insert(0, ("event", s(name)));
        emit(&obj(fields));
    }

    fn read_command(lines: &mut impl Iterator<Item = std::io::Result<String>>) -> Result<Option<Value>, Code> {
        match lines.next() {
            None => Ok(None),
            Some(Err(_)) => Err(Code::InvalidRequest),
            Some(Ok(line)) => {
                let value = canon::parse_canonical(line.as_bytes(), super::LINE_BYTES)?;
                if value.is_obj() { Ok(Some(value)) } else { Err(Code::InvalidRequest) }
            }
        }
    }

    /// The `--session` protocol on stdin (one canonical JSON object per line) and stdout (one event per line):
    ///
    /// | stdin | stdout |
    /// |---|---|
    /// | (connect) | `{event:"connected", targetPeer}` then `{event:"challenge", challengeId, helperNonce, helperIncarnation}` |
    /// | `{op:"bootstrap", ticket, sessionKey}` | `{event:"accepted"}` or `{event:"refused", code}` (exit 2); `code` is an enumerated spelling or `refused` (A11.6) |
    /// | `{op:"bootstrap-drop", ticket, sessionKey}` | PROOF-FIXTURE lost `accepted`: sends the bootstrap, closes without reading: `{event:"bootstrap-dropped"}` (exit 0) |
    /// | `{op:"frame", messageKind, body}` | `{event:"reply", messageKind, body, frame}` (`body` the canonical text, `frame` base64url) |
    /// | `{op:"drop", messageKind, body}` | sends the frame, closes without reading the reply: `{event:"dropped"}` (exit 0) |
    /// | `{op:"close"}` or end of input | exit 0 |
    ///
    /// The lease is the ticket's `leaseId` claim. The session key arrives only on stdin (never argv or environment) and is
    /// never printed.
    fn worker_session(connection: Connection) -> i32 {
        let credentials = connection.peer_credentials().ok();
        line_event("connected", vec![("targetPeer", credentials.as_ref().map_or(Value::Null, peer))]);
        let challenge = match peer::read_challenge(&connection) {
            Ok(challenge) => challenge,
            Err(code) => {
                line_event("error", vec![("code", s(code.as_str()))]);
                return 1;
            }
        };
        line_event(
            "challenge",
            vec![("challengeId", s(&challenge.challenge_id)), ("helperNonce", s(&challenge.helper_nonce)), ("helperIncarnation", s(&challenge.helper_incarnation))],
        );
        let stdin = std::io::stdin();
        let mut lines = stdin.lock().lines();
        let fail = |code: &str| {
            line_event("error", vec![("code", s(code))]);
            1
        };
        let command = match read_command(&mut lines) {
            Ok(Some(command)) => command,
            Ok(None) => return 0,
            Err(code) => return fail(code.as_str()),
        };
        let op = command.str_at("op").unwrap_or_default().to_string();
        if !(op == "bootstrap" || op == "bootstrap-drop") || !command.has_exact_keys(&["op", "ticket", "sessionKey"]) {
            return fail(Code::InvalidRequest.as_str());
        }
        let key = match peer::parse_session_key(command.str_at("sessionKey").unwrap_or_default()) {
            Ok(key) => key,
            Err(code) => return fail(code.as_str()),
        };
        let ticket = command.str_at("ticket").unwrap_or_default().to_string();
        if op == "bootstrap-drop" {
            return match WorkerSession::bootstrap_and_drop(connection, &challenge, &ticket, key) {
                Ok(()) => {
                    line_event("bootstrap-dropped", vec![]);
                    0
                }
                Err(error) => fail(&error.code()),
            };
        }
        let mut session = match WorkerSession::bootstrap(connection, &challenge, &ticket, key) {
            Ok(session) => session,
            Err(peer::WorkerError::Refused(code)) => {
                line_event("refused", vec![("code", s(&code))]);
                return 2;
            }
            Err(error) => return fail(&error.code()),
        };
        line_event("accepted", vec![]);
        loop {
            let command = match read_command(&mut lines) {
                Ok(Some(command)) => command,
                Ok(None) => return 0,
                Err(code) => return fail(code.as_str()),
            };
            let op = command.str_at("op").unwrap_or_default().to_string();
            if op == "close" && command.has_exact_keys(&["op"]) {
                return 0;
            }
            if !(op == "frame" || op == "drop") || !command.has_exact_keys(&["op", "messageKind", "body"]) {
                return fail(Code::InvalidRequest.as_str());
            }
            let kind = command.str_at("messageKind").unwrap_or_default().to_string();
            let body = command.str_at("body").unwrap_or_default().as_bytes().to_vec();
            if op == "drop" {
                return match session.send_and_drop(&kind, &body) {
                    Ok(()) => {
                        line_event("dropped", vec![("messageKind", s(&kind))]);
                        0
                    }
                    Err(error) => fail(&error.code()),
                };
            }
            match session.request(&kind, &body) {
                Ok(reply) => {
                    let text = String::from_utf8_lossy(&reply.body).to_string();
                    line_event("reply", vec![("messageKind", s(&reply.message_kind)), ("body", s(&text)), ("frame", s(&b64url_encode(&reply.frame)))]);
                }
                Err(error) => return fail(&error.code()),
            }
        }
    }
}
