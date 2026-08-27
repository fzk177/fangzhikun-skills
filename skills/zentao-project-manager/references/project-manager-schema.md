# Project Manager Enhanced 文件约定

## 推荐结构

每个禅道迭代使用一个独立目录，项目主页、需求任务和管理资料必须位于同一目录下：

```text
04.项目/
├── 01.经营系统/
│   ├── 迭代-86-订单功能第二期/
│   │   ├── 00.迭代总览.md
│   │   ├── 01.需求与任务/
│   │   │   ├── 00.禅道资源/
│   │   │   │   └── story-501/file-12345.png
│   │   │   ├── 需求-501-订单批量导入-a1b2c3d4.md
│   │   │   ├── 开发订单接口-b2c3d4e5.md
│   │   │   └── 迭代-86-计划完成-d4e5f6a7.md
│   │   └── 02.项目管理/
│   │       ├── 项目管理.md
│   │       ├── 任务交付/
│   │       └── 上线记录/
│   │           └── 迭代-86-上线准备.md
│   ├── 迭代-87-结算优化/
│   │   ├── 00.迭代总览.md
│   │   ├── 01.需求与任务/
│   │   └── 02.项目管理/
└── 99.已归档/
    └── <已完成迭代目录>/
```

关系映射：

```text
禅道迭代 → 一个迭代目录中的 Project Manager 项目主页
禅道需求 → 01.需求与任务中的顶层事项
需求关联任务 → 需求子任务
禅道子任务 → 更深层子任务
未关联需求任务 → 顶层任务
迭代计划完成日期 → 顶层完成里程碑
迭代首次同步 → 02.项目管理中的项目管理记录 + 上线准备记录
```

迭代项目的固定目录为：`00.迭代总览.md`、`01.需求与任务/`、`02.项目管理/`。同步脚本对已存在的项目保留现有位置，不会在普通同步中自动移动或归档；迁移及归档必须显式执行并校验链接。项目资料正文只在不存在时初始化，后续同步仅更新同步归属属性，不覆盖正文或本地管理属性。

需求、任务及备注中的内嵌位图统一存放在 `01.需求与任务/00.禅道资源/<来源类型-ID>/`。文件名使用稳定的禅道文件 ID，例如 `file-29398.png`；需求笔记和关联任务笔记使用 vault 内 Wiki 图片链接复用同一文件。资源目录不能以 `.` 开头，确保 Obsidian 能建立 Wiki 图片索引。普通同步比较资源二进制内容，不依赖原始文件名，不自动删除已经失效的历史资源。

同步范围始终以 `--execution <ID>` 指定的单个迭代为边界。脚本不读取禅道项目列表，不生成跨迭代项目汇总、项目时间线或待规划池，也不覆盖或删除 vault 中已经存在的旧项目汇总目录。

## 项目管理与上线记录

每个迭代项目首次同步时创建：

- `项目管理.md`：维护项目目标、当前进展、风险、决策、进展记录和复盘。
- `上线记录/迭代-<ID>-上线准备.md`：维护上线范围、角色负责人、前置检查、执行方式、脚本、回滚、验证和实际执行记录。

Project Manager Enhanced 项目文件必须提供两篇笔记的 Wiki-link，并写明本地任务约定：

- 本地项目管理任务使用 `local-management` 标签。
- 上线准备、执行和验证任务同时使用 `release-management` 标签。
- 禅道任务继续使用 `zentao` 标签，三类数据依靠标签明确所有权。
- 同步时只有带 `zentao` 标签且已从远端消失的文件才报告为遗留文件；本地任务不是遗留文件。
- 每次同步都按语义值比较项目资料笔记的同步归属 Frontmatter 属性；值变化时只更新对应属性。YAML 引号、数组写法或排版变化不作为业务差异。
- 项目管理记录同步 `type`、`project`、`zentaoExecutionId`、`zentaoExecutionUrl`；上线准备记录同步 `type`、`project`、`projectManagement`、`zentaoExecutionId`、`plannedDate`。
- `status`、`owner`、`version`、`environment` 及其他未知属性由本地维护，普通拉取同步不得覆盖。
- 上线准备笔记的 `plannedDate` 使用禅道迭代 `end`，但必须注明它只是计划参考，不等同于实际上线日期；禅道计划结束日期变化时同步更新该属性。
- 正式脚本以代码仓库为权威来源时，笔记只记录仓库、分支或 Tag、Commit ID、文件路径、执行顺序和审核信息，避免维护重复脚本。

