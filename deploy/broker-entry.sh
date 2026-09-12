#!/bin/sh
set -eu
# The operator creates this Docker secret interactively. Never use EC2 user-data for it.
if [ ! -s /run/secrets/ring_password ]; then
  echo 'Create the ring_password secret through the documented setup.' >&2
  exit 1
fi
gnome-keyring-daemon --unlock < /run/secrets/ring_password >/dev/null
export WALLET_PASS="$(cat /run/secrets/ring_password)"
exec node --import tsx server/main.ts
