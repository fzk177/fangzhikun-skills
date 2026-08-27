---
name: obsidian-plugin-develop
description: 维护、Fork、合并、构建、版本化、中文提交、推送和发布 Obsidian 第三方插件，并处理 GitHub Release、community.obsidian.md 首次提交、自动审核反馈、上游升级及重装恢复。仅当用户显式使用 $obsidian-plugin-develop 或明确要求使用此 skill 时使用；不用于普通 Obsidian 笔记编辑，也不用于 Codex 插件开发。
version: 1.0.0
---

# Obsidian 插件开发与发布

## 目标

把 Obsidian 插件从本地维护到可恢复、可构建、可发布的状态，保留用户改造并降低官方更新、系统重装和插件重装造成的覆盖风险。

## 识别任务模式

- **排查或评审**：只读检查源码、构建产物、配置和上游差异；用户未要求修改时不要写文件、提交或发布。
- **维护或开发**：修改现有插件源码或补丁，完成必要的生产构建和静态检查。
- **Fork 或整合**：检查许可证、上游源码、插件 ID、数据格式、生命周期和设置冲突，建立独立可安装插件。
- **Git 提交或推送**：仅在用户明确要求时执行，提交信息及“影响范围”使用中文。
- **GitHub Release 或市场发布**：仅在用户明确要求时创建 Release、更新远端或提交 Obsidian Community 审核。

仅调用 skill 不自动扩大外部写入权限。没有明确要求“提交、推送、发布、上架”时，在对应外部操作前停止并请求确认。

## 核心流程

1. 查找目标插件目录、源码仓库、`manifest.json`、运行时 `data.json` 和当前构建产物。
2. 读取仓库内适用的 `AGENTS.md`，检查 Git 状态并保留用户已有修改。
3. 确认上游仓库、许可证、基线版本、Commit 和发布资产哈希。
4. 选择源码维护、独立 Fork、内部模块整合或确定性补丁层；不得把缺失的历史源码伪装成已恢复。
5. 修改代码时保持现有格式，复杂逻辑使用中文注释；不顺手整理无关代码。若任务需要直接修改 vault 安装版，必须在同一轮把等价改动写入源码或确定性补丁层，立即生产构建并验证一致性；禁止把“稍后再恢复源码”留到发布阶段。
6. 发布或重装前，先审计近期 Codex/Claudian 会话是否直接修改过目标插件安装目录。使用 [scripts/audit_session_customizations.py](scripts/audit_session_customizations.py) 找出相关操作，并逐项核对它们已经进入源码。用户提到“以前改过、聊天里有、截图丢了”时，读取 `<vault>/.claudian/sessions/*.meta.json` 中的 `providerState.sessionFilePath`，再从对应 Codex JSONL 恢复需求、补丁和仍存在的截图路径。
7. 在修改版本号、提交或打标签前，从当前源码执行生产构建，并把构建后的 `main.js`、可选 `styles.css` 与目标 vault 安装目录逐字节比较；仅允许忽略 Obsidian 在安装版 `main.js` 末尾追加的 `/* nosourcemap */` 和文件末尾换行。目标安装存在但不一致时，视为尚未进入源码的用户改动，立即停止发布，先恢复并纳入可重复构建流程。
8. 使用 [scripts/verify_release_parity.py](scripts/verify_release_parity.py) 执行安装目录、源码构建和下载后 Release 资产的一致性门禁。仓库工作区干净和产物一致性都是必要条件，但不能证明更早被覆盖的定制没有丢失；会话改动审计与维护清单核对也必须通过。
9. 按请求执行生产构建、JavaScript 语法检查、Manifest/Release 一致性检查和必要的静态验证。
10. 未经用户确认不要运行单元测试。不要因为仓库自带测试脚本就自动执行。
11. 用户要求提交时，先检查差异和敏感信息，再使用中文 Commit 与中文影响范围。
12. 用户要求推送或发布时，核对 GitHub 登录账号、仓库可见性、目标分支和 Release 资产后再执行。
13. Release 创建后必须下载实际资产，用一致性脚本与标签源码中的三个发布文件精确比较；不一致时不得把发布标记为完成。
14. 用户要求进入 Obsidian 市场时，读取 [references/release-marketplace.md](references/release-marketplace.md) 并按最新官方流程处理。

开发、Fork、插件合并和本地安装的详细步骤见 [references/development-workflow.md](references/development-workflow.md)。

## 安全边界

- 不显示、记录或提交 GitHub Token、密码、Cookie、SSH 私钥或 Obsidian 账号凭据。
- `data.json`、vault 业务笔记、临时日志、截图和构建缓存默认不提交，除非用户明确要求且确认不含敏感数据。
- 修改公开仓库前检查 Git 作者邮箱；公开发布优先使用 GitHub noreply 邮箱。
- 不同时启用会重复注册相同视图、命令或事件的原插件与 Fork 插件。
- 迁移数据时保留旧插件目录和设置，验证完成前不删除。
- 上游代码不是本人原创时保留许可证、原作者声明和第三方来源。
- Obsidian Community 登录、GitHub 账号关联及网页端最终确认必须由用户本人完成，不绕过账号验证。
- 自动审核未完成时不要重复提交；收到反馈后先判断是否需要递增版本并重新发布。

## Git 规则

- 基于现有分支创建新分支时，默认创建干净的本地分支，不自动设置 upstream。
- 不覆盖用户手工改过的生成文件；先确认生成来源和当前文件是否与构建产物一致。
- 发布前先记录目标安装目录实际资产哈希，再执行源码构建和版本更新。若安装目录无法定位，不得声称当前本地改动已包含在发布中；用户明确说“发布这次改动”时，需要先取得安装目录或由用户明确放弃该项核验。
- 提交前执行 `git diff --check`、查看暂存统计并扫描可能的敏感文件。
- Commit 示例：

  ```text
  feat: 内置工作量洞察

  影响范围：插件生命周期、工作量视图、设置迁移和发布产物。
  ```

- 强制推送只允许用于自己尚未合并的功能分支，并使用 `--force-with-lease`。

## 完成标准

结果汇报应包含：

1. 插件路径、仓库、分支、Commit 和版本。
2. 修改或整合的能力范围。
3. 生产构建及静态检查结果；明确说明是否运行单元测试。
4. 本地安装、旧插件禁用和设置迁移状态。
5. 安装目录、源码构建和下载后 Release 资产的一致性结果；若 `main.js` 仅有 `/* nosourcemap */` 差异需明确说明。
6. GitHub 仓库、PR、Release 和下载资产链接。
7. Obsidian Community 的提交或审核状态，以及仍需用户完成的账号操作。
