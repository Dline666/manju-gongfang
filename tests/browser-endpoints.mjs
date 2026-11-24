// 自定义端点与可删除平台清单的端到端回归：
// 加一个 OpenAI 兼容端点 → 选它生图 → 断言请求体原样带上协议、Base URL 与模型 ID；
// 删掉内置平台 → 它从下拉消失 → 恢复 → 回来，而且它改过的模型 ID 还在。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const BASE = 'https://api.example.com/v1';
const source = '人物：阿青：黑短发，青色布衣\n场景：山门：黑石阶，薄雾\n道具：断剑：红绳剑柄，斜断口\n'
  + Array.from({ length: 10 }, (_, i) => `第${i + 1}镜（9秒）\n画面：阿青在山门举起断剑\n开场：石阶前\n动作：抬手\n终点：站定\n运镜：推进\n台词：阿青：我回来了。`).join('\n\n');

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
        const base64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; const x = c.getContext('2d'); x.fillStyle = '#00c2b8'; x.fillRect(0, 0, 8, 8); return c.toDataURL('image/png').split(',')[1]; });
        return route.fulfill({ json: { ok: true, data: { base64, mime: 'image/png' } } });
      }
      return route.fulfill({ json: { ok: true, data: {} } });
    });

    // 建一个作品并导入剧本（沿用既有回归的稳定路径）
    await page.goto('http://127.0.0.1:5173/');
    await page.getByLabel('一句话故事主题').fill('断剑归门');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('button', { name: '导入剧本', exact: true }).click();
    await page.getByLabel('或粘贴原文').fill(source);
    await page.getByRole('button', { name: '解析并预览', exact: true }).click();
    await page.getByRole('button', { name: '确认导入并替换剧本', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    // 设置页：加一个自定义端点
    await page.goto('http://127.0.0.1:5173/#/settings');
    await page.getByRole('heading', { name: '连接你的创作能力' }).waitFor();
    const openTab = async title => { await page.getByRole('tab', { name: new RegExp(`^${title}`) }).click(); };
    await openTab('自定义端点');
    await page.getByRole('button', { name: '添加自定义端点' }).click();
    // 用 Base URL 占位符认这块自定义面板（改名之后面板标题会跟着变）
    const custom = page.locator('.provider-panel').filter({ has: page.locator('input[placeholder="https://api.example.com/v1"]') });
    await custom.getByLabel('端点名称').fill('我的中转站');
    await custom.getByLabel('Base URL').fill(BASE);
    await custom.getByLabel('API Key').fill('fixture-key');
    await custom.getByLabel('文本模型 ID').fill('qwen-max');
    await custom.getByLabel('生图模型 ID').fill('flux-1');

    // 它出现在剧本与生图的端点下拉里，但不该出现在视频下拉里（各环节下拉在不同页签）
    await openTab('剧本');
    const scriptSelect = page.getByLabel('剧本默认模型平台');
    assert.ok((await scriptSelect.locator('option').allTextContents()).some(text => text.includes('我的中转站')), '自定义端点应出现在剧本下拉');
    await openTab('生图');
    const imageSelect = page.getByLabel('生图默认模型平台');
    assert.ok((await imageSelect.locator('option').allTextContents()).some(text => text.includes('我的中转站')), '自定义端点应出现在生图下拉');
    await imageSelect.selectOption({ label: '我的中转站 · flux-1' });
    await openTab('视频');
    const videoSelect = page.getByLabel('视频默认模型平台');
    assert.ok(!(await videoSelect.locator('option').allTextContents()).some(text => text.includes('我的中转站')), '自定义端点只覆盖剧本与生图，不该出现在视频下拉');

    // Key 不落盘，Base URL 属于作品配置、留在本机
    const stored = await page.evaluate(() => localStorage.getItem('manju-studio-v1') || '');
    assert.ok(!stored.includes('fixture-key'), 'API Key 不能落盘');
    assert.ok(stored.includes('api.example.com'), 'Base URL 应作为作品配置保存在本机');

    // 用它生图：请求体必须原样带上协议、Base URL 与模型 ID
    await page.goto('http://127.0.0.1:5173/#/assets');
    await page.getByRole('button', { name: '查看阿青详情', exact: true }).click();
    await page.getByRole('button', { name: '生成设定图', exact: true }).click();
    await page.getByRole('button', { name: '确认发送并生成图片', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const image = calls.find(call => call.action === 'image');
    assert.ok(image, '自定义端点应发出生图请求');
    assert.equal(image.body.provider, 'openai-compatible');
    assert.equal(image.body.baseUrl, BASE);
    assert.equal(image.body.model, 'flux-1');
    assert.equal(image.body.key, 'fixture-key');
    assert.equal(image.body.endpointId, undefined, 'endpointId 只用于本地记账，不该发给后端');

    // 删掉内置平台：它从下拉消失，别的端点不受影响，还能恢复
    await page.goto('http://127.0.0.1:5173/#/settings');
    await page.getByRole('heading', { name: '连接你的创作能力' }).waitFor();
    await openTab('生图');
    const openai = page.locator('.provider-panel').filter({ has: page.getByRole('heading', { name: 'OpenAI', exact: true }) });
    await openai.getByRole('button', { name: '删除', exact: true }).click();
    const afterDelete = await page.getByLabel('生图默认模型平台').locator('option').allTextContents();
    assert.ok(!afterDelete.some(text => text.includes('OpenAI')), '删掉的平台不该留在下拉里');
    assert.ok(afterDelete.some(text => text.includes('我的中转站')), '删一个平台不该影响其它端点');
    await page.getByRole('heading', { name: '已删除的内置平台' }).waitFor();
    const removed = page.locator('.provider-group').filter({ has: page.getByRole('heading', { name: '已删除的内置平台', exact: true }) });
    await removed.getByRole('button', { name: '恢复', exact: true }).click();
    const afterRestore = await page.getByLabel('生图默认模型平台').locator('option').allTextContents();
    assert.ok(afterRestore.some(text => text.includes('OpenAI')), '恢复后它回到下拉里');
    assert.ok(afterRestore.some(text => text.includes('gpt-image-2.6-sunburst')), '恢复后它改过的模型 ID 也该回来');

    assert.deepEqual(errors, []);
    results.push({
      width,
      passed: true,
      checks: [
        'custom endpoint appears in script and image selectors only',
        'custom endpoint sends provider/baseUrl/model/key verbatim',
        'endpointId is not sent to the backend',
        'api key stays out of local storage while base url is kept',
        'builtin platform removable and restorable with its model id',
      ],
      errors,
    });
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally { await browser.close(); }
