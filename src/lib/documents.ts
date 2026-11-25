import type { Dialogue, Project, PromptTemplateSet } from '../domain/types';
import { speakerName } from '../domain/types';
import { assetText, fixedDescription, imagePrompt, videoPrompt } from './prompts';
import { validateProject } from '../domain/validation';

const sourceNames = { empty: '空白项目', template: '模板演练（非AI生成，需人工完善）', import: '用户导入', ai: 'AI生成（需人工审核）' };
const kindNames = { character: '人物', scene: '场景', prop: '道具', voice: '音色' };
const audioNames = { original: '原声', dubbing: '后期配音', silent: '静音' };
const timestamp = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

export function buildSrt(project: Project): string {
  let elapsed = 0;
  let index = 0;
  const entries: string[] = [];
  for (const shot of project.shots) {
    const duration = Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : 0;
    const dialogues = shot.dialogues.filter(d => d.text.trim());
    dialogues.forEach((d, i) => {
      const start = elapsed + duration * i / dialogues.length;
      const end = elapsed + duration * (i + 1) / dialogues.length;
      entries.push(`${++index}\n${timestamp(start)} --> ${timestamp(end)}\n${d.text.replace(/\r?\n+/g, ' ')}`);
    });
    elapsed += duration;
  }
  return entries.join('\n\n') + (entries.length ? '\n' : '');
}

export function buildDocuments(project: Project, global?: PromptTemplateSet): Record<string, string> {
  const header = `# ${project.name}\n\n来源：${sourceNames[project.source]}\n\n主题：${project.theme}\n\n风格：${project.style}\n\n镜头：${project.shots.length} / 总时长：${project.shots.reduce((sum, s) => sum + s.duration, 0)}秒\n`;
  const speaker = (line: Dialogue) => speakerName(project, line) || '未指定人物';
  const issues = validateProject(project);
  return {
    '剧本文档.md': header + (project.screenplay?.trim() ? project.screenplay.trim() + '\n' : project.shots.map(s => `\n## 第${s.number}镜 · ${s.duration}秒\n\n画面：${s.visual}\n\n开场：${s.start}\n\n动作：${s.action}\n\n终点：${s.end}\n\n运镜：${s.camera}\n\n台词：\n${s.dialogues.map(d => `- ${speaker(d)}：${d.text}`).join('\n') || '无对白'}\n`).join('')),
    '资产设定.md': header + (project.assets.map(a => `\n## ${kindNames[a.kind]} · ${a.name}\n\n描述：${a.description}\n\n固定短语：${fixedDescription(a)}\n\n${a.kind === 'voice' ? `音色ID：${a.voiceId || '未选择'}；语速：${a.speed ?? 1}` : `图片：${a.imageId ? '已在本地素材库保存（本文档不含图片二进制）' : '未添加'}${a.voiceAssetId ? `；关联音色：${project.assets.find(v => v.id === a.voiceAssetId)?.name || '无效引用'}` : ''}`}\n`).join('') || '\n尚未创建资产。\n'),
    '分镜文档.md': header + `\n对应关系：${project.storyboardReady ? '已由用户确认' : '待确认'}\n` + project.shots.map(s => `\n## 第${s.number}镜 · ${s.duration}秒\n\n画面：${s.visual}\n\n开场：${s.start}\n\n动作：${s.action}\n\n终点：${s.end}\n\n运镜：${s.camera}\n\n${assetText(project, s)}\n\n实际图片附件顺序：\n${s.references.map((r, i) => `${i + 1}. ${project.assets.find(a => a.id === r.assetId)?.name || '未知资产'} · ${r.role}`).join('\n') || '未挂图'}\n\n音频：${audioNames[s.audioMode]}\n`).join(''),
    '生成提示词.md': header + '\n## 图片提示词\n' + project.assets.filter(a => a.kind !== 'voice').map(a => `\n### ${a.name}\n\n${imagePrompt(project, a, global)}\n`).join('') + '\n## 视频提示词\n' + project.shots.map(s => `\n### 第${s.number}镜\n\n${videoPrompt(project, s, global)}\n`).join(''),
    '制作清单.md': header + `\n## 剧本与引用校验\n\n${issues.length ? issues.map(e => `- [ ] ${e}`).join('\n') : '- [x] 镜数、时长和引用校验通过（不代表内容已审核）。'}\n\n## 制作状态\n\n${project.shots.map(s => `- [${s.video && !s.stale ? 'x' : ' '}] 第${s.number}镜：${s.stale ? '上游已修改，需要重新审核下游素材' : s.video ? '已关联视频' : '尚未制作视频'}；音频：${audioNames[s.audioMode]}${s.audio ? '（已有配音轨）' : ''}`).join('\n')}\n\n字幕按各镜对白均分时段估算，导出前须按实际语音校对。文档不包含本地图片、试听音频或视频二进制，不是完整素材备份。\n`,
  };
}
