#!/bin/bash
set -euo pipefail

# 兼容旧调用路径；认证、解析和材料获取只在 zentao-base 中维护。
zentao_debug_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$zentao_debug_script_dir/../../zentao-base/scripts/fetch_bug.js" "$@"
