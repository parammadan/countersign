#!/bin/sh
# Container entrypoint (runs as root only long enough to set up, then drops privileges).
set -e
# Volumes (e.g. Fly) mount root-owned: give /data to the app user, and only to it.
[ "$(stat -c %U "$DATA_DIR")" = node ] || chown -R node:node "$DATA_DIR"
chmod 700 "$DATA_DIR"
# Word converter: its own user, no access to /data; restarted if it ever exits.
(
  while true; do
    setpriv --reuid=convert --regid=convert --clear-groups env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp /usr/local/bin/node /app/converter.mjs || true
    sleep 1
  done
) &
exec setpriv --reuid=node --regid=node --init-groups node server.js
