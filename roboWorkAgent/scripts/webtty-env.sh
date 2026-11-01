# The Router launches the fixed profile gate after capturing its terminal identity.
# This hook must return normally and must never source robot-owned files.
if [ "${PLOINKY_WEBTTY_PROFILE_PROVIDER:-}" = roboWorkAgent ] && [ -n "${PLOINKY_WEBTTY_PROFILE_ID:-}" ]; then
    # The outer shell uses an empty service-owned stub, not the robot's home.
    export HISTFILE=/dev/null
fi
return 0
