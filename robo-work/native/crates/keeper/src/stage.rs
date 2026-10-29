//! The gated pre-exec stage (plan section 5.5, "Create gated"): the keeper binary in `stage` mode, started by the one
//! bwrap invocation. It reads exactly one byte from the gate pipe: only the commit byte proceeds; end-of-file or any
//! other byte aborts (exit 125) before the final exec. On commit it reads the workload environment from its env
//! descriptor (never from its own environment: bwrap ran it with `--clearenv`), sets no_new_privs, verifies that all
//! five capability sets are empty, installs the domain seccomp filter and execs the final program by absolute path.
//!
//! PROVISIONAL / UNWIRED (pending keeper wire contract). The env-block format below is an internal interface.

/// Bound on the environment block.
pub const MAX_ENV_BYTES: usize = 64 * 1024;
pub const MAX_ENV_ENTRIES: usize = 64;
pub const EXIT_ABORTED: i32 = 125;

/// Parses a NUL-terminated list of `NAME=VALUE` entries. Names are `[A-Za-z_][A-Za-z0-9_]*`; duplicates refuse.
pub fn parse_env_block(block: &[u8]) -> Result<Vec<(String, String)>, &'static str> {
    if block.len() > MAX_ENV_BYTES {
        return Err("env_too_large");
    }
    if block.is_empty() {
        return Ok(Vec::new());
    }
    if *block.last().unwrap() != 0 {
        return Err("env_not_terminated");
    }
    let mut entries: Vec<(String, String)> = Vec::new();
    for raw in block[..block.len() - 1].split(|byte| *byte == 0) {
        let text = std::str::from_utf8(raw).map_err(|_| "env_not_utf8")?;
        let (name, value) = text.split_once('=').ok_or("env_entry_without_equals")?;
        let valid_name = !name.is_empty()
            && name.bytes().next().is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
            && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        if !valid_name {
            return Err("env_bad_name");
        }
        if entries.iter().any(|(existing, _)| existing == name) {
            return Err("env_duplicate");
        }
        entries.push((name.to_string(), value.to_string()));
        if entries.len() > MAX_ENV_ENTRIES {
            return Err("env_too_many");
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_block() {
        assert_eq!(parse_env_block(b"").unwrap(), vec![]);
        assert_eq!(parse_env_block(b"HOME=/home/robot\0LANG=C.UTF-8\0").unwrap(), vec![("HOME".into(), "/home/robot".into()), ("LANG".into(), "C.UTF-8".into())]);
        assert_eq!(parse_env_block(b"A=1=2\0").unwrap(), vec![("A".into(), "1=2".into())]);
        for (bad, code) in [(&b"A=1"[..], "env_not_terminated"), (b"=1\0", "env_bad_name"), (b"1A=1\0", "env_bad_name"),
            (b"A\0", "env_entry_without_equals"), (b"A=1\0A=2\0", "env_duplicate"), (b"A=\xff\0", "env_not_utf8")] {
            assert_eq!(parse_env_block(bad), Err(code));
        }
        assert_eq!(parse_env_block(&vec![b'a'; MAX_ENV_BYTES + 1]), Err("env_too_large"));
    }
}
