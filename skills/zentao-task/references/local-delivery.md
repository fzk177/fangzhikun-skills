# 本地交付资料

仅在阶段四或五读取本文件，并同时完整读取任务交付资料约定。

## 阶段四：固化代码确认事实

只有用户通过 Git 核对明确确认代码后，才按时间规则计算最终实际开始和完成时间，先预览再应用：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/zentao-task/scripts/task_delivery_record.js" \
  --task <任务ID> \
  --phase code-confirmed \
  --real-started "<最终实际开始时间>" \
  --finished-date "<代码确认时间>" \
  --vault "<vault目录>" \
  --changed-file "<修改文件>"
```

1. 本地任务只更新独立完成事实、进度 100、剩余工时 0；本次消耗等于禅道当前剩余，总消耗等于远端原消耗加原剩余。
2. `stage` 和 `status` 保留当前禅道原始值，不提前写成 `done`；禅道完成后由迭代同步回读原始 `type/status`。
3. `start`、`due` 保留计划日期；实际时间写入 `actualStartedAt`、`actualFinishedAt`，`completed` 只保存完成日期。
4. `changed-file` 使用阶段三确认的完整文件清单；即使已提交且 `git diff` 为空也不能丢失。
5. 同步记录 Git 决策：已提交时记录各仓库分支、提交哈希和最终备注；暂不提交时记录未提交状态。

## 阶段五：项目管理与上线资料

1. 完善交付记录中的需求、方案、修改范围、数据流、操作步骤、注意事项、上线脚本、执行顺序、验证和回滚，不编造未知事实。
2. 使用任务 ID 稳定标记增量维护 `项目管理.md` 和对应迭代上线准备记录，只替换本任务标记区域，保留其他人工内容。
3. 发现正式正向 SQL 时，读取仓库脚本原文，把完整内容写入上线准备记录的 `## 上线脚本 / ### 正向脚本`，记录仓库、分支或 Tag、Commit 和源文件路径，并使用 `zentao-task-release-script:<任务ID>` 标记；不得只写路径或摘要。
4. `### 回滚脚本` 必须单独维护：存在正式脚本时粘贴完整 SQL；不存在时用 `zentao-task-release-rollback-script:<任务ID>` 标明“无独立回滚脚本”及安全限制，禁止臆造截断数据或不可逆的回滚 SQL。
5. 检查新内容是否含 `password`、`token`、`secret`、`zentaosid` 等敏感值；命中时立即停止且不展示敏感值。
6. 资料完成后先预览再应用 `docs-complete` 阶段，该动作只更新本地交付状态。

完成后汇报任务文件、交付记录、项目管理、上线准备、Git 决策和工时变化，然后进入阶段六。
