---
name: req-governance
description: 治理或快速自查 Java Controller 对外接口的 Req/Resp 字段契约，包括模型复用评估、专用模型拆分、OpenAPI 3 Schema、Bean Validation 和 Controller 最小接入。仅适用于用户明确指定接口并要求 Req/Resp 治理或自查，不用于普通 DTO 重构和业务逻辑修改。
version: 1.1.0
---

# Req/Resp 字段治理

## 模式

- “快速自查/检查/评估”：只读，不改代码；只输出问题。
- “治理/接入/修改/修复”：先自查，再做允许范围内的最小修改。
- 必须锁定一个 Controller 方法；无法唯一确定时询问用户，不批量处理相似接口。

## 工作流

1. 定位目标方法、直接使用的 Req/Resp 及其全部 Controller 使用方。可只读查看 Service、Facade、Handler、Manager、DTO、Query、Command、Mapper、SQL、枚举和前端，以确认字段真实用途、调用方和实际 JSON。
2. 对比复用接口的字段集合、含义/类型/格式/枚举、Req 必填规则、Resp 来源/空值/序列化。任一不一致即为目标接口拆分专用 Req/Resp；不能因内部共用 DTO/Query 而强行共享，也不建大型 BaseReq/BaseResp。
3. 专用 Req 只保留目标接口真实支持的字段；专用 Resp 以实际序列化 JSON 为准。删除、改名、改类型若需联动禁止范围或无法确认调用方兼容性，只报告不修改。
4. Controller 仅调整目标方法签名、校验入口、必要 import 和纯属性转换；保留原查询条件、固定值、排序、分页、权限、异常和返回行为。
5. 用 OpenAPI 3 `io.swagger.v3.oas.annotations.media.Schema` 描述所有对外业务字段。Apifox 读取 OpenAPI 文档，不直接读取 Java 注解或自定义注解。
6. 通过全局搜索和 `git diff` 自查范围、映射、共享类引用和意外格式变化。存在可访问的 OpenAPI 文档时再核对 `paths`、`components.schemas`、`required`、`description`、`format` 和 `enum`；无法核对则明确说明。

## 注解规则

- Req 无条件必填：`requiredMode = REQUIRED`；确需运行时校验时，按类型增加匹配的 `@NotNull`、`@NotBlank` 或 `@NotEmpty`，并确保目标入参存在必要的 `@Valid`/`@Validated`。
- Req 选填：`requiredMode = NOT_REQUIRED`，不加无条件非空校验。
- Req 条件必填：仍用 `NOT_REQUIRED`，在 `description` 写明触发字段、触发值和必填含义，不加无条件非空校验。
- Resp 不表达调用方提交必填；说明含义、格式、单位、枚举和空值场景。无法确认是否始终序列化时，不主动设置 `requiredMode`。
- 仅在契约有证据时设置 `format`、`example`、`allowableValues`、`minimum`、`maximum`。优先复用现有枚举；新增枚举会越界时只报告，不写魔法值。
- 禁止新增自定义字段治理注解，禁止新增 Swagger 2 `ApiModelProperty`。

## 修改边界

允许修改目标 Req/Resp、目标接口专用 Req/Resp、目标 Controller 的最小接入代码及对应文档/校验注解。Controller 对外入参必须是 Req，业务返回必须是 Resp，不直接暴露 DTO、Query、Command、PO、Entity、Map 或裸参数。

禁止修改 Service、Facade、Handler、Manager、Mapper、SQL、DTO、Query、Command、PO、Entity、前端、无关接口，以及未经授权的 `pom.xml`、配置、OpenAPI 全局配置和框架代码。Controller 不得新增计算、状态判断、查询、远程调用或回填。旧 Req/Resp 仍有引用时不得删除；无引用时也仅在用户明确要求清理时删除。

若项目缺少 OpenAPI 依赖、文档端点或 Apifox 同步配置，只报告前置问题，未经授权不扩大修改范围。

## 编码依赖

- 仅在“治理/接入/修改/修复”模式实际修改 Java 后端代码时，完整读取 [$java-backend-code](../java-backend-code/SKILL.md) 并遵守其编码与分层规范；快速自查模式不加载该 Skill。
- 字段治理额外禁止引入 Lambda、Stream、`Optional`、`switch` 表达式或模式匹配，避免为了接口模型调整扩大代码风格和运行环境变化。

## 输出

快速自查仅列问题，使用列：`对象 | 字段 | 问题 | 修改建议 | 本次是否可修改`。不列正常字段、完整调用链、无证据猜测或越界执行建议。

治理完成后仅汇总修改文件、契约变化、兼容性判断、阻断项和未执行的验证，不声称未执行的验证已通过。

只有遇到边界歧义、需要完整示例或用户要求严格逐项对照手册时，才完整读取 [接口ReqResp字段治理接入与自查手册.md](references/接口ReqResp字段治理接入与自查手册.md)。
