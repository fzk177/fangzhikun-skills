# Windows 服务器操作

适用于注册表平台为 `windows` 的服务器：通过 Windows 自带 OpenSSH Server 连接，默认 shell 为 Windows PowerShell 5.1，可能经 Tailscale 等组网工具访问，可能包含 WSL 发行版。连接或认证问题见 [setup.md](setup.md)。

## 执行方式

- 单条命令使用外层单引号，避免本机 shell 展开 `$`：

  ```bash
  ssh <ssh别名> '<PowerShell 命令>'
  ```

- 输出含中文时，在命令开头加 `[Console]::OutputEncoding=[Text.Encoding]::UTF8;`；调用 `wsl.exe` 前再加 `$env:WSL_UTF8=1;`，否则输出为乱码或 UTF-16 空字符。
- 多行逻辑、PowerShell 内再嵌套 Bash、或含多层引号时，不内联拼接：
  1. 在本机 `mktemp -d` 目录中写好 `.ps1` 或 `.sh` 脚本。
  2. 查询远端临时目录：`ssh <ssh别名> '$env:TEMP'`，在其下创建 `server-connect-<时间戳>` 子目录。
  3. 用 `scp` 上传，PowerShell 脚本以 `powershell -NoProfile -ExecutionPolicy Bypass -File <路径>` 执行；Bash 脚本以 `wsl -d <发行版> -u <用户> -- bash /mnt/c/<对应路径>` 执行。
  4. 执行完成后删除该临时子目录；脚本内容只包含本次已授权的动作。
- 管理员账户的 OpenSSH 会话默认已提权，不弹 UAC；只读诊断同样不得借此执行写操作。
- SSH 会话结束时，会话内启动的子进程通常一并结束；长任务在本机后台保持连接（`-o ServerAliveInterval=15`），不依赖 `Start-Process` 脱离会话。
- 部分工具在非交互 SSH 会话中不可用：系统自带的 `wsl.exe` 引导程序（未安装 WSL 时）只提示安装、不执行 `--install`；Microsoft Store 安装可能失败。改用 `dism.exe /online /enable-feature ... /norestart` 和 `winget install --id <包> -e --silent --accept-source-agreements --accept-package-agreements --disable-interactivity`。

## 只读诊断

```powershell
# 系统、开机时间、时钟（与本机比较偏差）
Get-CimInstance Win32_OperatingSystem | Select Caption,Version,LastBootUpTime
Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
# 服务
Get-Service <服务名> | Select Name,Status,StartType
# 进程与资源
Get-Process | Sort CPU -Descending | Select -First 15 Name,Id,CPU,WS
Get-PSDrive -PSProvider FileSystem
# 端口
Get-NetTCPConnection -State Listen | Where LocalPort -eq <端口>
# 系统日志（错误/警告，最近 30 分钟）
Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2,3; StartTime=(Get-Date).AddMinutes(-30)} -MaxEvents 50
# 开关机记录
Get-WinEvent -FilterHashtable @{LogName='System'; Id=1074,6005,6006,6008} -MaxEvents 10
# 防火墙规则与来源限制
Get-NetFirewallRule -Name <规则名> | Get-NetFirewallAddressFilter
# 计划任务、已登录用户、待重启标记
Get-ScheduledTask | Where State -ne Disabled
quser
Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
```

