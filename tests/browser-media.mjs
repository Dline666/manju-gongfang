// 真实 FFmpeg WASM 的端到端回归：合成 MP4、替换配音、素材包 ZIP、超长配音拦截、移动端不溢出。
// 新结构里没有独立的导出页，导出在剧集页顶栏，进度进任务托盘。
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });

  await page.goto('http://127.0.0.1:5173/#/chat');
  await page.waitForTimeout(800);

  console.log('Starting real FFmpeg WASM H264/AAC smoke');
  const smoke = await page.evaluate(async () => {
    const { smokeEncode } = await import('/src/lib/media/encoder.ts');
    const blob = await smokeEncode();
    const { inspectMedia } = await import('/src/lib/media/inputs.ts');
    const duration = await inspectMedia(blob, 'video');
    return { size: blob.size, duration };
  });
  assert.ok(smoke.size > 1000); assert.ok(Math.abs(smoke.duration - 1) < 1 / 24);
  console.log('SMOKE', JSON.stringify(smoke));

  // 10 种颜色各 9 秒，方便逐镜核对合成结果没有串镜。
  const colors = ['d93838', '38b938', '3858d9', 'd9b938', 'b938d9', '38b9b9', 'ee8833', '885533', '884488', '888888'];
  const fixtures = await page.evaluate(async colors => {
    const { FFmpeg } = await import('/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js');
    const { default: workerURL } = await import('/node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js?worker&url');
    const ffmpeg = new FFmpeg(); const output = [];
    try {
      ffmpeg.on('log', () => {});
      // 与产品同一条加载路径：classWorkerURL + 同源 core/wasm。
      // URL 必须在运行时拼（new URL 而不是字符串字面量），否则 Vite 会把它当模块去 import。
      const base = new URL('/ffmpeg/', location.href);
      await ffmpeg.load({ classWorkerURL: workerURL, coreURL: new URL('ffmpeg-core.js', base).href, wasmURL: new URL('ffmpeg-core.wasm', base).href });
      for (const color of colors) {
        const code = await ffmpeg.exec(['-f', 'lavfi', '-i', `color=c=0x${color}:s=720x1280:r=24:d=9`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=9', '-map', '0:v:0', '-map', '1:a:0', '-t', '9', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '1', '-c:a', 'aac', '-movflags', '+faststart', '-y', 'fixture.mp4']);
        if (code !== 0) throw new Error(`Fixture encode failed: ${code}`);
        output.push(Array.from(await ffmpeg.readFile('fixture.mp4')));
      }
      return output;
    } finally { ffmpeg.terminate(); }
  }, colors);

  // 用 10 镜 × 9 秒的固定一集，绕开模型依赖，让时长与配音假设稳定。
  const ids = await page.evaluate(async () => {
    const s = await import(performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/store/studio.ts')));
    const series = s.createSeries('媒体测试', '东方玄幻水墨风');
    const ep = series.episodes[0];
    s.updateEpisode(series.id, ep.id, cur => ({ ...cur,
      source: 'template', storyboardReady: true,
      assets: [{ id: 'hero', kind: 'character', name: '主角', description: '测试人物', lock: '测试人物' }],
      shots: Array.from({ length: 10 }, (_, i) => ({
        id: `shot-${i + 1}`, number: i + 1, duration: 9, visual: `第${i + 1}镜画面`, camera: '中景·固定·平视',
        start: '开场', action: '动作', end: '终点',
        dialogues: [{ id: `d${i + 1}`, speakerId: 'hero', text: '我回来了。' }],
        assetIds: ['hero'], references: [], audioMode: 'dubbing',
      })),
    }), false);
    return { seriesId: series.id, episodeId: ep.id };
  });

  await page.goto(`http://127.0.0.1:5173/#/library/${ids.seriesId}/${ids.episodeId}`);
  await page.locator('.shot-table tbody tr').first().waitFor();
  assert.equal(await page.locator('.shot-table tbody tr').count(), 10);

  // 逐镜上传视频与配音：两个控件都在视频格里，直接喂隐藏的 file input。
  const voice = await readFile('dev/test-voice.wav');
  for (let i = 0; i < 10; i++) {
    const row = page.locator('.shot-table tbody tr').nth(i);
    await row.locator('input[type=file][accept*="video"]').setInputFiles({ name: `test-${i + 1}.mp4`, mimeType: 'video/mp4', buffer: Buffer.from(fixtures[i]) });
    await row.locator('video').waitFor({ timeout: 20000 });
    await row.locator('input[type=file][accept*="audio"]').setInputFiles({ name: `voice-${i + 1}.wav`, mimeType: 'audio/wav', buffer: voice });
    await page.waitForTimeout(150);
  }
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('manju-studio-v1')));
  assert.equal(saved.series[0].episodes[0].shots.filter(s => s.video).length, 10);
  assert.equal(saved.series[0].episodes[0].shots.filter(s => s.audio).length, 10);

  // 超长配音：导出时必须报错而不是静默裁剪。
  const longVoice = await page.evaluate(async () => {
    const { getMedia } = await import('/src/store/media.ts');
    const { joinSpeech } = await import('/src/lib/dubbing.ts');
    const ep = JSON.parse(localStorage.getItem('manju-studio-v1')).series[0].episodes[0];
    const track = await getMedia(ep.shots[0].audio.mediaId);
    const joined = await joinSpeech([track, track]);
    return Array.from(new Uint8Array(await joined.blob.arrayBuffer()));
  });
  await page.locator('.shot-table tbody tr').first().locator('input[type=file][accept*="audio"]').setInputFiles({ name: 'overlong.wav', mimeType: 'audio/wav', buffer: Buffer.from(longVoice) });
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: '导出作品', exact: true }).click();
  await page.getByRole('button', { name: '导出 MP4', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByText(/配音超过镜头时长|超过镜头 9 秒/).first().waitFor({ timeout: 60000 });

  // 恢复合规配音，再真的合成一次
  await page.locator('.shot-table tbody tr').first().locator('input[type=file][accept*="audio"]').setInputFiles({ name: 'voice-1.wav', mimeType: 'audio/wav', buffer: voice });
  await page.waitForTimeout(400);

  // 移动端：导出弹窗不该把页面撑出横向滚动
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: '导出作品', exact: true }).click();
  await page.getByRole('button', { name: '导出 MP4', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, 'mobile export overflow');
  await page.screenshot({ path: 'dev/export-390.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');

  // 真正合成：结果通过任务托盘报告进度，完成后自动下载
  await page.getByRole('button', { name: '导出作品', exact: true }).click();
  const download = page.waitForEvent('download', { timeout: 600000 });
  const started = Date.now();
  await page.getByRole('button', { name: '导出 MP4', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  // 长任务在托盘里：既不能卡住页面，也要能看到当前阶段
  await page.getByText(/正在编码第|正在检查/).first().waitFor({ timeout: 60000 });
  await (await download).saveAs('dev/test-film.mp4');
  console.log('Encode finished in', (Date.now() - started) / 1000, 's');

  const info = await page.evaluate(async () => {
    const response = await fetch('/dev/test-film.mp4').catch(() => undefined);
    return response ? { ok: true } : { ok: false };
  });
  const film = await readFile('dev/test-film.mp4');
  assert.ok(film.byteLength > 10000, 'MP4 should have real content');
  const probe = await page.evaluate(async bytes => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video'); video.src = url; video.muted = true;
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('bad mp4')); });
    const result = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    video.src = ''; URL.revokeObjectURL(url);
    return result;
  }, Array.from(film));
  assert.ok(Math.abs(probe.duration - 90) < 1, `duration should be ~90s, got ${probe.duration}`);
  assert.equal(probe.width, 720); assert.equal(probe.height, 1280);

  // 素材包
  await page.getByRole('button', { name: '导出作品', exact: true }).click();
  const zipDownload = page.waitForEvent('download', { timeout: 300000 });
  await page.getByRole('button', { name: '导出素材包（ZIP）', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await (await zipDownload).saveAs('dev/test-materials.zip');
  const entries = unzipSync(await readFile('dev/test-materials.zip'));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  assert.equal(manifest.complete, true); assert.equal(manifest.shots.length, 10);
  assert.equal(Object.keys(entries).filter(n => n.startsWith('documents/')).length, 5);
  assert.equal(Object.keys(entries).filter(n => n.endsWith('/video.mp4')).length, 10);
  assert.equal(Object.keys(entries).filter(n => n.endsWith('/dubbing.wav')).length, 10);
  assert.ok(strFromU8(entries['subtitles.srt']).includes('00:01:30,000'));

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, smoke, film: probe, archiveFiles: Object.keys(entries).length, errors }, null, 2));
} finally { await browser.close(); }