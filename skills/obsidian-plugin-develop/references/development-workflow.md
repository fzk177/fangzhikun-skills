# Obsidian 插件维护、Fork 与整合流程

## 目录

1. 初始盘点
2. 维护策略选择
3. 独立 Fork
4. 合并多个插件
5. 构建与静态验证
6. 本地安装与迁移
7. Git 提交与推送

## 1. 初始盘点

先解析目标 vault 和插件目录：

```text
<vault>/.obsidian/plugins/<plugin-id>/
├── main.js
├── manifest.json
├── styles.css
└── data.json
```

检查：

- `manifest.json` 的 ID、版本、作者、最低 Obsidian 版本和桌面限制。
- 当前 `main.js`、`styles.css`、补丁脚本及上游 Release 的 SHA-256。
- `data.json` 是否属于用户运行时设置。
- `.obsidian/community-plugins.json` 中是否同时启用了冲突插件。
- Git 仓库是否存在未提交或人工修改内容。
- `.claudian/sessions/*.meta.json` 是否引用了近期修改该插件的 Codex 会话；安装目录曾被直接修改时，必须把会话中的需求、补丁和截图纳入恢复清单。

通过 Obsidian 社区插件目录或 GitHub API定位上游仓库，确认默认分支、标签、许可证和源码是否完整。

## 2. 维护策略选择

### 源码维护

上游提供完整 TypeScript 源码且本地改动能映射到源码时，优先用源码实现并保持每项功能独立提交。

### 确定性补丁层

历史定制源码缺失、只有已构建 Bundle 时：

1. 保留不可变的 `vendor/main.vendor.js`。
2. 对目标片段进行唯一匹配及源码哈希校验。
3. 使用可读的补丁脚本生成 `main.js`。
4. 在文档中明确哪些功能来自 Vendor 基线、哪些来自后续补丁。
5. 不宣称已经恢复不存在的 TypeScript 源码。

### 伴生插件

只适合公开 API、CSS 或 DOM 扩展。需要修改内部筛选、虚拟化、存储或生命周期时，伴生插件通常不能保证兼容，优先使用独立 Fork。

## 3. 独立 Fork

1. 从准确的上游标签或 Commit 创建本地分支。
2. 将官方远端命名为 `upstream`，用户仓库命名为 `origin`。
3. 使用新的唯一插件 ID，避免市场更新覆盖原插件。
4. 保留原作者许可证和版权说明。
5. 保持 Markdown Frontmatter、稳定 ID、Wiki-link 和数据目录结构兼容。
6. `data.json` 不提交；在迁移文档中说明复制方式。
7. 官方插件与 Fork 不得同时启用。

公开仓库提交前把 Git 邮箱改为 GitHub noreply，避免公开公司邮箱。

## 4. 合并多个插件

先检查：

- 两个插件是否注册相同视图类型、命令 ID、Ribbon 或设置页。
- 是否各自继承 `Plugin` 并维护独立生命周期。
- 是否同时调用 `loadData()`、`saveData()`，以及字段是否冲突。
- 是否依赖原插件 ID、原插件目录、特定版本正则或外部插件注册表。
- CSS 类是否有命名空间。

推荐整合方式：

1. 选择一个主插件作为唯一导出和生命周期所有者。
2. 把第二插件改为内部模块，注册资源由主插件托管并在卸载时释放。
3. 设置字段放入不冲突的命名空间，或明确同步到主插件设置并保证后续保存不会覆盖。
4. 替换外部插件 ID、旧设置路径和版本检测。
5. 删除重复设置页；需要保留配置能力时，将设置项合并到主设置页或提供独立配置入口。
6. 合并 CSS 时保留前缀和第三方许可证注释。
7. 保留第二插件完整来源、版本、Commit、许可证和第三方声明。
8. 原插件保留到迁移成功，但从启用列表移除。

如果使用两个编译 Bundle 合并：

- 分别放入 CommonJS 闭包，避免全局符号和 `module.exports` 冲突。
- 最终只导出一个主插件类。
- 子插件生命周期必须显式加载和卸载。
- 构建脚本必须进行基线哈希、唯一匹配和最终语法检查。

