#!/usr/bin/env bash
set -euo pipefail

# Generic macOS launchd adapter for one llama-server runtime.
# Copy this file to ./runtime-adapters/<alias>-service.sh, create a matching
# ./runtime-adapters/<alias>-service.env, then point local-model-gateway
# service_script at the copied script.

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
SERVICE_NAME="$(basename "${SCRIPT_PATH}" .sh)"
ENV_FILE="${LOCAL_MODEL_GATEWAY_RUNTIME_ENV:-${LOCAL_AI_GATEWAY_RUNTIME_ENV:-${LOCAL_GPU_GATEWAY_RUNTIME_ENV:-${SCRIPT_DIR}/${SERVICE_NAME}.env}}}"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

sanitize_label_part() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9.-]+/-/g; s/^-+//; s/-+$//'
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "${value}"
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

write_key_string() {
  local key="$1"
  local value="$2"
  cat <<EOF
  <key>${key}</key>
  <string>$(xml_escape "${value}")</string>
EOF
}

RUNTIME_ALIAS="${RUNTIME_ALIAS:-${SERVICE_NAME%-service}}"
RUNTIME_LABEL="${RUNTIME_LABEL:-ai.local.runtime.$(sanitize_label_part "${RUNTIME_ALIAS}")}"
RUNTIME_HOST="${RUNTIME_HOST:-127.0.0.1}"
RUNTIME_PORT="${RUNTIME_PORT:-8000}"
RUNTIME_HF_REPO="${RUNTIME_HF_REPO:-}"
RUNTIME_HF_FILE="${RUNTIME_HF_FILE:-}"
RUNTIME_MODEL_PATH="${RUNTIME_MODEL_PATH:-}"
RUNTIME_UPSTREAM_ALIAS="${RUNTIME_UPSTREAM_ALIAS:-${RUNTIME_ALIAS}}"
RUNTIME_CTX_SIZE="${RUNTIME_CTX_SIZE:-4096}"
RUNTIME_GPU_LAYERS="${RUNTIME_GPU_LAYERS:-999}"
RUNTIME_CACHE_TYPE_K="${RUNTIME_CACHE_TYPE_K:-q4_0}"
RUNTIME_CACHE_TYPE_V="${RUNTIME_CACHE_TYPE_V:-q4_0}"
RUNTIME_PARALLEL="${RUNTIME_PARALLEL:-1}"
RUNTIME_HTTP_THREADS="${RUNTIME_HTTP_THREADS:-4}"
RUNTIME_TIMEOUT_SECONDS="${RUNTIME_TIMEOUT_SECONDS:-1800}"
RUNTIME_EXTRA_ARGS="${RUNTIME_EXTRA_ARGS:-}"
RUNTIME_WORKDIR="${RUNTIME_WORKDIR:-$(pwd)}"
RUNTIME_LLAMA_SERVER="${RUNTIME_LLAMA_SERVER:-$(command -v llama-server || true)}"
RUNTIME_STATE_DIR="${RUNTIME_STATE_DIR:-${HOME}/Library/Application Support/local-model-gateway/runtimes/${RUNTIME_ALIAS}}"
RUNTIME_LOG_DIR="${RUNTIME_LOG_DIR:-${HOME}/Library/Logs/local-model-gateway/${RUNTIME_ALIAS}}"
RUNTIME_PLIST_DIR="${RUNTIME_PLIST_DIR:-${HOME}/Library/LaunchAgents}"

USER_UID="$(id -u)"
DOMAIN_TARGET="gui/${USER_UID}"
PLIST_PATH="${RUNTIME_PLIST_DIR}/${RUNTIME_LABEL}.plist"
WRAPPER_PATH="${RUNTIME_STATE_DIR}/llama-server-wrapper.sh"
STDOUT_LOG="${RUNTIME_LOG_DIR}/llama-server.stdout.log"
STDERR_LOG="${RUNTIME_LOG_DIR}/llama-server.stderr.log"

require_config() {
  if [[ -z "${RUNTIME_LLAMA_SERVER}" || ! -x "${RUNTIME_LLAMA_SERVER}" ]]; then
    echo "llama-server not found. Set RUNTIME_LLAMA_SERVER in ${ENV_FILE}." >&2
    exit 1
  fi
  if [[ -z "${RUNTIME_MODEL_PATH}" && ( -z "${RUNTIME_HF_REPO}" || -z "${RUNTIME_HF_FILE}" ) ]]; then
    echo "Set either RUNTIME_MODEL_PATH or both RUNTIME_HF_REPO and RUNTIME_HF_FILE in ${ENV_FILE}." >&2
    exit 1
  fi
}

