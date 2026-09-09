# Sourced only by Ploinky's fixed in-container terminal bootstrap.
roboteam_shell_home=$(pwd -P)
case "$roboteam_shell_home" in
    /data/robots/*/home)
        roboteam_shell_id=${roboteam_shell_home#/data/robots/}
        roboteam_shell_id=${roboteam_shell_id%/home}
        case "$roboteam_shell_id" in
            ''|*[!a-z0-9-]*) return 1 ;;
        esac
        [ -f "/data/robots/$roboteam_shell_id/metadata.json" ] || return 1
        export HOME="$roboteam_shell_home"
        . "$HOME/.roboteam-env.sh"
        ;;
esac
unset roboteam_shell_home roboteam_shell_id