## Project Manager Enhanced 配置

需求使用父任务、实施任务使用子任务，因此看板需要：

```json
"kanbanShowSubtasks": true
```

应通过插件设置或一次性配置修改启用。同步脚本本身不修改 `.obsidian/plugins/project-manager-enhanced/data.json`。

### 本地迭代归档

项目首页的归档状态不写入禅道，也不移动迭代目录。Project Manager Enhanced 在插件配置中按稳定项目 ID 保存：

```json
"dashboardArchivedProjects": {
  "zentao-execution-86": true
}
```

- 配置中值为 `true` 表示该本地迭代已归档；缺少项目 ID 或值不为 `true` 时视为未归档。
- 首页默认只显示未归档项目，支持查看全部或只看已归档项目；查看全部时归档项目排在同一系统分组底部。
- `sync_zentao_project.js --all-local` 读取该配置并默认跳过归档项目；用户明确要求包含归档项目时追加 `--include-archived`。
- `sync_zentao_project.js --execution <ID>` 是明确的单迭代范围，即使对应项目已归档也继续同步。
- 普通同步禁止修改 `dashboardArchivedProjects`，归档和取消归档只能由本地项目首页操作或用户明确维护。

### 嵌套目录兼容

本规范使用嵌套迭代目录，因此 Project Manager Enhanced 必须递归扫描 `projectsFolder` 下的 Markdown 项目文件，并将 `00.*.md` 项目的任务目录识别为其同级的 `01.需求与任务/`。升级或重装插件后，先检查此能力再迁移或新建迭代，避免列表显示“没有项目”。

## 项目 Frontmatter

```yaml
---
pm-project: true
id: "zentao-execution-86"
title: "禅道迭代 #86 · 订单功能第二期"
description: "由同步脚本生成的说明"
color: "#8b72be"
icon: "🚀"
status: "doing"
taskIds: ["顶层需求稳定ID", "未关联任务稳定ID"]
customFields:
  - id: "zentaoSourceType"
    name: "禅道来源类型"
    type: "select"
    options: ["story", "task", "execution"]
teamMembers: ["张三"]
savedViews:
  - id: "zentao-requirements"
    name: "需求阶段"
    filter: {"stages":[],"tags":["zentao-requirement"]}
    sortKey: "stage"
    sortDir: "asc"
    viewMode: "table"
createdAt: "2026-08-12T08:00:00.000Z"
updatedAt: "2026-08-12T08:00:00.000Z"
---
```

`taskIds` 只列顶层需求、顶层子需求或未关联需求的顶层任务，不列已经挂到需求下的任务。
迭代项目的 `taskIds` 还应包含自动生成的顶层迭代完成里程碑。

迭代项目的 `status` 直接保存禅道迭代原始状态。Project Manager Enhanced 项目面板可读取该字段作为项目状态信息；项目的系统分组由迭代所在的一级目录决定。分类只影响面板展示，不移动项目目录或改写 Wiki-link。

新迭代首次同步前，必须由用户选择 `04.项目` 下现有的一级系统目录，并通过 `--system-folder` 传入。同步脚本将迭代目录创建在该系统目录内；已存在的迭代仅按稳定 ID 读取其原目录，忽略新目录参数且不得移动。

## 表格层级呈现约定

Project Manager Enhanced 表格使用 `customFields.zentaoSourceType` 与 `customFields.zentaoId` 区分来源：

