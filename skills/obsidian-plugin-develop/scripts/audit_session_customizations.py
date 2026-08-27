#!/usr/bin/env python3
"""审计 Codex/Claudian 会话中对 Obsidian 插件安装目录的直接修改。"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


MUTATION_PATTERN = re.compile(
    r"apply_patch|writeFile|copyFile|sed\s+-i|perl\s+-(?:p?i)|cp\s+|mv\s+|cat\s+>",
    re.IGNORECASE,
)
SECRET_PATTERN = re.compile(
    r"(?:gho_|github[_-]?token|password|cookie|authorization)[^\s\"']*",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="扫描近期 Codex 会话，发现直接修改 vault 插件安装产物的操作。"
    )
    parser.add_argument("--vault", required=True, help="目标 Obsidian vault")
    parser.add_argument("--plugin-id", required=True, help="目标插件 ID")
    parser.add_argument("--repository", help="源码仓库路径，用于标识同轮源码修改")
    parser.add_argument("--since-days", type=int, default=30, help="扫描最近天数，默认 30")
    parser.add_argument(
        "--fail-on-findings",
        action="store_true",
        help="发现直接安装版修改时返回非零状态",
    )
    return parser.parse_args()


def session_paths(vault: Path) -> list[Path]:
    paths: set[Path] = set()
    for metadata_path in (vault / ".claudian" / "sessions").glob("*.meta.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        session_path = metadata.get("providerState", {}).get("sessionFilePath")
        if session_path:
            candidate = Path(session_path)
            if candidate.is_file():
                paths.add(candidate)

    codex_root = Path.home() / ".codex" / "sessions"
    if codex_root.is_dir():
        paths.update(codex_root.rglob("*.jsonl"))
    return sorted(paths)


def timestamp_value(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def sanitized_excerpt(value: str, limit: int = 260) -> str:
    compact = " ".join(value.split())
    compact = SECRET_PATTERN.sub("[已隐藏]", compact)
    return compact[:limit] + ("…" if len(compact) > limit else "")


def main() -> int:
    args = parse_args()
    vault = Path(args.vault).expanduser().resolve()
    plugin_dir = (vault / ".obsidian" / "plugins" / args.plugin_id).resolve()
    repository = Path(args.repository).expanduser().resolve() if args.repository else None
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(args.since_days, 1))
    findings: list[dict[str, str]] = []

    plugin_text = str(plugin_dir)
    repository_text = str(repository) if repository else ""
    for session_path in session_paths(vault):
        try:
            lines = session_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            occurred_at = timestamp_value(item.get("timestamp"))
            if occurred_at is None or occurred_at < cutoff:
                continue
            payload = item.get("payload", {})
            if item.get("type") != "response_item" or payload.get("type") != "custom_tool_call":
                continue
            tool_input = str(payload.get("input", ""))
            if plugin_text not in tool_input or not MUTATION_PATTERN.search(tool_input):
                continue
            findings.append(
                {
                    "time": occurred_at.isoformat(),
                    "session": str(session_path),
                    "source_touched": "是" if repository_text and repository_text in tool_input else "否",
                    "excerpt": sanitized_excerpt(tool_input),
                }
            )

    if not findings:
        print("[通过] 近期会话未发现直接修改目标插件安装目录的操作")
        return 0

    print(f"[需审计] 发现 {len(findings)} 条直接修改安装版的会话操作：")
    for finding in findings:
        print(
            f"- {finding['time']} source_touched={finding['source_touched']}\n"
            f"  session={finding['session']}\n"
            f"  action={finding['excerpt']}"
        )
    print("发布前必须逐项确认这些改动已经进入源码或确定性补丁层，并重新构建验证。")
    return 2 if args.fail_on_findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
