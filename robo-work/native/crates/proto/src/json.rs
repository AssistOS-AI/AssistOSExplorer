//! Strict, bounded JSON for the keeper's frame channel.
//!
//! The Node side encodes with `JSON.stringify` and decodes with `JSON.parse` (execution/frameCodec.mjs). This module
//! accepts every document those produce for the frozen frame shapes and is stricter in the following ways, all of
//! which refuse input that Node would accept and none of which accepts anything Node would refuse:
//!
//! | Input | Node | Here |
//! |---|---|---|
//! | Invalid UTF-8 in the payload | `toString('utf8')` substitutes U+FFFD | refused (`InvalidUtf8`) |
//! | A `\uXXXX` escape that leaves a lone surrogate | accepted | refused (`LoneSurrogate`) |
//! | A duplicate object key | the last value wins | refused (`DuplicateKey`) |
//! | Nesting deeper than `MAX_DEPTH` | accepted | refused (`TooDeep`) |
//!
//! Numbers are parsed with the JSON grammar and converted with Rust's correctly rounded `f64` parser, which gives the
//! same double as `JSON.parse`. Validators then apply `Number.isSafeInteger` semantics through [`Value::as_safe_int`].
//!
//! The serializer reproduces `JSON.stringify` for the values this crate emits: objects keep insertion order, strings
//! escape exactly `"`, `\`, `\b`, `\f`, `\n`, `\r`, `\t` and other C0 controls as lowercase `\u00xx`, and numbers are
//! safe integers printed in decimal.

use std::fmt::Write as _;

/// Maximum nesting depth of arrays and objects. The frozen frames nest at most three levels.
pub const MAX_DEPTH: usize = 16;

/// 2^53 - 1, `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    /// Insertion order is kept; keys are unique (duplicates are refused while parsing).
    Object(Vec<(String, Value)>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonError {
    InvalidUtf8,
    UnexpectedEnd,
    UnexpectedByte,
    TrailingData,
    BadNumber,
    BadEscape,
    LoneSurrogate,
    ControlInString,
    DuplicateKey,
    TooDeep,
}

impl Value {
    pub fn as_object(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?.iter().find(|(name, _)| name == key).map(|(_, value)| value)
    }

    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(flag) => Some(*flag),
            _ => None,
        }
    }

    /// `Number.isSafeInteger(value) ? value : undefined`.
    pub fn as_safe_int(&self) -> Option<i64> {
        match self {
            Value::Number(number) => safe_int(*number),
            _ => None,
        }
    }

    /// `Object.keys(value).sort().join(',')`. JavaScript sorts by UTF-16 code units, which is what this does.
    pub fn sorted_keys(&self) -> Option<String> {
        let entries = self.as_object()?;
        let mut keys: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        Some(keys.join(","))
    }

    pub fn is_plain_object(&self) -> bool {
        matches!(self, Value::Object(_))
    }
}

/// `Number.isSafeInteger` on a double.
pub fn safe_int(number: f64) -> Option<i64> {
    if !number.is_finite() || number.trunc() != number || number.abs() > MAX_SAFE_INTEGER as f64 {
        return None;
    }
    // Exact: |number| <= 2^53 - 1. `-0.0` becomes 0, as in JavaScript.
    Some(number as i64)
}

