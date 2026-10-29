//! File-server argv (pure). The keeper's spawn layout fixes the descriptors: 3 is the `/dev/fuse` connection and 4 the
//! grant root (crates/keeper/src/linux/os.rs). PROVISIONAL with the keeper spawn layout.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerArgs {
    pub read_only: bool,
    pub descriptor_cap: usize,
    pub grant: String,
}

pub const FUSE_FD: i32 = 3;
pub const ROOT_FD: i32 = 4;

pub fn parse(argv: &[String]) -> Result<ServerArgs, String> {
    let (mut fuse, mut root, mut access, mut cap, mut grant) = (None, None, None, None, None);
    let mut index = 0;
    while index < argv.len() {
        let flag = argv[index].as_str();
        let value = argv.get(index + 1).ok_or_else(|| format!("{flag} needs a value"))?.as_str();
        match flag {
            "--fuse-fd" if fuse.is_none() => fuse = Some(value),
            "--root-fd" if root.is_none() => root = Some(value),
            "--access" if access.is_none() => access = Some(value),
            "--descriptor-cap" if cap.is_none() => cap = Some(value),
            "--grant" if grant.is_none() => grant = Some(value),
            other => return Err(format!("unknown or repeated flag: {other}")),
        }
        index += 2;
    }
    if fuse != Some("3") || root != Some("4") {
        return Err("the spawn layout is --fuse-fd 3 --root-fd 4".into());
    }
    let read_only = match access {
        Some("read") => true,
        Some("write") => false,
        _ => return Err("--access must be read or write".into()),
    };
    let descriptor_cap = cap.and_then(|text| text.parse::<usize>().ok()).filter(|cap| *cap > 0 && *cap <= 1 << 20).ok_or("bad --descriptor-cap")?;
    let grant = grant.filter(|grant| rw_proto_like_grant(grant)).ok_or("bad --grant")?.to_string();
    Ok(ServerArgs { read_only, descriptor_cap, grant })
}

fn rw_proto_like_grant(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.as_bytes()[0].is_ascii_lowercase() | value.as_bytes()[0].is_ascii_digit()
        && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn layout_and_values() {
        let good = args(&["--fuse-fd", "3", "--root-fd", "4", "--access", "read", "--descriptor-cap", "1024", "--grant", "app"]);
        assert_eq!(parse(&good).unwrap(), ServerArgs { read_only: true, descriptor_cap: 1024, grant: "app".into() });
        for (index, bad) in [(1, "5"), (3, "3"), (5, "rw"), (7, "0"), (9, "App")] {
            let mut broken = good.clone();
            broken[index] = bad.to_string();
            assert!(parse(&broken).is_err(), "{bad}");
        }
    }
}
