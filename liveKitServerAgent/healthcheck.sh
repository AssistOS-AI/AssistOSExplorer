#!/bin/sh
set -eu

# Ploinky readiness scripts are root-relative single-file entrypoints. Keep the
# semantic listener/SFU/Egress probe in its reviewed implementation and expose
# this narrow wrapper for coordinated generation activation.
exec sh /code/scripts/health/livekit-server-agent-health.sh
