# public/vendor 版本清单

> 本文件由 `node scripts/sync-vendor.mjs` 自动生成，**请勿手工编辑**。
> 版本由 package.json 锁定；升级请改 package.json 后重跑同步脚本。

| 文件 | npm 包 | 版本 | 包内来源 |
|---|---|---|---|
| `purify.min.js` | dompurify | 3.4.14 | `dist/purify.min.js` |
| `marked.umd.js` | marked | 18.0.11 | `lib/marked.umd.js` |
| `anime.umd.min.js` | animejs | 4.5.0 | `dist/bundles/anime.umd.min.js` |

引用位置：`public/index.html`（script 标签）、`public/js/util.render.test.js`（渲染测试直接加载）。
