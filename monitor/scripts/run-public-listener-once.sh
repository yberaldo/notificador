#!/usr/bin/env bash

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
CLI_PATH="${ROOT_DIR}/dist/cli.js"

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

if [ ! -f "${CLI_PATH}" ]; then
  echo "dist/cli.js nao encontrado. Execute npm run build antes de rodar o monitor." >&2
  exit 1
fi

cd "${ROOT_DIR}"
exec node "${CLI_PATH}"
