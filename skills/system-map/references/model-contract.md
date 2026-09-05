# 架构模型契约

## 设计边界

`system-map` JSON 只表达架构语义和可选的软布局提示。具体坐标、节点尺寸、颜色、箭头路径和 Excalidraw 内部字段由脚本生成。

Schema 是字段形状的权威定义；脚本额外检查跨字段引用、稳定 ID、证据和主路径连通性。

## 根对象

| 字段 | 必需 | 含义 |
|---|---:|---|
| `schemaVersion` | 是 | 当前固定为 `1` |
| `diagramType` | 是 | 当前固定为 `architecture` |
| `meta` | 是 | 标题、语言、范围和代码来源 |
| `nodes` | 是 | 架构节点，默认 6～12 个 |
| `edges` | 否 | 有方向的架构关系 |
| `groups` | 否 | 系统、信任、部署或所有权边界 |
| `layoutHints` | 否 | 不影响事实的布局提示 |
| `unknowns` | 否 | 证据不足、需要用户确认的事项 |

数组应使用稳定顺序：节点按主要路径、层级和 ID 排列；关系按起点、终点和 ID 排列。不要写生成时间，避免无意义差异。

## 元信息

`meta.scope` 支持：

- `runtime`：运行时组件与交互，默认值。
- `module`：代码模块及依赖。
- `business-flow`：一条业务链路涉及的组件关系。
- `deployment`：有真实部署证据时使用。

`meta.source` 可以记录仓库名称、40 位 Git revision 和工作区是否存在未提交修改。不得记录个人绝对路径。没有 Git 时可以省略 revision，并在 `notes` 中说明基线限制。

## 节点

节点 `kind` 支持：

| kind | 用途 |
|---|---|
| `client` | 浏览器、移动端、调用方 |
| `frontend` | Web 前端或前端应用 |
| `gateway` | 网关、反向代理、负载均衡入口 |
| `service` | 同步业务服务或应用模块 |
| `worker` | 后台任务和异步消费者 |
| `database` | 持久化数据库 |
| `cache` | 缓存 |
| `message-bus` | 队列、Topic、事件总线 |
| `security` | 身份、鉴权、密钥或策略服务 |
| `external-system` | 仓库边界外的系统 |
| `infrastructure` | 对架构事实必要的基础设施 |

`technology` 保存 Spring Boot、Redis、MySQL 等准确名称；`kind` 不能用产品名代替。

稳定 ID 使用小写英文、数字和连字符，以字母开头。例如 `order-service`、`redis-cache`。重命名展示文字时不得改变 ID；只有实体身份确实改变时才更换 ID。

## 关系

关系 `kind` 支持：

- `request`：请求或调用。
- `read`、`write`、`query`：数据访问。
- `publish`、`consume`：异步消息。
- `authenticate`：认证或鉴权。
- `dependency`：模块或构建依赖。
- `transfer`：其他明确的数据传输。

`mode` 支持 `synchronous`、`asynchronous` 和 `batch`。关系标签应保留协议、API、Topic、动作和读写意图，不能为了排版删除语义。

关键关系必须有自己的证据，不能只依赖两端节点存在。配置中出现 Redis 只能证明 Redis 依赖存在，不能证明某条业务链路一定访问 Redis。

## 事实等级与证据

| truth | 使用条件 |
|---|---|
| `verified` | 代码或配置直接支持该事实，必须带证据 |
| `derived` | 由多个已验证事实组合推导，应带推导所依据的证据 |
| `declared` | 来自用户说明或项目文档，可以不带源码行号，但应在 `notes` 说明来源 |
| `unknown` | 证据不足，只能作为待确认事实 |

证据字段：

- `path`：相对于仓库根目录的路径，不允许绝对路径或 `..`。
- `line`：起始行号。
- `endLine`：可选结束行号，必须不小于 `line`。
- `symbol`：可选类、方法、配置项或模块名称。
- `note`：一句话说明该证据证明什么，不复制大段源码。

不要使用没有统一标尺的数值置信度。

## 分组和边界

分组 `kind` 支持：

- `system`：系统边界。
- `trust`：信任或安全边界。
- `deployment`：有真实部署证据的部署边界。
- `ownership`：团队或职责边界。

分组不能代替关系。只有代码、配置、部署文件或用户说明能够证明边界时才创建。

## 软布局提示

`layoutHints.direction` 当前只支持 `left-to-right` 和 `top-to-bottom`。

- `primaryPath`：读者首先关注的节点顺序。
- `node.layout.rank`：逻辑层级，不是 X/Y 坐标。
- `node.layout.lane`：稳定的职责泳道名。
- `node.layout.order`：同层或同泳道内的阅读顺序。

脚本可以忽略、修正或重新计算这些提示。布局变化不得改变节点、关系、分组或事实等级。

## 待确认项

`unknowns` 用于保存对架构理解有影响、但当前无法从证据确定的问题。每项必须包含稳定 ID、问题和可选的关联节点或关系。不要为了让图看起来完整而把待确认项改写成事实。
