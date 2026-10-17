// 裸 CDP 驱动运行中的 dev Electron 窗口（无需 playwright），做真机 DOM / 交互验证。
// 依赖仓库内 ws 包（node_modules/ws，经 createRequire 从本文件所在目录解析），必须显式加载：
// Node 22+ 的全局 WHATWG WebSocket 只有 addEventListener / readyState，没有 ws 包的
// .on()/.send(JSON 字符串) API，直接 new WebSocket(...) 会在 attach 时崩溃
// （TypeError: ws.on is not a function，2026-10-16 Node v25.6.0 实证）。
// 前提：dev 实例已起（未打包默认开 --remote-debugging-port 9222，环境变量 IART_CDP_PORT 可覆盖；
// 见 apps/desktop-shell/src/desktop-shell-bootstrap.cts）。用法与四坑纪律见同目录 README.md。
// 本文件是驱动基座，不属于构建链、不参与门禁；各次验证写一次性 phase 脚本 import 它。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

export const getJson = (url) =>
  new Promise((res, rej) => {
    require('node:http')
      .get(url, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res(JSON.parse(d)));
      })
      .on('error', rej);
  });

/**
 * attach 到 Hub 窗口（file://…/apps/hub/dist-static/index.html）。
 * Editor 窗口要先在 Hub 里点开一个项目卡片才会出现；要驱动 Editor 时按 URL 含 /editor/ 自行过滤。
 */
export async function attachHub(port = 9222) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  const hub = list.find((t) => t.type === 'page' && t.url.includes('hub/dist-static'));
  if (!hub) throw new Error('NO_HUB_TARGET');
  const ws = new WebSocket(hub.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  // 纪律一：所有 evalJs 必须 await——忘 await 拿到 Promise 是 truthy，判空放行后坐标为 undefined。
  // 纪律二：send 不检查 CDP error 字段，错误被吞，「脚本跑完」≠「点中」——每次点击后必须读数复核
  // （aria-checked / aria-pressed / computed display / 按钮文案），见 pitfalls.md 2026-09-26 CDP 条。
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __exception: r.result.exceptionDetails.exception?.description || 'exception' };
    return r.result?.result?.value;
  };
  return { ws, send, evalJs };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真实鼠标三连（mouseMoved → pressed → released）。坐标必须来自「先 scrollIntoView({block:'center'})
// 再取 getBoundingClientRect 中心」——视口外元素 rect 超界，直接点会落空；禁止用 evaluate 派发合成事件
// 代替（绕开命中/捕获语义，得出假的绿色）。
export async function realClick(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
