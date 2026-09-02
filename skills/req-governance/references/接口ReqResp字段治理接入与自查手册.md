# 接口 Req/Resp 字段治理接入与自查手册

## 1. 治理目标

本手册用于治理 Controller 对外接口直接使用的 Req 和 Resp，并将字段说明、必填性、格式和可选值通过 OpenAPI 3 同步到 Apifox。

治理以单个接口的真实契约为最小单位。当前 Req/Resp 被多个接口复用，但字段集合、必填性、字段语义或返回场景不完全一致时，应为目标接口建立专用 Req/Resp，避免共享 Schema 导致 Apifox 契约失真。

必须同时遵守三个原则：

1. 一个 Schema 只表达一份确定且一致的接口契约，不得为了减少类数量而强行复用。
2. 字段文档只使用 Apifox 能通过 OpenAPI 文档识别的标准注解。
3. 只允许为接入专用 Req/Resp 做最小范围的 Controller 签名和对象转换调整，不得借治理字段改变业务逻辑。

## 2. 修改边界

### 2.1 允许修改

- Controller 方法当前直接使用的 Req 类。
- Controller 方法当前直接使用的 Resp 类。
- 为目标接口新建专用 Req 和 Resp 类。
- 将目标 Controller 方法签名替换为专用 Req/Resp。
- 为接入专用 Req/Resp，调整目标 Controller 方法内部必要的属性复制、对象转换和分页结果转换代码。
- 目标 Controller 中因签名调整产生的必要 import。
- Req/Resp 类与字段上的 `@Schema` 注解。
- Req 中与真实接口契约一致的 Jakarta Bean Validation 注解。
- 为使目标 Req 的 Bean Validation 生效，在目标 Controller 入参上增加必要的 `@Valid` 或 `@Validated`。
- Req/Resp 的 Java 文档注释。
- 经确认不再被任何接口使用的旧 Req/Resp 清理。

### 2.2 禁止修改

- 除目标 Controller 的方法签名和必要对象转换外，不得修改其他 Controller 逻辑。
- Service、Facade、Handler、Manager、Mapper 和 SQL。
- DTO、Query、Command、PO、Entity 及其他中间对象。
- 前端代码。
- 未经用户明确授权的 `pom.xml`、配置文件、OpenAPI 全局配置和通用框架代码。
- 与指定接口无关的其他 Req/Resp。
- 接口原有查询条件、返回结果、排序、分页、权限和异常处理等业务行为。

可以只读检查 Controller、Service、DTO、Mapper、SQL 和前端代码，用于确认字段的真实用途和接口间差异，但不得修改禁止范围内的文件。

如果新 Req/Resp 能通过现有属性复制或转换工具接入，并且不需要修改业务层，则允许在 Controller 中完成转换。

如果删除、改名或修改字段类型会导致 Service、DTO、Query、Mapper、SQL 或前端必须同步修改，则本次不执行该项变更，只在自查结果中说明原因和建议。

项目缺少 OpenAPI 依赖、文档端点或 Apifox 同步配置时，应先报告项目级前置问题。只有用户明确授权扩大范围后，才允许修改 `pom.xml` 或全局配置。

## 3. 使用方式

### 3.1 快速自查

```text
请按照《接口ReqResp字段治理接入与自查手册.md》快速自查指定接口：

接口：VoyageController#detail

只检查当前接口直接使用的 Req 和 Resp。
检查 Req/Resp 是否被其他接口复用，以及复用接口之间的字段集合、必填性、语义和返回场景是否一致。
允许只读查看其他代码确认字段用途，但不修改任何文件。
只输出存在问题的字段、共享契约问题和修改建议，不输出正常字段、完整调用链或分析过程。
不修改代码，不运行测试。
```

### 3.2 治理（先分析、确认后修复）

