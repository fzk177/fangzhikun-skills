# SSH 别名与认证配置

只在别名缺失、认证失败或用户明确要求配置连接时使用本参考。

## 检查现状

只查看 Host 声明，避免输出无关 SSH 配置：

```bash
rg -n '^[[:space:]]*Host[[:space:]]+' "$HOME/.ssh/config"
```

检查展开后的目标信息时，不输出代理命令中的秘密或环境变量：

```bash
ssh -G <本机已登记别名> | rg '^(hostname|user|identityfile|identitiesonly) '
```

验证连接：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 <本机已登记别名> 'printf ready'
```

## 新增连接

用户明确要求配置时，先检查已有 Host 块，避免覆盖或创建冲突别名。真实配置只写入本机 `~/.ssh/config`，格式示例：

```sshconfig
Host example-dev
  HostName <真实主机>
  User <远端账号>
  IdentityFile <本机私钥路径>
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
```

不要把真实内容复制回 Skill 源码。密钥不存在或服务器未授权公钥时，由用户在自己的终端创建专用密钥并联系管理员添加公钥。密码登录、`ssh-copy-id` 和修改 `authorized_keys` 不由本 Skill 自动执行。

## 常见失败

- `Could not resolve hostname`：SSH 别名不存在或配置未生效。
- `Permission denied (publickey)`：密钥路径、文件权限或服务器公钥授权不匹配。
- `Connection timed out`：检查本机网络、VPN、安全组或服务器状态，不扫描其他端口。
- `Host key verification failed`：先让用户确认服务器是否更换或重建，未经确认不删除 `known_hosts`。
- `REMOTE HOST IDENTIFICATION HAS CHANGED`：视为高风险异常，停止连接并核验新指纹。
