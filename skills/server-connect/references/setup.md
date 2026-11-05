# SSH 别名与认证配置

只在别名缺失、认证失败、连接超时或用户明确要求配置连接时使用本参考。

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
ssh -o BatchMode=yes -o ConnectTimeout=8 <本机已登记别名> 'echo ready'
```

## 新增连接

用户明确要求配置时，先检查已有 Host 块，避免覆盖或创建冲突别名。真实配置只写入本机 `~/.ssh/config`，修改前备份，格式示例：

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

## Tailscale 组网主机

`HostName` 为 Tailscale 地址（CGNAT 网段 `100.64/10`）时：

- 本机 CLI：macOS 独立版位于 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`。
- 先看 `tailscale status` 中对端是否在线，再用 `tailscale ping <地址>` 判断路径：`via <局域网或公网地址>` 为直连，`via DERP(<地区>)` 为中转，延迟高属预期现象。
- 对端离线或 `no matching peer`：对端未开机、组网服务未运行、未开启无人值守，或节点密钥过期；只报告，不在本机改组网设置。
- 本机开启 Tailscale 后其他代理失效时，常见原因是 Tailscale 接管了全部 DNS；`tailscale set --accept-dns=false` 属于本机配置变更，需用户同意。关闭后 MagicDNS 名称不可解析，SSH 配置应写 Tailscale 地址。
- Tailscale SSH 不支持 Windows 作为服务端，Windows 必须使用系统 OpenSSH Server。

## Windows OpenSSH 初始化

以下步骤由用户在 Windows 本机的管理员 PowerShell（提示符以 `PS` 开头、标题含“管理员”）完成，或在已有可用远程通道且获得授权后执行：

1. 安装 OpenSSH Server（“设置 → 系统 → 可选功能”或 `Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Add-WindowsCapability -Online`），然后 `Set-Service sshd -StartupType Automatic; Start-Service sshd`。`C:\ProgramData\ssh` 在 sshd 首次启动后才生成。
2. 默认 shell 设为 PowerShell：`HKLM:\SOFTWARE\OpenSSH` 的 `DefaultShell` 指向 `powershell.exe`。
3. 管理员账户的公钥必须写入 `C:\ProgramData\ssh\administrators_authorized_keys`，用户目录下的 `authorized_keys` 对管理员无效；权限只保留 Administrators 与 SYSTEM：`icacls <文件> /inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F"`（使用 SID，兼容中文系统）。
4. 防火墙规则 `OpenSSH-Server-In-TCP` 启用，`Profile Any`；经组网访问时将来源限制为组网网段。
5. 组网客户端开启无人值守，保证未登录时在线。
6. 本机 `BatchMode` 验证成功后，再关闭 `PasswordAuthentication` 与 `KbdInteractiveAuthentication`，并按 [windows.md](windows.md) 的“防止失联”验证。

## 常见失败

- `Could not resolve hostname`：SSH 别名不存在或配置未生效；Tailscale 主机还可能是本机关闭了组网 DNS。
- `Permission denied (publickey)`：密钥路径、文件权限或服务器公钥授权不匹配；Windows 管理员账户检查 `administrators_authorized_keys` 的位置与权限。
- `Connection timed out`：检查本机网络、VPN、组网状态、安全组、远端 SSH 服务或防火墙，不扫描其他端口。
- `Host key verification failed`：先让用户确认服务器是否更换或重建，未经确认不删除 `known_hosts`。
- `REMOTE HOST IDENTIFICATION HAS CHANGED`：视为高风险异常，停止连接并核验新指纹。
- Windows 上整段命令每行都报错：多为粘贴进了 cmd 而非 PowerShell，或未以管理员运行。
