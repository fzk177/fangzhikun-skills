#!/usr/bin/env python3
"""Validate test manifests and render local planning/evidence artifacts; never run tests."""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import io
import json
import re
import sys

sys.dont_write_bytecode = True
import zipfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from uuid import uuid4
from xml.etree import ElementTree as ET

from business_artifacts import existing_attachments, render_artifacts, validate_extensions
from design_coverage import design_markdown, validate_design

CONTENT_NS = "urn:xmind:xmap:xmlns:content:2.0"
MANIFEST_NS = "urn:xmind:xmap:xmlns:manifest:1.0"
VERDICTS = {"Passed", "Failed", "Blocked", "Not run", "Passed — human review required"}
PASSES = {"Passed", "Passed — human review required"}
GROUPS = ("identity", "before", "input", "after", "persistence")
RATINGS = {"E0": 0, "E1": 1, "E2": 2, "E3": 3}
ET.register_namespace("", CONTENT_NS)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def strings(value, nonempty=True):
    return isinstance(value, list) and (bool(value) or not nonempty) and all(text(v) for v in value)


def unique_map(items, label):
    require(isinstance(items, list), f"{label} must be an array")
    result = {}
    for item in items:
        require(isinstance(item, dict), f"{label} entries must be objects")
        key = item.get("id")
        require(
            text(key) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", key), f"invalid {label} id"
        )
        require(key not in result, f"duplicate {label} id: {key}")
        result[key] = item
    return result


def load_manifest(path):
    raw = path.read_bytes()
    data = json.loads(raw)
    require(
        isinstance(data, dict) and data.get("schema_version") == 1, "unsupported manifest schema"
    )
    require(text(data.get("requirement_name")), "requirement_name is required")
    require(
        re.fullmatch(r"[1-9][0-9]*", str(data.get("story_id", ""))), "story_id must be positive"
    )
    require(text(data.get("project")), "project is required")
    analysis = data.get("analysis")
    require(isinstance(analysis, dict), "analysis is required")
    for key in ("change", "old_behavior", "new_behavior"):
        require(text(analysis.get(key)), f"analysis.{key} is required; state unknown explicitly")
    for key in (
        "objects",
        "impacts",
        "states",
        "consistency",
        "scenario_matrix",
        "partial_failures",
        "data_strategy",
        "unknowns",
        "strategy",
    ):
        require(strings(analysis.get(key, []), False), f"analysis.{key} must be a string array")
    risks = unique_map(data.get("risks"), "risk")
    cases = unique_map(data.get("cases"), "case")
    require(cases, "at least one real case is required")
    allocations = unique_map(data.get("data_allocations", []), "data allocation")
    regressions = unique_map(data.get("regressions", []), "regression")
    for risk in risks.values():
        require(risk.get("priority") in {"P0", "P1", "P2"}, f"invalid risk priority: {risk['id']}")
        require(text(risk.get("title")) and text(risk.get("impact")), "risk title/impact required")
    for case in cases.values():
        prefix = case["id"]
        for key in ("title", "group", "oracle", "cleanup"):
            require(text(case.get(key)), f"{prefix}.{key} is required")
        for key in ("ac_ids", "sources", "preconditions", "steps", "expected", "evidence"):
            require(strings(case.get(key)), f"{prefix}.{key} must be a nonempty string array")
        require(case.get("risk") in {"P0", "P1", "P2"}, f"invalid risk: {prefix}")
        require(case.get("ownership") in {"ai", "ai_review", "human"}, f"invalid owner: {prefix}")
        require(isinstance(case.get("writes_data"), bool), f"{prefix}.writes_data must be boolean")
        require(
            isinstance(case.get("persistence_required"), bool),
            "persistence_required must be boolean",
        )
        linked = case.get("risk_ids", [])
        require(strings(linked, False) and set(linked) <= risks.keys(), f"unknown risks: {prefix}")
        if case["ownership"] == "human":
            require(text(case.get("why_human")), f"{prefix}.why_human is required")
            require(strings(case.get("method_evidence")), f"{prefix}.method_evidence is required")
        if case["ownership"] == "ai_review":
            links = case.get("review_case_ids")
            require(strings(links), f"{prefix} needs review_case_ids")
            require(
                all(cases.get(k, {}).get("ownership") == "human" for k in links),
                "invalid review case",
            )
        if case["writes_data"]:
            allocation = allocations.get(case.get("data_allocation"))
            require(
                allocation and prefix in allocation.get("case_ids", []),
                f"{prefix} needs data allocation",
            )
    for allocation in allocations.values():
        links = allocation.get("case_ids")
        require(strings(links) and set(links) <= cases.keys(), "unknown data-allocation case")
        for key in (
            "business_type",
            "branch",
            "target_state",
            "parent",
            "marker",
            "reuse_limits",
            "rerun",
            "cleanup",
        ):
            require(text(allocation.get(key)), f"allocation {allocation['id']} needs {key}")
        for key in ("children", "capture_ids"):
            require(strings(allocation.get(key), False), f"allocation needs {key} array")
    for risk in risks.values():
        linked = any(risk["id"] in c.get("risk_ids", []) for c in cases.values())
        require(
            linked or text(risk.get("gap")),
            f"risk {risk['id']} has neither coverage nor explicit gap",
        )
    for regression in regressions.values():
        case = cases.get(regression.get("case_id"))
        require(case and case["ownership"] != "human", "regression must reference an AI case")
        require(regression.get("kind") in {"fixed", "dynamic"}, "invalid regression kind")
        require(text(regression.get("reason")), "regression reason required")
    validate_extensions(data)
    validate_design(data)
    return data, cases, hashlib.sha256(raw).hexdigest()


