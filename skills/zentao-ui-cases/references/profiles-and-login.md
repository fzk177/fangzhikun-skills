# 项目、环境与账号选择

用于首次准备输入、切换项目/环境/账号或恢复业务系统登录。禅道认证仍走 `zentao-base`；本流程只管理业务系统浏览器会话。

## 选择优先，不重复录入

1. 执行 `python3 <skill>/scripts/profiles.py list`。配置默认位于 `~/.config/zentao-ui-cases/profiles.json`；可用 `ZENTAO_UI_CASES_PROFILES` 指向独立本机配置。不存在时返回空列表，不创建文件。
2. 用户本轮明确指定的项目、地址、路径和账号优先于保存值；有差异时展示差异并只补缺项，不用历史配置覆盖用户输入，也不静默更新已存配置。完整匹配已有配置时可直接解析。
3. 未明确指定时把配置作为可选项展示，标签包含项目、环境、账号和角色/租户是否已确认；账号/角色未知须写“待确认”。使用可用的选项提问工具（如 `request_user_input_async`），一次选择一组“项目 / 环境 / 账号”。候选过多时先选项目，再选环境和账号，不把多个账号揉成同一选项。工具不可用时使用编号列表，接受编号或名称。仅有一项也供用户选择，不能据此默认授权在线访问。
4. 提供“新增或修改配置”和“仅生成，不连接环境”的入口；工具有自由输入时说明可直接输入这些意图。仅生成模式仍需选择/明确源码仓库和业务项目，但不要求地址、账号或登录。不为生成代码发起登录，不为切换配置要求用户重输已保存字段。
5. 无配置时执行 `python3 <skill>/scripts/profiles.py discover --repo <Playwright仓库>`。只读已指定仓库的 `projects/*/specs/stories/*.sources.json`，给出历史源码路径、环境和登录态文件路径作为候选；不读 `.env`、不扫描浏览器用户目录或其他项目凭据，不按标题猜项目。退出码 2 表示部分发现失败；保留有效候选并说明缺口。历史候选、文件时间及文件存在均不证明当前登录有效。
6. 选中后 `python3 <skill>/scripts/profiles.py resolve --id <配置ID>`，核验路径及业务项目存在，再记录当前 Git 分支、提交和脏状态。保存的是源码位置，不固定上次分支或提交，也不切分支。本轮未指定版本时说明使用已选仓库当前分支；用户给出目标版本时核验是否一致。

新项目仅填写一次缺失字段并保存；未来调用复用。保存配置属于本 skill 的本机设置能力，不修改其他工具的 runtime 配置。用户选择历史候选并要求记住时，保存所选组合；不把历史执行授权保存为永久授权。

## 非秘密配置契约

用 `profiles.py save` 从 stdin 接收一条 JSON 配置；修改同 ID 明确加 `--replace`。输出只包含配置 ID 和配置文件路径。示例：

```json
{
  "id": "example-dev-user",
  "label": "示例项目 / 开发 / example-user（角色、租户待确认）",
  "project": "vesselhub",
  "frontend_repo": "/absolute/path/to/frontend",
  "playwright_repo": "/absolute/path/to/playwright-cases",
  "environment": "dev",
  "base_url": "https://dev.example.test/app",
  "account": "example-user",
  "role": null,
  "tenant": null,
  "storage_state": "/absolute/path/to/playwright-cases/playwright/.auth/vesselhub/dev-example-user.json",
  "storage_state_env": "VESSELHUB_STORAGE_STATE"
}
```

示例中的路径和域名须替换为用户实际选择，不是通用默认环境或已生效选择。本机候选只进入本机配置，避免让迁移后的 skill 依赖旧机器路径。`account` 是账号标识，禁止填写密码；未知角色/租户不猜测。`base_url` 可含部署子路径，不含用户密码、query 或 fragment。`storage_state_env` 仅在读过项目 fixture 后填写真实变量名；没有适配时按项目既有方式传递，不能假定设置一个环境变量就能让 pytest 加载登录态。

`base_url`、账号、角色、租户、登录态位置和环境变量名可省略或为 null，支持只有源码的配置。每组项目/环境/账号使用独立配置 ID 和登录态路径；同域名不同账号或租户也不得混用。`save` 拒绝未知字段，不保存密码、Token、Cookie 内容、任意执行命令或执行授权。配置和新登录态写文件权限为 0600。

## 登录态复用与失效恢复

- 默认只检查文件是否存在，标为 `present_unverified`，不输出或复制内容。静态生成阶段不验证在线认证。环境和执行/只读探测范围已获授权后，用新浏览器上下文加载所选登录态，访问获准的只读受保护页面，核验实际账号、角色、租户及所需权限。不能用 Token 存在、文件较新、未跳转登录页或普通页面打开成功代替认证成功。
- 有效时直接复用，不要求用户重新登录。pytest 执行把 `resolve` 返回的 `pytest_options` 和 `environment_variables` 作为参数/环境字典传递；它们不含密码。它们是数据，禁止拼接成未经转义的 shell 命令。现有 fixture 已支持时不改测试代码；保留每用例独立 context。
- 需要工具辅助时，使用自动化仓库自己的 Python 运行 `login_session.py`，依赖既有 Playwright 和 Chromium，不静默安装。在线探测命令为 `.../python <skill>/scripts/login_session.py check --id <ID> --path /index --success-selector <已核实的受保护页面定位器>`。`--path` 相对于配置的部署子路径，首页路由不是部署子路径。定位器须从真实页面/源码核验，不从示例猜测。探测通过只证明保护页面标记可见，角色与租户仍需核验。
- 文件缺失、损坏或明确出现登录失效时才进入恢复；网络失败、定位超时、403、缺权限分别处理，不自动归为登录过期，不循环登录。无法确定时报告缺口，继续不依赖登录的工作。不要因过期改用另一个账号、环境或租户。
- 恢复用 `.../python <skill>/scripts/login_session.py login --id <ID> --path /index` 打开独立有界面浏览器，用户在浏览器内登录，不在对话/参数中提供密码。勿勾选记住密码。该脚本不用个人浏览器资料、不录制登录截图或 Trace。用户明确确认已完成并核对账号/角色/租户后，终端输入 `SAVE` 才保存；通过代理运行时使用 PTY，收到用户确认再向其 stdin 写入 `SAVE\n`。不得自行替用户确认。其他输入、EOF 或关闭浏览器取消，不覆盖原状态。
- 新配置没有指定登录态位置时，保存到 `~/.local/share/zentao-ui-cases/auth/<ID>.json`，目录 0700、文件 0600；已有配置继续用自己的指定位置。若位置在仓库内，先只读核验 `git check-ignore` 生效且未被跟踪，否则改用仓库外的专用位置，不把凭据保存进仓库。不要与其他账号/环境配置共享登录态路径。
- helper 支持 Cookie、localStorage、IndexedDB；保存时移除键名含 `password`/`loginform` 的记住密码条目。不承诺完整捕获 sessionStorage、浏览器绑定 SSO 或设备绑定认证；遇到此类项目按已验证的项目认证方案处理。缓存内容可能还需项目级脱敏，不能把登录态当作可分享产物。
- 登录恢复完成后，在新上下文做一次受保护页面与身份核验再执行原范围；不因恢复登录扩大测试授权。只有选择配置/登录维护授权时，不顺手执行测试。

禅道查询复用 `zentao-base` 当前 Profile 和钥匙串恢复机制；认证错误只重试其规定的一次，不另建禅道密码存储。明确区分“禅道认证失败”与“业务系统会话失效”。
