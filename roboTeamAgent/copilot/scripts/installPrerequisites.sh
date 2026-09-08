#!/usr/bin/env sh
set -eu

# Ploinky application-loader flags must not retarget npm or native CLI entry modules.
unset NODE_OPTIONS

fail() {
    echo "installPrerequisites: $*" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js >=22.19.0 is required; provision the managed Node runtime first."
node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) {
        console.error("installPrerequisites: Node.js >=22.19.0 is required by Pi 0.85.1; found " + process.version + ". Upgrade the managed Node runtime, not the user installation.");
        process.exit(1);
    }
' || exit 1

if ! command -v bwrap >/dev/null 2>&1; then
    apt-get update || fail "Bubblewrap package index update failed."
    apt-get install -y --no-install-recommends bubblewrap || fail "Bubblewrap installation failed."
    command -v bwrap >/dev/null 2>&1 || fail "Bubblewrap executable is missing after installation."
fi

if [ -z "${NPM_CLI:-}" ]; then
    for candidate in \
        /opt/ploinky-node/lib/node_modules/npm/bin/npm-cli.js \
        /opt/ploinky-node/share/nodejs/npm/bin/npm-cli.js \
        /usr/local/lib/node_modules/npm/bin/npm-cli.js \
        /usr/share/nodejs/npm/bin/npm-cli.js
    do
        if [ -f "$candidate" ]; then
            NPM_CLI="$candidate"
            break
        fi
    done
fi
[ -n "${NPM_CLI:-}" ] && [ -f "$NPM_CLI" ] || fail "npm CLI was not found; provision npm in the managed Node runtime or set NPM_CLI."

# Ploinky mounts the agent's writable persistent data directory at /root.
# Keep package installation separate from the native agents' authentication home.
NATIVE_PREFIX="${ACHILLES_NATIVE_PREFIX:-/root/.cache/achilles-native}"
case "$NATIVE_PREFIX" in
    /*) ;;
    *) fail "ACHILLES_NATIVE_PREFIX must be an absolute container-owned directory." ;;
esac
mkdir -p "$NATIVE_PREFIX/.setup-home" || fail "Cannot create container-owned native installation prefix."
export HOME="$NATIVE_PREFIX/.setup-home"
export XDG_CONFIG_HOME="$HOME/config" XDG_CACHE_HOME="$HOME/cache" XDG_DATA_HOME="$HOME/data"
export NPM_CONFIG_CACHE="$NATIVE_PREFIX/.npm-cache"
export NPM_CONFIG_USERCONFIG="$HOME/npm-user-config" NPM_CONFIG_GLOBALCONFIG="$HOME/npm-global-config"
: > "$NPM_CONFIG_USERCONFIG"
: > "$NPM_CONFIG_GLOBALCONFIG"
chmod 600 "$NPM_CONFIG_USERCONFIG" "$NPM_CONFIG_GLOBALCONFIG"

package_matches() {
    node -e '
        const fs = require("node:fs");
        try {
            const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            process.exit(value.version === process.argv[2] ? 0 : 1);
        } catch { process.exit(1); }
    ' "$1" "$2"
}

verify_binary() {
    node -e '
        const { spawnSync } = require("node:child_process");
        const result = spawnSync(process.argv[1], ["--version"], {
            encoding: "utf8", timeout: 30000
        });
        const versions = (result.stdout || "").match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/g) || [];
        if (result.error || result.status !== 0 || versions.length !== 1 || versions[0] !== process.argv[2]) {
            console.error("installPrerequisites: executable version verification failed for " + process.argv[1] + "; expected " + process.argv[2] + ". Repair the managed package/runtime installation.");
            process.exit(1);
        }
    ' "$1" "$2"
}

install_native() {
    name="$1"
    package="$2"
    version="$3"
    prefix="$NATIVE_PREFIX/$name"
    metadata="$prefix/node_modules/$package/package.json"
    binary="$prefix/node_modules/.bin/$name"
    if ! package_matches "$metadata" "$version"; then
        mkdir -p "$prefix" || fail "Cannot create managed $name prefix."
        # OpenCode requires its postinstall to select the matching platform binary.
        node "$NPM_CLI" install --global=false --prefix "$prefix" \
            --save-exact --engine-strict=true --force=false --ignore-scripts=false \
            --include=optional --min-release-age=0 --no-fund --no-audit \
            --loglevel=error --progress=false "$package@$version" \
            || fail "$package@$version installation failed; check the reported Node engine, registry, and managed prefix prerequisites."
    fi
    package_matches "$metadata" "$version" || fail "$package@$version package metadata is missing or mismatched after installation."
    verify_binary "$binary" "$version" || exit 1
}

install_native codex @openai/codex 0.139.0
install_native opencode opencode-ai 1.15.10
install_native pi @earendil-works/pi-coding-agent 0.85.1
