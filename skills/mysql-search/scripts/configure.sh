#!/usr/bin/env bash

set -euo pipefail

ENVIRONMENT=""
DATABASE_HOST=""
DATABASE_PORT=""
DATABASE_USERNAME=""
SSL_MODE=""
DATABASE_NAME=""
DMS_DATABASE_ID=""
DMS_LOGIC=""
DMS_REGION=""
DMS_TENANT_ID=""
ALIYUN_PROFILE=""

usage() {
  printf '%s\n' "用法:"
  printf '%s\n' "  configure.sh --env <dev|pre> [--host <地址>] [--port <端口>] [--username <只读账号>] [--ssl-mode <模式>]"
  printf '%s\n' "  configure.sh --env prod [--database <数据库>] [--db-id <DMS数据库ID>] [--logic <true|false>] [--region <地域>] [--tenant-id <DMS租户ID>] [--aliyun-profile <CLI配置名>]"
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
    --database)
      DATABASE_NAME="${2-}"
      shift 2
      ;;
    --db-id)
      DMS_DATABASE_ID="${2-}"
      shift 2
      ;;
    --logic)
      DMS_LOGIC="${2-}"
      shift 2
      ;;
    --region)
      DMS_REGION="${2-}"
      shift 2
      ;;
    --tenant-id)
      DMS_TENANT_ID="${2-}"
      shift 2
      ;;
    --aliyun-profile)
      ALIYUN_PROFILE="${2-}"
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

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "未找到 jq，无法安全生成环境配置" >&2
  exit 4
fi

CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIRECTORY="${CONFIG_BASE}/fangzhikun-skills/mysql-search"
CONFIG_FILE="${CONFIG_DIRECTORY}/${ENVIRONMENT}.json"

# 生产环境只登记 DMS 路由信息。阿里云凭据继续由 CLI 官方配置管理，不写入本文件。
if [[ "$ENVIRONMENT" == "prod" ]]; then
  DATABASES_JSON='{}'

  if [[ -f "$CONFIG_FILE" ]] && jq -e '.transport == "dms" and (.databases | type == "object")' "$CONFIG_FILE" >/dev/null 2>&1; then
    DATABASES_JSON="$(jq -c '.databases' "$CONFIG_FILE")"
    DMS_REGION="${DMS_REGION:-$(jq -r '.region // empty' "$CONFIG_FILE")}"
    DMS_TENANT_ID="${DMS_TENANT_ID:-$(jq -r '.tenantId // empty' "$CONFIG_FILE")}"
    ALIYUN_PROFILE="${ALIYUN_PROFILE:-$(jq -r '.aliyunProfile // empty' "$CONFIG_FILE")}"
  fi

  if [[ -z "$DATABASE_NAME" ]]; then
    read -r -p "请输入 prod 环境数据库名: " DATABASE_NAME
  fi

  # 已登记数据库默认复用原 DbId 和逻辑库标记，只有显式传参时才覆盖。
  if [[ -z "$DMS_DATABASE_ID" ]]; then
    DMS_DATABASE_ID="$(jq -r --arg database_name "$DATABASE_NAME" '.[$database_name].dbId // empty' <<<"$DATABASES_JSON")"
  fi

  if [[ -z "$DMS_LOGIC" ]]; then
    DMS_LOGIC="$(jq -r --arg database_name "$DATABASE_NAME" '.[$database_name].logic | if type == "boolean" then tostring else empty end' <<<"$DATABASES_JSON")"
  fi

  if [[ -z "$DMS_DATABASE_ID" ]]; then
    read -r -p "请输入该数据库的 DMS DbId: " DMS_DATABASE_ID
  fi

  if [[ -z "$DMS_LOGIC" ]]; then
    read -r -p "是否为 DMS 逻辑库 true/false [false]: " DMS_LOGIC
    DMS_LOGIC="${DMS_LOGIC:-false}"
  fi

  if [[ -z "$DMS_REGION" ]]; then
    read -r -p "请输入阿里云 DMS 地域，例如 cn-hangzhou: " DMS_REGION
  fi

  if [[ -z "$DMS_TENANT_ID" ]]; then
    read -r -p "请输入 DMS 租户 ID: " DMS_TENANT_ID
  fi

  if [[ -z "$ALIYUN_PROFILE" ]]; then
    read -r -p "请输入阿里云 CLI profile [default]: " ALIYUN_PROFILE
    ALIYUN_PROFILE="${ALIYUN_PROFILE:-default}"
  fi

  if [[ ! "$DATABASE_NAME" =~ ^[A-Za-z0-9_]+$ ]]; then
    printf '%s\n' "数据库名不能为空，且只能包含字母、数字和下划线" >&2
    exit 2
  fi

  if [[ ! "$DMS_DATABASE_ID" =~ ^[0-9]+$ ]] || [[ "$DMS_DATABASE_ID" == "0" ]] \
    || [[ ! "$DMS_TENANT_ID" =~ ^[0-9]+$ ]] || [[ "$DMS_TENANT_ID" == "0" ]]; then
    printf '%s\n' "DMS DbId 和租户 ID 必须是正整数" >&2
    exit 2
  fi

  if [[ "$DMS_LOGIC" != "true" && "$DMS_LOGIC" != "false" ]]; then
    printf '%s\n' "--logic 只支持 true 或 false" >&2
    exit 2
  fi

  if [[ ! "$DMS_REGION" =~ ^[A-Za-z0-9-]+$ ]]; then
    printf '%s\n' "DMS 地域格式不合法" >&2
    exit 2
  fi

  if [[ ! "$ALIYUN_PROFILE" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
    printf '%s\n' "阿里云 CLI profile 格式不合法" >&2
    exit 2
  fi

  mkdir -p "$CONFIG_DIRECTORY"
  chmod 700 "$CONFIG_DIRECTORY"

  TEMP_CONFIG="$(mktemp "${CONFIG_DIRECTORY}/.${ENVIRONMENT}.XXXXXX")"
  trap 'rm -f "$TEMP_CONFIG"' EXIT

  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg transport "dms" \
    --arg region "$DMS_REGION" \
    --arg tenantId "$DMS_TENANT_ID" \
    --arg aliyunProfile "$ALIYUN_PROFILE" \
    --arg databaseName "$DATABASE_NAME" \
    --arg dbId "$DMS_DATABASE_ID" \
    --argjson logic "$DMS_LOGIC" \
    --argjson databases "$DATABASES_JSON" \
    '{
      environment: $environment,
      transport: $transport,
      region: $region,
      tenantId: $tenantId,
      aliyunProfile: $aliyunProfile,
      databases: ($databases + {($databaseName): {dbId: $dbId, logic: $logic}})
    }' \
    >"$TEMP_CONFIG"

  chmod 600 "$TEMP_CONFIG"
  mv "$TEMP_CONFIG" "$CONFIG_FILE"
  trap - EXIT

  printf '%s\n' "prod DMS 路由配置完成：${CONFIG_FILE}"
  printf '%s\n' "阿里云身份未写入该文件，查询时将使用 CLI profile: ${ALIYUN_PROFILE}"
  exit 0
fi

# dev 和 pre 继续使用专用 MySQL 只读账号直连。
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

KEYCHAIN_SERVICE="codex.mysql-search.${ENVIRONMENT}"

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
