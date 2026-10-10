#!/usr/bin/env python3
"""BPM: one read-only session for MySQL 5.7.20+ or 8.0."""

import argparse
import configparser
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
import json
import os

# Runtime queries must not create files inside a managed Skill installation.
sys.dont_write_bytecode = True
from sql_guard import Rejected, validate, verify_tables


class QueryFailure(RuntimeError):
    pass


def supported_server_version(version):
    # 5.7.20 introduced transaction_read_only. Keep the same session controls
    # on both supported series; older/compatible products never trigger retry.
    match = re.fullmatch(r"(5\.7|8\.0)\.(\d+)(?:[-+][A-Za-z0-9_.+-]+)?", version)
    if not match or any(product in version.lower() for product in ("mariadb", "tidb", "oceanbase")):
        return False
    return match[1] == "8.0" or int(match[2]) >= 20


def check_option_file(path, database, allow_unencrypted=False):
    config = configparser.ConfigParser(interpolation=None)
    try:
        with open(path) as source:
            config.read_file(source)
    except (OSError, configparser.Error):
        raise QueryFailure("MySQL option 文件无效") from None
    allowed = {"user", "password", "host", "port", "database", "ssl-mode", "ssl-ca", "default-character-set"}
    if config.sections() != ["client"] or config.defaults() or set(config["client"]) - allowed:
        raise QueryFailure("MySQL option 文件包含未允许的选项")
    values = config["client"]
    modes = {"REQUIRED", "VERIFY_CA", "VERIFY_IDENTITY"}
    if allow_unencrypted:
        modes.add("DISABLED")
    if values.get("database", "").strip('"') != database or values.get("ssl-mode") not in modes:
        raise QueryFailure("MySQL option 数据库或 TLS 设置不一致")


class Session:
    def __init__(self, command):
        # MySQL 8.0 has no --no-login-paths. Its supported environment override
        # isolates the implicit .mylogin.cnf without reading real login paths.
        environment = {**os.environ, "MYSQL_TEST_LOGIN_FILE": os.devnull}
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
        self.lines = queue.Queue(maxsize=512)
        self.failed = threading.Event()
        self.closed = threading.Event()
        threading.Thread(target=self.read_stdout, daemon=True).start()
        threading.Thread(target=self.read_stderr, daemon=True).start()

    def read_stdout(self):
        try:
            while not self.closed.is_set():
                line = self.process.stdout.readline(8 * 1024 * 1024 + 1)
                if not line:
                    break
                if len(line) > 8 * 1024 * 1024:
                    self.failed.set()
                    break
                while not self.closed.is_set():
                    try:
                        self.lines.put(line, timeout=0.1)
                        break
                    except queue.Full:
                        continue
        finally:
            while not self.closed.is_set():
                try:
                    self.lines.put(None, timeout=0.1)
                    break
                except queue.Full:
                    continue

    def read_stderr(self):
        # Consume diagnostics to prevent pipe deadlocks; never expose SQL or
        # authentication details embedded in mysql's error messages.
        while not self.closed.is_set():
            chunk = self.process.stderr.read(1024)
            if not chunk:
                break
            self.failed.set()

    def query(self, sql):
        boundary = "mysql_search_" + uuid.uuid4().hex
        try:
            self.process.stdin.write((sql + ";\nSELECT '" + boundary + "' AS __mysql_search_boundary;\n").encode())
            self.process.stdin.flush()
        except (OSError, BrokenPipeError):
            raise QueryFailure("MySQL 会话中断，禁止重连或重试") from None
        deadline = time.monotonic() + 25
        result = []
        total = 0
        while time.monotonic() < deadline:
            if self.failed.is_set():
                raise QueryFailure("MySQL 会话报告错误，禁止继续执行")
            try:
                line = self.lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if line is None:
                raise QueryFailure("MySQL 会话中断，禁止重连或重试")
            total += len(line)
            if total > 8 * 1024 * 1024:
                raise QueryFailure("MySQL 结果超过 8 MiB，拒绝输出")
            text = line.decode("utf-8").rstrip("\r\n")
            if text == boundary:
                if not result or result[-1] != "__mysql_search_boundary":
                    raise QueryFailure("MySQL 会话边界格式异常")
                return result[:-1]
            result.append(text)
        raise QueryFailure("MySQL 会话等待超时，禁止继续执行")

    def close(self):
        self.closed.set()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


