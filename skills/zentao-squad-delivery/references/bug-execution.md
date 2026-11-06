# Bug 执行参考

仅在入口已核实为唯一成员 Bug ID、方案已确认、精确源码提交经「测试」复核通过且指派给万事屋后使用。不依赖 `zentao-debug` 会话流程。

## 依赖与预检

- 读取[认证与查询](../../zentao-base/references/read.md)、[Bug 材料](../../zentao-base/references/bug-materials.md)、[写入适配契约](../../zentao-base/references/write.md)。通过基础只读脚本查询 Bug 当前字段和完整历史。
- 读取 [Bug 提交规则](../../zentao-debug/references/commit.md)与 [Bug 本地记录](../../zentao-debug/references/bug-delivery.md)，只提炼 Git 核对和记录契约。其「等待提交确认」「不写禅道」是 `zentao-debug` 自身的会话边界；本 Skill 在自己的授权内连续执行，不修改或扩大 `zentao-debug` 的权限。
- 复用 `zentao-debug/scripts/bug_delivery_record.js` 原脚本，不复制代码。按[任务执行参考的安装根规则](execution.md)定位一套完整兼容的安装，提前核验基础能力、本 Skill 的 Bug 计划、Bug 记录和 `git-branch-delivery` 核心脚本。Vault 与仓库沿用入口的私有 profile，配置不得进入公开源码或评论。
- Git 前核验 Bug 为 `active`、未删除、`openedBy` 为真实账号且历史可读；`resolved`／`closed` 或存在本次交付备注时停止报告。起草、提交前和写入前都须核验 Bug 当前 `story`：正数使用原编号，明确的数值 0 或字符串 "0" 使用 story#0，不需单次例外授权。支持接口对象形态的明确 id/value；缺失、空、null、布尔值、非法编号或查询失败均停止，不能默认成 0。不得猜测、挂靠无关需求、创建需求或修改 Bug 的关联来通过交付。
- 在导入 Git 前核验根因、修复结果、实际验证／未运行项、风险回滚证据齐全且能形成合格四段备注；资料目录可用。任一前提不足都执行[交回用户与回复唤醒](handback.md)。

## 1. Git

复用[任务执行参考的 Git 导入步骤](execution.md)，将其中任务关联和提交标题替换为本节 Bug 规则：准确记录源提交、测试对应哈希、目标原 HEAD、当前分支、显式文件及源到目标映射；禁止切换目标分支、导入整个分支或解决上下文冲突。

排除全部 `docs/`；纯 docs 提交跳过，混合提交只导入明确代码和正式 SQL。不得修改、清理、暂存或 stash 用户已有未提交内容；与导入路径或 hooks 影响无法区分时停止。仅按精确文件路径 `git add -- <文件...>`，保留 hooks，不推送、不设置 upstream；hooks 要求构建／测试时停止，不跳过 hooks。

每仓库标题与正文首行固定为：

```text
fix(<中文模块>): <具体修复结果> story#<Bug实际Story编号，含0> bug#<BugID>

关联需求：story#<Bug实际Story编号，含0>。
```

Bug 类型固定 `fix`；Story 必须来自 Bug 事实，并在起草、提交、预览和执行前逐次核对一致。story#0 表示未关联需求，不伪造需求详情或向需求 0 写备注；该取值规则优先于共享 Bug 参考的单编号示例。关联变化时停止，不自动改写既有提交或重建计划继续。成功后检查实际提交、最终备注、分支和剩余未提交内容；`git diff --name-only <目标原HEAD>..HEAD` 不得出现 `docs/`。同源范围已交付则核验既有结果，不重复提交或解决。多仓库全部成功才继续；任何部分成功立即停止并回交用户。

## 2. Bug 本地交付

用 `zentao-base/scripts/fetch_bug.js` 获取安全摘要；每次调用携带已核实的摘要，避免旧本地记录代替远端事实。先预览、核对后在同轮追加 `--apply`：

```text
node <安装根>/zentao-debug/scripts/bug_delivery_record.js
  --bug <ID> --summary <临时材料目录>/bug-<ID>-summary.json
  --phase committed --vault <Vault>
  --repository <本机仓库> --branch <本机当前分支>
  --base-commit <目标原HEAD> --head-commit <最终目标提交>
  --changed-file <实际提交文件>
  --root-cause <有证据的根因> --resolution <实际修复结果>
  --validation <已执行验证和未运行项> --risk <上线风险与回滚>
  --event-at <实际提交时间> --json
```

多仓库参数按相同顺序重复；只有真实 Codex 会话才传 `--session-id`，Multica issue ID 不能冒充。核对已应用记录实际保留了仓库、分支、基线、最终提交及文件；若首次创建时脚本没有保存完整 Git 字段，使用相同事实再次预览并更新记录，不能仅凭脚本退出码认定完整。

