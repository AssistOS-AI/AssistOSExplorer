//! Canonical target JSON (T0 base section 2), a port of `contract.mjs` `encode` and `StrictParser`.
//!
//! Numbers are JSON safe integers only (no float, `-0`, exponent or fraction). Object keys are ASCII and sorted; strings
//! use exactly the `JSON.stringify` escapes. The strict parser refuses any text that differs from the canonical encoding
//! of the value it parsed, and mirrors the Node module's left-to-right refusal order and codes:
//!
//! | Input | Code |
//! |---|---|
//! | Text over the byte bound | `capacity_exceeded` |
//! | BOM, invalid UTF-8, syntax error, duplicate key, lone surrogate, any non-canonical spelling | `noncanonical_encoding` |
//! | Fraction, exponent, `-0`, unsafe integer, nesting deeper than 16 | `invalid_request` |

use crate::Code;
use crate::crypto::sha256_hex;

pub const MAX_NESTING: usize = 16;
/// The global object bound (64 KiB).
pub const OBJECT_BYTES: usize = 65536;
/// Receipts and start outcomes are bounded at 256 KiB (contract.mjs `RECEIPT_BYTES`).
pub const RECEIPT_BYTES: usize = 256 * 1024;
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// A JSON value. Objects keep insertion order; parsing refuses duplicate keys and builders must not create them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn str(&self) -> Option<&str> {
        match self {
            Value::Str(text) => Some(text),
            _ => None,
        }
    }

    /// The string at `key`, if it is one.
    pub fn str_at(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::str)
    }

    pub fn int(&self) -> Option<i64> {
        match self {
            Value::Int(number) => Some(*number),
            _ => None,
        }
    }

    pub fn bool(&self) -> Option<bool> {
        match self {
            Value::Bool(flag) => Some(*flag),
            _ => None,
        }
    }

    pub fn arr(&self) -> Option<&[Value]> {
        match self {
            Value::Arr(items) => Some(items),
            _ => None,
        }
    }

    pub fn obj(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Obj(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn is_obj(&self) -> bool {
        matches!(self, Value::Obj(_))
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// Exactly these keys, in any order (`Object.keys(value).length === keys.length && keys.every(hasOwn)`).
    pub fn has_exact_keys(&self, keys: &[&str]) -> bool {
        match self {
            Value::Obj(entries) => entries.len() == keys.len() && keys.iter().all(|key| self.has(key)),
            _ => false,
        }
    }

    /// Sets or inserts `key` (builders only).
    pub fn set(&mut self, key: &str, value: Value) {
        if let Value::Obj(entries) = self {
            if let Some(slot) = entries.iter_mut().find(|(name, _)| name == key) {
                slot.1 = value;
            } else {
                entries.push((key.to_string(), value));
            }
        }
    }
}

pub fn s(text: &str) -> Value {
    Value::Str(text.to_string())
}

pub fn obj(entries: Vec<(&str, Value)>) -> Value {
    Value::Obj(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

fn encode_into(out: &mut String, value: &Value, depth: usize) -> Result<(), Code> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Int(number) => {
            if number.abs() > MAX_SAFE {
                return Err(Code::InvalidRequest);
            }
            out.push_str(&number.to_string());
        }
        Value::Str(text) => write_string(out, text),
        Value::Arr(items) => {
            if depth + 1 > MAX_NESTING {
                return Err(Code::InvalidRequest);
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                encode_into(out, item, depth + 1)?;
            }
            out.push(']');
        }
        Value::Obj(entries) => {
            if depth + 1 > MAX_NESTING {
                return Err(Code::InvalidRequest);
            }
            if entries.iter().any(|(key, _)| !key.is_ascii()) {
                return Err(Code::NoncanonicalEncoding);
            }
            let mut sorted: Vec<&(String, Value)> = entries.iter().collect();
            // ASCII keys: byte order equals JavaScript's UTF-16 code-unit sort.
            sorted.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            out.push('{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                encode_into(out, item, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// `JSON.stringify` string escaping for a well-formed string.
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
}

/// Canonical text with the byte bound (`canonicalText` / `encodeBounded`).
pub fn canonical(value: &Value, max_bytes: usize) -> Result<String, Code> {
    let mut out = String::new();
    encode_into(&mut out, value, 0)?;
    if out.len() > max_bytes {
        return Err(Code::CapacityExceeded);
    }
    Ok(out)
}

/// Canonical text with the default 64 KiB bound.
pub fn canonical_text(value: &Value) -> Result<String, Code> {
    canonical(value, OBJECT_BYTES)
}

/// `digestOf`: lowercase hex SHA-256 of the canonical UTF-8 bytes.
pub fn digest(value: &Value, max_bytes: usize) -> Result<String, Code> {
    Ok(sha256_hex(canonical(value, max_bytes)?.as_bytes()))
}

pub fn digest_of(value: &Value) -> Result<String, Code> {
    digest(value, OBJECT_BYTES)
}

/// `parseCanonicalTargetJson` over UTF-8 bytes with a byte bound.
pub fn parse_canonical(bytes: &[u8], max_bytes: usize) -> Result<Value, Code> {
    if bytes.len() > max_bytes {
        return Err(Code::CapacityExceeded);
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(Code::NoncanonicalEncoding);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Code::NoncanonicalEncoding)?;
    let mut parser = Parser { text, pos: 0 };
    parser.skip_space();
    let value = parser.value(0)?;
    parser.skip_space();
    if parser.pos != text.len() {
        return Err(Code::NoncanonicalEncoding);
    }
    let mut encoded = String::new();
    encode_into(&mut encoded, &value, 0)?;
    if encoded != text {
        return Err(Code::NoncanonicalEncoding);
    }
    Ok(value)
}

struct Parser<'a> {
    text: &'a str,
    pos: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, Code> {
        match self.peek() {
            Some(b'{') => self.object(depth + 1),
            Some(b'[') => self.array(depth + 1),
            Some(b'"') => self.string().map(Value::Str),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => {
                for (literal, value) in [("true", Value::Bool(true)), ("false", Value::Bool(false)), ("null", Value::Null)] {
                    if self.text[self.pos..].starts_with(literal) {
                        self.pos += literal.len();
                        return Ok(value);
                    }
                }
                Err(Code::NoncanonicalEncoding)
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, Code> {
        if depth > MAX_NESTING {
            return Err(Code::InvalidRequest);
        }
        self.pos += 1;
        let mut entries: Vec<(String, Value)> = Vec::new();
        self.skip_space();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Obj(entries));
        }
        loop {
            self.skip_space();
            if self.peek() != Some(b'"') {
                return Err(Code::NoncanonicalEncoding);
            }
            let key = self.string()?;
            if entries.iter().any(|(name, _)| *name == key) {
                return Err(Code::NoncanonicalEncoding);
            }
            self.skip_space();
            if self.peek() != Some(b':') {
                return Err(Code::NoncanonicalEncoding);
            }
            self.pos += 1;
            self.skip_space();
            let value = self.value(depth)?;
            entries.push((key, value));
            self.skip_space();
            let next = self.peek();
            self.pos += 1;
            match next {
                Some(b'}') => return Ok(Value::Obj(entries)),
                Some(b',') => {}
                _ => return Err(Code::NoncanonicalEncoding),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, Code> {
        if depth > MAX_NESTING {
            return Err(Code::InvalidRequest);
        }
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_space();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Arr(items));
        }
        loop {
            self.skip_space();
            items.push(self.value(depth)?);
            self.skip_space();
            let next = self.peek();
            self.pos += 1;
            match next {
                Some(b']') => return Ok(Value::Arr(items)),
                Some(b',') => {}
                _ => return Err(Code::NoncanonicalEncoding),
            }
        }
    }

    /// Collects UTF-16 code units as JavaScript does, then requires a well-formed result.
    fn string(&mut self) -> Result<String, Code> {
        self.pos += 1;
        let mut units: Vec<u16> = Vec::new();
        loop {
            let Some(character) = self.text[self.pos..].chars().next() else {
                return Err(Code::NoncanonicalEncoding);
            };
            if character == '"' {
                self.pos += 1;
                break;
            }
            if (character as u32) < 0x20 {
                return Err(Code::NoncanonicalEncoding);
            }
            if character != '\\' {
                let mut buffer = [0u16; 2];
                units.extend_from_slice(character.encode_utf16(&mut buffer));
                self.pos += character.len_utf8();
                continue;
            }
            let escape = self.text.as_bytes().get(self.pos + 1).copied();
            let simple = match escape {
                Some(b'"') => Some(b'"'),
                Some(b'\\') => Some(b'\\'),
                Some(b'/') => Some(b'/'),
                Some(b'b') => Some(8),
                Some(b'f') => Some(12),
                Some(b'n') => Some(b'\n'),
                Some(b'r') => Some(b'\r'),
                Some(b't') => Some(b'\t'),
                _ => None,
            };
            if let Some(unit) = simple {
                units.push(unit as u16);
                self.pos += 2;
            } else if escape == Some(b'u') {
                let hex = self.text.as_bytes().get(self.pos + 2..self.pos + 6).ok_or(Code::NoncanonicalEncoding)?;
                if !hex.iter().all(u8::is_ascii_hexdigit) {
                    return Err(Code::NoncanonicalEncoding);
                }
                let unit = u16::from_str_radix(std::str::from_utf8(hex).map_err(|_| Code::NoncanonicalEncoding)?, 16)
                    .map_err(|_| Code::NoncanonicalEncoding)?;
                units.push(unit);
                self.pos += 6;
            } else {
                return Err(Code::NoncanonicalEncoding);
            }
        }
        String::from_utf16(&units).map_err(|_| Code::NoncanonicalEncoding)
    }

    /// `/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/`, then fraction/exponent, `-0` and safety refuse.
    fn number(&mut self) -> Result<Value, Code> {
        let bytes = self.text.as_bytes();
        let start = self.pos;
        let mut end = start;
        if bytes.get(end) == Some(&b'-') {
            end += 1;
        }
        match bytes.get(end) {
            Some(b'0') => end += 1,
            Some(b'1'..=b'9') => {
                while matches!(bytes.get(end), Some(b'0'..=b'9')) {
                    end += 1;
                }
            }
            _ => return Err(Code::NoncanonicalEncoding),
        }
        let integer_end = end;
        let mut fraction = false;
        if bytes.get(end) == Some(&b'.') && matches!(bytes.get(end + 1), Some(b'0'..=b'9')) {
            end += 1;
            while matches!(bytes.get(end), Some(b'0'..=b'9')) {
                end += 1;
            }
            fraction = true;
        }
        let mut exponent = false;
        if matches!(bytes.get(end), Some(b'e' | b'E')) {
            let mut probe = end + 1;
            if matches!(bytes.get(probe), Some(b'+' | b'-')) {
                probe += 1;
            }
            if matches!(bytes.get(probe), Some(b'0'..=b'9')) {
                while matches!(bytes.get(probe), Some(b'0'..=b'9')) {
                    probe += 1;
                }
                end = probe;
                exponent = true;
            }
        }
        self.pos = end;
        if fraction || exponent {
            return Err(Code::InvalidRequest);
        }
        let literal = &self.text[start..integer_end];
        if literal == "-0" {
            return Err(Code::InvalidRequest);
        }
        let digits = literal.trim_start_matches('-');
        // 9007199254740991 has 16 digits; longer literals are never safe.
        if digits.len() > 16 {
            return Err(Code::InvalidRequest);
        }
        let magnitude: i64 = digits.parse().map_err(|_| Code::InvalidRequest)?;
        if magnitude > MAX_SAFE {
            return Err(Code::InvalidRequest);
        }
        Ok(Value::Int(if literal.starts_with('-') { -magnitude } else { magnitude }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Value, Code> {
        parse_canonical(text.as_bytes(), OBJECT_BYTES)
    }

    #[test]
    fn canonical_round_trip_and_sorting() {
        let value = obj(vec![("b", Value::Int(2)), ("a", Value::Arr(vec![s("x"), Value::Null, Value::Bool(true)]))]);
        let text = canonical_text(&value).unwrap();
        assert_eq!(text, r#"{"a":["x",null,true],"b":2}"#);
        assert_eq!(parse(&text).unwrap(), obj(vec![("a", Value::Arr(vec![s("x"), Value::Null, Value::Bool(true)])), ("b", Value::Int(2))]));
        assert_eq!(canonical_text(&s("a\"\\\u{8}\u{c}\n\r\t\u{1}\u{7f}\u{2028}é")).unwrap(), "\"a\\\"\\\\\\b\\f\\n\\r\\t\\u0001\u{7f}\u{2028}é\"");
    }

    #[test]
    fn refusal_codes_follow_the_node_parser() {
        let noncanonical = [
            " {}", "{} ", "{\"b\":1,\"a\":2}", "{\"a\":1,\"a\":1}", "\"\\u0041\"", "\"\\/\"", "\"\\ud800\"", "\"\\udc00x\"", "[1,]",
            "{\"a\":1,}", "01", "1.", "'a'", "\u{feff}{}", "tru", "{\"a\" :1}", "\"\\U0041\"", "\"\t\"", "",
        ];
        for text in noncanonical {
            assert_eq!(parse(text), Err(Code::NoncanonicalEncoding), "{text:?}");
        }
        assert_eq!(parse_canonical(b"\xef\xbb\xbf{}", OBJECT_BYTES), Err(Code::NoncanonicalEncoding));
        assert_eq!(parse_canonical(b"\"\xff\"", OBJECT_BYTES), Err(Code::NoncanonicalEncoding));
        for text in ["1.0", "1e3", "1E+3", "-0", "9007199254740992", "-9007199254740992", "12345678901234567890", "[1.5,x]"] {
            assert_eq!(parse(text), Err(Code::InvalidRequest), "{text:?}");
        }
        assert_eq!(parse("9007199254740991").unwrap(), Value::Int(MAX_SAFE));
        assert_eq!(parse("-9007199254740991").unwrap(), Value::Int(-MAX_SAFE));
        let deep_ok = format!("{}{}", "[".repeat(16), "]".repeat(16));
        assert!(parse(&deep_ok).is_ok());
        let deep = format!("{}{}", "[".repeat(17), "]".repeat(17));
        assert_eq!(parse(&deep), Err(Code::InvalidRequest));
        assert_eq!(parse_canonical(b"[1,2]", 4), Err(Code::CapacityExceeded));
        // Left to right: a fraction before a later syntax error is invalid_request; a syntax error first wins.
        assert_eq!(parse("[1.5,}"), Err(Code::InvalidRequest));
        assert_eq!(parse("[},1.5]"), Err(Code::NoncanonicalEncoding));
        // Escaped controls are canonical only in lowercase \u00xx form.
        assert_eq!(parse("\"\\u0001\"").unwrap(), s("\u{1}"));
        assert_eq!(parse("\"\\u001F\""), Err(Code::NoncanonicalEncoding));
        assert_eq!(parse("\"\\ud83d\\ude00\""), Err(Code::NoncanonicalEncoding));
        assert_eq!(parse("\"\u{1F600}\"").unwrap(), s("\u{1F600}"));
    }

    #[test]
    fn encoder_refusals() {
        assert_eq!(canonical_text(&obj(vec![("é", Value::Null)])), Err(Code::NoncanonicalEncoding));
        assert_eq!(canonical_text(&Value::Int(MAX_SAFE + 1)), Err(Code::InvalidRequest));
        let mut deep = Value::Null;
        for _ in 0..17 {
            deep = Value::Arr(vec![deep]);
        }
        assert_eq!(canonical_text(&deep), Err(Code::InvalidRequest));
        assert_eq!(canonical(&s("abcd"), 5), Err(Code::CapacityExceeded));
        assert_eq!(canonical(&s("abc"), 5).unwrap(), "\"abc\"");
    }
}