## 5. 构建与静态验证

生产构建不是单元测试，可以在用户要求完成插件改造时执行。不要自动运行 `test`、`vitest` 或仓库自带单元测试。

### 发布产物一致性门禁

产物一致只能证明“当前安装版”和“当前源码构建”相同，不能发现已经被重装或旧构建覆盖的历史定制。发布前必须同时完成：

1. 对照 `CUSTOMIZATION.md`、Changelog 和源码模块确认维护能力清单完整。
2. 执行会话改动审计：

   ```bash
   python3 <skill-dir>/scripts/audit_session_customizations.py \
     --vault <vault> \
     --plugin-id <plugin-id> \
     --repository <source-repository> \
     --fail-on-findings
   ```

3. 对每条直接安装版修改，确认同一能力已进入 TypeScript 源码、`custom/` 模块或带基线哈希的确定性补丁。审计有发现不等于失败，但未经人工逐项核对不得发布。

日常维护中如直接编辑安装版，必须在同一轮完成“源码实现 → 生产构建 → 安装一致性验证”。不能只记录待办，也不能依赖发布前再从最终 Bundle 反推源码。

用户要求发布“当前改动”且目标 vault 安装目录存在时，必须执行以下三阶段检查：

1. **版本更新前**：记录安装目录实际 `main.js`、`manifest.json`、可选 `styles.css` 的 SHA-256，从当前源码执行生产构建，再运行一致性脚本。安装版 `main.js` 只允许多出 Obsidian 自动追加的 `/* nosourcemap */` 和末尾换行。
2. **提交与打标签前**：再次生产构建，确认生成文件没有未解释差异；安装版 Manifest 允许仍是上一版本，但除 `version` 外的字段必须一致。
3. **Release 创建后**：下载 GitHub Release 的实际资产，与标签源码根目录下的发布文件逐字节比较。必须比较下载内容，不能只读取工作流成功状态或复用旧 Release 哈希。

安装目录与源码构建不一致时，停止版本更新、提交、打标签和发布。把安装文件视为可能包含尚未入库的人工修改，先寻找源码、会话补丁、Git 对象或其他可恢复副本，将差异纳入源码或确定性补丁层，再重新开始三阶段检查。不得先用源码构建覆盖安装目录来消除差异。

一致性脚本示例：

```bash
python3 <skill-dir>/scripts/verify_release_parity.py \
  --repository <source-repository> \
  --plugin-dir <vault>/.obsidian/plugins/<plugin-id>

python3 <skill-dir>/scripts/verify_release_parity.py \
  --repository <source-repository-at-release-tag> \
  --release-dir <downloaded-release-assets>
```

至少检查：

- `node --check main.js`。
- `manifest.json` 是合法 JSON，ID、名称和版本正确。
- 构建后根目录包含 `main.js`、`manifest.json`、可选 `styles.css`。
- 重复视图、命令、旧插件 ID、旧设置路径和重复设置页不存在。
- 规范化 `/* nosourcemap */` 后，源码构建产物与本地安装产物一致。
- 下载后的 Release 资产与对应标签源码发布文件逐字节一致。
- Git 中没有 `data.json`、Token、密码、Cookie、日志或 vault 业务数据。

## 6. 本地安装与迁移

1. 构建后复制三个安装文件到新的插件目录。
2. 保留目标目录已有 `data.json`。
3. 如果需迁移旧插件设置，保留旧目录并在首次启动时读取；不要先删除。
4. 从 `.obsidian/community-plugins.json` 移除冲突插件，只保留新插件。
5. 要求用户重启 Obsidian 或重新启用插件。
6. 验证视图、命令、设置、数据、链接、滚动和筛选。

## 7. Git 提交与推送

提交前：

```bash
git status --short
git diff --check
git diff --stat
```

提交信息与影响范围使用中文。外部仓库创建前确认：

- GitHub 当前登录账号。
- 仓库名称和 Public/Private。
- 默认分支。
- 是否需要保留 `upstream`。

推送后核对本地和远端 Commit 一致，并记录仓库、PR、Release 和 Actions 链接。