```text
请按照《接口ReqResp字段治理接入与自查手册.md》治理指定接口，先只读分析并给出修复方案：

接口：VoyageController#detail

如果当前 Req/Resp 只服务于目标接口，直接治理现有类。
如果当前 Req/Resp 被多个契约不一致的接口复用，为目标接口新建专用 Req/Resp，并同步调整目标 Controller 方法签名和必要的对象转换代码。
使用 OpenAPI 3 的 @Schema 完善字段说明，使 Apifox 能正确识别必填性、格式和可选值。
可以只读查看其他代码确认字段用途；禁止修改 Service、DTO、Query、Mapper、SQL 和前端。
Controller 只允许修改目标方法签名、必要 import 和对象转换，不得增加业务逻辑。
如果某项变更必须联动修改禁止范围内的代码，不执行该变更，只说明阻断原因和建议。
分析完成后先列出拟修改文件、契约变化、兼容性风险和阻断项，并让我选择按方案修复、调整方案或只保留分析。
只有我明确选择按方案修复后才能修改代码，不得把最初的治理请求视为修复确认。
修复完成后展示拟提交文件和中文提交备注，并让我选择提交本地代码或暂不提交；未经明确确认不得暂存或提交。
不运行测试。
```

### 3.3 两阶段确认

治理任务必须经过两个相互独立的确认关卡：

1. 分析完成后确认是否按已展示的方案修复。
2. 修复完成后确认是否按已展示的文件范围和提交备注提交本地代码。

修复确认只授权实施已展示且属于允许范围的修改，不授权 Git 提交。用户要求调整方案时，应先更新拟修改范围并再次确认；用户选择只分析、暂不提交或没有明确确认时，停在对应阶段，不代替用户作出选择。

## 4. Apifox 兼容方案

### 4.1 注解选型

统一使用 OpenAPI 3 标准注解：

```java
import io.swagger.v3.oas.annotations.media.Schema;
```

禁止为字段治理新建 `ReqFieldSubmitRule`、`ReqFieldSubmitRuleEnum` 等自定义注解或枚举。Apifox 不会直接扫描 Java 自定义注解，这些信息如果没有被 OpenAPI 生成器转换为标准 Schema，就不会同步到 Apifox。

不使用 Swagger 2 的 `io.swagger.annotations.ApiModelProperty`，新增字段文档统一使用 `@Schema`。

### 4.2 同步链路

Apifox 识别的是应用生成的 OpenAPI JSON/YAML，不是 Java 注解本身。

```text
Req/Resp 上的 @Schema
        ↓
OpenAPI 生成器
        ↓
/v3/api-docs 或项目实际的 OpenAPI 地址
        ↓
Apifox 导入或自动同步
```

开始治理前应确认项目已具备 OpenAPI 3 文档生成能力，并且 `Schema` 已在当前模块可用。如果缺少依赖、文档端点或 Apifox 同步配置，应作为项目级前置问题单独报告；未获得用户明确授权时，不得修改 `pom.xml` 或全局配置。

## 5. 接口专用 Req/Resp 规则

### 5.1 是否允许共享

默认采用“一接口场景一组 Req/Resp”。共享是经过契约一致性检查后的例外，不是默认做法。

Req/Resp 只有在以下条件全部满足时才允许被多个接口共享：

1. 对外字段集合一致。
2. 同名字段在所有接口中的业务含义、类型、格式和可选值一致。
3. Req 字段的无条件必填、选填和条件必填规则一致。
4. Resp 字段的回填来源、空值场景和序列化行为一致。
5. 可以使用同一份 `@Schema` 准确描述所有使用接口，不需要在共享类中写某个接口专属说明。

存在以下任一情况时，应拆分为接口专用 Req/Resp：

- 某字段在一个接口中有效，在另一个接口中被忽略、覆盖或固定赋值。
- 同一字段在不同接口中的必填性或条件必填规则不同。
- 不同接口实际支持的查询字段集合不同。
- 不同接口返回字段、回填逻辑或空值场景不同。
- 共享类中需要出现“仅某接口有效”“某接口不返回”等接口专属描述。
- 共享 Req/Resp 持续膨胀，调用方无法从 Schema 判断当前接口真正支持的字段。

