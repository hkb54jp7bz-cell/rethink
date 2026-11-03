#!/bin/sh
# Opening the menu does not send packets; each trial requires a menu command.
if [ "$#" -eq 0 ]; then
    set -- --execute
fi
exec /usr/bin/node /app/tools/puricare-terminal-test.mjs "$@"
