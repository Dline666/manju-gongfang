// 提示词模板的作用域：全局模板是默认，单部作品可以单独覆盖某一步。
// 覆盖「全局生效 → 作品独立 → 恢复跟随」这条链路，并确认全局模板真的进了生成提示词。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });

import { makeScreenplay } from './screenplay-fixtures.mjs';
const screenplay = makeScreenplay();


const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = []; const calls = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => { void dialog.accept(); });
    await page.route('**/functions/v1/app?*', async route => {
      const action = new URL(route.request().url()).searchParams.get('action');
      const body = route.request().postDataJSON(); calls.push({ action, body });
      if (action === 'screenplay') await route.fulfill({ json: { ok: true, data: { title: '断剑归门', logline: '少年拾剑', screenplay } } });
      else if (action === 'contracts') await route.fulfill({ json: { ok: true, data: { instruction: '固定契约（测试替身）', schema: { type: 'object' } } } });
      else throw new Error(`Unexpected network action: ${action}`);
    });
    const store = () => page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      return import(entry);
    });
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')));

    await page.goto('http://127.0.0.1:5173/');
    await page.getByLabel('一句话故事主题').fill('断剑归门');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      const module = await import(entry);
      module.setKey('gemini', 'fixture-not-transmitted');
    });

    // 1. 设置页有「提示词模板」页签，模板在整页里编辑。
    await page.goto('http://127.0.0.1:5173/#/settings');
    await page.getByRole('tab', { name: '提示词模板' }).click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.template-editor').count(), 1, '点「提示词模板」要立刻切到模板页');
    await page.getByRole('tab', { name: '连接模型' }).click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.template-editor').count(), 0, '点「连接模型」要立刻切回连接页');
    await page.getByRole('tab', { name: '提示词模板' }).click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.template-editor').count(), 1, '再切回来也要立刻生效');

    await page.goto('http://127.0.0.1:5173/#/settings/templates?kind=script');
    const editor = page.locator('.template-editor');
    await editor.waitFor();
    await page.getByRole('tab', { name: '全局模板（默认）' }).click();
    await expect(editor.getByRole('button', { name: /^剧本/ }).first()).toBeVisible();

    // 2. 全局模板写一条规则并保存。（出厂模板带内容，先清空再写，测的是作用域本身）
    await editor.getByRole('button', { name: '清空模板' }).click();
    await page.waitForTimeout(300);
    await editor.getByRole('button', { name: '新增块' }).click();
    await editor.locator('input[aria-label="块标题 1"]').fill('全局规则');
    await editor.locator('textarea:not([readonly])').last().fill('全局剧本规则：只写雨夜。');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForTimeout(300);
    const afterGlobal = await saved();
    assert.deepEqual(afterGlobal.settings.promptTemplates.templates.script.blocks.map(block => block.text), ['全局剧本规则：只写雨夜。'], '全局模板存进设置');
    assert.equal(afterGlobal.projects[0].promptConfig, undefined, '全局模板不写进作品存档');

    // 3. 全局模板真的进了剧本提示词。
    await page.goto('http://127.0.0.1:5173/#/script');
    await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
    const scriptBox = page.getByLabel('即将发送的完整提示词');
    await expect(scriptBox).toBeEditable();
    const globalPrompt = await scriptBox.inputValue();
    assert.ok(globalPrompt.includes('全局剧本规则：只写雨夜。'), `全局模板必须进入剧本提示词，实际：\n${globalPrompt}`);
    await page.getByRole('button', { name: '确认发送并生成', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const screenplayCall = calls.find(call => call.action === 'screenplay');
    assert.ok(screenplayCall.body.prompt.includes('全局剧本规则：只写雨夜。'), '发出去的提示词必须带上全局模板');

    // 4. 作品改为独立：这一步归本作品管，内容与全局无关。
    await page.goto('http://127.0.0.1:5173/#/settings/templates?kind=script&scope=project');
    await page.getByRole('tab', { name: /^当前作品/ }).click();
    const projectEditor = page.locator('.template-editor');
    await projectEditor.waitFor();
    await projectEditor.getByRole('button', { name: '改为独立编辑' }).click();
    await page.waitForTimeout(300);
    await projectEditor.getByRole('button', { name: '清空模板' }).click();
    await page.waitForTimeout(300);
    await projectEditor.getByRole('button', { name: '新增块' }).click();
    await projectEditor.locator('input[aria-label="块标题 1"]').fill('本作品规则');
    await projectEditor.locator('textarea:not([readonly])').last().fill('本作品剧本规则：只写雪天。');
    await projectEditor.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForTimeout(300);
    const afterOverride = await saved();
    const overrides = afterOverride.projects[0].promptConfig.overrides;
    assert.equal(afterOverride.projects[0].promptConfig.v, 3, '作品存的是覆盖层');
    assert.deepEqual(overrides.templates.script.blocks.map(block => block.text), ['本作品剧本规则：只写雪天。'], '作品只存自己的那一步');
    assert.equal(overrides.templates.director, undefined, '没覆盖的步骤不进覆盖层');

    // 5. 剧本提示词现在用作品自己的内容。
    await page.goto('http://127.0.0.1:5173/#/script');
    await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
    const overridePrompt = await page.getByLabel('即将发送的完整提示词').inputValue();
    assert.ok(overridePrompt.includes('本作品剧本规则：只写雪天。'), '作品覆盖的内容要进提示词');
    assert.ok(!overridePrompt.includes('全局剧本规则'), '被覆盖的步骤不再用全局内容');
    await page.getByRole('button', { name: '取消' }).click();

    // 6. 恢复跟随全局：内容回到全局。
    await page.goto('http://127.0.0.1:5173/#/settings/templates?kind=script&scope=project');
    await page.getByRole('tab', { name: /^当前作品/ }).click();
    await projectEditor.waitFor();
    await projectEditor.getByRole('button', { name: '恢复跟随全局' }).click();
    await page.waitForTimeout(300);
    await projectEditor.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForTimeout(300);
    const afterFollow = await saved();
    assert.equal(afterFollow.projects[0].promptConfig.overrides.templates.script, undefined, '恢复跟随后删掉覆盖层');
    assert.deepEqual(afterFollow.settings.promptTemplates.templates.script.blocks.map(block => block.text), ['全局剧本规则：只写雨夜。'], '全局模板没被动过');

    await page.goto('http://127.0.0.1:5173/#/script');
    await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
    const followPrompt = await page.getByLabel('即将发送的完整提示词').inputValue();
    assert.ok(followPrompt.includes('全局剧本规则：只写雨夜。'), '恢复跟随后回到全局内容');

    // 7. 全局模板对另一部作品同样生效（它是默认，不是某部作品的私有配置）。
    const secondId = await page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      const module = await import(entry);
      return module.createProject('第二部作品', '另一个故事').id;
    });
    await page.goto('http://127.0.0.1:5173/#/script');
    await page.getByRole('button', { name: 'AI 生成剧本', exact: true }).click();
    const otherPrompt = await page.getByLabel('即将发送的完整提示词').inputValue();
    assert.ok(otherPrompt.includes('全局剧本规则：只写雨夜。'), '另一部作品也用全局模板');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    // 8. 流程页的「编辑提示词模板」直接跳到设置页并定位到这一步。
    await page.goto('http://127.0.0.1:5173/#/script');
    await page.locator('details').filter({ hasText: '高级：提示词与规则' }).locator('summary').click();
    await page.getByRole('button', { name: '编辑提示词模板' }).click();
    await page.waitForTimeout(400);
    const hash = await page.evaluate(() => location.hash);
    assert.ok(hash.includes('/settings/templates'), `流程页的入口要跳到设置页模板页签，实际 ${hash}`);
    assert.ok(hash.includes('kind=script'), `要定位到剧本这一步，实际 ${hash}`);
    assert.equal(await page.locator('[data-slot="sheet-content"]').count(), 0, '不再有抽屉');

    assert.deepEqual(errors, []);
    results.push({ width, passed: true, calls: calls.map(call => call.action) });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
