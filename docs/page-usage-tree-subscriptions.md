> 实现状态：项目已按最终确认的单主渠道/可选备用、文字通知方案实现。当前功能与安装说明见 ../README.md；本文保留早期规划记录。

# 基于 page-usage-tree 增加自定义订阅

2026-11-09。已确定的交互：用户在 Magpie 插件页面配置订阅，机器人负责推送。

本文和配套 examples/subscriptions.example.json 是待实现设计，不是现有插件接口或已经可运行的功能。工作区目前只有调研文档；没有修改已安装的 Magpie、安装插件或发送通知。

## 1. 选定基础与修改范围

基础项目：[magpie-community/plugins/packages/page-usage-tree](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-tree)，当前 package.json 为 0.1.0；本次查询该目录最新变更为 808f7a184d3a88db69691f4838deee46f64560b1。

沿用现有 .mjs 模块和原生 HTML/CSS。保留“供应商 → 账号 → 模型”用量树，增加“订阅”和“发送记录”视图。数据查询、报表生成和发送由同一个后台服务提供，页面预览与定时推送共用报表生成函数。

若独立发布，可将该子目录复制为独立包，命名为 magpie-usage-subscriptions，保留 LICENSE 与来源说明。在与原插件并装的情况下，给新包设置独立的宿主 id、服务 PLUGIN_NAME、缓存/状态目录和默认端口，例如 3495；package.json 的 page.service.port、options.port、page/boot.js 和独立启动入口保持一致。

## 2. 用户如何自定义

把一个订阅理解为一份保存好的报表定义：

| 配置项 | 页面控件 | 例子 |
| --- | --- | --- |
| 发给谁 | 多选已配置渠道 | 我的 TG 私聊 + 我的邮箱 |
| 什么时候 | 每日时间、每周时间、间隔；高级 cron | 每天 22:00，Asia/Shanghai |
| 统计哪些调用 | 供应商、账号、模型、Agent、来源筛选 | 只看 OpenAI / 某账号 / 网关请求 |
| 报告哪些内容 | 区块增删、拖动排序 | 今日概览 → 本周模型表 → 本月模型表 |
| 每块统计多久 | 每个区块独立选周期 | 今日、本周、本月、上周、上月、近 7/30 天 |
| 表格如何显示 | 列勾选、列排序、分组、排序方式 | 模型、调用、失败、Token、预估费用 |
| 怎么写 | 标题、开头、结尾；高级固定变量模板 | “本周模型用量”及自定义说明 |
| 其他行为 | 空报表是否跳过、补发规则 | 无调用则跳过，恢复后补最新一份 |

先提供三个预设：“今日用量”“每日综合日报”“上周周报”。用户复制预设后修改。高级配置可以导入/导出 JSON，但常规设置全部由表单完成。

页面树的临时搜索、展开状态、排序不自动影响已保存订阅。“从当前筛选创建订阅”将当前选择明确保存为配置快照。

建议的新建流程：名称与渠道 → 周期和内容 → 发送时间 → 预览 → 保存/启用。预览按 Telegram、邮件分别显示最终格式与拆分后的消息数量。发送测试由页面上的明确按钮触发。

## 3. 数据结构

拆成两个对象：

- Channel：发送方式、接收目标及凭据引用。多个订阅可以复用。
- Subscription：筛选范围、内容区块、调度和 channelIds。不复制机器人 token。

完整开发用示例见 [subscriptions.example.json](../examples/subscriptions.example.json)，默认 enabled 为 false。凭据引用是拟新增后端能力，示例未包含实际凭据。

区块最小格式：

~~~json
{
  "id": "week",
  "type": "table",
  "period": "this-week",
  "title": "本周各模型",
  "groupBy": ["provider", "model"],
  "columns": ["model", "provider", "calls", "errors", "tokens", "costUsd"],
  "sort": { "field": "costUsd", "direction": "desc" },
  "rowLimit": null
}
~~~

第一版区块类型：

- summary：选定周期的总计卡片/简短文字。
- table：模型表或供应商/账号/模型表。
- note：用户文字和系统生成的范围、价格说明。

后续增加 quota（余额/额度与重置）和 errors（失败详情）时，各自增加数据源和预览状态，不把它们硬塞进 usage-tree 的已有数据。