不得因为多个接口最终转换为同一个 Query、DTO 或 Entity，就认定它们必须共享 Req/Resp。Req/Resp 是对外接口契约，中间对象是内部处理模型，两者职责不同。

### 5.2 命名规则

专用类名应包含业务对象、接口场景和动作，能够从类名直接判断用途。

```text
{业务对象}{场景}{动作}Req
{业务对象}{场景}{动作}Resp
```

例如：

```text
VoyageEstablishPageReq
VoyageEstablishPageResp
VoyageListReq
VoyageListResp
VoyageDropdownSearchReq
VoyageDropdownSearchResp
```

分页接口可以继续使用项目已有公共包装对象：

```java
PageRequest<VoyageEstablishPageReq>
PageResult<VoyageEstablishPageResp>
```

公共分页包装对象自身的 `query`、`page`、`size`、`sorts` 和分页返回字段仍需具备准确的 OpenAPI 契约。公共包装对象来自外部依赖且无法在当前项目治理时，应单独报告，不得在每个业务 Req 中重复分页字段。

不建议仅为减少重复字段建立大型 `BaseReq`、`BaseResp` 并让多个场景继承。只有字段语义和契约长期稳定且完全一致时，才允许抽取小型公共模型。

### 5.3 拆分和接入步骤

1. 全局搜索现有 Req/Resp 的全部 Controller 使用方，确认是否为共享模型。
2. 对比各接口实际读取的入参、Controller 固定或覆盖的字段、Query/DTO 映射以及最终返回内容。
3. 为目标接口建立专用 Req/Resp，只保留该接口真实支持和真实返回的字段。
4. 遵循项目现有类注释、作者、日期和命名规范创建新类。
5. 修改目标 Controller 方法签名，并通过现有 `BeanUtils`、转换工具或明确的属性赋值转换为原有 Query/DTO。
6. 保持 Service 方法、Query/DTO、Mapper、SQL 和前端请求字段不变，确保业务行为不发生变化。
7. 原共享 Req/Resp 仍被其他接口使用时不得删除；全部使用方完成迁移后，才可单独清理。
8. 对目标接口生成的 OpenAPI Schema 和实际 JSON 返回进行验证。

确定 Resp 字段集合时必须以实际序列化 JSON 为准。字段虽然没有查询或回填，但如果当前 Jackson 配置仍会将其序列化为 `null`，删除该字段仍属于响应 JSON 结构变化，必须先完成调用方兼容性确认。

### 5.4 Controller 转换规则

允许在目标 Controller 中处理以下内容：

- 专用 Req 到现有 Query/DTO 的纯属性复制。
- 现有 DTO 或分页结果到专用 Resp 的纯对象转换。
- 原方法已经存在的服务端固定查询条件，例如固定业务模式。

Controller 中不得新增字段计算、状态判断、数据库查询、远程调用、数据回填等业务逻辑。现有转换工具无法完成转换且必须修改业务层时，只报告阻断原因，不扩大治理范围。

Controller 对外方法入参必须使用 Req，返回业务数据必须使用 Resp；不得继续直接暴露 DTO、Query、Command、PO、Entity、Map 或裸业务参数。`PageRequest<Req>`、`Response<PageResult<Resp>>` 等项目统一包装方式可以保留。

### 5.5 兼容性规则

- 仅更换后端 Java 类名而保持 JSON 字段名和类型不变时，通常不需要修改前端。
- 删除、改名或改变 JSON 字段类型前，必须只读检查前端和其他调用方；需要调用方同步时，本次不执行。
- 新专用 Req 不得复制原共享类中对当前接口无效的字段。
- 新专用 Resp 原则上不保留当前接口固定不查询、不转换或不回填的字段；如果实际 JSON 已序列化这些字段且必须保持兼容，应保留字段并准确说明空值场景，或通过接口版本升级单独治理。
- 如果旧接口已被外部系统调用且调用方不可确认，应优先保持 JSON 契约兼容，只拆分 Java 模型和 OpenAPI Schema。

