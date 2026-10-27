(() => {
  "use strict";
  const D = window.ResistanceData, $ = (id) => document.getElementById(id);
  const ENDPOINT = "https://sensor-1.obs.cn-east-3.myhuaweicloud.com";
  const PREFIX = "sensor_data/resistance/", DB = "iotda-resistance-archive", STORE = "windows";
  const initialModel = new URLSearchParams(location.search).get("model");
  const PAGE_SIZE = 100;
  const state = { rows: [], filtered: [], selected: new Set(), pendingDelete: [], busy: false, page: 1,
    model: ["ER81C", "ER21T", "unclassified"].includes(initialModel) ? initialModel : "ER81C" };
  const modelLabel = (model = state.model) => model === "unclassified" ? "身份待核对" : model;
  const modelRows = () => state.rows.filter((row) => D.matchesModel(row, state.model));
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
    const scopedRows = modelRows(), devices = new Map(scopedRows.map((r) => [r.deviceId, r.device]));
    $("rDevice").innerHTML = '<option value="__all__">当前型号全部设备</option>' + [...devices].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => `<option value="${escape(id)}">${escape(name)}</option>`).join("");
    if (devices.has(device)) $("rDevice").value = device;
    const scoped = scopedRows.filter((r) => $("rDevice").value === "__all__" || r.deviceId === $("rDevice").value);
    $("rChannel").innerHTML = [...new Set(scoped.map((r) => r.channel))].sort().map((ch) => `<option value="${escape(ch)}">${escape(ch)}</option>`).join("");
    [...$("rChannel").options].forEach((option) => { option.selected = channels.includes(option.value); });
  }
  function selectedOptions() {
    return { model: state.model, device: $("rDevice").value, channels: [...$("rChannel").selectedOptions].map((o) => o.value),
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
    document.querySelectorAll("[data-model]").forEach((link) => {
      const active = link.dataset.model === state.model;
      link.classList.toggle("primary", active); link.classList.toggle("secondary", !active);
      if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
      const count = state.rows.filter((r) => D.matchesModel(r, link.dataset.model)).length;
      link.querySelector("span").textContent = count.toLocaleString("zh-CN");
    });
    $("rModelTitle").textContent = `${modelLabel()} · 电阻统计数据`;
    document.title = `${modelLabel()} · 电阻系统 · IoTDA 传感器看板`;
    $("rModelHint").textContent = state.model === "unclassified" ? "这些记录的型号未知，或云端设备身份与消息内容不一致，未计入 ER81C / ER21T。请核对原文件与网关配置。" :
      `当前只查看 ${state.model}，设备、通道、时间筛选、导出和删除均仅作用于本型号。切换型号不会清空任何记录。`;
    $("rCount").textContent = rows.length.toLocaleString("zh-CN");
    $("rDevices").textContent = new Set(rows.map((r) => r.deviceId)).size;
    $("rChannels").textContent = new Set(rows.map((r) => r.deviceId + "|" + r.channel)).size;
    $("rLatest").textContent = rows.length ? D.beijing(latest).slice(0, 19) : "—";
    $("rTableCount").textContent = `${modelLabel()}：${rows.length} 条 / 本型号归档 ${modelRows().length} 条`;
    $("rDeleteFiltered").disabled = state.busy || rows.length === 0;
    state.page = 1; renderTable();
    selectionState(); status(modelRows().length ? `${modelLabel()} 已归档 ${modelRows().length} 条` : `${modelLabel()} 暂无已归档记录`, modelRows().length > 0);
  }
  function renderTable() {
    const rows = state.filtered, pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const end = rows.length - (state.page - 1) * PAGE_SIZE;
    const visible = rows.slice(Math.max(0, end - PAGE_SIZE), end).reverse();
    $("rPageInfo").textContent = `第 ${state.page} / ${pages} 页 · 共 ${rows.length} 条（每页 ${PAGE_SIZE} 条，仅表格分页，导出仍包含全部筛选结果）`;
    $("rPrevPage").disabled = state.page <= 1; $("rNextPage").disabled = state.page >= pages;
    $("rTable").innerHTML = rows.length ? visible.map((r) =>
      `<tr><td><input class="r-check" type="checkbox" data-key="${encodeURIComponent(D.identity(r))}"${state.selected.has(D.identity(r)) ? " checked" : ""} aria-label="勾选 ${escape(r.device)} ${escape(r.channel)} ${escape(D.beijing(r.time))}"></td>` +
      `<td title="${escape(r.deviceId)}">${escape(r.device)}${D.modelOf(r) === "conflict" ? '<small class="identity-warning">身份冲突</small>' : ""}</td><td>${escape(r.channel)}</td><td>${escape(D.beijing(r.time))}</td><td>${number(r.sampleCount)}</td>` +
      D.fields.map((key) => `<td${key === "meanOhm" ? ' class="value"' : ""}>${number(r[key])}</td>`).join("") + `<td>${escape(r.seq === "" ? "—" : r.seq)}</td></tr>`).join("") :
      `<tr><td colspan="11" class="muted">${modelRows().length ? "当前型号在此筛选范围内没有记录，可重置本型号筛选。" :
        state.model === "unclassified" ? "没有身份待核对的本机记录。" : `${state.model} 暂无本机记录。请刷新云端；若串口显示 MQTT 成功但仍无数据，请确认该设备的“设备消息上报”归档规则已启动。另一型号的数据不会显示在此处。`}</td></tr>`;
  }
  async function run(task) {
    if (state.busy) return;
    state.busy = true; error();
    document.querySelectorAll("[data-model]").forEach((link) => link.setAttribute("aria-disabled", "true"));
    ["rCloud", "rArchive", "rFile", "rCsv", "rJson", "rDelete", "rDeleteFiltered"].forEach((id) => { $(id).disabled = true; });
    try { await task(); } catch (e) { error(e.message || "操作失败"); status("读取或操作未完成"); }
    finally {
      state.busy = false; ["rCloud", "rArchive", "rFile", "rCsv", "rJson"].forEach((id) => { $(id).disabled = false; });
      document.querySelectorAll("[data-model]").forEach((link) => link.removeAttribute("aria-disabled"));
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
    const requestedModel = state.model, objects = new Map(), pending = [PREFIX], visited = new Set();
    let page = 0;
    const relevantKey = (key) => requestedModel === "unclassified" || D.objectModel(key) === "unknown" || D.objectModel(key) === requestedModel;
    // 根目录保留旧版平铺文件，同时递归读取当前型号和未标明型号的历史目录；不设置“最新N条”上限。
    while (pending.length) {
      const prefix = pending.shift(); if (visited.has(prefix)) continue; visited.add(prefix);
      let marker = "";
      while (true) {
      const query = new URLSearchParams({ prefix, delimiter: "/", "max-keys": "1000" }); if (marker) query.set("marker", marker);
      const response = await fetch(`${ENDPOINT}/?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`OBS 列举失败（HTTP ${response.status}）；请核对该目录的公共读和 CORS 权限。`);
      const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("OBS 返回的列表不是有效 XML");
      const contents = [...xml.getElementsByTagName("Contents")];
      contents.forEach((item) => {
        const key = item.getElementsByTagName("Key")[0]?.textContent;
        if (key?.startsWith(PREFIX) && !key.endsWith("/") && relevantKey(key)) objects.set(key, item.getElementsByTagName("LastModified")[0]?.textContent);
      });
      const folders = [...xml.getElementsByTagName("CommonPrefixes")].map((item) => item.getElementsByTagName("Prefix")[0]?.textContent).filter(Boolean);
      folders.forEach((folder) => { if (folder.startsWith(PREFIX) && relevantKey(folder) && !visited.has(folder)) pending.push(folder); });
      page += 1; $("rHint").textContent = `正在列举 ${modelLabel(requestedModel)} 全部历史：第 ${page} 页，找到 ${objects.size} 个候选对象…`;
      if (xml.getElementsByTagName("IsTruncated")[0]?.textContent.trim() !== "true") break;
      const next = xml.getElementsByTagName("NextMarker")[0]?.textContent || [...contents.map((item) => item.getElementsByTagName("Key")[0]?.textContent), ...folders].filter(Boolean).sort().at(-1);
      if (!next || next === marker) throw new Error("OBS 翻页标记异常，已停止以避免只显示部分历史。");
      marker = next;
      }
    }
    if (!objects.size) throw new Error(`云端未找到 ${modelLabel(requestedModel)} 的归档对象，本机记录保持不变。MQTT 确认仅表示 IoTDA 已接收；请在 IoTDA 数据转发中检查该设备的“设备消息上报”规则是否运行，目标是否为 sensor-1 / sensor_data/resistance/${requestedModel}-01。不要改动水分/蒸腾的属性上报规则。`);
    const entries = [...objects], rows = []; let failed = 0, ignored = 0;
    for (let start = 0; start < entries.length; start += 12) {
      const batch = await Promise.all(entries.slice(start, start + 12).map(async ([key, modified]) => {
        try {
          const response = await fetch(`${ENDPOINT}/${key.split("/").map(encodeURIComponent).join("/")}`, { cache: "no-store" });
          if (!response.ok) { failed += 1; return []; }
          const parsed = D.parseText(decode(await response.arrayBuffer()), { sourceKey: key }, modified);
          if (!parsed.length) ignored += 1; return parsed.filter((row) => D.matchesModel(row, requestedModel) || D.modelOf(row) === "conflict");
        } catch (_) { failed += 1; return []; }
      }));
      rows.push(...batch.flat()); $("rHint").textContent = `正在读取 ${modelLabel(requestedModel)} 全部历史：${Math.min(start + 12, entries.length)}/${entries.length} 个对象…`;
    }
    if (!rows.length) throw new Error(`已找到 ${entries.length} 个对象，但未识别到电阻统计。读取失败 ${failed} 个，非统计/测试消息 ${ignored} 个。本机记录未改动。`);
    const result = await appendArchive(rows);
    $("rHint").textContent = `已读取 ${modelLabel(requestedModel)} 的 ${entries.length} 个候选对象：新增 ${result.added} 条，重复跳过 ${result.skipped} 条；本型号归档 ${modelRows().length} 条。` + (failed || ignored ? ` 读取失败 ${failed} 个，未识别 ${ignored} 个；结果可能不完整，可检查后重试。` : "") + (rows.some((r) => D.modelOf(r) === "conflict") ? " 发现身份冲突，请查看“身份待核对”。" : "");
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
  $("rPrevPage").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; renderTable(); } });
  $("rNextPage").addEventListener("click", () => { if (state.page * PAGE_SIZE < state.filtered.length) { state.page += 1; renderTable(); } });
  document.querySelectorAll("[data-model]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault(); if (state.busy) return;
    state.model = link.dataset.model;
    $("rDevice").value = "__all__"; $("rRange").value = "all"; $("rFrom").value = ""; $("rTo").value = "";
    [...$("rChannel").options].forEach((o) => { o.selected = false; });
    const url = new URL(location.href); url.searchParams.set("model", state.model);
    try { history.replaceState(null, "", url); } catch (_) {}
    updateSelects(); render(); $("rHint").textContent = `已切换到 ${modelLabel()}。云端刷新只读取当前型号和未标明型号的历史对象，不混入另一型号。`;
  }));
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
    $("rDeleteMessage").textContent = `确定删除当前 ${modelLabel()} 视图中的这 ${keys.length} 条本机归档？仅删除本机缓存，另一型号、水分/蒸腾归档和云端文件均不变；可重新从云端或原文件导入。`;
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
  $("rCsv").addEventListener("click", () => { if (!state.filtered.length) { error("当前筛选条件没有可导出的电阻记录。"); return; } download(utf16(D.csv(state.filtered)), `${modelLabel()}_电阻统计_当前筛选_北京时间.csv`, "text/csv;charset=utf-16le"); });
  $("rJson").addEventListener("click", () => {
    if (!state.filtered.length) { error("当前筛选条件没有可导出的电阻记录。"); return; }
    const records = state.filtered.map((r) => ({ ...r, time: r.time.toISOString(), beijing_time: D.beijing(r.time) }));
    download(JSON.stringify({ schema_version: 1, kind: "resistance-statistics", exported_at: new Date().toISOString(), filter: selectedOptions(), record_count: records.length, records }, null, 2), `${modelLabel()}_电阻统计_当前筛选.json`, "application/json;charset=utf-8");
  });
  render(); run(async () => { state.rows = await readArchive(); updateSelects(); render(); });
})();
