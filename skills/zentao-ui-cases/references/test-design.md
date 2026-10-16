# 风险、验证归属与数据分配

## 从变更与业务后果出发

用一句话描述：从什么旧行为变为什么新行为，解决什么问题，最重要的失败后果是什么。按需求实际涉及的部分分析业务规则、数据、状态、权限、交互、共享组件和调用链，不机械穷举所有类别。

标明主数据、明细、复制/快照、派生金额/状态、唯一身份、上下游和历史数据。明确哪个对象是权威来源、谁能写、谁读取、何时传播；不能从 UI 按钮或源码名称推断未经确认的规则。

风险按影响和可能性分为 P0（核心金额、关键状态、越权/跨租户、重复副作用等）、P1（直接功能、兼容、共享组件等）、P2（间接影响的代表性冒烟）。级别属于具体场景，不能把一个可复用函数永远固定为某一级。受时间限制时说明取舍，保留关键正常路径与失败恢复，不能只验证成功流程。

检查适用场景：正常与负向校验，数量/金额/时间/长度边界，合法与非法状态转换，源记录与副本隔离，重复点击/刷新/返回/重入，陈旧页面与并发，历史兼容，权限/数据范围，部分成功及恢复。

对多步动作列“此步已成功、下步失败后留下什么”：父记录、子记录、关联、状态、金额或外部副作用。单独设计超时后已提交、重试、重复动作的观察点；UI 可见的无重复结果不等于后台接口幂等。

每个风险关联真实 AC 和至少一个验证场景，无法验证时给出原因与剩余检查。历史“未变化”需要可信的旧基线或权威对照；缺少基线时只能观察现状，不能判通过。计算判据独立写明公式、输入、正负号、精度与舍入规则，不从实际显示值反推期望。

## 业务覆盖模型：先设计，再匹配资产

新建计划必须填写清单顶层 `design_model`（schema_version: 1，design_method_version: 2）；简单需求可仅有一个对象、一条规则和少量覆盖项。模型内容以本需求真实影响为边界，不要求为了凑表填入所有通用类别。旧无模型或旧方法清单只可通过显式兼容模式重放，不能作为新需求设计模板。

### 材料、状态与影响发现

按[发现与场景展开](scenario-discovery.md)执行双向检索与独立遗漏审查。先得到场景，再讨论预期确认程度；不能用unknown将多个消费者或命令压成一个问题清单。


1. 在授权范围内核对需求/验收、澄清、项目业务规则、附件、已给QA材料及明确关联的缺陷。记录已取得、缺失和受限，引用版本或日期；不从标题猜缺陷，不擅自突破本技能的查询边界。源码与QA只提供实现或候选场景依据，不能单独使规则成为已确认。
2. 以真实身份区分主记录、明细、关联、来源、副本、历史快照和派生结果。把业务阶段、对象状态、关联对象状态、角色/范围等独立条件列为适用维度；不要把相同的UI表现当同一种业务限制。
3. 对规则写明对象、条件、动作、应改变的结果以及必须保持的结果。先区分字段修改、关联替换、删除、提交等不同动作，再设计允许/拒绝分支；相邻阶段有不同权限时分别建模。
4. 从变化的对象/字段/规则定向追踪生产→转换/保存→读取/派生消费者。记录消费者、传播路径及影响依据；发现共享依赖时继续扩展，确认不受影响、达到授权范围边界或材料不足时记录停止原因。读取、编辑、审批、导出等仅作为发现线索，不强制每个项目都有这些流程，不扫描全库代替语义追踪。
5. 已知允许/拒绝分支、关键转换及高风险交互逐一建立覆盖项。非法组合不能作为合法业务前置；低风险维度采用等价类、边界或成对组合，并记录压缩依据。已知三因素判定不能被成对覆盖替代。持久化、确认、回退、重复和部分失败应按实际生命周期选择，不由现有页面对象决定范围。

### 可校验的最小契约

