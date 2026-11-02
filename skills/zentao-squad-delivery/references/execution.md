# 执行参考

## 共享资源与边界

复用以下文件，不复制或另写脚本实现：

| 阶段 | 必须读取／使用 |
|---|---|
| 预检与 Git | [项目上下文](../../zentao-task/references/project-context.md)、[认证与查询](../../zentao-base/references/read.md)；只读脚本 `zentao-base/scripts/read_object.js` |
| 本地交付 | [任务交付资料约定](../../zentao-task/references/task-delivery-schema.md)、[本地交付资料](../../zentao-task/references/local-delivery.md)、[时间与工时](../../zentao-task/references/time-and-effort.md)；`zentao-task/scripts/task_delivery_record.js` |
| 禅道完成与指派 | [写入适配契约](../../zentao-base/references/write.md)；`zentao-task/scripts/zentao_task_workflow.js` |
| 迭代同步 | `zentao-project-manager/scripts/sync_zentao_project.js`，仅 `--execution <ID> --apply` 回读同步，不调用写回能力 |
| 分支联动 | 由交付脚本调用已安装 `git-branch-delivery/scripts/branch_delivery_core.js`，不复制实现 |

共享本地资料文件中的“用户确认代码”在本场景对应入口已授权且本地提交成功的事实；其中要求回到会话式完成确认的收尾句不用于本 Skill。此映射不改变时间、工时、资料结构、回读或错误处理规则。

运行时先定位完整、可兼容的一套 Skill 安装根目录；脚本路径从实际安装位置解析，不假定 Multica 导入会递归安装依赖。若 `CODEX_HOME` 是隔离目录而依赖只在本机 `~/.codex/skills`，仅对本次子进程设置与所选安装根匹配的 `CODEX_HOME`，不修改全局环境、配置或安装目录。尤其先检查分支交付核心脚本，否则交付脚本可能写入本地记录后才报告联动失败。

以下命令中的 `<安装根>`、ID、时间、路径和哈希必须替换成已核实的实际值；不执行占位命令。使用参数数组传递备注等多行内容，避免 shell 插值。共享计划脚本没有调用方参数，不杜撰 `--caller` 或跳过确认开关；使用 `--json` 获取结构化计划，避免把面向 `zentao-task` 的交互提示误当成本 Skill 的停点。

## 1. Git 导入和提交

1. 在目标仓库根及文件所在层级读取适用 `AGENTS.md`。记录来源仓库、分支、完整提交哈希、开发前基线，测试对应哈希，以及目标仓库当前分支、HEAD、upstream、工作区和暂存区状态。拒绝 detached HEAD、正在进行的合并／挑拣及无法归属的暂存内容。已有未提交改动仅在能证明与全部导入路径（含重命名源／目标）不重叠且 hooks 不会修改它们时保留；否则停止，不切换分支或 stash。
2. 只读检查来源提交的文件、diff、依赖和顺序；不能挑整个分支或用提交标题推测范围。来源与目标须属同一项目；缺对象时只获取明确来源的提交，不拉取合并或改 upstream。复核通过范围不含目标新增差异时，存在上下文不兼容就停止，不擅自解决冲突或编码。
3. 排除 `docs/` 下全部文件。纯 docs 提交直接跳过；混合提交只导入允许的代码与正式 SQL，不把 docs 曾经提交到目标分支后再删除。其他生成的 Markdown、JSON、TXT 等资料默认不导入；代码必需的已有资源须以实际业务用途和已复核范围核实。正式交付 SQL 可按明确路径提交，不执行 SQL。
4. 可将明确源提交范围中允许文件的变更生成带完整索引的二进制补丁，先只读检查适用性，再应用到目标工作区；仅对精确列出的允许路径暂存后提交。这样可保留目标已有差异并剔除 docs。不要以源文件快照覆盖整个文件，也不要直接 cherry-pick 含 docs 的提交。出现冲突或应用异常立即停止，记录真实状态，不运行 reset、clean、自动 abort 或覆盖用户内容。
5. 提交前记录准确文件清单、排除项、目标分支／基线、diff 和中文备注；复查禅道任务的真实 `story` 关联与先前一致。标题与正文使用入口文件指定的 story／task 双编号格式。执行前再次核对分支、HEAD、暂存区与文件内容；只用 `git add -- <明确文件路径...>`，禁止 `git add .`、`git add -A` 或宽泛 pathspec。多仓库分别提交；不设置 upstream、不推送。
6. 保留 hooks，不设置跳过 hook 的环境变量；hook 引发构建或测试而与本 Skill 禁止运行冲突时停止交用户处理。提交或 hook 失败、hook 修改文件时不扩大暂存范围或自动重试。
7. 成功后核对实际提交 diff、完整哈希、最终备注和剩余未提交内容；`git diff --name-only <目标原HEAD>..HEAD` 不得含 `docs/`。保留用户原有改动，持久化源提交到目标提交的映射。无法证明所有代码已导入时不进入禅道完成。若历史交付记录已证明同一源范围已交付，只核对既有结果，不创建空提交或重复执行完成。

## 2. 时间与本地交付

