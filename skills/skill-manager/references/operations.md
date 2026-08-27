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

## 安装目录漂移

先创建系统临时目录，再导出安装内容：

```bash
skill_import_root="$(mktemp -d)"
./tools/skillctl import-local <skill-name> \
  --destination "$skill_import_root/<skill-name>"
```

比较源码和导出目录，只展示文件名、差异摘要和必要片段。人工修改必须由用户确认归属后，才能以最小范围合入源码；不得直接从安装目录覆盖源码。

## Git 提交

提交预览包含：

- 当前分支和 upstream。
- 本次修改文件。
- 不纳入的已有修改。
- 版本和变更记录。
- 静态校验结果。
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

执行：

```bash
./tools/skillctl deploy <skill-name>
./tools/skillctl status <skill-name>
```

`--force-initial` 只用于首次接管已有安装目录。普通更新不得使用它绕过漂移保护。

部署后报告版本、安装路径、部署时间和备份位置。当前会话不会自动重新加载 Skill；需要新建会话验证新版本。

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