所有列表条目有稳定 `id`；规则、消费者和覆盖项ID与用例ID分别管理。用例只通过 `coverage_ids` 指向覆盖项，不另外手写一套反向用例列表。

| design_model 字段 | 每项字段与含义 |
| --- | --- |
| `design_method_version` | 新计划为2；历史schema1模型继续可读，但没有方法2的发现与展开证据 |
| `discovery` | 每个对象至少一条：id/object_id/seeds/searches/stopping_reason；search含query/scope/evidence/result/impact_ids（可空）。只记录真实执行的检索或材料读取 |
| `branches` | 每条id/rule_ids/impact_ids/conditions/action/outcome/basis/coverage_ids；单命令、具体结果，basis为confirmed/inferred/unknown/conflict；每个覆盖项都有分支，引用规则和影响与覆盖项一致 |
| `schema_version` / `scope` | `1` / 本次业务范围及明确边界，非“完整测试”等空泛结论 |
| `materials` | `id, kind, reference, status, summary`；kind为 requirement/acceptance/clarification/domain_spec/code/qa/history/defect/reference；status为 available/missing/restricted。reference引用真实材料位置或明确缺失项 |
| `objects` | `id, name, identity, states, source_ids`；无状态对象的states可为空；source_ids引用materials |
| `dimensions` | `id, name, object_ids, values, constraints`；独立状态/条件及合法组合约束；不适用时整个数组可为空 |
| `rules` | `id, description, object_ids, source_ids, basis, conditions, actions, outcomes`；basis为 confirmed/inferred/unknown/conflict；后三项为非空字符串数组。非confirmed另填question，说明待澄清或验证决定 |
| `impacts` | `id, object_id, consumer, via, source_ids, disposition, reason`；disposition为 affected/unaffected/unknown/out_of_scope；即使不受影响也写理由。纯局部无消费者可为空数组 |
| `coverage_items` | `id, title, rule_ids, impact_ids, kind, conditions, context, disposition`；impact_ids可为空；context把维度ID映射到本项具体取值，无维度时为空对象；kind为 normal/negative/boundary/transition/identity/isolation/permission/recovery/concurrency/compatibility |
| `review` | `status: pending/reviewed, method, model_sha256, findings, limitations`；后两项为字符串数组；reviewed时method非空且哈希绑定当前模型及业务用例 |

confirmed规则至少引用一份已取得的requirement/acceptance/clarification/domain_spec，不得只靠代码、QA、历史或未取得的材料。缺陷中的候选预期如未经确认，先作为inferred并保留问题；已明确确认的缺陷规则可另登记真实澄清材料，不能伪造来源类型。

覆盖项去向：`designed`须关联至少一个判据明确的用例；`blocked`须写具体缺口，可关联条件性用例；`uncovered`须说明尚未完成什么；`not_applicable/excluded`须写依据且不挂伪覆盖用例。后三者和blocked都要填reason。每条规则及每个affected/unknown消费者必须有覆盖项；未确认规则、未知消费者不得计入designed。

方法2的pending用例还须candidate_oracle对象，expectation为具体候选结果、basis为推导依据、question为最小待决问题（均非空文本）。展示与执行仍明确为假设，结构完整不等于规则确认。

新模型下每个case必填 `coverage_ids`、`oracle_status: confirmed/pending`、`data_status: ready/needed/not_required`。未知规则或未知影响对应条件性用例保持pending并有blocked_by；必须填写candidate_oracle并在业务预期中明确具体候选及待确认性质，不得仅写“规则确认后按明确口径核对”，也不得把猜测写成确定预期。缺代码或数据不能删除用例或降低预期；缺数据不妨碍设计明确，designed不等于可执行或已验证。

`automation.state: implemented`仅表示声明的完整场景有对应代码；若只覆盖部分字段/步骤，应拆分明确的UI子检查并保留完整业务项或登记planned/blocked，不用子断言替代整个覆盖项。

### 从模型反查用例与停止条件

