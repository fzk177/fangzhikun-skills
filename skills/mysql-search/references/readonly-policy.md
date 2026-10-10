# 脚本只读策略与验证范围

`query.sh` 必须先核对连接/环境的固定路由并通过 `sql_guard.py` 的完整语法校验，再读取配置和凭据。`connections.py` 校验配置归属、停用状态、通道和数据库范围，不允许配置关闭只读或改变固定路由。它只执行校验器生成的规范 SQL；未识别语法、校验失败或依赖缺失一律停止。校验器只依赖 Python 3 标准库，不自动安装依赖。

## 支持范围

- `SELECT`：字段、过滤、排序、聚合、CASE、JOIN ON、子查询、UNION，以及整数 LIMIT。支持单引号字符串和简单 ASCII 标识符；保留字列名使用反引号。
- 函数仅允许代码 `FUNCTIONS` 中列出的 MySQL 5.7.20+/8.0 共有的原生无副作用函数；不支持任意函数、加引号函数或 schema 限定函数。新增函数需要核对两个支持版本的原生支持和副作用，再补充回归案例。不得因为函数名“看起来只读”而放行。
- `DESC/DESCRIBE` 仅用于表结构；`EXPLAIN` 仅允许 SELECT，可选择 JSON/TREE/TRADITIONAL 格式。
- `SHOW` 仅支持 TABLES、COLUMNS/FIELDS、INDEX/INDEXES/KEYS、CREATE TABLE、STATUS 和 VARIABLES 的已实现子集。
- 所有 SELECT 都强制最终返回上限；字符串中的 `LIMIT` 不会被误认为 SQL 子句。

禁止多语句、注释（含版本注释和优化器提示）、写入/DDL/权限语句、所有 ANALYZE 变体、显式锁、文件操作、变量、反斜杠、双引号、未知函数及 SELECT 执行修饰符。暂不支持 CTE、窗口函数、JSON_TABLE、复杂函数专用语法等；需改写为受支持的查询，禁止绕过入口。字符串中的单引号用 `''` 转义。

## 表对象与传输

校验器收集完整查询（含 JOIN、子查询和 UNION）的所有表引用。脚本生成并执行定向 `information_schema.TABLES` 元数据查询，逐一校验 schema、表名、类型和引擎；缺失或不匹配即停止。仅允许目标数据库的 BASE TABLE，且引擎为 InnoDB、MyISAM、MEMORY、CSV 或 ARCHIVE；禁止业务视图、FEDERATED 和未知引擎，防止视图隐藏函数副作用或访问外部系统。MySQL 自带 `information_schema` 对象单独允许。标识符须使用元数据中的实际拼写，不猜测或跨业务库查询。

OP dev/pre 和 BPM prod 额外设置 `transaction_read_only=ON`，执行固定的 `START TRANSACTION READ ONLY; <已校验SQL>; ROLLBACK`。客户端仅读取临时 option 文件，使用 MYSQL_TEST_LOGIN_FILE=/dev/null 隔离 login paths，禁用本地文件导入和客户端命令；密码/配置值中的换行不会成为 option 指令。

BPM prod 使用单一 MySQL 5.7.20+/8.0 会话：开启只读事务后核验版本、实际数据库、会话只读状态，核验目标表，再发送业务 SQL。客户端禁止自动重连和出错后继续，结果超过 200 行或 8 MiB 时不输出；异常关闭会话，正常回滚后输出。单独调用执行器时仍重新校验 SQL，并拒绝 option 文件中的额外客户端指令。

OP prod 仍仅使用 DMS ExecuteScript。元数据和业务查询分别调用，结果数量/行数异常时拒绝输出，不尝试直连或其他环境。结果行数校验不是执行前的只读保障。

