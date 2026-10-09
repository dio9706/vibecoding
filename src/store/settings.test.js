import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, makeTokenEntry, credentialModels, normalizeModelList, makeMcpServerEntry, makeBotEntry, pickActiveBot, normalizeExec, normalizeSearch } from './settings.js';

test('normalizeSettings：缺 providerId 的 token 回填 claude-agent', () => {
  const out = normalizeSettings({ tokens: [{ id: 'a', token: 'x', status: 'healthy' }] });
  assert.equal(out.tokens[0].providerId, 'claude-agent');
});

test('normalizeSettings：已有 providerId 不被覆盖（幂等）', () => {
  const out = normalizeSettings({ tokens: [{ id: 'o', providerId: 'openai-compat', token: 'x' }] });
  assert.equal(out.tokens[0].providerId, 'openai-compat');
  assert.equal(normalizeSettings(out).tokens[0].providerId, 'openai-compat'); // 再归一仍不变
});

test('normalizeSettings：非数组 tokens 归一为空数组', () => {
  assert.deepEqual(normalizeSettings({ tokens: 'nope' }).tokens, []);
});

test('normalizeSettings：builtinMcp/builtinSkills 白名单过滤与形状归一', () => {  const out = normalizeSettings({
    builtinMcp: {
      context7: { enabled: false, apiKey: ' k ' },
      'figma-framelink': { enabled: 'yes' }, // 非布尔 → 丢弃该字段（条目保留为 {}）
      unknown: { enabled: true }, // 未知 id → 整条剔除（防僵尸键）
    },
    builtinSkills: {
      superpowers: { enabled: true, disabledSkills: ['brainstorming', 'nope', 'brainstorming', 42] },
      nope: { enabled: true },
    },
  });
  assert.deepEqual(out.builtinMcp, { context7: { enabled: false, apiKey: 'k' }, 'figma-framelink': {} });
  assert.deepEqual(out.builtinSkills, { superpowers: { enabled: true, disabledSkills: ['brainstorming'] } });
  assert.deepEqual(normalizeSettings({ builtinMcp: 'x' }).builtinMcp, {});
  assert.deepEqual(normalizeSettings({}).builtinSkills, {});
  // 全恢复启用后不留空数组
  assert.deepEqual(
    normalizeSettings({ builtinSkills: { superpowers: { disabledSkills: [] } } }).builtinSkills,
    { superpowers: {} },
  );
});

test('normalizeSettings：repoMap 默认开启、只认布尔', () => {
  assert.equal(normalizeSettings({}).repoMap.enabled, true);
  assert.equal(normalizeSettings({ repoMap: { enabled: false } }).repoMap.enabled, false);
  assert.equal(normalizeSettings({ repoMap: { enabled: 'no' } }).repoMap.enabled, true, '非布尔回落默认');
  assert.equal(normalizeSettings({ repoMap: null }).repoMap.enabled, true);
});

test('normalizeSettings：保留 token 其余字段', () => {
  const out = normalizeSettings({ tokens: [{ id: 'a', token: 'x', status: 'warning', utilization: 0.5 }] });
  assert.equal(out.tokens[0].status, 'warning');
  assert.equal(out.tokens[0].utilization, 0.5);
});

test('makeTokenEntry：claude 条目不含 baseURL/model/vendor，带默认字段', () => {
  const e = makeTokenEntry({ id: 'k1', token: 'sk-x', providerId: 'claude-agent', index: 0, now: 'T' });
  assert.equal(e.id, 'k1');
  assert.equal(e.providerId, 'claude-agent');
  assert.equal(e.token, 'sk-x');
  assert.equal(e.label, '账号1');
  assert.equal(e.status, 'healthy');
  assert.equal(e.updatedAt, 'T');
  assert.equal('baseURL' in e, false);
  assert.equal('model' in e, false);
  assert.equal('vendor' in e, false);
});

