// 后端不可达时，界面要说清是「本地服务没连上」，而不是让人去查模型配置。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // 模拟 dev 代理在 Function 没起来时的 502：不是 JSON 信封
    await page.route('**/functions/v1/app?*', route => route.fulfill({ status: 502, contentType: 'text/plain', body: 'Proxy error: connect ECONNREFUSED 127.0.0.1:8000' }));

    await page.goto('http://127.0.0.1:5173/');
    await page.evaluate(async () => {
      const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts');
      const { templateScript } = await import('/src/features/script/creation.ts');
      const p = s.createProject('后端不可达测试', '山门断剑');
      const draft = templateScript(p.theme);
      draft.assets = [{ id: 'hero', kind: 'character', name: '阿青', description: '十七岁少年，灰白旧布衣', lock: '十七岁少年，灰白旧布衣' }];
      s.updateProject(p.id, { ...draft, source: 'template', storyboardReady: true });
      s.setKey('openai', 'fixture-key');
      location.hash = '/assets';
    });
    await page.getByRole('button', { name: '查看阿青详情', exact: true }).click();
    await page.getByRole('button', { name: '生成设定图', exact: true }).click();
    await page.getByRole('button', { name: '确认发送并生成图片', exact: true }).click();
    await page.getByText('本地服务没有响应', { exact: false }).waitFor({ timeout: 20000 });
    const text = await page.getByRole('dialog').textContent();
    assert.ok(text.includes('npm run dev:function'), '要告诉用户怎么把本地服务起起来');
    assert.ok(!text.includes('检查模型配置和网络'), '后端不可达时不该再指向模型配置');
    assert.deepEqual(errors, []);
    results.push({ width, passed: true, message: text.replace(/\s+/g, ' ').slice(0, 120), errors });
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally { await browser.close(); }
