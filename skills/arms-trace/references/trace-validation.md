# CLI 兼容性、权限与参数验证规则

本文件只记录可公开的通用操作规则；实际 TraceID、SpanID、RequestId、账号映射和脱敏验证记录维护在本机 `~/.config/fangzhikun-skills/arms-trace/trace-validation.md`。

## CLI 元数据兼容

1. 常规调用本地报 `not a valid api` 时，先读取 `aliyun help xtrace`，核对产品默认版本是否为 `2019-08-08`。本地失败不等于云端拒绝或 Trace 不存在。
2. 按官方 API 文档核对 API 名称和参数，并从官方 Endpoint 文档确认目标地域接入点。不得猜测地域或在不同账号间重试。
3. CLI 3.4.11 在命令分发阶段可能对显式 `--version 2019-08-08` 报 `unchecked version`。若已通过产品帮助确认默认版本就是 2019-08-08，可保持 `SearchTraces` / `GetTrace` 的原查询参数与输出收窄方式，省略显式 `--version`，额外使用以下参数：

```text
--force --secure --auto-plugin-install false --retry-count 0
--endpoint <官方已确认的目标地域Endpoint>
```

4. 不执行带占位符的命令。每次显式传入 `--profile`、`--region`、`--RegionId`，两个地域值一致，并启用 `set -o pipefail`，检查 CLI 与过滤程序退出码。
5. `--force` 仅跳过本机 API 元数据校验，不绕过 RAM 权限；只用于本 Skill 允许的两个只读接口。不安装插件、不升级 CLI、不修改配置，不以其他产品同名接口替代本次请求。
6. CLI 返回和标准错误在内存中处理，成功内容先经 jq 收窄；失败只提取必要错误码、RequestId、AuthAction 和拒绝类型。必要时输出供管理员核对的非秘密身份标识；不输出 EncodedDiagnosticMessage、完整响应头或任何签名及凭据。

依据：[官方强制调用说明](https://help.aliyun.com/zh/cli/force-call-apis)、[官方地域 Endpoint](https://help.aliyun.com/zh/opentelemetry/developer-reference/api-xtrace-2019-08-08-endpoint)、[CLI 3.4.11 命令分发源码](https://github.com/aliyun/aliyun-cli/blob/v3.4.11/openapi/commando.go)、[CLI 请求版本设置源码](https://github.com/aliyun/aliyun-cli/blob/v3.4.11/openapi/invoker.go)。其他 CLI 版本遇到不同行为时重新核对，不机械套用旧结论。

## ReadOnly 与实际鉴权

- 以当前官方策略内容与实际错误中的 AuthAction 为准，不能从 API 名称推断 RAM 权限点。
- `xtrace GetTrace` 与 `SearchTraces` 的官方授权点是 `xtrace:SearchTrace`，资源 `*`；不支持按应用做资源级授权。
- 已核对的 `AliyunARMSReadOnlyAccess` xtrace 部分仅含 `Read*`、`Get*`、`Describe*`，不含 `Search*`。`AliyunTracingAnalysisReadOnlyAccess` 含 `xtrace:Search*`，可覆盖该权限点。策略可能变化，处理当前授权问题时重新查官方文档。
- 网页可访问不证明 CLI 采用同一身份或接口。TracingAnalysis 策略看似已有但 API 仍为 ImplicitDeny 时，优先核对实际 RAM 用户 / 用户组 / 角色、账号级授权范围及生效情况，不直接要求 FullAccess。
- 系统策略名称含 ReadOnly 也可能包括本 Skill 范围之外的权限；不能自动执行其他操作。只需要两个 API 时，可向管理员提供最小自定义策略，由管理员处理：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["xtrace:SearchTrace"],
      "Resource": "*"
    }
  ]
}
```

依据：[ARMS ReadOnly 策略](https://help.aliyun.com/zh/ram/developer-reference/aliyunarmsreadonlyaccess)、[TracingAnalysis ReadOnly 策略](https://help.aliyun.com/zh/ram/developer-reference/aliyuntracinganalysisreadonlyaccess)、[SearchTraces](https://help.aliyun.com/zh/opentelemetry/developer-reference/api-xtrace-2019-08-08-searchtraces)、[GetTrace](https://help.aliyun.com/zh/arms/tracing-analysis/api-xtrace-2019-08-08-gettrace-arms)。

## 单条 Trace 的参数验证

1. 优先读取用户提供且地域 / 身份已确认的 TraceID；无样本时只在明确时间与服务条件下获取少量候选，不扫描全地域或所有应用。
2. 将 `Spans.Span` 以及标签 / 事件的单对象或数组形式归一化；按所需页数读取，每页最多 100 个 Span，未读完必须标明范围。以 SpanId、ParentSpanId 和开始时间定位目标调用。
3. 首次只输出目标字段键、类型、长度、是否非空、JSON 是否可解析与脱敏后的结构；不要回显所有标签或报文。
4. 对已观察到的 `biz.Parameters` 验证是否为有效且非空 JSON。它可能包含 query、分页等业务字段，也可能为空对象；具体采集来源由采集规则及控制台证据确认，不把空对象解释为没有请求 Body。
5. `biz.header` 可能直接包含 Bearer Token，只报告存在性，不输出值、不持久保存，不将它当作请求 Body。
6. 对 `biz.response.body` 检查存在性、长度和 JSON 结构，仅按需输出 code / success 等最小状态字段及脱敏业务片段。不可解析时记录现象，不猜测截断原因、不补齐字符串。JSON 合法也不证明原始响应或记录列表完整；列表可能已被序列化或简化，需单独核对采集规则。
7. 实际 Timestamp 位数必须核验。已观察到 GetTrace 返回 13 位毫秒时间戳的情形，与文档描述微秒不同；按实际位数与控制台发生时间交叉检查，再转换北京时间。API 整数毫秒耗时与控制台小数精度不混用。
8. 分别记录链路、入参和出参状态为已确认可读、当前范围未发现或尚未验证；保留单条样本及读取页数证据。权限拒绝不按空链路解释，一个样本成功不推广到全部接口。
9. 只能读取已采集内容。Java 业务参数提取支持及探针版本以官方文档为准；未采集的旧请求不能追溯补回，配置调整由用户或运维处理，本 Skill 不修改采集规则、应用或探针。

依据：[Java 业务参数提取](https://help.aliyun.com/zh/arms/application-monitoring/user-guide/extract-business-parameters)。
