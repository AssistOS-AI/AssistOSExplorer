#!/bin/bash
set -e

# Soul Gateway remote deployment script
# Called by GH Actions with env vars:
#   PGPASSWORD, DEFAULT_PROXY_API_KEY, PLOINKY_ADMIN_PASSWORD

WORKSPACE="$HOME/soulGateway"
PLOINKY="$HOME/ploinky/bin/ploinky"
PROXIES_REPO="https://github.com/PloinkyRepos/proxies.git"
BASIC_REPO="https://github.com/PloinkyRepos/Basic.git"
CODE_DIR="$HOME/code"
ROUTER_URL="${PLOINKY_ROUTER_URL:-http://localhost:${ROUTER_PORT:-8080}}"
HEALTH_URL="${ROUTER_URL%/}/public-services/soul-gateway-health/"
PLOINKY_ADMIN_USER="${PLOINKY_ADMIN_USER:-admin}"

echo "=== Soul Gateway Deploy ==="

# 1. Clone or pull the proxies repo
if [ -d "$CODE_DIR/proxies/.git" ]; then
    echo "Pulling latest proxies..."
    cd "$CODE_DIR/proxies"
    git fetch origin main
    git reset --hard origin/main
else
    echo "Cloning proxies repo..."
    mkdir -p "$CODE_DIR"
    git clone "$PROXIES_REPO" "$CODE_DIR/proxies"
fi

# 2. Clone or pull the basic repo
if [ -d "$CODE_DIR/basic/.git" ]; then
    echo "Pulling latest basic..."
    cd "$CODE_DIR/basic"
    git fetch origin main
    git reset --hard origin/main
else
    echo "Cloning basic repo..."
    git clone "$BASIC_REPO" "$CODE_DIR/basic"
fi

# 3. Create workspace
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

# 4. Register repos with ploinky (symlink to source)
mkdir -p "$WORKSPACE/.ploinky/repos"
ln -sfn "$CODE_DIR/proxies" "$WORKSPACE/.ploinky/repos/proxies"
ln -sfn "$CODE_DIR/basic" "$WORKSPACE/.ploinky/repos/basic"

if [ ! -f "$WORKSPACE/.ploinky/enabled_repos.json" ]; then
    echo '["basic","proxies"]' > "$WORKSPACE/.ploinky/enabled_repos.json"
fi

# 5. Set ploinky vars for soul-gateway
echo "Configuring env vars..."
$PLOINKY var UPSTREAM_URL "https://proxy.axiologic.dev"
$PLOINKY var PGHOST "host.containers.internal"
$PLOINKY var PGPORT "5432"
$PLOINKY var PGUSER "postgres"
$PLOINKY var PGPASSWORD "${PGPASSWORD}"
$PLOINKY var PGDATABASE "soul_gateway_v2"
$PLOINKY var DEFAULT_PROXY_API_KEY "${DEFAULT_PROXY_API_KEY}"

if [ -z "${PLOINKY_ADMIN_PASSWORD:-}" ]; then
    echo "ERROR: PLOINKY_ADMIN_PASSWORD is required for Ploinky local-auth admin login."
    exit 1
fi

# 6. Stop existing soul-gateway if running
if podman ps --format '{{.Names}}' 2>/dev/null | grep -q "soul-gateway.*soulGateway"; then
    echo "Stopping existing soul-gateway..."
    $PLOINKY stop soul-gateway 2>&1 || true
    $PLOINKY clean soul-gateway 2>&1 || true
fi

# 7. Ensure the gateway is protected by Ploinky local auth
echo "Ensuring soul-gateway uses Ploinky local auth..."
$PLOINKY disable soul-gateway 2>&1 || true
$PLOINKY enable agent proxies/soul-gateway \
    --auth pwd \
    --user "$PLOINKY_ADMIN_USER" \
    --password "$PLOINKY_ADMIN_PASSWORD" \
    as soul-gateway

# 8. Start soul-gateway
echo "Starting soul-gateway..."
$PLOINKY start soul-gateway 2>&1

# 9. Wait for startup and health check
echo "Waiting for startup..."
for i in $(seq 1 30); do
    sleep 2
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
        echo "Soul Gateway is healthy!"
        curl -s "$HEALTH_URL"
        echo ""
        exit 0
    fi
    echo "  Attempt $i/30..."
done

echo "ERROR: Soul Gateway failed to start within 60 seconds"
podman logs --tail 20 "$(podman ps -a --format '{{.Names}}' | grep soul-gateway | head -1)" 2>&1 || true
exit 1
