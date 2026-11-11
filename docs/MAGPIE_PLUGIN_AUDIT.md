# Magpie 插件设计与权限对照审计

审计日期：2026-11-10。对象为当前工作区，包括已有、尚未提交的渠道表单修复。

结论：本项目采用的“社区插件入口 + 沙箱启动页 + Bun 回环服务”属于 Magpie 支持的扩展方式；没有缺少必须声明的页面读取权限。但是，确认存在六处实现问题，以及一处主题／可见性对接缺口。其中访问令牌泄露和宿主服务交接应优先修复。

本报告的发现记录对应 2026-11-10 的审计快照；下面的代码行号为当时的位置。2026-11-11 第一阶段已修复 A1–A5，并把原版视图整合为用量页标签：含令牌文档移除 null CORS，宿主管理器增加协议与目录标识及后台接管，旧原版代理由统一鉴权 API 取代。A6 显示选项、I1 主题／可见性对接继续保留为后续工作。

最新验证及交付状态见 [验收记录](ACCEPTANCE.md)。本报告末尾保留的审计探针是修复前的复现记录，其“问题能复现”断言不适用于修复后的代码；正式回归入口已覆盖对应正反场景。

## 依据和验证范围

官方源码位于工作区 `.smoke/official-magpie`，远程为 `https://github.com/yetone/magpie.git`，快照提交为 `c02a491e8768232ce384917c17dc70ab11929cda`，提交时间为 2026-11-10 03:10:44 +0800。以下关键文档和实现已与该提交的 Git 对象逐一核对，内容一致：

