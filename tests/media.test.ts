import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import type { Project, Shot } from '../src/domain/types';
import { buildTimeline, locateTime, audioDurationIssue, projectIssues, safeFilename, formatTime } from '../src/lib/media/timeline';
import { shotCommand, concatList } from '../src/lib/media/commands';
import { requireBlob, assertReady, inspectProject } from '../src/lib/media/inputs';
import { zipFiles, buildMaterialZip } from '../src/lib/media/archive';
import { buildSrt } from '../src/lib/documents';

function shot(number: number, duration = 9): Shot {
  return { id: `shot-${number}`, number, duration, visual: '', camera: '', start: '', action: '', end: '', dialogues: [], references: [], assetIds: [], audioMode: 'silent' };
}
function project(): Project {
  return { id: 'project', name: 'Test', theme: '', style: '', createdAt: '', updatedAt: '', revision: 0, skills: [], shots: Array.from({ length: 10 }, (_, index) => shot(index + 1)), assets: [], source: 'empty', storyboardReady: true };
}

test('ten default shots share an exact 90 second timeline', () => {
  const value = project();
  assert.deepEqual(projectIssues(value), []);
  const timeline = buildTimeline(value.shots);
  assert.equal(timeline.at(-1)?.endMs, 90000);
  assert.equal(timeline.reduce((sum, entry) => sum + entry.frames, 0), 2160);
  assert.equal(locateTime(timeline, 9)?.index, 1);
  assert.equal(locateTime(timeline, 9)?.localTime, 0);
  assert.equal(locateTime(timeline, 90)?.localTime, 9);
  assert.equal(locateTime(timeline, -4)?.index, 0);
  assert.equal(locateTime(timeline, Infinity)?.localTime, 0);
  assert.equal(locateTime([], 0), undefined);
});

test('cumulative boundaries do not accumulate per-shot rounding drift', () => {
  const timeline = buildTimeline(Array.from({ length: 2160 }, (_, index) => shot(index, 1 / 24)));
  assert.equal(timeline.at(-1)?.endMs, 90000);
  timeline.slice(1).forEach((entry, index) => assert.equal(entry.startMs, timeline[index].endMs));
});

test('invalid durations, wrong counts and non-frame-aligned durations are blocked', () => {
  assert.throws(() => buildTimeline([shot(1, NaN)]), /时长无效/);
  assert.throws(() => buildTimeline([shot(1, 0)]), /时长无效/);
  const value = project();
  value.shots[0].duration = 9.01; value.shots[1].duration = 8.99;
  assert.ok(projectIssues(value).some(issue => issue.includes('24 fps')));
  value.shots.pop();
  assert.ok(projectIssues(value).some(issue => issue.includes('10 镜')));
  assert.ok(projectIssues(value).some(issue => issue.includes('90 秒')));
});

test('dubbing overruns are rejected instead of truncated', () => {
  assert.equal(audioDurationIssue(8, 9), undefined);
  assert.equal(audioDurationIssue(9, 9), undefined);
  assert.match(audioDurationIssue(9.02, 9)!, /不会裁剪对白/);
  assert.match(audioDurationIssue(9.0005, 9)!, /不会裁剪对白/);
  assert.match(audioDurationIssue(0, 9)!, /有效时长/);
  assert.match(audioDurationIssue(Infinity, 9)!, /有效时长/);
});

test('empty, missing and stale media cannot be considered ready', async () => {
  assert.throws(() => requireBlob(new Blob(), '视频'), /为空文件/);
  assert.throws(() => requireBlob(undefined, '视频'), /缺失/);
  assert.equal(requireBlob(new Blob(['test']), '视频').size, 4);
  const value = project(); value.shots[0].stale = true;
  const report = await inspectProject(value);
  assert.equal(report.ready, false);
  assert.equal(report.shots.length, 10);
  assert.ok(report.shots[0].issues.some(issue => issue.includes('过期')));
  assert.throws(() => assertReady(report), /尚未导入/);
  await assert.rejects(buildMaterialZip(value), /尚未导入/);
});