- 列头使用“事项 ID”，需求显示“需求 #<ID>”、任务显示“任务 #<ID>”；不能再显示笼统的“禅道 ID”。
- `title` 始终保持禅道原始名称，展示 ID 不得反写到标题、正文或 Frontmatter 的其他字段。
- 需求作为父级分组项，关联任务作为其子级。相邻需求组仅在界面层使用薄荷绿、暖杏橙两种低饱和度色系交替；需求使用较明显的色条或浅色背景，子任务继承相同色系但使用更淡的背景。
- 需求标题可比任务标题略大、字重略高；任务普通文字（事项 ID、事项标题、模块等）使用界面灰色且标题不加粗。阶段、状态、优先级、负责人、完成者和标签必须保留各自的语义组件颜色。颜色必须由稳定的父需求顺序决定，禁止随机配色，避免刷新后同一需求视觉标识漂移。
- 上述均属于 Project Manager Enhanced 插件展示逻辑；同步脚本只保证来源类型、ID 和父子关系正确，不得向 Markdown 写入展示样式。
- `zentao` 是内部同步归属标签，不在表格、看板或详情标签区展示；`zentao-requirement`、`zentao-task` 仍保留为 Saved View 筛选依据，但界面文案分别为“需求”“任务”。关联任务不再重复显示“子任务”结构标签，缩进和父子关系已足以表达层级。
- 甘特图左侧使用与表格一致的定位信息，列顺序固定为“事项 ID｜事项｜阶段｜状态｜优先级｜负责人｜完成者”。阶段、状态、优先级使用配置标签，负责人读取 `assignees`，完成者读取 `customFields.completedBy`；`executionId`、`storyId`、`zentaoUrl`、`sourceUpdatedAt` 仅留在详情或同步诊断，禁止增加为甘特图日常列。
- 甘特图列头支持点击排序和拖拽列边界调整宽度。排序限于同级事项，递归保留每项的子任务，禁止将需求与其关联任务拆散或改变父子关系。
- 甘特图事项标题受列宽限制时允许省略，但悬停时必须显示完整标题；展示文本仍直接来自原始 `title`，不得额外拼接禅道 ID。

## 需求 Frontmatter

```yaml
---
pm-task: true
projectId: "zentao-execution-86"
parentId: null
id: "需求稳定ID"
title: "订单批量导入"
type: "task"
stage: "developing"
status: "active"
priority: "high"
start: "2026-08-10"
due: "2026-08-20"
progress: 40
assignees: ["张三"]
tags: ["zentao", "zentao-requirement", "未更新工时", "超时3h"]
subtaskIds: ["关联任务稳定ID"]
dependencies: []
customFields:
  zentaoSourceType: "story"
  zentaoId: "501"
  zentaoUrl: "http://example/zentao/story-view-501.html"
  zentaoModule: "订单中心 / 订单导入"
  zentaoModuleId: "208"
  executionId: "86"
  storyId: ""
  completedBy: ""
  estimatedHours: 0
  consumedHours: 0
  remainingHours: 0
  displayEstimatedHours: 20
  displayConsumedHours: 23
  displayRemainingHours: 0
  sourceUpdatedAt: "2026-08-12 10:00:00"
---
```

需求进度优先按照直属子事项的预计工时加权计算；没有预计工时时按子事项数量平均计算。

### 工时健康标签与需求展示工时

- `未分配开发`：需求全部后代任务中没有 `devel/develop/development/dev` 类型。
- `未分配测试`：需求全部后代任务中没有 `test/testing/qa` 类型。
- `未更新工时`：需求原始 `estimatedHours = 0`，但后代任务的预计、已消耗或剩余工时任一合计不为 `0`。
- `超时<差值>h`：已消耗大于预计；需求使用后代任务已消耗合计，任务使用自身 `consumedHours`。该标签在插件中固定显示为红色。
- `提前<差值>h`：事项已完成，并且已消耗小于预计。

动态标签由拉取脚本全量重算，条件消失后必须移除。工时差值最多保留两位小数，不写多余尾零。

`displayEstimatedHours`、`displayConsumedHours`、`displayRemainingHours` 是需求行专用的隐藏展示字段：

- 需求禅道预计工时大于 `0` 时，展示预计仍使用原始需求预计，已消耗使用后代任务合计。
- 需求禅道预计工时为 `0` 且子任务存在工时时，展示预计和已消耗都使用后代任务合计，并添加 `未更新工时`。
- 三个字段不加入项目 `customFields` 定义，避免产生重复表格列；不进入 `zentaoPushBaseline`，写回脚本不得把派生值更新到禅道。
- PM 洞察总体和成员指标继续统计任务原始工时，需求展示汇总不得再次进入指标，避免与子任务重复累计。

需求和任务标题必须与禅道原始名称一致；不要将“需求 #ID”“任务 #ID”等 ID 前缀写入 `title`。禅道 ID 只保存在 `customFields.zentaoId`。

## 任务 Frontmatter

