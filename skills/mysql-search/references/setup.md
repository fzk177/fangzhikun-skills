# MySQL 查询首次配置

## 客户端

使用 MySQL 8.0 客户端。本机 Homebrew 安装命令为：

```bash
brew install mysql-client@8.0
```

该 formula 是 keg-only，不需要修改 `~/.zshrc`；查询脚本会自动查找 `brew --prefix mysql-client@8.0` 下的客户端。skill 不自动启动或安装 MySQL Server。

如果客户端缺失，只有在用户明确授权安装时才执行上述命令；否则报告缺失项并让用户自行安装。

## 一次性配置环境

每个需要使用的环境分别执行一次。未通过参数提供的 Host、端口和用户名都会逐项提示输入，随后由 macOS 钥匙串单独提示输入密码。数据库不属于连接配置，在每次查询时指定：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" --env dev
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" --env pre
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" --env prod
```

脚本会：

1. 提示输入该环境的 Host、端口和用户名，不使用内置数据库地址。
2. 调用 macOS `security`，在最后一个 `-w` 参数后安全提示输入密码；密码不会进入 shell 参数、历史或配置文件。
3. 把 Host、端口和用户名保存到 `${XDG_CONFIG_HOME:-$HOME/.config}/fangzhikun-skills/mysql-search/<env>.json`，权限为 `600`。
4. 把密码保存到默认 macOS 钥匙串，service 为 `codex.mysql-search.<env>`，account 为数据库用户名。

环境地址、数据库或用户名需要覆盖时使用：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/configure.sh" \
  --env pre \
  --host '已确认的地址' \
  --port 3306 \
  --username '只读账号'
```

重新执行会更新相同环境和用户名的钥匙串密码，不需要在对话中提供凭据。

## 账号权限

优先使用专用只读账号，并由数据库管理员将权限限制为目标 schema 的 `SELECT` 和必要的 `SHOW VIEW`。不要使用拥有 `INSERT`、`UPDATE`、`DELETE`、DDL、权限管理或文件权限的账号。

skill 不创建账号、不执行 `GRANT`、不修改权限。只有客户端校验和只读事务不能替代数据库侧最小权限。

## 验证

配置完成后执行最小只读查询：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/mysql-search/scripts/query.sh" \
  --env dev \
  --database example_database \
  --sql 'SELECT VERSION() AS mysql_version, DATABASE() AS database_name'
```

认证失败时重新运行 `configure.sh` 更新钥匙串；网络失败时检查 VPN、白名单和 Host。不要把密码粘贴到聊天窗口。
