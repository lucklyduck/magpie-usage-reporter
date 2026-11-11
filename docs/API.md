# Local service API v1

All application routes require the X-Usage-Token header injected into the page's metadata. Only loopback Host values and allowed origins are accepted. Token-bearing HTML is available by document navigation without null-origin CORS; public module assets and authenticated APIs support the opaque origin of Magpie's sandbox. Origin: null is not itself authentication. Writes use application/json; body limit 256 Ki characters. Credentials are accepted only on writes and are omitted from read responses.

| Method       | Path                           | Result                                                                                 |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------- |
| GET          | /healthz                       | Service identity, version, build and readiness; no user configuration                  |
| GET          | /api/v1/capabilities           | Metrics, blocks, grouping/layout/channel definitions, settings fields and presets      |
| GET          | /api/v1/status                 | Worker ownership, last tick, processing state and next runs                            |
| GET          | /api/v1/display                | Effective display, host display snapshot, rate provenance and fallback diagnostics     |
| GET          | /api/v1/usage                  | Usage snapshot, hierarchy, facets, quotas and diagnostics                              |
| GET          | /api/v1/original/tree          | Original provider → account → model tree; period=today,7d,30d,all and optional fresh=1 |
| GET          | /api/v1/quotas                 | Current cached quota cards                                                             |
| GET/PATCH    | /api/v1/settings               | Settings; PATCH includes revision                                                      |
| GET/POST     | /api/v1/subscriptions          | List/create subscriptions                                                              |
| PATCH/DELETE | /api/v1/subscriptions/:id      | Update/delete                                                                          |
| POST         | /api/v1/subscriptions/:id/send | Queue a manual execution; 202 and execution ID                                         |
| GET/POST     | /api/v1/channels               | List/create destinations                                                               |
| PATCH/DELETE | /api/v1/channels/:id           | Update/delete; referenced channels cannot be deleted                                   |
| POST         | /api/v1/channels/:id/test      | Queue explicit test message; 202                                                       |
| POST         | /api/v1/reports/preview        | Validate draft, build report and render channel-specific message parts; no job         |
| GET          | /api/v1/deliveries             | Execution records; subscriptionId/status/limit filters                                 |
| GET          | /api/v1/deliveries/:id         | Execution, frozen report, per-part receipts and events                                 |
| POST         | /api/v1/deliveries/:id/retry   | Explicit retry of failed/partial/unknown execution                                     |
| POST         | /api/v1/deliveries/:id/cancel  | End unresolved execution; active request must first finish                             |

Usage parameters: period, from, to, grouping=account|model, sort, includeCache, showZeroAccounts, fresh=1. Filter parameters providers/accounts/models/agents/sources are JSON arrays. Empty identity arrays mean unrestricted; sources must contain at least one selected source. Account/model IDs returned in facets are opaque JSON tuple strings.

Channel writes contain name/type/config/secret, plus revision for updates. Omitted secret fields retain existing values. GET returns configured, never secret.

Settings add `displayMode: "magpie" | "custom"` and `chineseUnits: boolean`. New installations use magpie; a stored settings record without displayMode is read as custom without writing or revising that record. `currency` (USD/CNY) and `usdCny` remain the saved custom values, retained while following Magpie. CNY requires a positive rate in custom mode. Host refreshes never change the settings revision. Unknown old plugin options are not used as display configuration.

`GET /api/v1/display` returns `{mode, effective: {currency, usdCny, chineseUnits}, source, stale, rate: {source, at, stale}, warnings, magpie}`. `magpie` is the same sanitized host snapshot before applying custom overrides; the settings form uses it to preview the follow mode without saving. `source` is magpie/custom/fallback; rate.source is magpie-cache/custom/fallback; at is an ISO timestamp or null. Warnings contain only fixed code/message pairs, never host file contents or paths. The route uses the same X-Usage-Token and sandbox CORS checks as all other application APIs.

Host values come from input.directory/settings.json (currency and chineseUnits only) and Magpie's fxrate.json. Installed caches follow XDG_CACHE_HOME or ~/.cache/magpie; portable caches live under the host config's cache/. Plugin stateDir has no influence on the host config. No host file is written and no exchange-rate request is sent. Missing/corrupt files retain the last successful reading, then fall back to USD/K-M-B/7.2 if none exists; a cached rate is stale after 12 hours.

Subscriptions use route.primaryChannelId and optional route.backupChannelId. Each content.blocks entry selects its type, period, grouping, fields, sort and optional limit. See examples/subscriptions.example.json for a draft; replace the channel ID with a saved destination. No template evaluation is supported.

Subscription content and generated reports accept optional `chineseUnits`. An explicit boolean selects 万/亿 or K/M/B for counts. Absence retains the legacy numeric format. The UI snapshots effective display values only when creating a new subscription draft; edits and copies retain their original values. Page settings never rewrite saved subscriptions or frozen delivery text.

Job statuses: pending, building, sending, waiting, sent, failed, partial, unknown, skipped, canceled. A stable execution key de-duplicates scheduled runs. Configuration snapshots and text are frozen for delivery retries.

Errors have an error object with message/code and optional field diagnostics. Validation is 400, forbidden origins 403, invalid token 401, missing resource 404, revision conflicts 409, gateway problems 502.

Quota values preserve the provider's reported units and timestamps. They are independent of historical usage periods. Secrets, prompts, model replies and tool contents are not included in notification reports.

`/healthz` retains name/version/build/ready and adds `serviceProtocol: 1` and `instanceId`, the SHA-256 of the canonical state directory (case-normalized on Windows). This identifier distinguishes configurations; it is not an authentication token and the directory is not disclosed. A managed host only waits for an occupied port when the name, protocol and instance match. It retries every 500ms for up to 12 minutes, then reports handover_timeout. Different directories fail with instance_conflict; unidentified/older protocols require a complete host restart. Standalone startServer never silently reuses an occupied listener.

GET/HEAD `/original` and `/original/` now redirect to `?usageView=original` under the service root. Other `/original/*` routes return 410. The integrated view uses the authenticated original/tree route and no secondary HTTP server or x-usage-tree-token. Relative redirects and resource URLs retain Magpie Web's service prefix.

After host replacement, a 401 reconnects a page once automatically when no form is being edited. Unsaved editors/settings remain visible with a reconnect button. Failed writes and sends are never replayed automatically; no draft credentials are persisted in browser storage.

The service page implements Magpie's existing hello/theme/visibility/error message subset. Only messages from parent with the expected shape are accepted; hello correlation IDs are unique across navigations. Handshake waiting is bounded to 2 seconds and never delays application initialization. Theme colors/fonts are validated, language stays zh-CN, and errors are reported using fixed sanitized text. Both document.hidden and the host visibility event pause frontend polling and cancel read requests; showing the page merges refresh work into one batch. Backend delivery and active writes are independent of page visibility.

The stable app.js entry loads no new modules until an authenticated capabilities probe returns uiProtocol: 1. A retiring older backend may already read new UI files while its route table lacks those modules or the required UI capability. A 404 or missing UI capability shows an explicit update-wait state and probes once a second, up to 12 minutes; a token change reloads the document once with bootReconnect=1. No writes are queued or replayed. Startup waiting also pauses for document/host visibility, and timeout or repeated authentication failure leaves a manual reconnect action. The main UI is loaded from main.js after compatibility is established.
