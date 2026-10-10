# 数据库查询首次配置

## 查询入口依赖

查询需要 Bash、Python 3 和 jq。`scripts/sql_guard.py` 仅使用 Python 标准库，无需安装第三方 SQL 解析库。依赖或校验器缺失时脚本拒绝执行，不使用直接客户端绕过。

## dev 和 pre

`dev/pre` 使用 MySQL 8.0 客户端和专用只读账号。本机 Homebrew 安装命令为：

```bash
brew install mysql-client@8.0
```

该 formula 是 keg-only，不需要修改 `~/.zshrc`；查询脚本会自动查找 `brew --prefix mysql-client@8.0` 下的客户端。Skill 不自动启动或安装 MySQL Server，也不自动安装客户端。客户端缺失时，只有在用户明确授权后才能执行安装命令。

每个需要使用的环境分别执行一次。未通过参数提供的 Host、端口和用户名都会逐项提示输入，随后由 macOS 钥匙串单独提示输入密码：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" --env dev
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" --env pre
```

脚本会把 Host、端口和用户名保存到权限为 `600` 的本机 JSON 配置中，把密码保存到默认 macOS 钥匙串。密码不会进入 shell 参数、历史或配置文件。

优先使用数据库侧专用只读账号，并将权限限制为目标 schema 的 `SELECT` 和必要的 `SHOW VIEW`。Skill 不创建账号、不执行 `GRANT`、不修改权限。

## prod

`prod` 不再使用 MySQL 账号直连，只通过阿里云 DMS OpenAPI 的 `ExecuteScript` 查询。

### 阿里云 CLI 与身份

本机需要阿里云 CLI，并能执行：

```bash
aliyun version
```

CLI 缺失时，Skill 只报告缺失项，不自动安装。需要安装时应由用户明确授权，并遵循阿里云 CLI 官方安装文档。

身份配置必须由用户在自己的终端中完成。优先使用 CloudSSO、STS、RAM 角色或外部凭据等短期认证方式；确实只能使用 AccessKey 时，也只能通过阿里云 CLI 官方配置流程保存。不要把 AccessKey Secret、STS Token 或浏览器 Cookie 粘贴到聊天窗口，也不要写入 `prod.json`。

Skill 只读取 CLI profile 名并传给 `aliyun` 命令，不读取、复制或输出阿里云 CLI 的凭据文件。可为本 Skill 单独建立 profile，例如 `mysql-search-prod`，避免误用其他身份。

### 最小权限

执行身份至少需要调用 DMS `ExecuteScript` 的 RAM 权限，并且该身份必须已加入正确的 DMS 租户、拥有目标生产数据库的查询权限。DMS 数据库权限应只授予查询和必要的元数据查看能力，不授予变更数据、结构设计、数据导出或权限管理能力。

阿里云 DMS 的 `ExecuteScript` 接口本身支持 DQL、DDL 和 DML。包装脚本会在调用前完整解析只读 SQL 子集、限制内置函数并核验引用表，但客户端校验不能替代 DMS 侧的最小权限和安全规则。生产查询必须使用服务端只读身份；脚本不会授予权限，也不能仅凭本地 profile 名确认权限。尤其元数据核验和业务查询是两次调用，不能将它们视为同一只读事务。详见 [readonly-policy.md](readonly-policy.md)。

### 登记数据库路由

每个生产数据库都要明确登记数据库名、DMS DbId 和是否为逻辑库。地域、租户 ID 和 CLI profile 在同一 `prod.json` 中复用；重复执行可追加或更新单个数据库映射：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" \
  --env prod \
  --database example_database \
  --db-id '<DMS数据库ID>' \
  --logic false \
  --region '<实际地域>' \
  --tenant-id '<DMS租户ID>' \
  --aliyun-profile mysql-search-prod
```

- `DbId` 是 DMS 数据库 ID，不是 RDS 实例 ID、数据库端口或 schema 名。
- 普通物理库使用 `--logic false`，DMS 逻辑库使用 `--logic true`。
- 数据库名只用于本机精确映射；查询时不会通过近似名称自动搜索其他生产库。
- 旧版 `prod.json` 中的 Host、端口、用户名和钥匙串配置不再使用。迁移时重新执行上述配置命令；Skill 不自动改写本机真实配置。

DMS 租户 ID 可从 DMS 控制台的租户信息中确认，DbId 可从目标数据库详情或 DMS `SearchDatabase` 结果中确认。无法唯一确认 DbId、逻辑库标记或租户时必须停止配置，不得猜测。

## 验证

`dev/pre` 可使用最小查询验证 MySQL 连接：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/query.sh" \
  --env dev \
  --database example_database \
  --sql 'SELECT VERSION() AS mysql_version, DATABASE() AS database_name LIMIT 1'
```

`prod` 配置完成后使用无业务数据的最小查询验证 DMS 路由和权限：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/query.sh" \
  --env prod \
  --database example_database \
  --sql 'SELECT 1 AS connectivity_check LIMIT 1'
```

认证失败时由用户更新对应 CLI profile；无 DMS 查询权限时联系管理员授予最小权限；数据库未命中时核对 `prod.json` 中的精确数据库映射。不要改用旧生产数据库账号，也不要跨环境重试。
