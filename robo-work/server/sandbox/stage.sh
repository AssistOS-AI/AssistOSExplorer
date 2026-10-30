#!/bin/sh
# Fixed stage script (plan Revision 10, sections B and D). No robot input is interpolated into this text: everything
# arrives as arguments and is validated or quoted.
#
#   stage.sh prep <marker> <supervisor-pid> <grant-fds-csv> <bwrap-args-fd> <prep-spec> -- <bwrap-command> [args...]
#       Runs `setpriv --pdeathsig KILL -- node sandboxPrep.mjs <marker> <prep-spec>` as a foreground child. Non-zero
#       exit: exit with that code, before bwrap. Exit 0: check $PPID is still the supervisor, close every grant fd, then
#       exec bwrap with the marker on its real argv and the command after `--` (matches bwrapArgs.mjs bwrapRealArgv: bwrap
#       takes the command only from its real argv, never from the --args buffer).
#   stage.sh final <fd-allow-csv> <env-names-csv> <command> [args...]
#       Closes every fd >= 3 not in the allowlist (found by listing /proc/self/fd) and execs the command under env -i with
#       exactly the named variables, whose VALUES come from the environment bwrap set (`--setenv` in the --args buffer), so
#       that no value is ever on a command line.
set -u

# Each fd to close becomes an `N>&-` redirection of the final exec, so the closing and the exec are one already-parsed
# command. dash parses only a single-digit fd in a redirection: when a fd >= 10 must be closed, the script re-execs itself
# once under /bin/bash (same pid, so $PPID is unchanged) and fails closed (exit 72) when bash is absent.
numeric() { case $1 in ''|*[!0-9]*) return 1;; esac; }
needbash() { [ -z "${BASH_VERSION:-}" ] && [ ! -x /bin/bash ] && exit 72; }

mode=${1:-}
case $mode in
prep)
    [ $# -ge 8 ] || exit 64
    marker=$2; supervisor=$3; grants=$4; argsfd=$5; prepspec=$6
    [ "$7" = "--" ] || exit 64
    shift 5
    case $marker in ''|-*|*[!A-Za-z0-9_-]*) exit 64;; esac
    [ "${#marker}" -ge 8 ] && [ "${#marker}" -le 64 ] || exit 64
    numeric "$supervisor" || exit 64
    numeric "$argsfd" || exit 64
    case ",$grants," in *,[0-9][0-9]*) [ -n "${BASH_VERSION:-}" ] || { needbash; exec /bin/bash "$0" prep "$marker" "$supervisor" "$grants" "$argsfd" "$@"; };; esac
    shift 2
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
    eval "exec$redirs /usr/bin/bwrap --unshare-uts --hostname \"\$marker\" --args \"\$argsfd\" -- \"\$@\""
    exit 71
    ;;
final)
    [ $# -ge 4 ] || exit 64
    allow=$2; names=$3
    shift 3
    case $allow in ''|*[!0-9,]*) exit 64;; esac
    case $names in *[!A-Za-z0-9_,]*) exit 64;; esac
    redirs=; big=0
    for f in /proc/self/fd/*; do
        fd=${f##*/}
        numeric "$fd" || continue
        [ "$fd" -ge 3 ] || continue
        # The shell's own read-only script descriptor (fixed stage.sh text) is left: dash keeps it at fd 10 or above.
        [ "$f" -ef "$0" ] && continue
        case ",$allow," in *",$fd,"*) continue;; esac
        [ "$fd" -ge 10 ] && big=1
        redirs="$redirs $fd>&-"
    done
    if [ "$big" = 1 ] && [ -z "${BASH_VERSION:-}" ]; then needbash; exec /bin/bash "$0" final "$allow" "$names" "$@"; fi
    # The named variables (values set by bwrap, never on a command line) become the whole environment of the command.
    set -f
    oldifs=$IFS; IFS=,
    for name in $names; do
        case $name in ''|[0-9]*) exit 64;; esac
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
