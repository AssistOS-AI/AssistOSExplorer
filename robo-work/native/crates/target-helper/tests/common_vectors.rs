//! The authoritative common vectors (A5.5: `contracts-v1.json` `eb8df3e6…dbbc`; `tests/vectors/contracts-v1.json` is a
//! byte copy of `robo-work/tests/executionTarget/fixtures/contracts-v1.json`). The `canonical` and `parseRejections`
//! sections cover the canonical encoder and the strict canonical parser this crate ports; the other sections are the
//! source-protection documents, which this crate does not implement.

mod common;

use common::text;
use rw_target_helper::Code;
use rw_target_helper::canon::{self, Value};
use rw_target_helper::crypto::sha256_hex;

const AUTHORITATIVE_SHA256: &str = "eb8df3e6bd6f7d0a3360f2f27d2f468ef937c7a899655662dcaa4aae01dfdbbc";
/// ENC-03-k carries a raw lone surrogate, which no Rust string (and no strict JSON reader) can hold. The loader replaces
/// that one JSON escape with this marker, and the test feeds its WTF-8 bytes to the byte parser, matching Node's
/// "string input that is not well formed" refusal.
const LONE_MARKER: &str = "@@LONE-SURROGATE-D800@@";

fn load_sections() -> (Vec<u8>, Value, Value) {
    let path = common::crate_dir().join("tests/vectors/contracts-v1.json");
    let bytes = std::fs::read(&path).unwrap();
    let raw = common::parse_raw(std::str::from_utf8(&bytes).unwrap(), LONE_MARKER);
    let section = |name: &str| raw.get(name).unwrap_or_else(|| panic!("section {name}")).to_value();
    let rejections = section("parseRejections");
    let markers = rejections.arr().unwrap().iter().filter(|entry| text(entry, "text").contains(LONE_MARKER)).count();
    assert_eq!(markers, 1, "exactly one raw lone surrogate in the parse rejections");
    (bytes, section("canonical"), rejections)
}

#[test]
fn native_copy_is_the_authoritative_fixture() {
    let (bytes, _, _) = load_sections();
    assert_eq!(sha256_hex(&bytes), AUTHORITATIVE_SHA256);
    let shared = common::robo_work_dir().join("tests/executionTarget/fixtures/contracts-v1.json");
    let source = std::fs::read(&shared).unwrap_or_else(|error| panic!("the shared fixture must be present ({}): {error}", shared.display()));
    assert_eq!(sha256_hex(&source), AUTHORITATIVE_SHA256);
}

#[test]
fn canonical_vectors_encode_digest_and_parse_back() {
    let (_, canonical, _) = load_sections();
    let entries = canonical.arr().unwrap();
    assert_eq!(entries.len(), 9);
    for entry in entries {
        let id = text(entry, "id");
        let value = entry.get("value").unwrap();
        let expected = text(entry, "canonicalJson");
        assert_eq!(canon::canonical_text(value).as_deref(), Ok(expected), "{id}");
        assert_eq!(canon::digest_of(value).as_deref(), Ok(text(entry, "sha256")), "{id}");
        let parsed = canon::parse_canonical(expected.as_bytes(), canon::OBJECT_BYTES).unwrap_or_else(|code| panic!("{id}: {code}"));
        assert_eq!(canon::canonical_text(&parsed).as_deref(), Ok(expected), "{id}");
    }
}

#[test]
fn parse_rejections_have_the_authoritative_codes() {
    let (_, _, rejections) = load_sections();
    let entries = rejections.arr().unwrap();
    assert_eq!(entries.len(), 24);
    for entry in entries {
        let id = text(entry, "id");
        let source = text(entry, "text");
        let bytes = match source.split_once(LONE_MARKER) {
            Some((before, after)) => [before.as_bytes(), &[0xed, 0xa0, 0x80], after.as_bytes()].concat(),
            None => source.as_bytes().to_vec(),
        };
        let expected = match text(entry, "code") {
            "noncanonical_encoding" => Code::NoncanonicalEncoding,
            "invalid_request" => Code::InvalidRequest,
            "capacity_exceeded" => Code::CapacityExceeded,
            other => panic!("{id}: unexpected code {other}"),
        };
        assert_eq!(canon::parse_canonical(&bytes, canon::OBJECT_BYTES).err(), Some(expected), "{id}");
    }
}
