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
                         [--proof-fixture-session [--proof-fixture-keeper]]
  rw-target-helper worker-peer --mailbox <socket> (--probe | --session)";
#[cfg(not(feature = "proof-fixture"))]
const USAGE: &str = "usage:
  rw-target-helper journal-init --root <dir>
  rw-target-helper serve --mailbox <socket> --journal-root <dir> --store-identity <Id> --helper-incarnation <Id>
  rw-target-helper worker-peer --mailbox <socket> (--probe | --session)";

/// Event and reply lines can carry one receipt and one reply frame.
const LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Default)]
struct Options {
    root: Option<PathBuf>,
    mailbox: Option<PathBuf>,
    store_identity: Option<String>,
    helper_incarnation: Option<String>,
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
        "journal-init" => options.root.is_some() && options.store_identity.is_none() && options.helper_incarnation.is_none() && options.mailbox.is_none() && !options.probe && !options.session && !options.fixture_session && !options.fixture_keeper,
        "serve" => options.root.is_some() && options.mailbox.is_some() && options.store_identity.is_some() && options.helper_incarnation.is_some() && !options.probe && !options.session && (options.fixture_session || !options.fixture_keeper),
        "worker-peer" => options.mailbox.is_some() && peer_mode && options.root.is_none() && !options.fixture_session && !options.fixture_keeper,
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
    use rw_target_helper::keeper::{KeeperLauncher, UnavailableUntilG1};
    use rw_target_helper::mailbox::{Connection, Listener, PeerCredentials, RecvError, RecvLimits, connect_error_code};
    use rw_target_helper::peer::{self, HelperState, SystemClock, WorkerSession};
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

    #[cfg(feature = "proof-fixture")]
    fn fixture_ticket_key(options: &Options) -> Option<TicketKey> {
        options.fixture_session.then(rw_target_helper::session::proof_fixture::ticket_key)
    }

    #[cfg(not(feature = "proof-fixture"))]
    fn fixture_ticket_key(_options: &Options) -> Option<TicketKey> {
        None
    }

    /// The target side: open the provisioned journal (never create it), bind the provisioned mailbox and serve.
    ///
    /// Without a ticket key (every build without the `proof-fixture` feature, and a fixture build without
    /// `--proof-fixture-session`) no connection can have a session: every received frame is refused as
    /// `frame_authentication`, its descriptors are closed and the connection is closed. With the proof-fixture ticket key
    /// each connection runs the A11 handshake (`session`, `peer`). Keeper launch refuses until G1 (`service`) unless
    /// `--proof-fixture-keeper` selects the fixture launcher, which launches nothing.
    pub fn serve(options: &Options) -> i32 {
        let root = options.root.as_deref().unwrap_or(std::path::Path::new(""));
        let store = options.store_identity.as_deref().unwrap_or_default();
        let incarnation = options.helper_incarnation.as_deref().unwrap_or_default();
        let journal = match Journal::open(root, store, incarnation, JournalLimits::default(), Duration::from_millis(5000)) {
            Ok(journal) => journal,
            Err(code) => {
                emit(&code.result_value());
                return if code == Code::JournalUnavailable { 75 } else { 1 };
            }
        };
        let ticket_key = fixture_ticket_key(options);
        let journal = match fixture_keeper(options, journal, ticket_key.clone()) {
            Ok(status) => return status,
            Err(journal) => journal,
        };
        serve_with(options, TargetService::new(journal, UnavailableUntilG1), ticket_key, "unavailable-until-g1")
    }

    /// `--proof-fixture-keeper`: serve with the fixture launcher (launches nothing). Returns the journal otherwise.
    #[cfg(feature = "proof-fixture")]
    fn fixture_keeper(options: &Options, journal: Journal, ticket_key: Option<TicketKey>) -> Result<i32, Journal> {
        if options.fixture_keeper { Ok(serve_with(options, TargetService::proof_fixture(journal), ticket_key, "proof-fixture-no-keeper")) } else { Err(journal) }
    }

    #[cfg(not(feature = "proof-fixture"))]
    fn fixture_keeper(_options: &Options, journal: Journal, _ticket_key: Option<TicketKey>) -> Result<i32, Journal> {
        Err(journal)
    }

    fn serve_with<L: KeeperLauncher>(options: &Options, mut service: TargetService<L>, ticket_key: Option<TicketKey>, launcher: &str) -> i32 {
        let mailbox = options.mailbox.as_deref().unwrap_or(std::path::Path::new(""));
        let listener = match Listener::bind(mailbox) {
            Ok(listener) => listener,
            Err(error) => {
                event("mailbox_unavailable", vec![("kind", s(&format!("{:?}", error.kind())))]);
                return 75;
            }
        };
        let mut fields = vec![
            ("state", s("ready")),
            ("helperIncarnation", s(service.journal().helper_incarnation())),
            ("journalStoreIdentity", s(service.journal().store_identity())),
        ];
        if ticket_key.is_some() {
            fields.push(("session", s("proof-fixture")));
            fields.push(("keeperLauncher", s(launcher)));
        }
        emit(&ok_value(obj(fields)));
        let mut state = ticket_key.map(|key| HelperState::new(key, service.journal().helper_incarnation(), service.journal().store_identity()));
        let clock = SystemClock::new();
        loop {
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
            if let Some(state) = state.as_mut() {
                peer::serve_session(&connection, state, &mut service, &clock, &mut |name, fields| event(name, fields));
                drop(connection);
                continue;
            }
            let limits = RecvLimits { idle_timeout: Some(Duration::from_millis(300_000)), ..RecvLimits::default() };
            match connection.recv_frame(limits) {
                Ok(frame) => {
                    // No session key: nothing can authenticate. Dropping the frame closes every received descriptor.
                    let closed = frame.descriptors.len();
                    drop(frame);
                    event("frame_refused", vec![("code", s(Code::FrameAuthentication.as_str())), ("descriptorsClosed", Value::Int(closed as i64))]);
                }
                Err(RecvError::Closed) => event("connection_closed", vec![]),
                Err(error) => {
                    let code = match error {
                        RecvError::Ancillary(_) => Code::DescriptorCount.as_str(),
                        RecvError::Oversize => Code::CapacityExceeded.as_str(),
                        RecvError::Timeout => "timeout",
                        RecvError::Truncated => "truncated",
                        RecvError::Closed | RecvError::Io(_) => "io",
                    };
                    event("frame_refused", vec![("code", s(code))]);
                }
            }
            drop(connection);
        }
    }

    /// The worker side. `--probe`: connect, record the target's kernel credentials (diagnostics only), send one
    /// unauthenticated probe frame carrying one descriptor and expect the target to refuse and close. `--session`: the
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
        let closed = matches!(connection.recv_frame(limits), Err(RecvError::Closed));
        emit(&ok_value(obj(vec![
            ("closedByTarget", Value::Bool(closed)),
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
