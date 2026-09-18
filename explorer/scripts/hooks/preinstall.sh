#!/usr/bin/env bash
set -euo pipefail

# This hook runs on the HOST before container creation.
# Purpose: configure Explorer's global run mode and prepare its AxiFace assets.
# The workspace root is supplied to the Explorer runtime by Ploinky; this hook
# must not read or write Ploinky's encrypted secrets.
#
# Note: prior versions of this hook also started a raw OnlyOffice Document Server
# sidecar (`ploinky_onlyoffice_<workspace>`). Document Server lifecycle now
# belongs to the Ploinky-managed `onlyOffice` agent in the OnlyOfficeAgent
# repository (`OnlyOfficeAgent/onlyOffice`; see
# https://github.com/AssistOS-AI/OnlyOfficeAgent). Explorer no longer creates,
# recreates, or mutates that container.

workspace_root="${PLOINKY_WORKSPACE_ROOT:?PLOINKY_WORKSPACE_ROOT is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
explorer_root="$(cd "${script_dir}/../.." && pwd)"
axiface_url="${AXIFACE_REPO_URL:-https://github.com/AssistOS-AI/AxiFace.git}"
axiface_default_root="${explorer_root}/shared/vendor/axi-face"
axiface_root="${AXIFACE_REPO_PATH:-${axiface_default_root}}"

# Ensure the Explorer agent runs in global mode so the workspace root is mounted
# into the container (not just the isolated agent workdir under ./agents/explorer).
#
# Ploinky stores enabled agents in JSON at .ploinky/agents.json.
# We update the record for this agent (and repo, if provided) to:
# - runMode: global
# - projectPath: <workspace_root>
agents_file="${workspace_root}/.ploinky/agents.json"
if [[ -f "$agents_file" ]]; then
    node - <<'NODE'
const fs = require('fs');
const path = require('path');

const workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
if (!workspaceRoot) process.exit(1);
const agentsFile = path.join(workspaceRoot, '.ploinky', 'agents.json');

const agentName = String(process.env.PLOINKY_AGENT_NAME || '').trim() || 'explorer';
const repoName = String(process.env.PLOINKY_REPO_NAME || '').trim();

let raw;
try {
    raw = fs.readFileSync(agentsFile, 'utf8');
} catch {
    process.exit(0);
}

let data;
try {
    data = JSON.parse(raw || '{}') || {};
} catch {
    process.exit(0);
}

let changed = false;
for (const [key, rec] of Object.entries(data)) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type !== 'agent') continue;
    if (String(rec.agentName || '').trim() !== agentName) continue;
    if (repoName && String(rec.repoName || '').trim() !== repoName) continue;
    // Don't rewrite aliased instances; only the primary agent should become global by default.
    if (rec.alias) continue;

    if (rec.runMode !== 'global') {
        rec.runMode = 'global';
        changed = true;
    }
    if (rec.projectPath !== workspaceRoot) {
        rec.projectPath = workspaceRoot;
        changed = true;
    }
    data[key] = rec;
}

if (changed) {
    try {
        fs.writeFileSync(agentsFile, JSON.stringify(data, null, 2));
    } catch {
        // ignore
    }
}
NODE
fi

if [[ ! -f "${axiface_root}/src/axi-face.mjs" ]]; then
    if [[ -n "${AXIFACE_REPO_PATH:-}" ]]; then
        echo "[preinstall] AXIFACE_REPO_PATH does not contain src/axi-face.mjs: ${AXIFACE_REPO_PATH}" >&2
        exit 1
    fi
    mkdir -p "$(dirname "${axiface_root}")"
    git clone "${axiface_url}" "${axiface_root}"
fi

if [[ ! -f "${axiface_root}/src/axi-face.mjs" ]]; then
    echo "[preinstall] AxiFace asset repository is missing src/axi-face.mjs: ${axiface_root}" >&2
    exit 1
fi

if [[ ! -d "${axiface_root}/packs" ]]; then
    echo "[preinstall] AxiFace asset repository is missing packs/: ${axiface_root}" >&2
    exit 1
fi

if find "${axiface_root}/src" "${axiface_root}/packs" -type l -print -quit | grep -q .; then
    echo "[preinstall] AxiFace public assets must not contain symlinks: ${axiface_root}" >&2
    exit 1
fi

for pack_dir in "${axiface_root}"/packs/*; do
    if [[ -d "${pack_dir}" ]]; then
        pack_name="$(basename "${pack_dir}")"
        if [[ ! "${pack_name}" =~ ^[A-Za-z0-9._-]+$ ]]; then
            echo "[preinstall] Invalid AxiFace pack directory name: ${pack_name}" >&2
            exit 1
        fi
    fi
done

node --input-type=module - "${axiface_root}" "${explorer_root}/shared/generated/axi-face-packs.json" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [, , axifaceRoot, outputPath] = process.argv;
const packsRoot = path.join(axifaceRoot, 'packs');
const packs = [];

for (const name of fs.readdirSync(packsRoot).sort()) {
    const manifestPath = path.join(packsRoot, name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    packs.push({
        ...manifest,
        id: manifest.id || name,
        name: manifest.name || name,
        description: manifest.description || '',
        manifestSrc: `/explorer/shared/vendor/axi-face/packs/${name}/manifest.json`
    });
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({ packs }, null, 2)}\n`);
NODE

exit 0
