/**
 * 维度③的文件系统层：读 .claude/rules/ 目录，喂给 logic 层判定。
 * 这一层刻意保持极薄且不含判断逻辑，所有可测的部分都在 check-rules.logic.js。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.logic.js';
import { evaluateRules } from './check-rules.logic.js';

export function checkRules(projectDir) {
  const rulesDir = path.join(projectDir, '.claude', 'rules');
  if (!fs.existsSync(rulesDir)) return evaluateRules(null);

  const files = [];
  for (const name of fs.readdirSync(rulesDir)) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(rulesDir, name);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    const raw = fs.readFileSync(full, 'utf8');
    const fm = parseFrontmatter(raw);
    // hasFrontmatter 要一并传下去：logic 层靠它区分「确实没写 paths」和
    // 「有 frontmatter 但解析不出 paths」，后者会拒绝自动降级（破坏性操作）
    files.push({
      name,
      sizeBytes: st.size,
      paths: fm.paths,
      hasFrontmatter: fm.hasFrontmatter,
    });
  }

  return evaluateRules(files);
}