test('video filters fit without stretching, hold last frame and use exact target duration', () => {
  const command = shotCommand(shot(1), true);
  const filter = command[command.indexOf('-vf') + 1];
  assert.match(filter, /dar/);
  assert.match(filter, /setsar=1/);
  assert.match(filter, /out_color_matrix=bt709:out_range=tv/);
  assert.equal(command[command.indexOf('-colorspace') + 1], 'bt709');
  assert.equal(command[command.indexOf('-color_range') + 1], 'tv');
  assert.match(filter, /pad=720:1280/);
  assert.match(filter, /fps=24/);
  assert.match(filter, /tpad=stop_mode=clone:stop_duration=9/);
  assert.match(filter, /trim=duration=9/);
  assert.ok(command.includes('yuv420p'));
  assert.ok(command.includes('libx264'));
  assert.ok(command.includes('pcm_s16le'));
  assert.equal(command.at(-1), 'segment.mov');
});

test('original, replacement and silent audio have distinct mapping', () => {
  const original = shotCommand({ ...shot(1), audioMode: 'original' }, true);
  assert.ok(original.includes('0:a:0'));
  assert.ok(!original.includes('/input/input-audio'));
  const dubbing = shotCommand({ ...shot(1), audioMode: 'dubbing' }, true);
  assert.ok(dubbing.includes('/input/input-audio'));
  assert.ok(dubbing.includes('1:a:0'));
  assert.ok(!dubbing.includes('0:a:0'));
  const silent = shotCommand(shot(1), true);
  assert.ok(silent.includes('anullsrc=r=48000:cl=stereo'));
  const absentOriginal = shotCommand({ ...shot(1), audioMode: 'original' }, false);
  assert.ok(absentOriginal.includes('anullsrc=r=48000:cl=stereo'));
  assert.match(dubbing[dubbing.indexOf('-af') + 1], /apad/);
});

test('concat uses generated filenames and exact explicit durations', () => {
  const list = concatList([9, 8.5, 9.5]);
  assert.match(list, /parts\/part-0.mov/);
  assert.match(list, /duration 8.500000000/);
  assert.equal(list.split('file ').length - 1, 3);
});

test('SRT ends exactly at 90 seconds and has continuous dialogue boundaries', () => {
  const value = project();
  value.shots.forEach(item => { item.dialogues = [{ id: 'd1', speakerId: '', text: '第一句' }, { id: 'd2', speakerId: '', text: '第二句' }, { id: 'd3', speakerId: '', text: '第三句' }]; });
  const srt = buildSrt(value);
  assert.match(srt, /00:01:27,000 --> 00:01:30,000/);
  assert.equal(srt.match(/-->/g)?.length, 30);
  const boundaries = [...srt.matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g)];
  boundaries.slice(1).forEach((entry, index) => assert.equal(entry[1], boundaries[index][2]));
});

test('async ZIP entries are sorted and preserve binary content and empty subtitles', async () => {
  const progress: string[] = [];
  const binary = new Uint8Array([0, 1, 255, 12]);
  const blob = await zipFiles([
    { path: 'z-video.mp4', blob: new Blob([binary]) },
    { path: 'b-subtitles.srt', blob: new Blob(), text: true },
    { path: 'a-document.txt', blob: new Blob(['配音与参考图']), text: true },
  ], value => { if (value.file) progress.push(value.file); });
  assert.equal(blob.type, 'application/zip');
  const data = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(Object.keys(data), ['a-document.txt', 'b-subtitles.srt', 'z-video.mp4']);
  assert.deepEqual(progress, Object.keys(data));
  assert.equal(strFromU8(data['a-document.txt']), '配音与参考图');
  assert.deepEqual(data['z-video.mp4'], binary);
  assert.equal(data['b-subtitles.srt'].length, 0);
});

test('ZIP supports cancellation and rejects duplicate names', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(zipFiles([], undefined, controller.signal), { name: 'AbortError' });
  await assert.rejects(zipFiles([{ path: 'same', blob: new Blob() }, { path: 'same', blob: new Blob() }]), /重复/);
  const active = new AbortController();
  await assert.rejects(zipFiles([{ path: 'a.txt', blob: new Blob(['test']), text: true }], () => active.abort(), active.signal), { name: 'AbortError' });
});

test('display timestamp rounding carries into the next minute', () => {
  assert.equal(formatTime(59.999), '01:00.00');
  assert.equal(formatTime(90), '01:30.00');
  assert.equal(formatTime(NaN), '00:00.00');
});

test('filenames cannot inject directories into a material archive', () => {
  assert.equal(safeFilename('../../api-key.json'), '_.._api-key.json');
  assert.ok(!/[\\/:*?"<>|]/.test(safeFilename('x/y\\z:bad?')));
  assert.equal(safeFilename('...'), 'untitled');
});