在 Git 前读取任务 `left`、`consumed`、`realStarted`、`status` 与迭代 ID，并检查资料目标可用。提交后重新核对这些字段没有并发变化；变化即停止，不能重新选工时继续完成。

以成功提交的实际时间（本地项目时区，精确到秒）作为最终完成时间。当前剩余必须是合法非负数，本次消耗等于该值；总消耗为远端原消耗加原剩余；开始时间按小数工时折算秒向前推算。`doing` 已有实际开始时间或任务已有其他实际开始时间时不覆盖：与推算结果不一致即停止；只允许共享规则中的秒截断等价。用户明确指定时间优先，但出现冲突仍停止报告。

调用交付脚本先预览，再以相同事实在本轮追加 `--apply`：

```text
node <安装根>/zentao-task/scripts/task_delivery_record.js
  --task <ID> --phase code-confirmed
  --real-started <最终实际开始时间> --finished-date <提交完成时间>
  --vault <Vault> --repository <本机仓库> --branch <当前分支>
  --base-commit <目标原HEAD> --head-commit <最终目标提交>
  --changed-file <实际提交文件> --json
```

`--repository`、`--branch`、`--base-commit`、`--head-commit` 和 `--changed-file` 按已核实范围重复传入，仓库／分支一一对应。有真实 Codex 会话身份才传 `--session-id`；Multica issue ID 不能冒充会话 ID。记录最终提交备注、源提交映射与复核证据，不手工改写 `codex:auto` 区域。

完善交付记录、`项目管理.md` 和上线准备中本任务的稳定标记区域，保留人工内容。正向 SQL 在上线准备的正向脚本聚合区保存全文、源路径、仓库／分支／Commit、执行前置、影响对象与验证方式；回滚脚本在独立区域保存全文，无正式脚本时明确无独立脚本及备份／数据兼容限制，不生成破坏性回滚 SQL。没有 SQL 明确写无。

写入前扫描新内容的敏感值，命中立即停止且不输出该值。之后预览并应用 `--phase docs-complete --event-at <实际资料完成时间>`；持续携带仓库／分支及最终 Commit 刷新分支交付投影，不能因 diff 已清空而丢失文件清单。联动失败属于部分成功，不把 QA／业务验收擅自标为通过。

## 3. 完成与回读

备注使用以下四段，任务和归属需求正文完全相同，各新增一条；不修改需求正文、验收标准或状态：

```text
涉及模块：
- <具体仓库、服务、模块、接口、页面或数据处理范围>

主要调整：
- <实际提交中的调整及结果>

验收口径：
- <可核验的场景、边界、数据结果或上下游联动>

其他影响：
- <兼容性、接口、数据、配置、部署、回滚或回归影响>
```

前三段不能空缺或以“无”“功能优化”“完成需求”等占位；最后一段经核实无影响时允许“无其他已知影响”。以实际提交、用户确认方案、测试结论和交付资料为准，不能把未执行的构建／测试写成通过。

```text
node <安装根>/zentao-task/scripts/zentao_task_workflow.js
  --task <ID> --action complete
  --real-started <持久化的最终开始时间> --finished-date <持久化的最终完成时间>
  --delivery-comment <完整四段备注> --json
```

保留预览的全部动作、字段差异、任务／需求 ID、双备注、工时计算与完整哈希；确认 `blockers` 为空，计划与实际提交、本地记录及先前远端快照一致。将同一组参数追加 `--apply --plan-hash <本次完整64位哈希>` 在本轮执行，不等待用户复制哈希。不要修改共享脚本，不使用其他完成、备注修复或时间恢复入口绕过阻断。

`wait` 由脚本先 start 并回读再 finish；`doing` 保持真实开始时间。finish 同时新增任务备注；任务备注逐字回读一致后才新增需求备注，再逐字回读需求备注。发生任何异常均停止，不能因脚本提示“重新预览确认”而在本轮重试写入。时间仅秒截断为 `00` 且其余相同可接受；其他差异停止。

仅全部成功后调用 `sync_zentao_project.js --execution <所属迭代ID> --apply`，然后预览并应用交付脚本的 `--phase zentao-completed --event-at <本次真实时间>`。迭代同步失败即停止，不进入指派。

## 4. 固定指派与同步

```text
node <安装根>/zentao-task/scripts/zentao_task_workflow.js
  --task <ID> --action assign --assigned-to dengshengzhang --json
```

核对当前账号、目标账号、全部字段和本计划完整哈希，无阻断后以相同参数追加 `--apply --plan-hash <指派计划完整64位哈希>`。本次指派计划独立于完成计划，不能复用完成哈希。脚本调用专用 `POST /api.php/v1/tasks/:id/assignto`，请求仅 `assignedTo` 和可选 `comment`，不用通用 update。

回读指派目标、状态、工时、完成者、实际开始／完成时间及全部可编辑字段；只允许指派字段按计划变化及服务端正常更新指派日期、最后编辑人／日期。出现非计划变化立即停止，不再次指派。成功后再次同步同一迭代，再预览并应用 `--phase assigned --assigned-to dengshengzhang --event-at <本次真实时间>`，刷新分支关联；全部成功后按入口文件收尾。
