import { Cron } from "croner";
import { dateInZone, shiftDay } from "./periods.mjs";
function localParts(time, zone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .map((p) => [p.type, p.value]),
  );
}
export function localInstant(day, time, zone) {
  const [h, m] = time.split(":").map(Number),
    wanted = Date.parse(day + "T" + time + ":00Z");
  let guess = wanted;
  for (let i = 0; i < 5; i++) {
    const p = localParts(guess, zone);
    const seen = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour,
      +p.minute,
      +p.second,
    );
    const delta = wanted - seen;
    if (!delta) return guess;
    guess += delta;
  }
  // A nonexistent DST time is skipped by the caller; a repeated time chooses the first occurrence.
  const p = localParts(guess, zone);
  return +p.hour === h && +p.minute === m ? guess : null;
}
export function nextRun(
  schedule,
  after,
  timezone = "Asia/Shanghai",
  anchor = after,
) {
  if (schedule.type === "interval") {
    const step = schedule.minutes * 60000;
    return anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  if (schedule.type === "cron") {
    const c = new Cron(schedule.expression, { timezone, paused: true });
    const d = c.nextRun(new Date(after));
    c.stop();
    return d ? d.getTime() : null;
  }
  let day = dateInZone(after, timezone);
  for (let i = 0; i < 740; i++, day = shiftDay(day, 1)) {
    const d = new Date(day + "T12:00:00Z");
    if (schedule.type === "weekly" && d.getUTCDay() !== schedule.weekday)
      continue;
    if (schedule.type === "monthly") {
      const last = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const wanted =
        schedule.day === "last" ? last : Math.min(schedule.day, last);
      if (d.getUTCDate() !== wanted) continue;
    }
    const at = localInstant(day, schedule.time, timezone);
    if (at !== null && at > after) return at;
  }
  return null;
}
export function latestDue(schedule, next, now, zone, anchor) {
  if (schedule.type === "interval") {
    const step = schedule.minutes * 60000;
    return next + Math.floor((now - next) / step) * step;
  }
  if (schedule.type !== "cron") {
    let day = dateInZone(now, zone);
    for (let i = 0; i < 370; i++, day = shiftDay(day, -1)) {
      const d = new Date(day + "T12:00:00Z");
      if (schedule.type === "weekly" && d.getUTCDay() !== schedule.weekday)
        continue;
      if (schedule.type === "monthly") {
        const last = new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
        ).getUTCDate();
        if (
          d.getUTCDate() !==
          (schedule.day === "last" ? last : Math.min(schedule.day, last))
        )
          continue;
      }
      const value = localInstant(day, schedule.time, zone);
      if (value !== null && value >= next && value <= now) return value;
    }
    return next;
  }
  let value = next;
  for (let i = 0; i < 2000; i++) {
    const n = nextRun(schedule, value, zone, anchor);
    if (n === null || n > now) return value;
    value = n;
  }
  // Bound long cron backlogs without iterating every missed minute.
  if (schedule.type === "cron") {
    const c = new Cron(schedule.expression, { timezone: zone, paused: true });
    let cursor = now - 86400000;
    const runs = c.nextRuns(1500, new Date(cursor));
    c.stop();
    const past = runs.map((d) => d.getTime()).filter((t) => t <= now);
    if (past.length) return past.at(-1);
  }
  return value;
}
