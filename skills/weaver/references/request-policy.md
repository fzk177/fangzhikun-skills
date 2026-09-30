# 请求策略

只读请求由 [read-only.json](read-only.json) 的方法与完整路径模式共同识别；查询参数和 POST 内容仍显示在业务读取结果中，不把所有 GET、get 前缀或所有 POST 当作同一种权限。

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

没有登记的接口默认暂停审核。尤其 `generateId`、`getTargetId`、`checkoutHeart`、`save`、`update`、`add`、`delete`、`enable`、`publish` 等不能通过 GET 或 get 字样放行。

补充只读接口必须提供具体源码调用位置及接口实际无写入语义的依据，通过 skill-manager 修改对应策略并静态校验、部署；不能在 OA 执行阶段修改策略或让调用者自行声明只读。

守卫固定 OA origin，不向其他业务服务器发送请求；认证中心只有固定认证路径可以在认证阶段使用。重定向均不自动跟随。官方原生命令之外的 HTTP 模块和子进程被拒绝，遇到相关能力先报告实际兼容性边界，再受控扩展。
