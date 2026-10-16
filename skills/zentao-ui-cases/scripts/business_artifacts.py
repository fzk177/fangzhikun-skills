#!/usr/bin/env python3
"""Business CSV and explorable case/automation report. Never import test code."""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import ast
import csv
import hashlib
import html
import io
import json
import os
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

from design_coverage import design_html, validate_design

CSV_COLUMNS = [
    "所属模块",
    "用例名称",
    "前置条件",
    "步骤",
    "预期",
    "关键词",
    "优先级",
    "用例类型",
    "适用阶段",
    "相关研发需求",
    "类型可选值列表",
    "阶段可选值列表",
]
EXPORT_FIELDS = {"module", "priority", "case_type", "stage"}
STATES = {
    "implemented": "已实现（声明）",
    "planned": "待实现",
    "blocked": "实现受阻",
    "manual": "人工核验",
}
VERDICTS = {
    "Passed": "通过",
    "Failed": "失败",
    "Blocked": "阻塞",
    "Not run": "未执行",
    "Passed — human review required": "UI通过，待人工复核",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def string_list(value):
    return isinstance(value, list) and all(isinstance(x, str) and x.strip() for x in value)


def parse_ref(ref):
    require(isinstance(ref, str) and "::" in ref, "Python引用须为 path.py::symbol")
    path, *symbols = ref.split("::")
    selector = ".".join(symbols)
    match = re.fullmatch(r"([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\[([^\[\]]+)\])?", selector)
    require(match and path.endswith(".py"), f"无效Python引用: {ref}")
    require(
        not Path(path).is_absolute() and ".." not in Path(path).parts,
        "代码引用必须位于自动化仓库内",
    )
    return path, match[1], match[2]


def validate_extensions(data):
    defaults = data.get("zentao_export", {})
    require(
        isinstance(defaults, dict) and not set(defaults) - EXPORT_FIELDS,
        "zentao_export 只能包含 module/priority/case_type/stage",
    )
    for case in data["cases"]:
        for key in ("asset_ids", "python_refs"):
            require(string_list(case.get(key, [])), f"{case['id']}.{key} 须为字符串数组")
        for ref in case.get("python_refs", []):
            parse_ref(ref)
        metadata = case.get("zentao", {})
        require(
            isinstance(metadata, dict) and not set(metadata) - EXPORT_FIELDS,
            "case.zentao 含未知字段",
        )
        for name, value in {**defaults, **metadata}.items():
            if value is None or value == "":
                continue
            if name == "priority":
                require(
                    not isinstance(value, bool) and str(value) in {"1", "2", "3", "4"},
                    "导入优先级须为1–4；不得直接使用P0/P1/P2",
                )
            else:
                require(isinstance(value, str) and value.strip(), f"{name} 须为非空文本")
        automation = case.get("automation", {})
        require(
            isinstance(automation, dict) and not set(automation) - {"state", "reason", "steps"},
            "automation 只能包含 state/reason/steps",
        )
        if "state" in automation:
            require(automation["state"] in STATES, "未知自动化实现状态")
            if automation["state"] == "implemented":
                require(case.get("python_refs"), "声明已实现须提供真实测试入口")
            if automation["state"] in {"planned", "blocked"}:
                require(
                    isinstance(automation.get("reason"), str) and automation["reason"].strip(),
                    "待实现或实现受阻须说明原因",
                )
            if automation["state"] == "manual":
                require(case["ownership"] == "human", "人工状态须对应独立人工用例")
        if case["ownership"] == "human":
            require(automation.get("state", "manual") == "manual", "人工项不能声明自动化已实现")
        steps = automation.get("steps", [])
        require(isinstance(steps, list), "automation.steps 须为数组")
        for step in steps:
            require(
                isinstance(step, dict)
                and not set(step) - {"step", "asset_ids", "code_refs", "expected_indexes"},
                "步骤关联字段无效",
            )
            index = step.get("step")
            require(type(index) is int and 1 <= index <= len(case["steps"]), "步骤关联越界")
            for key in ("asset_ids", "code_refs"):
                require(string_list(step.get(key, [])), "步骤代码/资产引用须为字符串数组")
            require(
                set(step.get("asset_ids", [])) <= set(case.get("asset_ids", [])),
                "步骤资产须登记在当前用例中",
            )
            require(step.get("asset_ids") or step.get("code_refs"), "步骤关联须指向代码或资产")
            for ref in step.get("code_refs", []):
                parse_ref(ref)
            require(
                isinstance(step.get("expected_indexes", []), list)
                and all(
                    type(i) is int and 1 <= i <= len(case["expected"])
                    for i in step.get("expected_indexes", [])
                ),
                "预期关联越界",
            )


class StaticLinks:
    def __init__(self, repo, project):
        self.repo = Path(repo).resolve() if repo else None
        self.project = project
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", project), "无效业务项目名")
        if self.repo:
            require(
                self.repo.is_dir() and (self.repo / "projects" / project).is_dir(),
                "自动化仓库或所选业务项目不存在",
            )
        self.trees = {}
        self.assets = {}
        self.catalog_loaded = False
        self.warnings = [] if repo else ["未指定自动化仓库；代码与流程引用尚未核验"]

    def file(self, raw):
        require(self.repo is not None, "未指定自动化仓库")
        path = (self.repo / raw).resolve()
        require(
            not Path(raw).is_absolute() and path.is_relative_to(self.repo) and path.is_file(),
            f"代码文件不存在或越出仓库: {raw}",
        )
        return path

    def reference(self, ref):
        raw, symbol, parameter = parse_ref(ref)
        if self.repo is None:
            return {"ref": ref, "status": "unverified", "parameters": None}
        path = self.file(raw)
        if path not in self.trees:
            self.trees[path] = ast.parse(path.read_text(encoding="utf-8"))
        node = self.trees[path]
        for part in symbol.split("."):
            node = next(
                (
                    n
                    for n in node.body
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                    and n.name == part
                ),
                None,
            )
            require(node is not None, f"Python符号不存在: {ref}")
        require(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)), "引用须指向函数/方法")
        parameters = None
        if parameter:
            possible, opaque = {}, False
            for decorator in node.decorator_list:
                if not (
                    isinstance(decorator, ast.Call)
                    and isinstance(decorator.func, ast.Attribute)
                    and decorator.func.attr == "parametrize"
                ):
                    continue
                try:
                    ids_node = next(k.value for k in decorator.keywords if k.arg == "ids")
                    ids = ast.literal_eval(ids_node)
                    names = ast.literal_eval(decorator.args[0])
                    names = (
                        [s.strip() for s in names.split(",")] if isinstance(names, str) else names
                    )
                    values = ast.literal_eval(decorator.args[1])
                except (StopIteration, ValueError, TypeError, IndexError):
                    opaque = True
                    continue
                require(
                    isinstance(ids, (list, tuple)) and len(ids) == len(values),
                    f"参数ID与数据数量不同: {ref}",
                )
                for marker, value in zip(ids, values, strict=True):
                    row = [value] if len(names) == 1 else value
                    require(len(names) == len(row), f"参数数量不同: {ref}")
                    require(marker not in possible, f"重复参数场景ID: {ref}")
                    possible[marker] = dict(zip(names, row, strict=True))
            if parameter in possible:
                parameters = possible[parameter]
            elif opaque:
                self.warnings.append(f"{ref} 的参数定义不能静态解析，需后续核对实际运行入口")
            else:
                raise ValueError(f"参数场景ID不存在: {ref}")
        return {
            "ref": ref,
            "status": "parameter_unverified" if parameter and parameters is None else "static",
            "parameters": parameters,
        }

    def load_catalog(self):
        if self.catalog_loaded or self.repo is None:
            return
        self.catalog_loaded = True
        catalog = self.file(f"projects/{self.project}/specs/catalog.yaml")
        try:
            data = json.loads(catalog.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            try:
                import yaml
            except ImportError as exc:
                raise ValueError("catalog为YAML；当前Python缺少PyYAML，不能核验资产引用") from exc
            data = yaml.safe_load(catalog.read_text(encoding="utf-8"))
        require(
            isinstance(data, dict)
            and data.get("project") == self.project
            and isinstance(data.get("assets"), list),
            "资产登记与业务项目不符",
        )
        for item in data["assets"]:
            require(isinstance(item, dict) and isinstance(item.get("id"), str), "无效资产记录")
            require(item["id"] not in self.assets, "重复资产ID")
            self.assets[item["id"]] = item

    def asset(self, asset_id, stack=()):
        if self.repo is None:
            return {"id": asset_id, "title": asset_id, "uses": [], "status": "unverified"}
        self.load_catalog()
        require(asset_id in self.assets, f"资产ID不存在: {asset_id}")
        require(asset_id not in stack, f"流程依赖成环: {asset_id}")
        item = self.assets[asset_id]
        code = item.get("code", {})
        ref = code.get("path", "") + "::" + code.get("symbol", "")
        self.reference(ref)
        if code.get("sha256"):
            require(
                hashlib.sha256(self.file(code["path"]).read_bytes()).hexdigest() == code["sha256"],
                f"资产源码哈希变化，请先复核登记: {asset_id}",
            )
        require(string_list(item.get("uses", [])), "流程uses须为有序资产ID数组")
        for dependency in item.get("uses", []):
            self.asset(dependency, (*stack, asset_id))
        return {**item, "status": "static"}


def runtime_matches(case, record):
    actual = record.get("node_id")
    if not actual:
        return "未记录实际执行入口，不能据此核验执行关联"
    actual_path, actual_symbol, actual_parameter = parse_ref(actual)
    for ref in case.get("python_refs", []):
        path, symbol, parameter = parse_ref(ref)
        if (path, symbol) != (actual_path, actual_symbol):
            continue
        if parameter and not re.search(
            r"(?:^|-)" + re.escape(parameter) + r"(?:-|$)", actual_parameter or ""
        ):
            continue
        return "实际运行入口与声明入口匹配（不代表全部流程步骤均已执行）"
    raise ValueError(f"实际运行入口不属于当前用例: {case['id']}")


def csv_bytes(data):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=CSV_COLUMNS)
    writer.writeheader()
    missing = []

    def safe_cell(value):
        value = str(value)
        # Spreadsheet formulas are not business steps. Reject rather than changing test content.
        require(
            not value.lstrip().startswith(("=", "+", "-", "@")),
            "CSV字段含电子表格公式前缀；请改写为明确业务文本",
        )
        return value

    for case in data["cases"]:
        meta = {**data.get("zentao_export", {}), **case.get("zentao", {})}
        absent = [name for name in ("module", "priority") if meta.get(name) in (None, "")]
        if absent:
            missing.append({"case_id": case["id"], "fields": absent})
        row = {
            "所属模块": meta.get("module") or "",
            "用例名称": case["title"],
            "前置条件": "\n".join(case["preconditions"]),
            "步骤": "\n".join(f"{i}. {s}" for i, s in enumerate(case["steps"], 1)),
            "预期": "\n".join(f"{i}. {s}" for i, s in enumerate(case["expected"], 1)),
            "关键词": f"需求{data['story_id']};用例ID:{case['id']};" + ";".join(case["ac_ids"]),
            "优先级": meta.get("priority") or "",
            "用例类型": meta.get("case_type")
            or ("其他" if case["ownership"] == "human" else "功能测试"),
            "适用阶段": meta.get("stage") or "系统测试阶段",
            "相关研发需求": f"(#{data['story_id']})",
            "类型可选值列表": "",
            "阶段可选值列表": "",
        }
        writer.writerow({key: safe_cell(value) for key, value in row.items()})
    return stream.getvalue().encode("utf-8-sig"), missing


