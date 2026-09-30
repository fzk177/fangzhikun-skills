# 配置与实现

## 前提

- macOS、Python 3、Node.js 18 或以上。
- 已安装官方 `weaver-e10-builder`；首版按 1.1.9 的导出模块实现，也允许兼容的后续 1.x，但升级后需重新静态校验和实际只读核对。
- 官方 Skill `weaver-e10-builder` 已安装，动作流依赖按其声明按需读取。

`node scripts/weaver.js info` 只检查非秘密配置与 CLI 依赖，不读取钥匙串、不登录。

本机配置、钥匙串首次录入、Git 提交、推送和本机部署需要按 skill-manager 契约分别预览确认。首次账号密码只能由用户在本机隐藏输入；运行管理任务的 AI 不读取凭证。

## 模块

- [common.js](../scripts/common.js)：环境解析、CLI 定位、只读策略加载、状态路径与脱敏。
- 私有运行记录通过本模块保存的原始文件描述符函数写入，避免被官方业务文件护栏误拦；该内部写入路径不作为业务命令的豁免入口。
- [authentication.js](../scripts/authentication.js)：原生钥匙串、内存会话、官方 RSA 登录和身份校验。
- [guard.js](../scripts/guard.js)：只读白名单、实际请求冻结、逐请求审批、禁止其他网络与子进程绕过。
- [weaver.js](../scripts/weaver.js)：只读信息、认证、受控 CLI、查看审核单及逐项放行。
- [enroll.py](../scripts/enroll.py)：用户本机隐藏录入，凭证通过 stdin 交给钥匙串。

## 使用

```bash
node scripts/weaver.js info
python3 scripts/enroll.py --env pre
python3 scripts/enroll.py --env prod
node scripts/weaver.js auth --env pre
node scripts/weaver.js run --env pre -- workflow search --name 采购
```

变更命令须提供 `--purpose` 与 `--impact`，运行后按照实际 pending 请求逐条审核。未登录时不会要求复制 Cookie；缺少钥匙串凭证时提示先完成本机录入。

## 验证与交付

只通过仓库 `tools/skillctl validate weaver` 和 `validate --all` 执行结构、引用、JSON、脚本语法及公开安全检查。不得擅自新增或运行测试。正式启用之前仍需在用户授权后分别核对测试／生产的自动登录、读取权限和钥匙串弹窗情况；验证读取不得包含 OA 写操作。

此次新建不修改现有官方 Skill、CLI、官方全局 profile 或既有会话文件。变更仅涉及自研源码、必要登记和受控 Obsidian 文档同步。
