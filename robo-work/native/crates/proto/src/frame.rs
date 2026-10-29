//! Length-prefixed frame codec of the supervisor <-> keeper channel (plan section 5.5), keeper side.
//!
//! Byte-for-byte the format of `robo-work/server/execution/frameCodec.mjs`: a 4-byte big-endian length followed by
//! that many bytes of UTF-8 JSON that encode one object. The channel carries no descriptors (the keeper reads it with
//! plain `read`, which discards any ancillary data on Linux).
//!
//! Bounds, all decided before a payload byte is retained (the same as the Node decoder):
//!   - a length of zero is `empty_frame` and a length above `max_frame_bytes` is `oversize_frame`, decided from the four
//!     header bytes alone; nothing is allocated for the payload;
//!   - a frame that is not complete within `partial_frame_deadline_ms` of its first byte is `partial_frame_deadline`;
//!     a trickle of bytes does not extend the deadline;
//!   - a payload that is not a JSON object is `malformed_frame`;
//!   - at most `max_in_flight` requests are outstanding at once ([`InFlight`]); one more is `in_flight_overflow`.
//! The first refusal kills the decoder: it reports exactly one violation and ignores all later input.
//!
//! Time is injected (`now_ms`, a monotonic millisecond clock), so the state machine is pure and host-testable.

use crate::json::{self, Value};

pub const HEADER_BYTES: usize = 4;

pub const EMPTY_FRAME: &str = "empty_frame";
pub const OVERSIZE_FRAME: &str = "oversize_frame";
pub const MALFORMED_FRAME: &str = "malformed_frame";
pub const PARTIAL_FRAME_DEADLINE: &str = "partial_frame_deadline";
pub const IN_FLIGHT_OVERFLOW: &str = "in_flight_overflow";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodeError {
    OutsideBound,
}