可选指标包括 calls、errors、retried、canceled、input、output、cacheRead、cacheWrite、reasoning、tokens、costUsd、unpriced、errorRate、avgTtftMs。costUsd 对应上游 cost，currency 仅控制展示；tokens 按 tokenMode 选择是否包含缓存，reasoning 不再叠加。当前上游 canceled 等字段没有全部映射，提供前需补映射并确认来源。

字段、分组、周期、指标都做白名单校验。订阅记录 schemaVersion 和 revision，便于升级和同时打开多个页面时检测编辑冲突。

filters 的数组约定：空数组表示该维度不限制，同维度多项取 OR，不同维度取 AND。模型选择保存 provider + model，账号选择保存 provider + 原始账号标识；页面显示别名，修改显示名称不应改变筛选对象。出现已删除或无法识别的选择时显示失效项，不能自动扩成全部账号/模型。

## 4. 普通内容配置与高级模板

普通用户用区块和表格列完成定制，无需写模板。文字字段支持固定变量，例如：

~~~text
{{subscription.name}}
生成时间：{{report.generatedAt}}

{{sections.day.title}}
{{sections.day.table}}

{{sections.week.title}}
{{sections.week.table}}

{{pricing.note}}
~~~

这个完整模板可以作为可选的 content.bodyTemplate；未配置时按 sections 顺序渲染。title、intro、note、footer 同样可以使用限定变量。

模板读取的是后端已经算好的 Report。合计、费用、排名和失败率由后端计算。模板解析器只展开声明的变量及表格区块，未知变量给出配置错误；不执行 JavaScript，不允许访问任意对象路径或环境变量。

表格变量是受控区块标记：Telegram 渲染成转义后的 pre 文本，邮件渲染成 HTML table，Webhook 可附结构化 Report。用户文字、模型名、账号名都按目标格式转义。通过后端字段 includeAccountNames 控制是否加入账号名称；普通报告默认关闭。

rowLimit 为 null 表示全部模型。若设为 Top N，先对全部筛选结果计算合计，再截取展示行，附“其余模型”汇总和省略行数；完整 CSV 仍包含全部行。多周期区块分别合计，不跨今日、本周、本月求和。

## 5. 按文件改什么

| 上游文件 | 已有职责 | 修改建议 |
| --- | --- | --- |
| index.mjs | 在宿主中只启动一次本地服务 | 初始化应用状态、调度器与发送 worker；保持错误清理和重复启动保护 |
| lib/gateway.mjs | 网关发现和 usage/requests 读取 | 增加统一查询参数、能力检测和结构化错误；支持报表需要的筛选 |
| lib/data.mjs | 聚合、磁盘缓存、后台刷新 | 增加严格读取模式与完整性状态；支持日期范围及按查询身份区分缓存 |
| lib/usage.mjs | 供应商 → 账号 → 模型聚合 | 复用统计映射，补字段；将周期校验移到统一模块；输出明确的明细覆盖情况 |
| lib/server.mjs | 静态页面、GET /api/tree、GET /api/settings | 增加订阅、渠道、预览、手动发送和记录 API；按路径处理 HTTP 方法与鉴权 |
| ui/app.html、ui/app.js | 用量树页面和事件 | 增加订阅列表入口，编辑器与预览单独模块，避免继续堆进 app.js |
| ui/view.js | 数字格式和视图数据 | 共享可复用格式化；报表核心保留原始数值，格式化在最后一步完成 |
| ui/i18n.js、ui/style.css | 中英文及样式 | 增加订阅字段、状态、错误文案与编辑器样式 |
| page/boot.js、package.json | 页面启动、主题传递、服务端口 | 独立发布时更新包身份和服务端口；只传启动/显示选项 |
| serve.mjs | 独立开发入口 | 与宿主调用同一应用启动函数，支持后台运行模式 |

建议新增：

~~~text
lib/
  periods.mjs             # 自然周期解析、边界与时区
  report.mjs              # 生成统一 Report，保留数值与完整性状态
  report-query.mjs        # 按订阅筛选查询，复用已有网关和聚合逻辑
  subscription-schema.mjs # 校验配置、默认值和版本迁移
  store.mjs               # 订阅、报表快照、队列、执行租约
  scheduler.mjs           # nextRunAt、触发与恢复
  delivery-worker.mjs     # 各渠道发送、重试和结果
  credentials.mjs         # 后端凭据读写
  render/
    text.mjs
    telegram.mjs
    email.mjs
    csv.mjs
  channels/
    telegram.mjs
    onebot11.mjs
    smtp.mjs
    webhook.mjs
