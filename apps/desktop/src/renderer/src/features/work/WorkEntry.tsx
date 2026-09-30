import { useCallback, useEffect, useState } from 'react';
import {
  subscribeAppCommand,
  takePendingEntryIntent,
  type EntryIntent,
} from '../../lib/app-commands';
import { useWorkSession } from '../session/WorkSessionProvider';
import { NewWorkDialog } from './NewWorkDialog';
import { shelfView } from './shelf-view';
import { WorkShelf } from './WorkShelf';
import { pickDirectory, useOpenWork, useRecentWorks } from './use-work-entry';

/** 从路径里取末段做显示名。Windows 上两种分隔符都要认。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter((piece) => piece !== '');
  return parts[parts.length - 1] ?? p;
}

/**
 * 首页 = 书架（`04` §5.1 的原设计 + §11 的改版）。
 *
 * 两种取舍写在明处：
 *
 * - **不自动打开上次的作品**：用户点开应用，期待的是"自己选"，而不是被塞进一本三天前
 *   写的东西。自动打开还会让"打开失败"这条错误路径在启动时就可能触发。
 * - **新建表单收进对话框**（§11）：首页的主角是"我在写的这几本"，
 *   而不是一行空的标题输入框。
 */
export function WorkEntry({ onOpenDiagnostics }: { onOpenDiagnostics: () => void }) {
  const { state, client } = useWorkSession();
  const recent = useRecentWorks();
  const { openingPath, failure, open, forget } = useOpenWork(recent);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);

  /**
   * 正在打开的是哪一本（`docs/13` M19）。
   *
   * 本组件在 `opening` 期间**不卸载**（见 `AppRoutes`），所以这一屏既能看到
   * 卡片上的「打开中……」，也能在打开失败时把原因留在那一张卡上。
   * 全屏"正在打开"卡片留给 `WorkShell`（当前路由走不到，见那边的注释）。
   */
  const openingTitle = state.kind === 'opening' ? state.title : null;

  const openByPicker = useCallback(async () => {
    setPicking(true);
    try {
      const dir = await pickDirectory('选择已有的作品目录');
      if (dir) await open(dir, baseName(dir));
    } finally {
      setPicking(false);
    }
  }, [open]);

  /**
   * 响应用户从菜单里点的「新建作品 / 打开作品」（`09` §4.4）。
   *
   * **两条入口，缺一不可**：
   * - **订阅**：用户本来就站在首页，命令直接到达；
   * - **取意图**：用户是在作品内点的菜单 —— 那条命令发出时本组件还不存在（见
   *   `lib/app-commands.ts` 的单槽说明），只能靠待处理意图把它带过来。
   *
   * 取意图只在挂载/重订阅时做一次；槽是"取走即清空"的，重复执行是安全的。
   *
   * 「新建」只需要把对话框打开 —— 光标会由对话框自己送进输入框（见 `NewWorkDialog`）。
   */
  useEffect(() => {
    const consume = (intent: EntryIntent): void => {
      if (intent === 'open') void openByPicker();
      else setCreating(true);
    };

    const pending = takePendingEntryIntent();
    if (pending !== null) consume(pending);

    return subscribeAppCommand((command) => {
      if (command === 'work:open') consume('open');
      else if (command === 'work:new') consume('new');
    });
  }, [openByPicker]);

  const view = shelfView(recent.items, recent.error);
  const busy = picking || openingPath !== null;

  return (
    <div className="entry">
      <div className="entry-inner stack">
        <header className="row entry-head">
          <div className="col">
            <h1 className="entry-title">砚台</h1>
            <span className="hint">本地优先的中文小说创作工作台</span>
          </div>
          <button type="button" onClick={onOpenDiagnostics}>
            诊断
          </button>
        </header>

        <section className="shelf-section">
          <div className="row entry-section-head">
            <h2 className="section-title">我的书架</h2>
            <div className="row">
              <button type="button" className="entry-new" onClick={() => setCreating(true)}>
                ＋ 新建作品
              </button>
              <button type="button" onClick={() => void openByPicker()} disabled={busy || !client}>
                {picking ? '选择中……' : '从文件夹打开'}
              </button>
            </div>
          </div>

          {/*
            正在打开：**一条附注，不是整屏替换**。书架照常可见，被点的那张卡自己
            显示「打开中……」（`shelfCardStatus` 的第一条分支），其余卡片暂时禁用
            —— 点一张没反应的卡比禁用更让人困惑。
          */}
          {openingTitle === null ? null : (
            <p className="shelf-opening" role="status">
              <span className="spinner" />
              正在打开《{openingTitle}》……
            </p>
          )}

          {/*
            错误与列表**可以同时存在**（先成功过一次、之后刷新失败），
            所以它是书架上方的一条附注，而不是把整块书架换掉 —— 理由见 `shelf-view.ts`。
            带「重试」是因为没有它的错误信息是一条死路。
          */}
          {view.error !== null ? (
            <p className="inline-error shelf-error">
              书架读取失败：{view.error}
              <button type="button" onClick={() => void recent.reload()}>
                重试
              </button>
            </p>
          ) : null}

          {view.list.kind === 'loading' ? <p className="hint">正在读取书架……</p> : null}

          {/*
            空态**要有一个按钮**：新建已经移进对话框，首页上没有它的话，
            新用户第一次打开只看到一句"书架还空着"，还得自己去右上角找入口。
            （这条与旧版相反：旧版新建表单常驻，空列表就什么都不显示。）
          */}
          {view.list.kind === 'empty' ? (
            <div className="shelf-empty">
              <p className="hint">书架还空着。正文会存在你自己选的目录里，不上传。</p>
              <button type="button" className="entry-new" onClick={() => setCreating(true)}>
                新建第一本书
              </button>
            </div>
          ) : null}

          {view.list.kind === 'ready' ? (
            <WorkShelf
              items={view.list.items}
              openingPath={openingPath}
              failure={failure}
              canOpen={client !== null && openingPath === null}
              onOpen={(rootPath, title) => void open(rootPath, title)}
              onForget={(rootPath) => void forget(rootPath)}
            />
          ) : null}
        </section>
      </div>

      {creating ? <NewWorkDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