/// Parses one JSON document from UTF-8 bytes.
pub fn parse(bytes: &[u8]) -> Result<Value, JsonError> {
    let text = std::str::from_utf8(bytes).map_err(|_| JsonError::InvalidUtf8)?;
    let mut parser = Parser { bytes: text.as_bytes(), text, pos: 0 };
    parser.skip_ws();
    let value = parser.value(0)?;
    parser.skip_ws();
    if parser.pos != parser.bytes.len() {
        return Err(JsonError::TrailingData);
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    pos: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    // JSON whitespace is exactly tab, line feed, carriage return and space (ECMA-404), as in JSON.parse.
    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect_literal(&mut self, literal: &[u8]) -> Result<(), JsonError> {
        let end = self.pos + literal.len();
        if end > self.bytes.len() {
            return Err(JsonError::UnexpectedEnd);
        }
        if &self.bytes[self.pos..end] != literal {
            return Err(JsonError::UnexpectedByte);
        }
        self.pos = end;
        Ok(())
    }

    fn value(&mut self, depth: usize) -> Result<Value, JsonError> {
        match self.peek() {
            None => Err(JsonError::UnexpectedEnd),
            Some(b'n') => self.expect_literal(b"null").map(|()| Value::Null),
            Some(b't') => self.expect_literal(b"true").map(|()| Value::Bool(true)),
            Some(b'f') => self.expect_literal(b"false").map(|()| Value::Bool(false)),
            Some(b'"') => self.string().map(Value::String),
            Some(b'[') => self.array(depth + 1),
            Some(b'{') => self.object(depth + 1),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(JsonError::UnexpectedByte),
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, JsonError> {
        if depth > MAX_DEPTH {
            return Err(JsonError::TooDeep);
        }
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value(depth)?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Array(items));
                }
                None => return Err(JsonError::UnexpectedEnd),
                Some(_) => return Err(JsonError::UnexpectedByte),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, JsonError> {
        if depth > MAX_DEPTH {
            return Err(JsonError::TooDeep);
        }
        self.pos += 1;
        let mut entries: Vec<(String, Value)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(entries));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(if self.peek().is_none() { JsonError::UnexpectedEnd } else { JsonError::UnexpectedByte });
            }
            let key = self.string()?;
            self.skip_ws();
            match self.peek() {
                Some(b':') => self.pos += 1,
                None => return Err(JsonError::UnexpectedEnd),
                Some(_) => return Err(JsonError::UnexpectedByte),
            }
            self.skip_ws();
            let value = self.value(depth)?;
            if entries.iter().any(|(name, _)| *name == key) {
                return Err(JsonError::DuplicateKey);
            }
            entries.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Object(entries));
                }
                None => return Err(JsonError::UnexpectedEnd),
                Some(_) => return Err(JsonError::UnexpectedByte),
            }
        }
    }

    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(JsonError::BadNumber),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(JsonError::BadNumber);
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(JsonError::BadNumber);
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let literal = &self.text[start..self.pos];
        let number: f64 = literal.parse().map_err(|_| JsonError::BadNumber)?;
        Ok(Value::Number(number))
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let end = self.pos + 4;
        if end > self.bytes.len() {
            return Err(JsonError::UnexpectedEnd);
        }
        let mut value = 0u32;
        for &byte in &self.bytes[self.pos..end] {
            let digit = (byte as char).to_digit(16).ok_or(JsonError::BadEscape)?;
            value = value * 16 + digit;
        }
        self.pos = end;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let start = self.pos;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            // The run is valid UTF-8: the input is a &str and the run ends at an ASCII byte or at the end.
            out.push_str(&self.text[start..self.pos]);
            match self.peek() {
                None => return Err(JsonError::UnexpectedEnd),
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let escape = self.peek().ok_or(JsonError::UnexpectedEnd)?;
                    self.pos += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let first = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&first) {
                                if self.bytes.get(self.pos..self.pos + 2) != Some(b"\\u".as_slice()) {
                                    return Err(JsonError::LoneSurrogate);
                                }
                                self.pos += 2;
                                let second = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&second) {
                                    return Err(JsonError::LoneSurrogate);
                                }
                                0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&first) {
                                return Err(JsonError::LoneSurrogate);
                            } else {
                                first
                            };
                            out.push(char::from_u32(code).ok_or(JsonError::BadEscape)?);
                        }
                        _ => return Err(JsonError::BadEscape),
                    }
                }
                Some(_) => return Err(JsonError::ControlInString),
            }
        }
    }
}

