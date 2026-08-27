#!/usr/bin/env bash

set -euo pipefail

ENVIRONMENT=""
DATABASE_HOST=""
DATABASE_PORT=""
DATABASE_USERNAME=""
SSL_MODE=""

usage() {
  printf '%s\n' "用法: configure.sh --env <dev|pre|prod> [--host <地址>] [--port <端口>] [--username <只读账号>] [--ssl-mode <PREFERRED|REQUIRED|VERIFY_CA|VERIFY_IDENTITY>]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENVIRONMENT="${2-}"
      shift 2
      ;;
    --host)
      DATABASE_HOST="${2-}"
      shift 2
      ;;
    --port)
      DATABASE_PORT="${2-}"
      shift 2
      ;;
    --username)
      DATABASE_USERNAME="${2-}"
      shift 2
      ;;
    --ssl-mode)
      SSL_MODE="${2-}"
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

case "$ENVIRONMENT" in
  dev|pre)
    ;;
  prod|production|生产)
    ENVIRONMENT="prod"
    ;;
  *)
    printf '%s\n' "--env 只支持 dev、pre 或 prod" >&2
    exit 2
    ;;
esac

if [[ -z "$DATABASE_HOST" ]]; then
  read -r -p "请输入 ${ENVIRONMENT} 环境 MySQL Host: " DATABASE_HOST
fi

if [[ -z "$DATABASE_PORT" ]]; then
  read -r -p "请输入 ${ENVIRONMENT} 环境 MySQL Port: " DATABASE_PORT
fi

if [[ -z "$DATABASE_USERNAME" ]]; then
  read -r -p "请输入 ${ENVIRONMENT} 环境 MySQL 只读账号: " DATABASE_USERNAME
fi

if [[ -z "$SSL_MODE" ]]; then
  if [[ "$ENVIRONMENT" == "dev" ]]; then
    SSL_MODE="PREFERRED"
  else
    SSL_MODE="REQUIRED"
  fi
fi

if [[ ! "$DATABASE_HOST" =~ ^[A-Za-z0-9.-]+$ ]]; then
  printf '%s\n' "数据库 Host 格式不合法" >&2
  exit 2
fi

if [[ ! "$DATABASE_PORT" =~ ^[0-9]+$ ]] || (( DATABASE_PORT < 1 || DATABASE_PORT > 65535 )); then
  printf '%s\n' "数据库端口必须在 1 到 65535 之间" >&2
  exit 2
fi

case "$SSL_MODE" in
  PREFERRED|REQUIRED|VERIFY_CA|VERIFY_IDENTITY)
    ;;
  *)
    printf '%s\n' "SSL 模式只支持 PREFERRED、REQUIRED、VERIFY_CA 或 VERIFY_IDENTITY" >&2
    exit 2
    ;;
esac

if [[ -z "$DATABASE_USERNAME" || "$DATABASE_USERNAME" == *$'\n'* || "$DATABASE_USERNAME" == *$'\r'* ]]; then
  printf '%s\n' "数据库用户名不能为空或包含换行" >&2
  exit 2
fi

if ! command -v security >/dev/null 2>&1; then
  printf '%s\n' "当前系统没有 macOS security 命令，无法安全托管凭据" >&2
  exit 4
fi

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "未找到 jq，无法安全生成环境配置" >&2
  exit 4
fi

KEYCHAIN_SERVICE="codex.mysql-search.${ENVIRONMENT}"
CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIRECTORY="${CONFIG_BASE}/fangzhikun-skills/mysql-search"
CONFIG_FILE="${CONFIG_DIRECTORY}/${ENVIRONMENT}.json"

printf '%s\n' "即将配置 ${ENVIRONMENT}: host=${DATABASE_HOST}, port=${DATABASE_PORT}, user=${DATABASE_USERNAME}, ssl=${SSL_MODE}"
printf '%s\n' "请在接下来的 macOS 钥匙串提示中输入一次数据库密码。"

# 把 -w 放在最后且不携带参数，让 security 自行安全提示密码，避免密码进入命令行和历史。
security add-generic-password \
  -U \
  -s "$KEYCHAIN_SERVICE" \
  -a "$DATABASE_USERNAME" \
  -D "MySQL read-only credential" \
  -j "Codex mysql-search ${ENVIRONMENT}" \
  -w

mkdir -p "$CONFIG_DIRECTORY"
chmod 700 "$CONFIG_DIRECTORY"

TEMP_CONFIG="$(mktemp "${CONFIG_DIRECTORY}/.${ENVIRONMENT}.XXXXXX")"
trap 'rm -f "$TEMP_CONFIG"' EXIT

jq -n \
  --arg environment "$ENVIRONMENT" \
  --arg host "$DATABASE_HOST" \
  --argjson port "$DATABASE_PORT" \
  --arg username "$DATABASE_USERNAME" \
  --arg sslMode "$SSL_MODE" \
  --arg keychainService "$KEYCHAIN_SERVICE" \
  '{environment: $environment, host: $host, port: $port, username: $username, sslMode: $sslMode, keychainService: $keychainService}' \
  >"$TEMP_CONFIG"

chmod 600 "$TEMP_CONFIG"
mv "$TEMP_CONFIG" "$CONFIG_FILE"
trap - EXIT

printf '%s\n' "配置完成：${CONFIG_FILE}；密码已保存到 macOS 钥匙串。"