## 6. Req 字段规则

### 6.1 无条件必填

```java
/** 航次ID */
@Schema(description = "航次ID", requiredMode = Schema.RequiredMode.REQUIRED)
@NotNull(message = "航次ID不能为空")
private Integer voyageId;
```

要求：

- `REQUIRED` 用于让字段进入 OpenAPI Schema 的 `required` 列表，Apifox 导入后展示为必填。
- 字段确实需要运行时非空校验时，根据类型使用 `@NotNull`、`@NotBlank` 或 `@NotEmpty`。
- `@Schema` 负责文档契约，Bean Validation 负责运行时校验，两者职责不同。
- 如果当前 Controller 没有使验证链路生效，且非空校验与真实接口契约一致，允许在目标入参上增加必要的 `@Valid` 或 `@Validated`。
- 增加运行时校验会改变非法请求的响应行为，必须有 Controller、现有校验逻辑或明确业务规则作为证据，不得只根据前端表单猜测必填性。

### 6.2 选填

```java
/** 执行单号 */
@Schema(description = "执行单号", requiredMode = Schema.RequiredMode.NOT_REQUIRED)
private String executionNo;
```

要求：

- 明确使用 `NOT_REQUIRED`，Apifox 导入后不将其标记为必填。
- 不增加无条件非空校验。
- 不使用 `AUTO` 表达已确认的选填契约，避免文档生成器推断出不同结果。

### 6.3 条件必填

OpenAPI 3 普通对象的 `required` 列表只能表示无条件必填，不能用一个字段级 `required` 标记准确表示条件必填。

```java
/** 终止运输说明 */
@Schema(
        description = "终止运输说明；当terminationApprovalType为2或3时必填",
        requiredMode = Schema.RequiredMode.NOT_REQUIRED)
private String reasonNote;
```

要求：

- 不得标记为 `REQUIRED`，否则 Apifox 会错误展示为所有场景必填。
- `description` 必须写明触发字段、触发值和必填含义。
- 不增加无条件 `@NotBlank`、`@NotNull` 或 `@NotEmpty`。
- 如需使用 `oneOf` 等复杂 Schema 精确表达多分支契约，作为独立的 OpenAPI 项目级改造，不在本手册中扩大范围。

### 6.4 格式和可选值

只在真实契约明确时填写 `format`、`example`、`allowableValues`、`minimum` 或 `maximum`，不得猜测或新增魔法值。

```java
/** 业务日期 */
@Schema(
        description = "业务日期，格式为yyyy-MM-dd",
        type = "string",
        format = "date",
        requiredMode = Schema.RequiredMode.NOT_REQUIRED)
private LocalDate businessDate;
```

```java
/** 开票状态 */
@Schema(
        description = "开票状态：0-未开票，1-已开票",
        allowableValues = {"0", "1"},
        requiredMode = Schema.RequiredMode.NOT_REQUIRED)
private Integer invoiceStatus;
```

如果系统已有对应业务枚举，描述和可选值必须与枚举一致；如果没有合适枚举，只报告治理建议，不在本次任务中修改其他层代码。

## 7. Resp 字段规则

Resp 不表达“调用方是否必须提交”，不得套用 Req 提交规则。Resp 重点说明字段含义、类型、格式、单位、可选值和可能为空的场景。

```java
/** 航次名称 */
@Schema(description = "航次名称")
private String voyageName;
```

```java
/** 结算金额 */
@Schema(description = "结算金额，单位：元")
private BigDecimal settlementAmount;
```

Resp 字段是否进入 OpenAPI `required` 列表，应以序列化后是否始终存在为准。无法确认时不主动设置 `requiredMode`。

## 8. 字段增删改规则

### 8.1 可以直接处理

