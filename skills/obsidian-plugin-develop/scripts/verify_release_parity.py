#!/usr/bin/env python3
"""校验 Obsidian 安装产物、源码构建与 Release 下载资产的一致性。"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


RELEASE_FILES = ("main.js", "manifest.json", "styles.css")
NO_SOURCE_MAP_SUFFIX = re.compile(rb"(?:\r?\n)?/\* nosourcemap \*/[ \t\r\n]*\Z")


def sha256(content: bytes) -> str:
    """计算内容哈希，避免在输出中暴露文件内容。"""

    return hashlib.sha256(content).hexdigest()


def read_required(path: Path) -> bytes:
    """读取必需文件并提供明确错误。"""

    if not path.is_file():
        raise FileNotFoundError(f"缺少文件：{path}")
    return path.read_bytes()


def normalized_main(content: bytes) -> bytes:
    """仅忽略 Obsidian 安装时追加的标记和文件末尾换行。"""

    without_marker = NO_SOURCE_MAP_SUFFIX.sub(b"", content)
    return without_marker.rstrip(b"\r\n")


def load_manifest(path: Path) -> dict[str, Any]:
    """读取 Manifest 并确认顶层为 JSON 对象。"""

    value = json.loads(read_required(path).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Manifest 顶层必须是对象：{path}")
    return value


def compare_install(repository: Path, plugin_dir: Path, require_version: bool) -> list[str]:
    """比较源码构建与本地安装产物。"""

    failures: list[str] = []
    source_main = normalized_main(read_required(repository / "main.js"))
    installed_main = normalized_main(read_required(plugin_dir / "main.js"))
    if source_main != installed_main:
        failures.append(
            "安装 main.js 与源码构建不一致："
            f"source={sha256(source_main)} install={sha256(installed_main)}"
        )
    else:
        print(f"[通过] 安装 main.js（规范化）sha256={sha256(source_main)}")

    source_styles = repository / "styles.css"
    installed_styles = plugin_dir / "styles.css"
    if source_styles.exists() or installed_styles.exists():
        source_content = read_required(source_styles)
        installed_content = read_required(installed_styles)
        if source_content != installed_content:
            failures.append(
                "安装 styles.css 与源码构建不一致："
                f"source={sha256(source_content)} install={sha256(installed_content)}"
            )
        else:
            print(f"[通过] 安装 styles.css sha256={sha256(source_content)}")

    source_manifest = load_manifest(repository / "manifest.json")
    installed_manifest = load_manifest(plugin_dir / "manifest.json")
    source_without_version = {key: value for key, value in source_manifest.items() if key != "version"}
    installed_without_version = {
        key: value for key, value in installed_manifest.items() if key != "version"
    }
    if source_without_version != installed_without_version:
        failures.append("安装 manifest.json 除 version 外的字段与源码不一致")
    elif require_version and source_manifest.get("version") != installed_manifest.get("version"):
        failures.append(
            "安装 manifest.json 版本不一致："
            f"source={source_manifest.get('version')} install={installed_manifest.get('version')}"
        )
    else:
        version_note = source_manifest.get("version")
        if source_manifest.get("version") != installed_manifest.get("version"):
            version_note = (
                f"source={source_manifest.get('version')} install={installed_manifest.get('version')}（允许）"
            )
        print(f"[通过] 安装 manifest.json 语义一致，version={version_note}")

    return failures


def compare_release(repository: Path, release_dir: Path) -> list[str]:
    """把下载后的 Release 资产与标签源码逐字节比较。"""

    failures: list[str] = []
    for filename in RELEASE_FILES:
        source_path = repository / filename
        release_path = release_dir / filename
        if filename == "styles.css" and not source_path.exists() and not release_path.exists():
            continue

        source_content = read_required(source_path)
        release_content = read_required(release_path)
        if source_content != release_content:
            failures.append(
                f"Release {filename} 与标签源码不一致："
                f"source={sha256(source_content)} release={sha256(release_content)}"
            )
        else:
            print(f"[通过] Release {filename} sha256={sha256(source_content)}")
    return failures


def parse_args() -> argparse.Namespace:
    """解析校验目标。"""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, type=Path, help="插件源码仓库")
    parser.add_argument("--plugin-dir", type=Path, help="vault 中的插件安装目录")
    parser.add_argument("--release-dir", type=Path, help="下载后的 Release 资产目录")
    parser.add_argument(
        "--require-manifest-version",
        action="store_true",
        help="安装目录 Manifest 版本也必须与源码一致",
    )
    args = parser.parse_args()
    if args.plugin_dir is None and args.release_dir is None:
        parser.error("--plugin-dir 与 --release-dir 至少提供一个")
    return args


def main() -> int:
    """执行全部请求的一致性检查。"""

    args = parse_args()
    repository = args.repository.resolve()
    failures: list[str] = []

    try:
        if args.plugin_dir is not None:
            failures.extend(
                compare_install(
                    repository,
                    args.plugin_dir.resolve(),
                    args.require_manifest_version,
                )
            )
        if args.release_dir is not None:
            failures.extend(compare_release(repository, args.release_dir.resolve()))
    except (FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        failures.append(str(error))

    for failure in failures:
        print(f"[失败] {failure}", file=sys.stderr)
    if failures:
        return 1

    print("产物一致性门禁通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
