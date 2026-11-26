#!/usr/bin/env bash
# Runs on the selected QA host under the existing deployment lock. Input to
# inspect is the reader code from the workflow checkout, never workspace code.
set -euo pipefail
umask 077
root=/home/admin
workspace=$root/explorerQaWorkspace
tools=$root/.qa-deployment-tools
receipts=$tools/qa-source-receipts
action=${1:?}
scope=${2:?}
case "$scope" in full|bizanso|scriptahub|csvmail) ;; *) exit 2 ;; esac
for dir in "$tools" "$receipts"; do
  if [[ -L "$dir" || ( -e "$dir" && ! -d "$dir" ) ]]; then
    echo 'QA deployment tools or receipt directory is invalid.' >&2
    exit 1
  fi
done
receipt() {
  local file=$receipts/$1.json
  if [[ -L "$file" || ( -e "$file" && ! -f "$file" ) ]]; then printf '"invalid"'; return; fi
  if [[ -f "$file" ]]; then
    printf '"'
    base64 < "$file" | tr -d '\n'
    printf '"'
  else
    printf 'null'
  fi
}

if [[ "$action" == receipt ]]; then
  case "$scope" in bizanso) name=bizanso ;; csvmail) name=simpleCSVMailSend ;; *) exit 2 ;; esac
  mkdir -p -- "$receipts"
  staging=$(mktemp "$receipts/.incoming.XXXXXXXX")
  trap 'rm -f -- "$staging"' EXIT
  cat > "$staging"
  if [[ -L "$receipts/$name.json" || ( -e "$receipts/$name.json" && ! -f "$receipts/$name.json" ) ]]; then exit 1; fi
  mv -f -- "$staging" "$receipts/$name.json"
  exit 0
fi
[[ "$action" == inspect ]]
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
tar -xf - -C "$scratch" qaSourceInventory.mjs qaCopyManifest.mjs
mount_dir() {
  local source=$1
  if [[ -L "$source" || ( -e "$source" && ! -d "$source" ) ]]; then
    echo "Unexpected QA source directory: $source" >&2
    exit 1
  fi
}
mount_dir "$workspace"
mount_dir "$tools/ploinky"
mounts=()
# Keep real paths for worktrees that refer to the workspace by absolute path.
if [[ -d "$workspace" ]]; then mounts+=(--volume "$workspace:$workspace:ro"); fi
if [[ "$scope" == full && -d "$tools/ploinky" ]]; then mounts+=(--volume "$tools/ploinky:$tools/ploinky:ro"); fi
if (( ${#mounts[@]} )); then
  # Use an immutable local image ID. The deployment Box need not be running.
  image=$(podman image inspect docker.io/assistos/ploinky-box:latest --format '{{.Id}}') || {
    echo 'QA sources exist but the local Ploinky Box reader image is unavailable.' >&2
    exit 1
  }
  [[ "$image" =~ ^(sha256:)?[0-9a-f]{64}$ ]]
  podman run --rm --pull=never --network=none --read-only --read-only-tmpfs=false \
    --cap-drop=all --cap-add=DAC_OVERRIDE --security-opt=no-new-privileges \
    --user 0 --workdir /tmp --tmpfs /tmp:rw,nosuid,nodev,noexec \
    --volume "$scratch:/qa-reader:ro" "${mounts[@]}" --entrypoint node "$image" \
    /qa-reader/qaSourceInventory.mjs "$scope" "$workspace" "$tools/ploinky" > "$scratch/inventory.json"
else
  # Neither the selected workspace nor a full deployment's host checkout exists.
  case "$scope" in
    full) copies='[{"name":"bizanso","manifest":null},{"name":"simpleCSVMailSend","manifest":null}]' ;;
    bizanso) copies='[{"name":"bizanso","manifest":null}]' ;;
    csvmail) copies='[{"name":"simpleCSVMailSend","manifest":null}]' ;;
    scriptahub) copies='[]' ;;
  esac
  printf '{"repos":[],"copies":%s,"errors":[]}' "$copies" > "$scratch/inventory.json"
fi
printf '{"inventory":'
cat "$scratch/inventory.json"
printf ',"receipts":{'
case "$scope" in
  full) printf '"bizanso":'; receipt bizanso; printf ',"simpleCSVMailSend":'; receipt simpleCSVMailSend ;;
  bizanso) printf '"bizanso":'; receipt bizanso ;;
  csvmail) printf '"simpleCSVMailSend":'; receipt simpleCSVMailSend ;;
esac
printf '}}\n'
