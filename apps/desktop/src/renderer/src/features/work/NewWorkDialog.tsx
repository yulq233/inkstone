import { useEffect, useRef } from 'react';
import { NewWorkForm } from './NewWorkForm';

/**
 * 新建作品对话框（`04` §5.2 的表单挪进这里，§11 说明为什么）。
 *
 * 为什么从"常驻表单"改成对话框：首页应当是书架。一进门就是一行空输入框，
 * 对**已经有作品**的人是噪音；对新人也不构成"这里有几本书"的认知。
 *
 * ## 两个刻意的取舍
 *
 * **不做 Esc 关闭、不做点遮罩关闭。** 两者都会让"填了一半的标题与目录"被一次误触清空，
 * 而退出本来只需要一个明确动作。所以只有「取消」一个出口 —— 与 `ConflictDialog` 同口径。
 *
 * **输入框在挂载时自己聚焦**，因此菜单的「新建作品」只要把对话框打开就够了，
 * 不必再跨组件传 ref 去戳输入框（旧版常驻表单必须那样做：只切页面不送光标，
 * 用户还得自己点一下）。
 */
export function NewWorkDialog({ onClose }: { onClose: () => void }) {
  const titleRef = useRef<HTMLInputElement | null>(null);

  // 子组件先挂载、父的 effect 后跑，所以这里 `titleRef.current` 已经被填上了
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-work-dialog-title"
      >
        <div className="row modal-head">
          <h2 id="new-work-dialog-title">新建作品</h2>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
        <NewWorkForm titleInputRef={titleRef} />
      </div>
    </div>
  );
}
