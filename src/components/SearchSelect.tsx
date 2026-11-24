import { useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export type SearchOption = { value: string; label: string; hint?: string; group?: string };

/**
 * 长下拉的替代：可搜索、按平台分组，默认只露出前 5 项，其余点「更多」。
 * 原生 select 无法搜索，这里用按钮 + 弹出列表，保持同样的取值/回调形态。
 */
export default function SearchSelect({ label, value, onChange, options, disabled, placeholder = '请选择', limit = 5 }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SearchOption[];
  disabled?: boolean;
  placeholder?: string;
  limit?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.find(option => option.value === value);

  const filtered = query.trim()
    ? options.filter(option => `${option.label} ${option.hint ?? ''} ${option.group ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    : options;
  const visible = query.trim() || showAll ? filtered : filtered.slice(0, limit);
  const hiddenCount = filtered.length - visible.length;
  const groups: { name: string; items: SearchOption[] }[] = [];
  for (const option of visible) {
    const name = option.group ?? '';
    const group = groups.find(item => item.name === name);
    if (group) group.items.push(option);
    else groups.push({ name, items: [option] });
  }

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setShowAll(false);
    setActive(0);
  }, [open]);

  function choose(option: SearchOption) {
    onChange(option.value);
    setOpen(false);
  }

  function move(delta: number) {
    if (!visible.length) return;
    setActive(previous => (previous + delta + visible.length) % visible.length);
  }

  return <div className="field search-select">
    <span>{label}</span>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="search-select-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" disabled={disabled}>
          <span className={`truncate ${selected ? '' : 'muted'}`.trim()}>{selected?.label ?? placeholder}</span>
          <ChevronDown size={14} className="muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} collisionPadding={12} className="search-select-popover">
        <input className="search-select-input" aria-label={`搜索${label}`} placeholder="输入名称或模型搜索…" value={query} autoFocus onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
          else if (event.key === 'Enter') { event.preventDefault(); const option = visible[active]; if (option) choose(option); }
        }} />
        <div className="search-select-list" role="listbox" aria-label={label}>
          {!visible.length && <p className="search-select-empty muted small">没有匹配的选项</p>}
          {groups.map(group => <div key={group.name || 'all'} role="group" aria-label={group.name || label}>
            {group.name && <div className="search-select-group">{group.name}</div>}
            {group.items.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} className={`search-select-option ${option.value === value ? 'is-selected' : ''} ${option === visible[active] ? 'is-active' : ''}`.trim()} onMouseEnter={() => setActive(visible.indexOf(option))} onClick={() => choose(option)}>
              <span className="search-select-text"><span className="truncate">{option.label}</span>{option.hint && <small className="muted truncate">{option.hint}</small>}</span>
              {option.value === value && <Check size={14} />}
            </button>)}
          </div>)}
        </div>
        {hiddenCount > 0 && <button type="button" className="search-select-more" onClick={() => setShowAll(true)}>更多（{hiddenCount}）</button>}
      </PopoverContent>
    </Popover>
  </div>;
}
