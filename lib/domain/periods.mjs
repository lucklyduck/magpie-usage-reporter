import { invariant } from "./errors.mjs";
export const PERIODS = [
  { id: "today", label: "今日" },
  { id: "this-week", label: "本周" },
  { id: "this-month", label: "本月" },
  { id: "previous-week", label: "上周" },
  { id: "previous-month", label: "上月" },
  { id: "7d", label: "近 7 天" },
  { id: "30d", label: "近 30 天" },
  { id: "custom", label: "自选日期" },
];
export function dateInZone(time, zone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(time);
    const p = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return p.year + "-" + p.month + "-" + p.day;
  } catch {
    throw new Error("无效时区：" + zone);
  }
}
export function shiftDay(day, n) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function validDay(day) {
  return (
    typeof day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    !Number.isNaN(Date.parse(day + "T00:00:00Z")) &&
    new Date(day + "T00:00:00Z").toISOString().slice(0, 10) === day
  );
}
export function resolvePeriod(
  id = "today",
  at = Date.now(),
  zone = "Asia/Shanghai",
  custom = {},
) {
  invariant(
    id === "all" || PERIODS.some((x) => x.id === id),
    "不支持的统计周期",
  );
  const today = dateInZone(at, zone);
  let from = today,
    to = today;
  const day = new Date(today + "T12:00:00Z"),
    weekday = (day.getUTCDay() + 6) % 7;
  if (id === "this-week") from = shiftDay(today, -weekday);
  if (id === "previous-week") {
    to = shiftDay(today, -weekday - 1);
    from = shiftDay(to, -6);
  }
  if (id === "this-month") from = today.slice(0, 8) + "01";
  if (id === "previous-month") {
    to = shiftDay(today.slice(0, 8) + "01", -1);
    from = to.slice(0, 8) + "01";
  }
  if (id === "7d" || id === "30d")
    from = shiftDay(today, id === "7d" ? -6 : -29);
  if (id === "all") from = "1970-01-01";
  if (id === "custom") {
    from = custom.from;
    to = custom.to;
    invariant(
      validDay(from) && validDay(to) && from <= to && to <= today,
      "自选日期范围无效",
    );
  }
  return {
    id,
    label: id === "all" ? "全部" : PERIODS.find((x) => x.id === id).label,
    from,
    to,
    timezone: zone,
    gatewayPeriod: from + ".." + to,
    at: new Date(at).toISOString(),
  };
}
