#!/usr/bin/env bash

set -euo pipefail

DEFAULT_ROW_LIMIT="200"
DEV_PRE_MAX_ROW_LIMIT="500"
PROD_MAX_ROW_LIMIT="200"
CONNECT_TIMEOUT_SECONDS="8"
EXECUTION_TIMEOUT_MILLISECONDS="15000"

ENVIRONMENT=""
DATABASE_NAME=""
SQL_TEXT=""
ROW_LIMIT="$DEFAULT_ROW_LIMIT"
OUTPUT_FORMAT="tsv"

usage() {
  printf '%s\n' "用法: query.sh --env <dev|pre|prod> --database <数据库> --sql <单条只读SQL> [--limit <行数>] [--format <tsv|table>]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENVIRONMENT="${2-}"
      shift 2
      ;;
    --database)
      DATABASE_NAME="${2-}"
      shift 2
      ;;
    --sql)
      SQL_TEXT="${2-}"
      shift 2
      ;;
    --limit)
      ROW_LIMIT="${2-}"
      shift 2
      ;;
    --format)
      OUTPUT_FORMAT="${2-}"
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
    MAX_ROW_LIMIT="$DEV_PRE_MAX_ROW_LIMIT"
    ;;
  prod|production|生产)
    ENVIRONMENT="prod"
    MAX_ROW_LIMIT="$PROD_MAX_ROW_LIMIT"
    ;;
  *)
    printf '%s\n' "--env 只支持 dev、pre 或 prod" >&2
    exit 2
    ;;
esac

if [[ -z "$SQL_TEXT" ]]; then
  printf '%s\n' "--sql 不能为空" >&2
  exit 2
fi

if [[ ! "$DATABASE_NAME" =~ ^[A-Za-z0-9_]+$ ]]; then
  printf '%s\n' "--database 不能为空，且只能包含字母、数字和下划线" >&2
  exit 2
fi

if [[ ! "$ROW_LIMIT" =~ ^[0-9]+$ ]] || (( ROW_LIMIT < 1 || ROW_LIMIT > MAX_ROW_LIMIT )); then
  printf '%s\n' "--limit 在 ${ENVIRONMENT} 环境必须位于 1 到 ${MAX_ROW_LIMIT} 之间" >&2
  exit 2
fi

case "$OUTPUT_FORMAT" in
  tsv|table)
    ;;
  *)
    printf '%s\n' "--format 只支持 tsv 或 table" >&2
    exit 2
    ;;
esac

# 允许一个结尾分号，但拒绝多语句、注释以及可能改变状态或读取服务器文件的 SELECT 变体。
SQL_TEXT="$(printf '%s' "$SQL_TEXT" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/;[[:space:]]*$//')"

if [[ -z "$SQL_TEXT" || "$SQL_TEXT" == *";"* ]]; then
  printf '%s\n' "只允许执行一条 SQL" >&2
  exit 3
fi

if [[ "$SQL_TEXT" =~ --[[:space:]] || "$SQL_TEXT" == *"/*"* || "$SQL_TEXT" == *"*/"* || "$SQL_TEXT" == *"#"* ]]; then
  printf '%s\n' "SQL 中不允许注释" >&2
  exit 3
fi

FIRST_KEYWORD="$(printf '%s' "$SQL_TEXT" | awk '{print toupper($1); exit}')"
case "$FIRST_KEYWORD" in
  SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)
    ;;
  *)
    printf '%s\n' "只允许 SELECT、SHOW、DESC/DESCRIBE 或 EXPLAIN" >&2
    exit 3
    ;;
esac

