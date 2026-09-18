#!/bin/bash

set -euo pipefail

# 此脚本只允许把一个尚未解决的 Bug 标记为 fixed，并在同一次解决动作中写入已确认的解决版本、解决日期、指派人和固定四段备注。
# 调用方必须已经展示完整同步预览并取得用户对本次禅道写入的明确确认。

readonly CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
readonly RUNTIME_CONFIG="${FANGZHIKUN_SKILLS_CONFIG:-${CONFIG_BASE}/fangzhikun-skills/runtime.json}"

if [ "$#" -ne 8 ]; then
    echo "用法: resolve_bug.sh <bug-id> <解决版本值> <解决日期> <指派账号或@openedBy> <涉及模块> <主要调整> <验收口径> <其他影响>" >&2
    exit 2
fi

readonly BUG_ID="$1"
readonly RESOLVED_BUILD="$2"
readonly RESOLVED_DATE="$3"
readonly ASSIGNED_TO_INPUT="$4"
readonly AFFECTED_MODULES="$5"
readonly MAIN_CHANGES="$6"
readonly ACCEPTANCE_CRITERIA="$7"
readonly OTHER_IMPACTS="$8"

if ! printf '%s' "$BUG_ID" | grep -Eq '^[0-9]+$'; then
    echo "Bug ID 必须为纯数字" >&2
    exit 2
fi

if ! printf '%s' "$RESOLVED_BUILD" | grep -Eq '^(trunk|[0-9]+)$'; then
    echo "解决版本值必须为受控候选中的 trunk 或纯数字版本 ID" >&2
    exit 2
fi

if ! printf '%s' "$RESOLVED_DATE" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'; then
    echo "解决日期格式必须为 yyyy-MM-dd HH:mm:ss" >&2
    exit 2
fi

if [ "$ASSIGNED_TO_INPUT" != "@openedBy" ] && \
    ! printf '%s' "$ASSIGNED_TO_INPUT" | grep -Eq '^[A-Za-z0-9_.@-]+$'; then
    echo "指派人必须为禅道账号，或使用 @openedBy 表示 Bug 创建人" >&2
    exit 2
fi

for field_value in "$AFFECTED_MODULES" "$MAIN_CHANGES" "$ACCEPTANCE_CRITERIA" "$OTHER_IMPACTS"; do
    if [ -z "$(printf '%s' "$field_value" | tr -d '[:space:]')" ]; then
        echo "四段备注内容均不能为空" >&2
        exit 2
    fi
done

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

BUG_COMMENT="$(printf '涉及模块：%s\n主要调整：%s\n验收口径：%s\n其他影响：%s' \
    "$AFFECTED_MODULES" "$MAIN_CHANGES" "$ACCEPTANCE_CRITERIA" "$OTHER_IMPACTS")"
readonly BUG_COMMENT

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

current_status="$(printf '%s' "$bug_json" | jq -r '.bug.status // empty')"
current_resolution="$(printf '%s' "$bug_json" | jq -r '.bug.resolution // empty')"
bug_opened_by="$(printf '%s' "$bug_json" | jq -r '.bug.openedBy // empty')"

if [ "$ASSIGNED_TO_INPUT" = "@openedBy" ]; then
    if [ -z "$bug_opened_by" ]; then
        echo "Bug #$BUG_ID 创建人为空，无法使用默认指派规则" >&2
        exit 1
    fi
    resolved_assigned_to="$bug_opened_by"
else
    resolved_assigned_to="$ASSIGNED_TO_INPUT"
fi
readonly resolved_assigned_to

if [ "$current_status" = "resolved" ] || [ "$current_status" = "closed" ]; then
    if [ "$current_status" = "resolved" ] && [ "$current_resolution" = "fixed" ] && \
        printf '%s' "$bug_json" | jq -e --arg resolved_build "$RESOLVED_BUILD" \
            '((.bug.resolvedBuild // "") | tostring | split(",") | index($resolved_build)) != null' >/dev/null && \
        printf '%s' "$bug_json" | jq -e --arg resolved_date "$RESOLVED_DATE" \
            '(.bug.resolvedDate // "") == $resolved_date' >/dev/null && \
        printf '%s' "$bug_json" | jq -e --arg assigned_to "$resolved_assigned_to" \
            '(.bug.assignedTo // "") == $assigned_to' >/dev/null && \
        printf '%s' "$bug_json" | jq -e --arg comment "$BUG_COMMENT" \
            'any(.actions[]?; (.comment // "") == $comment)' >/dev/null; then
        jq -n --arg id "$BUG_ID" --arg status "$current_status" --arg resolution "$current_resolution" \
            --arg resolvedBuild "$RESOLVED_BUILD" --arg resolvedDate "$RESOLVED_DATE" \
            --arg assignedTo "$resolved_assigned_to" --arg comment "$BUG_COMMENT" \
            '{bugID: ($id | tonumber), status: $status, resolution: $resolution,
              resolvedBuild: $resolvedBuild, resolvedDate: $resolvedDate,
              assignedTo: $assignedTo, comment: $comment, changed: false}'
        exit 0
    fi

    echo "Bug #$BUG_ID 当前状态为 $current_status，拒绝重复解决或覆盖既有解决结果" >&2
    exit 1
