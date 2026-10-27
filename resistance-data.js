/* 电阻窗口统计的独立解析层；不读取或修改原水分/蒸腾归档。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ResistanceData = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const fields = ["meanOhm", "medianOhm", "minOhm", "maxOhm", "stdOhm"];
  const wireFields = ["mean_ohm", "median_ohm", "min_ohm", "max_ohm", "std_ohm"];
  const metricLabels = ["均值(Ω)", "中位数(Ω)", "最小值(Ω)", "最大值(Ω)", "标准差(Ω)"];
  const finite = (value) => value === null || value === undefined || String(value).trim() === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  function dateOf(value) {
    if (value instanceof Date) return Number.isNaN(+value) ? null : new Date(value);
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
      const n = Number(value); const d = new Date(n < 1e12 ? n * 1000 : n); return Number.isNaN(+d) ? null : d;
    }
    let text = String(value).trim();
    const compact = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?Z$/);
    if (compact) text = `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.${(compact[7] || "0").padEnd(3, "0")}Z`;
    // 无时区的表格/筛选时间按北京时间解释，不依赖查看者电脑的时区。
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)) text = text.replace(" ", "T") + "+08:00";
    const d = new Date(text); return Number.isNaN(+d) ? null : d;
  }
  function timeOf(node, fallback) {
    for (const key of ["timestamp", "reported_at", "event_time_ms", "event_time", "time", "beijing_time", "created_at", "ts"]) {
      const time = dateOf(node?.[key]); if (time) return time;
    }
    return dateOf(fallback);
  }
  function displayDevice(value) {
    const text = String(value || "未知设备");
    return text.match(/((?:ER21T|ER81C)[-_]\d+)$/i)?.[1].replace("_", "-").toUpperCase() || text;
  }
  function normalise(row) {
    const time = dateOf(row.time || row.timestamp || row.beijing_time);
    const deviceId = String(row.deviceId || row.device_id || row.device || "未知设备");
    const device = displayDevice(row.device || deviceId);
    const channelNumber = String(row.channel || "").match(/(?:ch[_-]?|通道)?(\d+)$/i)?.[1];
    if (!time || !channelNumber) return null;
    const n = finite(row.sampleCount ?? row.sample_count ?? row.n);
    const record = { time, systemId: "resistance", device, deviceId,
      channel: `CH${String(Number(channelNumber)).padStart(2, "0")}`,
      sampleCount: n !== null && Number.isInteger(n) && n >= 0 ? n : null,
      seq: row.seq ?? row.sample_seq ?? "", messageId: String(row.messageId || row.message_id || ""),
      sourceKey: String(row.sourceKey || row.source_key || ""), unit: "ohm" };
    fields.forEach((key, i) => { record[key] = finite(row[key] ?? row[wireFields[i]]); });
    // n=0 是未采样，不能把原始占位值显示为测得的0Ω。
    if (record.sampleCount === 0) fields.forEach((key) => { record[key] = null; });
    if (record.sampleCount === null && fields.every((key) => record[key] === null)) return null;
    return record;
  }
  function identity(row) {
    return [row.sourceKey || "local", row.deviceId, row.channel, +row.time, row.seq, row.messageId,
      row.sampleCount, ...fields.map((key) => row[key] ?? "null")].join("|");
  }
  function unique(rows) {
    const map = new Map(); rows.forEach((row) => { const item = normalise(row); if (item) map.set(identity(item), item); });
    return [...map.values()].sort((a, b) => +a.time - +b.time || a.device.localeCompare(b.device) || a.channel.localeCompare(b.channel));
  }
  function parse(input, inherited = {}, fallbackTime = null) {
    const rows = [];
    function visit(node, context, depth) {
      if (depth > 24) return;
      if (typeof node === "string") {
        const text = node.trim();
        if (text.startsWith("{") || text.startsWith("[")) { try { visit(JSON.parse(text), context, depth + 1); } catch (_) {} }
        return;
      }
      if (Array.isArray(node)) { node.forEach((item) => { if (typeof item === "object" || typeof item === "string") visit(item, context, depth + 1); }); return; }
      if (!node || typeof node !== "object") return;
      const header = node.header && typeof node.header === "object" ? node.header : {};
      const merged = { ...context, time: timeOf(node, context.time),
        deviceId: node.object_device_id || node.device_id || header.device_id || context.deviceId,
        messageId: node.message_id || header.message_id || context.messageId,
        sourceKey: node.sourceKey || node.source_key || context.sourceKey };
      if (node.content !== undefined && node.id && !/^(?:ER21T|ER81C)[-_]\d+$/i.test(String(node.id))) merged.messageId = String(node.id);
      if (node.channel && (node.systemId === "resistance" || node.system_id === "resistance") &&
          (Object.hasOwn(node, "meanOhm") || Object.hasOwn(node, "mean_ohm"))) {
        const item = normalise({ ...node, time: timeOf(node, merged.time), sourceKey: node.sourceKey || merged.sourceKey });
        if (item) rows.push(item); return;
      }
      if (Array.isArray(node.mean_ohm) && Array.isArray(node.n)) {
        const count = Math.max(node.n.length, ...wireFields.map((key) => Array.isArray(node[key]) ? node[key].length : 0));
        // 保持实际统计，不重算均值/中位数/标准差，也不生成额外通道。
        for (let i = 0; i < count; i += 1) {
          const item = normalise({ time: merged.time, device: node.id || displayDevice(merged.deviceId),
            deviceId: merged.deviceId || node.id, channel: `CH${i + 1}`, sampleCount: node.n[i],
            seq: node.seq, messageId: merged.messageId, sourceKey: merged.sourceKey,
            ...Object.fromEntries(fields.map((key, j) => [key, node[wireFields[j]]?.[i] ?? null])) });
          if (item) rows.push(item);
        }
        return;
      }
      // notify_data的header与body为同级，先把header身份带入body/content。
      const childContext = { ...merged, deviceId: header.device_id || merged.deviceId };
      Object.entries(node).forEach(([key, value]) => {
        if (key !== "header" && (value && typeof value === "object" || typeof value === "string" && ["content", "message", "data", "payload", "body"].includes(key))) visit(value, childContext, depth + 1);
      });
    }
    visit(input, { deviceId: inherited.device_id || inherited.deviceId, messageId: inherited.messageId,
      sourceKey: inherited.source_key || inherited.sourceKey || "", time: timeOf(inherited, fallbackTime) }, 0);
    return unique(rows);
  }
  function splitCsv(line) {
    const out = []; let value = "", quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]; if (ch === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i += 1; } else quoted = !quoted; }
      else if (ch === "," && !quoted) { out.push(value); value = ""; } else value += ch;
    }
    out.push(value); return out;
  }
  function parseCsv(text, context = {}) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
    if (/^sep=,$/i.test(lines[0]?.trim())) lines.shift();
    if (lines.length < 2) return [];
    const headers = splitCsv(lines.shift());
    return unique(lines.map((line) => {
      const cells = splitCsv(line), row = Object.fromEntries(headers.map((key, i) => [key, cells[i] ?? ""]));
      const first = (...keys) => keys.map((key) => row[key]).find((value) => value !== undefined);
      return { time: first("北京时间", "time", "timestamp"), device: first("设备", "device"),
        deviceId: first("设备ID", "device_id", "deviceId"), channel: first("通道", "channel"),
        sampleCount: first("样本数", "sample_count", "sampleCount", "n"),
        ...Object.fromEntries(fields.map((key, i) => [key, first(metricLabels[i], wireFields[i], key)])),
        seq: first("序号", "seq"), messageId: first("消息ID", "messageId"), sourceKey: first("来源对象", "sourceKey") || context.sourceKey || "" };
    }));
  }
  function parseText(text, context = {}, fallback = null) {
    text = String(text).replace(/^\uFEFF/, "");
    try { return parse(JSON.parse(text), context, fallback); } catch (_) {}
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length && lines.every((line) => /^[\s]*[\[{]/.test(line))) {
      try { return unique(lines.flatMap((line) => parse(JSON.parse(line), context, fallback))); } catch (_) {}
    }
    return parseCsv(text, context);
  }
  function beijing(time) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(time));
    const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${String(new Date(time).getMilliseconds()).padStart(3, "0")}`;
  }
  function csv(rows) {
    const headers = ["北京时间", "设备", "设备ID", "通道", "样本数", ...metricLabels, "序号", "消息ID", "来源对象", "单位"];
    const cells = [headers, ...rows.map((r) => [beijing(r.time), r.device, r.deviceId, r.channel, r.sampleCount,
      ...fields.map((key) => r[key]), r.seq, r.messageId, r.sourceKey, "ohm"])];
    const quoted = (cell) => {
      let text = String(cell ?? "");
      // 对外部设备名/来源文本防止Excel公式注入；合法负数测量仍保留数值。
      if (typeof cell === "string" && /^[=+@\t\r-]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    return "sep=,\r\n" + cells.map((row) => row.map(quoted).join(",")).join("\r\n");
  }
  function filter(rows, options = {}) {
    let result = rows.filter((r) => (!options.device || options.device === "__all__" || r.deviceId === options.device) &&
      (!options.channels?.length || options.channels.includes(r.channel)));
    const from = dateOf(options.from), to = dateOf(options.to);
    if (from || to) result = result.filter((r) => (!from || +r.time >= +from) && (!to || +r.time <= +to + (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(options.to) ? 59999 : 0)));
    else if (options.range && options.range !== "all" && result.length) {
      const latest = result.reduce((max, r) => Math.max(max, +r.time), -Infinity);
      const duration = { "1h": 3600000, "24h": 86400000, "7d": 604800000 }[options.range];
      if (duration) result = result.filter((r) => +r.time >= latest - duration);
    }
    return result.sort((a, b) => +a.time - +b.time || a.device.localeCompare(b.device) || a.channel.localeCompare(b.channel));
  }
  return { fields, wireFields, finite, dateOf, normalise, identity, unique, parse, parseCsv, parseText, beijing, csv, filter };
});
