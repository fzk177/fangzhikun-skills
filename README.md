# fangzhikun-skills

用于版本化维护、校验和部署个人 Skills 的公开源码仓库，支持 Codex 原版和 Claude Code 通用入口。

## 仓库内容

- `skills/`：自主维护的 Skill 源码。
- `registry/skills.json`：Skill 版本、依赖、所有权和部署目标注册表。
- `config/examples/`：不包含真实地址、账号或凭据的本机配置示例。
- `tools/skillctl`：状态检查、校验、部署、导入、回滚和环境诊断工具。
- `checks/public-safety.patterns`：公开发布前的敏感信息规则。

## 配置边界

仓库只保存可公开的执行规则、脚本和配置示例。真实配置默认放在：

```text
~/.config/fangzhikun-skills/
├── runtime.json
└── profiles/
    ├── server-connect.md
    └── zentao-task.md
```

密码、Token、Cookie、AccessKey Secret 等凭据不得写入上述文件，继续使用 macOS 钥匙串或工具官方凭据存储。

可以通过 `FANGZHIKUN_SKILLS_CONFIG` 指定其他 `runtime.json` 路径。

## 使用方式

```bash
./tools/skillctl status --all
./tools/skillctl validate --all
./tools/skillctl doctor
./tools/skillctl deploy zentao-debug
./tools/skillctl deploy --all
./tools/skillctl rollback zentao-debug
```

不熟悉命令行时，可以在新会话中使用自然语言管理入口：

```text
$skill-manager 查看所有 Skill 状态
$skill-manager 更新 log-search
$skill-manager 校验并部署 zentao-task
$skill-manager 回滚 zentao-debug
```

`skill-manager` 只负责理解目标、展示差异和组织确认，底层仍调用 `skillctl`。Git 提交、GitHub 推送、本机部署和回滚不会相互推导授权。

安装目录出现未被部署记录覆盖的人工修改时，部署会停止。先执行：

```bash
./tools/skillctl status zentao-debug
./tools/skillctl import-local zentao-debug --destination <安全目录>
```

确认差异已经进入源码后再重新部署。

## Claude Code 接入

使用同一份已登记的自研源码生成 Claude Code 个人入口，无需更改 Skill 版本或真实连接配置：

```bash
./tools/skillctl claude-status --all
./tools/skillctl claude-sync --all
# 审阅完整预览并确认后，使用预览中的 64 位计划哈希执行：
./tools/skillctl claude-sync --all --apply --plan-hash <完整计划哈希>
```

默认位置是 `~/.claude/skills/<技能名>/`，设置 `CLAUDE_CONFIG_DIR` 时使用该配置目录下的 `skills/`。`--all` 处理已登记且已适配的 Skill；也可以指定一个 Skill，或重复使用 `--exclude <技能名>`。缺少内部依赖时先同步依赖，或使用 `--all`。

适配仅改变生成入口的调用约定：Claude Code 使用 `/技能名`；根据 `agents/openai.yaml` 中的 `allow_implicit_invocation` 生成对应的 `disable-model-invocation`。Java 后端编码保留已有自动启用策略，其余依照各自策略。脚本和引用文件保持源码内容及目录布局，已授权的内部依赖按原规则读取，原有业务权限边界不变。

外部依赖不复制、不纳入自研管理。工具核验原安装入口，并在生成文档中给出本机引用；依赖资源仍从原目录读取。缺少依赖时停止，Codex 专属工具与真实会话身份不会自动变为 Claude 工具或身份；需要在 Claude 新会话中验证相应运行能力。

同步默认只预览，计划绑定源码、工具、注册表、外部入口、目标内容和旧部署状态；执行前检查 Obsidian 文档一致性。已有未受管目录、人工漂移、链接或特殊文件均停止覆盖。每个 Skill 独立原子替换，批量过程中后续失败时保留前面已完成的项目，查看状态后重新预览再继续。

Claude 状态与备份独立保存在 `~/.local/state/fangzhikun-skills/claude/`，不改变 Codex 安装或部署记录。已有版本被替换前保留完整目录和部署记录；首次安装没有旧版本备份。恢复时先预览并确认：

```bash
./tools/skillctl claude-rollback <技能名> --backup <该技能的完整备份目录>
./tools/skillctl claude-rollback <技能名> --backup <同一备份目录> --apply --plan-hash <完整计划哈希>
```

回滚保留选定备份，并把被替换版本另存为 `replaced`。后续源码升级不会静默改变 Claude 副本，需重新预览和确认同步；不要直接修改生成目录。未更新的 `skill-manager` 在 Claude 入口中会附带本节命令说明，不将其视为管理 Skill 自身的新版本。

## 显式退役文档

用户明确要求删除 Skill 时，在移除源码和注册表之前，先通过 `tools/skilldocs retire --skill <技能名> --archive-dir <管理目录之外的绝对路径>` 预览文档退役，再以相同参数加 `--apply` 执行。工具要求源码、Obsidian 文档和同步基线一致，将文档保留到新的归档目录后移除对应同步登记；存在人工修改、缺失文件、链接或未管理内容时停止。普通 `sync` 仍拒绝删除和登记范围变化，不自动退役 Skill。

该操作只退役文档；删除源码、注册表、安装副本和安装登记仍须遵守用户明确指定的范围，并先保留恢复副本。

## 发布流程

1. 修改源码并检查差异。
2. 更新 `registry/skills.json` 中对应版本和根目录 `CHANGELOG.md`。
3. 执行 `./tools/skillctl validate --all`。
4. 使用中文提交说明提交 Git。
5. 推送 GitHub 后，显式执行部署；Git 分支切换不会直接改变运行中的 Skill。

## 权利说明

仓库中的自主维护内容保留所有权利。
