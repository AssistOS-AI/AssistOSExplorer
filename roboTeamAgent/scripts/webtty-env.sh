# Sourced only by Ploinky's fixed in-container terminal bootstrap, by /bin/bash
# and /bin/sh wrappers alike, so it stays POSIX. Ploinky sets HOME and the
# PLOINKY_WEBTTY_PROFILE_* variables from a profile the router already
# validated; this hook only checks that they agree and loads that robot's tool
# environment. It never infers a robot from the working directory and never
# changes the directory the terminal was opened in.
roboteam_hook_provider=${PLOINKY_WEBTTY_PROFILE_PROVIDER:-}
roboteam_hook_id=${PLOINKY_WEBTTY_PROFILE_ID:-}
# Without a profile the shell stays plain. A profile owned by another provider is not ours to load.
if [ -z "$roboteam_hook_provider" ] && [ -z "$roboteam_hook_id" ]; then
    unset roboteam_hook_provider roboteam_hook_id
    return 0
fi
[ -n "$roboteam_hook_provider" ] && [ -n "$roboteam_hook_id" ] || return 1
if [ "$roboteam_hook_provider" != roboTeamAgent ]; then
    unset roboteam_hook_provider roboteam_hook_id
    return 0
fi
roboteam_hook_registry=/data/robots
# Same shape as RobotStore ids, ^[a-z0-9][a-z0-9-]{2,63}$, with explicit sets so a locale cannot widen a range.
case "$roboteam_hook_id" in
    -*|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*) return 1 ;;
esac
[ "${#roboteam_hook_id}" -ge 3 ] && [ "${#roboteam_hook_id}" -le 64 ] || return 1
[ -f "$roboteam_hook_registry/$roboteam_hook_id/metadata.json" ] || return 1
# The home Ploinky chose must be this robot's home. -ef compares inodes, so any alias of it
# (/data and the workspace data mount) passes.
[ -n "${HOME:-}" ] && [ "$HOME" -ef "$roboteam_hook_registry/$roboteam_hook_id/home" ] || return 1
# Sourcing a missing file aborts a POSIX shell, so test first.
[ -f "$HOME/.roboteam-env.sh" ] && [ ! -L "$HOME/.roboteam-env.sh" ] || return 1
roboteam_hook_start=$(pwd -P) || return 1
. "$HOME/.roboteam-env.sh"
# The robot environment may change directory; the folder the user chose wins.
if [ "$(pwd -P)" != "$roboteam_hook_start" ]; then
    cd -- "$roboteam_hook_start" || return 1
fi
unset roboteam_hook_provider roboteam_hook_id roboteam_hook_registry roboteam_hook_start
return 0
