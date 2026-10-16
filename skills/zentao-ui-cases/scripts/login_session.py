#!/usr/bin/env python3
"""Explicit headed login capture or protected-page check for a selected profile."""

import argparse
import json
import sys

sys.dont_write_bytecode = True
from urllib.parse import urlsplit

from profiles import atomic_json, resolve, select_profile, state_path, validate_state_destination


def origin(url):
    parsed = urlsplit(url)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def target_url(base_url, route):
    if not route.startswith("/") or route.startswith("//") or "?" in route or "#" in route:
        raise ValueError("检查路径须为站内部署相对路径，不含查询参数或 fragment")
    return base_url.rstrip("/") + route


def clean_state(state):
    """Discard remembered login forms; preserve authentication and application storage."""
    for entry in state.get("origins", []):
        entry["localStorage"] = [
            item
            for item in entry.get("localStorage", [])
            if not any(
                word in item["name"].lower().replace("_", "").replace("-", "")
                for word in ("password", "loginform")
            )
        ]
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["check", "login"])
    parser.add_argument("--id", required=True)
    parser.add_argument("--path", default="/", help="部署子路径下的只读登录后页面")
    parser.add_argument("--success-selector", help="已核实的登录后页面定位器；check 必填")
    parser.add_argument("--timeout-ms", type=int, default=15000)
    args = parser.parse_args()
    if args.mode == "check" and not args.success_selector:
        parser.error("check 需要 --success-selector，文件存在或未跳转登录页不足以证明认证有效")
    if args.timeout_ms <= 0 or args.timeout_ms > 60000:
        parser.error("timeout-ms 须为 1–60000")
    try:
        profile = select_profile(args.id)
        resolve(profile)
        if not profile.get("base_url"):
            raise ValueError("配置没有运行环境")
        destination = target_url(profile["base_url"], args.path)
        state = state_path(profile)
        if args.mode == "login":
            state = validate_state_destination(profile)
        if args.mode == "check" and not state.is_file():
            print(json.dumps({"status": "missing", "profile": args.id}))
            return 3
        # Import only for an explicitly requested online operation.
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=args.mode == "check")
            try:
                # Login starts fresh so another account cannot silently carry over.
                context = browser.new_context(
                    **({"storage_state": str(state)} if args.mode == "check" else {})
                )
                page = context.new_page()
                page.goto(destination, wait_until="domcontentloaded", timeout=args.timeout_ms)
                if args.mode == "login":
                    print(
                        "请在浏览器登录，勿勾选记住密码。核对选中配置的账号、角色及租户；"
                        "完成后输入 SAVE，其他输入取消。仅保存登录态，不录制登录截图或 Trace。",
                        flush=True,
                    )
                    if input().strip() != "SAVE":
                        print(json.dumps({"status": "cancelled", "profile": args.id}))
                        return 4
                if args.success_selector:
                    page.locator(args.success_selector).wait_for(
                        state="visible", timeout=args.timeout_ms
                    )
                if origin(page.url) != origin(profile["base_url"]):
                    raise ValueError("页面未回到所选业务环境，不能保存或确认会话")
                if args.mode == "login":
                    captured = clean_state(context.storage_state(indexed_db=True))
                    atomic_json(state, captured)
                    result = {
                        "status": "saved_user_confirmed",
                        "profile": args.id,
                        "storage_state": str(state),
                    }
                else:
                    result = {
                        "status": "protected_marker_visible",
                        "profile": args.id,
                        "identity": "requires_role_and_tenant_verification",
                    }
                print(json.dumps(result, ensure_ascii=False))
                context.close()
                return 0
            finally:
                browser.close()
    except (ValueError, OSError, EOFError, ImportError):
        print("会话操作未完成：请检查配置、依赖或交互确认；已有登录态未被覆盖。", file=sys.stderr)
        return 2
    except Exception:
        # Browser exceptions can contain URLs, headers and storage data. Keep them private.
        print(
            "浏览器检查未完成：可能为网络、浏览器、定位器或认证问题；不能直接判为登录过期。",
            file=sys.stderr,
        )
        return 3


if __name__ == "__main__":
    sys.exit(main())
