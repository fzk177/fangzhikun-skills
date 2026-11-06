# 操作契约

只在进入对应管理模式时读取相关章节。所有命令都在本机配置的 Skill 源码仓库中执行。

## 状态检查

本机源码与安装状态：

```bash
./tools/skillctl status --all
git status --short --branch
git rev-parse HEAD
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
```

用户要求核对 GitHub 最新状态时，可以执行 `git fetch origin <当前分支>`，随后比较本地 HEAD、upstream 和远端提交。不要使用 `pull`、`reset`、`checkout` 或自动合并。

状态必须区分：

- GitHub 远端提交。
- 本地源码提交与未提交修改。
- 当前安装内容。
- 最近部署记录与可用备份。

`skillctl` 返回“安装目录存在人工漂移”时，不得继续部署。

## 静态校验

单个 Skill：

```bash
./tools/skillctl validate <skill-name>
```

全部 Skill：

```bash
./tools/skillctl validate --all
git diff --check -- <本次修改文件>
```

校验失败必须报告具体文件和原因。不得通过删除规则、放宽敏感信息正则或跳过目标文件来制造通过结果，除非用户明确要求调整规则且已经说明安全影响。

## Obsidian 文档同步

同步工具优先读取本机 `runtime.json` 中的 `skillManager.obsidianDocsRoot`，该字段指向现有 Obsidian 库的 `03.AI/20.skills管理/10.文档`；未设置时才使用 `paths.vault` 拼接该相对路径。不向公开仓库写入个人绝对路径。同步记录位于 `~/.local/state/fangzhikun-skills/obsidian-docs.json`，不进入 Git。总览页位于文档目录外，不参与同步。

首次接入先预览全部 Markdown，再执行安全复制和一致性核对：

```bash
./tools/skilldocs sync
./tools/skilldocs sync --apply
./tools/skilldocs check
```

普通源码更新只处理目标 Skill 和根目录 `CHANGELOG.md`：

```bash
./tools/skilldocs status --skill <skill-name>
./tools/skilldocs sync --skill <skill-name>
./tools/skilldocs sync --skill <skill-name> --apply
./tools/skilldocs check --skill <skill-name>
```

`status`、不带 `--apply` 的 `sync` 和 `check` 均只读。同步工具以最近一次一致内容的哈希判断方向；两侧内容不同且都发生变化、文件删除、软链接或登记范围变化时停止，不自动覆盖或删除。仅在 Obsidian 新建的文档需要先审阅内容，再以 `--import-new <仓库相对路径>` 显式允许导入；新文件不自动暂存或纳入 Git。同步时重新核对写入前内容，并在写入后核对哈希。

如果本次还修改了 `README.md` 或 `config/examples/` 下的 Markdown，使用全量 `sync` 预览和应用；全量预览存在无关文档改动或冲突时，不代替用户决定归属，应先处理后再同步。新生成文档不自动暂存或纳入 Git。

源码校验通过后完成 Obsidian 同步，且对应文档一致，才能进入 Git 提交、推送或部署预览。仅执行这些后续动作时运行只读 `check --skill <skill-name>`。回滚只改变安装版本，不同步旧文档到 Obsidian。

## 安装目录漂移

先创建系统临时目录，再导出安装内容：

```bash
skill_import_root="$(mktemp -d)"
./tools/skillctl import-local <skill-name> \
  --destination "$skill_import_root/<skill-name>"
```

比较源码和导出目录，只展示文件名、差异摘要和必要片段。人工修改必须由用户确认归属后，才能以最小范围合入源码；不得直接从安装目录覆盖源码。

漂移已合入源码、目标 Skill 与注册表均已提交且静态校验通过后，使用同一个导出目录生成接管预览：

```bash
./tools/skillctl accept-drift <skill-name> \
  --reviewed-directory "$skill_import_root/<skill-name>"
```

如果安装内容对应当前源码的一个已提交旧版本，而当前源码已经在该版本之上继续演进，可显式指定该旧版本的完整提交哈希：

```bash
./tools/skillctl accept-drift <skill-name> \
  --reviewed-directory "$skill_import_root/<skill-name>" \
  --source-baseline <完整祖先提交哈希>
```

旧源码基线必须是当前 `HEAD` 的祖先，且该提交中的目标 Skill 注册信息与当前源码保持相同的所有权、源码路径和部署目标。安装内容必须与该提交中的目标 Skill 除 `SKILL.md` 版本号外完全一致；不得用分支名、远端引用或无关历史替代已经审阅的具体提交哈希。

预览必须展示目标 Skill、源码版本、源码/安装/导出/原部署摘要和完整 64 位计划哈希，然后单独询问是否接受该漂移。用户确认后使用完全相同的导出目录和计划哈希执行：

```bash
./tools/skillctl accept-drift <skill-name> \
  --reviewed-directory "$skill_import_root/<skill-name>" \
  [--source-baseline <与预览相同的完整祖先提交哈希>] \
  --apply \
  --plan-hash <完整计划哈希>
```

