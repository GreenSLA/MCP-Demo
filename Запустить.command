#!/bin/zsh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Нужен Node.js 22 или новее: https://nodejs.org/'
  read -k 1
  exit 1
fi
if [ ! -d node_modules ]; then npm ci || exit 1; fi
(
  for attempt in {1..60}; do
    if curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1; then
      open http://127.0.0.1:3000
      break
    fi
    sleep 1
  done
) &
npm run dev