def bullet(items):
    return "\n".join(f"- {item}" for item in items) or "- 无／不适用"


def case_markdown(case):
    parts = [
        f"### {case['id']} · {case['title']}",
        f"风险：{case['risk']}；验证归属：{case['ownership']}；AC：{', '.join(case['ac_ids'])}",
        "预期依据：\n" + bullet(case["sources"]),
        "前置条件：\n" + bullet(case["preconditions"]),
        "步骤：\n" + "\n".join(f"{i}. {s}" for i, s in enumerate(case["steps"], 1)),
        "预期：\n" + bullet(case["expected"]),
        "独立判据：" + case["oracle"],
        "证据检查点：\n" + bullet(case["evidence"]),
        "清理：" + case["cleanup"],
        "资产／pytest 引用：\n" + bullet(case.get("asset_ids", []) + case.get("python_refs", [])),
    ]
    if case.get("review_case_ids"):
        parts.append("关联人工检查：" + ", ".join(case["review_case_ids"]))
    if case.get("blocked_by"):
        parts.append("阻塞条件：\n" + bullet(case["blocked_by"]))
    return "\n\n".join(parts)


def xmind_bytes(data, manual_cases):
    def tag(name):
        return f"{{{CONTENT_NS}}}{name}"

    def topic(title, identity):
        node = ET.Element(tag("topic"), {"id": identity})
        ET.SubElement(node, tag("title")).text = title
        return node

    def attach(parent, child):
        children = parent.find(tag("children"))
        if children is None:
            children = ET.SubElement(parent, tag("children"))
        topics = children.find(tag("topics"))
        if topics is None:
            topics = ET.SubElement(children, tag("topics"), {"type": "attached"})
        topics.append(child)

    content = ET.Element(tag("xmap-content"), {"version": "2.0"})
    sheet = ET.SubElement(content, tag("sheet"), {"id": "manual-sheet"})
    ET.SubElement(sheet, tag("title")).text = "人工／工具辅助验证"
    central = topic(data["requirement_name"], "manual-root")
    central.set("structure-class", "org.xmind.ui.logic.right")
    sheet.append(central)
    groups = {}
    for case in manual_cases:
        group = case["group"]
        if group not in groups:
            groups[group] = topic(group, "group-" + hashlib.sha256(group.encode()).hexdigest()[:16])
            attach(central, groups[group])
        node = topic(f"{case['id']}｜{case['title']}", "case-" + case["id"])
        attach(groups[group], node)
        notes = ET.SubElement(node, tag("notes"))
        ET.SubElement(notes, tag("plain")).text = "需求来源：\n" + "\n".join(case["sources"])
        for key, label in (
            ("preconditions", "前置条件"),
            ("steps", "步骤"),
            ("expected", "预期"),
            ("method_evidence", "所需方法与证据"),
        ):
            branch = topic(label, f"{case['id']}-{key}")
            attach(node, branch)
            for i, value in enumerate(case[key]):
                attach(branch, topic(value, f"{case['id']}-{key}-{i}"))
        attach(node, topic("浏览器不足以证明：" + case["why_human"], case["id"] + "-why"))
    if not manual_cases:
        attach(
            central, topic("本次未识别出独立人工检查项；不代表隐藏层已验证", "manual-empty-note")
        )
    files = {
        "content.xml": ET.tostring(content, encoding="utf-8", xml_declaration=True),
        "styles.xml": b'<xmap-styles xmlns="urn:xmind:xmap:xmlns:style:2.0" version="2.0"/>',
        "meta.xml": b'<meta xmlns="urn:xmind:xmap:xmlns:meta:2.0" version="2.0"/>',
    }
    manifest = ET.Element(f"{{{MANIFEST_NS}}}manifest")
    for name in files:
        ET.SubElement(
            manifest, f"{{{MANIFEST_NS}}}file-entry", {"full-path": name, "media-type": "text/xml"}
        )
    files["META-INF/manifest.xml"] = ET.tostring(manifest, encoding="utf-8", xml_declaration=True)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    return output.getvalue()


