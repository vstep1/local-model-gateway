#!/usr/bin/env bash
set -euo pipefail

# Generic macOS launchd adapter for one llama-server runtime.
# Copy this file to ./runtime-adapters/<alias>-service.sh, create a matching
# ./runtime-adapters/<alias>-service.env, then point local-model-gateway
# service_script at the copied script.

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
SERVICE_NAME="$(basename "${SCRIPT_PATH}" .sh)"
ENV_FILE="${LOCAL_MODEL_GATEWAY_RUNTIME_ENV:-${SCRIPT_DIR}/${SERVICE_NAME}.env}"

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

write_key_bool() {
  local key="$1"
  local value
  case "$(printf '%s' "${2:-false}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) value="true" ;;
    *) value="false" ;;
  esac
  cat <<EOF
  <key>${key}</key>
  <${value}/>
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
RUNTIME_PROGRESS_FILE="${RUNTIME_PROGRESS_FILE:-${RUNTIME_STATE_DIR}/load-progress.json}"
RUNTIME_LOG_DIR="${RUNTIME_LOG_DIR:-${HOME}/Library/Logs/local-model-gateway/${RUNTIME_ALIAS}}"
RUNTIME_PLIST_DIR="${RUNTIME_PLIST_DIR:-${HOME}/Library/LaunchAgents}"
RUNTIME_RUN_AT_LOAD="${RUNTIME_RUN_AT_LOAD:-false}"
RUNTIME_KEEP_ALIVE="${RUNTIME_KEEP_ALIVE:-false}"

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

progress_file="\${RUNTIME_PROGRESS_FILE:-${RUNTIME_PROGRESS_FILE}}"
load_phase="starting"
load_progress="null"
prefill_progress="null"
prefill_task_id="null"
prefill_tokens_done="null"
prefill_tokens_total="null"

normalize_progress() {
  awk -v p="\$1" 'BEGIN { if (p > 1) p = p / 100; if (p < 0) p = 0; if (p > 1) p = 1; printf "%.4f", p }'
}

write_telemetry() {
  if [[ -z "\${progress_file}" ]]; then
    return
  fi
  mkdir -p "\$(dirname "\${progress_file}")"
  printf '{"load_phase":"%s","load_progress":%s,"prefill_progress":%s,"prefill_task_id":%s,"prefill_tokens_done":%s,"prefill_tokens_total":%s,"updated_at":"%s"}\n' \
    "\${load_phase}" "\${load_progress}" "\${prefill_progress}" "\${prefill_task_id}" "\${prefill_tokens_done}" "\${prefill_tokens_total}" "\$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >"\${progress_file}"
}

set_load_progress() {
  load_phase="\$1"
  load_progress="\$2"
  write_telemetry
}

set_prefill_progress() {
  prefill_task_id="\$1"
  prefill_tokens_done="\$2"
  prefill_tokens_total="\$3"
  prefill_progress="\$4"
  write_telemetry
}

clear_prefill_progress() {
  prefill_progress="null"
  prefill_task_id="null"
  prefill_tokens_done="null"
  prefill_tokens_total="null"
  write_telemetry
}

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

tmp_dir="\${TMPDIR:-/tmp}"
stderr_fifo="\$(mktemp "\${tmp_dir%/}/local-model-gateway-stderr.XXXXXX")"
rm -f "\${stderr_fifo}"
mkfifo "\${stderr_fifo}"
stderr_reader_pid=""