```yaml
---
pm-task: true
projectId: "zentao-execution-86"
parentId: "需求稳定ID"
id: "任务稳定ID"
title: "开发订单接口"
type: "subtask"
stage: "devel"
status: "doing"
priority: "high"
start: "2026-08-10"
due: "2026-08-15"
progress: 40
assignees: ["张三"]
tags: ["zentao", "zentao-task"]
subtaskIds: []
dependencies: []
timeEstimate: 16
customFields:
  zentaoSourceType: "task"
  zentaoId: "5678"
  zentaoUrl: "http://example/zentao/task-view-5678.html"
  zentaoModule: "订单中心 / 订单导入"
  zentaoModuleId: "208"
  executionId: "86"
  storyId: "501"
  completedBy: "张三"
  estimatedHours: 16
  consumedHours: 8
  remainingHours: 8
  actualStartedAt: "2026-08-10 09:30:00"
  actualFinishedAt: ""
  sourceUpdatedAt: "2026-08-12 11:00:00"
---
```

- 关联需求或父任务存在时，任务类型使用 `subtask`。
- 未关联需求且没有父任务时，任务作为顶层 `task`。
- `parentId` 与父文件的 `subtaskIds` 必须对应。
- `dependencies` 只表示真正的前后置依赖，不用于表示需求关联。
- `completedBy` 从禅道任务的 `finishedBy` 转换为真实姓名；任务未完成时为空。
- 禅道任务自身的业务类型直接写入原生 `stage`；它不改变 Project Manager Enhanced 的 `task/subtask` 层级类型。
- `start` 和 `due` 表达计划日期；`actualStartedAt` 和 `actualFinishedAt` 分别保留禅道 `realStarted`、`finishedDate` 的完整实际时间。
- `completed` 只在任务完成后写入实际完成日期，供 Project Manager 判断完成节点；它不能替代 `actualFinishedAt` 的完整时间。

## Bug质量事实与派生字段

每个迭代使用独立数据支持文件：

```text
<迭代目录>/03.数据支持/zentao-bug-facts.json
```

该文件不是 Project Manager 事项，不使用 `pm-task`，不加入项目任务层级，也不在项目资料中生成 Wiki-link。格式为：

```json
{
  "schemaVersion": 1,
  "projectId": "zentao-execution-148",
  "executionId": "148",
  "recordCount": 2,
  "dataHash": "完整64位摘要",
  "records": [
    {
      "storyId": "436",
      "severity": "1",
      "status": "active",
      "assignedToAccount": "chenzongjun",
      "assignedTo": "陈宗军",
      "resolvedByAccount": "",
      "resolvedBy": ""
    }
  ]
}
```

- 每条记录代表一个 Bug，但不保存 Bug ID、标题、描述、步骤、附件、历史、链接或备注。
- 账号用于人员唯一识别，姓名用于界面展示；当前指派人和解决人必须分开聚合。
- `active` 表示未解决且未关闭，`resolved` 表示已解决待验证/关闭且未关闭，`closed` 表示已解决且已关闭。
- `dataHash` 对排序后的最小事实数组计算 SHA-256；事实内容未变化时不得仅因接口返回顺序变化而改写文件。
- 同步必须完整读取全部分页后再原子替换数据文件；任意分页失败时保留旧文件并停止本次迭代写入。
- 数据文件默认不纳入 Git 追踪。

需求的 `customFields` 同步增加以下派生字段：

| 字段 | 含义 |
|---|---|
| `bugTotal` | 关联 Bug 总数 |
| `bugUnclosed` | 未关闭 Bug 数 |
| `bugUnclosedSeverity1` | 未关闭1级 Bug 数 |
| `bugUnclosedSeverity2` | 未关闭2级 Bug 数 |
| `bugUnresolved` | 当前状态为 `active` 的 Bug 数 |
| `bugResolvedOpen` | 当前状态为 `resolved` 的待验证/关闭 Bug 数 |
| `bugClosed` | 当前状态为 `closed` 的 Bug 数 |
| `bugSummary` | 需求表格紧凑展示文案 |

这些字段不加入 `zentaoPushBaseline`，不参与工时与进度洞察，也不得写回禅道。任务和里程碑不生成这些字段。

Project Manager 和 PM 洞察只消费聚合结果：

- 迭代详情展示 Bug质量卡、人员未关闭 Bug 列和严重 Bug 风险。
- 人员洞察的当前负责指标读取 `assignedTo`，解决成果读取 `resolvedBy`。
- 人员组合分析只输出按严重级别、状态、迭代或需求汇总的矩阵，不提供单个 Bug 列表。
- 存在未关闭1级 Bug 时将对应迭代或人员健康等级提升为高风险；存在未关闭2级且没有未关闭1级时提升为关注。

