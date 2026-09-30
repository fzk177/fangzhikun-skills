# 配置与实现

## 前提

- macOS、Python 3、Node.js 18 或以上。
- 已安装官方 `weaver-e10-builder`；首版按 1.1.9 的导出模块实现，也允许兼容的后续 1.x，但升级后需重新静态校验和实际只读核对。
- 官方 Skill `weaver-e10-builder` 已安装，动作流依赖按其声明按需读取。

`node scripts/weaver.js info` 只检查非秘密配置与 CLI 依赖，不读取钥匙串、不登录。

本机配置、钥匙串首次录入、Git 提交、推送和本机部署需要按 skill-manager 契约分别预览确认。首次账号密码只能由用户在本机隐藏输入；运行管理任务的 AI 不读取凭证。

## 模块

- [common.js](../scripts/common.js)：环境解析、CLI 定位、只读策略加载、状态路径与脱敏。
- 私有运行记录通过本模块保存的原始文件描述符函数写入，避免被官方业务文件护栏误拦；该内部写入路径不作为业务命令的豁免入口。
- [authentication.js](../scripts/authentication.js)：原生钥匙串、内存会话、官方 RSA 登录和身份校验。
- [guard.js](../scripts/guard.js)：查询名称放行、已有读取规则、观察记录、实际请求冻结及逐请求审批，禁止其他网络与子进程绕过。
- [weaver.js](../scripts/weaver.js)：只读信息、认证、受控 CLI、查看审核单及逐项放行。
- [workflow-read.js](../scripts/workflow-read.js)：独立节点审批人明细与已有出口条件查询，复用官方 ApiClient 及原守卫，不调用保存、删除或生成 ID 接口。
- [enroll.py](../scripts/enroll.py)：用户本机隐藏录入，凭证通过 stdin 交给钥匙串。

## 使用

```bash
node scripts/weaver.js info
python3 scripts/enroll.py --env pre
python3 scripts/enroll.py --env prod
node scripts/weaver.js auth --env pre
node scripts/weaver.js run --env pre -- workflow search --name 采购
node scripts/weaver.js run --env prod -- workflow operators <流程ID> [节点ID]
node scripts/weaver.js run --env prod -- workflow conditions-read <流程ID> [--link-id <出口ID>]
```

审批人命令支持整个流程或指定节点，输出节点设置、操作者组与组内条目；人员 ID、签署顺序、批次、条件及动态人员来源以实际返回字段为准，不按组名推断实际收件人。请求失败、响应格式不兼容或缺少关键数组时明确停止，不返回伪造空结果。

条件命令仅查询服务端出口列表中已有条件绑定，回读同一 conditionKey 后读取完整条件列表；mapBaseId 与 conditionKey 是不同字段，不强制它们相等。命令处理分页与重复页，不把已有条件的空响应解释为无条件。

`getConditionSet`、`getLayoutConfigInfo` 保留观察记录；未匹配精确读取规则、但名称以 get/query/search/list/read/find/fetch 开头的请求也直接放行并观察。每次结果写入原有权限受限的任务目录，文件名为 `<observationId>.observation.json`，标准输出包含 `readonly_observation` 事件及 `allowReason`。名称规则的放行理由为 `query-name`，不表示已证实只读；记录环境、接口、脱敏参数、返回 ID、业务状态和响应哈希，不保存完整业务响应。

非自动放行请求不强制提供 `--purpose` 与 `--impact`；没有预填时自动展示命令、实际接口和参数、待用户判断的影响，保持暂停等待本条决定。仍可通过这两个参数补充说明。未登录时不会要求复制 Cookie；缺少钥匙串凭证时提示先完成本机录入。

## 验证与交付

只通过仓库 `tools/skillctl validate weaver` 和 `validate --all` 执行结构、引用、JSON、脚本语法及公开安全检查。不得擅自新增或运行测试。正式启用之前仍需在用户授权后分别核对测试／生产的自动登录、读取权限和钥匙串弹窗情况；验证读取不得包含 OA 写操作。

此次新建不修改现有官方 Skill、CLI、官方全局 profile 或既有会话文件。变更仅涉及自研源码、必要登记和受控 Obsidian 文档同步。
