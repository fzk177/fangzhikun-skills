"""Local regression tests for business exports and static links; no business UI access."""

import copy
import csv
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from business_artifacts import (
    CSV_COLUMNS,
    StaticLinks,
    csv_bytes,
    render_artifacts,
    validate_extensions,
)
from design_coverage import design_html, design_markdown, model_digest, validate_design
from test_artifacts import assess_results, load_manifest, plan


class BusinessArtifactsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="business-artifacts-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "automation"
        self.out = self.root / "delivery"
        self.test_path = "projects/p/tests/test_sample.py"
        test_file = self.repo / self.test_path
        test_file.parent.mkdir(parents=True)
        test_file.write_text(
            'raise RuntimeError("MUST NOT IMPORT")\n'
            "import pytest\n"
            '@pytest.mark.parametrize("value", [7], ids=["C-1"])\n'
            "def test_it(value):\n    assert value == 7\n"
            "def check_value():\n    return True\n",
            encoding="utf-8",
        )
        action = self.repo / "projects/p/cases/actions.py"
        action.parent.mkdir()
        action.write_text("def add_item():\n    return 7\n", encoding="utf-8")
        self.asset = {
            "id": "p.case.add",
            "title": "增加业务项",
            "kind": "case",
            "code": {
                "path": "projects/p/cases/actions.py",
                "symbol": "add_item",
                "sha256": hashlib.sha256(action.read_bytes()).hexdigest(),
            },
            "uses": [],
        }
        self.catalog_path = self.repo / "projects/p/specs/catalog.yaml"
        self.catalog_path.parent.mkdir()
        self.write_catalog([self.asset])
        case = {
            "id": "C-1",
            "title": '中文业务，含"引号"',
            "group": "业务主题",
            "ownership": "ai",
            "risk": "P1",
            "risk_ids": ["R-1"],
            "ac_ids": ["AC-1"],
            "sources": ["测试夹具中的需求材料"],
            "preconditions": ["第一行", "第二行"],
            "steps": ["打开业务页", "增加业务项"],
            "expected": ["业务项正确显示"],
            "oracle": "独立业务规则",
            "evidence": ["页面证据"],
            "writes_data": False,
            "persistence_required": False,
            "cleanup": "关闭独立页面",
            "asset_ids": ["p.case.add"],
            "python_refs": [self.test_path + "::test_it[C-1]"],
            "automation": {
                "state": "implemented",
                "steps": [
                    {
                        "step": 2,
                        "asset_ids": ["p.case.add"],
                        "code_refs": [self.test_path + "::check_value"],
                        "expected_indexes": [1],
                    }
                ],
            },
        }
        manual = {
            **copy.deepcopy(case),
            "id": "H-1",
            "title": "人工业务核验",
            "ownership": "human",
            "asset_ids": [],
            "python_refs": [],
            "why_human": "需要独立领域材料",
            "method_evidence": ["人工材料"],
            "automation": {"state": "manual"},
        }
        self.data = {
            "schema_version": 1,
            "requirement_name": "仅用于回归的虚构需求",
            "story_id": "123",
            "project": "p",
            "analysis": {"change": "测试变化", "old_behavior": "原规则", "new_behavior": "新规则"},
            "risks": [{"id": "R-1", "title": "业务风险", "impact": "影响", "priority": "P1"}],
            "cases": [case, manual],
            "data_allocations": [],
            "regressions": [],
            "zentao_export": {"module": "/虚构模块(#1)", "priority": "2"},
        }

    def with_design(self):
        data = copy.deepcopy(self.data)
        data["design_model"] = {
            "schema_version": 1,
            "design_method_version": 2,
            "scope": "局部业务项显示及独立领域检查",
            "materials": [
                {
                    "id": "M-1",
                    "kind": "requirement",
                    "reference": "虚构需求123 §1",
                    "status": "available",
                    "summary": "新增业务项后显示当前值",
                }
            ],
            "objects": [
                {
                    "id": "O-1",
                    "name": "业务项",
                    "identity": "业务项ID",
                    "states": ["可见"],
                    "source_ids": ["M-1"],
                }
            ],
            "dimensions": [
                {
                    "id": "D-1",
                    "name": "角色",
                    "object_ids": ["O-1"],
                    "values": ["可读取", "不可读取"],
                    "constraints": [],
                }
            ],
            "rules": [
                {
                    "id": "B-1",
                    "description": "有权限用户看到业务项",
                    "object_ids": ["O-1"],
                    "source_ids": ["M-1"],
                    "basis": "confirmed",
                    "conditions": ["当前角色可读取"],
                    "actions": ["新增并查看"],
                    "outcomes": ["仅当前项出现"],
                }
            ],
            "impacts": [
                {
                    "id": "I-1",
                    "object_id": "O-1",
                    "consumer": "业务项列表",
                    "via": "保存后列表读取",
                    "source_ids": ["M-1"],
                    "disposition": "affected",
                    "reason": "新增项在列表可见",
                }
            ],
            "discovery": [
                {
                    "id": "S-1",
                    "object_id": "O-1",
                    "seeds": ["业务项ID", "列表读取"],
                    "searches": [
                        {
                            "query": "业务项ID/列表读取",
                            "scope": "虚构需求123 §1 的局部对象边界",
                            "evidence": ["虚构需求123 §1：保存后列表读取新增业务项"],
                            "impact_ids": ["I-1"],
                            "result": "发现业务项列表消费者",
                        }
                    ],
                    "stopping_reason": "需求明确限定独立列表，无额外消费者；未外推全库边界",
                }
            ],
            "branches": [
                {
                    "id": "BR-1",
                    "rule_ids": ["B-1"],
                    "impact_ids": ["I-1"],
                    "conditions": ["当前角色可读取"],
                    "action": "新增一个业务项",
                    "outcome": "列表仅出现当前范围内的新业务项",
                    "basis": "confirmed",
                    "coverage_ids": ["V-1"],
                }
            ],
            "coverage_items": [
                {
                    "id": "V-1",
                    "title": "可读取角色查看新增业务项",
                    "rule_ids": ["B-1"],
                    "impact_ids": ["I-1"],
                    "kind": "normal",
                    "conditions": ["可读取角色"],
                    "context": {"D-1": "可读取"},
                    "disposition": "designed",
                }
            ],
            "review": {
                "status": "pending",
                "method": "",
                "findings": [],
                "limitations": ["虚构局部材料，不代表真实产品"],
            },
        }
        for c in data["cases"]:
            c.update(coverage_ids=["V-1"], oracle_status="confirmed", data_status="not_required")
        return data

    def test_new_plan_requires_model_before_writing(self):
        source = self.root / "manifest.json"
        source.write_text(json.dumps(self.data))
        with self.assertRaisesRegex(ValueError, "new plans require"):
            plan(source, self.out, "new-plan", self.repo)
        self.assertFalse(self.out.exists())

    def test_model_plan_projects_coverage_and_gaps(self):
        data = self.with_design()
        item = copy.deepcopy(data["design_model"]["coverage_items"][0])
        item.update(
            id="V-2",
            title="不可读取角色的独立分支",
            kind="permission",
            context={"D-1": "不可读取"},
            conditions=["不可读取角色"],
            disposition="uncovered",
            reason="尚未完成该分支的具体用例",
        )
        data["design_model"]["coverage_items"].append(item)
        branch = copy.deepcopy(data["design_model"]["branches"][0])
        branch.update(
            id="BR-2",
            coverage_ids=["V-2"],
            conditions=["不可读取角色"],
            outcome="列表不显示新业务项",
            basis="inferred",
        )
        data["design_model"]["branches"].append(branch)
        source = self.root / "manifest.json"
        source.write_text(json.dumps(data))
        result = plan(source, self.out, "new-plan", self.repo)
        self.assertEqual(result["design_counts"], {"designed": 1, "uncovered": 1})
        self.assertTrue(result["design_warnings"])
        page = (self.out / "00-test-case-automation.html").read_text()
        self.assertIn("尚未完成该分支的具体用例", page)
        report = (self.out / "01-requirement-risk-analysis.md").read_text()
        self.assertIn("尚未设计 1", report)
        self.assertIn("不证明材料齐全", report)

    def test_model_rejects_orphan_rules_and_consumers(self):
        for key, prefix in [("rules", "B"), ("impacts", "I")]:
            data = self.with_design()
            extra = copy.deepcopy(data["design_model"][key][0])
            extra["id"] = prefix + "-2"
            data["design_model"][key].append(extra)
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "no coverage disposition"),
            ):
                validate_design(data)

    def test_model_rejects_false_coverage_and_bad_context(self):
        mutations = [
            lambda d: d["cases"][0].update(coverage_ids=["unknown"]),
            lambda d: d["design_model"]["coverage_items"][0].update(id="V-2"),
            lambda d: d["design_model"]["coverage_items"][0].update(context={"D-1": "非法角色"}),
            lambda d: d["design_model"]["coverage_items"][0].update(
                disposition="excluded", reason="范围外"
            ),
            lambda d: d["design_model"]["impacts"][0].update(disposition="unknown"),
        ]
        for mutation in mutations:
            data = self.with_design()
            mutation(data)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_design(data)

    def test_inferred_rules_remain_pending_with_concrete_gap(self):
        data = self.with_design()
        rule = data["design_model"]["rules"][0]
        rule.update(basis="inferred", question="该读取规则是否适用于跨角色?")
        with self.assertRaisesRegex(ValueError, "unconfirmed rules"):
            validate_design(data)
        item = data["design_model"]["coverage_items"][0]
        item.update(disposition="blocked", reason="等待跨角色口径确认")
        for c in data["cases"]:
            self.make_pending(c)
        summary = validate_design(data)
        self.assertEqual(summary["counts"], {"blocked": 1})
        self.assertTrue(summary["warnings"])

    def test_code_or_qa_cannot_be_only_confirmation(self):
        for kind in ["code", "qa", "history", "defect"]:
            data = self.with_design()
            data["design_model"]["materials"][0]["kind"] = kind
            with (
                self.subTest(kind=kind),
                self.assertRaisesRegex(ValueError, "cannot be confirmed solely"),
            ):
                validate_design(data)

    @staticmethod
    def make_pending(case):
        case.update(
            oracle_status="pending",
            blocked_by=["等待跨角色口径"],
            candidate_oracle={
                "expectation": "切换到不可读取角色后列表隐藏此前新增业务项",
                "basis": "由当前角色可读取规则推导角色隔离的候选行为",
                "question": "角色切换后列表是否立即刷新读取范围？",
            },
        )

    def test_method_two_requires_investigation_for_every_object(self):
        for mutation, message in [
            (lambda m: m.pop("discovery"), "discovery must be an array"),
            (lambda m: m.update(discovery=[]), "discovery must be an array"),
            (
                lambda m: m["objects"].append({**m["objects"][0], "id": "O-2"}),
                "O-2 has no discovery record",
            ),
            (lambda m: m["discovery"][0].update(object_id="unknown"), "unknown object"),
            (lambda m: m["discovery"][0].update(seeds=[]), "discovery seeds"),
            (lambda m: m["discovery"][0].update(stopping_reason=""), "stopping_reason"),
            (lambda m: m["discovery"][0].update(searches=[]), "needs searches"),
            (lambda m: m["discovery"][0]["searches"][0].update(evidence=[]), "search evidence"),
            (
                lambda m: m["discovery"][0]["searches"][0].update(impact_ids=["missing"]),
                "unknown/duplicate IDs",
            ),
            (lambda m: m["discovery"][0]["searches"][0].update(result=""), "query/scope/result"),
        ]:
            data = self.with_design()
            mutation(data["design_model"])
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                validate_design(data)

    def test_method_two_accepts_documented_empty_or_restricted_search(self):
        for result in ["局部范围无额外消费者", "查询权限受限，无法确认外部调用者"]:
            data = self.with_design()
            search = data["design_model"]["discovery"][0]["searches"][0]
            search.update(impact_ids=[], result=result, evidence=["查询业务项外部调用：返回0条"])
            self.assertEqual(
                validate_design(data)["branch_counts"], {"confirmed": 1, "candidate": 0}
            )

    def test_branches_require_structure_and_cover_each_coverage_item(self):
        for mutation, message in [
            (lambda m: m.pop("branches"), "branches must be an array"),
            (lambda m: m["branches"][0].update(rule_ids=[]), "rule_ids is invalid"),
            (lambda m: m["branches"][0].update(impact_ids=["missing"]), "unknown/duplicate IDs"),
            (lambda m: m["branches"][0].update(coverage_ids=["missing"]), "unknown/duplicate IDs"),
            (lambda m: m["branches"][0].update(conditions=[]), "needs conditions"),
            (lambda m: m["branches"][0].update(action=""), "action/outcome"),
            (lambda m: m["branches"][0].update(outcome=""), "action/outcome"),
            (lambda m: m["branches"][0].update(basis="question"), "invalid basis"),
            (
                lambda m: m["coverage_items"].append(
                    {
                        **m["coverage_items"][0],
                        "id": "V-2",
                        "disposition": "uncovered",
                        "reason": "未设计",
                    }
                ),
                "V-2 has no branch",
            ),
        ]:
            data = self.with_design()
            mutation(data["design_model"])
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                validate_design(data)

    def test_branch_references_must_belong_to_its_coverage_items(self):
        for field, collection, prefix in [
            ("rule_ids", "rules", "B"),
            ("impact_ids", "impacts", "I"),
        ]:
            data = self.with_design()
            model = data["design_model"]
            model[collection].append({**model[collection][0], "id": prefix + "-2"})
            model["coverage_items"].append(
                {
                    **model["coverage_items"][0],
                    "id": "V-2",
                    field: [prefix + "-2"],
                    "disposition": "uncovered",
                    "reason": "未设计新分支",
                }
            )
            model["branches"][0][field] = [prefix + "-2"]
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "must belong"):
                validate_design(data)

    def test_candidate_branch_cannot_count_as_designed(self):
        for basis in ["inferred", "unknown", "conflict"]:
            data = self.with_design()
            data["design_model"]["branches"][0]["basis"] = basis
            with (
                self.subTest(basis=basis),
                self.assertRaisesRegex(ValueError, "unconfirmed branch"),
            ):
                validate_design(data)

    def test_branch_can_reference_union_of_its_linked_coverage_items(self):
        data = self.with_design()
        model = data["design_model"]
        model["rules"].append({**model["rules"][0], "id": "B-2"})
        model["impacts"].append({**model["impacts"][0], "id": "I-2"})
        model["coverage_items"].append(
            {
                **model["coverage_items"][0],
                "id": "V-2",
                "rule_ids": ["B-2"],
                "impact_ids": ["I-2"],
                "disposition": "uncovered",
                "reason": "尚未设计另一个判据",
            }
        )
        model["branches"][0].update(
            rule_ids=["B-1", "B-2"],
            impact_ids=["I-1", "I-2"],
            coverage_ids=["V-1", "V-2"],
        )
        self.assertEqual(validate_design(data)["counts"], {"designed": 1, "uncovered": 1})

    def test_pending_candidate_fields_required_and_bound_to_review(self):
        data = self.with_design()
        model = data["design_model"]
        model["coverage_items"][0].update(disposition="blocked", reason="等待角色切换口径")
        for case in data["cases"]:
            self.make_pending(case)
        for field in ["expectation", "basis", "question"]:
            changed = copy.deepcopy(data)
            changed["cases"][0]["candidate_oracle"][field] = ""
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "candidate_oracle"):
                validate_design(changed)
        changed = copy.deepcopy(data)
        changed["cases"][0].pop("candidate_oracle")
        with self.assertRaisesRegex(ValueError, "candidate_oracle"):
            validate_design(changed)
        model["review"].update(
            status="reviewed",
            method="候选分支审查",
            model_sha256=model_digest(model, data["cases"]),
        )
        data["cases"][0]["candidate_oracle"]["expectation"] = "切换角色后保留业务项"
        with self.assertRaisesRegex(ValueError, "current model hash"):
            validate_design(data)

    def test_discovery_branches_and_candidate_oracles_render_in_both_formats(self):
        data = self.with_design()
        model = data["design_model"]
        model["coverage_items"][0].update(disposition="blocked", reason="等待角色切换口径")
        model["branches"][0]["basis"] = "inferred"
        for case in data["cases"]:
            self.make_pending(case)
        for rendered in [design_html(data), design_markdown(data)]:
            for value in [
                model["discovery"][0]["stopping_reason"],
                *model["discovery"][0]["searches"][0]["evidence"],
                model["discovery"][0]["searches"][0]["query"],
                model["discovery"][0]["searches"][0]["scope"],
                model["discovery"][0]["searches"][0]["result"],
                model["branches"][0]["action"],
                model["branches"][0]["outcome"],
                *model["branches"][0]["conditions"],
                *data["cases"][0]["candidate_oracle"].values(),
                "已确认 0",
                "候选待确认 1",
                "不代表完整覆盖",
                "待确认假设",
            ]:
                with self.subTest(value=value):
                    self.assertIn(value, rendered)

    def test_old_model_remains_readable_and_requires_explicit_legacy_plan(self):
        data = self.with_design()
        for key in ["design_method_version", "discovery", "branches"]:
            data["design_model"].pop(key)
        # Golden 1.5 digest: adding optional candidate fields must not invalidate old reviews.
        legacy_digest = "5c7a25b603f6807d03357c26a10c2685d00467ac9b1e999f579c8fc810454a0c"
        self.assertEqual(model_digest(data["design_model"], data["cases"]), legacy_digest)
        data["design_model"]["review"].update(
            status="reviewed",
            method="既有1.5审查",
            model_sha256=legacy_digest,
        )
        self.assertEqual(validate_design(data)["counts"], {"designed": 1})
        self.assertIn("V-1", design_html(data))
        self.assertIn("V-1", design_markdown(data))
        with self.assertRaisesRegex(ValueError, "design_method_version=2"):
            validate_design(data, required=True)
        source = self.root / "legacy-model.json"
        source.write_text(json.dumps(data))
        plan(source, self.out, "legacy-plan", self.repo, allow_legacy_design=True)
        self.assertTrue((self.out / "00-test-case-automation.html").exists())

    def test_review_hash_invalidated_after_model_change(self):
        data = self.with_design()
        model = data["design_model"]
        model["review"].update(
            status="reviewed",
            method="从规则反查用例",
            model_sha256=model_digest(model, data["cases"]),
        )
        self.assertEqual(validate_design(data)["status"], "reviewed")
        model["rules"][0]["outcomes"] = ["新增项只在当前范围显示"]
        with self.assertRaisesRegex(ValueError, "current model hash"):
            validate_design(data)

    def test_pending_or_unprepared_cases_cannot_pass(self):
        for field, value, message in [
            ("oracle_status", "pending", "unresolved oracle"),
            ("data_status", "needed", "unprepared data"),
        ]:
            data = self.with_design()
            case = data["cases"][0]
            case[field] = value
            if field == "oracle_status":
                self.make_pending(case)
            result = {
                "schema_version": 1,
                "manifest_sha256": "digest",
                "run_id": "regression",
                "phase": "executed",
                "selected_case_ids": ["C-1"],
                "results": [
                    {
                        "case_id": "C-1",
                        "verdict": "Passed",
                        "actual": "显示",
                        "context": {"page": "local fixture"},
                        "cleanup": "无副作用",
                        "evidence": {"rating": "E0"},
                    }
                ],
            }
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, message):
                assess_results(
                    data, {c["id"]: c for c in data["cases"]}, "digest", result, self.root
                )

    def test_pending_oracle_cannot_confirm_product_bug(self):
        for confirmed_bug in [False, True]:
            data = self.with_design()
            self.make_pending(data["cases"][0])
            row = {
                "case_id": "C-1",
                "verdict": "Failed",
                "actual": "观察到差异",
                "context": {"page": "local fixture"},
                "cleanup": "无副作用",
                "failure_category": "product",
                "confirmed_bug": confirmed_bug,
                "evidence": {"rating": "E0"},
            }
            results = {
                "schema_version": 1,
                "manifest_sha256": "digest",
                "run_id": "local-regression",
                "phase": "executed",
                "selected_case_ids": ["C-1"],
                "results": [row],
            }
            with (
                self.subTest(confirmed_bug=confirmed_bug),
                self.assertRaisesRegex(
                    ValueError, "unresolved oracle cannot confirm product failure"
                ),
            ):
                assess_results(
                    data, {c["id"]: c for c in data["cases"]}, "digest", results, self.root
                )

    def test_linked_blocker_reason_question_and_review_remain_visible(self):
        data = self.with_design()
        model = data["design_model"]
        model["rules"][0].update(basis="unknown", question="角色切换后是否保留来源范围?")
        model["coverage_items"][0].update(disposition="blocked", reason="缺少角色切换业务口径")
        model["review"].update(
            findings=["已发现角色边界未确认"], limitations=["当前仅有虚构需求材料"]
        )
        for c in data["cases"]:
            self.make_pending(c)
        source = self.root / "manifest.json"
        source.write_text(json.dumps(data))
        plan(source, self.out, "new-plan", self.repo)
        for name in ["00-test-case-automation.html", "01-requirement-risk-analysis.md"]:
            rendered = (self.out / name).read_text()
            for value in [
                "缺少角色切换业务口径",
                "角色切换后是否保留来源范围?",
                "已发现角色边界未确认",
                "当前仅有虚构需求材料",
            ]:
                self.assertIn(value, rendered)

    def test_review_hash_binds_case_risk_and_oracle_changes(self):
        for field, value in [
            ("risk", "P0"),
            ("ownership", "ai_review"),
            ("expected", ["新的业务判据"]),
        ]:
            data = self.with_design()
            model = data["design_model"]
            model["review"].update(
                status="reviewed",
                method="语义审查",
                model_sha256=model_digest(model, data["cases"]),
            )
            data["cases"][0][field] = value
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "current model hash"),
            ):
                validate_design(data)

    def test_review_binds_verification_scope_but_ignores_implementation_refs(self):
        for field, value in [
            ("scope", "扩大业务范围"),
            ("evidence", ["新的证据要求"]),
            ("why_human", "另一领域判据"),
            ("method_evidence", ["额外工具证据"]),
        ]:
            data = self.with_design()
            model = data["design_model"]
            model["review"].update(
                status="reviewed",
                method="语义审查",
                model_sha256=model_digest(model, data["cases"]),
            )
            data["cases"][0][field] = value
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "current model hash"),
            ):
                validate_design(data)
        data = self.with_design()
        data["cases"][0]["technical"] = {"scope": "局部字段", "code_ref": "old.py"}
        model = data["design_model"]
        model["review"].update(
            status="reviewed", method="语义审查", model_sha256=model_digest(model, data["cases"])
        )
        data["cases"][0]["technical"]["code_ref"] = "new.py"
        self.assertEqual(validate_design(data)["status"], "reviewed")
        data["cases"][0]["technical"]["scope"] = "完整业务对象"
        with self.assertRaisesRegex(ValueError, "current model hash"):
            validate_design(data)

    def write_catalog(self, assets):
        self.catalog_path.write_text(
            json.dumps({"project": "p", "assets": assets}), encoding="utf-8"
        )

    def render(self, data=None, **kwargs):
        return render_artifacts(data or self.data, self.out, self.repo, **kwargs)

    def test_csv_roundtrip_and_manual_cases(self):
        payload, missing = csv_bytes(self.data)
        self.assertTrue(payload.startswith(b"\xef\xbb\xbf"))
        rows = list(csv.DictReader(io.StringIO(payload.decode("utf-8-sig"))))
        self.assertEqual(list(rows[0]), CSV_COLUMNS)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["用例名称"], self.data["cases"][0]["title"])
        self.assertEqual(rows[0]["前置条件"], "第一行\n第二行")
        self.assertIn("用例ID:C-1", rows[0]["关键词"])
        self.assertEqual(rows[1]["用例名称"], "人工业务核验")
        self.assertEqual(missing, [])

    def test_no_forced_step_expected_zip(self):
        payload, _ = csv_bytes(self.data)
        rows = list(csv.DictReader(io.StringIO(payload.decode("utf-8-sig"))))
        self.assertIn("2. 增加业务项", rows[0]["步骤"])
        self.assertEqual(rows[0]["预期"], "1. 业务项正确显示")

    def test_draft_when_import_metadata_missing(self):
        del self.data["zentao_export"]
        files, index = self.render()
        self.assertIn("05-business-test-cases-draft.csv", files)
        self.assertEqual(index["csv_status"], "draft")
        self.assertEqual(len(index["missing_export_fields"]), 2)

    def test_static_parameters_without_importing_test(self):
        _, index = self.render()
        self.assertEqual(index["cases"][0]["python_refs"][0]["parameters"], {"value": 7})
        self.assertEqual(index["cases"][0]["verdict"], "未执行")

    def test_missing_file_symbol_and_parameter_rejected(self):
        for ref in (
            "projects/p/tests/missing.py::test_it",
            self.test_path + "::missing",
            self.test_path + "::test_it[C-NOT-FOUND]",
        ):
            with self.subTest(ref=ref):
                self.data["cases"][0]["python_refs"] = [ref]
                with self.assertRaises(ValueError):
                    self.render()

    def test_missing_asset_rejected(self):
        self.data["cases"][0]["asset_ids"] = ["p.case.missing"]
        with self.assertRaises(ValueError):
            self.render()

    def test_dependency_cycle_and_missing_dependency_rejected(self):
        for dependency in ("p.case.add", "p.case.unknown"):
            self.asset["uses"] = [dependency]
            self.write_catalog([self.asset])
            with self.assertRaises(ValueError):
                self.render()

    def test_changed_asset_hash_rejected(self):
        (self.repo / self.asset["code"]["path"]).write_text("def add_item():\n    return 9\n")
        with self.assertRaises(ValueError):
            self.render()

    def test_path_and_symlink_cannot_escape_repo(self):
        outside = self.root / "outside.py"
        outside.write_text("def test_it(): pass\n")
        (self.repo / "alias.py").symlink_to(outside)
        for ref in ("../outside.py::test_it", "alias.py::test_it"):
            self.data["cases"][0]["python_refs"] = [ref]
            with self.assertRaises(ValueError):
                self.render()

    def test_step_and_expected_links_are_bounded(self):
        for changes in ({"step": 99}, {"expected_indexes": [99]}, {"asset_ids": ["unknown"]}):
            data = copy.deepcopy(self.data)
            data["cases"][0]["automation"]["steps"][0].update(changes)
            with self.assertRaises(ValueError):
                self.render(data)

    def test_export_priority_is_not_risk(self):
        self.data["zentao_export"]["priority"] = "P1"
        with self.assertRaises(ValueError):
            validate_extensions(self.data)

    def test_formula_rejected_and_html_escaped(self):
        self.data["cases"][0]["title"] = "=EXECUTE()"
        with self.assertRaises(ValueError):
            self.render()
        self.data["cases"][0]["title"] = '<script>alert("not executed")</script>'
        files, _ = self.render()
        page = files["00-test-case-automation.html"].decode()
        self.assertIn("&lt;script&gt;", page)
        self.assertNotIn('<script>alert("not executed")</script>', page)

    def test_legacy_manifest_load_and_plan_with_new_deliverables(self):
        for case in self.data["cases"]:
            case.pop("automation")
        self.data.pop("zentao_export")
        source = self.root / "test-cases.json"
        source.write_text(json.dumps(self.data))
        load_manifest(source)
        result = plan(source, self.out, "local-test", self.repo, allow_legacy_design=True)
        self.assertEqual(result["csv_status"], "draft")
        self.assertTrue((self.out / "03-manual-test.xmind").is_file())
        self.assertTrue((self.out / "00-test-case-automation.html").is_file())
        with self.assertRaises(ValueError):
            plan(source, self.out, "must-not-overwrite", self.repo, allow_legacy_design=True)

    def test_invalid_refs_do_not_write_partial_plan(self):
        self.data["cases"][0]["python_refs"] = [self.test_path + "::missing"]
        source = self.root / "test-cases.json"
        source.write_text(json.dumps(self.data))
        with self.assertRaises(ValueError):
            plan(source, self.out, "local-test", self.repo, allow_legacy_design=True)
        self.assertFalse(self.out.exists())

    def test_no_repo_reports_unverified(self):
        _, index = render_artifacts(self.data, self.out)
        self.assertTrue(index["warnings"])
        self.assertEqual(index["cases"][0]["reference_check"], "代码/参数待核验")

    def test_runtime_identity_and_parameters_checked(self):
        record = {
            "case_id": "C-1",
            "verdict": "Blocked",
            "actual": "前置不满足",
            "node_id": self.test_path + "::test_it[chromium-C-1]",
            "inputs": {"actual_pytest_parameters": {"value": 7}},
        }
        results = {"phase": "executed", "selected_case_ids": ["C-1"], "results": [record]}
        _, index = self.render(results=results)
        self.assertEqual(index["cases"][0]["verdict"], "阻塞")
        self.assertIn("不代表全部流程", index["cases"][0]["runtime_link"])
        record["node_id"] = self.test_path + "::test_it[chromium-C-OTHER]"
        with self.assertRaises(ValueError):
            self.render(results=results)
        record["node_id"] = self.test_path + "::test_it[chromium-C-1]"
        record["inputs"]["actual_pytest_parameters"]["value"] = 9
        with self.assertRaises(ValueError):
            self.render(results=results)

    def test_unselected_and_manual_are_not_passes(self):
        _, index = self.render(
            results={"phase": "executed", "selected_case_ids": [], "results": []}
        )
        self.assertEqual(index["cases"][0]["verdict"], "本轮范围外")
        self.assertEqual(index["cases"][1]["verdict"], "待人工核验")

    def test_pytest_class_reference(self):
        path = self.repo / "class_test.py"
        path.write_text("class TestBusiness:\n    def test_rule(self):\n        pass\n")
        self.assertEqual(
            StaticLinks(self.repo, "p").reference("class_test.py::TestBusiness::test_rule")[
                "status"
            ],
            "static",
        )

    def test_dynamic_parameters_not_reported_as_verified(self):
        (self.repo / self.test_path).write_text(
            'import pytest\n@pytest.mark.parametrize("value", VALUES, ids=IDS)\n'
            "def test_it(value):\n    pass\n"
            "def check_value():\n    return True\n"
        )
        _, index = self.render()
        self.assertEqual(index["cases"][0]["reference_check"], "入口已核对，动态参数待核验")
        self.assertTrue(index["warnings"])


if __name__ == "__main__":
    unittest.main()
