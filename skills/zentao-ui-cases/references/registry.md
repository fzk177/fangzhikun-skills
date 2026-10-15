# 资产与证据契约

## 文件位置和事实来源

登记位于 `projects/<项目>/specs/catalog.yaml`，需求映射位于 `specs/stories/<Story ID>.md`。两者随自动化代码维护，运行产物在用户的临时目录。不要把原始禅道响应、客户数据或认证状态复制进规格。

`catalog.yaml` 是索引，Python 代码是执行事实。记录真实代码引用和契约，不创建动态执行 YAML 的框架。脚本扫描结果和手工登记互补：发现未登记代码时阅读并按需补录，找不到登记不等于没有代码。

首次复制 `assets/catalog.yaml` 后将 `project` 设为项目目录名；`assets` 初始为空，不为凑示例创建业务能力。

## 每项资产的数据

```yaml
id: vesselhub.case.create-draft
kind: case
title: 创建草稿
code:
  path: projects/vesselhub/cases/drafts.py
  symbol: create_draft
  sha256: 当前文件的实际SHA256
contract:
  inputs: {data: 草稿数据}
  outputs: {draft_id: 新建草稿的业务ID}
  preconditions: [已处于正确租户并获得创建权限]
  postconditions: [目标草稿存在且返回其ID]
  cleanup: [使用返回的ID删除本次创建的数据]
scope:
  roles: [editor]
  environments: [test]
story_ids: ["123"]
uses: []
tests: [projects/vesselhub/tests/test_drafts.py::test_create_draft]
status: candidate
verification: []
maturity_approval: null
notes: []
```

上面的路径、角色和 Story 均是示例，不能直接登记成真实资产。字段含义：

- `schema_version: 1`、`project`、`assets` 是顶层字段；扩展已有格式时先兼容已有记录。
- `id` 稳定且项目内唯一，建议 `<项目>.case.<业务名>` 或 `<项目>.flow.<业务名>`。ID 不绑定 Story、文件名或行号；移动代码只更新 `code`。同一动作可关联多个 Story。
- `code.path` 相对自动化仓库，必须存在且留在该仓库内；`symbol` 为 AST 可定位的限定名称，如 `DraftCases.create`。`sha256` 为文件内容哈希；运行证据中的旧哈希不能随代码更新而覆盖。
- `kind` 为 `case` 或 `flow`。`uses` 是流程依赖的资产 ID 有序列表，可包含重复调用及其他流程，但不能形成递归环；不能引用其他项目而不声明适配契约。原子能力通常直接用页面对象，`uses` 为空。
- `contract` 记录业务输入输出和前置、后置、清理条件；不适用的项写空集合并解释，不编造。
- `scope` 描述实际适用的角色、租户或环境限制；未知时说明未知，不能把 `test` 推广成所有环境。
- `tests` 引用真实 pytest 路径及函数/类方法；参数化 node ID 已执行时可进一步记录具体参数。一个测试可验证多个相关资产。
- `status` 为 `candidate`、`verified`、`mature`、`needs_review` 或 `deprecated`。
- `verification` 和 `maturity_approval` 的证据结构见验证协议；`notes` 保留人工备注、限制和降级理由。

页对象、fixtures 和现有独立测试可先留在扫描索引，不要求全部包装成 `case`。只有被当前需求复用或新建且值得复用的业务能力才登记；避免维护一个复制所有函数的第二份源码目录。

## Story 覆盖记录

使用 `assets/story.md` 的结构，记录：

1. 查询时间、Story 版本/更新时间和安全来源链接；无法获取的历史或材料。
2. 前端与自动化仓库的实际分支、提交、工作区状态及相关文件哈希。避免只写“最新版本”。
3. AC 的稳定编号、业务预期、规则来源、源码证据、角色/数据和测试引用。
4. 每个验收点的复用选择及理由；需求/实现冲突、运行时待核验项。
5. 真实执行结果及证据位置；覆盖状态是 `generated`、`verified`、`blocked` 或 `not_applicable`，后者必须有理由。
6. 风险、验证归属、数据分配和人工/工具辅助子检查；同一 AC 可包含多个不同证据边界的子场景。
7. 本次交付包、统一用例清单与执行报告的链接、运行 ID 和范围；格式见 [交付物协议](deliverables.md)。

需求对应测试存在或静态检查通过，只能记 `generated`。只有相关验收点在已声明范围内实际通过才记 `verified`；通过登录步骤不能证明整个 Story 已覆盖。

浏览器不足以证明的部分不是业务“不适用”。分别记录 UI 子断言与尚未完成的人工检查，不能为提高自动化覆盖而标记整条 AC 已完成。风险级别与判定归属放在场景和 Story 记录，不固化到跨场景复用的原子能力上。既有 catalog schema_version 1 和历史 Story 格式兼容保留。

重处理时按 Story 版本差异更新受影响的 AC、资产和测试。保留人工说明、稳定编号与历史证据；同一来源重复运行不追加重复条目。覆盖、跳过和未执行分别统计，不以脚本数量代表覆盖率。

## 引用及失效检查

每次生成前和结束前至少检查当前关联资产：ID 唯一，代码路径/符号/测试引用存在，依赖 ID 可解析且无环，契约与实际实现一致。

比较相关源码哈希、Story 规则、角色/环境与部署版本。原子能力、相关页面/fixture 或前端行为变化后，重新评估所有受影响的上层组合和覆盖结论。登记 `needs_review` 及原因，保留旧状态的证据；无关文档变化无需让所有资产失效。

静态检索脚本提供引用和哈希线索，不验证整个 YAML 契约或证明业务语义等价；这部分需读取真实代码与证据。不得从静态扫描成功推导成熟度。