该命令只更新本机部署状态，不修改源码或安装目录，并保存原部署状态备份。以下任一条件不满足时必须停止：

- 导出目录与当前安装内容完全一致。
- 未指定旧源码基线时，当前源码与安装内容除 `SKILL.md` 版本号外完全一致。
- 指定旧源码基线时，基线是当前 `HEAD` 的已提交祖先，基线注册信息与当前源码一致，且基线内容与安装内容除 `SKILL.md` 版本号外完全一致。
- 目标 Skill 源码和 `registry/skills.json` 没有未提交修改。
- 执行时重新计算的计划哈希与用户确认值一致。

预览必须额外展示接管基线的完整提交哈希、版本和摘要。基线提交、基线内容、当前源码、安装内容、导出副本或原部署状态任一变化时，原计划哈希失效。

接管成功后状态应为“源码有待部署修改”或“已同步”，再单独生成部署预览；接受漂移不等于授权部署。

## 保留私有资料后的受控替换

当安装漂移同时包含可公开的能力变更和不能进入公开仓库的非秘密本机资料，无法满足普通 accept-drift 的源码一致性要求时，只有用户明确授权此路径后才能使用。不得先提交私有内容再删除，也不直接改安装目录或使用 force-initial 绕过保护。

1. 使用 import-local 导出完整安装目录，审阅所有差异；将通用规则以最小范围合入源码并校验。账号映射、应用清单与最小脱敏验证资料只保留到明确的本机私有目录，不保存凭据。
2. 使用以下命令预览；目录和每个私有文件均为审阅确认的实际值，不执行占位命令：

```bash
./tools/skillctl deploy-reviewed <skill-name> \
  --reviewed-directory <已审阅导出目录> \
  --local-archive <本机非秘密资料目录> \
  --private-file <导出副本中明确的相对文件路径>
```

3. --private-file 可重复传入，保存到本机资料目录下对应文件名；同名目标已有不同内容时停止，不覆盖人工资料。目录权限 700、文件权限 600。导出、本机资料、源码与安装路径不允许软链接，导出和资料目录不得位于仓库或安装根目录中。
4. 展示目标、版本、变化文件、源码 / 安装 / 导出摘要、原部署状态摘要、私有资料路径和完整 64 位计划哈希。用户确认后使用相同参数及 --apply --plan-hash 执行。源码、注册表、管理工具必须先提交；提交改变 HEAD 会使旧计划失效，执行前重新预览并核对最终计划，不复用旧哈希。
5. 工具先校验与保留私有资料，再反复核对计划；保存完整旧安装到部署 backups 后原子替换，验证安装哈希并登记新部署状态。失败则恢复原安装，已经保存的本机资料不删除。工具不会删除旧副本或备份，也不会自动提交或推送。
6. 成功后运行 skillctl status；只确认目标源码、安装及部署记录一致，不声称当前会话已经加载新版本。恢复安装可使用既有 rollback，私有资料不随普通部署或回滚被覆盖。

该路径是显式批准的备份替换，不把未完整合入公开源码的漂移登记为合法源码基线；原 accept-drift 的严格一致性和祖先约束保持不变。

## Git 提交

提交预览包含：

- 当前分支和 upstream。
- 本次修改文件。
- 不纳入的已有修改。
- 版本和变更记录。
- 静态校验结果。
- Obsidian 对应文档的一致性核对结果。
- 中文提交备注。

提交备注格式：

```text
<类型>（<中文影响范围>）<准确描述结果>
```

用户确认后逐个显式暂存文件，再检查 `git diff --cached --check` 和 `git diff --cached --stat`，最后提交。提交说明中的影响范围必须使用中文。

## GitHub 推送

推送前检查：

```bash
git remote -v
git status --short --branch
git rev-parse HEAD
git rev-parse '@{upstream}'
```

只推送预览中确认的当前分支和远端，不自动设置或改变 upstream；尚无 upstream 时必须单独说明并等待用户决定。推送后核对远端提交，并在仓库配置 GitHub Actions 时读取最近一次对应校验结果。

## 部署

部署前必须满足：

- 目标源码静态校验通过。
- 安装目录没有人工漂移。
- 目标版本与预览一致。
- 用户已经明确确认部署。
- Obsidian 对应文档与源码一致。

执行：

```bash
./tools/skillctl deploy <skill-name>
./tools/skillctl status <skill-name>
```

`--force-initial` 只用于首次接管已有安装目录。普通更新不得使用它绕过漂移保护。

部署后报告版本、安装路径、部署时间和备份位置。当前会话不会自动重新加载 Skill；需要新建会话验证新版本。

本机配置登记了远端主机时，部署同时包含下节的远端主机同步；只部署本机而遗漏已登记远端主机，视为部署未完成。

## 远端主机同步

远端主机（如个人 Windows 工作机的 WSL）各自保存一份本仓库，用远端本地的 `skillctl` 部署 Codex 原版和生成 Claude 副本。Claude 副本含有按本机主目录生成的绝对路径，禁止把 Mac 的安装目录直接复制到远端。

