#!/bin/bash

set -euo pipefail

# 此脚本只负责查询单个 Bug，并在凭据过期时通过 macOS 钥匙串自动恢复登录。
# 不接受任意禅道子命令，避免误执行创建、修改或删除操作。

readonly CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
readonly RUNTIME_CONFIG="${FANGZHIKUN_SKILLS_CONFIG:-${CONFIG_BASE}/fangzhikun-skills/runtime.json}"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "用法: fetch_bug.sh <bug-id> [output-directory]" >&2
    exit 2
fi

readonly BUG_ID="$1"
readonly OUTPUT_DIRECTORY="${2:-}"

if ! printf '%s' "$BUG_ID" | grep -Eq '^[0-9]+$'; then
    echo "Bug ID 必须为纯数字" >&2
    exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "缺少 jq，无法解析本机配置和 zentao CLI 返回结果" >&2
    exit 1
fi

if [ ! -f "$RUNTIME_CONFIG" ]; then
    echo "缺少本机配置：$RUNTIME_CONFIG" >&2
    exit 1
fi

KEYCHAIN_SERVICE="$(jq -er '.zentao.keychainService' "$RUNTIME_CONFIG")"
DEFAULT_ACCOUNT="$(jq -r '.zentao.account // empty' "$RUNTIME_CONFIG")"
DEFAULT_SERVER="$(jq -r '.zentao.server // empty' "$RUNTIME_CONFIG")"
FALLBACK_ZENTAO_BIN="$(jq -r '.zentao.cli // empty' "$RUNTIME_CONFIG")"
readonly KEYCHAIN_SERVICE DEFAULT_ACCOUNT DEFAULT_SERVER FALLBACK_ZENTAO_BIN

if [ -n "$FALLBACK_ZENTAO_BIN" ] && [ -x "$FALLBACK_ZENTAO_BIN" ]; then
    ZENTAO_BIN="$FALLBACK_ZENTAO_BIN"
elif command -v zentao >/dev/null 2>&1; then
    ZENTAO_BIN="$(command -v zentao)"
else
    echo "未找到 zentao CLI" >&2
    exit 1
fi
readonly ZENTAO_BIN

# 使用 raw 格式查询，确保同时取得 Bug、操作记录和字段变更历史。
query_bug() {
    "$ZENTAO_BIN" --format=raw --machine-readable bug "$BUG_ID"
}

# 仅在登录缺失或 Token 失效时，从钥匙串读取密码并自动重新登录。
restore_login() {
    local profile_json
    local server
    local account
    local password

    profile_json="$($ZENTAO_BIN --format=json --machine-readable profile 2>/dev/null || true)"
    server="$(printf '%s' "$profile_json" | jq -r '.profiles[]? | select(.current == true) | .server' 2>/dev/null | head -n 1)"
    account="$(printf '%s' "$profile_json" | jq -r '.profiles[]? | select(.current == true) | .account' 2>/dev/null | head -n 1)"

    if [ -z "$server" ] || [ "$server" = "null" ]; then
        server="$DEFAULT_SERVER"
    fi

    if [ -z "$account" ] || [ "$account" = "null" ]; then
        account="$DEFAULT_ACCOUNT"
    fi

    if [ -z "$server" ] || [ -z "$account" ]; then
        echo "禅道 Profile 和本机 runtime.json 均缺少 server 或 account" >&2
        return 1
    fi

    if ! command -v security >/dev/null 2>&1; then
        echo "当前系统不支持 macOS 钥匙串，无法自动恢复禅道登录" >&2
        return 1
    fi

    if ! password="$(security find-generic-password -a "$account" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"; then
        echo "未找到禅道自动登录钥匙串条目，请恢复 runtime.json 登记的凭据" >&2
        return 1
    fi

    if ! ZENTAO_URL="$server" ZENTAO_ACCOUNT="$account" ZENTAO_PASSWORD="$password" \
        "$ZENTAO_BIN" --machine-readable login --useEnv >/dev/null; then
        unset password
        echo "禅道自动重新登录失败，请检查服务地址或本机钥匙串凭据" >&2
        return 1
    fi

    unset password
}

bug_json="$(query_bug 2>&1)" || {
    printf '%s\n' "$bug_json" >&2
    exit 1
}

error_code="$(printf '%s' "$bug_json" | jq -r '.error.code // empty' 2>/dev/null || true)"

if [ "$error_code" = "1001" ] || [ "$error_code" = "1004" ]; then
    restore_login
    bug_json="$(query_bug 2>&1)" || {
        printf '%s\n' "$bug_json" >&2
        exit 1
    }
    error_code="$(printf '%s' "$bug_json" | jq -r '.error.code // empty' 2>/dev/null || true)"
fi

