# 请求策略

## 当前生效策略（2.0.0）

用户通过 `$skill-manager` 明确要求：调用的命令、接口具有明显查询含义时直接放行，其余接口交给用户判断，不直接阻断。统一策略登记在 [read-only.json](read-only.json)，由真实请求守卫执行：

1. 原精确读取规则匹配的请求直接放行。
2. 接口路径末段以 get/query/search/list/read/find/fetch 开头的请求也直接放行，前缀大小写不敏感，不区分 HTTP 方法；无需先登记，也不因精确规则参数不匹配而否决。官方读取命令及独立查询扩展的每个实际请求均按此规则判断，命令名称不替代后续接口的独立审核。
3. 其他请求立即生成 `approval_required` 审核单，逐条等待用户 allow/deny，不自动拒绝；没有预填 purpose/impact 时展示真实命令、请求参数和待判断的副作用，不提前退出。

名称放行依据是用户的授权约定，不能解释成已获得服务端无副作用证据。即使 get 接口返回 ID 或出现在新建路径，也按名称规则放行；新名称匹配及指定观察接口记录脱敏请求、放行依据和响应摘要。

环境 origin、凭证、未知传输通道和本机文件保护继续生效；这条规则不是允许任意外部地址、未支持传输或绕过请求守卫。以下各节保留源码核查与精确规则的登记历史；其中旧参数范围和旧暂停结论已经由本节的名称放行规则覆盖。

首版白名单覆盖已在官方 CLI 1.1.9 源码核对的流程搜索、节点、出口、流程图读取，Ebuilder 应用和表单信息、数据查询、人员／组织浏览以及已确认的表单布局和字段读取。

## 已确认的补充只读接口

2026-09-30，在展示具体方法、完整路径及可能副作用后，用户明确确认编号 1、2、3、6、7 可以标记为只读。以下五条规则以官方 CLI 1.1.9 的具体读取调用和用户对接口语义的确认为依据；此次只做本机源码核对，未请求 OA 或验证服务端行为。

| 确认编号 | 方法与完整路径 | 官方 CLI 1.1.9 源码位置与用途 | 用户确认的只读范围 |
|---|---|---|---|
| 1 | GET `/api/bs/ebuilder/form/workflow/pathdef/mark/markSet/getMarkSetForm` | `dist/commands/form-serial-mark.js:39`，按 `workflowId` 获取默认编号规则 | 获取默认规则不初始化配置或生成 ID |
| 2 | GET `/api/bs/workflow/pathdef/mark/markDef/getMarkDefEditTable` | `dist/commands/workflow-numbering.js:37`，按 `workflowId`、`markDefId` 读取编号定义 | 包含 `markDefId=0` 的读取，不生成默认定义 |
| 3 | GET `/api/bs/workflow/pathdef/mark/markField/getMarkFieldEditTable` | `dist/commands/workflow-numbering.js:41,80`，读取编号组成 | 包含 `markDefId=0` 的读取，不生成默认编号段或 ID |
| 6 | POST `/api/ebuilder/form/form/builder/getFormLayout` | `dist/services/form-view.js:175-185`，读取表单视图布局 | 源码所示 `layoutMultiId`、`local:true`、未传 `convert` 的调用属于只读，不创建或持久转换布局 |
| 7 | POST `/api/ebuilder/form/form/view/relate/getConfig` | `dist/commands/form-add-detail-table.js:52-56`，获取字段布局配置 | 源码所示配置读取不补建配置或分配 ID |

白名单按方法与完整路径精确匹配；此次不扩展到相似路径。编号 4 的 `/api/ebuilder/form/form/linkage/preCheck` 与编号 5 的 `/api/form/datasources/checkName` 仍待确认，不登记只读。`getMarkSet` 的默认记录初始化、`getEbMarkTargetId` 和 `getMarkFieldAddData` 的 ID 生成，以及 `initLayout` 的布局重建仍属于非只读；读取命令中夹带这些请求时仍须逐条审核。

## 审批人和条件明细核查（2026-09-30）

用户要求检查实际语义，确认合适后登记；本次依据已安装官方 CLI 1.1.9 的读取函数、文档及创建路径交叉核对，仅登记下列范围。已用源码受控入口在 prod 读取已知节点审批人、已有条件上下文和条件列表，并核对官方原生条件 list 的兼容性；这不等于已核对服务端实现或证明没有服务端副作用。

