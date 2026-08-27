# SLS 首次配置与认证

只在 SLS 工具缺失、认证失败或用户要求配置时读取本参考。秘密只由用户在自己的终端输入，不要求用户在对话中粘贴 AccessKey Secret 或 STS Token。

dev SSH 的服务器登记、别名和认证配置已归属 `$server-connect`，本 skill 不保存或修改 SSH 连接信息。

## 只读查询前置条件

本 skill 只检查 `aliyunlog`、`jq` 和只读认证是否可用，不自动安装工具、不创建或修改凭据文件。工具缺失时，只报告缺失项。用户如需安装，可自行在本机终端选择合适方式；以下命令仅作为参考，不由本 skill 执行：

```bash
uv tool install aliyun-log-cli
aliyunlog --version
```

若 `uv` 不存在：

```bash
brew install uv
uv tool install aliyun-log-cli
```

### 获取最小只读凭据

让阿里云管理员创建专用于日志排查的 RAM 身份，优先使用短期 STS 凭据；确需长期 AccessKey 时，至少授予日志服务只读权限，并把资源范围限制为本机 `runtime.json` 中实际登记的 Project 和 Logstore。

可使用系统只读策略 `AliyunLogReadOnlyAccess`，更严格时由管理员创建只允许查询已登记 Project/Logstore 的自定义策略。不要给该身份写入、删除或日志项目管理权限。

AccessKey Secret 通常只在创建时展示一次。让用户自行妥善保存，不要发送到聊天窗口。

### 用户自行配置 CLI

以下步骤只能由用户在自己的终端执行，本 skill 不代为输入、保存或持久化秘密。CLI 支持环境变量和 `~/.aliyunlogcli`，优先使用当前终端临时环境变量，避免把秘密放在命令参数和 shell 历史中：

```bash
read -r -p "AccessKey ID: " ALIYUN_LOG_CLI_ACCESSID
read -r -s -p "AccessKey Secret: " ALIYUN_LOG_CLI_ACCESSKEY
echo
export ALIYUN_LOG_CLI_ACCESSID ALIYUN_LOG_CLI_ACCESSKEY
export ALIYUN_LOG_CLI_ENDPOINT="https://<实际地域>.log.aliyuncs.com"
```

使用 STS 时额外设置：

```bash
read -r -s -p "STS Token: " ALIYUN_LOG_CLI_STS_TOKEN
echo
export ALIYUN_LOG_CLI_STS_TOKEN
```

这些环境变量只在当前终端会话生效。不要把 AccessKey Secret 写入 shell 启动文件。若用户自行选择持久化配置，应使用官方方案并确保配置文件权限为 `600`；本 skill 不执行该写入。

### 只读验证

在包含上述环境变量的同一终端中执行：

```bash
aliyunlog log get_project --project_name=<本机已登记Project> --client-name=log-search --format-output=json,no_escape
```

只验证用户实际获权的 Project。`Unauthorized` 或 `Forbidden` 表示 RAM/STS 权限不足；连接错误时检查 endpoint 是否与实际 SLS 地域一致。

注意：Codex 进程通常无法继承用户在另一个终端临时导出的环境变量。要让 skill 自动查询，需从同一个已配置终端启动 Codex，或由用户自行选择一种本机安全凭据注入方式。
