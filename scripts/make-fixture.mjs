#!/usr/bin/env node
/**
 * 造一份性能基线用的测试作品（docs/10 §7.2）。
 *
 * ## 为什么要一个脚本而不是手工建
 *
 * M1 优化前后要对比"打开 10 万字、切章、保存"的耗时，对比的前提是**同一份数据**。
 * 脚本生成保证：同样的参数出**逐字节一致**的作品（段落从固定语料轮转，带标题/加粗/
 * 斜体/引用/分隔线，覆盖白名单全部语法），M1 任何时候重跑都能拿到同一基线。
 *
 * 为了"逐字节一致"成立，时间戳**刻意是冻结的常量**（见 `FIXTURE_TS`）：
 * 用 `new Date()` 的话每次重跑都不同，"同一份数据"就只剩"内容差不多"。
 *
 * ## 为什么 meta.json 里**不写** `wordCountCache`（`docs/13` M31）
 *
 * 原来的写法是用一句正则剥掉语法字符后取 `.length` —— 那与 sidecar 的口径
 * （`domain/wordcount.py`：按码点、排 ECMAScript 空白、再排 Unicode `P`/`S`）
 * **不等价**，全角标点、emoji、UTF-16 代理对全都会算错。
 * 而 `_read_title_and_wordcount` 只信缓存、不校验：`word_count_cache is not None` 时
 * 直接返回，于是**一个算错的数会被永久信任**（这正是 M1"字数永久陈旧"的加剧项）。
 *
 * 修法不是"在 JS 里再抄一份口径"—— 那就成了第三份实现，漂移是迟早的事。
 * 留空即可：`ChapterMeta.word_count_cache` 默认 `None`，sidecar 首次扫描会
 * 自己精确算一遍并写回。**基线用的是 sidecar 自己的数**，不可能不一致。
 *
 * 副作用要认：首次 `list_chapters` 会整文件读一遍（冷扫描）。这恰恰是"打开一部作品"
 * 的真实路径，对基线来说比"预先塞一个热缓存"更诚实。
 *
 * 目录结构与 sidecar 的 `domain/paths.py` 严格一致：
 *   <root>/<题目>/
 *     work.json
 *     设定.md
 *     outline/卷纲/
 *     manuscript/001-第一章/chapter.md + meta.json
 *     codex/  snippets/  styles/  .inkstone/{logs,backups}
 *
 * 用法：
 *   node scripts/make-fixture.mjs --chars 100000 --chapters 100
 *   node scripts/make-fixture.mjs --chars 100000 --chapters 100 --out D:/tmp
 *
 * 产物在临时目录（不打进仓库），路径会打印出来。
 */

import fs from 'node:fs';
import path from 'node:path';

// ---- 参数 ----
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const TOTAL_CHARS = Number(argValue('--chars') ?? 100_000);
const CHAPTERS = Number(argValue('--chapters') ?? 100);
const OUT_ROOT =
  argValue('--out') ?? path.join(process.env.TEMP ?? '/tmp', `inkstone-fixture-${Date.now()}`);

/**
 * 冻结的时间戳。
 *
 * **必须是常量**：docstring 承诺"逐字节一致"，而 `createdAt` / `updatedAt` 一旦用
 * `new Date()`，两次运行的文件就不相同了（`docs/13` M31 的后半句就是这个）。
 * 冻结成常量还有个附带好处：产物能用 `diff` 比对，改动一眼可见。
 */
const FIXTURE_TS = '2026-01-01T00:00:00.000Z';

if (
  !Number.isFinite(TOTAL_CHARS) ||
  TOTAL_CHARS <= 0 ||
  !Number.isFinite(CHAPTERS) ||
  CHAPTERS <= 0
) {
  process.stderr.write(
    '用法: node scripts/make-fixture.mjs --chars 100000 --chapters 100 [--out dir]\n',
  );
  process.exit(2);
}

const WORK_TITLE = '云京 baseline';

