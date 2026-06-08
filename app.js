import {
  applyFilters,
  clearSession,
  computeCategoricalTopValues,
  computeDateRanges,
  computeNumericStats,
  exportCsv,
  exportMarkdown,
  formatDuration,
  formatNumber,
  formatPercent,
  inferFields,
  loadSession,
  makeSummary,
  parseJsonl,
  sampleRows,
  saveSession
} from "./src/core.js";

const SESSION_KEY = "jsonl-insight-pwa:session:v1";
const MAX_STORAGE_CHARS = 2_000_000;

const state = {
  fileName: "",
  text: "",
  parsed: parseJsonl(""),
  fields: [],
  filteredRows: [],
  numericStats: [],
  categoryStats: [],
  dateRanges: [],
  activeTab: "overview"
};

const elements = {
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  loadExampleButton: document.querySelector("#loadExampleButton"),
  searchInput: document.querySelector("#searchInput"),
  errorsOnlyToggle: document.querySelector("#errorsOnlyToggle"),
  validOnlyToggle: document.querySelector("#validOnlyToggle"),
  sampleSizeInput: document.querySelector("#sampleSizeInput"),
  exportCsvButton: document.querySelector("#exportCsvButton"),
  exportMarkdownButton: document.querySelector("#exportMarkdownButton"),
  clearSessionButton: document.querySelector("#clearSessionButton"),
  statusText: document.querySelector("#statusText"),
  totalRowsMetric: document.querySelector("#totalRowsMetric"),
  validRowsMetric: document.querySelector("#validRowsMetric"),
  errorRowsMetric: document.querySelector("#errorRowsMetric"),
  fieldCountMetric: document.querySelector("#fieldCountMetric"),
  overviewList: document.querySelector("#overviewList"),
  outlierHints: document.querySelector("#outlierHints"),
  fieldsTableBody: document.querySelector("#fieldsTableBody"),
  numericTableBody: document.querySelector("#numericTableBody"),
  categoryCards: document.querySelector("#categoryCards"),
  timeTableBody: document.querySelector("#timeTableBody"),
  errorsTableBody: document.querySelector("#errorsTableBody"),
  sampleTable: document.querySelector("#sampleTable")
};

boot();

function boot() {
  bindEvents();
  restoreSession();
  registerServiceWorker();
  recompute();
}

function bindEvents() {
  elements.fileInput.addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    if (file) await loadFile(file);
    elements.fileInput.value = "";
  });

  elements.loadExampleButton.addEventListener("click", async () => {
    const response = await fetch("examples/ai-eval-log.jsonl", { cache: "no-store" });
    const text = await response.text();
    setDataset("ai-eval-log.jsonl", text);
  });

  elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });

  elements.dropZone.addEventListener("dragleave", () => {
    elements.dropZone.classList.remove("dragging");
  });

  elements.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
    const [file] = event.dataTransfer.files || [];
    if (file) await loadFile(file);
  });

  elements.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });

  for (const input of [elements.searchInput, elements.errorsOnlyToggle, elements.validOnlyToggle, elements.sampleSizeInput]) {
    input.addEventListener("input", recompute);
    input.addEventListener("change", recompute);
  }

  elements.exportCsvButton.addEventListener("click", () => {
    const csv = exportCsv(state.filteredRows, state.fields);
    downloadText(`${baseName(state.fileName || "jsonl-insight")}-sample.csv`, csv, "text/csv");
  });

  elements.exportMarkdownButton.addEventListener("click", () => {
    const summary = buildSummary();
    const markdown = exportMarkdown(summary, state.numericStats, state.categoryStats, state.dateRanges);
    downloadText(`${baseName(state.fileName || "jsonl-insight")}-summary.md`, markdown, "text/markdown");
  });

  elements.clearSessionButton.addEventListener("click", () => {
    clearSession(localStorage, SESSION_KEY);
    setDataset("", "");
    elements.searchInput.value = "";
    elements.errorsOnlyToggle.checked = false;
    elements.validOnlyToggle.checked = false;
    setStatus("会话已清除");
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      renderTabs();
    });
  });
}

async function loadFile(file) {
  const text = await file.text();
  setDataset(file.name, text);
}

