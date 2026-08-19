#!/usr/bin/env node
/**
 * 生成埋点索引快照：全集以生产库为准，中文名由 compass-agent 的字典提供。
 *
 * 为什么用快照而不是运行时直读对方仓库：那会让机器人硬依赖「两个仓库位于同一台机器的
 * 固定相对位置」，换台机器部署就崩。快照的代价是新增埋点后要手动同步一次，
 * 但失败模式温和得多 —— 「新事件查不到」而不是「整个功能挂掉」。
 *
 * 用法：node scripts/sync-event-dict.mjs [compass-agent 目录]
 *      未传参时取环境变量 COMPASS_AGENT_DIR
 *      数据库连接见 TRACKING_DB_* 环境变量（见下方 readDbConfig）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoDir = process.argv[2] || process.env.COMPASS_AGENT_DIR || '';
if (!repoDir) {
  console.error('❌ 请传入 compass-agent 目录，或设置环境变量 COMPASS_AGENT_DIR');
  process.exit(1);
}
const pyFile = path.join(repoDir, 'constants', 'user_path_mapping.py');
if (!fs.existsSync(pyFile)) {
  console.error(`❌ 找不到字典文件：${pyFile}`);
  process.exit(1);
}

const src = fs.readFileSync(pyFile, 'utf8');

/**
 * 从 Python 源码里抠出一个字面量 dict。
 * 只认 `KEY = {` 到最近一个行首 `}` 之间的内容，逐行匹配 "k": "v" ——
 * 不做通用 Python 解析：字典是纯字面量常量，正则足够且没有依赖。
 *
 * 值里允许出现 \" 转义：上游有 11 条文案形如 "点击\"期望开通\"按钮"，
 * 若值只写成 [^"]* 会在第一个转义引号处断开导致整行不匹配（实测漏 11 条）。
 * 因此值用「非引号非反斜杠 或 反斜杠+任意字符」的组合来吃掉转义序列，再统一还原。
 * 夹在条目之间的 `# 注释行` 天然不匹配，直接被跳过，不需要额外处理。
 */
function extractDict(name) {
  const start = src.indexOf(`${name} = {`);
  if (start < 0) throw new Error(`源码中找不到 ${name}`);
  const end = src.indexOf('\n}', start);
  if (end < 0) throw new Error(`${name} 未正常闭合`);
  const body = src.slice(start, end);
  // 原型链干净的空对象：神策自定义事件名无强约束，一旦出现名为 toString / constructor
  // 的埋点，普通 {} 的 labels[name] 会命中 Object.prototype 上的函数，
  // 落盘时被 JSON.stringify 丢弃 —— 下游拿到 named:true 但 label 字段整个消失。
  const out = Object.create(null);
  const re = /^\s*"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/gm;
  let m;
  while ((m = re.exec(body)) !== null) out[unescapePy(m[1])] = unescapePy(m[2]);
  // 正则解析是「匹配不上就跳过」的语义，没有失败信号 —— 上游改引号风格（black/ruff 的
  // 格式化偏好就能把 " 换成 '）、或改成计算式生成（dict(...)、循环拼装、**BASE_MAP），
  // 都会让这里悄悄归零，然后写出一份全员缺中文名的快照且退出码 0。
  // 拿一个远低于当前规模（事件 677 / 页面 82）的下限兜底：宁可炸，也不要静默降级。
  if (Object.keys(out).length < 50) {
    throw new Error(
      `${name} 只解析出 ${Object.keys(out).length} 条，疑似上游改了字典写法，请检查 ${pyFile}`,
    );
  }
  return out;
}

/** 还原 Python 字符串里的转义（这里只会出现 \" 和 \\，不必上完整的转义表）。 */
function unescapePy(s) {
  return s.replace(/\\(.)/g, '$1');
}

const eventLabels = extractDict('EVENT_NAME_MAP');
const pageLabels = extractDict('PAGE_NAME_MAP');

