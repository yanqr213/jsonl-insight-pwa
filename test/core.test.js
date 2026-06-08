import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFilters,
  clearSession,
  computeCategoricalTopValues,
  computeDateRanges,
  computeNumericStats,
  createMemoryStorage,
  exportCsv,
  exportMarkdown,
  flattenObject,
  inferFields,
  loadSession,
  makeSummary,
  parseJsonl,
  sampleRows,
  saveSession
} from "../src/core.js";

const fixture = [
  '{"id":1,"level":"info","created_at":"2026-01-01T00:00:00Z","duration_ms":10,"status":"pass","nested":{"score":0.9}}',
  '{"id":2,"level":"error","created_at":"2026-01-01T00:01:00Z","duration_ms":40,"status":"fail","nested":{"score":0.2},"message":"bad output"}',
  '{"id":3,"level":"info","created_at":"2026-01-01T00:02:00Z","duration_ms":20,"status":"pass","nested":{"score":0.8}}',
  '{"id":4,"level":"warn","created_at":"2026-01-01T00:03:00Z","duration_ms":999,"status":"pass","nested":{"score":0.7}}',
  '{"id":5,"level":"info","created_at":"2026-01-01T00:04:00Z","duration_ms":"30","status":"pass","nested":{"score":0.95}}',
  '{"id":6,"level":"error","created_at":"2026-01-01T00:05:00Z","duration_ms":50,"status":"fail","nested":{"score":0.1}}',
  '{"id":7,"level":"info","created_at":"2026-01-01T00:06:00Z","duration_ms":60,"status":"pass","nested":{"score":0.82}}',
  '{"id":8,"level":"debug","created_at":"2026-01-01T00:07:00Z","duration_ms":70,"status":"pass","nested":{"score":0.77}}',
  '{"id":9,"level":"info","created_at":"2026-01-01T00:08:00Z","duration_ms":80,"status":"pass","nested":{"score":0.91}}',
  '{"id":10,"level":"info","created_at":"2026-01-01T00:09:00Z","duration_ms":90,"status":"pass","nested":{"score":0.93}}',
  '{"id":11,"level":"info","created_at":"2026-01-01T00:10:00Z","duration_ms":100,"status":"pass","nested":{"score":0.88}}',
  '{"id":12","broken":true}'
].join("\n");

test("parseJsonl parses valid rows and isolates bad rows", () => {
  const parsed = parseJsonl(fixture);
  assert.equal(parsed.rows.length, 11);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].lineNumber, 12);
});

test("parseJsonl skips empty lines without treating them as errors", () => {
  const parsed = parseJsonl('\n{"ok":true}\n\n');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.skippedEmpty, 3);
});

test("flattenObject exposes nested paths", () => {
  assert.deepEqual(flattenObject({ a: { b: 1 }, c: [2] }), { "a.b": 1, c: [2] });
});

test("inferFields detects numeric, date, and nested fields", () => {
  const parsed = parseJsonl(fixture);
  const fields = inferFields(parsed.rows);
  const duration = fields.find((field) => field.name === "duration_ms");
  const created = fields.find((field) => field.name === "created_at");
  const score = fields.find((field) => field.name === "nested.score");
  assert.equal(duration.kind, "number");
  assert.equal(created.kind, "date");
  assert.equal(score.kind, "number");
});

test("inferFields records coverage", () => {
  const parsed = parseJsonl('{"a":1}\n{"b":2}');
  const fields = inferFields(parsed.rows);
  assert.equal(fields.find((field) => field.name === "a").coverage, 0.5);
});

