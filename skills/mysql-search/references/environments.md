# MySQL 环境映射

环境名只用于隔离和选择连接配置，不内置 Host、端口、数据库或账号。首次使用每个环境时，必须通过 `scripts/configure.sh` 显式配置 Host、端口和账号；数据库在每次查询时单独指定，脚本不会跨环境回退。

| 环境 | 配置文件 | 钥匙串 Service | 默认 SSL |
|---|---|---|---|
| dev | `dev.json` | `codex.mysql-search.dev` | `PREFERRED` |
| pre | `pre.json` | `codex.mysql-search.pre` | `REQUIRED` |
| prod/生产 | `prod.json` | `codex.mysql-search.prod` | `REQUIRED` |

## 路由规则

- `dev`、`pre`、`prod` 使用相互独立的配置文件和钥匙串条目。
- 每个环境的 Host、端口和用户名保存在本机权限为 `600` 的 JSON 配置中；密码只保存在 macOS 钥匙串。
- 用户说“生产”时映射到 `prod`；没有环境时不得选择默认环境。
- 用户只提到系统名或数据库名但未说明环境时，不能据此推断为生产。
- 连接失败时只报告目标环境、Host、端口和错误类型，不输出账号、密码或完整连接参数。
- 不自动尝试其他 Host、其他 schema、项目配置中的凭据或其他环境。

## 查询限制

- `prod` 默认和最大返回 200 行；必须使用明确过滤条件，元数据排查也应限定 schema 或表名。
- `dev/pre` 默认返回 200 行，确有需要可提高到 500 行。
- 每次查询必须通过 `--database` 明确指定 schema。需要访问其他 schema 时重新指定即可，但必须确认它属于当前环境和任务范围；不要在 SQL 中静默跨库。
