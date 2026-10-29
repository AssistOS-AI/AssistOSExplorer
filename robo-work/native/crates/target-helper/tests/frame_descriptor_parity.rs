//! Rust side of `tests/vectors/frame-descriptor-parity.json`: header `descriptors` values that Node's
//! `validateTargetFrame` refuses through JavaScript `.length` semantics (null throws, strings and `{length:0}` objects
//! pass the data-frame length check). `robo-work/tests/executionTarget/frameDescriptorParity.test.mjs` pins the same
//! cases against Node.

mod common;

use common::{load, text, unhex};
use rw_target_helper::canon::Value;
use rw_target_helper::frame::{self, Ancillary, ExpectedIds, FrameLimits, FrameState};

#[test]
fn frame_descriptor_values_refuse_exactly_as_in_node() {
    let transport = load(&common::crate_dir().join("tests/vectors/transport-v1.json"));
    let parity = load(&common::crate_dir().join("tests/vectors/frame-descriptor-parity.json"));
    let vector = &transport.get("frames").unwrap().arr().unwrap()[0];
    let ticket = transport.get("ticket").unwrap();
    let session_key = unhex(text(&transport, "sessionKeyHex"));
    let claims = text(ticket, "claimsCanonical").as_bytes().to_vec();
    let expected_values = ticket.get("expected").unwrap();
    let expected = ExpectedIds {
        lease_id: text(vector.get("header").unwrap(), "leaseId").into(),
        reservation_id: text(expected_values, "reservationId").into(),
        operation_id: text(expected_values, "operationId").into(),
        request_digest: text(expected_values, "requestDigest").into(),
    };
    let state = FrameState {
        direction: text(vector, "direction"),
        session_key: &session_key,
        claims_canonical: &claims,
        binding: ticket.get("claims").unwrap().get("binding").unwrap(),
        expected: &expected,
        channel_epoch: "1",
        next_sequence: "1",
        lease_active: true,
        ancillary: Ancillary { count: 0, truncated: false, well_formed: true, on_first_byte: true },
        channel_manifest: None,
        limits: FrameLimits::default(),
    };
    let body = unhex(text(vector, "bodyHex"));
    let cases = parity.get("cases").unwrap().arr().unwrap();
    assert!(cases.len() >= 10);
    for case in cases {
        let mut header = vector.get("header").unwrap().clone();
        if let Value::Obj(entries) = &mut header {
            entries.retain(|(key, _)| key != "bodyBytes" && key != "bodyDigest");
        }
        header.set("messageKind", case.get("messageKind").unwrap().clone());
        header.set("descriptors", case.get("descriptors").unwrap().clone());
        let encoded = frame::encode_frame(&header, &body, &session_key, &claims, FrameLimits::default()).unwrap();
        let result = match frame::validate_target_frame(&encoded, &state) {
            Ok(_) => "ok".to_string(),
            Err(code) => code.as_str().to_string(),
        };
        assert_eq!(result, text(case, "expected"), "{}", text(case, "name"));
    }
}