补齐根因、修复范围、实际验证与未运行项、上线风险与回滚；不虚构测试通过或业务验收。正式 SQL 全文与回滚脚本按[本地交付约定](../../zentao-task/references/local-delivery.md)单独维护，仅写本地资料不执行 SQL，无 SQL 明确写无。新内容先查敏感值，不输出命中值，不覆盖人工备注或手工改自动区域。

资料完整后，以同一份 Git 事实先预览再应用 `--phase documented --event-at <实际资料完成时间>`。检查两阶段记录及分支联动均成功。任何资料或分支联动失败即停止，不能重复提交代码或继续解决 Bug。Bug 流程不使用任务工时、任务记录阶段或需求双备注。

## 3. 解决计划与执行

入口成立后直接按远端 Bug 的实际 Story 生成计划，story=0 无需额外授权评论或参数。计划版本 2 以 `storyPolicy=remote-bug-story` 记录规则，绑定实际 Story、Bug 快照、历史、备注与目标字段。旧 `--story-zero-authorization <评论UUID>` 仅保留兼容且仍限定远端为 0，不再必需，也不能覆盖真实关联。旧版未执行的计划不能原样执行；升级前已有计划时先只读核对未发送任何写请求及事实未变化，再显式重新预览。已有尝试标记或结果不确定则不重建、不重试，也不删除标记。

由执行者自动预览、校验及执行，无需用户复制参数、确认哈希或再次批准入口已授权的解决与指派。只有提交授权而入口未成立时，不能自行扩大为解决授权。续接先回读：已成功则报告既有结果；尚未尝试且前提仍成立才执行剩余步骤；有尝试标记或结果不确定时只读核对，不重试。安装版本不支持当前规则时不能改计划或临时换脚本绕过；技能维护与交付执行分开处理。

四段备注以实际提交和 issue 结论为准，用 UTF-8 文件保存在权限 700 的系统临时目录，文件权限 600：

```text
问题原因：
- <具体根因和证据>

修改内容：
- <实际修改及修复后的结果>

验收口径：
- <场景、边界、可核验结果；明确实际验证和未运行项>

其他影响：
- <兼容、数据、部署、回归、风险与回滚；核实没有时写“无其他已知影响”>
```

前三段不允许空或「无」等占位，最后一段也不能空。使用参数数组传路径，不把多行备注插入 shell。先预览：

```text
node <安装根>/zentao-squad-delivery/scripts/zentao_bug_workflow.js
  --bug <ID> --comment-file <临时备注文件> --json
```

预览保存权限受限的计划，绑定 Profile、CLI／配置、Bug 快照与历史、创建人、备注和目标字段，生成完整 64 位 SHA-256。核对 `blockers` 为空、Story 关联与提交一致、`source.status=active`、目标 `status=resolved` 及全部备注正文；写入固定为 `resolution=fixed`、`resolvedBuild=trunk`、`assignedTo=openedBy`，创建人不能取当前指派人或展示名。

本轮以同一参数追加 `--apply --plan-hash <完整64位哈希>`。脚本重新生成计划与保存内容比对，并在请求前再只读核验一次，任何变化即停，不重新生成哈希继续。唯一写请求通过基础 `resolveBug` 适配器，等效 `zentao bug resolve --bugID <ID> --resolution fixed --resolvedBuild trunk --assignedTo <openedBy> --comment <四段备注>`；不调用 update、close、activate、delete 或另写备注。

脚本在请求前保存排他尝试标记，超时、认证恢复、请求错误或回读失败都不重发；再次调用也会阻断。标记不是成功证明，禁止为重试而删除／修改标记或计划。写入异常时仅只读回读并报告已成功／未能确认的字段。

写后只读回读并逐项验证：`resolved`、`fixed`、`trunk`、创建人账号、原历史保持和唯一新增 `resolved` 记录中的备注正文逐字一致；关联需求、创建人及其他非计划字段不得变化。正文存在 HTML 或格式差异也停止交用户核实，不自动放宽比较或补写备注。查询失败或缺历史不能视为成功。

## 4. 收尾与异常

仅 Git、本地 `committed`／`documented`、分支联动和全部 Bug 回读成功后发布本轮唯一最终评论，列出每仓库当前分支与完整提交哈希、Bug ID／状态／解决方案／版本／备注回读、指派创建人账号及「仅本地提交，未推送」。按已授权小队口径置 `done`。

任何失败、来源不明、状态不符、计划变化或部分成功都按[交回用户与回复唤醒](handback.md)立即停止、报告真实状态、指派回 fangzk 并置 `blocked`、登记成员评论唤醒。禁止重复解决、完成、指派、备注或自动回滚。不写数据库，不运行构建或测试，不修改用户已有未提交内容。
