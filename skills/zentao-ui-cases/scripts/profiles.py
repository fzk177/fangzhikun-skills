#!/usr/bin/env python3
"""Local, non-secret project/environment/account choices. No network or code imports."""

import argparse
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

FIELDS = {
    "id",
    "label",
    "project",
    "frontend_repo",
    "playwright_repo",
    "environment",
    "base_url",
    "account",
    "role",
    "tenant",
    "storage_state",
    "storage_state_env",
}
REQUIRED = {"id", "label", "project", "frontend_repo", "playwright_repo", "environment"}


def config_path():
    return (
        Path(
            os.environ.get(
                "ZENTAO_UI_CASES_PROFILES",
                str(Path.home() / ".config/zentao-ui-cases/profiles.json"),
            )
        )
        .expanduser()
        .absolute()
    )


def validate_profile(profile):
    if not isinstance(profile, dict) or set(profile) - FIELDS or REQUIRED - set(profile):
        raise ValueError("配置字段缺失或包含未知字段；不得保存密码、Token、Cookie 或执行命令")
    if any(
        value is not None and (not isinstance(value, str) or not value.strip())
        for value in profile.values()
    ):
        raise ValueError("配置值须为非空字符串或 null")
    if any(profile[field] is None for field in REQUIRED):
        raise ValueError("必填配置不能为 null")
    for field in ("id", "project"):
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", profile[field]):
            raise ValueError(f"{field} 只能包含字母、数字、下划线和连字符")
    for field in ("frontend_repo", "playwright_repo", "storage_state"):
        if profile.get(field) and not Path(profile[field]).expanduser().is_absolute():
            raise ValueError(f"{field} 须为绝对路径")
    if profile.get("storage_state_env") and not re.fullmatch(
        r"[A-Z_][A-Z0-9_]*", profile["storage_state_env"]
    ):
        raise ValueError("storage_state_env 须为环境变量名，不是环境变量值")
    if profile.get("base_url"):
        url = urlsplit(profile["base_url"])
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError(
                "base_url 须为无凭据、查询参数和 fragment 的 HTTP(S) 地址；可含部署子路径"
            )
        _ = url.port
    return profile


def load_config():
    path = config_path()
    if not path.exists():
        return {"version": 1, "profiles": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(data, dict)
        or set(data) != {"version", "profiles"}
        or data["version"] != 1
        or not isinstance(data["profiles"], list)
    ):
        raise ValueError("配置格式或版本无效；保留原文件，请修正后重试")
    ids = []
    states = []
    for profile in data["profiles"]:
        validate_profile(profile)
        ids.append(profile["id"])
        states.append(state_path(profile).resolve())
    if len(set(ids)) != len(ids):
        raise ValueError("配置 ID 重复")
    if len(set(states)) != len(states):
        raise ValueError("不同配置不得共用登录态文件")
    return data


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def select_profile(profile_id):
    for profile in load_config()["profiles"]:
        if profile["id"] == profile_id:
            return profile
    raise ValueError("配置 ID 不存在；先 list，不自动改用其他环境或账号")


def state_path(profile):
    if profile.get("storage_state"):
        return Path(profile["storage_state"]).expanduser()
    return Path.home() / ".local/share/zentao-ui-cases/auth" / (profile["id"] + ".json")


