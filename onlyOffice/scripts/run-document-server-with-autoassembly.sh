#!/bin/bash
set -euo pipefail

source_script="${ONLYOFFICE_DOCUMENT_SERVER_BASE_SCRIPT:-/app/ds/run-document-server.sh}"
patched_script="${TMPDIR:-/tmp}/onlyoffice-agent-run-document-server.$$.sh"
patched_gzip_script="${TMPDIR:-/tmp}/onlyoffice-agent-static-gzip.$$.sh"
configure_v5_script="${ONLYOFFICE_V5_CONFIGURE_SCRIPT:-/code/scripts/configure-document-server-v5.sh}"
configure_support_listeners_script="${ONLYOFFICE_SUPPORT_LISTENER_SCRIPT:-/code/scripts/configure-support-listeners-v5.sh}"
bounded_shutdown_script="${ONLYOFFICE_BOUNDED_SHUTDOWN_SCRIPT:-/code/scripts/prepare-document-server-shutdown.sh}"
bootstrap_script="${ONLYOFFICE_BOOTSTRAP_SCRIPT:-/code/scripts/document-server-bootstrap.mjs}"
node_bin="${ONLYOFFICE_NODE_BIN:-/usr/local/bin/node}"

# Exec below preserves this PID and its kernel start time. A previous process's
# completion cannot authorize this startup, even when container storage survives.
export ONLYOFFICE_BOOTSTRAP_NONCE
ONLYOFFICE_BOOTSTRAP_NONCE="$("$node_bin" "$bootstrap_script" begin "$$")"

if [ ! -f "$source_script" ]; then
  echo "OnlyOffice Document Server script not found: $source_script" >&2
  exit 1
fi

if [ ! -x "$configure_support_listeners_script" ]; then
  echo "OnlyOffice support-listener configuration script is missing or not executable: $configure_support_listeners_script" >&2
  exit 1
fi

if [ ! -f "$bounded_shutdown_script" ]; then
  echo "OnlyOffice bounded DocumentServer shutdown script is missing: $bounded_shutdown_script" >&2
  exit 1
fi

# GNU find's per-file -exec form discards gzip's failure status. Its batched
# form preserves the same compression options and makes any failed gzip child
# fail the phase. Validate both pinned commands before starting any services.
if ! static_gzip_source="$(command -v documentserver-static-gzip.sh)"; then
  echo 'OnlyOffice static compression script is missing; refusing startup.' >&2
  exit 1
fi
awk '
  BEGIN {
    assets = "find ./sdkjs ./web-apps ./sdkjs-plugins ./dictionaries -type f \\( -name *.js -o -name *.json -o -name *.htm -o -name *.html -o -name *.css -o -name *.bin -o -name *.wasm -o -name *.dic -o -name *.aff -o -name *.svg \\) -exec gzip -kf9 {} \\;"
    fonts = "find ./fonts -type f ! -name \"*.*\" -exec gzip -kf9 {} \\;"
  }
  /^[[:space:]]*find[[:space:]].*-exec[[:space:]]+gzip[[:space:]]/ && $0 != assets && $0 != fonts {
    unexpected_gzip_commands++
  }
  $0 == assets {
    sub(/\\;$/, "+")
    assets_line = NR
    assets_patched++
  }
  $0 == fonts {
    sub(/\\;$/, "+")
    fonts_line = NR
    fonts_patched++
  }
  { print }
  END {
    if (assets_patched != 1 || fonts_patched != 1 || assets_line >= fonts_line || unexpected_gzip_commands) {
      exit 46
    }
  }
' "$static_gzip_source" > "$patched_gzip_script" || {
  echo 'Unsupported OnlyOffice static compression script; refusing startup.' >&2
  exit 46
}

