#!/usr/bin/env node
// cdp-eval.mjs — 对运行中的 dev Electron 窗口执行任意 JS 并打印返回值。
// 用法: node tooling/scripts/cdp-eval.mjs [窗口title片段] <表达式>
//   node tooling/scripts/cdp-eval.mjs Editor "getComputedStyle(document.body).fontSize"
//   node tooling/scripts/cdp-eval.mjs "项目管理" "document.querySelectorAll('button').length"
// 窗口省略时默认匹配 "Editor"。表达式应自带 JSON.stringify（或返回可序列化值）。
// 依据 AGENTS.md「Playwright 与开发期窗口访问」：dev 窗口经 CDP 9222 暴露，仅限开发期诊断。
import http from 'node:http';

const [titlePart = 'Editor', ...rest] = process.argv.slice(2);
const expression = rest.join(' ');
if (!expression) { console.error('用法: node cdp-eval.mjs [窗口title片段] <表达式>'); process.exit(1); }

const targets = await new Promise((resolve, reject) => {
  http.get('http://127.0.0.1:9222/json/list', (res) => {
    let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve(JSON.parse(data)));
  }).on('error', reject);
});
const target = targets.find((t) => t.type === 'page' && t.title.includes(titlePart))
  ?? targets.find((t) => t.type === 'page' && t.url.includes(titlePart));
if (!target) { console.error(`未找到窗口: ${titlePart}；现有: ` + targets.map((t) => t.title).join(' | ')); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msgId = ++id; pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
if (result.exceptionDetails) {
  console.error('表达式抛错:', JSON.stringify(result.exceptionDetails, null, 2));
} else {
  console.log(result.result.value);
}
ws.close();
process.exit(0);
