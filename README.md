# fangzhikun-skills

用于版本化维护、校验和部署个人 Codex Skills 的公开源码仓库。

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
./tools/skillctl status
./tools/skillctl validate --all
./tools/skillctl doctor
./tools/skillctl deploy zentao-debug
./tools/skillctl deploy --all
./tools/skillctl rollback zentao-debug
```

安装目录出现未被部署记录覆盖的人工修改时，部署会停止。先执行：

```bash
./tools/skillctl status zentao-debug
./tools/skillctl import-local zentao-debug --destination <安全目录>
```

确认差异已经进入源码后再重新部署。

## 发布流程

1. 修改源码并检查差异。
2. 更新 `registry/skills.json` 中对应版本和根目录 `CHANGELOG.md`。
3. 执行 `./tools/skillctl validate --all`。
4. 使用中文提交说明提交 Git。
5. 推送 GitHub 后，显式执行部署；Git 分支切换不会直接改变运行中的 Skill。

## 权利说明

仓库中的自主维护内容保留所有权利。