def execute(mysql_bin, option_file, database, limit, supplied_plan, allow_unencrypted=False):
    # Re-validate even if this helper is invoked directly with a forged plan.
    plan = validate(supplied_plan["sql"], database, limit)
    check_option_file(option_file, database, allow_unencrypted)
    command = [mysql_bin, "--defaults-file=" + str(option_file), "--connect-timeout=8",
               "--init-command=SET SESSION MAX_EXECUTION_TIME=15000, transaction_read_only=ON",
               "--binary-mode", "--local-infile=0", "--skip-reconnect", "--skip-force",
               "--batch", "--unbuffered", "--skip-auto-rehash", "--column-names"]
    session = Session(command)
    try:
        identity = session.query("START TRANSACTION READ ONLY; SELECT VERSION() AS server_version, DATABASE() AS database_name, @@SESSION.transaction_read_only AS session_readonly")
        if len(identity) != 2 or identity[0] != "server_version\tdatabase_name\tsession_readonly":
            raise QueryFailure("无法核验 MySQL 版本、数据库和会话只读状态")
        fields = identity[1].split("\t")
        if len(fields) != 3 or not supported_server_version(fields[0]) or fields[1] != database or fields[2] != "1":
            raise QueryFailure("BPM 要求 MySQL 5.7.20+ 或 8.0、目标数据库匹配和已启用的只读会话")
        if plan["metadata_sql"]:
            metadata = session.query(plan["metadata_sql"])
            columns = ["TABLE_SCHEMA", "TABLE_NAME", "TABLE_TYPE", "ENGINE"]
            if not metadata or metadata[0].split("\t") != columns:
                raise QueryFailure("MySQL 元数据格式异常")
            rows = []
            for line in metadata[1:]:
                cells = line.split("\t")
                if len(cells) != 4:
                    raise QueryFailure("MySQL 元数据格式异常")
                rows.append(dict(zip(columns, cells)))
            verify_tables(plan, rows)
        result = session.query(plan["sql"])
        if len(result) - 1 > limit:
            raise QueryFailure("MySQL 返回行数超过生产上限，拒绝输出")
        session.query("ROLLBACK")
        session.process.stdin.close()
        if session.process.wait(timeout=3) != 0 or session.failed.is_set():
            raise QueryFailure("MySQL 会话未正常结束，拒绝输出")
        return result
    finally:
        session.close()


def render_table(lines):
    rows = [line.split("\t") for line in lines]
    if not rows:
        return ""
    columns = len(rows[0])
    if any(len(row) != columns for row in rows):
        raise QueryFailure("MySQL 结果格式异常")
    widths = [max(len(row[index]) for row in rows) for index in range(columns)]
    border = "+" + "+".join("-" * (width + 2) for width in widths) + "+"
    output = [border]
    for index, row in enumerate(rows):
        output.append("| " + " | ".join(cell.ljust(width) for cell, width in zip(row, widths)) + " |")
        if index == 0:
            output.append(border)
    output.append(border)
    return "\n".join(output)


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--mysql-bin", required=True)
    cli.add_argument("--option-file", required=True)
    cli.add_argument("--database", required=True)
    cli.add_argument("--limit", type=int, required=True)
    cli.add_argument("--format", choices=("tsv", "table"), default="tsv")
    cli.add_argument("--plan", required=True)
    cli.add_argument("--allow-unencrypted", action="store_true")
    args = cli.parse_args()
    try:
        if not 1 <= args.limit <= 200:
            raise QueryFailure("BPM 生产查询最多 200 行")
        lines = execute(args.mysql_bin, args.option_file, args.database, args.limit, json.loads(args.plan), args.allow_unencrypted)
        if lines:
            print(render_table(lines) if args.format == "table" else "\n".join(lines))
    except Rejected:
        print("BPM SQL/表对象只读校验失败，拒绝执行", file=sys.stderr)
        return 3
    except QueryFailure as error:
        # These messages are fixed strings authored here, never raw diagnostics.
        print("BPM MySQL 只读会话失败：" + str(error), file=sys.stderr)
        return 5
    except (OSError, ValueError, KeyError, TypeError, UnicodeError, subprocess.TimeoutExpired):
        print("BPM MySQL 只读会话失败；未自动重连、切换连接或输出原始错误", file=sys.stderr)
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main())
