// 端点超时的界面文案回归：拦网络造一个 504，验证用户看到的是「端点超时」而不是含糊话。
// 不真的等 120 秒上游超时，也不产生任何付费请求。
import { chromium } from '@playwright/test';
import { pickSearchOption } from './select-helpers.mjs';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('http://127.0.0.1:5173/');
  await page.evaluate(async () => {
    // 取 app 实际加载过的那个模块 URL：HMR 之后裸路径会拿到另一个实例，存档就对不上了
    const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts';
    const s = await import(url);
    const p = s.createProject('超时文案回归', '少年在雨夜山门拾起一把断剑，却不知剑里封着自己被削去的神格');
    s.updateProject(p.id, { style: '东方玄幻水墨风' });
    location.hash = '/settings';
  });
  await page.getByRole('heading', { name: '连接你的创作能力' }).waitFor({ timeout: 20000 });

  // 一个假端点 + 假 Key，只为让剧本页能进入确认流程
  await page.getByRole('tab', { name: /^自定义端点/ }).click();
  await page.getByRole('button', { name: '添加自定义端点' }).click();
  const panel = page.locator('.provider-panel').filter({ has: page.locator('input[placeholder="https://api.example.com/v1"]') });
  await panel.getByLabel('端点名称').fill('超时回归端点');
  await panel.getByLabel('Base URL').fill('https://direct-api.cangyuansuanli.cn/v1');
  await panel.getByLabel('API Key').fill('sk-regression-fake-key');
  await page.getByRole('tab', { name: /^剧本/ }).click();
  await pickSearchOption(page, '剧本默认模型平台', '超时回归端点');

  await page.route('**/functions/v1/app**', route => {
    const url = route.request().url();
    if (url.includes('action=screenplay')) {
      return route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'endpoint_timeout' }) });
    }
    return route.continue();
  });

  await page.evaluate(() => { location.hash = '/script'; });
  const generate = page.getByRole('button', { name: 'AI 生成剧本', exact: true });
  await generate.waitFor({ timeout: 20000 });
  await generate.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 20000 });
  await dialog.getByRole('button', { name: '确认发送并生成', exact: true }).click();
  await page.waitForTimeout(2500);

  const text = (await dialog.textContent() || '').replace(/\s+/g, ' ');
  const checks = {
    显示端点超时: text.includes('两分钟内没有返回'),
    提醒可能已送达: text.includes('已经送达'),
    提醒先查计费: text.includes('计费'),
    不再显示含糊的提交结果未知: !text.includes('未收到服务商明确结果'),
    提供重试: await dialog.getByRole('button', { name: '重试' }).count() > 0,
  };
  await page.screenshot({ path: 'dev/browser-endpoint-timeout.png' });
  console.log(JSON.stringify({ checks, errors }, null, 2));
  if (!Object.values(checks).every(Boolean) || errors.length) {
    console.error('失败：端点超时文案不符合预期');
    process.exitCode = 1;
  }
  await context.close();
} finally { await browser.close(); }
