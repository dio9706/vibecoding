import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTextContent,
  parseImageContent,
  parsePostContent,
  parseFileContent,
  extractDocLinks,
  stripDocLinks,
  parseMentions,
  stripMentions,
} from './feishu-normalize.js';

test('parseTextContent：正常/空白修剪/坏 JSON', () => {
  assert.equal(parseTextContent('{"text":" 你好 "}'), '你好');
  assert.equal(parseTextContent('{"text":""}'), '');
  assert.equal(parseTextContent('not json'), '');
});

test('parseImageContent：取 image_key，坏 JSON 归空', () => {
  assert.equal(parseImageContent('{"image_key":"img_v3_abc"}'), 'img_v3_abc');
  assert.equal(parseImageContent('{}'), '');
  assert.equal(parseImageContent('x'), '');
});

test('parsePostContent：title 置首 + 段落拼接 + 链接文本+href + 图片 key 收集', () => {
  // 真实飞书 post 报文形状：content 为段落数组，节点 tag=text/a/img
  // a 标签现在同时保留 text 和 href，云文档链接不再丢失
  const content = JSON.stringify({
    title: '需求标题',
    content: [
      [{ tag: 'text', text: '第一段' }, { tag: 'a', text: '链接文字', href: 'https://x' }],
      [{ tag: 'img', image_key: 'img_k1' }],
      [{ tag: 'text', text: '第二段' }],
      [{ tag: 'img', image_key: 'img_k2' }],
    ],
  });
  const r = parsePostContent(content);
  // a 标签现输出 "链接文字 https://x"（text + href 拼接）
  assert.equal(r.text, '需求标题\n第一段链接文字 https://x\n第二段');
  assert.deepEqual(r.imageKeys, ['img_k1', 'img_k2']);
});

test('parsePostContent：无 title / 空段落 / 坏 JSON', () => {
  assert.deepEqual(parsePostContent(JSON.stringify({ content: [[{ tag: 'text', text: 'a' }]] })), {
    text: 'a',
    imageKeys: [],
  });
  assert.deepEqual(parsePostContent('bad'), { text: '', imageKeys: [] });
  assert.deepEqual(parsePostContent(JSON.stringify({ title: '', content: [] })), { text: '', imageKeys: [] });
});

test('parseFileContent：取 file_key 与文件名', () => {
  assert.deepEqual(
    parseFileContent(JSON.stringify({ file_key: 'fk1', file_name: '联调文档.docx' })),
    { fileKey: 'fk1', fileName: '联调文档.docx' },
  );
  assert.equal(parseFileContent('{}'), null);
  assert.equal(parseFileContent('not-json'), null);
});

test('extractDocLinks：识别 docx/wiki 链接与 token（含 query 串）', () => {
  const text = '看这个 https://abc.feishu.cn/docx/AbCd1234 和 https://abc.feishu.cn/wiki/WkTk5678?from=x';
  assert.deepEqual(extractDocLinks(text), [
    { url: 'https://abc.feishu.cn/docx/AbCd1234', kind: 'docx', token: 'AbCd1234' },
    // wiki 链接 url 包含完整 query 串，token 仍只取路径段
    { url: 'https://abc.feishu.cn/wiki/WkTk5678?from=x', kind: 'wiki', token: 'WkTk5678' },
  ]);
  assert.deepEqual(extractDocLinks('没有链接'), []);
  // g flag 幂等：多次调用同一输入结果一致（无 lastIndex 污染）
  assert.deepEqual(extractDocLinks(text), extractDocLinks(text));
});

test('stripDocLinks：去掉链接后剩余文本（含 query 串）', () => {
  assert.equal(stripDocLinks('https://abc.feishu.cn/docx/AbCd1234'), '');
  assert.equal(stripDocLinks('按这个联调 https://abc.feishu.cn/docx/AbCd1234'), '按这个联调');
  // 飞书「复制链接」默认带 from=from_copylink，纯链接分支必须整串吞掉
  assert.equal(stripDocLinks('https://abc.feishu.cn/docx/AbCd1234?from=from_copylink'), '');
  // 中文逗号即停：query 字符集限 ASCII，不误吞后续正文
  assert.equal(stripDocLinks('看这个https://abc.feishu.cn/docx/X9?from=from_copylink，按这个做'), '看这个，按这个做');
});

test('parsePostContent：a 标签保留 href（云文档链接不再丢失）', () => {
  const content = JSON.stringify({
    title: 'T',
    content: [[{ tag: 'a', text: '联调文档', href: 'https://abc.feishu.cn/docx/AbCd1234' }]],
  });
  const r = parsePostContent(content);
  assert.ok(r.text.includes('https://abc.feishu.cn/docx/AbCd1234'));
});

test('parseMentions：抽出 key/openId/name', () => {
  const message = {
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '开发助手' },
      { key: '@_user_2', id: { open_id: 'ou_me' }, name: '张三' },
    ],
  };
  assert.deepEqual(parseMentions(message), [
    { key: '@_user_1', openId: 'ou_bot', name: '开发助手' },
    { key: '@_user_2', openId: 'ou_me', name: '张三' },
  ]);
});

test('parseMentions：无 mentions / 字段缺失 → 空数组（不抛错）', () => {
  assert.deepEqual(parseMentions({}), []);
  assert.deepEqual(parseMentions(null), []);
  assert.deepEqual(parseMentions({ mentions: [{}] }), []);
});

test('stripMentions：剥掉 @_user_N 占位符，压缩空白', () => {
  const mentions = [{ key: '@_user_1', openId: 'ou_bot', name: '开发助手' }];
  assert.equal(stripMentions('@_user_1 提交需求：加导出', mentions), '提交需求：加导出');
  assert.equal(stripMentions('提交需求：加导出 @_user_1', mentions), '提交需求：加导出');
  assert.equal(stripMentions('帮我 @_user_1  看看', mentions), '帮我 看看');
});

test('stripMentions：占位符是纯 @ 消息 → 空串（调用方据此丢弃）', () => {
  const mentions = [{ key: '@_user_1', openId: 'ou_bot', name: '开发助手' }];
  assert.equal(stripMentions('@_user_1', mentions), '');
  assert.equal(stripMentions('  @_user_1  ', mentions), '');
});

test('stripMentions：多个占位符（@_user_10 不会被 @_user_1 吃掉前缀）', () => {
  const mentions = [
    { key: '@_user_1', openId: 'ou_a', name: 'A' },
    { key: '@_user_10', openId: 'ou_b', name: 'B' },
  ];
  assert.equal(stripMentions('@_user_10 @_user_1 提需求', mentions), '提需求');
});

test('stripMentions：无 mentions → 原文 trim（不动内容）', () => {
  assert.equal(stripMentions(' 提交需求：加导出 ', []), '提交需求：加导出');
  assert.equal(stripMentions('a @b c', undefined), 'a @b c');
});
