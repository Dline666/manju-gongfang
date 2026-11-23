import test from 'node:test';
import assert from 'node:assert/strict';
import { durationRows } from '../src/features/script/DurationStrip';
import { makeShot, type Asset, type Project } from '../src/domain/types';

const hero: Asset = { id: 'hero', kind: 'character', name: '沈砚', description: '', lock: '灰白布衣' };
const voice: Asset = { id: 'voice', kind: 'voice', name: '音色', description: '', lock: '', voiceId: 'v', speed: 2 };

function project(assets: Asset[], dialogue: string, duration: number): Project {
  return {
    id: 'p', name: '测试', theme: '', style: '', createdAt: '', updatedAt: '', revision: 0,
    skills: [], assets, shots: [{ ...makeShot(1), duration, dialogues: [{ id: 'd', speakerId: 'hero', text: dialogue }] }],
    source: 'template', storyboardReady: false,
  };
}

test('时长表标记越界的镜头', () => {
  const rows = durationRows(project([hero], '', 0.2));
  assert.equal(rows[0].invalid, true);
  assert.equal(durationRows(project([hero], '', 31))[0].invalid, true);
  assert.equal(durationRows(project([hero], '', 9))[0].invalid, false);
});

test('台词所需时间超过时长时标记不够，语速会改变判断', () => {
  const normal = durationRows(project([hero], '一'.repeat(20), 2));
  assert.equal(normal[0].needed, 2.5);
  assert.equal(normal[0].short, true);
  const fast = durationRows(project([{ ...hero, voiceAssetId: voice.id }, voice], '一'.repeat(20), 2));
  assert.equal(fast[0].needed, 1.25);
  assert.equal(fast[0].short, false);
  const noDialogue = durationRows(project([hero], '', 2));
  assert.equal(noDialogue[0].needed, 0);
  assert.equal(noDialogue[0].short, false);
});
