// 参考图必须真的进入生图请求。
// 只验证「显示」不够：一张挂在表格里、却从没上传给模型的图，等于给用户一个假承诺。
// 这里把 /functions/v1/app?action=image 截住，检查请求体里有没有 reference。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CHAIN = ['s1', 's2', 's3', 's4', 's5'];
const shot = (n) => ({ number: n, scene: '山门', visual: 'V' + n, duration: 10, shotSize: '中景', movement: '固定', angle: '平视', start: CHAIN[n - 1], action: 'a', end: CHAIN[n] });
const JSON_BODY = {
  assets: [
    { assetId: 'c1', kind: 'character', name: '阿青', description: '少年' },
    { assetId: 'c3', kind: 'character', name: '老剑师', description: '老者，白发' },
  ],
  shots: [shot(1), shot(2), shot(3), shot(4)],
};

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
// 截住生图请求：返回一张合法 PNG，并记下请求体。Key 是假的，请求不会真的发出去。
let captured = null;
await page.route('**/functions/v1/app?action=image', async route => {
  captured = JSON.parse(route.request().postData() || '{}');
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ base64: PNG.toString('base64'), mime: 'image/png' }) });
});

try {
  await page.goto('http://127.0.0.1:5173/#/library');
  await page.evaluate(() => localStorage.clear());

  // Key 只活在当前页面内存里，所以必须在同一个页面里填好再跳路由（hash 跳转不丢内存）。
  await page.goto('http://127.0.0.1:5173/#/settings');
  await page.waitForTimeout(1600);
  await page.locator('.provider-tab', { hasText: '生图' }).click();
  await page.waitForTimeout(600);
  await page.locator('main button.inline-flex').filter({ hasText: /^设置$/ }).first().click();
  await page.waitForTimeout(600);
  await page.locator('input[placeholder="在这里粘贴你的 API Key"]').first().fill('sk-test-only-intercept');
  await page.waitForTimeout(400);

  await page.goto('http://127.0.0.1:5173/#/library');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '新建系列' }).first().click();
  await page.waitForTimeout(500);
  await page.locator('.studio-dialog input').first().fill('参考图进请求');
  await page.getByRole('button', { name: '创建并打开' }).click();
  await page.waitForTimeout(1200);
  const ids = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('manju-studio-v1')).series[0]; return s.id + '/' + s.episodes[0].id; });
  await page.goto('http://127.0.0.1:5173/#/library/' + ids);
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: /导入分镜/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByLabel('分镜 JSON 正文').fill(JSON.stringify(JSON_BODY));
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '确认导入' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: '角色设置' }).click();
  await page.waitForTimeout(900);

  // 给阿青传图，再把老剑师的参考图挂到阿青
  await page.locator('.assets-dialog-table .asset-name').first().click();
  await page.waitForTimeout(600);
  await page.setInputFiles('.lightbox-info input[type=file]', { name: 'a.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForTimeout(1600);
  await page.getByRole('button', { name: '返回列表' }).click();
  await page.waitForTimeout(600);
  await page.dragAndDrop('.assets-dialog-table tbody .asset-table-thumb >> nth=0', '.assets-dialog-table tbody .asset-reference-drop >> nth=1');
  await page.waitForTimeout(1200);

  // 生成老剑师的设定图，看请求体
  await page.getByRole('button', { name: '查看老剑师详情' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /生成设定图/ }).click();
  await page.waitForTimeout(2500);

  assert.ok(captured, '应捕获到生图请求');
  assert.ok(String(captured.reference || '').startsWith('data:image/png;base64,'), `请求里应带参考图 data URL：${String(captured.reference).slice(0, 40)}`);
  assert.ok(captured.prompt.trim().length > 0, '提示词不该为空');
  // 没有挂参考图时不该凭空带一个 reference
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fields: Object.keys(captured), errors }));
} finally { await browser.close(); }