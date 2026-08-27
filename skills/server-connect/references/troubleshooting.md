# 远程服务故障排查

## 通用顺序

将 `<service>` 替换为用户指定且已确认的服务名。默认只执行以下只读检查：

```bash
systemctl status <service> --no-pager -l
systemctl show <service> -p ActiveState -p SubState -p Result -p ExecMainCode -p ExecMainStatus
journalctl -u <service> --since '-30 minutes' --no-pager -n 300
systemctl cat <service>
ps -ef
ss -lntp
df -h
df -i
```

不要直接回显完整进程环境变量。结果较多时，应在远端使用明确的服务名、端口或时间范围收窄，而不是无边界导出。

重点判断：

- `Result`、主进程退出码与首次异常是否一致。
- 监听端口是否被其他进程占用，服务实际监听地址是否符合预期。
- 磁盘空间和 inode 是否耗尽。
- 配置、证书、日志目录和运行用户权限是否匹配。
- 依赖的 DNS、上游服务或挂载是否可用。
- 服务是否进入启动频率限制，例如 `start request repeated too quickly`；继续查最早一次启动失败，不把频率限制当作根因。

## Nginx 无法启动

建议按以下顺序执行：

```bash
systemctl status nginx --no-pager -l
systemctl show nginx -p ActiveState -p SubState -p Result -p ExecMainCode -p ExecMainStatus
journalctl -u nginx --since '-30 minutes' --no-pager -n 300
nginx -t
ss -lntp
ps -ef | rg '[n]ginx'
df -h
df -i
```

根据报错再定向检查：

- 配置语法或引用文件：使用 `nginx -T` 展开有效配置，但输出前过滤证书私钥、密码、Token 和鉴权头。
- 端口冲突：对具体端口执行 `ss -lntp 'sport = :<port>'`，确认占用进程归属。
- 文件不存在或权限错误：使用 `namei -l <明确路径>`、`stat <明确路径>` 查看每级目录和目标文件权限。
- 证书问题：只查看证书元信息，如 `openssl x509 -in <证书路径> -noout -subject -issuer -dates`；禁止读取私钥内容。
- 上游解析失败：从 Nginx 配置中确认实际域名后，再执行有限的 `getent hosts <域名>`。
- SELinux 拒绝：先查看状态和与故障时间对应的审计记录，不自动关闭 SELinux 或修改策略。

`nginx -t` 和 `nginx -T` 属于配置验证，不启动或 reload 服务；仍应在执行前确认命令指向系统中实际使用的 Nginx 二进制。

## 需要明确授权的动作

以下动作不属于默认诊断范围：

- `systemctl start|stop|restart|reload|reset-failed`。
- 编辑、替换或删除配置、证书、日志、PID 文件和 systemd unit。
- `kill`、`pkill`、清理端口占用进程。
- `chmod`、`chown`、调整 SELinux、防火墙或安全组。
- 安装、升级、降级软件包。
- 清理磁盘、日志或缓存。

用户授权后也要先保存可恢复副本，明确只修改的文件或服务，并在变更后执行配置检查、状态检查和最小业务验证。

