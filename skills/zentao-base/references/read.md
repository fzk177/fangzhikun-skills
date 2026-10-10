# 认证与查询

## 本机配置

使用 `${FANGZHIKUN_SKILLS_CONFIG:-~/.config/fangzhikun-skills/runtime.json}` 的 `zentao` 节：`cli`、`config`、`server`、`account`、`keychainService`。这些字段只保存非秘密配置，不保存密码、Token 或 Cookie；不在汇报中输出完整配置。配置缺失、格式错误或包含秘密字段时停止，让用户在本机修复，不在对话中索要凭据。

脚本复用 CLI 当前 Profile；所有查询和重新登录使用同一配置路径。认证错误 `1001`／`1004` 时，只在脚本内从 macOS 钥匙串取凭据，通过环境变量执行 `login --useEnv`，只重试一次只读请求。凭据不进入命令参数、输出、资料或日志；钥匙串缺失时仅提示恢复登记的条目。

## 独立查询

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/zentao-base/scripts/read_object.js" <task|story|bug> <纯数字ID>
```

先确认对象类型再执行；缺少类型或 ID 时询问，不猜测。只报告请求所需字段，正文与操作历史按需读取。

## 脚本接入

只读模块为 `scripts/zentao_client.js`，提供 `defaultOptions`、`getTask`、`getStory`、`getBug`、`getBugEnvelope` 和受命令白名单限制的 `cliJson`。后者只接受 `profile` 或 `task/story/bug <ID>`，拒绝额外参数和写操作。

Bug 原始材料使用 raw 信封，兼容 `{status,data}`、`{bug,actions}` 和对象自身携带的 actions；原始响应另行保留。需求查询在 CLI 未返回历史时使用已经核实的 v2 GET 详情接口补齐，不能伪造空历史；任务详情保留 CLI 已返回的历史。

`scripts/zentao_transport.js` 是内部传输实现，不作为 agent 的任意 CLI／API 执行入口。`zentao-task` 中原 `scripts/zentao_cli.js` 保留只读兼容导出及本地交付所需辅助函数；原型访问与项目同步仍由原 skill 负责。
