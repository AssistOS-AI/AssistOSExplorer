#!/bin/sh
# Fixed stage script (plan Revision 10, sections B and D). No robot input is interpolated into this text: everything
# arrives as arguments and is validated or quoted.
#
#   stage.sh prep <marker> <supervisor-pid> <grant-fds-csv> <bwrap-args-fd> <prep-spec> <keep-fds-csv> -- <bwrap-command> [args...]
#       First closes, in this shell, every fd >= 3 that is not in <keep-fds-csv> (M-65: the launcher's exact slot set; it must
#       contain the args fd and every grant fd), so that neither node prep nor bwrap ever holds a descriptor the worker
#       process leaked without close-on-exec (a robot's PTY master, for instance). Then runs `setpriv --pdeathsig KILL --
#       node sandboxPrep.mjs <marker> <prep-spec>` as a foreground child. Non-zero exit: exit with that code, before bwrap.
#       Exit 0: check $PPID is still the supervisor, close every grant fd, then exec bwrap with the marker on its real argv
#       and the command after `--` (matches bwrapArgs.mjs bwrapRealArgv: bwrap takes the command only from its real argv,
#       never from the --args buffer).
#   stage.sh final <fd-allow-csv> <env-names-csv> <command> [args...]
#       Closes every fd >= 3 not in the allowlist (found by listing /proc/self/fd) and execs the command under env -i with
#       exactly the named variables, whose VALUES come from the environment bwrap set (`--setenv` in the --args buffer), so
#       that no value is ever on a command line.
#
# Exit codes: 64 bad arguments, 70 parent changed, 71 exec failed, 72 a descriptor that must be closed cannot be (bash
# absent for an fd >= 10, or /proc/self/fd not listable); anything else is node prep's own exit code.
#
# M-65 scope of the fd closing. The processes BEFORE this script in the chain (setpriv, nsenter, unshare, all exec'd in turn
# in one process, fixed util-linux binaries running no robot input) still carry a leaked fd up to here; this shell is the
# first point that can close it (Node has no fcntl). The worker's own short-lived trusted helpers that the supervisor
# starts directly (ip, nft) may inherit such an fd as well: accepted, they run no robot input and never enter a sandbox.
# orchestration and endpoint do not pass through `final`: bwrap inherits exactly the keep set (0-2, role fds, seccomp,
# block, info, json-status, args), closes its own control fds before it execs the command (observed with bubblewrap
# 0.11.1), and the fdTrim.mjs preload closes anything else not in RW_FD_ALLOW, so the command keeps only its role fds.
set -u

# Each fd to close becomes an `N>&-` redirection of an exec, so the closing is one already-parsed command. dash parses only
# a single-digit fd in a redirection: when a fd >= 10 must be closed, the script re-execs itself once under /bin/bash
# (same pid, so $PPID is unchanged) and fails closed (exit 72) when bash is absent. (In the worker image /bin/sh is bash
# itself; the dash paths serve other hosts.)
numeric() { case $1 in ''|*[!0-9]*) return 1;; esac; }
needbash() { [ -z "${BASH_VERSION:-}" ] && [ ! -x /bin/bash ] && exit 72; }
# A csv of fd numbers: no empty element, digits only.
fdcsv() { case $1 in ''|,*|*,|*,,*|*[!0-9,]*) return 1;; esac; }
# True when fd $1 of this shell is close-on-exec (the octal flags line of /proc/self/fdinfo/<fd>; O_CLOEXEC is 02000000).
cloexec() {
    flags=
    while read -r key value; do
        [ "$key" = flags: ] && { flags=$value; break; }
    done < "/proc/self/fdinfo/$1" || return 1
    numeric "$flags" || return 1
    [ $(( 0$flags / 02000000 % 2 )) -eq 1 ]
}
# Sets $redirs to the `N>&-` redirections of every open fd >= 3 that is not in the csv $1, and $big=1 when one is >= 10.
# The listing must come from this shell itself (no command substitution). The glob's own directory descriptor is listed
# but already closed when the loop runs, so only entries that are still links count. A descriptor of this very script is
# left only when it is close-on-exec: that is the shell's own reading descriptor (bash: 255; dash: moved to 10 or above),
# which no exec'd program receives. dash does NOT mark it close-on-exec when it had to open the script at fd 10 or above
# (fds 0-9 all in use, as in the endpoint layout), and a copy inherited from an earlier shell is not close-on-exec either:
# both are closed like any other fd (under dash, by the bash re-exec, since they are >= 10). Nothing listed at all: exit 72.
scanfds() {
    redirs=; big=0; seen=0
    for f in /proc/self/fd/*; do
        fd=${f##*/}
        numeric "$fd" || continue
        [ -L "$f" ] || continue
        seen=1
        [ "$fd" -ge 3 ] || continue
        [ "$f" -ef "$0" ] && cloexec "$fd" && continue
        case ",$1," in *",$fd,"*) continue;; esac
        [ "$fd" -ge 10 ] && big=1
        redirs="$redirs $fd>&-"
    done
    [ "$seen" = 1 ] || exit 72
}