| 方法与完整路径 | 源码依据 | 登记范围 |
|---|---|---|
| GET `/api/bs/workflow/pathdef/nodeOperator/getOperatorGroupList` | `dist/services/workflow-operator.js:7-14`、`dist/commands/workflow-operator-sign.js:82`：读取已有组条目；删除和保存由其他独立接口完成 | 参数仅限正整数 `paramGroupId`、`nodeId`，`sourceType=1`，`refWorkflowId` 为空；重复或额外参数不自动放行 |
| POST `/api/workflow/pathdef/rule/condition/getConditionList` | `dist/commands/workflow-condition.js:467-486,530-574` 及官方条件指南“查看已有条件”：按已有出口列出条件；创建保存和删除走独立接口 | 仅 `source=2`、正整数 workflowId/sourceId/conditionKey、`needFormfield=true`、`viewRight=true`；readOnly/addRight/editRight/deleteRight 仅接受布尔值，兼容官方读取所带界面标志，分页范围 1–100 |

`getNodeSetForm` 原已登记，可用于读取操作者组 ID；新增独立 `workflow operators` 扩展只调用节点列表、节点设置和组明细三个读取接口。完整组条目用于识别人员 ID、签署顺序、动态选人及条件，不把节点名或连线名当作审批人证据。

### 用户明确授权先放行的观察名单

2026-09-30，用户明确指示：“新建时会调用也不影响它是纯读取，我建议先放行，加入观察名单”。按此授权登记下列两个接口，并标记 `observe=true`。这不表示已获得服务端实现证据；新建调用及返回 ID 也不能单独证明持久写入，前述疑点继续通过观察核实。

| 方法与完整路径 | 源码依据 | 自动放行与观察范围 |
|---|---|---|
| POST `/api/workflow/pathdef/rule/condition/getConditionSet` | `dist/commands/workflow-condition.js:471` 读取条件上下文；`dist/services/condition-rules.js:219-230` 创建时也使用其 mapBaseId | 无 URL 查询参数，source=2、needFormfield=true、正整数 workflowId/sourceId；readOnly 可为 true/false，兼容官方读取。不扩展到动作条件 source=19 |
| POST `/api/bs/workflow/pathdef/nodeOperator/getLayoutConfigInfo` | `dist/services/workflow-initiator.js:58-69`、`dist/commands/workflow.js:1311` 取得界面配置及 reserveGroupId | 无 URL 查询参数，isOperatorRuleAuth=true、sourceType=1、正整数 workflowId/nodeId；groupId 仅为空或正整数，其他调用不自动放行 |

每次记录脱敏请求、环境、HTTP/业务状态、mapBaseId/conditionKey/reserveGroupId、响应哈希及连接异常，不保存完整响应或凭证。记录位于原有私有任务目录，权限沿用 600/700；成功响应只证明查询返回，不能证明没有服务端副作用。观察名单不放行保存、删除、发布或其他相似路径。

本次 prod 回读的已有出口条件中，readOnly=true 与官方 readOnly=false 均返回原已绑定 conditionKey，未观察到 ID 改变。getLayoutConfigInfo 尚未在真实环境单独回读。精确登记保留请求字段限制用于匹配依据；2.0.0 起未满足这些限制但符合查询名称的请求同样放行，并记录 query-name 观察结果。

`workflow conditions-read` 会先核对已有出口绑定，再取得完整条件上下文并回读同一 conditionKey。mapBaseId 与 conditionKey 不要求相等；已有绑定返回空列表或另一 conditionKey 时明确停止，不能据此判断出口无条件。

未匹配精确读取规则且没有明确查询前缀的接口默认暂停审核，由用户判断。generateId、checkoutHeart、save、update、add、delete、enable、publish 等名称仍等待逐条决定；getTargetId 等 get 前缀接口按用户新规则自动放行并观察，不单独例外阻断。

查询名称规则无需逐接口增补；要调整规则本身或新增其他精确放行依据，仍通过受控源码管理、静态校验和部署完成，不在业务执行阶段修改策略或编辑审核记录。

守卫固定 OA origin，不向其他业务服务器发送请求；认证中心只有固定认证路径可以在认证阶段使用。重定向均不自动跟随。官方原生命令之外的 HTTP 模块和子进程被拒绝，遇到相关能力先报告实际兼容性边界，再受控扩展。
