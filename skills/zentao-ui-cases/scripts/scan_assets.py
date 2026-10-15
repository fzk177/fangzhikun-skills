#!/usr/bin/env python3
"""Statically inventory a Python Playwright workspace without importing its code."""

import argparse
import ast
import hashlib
import json
import keyword
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

EXCLUDED = {
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    "node_modules",
    ".auth",
    "artifacts",
    "test-results",
    "reports",
}


def dotted_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else ""
    return ""


class Symbols(ast.NodeVisitor):
    def __init__(self, tree):
        self.entries = []
        self.classes = []
        self.aliases = {}
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.aliases[alias.asname or alias.name.split(".")[0]] = (
                        alias.name if alias.asname else alias.name.split(".")[0]
                    )
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if node.module:
                        self.aliases[alias.asname or alias.name] = f"{node.module}.{alias.name}"

    def canonical(self, name):
        first, separator, rest = name.partition(".")
        return self.aliases.get(first, first) + (separator + rest if separator else "")

    def visit_ClassDef(self, node):
        self.entries.append(self.entry(node, "class"))
        self.classes.append(node.name)
        for child in node.body:
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                self.visit(child)
        self.classes.pop()

    def entry(self, node, kind):
        doc = ast.get_docstring(node) or ""
        return {
            "symbol": ".".join([*self.classes, node.name]),
            "kind": kind,
            "line": node.lineno,
            "end_line": node.end_lineno,
            "summary": doc.splitlines()[0] if doc else "",
        }

    def visit_FunctionDef(self, node):
        decorators = []
        for decorator in node.decorator_list:
            expression = decorator.func if isinstance(decorator, ast.Call) else decorator
            name = dotted_name(expression)
            if name:
                decorators.append(self.canonical(name))
        if "pytest.fixture" in decorators:
            kind = "fixture"
        elif node.name.startswith("test_"):
            kind = "test"
        else:
            kind = "method" if self.classes else "function"
        entry = self.entry(node, kind)
        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        if node.args.vararg:
            arguments.append(node.args.vararg)
        if node.args.kwarg:
            arguments.append(node.args.kwarg)
        entry.update(
            {
                "async": isinstance(node, ast.AsyncFunctionDef),
                "parameters": [argument.arg for argument in arguments],
                "decorators": decorators,
                "parametrized": "pytest.mark.parametrize" in decorators,
                "calls": sorted(
                    {
                        name
                        for child in ast.walk(node)
                        if isinstance(child, ast.Call)
                        if (name := dotted_name(child.func))
                    }
                ),
            }
        )
        self.entries.append(entry)
        # Nested functions are implementation details, not independent asset entries.

    visit_AsyncFunctionDef = visit_FunctionDef


def git_snapshot(repo):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")

    def run(*args):
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else None

    try:
        commit = run("rev-parse", "HEAD")
        status = run("status", "--porcelain", "--untracked-files=normal")
        return {
            "commit": commit,
            "branch": run("symbolic-ref", "--short", "-q", "HEAD"),
            "dirty": bool(status) if status is not None else None,
            "available": status is not None,
        }
    except (OSError, subprocess.TimeoutExpired):
        return {"available": False, "commit": None, "branch": None, "dirty": None}


def inventory(repo, project, include_others=False):
    target = repo / "projects" / project
    if not target.is_dir():
        raise ValueError(f"Project directory does not exist: {target}")
    if not target.resolve().is_relative_to(repo):
        raise ValueError("Project directory resolves outside the repository")
    report = {
        "schema_version": 1,
        "repo": str(repo),
        "project": project,
        "revision": git_snapshot(repo),
        "complete": True,
        "files": [],
        "documents": [],
        "errors": [],
        "notes": [
            "AST candidates only; no code imports, pytest collection, browser or network access.",
            "Test counts are function definitions; parametrized invocations are not expanded.",
            "Call names are hints, not resolved dependencies or proof of semantic equivalence.",
        ],
    }
    roots = [(target, project)]
    if include_others:
        for folder in sorted((repo / "projects").iterdir()):
            if folder.is_dir() and folder.name != project and folder.name not in EXCLUDED:
                roots.append((folder, folder.name))
    shared = repo / "src" / "playwright_cases"
    if shared.is_dir():
        roots.append((shared, "shared"))

    candidates = {}
    for root, owner in roots:
        if not root.resolve().is_relative_to(repo):
            report["errors"].append({"path": str(root.relative_to(repo)), "error": "outside repo"})
            continue

        def walk_error(error, scan_root=root):
            report["errors"].append({"path": str(scan_root.relative_to(repo)), "error": str(error)})

        for directory, subdirs, filenames in os.walk(root, followlinks=False, onerror=walk_error):
            base = Path(directory)
            kept = []
            for name in sorted(subdirs):
                child = base / name
                if name in EXCLUDED or name.startswith("."):
                    continue
                if child.is_symlink():
                    report["errors"].append(
                        {
                            "path": str(child.relative_to(repo)),
                            "error": "symlink directory not scanned",
                        }
                    )
                else:
                    kept.append(name)
            subdirs[:] = kept
            for filename in sorted(filenames):
                path = base / filename
                relative = path.relative_to(root)
                if path.suffix == ".py":
                    candidates[path] = (owner, True)
                elif filename == "README.md" or (
                    relative.parts[0] == "specs" and path.suffix in {".yaml", ".yml", ".md"}
                ):
                    candidates[path] = (owner, False)
    for filename, is_python in (("conftest.py", True), ("pyproject.toml", False)):
        path = repo / filename
        if path.is_file():
            candidates[path] = ("shared", is_python)

    for path, (owner, is_python) in sorted(candidates.items()):
        relative = str(path.relative_to(repo))
        try:
            if path.is_symlink() or not path.resolve().is_relative_to(repo):
                raise ValueError("symlink file not scanned")
            content = path.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
            entry = {"path": relative, "owner": owner, "sha256": digest}
            if not is_python:
                report["documents"].append(entry)
                continue
            tree = ast.parse(content, filename=relative)
            symbols = Symbols(tree)
            symbols.visit(tree)
            entry["imports"] = sorted(
                {
                    name
                    for node in ast.walk(tree)
                    if isinstance(node, (ast.Import, ast.ImportFrom))
                    for name in (
                        [alias.name for alias in node.names]
                        if isinstance(node, ast.Import)
                        else ["." * node.level + (node.module or "")]
                    )
                }
            )
            entry["symbols"] = symbols.entries
            report["files"].append(entry)
        except (OSError, SyntaxError, UnicodeError, ValueError, LookupError) as error:
            report["errors"].append({"path": relative, "error": str(error)})
    report["complete"] = not report["errors"]
    counts = Counter(symbol["kind"] for file in report["files"] for symbol in file["symbols"])
    report["counts"] = {"python_files": len(report["files"]), **dict(sorted(counts.items()))}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--include-other-projects", action="store_true")
    args = parser.parse_args()
    if not args.project.isidentifier() or keyword.iskeyword(args.project):
        parser.error("--project must be a Python package name")
    repo = args.repo.expanduser().resolve()
    if not repo.is_dir():
        parser.error("--repo must be an existing directory")
    try:
        report = inventory(repo, args.project, args.include_other_projects)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0 if report["complete"] else 2


if __name__ == "__main__":
    sys.exit(main())
