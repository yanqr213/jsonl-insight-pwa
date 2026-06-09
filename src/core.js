const DATE_LIKE_KEY = /(time|date|timestamp|created|updated|ts|at)$/i;
const FAILURE_STATUS_VALUES = new Set(["fail", "failed", "failure", "error", "errored", "timeout", "timed-out", "invalid", "rejected"]);
const STATUS_FIELDS = ["status", "result", "outcome", "state", "verdict"];
const SUCCESS_FIELDS = ["success", "ok", "passed"];
const ERROR_FIELDS = ["error", "errors", "exception", "failure", "failure_reason", "failure.reason", "error.message", "message.error"];
const FAILURE_DETAIL_FIELDS = [...ERROR_FIELDS, "message", "reason", "failure_message"];
const CATEGORY_FIELDS = ["category", "suite", "task.category", "case.category", "case.difficulty", "difficulty", "judge"];
const MODEL_FIELDS = ["model", "model_name", "model.id", "provider.model", "run.model", "agent", "agentName"];
const ID_FIELDS = ["id", "case.id", "case.name", "name", "trace_id", "request_id"];
const SCORE_FIELDS = ["score", "metrics.score", "judge.score"];
const LATENCY_FIELDS = ["latency_ms", "duration_ms", "elapsed_ms", "time_ms", "latency"];

export function parseJsonl(text) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const rows = [];
  const errors = [];
  let skippedEmpty = 0;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) {
      skippedEmpty += 1;
      return;
    }

    try {
      const data = JSON.parse(line);
      rows.push({
        id: rows.length + 1,
        lineNumber,
        raw: line,
        data
      });
    } catch (error) {
      errors.push({
        lineNumber,
        raw: line,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return {
    rows,
    errors,
    totalLines: lines.length,
    nonEmptyLines: rows.length + errors.length,
    skippedEmpty
  };
}

export function flattenObject(value, prefix = "", output = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) output[prefix] = value;
    return output;
  }

  const entries = Object.entries(value);
  if (entries.length === 0 && prefix) {
    output[prefix] = value;
    return output;
  }

  for (const [key, child] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenObject(child, path, output);
    } else {
      output[path] = child;
    }
  }

  return output;
}

export function getPathValue(source, path) {
  if (!path) return undefined;
  return path.split(".").reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    return current[part];
  }, source);
}

export function detectValueType(value, fieldName = "") {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "number") return Number.isFinite(value) ? "number" : "other";
  if (type === "boolean") return "boolean";
  if (type === "object") return "object";
  if (type === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return "empty";
    if (isDateLike(trimmed, fieldName)) return "date";
    if (isNumericString(trimmed)) return "numeric-string";
    return "string";
  }
  return "other";
}

