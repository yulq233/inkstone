import type { SidecarStatus } from '@inkstone/shared';

/**
 * sidecar 正在重启时的顶部横幅。
 * 批次 B 起，这里还要把编辑器切成只读，避免用户在"服务不在"时继续打字。
 */
export function StatusBanner({ status }: { status: SidecarStatus }) {
  return (
    <div className="banner">
      <div className="spinner" />
      <span>本地服务正在重启（第 {status.restartCount ?? 1} 次），请稍候……</span>
    </div>
  );
}