/// `JSON.stringify(value)` for the values this crate emits.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => match safe_int(*number) {
            Some(integer) => {
                let _ = write!(out, "{integer}");
            }
            // Not emitted by this crate; JSON.stringify writes null for non-finite numbers.
            None if !number.is_finite() => out.push_str("null"),
            None => {
                let _ = write!(out, "{number}");
            }
        },
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(entries) => {
            out.push('{');
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

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
            control if (control as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", control as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

/// Small builder helpers for reply objects.
pub fn obj(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

pub fn int(value: i64) -> Value {
    Value::Number(value as f64)
}

pub fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_round_trips_frame_shapes() {
        let source = br#"{"id":7,"op":"view_root_lease","grantId":"g1","epoch":2,"verdict":"renew","ttlMs":3000}"#;
        let value = parse(source).unwrap();
        assert_eq!(value.get("id").unwrap().as_safe_int(), Some(7));
        assert_eq!(value.sorted_keys().unwrap(), "epoch,grantId,id,op,ttlMs,verdict");
        assert_eq!(stringify(&value).as_bytes(), source);
    }

    #[test]
    fn number_semantics_follow_json_parse_and_is_safe_integer() {
        assert_eq!(parse(b"1.0").unwrap().as_safe_int(), Some(1));
        assert_eq!(parse(b"1e3").unwrap().as_safe_int(), Some(1000));
        assert_eq!(parse(b"-0").unwrap().as_safe_int(), Some(0));
        assert_eq!(parse(b"9007199254740991").unwrap().as_safe_int(), Some(MAX_SAFE_INTEGER));
        assert_eq!(parse(b"9007199254740992").unwrap().as_safe_int(), None);
        assert_eq!(parse(b"1.5").unwrap().as_safe_int(), None);
        assert_eq!(parse(b"1e400").unwrap().as_safe_int(), None);
        for bad in [&b"01"[..], b"1.", b".5", b"+1", b"1e", b"--1", b"0x10", b"NaN", b"Infinity"] {
            assert!(parse(bad).is_err(), "{:?}", std::str::from_utf8(bad));
        }
    }

    #[test]
    fn strictness_beyond_json_parse_is_refusal_only() {
        assert_eq!(parse(br#"{"a":1,"a":2}"#), Err(JsonError::DuplicateKey));
        assert_eq!(parse(br#""\ud800""#), Err(JsonError::LoneSurrogate));
        assert_eq!(parse(br#""\udc00""#), Err(JsonError::LoneSurrogate));
        assert_eq!(parse(b"\"\xff\""), Err(JsonError::InvalidUtf8));
        assert_eq!(parse(b"\"\\ud83d\\ude00\""), Ok(Value::String("\u{1F600}".into())));
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
        assert_eq!(parse(deep.as_bytes()), Err(JsonError::TooDeep));
        let ok = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(parse(ok.as_bytes()).is_ok());
    }

    #[test]
    fn grammar_errors() {
        for bad in [&b""[..], b" ", b"{", b"{\"a\"}", b"{\"a\":}", b"[1,]", b"{\"a\":1,}", b"\"a", b"\"\t\"", b"tru", b"nul", b"{} x", b"\xef\xbb\xbf{}"] {
            assert!(parse(bad).is_err(), "{:?}", String::from_utf8_lossy(bad));
        }
        assert!(parse(b" \t\r\n{} \n").is_ok());
    }

    #[test]
    fn stringify_matches_json_stringify_escapes() {
        let value = Value::String("a\"b\\c\u{8}\u{c}\n\r\t\u{1}\u{1f}/\u{7f}é\u{2028}".into());
        assert_eq!(stringify(&value), "\"a\\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\\u001f/\u{7f}é\u{2028}\"");
    }

    #[test]
    fn sorted_keys_uses_utf16_order() {
        // U+FF5E sorts before U+1F600 in UTF-16 (0xFF5E < 0xD83D is false; 0xD83D < 0xFF5E), JavaScript order.
        let value = Value::Object(vec![("\u{FF5E}".into(), Value::Null), ("\u{1F600}".into(), Value::Null)]);
        assert_eq!(value.sorted_keys().unwrap(), "\u{1F600},\u{FF5E}");
    }
}
