import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { pickSearchOption } from './select-helpers.mjs';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const imageModels = [
  ['openai', 'gpt-image-2.6-sunburst'], ['openai', 'gpt-image-2.6-flare'],
  ['seedream', 'doubao-seedream-5-5-261028'], ['seedream', 'doubao-seedream-5-0-pro-260628'], ['seedream', 'doubao-seedream-5-0-flash-260915'],
  ['siliconflow', 'Kwai-Kolors/Kolors'],
];
const videoModels = [
  ['seedance', 'doubao-seedance-2-5-260628'], ['seedance', 'doubao-seedance-2-0-260128'],
  ['seedance', 'doubao-seedance-2-0-fast-260128'], ['seedance', 'doubao-seedance-2-0-mini-260615'], ['minimax', 'MiniMax-H3'],
];
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = []; const calls = []; let failImage = false;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/functions/v1/app?*', async route => {
      const action = new URL(route.request().url()).searchParams.get('action');
      const body = route.request().postDataJSON(); calls.push({ action, body });
      if (action === 'image') {
        if (failImage) return route.fulfill({ status: 401, json: { ok: false, error: 'provider_auth_failed' } });
        const base64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#00c2b8'; x.fillRect(0, 0, 64, 64); return c.toDataURL('image/png').split(',')[1]; });
        return route.fulfill({ json: { ok: true, data: { base64, mime: 'image/png' } } });
      }
      if (action === 'video-create') return route.fulfill({ json: { ok: true, data: { id: `fixture-${calls.length}`, status: 'queued' } } });
      if (action === 'video-status') return route.fulfill({ json: { ok: true, data: { status: 'running' } } });
      throw new Error(`Unexpected action ${action}`);
    });
    const go = async stage => { await page.evaluate(stage => { location.hash = `/${stage}`; }, stage); };
    const overflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `overflow ${width}`);
    const panel = name => page.locator('.provider-panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
    // 设置页按环节分页签：先切到对应页签，再展开端点行才能填 Key。
    const openTab = async title => { await page.getByRole('tab', { name: new RegExp(`^${title}`) }).click(); };
    const expand = async name => { const button = panel(name).getByRole('button', { name: '设置', exact: true }); if (await button.count()) await button.click(); };
    const close = async () => { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); };
    const createImage = async () => {
      await page.getByRole('button', { name: '查看模型测试人物详情', exact: true }).click();
      await page.getByRole('button', { name: '生成设定图', exact: true }).click();
    };
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')));
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('heading', { name: '我的作品' }).waitFor();
    await page.evaluate(async () => {
      const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')));
      const { templateScript } = await import('/src/features/script/creation.ts');
      const p = s.createProject('隔离模型测试', '山门断剑'); const draft = templateScript(p.theme);
      // 剧本步骤不再预置人物资产，这里手动建一个用于生图测试。
      draft.assets = [{ id: 'model-hero', kind: 'character', name: '模型测试人物', description: '十七岁少年，灰白旧布衣', lock: '十七岁少年，灰白旧布衣' }];
      s.updateProject(p.id, { ...draft, source: 'template', storyboardReady: true });
      location.hash = '/assets';
    });
    const imageSelect = page.getByRole('combobox', { name: /^生图模型/ });
    await expect(imageSelect).toContainText('GPT Image 2.6 Sunburst');
    await imageSelect.click();
    await page.locator('.search-select-popover').waitFor();
    await page.locator('.search-select-more').click();
    assert.deepEqual(await page.locator('.search-select-popover .search-select-group').allTextContents(), ['OpenAI', '火山引擎 / 即梦 · Seedream', '硅基流动 SiliconFlow（免费）']);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await pickSearchOption(page, /^生图模型/, 'doubao-seedream-5-5-261028');
    await createImage();
    await page.getByRole('heading', { name: '连接你的创作能力' }).waitFor();
    assert.equal(calls.length, 0);
    await expect(page.locator('.provider-panel .tag')).toHaveText(Array(2).fill('Key 缺失'));
    await openTab('视频');
    await expect(panel('MiniMax 国内版')).toContainText('仅支持国内开放平台 Key');
    for (const [tab, name] of [['生图', 'OpenAI'], ['生图', '火山引擎 / 即梦 · Seedream'], ['生图', '硅基流动 SiliconFlow（免费）'], ['视频', '火山引擎 Seedance'], ['视频', 'MiniMax 国内版']]) {
      await openTab(tab);
      await expand(name);
      await panel(name).getByLabel('API Key', { exact: true }).fill('fixture-key-not-transmitted');
      await expect(panel(name).locator('.tag')).toHaveText('已填写 · 待验证');
    }
    await overflow();
    await go('assets');
    for (const [provider, model] of imageModels) {
      await pickSearchOption(page, /^生图模型/, model);
      await page.getByRole('button', { name: '生图模型说明' }).click();
      await expect(page.getByText(/当前生图渠道/)).toContainText(model);
      await page.keyboard.press('Escape');
      const before = calls.filter(c => c.action === 'image').length;
      await createImage();
      await expect(page.getByRole('dialog')).toContainText(model);
      assert.equal(calls.filter(c => c.action === 'image').length, before, 'confirmation must not send');
      await page.getByRole('button', { name: '确认发送并生成图片', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const call = calls.filter(c => c.action === 'image').at(-1);
      assert.equal(call.body.provider, provider); assert.equal(call.body.model, model);
      assert.ok(call.body.prompt.includes('主体：模型测试人物'), '图片提示词应来自数据块');
      assert.ok(!call.body.prompt.includes('正面、侧面、背面'), '系统不再自带三视图默认文案');
      assert.ok((await saved()).projects[0].assets[0].imageId);
    }
    await overflow();
    await imageSelect.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `dev/image-models-${width}.png` });
    await go('settings');
    await openTab('生图');
    await expect(panel('OpenAI').locator('.tag')).toHaveText('可用');
    await expect(panel('火山引擎 / 即梦 · Seedream').locator('.tag')).toHaveText('可用');
    await expand('火山引擎 / 即梦 · Seedream');
    await panel('火山引擎 / 即梦 · Seedream').getByRole('textbox', { name: /^模型 ID/ }).fill('ep-custom-seedream');
    await go('assets');
    await pickSearchOption(page, /^生图模型/, 'ep-custom-seedream');
    await expect(imageSelect).toContainText('ep-custom-seedream');
    await createImage(); await page.getByRole('button', { name: '确认发送并生成图片', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(calls.filter(c => c.action === 'image').at(-1).body.model, 'ep-custom-seedream');
    failImage = true;
    await pickSearchOption(page, /^生图模型/, 'gpt-image-2.6-sunburst');
    await createImage(); const beforeFailure = calls.filter(c => c.action === 'image').length;
    const beforeImage = (await saved()).projects[0].assets[0].imageId;
    await page.getByRole('button', { name: '确认发送并生成图片', exact: true }).click();
    await page.getByText('模型平台拒绝了此 Key，请检查密钥及账号地区。', { exact: true }).waitFor();
    await page.getByText('Key 错了：回设置页重新粘贴，并确认平台与地区', { exact: true }).waitFor();
    await close();
    assert.equal(calls.filter(c => c.action === 'image').length, beforeFailure + 1, 'no automatic fallback or retry');
    assert.equal((await saved()).projects[0].assets[0].imageId, beforeImage);
    await page.getByRole('button', { name: '生图模型说明' }).click();
    await expect(page.getByText(/当前生图渠道/)).toContainText('免费兜底暂未配置');
    await page.keyboard.press('Escape');
    await go('settings');
    await openTab('生图');
    await expect(panel('OpenAI').locator('.tag')).toHaveText('调用失败');
    await expect(panel('OpenAI')).toContainText('Key 错了：回设置页重新粘贴，并确认平台与地区');
    await expand('OpenAI');
    await panel('OpenAI').getByLabel('API Key', { exact: true }).fill('replacement-fixture-key');
    await expect(panel('OpenAI').locator('.tag')).toHaveText('已填写 · 待验证');
    await panel('OpenAI').getByLabel('API Key', { exact: true }).fill('');
    await expect(panel('OpenAI').locator('.tag')).toHaveText('Key 缺失');
    await page.screenshot({ path: `dev/channel-status-${width}.png` });
    await go('generation');
    const videoSelect = page.getByRole('combobox', { name: /^视频模型/ });
    await expect(videoSelect).toContainText('Doubao-Seedance-2.0-fast');
    await videoSelect.click();
    await page.locator('.search-select-popover').waitFor();
    assert.deepEqual(await page.locator('.search-select-popover .search-select-group').allTextContents(), ['火山引擎 Seedance', 'MiniMax 国内版']);
    assert.equal(await page.locator('.search-select-popover .search-select-option').count(), 5);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    for (const [index, [provider, model]] of videoModels.entries()) {
      await pickSearchOption(page, /^视频模型/, model);
      await page.getByRole('button', { name: `查看第${index + 1}镜视频详情`, exact: true }).click();
      await page.getByRole('button', { name: 'API 生成', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText(model);
      if (index === 0) {
        const box = page.getByLabel('即将发送的完整视频提示词');
        const originalPrompt = await box.inputValue();
        assert.ok(originalPrompt.includes('第1镜'));
        await box.fill(`${originalPrompt}\n补充运镜：缓慢推进`);
        await page.getByRole('button', { name: '恢复默认提示词', exact: true }).waitFor();
      }
      const before = calls.filter(c => c.action === 'video-create').length;
      assert.equal(before, index);
      await page.getByRole('button', { name: '确认并开始生成', exact: true }).click();
      await expect(videoSelect).toBeEnabled();
      const call = calls.filter(c => c.action === 'video-create').at(-1);
      assert.equal(call.body.provider, provider); assert.equal(call.body.model, model);
      const shotDurations = (await saved()).projects[0].shots.map(shot => shot.duration);
      assert.equal(call.body.duration, shotDurations[index]);
      if (index === 0) assert.ok(call.body.prompt.includes('补充运镜：缓慢推进'));
      assert.equal((await saved()).projects[0].shots[index].task.model, model);
    }
    await overflow();
    await videoSelect.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `dev/video-models-${width}.png` });
    await page.getByRole('button', { name: '查看第6镜视频详情', exact: true }).click();
    await page.getByRole('button', { name: 'API 生成', exact: true }).click();
    await page.evaluate(async () => {
      const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')));
      s.setSettings({ ...s.getStudio().settings, videoProvider: 'seedance' });
    });
    await page.getByRole('button', { name: '确认并开始生成', exact: true }).click();
    await page.getByText('视频模型设置已改变，剩余任务未提交，请重新确认。', { exact: true }).waitFor();
    assert.equal(calls.filter(c => c.action === 'video-create').length, 5);
    const persisted = await saved();
    assert.equal(persisted.keys, undefined); assert.equal(persisted.providerStatus, undefined);
    assert.ok(!JSON.stringify(persisted).includes('fixture-key-not-transmitted'));
    await page.reload();
    await expect(videoSelect).toContainText('Doubao-Seedance-2.0-mini');
    await go('settings');
    await expect(page.locator('.provider-panel .tag')).toHaveText(Array(2).fill('Key 缺失'));
    await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('manju-studio-v1'));
      delete data.settings.imageProvider; delete data.settings.models.seedream;
      data.settings.models.seedance = 'ep-legacy-kept';
      localStorage.setItem('manju-studio-v1', JSON.stringify(data));
    });
    await page.reload();
    await openTab('视频'); await expand('火山引擎 Seedance');
    await expect(panel('火山引擎 Seedance').getByRole('textbox', { name: /^模型 ID/ })).toHaveValue('ep-legacy-kept');
    await openTab('生图'); await expand('火山引擎 / 即梦 · Seedream');
    await expect(panel('火山引擎 / 即梦 · Seedream').getByRole('textbox', { name: /^模型 ID/ })).toHaveValue('doubao-seedream-5-5-261028');
    await expect(page.getByText(/已停止覆盖保存/)).toHaveCount(0);
    await go('assets'); await expect(imageSelect).toContainText('GPT Image 2.6 Sunburst');
    assert.equal((await saved()).projects[0].name, '隔离模型测试');
    assert.deepEqual(errors, []);
    results.push({ width, images: calls.filter(c => c.action === 'image').length, videos: calls.filter(c => c.action === 'video-create').length, errors });
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally { await browser.close(); }
