"""Offline policy/transport regression tests. No real credentials or servers."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sql_guard", ROOT / "scripts/sql_guard.py")
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)

ALLOWED = [
    "SELECT 1", "SELECT VERSION(), DATABASE()", "SELECT COUNT (*) FROM customers",
    "SELECT id, name FROM customers WHERE id=1 LIMIT 20",
    "SELECT COUNT(*) FROM customers WHERE status IN (1,2)",
    "SELECT a.id,b.code FROM customers a LEFT JOIN orders b ON a.id=b.customer_id WHERE a.id=1",
    "SELECT id FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE id=2)",
    "SELECT id FROM customers WHERE EXISTS (SELECT 1 FROM orders WHERE customer_id=customers.id)",
    "SELECT COUNT(DISTINCT status), SUM(id) FROM customers GROUP BY status HAVING COUNT(*)>1 ORDER BY status DESC",
    "SELECT CASE WHEN id=1 THEN 'yes' ELSE 'no' END AS label FROM customers",
    "SELECT CAST(id AS CHAR(20)), TIMESTAMPDIFF(DAY, created_at, NOW()) FROM customers",
    "SELECT id FROM (SELECT id FROM customers WHERE id=1) AS c",
    "SELECT id FROM customers WHERE id BETWEEN 1 AND 3 AND name NOT LIKE 'abc%'",
    "SELECT id FROM customers WHERE status IS NOT NULL AND id NOT IN (1,2)",
    "SELECT 1 UNION ALL SELECT 2", "SELECT 1 UNION ALL SELECT 2 LIMIT 3",
    "SELECT 'UPDATE; -- /* # GET_LOCK()' AS note", "SELECT 'O''Brien' AS name;",
    "SELECT `status`, `order` FROM `customers`",
    "SHOW TABLES", "SHOW FULL TABLES FROM audit LIKE 'customer%'",
    "SHOW COLUMNS FROM customers", "SHOW INDEX FROM customers",
    "SHOW CREATE TABLE customers", "SHOW SESSION VARIABLES LIKE 'version%'",
    "SHOW GLOBAL STATUS LIKE 'Threads_connected'", "DESC customers", "DESCRIBE customers 'id'",
    "EXPLAIN SELECT id FROM customers WHERE id=1",
    "EXPLAIN FORMAT=JSON SELECT id FROM customers WHERE id=1",
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='audit' LIMIT 10",
]
DENIED = [
    "UPDATE customers SET name='x'", "DELETE FROM customers", "INSERT INTO customers VALUES (1)",
    "REPLACE INTO customers VALUES (1)", "DROP TABLE customers", "CREATE TABLE t(id INT)",
    "ALTER TABLE customers ADD id2 INT", "TRUNCATE customers", "GRANT SELECT ON audit.* TO user",
    "SET autocommit=1", "CALL p()", "START TRANSACTION", "COMMIT", "ROLLBACK",
    "SELECT 1; DELETE FROM customers", "SELECT 1;;", "SELECT 1 -- comment", "SELECT 1 # comment",
    "SELECT /*!80000 SLEEP(1) */ 1", "SELECT /*+ SET_VAR(max_execution_time=0) */ 1",
    "SELECT 1 INTO OUTFILE '/tmp/probe'", "SELECT 1 INTO DUMPFILE '/tmp/probe'",
    "SELECT id FROM customers FOR UPDATE", "SELECT id FROM customers FOR SHARE",
    "SELECT id FROM customers LOCK IN SHARE MODE", "SELECT GET_LOCK('probe',0)",
    "SELECT RELEASE_LOCK('probe')", "SELECT RELEASE_ALL_LOCKS()", "SELECT SLEEP(1)",
    "SELECT BENCHMARK(100,1)", "SELECT LOAD_FILE('/tmp/probe')", "SELECT LAST_INSERT_ID(123)",
    "SELECT audit_side_effect()", "SELECT audit.abs(1)", "SELECT `ABS`(1)", "SELECT `audit`.`ABS`(1)",
    "SELECT GET_LOCK ('probe',0)", "SELECT `GET_LOCK` ('probe',0)",
    "SELECT @x:=1", "SELECT 1 INTO @x", "SELECT @@version", "SELECT @x",
    "EXPLAIN ANALYZE SELECT 1", "DESCRIBE ANALYZE SELECT 1", "DESC ANALYZE SELECT 1",
    "EXPLAIN UPDATE customers SET id=1", "EXPLAIN FOR CONNECTION 1",
    "SHOW BINLOG EVENTS", "SHOW PROCESSLIST", "SHOW ENGINE INNODB STATUS",
    "SELECT id FROM other.customers", "SELECT other.customers.id FROM customers",
    "SELECT * FROM sys.processlist", "SELECT * FROM customers PROCEDURE ANALYSE()",
    "SELECT 1 LIMIT 201", "SELECT 1 LIMIT 0,201", "SELECT 1 LIMIT 201 OFFSET 0",
    "SELECT 1 UNION ALL SELECT 2 LIMIT 201", "SELECT 1 LIMIT @n", "SELECT 'unterminated",
    'SELECT "ambiguous"', "SELECT 1\x00", "SELECT 1\\g", "SELECT 1\n\\! touch /tmp/probe",
    "SELECT 1\ndelimiter $$\nDELETE FROM customers", "SELECT 'a\\'b'",
    "WITH t AS (SELECT 1) DELETE FROM customers", "SELECT * FROM JSON_TABLE('{}', '$') AS j",
    "SELECT 1 UNION SELECT 2 LIMIT 20 ORDER BY 1 LIMIT 20",
    *[f"SELECT {modifier} id FROM customers" for modifier in guard.SELECT_MODIFIERS],
]


class GuardTests(unittest.TestCase):
    def test_read_queries(self):
        for sql in ALLOWED:
            with self.subTest(sql=sql):
                plan = guard.validate(sql, "audit", 200)
                self.assertTrue(plan["sql"])
                if plan["kind"] == "SELECT":
                    self.assertIn("LIMIT", plan["sql"])

    def test_rejects_side_effects_and_unknown_syntax(self):
        for sql in DENIED:
            with self.subTest(sql=sql):
                with self.assertRaises(guard.Rejected):
                    guard.validate(sql, "audit", 200)

    def test_limit_literals_are_not_mistaken_for_sql(self):
        self.assertEqual(guard.validate("SELECT 'LIMIT 900'", "audit", 3)["sql"], "SELECT 'LIMIT 900' LIMIT 3")

    def test_collects_every_table(self):
        plan = guard.validate("SELECT a.id FROM customers a JOIN orders b ON a.id=b.customer_id WHERE EXISTS (SELECT 1 FROM items WHERE id=b.id)", "audit", 200)
        self.assertEqual(plan["tables"], [("audit", "customers"), ("audit", "items"), ("audit", "orders")])

    def test_metadata_must_match_and_be_native_base_tables(self):
        plan = guard.validate("SELECT id FROM customers", "audit", 200)
        row = {"TABLE_SCHEMA": "audit", "TABLE_NAME": "customers", "TABLE_TYPE": "BASE TABLE", "ENGINE": "InnoDB"}
        guard.verify_tables(plan, [row])
        for rows in ([], [row, row], [{**row, "TABLE_TYPE": "VIEW"}], [{**row, "ENGINE": "FEDERATED"}], [{**row, "TABLE_NAME": "other"}], [{**row, "ENGINE": None}]):
            with self.subTest(rows=rows), self.assertRaises(guard.Rejected):
                guard.verify_tables(plan, rows)


MOCK_CLIENT = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['AUDIT_LOG'], 'a') as f:
    f.write(json.dumps({'client': name, 'args': args}) + '\\n')
if name == 'security':
    print('offline-test-password')
    sys.exit(0)
sql = args[args.index('--Script') + 1] if name == 'aliyun' else next(x.split('=',1)[1] for x in args if x.startswith('--execute='))
metadata = 'FROM information_schema.TABLES WHERE' in sql
if metadata:
    mode = os.environ.get('AUDIT_METADATA', 'base')
    rows = [] if mode == 'missing' else [{'TABLE_SCHEMA':'audit', 'TABLE_NAME':'customers', 'TABLE_TYPE':'VIEW' if mode == 'view' else 'BASE TABLE', 'ENGINE':'FEDERATED' if mode == 'external' else 'InnoDB'}]
else:
    rows = [{'id': 1}]
if name == 'aliyun':
    print(json.dumps({'Success':True,'Results':[{'Success':True,'ColumnNames':list(rows[0]) if rows else [],'Rows':rows,'RowCount':len(rows)}]}))
elif metadata:
    for row in rows:
        print('\\t'.join(row.values()))
else:
    print('id\\n1')
'''


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mysql-search-test-")
        self.base = Path(self.temp.name)
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        # Isolate PATH entirely: no real DB clients or Keychain binaries can run.
        for command in ("bash", "python3", "jq", "dirname", "mktemp", "mkdir", "mv", "rm", "rmdir", "chmod"):
            (bin_dir / command).symlink_to(shutil.which(command))
        for client in ("mysql", "aliyun", "security"):
            target = bin_dir / client
            target.write_text(MOCK_CLIENT)
            target.chmod(0o700)
        config = self.base / "config/fangzhikun-skills/mysql-search"
        config.mkdir(parents=True)
        direct = {"host": "offline.invalid", "port": 3306, "username": "audit", "sslMode": "REQUIRED", "keychainService": "offline-only"}
        for environment in ("dev", "pre"):
            (config / (environment + ".json")).write_text(json.dumps(direct))
        (config / "prod.json").write_text(json.dumps({"transport":"dms", "region":"cn-hangzhou", "tenantId":"1", "aliyunProfile":"offline", "databases":{"audit":{"dbId":"1", "logic":False}}}))
        self.log = self.base / "calls.jsonl"
        self.env = {**os.environ, "PATH": str(bin_dir), "XDG_CONFIG_HOME": str(self.base / "config"), "AUDIT_LOG": str(self.log), "PYTHONDONTWRITEBYTECODE": "1"}

    def tearDown(self):
        self.temp.cleanup()

    def run_query(self, environment, sql, **env):
        if self.log.exists():
            self.log.unlink()
        result = subprocess.run(["bash", str(ROOT / "scripts/query.sh"), "--env", environment, "--database", "audit", "--sql", sql], env={**self.env, **env}, capture_output=True, text=True, timeout=15)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def test_rejected_sql_never_reaches_clients_or_credentials(self):
        for environment in ("dev", "pre", "prod"):
            for sql in DENIED:
                if "\x00" in sql:
                    # POSIX argv cannot contain NUL. The stdin guard test above
                    # covers it; subprocess rejects it before a shell can run.
                    continue
                with self.subTest(environment=environment, sql=sql):
                    result, calls = self.run_query(environment, sql)
                    self.assertEqual(result.returncode, 3, result.stderr)
                    self.assertEqual(calls, [])

    def test_valid_query_checks_metadata_before_business_query(self):
        for environment in ("dev", "pre", "prod"):
            with self.subTest(environment=environment):
                result, calls = self.run_query(environment, "SELECT id FROM customers WHERE id=1")
                self.assertEqual(result.returncode, 0, result.stderr)
                db_calls = [c for c in calls if c["client"] != "security"]
                self.assertEqual(len(db_calls), 2)
                self.assertIn("information_schema.TABLES", " ".join(db_calls[0]["args"]))
                self.assertIn("SELECT id FROM customers WHERE id = 1 LIMIT 200", " ".join(db_calls[1]["args"]))
                if environment != "prod":
                    for call in db_calls:
                        args = call["args"]
                        self.assertIn("--binary-mode", args)
                        self.assertIn("--local-infile=0", args)
                        self.assertIn("--no-login-paths", args)
                        self.assertTrue(args[0].startswith("--defaults-file="))
                        self.assertIn("transaction_read_only=ON", " ".join(args))
                        self.assertIn("START TRANSACTION READ ONLY;", " ".join(args))

    def test_unsafe_or_missing_table_metadata_blocks_business_query(self):
        for environment in ("dev", "pre", "prod"):
            for mode in ("view", "external", "missing"):
                with self.subTest(environment=environment, mode=mode):
                    result, calls = self.run_query(environment, "SELECT id FROM customers", AUDIT_METADATA=mode)
                    self.assertEqual(result.returncode, 3, result.stderr)
                    db_calls = [c for c in calls if c["client"] != "security"]
                    self.assertEqual(len(db_calls), 1)
                    self.assertIn("information_schema.TABLES", " ".join(db_calls[0]["args"]))

    def test_missing_guard_fails_closed(self):
        isolated = self.base / "isolated"
        isolated.mkdir()
        shutil.copy2(ROOT / "scripts/query.sh", isolated / "query.sh")
        result = subprocess.run(["bash", str(isolated / "query.sh"), "--env", "prod", "--database", "audit", "--sql", "SELECT 1"], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 4)
        self.assertFalse(self.log.exists())


if __name__ == "__main__":
    unittest.main()
