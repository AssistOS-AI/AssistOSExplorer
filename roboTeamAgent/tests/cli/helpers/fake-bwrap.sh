#!/bin/bash
set -eu

raw_args=("$@")
if [[ -n "${FAKE_BWRAP_ARGS_PATH:-}" ]]; then
    printf '%s\n' "${raw_args[@]}" > "$FAKE_BWRAP_ARGS_PATH"
fi

clear_environment=false
working_directory="$PWD"
environment_args=()
command_args=()

while (($#)); do
    case "$1" in
        --)
            shift
            command_args=("$@")
            break
            ;;
        --clearenv)
            clear_environment=true
            shift
            ;;
        --setenv)
            environment_args+=("$2=$3")
            shift 3
            ;;
        --chdir)
            working_directory="$2"
            shift 2
            ;;
        --bind|--ro-bind|--symlink)
            shift 3
            ;;
        --dir|--proc|--dev|--tmpfs|--remount-ro)
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

if ((${#command_args[@]} == 0)); then
    echo "fake-bwrap: missing command separator" >&2
    exit 2
fi

cd "$working_directory"
if [[ "$clear_environment" == true ]]; then
    if ((${#environment_args[@]})); then
        exec env -i "${environment_args[@]}" "${command_args[@]}"
    fi
    exec env -i "${command_args[@]}"
fi
if ((${#environment_args[@]})); then
    exec env "${environment_args[@]}" "${command_args[@]}"
fi
exec env "${command_args[@]}"