### 登记

远端主机只登记在本机 `runtime.json` 的 `skillManager.remoteHosts`，字段含义见 `config/examples/runtime.example.json`：`name`、`sshAlias`、`platform`（`windows` 或 `linux`）、Windows 的 `wsl.distro` 与 `wsl.user`、远端环境中的 `repository` 绝对路径，以及需要维护的 `targets`（`codex`、`claude`）。未登记时只处理本机，不从 SSH 配置或历史对话猜测远端主机。公开仓库只使用占位示例。

### 执行方式

- 连接前先执行 `ssh -o BatchMode=yes -o ConnectTimeout=8 <sshAlias> 'echo ready'`。
- `platform` 为 `windows` 时，远端命令遵循 [server-connect 的 Windows 执行方式](../../server-connect/references/windows.md)：在本机临时目录写脚本、上传到远端临时目录，用 `wsl -d <distro> -u <user> -- bash -l /mnt/c/<路径>` 执行，执行后删除临时目录；不内联拼接含管道、引号或 `$` 的命令。
- 远端只运行仓库内 `tools/skillctl` 与只读 Git 命令，以及确认后的 `git merge --ff-only`；不执行 `pull`、`reset`、`checkout`、`clean` 或 `--force-initial`（首次接入除外）。

### 部署预览（与本机部署预览合并）

本机推送完成、远端 GitHub 校验通过后，对每台已登记远端主机只读收集：

1. 连通性；远端仓库路径与远端 `runtime.json` 的 `skillManager.repository` 一致。
2. `git status --short --branch` 无未提交修改；`git fetch origin <分支>` 后，远端 `HEAD` 是本机已推送目标提交的祖先或与其相同。
3. 在远端临时工作树（`git worktree add --detach <临时目录> <目标提交>`）或快进后的仓库中执行 `skillctl status`、`skillctl claude-status`，得到待部署 Skill、版本和漂移状态；`claude-sync <skill>` 预览得到远端计划哈希。使用临时工作树时预览完成后移除该工作树。

部署预览中按主机分别列出：目标提交、远端当前 `HEAD`、将部署的 Codex Skill 与版本、Claude 同步计划哈希，以及不可达、工作区不干净、无法快进或人工漂移等阻塞。用户对这份预览的部署确认同时覆盖本机和其中列出的远端动作。

### 执行与验证

1. 本机部署完成后，远端执行 `git merge --ff-only <目标提交>`，再执行目标 Skill 校验。
2. 按预览逐个执行 `skillctl deploy <skill>`；Claude 端用 `claude-sync <skill> --apply --plan-hash <预览哈希>`，存在依赖时先同步依赖。执行时计划哈希与预览不一致即停止并重新预览。
3. 完成后执行 `skillctl status --all` 和 `claude-status --all`，报告每台主机的版本、部署时间与备份位置。

远端任一阻塞只停止该主机的后续动作，不回退已完成的本机部署；汇报时明确哪些主机已同步、哪些未同步及原因。远端人工漂移按“安装目录漂移”在远端导出审阅，不用本机结果覆盖。Obsidian 文档只在本机核对，远端不涉及。远端回滚是独立动作，需在远端用 `skillctl rollback` 或 `claude-rollback` 单独预览和确认。

### 首次接入

远端尚无仓库或部署记录时，首次接入需单独预览和确认，因为它会修改远端真实配置并接管已有安装目录：

1. 在登记的 `repository` 路径克隆本仓库，切到本机已推送的同一提交。
2. 在远端 `runtime.json` 中只新增或更新 `skillManager.repository`，保持目录权限 `700`、文件权限 `600`，不复制本机其他配置。
3. 对已存在但无部署记录的安装目录，逐个与目标源码比较：内容一致（`SKILL.md` 版本号外）或仅差运行缓存时，展示差异摘要后用 `deploy --force-initial` 接管；存在其他差异时按人工漂移处理，停在该 Skill 并询问归属。
4. Claude 副本按 `claude-status --all` 的结果处理，未登记或不一致的已有目录同样先审阅差异，不直接覆盖。

## 回滚

先从 `~/.local/state/fangzhikun-skills/backups/<skill-name>/` 读取可用备份目录、时间和文件哈希，只展示候选摘要。明确用户选择后执行：

```bash
./tools/skillctl rollback <skill-name>
./tools/skillctl status <skill-name>
```

回滚只改变安装版本，不回退 Git 源码。被替换的当前安装版本会保存到 `replaced` 目录。回滚后通常应显示“源码有待部署修改”，这是预期状态，不应自动再次部署。

## 本机配置

真实配置位于 `${FANGZHIKUN_SKILLS_CONFIG:-~/.config/fangzhikun-skills/runtime.json}` 及其 `profiles/`、`mysql-search/` 子目录。

修改前只展示字段名和脱敏后的旧值/新值，得到确认后执行最小修改，并保持目录权限 `700`、文件权限 `600`。禁止把真实配置复制到仓库 `config/examples/`；示例只能使用占位内容。
