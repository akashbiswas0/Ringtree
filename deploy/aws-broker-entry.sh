#!/bin/sh
set -eu
if [ -s /run/ringtree-secrets/ring-password ]; then
  gnome-keyring-daemon --unlock < /run/ringtree-secrets/ring-password >/dev/null
  export WALLET_PASS="$(cat /run/ringtree-secrets/ring-password)"
else
  echo 'Remote enrollment pending. No ring password provisioned; secret use remains blocked.'
fi
exec node --import tsx server/main.ts