write_wrapper() {
  mkdir -p "${RUNTIME_STATE_DIR}" "${RUNTIME_LOG_DIR}"
  local env_file_q
  env_file_q="$(shell_quote "${ENV_FILE}")"
  cat >"${WRAPPER_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ -f ${env_file_q} ]]; then
  source ${env_file_q}
fi

extra_args=()
if [[ -n "\${RUNTIME_EXTRA_ARGS:-}" ]]; then
  # Keep this simple: quote-sensitive advanced args should be placed directly in
  # this wrapper after copying the example.
  read -r -a extra_args <<< "\${RUNTIME_EXTRA_ARGS}"
fi

cmd=(
  "\${RUNTIME_LLAMA_SERVER:-${RUNTIME_LLAMA_SERVER}}"
  --alias "\${RUNTIME_UPSTREAM_ALIAS:-${RUNTIME_UPSTREAM_ALIAS}}"
  --host "\${RUNTIME_HOST:-${RUNTIME_HOST}}"
  --port "\${RUNTIME_PORT:-${RUNTIME_PORT}}"
  --ctx-size "\${RUNTIME_CTX_SIZE:-${RUNTIME_CTX_SIZE}}"
  --gpu-layers "\${RUNTIME_GPU_LAYERS:-${RUNTIME_GPU_LAYERS}}"
  --cache-type-k "\${RUNTIME_CACHE_TYPE_K:-${RUNTIME_CACHE_TYPE_K}}"
  --cache-type-v "\${RUNTIME_CACHE_TYPE_V:-${RUNTIME_CACHE_TYPE_V}}"
  --parallel "\${RUNTIME_PARALLEL:-${RUNTIME_PARALLEL}}"
  --jinja
  --no-warmup
  --threads-http "\${RUNTIME_HTTP_THREADS:-${RUNTIME_HTTP_THREADS}}"
  --timeout "\${RUNTIME_TIMEOUT_SECONDS:-${RUNTIME_TIMEOUT_SECONDS}}"
)

if [[ -n "\${RUNTIME_MODEL_PATH:-}" ]]; then
  cmd+=(-m "\${RUNTIME_MODEL_PATH}")
else
  cmd+=(-hf "\${RUNTIME_HF_REPO}" --hf-file "\${RUNTIME_HF_FILE}")
fi

exec "\${cmd[@]}" "\${extra_args[@]}"
EOF
  chmod 0755 "${WRAPPER_PATH}"
}

write_plist() {
  mkdir -p "${RUNTIME_PLIST_DIR}" "${RUNTIME_LOG_DIR}"
  cat >"${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
$(write_key_string Label "${RUNTIME_LABEL}")
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "${WRAPPER_PATH}")</string>
  </array>
$(write_key_string WorkingDirectory "${RUNTIME_WORKDIR}")
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
$(write_key_string StandardOutPath "${STDOUT_LOG}")
$(write_key_string StandardErrorPath "${STDERR_LOG}")
  <key>EnvironmentVariables</key>
  <dict>
$(write_key_string PATH "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
$(write_key_string LOCAL_MODEL_GATEWAY_RUNTIME_ENV "${ENV_FILE}")
  </dict>
</dict>
</plist>
EOF
  chmod 0644 "${PLIST_PATH}"
}

bootout_label() {
  launchctl bootout "${DOMAIN_TARGET}" "${PLIST_PATH}" >/dev/null 2>&1 || true
  launchctl bootout "${DOMAIN_TARGET}/${RUNTIME_LABEL}" >/dev/null 2>&1 || true
}

bootstrap_label() {
  launchctl bootstrap "${DOMAIN_TARGET}" "${PLIST_PATH}" 2>/dev/null || true
  launchctl enable "${DOMAIN_TARGET}/${RUNTIME_LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "${DOMAIN_TARGET}/${RUNTIME_LABEL}" >/dev/null 2>&1 || true
}

start_service() {
  require_config
  write_wrapper
  write_plist
  if ! launchctl print "${DOMAIN_TARGET}/${RUNTIME_LABEL}" >/dev/null 2>&1; then
    launchctl bootstrap "${DOMAIN_TARGET}" "${PLIST_PATH}"
    launchctl enable "${DOMAIN_TARGET}/${RUNTIME_LABEL}" >/dev/null 2>&1 || true
  fi
  launchctl kickstart -k "${DOMAIN_TARGET}/${RUNTIME_LABEL}" >/dev/null 2>&1 || true
  echo "Started ${RUNTIME_ALIAS} via ${RUNTIME_LABEL}."
}

stop_service() {
  bootout_label
  echo "Stopped ${RUNTIME_ALIAS} via ${RUNTIME_LABEL}."
}

status_service() {
  echo "== launchctl =="
  launchctl print "${DOMAIN_TARGET}/${RUNTIME_LABEL}" 2>/dev/null | sed -n '1,80p' || echo "not loaded"
  echo
  echo "== listening port =="
  lsof -nP -iTCP:"${RUNTIME_PORT}" -sTCP:LISTEN 2>/dev/null || true
  echo
  echo "== health =="
  curl -fsS --max-time 3 "http://${RUNTIME_HOST}:${RUNTIME_PORT}/v1/models" 2>/dev/null || echo "not ready"
  echo
}

case "${1:-}" in
  install|start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    status_service
    ;;
  logs)
    mkdir -p "${RUNTIME_LOG_DIR}"
    tail -n 120 -f "${STDERR_LOG}" "${STDOUT_LOG}"
    ;;
  *)
    echo "Usage: $0 <install|start|stop|restart|status|logs>" >&2
    exit 2
    ;;
esac
