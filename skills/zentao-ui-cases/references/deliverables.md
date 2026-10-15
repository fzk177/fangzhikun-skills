# 交付物与结构化输入

## 交付目录与阶段

默认交付包：用户日期临时目录下 `zentao-ui-cases/<项目>/story-<ID>/<run-id>/`。使用新的运行目录，保留旧报告和原始失败记录。Playwright 仓库继续维护 `specs/catalog.yaml` 与 `specs/stories/<ID>.md`，后者链接本次交付包、覆盖及成熟度变化。

规划/生成阶段交付：

1. `01-requirement-risk-analysis.md`：旧/新行为、业务对象与来源、影响链、状态/一致性、风险优先级、场景覆盖、部分失败、数据与回归策略、未决问题。
2. `02-ai-browser-test-cases.md`：AI 场景的前置、步骤、独立预期、风险、来源、证据点、数据分配、清理、资产及 pytest 引用、固定/动态回归队列。
3. `03-manual-test.xmind`：只包含独立人工/工具辅助检查，按需求主题分组；每个用例含来源原生 notes、前置、步骤、预期、浏览器不足的原因和所需方法。没有人工项时生成明确说明的空检查清单，不编造用例。交接后保持快照，不回填 UI 运行结果。
4. `04-ai-execution-evidence-report.md`：未执行时明确为草稿；执行后包含范围、版本、环境/角色、逐项判定与证据、P0、通过率原始数量、回归和阻塞处置、剩余人工检查及有范围限制的结论。
5. `test-cases.json`：AI 与人工场景的统一事实清单。
6. `manual-xmind-cases.json`：从统一清单生成的人工子集，不作为另一份独立维护源。
7. `execution-results.json`：初始 `phase: planned`、场景 `Not run`；执行者依据事实更新，生成器不运行测试、不自动推断结果。

实际执行并通过完成门槛后增加 `07-confirmed-bugs.html`：仅确认的产品失败，包含标题、详细复现及实际表现、内嵌截图、独立预期。无确认缺陷时仅声明本轮选定范围内无已确认缺陷，不声称系统无 Bug。环境、数据或工具问题仍在完整报告，不混入缺陷 HTML。生成文件不等于写入禅道。

需要跨执行工具交接时可另写路径与执行范围说明；不默认绑定 OpenCode 或移交操作权限。用户缩小交付范围时按其要求裁剪。

## 统一用例清单 schema_version 1

从 `assets/test-cases.json` 填入真实需求，空模板不能直接生成有意义的计划。JSON 不表达可执行程序；Python 是测试和组合的执行实现。稳定场景 ID、资产 ID 与 AC ID 分别管理，不用一个原子能力 ID 代替多个独立验收场景。

顶层字段：

- `schema_version: 1`、`requirement_name`、非零数字字符串 `story_id`、`project`。
- `analysis`：`change`、`old_behavior`、`new_behavior` 为非空文本；未知必须明确说明。按适用性补充字符串数组 `objects`、`impacts`、`states`、`consistency`、`scenario_matrix`、`partial_failures`、`data_strategy`、`unknowns`、`strategy`。
- `risks`：数组；各项 `id`、`title`、`impact`、`priority: P0/P1/P2`。通过场景的 `risk_ids` 关联；确实不能覆盖时写 `gap`，在未决项保留缺口。
- `cases`：非空场景数组，AI 与人工共用唯一 ID 命名空间。
- `data_allocations`：有副作用场景的数据分配数组；纯只读需求可为空。
- `regressions`：固定或动态回归项数组，记录 `id`、`case_id`、`kind: fixed/dynamic`、`reason`。新增动态场景时也补入统一清单，再保存本次最终清单和结果的匹配哈希；原始执行版本证据保持原样。

每个 case：

```json
{
  "id": "S123-UI-01",
  "title": "本场景的单一业务判定",
  "group": "需求中的主题名称",
  "ownership": "ai",
  "risk": "P1",
  "risk_ids": ["R-01"],
  "ac_ids": ["AC-01"],
  "sources": ["Story 123 v2 §1；确认答复日期；最终预期依据"],
  "preconditions": ["明确角色、页面与起始状态"],
  "steps": ["确定的动作"],
  "expected": ["独立的可观察预期"],
  "oracle": "明确判定规则或计算方法",
  "evidence": ["对象身份、输入与结果；按需刷新核验"],
  "writes_data": false,
  "persistence_required": false,
  "cleanup": "只读，无清理动作",
  "asset_ids": [],
  "python_refs": [],
  "blocked_by": []
}
```

