/**
 * 内置工具集（builtin-tools.js）的离线测试。
 *
 * 每个用例在临时目录里造自己的工作区——这些工具会真的读写磁盘、真的起子进程，
 * 直接对仓库跑会把工作区搞脏（Write/Bash 用例尤其）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { streamTextToModelRun } from './openai-compat-model.js';
import {
  createBuiltinTools,
  buildAgentSystemPrompt,
  globToRegExp,
  normalizeTodos,
} from './builtin-tools.js';
import { resolveWorkspace } from '../shared/workspace-paths.js';

// ---------- 夹具 ----------

const tmpDirs = [];
after(() => {
  // 被杀的子进程在 Windows 上释放目录句柄有延迟：带重试清理（正常路径下第一次就成功）
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** 造一个用完即弃的工作区：文本/二进制/被忽略目录都有，覆盖各工具的边界 */
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-tools-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\nhello world\nsecond line');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'const answer = 42;\nexport default answer;');
  fs.writeFileSync(path.join(dir, 'src', 'util.js'), 'export function Hello() {\n  return "hello";\n}');
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from('hi\u0000hi', 'utf8')); // 含 NUL → 二进制
  return dir;
}

/** 跨平台路径比较：Windows 不区分大小写，且短路径/长路径要经 realpath 归一 */
function samePath(a, b) {
  const [ra, rb] = [fs.realpathSync(a), fs.realpathSync(b)];
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

// ---------- 纯函数 ----------

test('globToRegExp：** 跨目录、* 不跨 /、? 单字符、{a,b} 备选', () => {
  assert.ok(globToRegExp('**/*.js').test('app.js'), '**/ 应匹配零级目录');
  assert.ok(globToRegExp('**/*.js').test('src/app.js'));
  assert.ok(!globToRegExp('*.js').test('src/app.js'), '* 不应跨 /（与 Claude Glob 语义一致）');
  assert.ok(globToRegExp('src/*.js').test('src/app.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/deep/app.js'));
  assert.ok(globToRegExp('a?.md').test('a1.md'));
  assert.ok(!globToRegExp('a?.md').test('a12.md'));
  assert.ok(globToRegExp('*.{js,ts}').test('x.ts'));
  assert.ok(!globToRegExp('*.{js,ts}').test('x.py'));
  assert.ok(globToRegExp('src/**').test('src/a/b.js'));
  assert.ok(!globToRegExp('src/**').test('other/a.js'));
});

test('系统提示词：包含工作目录、操作系统与各工具名', () => {
  const ws = makeWorkspace();
  const prompt = buildAgentSystemPrompt({ cwd: ws, platform: 'darwin' });
  assert.ok(prompt.includes(ws), '应写明工作目录');
  assert.match(prompt, /macOS/);
  for (const name of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']) {
    assert.ok(prompt.includes(name), `应提到 ${name}`);
  }
});

test('系统提示词：带仓库地图时追加地图段；缺省不含', () => {
  const base = buildAgentSystemPrompt({ cwd: 'C:\\proj', platform: 'win32' });
  assert.ok(!base.includes('仓库地图'));
  const withMap = buildAgentSystemPrompt({
    cwd: 'C:\\proj',
    platform: 'win32',
    repoMap: 'src/a.js  (3)\n│ export function a()',
  });
  assert.match(withMap, /## 仓库地图（自动生成：文件 \+ 关键导出\/类方法符号，按引用重要度排序）/);
  assert.match(withMap, /先用它定位线索/);
  assert.match(withMap, /RepoMap 工具/, '地图段要告诉模型可以用 RepoMap 工具再查');
  assert.match(withMap, /src\/a\.js {2}\(3\)/);
});

test('createBuiltinTools：七个工具定义（zod inputSchema）齐备（含 TodoWrite）', () => {
  const { toolDefs, executeTool, workspace } = createBuiltinTools({ cwd: 'some-dir' });
  assert.deepEqual(Object.keys(toolDefs).sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'TodoWrite', 'Write']);
  for (const def of Object.values(toolDefs)) {
    assert.equal(typeof def.description, 'string');
    assert.ok(def.inputSchema, 'inputSchema 必须是 zod schema');
  }
  assert.equal(typeof executeTool, 'function');
  assert.equal(workspace, resolveWorkspace('some-dir'));
});

test('RepoMap：注入 loadRepoMap 才装配；透传 query/refresh；空图与失败有明确文案', async () => {
  const plain = createBuiltinTools({ cwd: 'some-dir' });
  assert.equal(Object.hasOwn(plain.toolDefs, 'RepoMap'), false, '未注入时不装配');

  const calls = [];
  const withTool = createBuiltinTools({
    cwd: 'some-dir',
    loadRepoMap: async (input) => {
      calls.push(input);
      return 'src/a.js  (3)\n│ export function a()';
    },
  });
  assert.ok(withTool.toolDefs.RepoMap, '注入后装配 RepoMap');
  assert.equal(typeof withTool.toolDefs.RepoMap.inputSchema, 'object');
  const out = await withTool.executeTool('RepoMap', { query: 'auth token', refresh: true });
  assert.deepEqual(calls, [{ query: 'auth token', refresh: true }]);
  assert.match(out, /src\/a\.js/);

  const empty = createBuiltinTools({ cwd: 'some-dir', loadRepoMap: async () => '' });
  assert.match(await empty.executeTool('RepoMap', {}), /没有可用的仓库地图/);

  const boom = createBuiltinTools({ cwd: 'some-dir', loadRepoMap: async () => { throw new Error('boom'); } });
  assert.match(await boom.executeTool('RepoMap', {}), /仓库地图加载失败：boom/);
});

// ---------- 文件工具 ----------

test('Read：文件带行号、offset/limit、目录列表、二进制与缺失报错', async () => {
  const { executeTool } = createBuiltinTools({ cwd: makeWorkspace() });
  assert.equal(await executeTool('Read', { file_path: 'README.md' }), '1: # Demo\n2: hello world\n3: second line');
  assert.equal(
    await executeTool('Read', { file_path: 'README.md', offset: 2, limit: 1 }),
    '2: hello world\n…（共 3 行，已显示到第 2 行；可用 offset=3 继续读）',
  );
  const dir = await executeTool('Read', { file_path: 'src' });
  assert.match(dir, /^目录 src：/);
  assert.match(dir, /app\.js/);
  assert.match(dir, /util\.js/);
  await assert.rejects(() => executeTool('Read', { file_path: 'bin.dat' }), /二进制/);
  await assert.rejects(() => executeTool('Read', { file_path: 'nope.txt' }), /不存在/);
});

test('Write：自动建父目录、内容落盘', async () => {
  const ws = makeWorkspace();
  const { executeTool } = createBuiltinTools({ cwd: ws });
  const msg = await executeTool('Write', { file_path: 'deep/new/file.txt', content: 'hello\nworld' });
  assert.match(msg, /已写入 deep\/new\/file\.txt/);
  assert.equal(fs.readFileSync(path.join(ws, 'deep', 'new', 'file.txt'), 'utf8'), 'hello\nworld');
});

test('Edit：唯一替换、无匹配/多匹配/空旧串/新旧相同报错、replace_all', async () => {
  const ws = makeWorkspace();
  const { executeTool } = createBuiltinTools({ cwd: ws });
  const app = path.join(ws, 'src', 'app.js');

  assert.match(await executeTool('Edit', { file_path: 'src/app.js', old_string: '42', new_string: '43' }), /替换 1 处/);
  assert.equal(fs.readFileSync(app, 'utf8'), 'const answer = 43;\nexport default answer;');

  await assert.rejects(() => executeTool('Edit', { file_path: 'src/app.js', old_string: 'not-there', new_string: 'x' }), /未在/);
  // 此时 'answer' 在文件里有两处：不给 replace_all 应拒绝，防止误伤
  await assert.rejects(() => executeTool('Edit', { file_path: 'src/app.js', old_string: 'answer', new_string: 'value' }), /匹配到 2 处/);
  assert.match(
    await executeTool('Edit', { file_path: 'src/app.js', old_string: 'answer', new_string: 'value', replace_all: true }),
    /替换 2 处/,
  );
  assert.equal(fs.readFileSync(app, 'utf8'), 'const value = 43;\nexport default value;');

  await assert.rejects(() => executeTool('Edit', { file_path: 'src/app.js', old_string: '', new_string: 'x' }), /不能为空/);
  await assert.rejects(() => executeTool('Edit', { file_path: 'src/app.js', old_string: 'x', new_string: 'x' }), /相同/);
});

test('Glob：** 匹配、默认排除 .git/node_modules、limit 截断', async () => {
  const { executeTool } = createBuiltinTools({ cwd: makeWorkspace() });
  assert.deepEqual((await executeTool('Glob', { pattern: '**/*.js' })).split('\n'), ['src/app.js', 'src/util.js']);
  assert.equal(await executeTool('Glob', { pattern: '*.md' }), 'README.md');
  assert.match(await executeTool('Glob', { pattern: '**/*.py' }), /没有匹配/);
  assert.match(await executeTool('Glob', { pattern: '**/*.js', limit: 1 }), /已截断到 1 条/);
});

test('Grep：文件:行号输出、include、literal、智能大小写、跳过二进制', async () => {
  const { executeTool } = createBuiltinTools({ cwd: makeWorkspace() });
  assert.deepEqual((await executeTool('Grep', { pattern: 'hello' })).split('\n'), [
    'README.md:2: hello world',
    'src/util.js:1: export function Hello() {',
    'src/util.js:2: return "hello";',
    '…（另有 1 个二进制或超过 2MiB 的文件未搜索）',
  ]);
  assert.match(await executeTool('Grep', { pattern: 'Hello', case_sensitive: true }), /^src\/util\.js:1: /);
  assert.deepEqual((await executeTool('Grep', { pattern: 'hello', include: '*.md' })).split('\n'), ['README.md:2: hello world']);
  assert.match(await executeTool('Grep', { pattern: 'answer = 4', literal: true }), /src\/app\.js:1: /);
  // 'hi' 只存在于二进制文件里：结果应为空，且明确提示有文件被跳过（不能假装搜全了）
  const empty = await executeTool('Grep', { pattern: 'hi' });
  assert.match(empty, /没有匹配/);
  assert.match(empty, /跳过 1 个二进制/);
});

// ---------- Bash ----------

/** 往工作区写一个脚本，用 `node <script>` 起子进程：避免各平台 shell 引号转义的差异 */
function writeScript(ws, name, body) {
  fs.writeFileSync(path.join(ws, name), body);
}

test('Bash：命令在工作目录执行、stdout 收集', async () => {
  const ws = makeWorkspace();
  writeScript(ws, 'hello.js', 'console.log(process.cwd());\nconsole.log("hi");\n');
  const out = (await createBuiltinTools({ cwd: ws }).executeTool('Bash', { command: 'node hello.js' })).trim();
  const [cwdLine, hiLine] = out.split(/\r?\n/);
  assert.ok(samePath(cwdLine, ws), `cwd 应为工作区：${cwdLine} vs ${ws}`);
  assert.equal(hiLine, 'hi');
});

test('Bash：非零退出码与 stderr 如实回报', async () => {
  const ws = makeWorkspace();
  writeScript(ws, 'fail.js', 'console.error("boom");\nprocess.exit(3);\n');
  const out = await createBuiltinTools({ cwd: ws }).executeTool('Bash', { command: 'node fail.js' });
  assert.match(out, /退出码 3/);
  assert.match(out, /\[stderr\]/);
  assert.match(out, /boom/);
});

test('Bash：abort 时杀进程并如实回报，不等命令自然结束', async () => {
  const ws = makeWorkspace();
  writeScript(ws, 'slow.js', "setTimeout(() => console.log('late'), 5000);\n");
  const ac = new AbortController();
  const { executeTool } = createBuiltinTools({ cwd: ws, signal: ac.signal });
  const t0 = Date.now();
  const p = executeTool('Bash', { command: 'node slow.js' });
  setTimeout(() => ac.abort(), 200);
  const out = await p;
  assert.match(out, /已被用户停止/);
  assert.ok(Date.now() - t0 < 4500, 'abort 后不应等命令跑完');
});

test('Bash：超时强杀', async () => {
  const ws = makeWorkspace();
  writeScript(ws, 'hang.js', "setTimeout(() => console.log('late'), 5000);\n");
  const out = await createBuiltinTools({ cwd: ws }).executeTool('Bash', { command: 'node hang.js', timeout: 300 });
  assert.match(out, /超时/);
});

test('Bash：执行后端 unavailable 时明确拒绝（T6 fail-closed，不静默退回本地执行）', async () => {
  const ws = makeWorkspace();
  writeScript(ws, 'hello.js', 'console.log("should-not-run");\n');
  const out = await createBuiltinTools({
    cwd: ws,
    bashBackend: { kind: 'unavailable', reason: '未检测到可用的 docker/podman（已配置容器后端）' },
  }).executeTool('Bash', { command: 'node hello.js' });
  assert.match(out, /Bash 当前不可用：未检测到可用的 docker\/podman/);
  assert.ok(!out.includes('should-not-run'), '不得偷偷在本地执行');
});

// ---------- TodoWrite ----------

test('TodoWrite：normalizeTodos 归一（白名单 status/去空/剪枝）；执行器返回确认文案', async () => {
  assert.deepEqual(
    normalizeTodos([
      { content: ' 修登录 ', status: 'in_progress' },
      { content: '', status: 'pending' }, // 空内容剔除
      { content: '写测试', status: 'weird' }, // 非法 status 回落 pending
      { content: '带进行时描述', status: 'pending', activeForm: ' 正在写 ' },
    ]),
    [
      { content: '修登录', status: 'in_progress' },
      { content: '写测试', status: 'pending' },
      { content: '带进行时描述', status: 'pending', activeForm: '正在写' },
    ],
  );
  assert.deepEqual(normalizeTodos(null), []);
  assert.equal(normalizeTodos(Array.from({ length: 60 }, (_, i) => ({ content: 't' + i, status: 'pending' }))).length, 50, '剪枝到 50 项');

  const out = await createBuiltinTools({ cwd: 'some-dir' }).executeTool('TodoWrite', {
    todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }],
  });
  assert.match(out, /清单已更新：2 项（完成 1，进行中 1）/);
});

// ---------- AI SDK 集成冒烟 ----------

test('冒烟：zod 工具定义经 streamText 转成模型可见的 JSON Schema', async () => {
  const { toolDefs } = createBuiltinTools({ cwd: makeWorkspace() });
  let seenTools = null;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      seenTools = options.tools;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'ok' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        }),
      };
    },
  });
  const { stream, finished } = streamTextToModelRun(model, toolDefs)([{ role: 'user', content: 'hi' }]);
  for await (const _ of stream) {
    // 抽干即可，本用例只关心请求侧的工具定义
  }
  await finished;

  assert.deepEqual(
    seenTools.map((t) => t.name).sort(),
    ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'TodoWrite', 'Write'],
  );
  const read = seenTools.find((t) => t.name === 'Read');
  assert.equal(read.type, 'function');
  assert.equal(read.inputSchema.type, 'object');
  assert.ok(read.inputSchema.properties.file_path, 'file_path 应出现在 JSON Schema 里');
  assert.deepEqual(read.inputSchema.required, ['file_path']);
});