cleanup() {
  rm -f "\${stderr_fifo}"
  if [[ -n "\${stderr_reader_pid}" ]]; then
    kill "\${stderr_reader_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

while IFS= read -r line; do
  if [[ "\${line}" == *"main: loading model"* ]]; then
    set_load_progress "loading_model" "0.0800"
  elif [[ "\${line}" == *"common_init_result: fitting params"* ]]; then
    set_load_progress "fitting_memory" "0.1000"
  elif [[ "\${line}" == *"load_tensors: loading model tensors"* ]]; then
    set_load_progress "loading_tensors" "0.1500"
  elif [[ "\${line}" =~ load_tensors:.*offloaded[[:space:]]+([0-9]+)/([0-9]+)[[:space:]]+layers ]]; then
    done_layers="\${BASH_REMATCH[1]}"
    total_layers="\${BASH_REMATCH[2]}"
    layer_progress="\$(awk -v done="\${done_layers}" -v total="\${total_layers}" 'BEGIN { if (total <= 0) total = 1; printf "%.4f", 0.20 + 0.20 * (done / total) }')"
    set_load_progress "offloading_layers" "\${layer_progress}"
  elif [[ "\${line}" =~ ^[.]+$ ]]; then
    dot_count="\${#line}"
    tensor_progress="\$(awk -v dots="\${dot_count}" 'BEGIN { p = dots / 100; if (p > 1) p = 1; printf "%.4f", 0.40 + 0.35 * p }')"
    set_load_progress "loading_tensors" "\${tensor_progress}"
  elif [[ "\${line}" == *"llama_context: constructing llama_context"* ]]; then
    set_load_progress "allocating_context" "0.7800"
  elif [[ "\${line}" == *"llama_kv_cache:"* ]]; then
    set_load_progress "allocating_kv_cache" "0.8400"
  elif [[ "\${line}" == *"sched_reserve:"* ]]; then
    set_load_progress "reserving_scheduler" "0.9000"
  elif [[ "\${line}" == *"srv    load_model: initializing slots"* ]]; then
    set_load_progress "initializing_slots" "0.9500"
  elif [[ "\${line}" == *"main: model loaded"* ]]; then
    set_load_progress "model_loaded" "0.9800"
  elif [[ "\${line}" == *"main: server is listening"* ]]; then
    set_load_progress "ready" "1.0000"
  elif [[ "\${line}" =~ slot[[:space:]]+update_slots:.*task[[:space:]]+([0-9]+).*new[[:space:]]+prompt.*task.n_tokens[[:space:]]+=[[:space:]]+([0-9]+) ]]; then
    prefill_task_id="\${BASH_REMATCH[1]}"
    prefill_tokens_total="\${BASH_REMATCH[2]}"
    prefill_tokens_done="0"
    prefill_progress="0.0000"
    write_telemetry
  elif [[ "\${line}" =~ slot[[:space:]]+update_slots:.*task[[:space:]]+([0-9]+).*prompt[[:space:]]+processing[[:space:]]+progress.*n_tokens[[:space:]]+=[[:space:]]+([0-9]+).*progress[[:space:]]+=[[:space:]]+([0-9.]+) ]]; then
    task_id="\${BASH_REMATCH[1]}"
    tokens_done="\${BASH_REMATCH[2]}"
    progress="\$(normalize_progress "\${BASH_REMATCH[3]}")"
    tokens_total="\${prefill_tokens_total}"
    if [[ "\${tokens_total}" == "null" || -z "\${tokens_total}" ]]; then
      tokens_total="\$(awk -v done="\${tokens_done}" -v progress="\${progress}" 'BEGIN { if (progress <= 0) print "null"; else printf "%d", done / progress }')"
    fi
    set_prefill_progress "\${task_id}" "\${tokens_done}" "\${tokens_total}" "\${progress}"
  elif [[ "\${line}" =~ slot[[:space:]]+update_slots:.*task[[:space:]]+([0-9]+).*prompt[[:space:]]+processing[[:space:]]+done ]]; then
    if [[ "\${prefill_tokens_total}" != "null" ]]; then
      set_prefill_progress "\${BASH_REMATCH[1]}" "\${prefill_tokens_total}" "\${prefill_tokens_total}" "1.0000"
    fi
  elif [[ "\${line}" == *"slot      release:"* || "\${line}" == *"srv  update_slots: all slots are idle"* ]]; then
    clear_prefill_progress
  elif [[ "\${line}" =~ ([0-9]{1,3}([.][0-9]+)?)% && "\${load_progress}" != "1.0000" ]]; then
    pct="\${BASH_REMATCH[1]}"
    normalized="\$(normalize_progress "\${pct}")"
    set_load_progress "\${load_phase}" "\${normalized}"
  fi
  printf '%s\n' "\${line}" >&2
done < "\${stderr_fifo}" &
stderr_reader_pid="\$!"

set +e
"\${cmd[@]}" "\${extra_args[@]}" 2>"\${stderr_fifo}"
cmd_status="\$?"
wait "\${stderr_reader_pid}" 2>/dev/null || true
stderr_reader_pid=""
set -e
exit "\${cmd_status}"
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
$(write_key_bool RunAtLoad "${RUNTIME_RUN_AT_LOAD}")
$(write_key_bool KeepAlive "${RUNTIME_KEEP_ALIVE}")
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
