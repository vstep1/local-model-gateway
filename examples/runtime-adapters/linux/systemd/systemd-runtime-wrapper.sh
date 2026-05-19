#!/usr/bin/env bash
set -euo pipefail

# Gateway-facing wrapper around a systemd runtime unit.
# Copy this file to ./runtime-adapters/<alias>-service.sh and set:
#   RUNTIME_SYSTEMD_UNIT=local-model-runtime@<alias>.service
# in either the environment or a sibling .env file.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="$(basename "${BASH_SOURCE[0]}" .sh)"
ENV_FILE="${LOCAL_MODEL_GATEWAY_RUNTIME_ENV:-${SCRIPT_DIR}/${SERVICE_NAME}.env}"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

RUNTIME_ALIAS="${RUNTIME_ALIAS:-${SERVICE_NAME%-service}}"
RUNTIME_SYSTEMD_UNIT="${RUNTIME_SYSTEMD_UNIT:-local-model-runtime@${RUNTIME_ALIAS}.service}"
RUNTIME_SYSTEMD_SCOPE="${RUNTIME_SYSTEMD_SCOPE:-system}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
JOURNALCTL_BIN="${JOURNALCTL_BIN:-journalctl}"

systemctl_args=()
journalctl_args=()
if [[ "${RUNTIME_SYSTEMD_SCOPE}" == "user" ]]; then
  systemctl_args+=(--user)
  journalctl_args+=(--user)
fi

case "${1:-}" in
  install|start)
    "${SYSTEMCTL_BIN}" "${systemctl_args[@]}" start "${RUNTIME_SYSTEMD_UNIT}"
    ;;
  stop)
    "${SYSTEMCTL_BIN}" "${systemctl_args[@]}" stop "${RUNTIME_SYSTEMD_UNIT}"
    ;;
  restart)
    "${SYSTEMCTL_BIN}" "${systemctl_args[@]}" restart "${RUNTIME_SYSTEMD_UNIT}"
    ;;
  status)
    "${SYSTEMCTL_BIN}" "${systemctl_args[@]}" status "${RUNTIME_SYSTEMD_UNIT}" --no-pager
    ;;
  logs)
    "${JOURNALCTL_BIN}" "${journalctl_args[@]}" -u "${RUNTIME_SYSTEMD_UNIT}" -f
    ;;
  *)
    echo "Usage: $0 <install|start|stop|restart|status|logs>" >&2
    exit 2
    ;;
esac
