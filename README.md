# JSONL Insight PWA

JSONL Insight PWA 是一个零构建、可离线运行的前端工具，用来在浏览器本地快速查看 JSONL / NDJSON 日志、AI eval 结果、工具调用日志和后端结构化日志。第一屏就是工作台：拖拽或选择文件后，应用会自动解析、推断字段、过滤、统计、抽样、提示异常值，并导出 CSV 或 Markdown 摘要。

所有数据都留在浏览器本地。应用没有后端，不会上传文件。

## 功能

- 拖拽或选择 `.jsonl`、`.ndjson`、`.log`、`.txt` 文件。
- 自动隔离解析失败的行，显示行号、错误和原始内容。
- 推断字段类型，支持嵌套对象路径，例如 `case.difficulty`。
- 搜索和过滤：支持全文、`field:value`、`field=value`、`field>100`、`field<=100`。
- 数值字段统计：count、min、median、p95、max、mean、IQR 异常值提示。
- 分类字段 top values 和占比。
- 时间字段范围、跨度统计。
- 抽样表，适合大文件快速扫视。
- 导出当前过滤结果 CSV。
- 导出 Markdown 摘要。
- localStorage 会话恢复。
- 示例数据可直接加载。
- PWA manifest 与 service worker，支持离线缓存应用外壳。

## 打开方式

直接用本地静态服务器打开：

```powershell
npm run serve
```

然后访问终端显示的本地地址，默认是：

```text
http://localhost:4173/
```

也可以用任何静态文件服务器托管整个目录。由于 service worker 需要安全上下文，建议使用 `localhost` 或 HTTPS，而不是直接双击 `index.html`。

## 示例数据

目录 `examples/` 包含两份可直接加载的数据：

- `examples/ai-eval-log.jsonl`：AI eval 结果，包含一行故意损坏的 JSON 用于测试错误隔离。
- `examples/backend-structured-log.ndjson`：后端结构化日志。

应用内的“加载示例”按钮会读取 `examples/ai-eval-log.jsonl`。

## 数据隐私

- 文件通过 File API 在浏览器内读取。
- 解析、统计、过滤、导出都在当前页面内完成。
- 应用没有网络上传逻辑。
- 最近一次会话会保存到 `localStorage`，默认最大约 2 MB；大文件不会写入缓存。
- 在共享电脑上使用后，请点击“清除会话”或清理浏览器站点数据。

## 浏览器限制

- 大文件受内存、主线程性能和 localStorage 容量限制影响。
- 当前版本优先提供即时本地分析，没有使用 Web Worker；数十万行以上文件可能出现短暂卡顿。
- service worker 离线缓存需要通过 `localhost` 或 HTTPS 访问。
- CSV 导出以 UTF-8 文本生成，电子表格软件打开时请确认编码。

## 测试

项目使用 Node 标准库 `node:test`，不需要安装第三方依赖：

```powershell
npm test
npm run check:no-placeholders
```

测试覆盖 parser、字段推断、filter、stats、export、storage 等核心逻辑。

## 目录结构

```text
.
├── index.html
├── styles.css
├── app.js
├── src/core.js
├── sw.js
├── manifest.webmanifest
├── assets/icon.svg
├── examples/
├── scripts/
├── test/
└── .github/workflows/ci.yml
```

## English

JSONL Insight PWA is a zero-build offline web app for local inspection of JSONL and NDJSON files. It is designed for AI eval logs, tool-call traces, and structured backend logs. Drop a file into the first screen and the app infers fields, filters rows, computes numeric and categorical summaries, detects date ranges, isolates parse errors, samples rows, and exports CSV or Markdown.

Data stays in the browser. There is no backend and no upload path. The app shell is cached by a service worker when served from `localhost` or HTTPS.

Run locally:

```powershell
npm run serve
npm test
```

Open `http://localhost:4173/` after the server starts.
