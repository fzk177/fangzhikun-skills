# 数据库环境映射

环境名只用于隔离和选择查询通道，不内置 Host、端口、数据库、账号、DMS DbId 或租户信息。首次使用每个环境时，必须通过 `scripts/configure.sh` 显式配置；数据库在每次查询时单独指定，脚本不会跨环境回退。

| 环境 | 查询通道 | 配置文件 | 凭据来源 |
|---|---|---|---|
| dev | MySQL 8.0 直连 | `dev.json` | macOS 钥匙串 `codex.mysql-search.dev` |
| pre | MySQL 8.0 直连 | `pre.json` | macOS 钥匙串 `codex.mysql-search.pre` |
| prod/生产 | 阿里云 DMS `ExecuteScript` | `prod.json` | 阿里云 CLI profile |

## 路由规则

- `dev`、`pre`、`prod` 使用相互独立的配置文件。
- `dev/pre` 的 Host、端口和用户名保存在本机权限为 `600` 的 JSON 配置中；密码只保存在 macOS 钥匙串。
- `prod` 只保存 DMS 地域、租户 ID、阿里云 CLI profile 名和数据库名到 DMS DbId 的映射；不保存 AccessKey、STS Token 或其他凭据。
- `prod` 不读取旧的 Host、端口、用户名或钥匙串密码，也不在 DMS 失败时尝试 MySQL 直连。
- 用户说“生产”时映射到 `prod`；没有环境时不得选择默认环境。
- 用户只提到系统名或数据库名但未说明环境时，不能据此推断为生产。
- 查询失败时只报告目标环境、查询通道和必要的错误类型；DMS 错误可报告错误码和 RequestId，不输出 CLI 凭据、完整响应或 SQL 中的敏感筛选值。
- 不自动尝试其他 Host、其他 schema、项目配置中的凭据或其他环境。

## 查询限制

- `prod` 默认和最大返回 200 行；必须使用明确过滤条件，元数据排查也应限定 schema 或表名。生产 `SELECT` 由包装脚本强制控制结尾 `LIMIT`，DMS 返回后还会校验实际行数。
- `dev/pre` 默认返回 200 行，确有需要可提高到 500 行。
- 每次查询必须通过 `--database` 明确指定 schema。`prod` 只接受已登记且完全匹配的数据库名；需要访问其他 schema 时先单独登记 DMS DbId，并确认它属于当前租户、生产环境和任务范围。不要在 SQL 中静默跨库。