/**
 * 从生产埋点库拉近 N 天真实出现过的事件与页面。
 *
 * 为什么必须查库：user_path_mapping.py 是人工维护的中文名对照表，维护滞后于代码 ——
 * 实测近 30 天生产库 593 个事件里有 331 个（56%）字典查不到，且全是在跑的核心功能
 * （付费墙、过敏记录、语音）。页面更糟：字典 key 无前导斜杠、库内有，
 * 直接拿字典 key 去 IN 查是 0 命中且不报错，安静返回空表。
 * 所以：全集以库为准，字典只作中文名注解。
 */
const LIVE_WINDOW_DAYS = 90;

/** 页面路径归一化：去前导斜杠。字典 key 无斜杠、库内值有，不归一就永远对不上 */
const normPath = (p) => String(p || '').replace(/^\/+/, '');

/** 连接信息一律走环境变量：本脚本要入库，硬编码生产库密码等于把它提交到 git。 */
function readDbConfig() {
  const cfg = {
    host: process.env.TRACKING_DB_HOST,
    port: Number(process.env.TRACKING_DB_PORT || 3306),
    database: process.env.TRACKING_DB_NAME || 'compass_prod',
    user: process.env.TRACKING_DB_USER,
    password: process.env.TRACKING_DB_PASSWORD,
  };
  const missing = ['TRACKING_DB_HOST', 'TRACKING_DB_USER', 'TRACKING_DB_PASSWORD'].filter(
    (k) => !process.env[k],
  );
  if (missing.length) {
    console.error(`❌ 缺少数据库环境变量：${missing.join(', ')}`);
    console.error('   需要：TRACKING_DB_HOST / TRACKING_DB_USER / TRACKING_DB_PASSWORD');
    console.error('   可选：TRACKING_DB_PORT（默认 3306）/ TRACKING_DB_NAME（默认 compass_prod）');
    process.exit(1);
  }
  return cfg;
}

/**
 * 查库取真实清单。
 *
 * 为什么用 Python 子进程而不是 mysql2：项目当前没装 mysql2（package.json 与 node_modules
 * 均无），而这是个一次性的离线同步脚本 —— 为它给整个应用新增一个运行时依赖不划算；
 * 本机 Python 已有 pymysql，调子进程零成本。
 * 参数经 stdin 传入而非命令行：命令行参数在进程列表里对同机其他用户可见，会泄露生产库密码。
 */
function fetchLive(cfg, sinceMs) {
  const py = `
import json, sys
import pymysql

cfg = json.loads(sys.stdin.read())
EVENT_SQL = """
SELECT JSON_UNQUOTE(JSON_EXTRACT(properties,'$.event_name')) AS name, COUNT(*) AS cnt
  FROM statistics_data
 WHERE time > %s AND is_deleted = 0
   AND JSON_EXTRACT(properties,'$.event_name') IS NOT NULL
 GROUP BY name
"""
PAGE_SQL = """
SELECT JSON_UNQUOTE(JSON_EXTRACT(properties,'$."$url_path"')) AS path, COUNT(*) AS cnt
  FROM statistics_data
 WHERE time > %s AND is_deleted = 0 AND event = '$MPViewScreen'
   AND JSON_EXTRACT(properties,'$."$url_path"') IS NOT NULL
 GROUP BY path
"""
# 必须显式给超时：库在 VPN 外或被防火墙 DROP 包时，TCP 不会收到拒绝，
# 默认无超时的 connect/read 会让整个脚本永久挂起而不是报错。
conn = pymysql.connect(
    host=cfg["host"], port=cfg["port"], user=cfg["user"],
    password=cfg["password"], database=cfg["database"], charset="utf8mb4",
    connect_timeout=15, read_timeout=120,
)
try:
    with conn.cursor() as cur:
        cur.execute(EVENT_SQL, (cfg["since"],))
        events = [{"name": r[0], "count": int(r[1])} for r in cur.fetchall() if r[0]]
        cur.execute(PAGE_SQL, (cfg["since"],))
        pages = [{"path": r[0], "count": int(r[1])} for r in cur.fetchall() if r[0]]
finally:
    conn.close()
sys.stdout.write(json.dumps({"events": events, "pages": pages}))
`;
  const pyBin = process.env.PYTHON || 'python';
  let raw;
  try {
    raw = execFileSync(pyBin, ['-c', py], {
      input: JSON.stringify({ ...cfg, since: sinceMs }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, // 上千行 GROUP BY 结果，默认 1MB 不一定够
      // Node 侧再兜一层超时：Python 侧的 connect/read 超时管不到 DNS 解析卡死之类的情况。
      // 这脚本正常也要跑几十秒，用户分不出「慢」和「死」，必须有个确定的失败时刻。
      timeout: 180_000,
    });
  } catch (err) {
    console.error('❌ 查询生产埋点库失败');
    if (err.code === 'ENOENT') {
      // ENOENT 说明子进程压根没起来，此时 err.stderr 是 undefined ——
      // 不特判就只剩一行没有任何线索的报错，而 pymysql 缺失（走 stderr）反而信息完整。
      console.error(`   找不到 Python 可执行文件：${pyBin}`);
      console.error('   请确认 python 已在 PATH 中，或用 PYTHON 环境变量指定完整路径');
    } else if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') {
      console.error('   已超时（180 秒）。请确认本机能连到生产库（VPN / IP 白名单）。');
    } else if (err.stderr) {
      console.error(String(err.stderr).trim());
    }
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch {
    // 裸 JSON.parse 会把「stdout 混进了 warning / 调试 print / 库启动横幅」
    // 报成看不懂的 Unexpected token，把实际输出打出来才能一眼定位。
    console.error('❌ Python 输出不是合法 JSON（stdout 可能混入了警告或调试打印）');
    console.error(`   实际输出前 200 字符：${String(raw).slice(0, 200)}`);
    process.exit(1);
  }
}

/**
 * 双源合并：库内清单是事实（有哪些埋点、各多少次），字典是注解（叫什么中文名）。
 * 仅字典有的条目不丢弃而是标 live:false —— 已下线埋点的历史数据仍可查，
 * 丢掉会让「查去年那个功能」直接失败。
 */
function mergeEvents(live, labels) {
  const out = live.map(({ name, count }) => ({
    name,
    label: labels[name] || name, // 无中文名时退回标识本身，保证 label 永远可读
    count,
    live: true,
    named: !!labels[name],
  }));
  const seen = new Set(live.map((e) => e.name));
  for (const [name, label] of Object.entries(labels)) {
    if (seen.has(name)) continue;
    out.push({ name, label, count: 0, live: false, named: true });
  }
  return sortByCount(out, (x) => x.name);
}

/**
 * 页面同时保留两种形态：path 是库内原始值（带前导斜杠，SQL 必须用它），
 * key 是归一化形式（仅用于跟字典 key 比对）。混用两者正是「0 命中且不报错」的根因。
 */
function mergePages(live, labels) {
  // 字典侧 key 同样要归一化后再比对：上游今天 82 个 key 都不带前导斜杠，但这是个没人保证的
  // 约定，哪天有人写了 "/pages/x"，活跃条目会查不到而误标 named:false，
  // 字典独有分支还会推出 { path: '//pages/x', key: '/pages/x' } ——
  // 同时破坏「key 不带斜杠」的核心不变量并产生重复条目。归一化即消灭这个单向假设。
  const byKey = new Map(Object.entries(labels).map(([k, v]) => [normPath(k), v]));
  const out = live.map(({ path: p, count }) => {
    const key = normPath(p);
    const label = byKey.get(key);
    return { path: p, key, label: label || key, count, live: true, named: !!label };
  });
  const seen = new Set(out.map((x) => x.key));
  for (const [key, label] of byKey) {
    if (seen.has(key)) continue;
    // 库里没出现过，拿不到原始值，按库内惯例补上前导斜杠
    out.push({ path: `/${key}`, key, label, count: 0, live: false, named: true });
  }
  return sortByCount(out, (x) => x.key);
}

/**
 * 纯码点序比较。刻意不用 localeCompare：它不传 locale 时依赖运行时 ICU，
 * 在 small-icu / --with-intl=none 的 Node 上会退化成另一套序。这份快照是入库文件，
 * 且有 358 个 count:0 的事件全靠兜底排序定位 —— 换台机器同步就是几百行的假 diff。
 */
const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 按 count 降序；同 count 用标识兜底排序，避免快照入库后产生无意义的顺序抖动 diff */
function sortByCount(list, idOf) {
  return list.slice().sort((a, b) => b.count - a.count || cmpId(idOf(a), idOf(b)));
}

/**
 * 业务模块目录：按事件名下划线前缀聚类，供「理解阶段」做「口语 → 检索词」的锚点。
 *
 * 代表 label 取组内「有中文名且 count 最高」那条：模块主路径的调用量通常远高于枝节动作，
 * 所以它的中文名最接近用户口中这个模块的叫法。
 * （曾经用「取最短中文名」，理由是最短的最泛化 —— 实测被证伪：baby_food 选出「选择奶源」、
 * rash_calendar 选出「记录返回」，短名往往只是某个短促的叶子动作。）
 * 全组都没有中文名时 label 直接置为 prefix，诚实标注「这个模块没人维护中文名」，
 * 好过拿一个随机机器名冒充模块名去误导检索。
 */
function buildCategories(list) {
  const groups = new Map();
  for (const ev of list) {
    if (ev.name.startsWith('$')) continue; // 神策系统事件不参与业务分类
    const prefix = ev.name.split('_').slice(0, 2).join('_');
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(ev);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length >= 3) // 太零散的前缀不成一类，避免目录噪声
    .map(([prefix, items]) => {
      const top = items
        .filter((e) => e.named)
        .sort((a, b) => b.count - a.count || cmpId(a.name, b.name))[0];
      return { prefix, label: top ? top.label : prefix, count: items.length };
    })
    .sort((a, b) => b.count - a.count || cmpId(a.prefix, b.prefix));
}

let sourceCommit = '';
try {
  sourceCommit = execFileSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  // 光有 commit 号，在「字典改了但没提交」时是在说谎，而这个字段存在的唯一意义就是可追溯：
  // 标上 -dirty 才能让人知道快照对不回任何一个已提交版本。
  const dirty = execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], {
    encoding: 'utf8',
  }).trim();
  if (dirty) sourceCommit += '-dirty';
} catch {
  sourceCommit = 'unknown'; // 对方仓库不是 git 或 git 不可用都不该让同步失败
}

