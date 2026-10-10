#!/usr/bin/env bash

set -euo pipefail

DEFAULT_ROW_LIMIT="200"
DEV_PRE_MAX_ROW_LIMIT="500"
PROD_MAX_ROW_LIMIT="200"
CONNECT_TIMEOUT_SECONDS="8"
EXECUTION_TIMEOUT_MILLISECONDS="15000"

CONNECTION="op"
CONNECTION_EXPLICIT="false"
ENVIRONMENT=""
DATABASE_NAME=""
SQL_TEXT=""
ROW_LIMIT="$DEFAULT_ROW_LIMIT"
OUTPUT_FORMAT="tsv"

usage() {
  printf '%s\n' "用法: query.sh [--connection <op|bpm>] --env <dev|pre|prod> --database <数据库> --sql <单条只读SQL> [--limit <行数>] [--format <tsv|table>]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --connection)
      CONNECTION="${2-}"
      CONNECTION_EXPLICIT="true"
      shift 2
      ;;
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

if [[ ! "$ROW_LIMIT" =~ ^[0-9]+$ ]] || [[ "${#ROW_LIMIT}" -gt 3 ]]; then
  printf '%s\n' "--limit 在 ${ENVIRONMENT} 环境必须位于 1 到 ${MAX_ROW_LIMIT} 之间" >&2
  exit 2
fi

ROW_LIMIT="$((10#$ROW_LIMIT))"
if (( ROW_LIMIT < 1 || ROW_LIMIT > MAX_ROW_LIMIT )); then
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

# 校验在读取环境配置/凭据和调用任何数据库客户端之前完成。
SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SQL_GUARD="${SCRIPT_DIRECTORY}/sql_guard.py"
CONNECTION_POLICY="${SCRIPT_DIRECTORY}/connections.py"
if ! command -v python3 >/dev/null 2>&1 || [[ ! -f "$SQL_GUARD" || ! -f "$CONNECTION_POLICY" ]]; then
  printf '%s\n' "查询需要 python3、sql_guard.py 和 connections.py，缺失时禁止执行" >&2
  exit 4
fi
if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "查询需要 jq 命令" >&2
  exit 4
fi
if ! CONNECTION_IDENTITY="$(python3 "$CONNECTION_POLICY" identity --connection "$CONNECTION" --env "$ENVIRONMENT")"; then
  exit 4
fi
CONNECTION="$(printf '%s' "$CONNECTION_IDENTITY" | jq -er '.connection')"
if [[ "$CONNECTION" == "bpm" && ! -f "${SCRIPT_DIRECTORY}/mysql_readonly.py" ]]; then
  printf '%s\n' "缺少 BPM 只读会话执行器，禁止执行" >&2
  exit 4
fi

if ! QUERY_PLAN="$(printf '%s' "$SQL_TEXT" | python3 "$SQL_GUARD" --database "$DATABASE_NAME" --limit "$ROW_LIMIT")"; then
  exit 3
fi
SQL_TEXT="$(printf '%s' "$QUERY_PLAN" | jq -er '.sql')"
METADATA_SQL="$(printf '%s' "$QUERY_PLAN" | jq -r '.metadata_sql')"

RESOLVE_ARGUMENTS=(resolve --connection "$CONNECTION" --env "$ENVIRONMENT" --database "$DATABASE_NAME")
if [[ "$CONNECTION_EXPLICIT" == "false" ]]; then
  RESOLVE_ARGUMENTS+=(--implicit-op)
fi
if ! CONNECTION_ROUTE="$(python3 "$CONNECTION_POLICY" "${RESOLVE_ARGUMENTS[@]}")"; then
  exit 4
fi
CONFIG_FILE="$(printf '%s' "$CONNECTION_ROUTE" | jq -er '.configFile')"
TRANSPORT="$(printf '%s' "$CONNECTION_ROUTE" | jq -er '.transport')"
CONNECTION_NAME="$(printf '%s' "$CONNECTION_ROUTE" | jq -er '.displayName')"
printf '查询目标：%s | env=%s | database=%s | transport=%s\n' "$CONNECTION_NAME" "$ENVIRONMENT" "$DATABASE_NAME" "$TRANSPORT" >&2

# 通道绑定连接+环境；OP prod 始终 DMS，BPM prod 始终 MySQL。
if [[ "$TRANSPORT" == "dms" ]]; then
  if ! command -v aliyun >/dev/null 2>&1; then
    printf '%s\n' "未找到阿里云 CLI，请阅读 references/setup.md" >&2
    exit 4
  fi

  if [[ "$(jq -r '.transport // empty' "$CONFIG_FILE")" != "dms" ]]; then
    printf '%s\n' "prod 配置不是 DMS 格式，请重新运行 scripts/configure.sh --connection op --env prod" >&2
    exit 4
  fi

  if ! jq -e --arg database_name "$DATABASE_NAME" '
    (.region | type == "string" and length > 0)
    and (.tenantId | tostring | test("^[0-9]+$"))
    and (.aliyunProfile | type == "string" and length > 0)
    and (.databases[$database_name].dbId | tostring | test("^[0-9]+$"))
    and (.databases[$database_name].logic | type == "boolean")
  ' "$CONFIG_FILE" >/dev/null 2>&1; then
    printf '%s\n' "prod 未配置数据库 ${DATABASE_NAME} 的有效 DMS 路由，请先运行 scripts/configure.sh --connection op --env prod" >&2
    exit 4
  fi

  DMS_REGION="$(jq -r '.region' "$CONFIG_FILE")"
  DMS_TENANT_ID="$(jq -r '.tenantId | tostring' "$CONFIG_FILE")"
  ALIYUN_PROFILE="$(jq -r '.aliyunProfile' "$CONFIG_FILE")"
  DMS_DATABASE_ID="$(jq -r --arg database_name "$DATABASE_NAME" '.databases[$database_name].dbId | tostring' "$CONFIG_FILE")"
  DMS_LOGIC="$(jq -r --arg database_name "$DATABASE_NAME" '.databases[$database_name].logic | tostring' "$CONFIG_FILE")"

  if [[ ! "$DMS_REGION" =~ ^[A-Za-z0-9-]+$ ]] \
    || [[ ! "$ALIYUN_PROFILE" =~ ^[A-Za-z0-9_.@-]+$ ]] \
    || [[ "$DMS_LOGIC" != "true" && "$DMS_LOGIC" != "false" ]]; then
    printf '%s\n' "prod DMS 配置格式不合法，请重新运行 scripts/configure.sh --connection op --env prod" >&2
    exit 4
  fi

  TEMP_DIRECTORY="$(mktemp -d)"
  DMS_RESPONSE_FILE="${TEMP_DIRECTORY}/response.json"
  DMS_ERROR_FILE="${TEMP_DIRECTORY}/error.log"

  cleanup_dms_files() {
    rm -f "$DMS_RESPONSE_FILE" "$DMS_ERROR_FILE"
    rmdir "$TEMP_DIRECTORY" 2>/dev/null || true
  }
  trap cleanup_dms_files EXIT
  umask 077

  execute_dms() {
    local DMS_SQL="$1"
    local DMS_ROW_LIMIT="$2"
    if ! aliyun dms-enterprise ExecuteScript \
      --region "$DMS_REGION" \
      --profile "$ALIYUN_PROFILE" \
      --DbId "$DMS_DATABASE_ID" \
      --Logic "$DMS_LOGIC" \
      --Script "$DMS_SQL" \
      --Tid "$DMS_TENANT_ID" \
      >"$DMS_RESPONSE_FILE" 2>"$DMS_ERROR_FILE"; then
      printf '%s\n' "DMS 查询调用失败，请检查阿里云 CLI 身份、网络及 dms:ExecuteScript 权限" >&2
      exit 5
    fi

    if ! jq -e 'type == "object"' "$DMS_RESPONSE_FILE" >/dev/null 2>&1; then
      printf '%s\n' "DMS 返回了无法识别的结果格式" >&2
      exit 5
    fi

    if [[ "$(jq -r '.Success // false' "$DMS_RESPONSE_FILE")" != "true" ]]; then
      DMS_ERROR_CODE="$(jq -r '.ErrorCode // "UNKNOWN"' "$DMS_RESPONSE_FILE")"
      DMS_REQUEST_ID="$(jq -r '.RequestId // "UNKNOWN"' "$DMS_RESPONSE_FILE")"
      printf 'DMS 查询失败：errorCode=%s, requestId=%s\n' "$DMS_ERROR_CODE" "$DMS_REQUEST_ID" >&2
      exit 5
    fi

    DMS_RESULT_COUNT="$(jq '[.Results // [] | if type == "array" then .[] elif type == "object" and has("Result") then .Result[] else empty end] | length' "$DMS_RESPONSE_FILE")"
    if [[ "$DMS_RESULT_COUNT" != "1" ]]; then
      printf '%s\n' "DMS 返回结果数量异常，已拒绝输出" >&2
      exit 5
    fi

    if [[ "$(jq -r '(.Results // [] | if type == "array" then .[0] elif type == "object" and has("Result") then .Result[0] else {} end).Success // false' "$DMS_RESPONSE_FILE")" != "true" ]]; then
      printf '%s\n' "DMS 未能执行只读 SQL，请检查 SQL、DMS 数据库权限和安全规则" >&2
      exit 5
    fi

    DMS_RETURNED_ROWS="$(jq '(.Results // [] | if type == "array" then .[0] elif type == "object" and has("Result") then .Result[0] else {} end).Rows // [] | length' "$DMS_RESPONSE_FILE")"
    DMS_DECLARED_ROW_COUNT="$(jq -r '(.Results // [] | if type == "array" then .[0] elif type == "object" and has("Result") then .Result[0] else {} end).RowCount // 0' "$DMS_RESPONSE_FILE")"
    if [[ ! "$DMS_DECLARED_ROW_COUNT" =~ ^[0-9]+$ ]] \
      || [[ "${#DMS_DECLARED_ROW_COUNT}" -gt 3 ]] \
      || (( DMS_RETURNED_ROWS > DMS_ROW_LIMIT || 10#$DMS_DECLARED_ROW_COUNT > DMS_ROW_LIMIT )); then
      printf '%s\n' "DMS 返回行数超过 ${DMS_ROW_LIMIT}，已拒绝输出" >&2
      exit 5
    fi
  }

  # 元数据查询由校验器根据解析出的表名生成，不接受用户替换。
  # 无法确认基础表/原生引擎时停止，禁止通过视图隐藏函数副作用。
  if [[ -n "$METADATA_SQL" ]]; then
    execute_dms "$METADATA_SQL" 65
    if ! python3 "$SQL_GUARD" --verify dms --plan "$QUERY_PLAN" <"$DMS_RESPONSE_FILE"; then
      exit 3
    fi
  fi
  execute_dms "$SQL_TEXT" "$ROW_LIMIT"

  render_dms_tsv() {
    jq -r '
      def result:
        .Results // []
        | if type == "array" then .[0]
          elif type == "object" and has("Result") then .Result[0]
          else {}
          end;
      def cell:
        if . == null then ""
        elif type == "array" or type == "object" then tojson
        else tostring
        end;
      result as $result
      | ($result.ColumnNames // []) as $columns
      | ($columns | @tsv),
        (($result.Rows // [])[] | . as $row | [$columns[] as $column | ($row[$column] | cell)] | @tsv)
    ' "$DMS_RESPONSE_FILE"
  }

  if [[ "$OUTPUT_FORMAT" == "table" ]] && command -v column >/dev/null 2>&1; then
    render_dms_tsv | column -t -s $'\t'
  else
    render_dms_tsv
  fi

  exit 0
fi

if ! command -v security >/dev/null 2>&1; then
  printf '%s\n' "MySQL 直连需要 macOS security 命令" >&2
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

DATABASE_HOST="$(jq -er '.host' "$CONFIG_FILE")"
DATABASE_PORT="$(jq -er '.port' "$CONFIG_FILE")"
DATABASE_USERNAME="$(jq -er '.username' "$CONFIG_FILE")"
SSL_MODE="$(jq -er '.sslMode' "$CONFIG_FILE")"
KEYCHAIN_SERVICE="$(jq -er '.keychainService' "$CONFIG_FILE")"
SSL_CA="$(jq -r '.sslCa // empty' "$CONFIG_FILE")"

if [[ ! "$DATABASE_HOST" =~ ^[A-Za-z0-9.-]+$ ]] \
  || [[ ! "$DATABASE_PORT" =~ ^[0-9]{1,5}$ ]] \
  || (( 10#$DATABASE_PORT < 1 || 10#$DATABASE_PORT > 65535 )) \
  || [[ "$SSL_MODE" != "PREFERRED" && "$SSL_MODE" != "REQUIRED" && "$SSL_MODE" != "VERIFY_CA" && "$SSL_MODE" != "VERIFY_IDENTITY" ]] \
  || [[ "$DATABASE_USERNAME" == *$'\n'* || "$DATABASE_USERNAME" == *$'\r'* ]]; then
  printf '%s\n' "MySQL 直连配置不合法，禁止执行" >&2
  exit 4
fi

DATABASE_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$DATABASE_USERNAME" -w 2>/dev/null || true)"
if [[ -z "$DATABASE_PASSWORD" ]]; then
  printf '%s\n' "未找到 ${ENVIRONMENT} 环境钥匙串凭据，请重新运行 scripts/configure.sh --connection ${CONNECTION} --env ${ENVIRONMENT}" >&2
  exit 4
fi

escape_option_value() {
  local option_value="$1"
  option_value="${option_value//\\/\\\\}"
  option_value="${option_value//\"/\\\"}"
  option_value="${option_value//$'\n'/\\n}"
  option_value="${option_value//$'\r'/\\r}"
  option_value="${option_value//$'\t'/\\t}"
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
  if [[ -n "$SSL_CA" ]]; then
    printf 'ssl-ca="%s"\n' "$(escape_option_value "$SSL_CA")"
  fi
  printf '%s\n' 'default-character-set=utf8mb4'
} >"$OPTION_FILE"
chmod 600 "$OPTION_FILE"
unset DATABASE_PASSWORD

MYSQL_ARGUMENTS=(
  "--defaults-file=${OPTION_FILE}"
  "--no-login-paths"
  "--connect-timeout=${CONNECT_TIMEOUT_SECONDS}"
  "--init-command=SET SESSION MAX_EXECUTION_TIME=${EXECUTION_TIMEOUT_MILLISECONDS}, transaction_read_only=ON"
  "--safe-updates"
  "--select-limit=${ROW_LIMIT}"
  "--raw"
  "--binary-mode"
  "--local-infile=0"
  "--skip-reconnect"
  "--skip-force"
)

if [[ "$CONNECTION" == "bpm" ]]; then
  if [[ ! -f "${SCRIPT_DIRECTORY}/mysql_readonly.py" ]]; then
    printf '%s\n' "缺少 BPM 只读会话执行器，禁止执行" >&2
    exit 4
  fi
  python3 "${SCRIPT_DIRECTORY}/mysql_readonly.py" --mysql-bin "$MYSQL_BIN" --option-file "$OPTION_FILE" \
    --database "$DATABASE_NAME" --limit "$ROW_LIMIT" --format "$OUTPUT_FORMAT" --plan "$QUERY_PLAN"
  exit "$?"
fi

if [[ "$OUTPUT_FORMAT" == "table" ]]; then
  MYSQL_ARGUMENTS+=("--table")
else
  MYSQL_ARGUMENTS+=("--batch")
fi

if [[ -n "$METADATA_SQL" ]]; then
  if ! METADATA_ROWS="$("$MYSQL_BIN" "${MYSQL_ARGUMENTS[@]}" --skip-table --batch --skip-column-names --execute="START TRANSACTION READ ONLY; ${METADATA_SQL}; ROLLBACK")"; then
    printf '%s\n' "目标表元数据核验失败，禁止执行查询" >&2
    exit 5
  fi
  if ! printf '%s' "$METADATA_ROWS" | python3 "$SQL_GUARD" --verify tsv --plan "$QUERY_PLAN"; then
    exit 3
  fi
fi
"$MYSQL_BIN" "${MYSQL_ARGUMENTS[@]}" --execute="START TRANSACTION READ ONLY; ${SQL_TEXT}; ROLLBACK"