MySQL 8.0 的客户端不支持 --no-login-paths；通过官方支持的 MYSQL_TEST_LOGIN_FILE 指向空设备，避免隐式读取 .mylogin.cnf。独立 BPM 执行器也主动设置该环境，不继承调用方的真实登录配置。见 [官方登录配置说明](https://dev.mysql.com/doc/refman/8.0/en/mysql-config-editor.html)。

## 固定会话控制与读写账号

BPM 执行器只发送固定的 `SET SESSION MAX_EXECUTION_TIME=15000, transaction_read_only=ON`、`START TRANSACTION READ ONLY`、版本/实际库/会话只读状态查询、生成的表元数据查询、已重新校验的用户查询、随机边界 SELECT 和 `ROLLBACK`。SET 只设置当前会话的超时与只读模式，START/ROLLBACK 控制当前只读事务；不发送 SET GLOBAL、COMMIT、业务 DML、DDL、GRANT 或存储例程调用。配置入口只操作本机 JSON 和钥匙串，不连接数据库或发送 SQL。

5.7 仅支持 5.7.20 及以上，因为 `transaction_read_only` 从此版本提供；8.0 保持原行为。版本、数据库和会话状态不匹配时，元数据与业务 SQL 均不发送。MySQL 兼容产品不自动归入支持范围，不因版本失败尝试旧变量或其他连接。

默认仍使用专用只读账号。用户明确选择读写账号时，脚本不修改账号权限：写入 SQL 和副作用入口仍在读取凭据前被拒绝，获准查询在同一只读事务中执行。该限制覆盖通过受控脚本发起的请求，不能把读写账号宣称为只读账号，也不覆盖用户另行使用 Navicat 或直接客户端的请求。数据库侧最小权限是额外的防护层，不能由离线脚本测试证明。此次不通过真实 INSERT/UPDATE/DELETE 来验证限制。

TLS 默认校验身份；用户明确选择 REQUIRED 时仍强制加密。BPM 始终拒绝 PREFERRED，不自动降级。用户明确选择无 TLS 时，配置必须同时传入 --ssl-mode DISABLED --allow-unencrypted，登记 allowUnencrypted=true；仅 DISABLED 或字符串形式的允许标记均拒绝。独立执行器也需要显式 --allow-unencrypted。该例外只影响传输加密，SQL、表对象、版本与只读事务核验不变。Skill 不开启 RDS SSL、不变更白名单或重启实例。

依据：[MySQL 5.7 官方手册](https://downloads.mysql.com/docs/refman-5.7-en.pdf)、[RDS SSL 官方文档](https://www.alibabacloud.com/help/en/rds/apsaradb-rds-for-mysql/configure-a-cloud-certificate-to-enable-ssl-encryption)。

## 保证边界

脚本强制保证的是：未经完整白名单校验的用户 SQL 不进入执行通道；未知函数和未核验对象不放行。该策略以实际后端为相应路由支持的 MySQL 版本、可信客户端/本机脚本和正确环境路由为前提。

OP prod 的 DMS 元数据核验与查询之间存在并发 DDL 窗口，不能仅凭两次 DMS 调用证明对象始终不变，也没有经验证的 DMS 同会话只读事务保障。默认要求各生产身份在 DMS/数据库侧只授予查询及必要元数据权限；用户已明确选择读写账号时仍如实标明这一权限缺口，并保持受控脚本的全部限制。数据库侧最小权限身份应只授予查询及必要元数据权限，并防止通过 EXECUTE、FILE、高权限视图等获得额外能力；必要时使用服务端强制只读的副本。不可宣称仅凭脚本就能在任意服务端权限、并发结构变更或恶意服务器下保证绝无写入。脚本不修改或自动授予这些服务端权限。

## 离线回归

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/tests" -v
```

测试涵盖 OP 原调用/迁移、BPM 环境与数据库范围、独立凭据、同一只读会话、版本/实际库/只读状态异常、停用与禁止回退。测试使用独立配置和隔离 PATH 中的模拟 MySQL、security 与 aliyun；验证拒绝的 SQL 不触达凭据或客户端、视图/外部引擎/元数据缺失时不执行业务查询、正常查询先核验后执行、依赖缺失时停止。测试不连接真实数据库或读取真实身份，不能代替服务端权限核验。