def existing_attachments(cases_path, results_path=None):
    result = {"test-cases.json": cases_path}
    if results_path:
        result["execution-results.json"] = results_path
    for parent in (cases_path.parent, results_path.parent if results_path else cases_path.parent):
        for name in (
            "01-requirement-risk-analysis.md",
            "02-ai-browser-test-cases.md",
            "03-manual-test.xmind",
            "04-ai-execution-evidence-report.md",
            "discovery-review.md",
        ):
            if (parent / name).is_file():
                result[name] = parent / name
    return result


def render_artifacts(data, out, repo=None, results=None, results_base=None, attachments=None):
    """Return bytes only; callers validate all outputs before any writes."""
    validate_extensions(data)
    design = validate_design(data)
    csv_payload, missing = csv_bytes(data)
    csv_name = "05-business-test-cases" + ("-draft" if missing else "") + ".csv"
    links = StaticLinks(repo, data["project"])
    records = {r["case_id"]: r for r in results.get("results", [])} if results else {}
    selected = set(results.get("selected_case_ids", [])) if results else set()
    sections, index = [], []

    def esc(value):
        return html.escape(str(value), quote=True)

    def href(path, label):
        relative = os.path.relpath(Path(path).resolve(), Path(out).resolve())
        return f'<a href="{esc(relative)}">{esc(label)}</a>'

    def code_link(ref):
        if links.repo:
            return href(links.file(parse_ref(ref)[0]), ref)
        return esc(ref)

    for case in data["cases"]:
        key = case["id"]
        refs = [links.reference(ref) for ref in case.get("python_refs", [])]
        assets = [links.asset(asset) for asset in case.get("asset_ids", [])]
        auto = case.get("automation", {})
        state = auto.get("state")
        implementation = (
            STATES.get(state)
            if state
            else (
                "人工核验" if case["ownership"] == "human" else "已有测试入口" if refs else "待实现"
            )
        )
        check = "代码/参数待核验" if links.repo is None else "引用已静态核对"
        if any(ref["status"] == "parameter_unverified" for ref in refs):
            check = "入口已核对，动态参数待核验"
        if not refs and case["ownership"] != "human":
            check = "尚无测试入口"
        record = records.get(key)
        if record:
            actual_parameters = record.get("inputs", {}).get("actual_pytest_parameters", {})
            for ref in refs:
                if ref["parameters"] and actual_parameters:
                    require(
                        all(
                            name in actual_parameters and actual_parameters[name] == value
                            for name, value in ref["parameters"].items()
                        ),
                        f"实际参数与静态场景不符: {key}",
                    )
        verdict = (
            VERDICTS.get(record.get("verdict"), "未执行")
            if record
            else (
                "待人工核验"
                if case["ownership"] == "human"
                else "本轮范围外"
                if results and results["phase"] == "executed" and key not in selected
                else "未执行"
            )
        )
        actual_link = runtime_matches(case, record) if record and record.get("node_id") else ""
        if case["ownership"] == "human":
            check = "独立人工项"
        business = []
        for label, field in (
            ("前置条件", "preconditions"),
            ("步骤", "steps"),
            ("最终预期", "expected"),
        ):
            items = "".join(f"<li>{esc(s)}</li>" for s in case[field])
            business.append(f"<h4>{label}</h4><ol>{items}</ol>")
        details = [f"<p>关联核对：{esc(check)}。静态引用存在不证明调用顺序或业务预期已通过。</p>"]
        if data.get("design_model") is not None:
            details.append(
                f"<p>业务覆盖项：{esc(', '.join(case['coverage_ids']))}；"
                f"判据：{esc(case['oracle_status'])}；数据：{esc(case['data_status'])}</p>"
            )
        if case.get("candidate_oracle"):
            candidate = case["candidate_oracle"]
            details.append(
                "<h4>待确认假设（不能作为验收结论）</h4>"
                f"<p>候选结果：{esc(candidate['expectation'])}</p>"
                f"<p>推导依据：{esc(candidate['basis'])}</p>"
                f"<p>待决问题：{esc(candidate['question'])}</p>"
            )
        if auto.get("reason"):
            details.append(f"<p>实现说明：{esc(auto['reason'])}</p>")
        details += ["<h4>测试入口与参数</h4><ul>"]
        for ref in refs:
            parameters = (
                json.dumps(ref["parameters"], ensure_ascii=False)
                if ref["parameters"] is not None
                else "无静态参数映射；按实际运行记录核对"
            )
            details.append(f"<li>{code_link(ref['ref'])}<br>静态参数：{esc(parameters)}</li>")
        details.append("</ul><h4>声明复用的流程与能力</h4><ul>")
        for asset in assets:
            code = asset.get("code", {})
            reference = code.get("path", "") + "::" + code.get("symbol", "")
            content = code_link(reference) if code else "尚未核验代码位置"
            dependencies = (
                " → ".join(links.assets[x].get("title", x) for x in asset.get("uses", []))
                if links.repo
                else " → ".join(asset.get("uses", []))
            )
            details.append(
                f"<li>{esc(asset.get('title', asset['id']))}：{content}"
                + (f"<br>登记的依赖顺序：{esc(dependencies)}" if dependencies else "")
                + "</li>"
            )
        details.append("</ul><h4>业务步骤与代码的关联</h4>")
        step_rows = []
        for step in auto.get("steps", []):
            step_refs = [links.reference(r) for r in step.get("code_refs", [])]
            related = [code_link(r["ref"]) for r in step_refs]
            related += [esc(links.asset(a).get("title", a)) for a in step.get("asset_ids", [])]
            expected = "；".join(case["expected"][i - 1] for i in step.get("expected_indexes", []))
            step_rows.append(
                f"<tr><td>{step['step']}. {esc(case['steps'][step['step'] - 1])}</td>"
                f"<td>{'<br>'.join(related)}</td>"
                f"<td>{esc(expected or '动作关联；未声明该步独立预期')}</td></tr>"
            )
        if step_rows:
            details.append(
                "<table><tr><th>业务步骤</th><th>代码/流程</th><th>关联的最终预期</th></tr>"
                + "".join(step_rows)
                + "</table>"
            )
        else:
            details.append(
                "<p>尚未登记步骤级关联；本页只确认上述用例级声明，不推断每一步均被自动化覆盖。</p>"
            )
        details.append(
            f"<p>判定依据：{esc(case['oracle'])}</p>"
            f"<p>覆盖边界：{esc(case.get('scope', '以本用例前置、步骤和预期为限'))}</p>"
        )
        if case.get("review_case_ids"):
            details.append(
                "<p>仍需独立人工复核："
                + "、".join(esc(x) for x in case["review_case_ids"])
                + "</p>"
            )
        if case["ownership"] == "human":
            details.append(f"<p>人工原因：{esc(case['why_human'])}</p>")
        if record:
            details.append(
                f"<h4>本次载入的运行记录</h4><p>{esc(record.get('actual', '尚未执行'))}</p>"
            )
            details.append(
                f"<p>实际运行入口：{esc(record.get('node_id', '未记录'))}<br>{esc(actual_link)}</p>"
            )
            if results_base:
                paths = record.get("evidence", {}).get("after", [])
                details.append(
                    "<p>证据："
                    + "　".join(href(Path(results_base) / p, Path(p).name) for p in paths)
                    + "</p>"
                )
        if case.get("blocked_by") and (not record or results["phase"] == "planned"):
            details.append(
                "<p>规划时记录的前置缺口（不是当前环境诊断）："
                + esc("；".join(case["blocked_by"]))
                + "</p>"
            )
        search_text = esc(key + " " + case["title"] + " " + " ".join(case["ac_ids"]))
        sections.append(
            f'<article data-search="{search_text}" data-verdict="{esc(verdict)}">'
            f"<h2>{esc(key)} · {esc(case['title'])}</h2>"
            f'<p class="tags">{esc(implementation)}　|　{esc(verdict)}　|　'
            f"{esc(', '.join(case['ac_ids']))}</p>"
            "<details open><summary>业务用例</summary>" + "".join(business) + "</details>"
            "<details><summary>查看自动化流程、步骤关联和运行证据</summary>"
            + "".join(details)
            + "</details></article>"
        )
        index.append(
            {
                "case_id": key,
                "implementation": implementation,
                "verdict": verdict,
                "reference_check": check,
                "runtime_link": actual_link,
                "python_refs": refs,
                "asset_ids": case.get("asset_ids", []),
            }
        )
    counts = Counter(item["verdict"] for item in index)
    summary = "　".join(f"{name} {count}" for name, count in counts.items())
    csv_status = (
        "草稿：缺少所属模块或导入优先级，请补齐后再导入"
        if missing
        else "导入字段已齐备；尚未进行禅道实际导入验证"
    )
    runtime = "未执行UI测试；仅生成用例与关联材料"
    if results and results["phase"] == "executed":
        environment = next(
            (
                r.get("context", {}).get("environment")
                for r in records.values()
                if r.get("context", {}).get("environment")
            ),
            "详见原运行报告",
        )
        runtime = (
            f"载入的历史运行：{results.get('run_id')}；时间 {results.get('executed_at')}；"
            f"环境 {environment}。"
            "本次生成页面没有重新执行测试。版本依据见技术报告。"
        )
    options = "".join(f'<option value="{esc(s)}">{esc(s)}</option>' for s in counts)
    payload = {
        "schema_version": 1,
        "story_id": data["story_id"],
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "csv": csv_name,
        "csv_status": "draft" if missing else "ready",
        "missing_export_fields": missing,
        "warnings": list(dict.fromkeys(links.warnings)),
        "design_coverage": design,
        "cases": index,
    }
    page = (
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
    )
    page += f"<title>{esc(data['requirement_name'])} · 业务用例与自动化关联</title>"
    page += """<style>
body{font:15px/1.75 system-ui,sans-serif;background:#f4f7fa;color:#1b2d3a;
max-width:1160px;margin:36px auto;padding:0 22px}
h1{font-size:28px}h2{font-size:20px}h4{margin:16px 0 6px}
section,article{background:white;border:1px solid #dce4eb;
border-radius:12px;padding:22px;margin:18px 0}
a{color:#135a98;overflow-wrap:anywhere}summary{cursor:pointer;font-weight:650}
details{margin:12px 0}li{margin:4px 0;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse}
td,th{padding:10px;text-align:left;vertical-align:top;
border-bottom:1px solid #dce4eb;overflow-wrap:anywhere}
.tags{color:#365b77}.notice{border-left:4px solid #bc8b26}
input,select{font:inherit;padding:9px;max-width:95%}input{width:66%}
.muted{color:#566b7a}</style>"""
    page += (
        f"<h1>{esc(data['requirement_name'])}</h1>"
        f'<p class="muted">业务用例与自动化关联 · 需求 {esc(data["story_id"])}'
        f" · 共 {len(index)} 条</p>"
        f'<section class="notice"><p>{esc(csv_status)}</p><p>{esc(runtime)}</p>'
        "<p>实现状态与执行结果分别展示；流程被关联不代表已调用，静态检查不计作测试通过。</p></section>"
        f"<section><h2>用例与结果概览</h2><p>{esc(summary)}</p><p>"
        + href(Path(out) / csv_name, "下载业务用例CSV（全部AI与人工场景）")
        + '</p><input id="search" type="search" placeholder="按用例编号、名称或验收点筛选"> '
        f'<select id="status"><option value="">全部结果</option>{options}</select></section>'
    )
    page += design_html(data)
    page += "".join(sections)
    page += "<section><details><summary>技术附件与关联校验说明</summary><p>"
    if attachments is None:
        attachments = {
            filename: Path(out) / filename
            for filename in (
                "01-requirement-risk-analysis.md",
                "02-ai-browser-test-cases.md",
                "03-manual-test.xmind",
                "04-ai-execution-evidence-report.md",
                "test-cases.json",
                "execution-results.json",
            )
        }
    for filename, path in {
        **attachments,
        "06-automation-links.json": Path(out) / "06-automation-links.json",
    }.items():
        page += href(path, filename) + "<br>"
    page += (
        "</p><p>"
        + esc(
            "；".join(payload["warnings"])
            or "当前引用已静态核对；调用语义和覆盖充分性仍需源码审阅及真实执行证据。"
        )
        + "</p></details></section>"
    )
    page += """<script>
function filter(){
  let q=document.querySelector('#search').value.toLowerCase();
  let v=document.querySelector('#status').value;
  document.querySelectorAll('[data-search]').forEach(n=>{
    n.hidden=!(n.dataset.search.toLowerCase().includes(q)&&(!v||n.dataset.verdict===v));
  });
}
document.querySelector('#search').addEventListener('input',filter);
document.querySelector('#status').addEventListener('change',filter);
</script></html>"""
    return {
        csv_name: csv_payload,
        "00-test-case-automation.html": page.encode("utf-8"),
        "06-automation-links.json": (
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8"),
    }, payload