mode=${1:-}
case $mode in
prep)
    [ $# -ge 9 ] || exit 64
    marker=$2; supervisor=$3; grants=$4; argsfd=$5; prepspec=$6; keep=$7
    [ "$8" = "--" ] || exit 64
    shift 5
    case $marker in ''|*[!A-Za-z0-9_-]*) exit 64;; esac
    [ "${#marker}" -ge 8 ] && [ "${#marker}" -le 64 ] || exit 64
    numeric "$supervisor" || exit 64
    numeric "$argsfd" || exit 64
    fdcsv "$keep" || exit 64
    [ -z "$grants" ] || fdcsv "$grants" || exit 64
    # The keep set is the launcher's explicit list; the args fd and every grant fd must be in it (they are needed up to the
    # bwrap exec), otherwise the two lists disagree and nothing runs.
    case ",$keep," in *",$argsfd,"*) ;; *) exit 64;; esac
    set -f
    oldifs=$IFS; IFS=,
    for g in $grants; do
        case ",$keep," in *",$g,"*) ;; *) exit 64;; esac
    done
    IFS=$oldifs
    set +f
    # M-65: close every fd outside the keep set NOW, in this shell, before node prep and bwrap exist.
    scanfds "$keep"
    case ",$grants," in *,[0-9][0-9]*) big=1;; esac
    if [ "$big" = 1 ] && [ -z "${BASH_VERSION:-}" ]; then needbash; exec /bin/bash "$0" prep "$marker" "$supervisor" "$grants" "$argsfd" "$@"; fi
    eval "exec$redirs"
    shift 3
    dir=${0%/*}
    setpriv --pdeathsig KILL -- node "$dir/sandboxPrep.mjs" "$marker" "$prepspec"
    rc=$?
    [ "$rc" -eq 0 ] || exit "$rc"
    [ "$PPID" = "$supervisor" ] || exit 70
    redirs=
    set -f
    oldifs=$IFS; IFS=,
    for g in $grants; do
        numeric "$g" || exit 64
        redirs="$redirs $g>&-"
    done
    IFS=$oldifs
    eval "exec$redirs /usr/bin/bwrap --unshare-uts --unsetenv \"\$marker\" --args \"\$argsfd\" -- \"\$@\""
    exit 71
    ;;
final)
    [ $# -ge 4 ] || exit 64
    allow=$2; names=$3
    shift 3
    case $allow in ''|*[!0-9,]*) exit 64;; esac
    case $names in *[!A-Za-z0-9_,]*) exit 64;; esac
    scanfds "$allow"
    if [ "$big" = 1 ] && [ -z "${BASH_VERSION:-}" ]; then needbash; exec /bin/bash "$0" final "$allow" "$names" "$@"; fi
    # The named variables (values set by bwrap, never on a command line) become the whole environment of the command.
    set -f
    oldifs=$IFS; IFS=,
    for name in $names; do
        case $name in ''|[0-9]*|*[!A-Za-z0-9_]*) exit 64;; esac
        eval "isset=\${$name+x}"
        [ -n "$isset" ] || continue
        eval "value=\${$name}"
        set -- "$name=$value" "$@"
    done
    IFS=$oldifs
    eval "exec$redirs /usr/bin/env -i -- \"\$@\""
    exit 71
    ;;
*)
    exit 64
    ;;
esac
