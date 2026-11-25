import type { ReactNode } from 'react';

/**
 * 页面标题行：标题 + 帮助 + 本页操作。
 * 五步步骤条不再由页面渲染，固定在 App 的 workspace-content 顶部一行，
 * 这样各页无论操作按钮多少，步骤条的纵向位置、左右边距都一致。
 */
export function PageHeader({ title, help, actions }: { title: ReactNode; help?: ReactNode; actions?: ReactNode }) {
  return <header className="page-heading">
    <div className="page-heading-title"><h1>{title}</h1>{help}</div>
    {actions && <div className="page-heading-actions">{actions}</div>}
  </header>;
}