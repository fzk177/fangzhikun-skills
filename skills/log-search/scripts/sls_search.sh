#!/usr/bin/env bash

set -euo pipefail

ENVIRONMENT=""
FROM_TIME=""
TO_TIME=""
QUERY=""
CONTAINS_LITERAL=""
LINE_COUNT="100"
CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
RUNTIME_CONFIG="${FANGZHIKUN_SKILLS_CONFIG:-${CONFIG_BASE}/fangzhikun-skills/runtime.json}"

usage() {
  printf '%s\n' "用法: sls_search.sh --env <本机已登记环境> --from <北京时间> --to <北京时间> --query <SLS查询语句> [--contains <原文字面量>] [--line <1-500>]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENVIRONMENT="${2-}"
      shift 2
      ;;
    --from)
      FROM_TIME="${2-}"
      shift 2
      ;;
    --to)
      TO_TIME="${2-}"
      shift 2
      ;;
    --query)
      QUERY="${2-}"
      shift 2
      ;;
    --contains)
      CONTAINS_LITERAL="${2-}"
      shift 2
      ;;
    --line)
      LINE_COUNT="${2-}"
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

if [[ -z "$FROM_TIME" || -z "$TO_TIME" || -z "$QUERY" ]]; then
  printf '%s\n' "--from、--to 和 --query 均不能为空" >&2
  exit 2
fi

if [[ ! "$LINE_COUNT" =~ ^[0-9]+$ ]] || (( LINE_COUNT < 1 || LINE_COUNT > 500 )); then
  printf '%s\n' "--line 必须在 1 到 500 之间" >&2
  exit 2
fi

if ! command -v aliyunlog >/dev/null 2>&1; then
  printf '%s\n' "未找到 aliyunlog，请先阅读 references/setup.md 完成安装" >&2
  exit 4
fi

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' "未找到 jq，无法安全构造查询请求" >&2
  exit 4
fi

if [[ ! -f "$RUNTIME_CONFIG" ]]; then
  printf '缺少本机配置：%s\n' "$RUNTIME_CONFIG" >&2
  exit 4
fi

# 环境名和别名都来自本机配置，公开源码不保存真实 Project 或 Logstore。
MAPPING="$(jq -cer --arg environment "$ENVIRONMENT" '
  .logSearch.sls
  | to_entries
  | map(select(.key == $environment or ((.value.aliases // []) | index($environment))))
  | if length == 1 then .[0].value else empty end
' "$RUNTIME_CONFIG" 2>/dev/null || true)"

if [[ -z "$MAPPING" ]]; then
  printf '%s\n' "--env 未在本机 logSearch.sls 中唯一登记" >&2
  exit 2
fi

PROJECT="$(jq -er '.project' <<<"$MAPPING")"
LOGSTORE="$(jq -er '.logstore' <<<"$MAPPING")"

# 使用 jq 构造 JSON，确保查询文本只作为数据传递，不参与 shell 求值。
REQUEST_JSON="$(jq -cn \
  --arg topic "" \
  --arg logstore "$LOGSTORE" \
  --arg project "$PROJECT" \
  --arg from_time "$FROM_TIME" \
  --arg to_time "$TO_TIME" \
  --arg query "$QUERY" \
  --arg line "$LINE_COUNT" \
  '{topic: $topic, logstore: $logstore, project: $project, fromTime: $from_time, toTime: $to_time, query: $query, line: $line, offset: "0", reverse: "true"}')"

RESULT_JSON="$(TZ="Asia/Shanghai" aliyunlog log get_logs \
  --request="$REQUEST_JSON" \
  --client-name=log-search \
  --format-output=json,no_escape)"

if ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$RESULT_JSON"; then
  printf '%s\n' "SLS 返回结果不是预期的 JSON 数组，无法安全分析" >&2
  printf '%s\n' "$RESULT_JSON"
  exit 5
fi

CANDIDATE_COUNT="$(jq 'length' <<<"$RESULT_JSON")"

if [[ -z "$CONTAINS_LITERAL" ]]; then
  if (( CANDIDATE_COUNT == 0 )); then
    printf '%s\n' "提示：当前 SLS 查询返回空，不能仅凭该结果判定日志不存在；UUID 或正文标识请改用上下文锚点查询并配合 --contains 过滤。" >&2
  fi

  printf '%s\n' "$RESULT_JSON"
  exit 0
fi

# SLS 只负责通过可索引锚点召回候选，再对候选的顶层字符串字段执行原文字面量匹配。
FILTERED_JSON="$(jq --arg literal "$CONTAINS_LITERAL" '
  [
    .[]
    | select(any(.[]; type == "string" and contains($literal)))
  ]
' <<<"$RESULT_JSON")"
FILTERED_COUNT="$(jq 'length' <<<"$FILTERED_JSON")"

if (( FILTERED_COUNT == 0 )); then
  if (( CANDIDATE_COUNT >= LINE_COUNT )); then
    printf '%s\n' "警告：本地原文过滤未命中，且 SLS 候选数已达到 --line 上限；结果可能被截断，请缩短时间窗口或增加查询锚点，不能据此判定日志不存在。" >&2
  elif (( CANDIDATE_COUNT == 0 )); then
    printf '%s\n' "提示：上下文锚点查询也未召回候选；请继续检查环境、时区、时间窗口、锚点、采集延迟和字段索引，不能仅凭该结果判定请求未执行。" >&2
  else
    printf '%s\n' "提示：已检查当前候选，但未发现指定原文字面量；如需排除索引漏检，请调整锚点或时间窗口后重查。" >&2
  fi
fi

printf '%s\n' "$FILTERED_JSON"
