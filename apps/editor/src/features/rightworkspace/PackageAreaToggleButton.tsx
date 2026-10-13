'use client';

import { IconPackage } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { useRightWorkspaceStore } from './rightWorkspaceStore';

/**
 * 打包区顶栏入口按钮（spec「右侧工作区与打包区服务」：打包区=顶栏按钮+快捷键）。
 * 再触同入口关闭（toggle 语义）；被 Agent 会话视图互斥由容器 store 治理。
 */
export function PackageAreaToggleButton() {
  const activeKind = useRightWorkspaceStore((s) => s.activeKind);
  const toggle = useRightWorkspaceStore((s) => s.toggle);

  const isOpen = activeKind === 'packageArea';

  return (
    <Button
      size="sm"
      variant={isOpen ? 'secondary' : 'ghost'}
      onClick={() => toggle('packageArea')}
      aria-expanded={isOpen}
      title="打开/关闭打包区（快捷键 T）"
    >
      <IconPackage size={16} className="mr-1" />
      打包区
    </Button>
  );
}

export default PackageAreaToggleButton;
