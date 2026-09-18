# Sourced only by Ploinky's fixed in-container terminal bootstrap.
[ -n "${PLOINKY_WORKSPACE_ROOT:-}" ] || { echo 'PLOINKY_WORKSPACE_ROOT is required' >&2; return 1; }
roboteam_shell_directory=$(pwd -P)
roboteam_shell_registry="$PLOINKY_WORKSPACE_ROOT/.data/roboTeamAgent/robots"
case "$roboteam_shell_directory" in
    /data/robots/*) roboteam_shell_id=${roboteam_shell_directory#/data/robots/} ;;
    "$roboteam_shell_registry"/*) roboteam_shell_id=${roboteam_shell_directory#"$roboteam_shell_registry"/} ;;
    *) unset roboteam_shell_directory roboteam_shell_registry; return 0 ;;
esac
# Preserve previously issued terminal launches into the old home directory.
roboteam_shell_id=${roboteam_shell_id%/home}
case "$roboteam_shell_id" in
    ''|*[!a-z0-9-]*) return 1 ;;
esac
roboteam_shell_root="$roboteam_shell_registry/$roboteam_shell_id"
[ -f "$roboteam_shell_root/metadata.json" ] || return 1
export HOME="$roboteam_shell_root/home"
export ROBOTEAM_WORKING_DIRECTORY="$roboteam_shell_root"
cd -- "$roboteam_shell_root" || return 1
. "$HOME/.roboteam-env.sh"
unset roboteam_shell_directory roboteam_shell_registry roboteam_shell_root roboteam_shell_id
