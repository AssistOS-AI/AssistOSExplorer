//! Descriptor-cap accounting of one file server (plan section 5.4, "Descriptors"). A port of
//! `robo-work/server/views/descriptorLedger.mjs` (S5 r5).
//!
//! The server inherits exactly two descriptors beyond its standard streams (the /dev/fuse connection and the grant
//! root). Every further descriptor is derived from the grant root and counted here. At the cap the server refuses the
//! NEW lookup or open explicitly (EMFILE); it never evicts a live node, and a refusal changes nothing.

use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapRefusal;

impl CapRefusal {
    pub const CODE: &'static str = "descriptor_cap";
    pub const ERRNO: &'static str = "EMFILE";
}

#[derive(Debug)]
pub struct DescriptorLedger {
    cap: usize,
    next_token: u64,
    live: BTreeMap<u64, &'static str>,
    peak: usize,
    refusals: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LedgerStats {
    pub cap: usize,
    pub in_use: usize,
    pub peak: usize,
    pub refusals: u64,
}

impl DescriptorLedger {
    pub fn new(cap: usize) -> Self {
        assert!(cap > 0, "The descriptor cap must be a positive integer");
        DescriptorLedger { cap, next_token: 1, live: BTreeMap::new(), peak: 0, refusals: 0 }
    }

    pub fn acquire(&mut self, kind: &'static str) -> Result<u64, CapRefusal> {
        assert!(!kind.is_empty(), "A descriptor needs a kind");
        if self.live.len() >= self.cap {
            self.refusals += 1;
            return Err(CapRefusal);
        }
        let token = self.next_token;
        self.next_token += 1;
        self.live.insert(token, kind);
        self.peak = self.peak.max(self.live.len());
        Ok(token)
    }

    /// Panics on an unknown or already released token: a double release is a logic error, never a silent success.
    pub fn release(&mut self, token: u64) {
        assert!(self.live.remove(&token).is_some(), "Unknown or already released descriptor");
    }

    /// Runs `work` with a counted transient descriptor, released on every path; refuses without running it at the cap.
    pub fn with_transient<T>(&mut self, kind: &'static str, work: impl FnOnce() -> T) -> Result<T, CapRefusal> {
        let token = self.acquire(kind)?;
        let result = work();
        self.release(token);
        Ok(result)
    }

    pub fn in_use(&self) -> usize {
        self.live.len()
    }

    pub fn stats(&self) -> LedgerStats {
        LedgerStats { cap: self.cap, in_use: self.live.len(), peak: self.peak, refusals: self.refusals }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_refuses_new_and_never_evicts() {
        let mut ledger = DescriptorLedger::new(2);
        let first = ledger.acquire("node").unwrap();
        let _second = ledger.acquire("file-handle").unwrap();
        assert_eq!(ledger.acquire("node"), Err(CapRefusal));
        assert_eq!(ledger.in_use(), 2);
        assert_eq!(ledger.with_transient("verify", || 1), Err(CapRefusal));
        ledger.release(first);
        assert_eq!(ledger.with_transient("verify", || 7), Ok(7));
        assert_eq!(ledger.stats(), LedgerStats { cap: 2, in_use: 1, peak: 2, refusals: 2 });
    }

    #[test]
    #[should_panic(expected = "already released")]
    fn double_release_panics() {
        let mut ledger = DescriptorLedger::new(1);
        let token = ledger.acquire("node").unwrap();
        ledger.release(token);
        ledger.release(token);
    }
}