## 迭代总结数据与界面约定

每个迭代使用独立的自动总结数据文件：

```text
<迭代目录>/03.数据支持/zentao-iteration-summary.json
```

该文件不是 Project Manager 事项，不使用 `pm-task`，不加入项目任务层级，不生成 Wiki-link，默认不纳入 Git 追踪。推荐结构为：

```json
{
  "schemaVersion": 1,
  "projectId": "zentao-execution-148",
  "executionId": "148",
  "generatedAt": "2026-08-25T08:30:00.000Z",
  "sourceHash": "完整64位摘要",
  "projectUpdatedAt": "2026-08-25T08:20:00.000Z",
  "bugDataHash": "Bug事实完整64位摘要",
  "deliveryPlanSignature": "规范化交付批次签名",
  "coverage": {
    "requirementTotal": 19,
    "requirementWithDescription": 18,
    "requirementWithoutDescriptionIds": ["501"]
  },
  "overall": {
    "introduction": "本迭代围绕……",
    "themes": [
      {
        "id": "稳定主题ID",
        "label": "发票与票样",
        "summary": "主要包括……",
        "requirementIds": ["需求稳定ID"]
      }
    ]
  },
  "batches": [
    {
      "id": "delivery-稳定批次ID",
      "name": "第1批交付",
      "introduction": "第1批交付主要交付……",
      "themes": [],
      "requirementIds": ["需求稳定ID"],
      "independentTaskIds": []
    }
  ],
  "unassigned": {
    "introduction": "当前有……尚未安排交付批次。",
    "themes": [],
    "requirementIds": [],
    "independentTaskIds": []
  },
  "changes": {
    "initial": false,
    "addedRequirementIds": [],
    "removedRequirementIds": [],
    "newlyClosedRequirementIds": [],
    "statusChangedRequirementIds": [],
    "batchChangedRequirementIds": [],
    "bugDelta": {
      "unclosed": -2,
      "closed": 2,
      "unclosedSeverity1": 0,
      "unclosedSeverity2": -1
    }
  },
  "snapshot": {
    "requirements": [],
    "bugStats": {}
  }
}
```

字段约定：

- `sourceHash` 覆盖迭代元数据、需求、任务、Bug事实摘要和交付批次签名；输入未变化时不得仅更新生成时间。
- `projectUpdatedAt`、`bugDataHash` 与 `deliveryPlanSignature` 用于插件判断总结是否与当前来源一致，不参与禅道写回。
- `themes.requirementIds` 使用 Project Manager 稳定事项 ID。一个需求只进入一个主主题，主题计数不得重复。
- `batches[].id` 必须直接使用 Project Manager Enhanced 中的稳定交付批次 ID；批次被删除后插件忽略旧总结，不能按名称猜测新旧批次关系。
- `snapshot` 只保存生成下一次聚合变化所需的需求状态、需求批次归属和 Bug聚合数字；禁止保存 Bug明细。
- `coverage` 只报告需求内容可用于归纳的覆盖度。详情缺失时仍保留精确状态和数字，并在界面显示“数据不完整”。

Project Manager Enhanced 迭代详情顶部操作区按“统计范围｜迭代总结｜交付批次｜查看计算过程｜收起”排列。“迭代总结”打开右侧抽屉：

- 提供整体、每个交付批次和未安排范围页签，默认跟随当前统计范围。
- 整体页展示整体迭代介绍、状态快照、功能范围、交付批次归纳、本次更新变化和全部需求。
- 批次页展示批次状态、负责人、提测日期、上线日期、人工批次说明、自动范围概述、进度、Bug质量、功能主题和批次需求。
- 人工批次说明直接读取 `iterationDeliveryPlans.batches[].description`，自动总结不得覆盖或反写该值。
- 已关闭需求严格按原始 `status = closed` 统计；当前应完成、实际完成和偏差继续复用迭代健康度算法。
- Bug只展示总数、未关闭、未解决、待验证/关闭、已关闭、未关闭1级和未关闭2级聚合数字，不提供Bug行、ID或详情入口。
- 总结文件不存在时使用当前需求标题和模块实时生成保守范围说明，并显示“暂无总结”；来源签名变化时显示“需刷新”，精确指标仍现场计算。

