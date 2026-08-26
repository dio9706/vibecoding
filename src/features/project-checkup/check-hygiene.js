/**
 * 维度「仓库卫生」的 fs 层。刻意保持极薄：所有判断都在 check-hygiene.logic.js。
 *
 * 本模块是 async（要跑 git ls-files），而 runStaticCheckup 是同步的 ——
 * 所以 hygiene 和 tests 一样走异步回填（见 index.js 的 ASYNC_DIM_KEYS）。
 *
 * 第二参 `_opts` 与 RUNNERS 里其他 runner 的签名对齐；cacheEntry 给 null 表示不做指纹缓存
 *（git 查询本身很快，缓存反而会掩盖刚提交的变化）。
 */
import { gitTrackedFiles } from './git-tracked.js';
import { evaluateHygiene } from './check-hygiene.logic.js';

export async function checkHygiene(projectDir, _opts) {
  const trackedFiles = await gitTrackedFiles(projectDir);
  return { ...evaluateHygiene({ trackedFiles }), cacheEntry: null, fingerprint: null, cached: false };
}
