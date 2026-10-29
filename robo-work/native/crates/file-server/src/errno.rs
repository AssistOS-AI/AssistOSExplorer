//! errno names <-> numbers for the engine's string codes (Linux only; the engine and the policy use names).

macro_rules! table {
    ($($name:ident),* $(,)?) => {
        pub fn errno_name(value: i32) -> &'static str {
            match value { $(libc::$name => stringify!($name),)* _ => "EIO" }
        }
        pub fn errno_value(name: &str) -> i32 {
            match name { $(stringify!($name) => libc::$name,)* _ => libc::EIO }
        }
    };
}

table!(
    EPERM, ENOENT, EIO, EBADF, EAGAIN, ENOMEM, EACCES, EBUSY, EEXIST, EXDEV, ENODEV, ENOTDIR, EISDIR, EINVAL, ENFILE, EMFILE,
    ETXTBSY, EFBIG, ENOSPC, ESPIPE, EROFS, EMLINK, ERANGE, ENAMETOOLONG, ENOSYS, ENOTEMPTY, ELOOP, ENOTSUP, ESTALE, EDQUOT,
    ENOTTY, EOVERFLOW, EINTR, ENXIO, EFAULT, ENOTCONN,
);
