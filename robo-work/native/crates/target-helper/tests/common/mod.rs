//! Shared test helpers: lenient (JSON.parse-compatible) reading of the pretty-printed vector files into canonical values.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use rw_target_helper::canon::Value;

pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The robo-work directory (`native/crates/target-helper` -> `robo-work`).
pub fn robo_work_dir() -> PathBuf {
    crate_dir().join("../../..")
}

pub fn convert(value: &rw_proto::json::Value) -> Value {
    use rw_proto::json::Value as P;
    match value {
        P::Null => Value::Null,
        P::Bool(flag) => Value::Bool(*flag),
        P::Number(number) => Value::Int(rw_proto::json::safe_int(*number).expect("vector numbers are safe integers")),
        P::String(text) => Value::Str(text.clone()),
        P::Array(items) => Value::Arr(items.iter().map(convert).collect()),
        P::Object(entries) => Value::Obj(entries.iter().map(|(key, item)| (key.clone(), convert(item))).collect()),
    }
}

pub fn load(path: &Path) -> Value {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    convert(&rw_proto::json::parse(&bytes).expect("vector JSON"))
}

pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.str_at(key).unwrap_or_else(|| panic!("string field {key}"))
}

pub fn unhex(text: &str) -> Vec<u8> {
    rw_target_helper::crypto::unhex(text).expect("hex")
}

/// A fresh, empty directory under the target directory's temporary area, unique per test.
pub fn temp_dir(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let base = std::env::var_os("TMPDIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let path = base.join(format!("rw-th-{label}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&path).expect("temp dir");
    path
}

/// Like [`temp_dir`], but on a memory filesystem when one is available (`/dev/shm` on Linux), for write-heavy tests.
pub fn fast_temp_dir(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let shm = Path::new("/dev/shm");
    if shm.is_dir() {
        let path = shm.join(format!("rw-th-{label}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
        if std::fs::create_dir(&path).is_ok() {
            return path;
        }
    }
    temp_dir(label)
}

/// A raw JSON tree for fixture reading: numbers keep their text, nesting is unbounded, and a lone UTF-16 surrogate
/// escape becomes `lone_marker` (Rust strings cannot hold one). Test input only; never a protocol parser.
#[derive(Debug, Clone)]
pub enum Raw {
    Null,
    Bool(bool),
    Number(String),
    Str(String),
    Arr(Vec<Raw>),
    Obj(Vec<(String, Raw)>),
}

impl Raw {
    pub fn get(&self, key: &str) -> Option<&Raw> {
        match self {
            Raw::Obj(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }

    /// Converts to a canonical value; every number must be a safe integer.
    pub fn to_value(&self) -> Value {
        match self {
            Raw::Null => Value::Null,
            Raw::Bool(flag) => Value::Bool(*flag),
            Raw::Number(text) => Value::Int(text.parse().unwrap_or_else(|_| panic!("non-integer fixture number {text}"))),
            Raw::Str(text) => Value::Str(text.clone()),
            Raw::Arr(items) => Value::Arr(items.iter().map(Raw::to_value).collect()),
            Raw::Obj(entries) => Value::Obj(entries.iter().map(|(key, item)| (key.clone(), item.to_value())).collect()),
        }
    }
}

pub fn parse_raw(text: &str, lone_marker: &str) -> Raw {
    struct P<'a> {
        s: &'a [u8],
        i: usize,
        marker: &'a str,
    }
    impl P<'_> {
        fn ws(&mut self) {
            while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
                self.i += 1;
            }
        }
        fn eat(&mut self, byte: u8) {
            self.ws();
            assert_eq!(self.s.get(self.i), Some(&byte), "fixture JSON at {}", self.i);
            self.i += 1;
        }
        fn hex4(&mut self) -> u16 {
            let text = std::str::from_utf8(&self.s[self.i..self.i + 4]).unwrap();
            self.i += 4;
            u16::from_str_radix(text, 16).unwrap()
        }
        fn string(&mut self) -> String {
            self.eat(b'"');
            let mut out = String::new();
            loop {
                let byte = self.s[self.i];
                match byte {
                    b'"' => {
                        self.i += 1;
                        return out;
                    }
                    b'\\' => {
                        let escape = self.s[self.i + 1];
                        self.i += 2;
                        match escape {
                            b'n' => out.push('\n'),
                            b't' => out.push('\t'),
                            b'r' => out.push('\r'),
                            b'b' => out.push('\u{8}'),
                            b'f' => out.push('\u{c}'),
                            b'u' => {
                                let unit = self.hex4();
                                if (0xd800..0xdc00).contains(&unit) && self.s.get(self.i..self.i + 2) == Some(b"\\u".as_slice()) {
                                    let save = self.i;
                                    self.i += 2;
                                    let low = self.hex4();
                                    if (0xdc00..0xe000).contains(&low) {
                                        out.push(char::from_u32(0x10000 + ((unit as u32 - 0xd800) << 10) + (low as u32 - 0xdc00)).unwrap());
                                        continue;
                                    }
                                    self.i = save;
                                }
                                match char::from_u32(unit as u32) {
                                    Some(character) => out.push(character),
                                    None => out.push_str(self.marker),
                                }
                            }
                            other => out.push(other as char),
                        }
                    }
                    _ => {
                        let rest = std::str::from_utf8(&self.s[self.i..]).unwrap();
                        let character = rest.chars().next().unwrap();
                        out.push(character);
                        self.i += character.len_utf8();
                    }
                }
            }
        }
        fn value(&mut self) -> Raw {
            self.ws();
            match self.s[self.i] {
                b'{' => {
                    self.i += 1;
                    let mut entries = Vec::new();
                    self.ws();
                    if self.s[self.i] == b'}' {
                        self.i += 1;
                        return Raw::Obj(entries);
                    }
                    loop {
                        let key = self.string();
                        self.eat(b':');
                        entries.push((key, self.value()));
                        self.ws();
                        let next = self.s[self.i];
                        self.i += 1;
                        if next == b'}' {
                            return Raw::Obj(entries);
                        }
                        assert_eq!(next, b',');
                    }
                }
                b'[' => {
                    self.i += 1;
                    let mut items = Vec::new();
                    self.ws();
                    if self.s[self.i] == b']' {
                        self.i += 1;
                        return Raw::Arr(items);
                    }
                    loop {
                        items.push(self.value());
                        self.ws();
                        let next = self.s[self.i];
                        self.i += 1;
                        if next == b']' {
                            return Raw::Arr(items);
                        }
                        assert_eq!(next, b',');
                    }
                }
                b'"' => Raw::Str(self.string()),
                b't' => {
                    self.i += 4;
                    Raw::Bool(true)
                }
                b'f' => {
                    self.i += 5;
                    Raw::Bool(false)
                }
                b'n' => {
                    self.i += 4;
                    Raw::Null
                }
                _ => {
                    let start = self.i;
                    while self.i < self.s.len() && matches!(self.s[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                        self.i += 1;
                    }
                    Raw::Number(std::str::from_utf8(&self.s[start..self.i]).unwrap().to_string())
                }
            }
        }
    }
    let mut parser = P { s: text.as_bytes(), i: 0, marker: lone_marker };
    let value = parser.value();
    parser.ws();
    assert_eq!(parser.i, text.len(), "trailing fixture data");
    value
}
