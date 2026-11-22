import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

// 右侧抽屉：仍是 role=dialog，兼容原有测试与键盘关闭。
export default function ShotDrawer({ open, number, onClose, children }: { open: boolean; number: number; onClose: () => void; children: ReactNode }) {
  return <Sheet open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-xl">
      <SheetHeader className="p-0"><SheetTitle>第{number}镜视频详情</SheetTitle><SheetDescription>查看完整画面、关联资产与固定短语，生成或导入本镜视频和配音。</SheetDescription></SheetHeader>
      <div className="stack media-detail">{children}</div>
    </SheetContent>
  </Sheet>;
}
