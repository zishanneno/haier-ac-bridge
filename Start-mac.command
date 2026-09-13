#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22 or 24 from https://nodejs.org, then reopen this launcher."
  echo "Press Return to close."
  read -r answer
  exit 1
fi
node scripts/launch.mjs
status=$?
if [ "$status" -ne 0 ] && [ "$status" -ne 130 ]; then
  echo "Could not start the bridge. See the message above and README.md."
  echo "Press Return to close."
  read -r answer
fi
exit "$status"
