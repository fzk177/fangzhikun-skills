# 环境路由与查询方式

## 本机环境映射

公开源码不保存真实 SSH 别名、日志目录、SLS Project、Logstore 或控制台地址。完整读取本机配置：

```text
${FANGZHIKUN_SKILLS_CONFIG:-~/.config/fangzhikun-skills/runtime.json}
```

结构参考仓库中的 `config/examples/runtime.example.json`。缺少环境、环境别名匹配到多项或配置不可读时停止查询，不根据应用名猜测。

## dev 查询

服务器登记由 `$server-connect` 的本机注册表维护。`$log-search` 只使用 `logSearch.dev.sshAlias`，日志根目录只使用 `logSearch.dev.root`；别名或认证不可用时，不在本 Skill 中配置连接。

先以受限深度发现应用目录，其中 `<ssh别名>` 和 `<日志根目录>` 必须来自本机配置：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 <ssh别名> \
  'find <日志根目录> -mindepth 1 -maxdepth 2 -type d -print 2>/dev/null | head -200'
```

固定字符串检索：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/log-search/scripts/dev_search.sh" \
  --keyword "trace-id-or-error" \
  --app "已确认的应用相对目录" \
  --minutes 30 \
  --context 8 \
  --limit 300
```

`--app` 相对于配置的日志根目录。未知时可省略，但必须保持较短时间窗口。脚本只检查近期修改的常见日志文件，并同时支持普通文件与 `.gz` 轮转文件。

查询无结果时，可以在配置日志根目录内列出近期日志文件。dev 查询仅允许受限 `find` 以及脚本内的 `grep`、`zgrep`、`head` 读取操作，不执行服务状态检查、配置读取、修改、重启、清理或无边界递归读取。

## SLS 查询

使用北京时间的绝对起止时间。环境参数必须是本机 `logSearch.sls` 登记的键或唯一别名：

```bash
bash "${CODEX_HOME:-$HOME/.codex}/skills/log-search/scripts/sls_search.sh" \
  --env <环境名或别名> \
  --from "2026-08-27 10:00:00" \
  --to "2026-08-27 10:15:00" \
  --query '精确标识或 SLS 查询语句' \
  --line 100
```

查询建议：

- 不知道字段索引时，先直接使用 traceId、requestId、业务单号或错误短语做全文查询。
- 命中后观察真实字段名，再使用 `字段名:值` 收窄，不假设固定字段存在。
- SLS 查询语句由用户提供或从已命中的字段构造，不把异常堆栈整段作为查询词。
- 带连字符、下划线或斜杠的标识直接查询为空时，改用任务名称、日志前缀、接口方法名、logger 或字段名召回候选，再通过 `--contains` 对完整原文过滤。
- 候选数达到 `--line` 上限仍未命中时，缩短时间窗口或增加锚点。
- 生产无结果时，先扩大到前后各 15 分钟；确认时区和 Logstore 后再扩大。
- 完成精确查询、锚点召回和原文过滤后仍无结果，只能表述为当前环境和时间范围内未发现相关日志。

CLI 无权访问时，只能提供待执行查询。只有实际读取结果后才能继续给出日志结论；否则请用户导出已脱敏的 JSON、CSV 或关键日志片段。
