#!/bin/bash
set -u

onlyoffice_shutdown_endpoint="http://[::1]:8000/internal/cluster/inactive"

# The agent has already stopped admission, force-saved every writable session,
# received each durable callback acknowledgement, and let the native shutdown
# disconnect upgraded editor sockets before this process-group hook runs.
# Keep DocumentServer's additional cluster-inactive notification inside the
# remaining Ploinky clean-exit margin instead of allowing curl to wait forever.
if ! /usr/bin/curl \
  --fail \
  --silent \
  --show-error \
  --connect-timeout 1 \
  --max-time 2 \
  --request PUT \
  --output /dev/null \
  "$onlyoffice_shutdown_endpoint"; then
  echo 'OnlyOffice DocumentServer cluster-inactive notification did not complete within its bounded shutdown window.' >&2
fi

exit 0
