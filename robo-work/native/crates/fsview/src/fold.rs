//! The protected-name fold (plan section 5.4; review R4-4).
//!
//! `fold_path_name` is Ploinky's `foldPathName` as copied into `robo-work/server/views/protectedNames.mjs`:
//! `String(name).normalize('NFKC').toLowerCase().replace(/[. ]+$/, '')`. `fold_ignorable_stripped` is that module's
//! hardening layer (strip Default_Ignorable_Code_Point, fold, twice).
//!
//! Unicode version pin (R4-4 item 4). NFKC and Default_Ignorable use tables generated from Node's ICU at Unicode 17.0 /
//! ICU 78.2 (`unicode_tables.rs`, `scripts/gen-unicode-tables.mjs`), the environment the shared vectors were generated
//! in. Lowercasing uses Rust std (`str::to_lowercase`, full mappings and Final_Sigma), whose tables are Unicode 17.0.0
//! in Rust 1.99.1. Tests check both versions and compare every code point and a 300 000-string seeded corpus with Node.

use crate::unicode_tables::{CCC_RANK, COMPOSE, DECOMP_DATA, DECOMP_INDEX, DEFAULT_IGNORABLE};

const S_BASE: u32 = 0xAC00;
const L_BASE: u32 = 0x1100;
const V_BASE: u32 = 0x1161;
const T_BASE: u32 = 0x11A7;
const L_COUNT: u32 = 19;
const V_COUNT: u32 = 21;
const T_COUNT: u32 = 28;
const N_COUNT: u32 = V_COUNT * T_COUNT;
const S_COUNT: u32 = L_COUNT * N_COUNT;

fn ccc_rank(cp: u32) -> u8 {
    match CCC_RANK.binary_search_by_key(&cp, |entry| entry.0) {
        Ok(index) => CCC_RANK[index].1,
        Err(_) => 0,
    }
}

fn decompose_into(cp: u32, out: &mut Vec<u32>) {
    if (S_BASE..S_BASE + S_COUNT).contains(&cp) {
        let index = cp - S_BASE;
        out.push(L_BASE + index / N_COUNT);
        out.push(V_BASE + (index % N_COUNT) / T_COUNT);
        let trailing = index % T_COUNT;
        if trailing != 0 {
            out.push(T_BASE + trailing);
        }
        return;
    }
    match DECOMP_INDEX.binary_search_by_key(&cp, |entry| entry.0) {
        Ok(index) => {
            let (_, offset, length) = DECOMP_INDEX[index];
            out.extend_from_slice(&DECOMP_DATA[offset as usize..offset as usize + length as usize]);
        }
        Err(_) => out.push(cp),
    }
}

fn compose_pair(left: u32, right: u32) -> Option<u32> {
    // Hangul LV and LVT.
    if (L_BASE..L_BASE + L_COUNT).contains(&left) && (V_BASE..V_BASE + V_COUNT).contains(&right) {
        return Some(S_BASE + ((left - L_BASE) * V_COUNT + (right - V_BASE)) * T_COUNT);
    }
    if (S_BASE..S_BASE + S_COUNT).contains(&left) && (left - S_BASE) % T_COUNT == 0 && (T_BASE + 1..T_BASE + T_COUNT).contains(&right) {
        return Some(left + (right - T_BASE));
    }
    COMPOSE.binary_search_by(|entry| (entry.0, entry.1).cmp(&(left, right))).ok().map(|index| COMPOSE[index].2)
}

/// Unicode Normalization Form KC (UAX #15): full compatibility decomposition, canonical ordering, canonical composition.
pub fn nfkc(text: &str) -> String {
    let mut decomposed: Vec<u32> = Vec::with_capacity(text.len());
    for character in text.chars() {
        decompose_into(character as u32, &mut decomposed);
    }
    // Canonical ordering: a stable sort of each run of non-starters by combining class.
    let mut index = 0;
    while index < decomposed.len() {
        if ccc_rank(decomposed[index]) == 0 {
            index += 1;
            continue;
        }
        let start = index;
        while index < decomposed.len() && ccc_rank(decomposed[index]) != 0 {
            index += 1;
        }
        decomposed[start..index].sort_by_key(|cp| ccc_rank(*cp));
    }
    // Canonical composition.
    let mut out: Vec<u32> = Vec::with_capacity(decomposed.len());
    let mut starter: Option<usize> = None;
    let mut last_class: u8 = 0;
    for cp in decomposed {
        let class = ccc_rank(cp);
        if let Some(position) = starter {
            let intervening = out.len() > position + 1;
            let blocked = intervening && (last_class == 0 || last_class >= class);
            if !blocked {
                if let Some(composite) = compose_pair(out[position], cp) {
                    out[position] = composite;
                    continue;
                }
            }
        }
        if class == 0 {
            starter = Some(out.len());
        }
        last_class = class;
        out.push(cp);
    }
    out.into_iter().map(|cp| char::from_u32(cp).expect("tables hold scalar values only")).collect()
}

pub fn is_default_ignorable(character: char) -> bool {
    let cp = character as u32;
    DEFAULT_IGNORABLE
        .binary_search_by(|&(low, high)| if high < cp { std::cmp::Ordering::Less } else if low > cp { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal })
        .is_ok()
}

/// `foldPathName(name)`.
pub fn fold_path_name(name: &str) -> String {
    let lowered = nfkc(name).to_lowercase();
    lowered.trim_end_matches(['.', ' ']).to_string()
}

/// `foldIgnorableStripped(name)`: strip default-ignorable code points and fold, twice (NFKC can itself produce a
/// default-ignorable code point: U+FFA0 becomes U+3164).
pub fn fold_ignorable_stripped(name: &str) -> String {
    let mut value = name.to_string();
    for _ in 0..2 {
        let stripped: String = value.chars().filter(|character| !is_default_ignorable(*character)).collect();
        value = fold_path_name(&stripped);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_pins() {
        assert_eq!(crate::unicode_tables::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(char::UNICODE_VERSION, (17, 0, 0), "std lowercasing must use the vectors' Unicode version");
    }

    #[test]
    fn known_cases() {
        assert_eq!(fold_path_name(".ploin\u{212A}y"), ".ploinky");
        assert_eq!(fold_path_name("\u{FF0E}data"), ".data");
        assert_eq!(fold_path_name(".data. ."), ".data");
        assert_eq!(nfkc("e\u{301}"), "\u{E9}");
        assert_eq!(nfkc("\u{1E9B}\u{323}"), "\u{1E69}");
        assert_eq!(nfkc("\u{FB01}"), "fi");
        assert_eq!(nfkc("\u{1100}\u{1161}\u{11A8}"), "\u{AC01}");
        assert_eq!(nfkc("a\u{323}\u{302}"), "\u{1EAD}");
        assert_eq!(nfkc("a\u{302}\u{323}"), "\u{1EAD}");
        assert_eq!(fold_ignorable_stripped(".e\u{200C}nv"), ".env");
        assert_eq!(fold_path_name(".e\u{200C}nv"), ".e\u{200C}nv");
        assert_eq!(fold_ignorable_stripped("\u{FFA0}.env"), ".env");
        assert!(is_default_ignorable('\u{AD}'));
        assert!(!is_default_ignorable('a'));
    }
}
