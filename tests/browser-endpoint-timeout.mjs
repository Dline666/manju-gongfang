// 端点超时的界面文案回归：拦网络造一个 504，验证用户看到的是「端点超时」而不是含糊话。
// 不真的等 120 秒上游超时，也不产生任何付费请求。
// 新结构里没有剧本页了，同一个错误现在经聊天室返回，文案映射仍在 api.ts 那一层。
import { chromium } from '@playwright/test';
import { pickSearchOption } from './select-helpers.mjs';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('http://127.0.0.1:5173/#/settings');
  await page.getByRole('heading', { name: '连接你的创作能力' }).waitFor({ timeout: 20000 });

  // 一个假端点 + 假 Key，只为让聊天室能发起一次请求
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
    if (url.includes('action=chat')) {
      return route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'endpoint_timeout' }) });
    }
    return route.continue();
  });

  await page.goto('http://127.0.0.1:5173/#/chat');
  const input = page.locator('textarea.chat-input').first();
  await input.waitFor({ timeout: 20000 });
  await input.fill('把这段写成小说开头：少年在雨夜山门拾起一把断剑。');
  await page.getByRole('button', { name: /发送/ }).first().click();

  // 错误留在消息流里，不弹窗、不清空已经写下的内容
  await page.locator('.chat-failure').waitFor({ timeout: 30000 });
  const text = (await page.locator('.chat-failure').textContent() || '').replace(/\s+/g, ' ');
  const checks = {
    显示端点超时: text.includes('两分钟内没有返回'),
    提醒可能已送达: text.includes('已经送达'),
    提醒先查计费: text.includes('计费'),
    不再显示含糊的提交结果未知: !text.includes('未收到服务商明确结果'),
    保留原文可重发: (await input.inputValue()).length > 0,
  };
  await page.screenshot({ path: 'dev/browser-endpoint-timeout.png' });
  console.log(JSON.stringify({ checks, errors }, null, 2));
  if (!Object.values(checks).every(Boolean) || errors.length) {
    console.error('失败：端点超时文案不符合预期');
    process.exitCode = 1;
  }
} finally { await browser.close(); }