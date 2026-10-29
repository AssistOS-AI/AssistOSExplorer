//! The grant-name predicate of the filtered project view (plan sections 4.1 and 5.4, review R4-4).
//!
//! A port of `robo-work/server/views/protectedNames.mjs` (S5 r5). Protected names are the folded matches of `.ploinky`,
//! `.data`, `.ploinky-box`, `.roboteam` (the whole directory), `.env`, `master-key` and the `*.secrets` suffix, at any
//! depth, per component, with no `.ploinky/repos` exemption. The hardening layer (strip default-ignorable code points
//! before folding; design question D-S5-1) only ever adds refusals.
//!
//! Names arrive from the kernel as bytes. A name that is not valid UTF-8 is folded after lossy decoding (U+FFFD), which
//! is what Node's `Buffer#toString('utf8')` gives Explorer for the same entry. Validity and the component byte bound are
//! checked on the raw bytes.

use crate::fold::{fold_ignorable_stripped, fold_path_name};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameClass {
    ControllerState,
    AgentData,
    HostState,
    PrivateSession,
    KeyMaterial,
}

impl NameClass {
    pub fn as_str(self) -> &'static str {
        match self {
            NameClass::ControllerState => "controller_state",
            NameClass::AgentData => "agent_data",
            NameClass::HostState => "host_state",
            NameClass::PrivateSession => "private_session",
            NameClass::KeyMaterial => "key_material",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameLayer {
    PloinkyFold,
    DefaultIgnorable,
}

impl NameLayer {
    pub fn as_str(self) -> &'static str {
        match self {
            NameLayer::PloinkyFold => "ploinky-fold",
            NameLayer::DefaultIgnorable => "default-ignorable",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub class: NameClass,
    pub layer: NameLayer,
}

pub const SECRETS_SUFFIX: &str = ".secrets";

fn classify_folded(key: &str) -> Option<NameClass> {
    match key {
        ".ploinky" => Some(NameClass::ControllerState),
        ".data" => Some(NameClass::AgentData),
        ".ploinky-box" => Some(NameClass::HostState),
        ".roboteam" => Some(NameClass::PrivateSession),
        ".env" | "master-key" => Some(NameClass::KeyMaterial),
        _ if key.ends_with(SECRETS_SUFFIX) => Some(NameClass::KeyMaterial),
        _ => None,
    }
}

/// `classifyGrantName(name, { hardening })`.
pub fn classify_grant_name(name: &str, hardening: bool) -> Option<Verdict> {
    if let Some(class) = classify_folded(&fold_path_name(name)) {
        return Some(Verdict { class, layer: NameLayer::PloinkyFold });
    }
    if !hardening {
        return None;
    }
    classify_folded(&fold_ignorable_stripped(name)).map(|class| Verdict { class, layer: NameLayer::DefaultIgnorable })
}

pub fn classify_grant_name_bytes(name: &[u8], hardening: bool) -> Option<Verdict> {
    classify_grant_name(&String::from_utf8_lossy(name), hardening)
}

pub fn is_protected_name(name: &[u8], hardening: bool) -> bool {
    classify_grant_name_bytes(name, hardening).is_some()
}

/// `firstProtectedComponent(segments)`: (index, verdict) of the first protected component.
pub fn first_protected_component(segments: &[&str], hardening: bool) -> Option<(usize, Verdict)> {
    segments.iter().enumerate().find_map(|(index, segment)| classify_grant_name(segment, hardening).map(|verdict| (index, verdict)))
}

/// `isValidComponentName(name, maxComponentBytes)` on the raw bytes.
pub fn is_valid_component_name(name: &[u8], max_component_bytes: usize) -> bool {
    !name.is_empty() && name != b"." && name != b".." && !name.contains(&b'/') && !name.contains(&0) && name.len() <= max_component_bytes
}
