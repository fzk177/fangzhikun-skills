#!/usr/bin/env python3
"""Fail-closed MySQL query subset. Standard library only; never connects to a DB.

This is deliberately not a general SQL parser: unsupported syntax is rejected.
Only the canonical SQL returned here may be sent to a transport.
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass


class Rejected(ValueError):
    pass


# MySQL 8.0 native functions only. Never accept quoted/qualified function names.
# Additions require checking native availability and absence of side effects.
FUNCTIONS = set("""
ABS CEIL CEILING FLOOR ROUND TRUNCATE MOD POW POWER SQRT SIGN
COUNT SUM AVG MIN MAX
CONCAT CONCAT_WS LOWER UPPER LENGTH CHAR_LENGTH CHARACTER_LENGTH
LEFT RIGHT SUBSTR SUBSTRING TRIM LTRIM RTRIM REPLACE LOCATE INSTR
COALESCE IFNULL NULLIF IF GREATEST LEAST
DATE TIME YEAR MONTH DAY DAYOFMONTH DAYOFWEEK DAYOFYEAR HOUR MINUTE SECOND
DATE_FORMAT DATEDIFF TIMESTAMPDIFF NOW CURDATE CURTIME
JSON_EXTRACT JSON_UNQUOTE JSON_LENGTH JSON_CONTAINS JSON_TYPE
VERSION DATABASE CAST
""".split())
UNITS = set("MICROSECOND SECOND MINUTE HOUR DAY WEEK MONTH QUARTER YEAR".split())
TYPES = set("CHAR DATE DATETIME TIME DECIMAL SIGNED UNSIGNED BINARY".split())
SELECT_MODIFIERS = set("""
SQL_CALC_FOUND_ROWS SQL_BUFFER_RESULT SQL_BIG_RESULT SQL_SMALL_RESULT
HIGH_PRIORITY STRAIGHT_JOIN DISTINCTROW SQL_NO_CACHE SQL_CACHE
""".split())
CLAUSE_WORDS = set("""
SELECT DISTINCT ALL FROM WHERE GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET
JOIN INNER LEFT RIGHT CROSS OUTER ON AS UNION AND OR XOR NOT IN IS NULL
TRUE FALSE LIKE BETWEEN EXISTS CASE WHEN THEN ELSE END DIV MOD
EXPLAIN SHOW DESCRIBE INTO FOR LOCK PROCEDURE ANALYZE
""".split())
NATIVE_ENGINES = {"INNODB", "MYISAM", "MEMORY", "CSV", "ARCHIVE"}
MAX_TABLES = 64


@dataclass(frozen=True)
class Token:
    kind: str
    text: str

    @property
    def word(self):
        return self.text.upper() if self.kind == "word" else self.text


def tokenize(sql):
    if not sql or len(sql) > 65536:
        raise Rejected("SQL 为空或超过 64 KiB")
    # Backslashes have different interpretations under NO_BACKSLASH_ESCAPES,
    # and are mysql client command introducers. Do not permit either meaning.
    if "\\" in sql or any(ord(c) < 32 and c not in "\t\r\n" for c in sql):
        raise Rejected("禁止反斜杠和控制字符；字符串用两个单引号转义")
    tokens = []
    pos = 0
    while pos < len(sql):
        c = sql[pos]
        if c in " \t\r\n":
            pos += 1
            continue
        if sql.startswith(("--", "/*", "*/"), pos) or c == "#":
            raise Rejected("禁止 SQL 注释，包括版本注释和优化器提示")
        if c == "'":
            start = pos
            pos += 1
            while pos < len(sql):
                if sql[pos] == "'":
                    pos += 1
                    if pos < len(sql) and sql[pos] == "'":
                        pos += 1
                        continue
                    break
                pos += 1
            else:
                raise Rejected("字符串未闭合")
            tokens.append(Token("string", sql[start:pos]))
        elif c == "`":
            end = sql.find("`", pos + 1)
            if end < 0 or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", sql[pos + 1:end]):
                raise Rejected("标识符只能包含 ASCII 字母、数字、下划线和美元符")
            tokens.append(Token("identifier", sql[pos:end + 1]))
            pos = end + 1
        elif c.isascii() and (c.isalpha() or c == "_"):
            match = re.match(r"[A-Za-z_][A-Za-z0-9_$]*", sql[pos:])
            tokens.append(Token("word", match[0]))
            pos += len(match[0])
        elif c.isascii() and c.isdigit():
            match = re.match(r"[0-9]+(?:\.[0-9]+)?", sql[pos:])
            tokens.append(Token("number", match[0]))
            pos += len(match[0])
        else:
            match = re.match(r"<=>|<=|>=|<>|!=|[(),.*+/%=<>;\-]", sql[pos:])
            if not match:
                raise Rejected("SQL 含不支持的字符或操作符")
            tokens.append(Token("symbol", match[0]))
            pos += len(match[0])
        if len(tokens) > 8192:
            raise Rejected("SQL 过于复杂")
    if tokens and tokens[-1].text == ";":
        tokens.pop()
    if not tokens or any(t.text == ";" for t in tokens):
        raise Rejected("只允许一条 SQL")
    if any(t.kind == "word" and t.word in SELECT_MODIFIERS for t in tokens):
        raise Rejected("禁止影响执行范围或锁优先级的 SELECT 修饰符")
    return tokens


def render(tokens):
    text = ""
    previous = None
    for token in tokens:
        # Enforce native function name parsing even with IGNORE_SPACE disabled.
        separator = "" if token.text == "(" and previous and previous.kind == "word" and previous.word in FUNCTIONS else " "
        text += separator + token.text
        previous = token
    return text.strip()


class Parser:
    def __init__(self, tokens, database, limit):
        self.tokens = tokens
        self.pos = 0
        self.database = database
        self.limit = limit
        self.tables = set()
        self.depth = 0

    def peek(self, word=None):
        token = self.tokens[self.pos] if self.pos < len(self.tokens) else None
        return token if word is None else token is not None and token.word == word

    def take(self, word=None):
        if word is not None and not self.peek(word):
            raise Rejected("不支持的 SQL 语法")
        token = self.peek()
        if token is None:
            raise Rejected("SQL 不完整")
        self.pos += 1
        return token

    def accept(self, word):
        if self.peek(word):
            self.pos += 1
            return True
        return False

    def identifier(self):
        token = self.take()
        if token.kind not in {"word", "identifier"} or (token.kind == "word" and token.word in CLAUSE_WORDS):
            raise Rejected("需要普通标识符；保留字作为列名时必须用反引号")
        return token.text.strip("`")

    def object_name(self):
        name = self.identifier()
        schema = self.database
        if self.accept("."):
            schema, name = name, self.identifier()
        if schema != self.database and schema.lower() != "information_schema":
            raise Rejected("禁止跨业务数据库查询")
        self.tables.add((schema, name))
        if len(self.tables) > MAX_TABLES:
            raise Rejected("引用表数量超过 64")

    def alias(self):
        if self.accept("AS"):
            self.identifier()
        elif self.peek() and (self.peek().kind == "identifier" or self.peek().kind == "word" and self.peek().word not in CLAUSE_WORDS):
            self.identifier()

    def expression_list(self, aliases=False):
        self.expression()
        if aliases:
            self.alias()
        while self.accept(","):
            self.expression()
            if aliases:
                self.alias()

    def expression(self, minimum=0):
        self.depth += 1
        if self.depth > 64:
            raise Rejected("表达式嵌套超过 64 层")
        self.atom()
        precedences = {"OR": 1, "XOR": 2, "AND": 3, "=": 4, "<=>": 4, "!=": 4, "<>": 4, "<": 4, ">": 4, "<=": 4, ">=": 4, "IS": 4, "IN": 4, "LIKE": 4, "BETWEEN": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "DIV": 6, "MOD": 6}
        while self.peek():
            operator = self.peek().word
            negative = operator == "NOT" and self.pos + 1 < len(self.tokens) and self.tokens[self.pos + 1].word in {"IN", "LIKE", "BETWEEN"}
            if negative:
                operator = self.tokens[self.pos + 1].word
            precedence = precedences.get(operator, -1)
            if precedence < minimum:
                break
            if negative:
                self.take("NOT")
            self.take()
            if operator == "IS":
                self.accept("NOT")
                if not any(self.accept(value) for value in ("NULL", "TRUE", "FALSE")):
                    raise Rejected("IS 仅允许 NULL、TRUE 或 FALSE")
            elif operator == "BETWEEN":
                self.expression(precedence + 1)
                self.take("AND")
                self.expression(precedence + 1)
            elif operator == "IN":
                self.take("(")
                if self.peek("SELECT"):
                    self.select()
                else:
                    self.expression_list()
                self.take(")")
            else:
                self.expression(precedence + 1)
        self.depth -= 1

    def atom(self):
        if any(self.accept(op) for op in ("+", "-", "NOT")):
            self.expression(7)
            return
        if self.accept("EXISTS"):
            self.take("(")
            self.select()
            self.take(")")
            return
        if self.accept("("):
            if self.peek("SELECT"):
                self.select()
            else:
                self.expression_list()
            self.take(")")
            return
        if self.accept("CASE"):
            if not self.peek("WHEN"):
                self.expression()
            self.take("WHEN")
            while True:
                self.expression()
                self.take("THEN")
                self.expression()
                if not self.accept("WHEN"):
                    break
            if self.accept("ELSE"):
                self.expression()
            self.take("END")
            return
        if self.peek() and (self.peek().kind in {"string", "number"} or self.peek().word in {"NULL", "TRUE", "FALSE", "*"}):
            self.take()
            return
        start = self.take()
        if start.kind not in {"word", "identifier"}:
            raise Rejected("不支持的表达式")
        if self.peek("("):
            if start.kind != "word" or start.word not in FUNCTIONS:
                raise Rejected("只允许白名单中的未加引号、未限定 schema 的 MySQL 内置函数")
            self.take("(")
            if start.word == "CAST":
                self.expression()
                self.take("AS")
                if self.take().word not in TYPES:
                    raise Rejected("不支持的 CAST 类型")
                if self.accept("("):
                    self.integer()
                    if self.accept(","):
                        self.integer()
                    self.take(")")
            elif start.word == "TIMESTAMPDIFF":
                if self.take().word not in UNITS:
                    raise Rejected("不支持的时间单位")
                self.take(",")
                self.expression()
                self.take(",")
                self.expression()
            elif not self.peek(")"):
                self.accept("DISTINCT")
                self.expression_list()
            self.take(")")
            return
        if start.kind == "word" and start.word in CLAUSE_WORDS:
            raise Rejected("不支持的表达式关键字")
        components = [start.text.strip("`")]
        while self.accept("."):
            if self.accept("*"):
                break
            components.append(self.identifier())
        if len(components) > 3 or len(components) == 3 and components[0] != self.database and components[0].lower() != "information_schema":
            raise Rejected("禁止跨业务数据库列引用")
        if self.peek("("):
            raise Rejected("禁止限定 schema 或加引号的函数调用")

    def integer(self):
        token = self.take()
        if token.kind != "number" or not token.text.isdigit() or len(token.text) > 10:
            raise Rejected("LIMIT/类型长度仅支持非负整数字面量")
        return int(token.text)

    def table(self):
        if self.accept("("):
            # Reject parenthesized joins and table functions, allow SELECT only.
            self.select()
            self.take(")")
            self.take("AS") if self.peek("AS") else None
            self.identifier()
        else:
            self.object_name()
            self.alias()

    def select(self):
        self.take("SELECT")
        self.accept("DISTINCT") or self.accept("ALL")
        self.expression_list(aliases=True)
        if self.accept("FROM"):
            self.table()
            while True:
                if self.accept(","):
                    self.table()
                elif self.peek() and self.peek().word in {"JOIN", "INNER", "LEFT", "RIGHT", "CROSS"}:
                    join = self.take().word
                    if join != "JOIN":
                        self.accept("OUTER")
                        self.take("JOIN")
                    self.table()
                    if self.accept("ON"):
                        self.expression()
                    elif join != "CROSS":
                        raise Rejected("JOIN 必须有 ON 条件")
                else:
                    break
        if self.accept("WHERE"):
            self.expression()
        if self.accept("GROUP"):
            self.take("BY")
            self.expression_list()
        if self.accept("HAVING"):
            self.expression()
        union_limit = False
        if self.accept("UNION"):
            self.accept("ALL") or self.accept("DISTINCT")
            union_limit = self.select()
            # The recursive final branch already consumed the UNION's global
            # ORDER BY/LIMIT. Do not parse a second trailing ORDER BY/LIMIT.
            return union_limit
        if self.accept("ORDER"):
            self.take("BY")
            while True:
                self.expression()
                self.accept("ASC") or self.accept("DESC")
                if not self.accept(","):
                    break
        has_limit = self.accept("LIMIT")
        if has_limit:
            count = self.integer()
            if self.accept(","):
                count = self.integer()
            elif self.accept("OFFSET"):
                self.integer()
            if count > self.limit:
                raise Rejected("SQL LIMIT 超过本次 --limit")
        return has_limit or union_limit

    def show(self):
        self.take("SHOW")
        full = self.accept("FULL")
        if self.accept("TABLES"):
            if self.accept("FROM") or self.accept("IN"):
                if self.identifier() != self.database:
                    raise Rejected("禁止跨库 SHOW TABLES")
            if self.accept("LIKE"):
                if self.take().kind != "string":
                    raise Rejected("LIKE 需要字符串")
        elif any(self.accept(word) for word in ("COLUMNS", "FIELDS", "INDEX", "INDEXES", "KEYS")):
            self.take("FROM")
            self.object_name()
            if self.accept("LIKE"):
                if self.take().kind != "string":
                    raise Rejected("LIKE 需要字符串")
        elif not full and self.accept("CREATE"):
            self.take("TABLE")
            self.object_name()
        elif not full:
            self.accept("SESSION") or self.accept("GLOBAL")
            if not (self.accept("STATUS") or self.accept("VARIABLES")):
                raise Rejected("不支持的 SHOW 类型")
            if self.accept("LIKE"):
                if self.take().kind != "string":
                    raise Rejected("LIKE 需要字符串")
        else:
            raise Rejected("不支持的 SHOW 类型")


def validate(sql, database, limit):
    if not re.fullmatch(r"[A-Za-z0-9_]+", database) or not 1 <= limit <= 500:
        raise Rejected("数据库名或行数上限不合法")
    tokens = tokenize(sql)
    parser = Parser(tokens, database, limit)
    kind = tokens[0].word
    has_limit = False
    if kind == "SELECT":
        has_limit = parser.select()
    elif kind in {"DESC", "DESCRIBE"}:
        parser.take()
        parser.object_name()
        if parser.peek():
            if parser.peek().kind == "string":
                parser.take()
            else:
                parser.identifier()
    elif kind == "EXPLAIN":
        parser.take()
        if parser.accept("FORMAT"):
            parser.take("=")
            if parser.take().word not in {"JSON", "TREE", "TRADITIONAL"}:
                raise Rejected("不支持的 EXPLAIN 格式")
        parser.select()
    elif kind == "SHOW":
        parser.show()
    else:
        raise Rejected("只允许受支持的 SELECT、SHOW、DESC/DESCRIBE 或 EXPLAIN SELECT")
    if parser.peek():
        raise Rejected("SQL 含未允许的语法；禁止写入、锁定、ANALYZE、变量和未知函数")
    canonical = render(tokens)
    if kind == "SELECT" and not has_limit:
        canonical += f" LIMIT {limit}"
    tables = sorted(parser.tables)
    predicates = [f"(TABLE_SCHEMA = '{schema}' AND TABLE_NAME = '{name}')" for schema, name in tables]
    metadata = ""
    if tables:
        metadata = "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE FROM information_schema.TABLES WHERE " + " OR ".join(predicates) + f" LIMIT {len(tables) + 1}"
    return {"sql": canonical, "kind": kind, "tables": tables, "metadata_sql": metadata}


def dms_rows(response):
    if not isinstance(response, dict) or response.get("Success") is not True:
        raise Rejected("DMS 元数据查询失败")
    results = response.get("Results")
    if isinstance(results, dict):
        results = results.get("Result")
    if not isinstance(results, list) or len(results) != 1 or results[0].get("Success") is not True:
        raise Rejected("DMS 元数据结果数量或状态异常")
    rows = results[0].get("Rows")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise Rejected("无法识别 DMS 元数据行格式")
    return rows


def verify_tables(plan, rows):
    expected = {tuple(table) for table in plan["tables"]}
    seen = set()
    if not isinstance(rows, list) or len(rows) != len(expected):
        raise Rejected("目标表元数据缺失或数量异常，拒绝执行")
    for row in rows:
        table = (row.get("TABLE_SCHEMA"), row.get("TABLE_NAME"))
        if table not in expected or table in seen:
            raise Rejected("目标表元数据不匹配，拒绝执行")
        seen.add(table)
        if table[0].lower() == "information_schema":
            # MySQL-owned metadata objects, not user-defined views/routines.
            if row.get("TABLE_TYPE") not in {"SYSTEM VIEW", "BASE TABLE"}:
                raise Rejected("information_schema 对象类型异常")
        elif row.get("TABLE_TYPE") != "BASE TABLE" or str(row.get("ENGINE", "")).upper() not in NATIVE_ENGINES:
            raise Rejected("只允许已核验的原生基础表；禁止业务视图和外部存储引擎")


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--database")
    cli.add_argument("--limit", type=int, default=200)
    cli.add_argument("--verify", choices=("dms", "tsv"))
    cli.add_argument("--plan")
    args = cli.parse_args()
    try:
        if args.verify:
            plan = json.loads(args.plan)
            if args.verify == "dms":
                rows = dms_rows(json.load(sys.stdin))
            else:
                rows = []
                for line in sys.stdin.read().splitlines():
                    cells = line.split("\t")
                    if len(cells) != 4:
                        raise Rejected("无法识别 MySQL 元数据行格式")
                    rows.append(dict(zip(("TABLE_SCHEMA", "TABLE_NAME", "TABLE_TYPE", "ENGINE"), cells)))
            verify_tables(plan, rows)
        else:
            print(json.dumps(validate(sys.stdin.read(), args.database or "", args.limit), ensure_ascii=False))
    except (Rejected, ValueError, TypeError, KeyError, AttributeError, RecursionError):
        # Never echo SQL, literals, result rows or parser internals on failure.
        print("SQL/元数据只读校验失败：仅支持白名单查询语法、内置函数和原生基础表；拒绝执行", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
