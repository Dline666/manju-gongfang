import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, FileJson, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  parseStoryboardJsonText, previewImport, validateStoryboardJson,
  MAX_SHOTS, MIN_SHOTS, MAX_DURATION, MIN_DURATION, SUGGESTED_MAX_DURATION, SUGGESTED_MIN_DURATION,
  type ImportIssue, type ImportResult,
} from '../../lib/storyboardJson';
import { useActiveEpisode, useActiveSeries, applyImportedStoryboard } from '../../store/studio';
import { Button, Fold, Modal } from '../../components/Ui';

const SHOT_LABELS = '远景 / 全景 / 中景 / 近景 / 特写';

/**
 * 导入分镜：本产品唯一的人工入口。
 *
 * 三件事必须做到，否则用户会失去信任：
 * 1. 校验不通过时**不写任何东西**，把第几镜哪个字段一次列全；
 * 2. 覆盖已有镜头前必须明说会覆盖多少；
 * 3. 导入成功后把「补齐了什么」如实报出来，不假装一切都来自模型。
 */
export default function StoryboardImportDialog({ open, rawText, onClose, onImported }: {
  open: boolean;
  /** 从聊天室带进来的原文；为空则是空文件选择态。 */
  rawText?: string;
  onClose: () => void;
  onImported: (seriesId: string, episodeId: string) => void;
}) {
  const series = useActiveSeries();
  const episode = useActiveEpisode();
  const [text, setText] = useState(rawText ?? '');
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [result, setResult] = useState<ImportResult>();
  const [confirming, setConfirming] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setText(rawText ?? ''); setIssues([]); setResult(undefined); setConfirming(false); } }, [open, rawText]);

  // 改了文本就重新校验：用户能立刻看到「问题消失了」的反馈。
  useEffect(() => {
    if (!text.trim()) { setIssues([]); setResult(undefined); return; }
    const parsed = parseStoryboardJsonText(text);
    if (!parsed.ok) { setIssues([parsed.issue]); setResult(undefined); return; }
    const outcome = validateStoryboardJson(parsed.value, { screenplay: episode?.screenplay });
    if (outcome.ok) { setIssues([]); setResult(outcome.result); }
    else { setIssues(outcome.issues); setResult(undefined); }
  }, [text, episode?.screenplay]);

  const preview = useMemo(() => result ? previewImport(result) : undefined, [result]);
  const existing = episode?.shots.length ?? 0;
  const blocked = !episode || !series;

  async function pick(uploaded?: File) {
    if (!uploaded) return;
    if (uploaded.size > 2 * 1024 * 1024) { toast.error('文件超过 2MB，分镜 JSON 不该这么大。请检查是不是贴错了文件。'); return; }
    setText(await uploaded.text());
    toast.success(`已读入 ${uploaded.name}`);
  }

  function commit() {
    if (!result || !series || !episode) return;
    if (existing > 0 && !confirming) { setConfirming(true); return; }
    applyImportedStoryboard(series.id, episode.id, {
      shots: result.shots,
      assets: result.assets,
      storyboardJson: text.trim(),
      ...(result.title ? { title: result.title } : {}),
    });
    toast.success(`已导入 ${result.shots.length} 镜${result.filledAssets.length ? `，补齐 ${result.filledAssets.length} 个资产` : ''}`);
    onImported(series.id, episode.id);
  }

  return <Modal open={open} onClose={onClose} wide title="导入分镜 JSON" description="粘贴或上传纯 JSON。校验不通过时不会写入任何内容。">
    <div className="stack import-dialog">
      {blocked && <p className="alert">请先在系列页打开某一集，再导入分镜。</p>}

      <div className="import-source">
        <label className="field grow">
          <span>粘贴 JSON</span>
          <textarea rows={9} value={text} spellCheck={false} aria-label="分镜 JSON 正文"
            placeholder='{"title":"第1集 雪夜归人","assets":[...],"shots":[...]}'
            onChange={event => setText(event.target.value)} />
        </label>
        <div className="import-upload">
          <Button variant="outline" onClick={() => file.current?.click()}><Upload size={15} /> 选择 .json 文件</Button>
          <input ref={file} type="file" accept=".json,application/json" hidden aria-label="上传分镜 JSON 文件"
            onChange={event => { void pick(event.target.files?.[0]); event.target.value = ''; }} />
          <p className="small muted">只接受纯 JSON：不能有 Markdown 围栏，前后不能有解释文字。</p>
        </div>
      </div>

      {issues.length > 0 && <section className="panel stack import-issues">
        <div className="section-title"><h3 className="row"><AlertTriangle size={16} /> 校验未通过 · {issues.length} 项</h3><span className="small muted">改完自动重新校验</span></div>
        <ul className="issue-list">{issues.map((issue, index) => <li key={index}>
          {issue.shot > 0
            ? <><button type="button" className="text-button" onClick={() => { const node = document.getElementById(`import-shot-${issue.shot}`); node?.scrollIntoView({ behavior: 'smooth', block: 'center' }); node?.classList.add('shot-flash'); window.setTimeout(() => node?.classList.remove('shot-flash'), 1600); }}>第{issue.shot}镜</button><span className="muted"> · {issue.field} · </span></>
            : <span className="tag subtle">整份</span>}
          {issue.message}
        </li>)}</ul>
        <p className="small muted">允许的景别 {SHOT_LABELS}；单镜 {MIN_DURATION}–{MAX_DURATION} 秒（建议 {SUGGESTED_MIN_DURATION}–{SUGGESTED_MAX_DURATION} 秒）；镜数 {MIN_SHOTS}–{MAX_SHOTS}。</p>
      </section>}

      {preview && result && <section className="panel stack import-preview">
        <div className="section-title"><h3 className="row"><Check size={16} /> 校验通过 · 可以导入</h3><span className="small muted">{result.title ?? episode?.title}</span></div>
        <div className="import-stats">
          <span className="tag">人物 {preview.assetsByKind.character}</span>
          <span className="tag">场景 {preview.assetsByKind.scene}</span>
          <span className="tag">道具 {preview.assetsByKind.prop}</span>
          <span className="tag">{preview.shots.length} 镜</span>
          <span className="tag">共 {preview.totalDuration.toFixed(1)} 秒</span>
          {result.dialogueMismatches > 0 && <span className="tag warning">{result.dialogueMismatches} 句台词与剧本对不上</span>}
        </div>
        {preview.filledAssets.length > 0 && <p className="alert">补齐项：{preview.filledAssets.join('、')}。顶层登记里没有这些资产，已按镜头引用补出来，固定描述留空等你补写。</p>}
        {preview.unknownAssetIds.length > 0 && <p className="alert">无法补齐：{preview.unknownAssetIds.join('、')}。这些 assetId 既没登记也推不出名字，导入后需要手工建资产。</p>}

        <table className="shot-table import-table">
          <caption className="sr-only">导入预览</caption>
          <thead><tr><th scope="col">序号</th><th scope="col">画面</th><th scope="col">景别</th><th scope="col">时长</th><th scope="col">台词</th><th scope="col">资产</th></tr></thead>
          <tbody>{result.shots.map(shot => <tr key={shot.id} id={`import-shot-${shot.number}`}>
            <td>{shot.number}</td>
            <td className="truncate">{shot.visual}</td>
            <td>{shot.camera}</td>
            <td className={shot.duration < SUGGESTED_MIN_DURATION || shot.duration > SUGGESTED_MAX_DURATION ? 'warn-cell' : undefined}>{shot.duration}s</td>
            <td>{shot.dialogues.length}</td>
            <td>{shot.assetIds.length}</td>
          </tr>)}</tbody>
        </table>

        <Fold title="模型原文" meta={`${text.length} 字`}><pre className="import-raw">{text}</pre></Fold>
      </section>}

      {existing > 0 && result && <p className={confirming ? 'alert' : 'small muted'}>
        {confirming
          ? `确认后会覆盖本集现有的 ${existing} 个镜头与资产登记。旧镜头无法找回，请先确认。`
          : `本集已有 ${existing} 个镜头。导入会整体覆盖它们，不是追加。`}
      </p>}

      <div className="row end">
        <Button variant="secondary" onClick={onClose}>取消</Button>
        {confirming && <Button variant="secondary" onClick={() => setConfirming(false)}>我再想想</Button>}
        <Button onClick={commit} disabled={!result || blocked}>
          <FileJson size={15} /> {confirming ? '确认覆盖并导入' : existing > 0 ? '导入（会覆盖）' : '确认导入'}
        </Button>
      </div>
    </div>
  </Modal>;
}