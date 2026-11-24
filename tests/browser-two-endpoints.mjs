// 两个自定义端点各管一个环节：gpt 负责图像、gemini 负责剧本。
// 断言：两个端点各自的 Base URL / Key / 模型 ID 不会串，生图请求走图像端点。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { pickSearchOption, searchSelectOptions } from './select-helpers.mjs';

const IMG_BASE = 'https://img.example.com/v1';
const TXT_BASE = 'https://txt.example.com/v1';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = []; const calls = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/functions/v1/app?*', async route => {
      const action = new URL(route.request().url()).searchParams.get('action');
      calls.push({ action, body: route.request().postDataJSON() });
      if (action === 'image') {
        const base64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; const x = c.getContext('2d'); x.fillStyle = '#22cbb8'; x.fillRect(0, 0, 8, 8); return c.toDataURL('image/png').split(',')[1]; });
        return route.fulfill({ json: { ok: true, data: { base64, mime: 'image/png' } } });
      }
      return route.fulfill({ json: { ok: true, data: {} } });
    });
    const openTab = async title => { await page.getByRole('tab', { name: new RegExp(`^${title}`) }).click(); };
    // 当前展开的自定义端点面板（每次只会展开一个）
    const openPanel = () => page.locator('.provider-panel').filter({ has: page.locator('input[placeholder="https://api.example.com/v1"]') });

    await page.goto('http://127.0.0.1:5173/');
    await page.evaluate(async () => {
      const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')));
      const { templateScript } = await import('/src/features/script/creation.ts');
      const p = s.createProject('双端点测试', '山门断剑');
      const draft = templateScript(p.theme);
      draft.assets = [{ id: 'hero', kind: 'character', name: '阿青', description: '十七岁少年，灰白旧布衣', lock: '十七岁少年，灰白旧布衣' }];
      s.updateProject(p.id, { ...draft, source: 'template', storyboardReady: true });
      location.hash = '/settings';
    });
    await page.getByRole('heading', { name: '连接你的创作能力' }).waitFor();

    // 端点一：只管生图
    await openTab('自定义端点');
    await page.getByRole('button', { name: '添加自定义端点' }).click();
    await openPanel().getByLabel('端点名称').fill('图像端点');
    await openPanel().getByLabel('Base URL').fill(IMG_BASE);
    await openPanel().getByLabel('API Key').fill('img-key');
    await openPanel().getByLabel('剧本', { exact: true }).uncheck();
    await openPanel().getByLabel('生图模型 ID').fill('gpt-image-2');

    // 端点二：只管剧本
    await page.getByRole('button', { name: '添加自定义端点' }).click();
    await openPanel().getByLabel('端点名称').fill('文本端点');
    await openPanel().getByLabel('Base URL').fill(TXT_BASE);
    await openPanel().getByLabel('API Key').fill('txt-key');
    await openPanel().getByLabel('生图', { exact: true }).uncheck();
    await openPanel().getByLabel('文本模型 ID').fill('gemini-4-argon');

    // 两个下拉各只看到自己的那个端点
    await openTab('剧本');
    const scriptOptions = await searchSelectOptions(page, '剧本默认模型平台');
    assert.ok(scriptOptions.some(text => text.includes('文本端点')), '剧本下拉应包含文本端点');
    assert.ok(!scriptOptions.some(text => text.includes('图像端点')), '图像端点不负责剧本，不该出现在剧本下拉');
    await pickSearchOption(page, '剧本默认模型平台', '文本端点');
    await openTab('生图');
    const imageOptions = await searchSelectOptions(page, '生图默认模型平台');
    assert.ok(imageOptions.some(text => text.includes('图像端点')), '生图下拉应包含图像端点');
    assert.ok(!imageOptions.some(text => text.includes('文本端点')), '文本端点不负责生图，不该出现在生图下拉');
    await pickSearchOption(page, '生图默认模型平台', '图像端点');

    // 剧本步骤显示的是文本端点
    await page.goto('http://127.0.0.1:5173/#/script');
    await page.getByText('文本端点 · gemini-4-argon').waitFor();

    // 生图请求必须走图像端点：Base URL、Key、模型都不串
    await page.goto('http://127.0.0.1:5173/#/assets');
    await page.getByRole('button', { name: '查看阿青详情', exact: true }).click();
    await page.getByRole('button', { name: '生成设定图', exact: true }).click();
    await page.getByRole('button', { name: '确认发送并生成图片', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const image = calls.find(call => call.action === 'image');
    assert.ok(image, '应当发出生图请求');
    assert.equal(image.body.baseUrl, IMG_BASE);
    assert.equal(image.body.key, 'img-key');
    assert.equal(image.body.model, 'gpt-image-2');
    assert.equal(image.body.provider, 'openai-compatible');

    assert.deepEqual(errors, []);
    results.push({ width, passed: true, checks: ['image endpoint owns image only', 'text endpoint owns screenplay only', 'image request carries its own base url and key'], errors });
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally { await browser.close(); }
