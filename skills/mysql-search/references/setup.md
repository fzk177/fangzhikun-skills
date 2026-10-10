# 数据库连接配置

查询需要 Bash、Python 3、jq；Python 脚本只用标准库。缺少工具或校验器时停止，不绕过入口。连接管理只操作本机非秘密配置，不创建账号、不执行 GRANT，不安装数据库客户端。

## 本地连接管理

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/connections.py" list
python3 "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/connections.py" migrate-op
python3 "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/connections.py" disable --connection bpm --env prod
python3 "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/connections.py" enable --connection bpm --env prod
```

list 只展示连接名称、环境、通道、本机配置状态和数据库白名单，不展示 Host、账号或凭据。configured 表示本机配置已填写，不表示真实网络或权限已验证。migrate-op 保留旧文件与原钥匙串服务，不覆盖已有新配置；查询不自动执行迁移。停用连接后不得用旧配置绕过停用。

BPM 首次登记可执行 init-bpm --connection bpm --env prod --database '<明确数据库名>'。仅生成 configured=false 的本机登记，不填地址/账号，不接触钥匙串，不覆盖已有文件。登记的唯一数据库后续 configure 不可静默改名。业务库名以本机登记为准。

## MySQL 直连

OP dev/pre、新 BPM prod 都使用 MySQL 8.0 客户端；脚本优先查 PATH，再查 Homebrew 的 mysql-client@8.0。缺失时报告，不自动安装。需要安装时由用户明确授权后执行 `brew install mysql-client@8.0`，不启动 MySQL Server、不改 shell 配置。

OP 原调用仍可用，也可以明确传入连接：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" --connection op --env dev
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" --connection op --env pre
```

BPM 使用独立入口；下面数据库名和 CA 路径是占位值，执行时使用本机实际登记与可信 CA：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" \
  --connection bpm --env prod \
  --database '<已登记的BPM数据库名>' \
  --ssl-ca '<本机CA证书路径>'
```

Host、端口、用户名未传入时逐项输入；密码只由 macOS 钥匙串在本机提示录入，不进入聊天、命令参数、历史或 JSON 文件。不要读取项目中的账号密码。BPM 使用专用只读账号，权限限定目标库 SELECT 与必要元数据查看，不授予 EXECUTE、FILE 或管理权限。

BPM 默认 VERIFY_IDENTITY，必须提供 ssl-ca；证书失败不自动降低验证等级。如果实际条件要求仅强制 TLS 加密，需配置时明确传入 --ssl-mode REQUIRED；禁止 PREFERRED。OP dev/pre 保持原 TLS 默认值，证书模式可额外指定 --ssl-ca。

新配置保存为权限 600 的连接/环境 JSON，密码仍在钥匙串；OP 复用原服务名，BPM 使用 codex.mysql-search.bpm.prod。配置命令会启用该配置，但不会查询数据库。

BPM 查询执行器核验实际 MySQL 8.0 版本、实际数据库和会话只读状态，核验失败停止；不能将其他版本或兼容产品自动视为已支持。

## OP prod：DMS

OP prod 只使用 DMS，不配置直连密码。阿里云 CLI 缺失时报告，不自动安装；身份由用户在本机官方 CLI 流程中配置。优先短期身份，不把 AccessKey Secret、STS Token 或 Cookie 粘贴到聊天，不读取/复制 CLI 凭据文件。

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" \
  --connection op --env prod \
  --database example_database --db-id '<DMS数据库ID>' --logic false \
  --region '<实际地域>' --tenant-id '<租户ID>' --aliyun-profile '<CLI profile>'
```

每个数据库登记精确 DbId/逻辑库标记，同一连接复用地域、租户和 profile。DbId 是 DMS 数据库 ID，非 RDS 实例 ID、端口或 schema；未知时停止，不猜测或近似搜索。重复登记保留其他库的映射，旧 prod.json 中的直连字段不用于生产查询。

DMS 身份须拥有 ExecuteScript 的 RAM 权限、正确租户及目标库查询权限。ExecuteScript 支持 DQL/DDL/DML，脚本完整白名单和对象核验不能替代服务端最小权限。元数据与业务查询是两次调用，不能视为同一只读事务，见 [readonly-policy.md](readonly-policy.md)。

## 指定连接的只读验证

配置完成后，只对用户指定连接、环境、数据库执行最小查询：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/query.sh" \
  --connection op --env prod --database example_database \
  --sql 'SELECT VERSION() AS mysql_version, DATABASE() AS database_name LIMIT 1'
```

BPM 使用相同命令结构，改为 --connection bpm 和本机登记的数据库；它会额外核验只读会话。未配置时只报告缺项，认证/网络/权限失败时停止，不尝试其他连接、环境、Host、schema 或凭据。排查子流程不因认证缺失而自动创建配置或录入身份。