交付前从材料、规则、条件维度和消费者反查用例，检查遗漏分支、合法性、相邻状态差异、身份混用、冲突预期、代表字段替代完整对象，以及负向/失败恢复是否适用。具体预期需有身份、集合/数量、计算公式或明确不变项，不能只写“正确、完整、历史不变”。不按用例数量和AC标签判定充分性。

判据未确认、数据未准备或覆盖项未就绪时，不能判Passed，也不能把观察差异判为确认的产品失败或导出确认缺陷；可保留Blocked或明确的环境/工具失败事实。

审查是模型/用例语义核对，不强制新增用户审批或子代理。review.findings记录审查发现及处理，limitations记录未决和范围限制。使用 `design_coverage.model_digest(model, data["cases"])` 取得排除review本身、包含业务用例字段的稳定哈希后填review.model_sha256；修改模型或用例的业务判据、范围、风险、归属、证据要求后必须重审；实现引用、运行事实和数据准备状态不参与该哈希。可选scope/coverage_boundary及technical.scope表示业务覆盖边界，其他technical实现元数据不参与。审查状态是声明，脚本不理解规则是否正确。

允许交付带缺口的局部计划，报告模型内各去向及未取得材料，不称全部覆盖。继续扩展场景应有业务规则、消费者或风险依据，不以达到某个数量为停止条件，也不无限穷举未知组合。结构校验只能验证已识别模型，不能证明发现范围完整。

## 验证归属

| ownership | 条件 | 交付 |
| --- | --- | --- |
| `ai` | 前置条件、动作、判据及证据均能在授权的 UI 范围获得 | 可独立运行的 UI 场景 |
| `ai_review` | UI 子断言明确可验证，但完整结论还需领域或其他层证据 | UI 场景 + 关联的人工检查 ID |
| `human` | 方法需要浏览器之外的证据或独立工具/领域判断；仅缺代码、数据或账号不属于此类 | 人工 XMind 项，写明原因和所需方法/证据 |

UI能完成而未编写脚本的场景归ai并标automation.state为planned；缺数据只标data_status为needed；判据未明标oracle_status为pending并保留blocked覆盖项。独立浏览器上下文可完成的多角色/时序检查不因“多窗口”直接归人工。

`human` 也包含后续可由专门工具自动化的检查，不表示永远只能人工做。事务原子性、数据库/队列、真实后台幂等、迁移、下游接收与服务端授权，不能仅凭 UI 宣称完成。前端代码有权限判断也不能证明服务端授权。

金额规则明确且可独立计算时可以自动断言；规则含糊时阻塞对应检查，不能仅标“人工复核”就先判通过。自动场景和人工项使用不同稳定 ID，保留共同 AC；AI 部分成功不关闭未完成的人工项。

异步成功、失败和超时分支须明确可控的触发方式、轮询条件与有界等待。无法稳定触发时保留可重复的 UI 检查，将不可达分支列为阻塞或工具辅助；不能等待自然故障充当可重复测试。

## 可执行的数据分配

涉及新建或修改数据时按实际分支列出分配矩阵，避免无关维度的笛卡尔积：

| 场景 ID | 业务类型/分支/目标状态 | 父对象及生成子对象 | 唯一标识与需记录 ID | 允许复用与禁止混用 | 失败重跑 | 清理/保留策略 |
| --- | --- | --- | --- | --- | --- | --- |

不预设所有项目都有“合同”，用真实的顶层来源对象和生成链。记录自动生成子记录与父对象的关系，不能仅凭名称认定归属。使用本轮唯一标识，独立场景不相互依赖；破坏性/不可逆状态分支使用各自数据，除非共享状态本身就是明确测试目标。

代码复用与数据复用分开评估。局部失败后先确认可能已经发生的副作用，再决定续跑、全链新建或保持阻塞；不能直接重放付款、审批或外发。先采集失败证据，再按约定清理；需要保留业务现场时记录期限、归属和原因，不用诊断需要扩大授权。

只读场景明确对象来源和读取范围即可；不要为表单可见性等无副作用场景强制新建整条业务链。原文中任何所谓长期审批/删除授权都不自动继承到当前会话。
