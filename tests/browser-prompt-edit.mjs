// 提示词可编辑验收：所有真正发往大模型的提示词，在最终发送前都能改写，
// 并按改写后的内容发送；手动改写不回写提示词模板。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });

const screenplay = `# 第一部分｜核心前提

【核心前提】
少年在雨夜山门拾起一把断剑。

【黄金3秒钩子】
类型：反常细节
△ 门缝里的光一寸一寸暗下去。

# 第二部分｜场景因果节拍表

| 场次 | 场景目标 | 遭遇阻碍 |
|---|---|---|
| 1 | 拾剑 | 山门无人 |

# 第三部分｜世界观与人物关系确认

【世界边界】
- 时代：架空。

# 第四部分｜标准漫剧剧本

## 第一章  断剑归门

### 场景1 外景 · 山门 — 清晨

**剧情：**少年在雨夜山门拾起一把断剑。
**人物：**阿青

【镜头：远景】
△ 少年在雨夜山门拾起一把断剑。（时长3s）

【镜头：中景】
阿青（平静）：“我来拿回我的剑。”（时长2s）
`;

const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = []; const calls = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/functions/v1/app?*', async route => {
      const action = new URL(route.request().url()).searchParams.get('action');
      const body = route.request().postDataJSON(); calls.push({ action, body });
      if (action === 'screenplay') await route.fulfill({ json: { ok: true, data: { title: '断剑归门', logline: '少年拾剑', screenplay } } });
      else if (action === 'extract-characters' || action === 'extract-scenes' || action === 'extract-props') {
        const key = action === 'extract-characters' ? 'characters' : action === 'extract-scenes' ? 'scenes' : 'props';
        const names = key === 'characters' ? ['阿青'] : key === 'scenes' ? ['山门'] : ['断剑'];
        await route.fulfill({ json: { ok: true, data: { [key]: [{ name: names[0], description: '固定描述' }], shots: [{ number: 1, [key]: names }, { number: 2, [key]: [] }] } } });
      }
      else if (action === 'director') {
        const shots = await page.evaluate(async () => {
          const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
          const store = await import(entry);
          return store.getStudio().projects[0].shots.map(shot => ({ number: shot.number, shotSize: '中景', movement: '固定', angle: '平视', start: shot.start || '石阶前', action: shot.action || '抬手', end: shot.end || '站定' }));
        });
        await route.fulfill({ json: { ok: true, data: { shots } } });
      } else throw new Error(`Unexpected network action: ${action}`);
    });
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')).projects[0]);
    const dialog = () => page.getByRole('dialog');
    await page.goto('http://127.0.0.1:5173/');
    await page.getByLabel('一句话故事主题').fill('断剑归门');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.evaluate(async () => { const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')); const store = await import(entry); store.setKey('gemini', 'fixture-not-transmitted'); });

    // 1. 剧本提示词：可改写 → 可恢复默认 → 按改写内容发送。
    await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
    const scriptBox = page.getByLabel('即将发送的完整提示词');
    await expect(scriptBox).toBeEditable();
    const scriptDefault = await scriptBox.inputValue();
    assert.ok(scriptDefault.length > 0, '剧本提示词不能为空');
    await scriptBox.fill(`${scriptDefault}\n手动补充：只影响本次剧本请求`);
    await page.getByRole('button', { name: '恢复默认提示词', exact: true }).click();
    assert.equal(await scriptBox.inputValue(), scriptDefault, '恢复默认必须回到本次生成时的原文');
    const scriptEdited = `${scriptDefault}\n手动补充：只影响本次剧本请求`;
    await scriptBox.fill(scriptEdited);
    await page.getByRole('button', { name: '确认发送并生成', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    const scriptCall = calls.find(call => call.action === 'screenplay');
    assert.ok(scriptCall, '必须真实发出剧本请求');
    assert.equal(scriptCall.body.prompt, scriptEdited, '必须发送改写后的剧本提示词');
    assert.notEqual(scriptCall.body.prompt, scriptDefault);

    // 2. 资产提取提示词：三类各自独立、各自可改写，并按改写内容发送。
    await page.goto('http://127.0.0.1:5173/#/assets');
    const defaults = {};
    for (const category of [{ label: '人物', action: 'extract-characters' }, { label: '场景', action: 'extract-scenes' }, { label: '道具', action: 'extract-props' }]) {
      await page.getByRole('button', { name: `AI 提取${category.label}（先确认）`, exact: true }).click();
      const extractBox = page.getByLabel(`即将发送的${category.label}提取提示词`);
      await expect(extractBox).toBeEditable();
      const extractDefault = await extractBox.inputValue();
      defaults[category.label] = extractDefault;
      assert.ok(extractDefault.length > 0, `${category.label}提取提示词不能为空`);
      const extractEdited = `${extractDefault}\n手动补充：只影响本次${category.label}提取请求`;
      await extractBox.fill(extractEdited);
      await page.getByRole('button', { name: `确认发送并提取${category.label}资产`, exact: true }).click();
      await page.getByRole('heading', { name: `提取结果预览 · ${category.label}`, exact: true }).waitFor();
      const extractCall = calls.find(call => call.action === category.action);
      assert.ok(extractCall, `必须真实发出${category.label}提取请求`);
      assert.equal(extractCall.body.prompt, extractEdited, `必须发送改写后的${category.label}提取提示词`);
      await page.getByRole('button', { name: '确认写入资产库', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    assert.notEqual(defaults['人物'], defaults['场景'], '人物与场景必须用不同的提示词');
    assert.notEqual(defaults['场景'], defaults['道具'], '场景与道具必须用不同的提示词');
    assert.notEqual(defaults['人物'], defaults['道具'], '人物与道具必须用不同的提示词');

    // 3. 导演分镜提示词：同样可改写并按改写内容发送。
    await page.goto('http://127.0.0.1:5173/#/director');
    await page.getByRole('button', { name: 'AI 生成分镜（先确认）', exact: true }).click();
    const directorBox = page.getByLabel('即将发送的导演提示词');
    await expect(directorBox).toBeEditable();
    const directorDefault = await directorBox.inputValue();
    const directorEdited = `${directorDefault}\n手动补充：只影响本次导演请求`;
    await directorBox.fill(directorEdited);
    await page.getByRole('button', { name: '确认发送并生成分镜', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    const directorCall = calls.find(call => call.action === 'director');
    assert.ok(directorCall, '必须真实发出导演分镜请求');
    assert.equal(directorCall.body.prompt, directorEdited, '必须发送改写后的导演提示词');

    // 4. 手动改写不回写模板。
    const after = await saved();
    assert.equal(after.promptConfig, undefined, '手动改写不得写回提示词模板');

    // 5. 提示词模板面板从左边展开。
    await page.goto('http://127.0.0.1:5173/#/assets');
    await page.getByRole('button', { name: '编辑模板', exact: true }).click();
    const sheet = page.locator('[data-slot="sheet-content"]');
    await sheet.waitFor();
    const box = await sheet.boundingBox();
    assert.ok(box.x <= 2, `模板面板必须贴左边展开，实际 x=${box.x}`);
    if (width === 1440) assert.ok(box.x + box.width <= width - 100, `模板面板必须靠左，实际 right=${box.x + box.width}`);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });

    assert.deepEqual(errors, []);
    results.push({ width, passed: true, calls: calls.map(call => call.action) });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
