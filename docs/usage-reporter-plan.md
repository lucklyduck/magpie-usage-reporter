> 实现状态：项目已按最终确认的单主渠道/可选备用、文字通知方案实现。当前功能与安装说明见 ../README.md；本文保留早期规划记录。

# Magpie 用量报表与通知插件：调研和开发方案

调研日期：2026-11-09。对象为 [yetone/magpie](https://github.com/yetone/magpie)，即 usemagpie.ai 的麻雀。

当前已选择基于 page-usage-tree 修改，用户在插件页面配置订阅、机器人负责推送。具体文件改动、区块配置和页面 API 以补充方案 [page-usage-tree-subscriptions.md](page-usage-tree-subscriptions.md) 为准。

本文是开发方案，尚未实现、安装或连接通知账号。接口结论来自上游源码；未对用户安装的 Magpie 版本做运行验证。

## 1. 现有插件与适合借鉴的代码

| 项目 | 已有能力 | 与目标的关系 |
| --- | --- | --- |
| [@magpie-community/hooks-mail-watch](https://github.com/magpie-community/plugins/tree/main/packages/mail-watch) | 供应商错误、额度预警、SMTP 邮件；可设置 report.hours 发送定期摘要；支持文本和 HTML 模板 | 最接近定时通知。当前摘要包含调用、输入/输出 token、积分以及模型等维度的调用分布；没有完整的逐模型 token 和费用报表，也没有自然周/月配置 |
| [@magpie-community/page-usage-tree](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-tree) | 供应商 → 账号 → 模型，用量、错误、缓存、费用；读取 Magpie 本地用量 API；Bun 宿主中的本地服务与页面 | 最适合参考数据接入、账号维度和页面/后台分工 |
| [@magpie-community/page-usage](https://github.com/magpie-community/plugins/tree/main/packages/usage) | 今日、7 天、30 天的调用、错误、token、费用和模型排行 | 最小页面示例。桥接权限 usage:summary 只给前 20 个模型，无账号明细 |
| [@magpie-community/gateway-notify](https://github.com/magpie-community/plugins/tree/main/packages/notify) | 一轮 agent 任务完成或失败时，发 Telegram、ntfy、Bark、Gotify、Server酱、飞书、钉钉、企微、Webhook | 可以借鉴 channels.mjs 的通道适配；触发条件是任务结束，尚不能直接当定时报表使用 |
| [Dreaminko/magpie-wakatime](https://github.com/Dreaminko/magpie-wakatime) | 读取本地用量 API，同步 WakaTime；SQLite 队列、租约、增量扫描、重试、停机补读 | 适合参考可靠后台同步。它默认只同步启用后的 through 记录，其范围不应直接照搬为总用量 |

在所查社区 registry、README 和公开仓库中，未找到一个已经同时完成自然日/周/月逐模型统计、费用估算、可配置定时发送以及 Telegram/OneBot/SMTP 全部通道的插件。上述项目已有部分能力，尤其值得先试用 mail-watch。

可安装体验：

~~~sh
magpie plugin add @magpie-community/page-usage-tree
magpie plugin add @magpie-community/hooks-mail-watch
magpie plugin add @magpie-community/gateway-notify
~~~

按需要选择安装；邮件和推送需要另行填写自己的通道配置。本文没有执行这些命令。

## 2. 数据以 Magpie 的用量 API 为准

默认网关地址通常为 http://127.0.0.1:3425。插件后台应优先读取宿主给出的 MAGPIE_ADDR，并允许显式 gatewayUrl，避免把端口固定在 3425。

当前已核实的接口：

~~~text
GET /v1/magpie/usage?period=today
GET /v1/magpie/usage?period=7d
GET /v1/magpie/usage?period=30d
GET /v1/magpie/usage?period=2026-11-01..2026-11-09
GET /v1/magpie/usage/requests?period=today&offset=0&limit=500
GET /v1/magpie/quotas?kept=1
~~~

- usage：汇总及模型、agent、账号等分组。当前网关接口会返回全部 sessions，历史很大时应考虑响应体积。
- usage/requests：分页明细、筛选和分组统计；limit 最大 500。支持 period、day、agent、provider、model、account、callerKey、purpose、failed、retried、q、via、computer 等筛选。完整扫描时必须分页。
- quotas?kept=1：读取最近保存的额度、余额及重置时间，不为每份报表重新访问供应商。
- 统计接口不会提供请求/回复正文。远程访问需要符合网关的共享和密钥权限；受模型、账号或预算限制的 key 无法读取全局汇总，只能读取自己的请求。实现时将 401/403 显示为取数失败，不能伪装成 0 用量。

汇总字段包括 calls、errors、retried、canceled、input、output、cache_read、cache_write、cache_write_1h、reasoning、cost、unpriced。cost 是已知价格部分的美元估值，unpriced 是有 token 但无已知价格的调用数。

优先复用 API 返回的费用和统计口径。不要同时累加 summary 与 requests，也不要再把 ccusage 扫出的同一批会话用量加进 Magpie 的汇总。

### 自然周期与近 N 天

这是实现中必须明确的一点：源码中的 Week 常量值为 7d，Month 常量值为 30d；它们不是自然周和自然月。usageapi.PeriodOf 对未知值默认回落到 30d，所以不要直接把 week 或 month 作为查询参数。reference.md 有文字示例与这里不一致，实施应以版本对应的源码和实际响应为准。

当前源码支持 YYYY-MM-DD..YYYY-MM-DD，首尾两天均包含，按网关所在机器的本地时区解释。

建议产品默认：

- 今日：用户时区当天 00:00 至取数时刻。
- 本周：周一 00:00 至取数时刻；周起始日可配置。
- 本月：当月 1 日 00:00 至取数时刻。
- 周报和月报另外支持上一个完整周/月，报表标题明确起止时间。
- 近 7 天/近 30 天作为额外选项，使用与 Magpie 相同的名称。
- 发送频率与统计范围分别配置，例如每 6 小时发送一份同时包含今日、本周、本月的报告。

2026-11-09 在 Asia/Shanghai 的自然本月查询范围为 2026-11-01..2026-11-09；上一个完整自然周为 2026-11-02..2026-11-08。

不要假设网关汇总接口支持 tz 参数：已读源码中的网关 handler 用 State/FilterOf，时区处理与窗口侧的 PageIn/FilterIn 不同。网关与用户时区一致时可以直接用日期范围。跨时区部署应先取覆盖边界的明细，再按记录时间戳在客户端筛到用户时区的半开区间 [start, end)，或者明确将报表时区设为网关时区。

### 统计范围和调用口径

Magpie 当前请求接口可区分：

- through：经过网关的请求。
- direct：Magpie 从本地 agent 会话文件读取、匹配后纳入的直连记录。
- reported：应用主动上报的调用。

默认展示 Magpie 已纳入的总量，同时允许筛选来源，并在报表注明范围。不能将其描述成供应商账号在所有设备上的完整账单。

calls 按 Magpie 的请求口径计算。已交给其他账号重试的中间尝试不额外算一个调用，但其 token 可以进入消耗；重试成功、最终失败和取消应分列。自建明细聚合时必须保留这套语义。

## 3. 推荐实现

TypeScript + Bun，发布为一个 npm 插件包，同时提供独立 CLI。Bun 为 Magpie 插件宿主使用的运行时；直接提供 TypeScript 入口即可。

~~~mermaid
flowchart LR
  A["Magpie 用量 API"] --> B["后台：取数与报表"]
  C["定时／手动触发"] --> B
  B --> D["SQLite：报表和发送队列"]
  D --> E["Telegram／OneBot／SMTP／Webhook"]
  F["Magpie 插件页面"] <--> B
~~~

建议文件布局：

~~~text
package.json
index.ts                 # Magpie Bun 宿主入口
src/
  cli.ts                 # preview / send / run / status
  magpie-client.ts       # 网关发现、接口校验、分页和错误分类
  periods.ts             # 自然日/周/月、已完成周期、时区
  report.ts              # 统一 Report 数据；按 provider + model 分组
  scheduler.ts           # interval/cron、到期处理、补发
  store.ts               # Bun SQLite：jobs、reports、deliveries、leases
  server.ts              # 页面所需的本地服务
  render/
    text.ts
    html.ts
    csv.ts
  channels/
    telegram.ts
    onebot11.ts
    smtp.ts
    webhook.ts
page/
  index.html             # Magpie 页面启动壳
  boot.js
ui/
  index.html
  app.js
  style.css
test/
~~~

Report 应将“展示”与“发送”共用：包含范围起止、时区、取数时刻、来源、模型行、总计、未定价调用数和价格说明。页面、邮件与 TG 不应各自重新算一遍。

后台在 Bun 宿主中运行，页面负责查询、预览和设置。标准插件页面有 connect-src 'none'，不能直接 fetch Telegram/SMTP，也不应在前端保存凭据。需要完整模型和账号明细时，可按 page-usage-tree 的模式由本地服务提供页面和 API，并声明 magpie.page.service 兼容 magpie web；服务绑定回环地址，校验访问 token 与 Origin/Host。

纯 page-usage 式桥接只有前 20 个模型，不足以满足“各个模型”的完整报表。

可选依赖：

- interval 用短周期唤醒、持久化 nextRunAt；cron 可选用支持时区的 Croner，接入前验证 Bun 兼容性。
- SQLite 使用 bun:sqlite，保留发送队列和租约。
- Telegram、OneBot HTTP、Webhook 用 fetch 即可。
- SMTP 可选择 Nodemailer，经 Bun 集成验证后使用。mail-watch 的手写 SMTP 可参考，但当前只支持隐式 TLS 和无认证明文中继，不支持 STARTTLS，不能直接承诺覆盖所有邮件服务。

## 4. 费用估算

第一版直接使用 Magpie 的 cost 和 unpriced，并注明“Magpie 价格估算”。同一模型在不同供应商、账号或计费规则下可以价格不同，基本分组应是 provider + model，可再展开 account。

后续若提供自定义价格：

1. 支持供应商、模型、币种、有效时间、阶梯和倍率。
2. 将互不重复的普通输入、输出、缓存读取、缓存写入分别计价。
3. 1 小时缓存写入是 cache_write 的子集，不再重复累加。
4. reasoning 通常是 output 内的拆分，不额外叠加一次费用。
5. 保留 pricingSource/pricingVersion；未知价格显示“未定价”，不显示为免费。
6. 汇率有时间戳或用户固定值；人民币换算属于展示。
7. 若需要历史报表金额保持不变，保存生成时报表和价格快照；重新生成时标明重算。

概念公式：

~~~text
估值 = 普通输入 × 输入单价
     + 输出 × 输出单价
     + 缓存读取 × 读取单价
     + 各类缓存写入 × 对应单价
~~~

订阅制展示 token 和按 API 价折算的价值；实际订阅费另列。供应商明确返回的扣费或积分单独保存原单位和来源，不把积分当美元，不用余额差强行推导逐模型账单。

## 5. 通知通道和表格

| 通道 | 建议实现 | 展示方式 |
| --- | --- | --- |
| Telegram | Bot API sendMessage；先做单向推送，无需收消息和轮询 | 转义后的 HTML pre 等宽表格，长表拆分；可附 CSV。普通 sendMessage 文本上限 4096 字符，拆分时保留格式 |
| OneBot 11 | 主动调用现有实现的 HTTP send_private_msg / send_group_msg | 文本或图片消息段；核对协议返回的 status/retcode，不能只判断 HTTP 200 |
| SMTP | 自己的 SMTP 邮箱、TLS 配置、可选认证 | HTML 表格 + 纯文本备份 + 可选 CSV |
| Webhook | 通用 JSON POST，可配置凭据引用 | 输出统一 Report JSON，方便用户接入自己的推送服务 |
| Apprise API（可选） | 部署独立 Apprise 服务，插件调用其 HTTP API | 扩展到更多通知渠道；增加一个服务依赖，个人本机版可先不引入 |

OneBot 是协议，需要用户已有正在运行的实现及对应 bot 账号；OneBot 12 应另写适配器，其 action/参数不应直接复用 v11。第一版只主动发送，不要求部署消息事件接收服务。

表格建议字段：

~~~text
模型（供应商） | 调用 | 失败 | 重试 | 输入 | 输出 | 缓存读/写 | 预估费用
~~~

分别展示今日、本周、本月和各自总计。模型很多时，通知正文可以列 Top N + 其余汇总，但完整 CSV/本地预览必须包含所有模型，并明确通知是否截断。

扩展项包括首次 token 延迟、错误率、额度剩余和重置时间；P95 之类分位数需要明细计算，不能从平均值推出来。

报表无需调用 LLM；字符串模板和确定性计算即可完成。

## 6. 定时发送与可靠性

关键约束：Magpie 的 Bun 宿主按需启动，纯页面的脚本又取决于页面是否打开。不能将“装了插件”直接等同于“无人访问、没有请求时也永远准时运行”。

建议提供两种运行方式，共用 Report/Store/Channels：

- 插件方式：宿主加载时启动后台检查；窗口关闭但 Magpie 仍在后台、宿主仍在运行时可继续执行。明确首次启动/宿主重新启动的唤醒路径，重启后处理过期任务。
- CLI run 或系统定时任务：需要无人调用也按点发送时，用 Windows 任务计划程序、systemd 或 cron 托管。Magpie 不可达时标记失败并重试；电脑休眠/关机期间无法发送，恢复后按补发策略处理。

mail-watch 是已存在的折中：它在 onResponse 看见配置后设置并恢复摘要定时器，后续无需每个请求都重新开始计时；重启后仍需要进入该钩子恢复。它的摘要游标在读数据后就前移，也不等于已经可靠投递，不能直接照搬为可靠发送的实现。

自己的调度至少保存：

- scheduleId、nextRunAt、范围起止及配置版本。
- 每份已生成报表和每通道 pending/sending/sent/failed 状态。
- 本机租约/锁，防止 GUI、CLI、插件更新期间多实例重复执行。
- 去重键 scheduleId + periodStart + periodEnd + channelId；即时时点报表还包含计划触发时刻。
- 超时、429 Retry-After、5xx/网络退避，以及永久配置错误。
- 正常确认后标记 sent；崩溃后恢复未完成发送，不重发已确认的其他渠道。
- 超时可能发生在服务已经接收之后；TG/SMTP 等通道通常无法保证严格 exactly-once。采用稳定 reportId、保留回执、限制自动重试，并在状态中标明不确定投递。

空数据、API 失败、未定价、通知失败是不同状态。默认空窗口可以不发，失败需要在插件状态中可见。

## 7. 拟定配置

这是待实现插件的设计示例，不是 Magpie 现有内置字段；secrets 字段表示待实现的凭据引用，不是宿主自动提供的能力。

~~~json
{
  "gatewayUrl": "auto",
  "timezone": "Asia/Shanghai",
  "weekStartsOn": "monday",
  "currency": "USD",
  "sources": ["through", "direct", "reported"],
  "schedules": [
    {
      "id": "usage-overview",
      "cron": "0 22 * * *",
      "windows": ["today", "week-to-date", "month-to-date"],
      "channels": ["my-telegram", "my-email"]
    },
    {
      "id": "weekly",
      "cron": "0 9 * * 1",
      "windows": ["previous-week"],
      "channels": ["my-telegram"]
    }
  ],
  "channels": [
    {
      "id": "my-telegram",
      "type": "telegram",
      "tokenSecret": "telegram-bot-token",
      "chatId": "YOUR_CHAT_ID"
    },
    {
      "id": "my-email",
      "type": "smtp",
      "host": "smtp.example.com",
      "port": 465,
      "secure": true,
      "user": "sender@example.com",
      "passwordSecret": "smtp-credential",
      "to": ["recipient@example.com"]
    }
  ]
}
~~~

实际运行应让用户选择安全保存凭据的方式，页面只显示已配置/未配置。由用户运行的桌面应用常常不继承当前终端环境，不能只靠当前 PowerShell 临时设置的环境变量。通知只携带必要统计，默认不带会话 ID、账户邮箱或对话正文。

## 8. 实施顺序与验收

1. 取数 CLI：检测接口能力；preview 输出今日/自然周/自然月 JSON 和表格，对比 Magpie 同范围统计。
2. 报表核心：周期、模型分组、未定价标识、文本/HTML/CSV；用有缓存和重试的固定记录验证口径。
3. 通知适配：Telegram、SMTP、OneBot 11、Webhook；先本地假服务器验证请求，再由用户配置测试目标。
4. 持久化调度：SQLite 状态、重启恢复、租约、部分通道失败重试和状态查看。
5. Magpie 页面：查看、筛选、报表预览、定时规则、发送结果；“发送测试”由用户在明确目标后触发。
6. 验证后制作 npm 包，保留本地目录安装方式；需要社区展示时按 registry 约定提交。

必要验证集中在边界：

- 周日/周一、月末/跨年、时区与夏令时，以及去年完整月份。
- 普通输入/输出、缓存读写、1h 写入子集、reasoning 不重复、未知价格。
- direct/through 重叠去重与来源筛选；重试、失败和取消的调用口径。
- 明细多于 500 条以及读取过程中有新请求，确保分页和补扫不漏不重复。
- 401/403/404、字段缺失与坏 JSON；不能变成看似成功的零报表。
- 单通道失败、429、超时后的不确定投递、发送前后进程崩溃及两个运行实例。
- 页面未打开、宿主重启、电脑休眠后恢复和禁用插件后的停止行为。
- SMTP TLS、Telegram 转义和拆分、OneBot 业务失败回执。

## 9. 其他开源参考与资料

- [ccusage](https://github.com/ccusage/ccusage)：本地 coding agent 数据的日/周/月报、JSON 输出和成本展示。适合借鉴报告；Magpie 已纳入的同源会话不要二次累加。
- [LiteLLM Spend Tracking](https://docs.litellm.ai/docs/proxy/cost_tracking)：费用映射、自定义价格、预算和分维度成本设计。对于本插件，优先用 Magpie 已有计价；将 LiteLLM 再加作一层代理会增加接入与运维成本。
- [Apprise](https://github.com/caronc/apprise) / [Apprise API](https://github.com/caronc/apprise-api)：统一通知适配和可选的通知服务，支持 Telegram、Email 等。
- [Magpie 插件编写](https://usemagpie.ai/docs/plugins)：宿主、页面、权限、钩子和安装格式。
- [Magpie 网关用量接口](https://github.com/yetone/magpie/blob/main/internal/gateway/usage_api.go)、[响应与参数解析](https://github.com/yetone/magpie/blob/main/internal/usageapi/usageapi.go)。
- [时间范围](https://github.com/yetone/magpie/blob/main/internal/usage/period_range.go)、[统计字段与 period 常量](https://github.com/yetone/magpie/blob/main/internal/usage/usage.go)。
- [异步通知渠道](https://github.com/magpie-community/plugins/blob/main/packages/notify/channels.mjs)、[邮件摘要](https://github.com/magpie-community/plugins/blob/main/packages/mail-watch/digest.js)、[邮件调度](https://github.com/magpie-community/plugins/blob/main/packages/mail-watch/mail-watch.hooks.js)。
- [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)。
- [OneBot 11 公开 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)。

本次读取的树快照：magpie c7ebb6f8d91693b80f863f9667879060d18820f4；magpie-community/plugins 1aab125bf12df945c30c4c20db46853640fbf174。部分文档使用默认分支读取，未来版本可能调整接口和生命周期，应在实现前固定目标 Magpie 版本并做集成验证。

社区插件示例的 package.json 标注 MIT。借用代码时保留对应版权和许可证，并单独核对新增依赖的许可。