def validate_state_destination(profile):
    """Refuse frontend writes and tracked/unignored credentials before opening login."""
    state = state_path(profile).resolve()
    if state == config_path().resolve() or state.is_relative_to(
        Path(profile["frontend_repo"]).expanduser().resolve()
    ):
        raise ValueError("登录态位置不能覆盖配置或写入前端仓库")
    ancestor = state.parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    git_root = subprocess.run(
        ["git", "-C", str(ancestor), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if git_root.returncode == 0:
        root = git_root.stdout.strip()
        tracked = subprocess.run(
            ["git", "-C", root, "ls-files", "--error-unmatch", "--", str(state)],
            capture_output=True,
            timeout=10,
            check=False,
        )
        ignored = subprocess.run(
            ["git", "-C", root, "check-ignore", "--quiet", "--", str(state)],
            capture_output=True,
            timeout=10,
            check=False,
        )
        if tracked.returncode != 1 or ignored.returncode != 0:
            raise ValueError("仓库内登录态须已忽略且未被跟踪；请改用仓库外专用位置")
    elif git_root.returncode != 128:
        raise ValueError("无法确认登录态目录的 Git 归属")
    return state


def describe(profile):
    result = dict(profile)
    state = state_path(profile)
    result["storage_state"] = str(state)
    result["availability"] = {
        "frontend_exists": Path(profile["frontend_repo"]).expanduser().is_dir(),
        "playwright_exists": Path(profile["playwright_repo"]).expanduser().is_dir(),
        "project_exists": (
            Path(profile["playwright_repo"]).expanduser() / "projects" / profile["project"]
        ).is_dir(),
        "storage_state": "present_unverified" if state.is_file() else "missing",
    }
    result["execution_authorized"] = False
    return result


def resolve(profile):
    result = describe(profile)
    if not all(
        result["availability"][key]
        for key in ("frontend_exists", "playwright_exists", "project_exists")
    ):
        raise ValueError("配置中的仓库或业务项目已不存在；请修正配置，不自动替换路径")
    result["pytest_options"] = (
        ["--base-url", profile["base_url"]] if profile.get("base_url") else []
    )
    result["environment_variables"] = {}
    if profile.get("storage_state_env") and state_path(profile).is_file():
        result["environment_variables"][profile["storage_state_env"]] = str(state_path(profile))
    return result


def discover(repo):
    """Read historical source metadata, never .env, auth contents, or frontend modules."""
    root = Path(repo).expanduser().resolve()
    if not root.is_dir():
        raise ValueError("Playwright 仓库不存在")
    candidates, errors = [], []
    for source in sorted(root.glob("projects/*/specs/stories/*.sources.json")):
        try:
            data = json.loads(source.read_text(encoding="utf-8"))
            frontend = data.get("frontend", {}).get("path")
            environment = data.get("environment")
            if not isinstance(frontend, str):
                continue
            project = source.relative_to(root).parts[1]
            candidate = {
                "project": project,
                "frontend_repo": frontend,
                "playwright_repo": str(root),
                "base_url": environment,
                "source": str(source),
                "status": "historical_candidate_not_selected",
                "account": None,
                "role": None,
                "tenant": None,
                "storage_state_candidates": [
                    str(p) for p in sorted((root / "playwright/.auth" / project).glob("*.json"))
                ],
            }
            validate_profile(
                {
                    "id": "candidate",
                    "label": project,
                    "environment": "待选择",
                    **{
                        k: candidate[k]
                        for k in ("project", "frontend_repo", "playwright_repo", "base_url")
                    },
                }
            )
            candidates.append(candidate)
        except (ValueError, TypeError, AttributeError, OSError):
            errors.append({"source": str(source), "error": "历史元数据无效或无法读取"})
    return {"candidates": candidates, "errors": errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="列出已保存配置及本地可用状态，不验证在线登录")
    discover_parser = sub.add_parser("discover", help="从指定仓库的历史依据发现候选，不保存")
    discover_parser.add_argument("--repo", required=True)
    resolve_parser = sub.add_parser("resolve", help="解析用户选择，不访问环境或执行测试")
    resolve_parser.add_argument("--id", required=True)
    save_parser = sub.add_parser("save", help="从 stdin 读取一条非秘密配置并保存")
    save_parser.add_argument("--replace", action="store_true", help="明确替换已有同 ID 配置")
    args = parser.parse_args()
    try:
        if args.command == "list":
            result = {"profiles": [describe(p) for p in load_config()["profiles"]]}
        elif args.command == "discover":
            result = discover(args.repo)
        elif args.command == "resolve":
            result = resolve(select_profile(args.id))
        else:
            profile = validate_profile(json.load(sys.stdin))
            data = load_config()
            existing = [i for i, p in enumerate(data["profiles"]) if p["id"] == profile["id"]]
            if existing and not args.replace:
                raise ValueError("配置 ID 已存在；修改须明确传 --replace")
            if existing:
                data["profiles"][existing[0]] = profile
            else:
                data["profiles"].append(profile)
            paths = [state_path(p).resolve() for p in data["profiles"]]
            if len(set(paths)) != len(paths):
                raise ValueError("不同配置不得共用登录态文件")
            atomic_json(config_path(), data)
            result = {"saved": profile["id"], "config": str(config_path())}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2 if args.command == "discover" and result["errors"] else 0
    except (ValueError, TypeError, OSError):
        print("配置操作失败：字段、文件或路径无效；检查本机配置，原始内容不输出。", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