test('makeTokenEntry：openai 条目携带 baseURL/model/vendor 与自定义 label', () => {
  const e = makeTokenEntry({ id: 'o1', token: 'sk-o', providerId: 'openai-compat', label: 'DeepSeek', vendor: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', index: 2, now: 'T' });
  assert.equal(e.providerId, 'openai-compat');
  assert.equal(e.label, 'DeepSeek');
  assert.equal(e.vendor, 'deepseek');
  assert.equal(e.baseURL, 'https://api.deepseek.com');
  assert.equal(e.model, 'deepseek-chat');
});

// 多模型（OpenCode 式）：models 归一后条件展开；空列表不落字段
test('makeTokenEntry：models 归一携带、modelsUpdatedAt 原样；空列表/缺省不带字段', () => {
  const e = makeTokenEntry({
    id: 'o9', token: 'sk', providerId: 'openai-compat', baseURL: 'https://api.deepseek.com/v1',
    models: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }, 'deepseek-v4-pro', { id: 'deepseek-flash' }, { id: '  ' }],
    modelsUpdatedAt: '2026-10-08T00:00:00.000Z', now: 'T',
  });
  assert.deepEqual(e.models, [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'deepseek-v4-pro' },
  ]);
  assert.equal(e.modelsUpdatedAt, '2026-10-08T00:00:00.000Z');
  const empty = makeTokenEntry({ id: 'o10', token: 'sk', providerId: 'openai-compat', models: [], now: 'T' });
  assert.equal('models' in empty, false);
  assert.equal('modelsUpdatedAt' in empty, false);
});

test('normalizeModelList：字符串/对象混用、去重保序、name===id 省略', () => {
  assert.deepEqual(normalizeModelList([' a ', { id: 'b', name: ' B ' }, 'a', { id: 'c', name: 'c' }, null]), [
    { id: 'a' },
    { id: 'b', name: 'B' },
    { id: 'c' },
  ]);
  assert.deepEqual(normalizeModelList(null), []);
});

test('normalizeModelList：efforts/defaultEffort 归一（坏值丢弃）；credentialModels 原样带出', () => {
  const out = normalizeModelList([
    { id: 'm1', efforts: [' low ', 'high', 'low', 42], defaultEffort: ' high ' },
    { id: 'm2', efforts: [], defaultEffort: 'x' },
    { id: 'm3', efforts: ['a'], defaultEffort: 'b' }, // default 不在档位 → 丢
  ]);
  assert.deepEqual(out, [
    { id: 'm1', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'm2' },
    { id: 'm3', efforts: ['a'] },
  ]);
  assert.deepEqual(
    credentialModels({ models: [{ id: 'm1', efforts: ['low'], defaultEffort: 'low' }] }),
    [{ id: 'm1', efforts: ['low'], defaultEffort: 'low' }],
  );
});

test('normalizeSettings：uiPrefs 含 openaiMaxSteps（默认 0=无上限，显式值透传）', () => {
  assert.equal(normalizeSettings({}).uiPrefs.openaiMaxSteps, 0);
  assert.equal(normalizeSettings({ uiPrefs: { openaiMaxSteps: 50 } }).uiPrefs.openaiMaxSteps, 50);
});

test('normalizeSearch：provider 白名单 + key trim；非法回空（未配置）', () => {
  assert.deepEqual(normalizeSearch({}), { provider: '', apiKey: '' });
  assert.deepEqual(normalizeSearch({ provider: 'tavily', apiKey: ' k ' }), { provider: 'tavily', apiKey: 'k' });
  assert.deepEqual(normalizeSearch({ provider: 'nope', apiKey: 42 }), { provider: '', apiKey: '' });
  assert.deepEqual(normalizeSettings({ search: { provider: 'bocha', apiKey: 'bk' } }).search, { provider: 'bocha', apiKey: 'bk' });
  assert.deepEqual(normalizeSettings({}).search, { provider: '', apiKey: '' });
});

test('credentialModels：models 优先；legacy model 回落单模型；空凭证 → []', () => {
  assert.deepEqual(
    credentialModels({ models: [{ id: 'deepseek-flash' }], model: 'legacy-ignored' }),
    [{ id: 'deepseek-flash' }],
    '有发现列表时忽略 legacy',
  );
  assert.deepEqual(credentialModels({ model: 'deepseek-chat' }), [{ id: 'deepseek-chat' }], '老凭证回落');
  assert.deepEqual(credentialModels({ model: '  ' }), []);
  assert.deepEqual(credentialModels({}), []);
  assert.deepEqual(credentialModels(null), []);
  assert.deepEqual(credentialModels({ models: 'x', model: 'm' }), [{ id: 'm' }], '坏 models 形状回落 legacy');
});

