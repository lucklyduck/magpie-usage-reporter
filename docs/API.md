# Local service API v1

All application routes require the X-Usage-Token header injected into the page's metadata. Only loopback Host values and allowed origins are accepted. Writes use application/json; body limit 256 Ki characters. Credentials are accepted only on writes and are omitted from read responses.

| Method | Path | Result |
| --- | --- | --- |
| GET | /healthz | Service identity, version, build and readiness; no user configuration |
| GET | /api/v1/capabilities | Metrics, blocks, grouping/layout/channel definitions, settings fields and presets |
| GET | /api/v1/status | Worker ownership, last tick, processing state and next runs |
| GET | /api/v1/usage | Usage snapshot, hierarchy, facets, quotas and diagnostics |
| GET | /api/v1/quotas | Current cached quota cards |
| GET/PATCH | /api/v1/settings | Settings; PATCH includes revision |
| GET/POST | /api/v1/subscriptions | List/create subscriptions |
| PATCH/DELETE | /api/v1/subscriptions/:id | Update/delete |
| POST | /api/v1/subscriptions/:id/send | Queue a manual execution; 202 and execution ID |
| GET/POST | /api/v1/channels | List/create destinations |
| PATCH/DELETE | /api/v1/channels/:id | Update/delete; referenced channels cannot be deleted |
| POST | /api/v1/channels/:id/test | Queue explicit test message; 202 |
| POST | /api/v1/reports/preview | Validate draft, build report and render channel-specific message parts; no job |
| GET | /api/v1/deliveries | Execution records; subscriptionId/status/limit filters |
| GET | /api/v1/deliveries/:id | Execution, frozen report, per-part receipts and events |
| POST | /api/v1/deliveries/:id/retry | Explicit retry of failed/partial/unknown execution |
| POST | /api/v1/deliveries/:id/cancel | End unresolved execution; active request must first finish |

Usage parameters: period, from, to, grouping=account|model, sort, includeCache, showZeroAccounts, fresh=1. Filter parameters providers/accounts/models/agents/sources are JSON arrays. Empty identity arrays mean unrestricted; sources must contain at least one selected source. Account/model IDs returned in facets are opaque JSON tuple strings.

Channel writes contain name/type/config/secret, plus revision for updates. Omitted secret fields retain existing values. GET returns configured, never secret.

Subscriptions use route.primaryChannelId and optional route.backupChannelId. Each content.blocks entry selects its type, period, grouping, fields, sort and optional limit. See examples/subscriptions.example.json for a draft; replace the channel ID with a saved destination. No template evaluation is supported.

Job statuses: pending, building, sending, waiting, sent, failed, partial, unknown, skipped, canceled. A stable execution key de-duplicates scheduled runs. Configuration snapshots and text are frozen for delivery retries.

Errors have an error object with message/code and optional field diagnostics. Validation is 400, forbidden origins 403, invalid token 401, missing resource 404, revision conflicts 409, gateway problems 502.

Quota values preserve the provider's reported units and timestamps. They are independent of historical usage periods. Secrets, prompts, model replies and tool contents are not included in notification reports.