- [插件中文文档](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/site/public/docs/zh/plugins.html)：宿主、插件输入、页面能力与沙箱限制。
- [插件运行时设计](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/docs/subsystems/plugin-runtime.md)：重点为 P4 社区页面、P5 页面服务与 CSP、页面回收和宿主启动。
- [页面清单解析与权限白名单](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/internal/plugin/page.go)。
- [宿主加载实现](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/internal/plugin/host.js)及[宿主启动、重启与退出实现](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/internal/plugin/host.go)。
- [页面文件与读取 API](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/internal/gui/pluginpage.go)、[服务反向代理](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/internal/gui/pageservice.go)、[页面桥接](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/internal/gui/pagebridge.js)和[宿主侧消息处理](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/internal/gui/assets/pluginpages.js)。
- [用量 API 的调用者限制](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/internal/gateway/usage_api.go)和[只读网关密钥允许的路由](https://github.com/yetone/magpie/blob/c02a491e8768232ce384917c17dc70ab11929cda/internal/gateway/readonly.go)。

本轮执行了现有自动测试及新增隔离探针。浏览器探针使用 Windows 无界面 Edge、随机回环端口和临时配置；应用使用内存夹具或临时 SQLite。未读取真实通知凭据，未修改真实 Magpie 配置，未发送外部通知。

这不是对所有 Magpie 版本的认证：本轮未验证清单声明的最低版本 0.1.3436，也未在 macOS／Linux 原生 WebKit 或远程 HTTPS 的真实 `magpie web` 环境执行验收。

## 权限模型：需要区分三层

| 层           | Magpie 的实际要求与能力                                                                                                                                                                           | 本项目情况                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内置插件     | Go `pluginrt.Manifest` 的 `API`、`Requires`、`Provides`、`Apply` 和 `OnDispose`，由 `plugins.yml` 管理。                                                                                          | 本项目属于社区 Bun 插件，不适用这套内置插件清单，也不应照搬这些字段。                                                                                                            |
| 社区插件后台 | 从 `main`／`exports` 加载，在共享 Bun 宿主内执行。`input.directory` 和 `worktree` 是 Magpie 配置目录。后台具有运行用户的文件、网络和 Bun shell 能力；页面的 `magpie.permissions` 不限制这些能力。 | `index.mjs` 的默认导出 `{ id, server }` 符合宿主加载协议；将状态放在 `input.directory/usage-subscriptions` 的方式符合用途。不能把页面沙箱理解为后台的操作系统权限隔离。          |
| 静态插件页面 | `magpie.page.file` 必须是包内 HTML，图标位于该页面目录内；沙箱只允许脚本。初始页面使用受限 CSP，通过 `postMessage` 桥接宿主。                                                                     | `page/index.html`、`page/icon.svg`、外部 `boot.js` 及 `_magpie/bridge.js` 的组织符合要求。                                                                                       |
| 页面读取权限 | 白名单只有 `usage:summary`、`usage:day`、`providers:list`；前后端分别校验声明。读取不会提供密钥、账号登录信息或请求正文。                                                                         | 当前没有调用 `magpie.read`，不声明 `magpie.permissions` 是正确的。增加 `usage:summary` 既不能授权通知发送，也不能替代后台读取明细／额度。                                        |
| 页面能力限制 | 无 `allow-forms`、`allow-popups`、`allow-same-origin`；页面的直接存储、原生表单提交、弹窗等能力受到限制。导航到本地服务后，iframe 的沙箱仍保留。                                                  | 保存表单已通过按钮事件调用 API，符合这一限制；原版页面入口仍违反弹窗限制，见 A4。                                                                                                |
| 页面后台服务 | `magpie.page.service {port, option}` 声明回环服务。桌面页直接访问回环地址，Web 页优先使用 `magpie.service` 的代理地址。                                                                           | 声明 `3495`、选项名 `port`，只监听 `127.0.0.1`，并优先使用 `magpie.service`，方向正确。                                                                                          |
| Web 服务代理 | 以页面的不可猜测 token 路径为入口；向后台重写 Host，移除 Cookie，拒绝非空且非 `null` 的 Origin；响应追加沙箱 CSP、去掉 Set-Cookie。                                                               | 主 UI 的静态和 API URL 使用相对路径，适合代理前缀；主 API 接受 `Origin: null` 是兼容需要，但不能据此认为来源已经可信，见 A1。                                                    |
| 服务 CSP     | 服务提供自己的策略；Web 代理为 `'self'` 补充完整地址，并追加 `sandbox allow-scripts`。WebKit 对不透明来源下的 `'self'` 有额外限制。                                                               | 主 UI 提供 CSP 响应头并列出显式回环源；初始页面不依赖内联脚本。原版页面的转发仍有独立 CORS 问题，见 A5。                                                                         |
| 读取网关数据 | 网关 `/v1/magpie/*` 与 GUI `/api/*` 的鉴权不同。外部网关需共享设置与合适密钥；受预算、模型或账号限制的密钥无法读取全局用量摘要。                                                                  | `MagpieSource` 从后台调用用量、请求账本和额度卡片 API，使用 `MAGPIE_ADDR` 并支持显式密钥；没有从沙箱页直接绕过 GUI API。远程只读用途可使用无预算／模型／账号限制的只读网关密钥。 |
| 后台调度     | 页面隐藏或 10 分钟后销毁，后台任务应仍归宿主管理；`keepAlive` 是保留页面的选项，不是后台守护开关。                                                                                                | 调度位于 `Application`，有持久状态、worker 租约和重启恢复，不依赖页面计时器；无需为了定时通知增加 `keepAlive`。宿主进程交接另有问题，见 A2。                                     |
| 凭据与状态   | 页面 bridge 不是机密数据仓库。后台可在配置目录保存自己的状态；服务自行负责本地 API 的读写边界。                                                                                                   | 通知凭据与 SQLite 分开存储，渠道读取不返回明文；配置没有经过页面 options 传递通知凭据。文件并非加密保险库，Windows ACL 的实际限制未在本轮单独验收。                              |

## A1 · P1：任意不透明来源可取得服务令牌并读写 API

位置：`lib/server.mjs:149`、`:310`、`:315`；`ui/index.html:6`；现有回归断言 `test/api.test.mjs:10`。

`cors(request)` 对任何 `Origin: null` 返回 `Access-Control-Allow-Origin: null`，并应用于包含随机 `usage-token` 的首页 HTML。外部网页也可以创建 `sandbox="allow-scripts"` 的 iframe，使其请求带 `Origin: null`。因此，这个来源值不能标识“来自 Magpie”。

隔离 Edge 验证从另一个网页来源启动，没有预先提供插件令牌：

1. 外部沙箱脚本 `fetch` 本地服务首页，成功读取 HTML 并提取令牌。
2. 携带提取的令牌读取 `/api/v1/settings`，返回 200。
3. 再 PATCH 测试实例设置，返回 200，后台设置确实改变。

Host 检查不阻止这条路径，因为请求本来就发往正确的回环 Host；拒绝具名外部 Origin 也不够。之前为模块脚本添加的 CORS 修复同时放行了含令牌的文档，范围过大。

影响是服务 API 的读取和修改边界被绕过，包括通知目标、订阅和执行操作；API 本身不直接返回通知密钥，但不能因此认为凭据安全边界仍成立，例如已有渠道的服务端点可以被修改。实际外部网站利用仍受浏览器本地网络访问策略影响。本轮证明的是不同本地网页来源之间的真实浏览器攻击路径；没有声称可绕过远程 `magpie web` 的不可猜测页面路径。

建议将公开静态资源与含令牌 HTML 分开：模块资源可按需要支持 `null` CORS，含令牌文档不应允许外部 `fetch` 读取。iframe 的正常文档导航不需要该 CORS 响应头。保持 API token 校验，补充“未知外部沙箱无法取得令牌”的负向测试，并修改目前把 `/` 与公共模块一起要求放行的测试。

## A2 · P1：新宿主复用旧服务后，旧宿主退出将导致服务消失

位置：`lib/server.mjs:335`；`index.mjs:4`。

遇到 `EADDRINUSE` 时，只要 `/healthz` 的名称和构建 ID 匹配，`startServer` 就直接返回 `reused: true`。这个结果没有自己的监听器、应用或调度器，也没有等待端口释放并接手的后续机制。`index.mjs` 又将这个已完成的 Promise 缓存为已启动状态。

Magpie 的重启／回收允许旧宿主继续完成现有调用，新调用由新宿主处理；旧进程最多可能保留 10 分钟。这不是可以假定“旧进程总在新进程之前退出”的运行环境。官方依据为 `internal/plugin/host.go:808`、`:828` 和 `:836`。

隔离复现：先启动第一份服务，再在同一端口启动第二份相同构建，第二份报告复用成功；关闭第一份后，该端口无法连接，而第二份仍没有自己的应用。真实宿主中的潜在结果是页面断线、定时任务停止，需要再次重启才能恢复。升级后构建 ID 不同则会直接报告端口占用，也缺少交接恢复。

建议设计明确的后台接手机制：允许旧服务暂时提供服务，同时新进程监测端口并在释放后取得监听与 worker 所有权；插件加载不得因无限等待而超过宿主加载时限。增加“旧宿主仍服务 → 新宿主启动 → 旧宿主退出 → 页面与调度恢复”的行为测试，覆盖相同和不同构建。

## A3 · P2：服务复用不检查状态目录，可能连接到另一份配置

位置：`lib/server.mjs:341`；目录解析在 `lib/bootstrap.mjs:10`。

复用判断只比较程序名称和构建 ID，发生在 `createApplication(options)` 之前，不比较 `stateDir`、`input.directory` 或其他实例配置。

本轮用两个独立临时状态目录验证：第一份服务保存一项可识别设置；第二份指定另一个目录和相同端口启动，得到 `reused: true`，第二个数据库甚至没有创建；读取该服务得到的是第一份目录的设置。

这会影响同时运行的开发预览和正式插件、多配置目录／便携实例：用户以为打开另一份配置，实际仍在读写先前实例。此问题在第一实例持续存活时也存在，因此修复宿主交接不能自动解决它。

建议给实例增加与规范化状态目录绑定的标识；跨目录冲突必须明确报错，或为新实例选择并公布不同端口。不能仅凭相同构建静默复用。回归测试应验证第二目录的配置不会被第一实例代替。

## A4 · P2：原版用量树入口使用沙箱禁止的弹窗

位置：`ui/index.html:43`。

链接使用 `target="_blank"`。Magpie 的 iframe 只有 `allow-scripts`，没有 `allow-popups`；页面跳转到自己的服务后，这个限制仍在。

隔离 Edge 点击实际入口，没有打开新窗口，控制台明确报告缺少 `allow-popups`。这与先前表单保存问题属于同一类浏览器沙箱限制，但涉及另一种能力。

建议使用同一 iframe 内的导航并提供返回入口，或将原版视图接入现有页面路由。无需也不应以扩大宿主沙箱权限作为插件修复。

## A5 · P2：原版页面代理拒绝预检，且去掉了其 CORS 响应

位置：`lib/server.mjs:272`、`:274`、`:292`；原页面请求在 `vendor/page-usage-tree/ui/app.js:308`。

即使绕过 A4、在当前 iframe 内加载原版页面，仍无法正常读取数据：

- 原页面以 `x-usage-tree-token` 请求相对地址 `api/tree`，沙箱来源为 `null`，浏览器会先发 OPTIONS。
- 请求路径是 `/original/api/tree`，不进入主服务的 `/api/` 预检分支；GET／HEAD 以外的方法在转发前被拒绝，OPTIONS 返回 405。
- 转发 GET 时主服务主动删除 Origin，原版服务因此不再添加 `Access-Control-Allow-Origin: null`；转发响应也未补充 CORS。

实测 OPTIONS 为 405；直接 GET 虽为 200，但没有允许来源头。真实 Edge 页面报告预检被 CORS 拒绝，数据加载失败。

建议让原版代理在严格校验的范围内处理必要预检、方法和允许头，并保留／正确设置 API 的 CORS；不要为包含原版令牌的 HTML 直接增加可读 CORS，以免重复 A1。修复后同时验证桌面直连与带前缀的 Web 代理。

## A6 · P2：清单暴露的显示选项没有接入运行结果

位置：`package.json:77`；`page/boot.js:8`；`index.mjs:5`；`lib/bootstrap.mjs`。

`magpie.options` 声明 `currency`、`chineseUnits` 和 `usdCny`，但：

- 启动页只读取 `port`，跳转地址只写入 `theme`。
- 插件入口只传递端口、目录和网关，不传递这些显示选项。
- 主 UI 从自己的持久设置读取币种／汇率；它没有读取这三个 Magpie 选项，中文单位也没有对应的当前设置定义。
- 原版服务的启动同样没有传递这几个选项。

本轮执行真实启动脚本并提供 `currency: cny`、`chineseUnits: true`、`usdCny: 7.2`：服务代理地址使用正确，但输出 URL 仍只有 `theme=light`。上游原版启动器具有转发代码，不能将 vendor 内测试的通过视为本项目也已接入。

建议明确唯一配置来源。若以当前页面设置为准，应删除清单中无效的选项并更新说明；若保留 Magpie 选项，需定义和已保存设置的优先级，接入对应视图，并确保不覆盖用户已经保存的值。

## I1 · P3：导航后的服务页面没有继续接收主题与可见性消息

位置：`page/boot.js:20`；`ui/index.html:10`；`ui/app.js:1502`、`:1511`。

启动页加载 bridge、读取初始主题后通过 `location.replace` 整页导航。实际服务文档没有 bridge，也没有接收对应消息的替代实现：

- Magpie 之后发送主题变化，页面仍只保留首次 URL 中的主题；窗口颜色令牌和语言消息也不会处理。
- 宿主通过 CSS 隐藏 iframe 后，内部 `document.hidden` 仍为 false。当前刷新循环只检查这个值，无法利用宿主提供的 `visibility` 消息暂停隐藏视图刷新。
- 服务页后续未捕获错误不会再由原 bridge 转交给宿主错误边界。

隔离探针在父窗口发送与宿主同格式的主题／可见性消息后，服务页主题没有改变，`window.magpie` 不存在，CSS 隐藏后的 `document.hidden` 仍为 false。

这是宿主体验与资源使用的对接缺口，和前面六项功能／访问边界问题分开记录。建议在服务文档接入必要的主题与可见性消息，并验证消息来自父窗口。后台调度仍应独立运行；暂停的是隐藏页面刷新。

## 测试结论与缺口

本轮运行 `bun test/run.mjs`：**86 pass、0 fail、183 次断言、15 个测试文件**。其中包括 vendor 的测试，不能把它们全部理解为当前项目集成层的覆盖。

新增隔离诊断命令：

```powershell
.\.tools\bun\bun-windows-x64-baseline\bun.exe .tools/audit-magpie-contract.mjs
```

该脚本是当前问题的复现探针，断言上述问题能被复现；退出码 0 不表示应用没有问题。诊断产物位于 `outputs/magpie-contract-audit.json`。两者属于本地忽略目录，没有加入普通测试入口；修复后应把相应要求转成正式的、以阻止这些错误为成功条件的回归测试。

| 检查                                  | 本轮结果                                                         |
| ------------------------------------- | ---------------------------------------------------------------- |
| 现有单元／集成测试                    | 86 项通过。                                                      |
| 未授权外部沙箱读取令牌后修改设置      | 真实 Edge 复现，读写均为 200。                                   |
| 原版入口弹窗                          | 真实 Edge 明确拦截。                                             |
| 原版 API 预检与 GET CORS              | 405／缺少允许来源头；真实 Edge 数据加载失败。                    |
| 同构建服务交接                        | 第一服务关闭后端口不可达，第二实例没有应用。                     |
| 不同状态目录隔离                      | 第二目录未建立数据库，实际返回第一目录设置。                     |
| 显示选项转发                          | 执行启动脚本确认只传递 theme。                                   |
| 主题／可见性对接                      | 发送事件后不响应，隐藏 iframe 内 document.hidden 仍为 false。    |
| 完整既有 UI 回归                      | 本轮没有重跑全部 `e2e/run.mjs`；本轮运行的是新增 Edge 审计探针。 |
| 真实通知平台接收                      | 本轮未测试；探针未发送外部消息。                                 |
| 原生 WebKit、远程 HTTPS Web、最低版本 | 本轮未执行。                                                     |

现有测试有三个容易误判的地方：`test/api.test.mjs` 将含令牌首页的 `null` CORS 放行也当作正确行为；`/original/` 仅检查 HTML 可返回，没有覆盖沙箱内点击和 API 读取；vendor 的生命周期和选项测试并不覆盖主服务重写后的对应实现。

建议修复顺序：A1 访问边界 → A2 宿主交接 → A3 状态隔离 → A4／A5 原版页面完整链路 → A6 配置来源 → I1 主题与可见性对接。
