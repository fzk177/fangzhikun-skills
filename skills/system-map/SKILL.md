---
name: system-map
description: 仅在用户显式调用 $system-map 时，读取代码仓库或用户提供的系统事实，生成带源码证据、稳定 ID 和软布局提示的架构语义 JSON，并通过随附脚本校验；不负责在 Agent 中手工计算坐标或直接拼装 Excalidraw 原生元素。
version: 1.1.0
---

# 系统架构建模

## 目标

把真实代码、配置和用户说明提炼为稳定、可追溯的架构语义 JSON。JSON 是系统事实的来源，Obsidian Excalidraw Script 负责布局和绘制。

第一版只支持 `architecture`，不生成时序图、工作流、数据流图或生命周期图。

## 启用条件

- 仅在用户显式使用 `$system-map` 或明确要求使用此 Skill 时启用。
- 用户只要求解释架构时，不自动生成或修改 JSON。
- 不调用 Archify 渲染器，不生成 HTML/SVG，不计算像素坐标或箭头折点。
- 不直接编辑 Excalidraw 原生 JSON；固定校验、布局和绘制逻辑统一使用 [scripts/system_map.js](scripts/system_map.js)。

## 建模流程

1. 明确分析范围和输出位置。默认分析当前代码仓库的高层运行时架构；输出 Vault 从 `${FANGZHIKUN_SKILLS_CONFIG:-~/.config/fangzhikun-skills/runtime.json}` 的 `paths.vault` 读取。用户指定模块、业务链路、部署范围、代码基线、Vault 或输出目录时，以用户要求为准。
2. 检查适用的 `AGENTS.md`、Git 状态和当前基线。只读分析不切换分支，不恢复或覆盖已有修改。
3. 优先检查真实入口、模块依赖、框架配置、路由、服务调用、持久化、消息系统、外部集成和部署配置。文件树和名称只能作为线索，不能单独证明运行时关系。
4. 建立一条清楚的主要路径，再补充必要支路。默认保留 6～12 个核心节点；超过 12 个时说明原因，超过 24 个时拆分视图。
5. 先运行脚本创建固定骨架，再填写语义事实：

   ```bash
   node <本 Skill 目录>/scripts/system_map.js init "<Vault>/20.Excalidraw/系统架构/<名称>.system-map.json" "<标题>"
   ```

   用户未显式指定输出目录时，语义 JSON 固定写入本机 `paths.vault` 所指 Vault 的 `20.Excalidraw/系统架构/`；脚本会自动创建缺失目录。`paths.vault` 缺失、不是绝对路径或目录不存在时停止，不把代码仓库目录当作 Vault，也不搜索或猜测其他路径。用户显式指定其他位置时使用其指定路径。

6. 按 [架构模型契约](references/model-contract.md) 填写节点、关系、分组、证据、待确认项和软布局提示。使用相对仓库路径，不写个人绝对路径。
7. 每个 `verified` 节点和关系必须带直接证据。跨文件推导使用 `derived`；用户说明使用 `declared`；证据不足使用 `unknown`，不得把推测写成已验证事实。
8. 每次修改 JSON 后运行固定校验：

   ```bash
   node <本 Skill 目录>/scripts/system_map.js validate <输出>.system-map.json --json
   ```

9. 校验失败时只修复回执指出的对象。最终校验通过后停止修改，并返回 JSON 路径、节点/关系数量、事实来源统计、警告和仍待确认的问题。

## 输出约束

- 文件名使用 `*.system-map.json`，`schemaVersion` 固定为 `1`，`diagramType` 固定为 `architecture`。
- 默认输出目录是本机配置 `paths.vault` 所指 Obsidian Vault 下的 `20.Excalidraw/系统架构/`，语义 JSON 与对应 Excalidraw 笔记放在同一目录；代码仓库目录只作为分析与证据来源，不能替代 Vault。只有用户显式指定时才改用其他位置。
- ID 使用稳定的领域名称，例如 `order-service`；不得使用数组序号、随机数、时间戳或当前坐标生成 ID。
- `kind` 表达组件职责，`technology` 表达具体产品或框架，两者不得混用。
- 关系标签保留协议、动作、同步/异步和读写方向等关键信息。
- 绝对坐标、尺寸、颜色、箭头端点和 Excalidraw 元素 ID 不进入语义 JSON。
- 只允许 `rank`、`lane`、`order` 和 `primaryPath` 这类软布局提示；删除提示不得改变架构事实。
- `meta.source` 不记录个人绝对路径。Git 工作区有未提交修改时写入 `dirty: true`，不得只用 HEAD 冒充完整代码状态。
- JSON、Excalidraw 图和其他生成物默认不加入 Git，除非用户明确要求。

## Excalidraw 交付

[scripts/system_map.js](scripts/system_map.js) 同时是 Obsidian Excalidraw Script。将它复制到 Excalidraw 插件配置的脚本目录后，可在 Obsidian 命令面板中运行：

- 新建图：根据 JSON 自动分层布局并创建 Excalidraw 笔记。
- 同步并保留布局：按稳定 ID 更新由脚本生成的内容，保留已有节点位置和用户手工创建的元素。
- 重新布局：重新计算脚本管理元素的位置，不修改语义 JSON。

脚本在校验通过前不得修改当前画布。同步时只处理带 `customData.systemMap` 标记且来源 JSON 相同的元素；没有该标记的人工元素必须保留。JSON 中删除的实体只删除对应的脚本管理元素。

新建图时，脚本使用所选语义 JSON 的所在目录作为 Excalidraw 笔记目录。因此按默认规则生成的图会写入本机 `paths.vault` 所指 Vault 的 `20.Excalidraw/系统架构/`；用户显式指定其他 JSON 输出目录时，图也跟随该目录。

用户显式要求 `$system-map` 生成或更新架构产物时，按上述默认目录写入语义 JSON 无需重复询问输出授权。Skill 源码只提供脚本，不自行复制到 Obsidian Vault，不修改 Obsidian 配置；安装脚本、修改插件配置或执行其他 Vault 操作仍须得到用户明确授权。

## 安全与真实性

- 不输出或写入 Token、Cookie、密码、私钥、真实生产凭据或本机数据库密码。
- 源码证据只记录必要的相对路径、行号和符号，不把大段业务源码复制进 JSON。
- 不读取与架构范围无关的业务数据、个人笔记或本机配置。
- 不把静态依赖图描述为实时流量、性能、故障影响或生产部署事实。
- 不因追求整洁图形删除有意义的节点、关系或不确定性说明。

字段定义与证据规则见 [架构模型契约](references/model-contract.md)，格式约束见 [JSON Schema](schemas/system-map.schema.json)。本 Skill 参考 Archify 的建模思想，许可与来源见 [第三方说明](references/third-party-notice.md)。

## 完成标准

结果应包含：

1. 分析范围和代码基线。
2. 生成的 `*.system-map.json` 路径。
3. 脚本校验结果及事实来源统计。
4. 是否已经在 Obsidian 中绘制；未获授权复制脚本或修改插件配置时明确说明未执行。
5. 仍待确认的架构问题。
6. 明确说明生成物是否加入 Git。