export function inferFields(rows) {
  const fieldMap = new Map();

  for (const row of rows) {
    const flattened = flattenObject(row.data);
    for (const [field, value] of Object.entries(flattened)) {
      if (!fieldMap.has(field)) {
        fieldMap.set(field, {
          name: field,
          present: 0,
          nonNull: 0,
          empty: 0,
          examples: [],
          types: {}
        });
      }

      const info = fieldMap.get(field);
      const valueType = detectValueType(value, field);
      info.present += 1;
      info.types[valueType] = (info.types[valueType] || 0) + 1;
      if (value !== null && value !== undefined && value !== "") info.nonNull += 1;
      if (value === "") info.empty += 1;
      if (info.examples.length < 3 && value !== null && value !== undefined && value !== "") {
        info.examples.push(formatPrimitive(value, 90));
      }
    }
  }

  return Array.from(fieldMap.values())
    .map((info) => ({
      ...info,
      kind: chooseFieldKind(info.types),
      coverage: rows.length ? info.present / rows.length : 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function computeNumericStats(rows, fields) {
  const result = [];

  for (const field of fields) {
    const values = rows
      .map((row) => normalizeNumber(getPathValue(row.data, field.name)))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);

    if (!values.length) continue;

    const sum = values.reduce((total, value) => total + value, 0);
    const mean = sum / values.length;
    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;
    const outliers = values.filter((value) => value < lowerFence || value > upperFence);

    result.push({
      field: field.name,
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      mean,
      median: quantile(values, 0.5),
      p05: quantile(values, 0.05),
      p95: quantile(values, 0.95),
      stdev: Math.sqrt(variance),
      outlierCount: outliers.length,
      outlierLow: outliers.length ? outliers[0] : null,
      outlierHigh: outliers.length ? outliers[outliers.length - 1] : null
    });
  }

  return result.sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}

export function computeCategoricalTopValues(rows, fields, limit = 8) {
  const categories = [];
  for (const field of fields) {
    const counts = new Map();
    let total = 0;

    for (const row of rows) {
      const value = getPathValue(row.data, field.name);
      const type = detectValueType(value, field.name);
      if (!["string", "boolean", "date", "numeric-string"].includes(type)) continue;
      const label = formatPrimitive(value, 120);
      counts.set(label, (counts.get(label) || 0) + 1);
      total += 1;
    }

    if (!total || counts.size > Math.max(80, rows.length * 0.65)) continue;

    const values = Array.from(counts.entries())
      .map(([value, count]) => ({ value, count, ratio: count / total }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, limit);

    categories.push({ field: field.name, total, values });
  }

  return categories.sort((a, b) => b.total - a.total || a.field.localeCompare(b.field));
}

export function computeDateRanges(rows, fields) {
  const ranges = [];

  for (const field of fields) {
    const values = rows
      .map((row) => normalizeDate(getPathValue(row.data, field.name), field.name))
      .filter((value) => value instanceof Date && !Number.isNaN(value.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());

    if (!values.length) continue;

    const min = values[0];
    const max = values[values.length - 1];
    ranges.push({
      field: field.name,
      count: values.length,
      min,
      max,
      spanMs: max.getTime() - min.getTime()
    });
  }

  return ranges.sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}

export function applyFilters(rows, options = {}) {
  const search = String(options.search || "").trim();
  const tokens = tokenizeSearch(search);
  if (!tokens.length) return rows.slice();

  return rows.filter((row) => {
    const flattened = flattenObject(row.data);
    const haystack = `${row.raw}\n${Object.values(flattened).map((value) => formatPrimitive(value, 500)).join("\n")}`.toLowerCase();

    return tokens.every((token) => {
      if (token.kind === "text") {
        return haystack.includes(token.value.toLowerCase());
      }

      const actual = flattened[token.field];
      if (actual === undefined) return false;
      return compareFilterValue(actual, token.operator, token.value);
    });
  });
}

export function sampleRows(rows, size = 50) {
  const requested = clampInteger(size, 5, 500);
  if (rows.length <= requested) return rows.slice();

  const sample = [];
  const step = (rows.length - 1) / (requested - 1);
  const used = new Set();

  for (let index = 0; index < requested; index += 1) {
    const rowIndex = Math.round(index * step);
    if (!used.has(rowIndex)) {
      sample.push(rows[rowIndex]);
      used.add(rowIndex);
    }
  }

  return sample;
}

export function makeSummary(parsed, rows, fields, numericStats, categoryStats, dateRanges) {
  const outlierHints = numericStats
    .filter((stat) => stat.outlierCount > 0)
    .map((stat) => ({
      field: stat.field,
      count: stat.outlierCount,
      low: stat.outlierLow,
      high: stat.outlierHigh
    }));

  return {
    totalLines: parsed.nonEmptyLines,
    validRows: parsed.rows.length,
    visibleRows: rows.length,
    parseErrors: parsed.errors.length,
    fieldCount: fields.length,
    numericFieldCount: numericStats.length,
    categoryFieldCount: categoryStats.length,
    dateFieldCount: dateRanges.length,
    outlierHints
  };
}

export function analyzeFailures(rows, options = {}) {
  const statusFields = options.statusFields || STATUS_FIELDS;
  const successFields = options.successFields || SUCCESS_FIELDS;
  const errorFields = options.errorFields || ERROR_FIELDS;
  const categoryFields = options.categoryFields || CATEGORY_FIELDS;
  const modelFields = options.modelFields || MODEL_FIELDS;
  const idFields = options.idFields || ID_FIELDS;
  const scoreFields = options.scoreFields || SCORE_FIELDS;
  const latencyFields = options.latencyFields || LATENCY_FIELDS;
  const examplesLimit = clampInteger(options.examplesLimit ?? 20, 1, 100);
  const failures = [];

  for (const row of rows) {
    const flattened = flattenObject(row.data);
    const status = firstPresent(flattened, statusFields);
    const success = firstPresent(flattened, successFields);
    const errorSignal = firstPresent(flattened, errorFields);
    const failureKind = getFailureKind(status, success, errorSignal);
    if (!failureKind) continue;

    const error = firstPresent(flattened, options.failureDetailFields || FAILURE_DETAIL_FIELDS);
    const score = normalizeNumber(firstPresent(flattened, scoreFields));
    const latencyMs = normalizeNumber(firstPresent(flattened, latencyFields));
    failures.push({
      lineNumber: row.lineNumber,
      id: formatPrimitive(firstPresent(flattened, idFields) || `line-${row.lineNumber}`, 120),
      status: formatPrimitive(status || failureKind, 80),
      error: summarizeFailureError(error),
      category: formatPrimitive(firstPresent(flattened, categoryFields) || "uncategorized", 120),
      model: formatPrimitive(firstPresent(flattened, modelFields) || "unknown", 120),
      score: Number.isFinite(score) ? score : null,
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : null
    });
  }

  return {
    totalRows: rows.length,
    failedRows: failures.length,
    failureRate: rows.length ? failures.length / rows.length : 0,
    statusBreakdown: countBreakdown(failures.map((item) => item.status || "failure"), failures.length),
    errorBreakdown: countBreakdown(failures.map((item) => item.error || "unknown"), failures.length),
    categoryBreakdown: countBreakdown(failures.map((item) => item.category || "uncategorized"), failures.length),
    modelBreakdown: countBreakdown(failures.map((item) => item.model || "unknown"), failures.length),
    examples: failures.slice(0, examplesLimit)
  };
}

export function exportFailureMarkdown(analysis) {
  const lines = [
    "# JSONL Failure Drilldown",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Valid rows inspected | ${analysis.totalRows} |`,
    `| Failure rows | ${analysis.failedRows} |`,
    `| Failure rate | ${formatPercent(analysis.failureRate)} |`,
    "",
    "## By Status",
    "",
    breakdownTable(analysis.statusBreakdown),
    "",
    "## By Error",
    "",
    breakdownTable(analysis.errorBreakdown),
    "",
    "## By Category",
    "",
    breakdownTable(analysis.categoryBreakdown),
    "",
    "## By Model",
    "",
    breakdownTable(analysis.modelBreakdown),
    "",
    "## Failure Examples",
    "",
    "| Line | ID | Status | Error | Category | Model | Score | Latency ms |",
    "| ---: | --- | --- | --- | --- | --- | ---: | ---: |"
  ];

  if (analysis.examples.length) {
    for (const item of analysis.examples) {
      lines.push(`| ${item.lineNumber} | ${escapeMarkdownCell(item.id)} | ${escapeMarkdownCell(item.status)} | ${escapeMarkdownCell(item.error)} | ${escapeMarkdownCell(item.category)} | ${escapeMarkdownCell(item.model)} | ${formatNumber(item.score)} | ${formatNumber(item.latencyMs)} |`);
    }
  } else {
    lines.push("|  | No failure rows detected |  |  |  |  |  |  |");
  }

  return `${lines.join("\n")}\n`;
}

export function exportCsv(rows, fields) {
  const fieldNames = fields.map((field) => (typeof field === "string" ? field : field.name));
  const header = ["lineNumber", ...fieldNames];
  const lines = [header.map(escapeCsvCell).join(",")];

  for (const row of rows) {
    const values = [row.lineNumber, ...fieldNames.map((field) => getPathValue(row.data, field))];
    lines.push(values.map(escapeCsvCell).join(","));
  }

  return lines.join("\n");
}

export function exportMarkdown(summary, numericStats, categoryStats, dateRanges) {
  const lines = [
    "# JSONL Insight Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Total non-empty lines | ${summary.totalLines} |`,
    `| Valid JSON rows | ${summary.validRows} |`,
    `| Visible rows | ${summary.visibleRows} |`,
    `| Parse errors | ${summary.parseErrors} |`,
    `| Inferred fields | ${summary.fieldCount} |`,
    "",
    "## Numeric Fields",
    "",
    "| Field | Count | Min | Median | P95 | Max | Mean | Outliers |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];

  if (numericStats.length) {
    for (const stat of numericStats) {
      lines.push(`| ${escapeMarkdownCell(stat.field)} | ${stat.count} | ${formatNumber(stat.min)} | ${formatNumber(stat.median)} | ${formatNumber(stat.p95)} | ${formatNumber(stat.max)} | ${formatNumber(stat.mean)} | ${stat.outlierCount} |`);
    }
  } else {
    lines.push("| No numeric fields | 0 |  |  |  |  |  | 0 |");
  }

  lines.push("", "## Top Values", "", "| Field | Value | Count | Ratio |", "| --- | --- | ---: | ---: |");
  if (categoryStats.length) {
    for (const category of categoryStats.slice(0, 12)) {
      for (const item of category.values.slice(0, 5)) {
        lines.push(`| ${escapeMarkdownCell(category.field)} | ${escapeMarkdownCell(item.value)} | ${item.count} | ${formatPercent(item.ratio)} |`);
      }
    }
  } else {
    lines.push("| No categorical fields |  | 0 | 0% |");
  }

  lines.push("", "## Time Ranges", "", "| Field | Count | Earliest | Latest | Span |", "| --- | ---: | --- | --- | --- |");
  if (dateRanges.length) {
    for (const range of dateRanges) {
      lines.push(`| ${escapeMarkdownCell(range.field)} | ${range.count} | ${range.min.toISOString()} | ${range.max.toISOString()} | ${formatDuration(range.spanMs)} |`);
    }
  } else {
    lines.push("| No time fields | 0 |  |  |  |");
  }

  if (summary.outlierHints.length) {
    lines.push("", "## Outlier Hints", "");
    for (const hint of summary.outlierHints) {
      lines.push(`- ${hint.field}: ${hint.count} outlier values, range ${formatNumber(hint.low)} to ${formatNumber(hint.high)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function saveSession(storage, key, session, maxChars = 2_000_000) {
  const payload = JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    session
  });
  if (payload.length > maxChars) {
    return { ok: false, reason: "too-large", size: payload.length };
  }
  storage.setItem(key, payload);
  return { ok: true, size: payload.length };
}

export function loadSession(storage, key) {
  const payload = storage.getItem(key);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || parsed.version !== 1 || !parsed.session) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(storage, key) {
  storage.removeItem(key);
}

export function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    keys() {
      return Array.from(data.keys());
    }
  };
}

export function normalizeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && isNumericString(value)) return Number(value);
  return NaN;
}

export function normalizeDate(value, fieldName = "") {
  if (value instanceof Date) return value;
  if (typeof value === "number" && DATE_LIKE_KEY.test(fieldName)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!isDateLike(trimmed, fieldName)) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  if (!Number.isFinite(value)) return String(value);
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 0.001 || absolute >= 1_000_000)) return value.toExponential(3);
  return Number(value.toFixed(4)).toLocaleString("en-US");
}

export function formatPercent(value) {
  return `${Number((value * 100).toFixed(1)).toLocaleString("en-US")}%`;
}

export function formatDuration(ms) {
  const absolute = Math.abs(ms);
  const units = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000]
  ];

  for (const [label, unit] of units) {
    if (absolute >= unit) return `${Number((ms / unit).toFixed(2)).toLocaleString("en-US")} ${label}`;
  }

  return `${ms} ms`;
}

function tokenizeSearch(search) {
  const parts = search.match(/"[^"]+"|\S+/g) || [];
  return parts.map((raw) => {
    const value = raw.replace(/^"|"$/g, "");
    const match = value.match(/^([A-Za-z0-9_.-]+)\s*(>=|<=|!=|=|:|>|<)\s*(.+)$/);
    if (!match) return { kind: "text", value };
    return {
      kind: "field",
      field: match[1],
      operator: match[2],
      value: match[3].replace(/^"|"$/g, "")
    };
  });
}

function compareFilterValue(actual, operator, expected) {
  const actualNumber = normalizeNumber(actual);
  const expectedNumber = normalizeNumber(expected);

  if ([">", ">=", "<", "<="].includes(operator)) {
    if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
    if (operator === ">") return actualNumber > expectedNumber;
    if (operator === ">=") return actualNumber >= expectedNumber;
    if (operator === "<") return actualNumber < expectedNumber;
    return actualNumber <= expectedNumber;
  }

  const actualText = formatPrimitive(actual, 1000).toLowerCase();
  const expectedText = String(expected).toLowerCase();

  if (operator === "!=") return actualText !== expectedText;
  if (operator === "=") return actualText === expectedText;
  return actualText.includes(expectedText);
}

function firstPresent(source, fields) {
  for (const field of fields) {
    let value;
    if (Object.hasOwn(source, field)) {
      value = source[field];
    } else {
      const prefix = `${field}.`;
      const nestedKey = Object.keys(source).find((key) => key.startsWith(prefix));
      value = nestedKey ? source[nestedKey] : undefined;
    }
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return undefined;
}

function getFailureKind(status, success, error) {
  const statusText = normalizeFailureToken(status);
  if (statusText && FAILURE_STATUS_VALUES.has(statusText)) return statusText;
  if (success === false || normalizeFailureToken(success) === "false") return "success=false";
  if (hasErrorSignal(error)) return "error";
  return "";
}

function normalizeFailureToken(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase().replace(/_/g, "-");
}

function hasErrorSignal(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return String(value).trim().length > 0;
}

function summarizeFailureError(value) {
  if (!hasErrorSignal(value)) return "unknown";
  return formatPrimitive(value, 140);
}

function countBreakdown(values, denominator) {
  const counts = new Map();
  for (const value of values) {
    const key = value || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count, ratio: denominator ? count / denominator : 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 12);
}

function breakdownTable(items) {
  if (!items.length) return "| Value | Count | Ratio |\n| --- | ---: | ---: |\n| No failures | 0 | 0% |";
  return [
    "| Value | Count | Ratio |",
    "| --- | ---: | ---: |",
    ...items.map((item) => `| ${escapeMarkdownCell(item.value)} | ${item.count} | ${formatPercent(item.ratio)} |`)
  ].join("\n");
}

function chooseFieldKind(types) {
  const ranked = Object.entries(types)
    .filter(([type]) => !["null", "empty"].includes(type))
    .sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "empty";
  const [type] = ranked[0];
  if (type === "numeric-string") return "number";
  return type;
}

function quantile(sortedValues, probability) {
  if (!sortedValues.length) return NaN;
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function isNumericString(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed);
}

function isDateLike(value, fieldName = "") {
  if (typeof value !== "string" || value.trim().length < 8) return false;
  if (!DATE_LIKE_KEY.test(fieldName) && !/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

function formatPrimitive(value, maxLength = 160) {
  let text;
  if (value === null) text = "null";
  else if (value === undefined) text = "";
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function escapeCsvCell(value) {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeMarkdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
