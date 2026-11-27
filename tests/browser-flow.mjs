// 新结构主链路：聊天室 → 系列/集 → 导入分镜 JSON → 分镜表。
// 不调真模型：要么点「不选 Skill」的自由对话（会被拦在没填 Key），要么直接走 UI 之外的
// 数据准备，再在界面上做真正的交互断言。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    let paidRequests = 0;
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/functions/v1/app')) paidRequests++; });

    const stage = async label => {
      const box = await page.evaluate(() => ({ w: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(box.scroll <= width + 2, `${width} ${label}: 横向溢出 ${JSON.stringify(box)}`);
      return label;
    };

    // 1) 主页就是聊天室
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('heading', { name: /从一个念头开始/ }).waitFor();
    assert.equal(await page.locator('.chat-quick-item').count(), 3, '聊天室要有三个 Skill 快捷入口');
    assert.equal(await page.locator('.chat-input').count(), 1);
    await stage('chat');
    await page.screenshot({ path: `dev/chat-${width}.png` });

    // 不选 Skill 时也能打字，点头发送会被拦在「先填 Key」，而不是静默失败
    await page.locator('.chat-input').fill('帮我写一集，主角在雨夜山门拾起一把断剑。');
    await page.getByRole('button', { name: /发送/ }).first().click();
    await page.getByText(/Key|密钥|模型配置/).first().waitFor({ timeout: 8000 });
    assert.equal(paidRequests, 0, '没有 Key 时不该发出付费请求');

    // 2) 作品集里建系列，系列自带第 1 集
    await page.goto('http://127.0.0.1:5173/#/library');
    await page.getByRole('heading', { name: '作品集' }).first().waitFor();
    await page.getByRole('button', { name: /新建系列/ }).first().click();
    await page.getByLabel('系列名称').fill('雨夜山门');
    await page.getByRole('button', { name: '创建并打开' }).click();
    // 创建后直接进入系列页
    await page.locator('.series-page').waitFor();
    assert.match(await page.evaluate(() => location.hash), /^#\/library\/[0-9a-f-]+$/);
    await stage('series-new');

    const seeded = await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      const s = await import(url);
      const state = s.getStudio();
      const series = state.series[0];
      return { seriesId: series.id, epId: series.episodes[0].id, episodes: series.episodes.length };
    });
    assert.equal(seeded.episodes, 1, '新系列默认带第 1 集');

    // 3) 打开这一集：空态要说清「分镜 JSON 是唯一入口」
    await page.goto(`http://127.0.0.1:5173/#/library/${seeded.seriesId}/${seeded.epId}`);
    await page.locator('.episode-page').waitFor();
    const emptyText = await page.locator('.episode-empty').textContent();
    assert.ok(emptyText.includes('分镜 JSON 是唯一的入口'), emptyText);
    assert.equal(await page.locator('.shot-table').count(), 0);
    await stage('episode-empty');

    // 4) 走真实 UI 导入分镜 JSON
    const payload = {
      title: '雨夜山门',
      style: '东方玄幻水墨风，冷灰 + 金色灵光',
      assets: [
        { assetId: 'char-shen', kind: 'character', name: '沈砚', description: '十七岁少年，灰白旧布衣，背空剑鞘' },
        { assetId: 'scene-gate', kind: 'scene', name: '雨夜山门', description: '黑色石阶与金色门环，细雨与低雾' },
      ],
      shots: [
        { number: 1, shotSize: '远景', movement: '固定', angle: '平视', duration: 12, scene: '外景 · 山门石阶 — 雨夜', visual: '沈砚跪在石阶前', start: '雨幕压下来', action: '他抬头看见断剑', end: '断剑映出金光', sceneId: 'scene-gate', assets: [{ assetId: 'char-shen', role: 'subject' }], dialogues: [] },
        { number: 2, shotSize: '近景', movement: '推', angle: '平视', duration: 11, scene: '外景 · 山门石阶 — 雨夜', visual: '断剑特写', start: '断剑映出金光', action: '沈砚伸手握住剑柄', end: '雨停了一瞬', sceneId: 'scene-gate', assets: [{ assetId: 'char-shen', role: 'subject' }], dialogues: [{ speaker: '沈砚', text: '这把剑，等了我很久。' }] },
        { number: 3, shotSize: '中景', movement: '跟', angle: '俯视', duration: 13, scene: '外景 · 山门石阶 — 雨夜', visual: '沈砚起身', start: '雨停了一瞬', action: '背影走向门', end: '门环轻响', sceneId: 'scene-gate', assets: [{ assetId: 'char-shen', role: 'subject' }], dialogues: [] },
        { number: 4, shotSize: '特写', movement: '固定', angle: '平视', duration: 12, scene: '外景 · 山门 — 雨夜', visual: '门环上的金纹', start: '门环轻响', action: '光流进石阶缝隙', end: '画面沉黑', sceneId: 'scene-gate', assets: [{ assetId: 'char-shen', role: 'subject' }], dialogues: [] },
      ],
    };
    await page.getByRole('button', { name: /导入分镜/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('textarea').first().fill(JSON.stringify(payload, null, 2));
    await dialog.locator('.import-table tbody tr').first().waitFor();
    assert.equal(await dialog.locator('.import-table tbody tr').count(), 4);
    assert.equal(await dialog.locator('.import-issues').count(), 0, '合规 JSON 不该报问题');
    const stats = (await dialog.locator('.import-stats').textContent()).replace(/\s+/g, ' ');
    assert.ok(stats.includes('4 镜') && stats.includes('48.0 秒'), stats);
    await page.screenshot({ path: `dev/import-${width}.png` });
    await dialog.getByRole('button', { name: /确认导入/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('.shot-table tbody tr').first().waitFor();

    // 5) 分镜表：五列、四镜、资产挂上、每镜一个生成按钮
    assert.equal(await page.locator('.shot-table tbody tr').count(), 4);
    assert.deepEqual(await page.locator('.shot-table thead th').allTextContents(), ['序号', '台词', '角色 / 场景 / 道具', '提示词', '视频']);
    assert.equal(await page.locator('.generate-video').count(), 4);
    assert.equal(await page.locator('.video-empty').count(), 4);
    assert.equal(await page.locator('.asset-thumb-mini').count(), 8, '四镜各有一个人物 + 场景');
    assert.equal(await page.locator('.dialogue-line').count(), 1, '第 2 镜有一句台词');
    await stage('shot-table');
    await page.screenshot({ path: `dev/shots-${width}.png` });

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')));
    const episode = saved.series[0].episodes[0];
    assert.equal(episode.shots.length, 4);
    assert.equal(episode.assets.length, 2, '一个人物 + 一个场景，场景只登记一次');
    assert.equal(episode.storyboardReady, true);
    assert.equal(episode.shots.reduce((n, s) => n + s.duration, 0), 48);
    assert.equal(episode.shots[0].camera, '远景·固定·平视');
    assert.equal(episode.shots[0].assetIds.includes('char-shen'), true, '镜头引用必须落进 assetIds');
    assert.equal(saved.keys, undefined, 'Key 不许进存档');
    assert.equal(saved.projects, undefined, '存档只剩 v2 形状');
    assert.equal(saved.version, 2);

    // 6) 加台词、改台词都写进存档
    await page.locator('.dialogue-add').first().click();
    await page.locator('.dialogue-text').first().fill('门，我来开。');
    await page.waitForTimeout(400);
    const withLine = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')).series[0].episodes[0].shots[0].dialogues);
    assert.equal(withLine.length, 1);
    assert.equal(withLine[0].text, '门，我来开。');

    // 7) 没写固定描述就不许生成，且说清是哪几个
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
      const s = await import(url);
      const state = s.getStudio();
      const series = state.series[0];
      s.updateEpisode(series.id, series.episodes[0].id, ep => ({ ...ep, assets: ep.assets.map(asset => ({ ...asset, description: '', lock: '' })) }), false);
    });
    await page.waitForTimeout(300);
    await page.locator('.generate-video').first().click();
    await page.getByText(/还没写固定描述/).first().waitFor({ timeout: 10000 });

    // 7b) 三个资产入口各自落到对应分类；这一集只有人物与场景，道具分类该给空态。
    for (const [label, expected, count] of [['角色设置', '人物', 1], ['场景设置', '场景', 1], ['道具设置', '道具', 0]]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('.chip.is-active').waitFor();
      assert.equal(await dialog.locator('.chip.is-active').innerText(), expected, `${label} 应定位到「${expected}」`);
      assert.equal(await dialog.locator('.asset-card').count(), count, `${label} 该显示 ${count} 个资产`);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    const imageCallsBefore = paidRequests;
    await page.getByRole('button', { name: '角色设置', exact: true }).click();
    await page.getByRole('button', { name: /生成设定图/ }).first().click();
    await page.getByText(/还没有固定描述/).first().waitFor({ timeout: 8000 });
    assert.equal(paidRequests, imageCallsBefore, '未锁定资产不该发出付费请求');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();

    // 8) 系列页：集数表 + 剧集资产
    await page.goto(`http://127.0.0.1:5173/#/library/${seeded.seriesId}`);
    await page.locator('.episode-table tbody tr').first().waitFor();
    assert.equal(await page.locator('.episode-table tbody tr').count(), 1);
    await page.locator('.series-tab').nth(1).click();
    assert.equal(await page.locator('.asset-card').count(), 2);
    await stage('series');
    await page.screenshot({ path: `dev/series-${width}.png` });

    // 9) 深链刷新后仍然落在同一集
    await page.goto(`http://127.0.0.1:5173/#/library/${seeded.seriesId}/${seeded.epId}`);
    await page.reload();
    await page.locator('.shot-table tbody tr').first().waitFor();
    assert.equal(await page.locator('.shot-table tbody tr').count(), 4, '刷新后分镜还在');

    // 10) 旧 v1 存档自动迁移成「一集一系列」
    const legacyContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const legacyPage = await legacyContext.newPage();
    await legacyPage.addInitScript(() => {
      localStorage.setItem('manju-studio-v1', JSON.stringify({
        version: 1,
        activeId: 'old-1',
        projects: [{
          id: 'old-1', name: '旧作品', theme: '断剑', style: '东方玄幻水墨风', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          revision: 0, skills: ['script'], source: 'template', storyboardReady: true,
          assets: [{ id: 'a1', kind: 'character', name: '阿青', description: '少年', lock: '少年' }],
          shots: [{ id: 's1', number: 1, duration: 12, visual: '画面', camera: '远景·固定·平视', start: '', action: '', end: '', dialogues: [], assetIds: ['a1'], references: [], audioMode: 'original' }],
        }],
        // v1 存档必须是完整形状：缺字段会被 schema 判成「读不了」，而不是当成迁移输入。
        settings: {
          scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance',
          models: { seedance: 'seedance-2.0-fast', minimax: 'MiniMax-Hailuo-02', openai: 'gpt-image-2', gemini: 'gemini-3-pro-image' },
          speechModel: 'speech-01', promptTemplates: { templates: {} },
        },
      }));
    });
    await legacyPage.goto('http://127.0.0.1:5173/#/library');
    await legacyPage.reload();
    await legacyPage.locator('.series-card').first().waitFor();
    const migrated = await legacyPage.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.series.length, 1);
    assert.equal(migrated.series[0].episodes.length, 1);
    assert.equal(migrated.series[0].episodes[0].shots.length, 1, '镜头原样带过来');
    assert.equal(migrated.series[0].episodes[0].assets.length, 1);
    assert.equal(migrated.series[0].aspect, '9:16');
    assert.equal(migrated.series[0].resolution, '720p');
    assert.equal(migrated.series[0].episodes[0].legacySpec, true, '旧规格要打标');
    await legacyContext.close();

    assert.deepEqual(errors, []);
    assert.equal(paidRequests, 0, '整条链路不该发出任何付费请求');
    results.push({ width, passed: true, errors, paidRequests });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }