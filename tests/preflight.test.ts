import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreflight } from '../src/features/export/preflight';
import { makeShot, type Project, type Shot } from '../src/domain/types';
import type { MediaReport } from '../src/lib/media/inputs';

const video = { origin: 'upload' as const, name: 'x.mp4', duration: 9 };
function makeProject(patch: (shot: Shot, index: number) => Partial<Shot> = () => ({})): Project {
  return {
    id: 'p', name: '成片检查', theme: '', style: '', createdAt: '', updatedAt: '', revision: 0,
    skills: [], assets: [], source: 'template', storyboardReady: true,
    shots: Array.from({ length: 10 }, (_, index) => ({ ...makeShot(index + 1), visual: '画面', video, ...patch(makeShot(index + 1), index) })),
  };
}
function makeReport(project: Project, patch: (shot: Shot, index: number) => { video?: boolean; audio?: boolean; videoDuration?: number; audioDuration?: number } = () => ({})): MediaReport {
  return {
    issues: [], ready: true,
    shots: project.shots.map((shot, index) => {
      const extra = patch(shot, index);
      return {
        shot, issues: [],
        video: extra.video === false ? undefined : ({} as Blob),
        audio: extra.audio === false ? undefined : ({} as Blob),
        videoDuration: extra.videoDuration ?? 9,
        audioDuration: extra.audioDuration,
      };
    }),
  };
}

test('完整素材没有红色项', () => {
  const project = makeProject(shot => ({ ...shot, audioMode: 'silent', dialogues: [] }));
  const result = buildPreflight(project, makeReport(project));
  assert.deepEqual(result.red, []);
  assert.equal(result.canExport, true);
});

test('缺视频、缺配音、配音超时、stale 都会阻止导出', () => {
  const project = makeProject((shot, index) => index === 0
    ? { ...shot, video: undefined }
    : index === 1
      ? { ...shot, audioMode: 'dubbing', dialogues: [{ id: 'd', speakerId: '', text: '台词' }], audio: { mediaId: 'a', name: 'a.wav', duration: 9 } }
      : index === 2
        ? { ...shot, stale: true }
        : { ...shot, audioMode: 'silent', dialogues: [] });
  const report = makeReport(project, (shot, index) => index === 1 ? { audioDuration: 10 } : {});
  const result = buildPreflight(project, report);
  assert.ok(result.red.some(item => item.message.includes('缺少视频')));
  assert.ok(result.red.some(item => item.message.includes('配音超过镜头时长')));
  assert.ok(result.red.some(item => item.message.includes('素材待更新')));
  assert.equal(result.canExport, false);
});

test('镜头缺失、总时长越界与时长越界会阻止导出', () => {
  const empty = makeProject();
  empty.shots = [];
  assert.ok(buildPreflight(empty, makeReport(empty)).red.some(item => item.message.includes('需要完整的分镜')));
  const short = makeProject();
  short.shots[0].duration = 3.2;
  assert.ok(buildPreflight(short, makeReport(short)).red.some(item => item.message.includes('0.5 秒的整数倍')));
  const long = makeProject();
  long.shots = long.shots.map(shot => ({ ...shot, duration: 45 }));
  assert.ok(buildPreflight(long, makeReport(long)).red.some(item => item.message.includes('总时长')));
});

test('补帧、截取与原声模式是需要勾选确认的黄色项', () => {
  const project = makeProject((shot, index) => index === 0
    ? { ...shot, audioMode: 'original', dialogues: [{ id: 'd', speakerId: '', text: '台词' }] }
    : { ...shot, audioMode: 'silent', dialogues: [] });
  const report = makeReport(project, (shot, index) => index === 0 ? { videoDuration: 5 } : index === 1 ? { videoDuration: 12 } : {});
  const result = buildPreflight(project, report);
  assert.deepEqual(result.red, []);
  assert.ok(result.yellow.some(item => item.message.includes('最后一帧补足')));
  assert.ok(result.yellow.some(item => item.message.includes('从开头截取')));
  assert.ok(result.yellow.some(item => item.message.includes('原声模式')));
});

test('没有报告时不放行', () => {
  const project = makeProject();
  const result = buildPreflight(project, undefined);
  assert.equal(result.canExport, false);
  assert.equal(result.checked, false);
});