awk \
  -v configure_v5_script="$configure_v5_script" \
  -v configure_support_listeners_script="$configure_support_listeners_script" \
  -v bounded_shutdown_script="$bounded_shutdown_script" \
  -v bootstrap_script="$bootstrap_script" \
  -v static_gzip_script="$patched_gzip_script" \
  -v node_bin="$node_bin" '
  /^[[:space:]]*CHILD=\$!; wait "\$CHILD"; CHILD="";[[:space:]]*$/ {
    print "  CHILD=$!"
    print "  wait \"$CHILD\" || { onlyoffice_child_status=$?; CHILD=\"\"; return \"$onlyoffice_child_status\"; }"
    print "  CHILD=\"\""
    child_wait_patched++
    next
  }
  /^[[:space:]]*start_process documentserver-generate-allfonts\.sh \$\{ONLYOFFICE_DATA_CONTAINER\}[[:space:]]*$/ {
    print "  start_process /bin/sh -e \"$(command -v documentserver-generate-allfonts.sh)\" ${ONLYOFFICE_DATA_CONTAINER} || { echo \"OnlyOffice font generation failed; refusing startup.\" >&2; exit 1; }"
    fonts_line = NR
    fonts_patched++
    next
  }
  /^[[:space:]]*start_process documentserver-static-gzip\.sh \$\{ONLYOFFICE_DATA_CONTAINER\}[[:space:]]*$/ {
    print "start_process /bin/bash -e \"" static_gzip_script "\" ${ONLYOFFICE_DATA_CONTAINER} || { echo \"OnlyOffice static compression failed; refusing startup.\" >&2; exit 1; }"
    gzip_line = NR
    gzip_patched++
    next
  }
  /^start_process bash -c "find .*xargs tail -F"[[:space:]]*$/ {
    print "\"" node_bin "\" \"" bootstrap_script "\" complete \"$$\" \"$ONLYOFFICE_BOOTSTRAP_NONCE\" || { echo \"OnlyOffice bootstrap completion failed; refusing startup.\" >&2; exit 1; }"
    tail_line = NR
    tail_patched++
  }
  /^[[:space:]]*\/usr\/bin\/documentserver-prepare4shutdown\.sh[[:space:]]*$/ {
    print "    /bin/bash \"" bounded_shutdown_script "\""
    bounded_shutdown_patched++
    next
  }
  /^[[:space:]]*service \$i start[[:space:]]*$/ {
    print "  if [ \"$i\" = \"rabbitmq-server\" ]; then"
    print "    install -d -o rabbitmq -g rabbitmq -m 0755 /var/run/rabbitmq"
    print "    RABBITMQ_PID_FILE=/var/run/rabbitmq/pid start-stop-daemon --quiet --chuid rabbitmq --start --exec /usr/sbin/rabbitmq-server --pidfile /var/run/rabbitmq/pid --background"
    print "  else"
    print "    service \"$i\" start"
    print "  fi"
    rabbitmq_start_patched++
    next
  }
  /service supervisor start/ && inserted == 0 {
    supervisor_line = NR
    print "onlyoffice_agent_autoassembly_enabled=\"${ONLYOFFICE_AUTO_ASSEMBLY_ENABLED:-true}\""
    print "case \"$onlyoffice_agent_autoassembly_enabled\" in"
    print "  true|TRUE|1|yes|YES|on|ON) onlyoffice_agent_autoassembly_json=true ;;"
    print "  *) onlyoffice_agent_autoassembly_json=false ;;"
    print "esac"
    print "onlyoffice_agent_autoassembly_interval=\"${ONLYOFFICE_AUTO_ASSEMBLY_INTERVAL:-1m}\""
    print "onlyoffice_agent_autoassembly_step=\"${ONLYOFFICE_AUTO_ASSEMBLY_STEP:-1m}\""
    print "[[ \"$onlyoffice_agent_autoassembly_interval\" =~ ^[0-9]+[smhd]$ ]] || onlyoffice_agent_autoassembly_interval=1m"
    print "[[ \"$onlyoffice_agent_autoassembly_step\" =~ ^[0-9]+[smhd]$ ]] || onlyoffice_agent_autoassembly_step=1m"
    print "${JSON} -I -e \"this.services.CoAuthoring.autoAssembly = this.services.CoAuthoring.autoAssembly || {}\""
    print "${JSON} -I -e \"this.services.CoAuthoring.autoAssembly.enable = ${onlyoffice_agent_autoassembly_json}\""
    print "${JSON} -I -e \"this.services.CoAuthoring.autoAssembly.interval = \047${onlyoffice_agent_autoassembly_interval}\047\""
    print "${JSON} -I -e \"this.services.CoAuthoring.autoAssembly.step = \047${onlyoffice_agent_autoassembly_step}\047\""
    print "/bin/bash \"" configure_v5_script "\" || { echo \"OnlyOffice v5 DocumentServer configuration failed; refusing startup.\" >&2; exit 1; }"
    inserted = 1
  }
  /#start needed local services/ && support_listeners_inserted == 0 {
    print "/bin/bash \"" configure_support_listeners_script "\" || { echo \"OnlyOffice v5 support-listener configuration failed; refusing startup.\" >&2; exit 1; }"
    support_listeners_inserted = 1
  }
  { print }
  END {
    if (rabbitmq_start_patched != 1) {
      exit 42
    }
    if (support_listeners_inserted != 1) {
      exit 43
    }
    if (bounded_shutdown_patched != 1) {
      exit 44
    }
    if (child_wait_patched != 1 || fonts_patched != 1 || gzip_patched != 1 || tail_patched != 1 \
        || inserted != 1 || !(supervisor_line < fonts_line && fonts_line < gzip_line && gzip_line < tail_line)) {
      exit 45
    }
  }
' "$source_script" > "$patched_script"

chmod +x "$patched_script"
exec /bin/bash "$patched_script"
