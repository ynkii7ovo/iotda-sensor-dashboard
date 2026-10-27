(() => {
  "use strict";
  const D = window.ResistanceData, $ = (id) => document.getElementById(id);
  const ENDPOINT = "https://sensor-1.obs.cn-east-3.myhuaweicloud.com";
  const PREFIX = "sensor_data/resistance/", DB = "iotda-resistance-archive", STORE = "windows";
  const state = { rows: [], filtered: [], selected: new Set(), pendingDelete: [], busy: false };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const number = (value) => value === null ? "—" : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
  function error(message = "") { $("rError").hidden = !message; $("rError").textContent = message; }
  function status(message, ready = false) { $("rStatus").textContent = message; $("rStatus").previousElementSibling.classList.toggle("ready", ready); }
  function openArchive() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("浏览器不支持本机归档")); return; }
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: "id" }); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async function readArchive() {
    const db = await openArchive();
    try { return D.unique(await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    })); } finally { db.close(); }
  }
  async function appendArchive(rows) {
    const old = await readArchive(), seen = new Set(old.map(D.identity));
    const unique = D.unique(rows), fresh = unique.filter((row) => !seen.has(D.identity(row)));
    const db = await openArchive();
    try { await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite"), store = tx.objectStore(STORE);
      fresh.forEach((row) => store.put({ ...row, id: D.identity(row), time: row.time.toISOString() }));
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("归档事务被取消"));
    }); } finally { db.close(); }
    state.rows = await readArchive(); updateSelects(); render();
    return { added: fresh.length, skipped: unique.length - fresh.length };
  }
  async function deleteRows(keys) {
    const db = await openArchive();
    try { await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite"); keys.forEach((key) => tx.objectStore(STORE).delete(key));
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
    state.rows = await readArchive(); updateSelects(); render();
  }
  function updateSelects() {
    const device = $("rDevice").value, channels = [...$("rChannel").selectedOptions].map((o) => o.value);
    const devices = new Map(state.rows.map((r) => [r.deviceId, r.device]));
    $("rDevice").innerHTML = '<option value="__all__">全部设备</option>' + [...devices].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => `<option value="${escape(id)}">${escape(name)}</option>`).join("");
    if (devices.has(device)) $("rDevice").value = device;
    const scoped = state.rows.filter((r) => $("rDevice").value === "__all__" || r.deviceId === $("rDevice").value);
    $("rChannel").innerHTML = [...new Set(scoped.map((r) => r.channel))].sort().map((ch) => `<option value="${escape(ch)}">${escape(ch)}</option>`).join("");
    [...$("rChannel").options].forEach((option) => { option.selected = channels.includes(option.value); });
  }
  function selectedOptions() {
    return { device: $("rDevice").value, channels: [...$("rChannel").selectedOptions].map((o) => o.value),
      range: $("rRange").value, from: $("rFrom").value, to: $("rTo").value };
  }
  function selectionState() {
    $("rDelete").disabled = state.busy || state.selected.size === 0;
    $("rSelectAll").disabled = state.filtered.length === 0;
    $("rSelectAll").checked = state.filtered.length > 0 && state.selected.size === state.filtered.length;
    $("rSelectAll").indeterminate = state.selected.size > 0 && state.selected.size < state.filtered.length;
  }
  function render() {
    const options = selectedOptions(), from = D.dateOf(options.from), to = D.dateOf(options.to);
    const invalid = from && to && +from > +to;
    if (invalid) error("开始时间不能晚于结束时间，请调整北京时间范围。");
    else error();
    state.filtered = invalid ? [] : D.filter(state.rows, options); state.selected.clear();
    state.pendingDelete = []; $("rDeleteConfirm").hidden = true;
    const rows = state.filtered, latest = rows.reduce((max, r) => Math.max(max, +r.time), -Infinity);
    $("rCount").textContent = rows.length.toLocaleString("zh-CN");
    $("rDevices").textContent = new Set(rows.map((r) => r.deviceId)).size;
    $("rChannels").textContent = new Set(rows.map((r) => r.deviceId + "|" + r.channel)).size;
    $("rLatest").textContent = rows.length ? D.beijing(latest).slice(0, 19) : "—";
    $("rTableCount").textContent = `${rows.length} 条 / 已归档 ${state.rows.length} 条`;
    $("rDeleteFiltered").disabled = state.busy || rows.length === 0;
    $("rTable").innerHTML = rows.length ? rows.slice().reverse().map((r) =>
      `<tr><td><input class="r-check" type="checkbox" data-key="${encodeURIComponent(D.identity(r))}" aria-label="勾选 ${escape(r.device)} ${escape(r.channel)} ${escape(D.beijing(r.time))}"></td>` +
      `<td title="${escape(r.deviceId)}">${escape(r.device)}</td><td>${escape(r.channel)}</td><td>${escape(D.beijing(r.time))}</td><td>${number(r.sampleCount)}</td>` +
      D.fields.map((key) => `<td${key === "meanOhm" ? ' class="value"' : ""}>${number(r[key])}</td>`).join("") + `<td>${escape(r.seq === "" ? "—" : r.seq)}</td></tr>`).join("") :
      `<tr><td colspan="11" class="muted">${state.rows.length ? "当前筛选条件没有电阻记录。可重置筛选查看全部。" : "尚无电阻数据。请从华为云刷新或导入电阻文件；上报周期由对应网关决定。"}</td></tr>`;
    selectionState(); status(state.rows.length ? `已归档 ${state.rows.length} 条电阻记录` : "等待电阻数据", state.rows.length > 0);
  }
  async function run(task) {
    if (state.busy) return;
    state.busy = true; error();
    ["rCloud", "rArchive", "rFile", "rCsv", "rJson", "rDelete", "rDeleteFiltered"].forEach((id) => { $(id).disabled = true; });
    try { await task(); } catch (e) { error(e.message || "操作失败"); status("读取或操作未完成"); }
    finally {
      state.busy = false; ["rCloud", "rArchive", "rFile", "rCsv", "rJson"].forEach((id) => { $(id).disabled = false; });
      $("rCloud").textContent = "从华为云刷新"; $("rDeleteFiltered").disabled = !state.filtered.length; selectionState();
    }
  }
  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder("utf-16le").decode(buffer);
    if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder("utf-16be").decode(buffer);
    const text = new TextDecoder("utf-8").decode(buffer);
    return text.includes("\uFFFD") ? new TextDecoder("gb18030").decode(buffer) : text;
  }
  async function loadCloud() {
    const objects = new Map(); let marker = "", page = 0;
    while (true) {
      const query = new URLSearchParams({ prefix: PREFIX, "max-keys": "1000" }); if (marker) query.set("marker", marker);
      const response = await fetch(`${ENDPOINT}/?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`OBS 列举失败（HTTP ${response.status}）；请核对该目录的公共读和 CORS 权限。`);
      const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("OBS 返回的列表不是有效 XML");
      const contents = [...xml.getElementsByTagName("Contents")];
      contents.forEach((item) => {
        const key = item.getElementsByTagName("Key")[0]?.textContent;
        if (key?.startsWith(PREFIX) && !key.endsWith("/")) objects.set(key, item.getElementsByTagName("LastModified")[0]?.textContent);
      });
      page += 1; $("rHint").textContent = `正在列举电阻历史：第 ${page} 页，找到 ${objects.size} 个对象…`;
      if (xml.getElementsByTagName("IsTruncated")[0]?.textContent.trim() !== "true") break;
      const next = xml.getElementsByTagName("NextMarker")[0]?.textContent || contents.at(-1)?.getElementsByTagName("Key")[0]?.textContent;
      if (!next || next === marker) throw new Error("OBS 翻页标记异常，已停止以避免只显示部分历史。");
      marker = next;
    }
    if (!objects.size) throw new Error("云端电阻目录暂时没有数据。本机已有记录保持不变；请先启用电阻消息归档规则，并等待网关完成一次统计上传。");
    const entries = [...objects], rows = []; let failed = 0, ignored = 0;
    for (let start = 0; start < entries.length; start += 12) {
      const batch = await Promise.all(entries.slice(start, start + 12).map(async ([key, modified]) => {
        try {
          const response = await fetch(`${ENDPOINT}/${key.split("/").map(encodeURIComponent).join("/")}`, { cache: "no-store" });
          if (!response.ok) { failed += 1; return []; }
          const parsed = D.parseText(decode(await response.arrayBuffer()), { sourceKey: key }, modified);
          if (!parsed.length) ignored += 1; return parsed;
        } catch (_) { failed += 1; return []; }
      }));
      rows.push(...batch.flat()); $("rHint").textContent = `正在读取全部电阻历史：${Math.min(start + 12, entries.length)}/${entries.length} 个对象…`;
    }
    if (!rows.length) throw new Error(`已找到 ${entries.length} 个对象，但未识别到电阻统计。读取失败 ${failed} 个，非统计/测试消息 ${ignored} 个。本机记录未改动。`);
    const result = await appendArchive(rows);
    $("rHint").textContent = `已读取 ${entries.length} 个电阻对象：新增 ${result.added} 条，重复跳过 ${result.skipped} 条；本机共 ${state.rows.length} 条。` + (failed || ignored ? ` 读取失败 ${failed} 个，未识别 ${ignored} 个；结果可能不完整，可检查权限后重试。` : "");
    if (failed) error(`有 ${failed} 个云端对象未能读取，当前结果可能不完整。请检查公共读/CORS权限后重试。`);
  }
  function download(content, name, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime })), a = document.createElement("a");
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function utf16(text) {
    const bytes = new Uint8Array(2 + text.length * 2); bytes[0] = 255; bytes[1] = 254;
    for (let i = 0; i < text.length; i += 1) { const code = text.charCodeAt(i); bytes[2 + i * 2] = code & 255; bytes[3 + i * 2] = code >> 8; } return bytes;
  }
  $("rCloud").addEventListener("click", () => run(loadCloud));
  $("rArchive").addEventListener("click", () => run(async () => { state.rows = await readArchive(); updateSelects(); render(); $("rHint").textContent = `已读取本机电阻归档 ${state.rows.length} 条；未读取或修改水分、蒸腾归档。`; }));
  $("rFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    run(async () => {
      const rows = D.parseText(decode(await file.arrayBuffer()), {}, file.lastModified);
      if (!rows.length) throw new Error("文件中未识别到电阻统计。支持 IoTDA 消息 JSON/JSONL、原网关统计 JSON 及本页导出的 CSV/JSON。");
      const result = await appendArchive(rows); $("rHint").textContent = `从 ${file.name} 导入：新增 ${result.added} 条，重复跳过 ${result.skipped} 条；本机共 ${state.rows.length} 条。`;
    }).finally(() => { event.target.value = ""; });
  });
  $("rDevice").addEventListener("change", () => { [...$("rChannel").options].forEach((option) => { option.selected = false; }); updateSelects(); render(); });
  ["rChannel", "rRange", "rFrom", "rTo"].forEach((id) => $(id).addEventListener("change", render));
  $("rReset").addEventListener("click", () => { $("rDevice").value = "__all__"; $("rRange").value = "all"; $("rFrom").value = ""; $("rTo").value = ""; [...$("rChannel").options].forEach((o) => { o.selected = false; }); updateSelects(); render(); });
  $("rTable").addEventListener("change", (event) => {
    if (!event.target.matches(".r-check")) return; const key = decodeURIComponent(event.target.dataset.key);
    if (event.target.checked) state.selected.add(key); else state.selected.delete(key); selectionState();
  });
  $("rSelectAll").addEventListener("change", () => {
    const checked = $("rSelectAll").checked; state.selected = new Set(checked ? state.filtered.map(D.identity) : []);
    document.querySelectorAll(".r-check").forEach((input) => { input.checked = checked; }); selectionState();
  });
  function requestDelete(keys) {
    if (!keys.length || state.busy) return;
    state.pendingDelete = keys.slice();
    $("rDeleteMessage").textContent = `确定删除这 ${keys.length} 条本机电阻归档？仅删除本机缓存，可重新从云端或原文件导入；水分/蒸腾归档和云端文件均不变。`;
    $("rDeleteConfirm").hidden = false; $("rCancelDelete").focus();
  }
  $("rCancelDelete").addEventListener("click", () => { state.pendingDelete = []; $("rDeleteConfirm").hidden = true; });
  $("rConfirmDelete").addEventListener("click", () => {
    const keys = state.pendingDelete.slice(); state.pendingDelete = []; $("rDeleteConfirm").hidden = true;
    if (!keys.length) return;
    run(async () => { await deleteRows(keys); $("rHint").textContent = `已删除本机电阻记录 ${keys.length} 条；云端和水分/蒸腾数据未改动。`; });
  });
  $("rDelete").addEventListener("click", () => requestDelete([...state.selected]));
  $("rDeleteFiltered").addEventListener("click", () => requestDelete(state.filtered.map(D.identity)));
  $("rCsv").addEventListener("click", () => { if (!state.filtered.length) { error("当前筛选条件没有可导出的电阻记录。"); return; } download(utf16(D.csv(state.filtered)), "电阻统计_当前筛选_北京时间.csv", "text/csv;charset=utf-16le"); });
  $("rJson").addEventListener("click", () => {
    if (!state.filtered.length) { error("当前筛选条件没有可导出的电阻记录。"); return; }
    const records = state.filtered.map((r) => ({ ...r, time: r.time.toISOString(), beijing_time: D.beijing(r.time) }));
    download(JSON.stringify({ schema_version: 1, kind: "resistance-statistics", exported_at: new Date().toISOString(), filter: selectedOptions(), record_count: records.length, records }, null, 2), "电阻统计_当前筛选.json", "application/json;charset=utf-8");
  });
  render(); run(async () => { state.rows = await readArchive(); updateSelects(); render(); });
})();
