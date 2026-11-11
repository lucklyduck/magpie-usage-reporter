# Magpie 用量与订阅

基于 [page-usage-tree 0.1.0](https://github.com/magpie-community/plugins/tree/808f7a184d3a88db69691f4838deee46f64560b1/packages/page-usage-tree) 的 Magpie 插件，按账号或模型查看用量，选择通知内容并定时发送文字报告。

## 功能

- 供应商 → 账号 → 模型、供应商 → 模型 → 账号两种视图；不同供应商的同名模型分别统计。
- 今日、本周、本月、上周、上月、近 7/30 天及自选日期。
- 供应商、账号、模型、Agent、记录来源筛选，显示列、排序和缓存 Token 开关。
- 调用、失败、重试、取消、输入/输出、缓存、reasoning 子集、预估费用及未定价标记。
- 当前账号额度、余额、重置时间及原始读取时间；共享额度/余额标记，不重复累加。
- 内容区块、指标列及顺序、统计周期、文字布局、行数和数据范围均可通过选项配置。
- Telegram、OneBot 11 HTTP、SMTP、Webhook；每个订阅一个主渠道，可选一个备用渠道。
- 间隔、每日、每周、每月和五字段 cron；手动发送、消息拆分、确认记录、重试及恢复。
- 页面关闭后，调度继续随 Magpie 插件宿主运行；宿主停止期间不发送。
- 用量页提供“增强视图／原版用量树”标签；原版保留独立周期、搜索排序、缓存开关和展开状态。上游代码和测试完整保存在 vendor/page-usage-tree。

图片、附件、机器人入站命令、阈值预警和独立守护服务留给后续版本。

## 安装

要求 Magpie 0.1.3436 或更新版本，以及 Magpie 的 Bun 插件宿主。本次开发验证使用 Bun 1.4.4。

在 Magpie 的插件页添加本项目目录，或执行：

```powershell
magpie plugin add C:\Users\Elecat\Documents\Code\magpie-plugin\magpie-usage-reporter
```

启用后，在 Magpie 的插件页面打开“用量与订阅”。默认本地服务为 http://127.0.0.1:3495。插件支持 magpie web 的服务代理。

默认端口可以在该插件的 options 中设置为 port。不要占用网关的 3425 端口。页面只传递启动和显示选项，通知凭据通过后台保存。

插件不需要创建模型供应商或登录额外模型账号。安装和保存设置不会发出通知。

首次升级到带实例隔离的版本时，若提示旧服务缺少实例标识，请等待正在进行的调用结束后完整重启 Magpie 插件宿主。后续宿主重载会等待同一配置目录的旧服务退出并自动接管；不同配置目录使用同一端口会明确报错，应为其设置不同端口。独立开发预览也不会静默连接到正式实例。

## 使用

1. 打开“用量”，选择周期和归类，核对数据。筛选为空表示不限制该维度；“来源”至少选择一项。
2. 打开“通知渠道”，填写目标与凭据。点击“发送测试”验证；会明确显示测试目标。
3. 打开“订阅”，从预设创建，选择区块、指标、周期、布局、主渠道与备用渠道。
4. 使用“预览”检查内容和拆分数量，保存。新订阅默认停用。
5. 启用订阅开始定时发送；“立即发送”是独立操作。
6. 在“发送记录”查看结果；结果未知时先核对接收端，再决定重试或结束任务。

文字布局包含等宽表格、详细列表和简短摘要。每个区块单独选择周期。前 N 行的范围合计包含全部选中记录，并单列其余项目合计。

### 通知渠道

| 渠道           | 配置                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| Telegram       | Bot Token、chat ID，可选话题 ID；支持私聊或群组                        |
| OneBot 11 HTTP | 现有 OneBot 实现的 HTTP 地址、私聊/群聊目标，可选 access token         |
| SMTP           | 主机、端口、发件/收件地址；TLS 465 或 STARTTLS 587；登录用户名和授权码 |
| Webhook        | HTTP(S) POST 地址，可选 Bearer token                                   |

OneBot 返回 HTTP 200 不一定成功，插件还验证 status、retcode 和消息回执。OneBot 12 和 WebSocket 未实现。

Webhook 的请求体为：

```json
{
  "title": "报告标题",
  "text": "已排版的文字",
  "reportId": "稳定报告 ID",
  "part": 1,
  "totalParts": 1,
  "format": "text"
}
```

SMTP 发送纯文本。无认证明文中继仅允许本机回环地址。生产邮件使用校验证书的 TLS，不提供跳过验证的页面开关。

### 主备、重试和恢复

- 主渠道明确永久失败时使用备用；明确临时失败最多三次，分别延迟至少 5 秒和 30 秒，平台 Retry-After 较长时遵循平台要求。
- 主渠道完整成功后结束，不发送备用。
- 已有部分消息确认时，剩余部分继续使用同一渠道。
- 请求发出后未取得确认时记录“结果未知”，不自动切换备用。
- 手动重试复用已生成报告和消息进度，可能再次发送未确认部分。
- 宿主恢复后默认补最近一次错过的执行，也可选择跳过。
- 暂停订阅取消排队任务；进行中的网络请求结束后停止尚未发出的剩余部分。
- 每月指定日超过当月天数时使用当月最后一天。不存在的夏令时时刻跳过。
- 系统时钟、电脑休眠和宿主重启会影响实际发送时间；页面显示后台状态和最后检查时间。

### 统计口径

数据来自 Magpie 的 matched request ledger，已包含其会话匹配及计价。插件分页读取明细，按记录时间筛选并去重，不使用带筛选豁免的 by.modelAt 直接充当选中范围。

- 中间转交尝试可贡献 Token 与费用，不额外算最终调用。
- reasoning 是输出拆分，1 小时缓存写入是缓存写入子集，不重复加总。
- 费用为 Magpie 价格估算，不等于订阅支出或供应商账单。未知价格显示未定价。
- 当前额度/余额标注读取时间，不能解释成历史周/月结束时的额度。
- 额度接口失败单独显示；历史用量不完整时停止报告生成并重试。
- 网关本身能看见的记录构成统计范围，不能覆盖供应商在所有设备上的活动。
- 单次查询上限 100 万条，超过时提示缩小周期。

默认读取 Magpie 给出的 MAGPIE_ADDR；也支持设置中的网关地址。远程网关需要适当权限的密钥，可通过 MAGPIE_API_KEY / MAGPIE_GATEWAY_KEY 提供。403 不会显示成零用量。

## 开发与验证

```powershell
bun install
bun run typecheck
bun run test
bun run test:ui
bun run test:live
bun run pack
```

test:ui 使用独立临时配置的无界面 Edge 和本机模拟发送端；可通过 BROWSER_CHANNEL 指定 chrome 等已安装浏览器。它不读取真实通知凭据。SMTP 集成测试使用公开的回环测试证书，测试私钥只属于测试夹具。

本机验收详情见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。安装包可通过隔离生产安装测试验证；scripts/check-host.mjs 用于已有宿主的显式回环定时验收，会临时创建并清理测试订阅和渠道。

开发预览：

```powershell
bun serve.mjs --port 3495 --state-dir .state
```

该入口用于开发，生产运行属于 Magpie 宿主。可加 --no-scheduler 仅调试页面/API。--gateway 指定开发网关地址。

自动测试覆盖周期、分页、去重、归类、未定价、HTTP 鉴权、配置冲突、主备、未知/部分发送、租约及重启恢复。test:live 只读本机 Magpie，用聚合数字核对两种归类，不输出账号身份。真实 TG/QQ/邮件账号的最终接收需要用户配置测试目标验证。

## 状态和凭据

- 默认持久状态：Magpie 配置目录下 usage-subscriptions/state.sqlite，启用 WAL。
- 独立凭据文件：usage-subscriptions/credentials，以渠道 ID 的散列命名；API 不返回明文。
- 文件使用 0600、目录 0700；Windows 使用用户配置目录的 ACL。凭据文件不是额外加密的保险库，应按个人 Magpie 配置一同保护和备份。
- MAGPIE_USAGE_STATE_DIR 可覆盖插件状态目录。开发入口默认使用工作区 .state。
- 卸载或停用不删除订阅与历史状态；重新启用继续读取同一目录。
- 更换设备时，配置、SQLite 的一致性备份及凭据需要一起迁移；运行中的 WAL 数据库不能仅复制主文件。

## 扩展方式

公共接口位于 types/contracts.d.ts。代码分为 lib/domain、lib/adapters、lib/render、lib/channels、应用服务和启动层。

- 新渠道：实现 NotificationAdapter，声明字段、凭据字段、能力和发送结果，加入渠道注册表。
- 新指标：注册 ID、名称、类型和 value 计算函数；页面选项与报表自动可用。
- 新设置：在 SETTING_DEFINITIONS 增加字段定义与 schema，页面自动生成表单。
- 新归类：实现 GroupingStrategy 并注册。
- 图片/附件：新增 ReportRenderer 并声明渠道能力，复用统一 Report、队列和路由。
- 测试注入 UsageSource、QuotaSource、Clock、Repository、CredentialStore 和通知适配器，无需真实服务。

本地 API 使用 /api/v1 前缀，保留随机访问 token、Host/Origin 校验和回环监听。配置 schemaVersion 为 1，更新包含 revision；冲突返回 409。详细接口见 docs/API.md。

## 来源与许可证

MIT。上游固定版本、原许可证和第三方依赖说明见 THIRD_PARTY_NOTICES.md。vendor 目录保留上游源码；本项目不代表 Magpie 官方。