ui/
  subscriptions.js        # 列表/启停/复制
  subscription-editor.js  # 筛选、区块、列、时间与模板
  report-preview.js       # 各渠道预览
  deliveries.js           # 投递状态
~~~

将 startServer 返回的 close 包装成统一 stop：先停止调度，取消/等待发送和查询，再关闭 HTTP 服务、数据库。服务 reused 时不在另一个进程启动一套调度；仍须通过共享状态目录中的租约处理 CLI/宿主的重叠。

lib/server.mjs 的 BUILD_FILES 当前是固定列表，新增运行模块和 UI 资源应纳入构建身份计算，同时注册 STATIC 路径，确保本地改动能被识别和加载。

## 6. 四处需要先处理的上游行为

### 周期白名单分散

当前以下位置分别只允许 today、7d、30d、all：

- lib/usage.mjs：PERIODS 和 aggregateGatewayUsage。
- lib/data.mjs：normalizePeriod。
- lib/server.mjs：dataFor 与 /api/tree 的参数校验。
- ui/app.js 和 ui/view.js：页面周期选项。

只在界面加“本周”会被后端拒绝或回落为别的周期。将“用户选项”和“网关查询”分开：this-week/this-month 先解析为日期范围，再调用 API。使用统一的 periods.mjs，未知值明确拒绝。

网关日期范围按网关本地时区解释。第一版本地插件可要求报表时区与本地网关一致，跨时区查询应使用覆盖边界的明细并按时间戳筛选。参考根目录的 usage-reporter-plan.md 中的接口核对结果。

### 页面缓存允许过期数据

lib/data.mjs 的 loadUsageData 默认会立即返回磁盘缓存，再后台刷新。lib/server.mjs 中，即使请求 fresh，刷新失败也可能退回 stale 的旧结果。

页面可继续显示带时间标记的缓存；定时生成新报告使用 loadReportData(..., {fresh: true, strict: true})，失败就记录并等待重试。首次生成成功后冻结 Report 快照，后续投递重试使用这一份快照，不边重试边重新计算。

缓存键至少包含网关身份、解析后的时间范围、时区、来源/筛选、数据结构版本。缓存存于可清理目录；订阅配置与发送状态放在持久状态目录，不能放进当前 ~/.cache/magpie/usage-tree。

### 模型明细可能不完整

lib/data.mjs 的 requestsForAccounts 当前捕获账号查询错误后写 null，继续保留账号总计。lib/usage.mjs 的 warnings 目前主要标记 no-usage。

报表需要区分 complete、partial、failed，记录缺失的账号或模型；在严格模式下所选指标明细不完整则停止本次生成，保留错误待重试。允许发送部分数据可作为明确选项，必须在报告写出缺失范围。

对整个树做扁平化时，每个数据层级有自己的作用。供应商、账号是汇总层，模型是叶子层；不要将它们一起相加。应用模型筛选后，重新计算该范围的合计，不能沿用未筛选的全局 summary。

### 接口的 by 分组有筛选特殊语义

Magpie 的 usage/requests 返回的 by.modelAt 不是任意条件下都等于当前过滤结果。上游 Filter.Without("modelAt") 会清除 provider 和 model 选择，让界面还能切换到其他选项。

复用此表时，按 provider + model 标识重新执行用户的供应商/模型选择。账号、agent、来源等条件在正确的查询范围内传入；多选条件拆分查询时，要确保分区互斥并去重。

合计与明细分别核对。同一模型有调用交给其他账号继续、API key 组和未识别账号等情况，应沿用网关的统计语义。需要原始调用或时间戳的功能再分页读取 rows；不能把第一页 500 行当作全部。

## 7. 页面 API

当前服务只允许 GET/HEAD/OPTIONS，/api/settings 仅返回显示设置。新增：

~~~text
GET    /api/subscriptions
POST   /api/subscriptions
PATCH  /api/subscriptions/:id
DELETE /api/subscriptions/:id

GET    /api/channels
POST   /api/channels
PATCH  /api/channels/:id
DELETE /api/channels/:id

POST   /api/reports/preview
POST   /api/subscriptions/:id/send
POST   /api/channels/:id/test
GET    /api/deliveries?subscriptionId=...
~~~