- 补充或修正 Req/Resp 上的 `@Schema`。
- 在不改变业务行为的前提下完善字段文档注释。
- 为契约不一致的目标接口新建专用 Req/Resp。
- 修改目标 Controller 方法签名、必要 import 和纯对象转换代码，以接入专用 Req/Resp。
- Controller 直接使用 DTO、PO、Query、Entity、Map 或裸参数时，建立专用 Req 并在 Controller 转换为原有内部对象。
- Controller 直接返回 DTO、PO、Entity 或 Map 时，建立专用 Resp 并在 Controller 转换后返回。
- 从目标接口的专用 Req 中删除该接口不读取或被服务端固定覆盖的字段。
- 从目标接口的专用 Resp 中删除该接口不查询、不转换且不回填的字段。
- 经只读全局搜索确认没有任何外部读取、赋值、映射或序列化依赖的无用字段，可以从 Req/Resp 删除。

### 8.2 只报告，不修改

- 删除 Req 字段后需要修改 Service、DTO、Query、Mapper、SQL 或前端。
- 删除 Resp 字段后需要修改 Service 查询、转换、回填、Mapper 或 SQL。
- 改名或改类型后需要联动修改前端、外部调用方或禁止范围内的内部对象。
- 专用 Req/Resp 无法通过 Controller 的纯对象转换接入，必须增加业务处理逻辑。
- 项目缺少 OpenAPI 依赖、文档端点或 Apifox 同步配置，且用户未授权扩大项目级修改范围。

不得通过修改 Service、DTO、Query、Mapper、SQL 或前端来“顺便完成”上述问题。

## 9. 自查项

### 9.1 契约隔离

- 当前 Req/Resp 是否被其他 Controller 接口复用。
- 所有复用接口的字段集合、字段语义、必填规则和返回场景是否完全一致。
- 是否存在被 Controller 忽略、覆盖或固定赋值的入参字段。
- 是否存在当前接口固定不查询、不转换或不回填的返回字段。
- 共享类的 `@Schema` 是否出现某个接口专属说明。
- 需要拆分时，是否已建立语义明确的专用 Req/Resp，而不是继续扩大共享模型。
- 专用 Req/Resp 是否只保留目标接口真实支持和真实返回的字段。

### 9.2 Req

- 每个非静态业务字段是否都有 `@Schema`。
- `description` 是否能让调用方独立理解字段含义。
- 无条件必填字段是否使用 `REQUIRED`。
- 选填字段是否使用 `NOT_REQUIRED`。
- 条件必填字段是否使用 `NOT_REQUIRED`，并在 `description` 中写明完整条件。
- `@Schema` 的必填性是否与 Bean Validation 注解一致。
- 日期、时间、金额、单位、枚举和集合元素是否说明清楚。
- 是否使用 OpenAPI 3 `Schema`，而非自定义提交规则注解。

### 9.3 Resp

- 每个对外返回的业务字段是否都有 `@Schema`。
- 字段含义、日期时间格式、金额精度、单位和枚举值是否清楚。
- 可能为空或因场景不返回的字段是否写明条件。
- 是否错误套用 Req 的“提交必填”概念。
- 是否只有 Java 字段注释，却没有可进入 OpenAPI 的 `@Schema`。

### 9.4 范围

- Git 变更是否只包含目标接口的 Req/Resp、目标 Controller 的最小接入改动，以及经明确授权的项目级 OpenAPI 配置。
- Controller 是否只修改了方法签名、验证入口、必要 import 和对象转换。
- 是否误改 Service、DTO、Query、Mapper、SQL、前端或其他接口行为。
- 是否因删除或改名字段造成其他层必须联动修改。
- 是否已区分用户原有修改与本次治理修改，且没有覆盖、回退或混入无关变更。

## 10. Apifox 结果验证

代码治理完成后，应验证生成的 OpenAPI 文档，不能只检查 Java 源码上是否存在注解。

