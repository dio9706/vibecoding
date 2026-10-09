/**
 * 内置 Skills 注册表（superpowers）。
 *
 * 资源布局：`assets/builtin/superpowers/`（安装时由 `scripts/superpowers-fetch.mjs` 拉取，gitignored；
 * 内容 = 上游 `.claude-plugin/` + 白名单 `skills/` + LICENSE + VERSION）。
 *
 * 装载：`run-claude.js` 在开关开启且**已安装**时，作为 Claude Agent SDK 的本地 plugin 注入
 * （`plugins: [{ type:'local', path, skipMcpDiscovery:true }]`，SDK 从插件里加载 skills）。
 *
 * per-skill 开关（Phase 3）：SDK 没有「按名字禁用」的选项——`Options.skills` 是**允许清单**，
 * 列出的同时会把项目/用户级 skills 一并隐藏。所以停用了部分技能时，本模块按需物化一份
 * 「启用视图」镜像目录（plugin.json + 启用技能），注入时才指向镜像；全量启用直接用原目录、零拷贝。
 *
 * fail-open：目录缺失（未拉取/离线）→ `installed=false`，设置页显示未安装、开关禁用，不注入、不报错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_SKILL_IDS, SUPERPOWERS_SKILL_IDS } from '../shared/builtin-ids.js';
import { bundledDir } from '../shared/bundled-paths.js';
import { appDataPath, isPackaged } from '../shared/app-paths.js';
import { logger } from '../shared/logger.js';

/** 核心技能白名单（与 fetch 脚本/设置页共用；id 列表的唯一来源在 shared/builtin-ids.js） */
export const SUPERPOWERS_SKILL_WHITELIST = SUPERPOWERS_SKILL_IDS;

export const BUILTIN_SKILLS = Object.freeze([
  {
    id: 'superpowers',
    label: 'Superpowers 技能包',
    desc: '头脑风暴 / 写计划 / 执行计划 / TDD / 系统化调试 / 完工前验证等工程技能（安装时从上游拉取）',
    installHint: 'npm run setup:superpowers',
  },
]);

export function superpowersDir() {
  return bundledDir('superpowers');
}

/** 已安装判定：plugin.json 与 skills/ 同时在位（只拷了一半不算装好）。exists 可注入便于测试。 */
export function isSuperpowersInstalled({ dir = superpowersDir(), exists = fs.existsSync } = {}) {
  return exists(`${dir}/.claude-plugin/plugin.json`) && exists(`${dir}/skills`);
}

/**
 * per-skill 过滤后物化的「启用视图」目录（仅存在停用技能时使用）。
 * 打包态安装目录只读（EPERM），镜像写 APP_DATA_DIR；开发态写 gitignored 的 assets/builtin 下，
 * 避免新增目录污染仓库根（app-paths 的教训：往只读目录写会被静默吞掉）。
 */
export function superpowersActiveDir() {
  return isPackaged() ? appDataPath('builtin-active', 'superpowers') : bundledDir('superpowers-active');
}

/** SKILL.md frontmatter 的 name/description（fail-open：读不到/没写都返回空串） */
function readSkillMeta(file, readFileFn) {
  let text = '';
  try {
    text = String(readFileFn(file, 'utf8') || '');
  } catch {
    return { name: '', desc: '' };
  }
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = block ? block[1] : '';
  const pick = (key) => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  return { name: pick('name'), desc: pick('description') };
}

/**
 * per-skill 清单（供 API/设置页）：白名单顺序 × 开关状态。
 * label 用 frontmatter name（缺失回退目录名）；desc 截断防超长（悬浮可看全文由 UI 负责）。
 */
export function listSuperpowersSkillItems({ dir = superpowersDir(), disabled = [], readFileFn = fs.readFileSync } = {}) {
  const off = new Set(SUPERPOWERS_SKILL_IDS.filter((id) => (Array.isArray(disabled) ? disabled : []).includes(id)));
  return SUPERPOWERS_SKILL_IDS.map((id) => {
    const meta = readSkillMeta(path.join(dir, 'skills', id, 'SKILL.md'), readFileFn);
    const desc = meta.desc.length > 160 ? meta.desc.slice(0, 160) + '…' : meta.desc;
    return { id, label: meta.name || id, desc, enabled: !off.has(id) };
  });
}

const ACTIVE_STAMP = '.active.json';

/**
 * 物化「启用视图」插件目录：停用了部分技能时生成只含启用技能的镜像（plugin.json + skills/<id>），
 * 返回应注入的目录；全量启用返回原目录（顺手清掉旧镜像）；全部停用返回 null（调用方不注入）。
 *
 * 幂等：镜像写 .active.json 记录（VERSION + 启用列表），命中即复用；上游重拉（VERSION 变）
 * 或开关变化时重建。fail-open：任何失败回退原目录（能力保留、停用暂不生效），只告警不阻塞 run。
 * 并发说明：多 run 同时物化可能互相覆盖镜像——最坏是某轮多/少一个技能，下一轮按戳自愈，故不加锁。
 */