## 迭代完成里程碑 Frontmatter

```yaml
---
pm-task: true
projectId: "zentao-execution-86"
parentId: null
id: "里程碑稳定ID"
title: "迭代 #86 · 计划完成"
type: "milestone"
stage: "sprint"
status: "doing"
priority: "medium"
start: ""
due: "2026-08-20"
progress: 0
assignees: []
tags: ["zentao", "zentao-milestone"]
subtaskIds: []
dependencies: []
customFields:
  zentaoSourceType: "execution"
  zentaoId: "86"
  zentaoUrl: "http://example/zentao/execution-task-86.html"
  executionId: "86"
  completedBy: ""
  estimatedHours: 0
  consumedHours: 0
  remainingHours: 0
---
```

- `due` 始终保留禅道迭代的计划结束日期 `end`，不能用实际结束日期覆盖。
- 仅当迭代原始状态为 `done` 或 `closed` 时，才把 `realEnd` 写入 `completed`。
- 里程碑必须是顶层事项，不关联需求、不接受子任务，也不记录工时和进度。
- 本地手工里程碑不带 `zentao-milestone` 标签，后续同步不得覆盖或删除。

里程碑的 `stage` 直接使用迭代 `type`，`status` 直接使用迭代原始状态，不做映射。

## 所属模块映射

- 需求和任务的 `module` 原始值写入 `customFields.zentaoModuleId`。
- `customFields.zentaoModule` 写入完整模块路径，层级之间使用 ` / ` 分隔。
- 模块 ID 为 `0` 时显示 `未设置`，模块 ID 字段保持为空。
- 模块名称通过只读 REST API `GET /executions/<迭代ID>/task/modules` 的 `modules` 映射解析，请求时必须同时传递当前迭代 ID，避免服务端复用上一次迭代上下文。
- 无法解析名称时保留 `zentaoModuleId`，并把展示值降级为 `模块 #<ID>`，不得静默丢失模块信息。
- Project Manager Enhanced 表格将 `zentaoModule` 提升为固定“模块”列；任务详情仍通过“所属模块”自定义字段展示。
- `executionId` 与 `storyId` 仅用于同步关联和任务详情，不作为项目表格列展示；迭代和关联需求的定位由父子层级及“事项 ID”表达，避免重复信息挤占表格宽度。
- `zentaoUrl` 与 `sourceUpdatedAt` 仅在详情和同步诊断中保留，不作为项目表格列展示；禅道链接无需在表格中重复铺开，更新时间也不作为日常项目状态判断依据。

## 阶段与状态原生字段

- 需求：`stage = story.stage`，`status = story.status`。
- 任务：`stage = task.type`，`status = task.status`。
- 迭代里程碑：`stage = execution.type`，`status = execution.status`。
- 字段值完整保留禅道原始类型，只通过 Project Manager Enhanced 阶段/状态目录配置中文标签、颜色和排序。
- 未识别值继续原样展示，不回退为 `todo`、`in-progress` 等 PM 语义值。
- `completed` 是独立事实字段；任务或迭代仅在原始状态为 `done/closed` 且能取得实际完成日期时写入，需求按关闭或实际交付阶段处理，但不使用计划截止日期伪造完成日期。

## 优先级映射

| 禅道优先级 | Project Manager 优先级 |
|---|---|
| `1` | `critical` |
| `2` | `high` |
| `3` 或未知 | `medium` |
| `4` | `low` |

## Saved Views

每个迭代项目预置：

- `需求阶段`：过滤 `zentao-requirement`，按 `stage` 排序的表格视图。
- `任务状态`：过滤 `zentao-task`，按禅道任务原始 `status` 分栏；保存视图只应用筛选，不强制切换当前表格、甘特图或 Kanban 视图。需求看板则按原始 `stage` 分栏。
- `里程碑`：过滤 `zentao-milestone`，甘特图视图。
- `上线管理`：过滤 `release-management`，表格视图；用于本地上线准备、执行和验证任务。
- `我参与的`：过滤当前禅道账号映射后的真实姓名，不限制状态。
- `高优先级`：过滤 `critical`、`high`。
- `禅道未完成状态`：按禅道原始未完成状态集合过滤；它只表示远端工作流状态，不读取或改变独立 `completed` 字段。
- `我的禅道未完成状态`：按当前禅道用户的真实姓名和禅道原始未完成状态集合过滤。

