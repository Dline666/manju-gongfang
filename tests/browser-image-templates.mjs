// 设定图提示词模板按品类拆分：图片栏里分人物 / 场景 / 道具三段，
// 三段各写各的、互不串；切换品类不丢块，保存后重新打开仍在。
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });

const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/functions/v1/app?*', route => route.fulfill({ json: { ok: true, data: { instruction: '固定契约（测试替身）', schema: { type: 'object' } } } }));

    await page.goto('http://127.0.0.1:5173/');
    await page.getByLabel('一句话故事主题').fill('断剑归门');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();

    // 1. 图片栏里分出人物 / 场景 / 道具三段。
    await page.goto('http://127.0.0.1:5173/#/settings/templates?kind=image');
    const editor = page.locator('.template-editor');
    await editor.waitFor();
    const cats = editor.getByRole('tablist', { name: '品类' });
    await cats.waitFor();
    for (const label of ['人物', '场景', '道具']) {
      assert.equal(await cats.getByRole('tab', { name: label, exact: true }).count(), 1, `图片栏要有「${label}」一段`);
    }
    assert.equal(await cats.getByRole('tab').count(), 3, '图片栏只分三段');

    // 2. 默认落在人物段，预览也是人物的。
    assert.equal(await cats.getByRole('tab', { name: '人物', exact: true }).getAttribute('aria-selected'), 'true', '默认应停在人物段');
    await expect(editor.locator('textarea[aria-label="模板预览 · 人物"]')).toHaveCount(1);
    const characterPreview = await editor.locator('textarea[aria-label="模板预览 · 人物"]').inputValue();
    assert.ok(characterPreview.includes('示例人物'), '人物段预览人物资产');
    assert.ok(!characterPreview.includes('示例场景'), '人物段不应出现场景资产');

    // 3. 内置块目录按品类分开：人物段没有场景构图说明，场景段没有人物三视图条款。
    const builtinOptions = async () => await editor.locator('select[aria-label="选择内置块"] option').allTextContents();
    const characterBuiltins = await builtinOptions();
    assert.ok(characterBuiltins.includes('人物三视图条款'), '人物段提供人物内置块');
    assert.ok(!characterBuiltins.includes('场景构图说明'), '人物段不提供场景内置块');
    assert.ok(!characterBuiltins.includes('道具构图说明'), '人物段不提供道具内置块');

    // 4. 给人物段写一块，保存。
    await editor.getByRole('button', { name: '新增块' }).click();
    await editor.locator('input[aria-label="块标题 1"]').fill('人物专用条款');
    await editor.locator('textarea:not([readonly])').first().fill('只输出一张角色设定卡：正面、侧面、背面三视图。');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForTimeout(300);
    const characterSaved = await editor.locator('textarea[aria-label="模板预览 · 人物"]').inputValue();
    assert.ok(characterSaved.includes('三视图'), '人物段的正文要进人物预览');

    // 5. 场景段是独立的：没有人物段的块，预览也换成场景资产。
    await cats.getByRole('tab', { name: '场景', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(await editor.locator('input[aria-label^="块标题"]').count(), 0, '场景段不能带人物段的块');
    await expect(editor.locator('textarea[aria-label="模板预览 · 场景"]')).toHaveCount(1);
    const scenePreview = await editor.locator('textarea[aria-label="模板预览 · 场景"]').inputValue();
    assert.ok(scenePreview.includes('示例场景'), '场景段预览场景资产');
    assert.ok(!scenePreview.includes('三视图'), '场景段不能出现人物段的块');
    const sceneBuiltins = await builtinOptions();
    assert.ok(sceneBuiltins.includes('场景构图说明'), '场景段提供场景内置块');
    assert.ok(!sceneBuiltins.includes('人物三视图条款'), '场景段不提供人物内置块');

    // 6. 道具段同样独立。
    await cats.getByRole('tab', { name: '道具', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(await editor.locator('input[aria-label^="块标题"]').count(), 0, '道具段不能带人物段的块');
    await expect(editor.locator('textarea[aria-label="模板预览 · 道具"]')).toHaveCount(1);
    const propPreview = await editor.locator('textarea[aria-label="模板预览 · 道具"]').inputValue();
    assert.ok(propPreview.includes('示例道具'), '道具段预览道具资产');
    assert.ok(!propPreview.includes('三视图'), '道具段不能出现人物段的块');

    // 7. 切回人物段，块还在，且三段预览互不相同。
    await cats.getByRole('tab', { name: '人物', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(await editor.locator('input[aria-label="块标题 1"]').inputValue(), '人物专用条款', '切回人物段块还在');
    const previews = new Set([characterSaved, scenePreview, propPreview]);
    assert.equal(previews.size, 3, '三段预览必须各不相同');

    // 8. 保存后重新打开：人物段的块还在，场景段仍然是空的。
    await page.reload();
    await page.locator('.template-editor').waitFor();
    const editor2 = page.locator('.template-editor');
    await editor2.getByRole('tablist', { name: '品类' }).getByRole('tab', { name: '人物', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(await editor2.locator('input[aria-label="块标题 1"]').inputValue(), '人物专用条款', '重开后人物段的块要还在');
    await editor2.getByRole('tablist', { name: '品类' }).getByRole('tab', { name: '场景', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(await editor2.locator('input[aria-label^="块标题"]').count(), 0, '重开后场景段仍然为空');

    // 9. 资产页的「编辑模板」直接落到对应品类那一段。
    await page.goto('http://127.0.0.1:5173/#/assets');
    await page.waitForTimeout(300);
    const assetTab = page.getByRole('tab', { name: '场景' }).first();
    await assetTab.click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '编辑模板', exact: true }).click();
    await page.locator('.template-editor').waitFor();
    const hash = await page.evaluate(() => location.hash);
    assert.ok(hash.includes('kind=image') && hash.includes('sub=scene'), `资产页跳转要带上 sub=scene，实际 ${hash}`);
    const editor3 = page.locator('.template-editor');
    await editor3.getByRole('tablist', { name: '品类' }).getByRole('tab', { name: '场景', exact: true }).waitFor();
    assert.equal(await editor3.getByRole('tablist', { name: '品类' }).getByRole('tab', { name: '场景', exact: true }).getAttribute('aria-selected'), 'true', '资产页跳过去要直接停在场景段');

    // 10. 真实生图链路：场景与道具的设定图提示词里不能出现人物那段条款。
    await page.goto('http://127.0.0.1:5173/#/assets');
    await page.waitForTimeout(300);
    const prompts = await page.evaluate(async () => {
      const names = performance.getEntriesByType('resource').map(e => e.name);
      const store = await import(names.find(n => n.includes('/src/store/studio.ts')));
      const lib = await import(names.find(n => n.includes('/src/lib/prompts.ts')));
      const state = store.getStudio();
      const project = state.projects[0];
      const assets = [
        { id: 'a-hero', kind: 'character', name: '阿青', description: '少年', lock: '灰白旧衣' },
        { id: 'a-scene', kind: 'scene', name: '山门', description: '石阶', lock: '青灰石阶' },
        { id: 'a-prop', kind: 'prop', name: '断剑', description: '断剑', lock: '断口有金光' },
      ];
      const out = {};
      for (const asset of assets) out[asset.kind] = lib.imagePrompt(project, asset, state.settings.promptTemplates);
      return out;
    });
    assert.ok(prompts.character.includes('三视图'), '人物图用人物那段条款');
    assert.ok(!prompts.scene.includes('三视图'), '场景图不能带人物那段条款');
    assert.ok(!prompts.prop.includes('三视图'), '道具图不能带人物那段条款');
    assert.ok(prompts.scene.includes('主体：山门'), '场景图仍然带自己的作品数据');

    assert.deepEqual(errors, []);
    results.push({ width, passed: true });
    await context.close();

    // 11. 旧存档（人物/场景/道具共用一份 image 模板）载入后，场景与道具也不该带人物条款。
    const legacy = {
      version: 1, projects: [], activeId: null,
      settings: {
        scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance', speechModel: 'speech-01',
        promptTemplates: { templates: { image: { blocks: [
          { id: 'legacy-rule', title: '角色条款', text: '只输出一张角色设定卡：正面、侧面、背面三视图。' },
        ] } } },
      },
    };
    const legacyContext = await browser.newContext({ viewport: { width, height: 900 } });
    await legacyContext.addInitScript(`localStorage.setItem('manju-studio-v1', ${JSON.stringify(JSON.stringify(legacy))})`);
    const legacyPage = await legacyContext.newPage();
    const legacyErrors = [];
    legacyPage.on('pageerror', e => legacyErrors.push(e.message));
    await legacyPage.route('**/functions/v1/app?*', route => route.fulfill({ json: { ok: true, data: { instruction: 'x', schema: {} } } }));
    await legacyPage.goto('http://127.0.0.1:5173/#/settings/templates?kind=image');
    await legacyPage.locator('.template-editor').waitFor();
    const legacyPrompts = await legacyPage.evaluate(async () => {
      const names = performance.getEntriesByType('resource').map(e => e.name);
      const store = await import(names.find(n => n.includes('/src/store/studio.ts')));
      const lib = await import(names.find(n => n.includes('/src/lib/prompts.ts')));
      const state = store.getStudio();
      const project = { id: 'p', name: 'x', theme: '断剑归门', style: '水墨', createdAt: '', updatedAt: '', revision: 0, skills: [], shots: [], assets: [], source: 'empty', storyboardReady: false };
      const out = {};
      for (const kind of ['character', 'scene', 'prop']) {
        out[kind] = lib.imagePrompt(project, { id: kind, kind, name: `${kind}-1`, description: '描述', lock: '固定短语' }, state.settings.promptTemplates);
      }
      return out;
    });
    assert.ok(legacyPrompts.character.includes('三视图'), '旧存档里人物那段条款仍然生效');
    assert.ok(!legacyPrompts.scene.includes('三视图'), '旧存档的场景图不能带人物条款');
    assert.ok(!legacyPrompts.prop.includes('三视图'), '旧存档的道具图不能带人物条款');
    assert.deepEqual(legacyErrors, []);
    await legacyContext.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