export function materializeSkillPlugin({ id = 'superpowers', state = {}, installed = true, dir = superpowersDir(), activeDir = superpowersActiveDir() } = {}) {
  if (!installed) return null;
  if (id !== 'superpowers') return dir; // 其余内置技能包暂无 per-skill 维度
  const st = state?.[id] && typeof state[id] === 'object' ? state[id] : {};
  const disabled = SUPERPOWERS_SKILL_IDS.filter((s) => (Array.isArray(st.disabledSkills) ? st.disabledSkills : []).includes(s));
  const enabled = SUPERPOWERS_SKILL_IDS.filter((s) => !disabled.includes(s));

  if (!disabled.length) {
    try {
      fs.rmSync(activeDir, { recursive: true, force: true });
    } catch {
      /* 旧镜像清理失败可忽略：下面走原目录，不读镜像 */
    }
    return dir;
  }
  if (!enabled.length) return null;

  try {
    let version = '';
    try {
      version = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8');
    } catch {
      version = '';
    }
    const stamp = JSON.stringify({ version, skills: enabled });
    const stampFile = path.join(activeDir, ACTIVE_STAMP);
    try {
      if (fs.readFileSync(stampFile, 'utf8') === stamp) return activeDir;
    } catch {
      /* 无戳/读失败 → 重建 */
    }
    fs.rmSync(activeDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(activeDir, 'skills'), { recursive: true });
    fs.cpSync(path.join(dir, '.claude-plugin'), path.join(activeDir, '.claude-plugin'), { recursive: true });
    for (const name of enabled) {
      fs.cpSync(path.join(dir, 'skills', name), path.join(activeDir, 'skills', name), { recursive: true });
    }
    fs.writeFileSync(stampFile, stamp);
    logger.info('builtin-skills', '已物化启用视图技能包', { activeDir, enabled: enabled.length, disabled: disabled.length });
    return activeDir;
  } catch (e) {
    logger.warn('builtin-skills', '技能启用视图物化失败，回退原目录（停用暂不生效）', { err: e?.message || String(e) });
    return dir;
  }
}

/**
 * 内置 Skills 清单（供 API/UI）。
 * @param {{state?:object, installed?:boolean, listItems?:boolean, readFileFn?:Function}} [opts]
 *   installed 可注入（测试/预计算）；listItems=true 时附带 per-skill 清单（设置页用，含文件读取）。
 */
export function resolveBuiltinSkills({ state = {}, installed = isSuperpowersInstalled(), listItems = false, readFileFn } = {}) {
  return BUILTIN_SKILLS.map((def) => {
    const st = state?.[def.id] && typeof state[def.id] === 'object' ? state[def.id] : {};
    const disabledSkills = SUPERPOWERS_SKILL_IDS.filter((id) => (Array.isArray(st.disabledSkills) ? st.disabledSkills : []).includes(id));
    const entry = {
      id: def.id,
      label: def.label,
      desc: def.desc,
      installHint: def.installHint,
      enabled: typeof st.enabled === 'boolean' ? st.enabled : false,
      installed: !!installed,
      dir: superpowersDir(),
      disabledSkills,
    };
    if (listItems) {
      entry.skills = installed && def.id === 'superpowers'
        ? listSuperpowersSkillItems({ dir: entry.dir, disabled: disabledSkills, ...(readFileFn ? { readFileFn } : {}) })
        : [];
    }
    return entry;
  });
}

/** 供 Claude 路径注入的 plugins 数组：启用 + 已安装才产出；停用了部分技能时指向物化镜像 */
export function resolveSkillPlugins({ state, installed = isSuperpowersInstalled(), materializeFn = materializeSkillPlugin } = {}) {
  const out = [];
  for (const s of resolveBuiltinSkills({ state, installed })) {
    if (!s.enabled || !s.installed) continue;
    const dir = materializeFn({ id: s.id, state, installed: s.installed, dir: s.dir });
    if (!dir) continue; // 全部技能被停用：等同于不注入
    out.push({ type: 'local', path: dir, skipMcpDiscovery: true });
  }
  return out;
}

/** 注册表与 shared 白名单一致性（防两处漂移） */
export function skillRegistryIdsMatchWhitelist() {
  const ids = BUILTIN_SKILLS.map((d) => d.id).sort();
  return JSON.stringify(ids) === JSON.stringify([...BUILTIN_SKILL_IDS].sort());
}