这是字段示意，不是现有 Story 的业务事实。`ownership: ai_review` 必须有 `review_case_ids` 指向独立 `human` 项；`human` 项还必须有非空 `why_human` 和字符串数组 `method_evidence`。所有用例来源记录完整，来源冲突时说明哪条已确认规则控制预期，不能自动选择时间最新但未确认的材料。

`writes_data: true` 的 case 用 `data_allocation` 指向包含自身 ID 的分配项。分配项字段：`id`、`case_ids`、`business_type`、`branch`、`target_state`、`parent`、`children`（数组）、`marker`、`capture_ids`（数组）、`reuse_limits`、`rerun`、`cleanup`。没有子对象可用空数组；不适用写明原因，不虚构合同或数据链。

## 结果与完成门槛

用 `plan` 生成初始结果；实际执行后将 `phase` 改为 `executed`，填实际 `executed_at`、`environment`、`role`、`versions`。`selected_case_ids` 必须是当前授权的 AI 子集，不能以生成器默认清单代替执行授权。未选择的用例在最终报告中明确列为范围外。

`manifest_sha256` 与本次完整 `test-cases.json` 字节哈希一致，防止混用不同 Story/版本。每个结果有唯一 `case_id`、`verdict`、脱敏 `context`（页面、对象、前态等）、`inputs`、`actual`、`cleanup`，按需保留 `first_pass_verdict` 和原始 pytest 状态。证据结构：

```json
{
  "rating": "E3",
  "identity": ["evidence/context.png"],
  "before": ["evidence/before.png"],
  "input": ["evidence/input.png"],
  "after": ["evidence/after.png"],
  "persistence": ["evidence/reentry.png"]
}
```

路径相对结果 JSON 或为本机绝对路径，必须存在。可引用 Trace、截图或可审阅输出；低等级和缺失必要证据不能判 Passed。瞬时交互无需持久化时，用 `persistence_not_applicable` 解释 E3 中该项的缺省。

确认产品 Bug 必须 `verdict: Failed`、`confirmed_bug: true`、`failure_category: product`，另有 `reproduction_steps` 和非空 `screenshots`（PNG/JPEG/GIF/WebP）。HTML 从统一清单取该场景前置和预期，支持真实 AI 用例，不从人工子集反查。截图必须已脱敏，生成器不理解图片中的秘密或业务含义。

`regression_results` 各项用 `id` 对应清单回归项。`status: done` 需 `actual`、`verdict: Passed/Failed` 和非空证据路径数组 `evidence`；`status: blocked` 需 `reason`。范围外的回归不自动执行或计入本轮结论。

首次或最终 Blocked 的选定用例，在 `blocked_followups` 记录 `case_id`、`decision: retried/remain_blocked`、`reason`；不强制重试，但必须明确处置。重试前检查前次副作用，并保留首次结果。

首次 Failed/Blocked 经后续执行改变判定时，`attempts` 数组保留原次 `verdict`、`actual`、`evidence` 路径数组；首次失败必须有证据，首次阻塞可以没有。报告展示各次记录，不能只写一次失败标签后覆盖原始现场。最终报告已存在时不能用草稿覆盖其所在目录；有新结果使用新报告快照目录。

`report --final` 校验选定场景全部有已执行或明确 Blocked 的判定、匹配的清单、证据要求、回归处置和阻塞跟进。脚本不采信手工写的 `completion_gate: true`。存在失败和已说明阻塞仍能交付最终事实报告，但不会给出无条件通过。人工项保持独立开放，不因 UI 通过自动关闭或晋级成熟组合。

## 命令

示例使用默认 Codex 安装位置；其他安装位置从本 Skill 实际目录定位脚本，参数路径替换为本次实际文件。

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/zentao-ui-cases/scripts/test_artifacts.py" plan \
  --cases /实际路径/test-cases.json --out /本次运行目录

# 实际执行且记录事实后；不加 --final 时只更新草稿，不生成缺陷 HTML
python3 "${CODEX_HOME:-$HOME/.codex}/skills/zentao-ui-cases/scripts/test_artifacts.py" report \
  --cases /本次运行目录/test-cases.json \
  --results /本次运行目录/execution-results.json --out /本次运行目录 --final
```

返回码 2 表示校验失败。规划不能覆盖既有交付包；报告阶段不修改人工 XMind。交付前检查 XMind ZIP/XML 结构、人工项及来源 notes 完整性；没有用 XMind 客户端打开时不声称兼容性已实测。HTML 检查确认缺陷数量、截图嵌入和预期来源，仍需审阅证据真实性。