fi

readonly SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resolved_builds_json="$(bash "$SCRIPT_DIRECTORY/fetch_resolved_builds.sh" "$BUG_ID" 2>&1)" || {
    printf '%s\n' "$resolved_builds_json" >&2
    echo "解决版本候选校验失败；未发起解决请求" >&2
    exit 1
}

if ! printf '%s' "$resolved_builds_json" | jq -e --arg resolved_build "$RESOLVED_BUILD" \
    'any(.candidates[]?; .value == $resolved_build)' >/dev/null; then
    echo "所选解决版本已不在当前候选列表中；未发起解决请求" >&2
    exit 1
fi

resolved_build_name="$(printf '%s' "$resolved_builds_json" | jq -r --arg resolved_build "$RESOLVED_BUILD" \
    '.candidates[] | select(.value == $resolved_build) | .name' | head -n 1)"
readonly resolved_build_name

resolve_output=""
if ! resolve_output="$($ZENTAO_BIN --format=raw --machine-readable bug resolve "$BUG_ID" \
    --resolution=fixed --resolvedBuild="$RESOLVED_BUILD" --resolvedDate="$RESOLVED_DATE" \
    --assignedTo="$resolved_assigned_to" --comment="$BUG_COMMENT" 2>&1)"; then
    printf '%s\n' "$resolve_output" >&2
    echo "解决请求失败；未自动重试，请重新查询 Bug 实际状态" >&2
    exit 1
fi

resolved_json="$(query_bug 2>&1)" || {
    printf '%s\n' "$resolved_json" >&2
    echo "解决请求已返回成功，但回读失败；不得自动重试写入" >&2
    exit 1
}

resolved_status="$(printf '%s' "$resolved_json" | jq -r '.bug.status // empty')"
resolved_resolution="$(printf '%s' "$resolved_json" | jq -r '.bug.resolution // empty')"
resolved_date="$(printf '%s' "$resolved_json" | jq -r '.bug.resolvedDate // empty')"
resolved_assigned_to_actual="$(printf '%s' "$resolved_json" | jq -r '.bug.assignedTo // empty')"

if [ "$resolved_status" != "resolved" ] || [ "$resolved_resolution" != "fixed" ] || \
    ! printf '%s' "$resolved_json" | jq -e --arg resolved_build "$RESOLVED_BUILD" \
        '((.bug.resolvedBuild // "") | tostring | split(",") | index($resolved_build)) != null' >/dev/null || \
    [ "$resolved_date" != "$RESOLVED_DATE" ] || \
    [ "$resolved_assigned_to_actual" != "$resolved_assigned_to" ] || \
    ! printf '%s' "$resolved_json" | jq -e --arg comment "$BUG_COMMENT" \
        'any(.actions[]?; (.comment // "") == $comment)' >/dev/null; then
    echo "解决请求后的回读结果不一致；不得自动重试写入" >&2
    jq -n --arg id "$BUG_ID" --arg status "$resolved_status" --arg resolution "$resolved_resolution" \
        --arg resolvedDate "$resolved_date" --arg assignedTo "$resolved_assigned_to_actual" \
        '{bugID: ($id | tonumber), observedStatus: $status, observedResolution: $resolution,
          observedResolvedDate: $resolvedDate, observedAssignedTo: $assignedTo}' >&2
    exit 1
fi

jq -n --arg id "$BUG_ID" --arg status "$resolved_status" --arg resolution "$resolved_resolution" \
    --arg resolvedBuild "$RESOLVED_BUILD" --arg resolvedBuildName "$resolved_build_name" \
    --arg resolvedDate "$resolved_date" --arg assignedTo "$resolved_assigned_to_actual" \
    --arg comment "$BUG_COMMENT" \
    '{bugID: ($id | tonumber), status: $status, resolution: $resolution,
      resolvedBuild: $resolvedBuild, resolvedBuildName: $resolvedBuildName,
      resolvedDate: $resolvedDate, assignedTo: $assignedTo,
      createdBuild: false, attachmentsUploaded: false,
      comment: $comment, changed: true}'
