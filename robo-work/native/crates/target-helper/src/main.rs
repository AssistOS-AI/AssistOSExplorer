//! `rw-target-helper journal-init | serve | worker-peer` (see `usage`). The mailbox roles are Linux only; on another host
//! they refuse to run.
//!
//! Output lines are canonical JSON results or events. They never carry secrets, tokens, paths of other principals or
//! frame contents.

use std::path::PathBuf;

use rw_target_helper::canon::{self, Value, obj, s};
use rw_target_helper::journal::Journal;
use rw_target_helper::{Code, ok_value};

const USAGE: &str = "usage:
  rw-target-helper journal-init --root <dir>
  rw-target-helper serve --mailbox <socket> --journal-root <dir> --store-identity <Id> --helper-incarnation <Id>
  rw-target-helper worker-peer --mailbox <socket> --probe";

#[derive(Debug, Default)]
struct Options {
    root: Option<PathBuf>,
    mailbox: Option<PathBuf>,
    store_identity: Option<String>,
    helper_incarnation: Option<String>,
    probe: bool,
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
            _ => return Err(format!("unexpected or repeated argument {flag}")),
        }
        index += 1;
    }
    let required = match command.as_str() {
        "journal-init" => options.root.is_some() && options.store_identity.is_none() && options.helper_incarnation.is_none() && options.mailbox.is_none() && !options.probe,
        "serve" => options.root.is_some() && options.mailbox.is_some() && options.store_identity.is_some() && options.helper_incarnation.is_some() && !options.probe,
        "worker-peer" => options.mailbox.is_some() && options.probe && options.root.is_none(),
        _ => return Err(format!("unknown command {command}")),
    };
    if !required {
        return Err(format!("missing or extra arguments for {command}"));
    }
    Ok((command, options))
}

fn emit(value: &Value) {
    match canon::canonical(value, canon::RECEIPT_BYTES) {
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
    use std::os::fd::AsFd;
    use std::time::Duration;

    use rw_target_helper::canon::{Value, obj, s};
    use rw_target_helper::journal::{Journal, JournalLimits};
    use rw_target_helper::keeper::UnavailableUntilG1;
    use rw_target_helper::mailbox::{Connection, Listener, PeerCredentials, RecvError, RecvLimits};
    use rw_target_helper::service::TargetService;
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

    /// The target side: open the provisioned journal (never create it), bind the provisioned mailbox and serve.
    ///
    /// The session handshake that yields a frame key (helper challenge, ticket, possession proof) is not frozen yet, so
    /// no connection has a session: every received frame is refused as `frame_authentication`, its descriptors are
    /// closed and the connection is closed. Keeper launch refuses until G1 (`service`).
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
        let service = TargetService::new(journal, UnavailableUntilG1);
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
        ])));
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

    /// The worker side: connect to the target mailbox, record the target's kernel credentials (diagnostics only),
    /// send one unauthenticated probe frame carrying one descriptor and expect the target to refuse and close.
    pub fn worker_peer(options: &Options) -> i32 {
        let mailbox = options.mailbox.as_deref().unwrap_or(std::path::Path::new(""));
        let connection = match Connection::connect(mailbox) {
            Ok(connection) => connection,
            Err(_) => {
                emit(&Code::JournalUnavailable.result_value());
                return 75;
            }
        };
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
}
