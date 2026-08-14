/**
 * bots 迁移单测：旧「单凭证 + 全局 persona/messages」→ 机器人实体 + 动作收养。
 * 隔离：APP_DATA_DIR 指到临时目录后再动态 import（同 action-configs.test.js）。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-migration-test-'));
process.env.APP_DATA_DIR = TMP_DIR;

const { migrateToBots } = await import('./bots-migration.js');
const { getSettings, replaceSettings, addBot } = await import('./settings.js');
const { getConfigs, saveConfigs } = await import('./action-configs.js');
const { dataPath } = await import('./index.js');

after(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  for (const f of ['settings.json', 'action-configs.json']) {
    try {
      fs.rmSync(dataPath(f));
    } catch {
      /* ignore */
    }
  }
});

test('旧凭证/persona/messages 迁移为启用的机器人 1，只带两条可配文案，旧字段清空', () => {
  replaceSettings({
    lark: { appId: 'cli_0123456789abcdef', appSecret: 'sec' },
    persona: '活泼助手',
    messages: { ackBug: '收到！', execProcessing: '在做了', welcome: '自定义欢迎', execNewChat: '新对话' },
    uiPrefs: { taskProjectDir: 'C:/work/my-project' },
  });
  const r = migrateToBots();
  assert.equal(r.migrated, true);
  const s = getSettings();
  assert.equal(s.bots.length, 1);
  const bot = s.bots[0];
  assert.equal(bot.name, '机器人 1');
  assert.equal(bot.platform, 'feishu');
  assert.equal(bot.appId, 'cli_0123456789abcdef');
  assert.equal(bot.appSecret, 'sec');
  assert.equal(bot.persona, '活泼助手');
  assert.equal(bot.enabled, true);
  assert.deepEqual(bot.messages, { ackBug: '收到！', execProcessing: '在做了' }); // welcome/execNewChat 丢弃
  assert.equal(bot.projectDir, 'C:/work/my-project'); // 原「基础设置-项目目录」随迁
  assert.deepEqual(s.lark, { appId: '', appSecret: '' });
  assert.equal(s.persona, '');
  assert.deepEqual(s.messages, {});
  assert.equal('taskProjectDir' in s.uiPrefs, false);
});

test('幂等：已有 bots 时不重复创建、不覆盖', () => {
  replaceSettings({ lark: { appId: 'cli_0123456789abcdef', appSecret: 'x' } });
  migrateToBots();
  const first = getSettings().bots[0];
  const r2 = migrateToBots();
  assert.equal(r2.migrated, false);
  assert.equal(getSettings().bots.length, 1);
  assert.equal(getSettings().bots[0].id, first.id);
});

test('无旧配置且无 bots：不创建机器人', () => {
  const r = migrateToBots();
  assert.equal(r.migrated, false);
  assert.equal(getSettings().bots.length, 0);
});

test('动作收养：botId 缺失或失配 → 回填启用机器人；有效 botId 保留', () => {
  replaceSettings({ lark: { appId: 'cli_0123456789abcdef', appSecret: 'x' } });
  const other = addBot({ name: '备用', enabled: false }); // 先有一个非启用机器人
  saveConfigs([
    { id: 'a1', name: '无主' },
    { id: 'a2', name: '失配', botId: 'bot_ghost' },
    { id: 'a3', name: '有效', botId: other.id },
  ]);
  const r = migrateToBots(); // lark 旧凭证仍在但 bots 非空 → 不再建 bot，只做收养
  assert.equal(r.migrated, false);
  assert.equal(r.adopted, 2);
  const byId = Object.fromEntries(getConfigs().map((c) => [c.id, c]));
  assert.equal(byId.a1.botId, other.id); // 无启用机器人时收养到第一个机器人
  assert.equal(byId.a2.botId, other.id);
  assert.equal(byId.a3.botId, other.id);
});

test('迁移 + 收养一体：旧配置迁移出的机器人收养存量动作', () => {
  replaceSettings({ lark: { appId: 'cli_0123456789abcdef', appSecret: 'x' } });
  saveConfigs([{ id: 'a1', name: '清理数据' }]);
  const r = migrateToBots();
  assert.equal(r.migrated, true);
  assert.equal(r.adopted, 1);
  const bot = getSettings().bots[0];
  assert.equal(getConfigs()[0].botId, bot.id);
});
