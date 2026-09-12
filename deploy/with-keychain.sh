#!/bin/sh
set -eu
# docker exec does not inherit the environment of dbus-run-session's child.
# Read only the public DBus socket address; never echo other process environment values.
bus=''
for proc in /proc/[0-9]*/environ; do
  candidate=$(tr '\000' '\n' < "$proc" 2>/dev/null | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p' | head -n 1) || true
  if [ -n "$candidate" ]; then bus="$candidate"; break; fi
done
if [ -z "$bus" ]; then echo 'Broker DBus session unavailable' >&2; exit 1; fi
export DBUS_SESSION_BUS_ADDRESS="$bus"
exec "$@"