def evidence_file(raw, base, image=False):
    require(text(raw) and "://" not in raw, "evidence must reference a local file")
    path = Path(raw).expanduser()
    path = (base / path).resolve() if not path.is_absolute() else path.resolve()
    require(path.is_file(), f"evidence file missing: {path}")
    if image:
        head = path.read_bytes()[:16]
        png = head.startswith(b"\x89PNG\r\n\x1a\n")
        jpeg = head.startswith(b"\xff\xd8\xff")
        gif = head.startswith((b"GIF87a", b"GIF89a"))
        webp = head.startswith(b"RIFF") and head[8:12] == b"WEBP"
        require(png or jpeg or gif or webp, f"unsupported screenshot format: {path}")
    return path


def assess_results(data, cases, digest, results, base):
    require(
        isinstance(results, dict) and results.get("schema_version") == 1,
        "unsupported results schema",
    )
    require(
        results.get("manifest_sha256") == digest, "results refer to a different manifest snapshot"
    )
    require(text(results.get("run_id")), "run_id required")
    require(results.get("phase") in {"planned", "executed"}, "invalid results phase")
    selected = results.get("selected_case_ids")
    require(
        strings(selected, False) and len(selected) == len(set(selected)),
        "selected case IDs must be unique",
    )
    require(
        all(cases.get(k, {}).get("ownership") in {"ai", "ai_review"} for k in selected),
        "unknown/non-AI selected case",
    )
    records = {}
    require(isinstance(results.get("results"), list), "results must be an array")
    for row in results["results"]:
        require(isinstance(row, dict), "result must be an object")
        key = row.get("case_id")
        require(key in selected and key not in records, f"unknown/duplicate result: {key}")
        verdict = row.get("verdict")
        require(verdict in VERDICTS, f"invalid verdict: {key}")
        if row.get("first_pass_verdict") is not None:
            require(row["first_pass_verdict"] in VERDICTS, "invalid first-pass verdict")
        first = row.get("first_pass_verdict")
        attempts = row.get("attempts", [])
        require(isinstance(attempts, list), "attempts must be an array")
        for attempt in attempts:
            require(
                isinstance(attempt, dict)
                and attempt.get("verdict") in VERDICTS
                and text(attempt.get("actual")),
                "attempt needs verdict/actual",
            )
            require(strings(attempt.get("evidence", []), False), "invalid attempt evidence")
            for raw in attempt.get("evidence", []):
                evidence_file(raw, base)
            if attempt["verdict"] == "Failed":
                require(attempt.get("evidence"), "failed attempt needs evidence")
        if first in {"Failed", "Blocked"} and first != verdict:
            require(
                any(a["verdict"] == first for a in attempts),
                "preserve the first failed/blocked attempt before changing its verdict",
            )
        if verdict != "Not run":
            require(text(row.get("actual")), f"actual result required: {key}")
        if verdict in PASSES or verdict == "Failed":
            require(
                isinstance(row.get("context"), dict) and row["context"], "result context required"
            )
            require(text(row.get("cleanup")), "side effects/cleanup status required")
        evidence = row.get("evidence", {})
        require(isinstance(evidence, dict), "evidence must be an object")
        rating = evidence.get("rating", "E0")
        require(rating in RATINGS, "unknown evidence rating")
        for group in GROUPS:
            paths = evidence.get(group, [])
            require(strings(paths, False), f"invalid evidence group: {group}")
            for raw in paths:
                evidence_file(raw, base)
        product_failure = verdict == "Failed" and (
            row.get("failure_category") == "product" or row.get("confirmed_bug")
        )
        if data.get("design_model") is not None and (verdict in PASSES or product_failure):
            decision = "pass" if verdict in PASSES else "confirm product failure"
            require(
                cases[key].get("oracle_status") == "confirmed",
                f"unresolved oracle cannot {decision}",
            )
            require(
                cases[key].get("data_status") in {"ready", "not_required"},
                f"unprepared data cannot {decision}",
            )
            coverage = {item["id"]: item for item in data["design_model"]["coverage_items"]}
            require(
                all(coverage[k]["disposition"] == "designed" for k in cases[key]["coverage_ids"]),
                f"unresolved coverage cannot {decision}",
            )
        if verdict in PASSES:
            threshold = 3 if cases[key]["risk"] == "P0" else 2
            require(RATINGS[rating] >= threshold, f"insufficient evidence rating: {key}")
            required = {"identity", "input", "after"}
            if rating == "E3":
                required.add("before")
            if cases[key]["persistence_required"]:
                required.add("persistence")
            elif rating == "E3" and not evidence.get("persistence"):
                require(
                    text(row.get("persistence_not_applicable")),
                    "explain inapplicable persistence check",
                )
            require(all(evidence.get(g) for g in required), f"missing evidence checkpoints: {key}")
            expected = (
                "Passed — human review required"
                if cases[key]["ownership"] == "ai_review"
                else "Passed"
            )
            require(verdict == expected, f"verdict does not preserve review ownership: {key}")
        if verdict == "Failed":
            require(
                RATINGS[rating] >= 2 and evidence.get("identity") and evidence.get("after"),
                f"failure needs identity and observable mismatch evidence: {key}",
            )
        require(isinstance(row.get("confirmed_bug", False), bool), "confirmed_bug must be boolean")
        require(strings(row.get("screenshots", []), False), "screenshots must be an array")
        for raw in row.get("screenshots", []):
            evidence_file(raw, base, image=True)
        if row.get("confirmed_bug"):
            require(
                verdict == "Failed" and row.get("failure_category") == "product",
                "only confirmed product failures are bugs",
            )
            require(
                strings(row.get("reproduction_steps")), "confirmed bug needs reproduction steps"
            )
            require(strings(row.get("screenshots")), "confirmed bug needs screenshots")
        records[key] = row
    blockers = []
    if results["phase"] != "executed":
        blockers.append("未进行实际执行")
    if not selected:
        blockers.append("未选择 AI 执行场景")
    for key in selected:
        if records.get(key, {}).get("verdict", "Not run") == "Not run":
            blockers.append(f"{key} 尚未执行")
    if not text(results.get("environment")) or not text(results.get("role")):
        blockers.append("缺少实际环境或角色说明")
    if not isinstance(results.get("versions"), dict) or not results["versions"]:
        blockers.append("缺少实际运行版本依据")
    if not text(results.get("executed_at")):
        blockers.append("缺少实际执行时间")
    regressions = unique_map(data.get("regressions", []), "regression")
    closed = unique_map(results.get("regression_results", []), "regression result")
    require(closed.keys() <= regressions.keys(), "unknown regression result")
    for key, item in regressions.items():
        if item["case_id"] not in selected:
            continue
        closure = closed.get(key, {})
        status = closure.get("status")
        if status == "done":
            require(
                text(closure.get("actual")) and closure.get("verdict") in {"Passed", "Failed"},
                "regression needs actual/verdict",
            )
            require(strings(closure.get("evidence")), "regression needs evidence")
            for raw in closure["evidence"]:
                evidence_file(raw, base)
        elif status == "blocked":
            require(text(closure.get("reason")), "blocked regression needs reason")
        else:
            blockers.append(f"回归 {key} 尚无处置")
    followups = {}
    require(
        isinstance(results.get("blocked_followups", []), list), "blocked_followups must be an array"
    )
    for row in results.get("blocked_followups", []):
        require(isinstance(row, dict), "blocked follow-up must be an object")
        key = row.get("case_id")
        require(key in selected and key not in followups, "unknown/duplicate blocker follow-up")
        require(
            row.get("decision") in {"retried", "remain_blocked"} and text(row.get("reason")),
            "blocker needs retry decision/reason",
        )
        followups[key] = row
    for key, row in records.items():
        if (
            "Blocked" in {row.get("verdict"), row.get("first_pass_verdict")}
            and key not in followups
        ):
            blockers.append(f"阻塞 {key} 未记录后续处置")
    return records, blockers