function setDataset(fileName, text) {
  state.fileName = fileName;
  state.text = text;
  state.parsed = parseJsonl(text);
  state.fields = inferFields(state.parsed.rows);
  const saved = saveSession(localStorage, SESSION_KEY, { fileName, text }, MAX_STORAGE_CHARS);
  recompute();
  if (!saved.ok) {
    setStatus(`已加载 ${fileName || "空数据"}，文件较大，未写入 localStorage`);
  }
}

function restoreSession() {
  const saved = loadSession(localStorage, SESSION_KEY);
  if (!saved?.session?.text) return;
  state.fileName = saved.session.fileName || "restored-session.jsonl";
  state.text = saved.session.text;
  state.parsed = parseJsonl(state.text);
  state.fields = inferFields(state.parsed.rows);
  setStatus(`已恢复 ${state.fileName}`);
}

function recompute() {
  const search = elements.searchInput.value;
  let rows = applyFilters(state.parsed.rows, { search });
  if (elements.errorsOnlyToggle.checked) rows = [];

  state.filteredRows = rows;
  state.fields = inferFields(state.parsed.rows);
  state.numericStats = computeNumericStats(rows, state.fields);
  state.categoryStats = computeCategoricalTopValues(rows, state.fields);
  state.dateRanges = computeDateRanges(rows, state.fields);

  if (state.text) {
    saveSession(localStorage, SESSION_KEY, { fileName: state.fileName, text: state.text }, MAX_STORAGE_CHARS);
  }

  render();
}

function render() {
  const summary = buildSummary();
  elements.totalRowsMetric.textContent = formatInteger(summary.totalLines);
  elements.validRowsMetric.textContent = formatInteger(summary.validRows);
  elements.errorRowsMetric.textContent = formatInteger(summary.parseErrors);
  elements.fieldCountMetric.textContent = formatInteger(summary.fieldCount);

  renderOverview(summary);
  renderFields();
  renderNumericStats();
  renderCategories();
  renderTimeRanges();
  renderErrors();
  renderSample();
  renderTabs();

  if (state.text) {
    setStatus(`${state.fileName || "未命名数据"}：${formatInteger(summary.visibleRows)} 行匹配，${formatInteger(summary.parseErrors)} 行解析失败`);
  } else {
    setStatus("等待加载文件");
  }
}

function buildSummary() {
  return makeSummary(state.parsed, state.filteredRows, state.fields, state.numericStats, state.categoryStats, state.dateRanges);
}

function renderOverview(summary) {
  const topFields = state.fields.slice(0, 8).map((field) => field.name).join(", ") || "无";
  elements.overviewList.innerHTML = "";
  const items = [
    ["文件", state.fileName || "尚未加载"],
    ["匹配行数", formatInteger(summary.visibleRows)],
    ["字段概况", `${formatInteger(summary.fieldCount)} 个字段；数值 ${summary.numericFieldCount}，分类 ${summary.categoryFieldCount}，时间 ${summary.dateFieldCount}`],
    ["主要字段", topFields],
    ["搜索语法", "text、field:value、field=value、field>100、field<=100"]
  ];
  for (const [label, value] of items) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    elements.overviewList.append(dt, dd);
  }

  elements.outlierHints.innerHTML = "";
  if (!summary.outlierHints.length) {
    elements.outlierHints.append(emptyState("暂无明显数值异常。"));
    return;
  }
  for (const hint of summary.outlierHints.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "hint-item";
    item.textContent = `${hint.field}: ${hint.count} 个异常值，范围 ${formatNumber(hint.low)} 至 ${formatNumber(hint.high)}`;
    elements.outlierHints.append(item);
  }
}

function renderFields() {
  elements.fieldsTableBody.innerHTML = "";
  if (!state.fields.length) {
    elements.fieldsTableBody.append(tableEmptyRow(5, "加载 JSONL 后显示字段推断。"));
    return;
  }
  for (const field of state.fields) {
    const row = document.createElement("tr");
    row.append(
      cell(field.name),
      cell(field.kind),
      cell(formatPercent(field.coverage)),
      cell(formatInteger(field.nonNull)),
      cell(field.examples.join(" | "))
    );
    elements.fieldsTableBody.append(row);
  }
}

function renderNumericStats() {
  elements.numericTableBody.innerHTML = "";
  if (!state.numericStats.length) {
    elements.numericTableBody.append(tableEmptyRow(8, "未发现可统计的数值字段。"));
    return;
  }
  for (const stat of state.numericStats) {
    const row = document.createElement("tr");
    row.append(
      cell(stat.field),
      cell(formatInteger(stat.count)),
      cell(formatNumber(stat.min)),
      cell(formatNumber(stat.median)),
      cell(formatNumber(stat.p95)),
      cell(formatNumber(stat.max)),
      cell(formatNumber(stat.mean)),
      cell(formatInteger(stat.outlierCount))
    );
    elements.numericTableBody.append(row);
  }
}

