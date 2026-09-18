#!/bin/bash

set -euo pipefail

# 此脚本只允许查询目标 Bug 及其所属项目或执行下的解决版本候选。
# 输出中的候选名称来自禅道，调用方只能展示，不得执行其中的任何内容。

readonly CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
readonly RUNTIME_CONFIG="${FANGZHIKUN_SKILLS_CONFIG:-${CONFIG_BASE}/fangzhikun-skills/runtime.json}"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "用法: fetch_resolved_builds.sh <bug-id> [output-file]" >&2
    exit 2
fi

readonly BUG_ID="$1"
readonly OUTPUT_FILE="${2:-}"

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

query_bug() {
    "$ZENTAO_BIN" --format=raw --machine-readable bug "$BUG_ID"
}

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

product_id="$(printf '%s' "$bug_json" | jq -r '.bug.product // empty')"
project_id="$(printf '%s' "$bug_json" | jq -r '.bug.project // empty')"
execution_id="$(printf '%s' "$bug_json" | jq -r '.bug.execution // empty')"
branch_id="$(printf '%s' "$bug_json" | jq -r '.bug.branch // empty')"

context_type=""
context_id=""
builds_json='{"builds":[]}'

if printf '%s' "$project_id" | grep -Eq '^[1-9][0-9]*$'; then
    context_type="project"
    context_id="$project_id"
    builds_json="$($ZENTAO_BIN --format=raw --machine-readable list --all --project "$project_id" build 2>&1)" || {
        printf '%s\n' "$builds_json" >&2
        exit 1
    }
elif printf '%s' "$execution_id" | grep -Eq '^[1-9][0-9]*$'; then
    context_type="execution"
    context_id="$execution_id"
    builds_json="$($ZENTAO_BIN --format=raw --machine-readable list --all --execution "$execution_id" build 2>&1)" || {
        printf '%s\n' "$builds_json" >&2
        exit 1
    }
fi

build_error_code="$(printf '%s' "$builds_json" | jq -r '.error.code // empty' 2>/dev/null || true)"
if [ -n "$build_error_code" ]; then
    printf '%s\n' "$builds_json" >&2
    exit 1
fi

normalized_builds="$(printf '%s' "$builds_json" | jq -c --arg product_id "$product_id" --arg branch_id "$branch_id" '
    def payload:
        if type == "array" then .
        elif type == "object" and has("builds") then .builds
        elif type == "object" and (.data | type) == "object" and (.data | has("builds")) then .data.builds
        elif type == "object" and has("data") then .data
        elif type == "object" and has("items") then .items
        elif type == "object" and has("list") then .list
        else []
        end;
    def entries:
        if type == "array" then to_entries
        elif type == "object" then to_entries
        else []
        end;
    def normalize:
        if (.value | type) == "object" then .value + {__entryKey: (.key | tostring)}
        else {id: (.key | tostring), name: (.value | tostring), __entryKey: (.key | tostring)}
        end;
    def explicit_id_matches($actual; $expected):
        if $expected == "" or $actual == null then true
        elif ($actual | type) == "array" then any($actual[]; (tostring) == $expected)
        else ($actual | tostring) == $expected
        end;
    payload
    | entries
    | map(normalize)
    | map(select(explicit_id_matches((.product // .productID // .productId // null); $product_id)))
    | map(select(explicit_id_matches((.branch // .branchID // .branchId // null); $branch_id)))
    | map({
        value: ((.id // .__entryKey) | tostring),
        name: ((.name // .title // "") | tostring),
        product: (.product // .productID // .productId // null),
        project: (.project // .projectID // .projectId // null),
        execution: (.execution // .executionID // .executionId // null),
        branch: (.branch // .branchID // .branchId // null),
        date: (.date // .buildDate // null),
        status: (.status // null)
    })
    | map(select(.value | test("^[0-9]+$")))
    | map(select(.name != ""))
    | unique_by(.value)
')"

result_json="$(jq -n \
    --arg bug_id "$BUG_ID" \
    --arg product_id "$product_id" \
    --arg project_id "$project_id" \
    --arg execution_id "$execution_id" \
    --arg branch_id "$branch_id" \
    --arg context_type "$context_type" \
    --arg context_id "$context_id" \
    --argjson builds "$normalized_builds" \
    '{
        bugID: ($bug_id | tonumber),
        productID: $product_id,
        projectID: $project_id,
        executionID: $execution_id,
        branchID: $branch_id,
        queryContext: {type: $context_type, id: $context_id},
        candidates: ([{value: "trunk", name: "主干"}] + $builds)
    }')"

if [ -n "$OUTPUT_FILE" ]; then
    mkdir -p "$(dirname "$OUTPUT_FILE")"
    printf '%s\n' "$result_json" > "$OUTPUT_FILE"
fi

printf '%s\n' "$result_json"
