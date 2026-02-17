#!/bin/bash
set -e

# Soul Gateway remote deployment script
# Called by GH Actions with env vars: PGPASSWORD, DEFAULT_PROXY_API_KEY

WORKSPACE="$HOME/soulGateway"
PLOINKY="$HOME/ploinky/bin/ploinky"
REPO_URL="https://github.com/PloinkyRepos/file-parser.git"
REPO_DIR="$HOME/code/file-parser"

echo "=== Soul Gateway Deploy ==="

# 1. Clone or pull the repo
if [ -d "$REPO_DIR/.git" ]; then
  echo "Pulling latest code..."
  cd "$REPO_DIR"
  git fetch origin main
  git reset --hard origin/main
else
  echo "Cloning repo..."
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone "$REPO_URL" "$REPO_DIR"
fi

# 2. Create workspace if needed
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

# 3. Register repos with ploinky if not already done
if [ ! -d "$WORKSPACE/.ploinky/repos/proxies" ]; then
  echo "Initializing ploinky workspace..."
  mkdir -p "$WORKSPACE/.ploinky/repos"
  ln -sfn "$REPO_DIR/proxies" "$WORKSPACE/.ploinky/repos/proxies"
  ln -sfn "$REPO_DIR/basic" "$WORKSPACE/.ploinky/repos/basic"
  echo '["basic","proxies"]' > "$WORKSPACE/.ploinky/enabled_repos.json"
fi

# 4. Set ploinky vars for soul-gateway
echo "Configuring env vars..."
$PLOINKY var UPSTREAM_URL "https://proxy.axiologic.dev"
$PLOINKY var PGHOST "host.containers.internal"
$PLOINKY var PGPORT "5432"
$PLOINKY var PGUSER "keycloak"
$PLOINKY var PGPASSWORD "${PGPASSWORD}"
$PLOINKY var PGDATABASE "keycloak"
$PLOINKY var DEFAULT_PROXY_API_KEY "${DEFAULT_PROXY_API_KEY}"

# 5. Update the app code in the ploinky repos
echo "Syncing soul-gateway-app..."
if [ -d "$WORKSPACE/.ploinky/repos/proxies/soul-gateway/app" ]; then
  rm -rf "$WORKSPACE/.ploinky/repos/proxies/soul-gateway/app"
fi
# Only copy if repos are real dirs (not symlinks)
if [ -L "$WORKSPACE/.ploinky/repos/proxies" ]; then
  echo "Repos are symlinked, code is already up to date."
else
  cp -a "$REPO_DIR/proxies/soul-gateway-app" "$WORKSPACE/.ploinky/repos/proxies/soul-gateway/app"
fi

# 6. Stop existing soul-gateway if running
if podman ps --format '{{.Names}}' 2>/dev/null | grep -q "soul-gateway.*soulGateway"; then
  echo "Stopping existing soul-gateway..."
  $PLOINKY stop soul-gateway 2>&1 || true
  $PLOINKY clean soul-gateway 2>&1 || true
fi

# 7. Start soul-gateway (postgres from basic will be started via enable)
echo "Starting soul-gateway..."
$PLOINKY start soul-gateway 2>&1

# 8. Wait for startup and health check
echo "Waiting for startup..."
for i in $(seq 1 30); do
  sleep 2
  if curl -sf http://localhost:8042/health > /dev/null 2>&1; then
    echo "Soul Gateway is healthy!"
    curl -s http://localhost:8042/health
    echo ""
    exit 0
  fi
  echo "  Attempt $i/30..."
done

echo "ERROR: Soul Gateway failed to start within 60 seconds"
podman logs --tail 20 "$(podman ps -a --format '{{.Names}}' | grep soul-gateway | head -1)" 2>&1 || true
exit 1