/// `encodeFrame(value, { maxFrameBytes })`.
pub fn encode_frame(value: &Value, max_frame_bytes: usize) -> Result<Vec<u8>, EncodeError> {
    let payload = json::stringify(value).into_bytes();
    if payload.is_empty() || payload.len() > max_frame_bytes || payload.len() > u32::MAX as usize {
        return Err(EncodeError::OutsideBound);
    }
    let mut frame = Vec::with_capacity(HEADER_BYTES + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

#[derive(Debug, PartialEq)]
pub enum DecodeEvent {
    Frame(Value),
    Violation(&'static str),
}

#[derive(Debug)]
pub struct FrameDecoder {
    max_frame_bytes: usize,
    partial_frame_deadline_ms: u64,
    header: [u8; HEADER_BYTES],
    header_filled: usize,
    expected: Option<usize>,
    payload: Vec<u8>,
    deadline_at: Option<u64>,
    dead: bool,
    frames: u64,
    peak_retained: usize,
    /// Payload length of each frame emitted, in order (for per-op size caps).
    lengths: Vec<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecoderStats {
    pub frames: u64,
    pub peak_retained: usize,
    pub dead: bool,
}

impl FrameDecoder {
    pub fn new(max_frame_bytes: usize, partial_frame_deadline_ms: u64) -> Self {
        assert!(max_frame_bytes > 0 && max_frame_bytes <= u32::MAX as usize, "max_frame_bytes out of range");
        assert!(partial_frame_deadline_ms > 0, "partial_frame_deadline_ms must be positive");
        FrameDecoder {
            max_frame_bytes,
            partial_frame_deadline_ms,
            header: [0; HEADER_BYTES],
            header_filled: 0,
            expected: None,
            payload: Vec::new(),
            deadline_at: None,
            dead: false,
            frames: 0,
            peak_retained: 0,
            lengths: Vec::new(),
        }
    }

    fn violate(&mut self, code: &'static str, out: &mut Vec<DecodeEvent>) {
        if self.dead {
            return;
        }
        self.dead = true;
        self.deadline_at = None;
        self.payload = Vec::new();
        out.push(DecodeEvent::Violation(code));
    }

    fn retained(&self) -> usize {
        self.header_filled + self.payload.len()
    }

    /// The deadline check that Node's timer performs. Call it from the event loop's timeout as well as before input.
    pub fn poll(&mut self, now_ms: u64, out: &mut Vec<DecodeEvent>) {
        if let Some(deadline) = self.deadline_at {
            if now_ms >= deadline {
                self.violate(PARTIAL_FRAME_DEADLINE, out);
            }
        }
    }

    /// When the event loop must call [`FrameDecoder::poll`] next, if a frame is partially received.
    pub fn deadline(&self) -> Option<u64> {
        if self.dead { None } else { self.deadline_at }
    }

    fn complete(&mut self, out: &mut Vec<DecodeEvent>) {
        let payload = std::mem::take(&mut self.payload);
        self.expected = None;
        self.header_filled = 0;
        self.deadline_at = None;
        match json::parse(&payload) {
            Ok(value) if value.is_plain_object() => {
                self.frames += 1;
                self.lengths.push(payload.len());
                out.push(DecodeEvent::Frame(value));
            }
            _ => self.violate(MALFORMED_FRAME, out),
        }
    }

    pub fn push(&mut self, chunk: &[u8], now_ms: u64, out: &mut Vec<DecodeEvent>) {
        self.poll(now_ms, out);
        let mut offset = 0;
        while offset < chunk.len() && !self.dead {
            match self.expected {
                None => {
                    if self.deadline_at.is_none() {
                        self.deadline_at = Some(now_ms.saturating_add(self.partial_frame_deadline_ms));
                    }
                    let take = (HEADER_BYTES - self.header_filled).min(chunk.len() - offset);
                    self.header[self.header_filled..self.header_filled + take].copy_from_slice(&chunk[offset..offset + take]);
                    self.header_filled += take;
                    offset += take;
                    if self.header_filled < HEADER_BYTES {
                        break;
                    }
                    let length = u32::from_be_bytes(self.header) as usize;
                    if length == 0 {
                        self.violate(EMPTY_FRAME, out);
                        return;
                    }
                    if length > self.max_frame_bytes {
                        self.violate(OVERSIZE_FRAME, out);
                        return;
                    }
                    self.expected = Some(length);
                }
                Some(expected) => {
                    let take = (expected - self.payload.len()).min(chunk.len() - offset);
                    self.payload.extend_from_slice(&chunk[offset..offset + take]);
                    offset += take;
                    if self.payload.len() == expected {
                        // Retained bytes peak just before completion.
                        self.peak_retained = self.peak_retained.max(self.retained());
                        self.complete(out);
                    }
                }
            }
            self.peak_retained = self.peak_retained.max(self.retained());
        }
    }

    /// The payload lengths of the frames emitted since the last call, in emission order.
    pub fn take_lengths(&mut self) -> Vec<usize> {
        std::mem::take(&mut self.lengths)
    }

    pub fn close(&mut self) {
        self.dead = true;
        self.deadline_at = None;
        self.payload = Vec::new();
    }

    pub fn stats(&self) -> DecoderStats {
        DecoderStats { frames: self.frames, peak_retained: self.peak_retained, dead: self.dead }
    }
}

/// Outstanding requests of one channel. A request stays in flight until its answer has been flushed to the peer, so a
/// supervisor that sends requests and never reads the answers reaches the bound, which is a violation by the peer.
#[derive(Debug)]
pub struct InFlight {
    max: usize,
    ids: Vec<i64>,
}

impl InFlight {
    pub fn new(max: usize) -> Self {
        assert!(max > 0);
        InFlight { max, ids: Vec::new() }
    }

    /// `admit(id)`: false means `in_flight_overflow`.
    pub fn admit(&mut self, id: i64) -> bool {
        if self.ids.len() >= self.max {
            return false;
        }
        self.ids.push(id);
        true
    }

    pub fn settle(&mut self, id: i64) {
        if let Some(index) = self.ids.iter().position(|value| *value == id) {
            self.ids.remove(index);
        }
    }

    pub fn count(&self) -> usize {
        self.ids.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{int, obj, text};

    fn frames_of(events: &[DecodeEvent]) -> usize {
        events.iter().filter(|event| matches!(event, DecodeEvent::Frame(_))).count()
    }

    #[test]
    fn encode_layout_is_big_endian_length_then_json() {
        let frame = encode_frame(&obj(vec![("id", int(1)), ("op", text("x"))]), 64).unwrap();
        assert_eq!(&frame[..4], &[0, 0, 0, 17]);
        assert_eq!(&frame[4..], br#"{"id":1,"op":"x"}"#);
        assert_eq!(encode_frame(&obj(vec![("id", int(1))]), 7), Err(EncodeError::OutsideBound));
        assert!(encode_frame(&obj(vec![("id", int(1))]), 8).is_ok());
    }

    #[test]
    fn byte_at_a_time_and_coalesced_frames() {
        let one = encode_frame(&obj(vec![("id", int(1))]), 64).unwrap();
        let two = encode_frame(&obj(vec![("id", int(2))]), 64).unwrap();
        let mut decoder = FrameDecoder::new(64, 1000);
        let mut out = Vec::new();
        for byte in &one {
            decoder.push(std::slice::from_ref(byte), 0, &mut out);
        }
        assert_eq!(frames_of(&out), 1);
        let mut both = one.clone();
        both.extend_from_slice(&two);
        decoder.push(&both, 1, &mut out);
        assert_eq!(frames_of(&out), 3);
        assert_eq!(decoder.stats().frames, 3);
        assert!(decoder.stats().peak_retained <= 64 + HEADER_BYTES);
    }

    #[test]
    fn header_alone_decides_size_refusals() {
        let mut decoder = FrameDecoder::new(64, 1000);
        let mut out = Vec::new();
        decoder.push(&[0, 0, 0, 65], 0, &mut out);
        assert_eq!(out, vec![DecodeEvent::Violation(OVERSIZE_FRAME)]);
        // As in Node, the refusal returns before the retained-bytes peak is updated: no payload byte was kept.
        assert!(decoder.stats().peak_retained <= HEADER_BYTES);
        // Dead: later input is ignored and no second violation is reported.
        decoder.push(&[0, 0, 0, 1, b'{'], 1, &mut out);
        assert_eq!(out.len(), 1);

        let mut decoder = FrameDecoder::new(64, 1000);
        let mut out = Vec::new();
        decoder.push(&[0, 0, 0, 0], 0, &mut out);
        assert_eq!(out, vec![DecodeEvent::Violation(EMPTY_FRAME)]);

        // Exactly the bound is accepted.
        let mut decoder = FrameDecoder::new(8, 1000);
        let mut out = Vec::new();
        decoder.push(&encode_frame(&obj(vec![("id", int(1))]), 8).unwrap(), 0, &mut out);
        assert_eq!(frames_of(&out), 1);
    }

    #[test]
    fn partial_frame_deadline_runs_from_first_byte_and_is_not_extended() {
        let mut decoder = FrameDecoder::new(64, 100);
        let mut out = Vec::new();
        decoder.push(&[0], 10, &mut out);
        assert_eq!(decoder.deadline(), Some(110));
        decoder.push(&[0], 60, &mut out);
        decoder.push(&[0, 9], 109, &mut out);
        decoder.push(b"{\"id\"", 109, &mut out);
        assert!(out.is_empty());
        decoder.poll(110, &mut out);
        assert_eq!(out, vec![DecodeEvent::Violation(PARTIAL_FRAME_DEADLINE)]);
        // A complete frame clears the deadline; the next frame starts a fresh one.
        let mut decoder = FrameDecoder::new(64, 100);
        let mut out = Vec::new();
        decoder.push(&encode_frame(&obj(vec![("id", int(1))]), 64).unwrap(), 0, &mut out);
        assert_eq!(decoder.deadline(), None);
        decoder.push(&[0], 500, &mut out);
        assert_eq!(decoder.deadline(), Some(600));
    }

    #[test]
    fn malformed_payloads() {
        for payload in [&b"[1]"[..], b"1", b"null", b"\"s\"", b"{", b"\xff\xfe\xfd\xfc"] {
            let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
            frame.extend_from_slice(payload);
            let mut decoder = FrameDecoder::new(64, 100);
            let mut out = Vec::new();
            decoder.push(&frame, 0, &mut out);
            assert_eq!(out, vec![DecodeEvent::Violation(MALFORMED_FRAME)], "{payload:?}");
        }
    }

    #[test]
    fn in_flight_bound() {
        let mut tracker = InFlight::new(2);
        assert!(tracker.admit(1));
        assert!(tracker.admit(2));
        assert!(!tracker.admit(3));
        tracker.settle(1);
        assert!(tracker.admit(3));
        assert_eq!(tracker.count(), 2);
    }
}
