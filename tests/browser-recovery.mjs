// 隔离与恢复：未确定的提交不重试、Key 只在内存、待办任务能恢复、
// 本地视频失效要人重选、存储配额错误要看得见、存档损坏时不覆盖。
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const calls = [];
  await page.route('**/functions/v1/app?*', async route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    const body = route.request().postDataJSON();
    calls.push({ action, body });
    if (action === 'video-create') await route.fulfill({ status: 504, json: { ok: false, error: 'submission_unknown' } });
    else if (action === 'voices') await route.fulfill({ json: { ok: true, data: [{ id: 'fixture-only', name: '隔离测试音色' }] } });
    else await route.fulfill({ json: { ok: true, data: { status: 'running' } } });
  });

  await page.goto('http://127.0.0.1:5173/#/library');
  await page.waitForTimeout(600);

  // 准备：一个系列、一集、四镜，资产都写好固定描述，Key 也填好（只在内存里）
  const ids = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
    const s = await import(url);
    const series = s.createSeries('隔离恢复测试', '东方玄幻水墨风，冷灰 + 金色灵光');
    const episode = series.episodes[0];
    const shots = [1, 2, 3, 4].map(n => ({
      id: `probe-shot-${n}`, number: n, title: '', duration: 12,
      visual: `第${n}镜画面：山门石阶上的沈砚`, camera: '中景·固定·平视',
      start: '雨幕压下来', action: '他抬头看见断剑', end: '断剑映出金光',
      scene: '外景 · 山门石阶 — 雨夜', dialogues: [], assetIds: ['probe-char'],
      references: [], audioMode: 'original',
    }));
    s.updateEpisode(series.id, episode.id, current => ({
      ...current,
      shots,
      assets: [{ id: 'probe-char', kind: 'character', name: '沈砚', description: '十七岁少年，灰白旧布衣', lock: '十七岁少年，灰白旧布衣' }],
      storyboardReady: true, source: 'import',
    }), false);
    s.setKey('seedance', 'fixture-key-never-transmitted');
    s.setKey('minimax', 'fixture-key-never-transmitted');
    return { seriesId: series.id, episodeId: episode.id };
  });

  await page.goto(`http://127.0.0.1:5173/#/library/${ids.seriesId}/${ids.episodeId}`);
  await page.locator('.shot-table tbody tr').first().waitFor();
  assert.equal(await page.locator('.shot-table tbody tr').count(), 4);

  // 1) 提交 → 504 未知结果：只提交一次，不重试，任务标成「未知」
  await page.locator('.generate-video').first().click();
  await page.getByRole('button', { name: '确认并开始生成' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByText('结果未知 · 请检查原平台', { exact: false }).first().waitFor({ timeout: 15000 });
  assert.equal(calls.filter(c => c.action === 'video-create').length, 1, '未知结果不许自动重试');
  const afterSubmit = await page.evaluate(seriesId => {
    const saved = JSON.parse(localStorage.getItem('manju-studio-v1'));
    return saved.series.find(s => s.id === seriesId).episodes[0].shots[0].task;
  }, ids.seriesId);
  assert.equal(afterSubmit.status, 'unknown');

  // 2) Key 绝不进存档；即使重新加载也读不回来
  const savedRaw = await page.evaluate(() => localStorage.getItem('manju-studio-v1'));
  assert.ok(!savedRaw.includes('fixture-key-never-transmitted'), 'Key 必须只在内存');

  // 3) 无 Key 的请求不带 model（接口契约）
  await page.evaluate(async () => {
    const { callApi, credentials } = await import('/src/lib/api.ts');
    await callApi('voices', credentials('minimax'));
    await callApi('video-status', { ...credentials('seedance'), taskId: 'fixture-task' });
  });
  for (const call of calls.filter(c => ['voices', 'video-status'].includes(c.action))) {
    assert.equal(call.body.model, undefined, `${call.action} 不该带 model`);
  }

  // 4) 刷新后：待办任务仍在，状态仍是「未知」，Key 已清空
  await page.reload();
  await page.locator('.shot-table tbody tr').first().waitFor();
  assert.equal(calls.filter(c => c.action === 'video-create').length, 1, '刷新不该导致重复提交');
  const keysAfterReload = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
    const s = await import(url);
    return s.getStudio().keys;
  });
  assert.deepEqual(keysAfterReload, {}, '刷新后 Key 必须为空');

  // 5) 本地视频失效：要人重新选文件，而不是装作还在
  await page.evaluate(async seriesId => {
    const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
    const s = await import(url);
    s.updateEpisode(seriesId, s.getStudio().series.find(x => x.id === seriesId).episodes[0].id, ep => ({
      ...ep,
      shots: ep.shots.map((shot, index) => index === 0
        ? { ...shot, video: { name: 'previous.mp4', duration: 9, origin: 'upload' }, task: { provider: 'seedance', model: 'fixture', status: 'submitting', revision: ep.revision, createdAt: new Date().toISOString() } }
        : shot),
    }));
  }, ids.seriesId);
  await page.reload();
  await page.getByText('本地视频未加载，请重新选择文件', { exact: true }).waitFor();
  const recoveredTask = await page.evaluate(async seriesId => {
    const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
    const s = await import(url);
    return s.getStudio().series.find(x => x.id === seriesId).episodes[0].shots[0].task;
  }, ids.seriesId);
  assert.equal(recoveredTask.status, 'unknown', '提交中断的镜头恢复成「未知」，不是「失败」');

  // 6) 存储配额错误必须看得见
  await page.evaluate(async () => {
    Storage.prototype.setItem = () => { throw new DOMException('test quota', 'QuotaExceededError'); };
    const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts'));
    const s = await import(url);
    const series = s.getStudio().series[0];
    s.updateSeries(series.id, { name: '未保存修改' });
  });
  await page.getByRole('alert').filter({ hasText: '当前修改尚未保存' }).waitFor();
  await page.getByText('尚未保存', { exact: true }).waitFor();

  assert.deepEqual(errors, []);
  await context.close();

  // 7) 存档完全损坏：停止覆盖，原样保留，不许静默重置
  const corruptContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const corrupt = await corruptContext.newPage();
  await corrupt.addInitScript(() => { localStorage.setItem('manju-studio-v1', '{broken-test'); });
  await corrupt.goto('http://127.0.0.1:5173/#/chat');
  await corrupt.getByRole('alert').filter({ hasText: '已停止覆盖保存' }).waitFor();
  // 聊天室还能用（它写的是另一个 key），但作品存档必须原样留着
  await corrupt.getByRole('button', { name: /发送/ }).first().waitFor();
  assert.equal(await corrupt.evaluate(() => localStorage.getItem('manju-studio-v1')), '{broken-test');
  await corruptContext.close();

  console.log(JSON.stringify({
    passed: true,
    checks: [
      'unknown submission never retried',
      'keys memory-only',
      'strict request contracts',
      'pending task recovery',
      'video reselection',
      'quota errors visible',
      'corrupt data preserved',
    ],
    interceptedRequests: calls.length,
    errors,
  }, null, 2));
} finally { await browser.close(); }