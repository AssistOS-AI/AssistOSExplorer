#!/bin/bash
APP_DIR="/app"

if [ $# -eq 0 ]; then
    echo "Soul Gateway CLI"
    echo ""
    echo "Usage:"
    echo "  status          Show gateway status"
    echo "  families        List soul families"
    echo "  keys            List API keys"
    echo "  models          List model configs"
    echo "  logs [n]        Show recent logs (default: 20)"
    echo "  health          Check health endpoint"
    echo ""
    exit 0
fi

PORT="${PORT:-8042}"
BASE="http://localhost:$PORT"

case "$1" in
    status|health)
        curl -s "$BASE/healthz" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
        ;;
    families)
        curl -s "$BASE/api/v1/soul-families" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
        ;;
    keys)
        curl -s "$BASE/api/v1/keys" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
        ;;
    models)
        curl -s "$BASE/api/v1/models" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
        ;;
    logs)
        LIMIT="${2:-20}"
        curl -s "$BASE/api/v1/logs?limit=$LIMIT" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
        ;;
    *)
        echo "Unknown command: $1"
        exit 1
        ;;
esac
