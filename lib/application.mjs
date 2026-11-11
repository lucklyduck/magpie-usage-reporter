import { randomUUID } from "node:crypto";
import { AppError, invariant } from "./domain/errors.mjs";
import {
  validateSettings,
  validateSubscription,
  presets,
  parse,
  filtersSchema,
  SETTING_DEFINITIONS,
} from "./domain/config.mjs";
import { nextRun, latestDue } from "./domain/schedule.mjs";
import { ReportBuilder } from "./domain/report.mjs";
import { accountKey, sum, stats, matches } from "./domain/stats.mjs";
import { capabilities } from "./registry.mjs";
import { renderText, payloads } from "./render/text.mjs";
import { defaultMagpieDisplay, effectiveDisplay } from "./domain/display.mjs";
const DONE = ["sent", "failed", "skipped", "canceled"];
export class Application {
  constructor({
    repository,
    credentials,
    source,
    quotaSource,
    registries,
    displaySource = { load: async () => defaultMagpieDisplay() },
    clock = { now: () => Date.now() },
  }) {
    Object.assign(this, { repository, credentials, source, registries, clock });
    this.displaySource = displaySource;
    this.quotaSource = quotaSource || { load: () => source.quotas() };
    this.owner = randomUUID();
    this.inFlight = null;
    this.started = false;
    this.stopping = false;
    this.lastTick = null;
    this.lastError = "";
    this.leader = false;
    this.lastUsage = new Map();
    this.abort = new AbortController();
    if (!registries.renderers.items.has("text"))
      registries.renderers.add({
        id: "text",
        render: (r, l) => renderText(r, l, registries),
      });
    this.builder = new ReportBuilder({
      usage: source,
      quotas: this.quotaSource,
      registries,
      clock,
    });
  }
  settings() {
    const saved = this.repository.get("settings", "app");
    return saved
      ? {
          ...validateSettings({
            ...saved,
            displayMode: saved.displayMode || "custom",
            chineseUnits: saved.chineseUnits ?? false,
          }),
          ...saved,
          displayMode: saved.displayMode || "custom",
          chineseUnits: saved.chineseUnits ?? false,
        }
      : {
          id: "app",
          revision: 0,
          ...validateSettings({}),
        };
  }
  async display() {
    return effectiveDisplay(this.settings(), await this.displaySource.load());
  }
  saveSettings(value) {
    const prior = this.settings();
    if (value.revision !== undefined && value.revision !== prior.revision)
      throw new AppError("设置已被修改，请刷新", 409, "revision_conflict");
    const s = validateSettings({ ...prior, ...value });
    if (s.preferences) {
      for (const id of s.preferences.columns) this.registries.metrics.get(id);
      this.registries.groupings.get(s.preferences.grouping);
    }
    return this.repository.put(
      "settings",
      { ...s, id: "app" },
      prior.revision || undefined,
    );
  }
  metadata() {
    return {
      uiProtocol: 1,
      ...capabilities(this.registries),
      presets: presets(),
      settingsFields: SETTING_DEFINITIONS.map(({ schema, ...field }) => field),
    };
  }
  status() {
    return {
      running: this.started,
      leader: this.leader,
      processing: Boolean(this.inFlight),
      lastTick: this.lastTick,
      lastError: this.lastError,
      nextRuns: this.repository
        .list("subscriptions")
        .filter((s) => s.enabled)
        .map((s) => ({
          id: s.id,
          name: s.name,
          ...this.repository.runtime("schedule:" + s.id),
        })),
    };
  }
  async usage(query = {}) {
    const settings = this.settings(),
      full = {
        timezone: settings.timezone,
        includeCache: settings.includeCache,
        ...query,
        filters: parse(filtersSchema, query.filters || {}),
      };
    const key = JSON.stringify(full);
    try {
      const [data, quotas] = await Promise.all([
        this.source.load(full),
        this.quotaSource.load(),
      ]);
      const grouping = this.registries.groupings.get(
        query.grouping || "account",
      );
      const groups = grouping.build(data.rows, {
        includeCache: full.includeCache,
        sort: query.sort,
      });
      let selected = quotas.cards.filter(
        (q) =>
          (!full.filters?.providers?.length ||
            full.filters.providers.includes(q.provider)) &&
          (!full.filters?.accounts?.length ||
            full.filters.accounts.includes(accountKey(q.provider, q.account))),
      );
      if (full.filters.models.length || full.filters.agents.length) {
        const ids = new Set(
          data.rows.map((r) => accountKey(r.provider, r.account)),
        );
        selected = selected.filter((q) =>
          ids.has(accountKey(q.provider, q.account)),
        );
      }
      if (
        (query.showZeroAccounts ?? settings.showZeroAccounts) &&
        grouping.id === "account" &&
        !full.filters?.models?.length &&
        !full.filters?.agents?.length
      ) {
        for (const q of selected) {
          let provider = groups.find((g) => g.id === q.provider);
          if (!provider) {
            provider = {
              id: q.provider,
              label: q.providerName,
              children: [],
              ...stats(),
            };
            groups.push(provider);
          }
          if (
            !provider.children.some(
              (a) => a.id === accountKey(q.provider, q.account),
            )
          )
            provider.children.push({
              id: accountKey(q.provider, q.account),
              label: q.accountName,
              kind: "quota-only",
              children: [],
              ...stats(),
            });
        }
      }
      const options = Object.fromEntries(
        Object.entries(data.options).map(([key, items]) => [key, [...items]]),
      );
      for (const q of quotas.cards) {
        if (!options.providers.some((p) => p.id === q.provider))
          options.providers.push({ id: q.provider, label: q.providerName });
        const id = accountKey(q.provider, q.account);
        if (!options.accounts.some((a) => a.id === id))
          options.accounts.push({
            id,
            label: q.providerName + " · " + q.accountName,
            provider: q.provider,
            account: q.account,
          });
      }
      const selectionWarnings = [];
      for (const key of ["providers", "accounts", "models", "agents"]) {
        for (const id of full.filters[key]) {
          if (!options[key].some((item) => item.id === id)) {
            options[key].push({
              id,
              label: id + "（当前周期无记录／已不可用）",
              unavailable: true,
            });
            selectionWarnings.push({
              code: "inactive_filter",
              message: "已保留筛选条件，当前周期无记录或项目已不可用：" + id,
            });
          }
        }
      }
      const result = {
        ...data,
        warnings: [...data.warnings, ...selectionWarnings],
        options,
        grouping: grouping.id,
        groups,
        quotas: { ...quotas, cards: selected },
      };
      this.lastUsage.set(key, result);
      if (this.lastUsage.size > 10)
        this.lastUsage.delete(this.lastUsage.keys().next().value);
      return result;
    } catch (e) {
      const old = this.lastUsage.get(key);
      if (old)
        return {
          ...old,
          stale: true,
          state: "partial",
          warnings: [
            ...old.warnings,
            { message: "刷新失败，当前显示上次读取：" + e.message },
          ],
        };
      throw e;
    }
  }
  async channelList() {
    return Promise.all(
      this.repository.list("channels").map(async (c) => ({
        ...c,
        configured: Object.values(await this.credentials.get(c.id)).some(
          Boolean,
        ),
      })),
    );
  }
  async saveChannel(value, id) {
    const operation = randomUUID(),
      lock = "channel:" + (id || operation);
    if (!this.repository.lease(lock, operation, this.clock.now()))
      throw new AppError("渠道正在修改，请稍后重试", 409, "revision_conflict");
    try {
      const old = id ? this.repository.get("channels", id) : null;
      if (id && !old) throw new AppError("渠道不存在", 404, "not_found");
      invariant(
        typeof value.name === "string" &&
          value.name.trim().length > 0 &&
          value.name.length <= 100,
        "请填写渠道名称",
      );
      const adapter = this.registries.channels.get(value.type);
      if (old) invariant(old.type === value.type, "修改渠道类型请新建渠道");
      const config = adapter.validate
        ? adapter.validate(value.config || {})
        : value.config || {};
      const channel = {
        id: old?.id || randomUUID(),
        name: value.name.trim(),
        type: value.type,
        config,
      };
      if (old && value.revision !== old.revision)
        throw new AppError("渠道已被修改，请刷新", 409, "revision_conflict");
      const previous = await this.credentials.get(channel.id),
        secret = { ...previous };
      if (value.secret && typeof value.secret === "object")
        for (const field of adapter.secretFields || [])
          if (value.secret[field.id] !== undefined)
            secret[field.id] = String(value.secret[field.id]);
      for (const field of adapter.secretFields || [])
        invariant(!field.required || secret[field.id], "请配置 " + field.label);
      await this.credentials.set(channel.id, secret);
      try {
        return {
          ...this.repository.put("channels", channel, old?.revision),
          configured: Object.values(secret).some(Boolean),
        };
      } catch (e) {
        await this.credentials.set(channel.id, previous);
        throw e;
      }
    } finally {
      this.repository.release(lock, operation);
    }
  }
  async deleteChannel(id) {
    invariant(
      !this.repository
        .list("subscriptions")
        .some(
          (s) =>
            s.route.primaryChannelId === id || s.route.backupChannelId === id,
        ),
      "该渠道仍被订阅引用，请先修改订阅",
    );
    invariant(
      !this.repository
        .jobs({ limit: 1000 })
        .some(
          (j) =>
            !DONE.includes(j.status) && j.channels?.some((c) => c?.id === id),
        ),
      "该渠道仍有未完成投递",
    );
    this.repository.remove("channels", id);
    await this.credentials.delete(id);
  }
  subscriptions() {
    return this.repository.list("subscriptions").map((s) => ({
      ...s,
      runtime: this.repository.runtime("schedule:" + s.id),
    }));
  }
  ensureRoute(spec) {
    const p = this.repository.get("channels", spec.route.primaryChannelId),
      b = spec.route.backupChannelId
        ? this.repository.get("channels", spec.route.backupChannelId)
        : null;
    invariant(p, "主渠道不存在");
    if (spec.route.backupChannelId) invariant(b, "备用渠道不存在");
    return [p, ...(b ? [b] : [])];
  }
  saveSubscription(value, id) {
    const old = id ? this.repository.get("subscriptions", id) : null;
    if (id && !old) throw new AppError("订阅不存在", 404, "not_found");
    const spec = validateSubscription(
      { ...value, id: old?.id || value.id },
      this.registries,
    );
    this.ensureRoute(spec);
    const saved = this.repository.put(
      "subscriptions",
      spec,
      old ? value.revision : undefined,
    );
    if (!saved.enabled) this.repository.cancelJobs(saved.id);
    const state = this.repository.runtime("schedule:" + saved.id),
      key = JSON.stringify([saved.schedule, saved.timezone]);
    if (!state || state.key !== key || (!old?.enabled && saved.enabled))
      this.repository.runtime("schedule:" + saved.id, {
        key,
        anchor: this.clock.now(),
        nextAt: nextRun(saved.schedule, this.clock.now(), saved.timezone),
      });
    return saved;
  }
  deleteSubscription(id) {
    this.repository.cancelJobs(id);
    this.repository.remove("subscriptions", id);
  }
  async preview(value) {
    const spec = validateSubscription(value, this.registries),
      channels = this.ensureRoute(spec),
      report = await this.builder.build(spec);
    const text = this.registries.renderers
      .get("text")
      .render(report, spec.content.layout);
    return {
      report,
      text,
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        role: c.id === spec.route.primaryChannelId ? "主渠道" : "备用渠道",
        parts: payloads(
          report,
          text,
          this.registries.channels.get(c.type),
          c.config,
        ),
      })),
    };
  }
  enqueue(
    spec,
    {
      dueAt = this.clock.now(),
      manual = true,
      kind = "report",
      testChannel,
    } = {},
  ) {
    const channels = testChannel ? [testChannel] : this.ensureRoute(spec);
    const now = this.clock.now();
    return this.repository.createJob({
      executionKey: manual ? randomUUID() : spec.id + ":" + dueAt,
      subscriptionId: spec?.id || "",
      subscription: spec,
      channels,
      kind,
      manual,
      dueAt,
      createdAt: now,
      nextAt: now,
      status: "pending",
      stage: 0,
      part: 0,
      attempts: 0,
      buildAttempts: 0,
      receipts: [],
      events: [],
      report: null,
      text: null,
      parts: null,
    });
  }
  manual(id) {
    const spec = this.repository.get("subscriptions", id);
    if (!spec) throw new AppError("订阅不存在", 404, "not_found");
    invariant(
      !this.repository.active(id),
      "该订阅有未完成任务，请先处理发送记录",
    );
    const j = this.enqueue(spec);
    this.kick();
    return j;
  }
  testChannel(id) {
    const c = this.repository.get("channels", id);
    if (!c) throw new AppError("渠道不存在", 404, "not_found");
    const job = this.enqueue(
      { name: "Magpie 通知渠道测试" },
      { kind: "test", testChannel: c },
    );
    this.kick();
    return job;
  }
  retry(id) {
    const j = this.repository.getJob(id);
    if (!j) throw new AppError("记录不存在", 404, "not_found");
    invariant(
      ["unknown", "partial", "failed"].includes(j.status),
      "该状态不能手动重试",
    );
    j.status = "pending";
    j.nextAt = this.clock.now();
    j.attempts = 0;
    if (j.stage >= j.channels.length) j.stage = j.channels.length - 1;
    j.events.push({ at: this.clock.now(), message: "用户明确请求重试" });
    this.repository.saveJob(j);
    this.kick();
    return j;
  }
  cancel(id) {
    const j = this.repository.getJob(id);
    if (!j) throw new AppError("记录不存在", 404, "not_found");
    invariant(!DONE.includes(j.status), "已结束的记录不能取消");
    invariant(j.status !== "sending", "发送进行中，请等待当前请求确认");
    j.status = "canceled";
    this.repository.saveJob(j);
    return j;
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.kick(), 15000);
    this.kick();
  }
  kick() {
    if (this.stopping) return;
    void this.tick().catch((e) => {
      this.lastError = e.message;
    });
  }
  async tick() {
    const now = this.clock.now();
    if (this.stopping) return;
    this.leader = this.repository.lease("worker", this.owner, now);
    this.lastTick = new Date(now).toISOString();
    if (!this.leader || this.inFlight) return;
    if (!this.recovered) {
      this.repository.recover();
      this.recovered = true;
    }
    this.inFlight = this.run(now);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
  async run(now) {
    for (const s of this.repository.list("subscriptions")) {
      if (!s.enabled) continue;
      const key = JSON.stringify([s.schedule, s.timezone]);
      let state = this.repository.runtime("schedule:" + s.id);
      if (!state || state.key !== key)
        state = {
          key,
          anchor: now,
          nextAt: nextRun(s.schedule, now, s.timezone),
        };
      if (
        state.nextAt != null &&
        state.nextAt <= now &&
        !this.repository.active(s.id)
      ) {
        const due = latestDue(
          s.schedule,
          state.nextAt,
          now,
          s.timezone,
          state.anchor,
        );
        if (s.catchUp === "skip" && now - due > 60000) {
          const j = this.enqueue(s, { dueAt: due, manual: false });
          j.status = "skipped";
          j.lastError = "已按配置跳过错过的执行";
          this.repository.saveJob(j);
        } else this.enqueue(s, { dueAt: due, manual: false });
        state.nextAt = nextRun(s.schedule, now, s.timezone, state.anchor);
      }
      this.repository.runtime("schedule:" + s.id, state);
    }
    for (const job of this.repository.jobs({ due: now, limit: 20 }).reverse()) {
      if (
        this.stopping ||
        !this.repository.owns("worker", this.owner, this.clock.now())
      )
        break;
      await this.deliver(job);
    }
    this.repository.prune(this.settings().historyDays, now);
  }
  async deliver(job) {
    const now = () => this.clock.now();
    if (!job.report) {
      try {
        job.status = "building";
        this.repository.saveJob(job);
        job.report =
          job.kind === "test"
            ? {
                id: job.id,
                title: "Magpie 通知渠道测试",
                generatedAt: new Date(now()).toISOString(),
                timezone: this.settings().timezone,
                currency: "USD",
                usdCny: 0,
                blocks: [
                  {
                    title: "连接测试",
                    lines: ["这是一条由你手动发送的测试消息。"],
                  },
                ],
                warnings: [],
                empty: false,
              }
            : await this.builder.build(job.subscription, job.dueAt);
        job.report.id = job.id;
        if (job.report.empty && job.subscription.skipEmpty) {
          job.status = "skipped";
          job.lastError = "选中的所有区块均为空";
          this.repository.saveJob(job);
          return;
        }
        job.text = this.registries.renderers
          .get("text")
          .render(job.report, job.subscription.content?.layout || "list");
        if (this.repository.getJob(job.id)?.status === "canceled") return;
      } catch (e) {
        if (this.repository.getJob(job.id)?.status === "canceled") return;
        job.buildAttempts++;
        job.lastError = e.message;
        job.events.push({ at: now(), message: "报告生成失败：" + e.message });
        job.status = job.buildAttempts >= 3 ? "failed" : "waiting";
        job.nextAt =
          now() + [30000, 120000, 300000][Math.min(job.buildAttempts - 1, 2)];
        this.repository.saveJob(job);
        return;
      }
    }
    while (!this.stopping) {
      const channel = job.channels[job.stage],
        adapter = this.registries.channels.get(channel.type);
      job.parts ??= payloads(job.report, job.text, adapter, channel.config);
      if (job.part >= job.parts.length) {
        job.status = "sent";
        job.sentAt = now();
        job.lastError = "";
        this.repository.saveJob(job);
        return;
      }
      if (!this.repository.owns("worker", this.owner, now())) return;
      const current = this.repository.getJob(job.id);
      if (current?.status === "canceled") return;
      if (current?.cancelRequested) {
        job.status = "canceled";
        job.lastError = "订阅暂停后结束剩余投递";
        this.repository.saveJob(job);
        return;
      }
      job.status = "sending";
      this.repository.saveJob(job);
      let result;
      let secret;
      try {
        secret = await this.credentials.get(channel.id);
      } catch {
        result = {
          outcome: "permanent",
          message: "无法读取渠道凭据，未发出请求",
        };
      }
      if (!result)
        try {
          result = await adapter.send(
            channel.config,
            secret,
            job.parts[job.part],
            { signal: this.abort.signal },
          );
        } catch {
          result = { outcome: "unknown", message: "发送未能取得明确确认" };
        }
      job.cancelRequested =
        this.repository.getJob(job.id)?.cancelRequested || false;
      job.events.push({
        at: now(),
        channelId: channel.id,
        part: job.part,
        outcome: result.outcome,
        message: result.message,
      });
      if (result.outcome === "success") {
        job.receipts.push({
          channelId: channel.id,
          part: job.part,
          receipt: result.receipt,
          at: now(),
        });
        job.part++;
        job.attempts = 0;
        job.status = "pending";
        this.repository.saveJob(job);
        continue;
      }
      job.lastError = result.message;
      if (result.outcome === "unknown") {
        job.status = "unknown";
        this.repository.saveJob(job);
        return;
      }
      job.attempts++;
      if (result.outcome === "retryable" && job.attempts < 3) {
        job.status = "waiting";
        job.nextAt =
          now() +
          Math.max(result.retryAfter || 0, [5000, 30000][job.attempts - 1]);
        this.repository.saveJob(job);
        return;
      }
      if (job.part === 0 && job.stage === 0 && job.channels.length > 1) {
        job.stage = 1;
        job.part = 0;
        job.parts = null;
        job.attempts = 0;
        job.status = "pending";
        this.repository.saveJob(job);
        continue;
      }
      job.status = job.part > 0 ? "partial" : "failed";
      this.repository.saveJob(job);
      return;
    }
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.abort.abort();
    await this.inFlight?.catch(() => {});
    this.repository.release("worker", this.owner);
    this.started = false;
  }
}
