// 聊天室流式验收：文字必须「一段一段长出来」，而不是等全部生成完再一次性显示。
// 用真实链路：临时 Vite 实例（独立端口）把 /functions/v1/app 代理到一个本地 SSE 服务，
// 这样 Vite 代理、SSE 解析、前端增量渲染三层都被真实覆盖，且不碰 5173 上正在跑的服务。
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import assert from 'node:assert/strict';

const CHUNKS = ['雨夜', '，少年拾起', '一把断剑。'];
const FULL = CHUNKS.join('');

// 后端替身：逐块推送 SSE，一块之间隔 150ms，让「文字在长」可被观测。
const backend = createServer(async (request, response) => {
  let body = '';
  request.on('data', part => { body += part; });
  request.on('end', async () => {
    const fail = body.includes('触发失败');
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    for (const chunk of CHUNKS) {
      response.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    response.write(`data: ${JSON.stringify(fail ? { error: 'insufficient_balance' } : { done: true })}\n\n`);
    response.end();
  });
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const backendPort = backend.address().port;

// 独立 Vite：静态资源走真实构建流程，/functions/v1/app 指向上面的替身。
const vite = await createViteServer({
  configFile: 'vite.config.ts',
  server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/functions/v1/app': `http://127.0.0.1:${backendPort}` } },
  logLevel: 'error',
});
await vite.listen();
const address = vite.httpServer?.address();
const frontPort = typeof address === 'object' && address ? address.port : 5173;

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(`http://127.0.0.1:${frontPort}/#/chat`);
    const input = page.locator('textarea.chat-input').first();
    await input.waitFor({ timeout: 20000 });
    // Key 只存在内存里，不进 localStorage：必须在页面里注入。
    await page.evaluate(async () => {
      const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts');
      s.setKey(s.getStudio().settings.scriptProvider, 'fixture-key');
    });

    await input.fill('写一段小说开头');
    await page.getByRole('button', { name: /发送/ }).first().click();

    // 关键断言：正文必须「一段一段长出来」。
    // Playwright 轮询比 150ms 的块间隔还慢，采不到中间态；改用页面内 MutationObserver 记录真实渲染序列。
    const lengths = await page.evaluate(async full => {
      const seen = [];
      const record = () => {
        // 只量正文节点，别把时间、按钮这些固定文本算进去，否则阶梯不直观。
        const bodies = document.querySelectorAll('.chat-msg.is-assistant .chat-msg-body');
        const last = bodies[bodies.length - 1];
        if (!last) return;
        const text = (last.textContent ?? '').replace(/\s+/g, '');
        if (!seen.length || seen.at(-1) !== text.length) seen.push(text.length);
      };
      const observer = new MutationObserver(record);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      const started = Date.now();
      while (Date.now() - started < 15000) {
        record();
        const bubbles = document.querySelectorAll('.chat-msg.is-assistant');
        const last = bubbles[bubbles.length - 1];
        if (last && (last.textContent ?? '').includes(full)) break;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      observer.disconnect();
      return seen;
    }, FULL);
    assert.ok(lengths.length >= 3, `流式过程中正文长度必须阶梯式增长过，实际采样：${JSON.stringify(lengths)}`);

    await page.locator('.chat-msg.is-streaming').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    const final = await page.locator('.chat-msg.is-assistant').last().innerText();
    assert.ok(final.includes(FULL), `最终正文要完整，实际：${final}`);
    assert.ok(!final.includes('done'), 'done 事件不能漏进正文');
    // 流式结束后，光标必须收掉
    assert.equal(await page.locator('.chat-msg.is-streaming').count(), 0, '结束后不该还留着流式标记');

    // 失败路径：保留半截 + 说明没写完 + 原文回填
    await input.fill('触发失败');
    await page.getByRole('button', { name: /发送/ }).first().click();
    await page.locator('.chat-msg.is-error').last().waitFor({ timeout: 15000 });
    const failed = await page.locator('.chat-msg.is-error').last().innerText();
    assert.ok(failed.includes(FULL), `已流出的半截要保留，实际：${failed}`);
    assert.ok(failed.includes('输出中断'), '要说明这段没写完');
    assert.ok(/余额|额度/.test(failed), '要报出真实的失败原因');
    assert.equal(await input.inputValue(), '触发失败', '失败后原文要留在输入框里便于重发');

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, `${width} 横向溢出`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `dev/chat-stream-${width}.png` });
    results.push({ width, passed: true, lengths, final: final.slice(0, 60), errors });
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, frontPort, results }, null, 2));
} finally {
  await browser.close();
  await vite.close();
  backend.close();
}