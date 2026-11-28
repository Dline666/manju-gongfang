// 自定义端点与可删除平台清单的端到端回归：
// 加一个 OpenAI 兼容端点 → 选它生图 → 断言请求体原样带上协议、Base URL 与模型 ID；
// 删掉内置平台 → 它从下拉消失 → 恢复 → 回来，而且它改过的模型 ID 还在。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { pickSearchOption, searchSelectOptions } from './select-helpers.mjs';

const BASE = 'https://api.example.com/v1';

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

    // 建一个系列并直接铺好这一集的资产：端点是设置项，这里只需要有人物可以生图。
    await page.goto('http://127.0.0.1:5173/#/library');
    await page.waitForTimeout(500);
    const seeded = await page.evaluate(async () => {
      const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')));
      const series = s.createSeries('断剑归门', '东方玄幻水墨风');
      const ep = series.episodes[0];
      s.updateEpisode(series.id, ep.id, cur => ({ ...cur,
        assets: [{ id: 'ep-hero', kind: 'character', name: '阿青', description: '黑短发，青色布衣', lock: '黑短发，青色布衣' }],
        shots: [1, 2, 3, 4].map(n => ({
          id: `ep-shot-${n}`, number: n, duration: 12, visual: `第${n}镜画面`, camera: '中景·固定·平视',
          start: n === 1 ? '开场' : '接上镜', action: '动作', end: n === 4 ? '终点' : '雨落',
          dialogues: [], assetIds: ['ep-hero'], references: [], audioMode: 'original',
        })),
        storyboardReady: true }), false);
      return { seriesId: series.id, episodeId: ep.id };
    });

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
    const scriptOptions = await searchSelectOptions(page, '剧本默认模型平台');
    assert.ok(scriptOptions.some(text => text.includes('我的中转站')), '自定义端点应出现在剧本下拉');
    await openTab('生图');
    const imageOptions = await searchSelectOptions(page, '生图默认模型平台');
    assert.ok(imageOptions.some(text => text.includes('我的中转站')), '自定义端点应出现在生图下拉');
    await pickSearchOption(page, '生图默认模型平台', '我的中转站');
    await openTab('视频');
    const videoOptions = await searchSelectOptions(page, '视频默认模型平台');
    assert.ok(!videoOptions.some(text => text.includes('我的中转站')), '自定义端点只覆盖剧本与生图，不该出现在视频下拉');

    // Key 不落盘，Base URL 属于作品配置、留在本机
    const stored = await page.evaluate(() => localStorage.getItem('manju-studio-v1') || '');
    assert.ok(!stored.includes('fixture-key'), 'API Key 不能落盘');
    assert.ok(stored.includes('api.example.com'), 'Base URL 应作为作品配置保存在本机');

    // 用它生图：请求体必须原样带上协议、Base URL 与模型 ID
    await page.goto(`http://127.0.0.1:5173/#/library/${seeded.seriesId}/${seeded.episodeId}`);
    await page.getByRole('button', { name: '角色设置', exact: true }).click();
    await page.getByRole('button', { name: /生成设定图/ }).first().click();
    const image = await (async () => {
      for (let i = 0; i < 60; i++) { const hit = calls.find(call => call.action === 'image'); if (hit) return hit; await page.waitForTimeout(250); }
    })();
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
    const afterDelete = await searchSelectOptions(page, '生图默认模型平台');
    assert.ok(!afterDelete.some(text => text.includes('OpenAI')), '删掉的平台不该留在下拉里');
    assert.ok(afterDelete.some(text => text.includes('我的中转站')), '删一个平台不该影响其它端点');
    await page.getByRole('heading', { name: '已删除的内置平台' }).waitFor();
    const removed = page.locator('.provider-group').filter({ has: page.getByRole('heading', { name: '已删除的内置平台', exact: true }) });
    await removed.getByRole('button', { name: '恢复', exact: true }).click();
    const afterRestore = await searchSelectOptions(page, '生图默认模型平台');
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
