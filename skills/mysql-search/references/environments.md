# 数据库连接与环境

连接由 `op`、`bpm` 标识；展示名称分别为 OP数据库连接、BPM数据库连接。脚本也接受这两个完整中文名称，以及 OP/BPM 大写标识。环境仍为 dev、pre、prod，production/生产映射到 prod。

| 连接 | 环境 | 通道 | 配置文件（相对 mysql-search 配置目录） | 凭据 |
|---|---|---|---|---|
| op | dev | MySQL 8.0 直连 | connections/op/dev.json | 原钥匙串 codex.mysql-search.dev |
| op | pre | MySQL 8.0 直连 | connections/op/pre.json | 原钥匙串 codex.mysql-search.pre |
| op | prod | DMS ExecuteScript | connections/op/prod.json | 该连接的阿里云 CLI profile |
| bpm | prod | MySQL 5.7.20+/8.0 直连（8.0 客户端） | connections/bpm/prod.json | 独立钥匙串 codex.mysql-search.bpm.prod |

配置目录为 `${XDG_CONFIG_HOME:-$HOME/.config}/fangzhikun-skills/mysql-search`。Host、用户名、DMS 路由和实际数据库名称只保存在本机配置，公开源码与文档不保存真实映射。密码仅在钥匙串，阿里云身份由官方 CLI 管理。

## 定位规则

- 查询完整目标为连接、环境、数据库；新调用显式指定三个参数。OP/BPM 的通道由脚本固定，配置不得改变路由或关闭只读策略。
- 旧命令省略 --connection 时固定 OP；请求的库已登记于 BPM 时提示补充连接参数，不自动转到 BPM。不从库名猜环境。BPM 配置缺失或损坏不阻止旧命令查询独立的 OP 目标。
- OP prod 只接受该配置中的精确 DMS 数据库映射；BPM prod 只接受该配置中唯一 allowedDatabases 项。OP dev/pre 保持原指定 schema 的方式，可在配置中额外限定 allowedDatabases，重新配置时保留该范围；无效白名单在录入凭据前拒绝。
- BPM dev/pre、未知连接、未登记库、停用连接、缺失配置或无效配置均停止，不读取凭据或跨连接尝试。
- 新 OP 配置不存在时，兼容同一环境的旧 dev.json/pre.json/prod.json。新文件存在但无效、停用或未配置时不回退旧文件。迁移只复制非秘密配置并补充归属，保留全部旧文件及原钥匙串服务。
- 现有 vesselhub-problem-analyze、zentao-debug 排查链路固定 OP，不因 BPM/审批关键词、失败或空结果改变连接；泛微 API 的独立查询规则不变。

## 查询限制

生产上限按环境决定：OP prod 和 BPM prod 默认/最大 200 行，OP dev/pre 默认 200、最大 500 行。所有 SELECT 由完整语法校验器补齐或校验 LIMIT，未知语法或函数拒绝。元数据核验仍限定引用表、schema，视图/外部引擎/缺失元数据禁止业务查询。

BPM 在同一 MySQL 5.7.20+/8.0 会话中开启只读事务，核验实际库与只读状态，随后核验表和查询，正常结束回滚，失败关闭会话；禁止自动重连。OP 保留现有 MySQL/DMS 执行逻辑。BPM 默认校验 TLS 身份；无 TLS 必须由用户明确选择并额外登记 allowUnencrypted=true，不因连接失败自动切换。支持子集和 DMS 保障边界见 [readonly-policy.md](readonly-policy.md)。
