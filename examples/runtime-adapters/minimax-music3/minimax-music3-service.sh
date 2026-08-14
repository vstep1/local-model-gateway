#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${SCRIPT_DIR}/minimax-music3"
PYTHON="${RUNTIME_DIR}/.venv/bin/python"
SERVER="${RUNTIME_DIR}/server.py"
MODEL_PATH="${RUNTIME_DIR}/model"
PROGRESS_PATH="${RUNTIME_DIR}/load-progress.json"
LABEL="ai.local.runtime.minimax-music3"
DOMAIN="gui/$(id -u)"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/local-model-gateway/minimax-music3"

write_plist() {
  mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}"
  local temporary="${PLIST}.tmp"
  sed \
    -e "s|__LABEL__|${LABEL}|g" \
    -e "s|__PYTHON__|${PYTHON}|g" \
    -e "s|__SERVER__|${SERVER}|g" \
    -e "s|__MODEL_PATH__|${MODEL_PATH}|g" \
    -e "s|__PROGRESS_PATH__|${PROGRESS_PATH}|g" \
    -e "s|__LOG_DIR__|${LOG_DIR}|g" >"${temporary}" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>__LABEL__</string>
  <key>ProgramArguments</key>
  <array><string>__PYTHON__</string><string>__SERVER__</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MINIMAX_MUSIC3_MODEL_PATH</key><string>__MODEL_PATH__</string>
    <key>MINIMAX_MUSIC3_PROGRESS_PATH</key><string>__PROGRESS_PATH__</string>
    <key>MINIMAX_MUSIC3_HOST</key><string>127.0.0.1</string>
    <key>MINIMAX_MUSIC3_PORT</key><string>18009</string>
    <key>MINIMAX_MUSIC3_DEVICE</key><string>mps</string>
    <key>MINIMAX_MUSIC3_DTYPE</key><string>bfloat16</string>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key><string>1</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
  </dict>
  <key>WorkingDirectory</key><string>__MODEL_PATH__</string>
  <key>StandardOutPath</key><string>__LOG_DIR__/stdout.log</string>
  <key>StandardErrorPath</key><string>__LOG_DIR__/stderr.log</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST_EOF
  mv "${temporary}" "${PLIST}"
  plutil -lint "${PLIST}" >/dev/null
}

case "${1:-status}" in
  start)
    [[ -x "${PYTHON}" ]] || { echo "Missing Python environment: ${PYTHON}" >&2; exit 1; }
    [[ -f "${MODEL_PATH}/modular_model_index.json" ]] || { echo "Model is not downloaded: ${MODEL_PATH}" >&2; exit 1; }
    write_plist
    if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
      launchctl kickstart -k "${DOMAIN}/${LABEL}"
    else
      launchctl bootstrap "${DOMAIN}" "${PLIST}"
    fi
    ;;
  stop)
    launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
    ;;
  status)
    launchctl print "${DOMAIN}/${LABEL}"
    ;;
  *)
    echo "Usage: $0 {start|stop|status}" >&2
    exit 2
    ;;
esac
