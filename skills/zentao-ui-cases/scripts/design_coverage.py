"""Validate a declared business model and render its coverage; not a completeness oracle."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import hashlib
import html
import json
from collections import Counter

DISPOSITIONS = {
    "designed": "已设计",
    "blocked": "待澄清/阻塞",
    "uncovered": "尚未设计",
    "not_applicable": "不适用",
    "excluded": "明确排除",
}
KINDS = {
    "normal",
    "negative",
    "boundary",
    "transition",
    "identity",
    "isolation",
    "permission",
    "recovery",
    "concurrency",
    "compatibility",
}


def require(condition, message):
    if not condition:
        raise ValueError("design: " + message)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def strings(value, nonempty=True):
    return isinstance(value, list) and (bool(value) or not nonempty) and all(text(v) for v in value)


def entries(value, label, nonempty=False):
    require(isinstance(value, list) and (value or not nonempty), label + " must be an array")
    result = {}
    for item in value:
        require(isinstance(item, dict) and text(item.get("id")), label + " needs stable IDs")
        require(item["id"] not in result, "duplicate " + label + ": " + item["id"])
        result[item["id"]] = item
    return result


def refs(item, key, targets, nonempty=True):
    values = item.get(key, [])
    require(strings(values, nonempty), item["id"] + "." + key + " is invalid")
    require(
        len(values) == len(set(values)) and set(values) <= targets.keys(),
        item["id"] + "." + key + " has unknown/duplicate IDs",
    )
    return values


def model_digest(model, cases=()):
    """Bind review to the model and business cases, excluding implementation/run metadata."""
    body = {
        "model": {k: v for k, v in model.items() if k != "review"},
        "cases": [
            {
                k: case.get(k)
                for k in (
                    "id",
                    "title",
                    "preconditions",
                    "steps",
                    "expected",
                    "oracle",
                    "coverage_ids",
                    "oracle_status",
                    "sources",
                    "risk",
                    "risk_ids",
                    "ac_ids",
                    "ownership",
                    "review_case_ids",
                    "writes_data",
                    "persistence_required",
                    "cleanup",
                    "scope",
                    "coverage_boundary",
                    "why_human",
                    "method_evidence",
                    "evidence",
                )
            }
            | {
                "technical_scope": case.get("technical", {}).get("scope")
                if isinstance(case.get("technical"), dict)
                else None
            }
            | ({"candidate_oracle": case["candidate_oracle"]} if "candidate_oracle" in case else {})
            for case in cases
        ],
    }
    return hashlib.sha256(
        json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def validate_design(data, required=False):
    model = data.get("design_model")
    if model is None:
        require(
            not required,
            "new plans require design_model; legacy replay needs --allow-legacy-design",
        )
        return {
            "status": "legacy",
            "warnings": ["历史清单未登记结构化覆盖模型；业务覆盖充分性未审查"],
            "counts": {},
            "items": [],
        }
    require(
        isinstance(model, dict) and model.get("schema_version") == 1, "unsupported model schema"
    )
    method = model.get("design_method_version")
    require(method in (None, 1, 2), "unsupported design_method_version")
    require(not required or method == 2, "new plans require design_method_version=2")
    require(text(model.get("scope")), "scope is required")
    materials = entries(model.get("materials"), "materials", True)
    objects = entries(model.get("objects"), "objects", True)
    dimensions = entries(model.get("dimensions"), "dimensions")
    rules = entries(model.get("rules"), "rules", True)
    impacts = entries(model.get("impacts"), "impacts")
    items = entries(model.get("coverage_items"), "coverage_items", True)
    cases = entries(data.get("cases"), "cases", True)
    warnings = []
    for m in materials.values():
        require(
            all(text(m.get(k)) for k in ("kind", "reference", "summary")),
            m["id"] + " needs material facts",
        )
        require(
            m["kind"]
            in {
                "requirement",
                "acceptance",
                "clarification",
                "domain_spec",
                "code",
                "qa",
                "history",
                "defect",
                "reference",
            },
            m["id"] + " invalid material kind",
        )
        require(
            m.get("status") in {"available", "missing", "restricted"},
            m["id"] + " invalid material status",
        )
        if m["status"] != "available":
            warnings.append(m["id"] + "：材料未获取或受限")
    for obj in objects.values():
        require(
            all(text(obj.get(k)) for k in ("name", "identity")), obj["id"] + " needs name/identity"
        )
        require(strings(obj.get("states"), False), obj["id"] + " needs states (empty if stateless)")
        refs(obj, "source_ids", materials)
    for dim in dimensions.values():
        require(
            text(dim.get("name")) and strings(dim.get("values")), dim["id"] + " needs name/values"
        )
        refs(dim, "object_ids", objects)
        require(strings(dim.get("constraints"), False), dim["id"] + " needs constraints")
    for rule in rules.values():
        require(text(rule.get("description")), rule["id"] + " needs description")
        refs(rule, "object_ids", objects)
        source_ids = refs(rule, "source_ids", materials)
        require(
            rule.get("basis") in {"confirmed", "inferred", "unknown", "conflict"},
            rule["id"] + " invalid basis",
        )
        for k in ("conditions", "actions", "outcomes"):
            require(strings(rule.get(k)), rule["id"] + "." + k + " is required")
        if rule["basis"] == "confirmed":
            require(
                any(
                    materials[k]["status"] == "available"
                    and materials[k]["kind"]
                    in {"requirement", "acceptance", "clarification", "domain_spec"}
                    for k in source_ids
                ),
                rule["id"] + " cannot be confirmed solely by code/QA/unavailable material",
            )
        else:
            require(
                text(rule.get("question")), rule["id"] + " needs a question/validation decision"
            )
    for impact in impacts.values():
        require(impact.get("object_id") in objects, impact["id"] + " unknown object")
        require(
            all(text(impact.get(k)) for k in ("consumer", "via", "reason")),
            impact["id"] + " needs impact boundary evidence",
        )
        refs(impact, "source_ids", materials)
        require(
            impact.get("disposition") in {"affected", "unaffected", "unknown", "out_of_scope"},
            impact["id"] + " invalid impact disposition",
        )
    if method == 2:
        discovery = entries(model.get("discovery"), "discovery", True)
        for record in discovery.values():
            require(record.get("object_id") in objects, record["id"] + " unknown object")
            require(strings(record.get("seeds")), record["id"] + " needs discovery seeds")
            require(text(record.get("stopping_reason")), record["id"] + " needs stopping_reason")
            searches = record.get("searches")
            require(isinstance(searches, list) and searches, record["id"] + " needs searches")
            for index, search in enumerate(searches, 1):
                label = record["id"] + ".searches[" + str(index) + "]"
                require(isinstance(search, dict), label + " must be an object")
                require(
                    all(text(search.get(k)) for k in ("query", "scope", "result")),
                    label + " needs query/scope/result",
                )
                require(strings(search.get("evidence")), label + " needs search evidence")
                require("impact_ids" in search, label + " needs impact_ids (empty if none)")
                refs({**search, "id": label}, "impact_ids", impacts, False)
        for key in objects:
            require(
                any(record["object_id"] == key for record in discovery.values()),
                key + " has no discovery record",
            )
    links = {key: [] for key in items}
    for case in cases.values():
        coverage_ids = refs(case, "coverage_ids", items)
        require(
            case.get("oracle_status") in {"confirmed", "pending"},
            case["id"] + " invalid oracle_status",
        )
        require(
            case.get("data_status") in {"ready", "needed", "not_required"},
            case["id"] + " invalid data_status",
        )
        if method == 2 and case["oracle_status"] == "pending":
            candidate = case.get("candidate_oracle")
            require(
                isinstance(candidate, dict)
                and all(text(candidate.get(k)) for k in ("expectation", "basis", "question")),
                case["id"] + " pending case needs candidate_oracle expectation/basis/question",
            )
        for key in coverage_ids:
            links[key].append(case["id"])
    rows = []
    for item in items.values():
        require(text(item.get("title")), item["id"] + " needs title")
        rule_ids = refs(item, "rule_ids", rules)
        refs(item, "impact_ids", impacts, False)
        require(item.get("kind") in KINDS, item["id"] + " invalid kind")
        require(strings(item.get("conditions")), item["id"] + " needs specific conditions")
        context = item.get("context")
        require(
            isinstance(context, dict) and set(context) <= dimensions.keys(),
            item["id"] + " invalid context dimensions",
        )
        require(
            all(
                text(value) and value in dimensions[key]["values"] for key, value in context.items()
            ),
            item["id"] + " context value is not declared in dimension",
        )
        state = item.get("disposition")
        require(state in DISPOSITIONS, item["id"] + " invalid disposition")
        if state == "designed":
            require(links[item["id"]], item["id"] + " designed but no case covers it")
            require(
                all(rules[k]["basis"] == "confirmed" for k in rule_ids),
                item["id"] + " unconfirmed rules cannot count as designed",
            )
            require(
                all(cases[k]["oracle_status"] == "confirmed" for k in links[item["id"]]),
                item["id"] + " designed cases need confirmed oracles",
            )
        else:
            require(text(item.get("reason")), item["id"] + " needs disposition reason")
            if state in {"not_applicable", "excluded", "uncovered"}:
                require(
                    not links[item["id"]], item["id"] + " disposition conflicts with linked cases"
                )
        if any(rules[k]["basis"] != "confirmed" for k in rule_ids):
            require(
                state in {"blocked", "not_applicable", "excluded", "uncovered"},
                item["id"] + " unresolved rule needs a gap",
            )
            require(
                all(
                    cases[k]["oracle_status"] == "pending" and cases[k].get("blocked_by")
                    for k in links[item["id"]]
                ),
                item["id"] + " unresolved oracle must stay blocked",
            )
        if any(impacts[k]["disposition"] == "unknown" for k in item.get("impact_ids", [])):
            require(state != "designed", item["id"] + " unknown consumer cannot count as designed")
            require(
                all(
                    cases[k]["oracle_status"] == "pending" and cases[k].get("blocked_by")
                    for k in links[item["id"]]
                ),
                item["id"] + " unknown consumer needs pending oracle",
            )
        rows.append({**item, "case_ids": links[item["id"]]})
    branch_counts = {}
    if method == 2:
        branches = entries(model.get("branches"), "branches", True)
        branch_links = set()
        for branch in branches.values():
            rule_ids = refs(branch, "rule_ids", rules)
            require("impact_ids" in branch, branch["id"] + " needs impact_ids (empty if none)")
            impact_ids = refs(branch, "impact_ids", impacts, False)
            coverage_ids = refs(branch, "coverage_ids", items)
            require(strings(branch.get("conditions")), branch["id"] + " needs conditions")
            require(
                text(branch.get("action")) and text(branch.get("outcome")),
                branch["id"] + " needs action/outcome",
            )
            require(
                branch.get("basis") in {"confirmed", "inferred", "unknown", "conflict"},
                branch["id"] + " invalid basis",
            )
            require(
                set(rule_ids) <= {r for k in coverage_ids for r in items[k]["rule_ids"]}
                and set(impact_ids)
                <= {i for k in coverage_ids for i in items[k].get("impact_ids", [])},
                branch["id"] + " rules/impacts must belong to linked coverage items",
            )
            if branch["basis"] != "confirmed":
                require(
                    all(items[k]["disposition"] != "designed" for k in coverage_ids),
                    branch["id"] + " unconfirmed branch cannot count as designed",
                )
            branch_links.update(coverage_ids)
        for key in items:
            require(key in branch_links, key + " has no branch")
        branch_counts = {
            "confirmed": sum(b["basis"] == "confirmed" for b in branches.values()),
            "candidate": sum(b["basis"] != "confirmed" for b in branches.values()),
        }
        if branch_counts["candidate"]:
            warnings.append("候选分支仍待确认，不计为已确认分支或完整业务覆盖")
    for key in rules:
        require(
            any(key in item["rule_ids"] for item in items.values()),
            key + " has no coverage disposition",
        )
    for key, impact in impacts.items():
        if impact["disposition"] in {"affected", "unknown"}:
            require(
                any(key in item.get("impact_ids", []) for item in items.values()),
                key + " consumer has no coverage disposition",
            )
    review = model.get("review")
    require(
        isinstance(review, dict) and review.get("status") in {"pending", "reviewed"},
        "review status is required",
    )
    require(
        strings(review.get("findings"), False) and strings(review.get("limitations"), False),
        "review findings/limitations required",
    )
    digest = model_digest(model, data["cases"])
    if review["status"] == "reviewed":
        require(
            text(review.get("method")) and review.get("model_sha256") == digest,
            "review must bind to current model hash",
        )
    else:
        warnings.append("尚未完成从业务模型反查用例的语义审查")
    counts = dict(Counter(x["disposition"] for x in rows))
    if any(counts.get(k, 0) for k in ("blocked", "uncovered")):
        warnings.append("存在待澄清、阻塞或尚未设计项；不能宣称业务范围全部覆盖")
    return {
        "status": "reviewed" if review["status"] == "reviewed" else "pending",
        "scope": model["scope"],
        "model_sha256": digest,
        "counts": counts,
        "branch_counts": branch_counts,
        "warnings": warnings,
        "items": rows,
        "limits": (
            "仅核验已声明模型的引用与去向；不证明材料齐全、检索已实际发生、"
            "消费者发现完整或业务预期正确"
        ),
    }


def design_markdown(data):
    summary = validate_design(data)
    if summary["status"] == "legacy":
        return "## 业务覆盖审查\n\n" + summary["warnings"][0] + "\n"
    lines = [
        "## 业务覆盖模型与缺口",
        "",
        "范围：" + summary["scope"],
        "",
        "模型内覆盖项："
        + "；".join(f"{DISPOSITIONS[k]} {v}" for k, v in summary["counts"].items()),
        "",
        summary["limits"],
        "",
        "| 覆盖项 | 条件/类型 | 去向 | 用例或原因 |",
        "| --- | --- | --- | --- |",
    ]
    if summary["branch_counts"]:
        counts = summary["branch_counts"]
        lines[7:7] = [
            f"分支：已确认 {counts['confirmed']}；候选待确认 {counts['candidate']}"
            "（不代表完整覆盖）",
            "",
        ]

    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", "<br>")

    for item in summary["items"]:
        lines.append(
            "| "
            + " | ".join(
                map(
                    cell,
                    (
                        item["id"] + " " + item["title"],
                        "；".join(item["conditions"]) + " / " + item["kind"],
                        DISPOSITIONS[item["disposition"]],
                        "；".join(
                            filter(None, (", ".join(item["case_ids"]), item.get("reason", "")))
                        ),
                    ),
                )
            )
            + " |"
        )
    lines += [
        "",
        "审查声明：" + data["design_model"]["review"]["status"],
        *["- " + w for w in summary["warnings"]],
        *["- " + label + "：" + value for label, value in design_notes(data)],
    ]
    return "\n".join(lines) + "\n"


def design_html(data):
    summary = validate_design(data)

    def esc(value):
        return html.escape(str(value), quote=True)

    parts = ["<section><details><summary>业务覆盖模型与剩余缺口</summary>"]
    if summary["status"] == "legacy":
        parts.append("<p>" + esc(summary["warnings"][0]) + "</p>")
    else:
        parts += [
            "<p>范围：" + esc(summary["scope"]) + "</p>",
            "<p>" + esc(summary["limits"]) + "</p>",
            "<p>"
            + esc("；".join(f"{DISPOSITIONS[k]} {v}" for k, v in summary["counts"].items()))
            + "</p>",
            "<table><tr><th>覆盖项</th><th>条件</th><th>去向</th><th>用例或原因</th></tr>",
        ]
        for item in summary["items"]:
            values = (
                item["id"] + " " + item["title"],
                "；".join(item["conditions"]),
                DISPOSITIONS[item["disposition"]],
                "；".join(filter(None, (", ".join(item["case_ids"]), item.get("reason", "")))),
            )
            parts.append("<tr>" + "".join("<td>" + esc(v) + "</td>" for v in values) + "</tr>")
        parts.append("</table>")
        if summary["branch_counts"]:
            counts = summary["branch_counts"]
            parts.append(
                "<p>分支：已确认 "
                + str(counts["confirmed"])
                + "；候选待确认 "
                + str(counts["candidate"])
                + "（不代表完整覆盖）</p>"
            )
        parts += ["<p>" + esc(w) + "</p>" for w in summary["warnings"]]
        parts += [
            "<p><strong>" + esc(label) + "：</strong>" + esc(value) + "</p>"
            for label, value in design_notes(data)
        ]
    return "".join(parts) + "</details></section>"


def design_notes(data):
    model = data["design_model"]
    notes = []
    for material in model["materials"]:
        if material["status"] != "available":
            notes.append(
                ("材料缺口 " + material["id"], material["reference"] + "；" + material["summary"])
            )
    for rule in model["rules"]:
        if rule["basis"] != "confirmed":
            notes.append(("规则待决 " + rule["id"] + " / " + rule["basis"], rule["question"]))
    for impact in model["impacts"]:
        notes.append(
            (
                "影响边界 " + impact["id"],
                impact["consumer"] + " / " + impact["disposition"] + "；" + impact["reason"],
            )
        )
    if model.get("design_method_version") == 2:
        for record in model["discovery"]:
            notes.append(
                (
                    "消费者发现 " + record["id"] + " / " + record["object_id"],
                    "种子："
                    + "；".join(record["seeds"])
                    + "；终止依据："
                    + record["stopping_reason"],
                )
            )
            for index, search in enumerate(record["searches"], 1):
                notes.append(
                    (
                        "检索 " + record["id"] + " / " + str(index),
                        "查询："
                        + search["query"]
                        + "；范围："
                        + search["scope"]
                        + "；证据："
                        + "；".join(search["evidence"])
                        + "；影响："
                        + ", ".join(search.get("impact_ids", []))
                        + "；结果："
                        + search["result"],
                    )
                )
        for branch in model["branches"]:
            notes.append(
                (
                    "业务分支 " + branch["id"] + " / " + branch["basis"],
                    "条件："
                    + "；".join(branch["conditions"])
                    + "；动作："
                    + branch["action"]
                    + "；结果/候选判据："
                    + branch["outcome"]
                    + "；规则："
                    + ", ".join(branch["rule_ids"])
                    + "；影响："
                    + ", ".join(branch.get("impact_ids", []))
                    + "；覆盖项："
                    + ", ".join(branch["coverage_ids"]),
                )
            )
        for case in data["cases"]:
            if case["oracle_status"] == "pending":
                candidate = case["candidate_oracle"]
                notes.append(
                    (
                        "候选预期 " + case["id"] + "（待确认假设）",
                        "候选结果："
                        + candidate["expectation"]
                        + "；推导依据："
                        + candidate["basis"]
                        + "；未决点："
                        + candidate["question"],
                    )
                )
    notes += [("审查方法", model["review"].get("method") or "待完成")]
    notes += [("审查发现", value) for value in model["review"]["findings"]]
    notes += [("审查限制", value) for value in model["review"]["limitations"]]
    return notes
