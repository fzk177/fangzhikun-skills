# 写入适配契约

仅在 `zentao-task` 的对应写入阶段，或 `zentao-squad-delivery` 已满足自身入口授权及交付前置条件后读取。独立调用 `zentao-base`、通过 `zentao-debug` 或 `zentao-ui-cases` 获取材料不允许进入写入路径。

## 调用方职责

`zentao-task` 保留 `scripts/zentao_task_workflow.js` 以及 `references/zentao-workflow.md`，负责计划生成和保存、完整字段差异与备注展示、用户确认、64 位计划哈希重新校验、前置阻断、动作顺序、写后回读和迭代同步。工时规则、代码提交前置条件、任务与需求同内容交付备注、完成后单独指派均不下沉或放宽。

`zentao-squad-delivery` 的任务分支复用上述计划脚本，只允许 `complete` 与完成后的 `assign` 工作流，不复制写入实现。其成员授权须由该 Skill 按可信 issue 来源核实；满足授权后，生成预览、校验无阻断项并在同轮使用完全相同参数和完整 64 位哈希执行，不等待会话回复。任务已提交、四段备注、双备注回读、工时、专用指派接口、远端快照核验与迭代同步仍须满足；任何变化或部分失败即停止交用户，不自动重试。

其 Bug 分支仅通过 [Bug 独立计划脚本](../../zentao-squad-delivery/scripts/zentao_bug_workflow.js)调用 `resolveBug`。计划脚本负责 active 状态、未删除、真实需求关联、创建人账号、完整历史、四段备注、已有同文备注阻断、700/600 临时计划保存与完整 64 位哈希校验。执行前再次回读原快照；唯一请求同时解决、指派和备注。写后回读状态、fixed、trunk、创建人账号、唯一新增解决记录与备注全文，以及原历史和非计划字段。任何失败立即停止，保留尝试标记，不自动重试或单独补备注；交回用户、blocked 与成员评论唤醒由小队 Skill 编排。

基础写入模块不判断自然语言确认，也不把哈希视为用户授权。不得绕过调用方工作流直接导入模块执行写请求。`zentao-task` 的既有确认在源码迁移、请求参数、远端基线或计划变化后不能继续复用，需重新预览确认；`zentao-squad-delivery` 的计划变化按其异常即停规则处理。两者不互相继承授权。

## 接口封装

`scripts/zentao_write.js` 仅供已校验计划内部调用：

- `writeCliJson`：只接受任务 `start/finish/update` 与需求 `update`，纯数字 ID 和单个 JSON data 参数；需求只允许 `comment`，不接受正文、验收或状态修改。
- `assignTask`：使用专用 `POST /api.php/v1/tasks/:id/assignto`，只允许 `assignedTo` 和可选 `comment`，不用通用编辑入口指派。
- `resolveBug(options, bugId, data, caller)`：调用方标识必须为 `zentao-squad-delivery`，只接受正整数 Bug ID 和恰好四个字符串字段 `resolution`、`resolvedBuild`、`assignedTo`、`comment`；固定 `fixed`、`trunk`，账号及备注不得为空。仅转换为 `bug resolve --bugID ...` 的参数数组，不经 shell，不允许 `resolvedDate` 或其他附加字段。创建人、四段内容和读写校验由上述计划负责。调用方标识仅是接口误用保护，不替代成员授权及保存计划校验。

任务编辑仍由调用方提供完整必要快照并核对非计划变化。`writeCliJson` 继续拒绝全部 Bug 命令；独立 `resolveBug` 不开放 Bug 编辑、关闭、激活、删除或单独备注，也不开放给 `zentao-task`、`zentao-debug`、`zentao-ui-cases` 或独立查询。

## 异常

写请求失败、响应异常或结果不确定时不重新发送。认证失效可以恢复登录，但原写请求不重试；先只读回读实际状态，再按调用方规则重新预览并确认后续动作。任务已完成、任务备注或需求备注部分成功时分别报告，禁止重复完成任务或重复新增备注。