// ---- 固定语料（含全部白名单语法；地名只用「云京」） ----
const PARAGRAPHS = [
  '云京的冬夜来得早，暮色像砚池里化开的墨，一层层漫过坊市的檐角。',
  '他推开门，风从巷口灌进来，把案上未干的稿纸吹得哗啦作响。',
  '**灯还亮着。**她在灯下抄书，笔锋沉稳，一字一句都不肯潦草。',
  '巷子深处传来打更声，*三更了*，茶棚里只剩最后一位客人。',
  '> 老人说，云京的雪要落三天，落满三天，河就会封。',
  '他把披风裹紧了些，沿着青石板路往渡口走。',
  '渡口的灯笼在风里晃，摆船的人还没来。',
  '---',
  '她合上书，望向窗外。雪确实下起来了，比夜里第一阵更密。',
  '「来了？」他问。',
  '「来了。」她把灯芯挑亮了一点，「坐吧，茶刚好。」',
  '两人在灯下对坐，谁也没有先开口。雪落在瓦上，几乎没有声音。',
];

// ---- 生成 ----
function chapterMarkdown(order, chars) {
  const parts = [`# 第${order}章`];
  let count = 0;
  let i = 0;
  while (count < chars) {
    const p = PARAGRAPHS[i % PARAGRAPHS.length];
    parts.push('', p);
    // 只用来决定"够不够长了"和最后打印一句"约 N 字"。
    // **不**写进 meta.json（口径会被 sidecar 永久信任，见文件头 M31 那段）。
    count += p.replace(/[*>#\-—\s]/g, '').length;
    i += 1;
  }
  return { md: parts.join('\n') + '\n', chars: count };
}

const root = path.join(OUT_ROOT, WORK_TITLE);
for (const dir of [
  root,
  path.join(root, 'outline', '卷纲'),
  path.join(root, 'manuscript'),
  path.join(root, 'codex'),
  path.join(root, 'snippets'),
  path.join(root, 'styles'),
  path.join(root, '.inkstone', 'logs'),
  path.join(root, '.inkstone', 'backups'),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const perChapter = Math.max(200, Math.ceil(TOTAL_CHARS / CHAPTERS));

fs.writeFileSync(
  path.join(root, 'work.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: 'w_fixture_baseline',
      title: WORK_TITLE,
      author: 'baseline',
      genre: '',
      tags: [],
      wordGoal: 0,
      dailyGoal: 4000,
      createdAt: FIXTURE_TS,
      updatedAt: FIXTURE_TS,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
fs.writeFileSync(
  path.join(root, '设定.md'),
  '# 设定\n\n这是性能基线用作品（make-fixture.mjs 生成）。故事发生在云京。\n',
  'utf8',
);

let total = 0;
for (let order = 1; order <= CHAPTERS; order += 1) {
  const slug = `第${order}章`;
  const dir = path.join(root, 'manuscript', `${String(order).padStart(3, '0')}-${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  const { md, chars } = chapterMarkdown(order, perChapter);
  fs.writeFileSync(path.join(dir, 'chapter.md'), md, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: `ch_fixture_${String(order).padStart(4, '0')}`,
        order,
        status: 'draft',
        pov: null,
        // **刻意不写 wordCountCache**：口径不同会算错，而 sidecar 只信不校验
        // （详见文件头 M31 那段）。留空 → sidecar 首次扫描精确算一遍并写回。
        createdAt: FIXTURE_TS,
        updatedAt: FIXTURE_TS,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  total += chars;
}

process.stdout.write(
  [
    `[make-fixture] 完成：${CHAPTERS} 章 / 约 ${total} 字（这个数是本脚本的粗略估计，`,
    '  精确字数由 sidecar 首次打开时写入 meta.json）',
    `  作品根目录：${root}`,
    '  （用砚台打开这个目录即可做性能基线；M1 对比时务必重跑本脚本而不是复用旧目录）',
    '',
  ].join('\n'),
);
