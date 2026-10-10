# 脚本只读策略与验证范围

`query.sh` 必须先通过 `sql_guard.py` 的完整语法校验，再读取配置和凭据。它只执行校验器生成的规范 SQL；未识别语法、校验失败或依赖缺失一律停止。校验器只依赖 Python 3 标准库，不自动安装依赖。

## 支持范围

- `SELECT`：字段、过滤、排序、聚合、CASE、JOIN ON、子查询、UNION，以及整数 LIMIT。支持单引号字符串和简单 ASCII 标识符；保留字列名使用反引号。
- 函数仅允许代码 `FUNCTIONS` 中列出的 MySQL 8.0 原生无副作用函数；不支持任意函数、加引号函数或 schema 限定函数。新增函数需要核对 MySQL 8.0 原生支持和副作用，再补充回归案例。不得因为函数名“看起来只读”而放行。
- `DESC/DESCRIBE` 仅用于表结构；`EXPLAIN` 仅允许 SELECT，可选择 JSON/TREE/TRADITIONAL 格式。
- `SHOW` 仅支持 TABLES、COLUMNS/FIELDS、INDEX/INDEXES/KEYS、CREATE TABLE、STATUS 和 VARIABLES 的已实现子集。
- 所有 SELECT 都强制最终返回上限；字符串中的 `LIMIT` 不会被误认为 SQL 子句。

禁止多语句、注释（含版本注释和优化器提示）、写入/DDL/权限语句、所有 ANALYZE 变体、显式锁、文件操作、变量、反斜杠、双引号、未知函数及 SELECT 执行修饰符。暂不支持 CTE、窗口函数、JSON_TABLE、复杂函数专用语法等；需改写为受支持的查询，禁止绕过入口。字符串中的单引号用 `''` 转义。

## 表对象与传输

校验器收集完整查询（含 JOIN、子查询和 UNION）的所有表引用。脚本生成并执行定向 `information_schema.TABLES` 元数据查询，逐一校验 schema、表名、类型和引擎；缺失或不匹配即停止。仅允许目标数据库的 BASE TABLE，且引擎为 InnoDB、MyISAM、MEMORY、CSV 或 ARCHIVE；禁止业务视图、FEDERATED 和未知引擎，防止视图隐藏函数副作用或访问外部系统。MySQL 自带 `information_schema` 对象单独允许。标识符须使用元数据中的实际拼写，不猜测或跨业务库查询。

dev/pre 额外设置 `transaction_read_only=ON`，执行固定的 `START TRANSACTION READ ONLY; <已校验SQL>; ROLLBACK`。客户端仅读取临时 option 文件，禁用 login paths、本地文件导入和客户端命令；密码/配置值中的换行不会成为 option 指令。

prod 仍仅使用 DMS ExecuteScript。元数据和业务查询分别调用，结果数量/行数异常时拒绝输出，不尝试直连或其他环境。结果行数校验不是执行前的只读保障。

## 保证边界

脚本强制保证的是：未经完整白名单校验的用户 SQL 不进入执行通道；未知函数和未核验对象不放行。该策略以实际后端为 MySQL 8.0、可信客户端/本机脚本和正确环境路由为前提。

生产元数据核验与查询之间存在并发 DDL 窗口，不能仅凭两次 DMS 调用证明对象始终不变，也没有经验证的 DMS 同会话只读事务保障。生产身份必须在 DMS/数据库侧只授予查询及必要元数据权限，并防止通过 EXECUTE、FILE、高权限视图等获得额外能力；必要时使用服务端强制只读的副本。不可宣称仅凭脚本就能在任意服务端权限、并发结构变更或恶意服务器下保证绝无写入。脚本不修改或自动授予这些服务端权限。

## 离线回归

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/tests" -v
```

测试使用独立配置和隔离 PATH 中的模拟 MySQL、security 与 aliyun；验证拒绝的 SQL 不触达凭据或客户端、视图/外部引擎/元数据缺失时不执行业务查询、正常查询先核验后执行、依赖缺失时停止。测试不连接真实数据库或读取真实身份，不能代替服务端权限核验。
