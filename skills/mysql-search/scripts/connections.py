#!/usr/bin/env python3
"""Local OP/BPM routing and non-secret configuration management."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile

CATALOG = {
    "op": {"name": "OP数据库连接", "routes": {"dev": "mysql", "pre": "mysql", "prod": "dms"}},
    "bpm": {"name": "BPM数据库连接", "routes": {"prod": "mysql"}},
}


class ConfigurationError(ValueError):
    pass


def root():
    return Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "fangzhikun-skills/mysql-search"


def identity(connection, environment):
    aliases = {"OP数据库连接": "op", "BPM数据库连接": "bpm"}
    connection = aliases.get(connection, connection.lower())
    environment = {"production": "prod", "生产": "prod"}.get(environment, environment)
    if connection not in CATALOG or environment not in CATALOG[connection]["routes"]:
        raise ConfigurationError("连接或环境不支持；OP 支持 dev/pre/prod，BPM 仅支持 prod")
    return connection, environment


def path_for(connection, environment):
    return root() / "connections" / connection / (environment + ".json")


def read_json(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        raise ConfigurationError("连接配置缺失或 JSON 无效") from None
    if not isinstance(data, dict):
        raise ConfigurationError("连接配置必须为对象")
    if any(key.lower() in {"password", "token", "secret", "accesskey", "accesskeysecret"} for key in data):
        raise ConfigurationError("连接配置不得保存秘密凭据")
    return data


def load(connection, environment):
    path = path_for(connection, environment)
    legacy = False
    if not path.exists() and connection == "op":
        path = root() / (environment + ".json")
        legacy = True
    data = read_json(path)
    transport = CATALOG[connection]["routes"][environment]
    if data.get("connection", connection) != connection or data.get("environment", environment) != environment:
        raise ConfigurationError("配置归属与请求连接/环境不一致")
    if data.get("transport", "mysql" if legacy and environment != "prod" else None) != transport:
        raise ConfigurationError("配置通道与固定路由不一致，禁止回退")
    if data.get("enabled", True) not in (True, False) or not isinstance(data.get("enabled", True), bool):
        raise ConfigurationError("enabled 必须为布尔值")
    if not isinstance(data.get("configured", True), bool) or data.get("readonly", True) is not True:
        raise ConfigurationError("配置状态无效或试图关闭只读限制")
    return path, data, legacy


def validate_database(database):
    if not re.fullmatch(r"[A-Za-z0-9_]+", database or ""):
        raise ConfigurationError("数据库名只能包含字母、数字和下划线")


def resolve(connection, environment, database, implicit_op=False):
    connection, environment = identity(connection, environment)
    validate_database(database)
    if implicit_op:
        # BPM registration is only an advisory for legacy OP calls. Invalid
        # or missing BPM configuration must not disable independent OP routes.
        try:
            _, bpm, _ = load("bpm", "prod")
            bpm_databases = bpm.get("allowedDatabases")
        except ConfigurationError:
            bpm_databases = None
        if isinstance(bpm_databases, list) and database in bpm_databases:
            raise ConfigurationError("该数据库已登记于 BPM，请明确指定 --connection bpm；不会自动切换")
    path, data, legacy = load(connection, environment)
    if data.get("enabled", True) is not True:
        raise ConfigurationError("该连接已停用")
    allowed = data.get("allowedDatabases")
    transport = CATALOG[connection]["routes"][environment]
    if connection == "bpm":
        if not isinstance(allowed, list) or len(allowed) != 1 or not isinstance(allowed[0], str):
            raise ConfigurationError("BPM 必须登记唯一数据库")
        validate_database(allowed[0])
    elif transport == "dms":
        mappings = data.get("databases")
        if not isinstance(mappings, dict):
            raise ConfigurationError("OP prod 缺少 DMS 数据库映射")
        allowed = list(mappings)
    elif allowed is not None and (not isinstance(allowed, list) or not all(isinstance(x, str) for x in allowed)):
        raise ConfigurationError("数据库白名单格式无效")
    if allowed is not None and database not in allowed:
        raise ConfigurationError("目标数据库未登记于选中的连接")
    if data.get("configured", True) is not True:
        raise ConfigurationError("连接已登记但尚未配置地址/身份；请运行 configure.sh")
    if transport == "mysql":
        if not re.fullmatch(r"[A-Za-z0-9.-]+", str(data.get("host", ""))):
            raise ConfigurationError("MySQL Host 格式无效")
        port = data.get("port")
        if isinstance(port, bool) or not str(port).isdigit() or not 1 <= int(port) <= 65535:
            raise ConfigurationError("MySQL 端口无效")
        for field in ("username", "keychainService"):
            value = data.get(field)
            if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
                raise ConfigurationError("MySQL 用户名或钥匙串服务名无效")
        modes = {"PREFERRED", "REQUIRED", "VERIFY_CA", "VERIFY_IDENTITY"}
        if data.get("sslMode") not in modes or connection == "bpm" and data["sslMode"] == "PREFERRED":
            raise ConfigurationError("TLS 配置无效；BPM 不允许降级为未加密连接")
        if connection == "bpm" and data["keychainService"] != "codex.mysql-search.bpm.prod":
            raise ConfigurationError("BPM 必须使用独立钥匙串服务")
        if data.get("sslCa") and (not isinstance(data["sslCa"], str) or any(ord(c) < 32 for c in data["sslCa"])):
            raise ConfigurationError("CA 路径格式无效")
        if connection == "bpm" and data["sslMode"] in {"VERIFY_CA", "VERIFY_IDENTITY"} and not Path(data.get("sslCa", "")).is_file():
            raise ConfigurationError("BPM 证书验证模式需要有效的本机 CA 文件")
    return {"connection": connection, "displayName": CATALOG[connection]["name"], "environment": environment,
            "transport": transport, "configFile": str(path), "legacy": legacy}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    fd, temporary = tempfile.mkstemp(prefix=".connection-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def migrate():
    migrated = []
    for environment in CATALOG["op"]["routes"]:
        source = root() / (environment + ".json")
        destination = path_for("op", environment)
        if not source.exists() or destination.exists():
            continue
        _, data, _ = load("op", environment)
        data.update(connection="op", displayName=CATALOG["op"]["name"], environment=environment,
                    transport=CATALOG["op"]["routes"][environment], enabled=data.get("enabled", True), schemaVersion=1)
        write_json(destination, data)
        migrated.append(environment)
    return {"connection": "op", "migratedEnvironments": migrated, "legacyFilesPreserved": True}


def listing():
    rows = []
    for connection, definition in CATALOG.items():
        for environment, transport in definition["routes"].items():
            try:
                _, data, legacy = load(connection, environment)
                state = "disabled" if not data.get("enabled", True) else "pending" if not data.get("configured", True) else "configured"
                databases = list(data.get("databases", {})) if transport == "dms" else data.get("allowedDatabases")
            except ConfigurationError:
                state, databases, legacy = "missing-or-invalid", None, False
            rows.append({"connection": connection, "displayName": definition["name"], "environment": environment,
                         "transport": transport, "state": state, "databases": databases, "legacy": legacy})
    return rows


def main():
    cli = argparse.ArgumentParser(description="OP/BPM 本地连接管理；不连接数据库、不读取密码")
    cli.add_argument("action", choices=("identity", "resolve", "list", "migrate-op", "init-bpm", "enable", "disable"))
    cli.add_argument("--connection", default="op")
    cli.add_argument("--env", default="")
    cli.add_argument("--database", default="")
    cli.add_argument("--implicit-op", action="store_true")
    args = cli.parse_args()
    try:
        if args.action == "list":
            result = listing()
        elif args.action == "migrate-op":
            result = migrate()
        else:
            connection, environment = identity(args.connection, args.env)
            if args.action == "identity":
                result = {"connection": connection, "environment": environment, "transport": CATALOG[connection]["routes"][environment]}
            elif args.action == "resolve":
                result = resolve(connection, environment, args.database, args.implicit_op)
            elif args.action == "init-bpm":
                if connection != "bpm":
                    raise ConfigurationError("init-bpm 仅用于 BPM")
                validate_database(args.database)
                path = path_for(connection, environment)
                if path.exists():
                    result = {"connection": connection, "state": "existing-config-preserved"}
                else:
                    write_json(path, {"schemaVersion": 1, "connection": connection, "displayName": CATALOG[connection]["name"],
                                      "environment": environment, "transport": "mysql", "enabled": True, "configured": False,
                                      "allowedDatabases": [args.database], "keychainService": "codex.mysql-search.bpm.prod", "sslMode": "VERIFY_IDENTITY"})
                    result = {"connection": connection, "state": "pending"}
            else:
                _, data, _ = load(connection, environment)
                data["enabled"] = args.action == "enable"
                write_json(path_for(connection, environment), data)
                result = {"connection": connection, "environment": environment, "enabled": data["enabled"]}
        print(json.dumps(result, ensure_ascii=False))
    except (ConfigurationError, OSError, ValueError, TypeError):
        # Static diagnostics only. Do not echo malformed configuration values.
        error = sys.exc_info()[1]
        print(str(error) if isinstance(error, ConfigurationError) else "连接配置操作失败", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
