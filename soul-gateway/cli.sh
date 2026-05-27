#!/bin/bash
if [ $# -eq 0 ]; then
    echo "Soul Gateway CLI"
    echo ""
    echo "Usage:"
    echo "  status          Show gateway status"
    echo "  keys            List API keys"
    echo "  models          List model configs"
    echo "  logs [n]        Show recent logs (default: 20)"
    echo "  health          Check health endpoint"
    echo ""
    echo "Environment:"
    echo "  GATEWAY_URL=http://localhost:8080"
    echo "  PLOINKY_AUTH_COOKIE='ploinky_jwt=...' for management commands"
    exit 0
fi

GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"
HEALTH_URL="$GATEWAY_URL/public-services/soul-gateway-health/"
MANAGEMENT_BASE="$GATEWAY_URL/services/soul-gateway/management"

pretty_json() {
    node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
}

management_get() {
    if [ -z "${PLOINKY_AUTH_COOKIE:-}" ]; then
        echo "PLOINKY_AUTH_COOKIE is required for management commands."
        echo "Authenticate through Ploinky and pass the router cookie, or use the AchillesIDE settings dashboard."
        exit 1
    fi
    curl -s -H "Cookie: ${PLOINKY_AUTH_COOKIE}" "$MANAGEMENT_BASE/$1" | pretty_json
}

case "$1" in
    status|health)
        curl -s "$HEALTH_URL" | pretty_json
        ;;
    keys)
        management_get "keys"
        ;;
    models)
        management_get "models"
        ;;
    logs)
        LIMIT="${2:-20}"
        management_get "logs?limit=$LIMIT"
        ;;
    *)
        echo "Unknown command: $1"
        exit 1
        ;;
esac