// vendor 是纯展示元数据，允许缺省：手写 API 调用 / 存量数据都可能没有它，
// 此时不该落一个空字段（前端按 baseURL 反查兜底）
test('makeTokenEntry：openai 条目省略 vendor 时不带该字段', () => {
  const e = makeTokenEntry({ id: 'o2', token: 'sk-o', providerId: 'openai-compat', baseURL: 'https://api.x.com/v1', model: 'm', now: 'T' });
  assert.equal('vendor' in e, false);
  assert.equal(e.baseURL, 'https://api.x.com/v1');
});

test('normalizeSettings：透传 openai 凭证的 vendor 字段（新增字段不被剥离）', () => {
  const out = normalizeSettings({ tokens: [{ id: 'o', providerId: 'openai-compat', token: 'x', vendor: 'zhipu', baseURL: 'b', model: 'glm-4' }] });
  assert.equal(out.tokens[0].vendor, 'zhipu');
  assert.equal(normalizeSettings(out).tokens[0].vendor, 'zhipu'); // 幂等
});

test('makeTokenEntry：label 缺省按 index 生成（账号N）', () => {
  assert.equal(makeTokenEntry({ id: 'x', token: 't', index: 4, now: 'T' }).label, '账号5');
});

test('makeMcpServerEntry：label 缺省取 command，enabled 默认开，args 归一为非空字符串数组', () => {
  const e = makeMcpServerEntry({ id: 'm1', command: 'npx', args: [' -y ', '', 'pkg', 42], now: 'T' });
  assert.equal(e.id, 'm1');
  assert.equal(e.label, 'npx');
  assert.equal(e.enabled, true);
  assert.deepEqual(e.args, ['-y', 'pkg', '42']);
  assert.deepEqual(e.autoAllow, []); // 缺省空白名单 = 全部审批
  assert.equal(e.updatedAt, 'T');
  assert.equal('cwd' in e, false); // 未传 cwd 不带字段
});

test('makeMcpServerEntry：autoAllow 归一（修剪/去空）', () => {
  const e = makeMcpServerEntry({ id: 'm3', command: 'npx', autoAllow: [' read_file ', '', 'stat'], now: 'T' });
  assert.deepEqual(e.autoAllow, ['read_file', 'stat']);
});

test('makeMcpServerEntry：显式 label/cwd 保留；args 非数组归空', () => {
  const e = makeMcpServerEntry({ id: 'm2', label: ' fs ', command: 'node', args: 'x', cwd: 'C:/w', now: 'T' });
  assert.equal(e.label, 'fs');
  assert.equal(e.cwd, 'C:/w');
  assert.deepEqual(e.args, []);
});

test('normalizeSettings：plugins 缺省 {}、非对象归 {}、显式值透传', () => {
  assert.deepEqual(normalizeSettings({}).plugins, {});
  assert.deepEqual(normalizeSettings({ plugins: [1] }).plugins, {});
  assert.deepEqual(normalizeSettings({ plugins: { 'team-tools': false } }).plugins, { 'team-tools': false });
});

test('normalizeSettings：bots 缺省空数组、非数组归空、条目透传', () => {
  assert.deepEqual(normalizeSettings({}).bots, []);
  assert.deepEqual(normalizeSettings({ bots: 'x' }).bots, []);
  const bot = { id: 'b1', name: '机器人 1', platform: 'feishu', appId: 'cli_1', enabled: true };
  assert.deepEqual(normalizeSettings({ bots: [bot] }).bots, [bot]);
});

