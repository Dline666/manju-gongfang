import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Clapperboard, Film, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Series } from '../../domain/series';
import { EPISODE_STATUS_LABEL, episodeStatus, episodeDuration } from '../../domain/series';
import { addEpisode, createSeries, deleteSeries, selectSeries, useStudio } from '../../store/studio';
import { releaseVideos, useMediaUrl } from '../../store/media';
import { Button, Empty, Field, Modal, StatusChip } from '../../components/Ui';

/**
 * 作品集：作品 = 系列，系列下是集数。
 *
 * 这一页只做两件事：把系列摆清楚、把某一集送进分镜表。
 * 资产不在这里管——资产属于每一集，在剧集页的「剧集资产」里。
 */
export default function ProjectsPage({ navigate }: { navigate: (route: string) => void }) {
  const { series } = useStudio();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<Series>();
  const [addingTo, setAddingTo] = useState<Series>();
  const [episodeTitle, setEpisodeTitle] = useState('');

  const sorted = [...series].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  function start() {
    const created = createSeries(name.trim() || '未命名系列');
    selectSeries(created.id);
    setName('');
    setCreating(false);
    navigate(`library/${created.id}`);
  }

  return <div className="stack library-page">
    <header className="page-heading">
      <div className="page-heading-title">
        <h1>作品集<span className="accent">。</span></h1>
        <p className="muted">一个作品是一部系列，系列下按集排。每一集各自有剧本、分镜和资产。</p>
      </div>
      <Button onClick={() => { setName(''); setCreating(true); }}><Plus size={16} /> 新建系列</Button>
    </header>

    {sorted.length === 0
      ? <Empty title="还没有作品" text="新建一个系列，再到聊天室写第一集的小说。">
        <Button onClick={() => { setName(''); setCreating(true); }}><Plus size={16} /> 新建系列</Button>
      </Empty>
      : <div className="series-grid">{sorted.map(item => <SeriesCard key={item.id} series={item}
          onOpen={() => { selectSeries(item.id); navigate(`library/${item.id}`); }}
          onDelete={() => setDeleting(item)} />)}</div>}

    <Modal open={creating} onClose={() => setCreating(false)} title="新建系列" description="系列定画幅与分辨率，之后每一集都沿用。">
      <form className="stack" onSubmit={event => { event.preventDefault(); start(); }}>
        <Field label="系列名称" hint="例如：断剑归门。之后可以改。">
          <input autoFocus value={name} maxLength={60} onChange={event => setName(event.target.value)} placeholder="给这部系列起个名字" />
        </Field>
        <p className="small muted">新建时会自动建好第 1 集。画幅默认 9:16、分辨率 720p，可在系列页改。</p>
        <div className="row end">
          <Button type="button" variant="secondary" onClick={() => setCreating(false)}>取消</Button>
          <Button type="submit">创建并打开</Button>
        </div>
      </form>
    </Modal>

    <Modal open={!!deleting} onClose={() => setDeleting(undefined)} title="删除系列" description="只删除此浏览器中的这整部系列，包含它所有的集数、分镜与资产。此操作无法撤销。">
      <p>确定删除「{deleting?.name}」？它的 {deleting?.episodes.length} 集内容都会一起消失。</p>
      <div className="row end">
        <Button variant="secondary" onClick={() => setDeleting(undefined)}>保留</Button>
        <Button variant="destructive" onClick={() => {
          if (!deleting) return;
          for (const episode of deleting.episodes) releaseVideos(episode.id);
          deleteSeries(deleting.id);
          setDeleting(undefined);
          toast.success('系列已删除');
        }}>确认删除</Button>
      </div>
    </Modal>

    <Modal open={!!addingTo} onClose={() => setAddingTo(undefined)} title="新增集数" description="新集会顺延集号，不会复用已删掉的号。">
      <form className="stack" onSubmit={event => {
        event.preventDefault();
        if (!addingTo) return;
        const episode = addEpisode(addingTo.id, episodeTitle.trim());
        setAddingTo(undefined);
        setEpisodeTitle('');
        if (episode) { toast.success(`已新增第${episode.number}集`); navigate(`library/${addingTo.id}/${episode.id}`); }
      }}>
        <Field label="集标题" hint="可留空，之后在分镜表顶栏改。">
          <input autoFocus value={episodeTitle} maxLength={60} onChange={event => setEpisodeTitle(event.target.value)} placeholder="例如：雪夜归人" />
        </Field>
        <div className="row end">
          <Button type="button" variant="secondary" onClick={() => setAddingTo(undefined)}>取消</Button>
          <Button type="submit">新增集数</Button>
        </div>
      </form>
    </Modal>
  </div>;
}

function SeriesCard({ series, onOpen, onDelete }: { series: Series; onOpen: () => void; onDelete: () => void }) {
  const cover = useMediaUrl(series.episodes.flatMap(episode => episode.assets).find(asset => asset.imageId)?.imageId);
  const shots = series.episodes.reduce((total, episode) => total + episode.shots.length, 0);
  const seconds = series.episodes.reduce((total, episode) => total + episodeDuration(episode), 0);
  const generated = series.episodes.filter(episode => episodeStatus(episode) === 'generated').length;
  return <article className="series-card">
    <button className="project-cover" onClick={onOpen} aria-label={`打开系列 ${series.name}`}>
      {cover ? <img src={cover} alt="系列资产预览" /> : <><Film size={38} strokeWidth={1} /><span>你的故事，正在成形</span></>}
      <span className="cover-badge">{generated > 0 ? `${generated} 集已生成` : shots > 0 ? `${shots} 个镜头` : '待起步'}</span>
      <span className="cover-arrow"><ArrowUpRight size={20} /></span>
    </button>
    <div className="project-info">
      <button className="text-button project-title" onClick={onOpen} title={series.name}>{series.name}</button>
      <p className="small muted">{series.aspect} · {series.resolution} · {series.episodes.length} 集</p>
      <div className="row between small muted">
        <span><Clapperboard size={13} /> {shots} 个镜头</span>
        <span>{seconds > 0 ? `${Math.round(seconds)} 秒` : '尚无分镜'}</span>
      </div>
      <div className="row between card-bottom">
        <span className="small muted">{new Date(series.updatedAt).toLocaleDateString('zh-CN')}</span>
        <div className="row tight">
          <button className="icon-button" title="删除系列" aria-label={`删除系列 ${series.name}`} onClick={onDelete}><Trash2 size={15} /></button>
          <Button variant="ghost" size="sm" onClick={onOpen}>打开 <ArrowRight size={14} /></Button>
        </div>
      </div>
    </div>
  </article>;
}

export { EPISODE_STATUS_LABEL, StatusChip };