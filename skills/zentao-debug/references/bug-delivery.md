# Bug 本地交付与分支联动

## 边界

- 只读分析阶段不创建 Bug交付记录。
- 用户明确授权修复后，才允许创建或更新本地 Bug交付记录。
- 本地记录不修改禅道 Bug 状态、解决版本、指派、备注或附件。
- Git 仓库、分支、Commit 和变更文件必须来自当前修复的只读核对结果，不得猜测。
- QA测试、业务验收和禅道关闭是三个独立事实，不能由代码提交或开发验证自动推导。

## 文件位置

能定位所属迭代时：

```text
<迭代目录>/02.项目管理/Bug交付/Bug-<ID>-<标题>.md
```

暂时不能定位迭代时：

```text
04.项目/00.分支管理/05.Bug交付/Bug-<ID>-<标题>.md
```

后续定位迭代时不得自动移动已有文件；先展示迁移预览并取得用户确认，避免破坏 Wiki-link。

## 阶段

| 状态 | 含义 |
|---|---|
| `fix-authorized` | 用户已授权修复，记录仓库、分支、基线和分析会话 |
| `local-fixed` | 代码修改完成但尚未完成提交决策 |
| `committed` | 本地提交完成并已记录不可变 Commit |
| `documented` | 验证、上线风险和回滚资料已完整维护 |

## 命令

首次创建必须使用当前临时目录中的安全摘要文件，先不带 `--apply` 预览：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/zentao-debug/scripts/bug_delivery_record.js" \
  --bug <Bug ID> \
  --summary "<临时目录>/bug-<ID>-summary.json" \
  --phase fix-authorized \
  --vault "<vault目录>" \
  --repository "<仓库路径>" \
  --branch "<当前分支>" \
  --base-commit "<修改前基线>" \
  --session-id "${CODEX_SESSION_ID:-<当前会话ID>}"
```

预览无误后在同一参数末尾追加 `--apply`。

提交完成时更新：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/zentao-debug/scripts/bug_delivery_record.js" \
  --bug <Bug ID> \
  --phase committed \
  --vault "<vault目录>" \
  --repository "<仓库路径>" \
  --branch "<确认分支>" \
  --base-commit "<修改前基线>" \
  --head-commit "<最终提交>" \
  --changed-file "<本次文件>" \
  --root-cause "<有证据支持的根因摘要>" \
  --resolution "<修复结果>" \
  --validation "<实际执行验证和未运行项>" \
  --risk "<上线风险与回滚方式>" \
  --session-id "${CODEX_SESSION_ID:-<当前会话ID>}"
```

多仓库参数按相同顺序重复。最终 Commit 使用 `--head-commit` 逐仓库传入。

## 分支和 Codex 双链

脚本应用后调用 `$git-branch-delivery` 的共享核心逻辑：

- 分支记录保存 `bug:<ID>`、迭代、Commit 和 Codex Session。
- Bug交付记录通过 `branch-delivery:auto:links` 保存分支反向投影。
- Codex 对话笔记存在时，通过 `codex:auto:branch-links` 保存分支反向投影。
- HEAD 变化后上线检查失效，但历史 Bug、Commit 和会话关联保留。

以上区域只允许自动维护，人工备注永不覆盖。
