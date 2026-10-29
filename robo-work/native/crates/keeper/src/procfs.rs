//! Pure parsers for the identity tuples the keeper commits (plan section 5.5, Commit row): a process's start time from
//! `/proc/<pid>/stat`, and a mount's ID from `/proc/self/mountinfo`.

/// Field 22 (`starttime`, clock ticks since boot) of `/proc/<pid>/stat`. The command name (field 2) is in parentheses
/// and may itself contain spaces and parentheses, so parsing starts after the LAST `)`.
pub fn start_time_from_stat(stat: &str) -> Option<u64> {
    let after = &stat[stat.rfind(')')? + 1..];
    // after = " S ppid pgrp ..." : field 3 is the first token, so starttime (field 22) is token index 19.
    after.split_ascii_whitespace().nth(19)?.parse().ok()
}

/// A whole `/proc/<pid>/stat` record (procView rule): the pid before ` (`, and the ppid and start time after the LAST
/// `)`. A record missing any of them, or with a non-numeric pid, is rejected as a whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatRecord {
    pub pid: i64,
    pub ppid: i64,
    pub start_time: u64,
}

pub fn parse_stat(line: &str) -> Option<StatRecord> {
    let pid_text = line.split(" (").next()?;
    if pid_text.is_empty() || !pid_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(StatRecord { pid: pid_text.parse().ok()?, ppid: ppid_from_stat(line)?, start_time: start_time_from_stat(line)? })
}

/// Parent pid (field 4) of `/proc/<pid>/stat`.
pub fn ppid_from_stat(stat: &str) -> Option<i64> {
    let after = &stat[stat.rfind(')')? + 1..];
    after.split_ascii_whitespace().nth(1)?.parse().ok()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountEntry {
    pub mount_id: i64,
    pub parent_id: i64,
    pub mountpoint: String,
    pub fstype: String,
    pub source: String,
}

/// mountinfo escapes space, tab, newline and backslash as `\040`, `\011`, `\012`, `\134`.
fn unescape(field: &str) -> Option<String> {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            let digits = field.get(index + 1..index + 4)?;
            out.push(u8::from_str_radix(digits, 8).ok()?);
            index += 4;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Parses `/proc/<pid>/mountinfo` (proc(5)): `id parent major:minor root mountpoint options [optional...] - fstype source super-options`.
pub fn parse_mountinfo(text: &str) -> Vec<MountEntry> {
    let mut entries = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split(' ').collect();
        let Some(separator) = fields.iter().position(|field| *field == "-") else { continue };
        if separator < 6 || fields.len() < separator + 3 {
            continue;
        }
        let (Ok(mount_id), Ok(parent_id)) = (fields[0].parse(), fields[1].parse()) else { continue };
        let (Some(mountpoint), Some(source)) = (unescape(fields[4]), unescape(fields[separator + 2])) else { continue };
        entries.push(MountEntry { mount_id, parent_id, mountpoint, fstype: fields[separator + 1].to_string(), source });
    }
    entries
}

/// Every mount at or below `path` (component-wise prefix). A runtime directory is removed only when this is empty:
/// a live view under it would otherwise be walked into (the contract's procView `remove('runtime-dir')` rule).
pub fn mounts_at_or_below<'a>(entries: &'a [MountEntry], path: &str) -> Vec<&'a MountEntry> {
    let prefix = format!("{}/", path.trim_end_matches('/'));
    entries.iter().filter(|entry| entry.mountpoint == path || entry.mountpoint.starts_with(&prefix)).collect()
}

/// The topmost (last listed) FUSE mount at `mountpoint`.
pub fn find_fuse_mount<'a>(entries: &'a [MountEntry], mountpoint: &str) -> Option<&'a MountEntry> {
    entries.iter().rev().find(|entry| entry.mountpoint == mountpoint && (entry.fstype == "fuse" || entry.fstype.starts_with("fuse.")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_with_hostile_comm() {
        let stat = "4242 (a) b (c) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000000 200 18446744073709551615";
        assert_eq!(start_time_from_stat(stat), Some(987654));
        assert_eq!(ppid_from_stat(stat), Some(1));
        assert_eq!(start_time_from_stat("garbage"), None);
        assert_eq!(start_time_from_stat("1 (x) S 0"), None);
    }

    #[test]
    fn mounts_below_a_runtime_directory() {
        let text = "22 1 0:21 / /run rw - tmpfs tmpfs rw\n\
                    812 22 0:63 / /run/robo-work/x/abc/views/app rw - fuse rw-fsview rw\n\
                    813 22 0:64 / /run/robo-work/x/abcd rw - tmpfs t rw\n";
        let entries = parse_mountinfo(text);
        let below = mounts_at_or_below(&entries, "/run/robo-work/x/abc");
        assert_eq!(below.len(), 1, "the live view is found; a sibling with a common string prefix is not");
        assert_eq!(below[0].mount_id, 812);
        assert!(mounts_at_or_below(&entries, "/run/robo-work/x/zzz").is_empty());
        // Negative control: a naive string-prefix test would also match the sibling /run/robo-work/x/abcd.
        assert_eq!(entries.iter().filter(|entry| entry.mountpoint.starts_with("/run/robo-work/x/abc")).count(), 2);
    }

    #[test]
    fn mountinfo_parsing_and_escapes() {
        let text = "22 1 0:21 / /run rw,nosuid shared:5 - tmpfs tmpfs rw\n\
                    812 22 0:63 / /run/robo-work/x/abcdef0123456789/views/my\\040app rw,nosuid,nodev - fuse rw-fsview rw,user_id=0\n\
                    813 22 0:64 / /run/robo-work/x/abcdef0123456789/views/my\\040app rw - fuse.other src rw\n\
                    bad line\n";
        let entries = parse_mountinfo(text);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[1].mountpoint, "/run/robo-work/x/abcdef0123456789/views/my app");
        let found = find_fuse_mount(&entries, "/run/robo-work/x/abcdef0123456789/views/my app").unwrap();
        assert_eq!(found.mount_id, 813, "the topmost mount wins");
        assert!(find_fuse_mount(&entries, "/run").is_none(), "not FUSE");
    }
}
