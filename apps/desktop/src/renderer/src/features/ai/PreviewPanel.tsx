/**
 * 工作台里的「**将发送什么**」入口（`docs/11` §6.4 / §6.7）。
 *
 * ## 为什么在工作台里，而不是设置页（沿用 D-10）
 *
 * 与 `EgressPanel` 同一条理由：要产生**真实**的 payload，就得有
 * `workId` + `chapterId` + 光标前后文 —— 而设置面板是全局的，没有"当前章节"这个概念。
 * 在设置页只能显示一句"打开一个章节后可用"，那等于没有预览。
 *
 * ## 为什么是"点击才加载"而不是常驻
 *
 * 预览要读设定文件、读相邻章、渲染模板 —— 挂在编辑器上方常驻就等于每次切章都白读一遍磁盘，
 * 而用户绝大多数时候并不需要看它。折中：一个轻量入口，点开才拉一次。
 *
 * ## 换作品 / 换章要把结果收起来
 *
 * 拉回来的那一份是**上一章**的 payload。留着它，用户会把"上一章要发的东西"
 * 当成"这一章要发的东西"读 —— 而这张面板的唯一用途就是让他相信眼前这一份。
 * 所以作用域一变就收起（不是"重新拉"，那会在切章时白读一次盘；用户再点一下即可）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiPreviewResponse } from '@inkstone/shared';

import { ApiClient, describeApiError } from '../../lib/api';
import type { EditorHandle } from '../editor/TipTapEditor';
import { ContextPreview } from './ContextPreview';
import { hostOf } from './context-preview';
import './ai-panel.css';

interface PreviewPanelProps {
  client: ApiClient | null;
  workId: string | null;
  chapterId: string | null;
  /** 惰性取句柄：编辑器实例会被 `useEditor` 换掉，拿实例会留下过期引用 */
  getHandle: () => EditorHandle | null;
}

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; preview: AiPreviewResponse }
  | { status: 'error'; message: string };

export function PreviewPanel({ client, workId, chapterId, getHandle }: PreviewPanelProps) {
  /**
   * 「展开」与「数据」是**两个 state**，刻意不合并。
   *
   * 合并成 `open = state.status !== 'idle'` 看着更省，但会让**迟到的响应把面板弹回来**：
   * 展开 → 收起（请求还在飞）→ 响应落地 → 状态变 `ready` → 面板自己又打开了。
   * 这是 `docs/13` M18 的同一族（`EgressPanel` 把 `open` 单独存，所以它没有这个问题；
   * 这里一开始照抄那份结构时漏了这一点）。
   */
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PanelState>({ status: 'idle' });
  /** 归属序号：收起 / 换作品 / 换章都自增，让在飞的那次结果作废（M18 同款，见 `use-ai-continue.ts`）。 */
  const seqRef = useRef(0);

  /** 收起并丢掉当前结果。收起必须**也作废在飞的那次**，否则它回来时会把面板重新推开。 */
  const discard = useCallback(() => {
    seqRef.current += 1;
    setOpen(false);
    setState({ status: 'idle' });
  }, []);

  // 换作品 / 换章：收起上一次的结果（理由见文件头）。
  // 在 cleanup 里 setState 不会被 `react-hooks/set-state-in-effect` 报 —— 该规则只管 effect body。
  useEffect(() => discard, [workId, chapterId, discard]);

  const toggle = useCallback(() => {
    if (open) {
      discard();
      return;
    }
    const handle = getHandle();
    if (client === null || workId === null || chapterId === null || handle === null) {
      // 说一句话，别"点了没反应"。正常情况下面板上方就是编辑器，这条路只在
      // sidecar 自愈的几秒里走得到。
      setOpen(true);
      setState({ status: 'error', message: '本地服务或编辑器还没准备好，稍后再试。' });
      return;
    }
    // 加载直接写在这里而不是"先 setOpen 再在 effect 里拉"：后者是一次级联渲染，
    // 而且 `set-state-in-effect` 会拦（与 `EgressPanel.toggle` 同一写法）。
    const seq = ++seqRef.current;
    const { prefix, suffix } = handle.getContextAroundCursor();
    setOpen(true);
    setState({ status: 'loading' });
    void client
      .previewAi({ workId, chapterId, prefix, suffix })
      .then((preview) => {
        // 收起过 / 换过章就丢掉这一份：它是**别的**上下文装配出来的（M18）。
        if (seqRef.current === seq) setState({ status: 'ready', preview });
      })
      .catch((err: unknown) => {
        if (seqRef.current === seq) {
          setState({ status: 'error', message: describeApiError(err) });
        }
      });
  }, [open, client, workId, chapterId, getHandle, discard]);

  const summary =
    state.status === 'ready'
      ? `将发给 ${state.preview.providerLabel}（${hostOf(state.preview.providerBaseUrl)}）· ${state.preview.egressChars} 字`
      : '';

  return (
    <div className="preview-panel">
      <button type="button" className="linkish" onClick={toggle}>
        将发送什么{open ? ' ▲' : ' ▼'}
      </button>
      {state.status === 'ready' ? <span className="hint">{summary}</span> : null}

      {open ? (
        <div className="preview-body">
          {state.status === 'loading' ? (
            <span className="spinner" />
          ) : state.status === 'error' ? (
            // 失败直接显示服务端那句话（`AI_NOT_CONFIGURED` / `AI_CONTEXT_TOO_LONG`
            // 都是"说清下一步做什么"的人话），不再翻译一遍
            <p className="inline-error">{state.message}</p>
          ) : state.status === 'ready' ? (
            <ContextPreview preview={state.preview} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