## 正文保护区

任务和需求正文中，仅以下区域由脚本管理：

```markdown
<!-- zentao-sync:start -->
## 禅道信息

从禅道同步的字段和描述。
<!-- zentao-sync:end -->
```

标记外正文视为本地内容，应在后续同步时保留。`Project:`、`Parent:` 和 `## Subtasks` 是 Project Manager 管理关系，允许脚本重建。

## 禅道写回基线

需求和任务的 `customFields` 中包含内部字段 `zentaoPushBaseline`。该字段不加入项目的 `customFields` 定义，因此不会作为普通表格列展示，但会随任务文件保存。

基线是一个 JSON 字符串，包含：

```json
{
  "version": 1,
  "kind": "task",
  "local": {
    "title": "开发订单接口",
    "stage": "devel",
    "status": "doing",
    "priority": "high",
    "start": "2026-08-10",
    "due": "2026-08-15",
    "assignees": ["张三"],
    "timeEstimate": 16,
    "zentaoModuleId": "208",
    "storyId": "501"
  },
  "remote": {
    "name": "开发订单接口",
    "type": "devel",
    "status": "doing",
    "pri": "2",
    "estStarted": "2026-08-10",
    "deadline": "2026-08-15",
    "assignedTo": "zhangsan",
    "estimate": 16,
    "module": "208",
    "story": "501"
  }
}
```

- `local` 保存拉取完成时 Project Manager 中可编辑字段的值。
- `remote` 保存同一时刻对应的禅道 API 值。
- Obsidian 可能把该 JSON 字符串序列化成 YAML 单引号标量；读取时需要先按 YAML 单引号规则解码，再执行 `JSON.parse`。
- `assignees`、`tags` 等字段可能是 YAML 块序列。解析键值时只能匹配行内空白，不能使用会跨行匹配的 `:\s*`，否则第一项可能被误读成普通字符串。
- 本地值未偏离 `local` 时不得写回。
- 本地和远端同时偏离各自基线时属于字段级冲突，不得自动覆盖。
- 计划哈希必须覆盖写入操作、冲突、暂不支持项、远端缺失对象和无基线数量；即使只报告的阶段或状态差异发生变化，旧确认也必须失效。
- 基线只服务于差异检测，禁止显示为业务字段或写入禅道。
- Project Manager 页面长时间未刷新时，内存缓存可能覆盖刚同步的内部基线；写回脚本必须兼容基线缺失，不能直接漏掉用户明确修改过的日期。

## 写回字段约定

受控写回只允许修改现有 `story` 和 `task`，不创建或删除对象：

- 需求：名称、优先级、指派人、预计工时、模块 ID。
- 任务：名称、优先级、指派人、预计工时、模块 ID、关联需求 ID、预计开始和截止日期。
- 日期有正式基线时按字段级基线比较；没有基线时使用同步映射推导兼容基线：`start = estStarted || realStarted || openedDate`，`due = deadline || estFinished || realFinished`。只有本地值偏离推导值且不同于远端当前值时才生成变更。
- 真实姓名必须唯一映射为禅道账号；任务只允许一个指派人。
- 阶段、状态、进度、完成者、实际工时、正文、层级、标签、依赖和里程碑不进入通用写回；本地阶段或状态偏离同步基线时只报告为暂不支持，不得静默忽略或塞入通用 `update`。
- 禅道需求和任务更新接口采用 `PUT` 语义。即使只修改一个字段，也要携带接口支持的完整当前字段快照，并让确认后的差异字段覆盖快照；否则未携带的优先级等字段可能被重置为默认值。
- 完整请求载荷只是保护措施，用户预览中的 `fields` 仍只列真正变更的字段。写回后必须回读确认计划字段已生效、非计划字段未变化。
- 写回命令异常或校验未归零时可能已经发生部分写入；必须逐个回读计划对象，不能直接重试，也不能把失败理解为零写入。

## 稳定 ID

- 迭代项目 ID：`zentao-execution-<ID>`。
- 需求和任务 ID：`sha256("zentao-<类型>:<ID>")` 的前 32 位十六进制值。
- 迭代完成里程碑 ID：`sha256("zentao-milestone:execution-<ID>-planned-end")` 的前 32 位十六进制值。
- 文件名包含稳定 ID 的前 8 位，以减少同名事项冲突。