test("applyFilters performs plain text search", () => {
  const parsed = parseJsonl(fixture);
  const rows = applyFilters(parsed.rows, { search: "bad output" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.id, 2);
});

test("applyFilters supports field contains filter", () => {
  const parsed = parseJsonl(fixture);
  const rows = applyFilters(parsed.rows, { search: "level:error" });
  assert.equal(rows.length, 2);
});

test("applyFilters supports numeric comparison", () => {
  const parsed = parseJsonl(fixture);
  const rows = applyFilters(parsed.rows, { search: "duration_ms>90" });
  assert.deepEqual(rows.map((row) => row.data.id), [4, 11]);
});

test("applyFilters combines multiple tokens", () => {
  const parsed = parseJsonl(fixture);
  const rows = applyFilters(parsed.rows, { search: "status:pass duration_ms<25" });
  assert.deepEqual(rows.map((row) => row.data.id), [1, 3]);
});

test("computeNumericStats calculates median and outliers", () => {
  const parsed = parseJsonl(fixture);
  const fields = inferFields(parsed.rows);
  const stats = computeNumericStats(parsed.rows, fields);
  const duration = stats.find((stat) => stat.field === "duration_ms");
  assert.equal(duration.count, 11);
  assert.equal(duration.median, 60);
  assert.equal(duration.outlierCount, 1);
  assert.equal(duration.outlierHigh, 999);
});

test("computeCategoricalTopValues returns sorted top values", () => {
  const parsed = parseJsonl(fixture);
  const fields = inferFields(parsed.rows);
  const stats = computeCategoricalTopValues(parsed.rows, fields);
  const status = stats.find((item) => item.field === "status");
  assert.equal(status.values[0].value, "pass");
  assert.equal(status.values[0].count, 9);
});

test("computeDateRanges finds min, max, and span", () => {
  const parsed = parseJsonl(fixture);
  const fields = inferFields(parsed.rows);
  const ranges = computeDateRanges(parsed.rows, fields);
  const created = ranges.find((range) => range.field === "created_at");
  assert.equal(created.count, 11);
  assert.equal(created.spanMs, 600000);
});

test("sampleRows returns deterministic spread including first and last", () => {
  const parsed = parseJsonl(fixture);
  const sample = sampleRows(parsed.rows, 5);
  assert.equal(sample.length, 5);
  assert.equal(sample[0].data.id, 1);
  assert.equal(sample.at(-1).data.id, 11);
});

test("exportCsv escapes commas and quotes", () => {
  const parsed = parseJsonl('{"name":"a,b","quote":"x\\"y"}');
  const fields = inferFields(parsed.rows);
  const csv = exportCsv(parsed.rows, fields);
  assert.match(csv, /"a,b"/);
  assert.match(csv, /"x""y"/);
});

test("exportMarkdown includes metric and numeric sections", () => {
  const parsed = parseJsonl(fixture);
  const rows = parsed.rows;
  const fields = inferFields(rows);
  const numeric = computeNumericStats(rows, fields);
  const categories = computeCategoricalTopValues(rows, fields);
  const dates = computeDateRanges(rows, fields);
  const summary = makeSummary(parsed, rows, fields, numeric, categories, dates);
  const markdown = exportMarkdown(summary, numeric, categories, dates);
  assert.match(markdown, /# JSONL Insight Summary/);
  assert.match(markdown, /duration_ms/);
  assert.match(markdown, /Time Ranges/);
});

test("saveSession and loadSession round trip", () => {
  const storage = createMemoryStorage();
  const result = saveSession(storage, "session", { fileName: "log.jsonl", text: "{}" });
  const loaded = loadSession(storage, "session");
  assert.equal(result.ok, true);
  assert.equal(loaded.session.fileName, "log.jsonl");
});

test("saveSession rejects oversized payloads", () => {
  const storage = createMemoryStorage();
  const result = saveSession(storage, "session", { text: "abcdef" }, 5);
  assert.equal(result.ok, false);
  assert.equal(storage.getItem("session"), null);
});

test("loadSession returns null for invalid JSON", () => {
  const storage = createMemoryStorage({ session: "not json" });
  assert.equal(loadSession(storage, "session"), null);
});

test("clearSession removes saved data", () => {
  const storage = createMemoryStorage();
  saveSession(storage, "session", { text: "{}" });
  clearSession(storage, "session");
  assert.equal(loadSession(storage, "session"), null);
});
