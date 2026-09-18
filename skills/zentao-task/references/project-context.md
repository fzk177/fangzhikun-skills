# 项目上下文

## 本机项目资料

每次进入阶段一时，完整读取以下本机文件：

```text
~/.config/fangzhikun-skills/profiles/zentao-task.md
```

该文件登记真实 Vault、前后端仓库、仓库优先级和当前开发者。文件缺失、路径不存在或多个仓库无法唯一选择时，在方案中明确缺口并询问，不根据源码仓库中的历史内容猜测，也不创建不存在的候选目录。

机器可读的通用路径和禅道连接配置位于 `${FANGZHIKUN_SKILLS_CONFIG:-~/.config/fangzhikun-skills/runtime.json}`。两个文件出现冲突时停止并请用户确认，以免连接错误系统或修改错误仓库。

## 仓库选择

- 标题明确标注前端：前端可修改，后端只读核对。
- 标题明确标注后端：后端可修改，前端只读核对。
- 标题未标明、存在前后端共同验收项或代码不能单端解释：同时只读分析，方案确认后才决定修改范围。
- 排查后端任务时允许结合前端入口、字段转换、接口调用和展示链路，但不要因此自动修改前端。

## 每次编码前检查

1. 从仓库根目录向目标文件查找并完整读取适用的 `AGENTS.md`。
2. 执行只读 `git status --short --branch`、`git branch --show-current` 和基线提交查询。
3. 已有工作区改动属于用户；不要恢复、覆盖、格式化或清理无关内容。
4. 需要新分支时，以方案确认的本地分支为基线创建干净本地分支，不设置 upstream。
5. 修改前端业务逻辑前，按前端仓库约束阅读入口、数据源、mapper、computed、watch、保存、详情、审批、附件与快照链路。
6. 修改后端业务逻辑时，优先把业务逻辑放在 Service，不把逻辑堆在 Controller；Controller 入参使用 Req，返回使用 Resp。

## Project Manager 配置

项目目录读取 `.obsidian/plugins/project-manager/data.json` 的 `projectsFolder`，默认 `04.项目`。需求作为父任务、实施任务作为子任务，因此 `kanbanShowSubtasks` 应为 `true`；检查不符合时报告，不由同步脚本静默修改。

## 需求与任务列表约定

- 本地事项的 `title` 保持禅道原始名称，不添加任务 ID 或来源前缀。
- 禅道 ID 从 `customFields.zentaoId` 读取，由界面独立展示。
- 需求是父级分组，任务是子级；来源类型、稳定 ID 和父子关系由同步脚本维护。
- `zentao`、`zentao-requirement`、`zentao-task` 是同步和筛选标签，不得删除或重命名。
- `executionId`、`storyId`、`zentaoUrl`、`sourceUpdatedAt` 只用于同步关联和来源追溯，不为展示目的复制到标题或新增列表字段。
- 界面展示和排序不得反向改写标题、父子关联或同步事实。
