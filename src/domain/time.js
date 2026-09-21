// 时间与政策周期工具。全部按 +08:00 日历日比较，避免 UTC 偏移把生效日算错。
// 注意：运行环境本地时区不一定是 +08:00，因此先平移到 +08:00 再用 UTC 方法取日历分量。

const TZ = "+08:00";
const SHIFT_MS = 8 * 3600 * 1000;

export function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.length === 10) {
    return new Date(value + "T00:00:00" + TZ);
  }
  return new Date(value);
}

function shifted(value) {
  return new Date(toDate(value).getTime() + SHIFT_MS);
}

function keyOf(d) {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

export function dayKey(value) {
  return keyOf(shifted(value));
}

export function monthKey(value) {
  return dayKey(value).slice(0, 7);
}

export function firstDayOfMonth(value) {
  return monthKey(value) + "-01";
}

export function lastDayOfMonth(value) {
  const d = shifted(value);
  return keyOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** 日期区间是否包含某一天（闭区间）。 */
export function covers(start, end, at) {
  const d = dayKey(at);
  return (!start || d >= start) && (!end || d <= end);
}

/** 两个 [start,end] 日历日区间是否重叠。 */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return (!aEnd || !bStart || aEnd >= bStart) && (!bEnd || !aStart || bEnd >= aStart);
}

/**
 * 证明的有效区间：
 * - LONG_TERM：长期有效（不传 effectiveUntil 即可）
 * - ISSUE_MONTH：仅开具当月有效，跨月即失效
 * 调用方也可直接给出 effectiveFrom/effectiveUntil 覆盖默认口径。
 */
export function materialValidity(materialCfg, doc = {}) {
  const effectiveFrom = doc.effectiveFrom
    || (doc.issuedAt ? dayKey(doc.issuedAt) : null);
  let effectiveUntil = doc.effectiveUntil ?? null;
  if (!effectiveUntil && materialCfg?.validity === "ISSUE_MONTH" && effectiveFrom) {
    effectiveUntil = lastDayOfMonth(effectiveFrom);
  }
  return { effectiveFrom, effectiveUntil };
}

/**
 * 月度项目的政策周期按自然月；事件型救助（临时救助）由受理时给定期次。
 * 返回的 periodStart/periodEnd 为日历日字符串，用于同周期排他判断。
 */
export function programPeriod(program, submittedAt, eventKey = null) {
  const at = toDate(submittedAt);
  if (program.cycle === "MONTHLY") {
    return {
      cycleKey: monthKey(at),
      periodStart: firstDayOfMonth(at),
      periodEnd: lastDayOfMonth(at),
    };
  }
  return {
    cycleKey: `EVT-${eventKey ?? dayKey(at)}`,
    periodStart: dayKey(at),
    periodEnd: eventKey?.match(/^\d{4}-\d{2}-\d{2}$/) ? eventKey : null,
  };
}