function renderCategories() {
  elements.categoryCards.innerHTML = "";
  if (!state.categoryStats.length) {
    elements.categoryCards.append(emptyState("未发现低基数分类字段。"));
    return;
  }
  for (const category of state.categoryStats.slice(0, 16)) {
    const card = document.createElement("article");
    card.className = "value-card";
    const title = document.createElement("h3");
    title.textContent = category.field;
    const list = document.createElement("div");
    list.className = "bar-list";

    const max = Math.max(...category.values.map((value) => value.count), 1);
    for (const value of category.values) {
      const row = document.createElement("div");
      row.className = "bar-row";
      const label = document.createElement("span");
      label.className = "bar-label";
      label.title = value.value;
      label.textContent = value.value;
      const count = document.createElement("strong");
      count.textContent = `${formatInteger(value.count)} (${formatPercent(value.ratio)})`;
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = `${Math.max(4, (value.count / max) * 100)}%`;
      track.append(fill);
      row.append(label, count, track);
      list.append(row);
    }
    card.append(title, list);
    elements.categoryCards.append(card);
  }
}

function renderTimeRanges() {
  elements.timeTableBody.innerHTML = "";
  if (!state.dateRanges.length) {
    elements.timeTableBody.append(tableEmptyRow(5, "未发现可识别的时间字段。"));
    return;
  }
  for (const range of state.dateRanges) {
    const row = document.createElement("tr");
    row.append(
      cell(range.field),
      cell(formatInteger(range.count)),
      cell(range.min.toISOString()),
      cell(range.max.toISOString()),
      cell(formatDuration(range.spanMs))
    );
    elements.timeTableBody.append(row);
  }
}

function renderErrors() {
  elements.errorsTableBody.innerHTML = "";
  if (!state.parsed.errors.length) {
    elements.errorsTableBody.append(tableEmptyRow(3, "没有解析失败的行。"));
    return;
  }
  for (const error of state.parsed.errors) {
    const row = document.createElement("tr");
    row.append(cell(error.lineNumber), cell(error.message), cell(error.raw));
    elements.errorsTableBody.append(row);
  }
}

function renderSample() {
  elements.sampleTable.innerHTML = "";
  const rows = elements.errorsOnlyToggle.checked
    ? state.parsed.errors.map((error) => ({ lineNumber: error.lineNumber, data: { error: error.message, raw: error.raw } }))
    : sampleRows(state.filteredRows, elements.sampleSizeInput.value);

  if (!rows.length) {
    const tbody = document.createElement("tbody");
    tbody.append(tableEmptyRow(3, "没有可显示的抽样行。"));
    elements.sampleTable.append(tbody);
    return;
  }

  const fields = elements.errorsOnlyToggle.checked
    ? ["error", "raw"]
    : state.fields.slice(0, 18).map((field) => field.name);
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  header.append(cell("line"));
  fields.forEach((field) => header.append(cell(field, "th")));
  thead.append(header);

  const tbody = document.createElement("tbody");
  for (const rowData of rows) {
    const row = document.createElement("tr");
    row.append(cell(rowData.lineNumber));
    for (const field of fields) {
      row.append(cell(readPath(rowData.data, field)));
    }
    tbody.append(row);
  }

  elements.sampleTable.append(thead, tbody);
}

function renderTabs() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.activeTab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${state.activeTab}`);
  });
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function downloadText(fileName, text, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function cell(value, tag = "td") {
  const element = document.createElement(tag);
  element.textContent = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return element;
}

function tableEmptyRow(colspan, message) {
  const row = document.createElement("tr");
  const empty = document.createElement("td");
  empty.colSpan = colspan;
  empty.append(emptyState(message));
  row.append(empty);
  return row;
}

function emptyState(message) {
  const element = document.createElement("div");
  element.className = "empty-state";
  element.textContent = message;
  return element;
}

function readPath(source, path) {
  return path.split(".").reduce((current, part) => {
    if (current === null || current === undefined) return "";
    return current[part];
  }, source);
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function baseName(fileName) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "jsonl-insight";
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("sw.js");
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}