const sinceMs = Date.now() - LIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000; // 库内 time 是毫秒时间戳
const liveData = fetchLive(readDbConfig(), sinceMs);
const events = mergeEvents(liveData.events, eventLabels);
const pages = mergePages(liveData.pages, pageLabels);

// 聚类输入取合并后的数组：库内新埋点也要能进业务目录，否则目录还是只覆盖字典那一半。
// 但只喂活跃事件 —— 业务目录是给 LLM 做「当前」功能锚点用的，
// 混入已下线模块只是噪声（实测会凭空多出 21 个成员全已下线的分类）。
const liveEvents = events.filter((e) => e.live);

const snapshot = {
  syncedAt: new Date().toISOString(),
  sourceCommit,
  liveWindowDays: LIVE_WINDOW_DAYS,
  events,
  pages,
  categories: buildCategories(liveEvents),
};

const outDir = path.join(process.cwd(), 'data');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'event-dict.json');
// 先写临时文件再 rename：同目录 rename 是原子的，同步中途 Ctrl-C 至多留下一个 .tmp 残片，
// 而直接 writeFileSync 会把这份入库的快照截断成半份，且看不出坏了。
const tmpFile = `${outFile}.tmp`;
fs.writeFileSync(tmpFile, JSON.stringify(snapshot, null, 2), 'utf8');
fs.renameSync(tmpFile, outFile);

// 统计特意把「活跃/历史」「有名/缺名」拆开报：字典维护缺口要一眼可见，不然会被总数掩盖
const liveEv = events.filter((e) => e.live).length;
const namedEv = events.filter((e) => e.live && e.named).length;
const histEv = events.length - liveEv;
const livePg = pages.filter((p) => p.live).length;
const histPg = pages.length - livePg;

console.log(`✅ 埋点索引已生成：${outFile}`);
console.log(`   事件：库内活跃 ${liveEv} 个（其中 ${namedEv} 个有中文名，${liveEv - namedEv} 个缺）+ 历史 ${histEv} 个`);
console.log(`   页面：库内活跃 ${livePg} 个 + 历史 ${histPg} 个`);
console.log(`   来源 commit：${sourceCommit} · 窗口 ${LIVE_WINDOW_DAYS} 天`);