test('makeBotEntry：缺省值齐全（platform=feishu、messages 空对象、enabled 默认关）', () => {
  const e = makeBotEntry({ id: 'b1', now: 'T' });
  assert.equal(e.id, 'b1');
  assert.equal(e.name, '机器人 1');
  assert.equal(e.platform, 'feishu');
  assert.equal(e.appId, '');
  assert.equal(e.appSecret, '');
  assert.equal(e.persona, '');
  assert.deepEqual(e.messages, {});
  assert.equal(e.projectDir, '');
  assert.equal(e.projectNotes, '');
  assert.equal(e.autonomy, 'light');
  assert.equal(e.enabled, false);
  assert.equal(e.updatedAt, 'T');
});

test('makeBotEntry：projectDir/projectNotes/autonomy 显式透传（addBot 同签名，防新建丢字段回归）', () => {
  const e = makeBotEntry({
    id: 'b9', projectDir: 'C:/w/p', projectNotes: '后端: x', autonomy: 'full', now: 'T',
  });
  assert.equal(e.projectDir, 'C:/w/p');
  assert.equal(e.projectNotes, '后端: x');
  assert.equal(e.autonomy, 'full');
});

test('makeBotEntry：autonomy 枚举透传、非法值归 light', () => {
  assert.equal(makeBotEntry({ id: 'b', autonomy: 'full', now: 'T' }).autonomy, 'full');
  assert.equal(makeBotEntry({ id: 'b', autonomy: 'medium', now: 'T' }).autonomy, 'medium');
  assert.equal(makeBotEntry({ id: 'b', autonomy: 'hacker', now: 'T' }).autonomy, 'light');
});

test('makeBotEntry：execPolicy 枚举透传、缺省/非法值归 bypass（T6：默认与改动前一致）', () => {
  assert.equal(makeBotEntry({ id: 'b', now: 'T' }).execPolicy, 'bypass');
  assert.equal(makeBotEntry({ id: 'b', execPolicy: 'standard', now: 'T' }).execPolicy, 'standard');
  assert.equal(makeBotEntry({ id: 'b', execPolicy: 'trusted', now: 'T' }).execPolicy, 'trusted');
  assert.equal(makeBotEntry({ id: 'b', execPolicy: 'yolo', now: 'T' }).execPolicy, 'bypass');
});

test('normalizeExec：后端白名单 + 镜像名 + 网络布尔；非法值 fail-closed 回默认', () => {
  assert.deepEqual(normalizeExec(undefined), { backend: 'local', image: 'node:22-bookworm', network: false });
  assert.deepEqual(normalizeExec({ backend: 'container', image: ' img ', network: true }), {
    backend: 'container',
    image: 'img',
    network: true,
  });
  assert.deepEqual(normalizeExec({ backend: 'hacker', image: '  ', network: 'x' }), {
    backend: 'local',
    image: 'node:22-bookworm',
    network: false,
  });
});

test('normalizeSettings：exec 分区归一透传（缺省 local）', () => {
  assert.deepEqual(normalizeSettings({}).exec, { backend: 'local', image: 'node:22-bookworm', network: false });
  assert.deepEqual(normalizeSettings({ exec: { backend: 'container' } }).exec, {
    backend: 'container',
    image: 'node:22-bookworm',
    network: false,
  });
});

test('makeBotEntry：显式字段透传，name 缺省按 index 生成', () => {
  const e = makeBotEntry({
    id: 'b2', name: ' 客服 ', platform: 'feishu', appId: 'cli_2', appSecret: 's',
    persona: 'p', messages: { ackBug: 'ok' }, enabled: true, index: 2, now: 'T',
  });
  assert.equal(e.name, '客服');
  assert.equal(e.appId, 'cli_2');
  assert.equal(e.enabled, true);
  assert.deepEqual(e.messages, { ackBug: 'ok' });
  assert.equal(makeBotEntry({ id: 'b3', index: 2, now: 'T' }).name, '机器人 3');
});

test('makeBotEntry：setupScript 字符串收录，非字符串归空', () => {
  const now = '2026-07-29T00:00:00.000Z';
  const a = makeBotEntry({ id: 'b1', setupScript: 'npm install', index: 0, now });
  assert.equal(a.setupScript, 'npm install');
  const b = makeBotEntry({ id: 'b2', setupScript: 123, index: 0, now });
  assert.equal(b.setupScript, '');
});

