# GitHub Release 与 Obsidian Community 发布

## 目录

1. 发布前检查
2. GitHub 认证
3. GitHub Release
4. Obsidian Community 首次提交
5. 审核反馈与后续版本

## 1. 发布前检查

执行市场发布前始终重新读取官方页面，避免沿用过期流程：

- <https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin>
- <https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines>
- <https://docs.obsidian.md/Developer+policies>

截至 2026-08-21，新插件通过 `community.obsidian.md` 网页提交，不再通过 `obsidianmd/obsidian-releases` Pull Request。

仓库根目录必须包含：

- `README.md`
- `LICENSE`
- `manifest.json`
- `main.js`
- 可选 `styles.css`
- 使用兼容版本时提供 `versions.json`

Manifest 要求：

- `id` 在市场中唯一且不能包含 `obsidian`。
- 初始版本和后续版本使用严格 `x.y.z` 格式。
- `version` 与 GitHub Release Tag 完全一致，不加 `v`。
- 描述适合市场检索，不包含敏感或内部信息。

## 2. GitHub 认证

优先使用 GitHub CLI：

```bash
gh auth status
gh auth login --hostname github.com --git-protocol https --web --clipboard
gh auth setup-git
```

需要提交包含 `.github/workflows/` 的仓库时，OAuth Token 必须具有 `workflow` 权限：

```bash
gh auth refresh --hostname github.com --scopes workflow --clipboard
```

网页登录和设备码确认由用户本人完成。不要读取或要求用户在对话中提供密码或 Token。

## 3. GitHub Release

1. 更新 `manifest.json`、`package.json`、`versions.json` 和 Changelog。
2. 使用中文提交信息提交并推送 `main`。
3. 创建与 Manifest 版本同名 Release，并上传安装资产：

   ```bash
   gh release create 1.2.3 \
     --target main \
     --title '1.2.3' \
     --notes '<发布说明>' \
     main.js manifest.json styles.css
   ```

4. 核对 Release 非 Draft、非 Prerelease，三个资产上传成功。
5. 使用实际下载链接确认 HTTP 200。
6. 核对远端 `main` 的 Manifest 与 Release 版本一致。

不要在当前版本已存在 Release 时覆盖同一 Tag。修改发布内容时递增版本。

## 4. Obsidian Community 首次提交

首次提交需要用户本人：

1. 登录 <https://community.obsidian.md>。
2. 在个人资料中关联拥有目标仓库的 GitHub 账号。
3. 选择添加 Plugin。
4. 填写 `owner/repository`。
5. 提交自动审核。

确认页面显示：

- Entry 已创建。
- 当前 Release 和版本正确。
- 审核状态为 Pending、Passed 或包含明确反馈。

自动审核 Pending 时不要重复提交。只有在反馈要求修改时才准备新版本。

## 5. 审核反馈与后续版本

- 把审核反馈逐条映射到源码、Manifest、README、Release 或开发者政策。
- 修复后递增版本，重新构建、提交、推送并创建新 Release。
- Community 会读取默认分支 HEAD 和新 Release，通常不需要重新创建插件条目。
- 上架结果由 Obsidian 官方决定，不能对用户承诺必然通过。
- 市场审核中的稳定版本与大型功能分支分离；大型整合先用功能分支和 Draft PR，验证后再合并并发布下一版本。
