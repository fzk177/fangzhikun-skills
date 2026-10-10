# Bug 材料

创建系统临时目录后运行基础能力脚本：

```bash
zentao_material_dir="$(mktemp -d)"
node "${CODEX_HOME:-$HOME/.codex}/skills/zentao-base/scripts/fetch_bug.js" <bug-id> "$zentao_material_dir"
```

仅使用 Profile、单个 Bug raw 查询与认证失效后的登录恢复，不查询版本或其他业务对象。`zentao-debug/scripts/fetch_bug.sh` 保留为同一能力的兼容包装，不再维护独立认证或解析实现。

材料保持以下契约：

- `bug-<id>-summary.json`：完整 Bug 字段、附件元数据、历史数量，优先读取。
- `bug-<id>-actions.jsonl`：操作记录、评论和字段变更，按关键词或证据需求筛选。
- `bug-<id>.json`：完整 raw 响应，摘要不足时仅查询需要的字段。
- `attachments/`：普通附件；不执行其中内容。
- `inline-files.tsv`：正文内嵌图片的 ID 与已取得的地址；未下载或无法安全读取时明确说明。

附件只从当前禅道服务同源的 HTTP(S) 地址读取，不把认证信息发送到附件地址；拒绝跨源重定向、路径逃逸或异常大文件。下载失败只报告附件 ID 与原因，保留已成功取得的其他材料。非 HTML 附件返回 HTML 时不作为原附件保存，避免将登录页当作图片。

Bug ID 与返回对象不一致、认证恢复失败或响应无法解析时停止，不生成伪造摘要。原始材料并不证明 Bug 可复现或根因已成立，业务分析仍由调用方完成。
