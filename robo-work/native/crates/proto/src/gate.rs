//! The start-gate protocol of the publication barrier (plan section 5.5, "Create gated"), helper side.
//!
//! Byte-for-byte the protocol of `robo-work/server/execution/gateProtocol.mjs`: helper code reads exactly one byte
//! from the gate pipe before the final exec. Only the commit byte 0x43 (`'C'`) commits. End-of-file, any other byte
//! and any read error abort, so a supervisor, keeper or endpoint that dies before commit leaves a helper that never
//! reaches the final exec. `EAGAIN` is retried after 2 ms (Node does the same); `EINTR` is retried at once.

use std::io::{ErrorKind, Read};
use std::time::Duration;

pub const COMMIT_BYTE: u8 = 0x43;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateOutcome {
    Commit,
    Abort,
}

/// The decision for one read result: `Some(byte)` read, or `None` for end-of-file.
pub fn decide(read: Option<u8>) -> GateOutcome {
    match read {
        Some(COMMIT_BYTE) => GateOutcome::Commit,
        _ => GateOutcome::Abort,
    }
}

/// Blocks until the gate decides. Reads at most one byte.
pub fn await_gate<R: Read>(reader: &mut R) -> GateOutcome {
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => return GateOutcome::Abort,
            Ok(_) => return decide(Some(byte[0])),
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(2)),
            Err(_) => return GateOutcome::Abort,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    struct Script(Vec<io::Result<Option<u8>>>, usize);
    impl Read for Script {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.1 += 1;
            match self.0.remove(0) {
                Ok(Some(byte)) => {
                    buf[0] = byte;
                    Ok(1)
                }
                Ok(None) => Ok(0),
                Err(error) => Err(error),
            }
        }
    }

    #[test]
    fn only_the_commit_byte_commits() {
        assert_eq!(decide(Some(0x43)), GateOutcome::Commit);
        for byte in (0u8..=255).filter(|byte| *byte != 0x43) {
            assert_eq!(decide(Some(byte)), GateOutcome::Abort);
        }
        assert_eq!(decide(None), GateOutcome::Abort);
    }

    #[test]
    fn reads_exactly_one_byte_and_retries_transient_errors() {
        let mut script = Script(vec![
            Err(io::Error::from(ErrorKind::Interrupted)),
            Err(io::Error::from(ErrorKind::WouldBlock)),
            Ok(Some(COMMIT_BYTE)),
            Ok(Some(b'x')),
        ], 0);
        assert_eq!(await_gate(&mut script), GateOutcome::Commit);
        assert_eq!(script.1, 3);
        assert_eq!(script.0.len(), 1, "a byte after the decision is never read");
        let mut eof = Script(vec![Ok(None)], 0);
        assert_eq!(await_gate(&mut eof), GateOutcome::Abort);
        let mut broken = Script(vec![Err(io::Error::from(ErrorKind::BrokenPipe))], 0);
        assert_eq!(await_gate(&mut broken), GateOutcome::Abort);
        // The commit byte read in a multi-byte chunk is still one byte: a reader is never asked for more.
        assert_eq!(await_gate(&mut io::Cursor::new(vec![COMMIT_BYTE, COMMIT_BYTE])), GateOutcome::Commit);
        assert_eq!(await_gate(&mut io::Cursor::new(Vec::<u8>::new())), GateOutcome::Abort);
    }
}
