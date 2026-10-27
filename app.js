(() => {
  "use strict";

  const state = { records: [], filtered: [], fileName: "", lastAdded: 0, lastSkipped: 0 };
  const palette = ["#356df3", "#0ea5a3", "#f08a24", "#9257d8", "#df5576", "#4e9f3d", "#e05d44", "#178ca8", "#7357c7", "#b7791f", "#217a72", "#ba4b93"];
  const CLOUD_OBS_ENDPOINT = "https://sensor-1.obs.cn-east-3.myhuaweicloud.com";
  const CLOUD_OBS_PREFIX = "sensor_data/";
  const $ = (id) => document.getElementById(id);
  const els = { canvas: $("trendChart"), empty: $("emptyState"), legend: $("legend"), system: $("systemSelect"), device: $("deviceSelect"), sensorType: $("sensorTypeSelect"), channel: $("channelSelect"), range: $("rangeSelect"), from: $("fromTime"), to: $("toTime"), mode: $("chartMode") };
  const DB_NAME = "iotda-sensor-archive";
  const DB_VERSION = 1;
  const STORE_NAME = "records";

  function openArchive() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("当前浏览器不支持本机归档")); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE_NAME, { keyPath: "id" }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开本机归档"));
    });
  }

  function archiveId(record) {
    const base = [record.systemId, record.sensorType, record.device, record.sensorId, record.channel, record.seq, record.validMask, record.value].join("|");
    // 云端对象名是稳定的；同一个对象重复刷新时必须命中同一个归档编号。
    if (record.sourceKey) return `cloud|${record.sourceKey}|${base}`;
    // 兼容旧版没有 sourceKey 的本机记录：只在两分钟窗口内合并完全相同的旧记录。
    return `legacy|${base}|${Math.floor(record.time.getTime() / 120000)}`;
  }

  function dedupeRecords(records) {
    const unique = new Map();
    records.forEach((record) => { const item = normaliseRecord(record); if (!Number.isNaN(item.time.getTime()) && item.channel && Number.isFinite(item.value)) unique.set(archiveId(item), item); });
    return [...unique.values()];
  }

  async function appendArchive(records) {
    const db = await openArchive();
    records = records.map(normaliseRecord).filter((record) => !Number.isNaN(record.time.getTime()) && record.channel && Number.isFinite(record.value));
    const oldRows = await new Promise((resolve, reject) => { const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const existingRecords = dedupeRecords(oldRows);
    const seen = new Set(existingRecords.map((record) => archiveId(record)));
    const fresh = [];
    records.forEach((record) => { const id = archiveId(record); if (!seen.has(id)) { seen.add(id); fresh.push(record); } });
    const all = dedupeRecords([...existingRecords, ...records]);
    // 重写一次归档表，同时把旧版重复记录压缩掉，避免刷新一次就越积越多。
    await new Promise((resolve, reject) => { const transaction = db.transaction(STORE_NAME, "readwrite"); const store = transaction.objectStore(STORE_NAME); store.clear(); all.forEach((record) => store.put({ ...record, id: archiveId(record), time: record.time.getTime() })); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    db.close();
    state.lastAdded = fresh.length; state.lastSkipped = records.length - fresh.length;
  }

  async function rewriteArchive(records) {
    const db = await openArchive();
    const unique = dedupeRecords(records);
    await new Promise((resolve, reject) => { const transaction = db.transaction(STORE_NAME, "readwrite"); const store = transaction.objectStore(STORE_NAME); store.clear(); unique.forEach((record) => store.put({ ...record, id: archiveId(record), time: record.time.getTime() })); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    db.close();
    return unique;
  }

  async function deleteArchiveWhere(predicate) {
    const db = await openArchive();
    const rows = await new Promise((resolve, reject) => { const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const before = dedupeRecords(rows);
    const kept = before.filter((record) => !predicate(record));
    await rewriteArchive(kept);
    return before.length - kept.length;
  }

  async function clearArchive() {
    const db = await openArchive();
    const count = await new Promise((resolve, reject) => { const transaction = db.transaction(STORE_NAME, "readwrite"); const store = transaction.objectStore(STORE_NAME); const request = store.count(); request.onsuccess = () => { store.clear(); }; transaction.oncomplete = () => resolve(request.result || 0); transaction.onerror = () => reject(transaction.error); });
    db.close();
    return count;
  }

  async function readArchive() {
    const db = await openArchive();
    const rows = await new Promise((resolve, reject) => { const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    return dedupeRecords(rows.map((row) => ({ ...row, time: new Date(row.time) })));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function canonicalDevice(value) {
    const text = String(value ?? "未命名设备").trim() || "未命名设备";
    const suffix = text.match(/((?:capnode|transnode|trans[-_]?gw|gw)[-_]\d{3})$/i);
    return suffix ? suffix[1].replace("_", "-").toLowerCase() : text;
  }

  function globalSensorId(device, channel) {
    const localMatch = String(channel || "").match(/(?:cap_|channel[_-]?)(\d{1,2})$/i);
    if (!localMatch) return String(channel || "未知通道");
    const localNumber = Number(localMatch[1]);
    const boardMatch = String(device || "").match(/(?:capnode|transnode)-(\d{3})$/i);
    const number = boardMatch ? (Number(boardMatch[1]) - 1) * 10 + localNumber : localNumber;
    return `sensor_${String(number).padStart(3, "0")}`;
  }

  function sensorTypeFor(sensorId, channel, systemId = "water") {
    // 水分系统的 30 个通道全部都是水分；只有蒸腾系统才按奇偶通道区分水分/湿度。
    if (systemIdFor(systemId) !== "transpiration") return "moisture";
    const idMatch = String(sensorId || "").match(/(?:sensor[_-]?)?(\d{1,3})$/i);
    const channelMatch = String(channel || "").match(/(?:cap_|channel[_-]?)(\d{1,2})$/i);
    const number = idMatch ? Number(idMatch[1]) : Number(channelMatch?.[1] || 1);
    return number % 2 === 0 ? "humidity" : "moisture";
  }

  function sensorTypeLabel(type) { return type === "humidity" ? "湿度" : "水分"; }

  function systemIdFor(value) {
    const text = String(value || "").toLowerCase();
    if (/transpiration|trans[_-]?node|trans[_-]?gw|transpirationsensors|蒸腾系统|蒸腾/.test(text)) return "transpiration";
    return "water";
  }

  function systemIdFromContext(context = {}) {
    const hints = [
      context.system_id, context.systemId, context.service_id, context.serviceId,
      context.service_type, context.serviceType, context.device_id, context.deviceId,
      context.node_id, context.nodeId, context.device, context.source_key, context.sourceKey,
    ].filter((value) => value !== undefined && value !== null && String(value).trim());
    return systemIdFor(hints.join("|"));
  }

  function systemLabel(systemId) { return systemIdFor(systemId) === "transpiration" ? "蒸腾系统" : "水分系统"; }

  function sensorDisplayName(record) { return `${sensorTypeLabel(record.sensorType)}_${record.sensorId}`; }

  function normaliseRecord(record) {
    const time = record.time instanceof Date ? record.time : new Date(record.time);
    const device = canonicalDevice(record.device); const channel = String(record.channel || "").toLowerCase();
    const sourceKey = String(record.sourceKey || record.source_key || "");
    const systemId = systemIdFor([record.systemId, record.system_id, record.serviceId, record.service_id, record.device, sourceKey].filter(Boolean).join("|"));
    const sensorId = record.sensorId || globalSensorId(device, channel);
    const sensorType = systemId === "transpiration"
      ? (importedSensorType(record.sensorType || record.sensor_type) || sensorTypeFor(sensorId, channel, systemId))
      : "moisture";
    return { time, systemId, device, channel, sensorId, sensorType, value: Number(record.value), seq: record.seq ?? "", validMask: record.validMask ?? "", sourceKey };
  }

  function parseBeijingInput(value, endOfMinute = false) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second = "0"] = match;
    const base = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - 8 * 3600000;
    return new Date(base + (endOfMinute && !match[6] ? 59999 : 0));
  }

  function timestampOf(obj, fallback) {
    const candidates = [obj?.timestamp, obj?.time, obj?.reported_at, obj?.event_time, obj?.created_at, obj?.ts];
    for (const value of candidates) {
      if (value === undefined || value === null || value === "") continue;
      if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
        const n = Number(value);
        return new Date(n < 1e12 ? n * 1000 : n);
      }
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date;
    }
    return new Date(fallback);
  }

  function timestampFromObjectKey(key) {
    const match = String(key || "").match(/_(\d{14})(\d{3})?_\d+$/);
    if (!match) return null;
    const stamp = match[1];
    const milliseconds = Number(match[2] || "0");
    const date = new Date(Date.UTC(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)), Number(stamp.slice(8, 10)), Number(stamp.slice(10, 12)), Number(stamp.slice(12, 14)), milliseconds));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function addProperties(records, properties, context, fallbackTime) {
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
    const time = timestampOf(context, fallbackTime);
    const device = canonicalDevice(context.device_id || context.deviceId || context.node_id || context.nodeId || context.device || "未命名设备");
    const seq = context.sample_seq ?? context.sampleSeq ?? "";
    const validMask = context.valid_mask ?? context.validMask ?? "";
    for (const [key, raw] of Object.entries(properties)) {
      if (!/^cap_\d+$/i.test(key) && !/^channel[_-]?\d+$/i.test(key)) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const channel = key.toLowerCase().replace(/^channel[_-]?/i, "cap_");
      records.push({ time: new Date(time), systemId: systemIdFromContext(context), device: String(device), channel, value, seq, validMask, sourceKey: context.source_key || "" });
    }
  }

  function parseJson(input, inherited = {}, fallbackTime = Date.now()) {
    const records = [];
    const visit = (node, inherited = {}) => {
      if (Array.isArray(node)) { node.forEach((item) => visit(item, inherited)); return; }
      if (!node || typeof node !== "object") return;
      const context = { ...inherited, ...node };
      if (node.devices && Array.isArray(node.devices)) {
        node.devices.forEach((device) => visit(device, context));
        return;
      }
      if (node.devices && typeof node.devices === "object" && !Array.isArray(node.devices)) {
        Object.entries(node.devices).forEach(([deviceId, device]) => visit(device, { ...context, device_id: deviceId }));
        return;
      }
      if (node.services && Array.isArray(node.services)) {
        node.services.forEach((service) => visit(service, context));
        return;
      }
      if (node.sensors && typeof node.sensors === "object" && !Array.isArray(node.sensors)) {
        Object.entries(node.sensors).forEach(([sensorId, sensor]) => {
          const samples = Array.isArray(sensor?.samples) ? sensor.samples : [];
          samples.forEach((sample) => records.push({ time: timestampOf(sample, fallbackTime), systemId: systemIdFromContext(context), device: canonicalDevice(context.device_id || context.deviceId || context.node_id || context.nodeId || context.device), channel: sensor.source_channel || sensor.channel || sensorId, sensorId, value: Number(sample.value), seq: sample.sample_seq ?? "", validMask: sample.valid_mask ?? "", sourceKey: context.source_key || "" }));
        });
        return;
      }
      if (node.properties && typeof node.properties === "object") addProperties(records, node.properties, context, fallbackTime);
      const wideKeys = Object.keys(node).filter((key) => /^cap_\d+$/i.test(key));
      if (wideKeys.length) addProperties(records, node, context, fallbackTime);
      if (!node.properties && !wideKeys.length) {
        for (const value of Object.values(node)) if (value && typeof value === "object") visit(value, context);
      }
    };
    visit(input, inherited);
    return records;
  }

  function splitCsv(line) {
    const cells = []; let current = ""; let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"' && quoted) { current += '"'; i += 1; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (char === "," && !quoted) { cells.push(current.trim()); current = ""; } else current += char;
    }
    cells.push(current.trim());
    return cells;
  }

  function importedSensorType(value) {
    const text = String(value || "").toLowerCase();
    if (/humidity|湿度/.test(text)) return "humidity";
    if (/moisture|水分/.test(text)) return "moisture";
    return "";
  }

  function decodeImportedBytes(buffer) {
    const raw = new Uint8Array(buffer);
    if (raw[0] === 0xff && raw[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
    if (raw[0] === 0xfe && raw[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
    let text = new TextDecoder("utf-8").decode(buffer);
    if (text.includes("\uFFFD")) text = new TextDecoder("gb18030").decode(buffer);
    return text;
  }

  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    // Excel/华为云导出的 CSV 可能用第一行 sep=, 声明分隔符；它不是表头。
    if (lines.length && /^\s*sep\s*=\s*,\s*$/i.test(lines[0])) lines.shift();
    if (lines.length < 2) return [];
    const headers = splitCsv(lines[0]).map((header) => header.toLowerCase().replace(/[\s-]/g, "_"));
    const find = (...names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0);
    const timeIndex = find("timestamp", "time", "reported_at", "event_time", "日期", "时间");
    const deviceIndex = find("device_id", "deviceid", "device", "node_id", "设备");
    const channelIndex = find("channel", "property", "property_name", "channel_name", "通道");
    const valueIndex = find("value", "data", "数值", "值");
    const systemIndex = find("system", "system_id", "系统");
    const sensorTypeIndex = find("type", "sensor_type", "类型");
    const sensorIdIndex = find("sensor_id", "sensorid", "global_sensor_id", "全局编号");

    // 兼容本项目导出的五列无表头格式：
    // 时间、系统、类型、全局编号、数值（前面可能还有 sep=,）。
    const firstCells = splitCsv(lines[0]);
    const looksLikeHeader = [timeIndex, deviceIndex, channelIndex, valueIndex, systemIndex, sensorTypeIndex, sensorIdIndex]
      .some((index) => index !== undefined);
    if (!looksLikeHeader && firstCells.length >= 5 && !Number.isNaN(Date.parse(firstCells[0]))) {
      return lines.map((line, rowIndex) => {
        const cells = splitCsv(line);
        if (cells.length < 5) return null;
        const value = Number(cells[4]);
        if (!Number.isFinite(value)) return null;
        const sensorId = String(cells[3] || "").trim().toLowerCase();
        if (!sensorId) return null;
        const systemId = systemIdFor(cells[1]);
        const sensorNumber = Number(sensorId.match(/(?:sensor[_-]?)(\d{1,3})$/i)?.[1] || 0);
        const boardPrefix = systemId === "transpiration" ? "transnode" : "capnode";
        const device = sensorNumber >= 1 && sensorNumber <= 30
          ? `${boardPrefix}-${String(Math.ceil(sensorNumber / 10)).padStart(3, "0")}`
          : "";
        return {
          time: timestampOf({ timestamp: cells[0] }, Date.now() + rowIndex * 1000),
          systemId,
          sensorType: importedSensorType(cells[2]),
          device,
          channel: sensorId,
          sensorId,
          value,
          seq: "",
          validMask: "",
        };
      }).filter(Boolean);
    }

    const records = [];
    lines.slice(1).forEach((line, rowIndex) => {
      const cells = splitCsv(line); const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
      const device = canonicalDevice(deviceIndex === undefined ? (row.device_id || row.device || "未命名设备") : cells[deviceIndex]);
      const time = timestampOf(timeIndex === undefined ? {} : { timestamp: cells[timeIndex] }, Date.now() + rowIndex * 1000);
      const wide = headers.filter((header) => /^cap_\d+$/i.test(header));
      const seq = row.sample_seq || row.seq || ""; const validMask = row.valid_mask || row.validmask || "";
      if (wide.length) wide.forEach((channel) => { const value = Number(row[channel]); if (Number.isFinite(value)) records.push({ time, device, channel, value, seq, validMask }); });
      else if (channelIndex !== undefined && valueIndex !== undefined) {
        const value = Number(cells[valueIndex]);
        if (Number.isFinite(value)) records.push({
          time,
          systemId: systemIdFor(systemIndex === undefined ? (row.system_id || row.system || "water") : cells[systemIndex]),
          sensorType: sensorTypeIndex === undefined ? "" : importedSensorType(cells[sensorTypeIndex]),
          sensorId: sensorIdIndex === undefined ? "" : String(cells[sensorIdIndex]).trim().toLowerCase(),
          device,
          channel: String(cells[channelIndex]).toLowerCase(),
          value,
          seq,
          validMask,
        });
      }
    });
    return records;
  }

  // 华为云事件时间和OBS对象名使用UTC；看板统一按中国标准时间（UTC+8）显示。
  function formatTime(date) {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function formatBeijingDateTime(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}.${milliseconds}`;
  }
  function formatNumber(value) { return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 6 }); }
  function setStatus(text, ready = false) { $("dataStatus").textContent = text; $("dataStatus").previousElementSibling.classList.toggle("ready", ready); }
  function selectedSensors() { return [...els.channel.selectedOptions].map((option) => option.value); }

  function loadRecords(records, source) {
    state.records = records.map(normaliseRecord).filter((record) => !Number.isNaN(record.time.getTime()) && record.channel && Number.isFinite(record.value));
    state.fileName = source || "未命名数据";
    updateSelects(); updateView();
    setStatus(`${state.records.length} 个数据点`, state.records.length > 0);
    $("sourceHint").textContent = `当前显示：${state.fileName}。导入文件会追加到本机归档，按“板卡 / 通道”去重保存。`;
  }

  async function archiveImportedRecords(records, source, displayRecords = null) {
    await appendArchive(records);
    const all = await readArchive();
    loadRecords(displayRecords || all, displayRecords ? source : "本机归档");
    $("sourceHint").textContent = `已从 ${source} 归档：新增 ${state.lastAdded} 条，重复跳过 ${state.lastSkipped} 条。当前共 ${all.length} 条。`;
  }

  async function loadCloudRecords() {
    // OBS 列表按对象名从旧到新返回；单次最多 1000 个对象。数据量超过 1000
    // 后，如果不使用 marker 翻页，看板会永远停在较早的日期，读不到最新数据。
    const allKeys = [];
    let marker = "";
    let page = 0;
    while (true) {
      page += 1;
      const params = new URLSearchParams({ prefix: CLOUD_OBS_PREFIX, "max-keys": "1000" });
      if (marker) params.set("marker", marker);
      const listResponse = await fetch(`${CLOUD_OBS_ENDPOINT}/?${params.toString()}`, { cache: "no-store" });
      if (!listResponse.ok) throw new Error(`OBS 列举对象失败（HTTP ${listResponse.status}）`);
      const xmlText = await listResponse.text();
      const xml = new DOMParser().parseFromString(xmlText, "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("OBS 返回的对象列表不是有效 XML");
      const pageKeys = [...xml.getElementsByTagName("Key")].map((node) => node.textContent.trim()).filter((key) => key && !key.endsWith("/"));
      allKeys.push(...pageKeys);
      const truncated = xml.getElementsByTagName("IsTruncated")[0]?.textContent?.trim().toLowerCase() === "true";
      const nextMarker = xml.getElementsByTagName("NextMarker")[0]?.textContent?.trim() || pageKeys.at(-1) || "";
      if (!truncated || !nextMarker || nextMarker === marker) break;
      marker = nextMarker;
      $("sourceHint").textContent = "正在列出华为云历史对象：第 " + page + " 页，已找到 " + allKeys.length + " 个对象…";
    }
    const keys = [...new Set(allKeys)];
    if (!keys.length) throw new Error(`OBS 的 ${CLOUD_OBS_PREFIX} 目录中没有可读取的数据对象`);
    const results = [];
    const batchSize = 20;
    for (let start = 0; start < keys.length; start += batchSize) {
      const batch = keys.slice(start, start + batchSize);
      const batchResults = await Promise.all(batch.map(async (key) => {
      const response = await fetch(`${CLOUD_OBS_ENDPOINT}/${key.split("/").map(encodeURIComponent).join("/")}`, { cache: "no-store" });
      if (!response.ok) {
        if (response.status === 403) throw new Error(`读取对象失败：${key}（HTTP 403）。该对象可能使用了 SSE-KMS 加密，公共读网页无法匿名读取。`);
        throw new Error(`读取对象失败：${key}（HTTP ${response.status}）`);
      }
      const text = decodeImportedBytes(await response.arrayBuffer()).replace(/^\uFEFF/, "");
      const deviceMatch = key.match(/(?:^|_)((?:capnode|transnode)[-_]\d{3})(?:_|$)/i);
      const sourceContext = { ...(deviceMatch ? { device_id: deviceMatch[1] } : {}), system_id: systemIdFor(key), source_key: key };
      const fallbackTime = timestampFromObjectKey(key)?.getTime() || Date.now();
      try { return parseJson(JSON.parse(text), sourceContext, fallbackTime); } catch (jsonError) {
        try { return text.split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => parseJson(JSON.parse(line), sourceContext, fallbackTime)); }
        catch (lineJsonError) { return parseCsv(text).map((record) => ({ ...record, sourceKey: key, time: record.time || new Date(fallbackTime), device: record.device === "未命名设备" ? (sourceContext.device_id || record.device) : record.device })); }
      }
      }));
      results.push(...batchResults);
      $("sourceHint").textContent = "正在读取华为云数据：" + Math.min(start + batch.length, keys.length) + "/" + keys.length + " 个对象…";
    }
    const records = results.flat();
    if (!records.length) throw new Error("已读取 OBS 文件，但没有识别到 cap_01 到 cap_10 的传感器数据");
    // 云端刷新后显示本机归档中的全部历史，不再只显示本次请求得到的那一批。
    await archiveImportedRecords(records, "华为云 OBS");
  }

  async function showArchive() {
    const all = await readArchive();
    if (!all.length) { alert("本机归档还是空的，请先导入华为云数据文件。"); return; }
    loadRecords(all, "本机归档");
    $("sourceHint").textContent = `已读取本机归档，共 ${all.length} 条；数据按板卡和通道独立保存。`;
  }

  function updateSelects() {
    const oldSystem = els.system.value; const oldDevice = els.device.value; const oldType = els.sensorType.value; const oldChannels = selectedSensors();
    const systems = [...new Set(state.records.map((record) => record.systemId))].sort();
    const devices = [...new Set(state.records.map((record) => record.device))].sort();
    const types = [...new Set(state.records.map((record) => record.sensorType))].sort();
    const sensors = [...new Set(state.records.map((record) => record.sensorId))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    els.system.innerHTML = `<option value="__all__">全部系统</option>${systems.map((system) => `<option value="${escapeHtml(system)}">${systemLabel(system)}</option>`).join("")}`;
    els.device.innerHTML = `<option value="__all__">全部设备</option>${devices.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("")}`;
    els.sensorType.innerHTML = `<option value="__all__">全部类型</option>${types.map((type) => `<option value="${escapeHtml(type)}">${sensorTypeLabel(type)}</option>`).join("")}`;
    els.channel.innerHTML = sensors.map((sensor) => `<option value="${escapeHtml(sensor)}">${escapeHtml(sensor)}</option>`).join("");
    if (systems.includes(oldSystem)) els.system.value = oldSystem;
    if (devices.includes(oldDevice)) els.device.value = oldDevice;
    if (types.includes(oldType)) els.sensorType.value = oldType;
    [...els.channel.options].forEach((option) => { option.selected = oldChannels.includes(option.value); });
  }

  function filteredRecords() {
    let records = state.records.slice(); const system = els.system.value; const device = els.device.value; const sensorType = els.sensorType.value; const channels = selectedSensors();
    if (system !== "__all__") records = records.filter((record) => record.systemId === system);
    if (device !== "__all__") records = records.filter((record) => record.device === device);
    if (sensorType !== "__all__") records = records.filter((record) => record.sensorType === sensorType);
    if (channels.length) records = records.filter((record) => channels.includes(record.sensorId));
    const from = parseBeijingInput(els.from.value); const to = parseBeijingInput(els.to.value, true);
    if (from || to) {
      if (from) records = records.filter((record) => record.time >= from);
      if (to) records = records.filter((record) => record.time <= to);
    } else {
      const range = els.range.value;
      if (range !== "all" && records.length) { const latest = Math.max(...records.map((record) => record.time.getTime())); const duration = { "1h": 3600000, "24h": 86400000, "7d": 604800000 }[range]; records = records.filter((record) => record.time.getTime() >= latest - duration); }
    }
    return records.sort((a, b) => a.time - b.time);
  }

  function seriesFor(records) {
    const mode = els.mode.value; const groups = new Map(); const channels = selectedSensors();
    records.forEach((record) => { const key = mode === "all" || channels.length !== 1 ? `${systemLabel(record.systemId)} · ${record.device} · ${sensorDisplayName(record)}` : `${systemLabel(record.systemId)} · ${record.device}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record); });
    return [...groups.entries()].map(([name, values]) => ({ name, values }));
  }

  function drawChart(records) {
    const canvas = els.canvas; const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; const width = Math.max(320, Math.floor(rect.width)); const height = Math.max(280, Math.floor(rect.height));
    canvas.width = width * dpr; canvas.height = height * dpr; const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    els.empty.style.display = records.length ? "none" : "grid"; els.legend.innerHTML = "";
    if (!records.length) return;
    const series = seriesFor(records).slice(0, 40); const times = records.map((record) => record.time.getTime()); const values = records.map((record) => record.value); let min = Math.min(...values); let max = Math.max(...values); const pad = Math.max((max - min) * .12, .5); min -= pad; max += pad;
    const margin = { left: 55, right: 22, top: 22, bottom: 42 }; const plotW = width - margin.left - margin.right; const plotH = height - margin.top - margin.bottom; const tMin = Math.min(...times); const tMax = Math.max(...times) || tMin + 1;
    const x = (time) => margin.left + ((time - tMin) / (tMax - tMin || 1)) * plotW; const y = (value) => margin.top + (1 - (value - min) / (max - min || 1)) * plotH;
    ctx.font = "12px Microsoft YaHei, sans-serif"; ctx.lineWidth = 1; ctx.strokeStyle = "#e9edf4"; ctx.fillStyle = "#8a95a8";
    for (let i = 0; i <= 4; i += 1) { const yy = margin.top + (plotH * i) / 4; ctx.beginPath(); ctx.moveTo(margin.left, yy); ctx.lineTo(width - margin.right, yy); ctx.stroke(); ctx.fillText(formatNumber(max - ((max - min) * i) / 4), 8, yy + 4); }
    const xLabels = Math.min(5, Math.max(2, Math.floor(width / 170))); for (let i = 0; i < xLabels; i += 1) { const xx = margin.left + (plotW * i) / (xLabels - 1); const time = new Date(tMin + ((tMax - tMin) * i) / (xLabels - 1)); ctx.fillText(formatTime(time), xx - 25, height - 15); }
    series.forEach((item, index) => { const color = palette[index % palette.length]; ctx.beginPath(); item.values.forEach((record, pointIndex) => { const xx = x(record.time.getTime()); const yy = y(record.value); if (pointIndex === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); }); ctx.strokeStyle = color; ctx.lineWidth = series.length > 18 ? 1.2 : 2.1; ctx.stroke(); if (item.values.length < 80) item.values.forEach((record) => { ctx.beginPath(); ctx.fillStyle = color; ctx.arc(x(record.time.getTime()), y(record.value), 2.5, 0, Math.PI * 2); ctx.fill(); }); els.legend.insertAdjacentHTML("beforeend", `<span class="legend-item"><i class="legend-swatch" style="background:${color}"></i>${escapeHtml(item.name)}</span>`); });
  }

  function updateTable(records) {
    // 表格展示当前筛选范围内的完整历史，而不是把同一通道压成一条“最新读数”。
    const rows = records.slice().sort((a, b) => b.time - a.time || a.device.localeCompare(b.device) || a.channel.localeCompare(b.channel));
    $("tableCount").textContent = `${rows.length} 条`;
    $("latestTable").innerHTML = rows.length ? rows.map((record) => `<tr><td><input class="record-check" type="checkbox" data-record-key="${encodeURIComponent(archiveId(record))}" aria-label="选择 ${escapeHtml(sensorDisplayName(record))} ${escapeHtml(formatTime(record.time))}"></td><td>${escapeHtml(systemLabel(record.systemId))}</td><td>${escapeHtml(sensorTypeLabel(record.sensorType))}</td><td class="value">${escapeHtml(record.sensorId)}</td><td>${escapeHtml(record.device)}</td><td>${escapeHtml(record.channel)}</td><td class="value">${escapeHtml(formatNumber(record.value))}</td><td>${escapeHtml(formatTime(record.time))}</td><td>${escapeHtml(record.seq || "—")}</td></tr>`).join("") : `<tr><td colspan="9" class="muted">暂无数据</td></tr>`;
    $("deleteSelected").disabled = true;
  }

  function updateView() {
    state.filtered = filteredRecords(); const allTimes = state.records.map((record) => record.time.getTime()); $("statPoints").textContent = state.records.length.toLocaleString("zh-CN"); $("statDevices").textContent = new Set(state.records.map((record) => record.device)).size; $("statChannels").textContent = new Set(state.records.map((record) => record.sensorId)).size; $("statLatest").textContent = allTimes.length ? formatTime(new Date(Math.max(...allTimes))) : "—"; $("chartCaption").textContent = state.filtered.length ? `${state.filtered.length} 个数据点 · ${new Set(state.filtered.map((record) => record.device)).size} 个设备 · ${new Set(state.filtered.map((record) => record.sensorId)).size} 个全局传感器` : "当前筛选条件没有数据"; drawChart(state.filtered); updateTable(state.filtered); }

  function downloadFile(content, fileName, type) { const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 200); }
  function utf16LeBytes(text) { const bytes = new Uint8Array(2 + text.length * 2); bytes[0] = 0xff; bytes[1] = 0xfe; for (let i = 0; i < text.length; i += 1) { const code = text.charCodeAt(i); bytes[2 + i * 2] = code & 0xff; bytes[3 + i * 2] = code >> 8; } return bytes; }

  function exportCsv() {
    const rows = state.filtered.slice().sort((a, b) => a.time - b.time || a.device.localeCompare(b.device) || a.channel.localeCompare(b.channel));
    if (!rows.length) { alert("当前筛选条件没有可导出的数据，请调整板卡、传感器或时间范围。"); return; }
    // 不输出表头，打开文件后第一行就是第一条传感器数据；字段顺序固定为北京时间、传感器编号、数值。
    const lines = rows.map((record) => [formatBeijingDateTime(record.time), systemLabel(record.systemId), sensorTypeLabel(record.sensorType), record.sensorId, record.value]);
    // sep=, 是 Excel 的分隔符提示，避免中文 Excel/WPS 把整行放进同一个单元格。
    const csv = "sep=,\r\n" + lines.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n"); downloadFile(utf16LeBytes(csv), "iotda_当前筛选_北京时间.csv", "text/csv;charset=utf-16le");
  }

  function exportJson() {
    const rows = state.filtered.slice().sort((a, b) => a.time - b.time || a.device.localeCompare(b.device) || a.channel.localeCompare(b.channel));
    if (!rows.length) { alert("当前筛选条件没有可导出的数据，请调整板卡、传感器或时间范围。"); return; }
    const devices = {};
    rows.forEach((record) => { const key = `${record.systemId}/${record.device}`; devices[key] ||= { system_id: record.systemId, device: record.device, sensors: {} }; devices[key].sensors[record.sensorId] ||= { sensor_type: record.sensorType, source_channel: record.channel, samples: [] }; devices[key].sensors[record.sensorId].samples.push({ timestamp: record.time.toISOString(), beijing_time: formatBeijingDateTime(record.time), value: record.value, valid_mask: record.validMask, sample_seq: record.seq }); });
    const payload = { schema_version: 3, exported_at: new Date().toISOString(), record_count: rows.length, filter: { system_id: els.system.value, device: els.device.value, sensor_type: els.sensorType.value, sensors: selectedSensors(), range: els.range.value, from_beijing: els.from.value || null, to_beijing: els.to.value || null }, devices };
    downloadFile(JSON.stringify(payload, null, 2), "iotda_按板卡和通道分类归档.json", "application/json;charset=utf-8");
  }

  $("loadArchive").addEventListener("click", () => showArchive().catch((error) => alert(`读取归档失败：${error.message}`)));
  $("latestTable").addEventListener("change", (event) => {
    if (event.target.matches(".record-check")) $("deleteSelected").disabled = !$("latestTable").querySelector(".record-check:checked");
  });
  $("deleteSelected").addEventListener("click", async () => {
    const keys = new Set([...$("latestTable").querySelectorAll(".record-check:checked")].map((input) => decodeURIComponent(input.dataset.recordKey || "")));
    if (!keys.size) return;
    if (!window.confirm(`确定删除勾选的 ${keys.size} 条本机归档吗？\n\n只删除这台电脑上的缓存，不会删除华为云 OBS 原始文件。`)) return;
    try { const deleted = await deleteArchiveWhere((record) => keys.has(archiveId(record))); const all = await readArchive(); loadRecords(all, "本机归档"); $("sourceHint").textContent = `已删除勾选数据 ${deleted} 条；华为云原始数据未改动。`; }
    catch (error) { alert(`删除失败：${error.message}`); }
  });
  $("deleteFiltered").addEventListener("click", async () => {
    if (!state.filtered.length) { alert("当前筛选范围没有可删除的数据。"); return; }
    if (!window.confirm(`确定删除当前筛选的 ${state.filtered.length} 条本机归档吗？\n\n只删除这台电脑上的缓存，不会删除华为云 OBS 原始文件。`)) return;
    try { const deleted = await deleteArchiveWhere((record) => state.filtered.some((item) => archiveId(item) === archiveId(record))); const all = await readArchive(); loadRecords(all, "本机归档"); $("sourceHint").textContent = `已删除本机归档 ${deleted} 条；华为云原始数据未改动。`; }
    catch (error) { alert(`删除失败：${error.message}`); }
  });
  $("clearArchive").addEventListener("click", async () => {
    if (!window.confirm("确定清空这台电脑上的全部本机归档吗？\n\n华为云 OBS 中的历史文件不会被删除，之后可以重新点击“从华为云刷新”。")) return;
    try { const deleted = await clearArchive(); loadRecords([], "等待导入真实数据"); $("sourceHint").textContent = `已清空本机归档 ${deleted} 条；华为云原始数据未改动。`; }
    catch (error) { alert(`清空失败：${error.message}`); }
  });
  $("loadCloud").addEventListener("click", async () => {
    const button = $("loadCloud");
    button.disabled = true; button.textContent = "正在读取华为云…";
    try { await loadCloudRecords(); } catch (error) { alert(`读取华为云失败：${error.message}\n\n请确认 OBS 已设置公共读和 CORS。`); }
    finally { button.disabled = false; button.textContent = "从华为云刷新"; }
  });
  $("exportCsv").addEventListener("click", exportCsv);
  $("exportJson").addEventListener("click", exportJson);
  [els.system, els.device, els.sensorType, els.channel, els.range, els.from, els.to, els.mode].forEach((element) => element.addEventListener("change", updateView));
  $("dataFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      // 旧版华为云/Excel 导出的 CSV 可能是 GBK；先按 UTF-8 解码，发现替换字符再回退到 GB18030。
      const text = decodeImportedBytes(await file.arrayBuffer());
      let records;
      if (file.name.toLowerCase().endsWith(".csv")) records = parseCsv(text);
      else { try { records = parseJson(JSON.parse(text)); } catch (jsonError) { records = text.split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => parseJson(JSON.parse(line))); } }
      if (!records.length) throw new Error("没有找到 cap_01 到 cap_10 数据");
      await archiveImportedRecords(records, file.name);
    } catch (error) { alert(`导入失败：${error.message}`); }
    event.target.value = "";
  });
  window.addEventListener("resize", () => drawChart(state.filtered));
  loadRecords([], "等待导入真实数据");
  readArchive().then((all) => { if (all.length) loadRecords(all, "本机归档"); }).catch(() => {});
})();