test('makeBotEntry：verifyScript 字符串收录并 trim，非字符串/缺省归空串', () => {
  const now = 'T';
  const a = makeBotEntry({ id: 'b1', verifyScript: '  npm test && npm run lint  ', index: 0, now });
  assert.equal(a.verifyScript, 'npm test && npm run lint');
  assert.equal(makeBotEntry({ id: 'b2', verifyScript: 42, index: 0, now }).verifyScript, '');
  assert.equal(makeBotEntry({ id: 'b3', index: 0, now }).verifyScript, '');
});

// per-bot 可信提交人白名单（trustedOpenIds）已删除：从未接通 API/UI，也无人读取。
// 这里留一条反向断言守住「不要再悄悄长回来」——字段一旦复活却仍无人读，就是同一个坑。
test('makeBotEntry：不再产出 trustedOpenIds 字段（已废弃删除）', () => {
  const e = makeBotEntry({ id: 'b1', trustedOpenIds: ['ou_a'], now: 'T' });
  assert.equal('trustedOpenIds' in e, false);
});

test('pickActiveBot：取第一个 enabled 的机器人；无启用返回 null', () => {
  const bots = [
    { id: 'a', enabled: false },
    { id: 'b', enabled: true },
    { id: 'c', enabled: true },
  ];
  assert.equal(pickActiveBot(bots).id, 'b');
  assert.equal(pickActiveBot([{ id: 'a', enabled: false }]), null);
  assert.equal(pickActiveBot([]), null);
  assert.equal(pickActiveBot('nope'), null);
});

test('normalizeSettings：persona 缺省空串、非字符串归空、字符串透传', () => {
  assert.equal(normalizeSettings({}).persona, '');
  assert.equal(normalizeSettings({ persona: 42 }).persona, '');
  assert.equal(normalizeSettings({ persona: ['x'] }).persona, '');
  assert.equal(normalizeSettings({ persona: '活泼的运维助手' }).persona, '活泼的运维助手');
});

test('normalizeSettings：mcpServers 缺省为空数组、非数组归空', () => {
  assert.deepEqual(normalizeSettings({}).mcpServers, []);
  assert.deepEqual(normalizeSettings({ mcpServers: 'x' }).mcpServers, []);
  assert.deepEqual(normalizeSettings({ mcpServers: [{ command: 'node' }] }).mcpServers, [{ command: 'node' }]);
});

test('normalizeSettings：myFeishuOpenId 缺省空串、非字符串归空、字符串 trim 透传', () => {
  assert.equal(normalizeSettings({}).myFeishuOpenId, '');
  assert.equal(normalizeSettings({ myFeishuOpenId: 123 }).myFeishuOpenId, '');
  assert.equal(normalizeSettings({ myFeishuOpenId: ' ou_abc ' }).myFeishuOpenId, 'ou_abc');
});

test('memoryBank：默认值完整', () => {
  const s = normalizeSettings({});
  assert.deepEqual(s.memoryBank, {
    enabled: false,
    nightStart: '00:00',
    nightEnd: '00:00',
    minIntervalHours: 1,
    model: '',
    maxItems: 40,
    maxChars: 3000,
    dormantDays: 90,
    minEvidence: 3,
    minSessions: 2,
  });
});

test('memoryBank：局部覆盖时其余字段回落默认', () => {
  const s = normalizeSettings({ memoryBank: { enabled: true, nightStart: '02:30' } });
  assert.equal(s.memoryBank.enabled, true);
  assert.equal(s.memoryBank.nightStart, '02:30');
  assert.equal(s.memoryBank.nightEnd, '00:00');
});

test('memoryBank：非对象/数组输入回落全默认，不抛错', () => {
  assert.equal(normalizeSettings({ memoryBank: null }).memoryBank.enabled, false);
  assert.equal(normalizeSettings({ memoryBank: [] }).memoryBank.nightEnd, '00:00');
});

test('memoryBank：默认关闭 —— 功能要用户显式开启后才跑', () => {
  assert.equal(normalizeSettings({}).memoryBank.enabled, false);
});