preview 接受未保存的订阅草稿，调用同一 buildReport + render 流程，返回内容和诊断，不创建投递任务。send/test 只在用户明确点击对应操作后创建发送任务。

保留现有回环绑定、Host/Origin 检查及随机 token；新写接口也检查 token、JSON 类型和长度，按路由允许方法，CORS 预检与桌面 sandbox/magpie web 的使用方式一致。凭据仅通过专用后端 API 更新；GET 只返回 configured 等状态和安全配置。不要将机器人 token 放进 page/boot.js 的 URL、localStorage 或 magpie.options 交给页面反复读取。

## 8. 定时与存储

后台可使用 Bun 内置 bun:sqlite，把 subscriptions、channels、reports、deliveries、leases 放在独立数据库。采用它时，将带数据库的独立入口和集成测试明确切换到 Bun；不要继续将 node serve.mjs 作为等价启动方式。纯函数的 node:test 测试可继续保留。

渠道凭据由后端凭据模块单独保存，数据库保存 credentialRef；GET 列表不返回凭据明文。

调度在应用启动时恢复，保存 nextRunAt，短周期检查到期项。每份计划执行有稳定 jobId，每个渠道独立保留状态。一次报告发送成功到 TG、邮件失败时，只重试邮件；手动发送另外生成执行 ID，不被定时去重误吞。

subscriptions.revision 用于新执行绑定配置；暂停/删除后取消待发送任务，修改接收目标后按新配置创建后续执行，历史 Report 和已确认回执保持可查。

调度与发送 worker 取得持久租约并续期，防止 Magpie CLI 临时宿主、插件服务和独立进程重复发送。限时失败可能已到达远端，保存 reportId/回执/不确定状态；TG/SMTP 不承诺严格 exactly-once。

Magpie 的插件宿主按需启动，定时器需要宿主存活。要求无人请求也准时运行时，使用同一后台核心的独立 run 模式，由系统任务/服务启动；插件页面与独立服务通过共享状态与租约协作。电脑休眠或关机后，catchUp: latest 默认补最近一份，列表中显示漏过的执行和原因。对历史时点补发，周期要按原计划时间解析；需要严格截止到当时的未完成自然日数据时按明细时间戳过滤。

## 9. 实现顺序

1. 复制独立包并固定上游版本，完成包名/服务身份/端口与 MIT 声明。
2. 增加 periods、Report 和 preview；先实现今日/本周/本月，数据与 Magpie 对账。
3. 增加订阅编辑器：区块、列、筛选、定时；持久化与导入/导出。
4. 接通 Telegram、SMTP、OneBot 11 和 Webhook，预览与发送使用同一 Report。
5. 加任务持久化、租约、重试、补发、暂停与发送记录。
6. 完成页面未打开、宿主重启、休眠恢复、多进程及部分渠道失败的验收，再发布。

优先验证的测试：周期边界与缓存隔离、筛选后的合计、by.modelAt 筛选语义、账号明细失败、重复层级不累加、字段与模板校验、格式转义和长表拆分、单渠道重试与重复执行、启动/关闭与租约恢复。取数和发送以本地假网关/假渠道验证，真实渠道由配置好的测试目标验证。

## 10. 源码与资料

- [上游入口与文件](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-tree)。
- [聚合逻辑](https://github.com/magpie-community/plugins/blob/main/packages/page-usage-tree/lib/usage.mjs)。
- [取数与磁盘缓存](https://github.com/magpie-community/plugins/blob/main/packages/page-usage-tree/lib/data.mjs)。
- [服务路由、内存缓存和生命周期](https://github.com/magpie-community/plugins/blob/main/packages/page-usage-tree/lib/server.mjs)。
- [网关查询](https://github.com/magpie-community/plugins/blob/main/packages/page-usage-tree/lib/gateway.mjs)。
- [Magpie 的请求分组与 Filter.Without](https://github.com/yetone/magpie/blob/main/internal/usage/ledger.go)。
- [Magpie 插件机制](https://usemagpie.ai/docs/plugins)。
- [现成通知通道](https://github.com/magpie-community/plugins/blob/main/packages/notify/channels.mjs)。
- [现成邮件摘要](https://github.com/magpie-community/plugins/tree/main/packages/mail-watch)。
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)。