1. 读取 `/v3/api-docs` 或项目实际的 OpenAPI JSON/YAML。
2. 定位目标接口的 `paths`，确认请求体和响应引用的是目标接口专用 Schema，而不是旧共享 Schema。
3. 定位目标 Req/Resp 对应的 `components.schemas`，确认不存在当前接口不支持的多余字段。
4. 确认无条件必填字段进入 Schema 的 `required` 数组。
5. 确认选填和条件必填字段没有被错误放入 `required` 数组。
6. 确认 `description`、`format`、`example` 和 `enum` 等信息已生成。
7. 对照接口实际 JSON，确认 Resp Schema 中的字段和空值场景与真实返回一致。
8. 在 Apifox 导入或同步后，再确认必填标识、字段说明、格式和可选值与 OpenAPI 文档一致。

如果 Java 中已有 `@Schema` 但 OpenAPI JSON/YAML 中没有对应信息，问题位于 OpenAPI 生成链路，不应继续在 Req/Resp 中叠加自定义注解。

## 11. 分析、修复与提交确认

### 11.1 分析完成后的修复确认

分析阶段只读，不修改文件。输出问题表后，还应说明：

- 目标 Controller 方法、HTTP 方法和接口路径。
- 拟修改的准确文件及每个文件的修改目的。
- 预计发生的 Req/Resp 字段、必填性、Schema、校验或模型拆分变化。
- JSON 兼容性判断、阻断项和明确不在本次范围内的事项。

然后提供以下选项并暂停：

1. 按当前方案修复。
2. 调整方案后再确认。
3. 本次只保留分析，不修改。

即使用户最初使用了“治理”“修改”或“修复”，也不得跳过本关卡。

### 11.2 修复完成后的提交确认

修复后先完成静态自查，再展示实际修改结果、当前分支、计划暂存的准确文件、明确排除的用户已有修改和完整中文提交备注，然后提供以下选项并暂停：

1. 按展示范围和备注提交本地代码。
2. 暂不提交，保留工作区修改。

未经明确选择不得执行 `git add` 或 `git commit`。只允许暂存本次治理文件，不得使用可能混入无关修改的宽泛暂存方式。任务生成的 `md`、`sql`、`txt`、`json` 等非代码文件默认不纳入提交，除非用户明确要求。

提交备注必须使用中文，并明确写出 Req 或 Req/Resp 契约优化、涉及接口和实际影响范围。推荐格式：

```text
优化 Req/Resp 契约：{Controller}#{method}

- 优化类型：Req/Resp 字段治理
- 涉及接口：{HTTP_METHOD} {path}（{Controller}#{method}）
- 影响范围：{Req/Resp/Controller 等本次实际修改对象}
- 契约变化：{字段、必填性、Schema 或模型拆分等实际变化}
- 验证情况：{已执行的静态核对和明确未执行的验证}
```

仅治理 Req 或 Resp 时，应按实际情况修改标题和“优化类型”。无法确认接口路径、提交范围或工作区变更归属时，不执行提交，只报告阻断原因。

## 12. 自查输出要求

快速自查只输出存在问题的结构、字段和修改建议。

| 对象 | 字段 | 问题 | 修改建议 | 本次是否可修改 |
|---|---|---|---|---|
| 结构 | `VoyageReq` | 被多个契约不一致的接口复用，分页接口中的 `businessMode` 会被服务端固定覆盖 | 新建 `VoyageEstablishPageReq`，移除该接口无效字段，并调整目标 Controller 签名和转换 | 是 |
| Req | `voyageId` | 缺少 OpenAPI 必填契约 | 增加 `@Schema(description = "航次ID", requiredMode = Schema.RequiredMode.REQUIRED)` | 是 |
| Req | `reasonNote` | 条件必填被标记为全场景必填 | 改为 `NOT_REQUIRED`，并在 `description` 写明触发条件 | 是 |
| 结构 | `VoyageResp` | 分页接口与详情接口返回场景不同，共享 Schema 暴露分页接口不需要的字段 | 确认实际 JSON 和调用方兼容性后，新建 `VoyageEstablishPageResp`，Controller 仅转换分页接口契约字段 | 是，需先确认响应兼容性 |
| Resp | `waybillList` | 当前分页接口不查询或回填该字段，却因共享 Resp 出现在 Schema 中 | 若实际 JSON 无兼容依赖，不放入分页专用 Resp；保留原共享 Resp 字段供其他接口使用 | 是，需先确认响应兼容性 |

