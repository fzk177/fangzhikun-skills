# 任务交付资料约定

## 文件位置

任务交付记录位于所属迭代目录的项目管理资料中：

```text
04.项目/
└── 01.进行中/
    └── 迭代-<迭代ID>-<名称>/
        ├── 00.迭代总览.md
        ├── 01.需求与任务/
        │   └── <任务文件>.md
        └── 02.项目管理/
            ├── 项目管理.md
            ├── 任务交付/
            │   └── 任务-<任务ID>-<任务名称>.md
            └── 上线记录/
                └── 迭代-<迭代ID>-上线准备.md
```

`task_delivery_record.js` 只创建任务交付模板、更新交付 Frontmatter 和代码确认后的 Project Manager 任务字段。业务内容由 agent 根据实际代码和用户确认结果填写，不能编造。

## 交付状态

| 状态 | 含义 |
|---|---|
| `planned` | 已创建记录，尚未编码 |
| `coding` | 方案已确认并开始编码 |
| `local-completed` | 用户确认代码，本地任务已标记待写回完成 |
| `documented` | 项目管理和上线资料已维护 |
| `zentao-completed` | 禅道完成工作流已执行并回读 |
| `complete` | 最终指派决策已经处理 |

## 时间和工时字段

- `start`、`due`：Project Manager 计划日期，不能被实际时间覆盖。
- `stage`：直接保留禅道任务原始 `type`；本地交付阶段不得修改。
- `status`：直接保留禅道任务原始 `status`；代码确认时不得提前改成 `done`，完成禅道工作流后通过迭代同步回读。
- `completed`：实际完成日期，仅保留 `YYYY-MM-DD`。
- `customFields.actualStartedAt`：禅道或交付记录中的完整实际开始时间。
- `customFields.actualFinishedAt`：禅道或交付记录中的完整实际完成时间。
- `customFields.consumedHours`：完成目标为“远端原消耗 + 远端原剩余”。
- `customFields.remainingHours`：完成目标为 0。
- `customFields.deliveryStatus`：本地完成但尚未写入禅道时使用 `pending-zentao`；禅道回读同步后允许移除。

## 项目管理增量区域

在 `项目管理.md` 的“当前进展”或“进展记录”下维护任务摘要。使用稳定标记保证幂等：

```markdown
<!-- zentao-task-delivery:<任务ID>:start -->
### 任务 #<任务ID> · <名称>

- 状态：
- 实际开始：
- 实际完成：
- 代码范围：
- 交付记录：[[...]]
- 风险或遗留：
<!-- zentao-task-delivery:<任务ID>:end -->
```

重复维护时只替换相同任务 ID 的标记区域，保留其余人工内容。

## Codex 会话关联区域

显式 `$zentao-task` 会话由全局 Codex 同步程序按 `zentaoSourceType=task` 与 `zentaoId` 自动关联。任务交付记录存在后，同步程序维护以下投影：

- 交付 Frontmatter 中由 `# codex:auto:sessions:start/end` 包围的 `codexSessions`。
- 交付正文中的 `<!-- codex:auto:sessions:start/end -->` 会话列表。
- Project Manager 任务正文中的 `<!-- codex:auto:conversation-links:start/end -->` 工作记录。

对话笔记中的 `project_task_links` 是关联事实源，上述内容都可重建。本 skill 不手工修改这些区域；首次只读分析阶段只允许对话归档建立正向链接，不写 Project Manager 任务或交付记录。

## 分支交付关联区域

任务交付记录应用后，`git-branch-delivery` 共享核心脚本按仓库和分支建立独立分支记录。分支记录保存 `task:<任务ID>`、迭代 ID、Commit 和 Codex Session；任务交付正文通过以下区域保存可重建的反向投影：

```markdown
<!-- branch-delivery:auto:links:start -->
<!-- branch-delivery:auto:links:end -->
```

- 分支不是 `pm-task`，不进入 Project Manager 任务层级、工时、进度或甘特图。
- `repositories`、`branches`、`baseCommits` 和 `changedFiles` 继续兼容既有记录；结构化分支事实以 `04.项目/00.分支管理/04.数据支持/branches` 为准。
- 分支名和 Commit 备注只可用于候选关联；任务交付记录应用或用户明确确认后才形成正式关联。
- HEAD 变化后旧上线检查自动失效，但任务历史关联和原 Codex 会话不得删除。

## 上线准备增量区域

在上线准备记录中维护任务的上线范围、服务或前端包、脚本、顺序、验证和回滚。使用独立稳定标记：

```markdown
<!-- zentao-task-release:<任务ID>:start -->
### 任务 #<任务ID> · <名称>

- 上线范围：
- 仓库、分支、Tag 或 Commit：
- 服务或构建版本：
- 配置变化：
- 正向脚本或仓库路径：
- 执行顺序：
- 验证步骤：
- 回滚方式：
<!-- zentao-task-release:<任务ID>:end -->
```

没有上线脚本时明确写“无”，不要保留容易误解的占位 SQL。若代码仓库存在正式脚本，代码仓库仍是源文件权威，但上线准备记录必须保留经核对的完整 SQL 快照，便于发布执行。

只要任务存在正向 SQL 脚本，除任务专属 `zentao-task-release:<任务ID>` 区域外，还必须在同一上线准备记录的 `## 上线脚本 / ### 正向脚本` 下建立或更新 `<!-- zentao-task-release-script:<任务ID>:start -->` 聚合区域：先记录交付记录链接、仓库/分支/Commit、源脚本路径，再粘贴完整脚本原文，并补充执行前置条件、影响对象和校验方式。该聚合区不得保留通用占位 SQL。

回滚脚本必须在 `### 回滚脚本` 下用独立 `<!-- zentao-task-release-rollback-script:<任务ID>:start -->` 标记维护：发现正式回滚 SQL 时粘贴完整原文；没有回滚脚本时，明确无独立脚本及回退前的数据兼容、备份或人工转换条件。禁止推测或生成破坏性回滚 SQL。

## 安全检查

- 不把密码、Token、Cookie、`zentaosid` 或数据库连接凭据写入任何资料。
- 不把临时计划 JSON 写入 vault；计划只能存放在权限受限的系统临时目录。
- 不自动把新生成的 Markdown、SQL、JSON 或 TXT 加入业务仓库 Git。
- 手工内容和受控标记外内容永不自动覆盖或删除。
