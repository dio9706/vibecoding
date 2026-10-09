/**
 * openai 检查点续跑 e2e（T2-P3）：真 web 进程 + 本地假 OpenAI 兼容端点。
 *
 * 守的不变量 ——
 * ① 崩溃遗留的 run-index 孤儿 → 启动对账自动续跑（不需要用户重发消息）；
 * ② 悬空 tool-call 的修复必须**落盘**（合成「未执行」结果进 conv-messages，否则新消息接在非法序列后）；
 * ③ 续跑消息序列对真实 ai-sdk 适配器合法（system 拆 instructions 的回归锚点：system 混在
 *    messages 里时真调用必抛 InvalidPromptError——2026-10-08 实锤，单测用 mock 漏网，此处用真 HTTP 兜底）；
 * ④ 收尾后 run-index 摘除、journal 落 settled(done)；
 * ⑤ 全程无「继续」提示词（历史末尾即接续点）。
 *
 * 自起独立 web 服务器（mkdtemp 临时 APP_DATA_DIR + 内核分配的空闲端口），**绝不触碰 pm2 的
 * 3000 端口与仓库根数据目录**（同 e2e-conv-notify.mjs / e2e-req-review.mjs 范式）。
 * 运行：node tests/e2e-openai-resume.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL: ' + msg);
};
const step = (msg) => console.log('  ✔ ' + msg);

/** 找一个当前空闲端口：临时监听 0 号端口由内核分配后立即关闭，复用其号码给待起的子进程。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForReady(baseUrl, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(baseUrl + '/api/ping');
      if (r.ok) return true;
    } catch {
      /* 还没监听上，继续等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const port = Number(process.env.E2E_PORT) || (await findFreePort());
const BASE = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-resume-e2e-'));

// ---- 假 OpenAI 兼容端点（标准 chat.completions SSE）----
let modelRequests = 0;
const fakeModel = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    modelRequests++;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // ③ 的锚点：system 必须以 instructions（即消息序列里的 system 角色）到达，而非混在 messages 触发 400/抛错
      const parsed = JSON.parse(body || '{}');
      const roles = (parsed.messages || []).map((m) => m.role);
      console.log('  模型收到消息序列: ' + roles.join(' > '));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: '续跑成功' }, finish_reason: null }],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }) +
          '\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => fakeModel.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${fakeModel.address().port}/v1`;

// ---- 播种（必须在 server 启动前）：凭证 + 半程检查点 + 崩溃遗留索引 ----
fs.writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify(
    {
      tokens: [
        {
          id: 'tk_e2e',
          providerId: 'openai-compat',
          label: 'e2e 假模型',
          token: 'sk-e2e-not-real',
          baseURL,
          model: 'test-model',
          status: 'healthy',
        },
      ],
      builtinMcp: { context7: { enabled: false } }, // 不拉 npx 子进程
      repoMap: { enabled: false }, // 不扫仓库
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(dataDir, 'conv-messages.json'),
  JSON.stringify({
    c_e2e: [
      { role: 'user', content: '读一下文件然后告诉我' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'Read', input: { file_path: 'x.txt' } }],
      },
    ],
  }),
);
fs.writeFileSync(
  path.join(dataDir, 'run-index.json'),
  JSON.stringify([
    {
      runId: 'run_dead_e2e',
      convId: 'c_e2e',
      provider: 'openai-compat',
      session_id: null,
      cwd: REPO_ROOT,
      model: 'test-model',
      credId: 'tk_e2e',
      requestId: null,
      prompt: '读一下文件然后告诉我',
      resumeAttempt: 0,
      pid: 999999, // 必死 pid：对账按孤儿回收
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      lastSeq: 1,
    },
  ]),
);

let child = null;
try {
  child = spawn(process.execPath, ['src/entrypoints/web/server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), APP_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', (d) => (serverOutput += d));
  child.stderr.on('data', (d) => (serverOutput += d));

  if (!(await waitForReady(BASE))) throw new Error('自起的 web 服务器未在 20s 内就绪，输出：\n' + serverOutput);
  step('web 已就绪（对账在 listen 回调内已调度续跑）');

  // 等恢复完成（3s 调度延迟 + 模型往返）
  const deadline = Date.now() + 15000;
  let msgs = [];
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'conv-messages.json'), 'utf8')).c_e2e;
      // v2 形状（T7）：{v:2, messages, summary}；v1 旧数组兜底
      msgs = Array.isArray(raw) ? raw : raw?.messages || [];
    } catch {
      msgs = [];
    }
    if (msgs.length >= 4 && msgs[msgs.length - 1].role === 'assistant') break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // ② 修复落盘
  const synth = msgs.find((m) => m.role === 'tool' && JSON.stringify(m).includes('未执行'));
  if (!synth) fail('悬空 tool-call 未修复落盘：' + JSON.stringify(msgs.map((m) => m.role)));
  else step('悬空 tool-call 已按「未执行」补记并落盘');

  // ③⑤ 真适配器往返 + 不追加「继续」：模型回复落盘，且发给模型的序列以修复后的现场继续
  const last = msgs[msgs.length - 1];
  if (!(last && last.role === 'assistant' && JSON.stringify(last).includes('续跑成功'))) {
    fail('模型续跑回复未落盘：' + JSON.stringify(last));
  } else {
    step('模型续跑回复已落盘：' + last.content[0].text);
  }
  if (msgs.some((m) => m.role === 'user' && JSON.stringify(m).includes('继续'))) {
    fail('检查点续跑不得追加「继续」提示词');
  }
  if (modelRequests !== 1) fail(`模型应被调用恰好一次，实际 ${modelRequests} 次`);

  // ④ 收尾清理
  const journal = fs
    .readFileSync(path.join(dataDir, 'run-journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const types = journal.map((e) => e.type);
  for (const t of ['resumed', 'submitted', 'started', 'settled']) {
    if (!types.includes(t)) fail(`journal 缺事件 ${t}（实际 ${types.join(',')}）`);
  }
  const settled = journal.find((e) => e.type === 'settled');
  if (!settled || settled.data.status !== 'done') fail('settled 非 done：' + JSON.stringify(settled));
  else step('journal：resumed → submitted → started → settled(done) 完整');

  const left = JSON.parse(fs.readFileSync(path.join(dataDir, 'run-index.json'), 'utf8'));
  if (left.length) fail('run-index 未清空：' + JSON.stringify(left));
  else step('run-index 已清空');

  console.log(
    failures
      ? `E2E FAIL（${failures} 处）`
      : 'E2E PASS：openai 检查点续跑全链（悬空修复落盘 → 真适配器往返 → 收尾清理）',
  );
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('FAIL(异常): ' + (e && e.stack ? e.stack : String(e)));
  process.exitCode = 1;
} finally {
  if (child) child.kill();
  fakeModel.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响测试结果 */
  }
}
