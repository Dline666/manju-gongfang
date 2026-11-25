import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const calls = [];
  await page.route('**/functions/v1/app?*', async route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    const body = route.request().postDataJSON(); calls.push({ action, body });
    if (action === 'video-create') await route.fulfill({ status: 504, json: { ok: false, error: 'submission_unknown' } });
    else if (action === 'voices') await route.fulfill({ json: { ok: true, data: [{ id: 'fixture-only', name: '隔离测试音色' }] } });
    else await route.fulfill({ json: { ok: true, data: { status: 'running' } } });
  });
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('heading', { name: '我的作品' }).waitFor();
  await page.evaluate(async () => {
    const store = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts');
    const { templateScript, rehearseShots } = await import('/src/features/script/creation.ts');
    const p = store.createProject('隔离恢复测试', '山门断剑');
    const draft = templateScript(p.theme);
    // 剧本步骤不拆镜：镜头由导演步骤产出，这里用本地演练排出镜头。
    store.updateProject(p.id, { ...draft, shots: rehearseShots(draft.screenplay || ''), source: 'template', storyboardReady: true });
    store.setKey('seedance', 'fixture-key-never-transmitted');
    store.setKey('minimax', 'fixture-key-never-transmitted');
    location.hash = '/generation';
  });
  await page.locator('.generation-card').nth(12).waitFor();
  await page.getByRole('button', { name: '查看第13镜视频详情', exact: true }).click();
  await page.getByRole('button', { name: 'API 生成', exact: true }).click();
  await page.getByRole('button', { name: '确认并开始生成' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '查看第13镜视频详情', exact: true }).click();
  await page.getByText('结果未知 · 请检查原平台', { exact: false }).first().waitFor();
  assert.equal(calls.filter(c => c.action === 'video-create').length, 1);
  assert.ok(calls[0].body.prompt.includes('音频模式：后期配音'), '音频模式应随镜头数据渲染');
  assert.ok(!calls[0].body.prompt.includes('后期配音模式'));
  assert.ok(!calls[0].body.prompt.includes('按下列对白自然发声'));
  const saved = await page.evaluate(() => localStorage.getItem('manju-studio-v1'));
  assert.ok(!saved.includes('fixture-key-never-transmitted'));
  await page.evaluate(async () => {
    const { callApi, credentials } = await import('/src/lib/api.ts');
    await callApi('voices', credentials('minimax'));
    await callApi('video-status', { ...credentials('seedance'), taskId: 'fixture-task' });
  });
  for (const call of calls.filter(c => ['voices', 'video-status'].includes(c.action))) assert.equal(call.body.model, undefined);
  await page.reload();
  await page.locator('.generation-card').nth(9).waitFor();
  assert.equal(calls.filter(c => c.action === 'video-create').length, 1);
  assert.deepEqual(await page.evaluate(async () => (await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts')).getStudio().keys), {});
  await page.evaluate(async () => {
    const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts'); const p = s.getStudio().projects[0];
    s.updateProject(p.id, { shots: p.shots.map((shot, i) => i === 0 ? { ...shot, video: { name: 'previous.mp4', duration: 9, origin: 'upload' }, task: { provider: 'seedance', model: 'fixture', status: 'submitting', revision: p.revision, createdAt: new Date().toISOString() } } : shot) });
  });
  await page.reload();
  await page.getByText('本地视频未加载，请重新选择文件', { exact: true }).waitFor();
  const task = await page.evaluate(async () => (await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts')).getStudio().projects[0].shots[0].task);
  assert.equal(task.status, 'unknown');
  await page.evaluate(async () => {
    Storage.prototype.setItem = () => { throw new DOMException('test quota', 'QuotaExceededError'); };
    const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')) || '/src/store/studio.ts'); s.updateProject(s.getStudio().projects[0].id, { name: '未保存修改' });
  });
  await page.getByRole('alert').filter({ hasText: '当前修改尚未保存' }).waitFor();
  await page.getByText('尚未保存', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
  const corruptContext = await browser.newContext(); const corrupt = await corruptContext.newPage();
  await corrupt.addInitScript(() => { localStorage.setItem('manju-studio-v1', '{broken-test'); });
  await corrupt.goto('http://127.0.0.1:5173/');
  await corrupt.getByRole('alert').filter({ hasText: '已停止覆盖保存' }).waitFor();
  await corrupt.getByLabel('一句话故事主题').fill('不覆盖损坏数据');
  await corrupt.getByRole('button', { name: '开始创作', exact: true }).click();
  assert.equal(await corrupt.evaluate(() => localStorage.getItem('manju-studio-v1')), '{broken-test');
  await corruptContext.close();
  console.log(JSON.stringify({ passed: true, checks: ['unknown submission never retried', 'keys memory-only', 'strict request contracts', 'pending task recovery', 'video reselection', 'quota errors visible', 'corrupt data preserved'], interceptedRequests: calls.length, errors }, null, 2));
} finally { await browser.close(); }
