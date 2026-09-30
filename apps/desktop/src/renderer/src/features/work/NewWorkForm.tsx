import { useState } from 'react';
import type { FormEvent, Ref } from 'react';
import { describeApiError } from '../../lib/api';
import { useWorkSession } from '../session/WorkSessionProvider';
import { pickDirectory, useCreateWork } from './use-work-entry';

export interface NewWorkFormProps {
  /**
   * 标题输入框的节点。交给上层，是为了让菜单的「新建作品」能把光标送进表单 ——
   * 只把页面切过来、光标还在别处，用户还是得自己点一下。
   */
  titleInputRef?: Ref<HTMLInputElement>;
}

/**
 * 新建作品表单（04 文档 §5.2）。
 *
 * 失败一律**内联报错并保留已填内容**：让用户重新填一遍标题和目录，比不报错更糟。
 * 提交中禁用按钮（本地 `submitting`），不依赖后端去重。
 */
export function NewWorkForm({ titleInputRef }: NewWorkFormProps) {
  const { client } = useWorkSession();
  const createWork = useCreateWork();

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [genre, setGenre] = useState('');
  const [wordGoalText, setWordGoalText] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // client 在 HEALTHY 之后还要异步取一次连接信息，这期间它会短暂为 null
  const ready = client !== null;

  const chooseDir = async () => {
    setError(null);
    try {
      const dir = await pickDirectory('选择作品存放的父目录');
      if (dir) setParentDir(dir);
    } catch (err) {
      setError(describeApiError(err));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    const trimmedTitle = title.trim();
    if (trimmedTitle === '') {
      setError('请填写作品标题。');
      return;
    }
    if (!parentDir) {
      setError('请先选择作品存放的目录。');
      return;
    }

    let wordGoal: number | undefined;
    if (wordGoalText.trim() !== '') {
      const parsed = Number(wordGoalText);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError('字数目标要填正整数，或者留空。');
        return;
      }
      wordGoal = parsed;
    }

    setSubmitting(true);
    setError(null);
    try {
      await createWork(parentDir, {
        title: trimmedTitle,
        author: author.trim() || undefined,
        genre: genre.trim() || undefined,
        wordGoal,
      });
      // 成功后会话切到 ready，本组件随之卸载，无需清理
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor="new-work-title">标题</label>
        <input
          id="new-work-title"
          ref={titleInputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="必填"
          autoComplete="off"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="new-work-author">作者</label>
          <input
            id="new-work-author"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="可留空"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="new-work-genre">题材</label>
          <input
            id="new-work-genre"
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            placeholder="可留空"
            autoComplete="off"
          />
        </div>
        <div className="field field-narrow">
          <label htmlFor="new-work-goal">字数目标</label>
          <input
            id="new-work-goal"
            value={wordGoalText}
            onChange={(e) => setWordGoalText(e.target.value)}
            placeholder="可留空"
            inputMode="numeric"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="new-work-dir">存放目录</label>
        <div className="row">
          <button
            id="new-work-dir"
            type="button"
            onClick={() => void chooseDir()}
            disabled={submitting}
          >
            选择目录
          </button>
          <span className="path-text" title={parentDir ?? undefined}>
            {parentDir ?? '尚未选择'}
          </span>
        </div>
      </div>

      {error ? <p className="inline-error">{error}</p> : null}

      <div className="actions">
        <button type="submit" disabled={submitting || !ready}>
          {submitting ? '正在创建……' : ready ? '创建作品' : '本地服务连接中……'}
        </button>
        <span className="hint">会在所选目录下新建一个作品文件夹，并自动创建「第一章」。</span>
      </div>
    </form>
  );
}