不输出：

- 正常字段。
- 完整调用链。
- 与问题无关的代码分析过程。
- 未经证据支持的字段用途猜测。
- 建议直接修改 Service、DTO、Query、Mapper、SQL 或前端等禁止范围文件的执行步骤。

## 13. 完成标准

1. 已判断现有 Req/Resp 是否被其他接口复用，并完成契约一致性评估。
2. 契约不一致时，目标接口已使用专用 Req/Resp，且旧共享类未影响其他接口。
3. 专用 Req 只包含目标接口真实支持的字段，专用 Resp 与目标接口约定及实际序列化 JSON 一致。
4. Controller 只进行了方法签名、验证入口、必要 import 和纯对象转换调整，业务行为保持不变。
5. Req 和 Resp 的对外业务字段均使用 OpenAPI 3 `@Schema` 描述。
6. Req 的无条件必填、选填和条件必填在 OpenAPI 中表达正确，并与运行时校验一致。
7. 字段的含义、格式、单位和可选值与真实业务契约一致。
8. 没有新增不能进入 OpenAPI 文档的自定义字段治理注解。
9. 生成的 OpenAPI `paths` 已引用目标接口专用 Schema，`components.schemas` 中不存在多余字段。
10. Apifox 同步后的必填标识、字段说明、格式和可选值与 OpenAPI 及接口实际 JSON 一致。
11. 未修改 Service、DTO、Query、Mapper、SQL、前端或其他无关接口。
12. 如果存在必须修改禁止范围或未授权项目级配置才能处理的问题，已明确报告且本次未越界修改。
13. 修改前已输出修复方案并取得明确修复确认，没有把初始治理请求当作修改授权。
14. 修复后已展示计划提交范围和中文提交备注；只有取得独立提交确认后才提交本地代码。

## 14. 常见错误

- 为了判断字段用途，直接修改 Service、DTO、Mapper 或 SQL。
- 发现共享 Req/Resp 契约不一致，仍在共享类中增加某个接口专属说明。
- 只拆分 Req，不检查共享 Resp 是否也包含当前接口不返回的字段。
- 为了减少重复字段建立大型 `BaseReq`、`BaseResp`，重新造成场景耦合。
- 新建专用 Req/Resp 后，在 Controller 中加入字段计算、状态判断、查询或回填等业务逻辑。
- 修改目标 Controller 签名时顺便改变原有查询条件、固定条件、排序、分页或返回行为。
- 原共享 Req/Resp 仍被其他接口使用时直接删除或改变其 JSON 契约。
- 添加自定义 `@ReqFieldSubmitRule`，却没有将其转换为标准 OpenAPI Schema。
- 只增加 Java 文档注释，认为 Apifox 会自动识别。
- 只增加 `@NotNull`，却不明确设置 `@Schema` 的 `requiredMode`。
- 把条件必填字段标记为 `REQUIRED`，导致 Apifox 显示为全场景必填。
- 只检查 Java 注解，没有验证生成的 OpenAPI JSON/YAML。
- 项目缺少 OpenAPI 能力时，未取得用户授权就修改 `pom.xml` 或全局配置。
- 删除 Req/Resp 字段后发现必须联动修改其他层，却继续扩大修改范围。
- 分析完直接修改代码，没有等待用户确认修复方案。
- 把用户确认修复理解为同时授权提交，或修复完成后自动执行 `git add`、`git commit`。
- 提交备注只写“优化接口”，没有说明 Req/Resp 治理、Controller 方法、HTTP 接口路径和实际影响范围。
- 提交时混入用户已有修改或任务无关文件。
