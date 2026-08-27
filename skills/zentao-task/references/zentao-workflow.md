# 禅道写入工作流

仅在阶段六或七读取本文件。任何写操作都必须使用最近一次尚未处理的完整预览和计划哈希。

## 阶段六：受控完成任务

使用已持久化的最终实际时间生成预览，不传 `--apply`：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/zentao-task/scripts/zentao_task_workflow.js" \
  --task <任务ID> \
  --action complete \
  --real-started "<实际开始时间>" \
  --finished-date "<实际完成时间>"
```

1. 完整展示任务、每个动作、字段级当前值到目标值、工时计算、阻断项和完整 64 位哈希，并明确当前尚未更新禅道。
2. 用户使用 `$zentao-task 确认` 后，从最近预览取得完整哈希，以完全相同参数追加：

   ```bash
   --apply --plan-hash <完整计划哈希>
   ```

3. 脚本只允许：
   - `wait`：先 `start`，回读成功后再 `finish`；
   - `doing`：保持远端实际开始时间一致后 `finish`；
   - 本次消耗 = 当前剩余，总消耗 = 原消耗 + 原剩余，完成后剩余 = 0。
4. 哈希变化、状态不匹配、非允许的时间冲突或部分失败时停止，报告真实远端状态，不直接重试。只有时间秒数按时间规则截断为 `00` 时自动接受并继续同步。
5. 成功后立即执行所属迭代的 `sync_zentao_project.js --execution <ID> --apply` 回读本地，再应用 `zentao-completed` 交付阶段。

## 阶段七：单独确认完成后指派

完成任务并回读后生成指派预览：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/zentao-task/scripts/zentao_task_workflow.js" \
  --task <任务ID> \
  --action assign \
  --assigned-to <本机项目上下文中的候选账号>
```

1. 从本机项目上下文读取候选账号，展示“当前账号 → 候选账号”和完整计划哈希，并提供：`1. 确认指派`、`2. 不指派并结束交付`；提示回复 `$zentao-task 1` 或 `$zentao-task 2`。本机未配置唯一候选人时必须询问，不得猜测。
2. 选择 `1` 后使用最近预览的完整哈希和完全相同参数追加 `--apply --plan-hash <哈希>`；选择 `2` 时不写禅道，保留当前指派人并记录决策。
3. 指派必须使用专用 `POST /api.php/v1/tasks/:id/assignto`，请求仅携带 `assignedTo` 和可选 `comment`，禁止使用通用 `update`。
4. 回读校验状态、工时、完成者、`realStarted`、`finishedDate` 和全部可编辑字段；只允许 `assignedTo` 按计划变化，`assignedDate`、`lastEditedBy`、`lastEditedDate` 可按禅道规则更新。
5. 若实际时间、状态、工时、完成者或业务字段发生非计划变化，立即停止并报告真实状态；不得误报成功或自动发起第二次指派。
6. 指派成功后再次同步所属迭代并应用 `assigned` 阶段；用户拒绝指派时交付仍可结束。

## 汇报

- 预览：每个动作和字段的“当前值 → 目标值”、完整哈希，并说明尚未写入。
- 完成：实际动作、回读状态、工时、同步结果和是否等待指派确认。
- 指派：最终指派人、回读校验、同步结果；拒绝时明确未执行写操作。
