# Weaver 本机配置示例

把以下非秘密结构合并到本机 `runtime.json`；应用真实配置前先预览并得到用户确认。真实地址、个人目录和钥匙串账号映射不提交到公开仓库。

```json
{
  "weaver": {
    "cliPackage": "/absolute/path/to/node_modules/weaver-e10-builder",
    "keychainService": "weaver-oa",
    "approvalTimeoutSeconds": 1800,
    "environments": {
      "test": {
        "baseUrl": "https://oa-test.example.com",
        "passportUrl": "https://oa-test.example.com",
        "credentialEntry": "test-account"
      },
      "prod": {
        "baseUrl": "https://oa.example.com",
        "passportUrl": "https://oa.example.com",
        "credentialEntry": "prod-account"
      }
    }
  }
}
```

`dev/pre` 自动映射至 `test`，`prod` 映射至 `prod`；会话键另加入完整 OA 地址摘要，避免同域名和端口冲突。账号密码与 Cookie 均保存在钥匙串，不放在此文件。

首次使用由用户在终端隐藏录入两套凭证。已保存凭证的替换需要显式 `--replace` 和本机再次确认。认证中心未单独部署时与 OA 地址一致；若实际存在独立认证中心，应在预览时填写其真实地址。