def report_markdown(data, cases, results, records, blockers, final=False):
    rows = [
        records.get(k, {"case_id": k, "verdict": "Not run"}) for k in results["selected_case_ids"]
    ]
    counts = Counter(row["verdict"] for row in rows)
    passed = sum(counts[v] for v in PASSES)
    executed = passed + counts["Failed"]
    rate = f"{passed}/{executed} = {passed / executed:.1%}" if executed else "不适用（0 项已执行）"
    manual = [c for c in cases.values() if c["ownership"] == "human"]
    relevant_regressions = {
        r["id"] for r in data.get("regressions", []) if r["case_id"] in results["selected_case_ids"]
    }
    regression_rows = [
        r for r in results.get("regression_results", []) if r["id"] in relevant_regressions
    ]
    failed_regression = any(r.get("verdict") == "Failed" for r in regression_rows)
    blocked_regression = any(r.get("status") == "blocked" for r in regression_rows)
    if counts["Failed"] or failed_regression:
        conclusion = "Failed（范围内存在失败，产品缺陷须单独确认）"
    elif not executed:
        conclusion = "Inconclusive（缺少已执行结果）"
    elif (
        blockers
        or counts["Blocked"]
        or manual
        or blocked_regression
        or counts["Passed — human review required"]
    ):
        conclusion = "Conditionally passed（仅限浏览器已验证部分，仍有待确认项）"
    else:
        conclusion = "Browser-observable passed（仅选定 UI 范围）"
    lines = [
        f"# {data['requirement_name']} · 执行证据报告",
        "",
        f"报告状态：{'最终事实报告' if final else '草稿／未完成'}；运行：{results['run_id']}",
        f"环境：{results.get('environment') or '未提供'}；角色：{results.get('role') or '未提供'}",
        f"清单 SHA256：{results['manifest_sha256']}",
        "版本依据：" + json.dumps(results.get("versions", {}), ensure_ascii=False),
        f"选定范围：{', '.join(results['selected_case_ids']) or '无'}",
        f"执行时间：{results.get('executed_at') or '尚未执行'}",
        "范围外未执行："
        + ", ".join(
            c["id"]
            for c in cases.values()
            if c["ownership"] != "human" and c["id"] not in results["selected_case_ids"]
        ),
        "",
        "## 汇总",
        f"浏览器可观察通过率：{rate}",
        "原始数量：" + json.dumps({v: counts[v] for v in sorted(VERDICTS)}, ensure_ascii=False),
        f"人工／工具辅助检查 {len(manual)} 项，完成情况须另附证据，本报告不自动关闭。",
        f"结论：{conclusion}",
        "完成门槛：" + ("通过（不代表所有用例通过）" if not blockers else "未通过"),
        bullet(blockers),
        "",
        "## 逐项证据",
    ]
    lines.extend(
        [
            "| 用例 | 判定 | 风险 | 证据 | 缺陷/阻塞 | 剩余人工检查 |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
    )
    for row in rows:
        case = cases[row["case_id"]]
        rating = row.get("evidence", {}).get("rating", "E0")
        issue = (
            "确认产品缺陷"
            if row.get("confirmed_bug")
            else (row.get("actual", "") if row["verdict"] in {"Failed", "Blocked"} else "无")
        )
        issue = issue.replace("|", "\\|").replace("\n", "<br>")
        lines.append(
            f"| {case['id']} | {row['verdict']} | {case['risk']} | {rating} | "
            + issue
            + " | "
            + ", ".join(case.get("review_case_ids", []))
            + " |"
        )
    for row in rows:
        case = cases[row["case_id"]]
        lines.extend(
            [
                "",
                f"### {case['id']} · {case['title']}",
                f"判定：{row['verdict']}；风险：{case['risk']}；"
                + f"证据：{row.get('evidence', {}).get('rating', 'E0')}",
                "预期来源：\n" + bullet(case["sources"]),
                "预期：\n" + bullet(case["expected"]),
                "实际：" + row.get("actual", "未执行"),
                "身份／前态／输入：" + json.dumps(row.get("context", {}), ensure_ascii=False),
                "本次输入：" + json.dumps(row.get("inputs", {}), ensure_ascii=False),
                "首次判定：" + row.get("first_pass_verdict", "未单独记录"),
                "各次执行：" + json.dumps(row.get("attempts", []), ensure_ascii=False),
                "持久化不适用原因：" + row.get("persistence_not_applicable", "无"),
                "副作用／清理：" + row.get("cleanup", "未记录"),
                "人工关联：" + ", ".join(case.get("review_case_ids", [])),
            ]
        )
        for group in GROUPS:
            links = [
                f"[{Path(raw).name}](<{raw}>)" for raw in row.get("evidence", {}).get(group, [])
            ]
            lines.append(f"{group}：\n" + bullet(links))
    lines.extend(["", "## P0 状态"])
    for row in rows:
        if cases[row["case_id"]]["risk"] == "P0":
            lines.append(f"- {row['case_id']}：{row['verdict']}")
    for case in cases.values():
        if case["risk"] == "P0" and case["id"] not in results["selected_case_ids"]:
            state = "需独立人工/工具证据" if case["ownership"] == "human" else "范围外未执行"
            lines.append(f"- {case['id']}：{state}")
    lines.extend(
        [
            "",
            "## 固定／动态回归与阻塞处置",
            json.dumps(
                {
                    "regressions": regression_rows,
                    "blocked_followups": results.get("blocked_followups", []),
                },
                ensure_ascii=False,
                indent=2,
            ),
            "",
            "## 剩余人工检查",
            bullet([f"{c['id']}：{c['title']}；{c['why_human']}" for c in manual]),
        ]
    )
    return "\n\n".join(lines) + "\n"


def bug_html(data, cases, results, records, base):
    def esc(value):
        return html.escape(str(value), quote=True)

    cards = []
    for key, row in records.items():
        if row.get("verdict") != "Failed" or not row.get("confirmed_bug"):
            continue
        case = cases[key]
        images = []
        for raw in row["screenshots"]:
            path = evidence_file(raw, base, image=True)
            payload = path.read_bytes()
            mime = (
                "image/png"
                if payload.startswith(b"\x89PNG")
                else (
                    "image/jpeg"
                    if payload.startswith(b"\xff\xd8")
                    else "image/gif"
                    if payload.startswith(b"GIF")
                    else "image/webp"
                )
            )
            images.append(
                f'<figure><img alt="{esc(path.name)}" src="data:{mime};base64,'
                + base64.b64encode(payload).decode()
                + '"></figure>'
            )
        steps = "".join(f"<li>{esc(s)}</li>" for s in row["reproduction_steps"])
        expected = "".join(f"<li>{esc(s)}</li>" for s in case["expected"])
        preconditions = "".join(f"<li>{esc(s)}</li>" for s in case["preconditions"])
        cards.append(
            f"<article><h2>标题：{esc(row.get('bug_title') or case['title'])}</h2>"
            f"<h3>复现步骤（详细）</h3><p>用例：{esc(key)}</p>"
            f"<p>前置条件：</p><ul>{preconditions}</ul>"
            f"<ol>{steps}</ol><p>实际表现：{esc(row['actual'])}</p>"
            f"<h3>截图</h3>{''.join(images)}<h3>期望</h3><ol>{expected}</ol></article>"
        )
    body = "".join(cards) or "<p>本轮选定范围内无已确认的产品缺陷；不代表不存在缺陷。</p>"
    return (
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
        f"<title>{esc(data['requirement_name'])}</title>"
        "<style>body{font:16px system-ui;max-width:1080px;margin:32px auto;padding:0 20px}"
        "article{border-top:1px solid #aaa;padding:20px 0}img{max-width:100%}</style>"
        f"<h1>{esc(data['requirement_name'])} · 确认缺陷</h1>"
        f"<p>运行：{esc(results['run_id'])}</p>{body}</html>"
    )


def plan(cases_path, out, run_id, repo=None, allow_legacy_design=False):
    data, cases, digest = load_manifest(cases_path)
    design = validate_design(data, required=not allow_legacy_design)
    ai = [c for c in cases.values() if c["ownership"] != "human"]
    manual = [c for c in cases.values() if c["ownership"] == "human"]
    analysis = data["analysis"]
    risk_lines = [
        f"# {data['requirement_name']} · 需求风险分析",
        analysis["change"],
        "旧行为：" + analysis["old_behavior"],
        "新行为：" + analysis["new_behavior"],
        design_markdown(data),
    ]
    for key, label in (
        ("objects", "业务对象与来源"),
        ("impacts", "影响链"),
        ("states", "状态与合法转换"),
        ("consistency", "一致性模型"),
        ("scenario_matrix", "场景矩阵"),
        ("partial_failures", "部分成功与恢复"),
        ("data_strategy", "数据准备策略"),
        ("unknowns", "未决问题"),
        ("strategy", "测试与回归策略"),
    ):
        risk_lines += ["## " + label, bullet(analysis.get(key, []))]
    for risk in data["risks"]:
        covered = [c["id"] for c in cases.values() if risk["id"] in c.get("risk_ids", [])]
        risk_lines += [
            f"## {risk['id']} · {risk['title']} · {risk['priority']}",
            risk["impact"],
            "覆盖：" + (", ".join(covered) or risk.get("gap", "")),
        ]
    allocation_text = [
        "## 数据分配矩阵",
        "| 场景/分配 ID | 分支/目标状态 | 父子对象/标识 | 捕获 ID | 复用限制 | 重跑/清理 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]

    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", "<br>")

    for allocation in data.get("data_allocations", []):
        values = [
            ", ".join(allocation["case_ids"]) + " / " + allocation["id"],
            " / ".join(allocation[k] for k in ("business_type", "branch", "target_state")),
            " / ".join([allocation["parent"], *allocation["children"], allocation["marker"]]),
            ", ".join(allocation["capture_ids"]),
            allocation["reuse_limits"],
            allocation["rerun"] + " / " + allocation["cleanup"],
        ]
        allocation_text.append("| " + " | ".join(cell(v) for v in values) + " |")
    if not data.get("data_allocations"):
        allocation_text.append("本次用例无数据写操作，未分配写入测试数据。")
    fixed = [
        "## 固定／动态回归队列",
        bullet(
            [
                f"{r['id']} → {r['case_id']}（{r['kind']}）：{r['reason']}"
                for r in data.get("regressions", [])
            ]
        ),
    ]
    results = {
        "schema_version": 1,
        "run_id": run_id,
        "phase": "planned",
        "manifest_sha256": digest,
        "environment": None,
        "role": None,
        "versions": {},
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "executed_at": None,
        "selected_case_ids": [c["id"] for c in ai],
        "results": [
            {
                "case_id": c["id"],
                "verdict": "Not run",
                "actual": "尚未执行",
                "evidence": {"rating": "E0"},
            }
            for c in ai
        ],
        "regression_results": [],
        "blocked_followups": [],
    }
    records, blockers = assess_results(data, cases, digest, results, out)
    files = {
        "01-requirement-risk-analysis.md": "\n\n".join(risk_lines).encode(),
        "02-ai-browser-test-cases.md": "\n\n".join(
            [
                f"# {data['requirement_name']} · AI 用例",
                "策划交付不代表执行授权。数据操作限已授权对象与环境。",
                *allocation_text,
                *[case_markdown(c) for c in ai],
                *fixed,
            ]
        ).encode(),
        "03-manual-test.xmind": xmind_bytes(data, manual),
        "04-ai-execution-evidence-report.md": report_markdown(
            data, cases, results, records, blockers
        ).encode(),
        "manual-xmind-cases.json": (
            json.dumps(
                {
                    "schema_version": 1,
                    "requirement_name": data["requirement_name"],
                    "manifest_sha256": digest,
                    "cases": manual,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        ).encode(),
        "execution-results.json": (
            json.dumps(results, ensure_ascii=False, indent=2) + "\n"
        ).encode(),
    }
    if (out / "test-cases.json").resolve() != cases_path.resolve():
        files["test-cases.json"] = cases_path.read_bytes()
    business_files, business_index = render_artifacts(data, out, repo, results, out)
    files.update(business_files)
    for name in files:
        require(not (out / name).exists(), f"output exists; use a new run directory: {out / name}")
    out.mkdir(parents=True, exist_ok=True)
    for name, payload in files.items():
        (out / name).write_bytes(payload)
    return {
        "stage": "planned",
        "output": str(out),
        "ai_cases": len(ai),
        "manual_cases": len(manual),
        "business_csv": business_index["csv"],
        "csv_status": business_index["csv_status"],
        "review_page": str(out / "00-test-case-automation.html"),
        "design_status": design["status"],
        "design_counts": design["counts"],
        "design_warnings": design["warnings"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    planning = commands.add_parser("plan")
    planning.add_argument("--cases", type=Path, required=True)
    planning.add_argument("--out", type=Path, required=True)
    planning.add_argument("--run-id", default=None)
    planning.add_argument("--repo", type=Path, help="静态核验代码与流程引用，不执行pytest")
    planning.add_argument(
        "--allow-legacy-design",
        action="store_true",
        help="仅重放历史无覆盖模型清单；显式显示覆盖未审查，不用于新需求设计",
    )
    reporting = commands.add_parser("report")
    reporting.add_argument("--cases", type=Path, required=True)
    reporting.add_argument("--results", type=Path, required=True)
    reporting.add_argument("--out", type=Path, required=True)
    reporting.add_argument("--final", action="store_true")
    reporting.add_argument("--repo", type=Path, help="静态核验当前代码与关联，不证明历史部署版本")
    viewing = commands.add_parser("view", help="为已有统一清单导出业务CSV与关联页，不执行测试")
    viewing.add_argument("--cases", type=Path, required=True)
    viewing.add_argument("--results", type=Path)
    viewing.add_argument("--repo", type=Path)
    viewing.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "plan":
            result = plan(
                args.cases,
                args.out.resolve(),
                args.run_id or datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid4().hex[:8],
                args.repo,
                allow_legacy_design=args.allow_legacy_design,
            )
        elif args.command == "view":
            data, cases, digest = load_manifest(args.cases)
            results = json.loads(args.results.read_text()) if args.results else None
            base = args.results.resolve().parent if args.results else None
            if results:
                assess_results(data, cases, digest, results, base)
            files, index = render_artifacts(
                data,
                args.out,
                args.repo,
                results,
                base,
                attachments=existing_attachments(args.cases, args.results),
            )
            for name in files:
                require(not (args.out / name).exists(), "view需要新的交付目录，不覆盖历史页面")
            args.out.mkdir(parents=True, exist_ok=True)
            for name, payload in files.items():
                (args.out / name).write_bytes(payload)
            result = {
                "stage": "view",
                "output": str(args.out),
                "business_csv": index["csv"],
                "csv_status": index["csv_status"],
                "cases": len(index["cases"]),
            }
        else:
            data, cases, digest = load_manifest(args.cases)
            results = json.loads(args.results.read_text())
            base = args.results.resolve().parent
            records, blockers = assess_results(data, cases, digest, results, base)
            require(
                not args.final or not blockers,
                "completion gate rejected final report: " + "; ".join(blockers),
            )
            report = report_markdown(data, cases, results, records, blockers, args.final)
            bugs = bug_html(data, cases, results, records, base) if args.final else None
            existing_html = args.out / "07-confirmed-bugs.html"
            if existing_html.exists():
                require(
                    bugs is not None and existing_html.read_text() == bugs,
                    "final artifact already exists; use a new report snapshot directory",
                )
            attachments = existing_attachments(args.cases, args.results)
            attachments["04-ai-execution-evidence-report.md"] = (
                args.out / "04-ai-execution-evidence-report.md"
            )
            business_files, business_index = render_artifacts(
                data, args.out, args.repo, results, base, attachments=attachments
            )
            args.out.mkdir(parents=True, exist_ok=True)
            (args.out / "04-ai-execution-evidence-report.md").write_text(report, encoding="utf-8")
            if bugs is not None:
                (args.out / "07-confirmed-bugs.html").write_text(bugs, encoding="utf-8")
            for name, payload in business_files.items():
                (args.out / name).write_bytes(payload)
            result = {"final": args.final, "completion_gate": not blockers, "unresolved": blockers}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, OSError, TypeError, KeyError) as error:
        print(f"Artifact validation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