if [ -n "$error_code" ]; then
    printf '%s\n' "$bug_json" >&2
    exit 1
fi

if [ -z "$OUTPUT_DIRECTORY" ]; then
    printf '%s\n' "$bug_json"
    exit 0
fi

mkdir -p "$OUTPUT_DIRECTORY/attachments"
readonly BUG_JSON_PATH="$OUTPUT_DIRECTORY/bug-$BUG_ID.json"
readonly BUG_SUMMARY_PATH="$OUTPUT_DIRECTORY/bug-$BUG_ID-summary.json"
readonly BUG_ACTIONS_PATH="$OUTPUT_DIRECTORY/bug-$BUG_ID-actions.jsonl"
printf '%s\n' "$bug_json" > "$BUG_JSON_PATH"

# zentao-cli 0.2.x 的 raw 输出为 {status, data}，旧版本输出为
# {bug, actions}。后续摘要和附件处理统一使用兼容后的结构，同时原始
# 响应仍完整保存在 bug-<id>.json 中。
normalized_bug_json="$(printf '%s' "$bug_json" | jq '
    if (.bug | type) == "object" then
        .
    elif .status == "success" and (.data | type) == "object" then
        {bug: .data, actions: (.actions // [])}
    else
        .
    end
')"

# 摘要保留完整 Bug 字段，但不携带通常较长的操作历史，供模型优先读取。
printf '%s' "$normalized_bug_json" | jq '{
    bug: (.bug // {}),
    actionCount: ((.actions // []) | length),
    historyChangeCount: ([.actions[]?.history[]?] | length),
    attachmentCount: ((.bug.files // {}) | length)
}' > "$BUG_SUMMARY_PATH"

# 操作历史使用 JSON Lines 存储，便于按关键词或行号筛选，避免整份载入上下文。
printf '%s' "$normalized_bug_json" | jq -c '(.actions // [])[] | {
    id,
    objectType,
    objectID,
    product,
    project,
    execution,
    actor,
    action,
    date,
    comment,
    extra,
    history: (.history // [])
}' > "$BUG_ACTIONS_PATH"

profile_json="$($ZENTAO_BIN --format=json --machine-readable profile 2>/dev/null || true)"
server="$(printf '%s' "$profile_json" | jq -r '.profiles[]? | select(.current == true) | .server' 2>/dev/null | head -n 1)"

if [ -z "$server" ] || [ "$server" = "null" ]; then
    server="$DEFAULT_SERVER"
fi

if [ -z "$server" ]; then
    echo "禅道 Profile 和本机 runtime.json 均缺少 server，无法下载附件" >&2
    exit 1
fi

server_origin="$(printf '%s' "$server" | sed -E 's#^(https?://[^/]+).*$#\1#')"

# 普通附件包含可直接读取的 webPath，逐一下载到临时目录。
while IFS=$'\t' read -r file_id title extension web_path; do
    if [ -z "$file_id" ] || [ -z "$web_path" ]; then
        continue
    fi

    safe_title="$(printf '%s' "$title" | sed 's#[/:]#_#g' | tr '\n\r\t' '___')"
    if [ -z "$safe_title" ]; then
        safe_title="attachment"
    fi

    if [ -n "$extension" ] && [ "${safe_title##*.}" != "$extension" ]; then
        file_name="$file_id-$safe_title.$extension"
    else
        file_name="$file_id-$safe_title"
    fi

    case "$web_path" in
        http://*|https://*) download_url="$web_path" ;;
        /*) download_url="$server_origin$web_path" ;;
        *) download_url="$server_origin/$web_path" ;;
    esac

    if ! curl --fail --location --silent --show-error \
        --output "$OUTPUT_DIRECTORY/attachments/$file_name" "$download_url"; then
        echo "附件下载失败，fileID=$file_id" >&2
    fi
done < <(printf '%s' "$normalized_bug_json" | jq -r '(.bug.files // {}) | to_entries[] | [(.value.id // .key), (.value.title // .value.name // "attachment"), (.value.extension // ""), (.value.webPath // "")] | @tsv')

# 正文内嵌图片不一定出现在 files 中，记录 ID 供分析结果说明，避免把登录页误当成图片。
inline_file_ids="$(printf '%s' "$normalized_bug_json" | jq -r '.bug.steps // ""' | grep -oE 'fileID=[0-9]+' | cut -d= -f2 | sort -u || true)"

if [ -n "$inline_file_ids" ]; then
    printf '%s\n' "$inline_file_ids" | while IFS= read -r inline_file_id; do
        printf '%s\t%s\n' "$inline_file_id" "$server_origin/zentao/zentao/index.php?m=file&f=read&fileID=$inline_file_id"
    done > "$OUTPUT_DIRECTORY/inline-files.tsv"
fi

printf '%s\n' "$BUG_JSON_PATH"
