import { createContext, useContext, type ReactNode } from 'react';

/**
 * 五步导航由 App 提供，页面标题行直接取用，
 * 这样「页面标题 + 步骤条 + 页面操作」只占一行。
 */
export const StageNavContext = createContext<ReactNode>(null);

export function PageHeader({ title, help, actions }: { title: ReactNode; help?: ReactNode; actions?: ReactNode }) {
  const nav = useContext(StageNavContext);
  return <header className="page-heading">
    <div className="page-heading-title"><h1>{title}</h1>{help}</div>
    {nav && <div className="page-heading-nav">{nav}</div>}
    {actions && <div className="page-heading-actions">{actions}</div>}
  </header>;
}
