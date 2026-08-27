#!/usr/bin/env bash

set -euo pipefail

APP_RELATIVE_PATH=""
KEYWORD=""
MINUTES="30"
CONTEXT="8"
LIMIT="300"
CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
RUNTIME_CONFIG="${FANGZHIKUN_SKILLS_CONFIG:-${CONFIG_BASE}/fangzhikun-skills/runtime.json}"

usage() {
  printf '%s\n' "用法: dev_search.sh --keyword <固定字符串> [--app <相对配置日志根目录的路径>] [--minutes <1-43200>] [--context <0-20>] [--limit <1-2000>]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keyword)
      KEYWORD="${2-}"
      shift 2
      ;;
    --app)
      APP_RELATIVE_PATH="${2-}"
      shift 2
      ;;
    --minutes)
      MINUTES="${2-}"
      shift 2
      ;;
    --context)
      CONTEXT="${2-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '未知参数: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$KEYWORD" ]]; then
  printf '%s\n' "--keyword 不能为空" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "未找到 jq，无法读取本机日志环境配置" >&2
  exit 4
fi

if [[ ! -f "$RUNTIME_CONFIG" ]]; then
  printf '缺少本机配置：%s\n' "$RUNTIME_CONFIG" >&2
  exit 4
fi

DEV_LOG_HOST="$(jq -er '.logSearch.dev.sshAlias' "$RUNTIME_CONFIG")"
DEV_LOG_ROOT="$(jq -er '.logSearch.dev.root' "$RUNTIME_CONFIG")"

if [[ ! "$DEV_LOG_HOST" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  printf '%s\n' "logSearch.dev.sshAlias 格式不合法" >&2
  exit 4
fi

if [[ "$DEV_LOG_ROOT" != /* || "$DEV_LOG_ROOT" == *".."* || ! "$DEV_LOG_ROOT" =~ ^/[[:alnum:]_.\/-]+$ ]]; then
  printf '%s\n' "logSearch.dev.root 必须是安全的绝对路径" >&2
  exit 4
fi

if (( ${#KEYWORD} > 2000 )); then
  printf '%s\n' "--keyword 长度不能超过 2000 个字符" >&2
  exit 2
fi

# 仅允许配置日志根目录下的相对目录，避免查询范围逃逸。
if [[ "$APP_RELATIVE_PATH" == /* || "$APP_RELATIVE_PATH" == *".."* || ! "$APP_RELATIVE_PATH" =~ ^[[:alnum:]_.\/-]*$ ]]; then
  printf '%s\n' "--app 必须是不含 .. 的安全相对目录" >&2
  exit 2
fi

if [[ ! "$MINUTES" =~ ^[0-9]+$ ]] || (( MINUTES < 1 || MINUTES > 43200 )); then
  printf '%s\n' "--minutes 必须在 1 到 43200 之间" >&2
  exit 2
fi

if [[ ! "$CONTEXT" =~ ^[0-9]+$ ]] || (( CONTEXT < 0 || CONTEXT > 20 )); then
  printf '%s\n' "--context 必须在 0 到 20 之间" >&2
  exit 2
fi

if [[ ! "$LIMIT" =~ ^[0-9]+$ ]] || (( LIMIT < 1 || LIMIT > 2000 )); then
  printf '%s\n' "--limit 必须在 1 到 2000 之间" >&2
  exit 2
fi

# OpenSSH 会把远端参数重新拼成命令字符串，因此先编码文本参数，避免远端 shell 求值。
APP_RELATIVE_PATH_BASE64="encoded:$(printf '%s' "$APP_RELATIVE_PATH" | base64 | tr -d '\n')"
KEYWORD_BASE64="encoded:$(printf '%s' "$KEYWORD" | base64 | tr -d '\n')"
DEV_LOG_ROOT_BASE64="encoded:$(printf '%s' "$DEV_LOG_ROOT" | base64 | tr -d '\n')"

ssh -o BatchMode=yes -o ConnectTimeout=8 "$DEV_LOG_HOST" bash -s -- \
  "$APP_RELATIVE_PATH_BASE64" "$KEYWORD_BASE64" "$DEV_LOG_ROOT_BASE64" "$MINUTES" "$CONTEXT" "$LIMIT" <<'REMOTE_SCRIPT'
set -euo pipefail

app_relative_path="$(printf '%s' "${1#encoded:}" | base64 -d)"
keyword="$(printf '%s' "${2#encoded:}" | base64 -d)"
search_root="$(printf '%s' "${3#encoded:}" | base64 -d)"
minutes="$4"
context="$5"
limit="$6"

if [[ -n "$app_relative_path" ]]; then
  search_root="${search_root}/${app_relative_path}"
fi

if [[ ! -d "$search_root" ]]; then
  printf '日志目录不存在: %s\n' "$search_root" >&2
  exit 3
fi

# 先限制文件更新时间和常见日志扩展名，再进行固定字符串查询。
find "$search_root" -type f -mmin "-${minutes}" \
  \( -name '*.log' -o -name '*.log.*' -o -name '*.out' -o -name '*.txt' -o -name '*.gz' \) \
  -print0 2>/dev/null |
  while IFS= read -r -d '' log_file; do
    case "$log_file" in
      *.gz)
        zgrep -H -n -F -C "$context" -- "$keyword" "$log_file" 2>/dev/null || true
        ;;
      *)
        grep -H -n -F -C "$context" -- "$keyword" "$log_file" 2>/dev/null || true
        ;;
    esac
  done |
  head -n "$limit" || true
REMOTE_SCRIPT
