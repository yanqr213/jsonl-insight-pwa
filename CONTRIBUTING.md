# Contributing

感谢你改进 JSONL Insight PWA。这个项目刻意保持零构建、无运行时依赖，方便复制、审计和离线使用。

## 开发原则

- 保持浏览器本地处理数据，不加入上传逻辑。
- 优先使用标准 Web API 和 Node 标准库。
- 核心逻辑放在 `src/core.js`，并配套 `node:test` 覆盖。
- UI 改动需要兼顾移动端和桌面端的稳定布局。
- 示例数据不得包含真实 token、密码、个人邮箱或私有地址。
- 新增导出格式或解析策略时，请在 README 中说明浏览器限制。

## 本地验证

```powershell
npm test
npm run check:no-placeholders
npm run serve
```

打开本地预览后，至少检查：

- 示例数据能加载。
- 解析失败行能在“错误”视图看到。
- 搜索 `status:fail` 和 `latency_ms>5000` 有结果。
- CSV 与 Markdown 能下载。
- 刷新页面后最近会话能恢复。

## 提交建议

- 保持改动聚焦。
- 测试名描述用户可观察行为。
- 对性能敏感的逻辑避免不必要的深拷贝。
