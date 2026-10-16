# 历史经验操作

仅在排查使用本地历史经验时读取。本机工具为 `~/.codex/obsidian-sync/bin/vesselhub_experience.py`；本文件不授予生产写入权限。安全投影、案例写入及证据详情以本机 Obsidian 库中的 `03.AI/00.AI读取区/05.生产经验协议.md` 为准，库路径从运行配置 `paths.vault` 读取。

## 选择入口

| 当前信息 | 操作 |
|---|---|
| 环境未明确 | 整理材料，补齐环境后再检索 |
| 环境明确，实例尚不明确 | 带事件ID的 `search`；不生成真实实例或收益 |
| 环境与实例明确，问题已同步 | `register-problem` 后直接 `lookup`；省去重复 `search` |
| 已有当次 `search` 事件 | 登记实例后，在 `lookup` 输入中指定 `retrieval_id`，绑定原结果 |
| 续接同一事故 | 沿用 `problem_key`；相同输入重试沿用ID；新查询使用新ID |
| 历史回放／Skill维护 | 回放使用 `historical_replay`；维护不登记real问题 |

## 实例未明确时记录检索

从当前会话实际读取 session ID，不猜会话或问题身份。查询使用最小脱敏线索；程序脱敏不代替人工检查。

```bash
python3 ~/.codex/obsidian-sync/bin/vesselhub_experience.py search \
  --env '<已确认环境>' --query '<业务入口、阶段、症状和已知字段>' \
  --session-id '<当前session ID>' --retrieval-id 'VH-RET-<本次稳定ID>'
```

默认事件模式为 `investigation`；历史检索显式加 `--mode historical_replay`。同一ID相同输入返回原快照；新查询必须另建ID。事件保存脱敏查询、环境、会话、时间、语料／索引校验值和结果，不代表实例已确认。纯只读审阅或离线对比可省略两个ID参数，程序不登记事件。

## 明确实例后的输入

仅对已核实的环境、实例和业务过程求本机SHA256作为 `problem_key`。续接复用该值，不把“症状相同”作为实例相同的依据。当前用户问题必须先进入安全投影；必要时只同步当前session。JSON材料按用户指定临时目录保存，只含脱敏内容。

以下字段中的占位值必须替换为已核实值：

```json
{
  "mode": "real",
  "problem_key": "<64位实例SHA256>",
  "environment": "prod",
  "request_evidence": {
    "id": "U1",
    "kind": "message",
    "session_id": "<当前session ID>",
    "message_id": "<本次实际用户消息ID>",
    "quote": "<实际命中的最小脱敏问题引文>",
    "summary": "本次用户问题"
  }
}
```

先保存上述输入并运行 `register-problem --file <本机JSON>`，使应检索问题在检索前进入统计分母。实例不明或材料未同步时，不猜字段或强行登记。

在同一输入上增加 `usage_id`（`VH-USE-`开头）、`query` 后，运行 `lookup --file <本机JSON>`。如果已有对应事件，再增加 `retrieval_id`；查询、环境与事件模式须一致，程序绑定当时快照，不重新搜索。直接lookup会自动创建事件。

real只接受近24小时的实际用户问题；历史材料使用 `historical_replay`，不会计入真实问题。旧usage相同输入重试只返回原观察；新问题不得复用旧事件或usage ID。

## 阅读候选和补检

- `candidates`：精确字段／机制或结构化入口与阶段线索命中的候选，仍须当前证据验证。
- `similar_symptoms`：只有症状相似，不能用作机制命中或填满候选列表；没有强候选时也会保留这些提示。
- `related_records`：同一案例族的支撑页面，不重复占Top3；`family_case_ids`只是阅读聚合，不合并实例证据。
- `review_status=source_updates`：来源会话有新增或变化，但所引证据未发现变化；阅读相关新增内容，不自动推翻旧历史判断。
- `review_status=evidence_review_required`：引用或来源不可用／变化，优先核验；已被替代条目始终排除。
- `status=unavailable`：索引不可用，不能记作知识覆盖缺失。

取得新的可辨别字段或入口后可补检一次，另建检索ID及观察；原始快照不改写。相同症状反复换泛词不能作为补检理由。

## 有依据后评价

调用 `assess-usage --file <本机JSON>`，传入 `usage_id`、`outcome`、`assessment`、`evidence`、`corrections`、`maintenance_minutes`。证据结构沿用协议，必须命中实际来源；成本未测量用 `null`。

贡献类别为 `帮助定位 / 帮助排除 / 没有帮助 / 误导 / 条件不适用`；未取得评价依据保留 `待评估`。可选 `gap_reason` 为 `coverage_gap / query_mismatch / environment_gap / tool_unavailable / instance_unknown`，由实际证据判断，不把一次空结果自动归为覆盖不足。

`stats` 只读返回登记覆盖、候选召回、评价完成、实际贡献、待评价和成本测量数量。覆盖率只针对新登记的明确问题，遗漏登记未知；旧观察沿用旧排序口径。独立回放须使用当时冻结索引并隔离该问题及续接产生的案例族；当前问题入库后再重查只能检查可检索性，不能计作真实收益。
