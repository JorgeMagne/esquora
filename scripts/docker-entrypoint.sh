#!/bin/sh
set -eu
umask 077

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$DATA_DIR"
  chown node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs "$@"
fi

exec "$@"
