"""Offline OP/BPM routing, migration and single-session enforcement."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

from test_readonly import ROOT, TransportTests, DENIED

spec = importlib.util.spec_from_file_location("connections", ROOT / "scripts/connections.py")
policy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = policy
spec.loader.exec_module(policy)

STREAM_CLIENT = '''#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path
args = sys.argv[1:]
def record(item):
    with open(os.environ['AUDIT_LOG'],'a') as f:
        f.write(json.dumps(item)+'\\n')
record({'client':'mysql','args':args})
database = os.environ.get('AUDIT_DATABASE','bpm_database')
for line in sys.stdin:
    sql = line.strip()
    record({'client':'mysql-stdin','sql':sql})
    marker = re.fullmatch("SELECT '(mysql_search_[a-f0-9]+)' AS __mysql_search_boundary;",sql)
    if marker:
        print('__mysql_search_boundary', flush=True)
        print(marker[1], flush=True)
    elif 'SELECT VERSION() AS server_version' in sql:
        print('server_version\\tdatabase_name\\tsession_readonly',flush=True)
        print(os.environ.get('AUDIT_VERSION','8.0.36')+'\\t'+os.environ.get('AUDIT_ACTUAL_DB',database)+'\\t'+os.environ.get('AUDIT_READONLY','1'),flush=True)
    elif 'FROM information_schema.TABLES WHERE' in sql:
        if os.environ.get('AUDIT_FAIL') == 'metadata':
            print('ERROR: DO_NOT_ECHO SQL or credentials',file=sys.stderr,flush=True)
            sys.exit(1)
        print('TABLE_SCHEMA\\tTABLE_NAME\\tTABLE_TYPE\\tENGINE',flush=True)
        mode=os.environ.get('AUDIT_METADATA','base')
        if mode != 'missing':
            print(database+'\\tcustomers\\t'+('VIEW' if mode=='view' else 'BASE TABLE')+'\\t'+('FEDERATED' if mode=='external' else 'InnoDB'),flush=True)
    elif sql == 'ROLLBACK;':
        pass
    else:
        if os.environ.get('AUDIT_FAIL') == 'business':
            print('ERROR: DO_NOT_ECHO SQL or credentials',file=sys.stderr,flush=True)
            sys.exit(1)
        print('id',flush=True)
        for n in range(int(os.environ.get('AUDIT_ROWS','1'))):
            print(n+1,flush=True)
'''


class ConnectionTests(unittest.TestCase):
    setUp = TransportTests.setUp
    tearDown = TransportTests.tearDown

    def run_cli(self, script, args, **environment):
        if self.log.exists():
            self.log.unlink()
        command = ["bash" if script.endswith(".sh") else "python3", str(ROOT / "scripts" / script), *args]
        result = subprocess.run(command, env={**self.env, **environment}, text=True, capture_output=True, timeout=15)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def write_bpm(self, configured=True, **fields):
        config = self.base / "config/fangzhikun-skills/mysql-search/connections/bpm/prod.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        data = {"connection":"bpm", "environment":"prod", "transport":"mysql", "enabled":True,
                "configured":configured, "allowedDatabases":["bpm_database"], "host":"bpm.invalid", "port":3306,
                "username":"audit", "keychainService":"codex.mysql-search.bpm.prod", "sslMode":"REQUIRED"}
        data.update(fields)
        config.write_text(json.dumps(data))
        return config

    def bpm_query(self, sql="SELECT id FROM customers WHERE id=1", **environment):
        return self.run_cli("query.sh", ["--connection","bpm","--env","prod","--database","bpm_database","--sql",sql], **environment)

    def streaming_mysql(self):
        path = self.base / "bin/mysql"
        path.write_text(STREAM_CLIENT)
        path.chmod(0o700)

    def test_op_routes_and_legacy_default(self):
        for env, expected in (("dev","mysql"),("pre","mysql"),("prod","aliyun")):
            for connection_args in ([], ["--connection","op"], ["--connection","OP数据库连接"]):
                with self.subTest(env=env, explicit=connection_args):
                    result, calls = self.run_cli("query.sh", [*connection_args,"--env",env,"--database","audit","--sql","SELECT 1"])
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual([c["client"] for c in calls if c["client"] != "security"], [expected])
                    self.assertIn("OP数据库连接",result.stderr)

    def test_invalid_bpm_targets_fail_before_credentials(self):
        self.write_bpm()
        for env, database in (("dev","bpm_database"),("pre","bpm_database"),("prod","other")):
            with self.subTest(env=env, database=database):
                result,calls=self.run_cli("query.sh",["--connection","bpm","--env",env,"--database",database,"--sql","SELECT 1"])
                self.assertEqual(result.returncode,4,result.stderr)
                self.assertEqual(calls,[])

    def test_bpm_database_requires_explicit_connection(self):
        self.write_bpm()
        result,calls=self.run_cli("query.sh",["--env","prod","--database","bpm_database","--sql","SELECT 1"])
        self.assertEqual(result.returncode,4)
        self.assertIn("--connection bpm",result.stderr)
        self.assertEqual(calls,[])

    def test_invalid_bpm_config_does_not_break_legacy_op_queries(self):
        path = self.write_bpm()
        for content in ('{broken', '{"connection":"bpm","environment":"pre","transport":"mysql"}'):
            path.write_text(content)
            for env in ("dev", "pre", "prod"):
                with self.subTest(content=content, env=env):
                    result, calls = self.run_cli("query.sh", ["--env", env, "--database", "audit", "--sql", "SELECT 1"])
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("OP数据库连接", result.stderr)
                    self.assertFalse(any("codex.mysql-search.bpm.prod" in c["args"] for c in calls))

    def test_pending_disabled_and_wrong_transport_fail_closed(self):
        for fields in ({"configured":False},{"enabled":False},{"transport":"dms"},{"sslMode":"PREFERRED"},{"keychainService":"codex.mysql-search.dev"},{"environment":"pre"},{"readonly":False}):
            with self.subTest(fields=fields):
                self.write_bpm(**fields)
                result,calls=self.bpm_query()
                self.assertEqual(result.returncode,4,result.stderr)
                self.assertEqual(calls,[])

    def test_bpm_rejected_sql_never_reaches_any_client(self):
        self.write_bpm()
        for sql in DENIED:
            if "\x00" in sql:
                continue
            with self.subTest(sql=sql):
                result,calls=self.bpm_query(sql)
                self.assertEqual(result.returncode,3,result.stderr)
                self.assertEqual(calls,[])

    def test_bpm_uses_one_readonly_session_and_separate_keychain(self):
        self.write_bpm()
        self.streaming_mysql()
        result,calls=self.bpm_query()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout,"id\n1\n")
        self.assertIn("BPM数据库连接",result.stderr)
        self.assertEqual(sum(c["client"]=="mysql" for c in calls),1)
        self.assertEqual(sum(c["client"]=="aliyun" for c in calls),0)
        credential=next(c for c in calls if c["client"]=="security")
        self.assertIn("codex.mysql-search.bpm.prod",credential["args"])
        mysql=next(c for c in calls if c["client"]=="mysql")
        for flag in ("--binary-mode","--local-infile=0","--skip-reconnect","--skip-force"):
            self.assertIn(flag,mysql["args"])
        sql=[c["sql"] for c in calls if c["client"]=="mysql-stdin"]
        self.assertTrue(sql[0].startswith("START TRANSACTION READ ONLY;"))
        metadata=next(i for i,s in enumerate(sql) if "information_schema.TABLES WHERE" in s)
        business=next(i for i,s in enumerate(sql) if s.startswith("SELECT id FROM customers"))
        self.assertLess(metadata,business)
        self.assertIn("LIMIT 200",sql[business])
        self.assertIn("ROLLBACK;",sql)

    def test_invalid_server_identity_stops_before_metadata_and_business(self):
        self.write_bpm()
        self.streaming_mysql()
        for environment in ({"AUDIT_VERSION":"5.7.44"},{"AUDIT_ACTUAL_DB":"other"},{"AUDIT_READONLY":"0"}):
            with self.subTest(environment=environment):
                result,calls=self.bpm_query(**environment)
                self.assertEqual(result.returncode,5,result.stderr)
                self.assertNotIn("SELECT id FROM customers",json.dumps(calls))
                self.assertNotIn("information_schema.TABLES WHERE",json.dumps(calls))

    def test_unsafe_metadata_stops_before_business_in_same_session(self):
        self.write_bpm()
        self.streaming_mysql()
        for mode in ("view","external","missing"):
            with self.subTest(mode=mode):
                result,calls=self.bpm_query(AUDIT_METADATA=mode)
                self.assertEqual(result.returncode,3,result.stderr)
                self.assertNotIn("SELECT id FROM customers",json.dumps(calls))
                self.assertEqual(sum(c["client"]=="mysql" for c in calls),1)

    def test_server_error_never_retries_or_leaks_diagnostics(self):
        self.write_bpm()
        self.streaming_mysql()
        for phase in ("metadata","business"):
            with self.subTest(phase=phase):
                result,calls=self.bpm_query(AUDIT_FAIL=phase)
                self.assertEqual(result.returncode,5,result.stderr)
                self.assertNotIn("DO_NOT_ECHO",result.stdout+result.stderr)
                self.assertEqual(result.stdout,"")
                self.assertEqual(sum(c["client"]=="mysql" for c in calls),1)
                self.assertFalse(any(c["client"]=="aliyun" for c in calls))

    def test_bpm_production_row_cap(self):
        self.write_bpm()
        self.streaming_mysql()
        result,calls=self.bpm_query(AUDIT_ROWS="201")
        self.assertEqual(result.returncode,5,result.stderr)
        self.assertEqual(result.stdout,"")
        result,calls=self.run_cli("query.sh",["--connection","bpm","--env","prod","--database","bpm_database","--sql","SELECT 1","--limit","500"])
        self.assertEqual(result.returncode,2)
        self.assertEqual(calls,[])

    def test_migration_preserves_routes_and_credentials_and_never_overwrites(self):
        root=self.base / "config/fangzhikun-skills/mysql-search"
        before={env:json.loads((root/(env+".json")).read_text()) for env in ("dev","pre","prod")}
        result,calls=self.run_cli("connections.py",["migrate-op"])
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(calls,[])
        for env,old in before.items():
            self.assertEqual(json.loads((root/(env+".json")).read_text()),old)
            new=json.loads((root/"connections/op"/(env+".json")).read_text())
            self.assertEqual(new["transport"],"dms" if env=="prod" else "mysql")
            for key,value in old.items():
                self.assertEqual(new[key],value)
        target=root/"connections/op/dev.json"
        content=target.read_bytes()
        result,_=self.run_cli("connections.py",["migrate-op"])
        self.assertEqual(json.loads(result.stdout)["migratedEnvironments"],[])
        self.assertEqual(target.read_bytes(),content)

    def test_new_invalid_op_config_never_falls_back_to_legacy(self):
        path=self.base / "config/fangzhikun-skills/mysql-search/connections/op/prod.json"
        path.parent.mkdir(parents=True)
        path.write_text('{"connection":"op","environment":"prod","transport":"mysql"}')
        result,calls=self.run_cli("query.sh",["--connection","op","--env","prod","--database","audit","--sql","SELECT 1"])
        self.assertEqual(result.returncode,4)
        self.assertEqual(calls,[])

    def test_local_management_never_reads_credentials_and_list_redacts_endpoints(self):
        result,calls=self.run_cli("connections.py",["init-bpm","--connection","bpm","--env","prod","--database","bpm_database"])
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(calls,[])
        result,calls=self.run_cli("connections.py",["list"])
        self.assertIn('"pending"',result.stdout)
        self.assertNotIn("offline.invalid",result.stdout)
        self.assertNotIn("username",result.stdout)
        self.assertEqual(calls,[])
        for action,expected in (("disable",False),("enable",True)):
            result,calls=self.run_cli("connections.py",[action,"--connection","bpm","--env","prod"])
            self.assertEqual(json.loads(result.stdout)["enabled"],expected)
            self.assertEqual(calls,[])

    def test_bpm_configure_stores_only_nonsecret_config_and_isolates_credentials(self):
        self.write_bpm(configured=False)
        result,calls=self.run_cli("configure.sh",["--connection","bpm","--env","prod","--database","bpm_database","--host","bpm.invalid","--port","3306","--username","audit","--ssl-mode","REQUIRED"])
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]["client"],"security")
        self.assertIn("codex.mysql-search.bpm.prod",calls[0]["args"])
        config=json.loads((self.base/"config/fangzhikun-skills/mysql-search/connections/bpm/prod.json").read_text())
        self.assertTrue(config["configured"])
        self.assertEqual(config["allowedDatabases"],["bpm_database"])
        self.assertNotIn("password",config)
        self.assertNotIn("offline-test-password",json.dumps(config))

    def test_bpm_configure_cannot_change_registered_database_or_downgrade_tls(self):
        self.write_bpm(configured=False)
        for database,mode in (("other","REQUIRED"),("bpm_database","PREFERRED"),("bpm_database","VERIFY_IDENTITY")):
            with self.subTest(database=database,mode=mode):
                result,calls=self.run_cli("configure.sh",["--connection","bpm","--env","prod","--database",database,"--host","bpm.invalid","--port","3306","--username","audit","--ssl-mode",mode])
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(calls,[])

    def test_op_reconfigure_preserves_database_scope(self):
        path = self.base / "config/fangzhikun-skills/mysql-search/dev.json"
        original = json.loads(path.read_text())
        original["allowedDatabases"] = ["audit"]
        path.write_text(json.dumps(original))
        result, _ = self.run_cli("configure.sh", ["--connection", "op", "--env", "dev", "--host", "op.invalid", "--port", "3306", "--username", "audit", "--ssl-mode", "REQUIRED"])
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.base / "config/fangzhikun-skills/mysql-search/connections/op/dev.json"
        self.assertEqual(json.loads(config.read_text())["allowedDatabases"], ["audit"])
        result, calls = self.run_cli("query.sh", ["--env", "dev", "--database", "other", "--sql", "SELECT 1"])
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