组网与 WSL：

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' status
& 'C:\Program Files\Tailscale\tailscale.exe' netcheck
& 'C:\Program Files\Tailscale\tailscale.exe' debug prefs   # 关注 ForceDaemon、CorpDNS、RouteAll
$env:WSL_UTF8=1; wsl -l -v; wsl --version
wsl -d <发行版> -u root -- systemctl --failed
```

## 需要明确授权的动作

- `Restart-Computer`、`Stop-Computer`、`shutdown.exe`。
- `Start/Stop/Restart-Service`、`Set-Service`，`Stop-Process`。
- `winget`、MSI、`dism` 启用或禁用功能，`Add/Remove-WindowsCapability`。
- 注册表、`sshd_config`、`administrators_authorized_keys`、防火墙规则、`powercfg`、计划任务、本地用户与组。
- 组网客户端设置（如 `tailscale set`、`tailscale up/down`）。
- WSL：`wsl --shutdown`、`--terminate` 会中断其中所有任务；修改 `/etc/wsl.conf`、`%USERPROFILE%\.wslconfig`；`wsl --unregister` 会删除整个发行版数据，除非用户逐字点名该发行版和删除动作，否则不执行。
- WSL 内的软件安装、服务启停和文件修改，同 Linux 规则。

## 防止失联

通过远程链路修改 SSH、组网、防火墙或网络设置时：

1. 先把将修改的文件复制为 `<文件>.bak-<日期>`，或记录旧值。
2. 修改后不关闭当前会话，另起 `ssh -o BatchMode=yes -o ConnectTimeout=15 <ssh别名> 'echo ready'` 验证；失败时用当前会话恢复备份。
3. 禁止经由同一链路执行 `tailscale down`、停止组网服务、启用拒绝入站（shields-up）、切换出口节点，或停用当前所用网卡。
4. 关闭密码登录时同时关闭 `PasswordAuthentication` 和 `KbdInteractiveAuthentication`，并验证 `-o PubkeyAuthentication=no` 的连接被拒、密钥连接仍成功。

## 重启前检查

用户授权重启后，先逐项确认，任一不满足时停在重启前说明：

- `sshd` 与组网服务为 `Running` 且 `StartType` 为 `Automatic`。
- 组网客户端在用户未登录时也会上线：Tailscale 的 `ForceDaemon` 为 `true`（托盘中的 Run unattended）；节点密钥未临近过期。
- SSH 防火墙规则已启用，`Profile` 覆盖当前网络类型。
- BitLocker 没有开机 PIN 等需要人工输入的保护器。
- 有待重启更新时提示用户，开机可能因安装更新而延长。
- 组网流量若依赖只在用户登录后才启动的代理（如 TUN 模式代理客户端），确认不经该代理也能上线：例如同一出口网络的其他节点可直连组网服务。
- 列出 WSL 中仍在运行的任务（如 tmux 会话），告知用户会被中断。
- 先把需要联网下载的安装包准备好，避免重启后无代理可用。

执行与验证：

```bash
ssh <ssh别名> 'shutdown.exe /r /t 5 /c "<原因>"'
# 本机后台循环等待：每 10 秒尝试 BatchMode 连接，最长 15 分钟
```

恢复后核对 `LastBootUpTime`、1074/6005 事件、`sshd` 与组网服务状态。远端时钟有偏差时以事件顺序和运行时长判断，不只看绝对时间。

## WSL

- 执行命令：`wsl -d <发行版> -u <用户> -- bash -lc '<命令>'`；需要 root 时用 `-u root`，不向用户索要 sudo 密码。
- 离线安装发行版：从 `https://raw.githubusercontent.com/microsoft/WSL/master/distributions/DistributionInfo.json` 取得 `.wsl` 镜像地址和 SHA256，下载并校验后执行 `wsl --install --from-file <文件> --name <名称> --no-launch`。
- 常驻：`%USERPROFILE%\.wslconfig` 中 `[wsl2] vmIdleTimeout=-1`、`[general] instanceIdleTimeout=-1`；`/etc/wsl.conf` 中 `[boot] systemd=true`。修改后需 `wsl --shutdown` 生效。

## 常见问题

- `printf`、`grep` 等报“无法识别”：远端是 PowerShell，改用对应 cmdlet。
- 中文输出乱码：见“执行方式”中的编码设置。
- 远端时钟偏差：`w32tm /resync /force` 属于变更，需授权。
- 组网走中转、延迟高：远端组网流量可能被代理客户端的 TUN 模式转发到境外，无法打洞直连；需在代理规则中让组网客户端直连。
- 本机开启组网客户端后代理失效：组网客户端接管了全部 DNS，本机执行 `tailscale set --accept-dns=false`（本机配置变更，需用户同意）。
