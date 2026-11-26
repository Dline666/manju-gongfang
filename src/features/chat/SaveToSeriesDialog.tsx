import { useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import type { Series } from '../../domain/series';
import { addEpisode, createSeries, updateEpisode } from '../../store/studio';
import { appendMessage, setSessionTarget, type ChatMessage } from '../../store/chat';
import { Button, Field, Modal } from '../../components/Ui';

type Target = 'auto' | 'novel' | 'screenplay' | 'storyboard';
type Resolved = Exclude<Target, 'auto'>;

/**
 * 把聊天室里的一条回复落到系列/集里。
 *
 * 落点由内容决定，不靠用户猜：
 * - 有【镜头N：…】标记 → 剧本
 * - 是纯 JSON 且有 shots → 分镜原文（只备查，真落地要走「导入分镜」）
 * - 其它 → 小说
 * 允许手动改判：模型输出形态不一定规矩，人说了算。
 */
export function guessTarget(text: string): Resolved {
  if (/【镜头\s*\d+[:：]/.test(text)) return 'screenplay';
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && /"shots"/.test(trimmed)) return 'storyboard';
  return 'novel';
}

const labels: Record<Resolved, string> = {
  novel: '本集小说',
  screenplay: '本集剧本',
  storyboard: '本集分镜原文（仅备查，需另走导入）',
};

export default function SaveToSeriesDialog({ open, message, sessionId, series, onClose, onSaved }: {
  open: boolean;
  message: ChatMessage;
  sessionId: string;
  series: Series[];
  onClose: () => void;
  onSaved: (seriesId: string, episodeId: string) => void;
}) {
  const guessed = guessTarget(message.text);
  const [target, setTarget] = useState<Target>('auto');
  const [mode, setMode] = useState<'existing' | 'new'>(series.length ? 'existing' : 'new');
  const [seriesId, setSeriesId] = useState(series[0]?.id ?? '');
  const [episodeId, setEpisodeId] = useState(series[0]?.episodes[0]?.id ?? '');
  const [newName, setNewName] = useState('');
  const resolved: Resolved = target === 'auto' ? guessed : target;
  const picked = series.find(item => item.id === seriesId);
  const episodes = picked?.episodes ?? [];

  function save() {
    if (mode === 'new' || !picked) {
      const name = newName.trim() || '未命名系列';
      const created = createSeries(name);
      const episode = created.episodes[0] ?? addEpisode(created.id);
      if (!episode) { toast.error('新建失败，请重试。'); return; }
      write(created.id, episode.id, name, name);
      return;
    }
    const episode = episodes.find(item => item.id === episodeId) ?? episodes[0];
    if (!episode) { toast.error('这个系列还没有集数：先在系列页新增一集，再回来保存。'); return; }
    write(picked.id, episode.id, picked.name, episode.title);
  }

  function write(toSeriesId: string, toEpisodeId: string, seriesName: string, episodeTitle: string) {
    const patch = resolved === 'novel' ? { novel: message.text }
      : resolved === 'screenplay' ? { screenplay: message.text }
        : { storyboardJson: message.text };
    // 空标题在分镜表顶栏很显眼：取第一行非 JSON 文本当标题，取不到就用系列名。
    const fallbackTitle = message.text.split('\n').map(line => line.trim())
      .find(line => line && !line.startsWith('{') && !line.startsWith('['))?.slice(0, 30);
    updateEpisode(toSeriesId, toEpisodeId, episodeTitle ? patch : { ...patch, ...(resolved === 'storyboard' ? {} : { title: fallbackTitle || seriesName }) });
    setSessionTarget(sessionId, toSeriesId, toEpisodeId);
    appendMessage(sessionId, { role: 'assistant', text: `已保存到「${seriesName}」的${labels[resolved].replace(/（.*$/, '')}。`, error: false });
    toast.success('已保存，可以到系列页继续');
    onSaved(toSeriesId, toEpisodeId);
  }

  return <Modal open={open} onClose={onClose} title="保存到系列" description="保存只写入文本，不会覆盖已导入的分镜镜头。">
    <form className="stack" onSubmit={event => { event.preventDefault(); save(); }}>
      <Field label="内容类型" hint={`自动判断为「${labels[guessed]}」，判断不对可以手动改。`}>
        <select value={target} onChange={event => setTarget(event.target.value as Target)}>
          <option value="auto">自动判断（{labels[guessed]}）</option>
          {(Object.keys(labels) as Resolved[]).map(value => <option key={value} value={value}>{labels[value]}</option>)}
        </select>
      </Field>
      <Field label="保存到" hint="选已有系列，或新建一个（会同时建好第 1 集）。">
        <select value={mode === 'new' ? '__new' : seriesId} onChange={event => {
          if (event.target.value === '__new') { setMode('new'); return; }
          setMode('existing');
          setSeriesId(event.target.value);
          setEpisodeId(series.find(item => item.id === event.target.value)?.episodes[0]?.id ?? '');
        }}>
          {series.map(item => <option key={item.id} value={item.id}>{item.name}（{item.episodes.length} 集）</option>)}
          <option value="__new">+ 新建系列</option>
        </select>
      </Field>
      {mode === 'new' && <Field label="新系列名称"><input autoFocus value={newName} onChange={event => setNewName(event.target.value)} maxLength={60} placeholder="例如：断剑归门" /></Field>}
      {mode === 'existing' && episodes.length > 0 && <Field label="保存到哪一集" hint={resolved === 'storyboard' ? '分镜原文不会直接生成本集镜头，请到剧集页用「导入分镜」。' : undefined}>
        <select value={episodeId} onChange={event => setEpisodeId(event.target.value)}>
          {episodes.map(item => <option key={item.id} value={item.id}>第{item.number}集 {item.title}</option>)}
        </select>
      </Field>}
      {mode === 'existing' && episodes.length === 0 && <p className="small muted">这个系列还没有集数，保存会失败。请先到系列页新增一集。</p>}
      <div className="row end">
        <Button type="button" variant="secondary" onClick={onClose}>取消</Button>
        <Button type="submit"><Plus size={15} /> 保存</Button>
      </div>
    </form>
  </Modal>;
}