UPPER_SQL="$(printf '%s' "$SQL_TEXT" | tr '[:lower:]' '[:upper:]')"
if [[ "$UPPER_SQL" =~ INTO[[:space:]]+(OUTFILE|DUMPFILE) ]] \
  || [[ "$UPPER_SQL" =~ FOR[[:space:]]+UPDATE ]] \
  || [[ "$UPPER_SQL" =~ LOCK[[:space:]]+IN[[:space:]]+SHARE[[:space:]]+MODE ]] \
  || [[ "$UPPER_SQL" =~ (GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK|LOAD_FILE)[[:space:]]*\( ]]; then
  printf '%s\n' "SQL 包含被禁止的文件、锁定或资源消耗操作" >&2
  exit 3
fi

if ! command -v jq >/dev/null 2>&1 || ! command -v security >/dev/null 2>&1; then
  printf '%s\n' "查询需要 jq 和 macOS security 命令" >&2
  exit 4
fi

MYSQL_BIN="$(command -v mysql || true)"
if [[ -z "$MYSQL_BIN" ]] && command -v brew >/dev/null 2>&1; then
  MYSQL_PREFIX="$(brew --prefix mysql-client@8.0 2>/dev/null || true)"
  if [[ -n "$MYSQL_PREFIX" && -x "${MYSQL_PREFIX}/bin/mysql" ]]; then
    MYSQL_BIN="${MYSQL_PREFIX}/bin/mysql"
  fi
fi

if [[ -z "$MYSQL_BIN" || ! -x "$MYSQL_BIN" ]]; then
  printf '%s\n' "未找到 MySQL 8.0 客户端，请阅读 references/setup.md" >&2
  exit 4
fi

CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_FILE="${CONFIG_BASE}/fangzhikun-skills/mysql-search/${ENVIRONMENT}.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  printf '%s\n' "缺少 ${ENVIRONMENT} 环境配置，请先运行 scripts/configure.sh --env ${ENVIRONMENT}" >&2
  exit 4
fi

DATABASE_HOST="$(jq -er '.host' "$CONFIG_FILE")"
DATABASE_PORT="$(jq -er '.port' "$CONFIG_FILE")"
DATABASE_USERNAME="$(jq -er '.username' "$CONFIG_FILE")"
SSL_MODE="$(jq -er '.sslMode' "$CONFIG_FILE")"
KEYCHAIN_SERVICE="$(jq -er '.keychainService' "$CONFIG_FILE")"

DATABASE_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$DATABASE_USERNAME" -w 2>/dev/null || true)"
if [[ -z "$DATABASE_PASSWORD" ]]; then
  printf '%s\n' "未找到 ${ENVIRONMENT} 环境钥匙串凭据，请重新运行 scripts/configure.sh --env ${ENVIRONMENT}" >&2
  exit 4
fi

escape_option_value() {
  local option_value="$1"
  option_value="${option_value//\\/\\\\}"
  option_value="${option_value//\"/\\\"}"
  printf '%s' "$option_value"
}

TEMP_DIRECTORY="$(mktemp -d)"
OPTION_FILE="${TEMP_DIRECTORY}/client.cnf"

cleanup() {
  rm -f "$OPTION_FILE"
  rmdir "$TEMP_DIRECTORY" 2>/dev/null || true
}
trap cleanup EXIT
umask 077

{
  printf '%s\n' '[client]'
  printf 'user="%s"\n' "$(escape_option_value "$DATABASE_USERNAME")"
  printf 'password="%s"\n' "$(escape_option_value "$DATABASE_PASSWORD")"
  printf 'host="%s"\n' "$(escape_option_value "$DATABASE_HOST")"
  printf 'port=%s\n' "$DATABASE_PORT"
  printf 'database="%s"\n' "$(escape_option_value "$DATABASE_NAME")"
  printf 'ssl-mode=%s\n' "$SSL_MODE"
  printf '%s\n' 'default-character-set=utf8mb4'
} >"$OPTION_FILE"
chmod 600 "$OPTION_FILE"
unset DATABASE_PASSWORD

MYSQL_ARGUMENTS=(
  "--defaults-extra-file=${OPTION_FILE}"
  "--connect-timeout=${CONNECT_TIMEOUT_SECONDS}"
  "--init-command=SET SESSION MAX_EXECUTION_TIME=${EXECUTION_TIMEOUT_MILLISECONDS}"
  "--safe-updates"
  "--select-limit=${ROW_LIMIT}"
  "--raw"
)

if [[ "$OUTPUT_FORMAT" == "table" ]]; then
  MYSQL_ARGUMENTS+=("--table")
else
  MYSQL_ARGUMENTS+=("--batch")
fi

"$MYSQL_BIN" "${MYSQL_ARGUMENTS[@]}" --execute="START TRANSACTION READ ONLY; ${SQL_TEXT}; ROLLBACK"
