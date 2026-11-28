import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Clapperboard, Film, Mic, Plus, Shapes, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ASPECTS, EPISODE_STATUS_LABEL, RESOLUTIONS, episodeDuration, episodeLabel, episodeStatus, sortedEpisodes, type Aspect, type Resolution, type Series } from '../../domain/series';
import { addEpisode, deleteEpisode, setSeriesAspect, setSeriesResolution, updateSeries, useStudio } from '../../store/studio';
import { releaseVideos, useMediaUrl } from '../../store/media';
import { Button, Empty, Field, Modal, StatusChip } from '../../components/Ui';

const assetKindLabels = { character: '人物', scene: '场景', prop: '道具', voice: '音色' } as const;
type AssetKind = keyof typeof assetKindLabels;

/**
 * 系列详情：上面是系列设定，下面是集数表，再下面是跨集的「剧集资产」总览。
 *
 * 资产按集存放（每一集有自己的人物/场景/道具），这里只是汇总视图：
 * 同名同 id 的资产去重显示，并列出它在第几集、第几镜出现，方便统一改设定。
 */
export default function SeriesPage({ series, navigate }: { series: Series; navigate: (route: string) => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(series.name);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [removing, setRemoving] = useState<{ id: string; label: string }>();
  const [tab, setTab] = useState<'episodes' | 'assets'>('episodes');
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const episodes = sortedEpisodes(series);

  const assets = useMemo(() => {
    const rows = new Map<string, { id: string; kind: AssetKind; name: string; description: string; imageId?: string; episodes: Set<number>; shots: Set<number> }>();
    for (const episode of episodes) {
      for (const asset of episode.assets) {
        const row = rows.get(asset.id) ?? { id: asset.id, kind: asset.kind, name: asset.name, description: asset.description, imageId: asset.imageId, episodes: new Set(), shots: new Set() };
        if (!row.imageId && asset.imageId) row.imageId = asset.imageId;
        if (!row.description && asset.description) row.description = asset.description;
        row.episodes.add(episode.number);
        for (const shot of episode.shots) if (shot.assetIds.includes(asset.id) || shot.dialogues.some(line => line.speakerId === asset.id)) row.shots.add(shot.number);
        rows.set(asset.id, row);
      }
    }
    return [...rows.values()].filter(row => kind === 'all' || row.kind === kind);
  }, [episodes, kind]);

  const totalShots = episodes.reduce((total, episode) => total + episode.shots.length, 0);
  const totalSeconds = episodes.reduce((total, episode) => total + episodeDuration(episode), 0);

  return <div className="stack series-page">
    <div className="row between wrap series-head">
      <div className="row tight">
        <Button variant="ghost" size="sm" onClick={() => navigate('library')}><ArrowLeft size={15} /> 作品集</Button>
        <h1 className="series-title">{series.name}</h1>
        <Button variant="ghost" size="sm" onClick={() => { setName(series.name); setRenaming(true); }}>重命名</Button>
      </div>
      <div className="row tight">
        <span className="tag">{episodes.length} 集</span>
        <span className="tag">{totalShots} 镜</span>
        <span className="tag">{Math.round(totalSeconds)} 秒</span>
      </div>
    </div>

    <section className="panel stack series-settings">
      <div className="section-title"><h2>系列设定</h2><span className="small muted">本系列所有集共用画幅与分辨率</span></div>
      <div className="row wrap series-settings-row">
        <Field label="画幅" hint="竖屏 9:16 适合手机端漫剧；横屏 16:9 适合投屏与长视频。">
          <select value={series.aspect} onChange={event => {
            const next = event.target.value as Aspect;
            setSeriesAspect(series.id, next);
            toast.success(`画幅已改为 ${next}，已生成的视频需要重新生成才能套用。`);
          }}>
            {ASPECTS.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </Field>
        <Field label="分辨率" hint="720p 够用且快；1080p 更清晰但更慢更贵。">
          <select value={series.resolution} onChange={event => setSeriesResolution(series.id, event.target.value as Resolution)}>
            {RESOLUTIONS.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </Field>
        <Field label="风格" hint="风格定义会逐字进入每一镜的提示词，不要在这里写具体剧情。">
          <textarea rows={3} value={series.style ?? ''} onChange={event => updateSeries(series.id, { style: event.target.value })} placeholder="例如：东方玄幻水墨，冷青灰调，颗粒质感" />
        </Field>
      </div>
    </section>

    <div className="row tight series-tabs" role="tablist" aria-label="系列内容">
      <button role="tab" aria-selected={tab === 'episodes'} className={`series-tab ${tab === 'episodes' ? 'is-active' : ''}`} onClick={() => setTab('episodes')}><Clapperboard size={15} /> 集数</button>
      <button role="tab" aria-selected={tab === 'assets'} className={`series-tab ${tab === 'assets' ? 'is-active' : ''}`} onClick={() => setTab('assets')}><Shapes size={15} /> 剧集资产</button>
    </div>

    {tab === 'episodes' && <section className="panel stack">
      <div className="section-title"><h2>集数</h2><Button variant="ghost" onClick={() => { setTitle(''); setAdding(true); }}><Plus size={15} /> 新增集数</Button></div>
      {episodes.length === 0
        ? <Empty title="还没有集数" text="新增一集，再去聊天室写这一集的小说。"><Button onClick={() => setAdding(true)}><Plus size={15} /> 新增集数</Button></Empty>
        : <div className="table-scroll">
          <table className="episode-table">
          <caption className="sr-only">集数列表</caption>
          <thead><tr><th scope="col">集</th><th scope="col">标题</th><th scope="col">分镜</th><th scope="col">总时长</th><th scope="col">状态</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
          <tbody>{episodes.map(episode => <tr key={episode.id}>
            <td className="episode-number">第{episode.number}集</td>
            <td><button className="text-button" onClick={() => navigate(`library/${series.id}/${episode.id}`)}>{episode.title || '未命名'}</button></td>
            <td>{episode.shots.length} 个镜头</td>
            <td>{episodeDuration(episode) > 0 ? `${episodeDuration(episode).toFixed(1)} 秒` : '—'}</td>
            <td><StatusChip tone={episodeStatus(episode) === 'generated' ? 'success' : episodeStatus(episode) === 'imported' ? 'running' : 'neutral'}>{EPISODE_STATUS_LABEL[episodeStatus(episode)]}</StatusChip></td>
            <td><div className="row end tight">
              <Button variant="ghost" size="sm" onClick={() => navigate(`library/${series.id}/${episode.id}`)}>进入分镜表 <ArrowRight size={14} /></Button>
              <button className="icon-button" aria-label={`删除 ${episodeLabel(episode)}`} onClick={() => setRemoving({ id: episode.id, label: episodeLabel(episode) })}><Trash2 size={15} /></button>
            </div></td>
          </tr>)}</tbody>
          </table>
        </div>}
    </section>}

    {tab === 'assets' && <section className="panel stack">
      <div className="section-title">
        <h2>剧集资产</h2>
        <div className="row wrap" role="group" aria-label="资产分类">
          <button className={`chip ${kind === 'all' ? 'is-active' : ''}`} onClick={() => setKind('all')}>全部</button>
          {(Object.keys(assetKindLabels) as AssetKind[]).map(value => <button key={value} className={`chip ${kind === value ? 'is-active' : ''}`} onClick={() => setKind(value)}>{assetKindLabels[value]}</button>)}
        </div>
      </div>
      <p className="small muted">资产按集存放，这里是跨集汇总。同名资产只显示一次，并标出它出现在哪些集、哪些镜。</p>
      {assets.length === 0
        ? <Empty title="还没有资产" text="先在某一集导入分镜，资产会从分镜 JSON 的登记表里自动建好。" />
        : <div className="asset-grid">{assets.map(asset => <AssetRow key={`${asset.kind}-${asset.id}`} asset={asset} />)}</div>}
    </section>}

    <Modal open={renaming} onClose={() => setRenaming(false)} title="重命名系列" description="只改显示名称，集数与分镜不受影响。">
      <form className="stack" onSubmit={event => { event.preventDefault(); if (!name.trim()) return; updateSeries(series.id, { name: name.trim() }); setRenaming(false); toast.success('已重命名'); }}>
        <Field label="系列名称"><input autoFocus value={name} maxLength={60} onChange={event => setName(event.target.value)} required /></Field>
        <div className="row end"><Button type="button" variant="secondary" onClick={() => setRenaming(false)}>取消</Button><Button type="submit">保存</Button></div>
      </form>
    </Modal>

    <Modal open={adding} onClose={() => setAdding(false)} title="新增集数" description="集号顺延取最大值 +1，不复用已删掉的号。">
      <form className="stack" onSubmit={event => {
        event.preventDefault();
        const episode = addEpisode(series.id, title.trim());
        setAdding(false); setTitle('');
        if (episode) { toast.success(`已新增第${episode.number}集`); navigate(`library/${series.id}/${episode.id}`); }
      }}>
        <Field label="集标题" hint="可留空，之后在分镜表顶栏改。"><input autoFocus value={title} maxLength={60} onChange={event => setTitle(event.target.value)} placeholder="例如：雪夜归人" /></Field>
        <div className="row end"><Button type="button" variant="secondary" onClick={() => setAdding(false)}>取消</Button><Button type="submit">新增集数</Button></div>
      </form>
    </Modal>

    <Modal open={!!removing} onClose={() => setRemoving(undefined)} title="删除这一集" description="这一集的剧本、分镜与资产都会一起删除。此操作无法撤销。">
      <p>确定删除「{removing?.label}」？同一系列的其它集不受影响。</p>
      <div className="row end">
        <Button variant="secondary" onClick={() => setRemoving(undefined)}>保留</Button>
        <Button variant="destructive" onClick={() => { if (!removing) return; releaseVideos(removing.id); deleteEpisode(series.id, removing.id); setRemoving(undefined); toast.success('已删除'); }}>确认删除</Button>
      </div>
    </Modal>
  </div>;
}

function AssetRow({ asset }: { asset: { id: string; kind: AssetKind; name: string; description: string; imageId?: string; episodes: Set<number>; shots: Set<number> } }) {
  const url = useMediaUrl(asset.imageId);
  const Icon = asset.kind === 'character' ? Shapes : asset.kind === 'scene' ? Film : asset.kind === 'voice' ? Mic : Shapes;
  return <article className="asset-card">
    <div className="asset-thumb compact-media-thumbnail">{url ? <img src={url} alt={`${asset.name} 设定图`} /> : <Icon size={22} strokeWidth={1.3} />}</div>
    <div className="min-w-0 grow">
      <div className="row between gap-2 asset-card-head"><strong className="truncate">{asset.name}</strong><span className="tag subtle">{assetKindLabels[asset.kind]}</span></div>
      <p className="small muted asset-desc">{asset.description || '还没有固定描述，生成前需要补上。'}</p>
      <p className="small muted">{asset.episodes.size ? `第 ${[...asset.episodes].sort((a, b) => a - b).join('、')} 集` : '未出现'}{asset.shots.size ? ` · 镜 ${[...asset.shots].sort((a, b) => a - b).join('、')}` : ''}</p>
    </div>
  </article>;
}