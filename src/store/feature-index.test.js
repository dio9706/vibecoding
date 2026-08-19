/**
 * 功能账本测试套件 —— 验证 CRUD 操作、频次统计、排序、边界处理
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert';

// 在动态 import 之前设置隔离的 APP_DATA_DIR
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-index-test-'));
process.env.APP_DATA_DIR = tmpdir;

// 动态导入待测模块（确保 APP_DATA_DIR 已设置）
const { getFeature, listFeatureTags, harvestFiles, getTopFiles, getFeatureIndex } =
  await import('./feature-index.js');

// 每次测试前清理旧的 feature-index.json 与其锁文件，确保测试隔离
function resetIndex() {
  const filePath = path.join(tmpdir, 'feature-index.json');
  const lockFile = filePath + '.lock';
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    // 文件不存在或被锁定
  }
  try {
    fs.unlinkSync(lockFile);
  } catch (e) {
    // 锁文件不存在
  }
}

test('getFeature: 标签不存在返回 null', () => {
  resetIndex();
  const result = getFeature('nonexistent_tag_001');
  assert.strictEqual(result, null, '应返回 null');
});

test('harvestFiles: 首次收割写入 count=1', () => {
  resetIndex();
  const tag = 'first_harvest_tag';
  harvestFiles(tag, ['src/views/BabyFood.vue', 'src/api/babyFood.js']);
  const entry = getFeature(tag);
  assert.ok(entry, '应创建新条目');
  assert.strictEqual(entry.tag, tag, 'tag 应匹配');
  assert.strictEqual(entry.files.length, 2, '应有 2 个文件');
  assert.deepStrictEqual(
    entry.files,
    [
      { path: 'src/views/BabyFood.vue', count: 1 },
      { path: 'src/api/babyFood.js', count: 1 },
    ],
    '每个文件计数应为 1'
  );
  assert.ok(entry.lastHarvestedAt, '应记录 lastHarvestedAt');
});

test('harvestFiles: 重复收割累加计数并按频次排序', () => {
  resetIndex();
  const tag = 'repeat_harvest_tag';
  harvestFiles(tag, ['src/views/BabyFood.vue', 'src/api/babyFood.js']);
  harvestFiles(tag, ['src/views/BabyFood.vue']);
  const entry = getFeature(tag);
  assert.strictEqual(entry.files[0].path, 'src/views/BabyFood.vue', '高频文件应排在首位');
  assert.strictEqual(entry.files[0].count, 2, '重复文件计数应累加为 2');
  assert.strictEqual(entry.files[1].path, 'src/api/babyFood.js', '低频文件应排在后');
  assert.strictEqual(entry.files[1].count, 1, '未重复的文件计数保持 1');
});

test('harvestFiles: tag 为空时静默跳过', () => {
  resetIndex();
  const indexBefore = JSON.stringify(getFeatureIndex());
  harvestFiles(null, ['src/test.js']);
  harvestFiles('', ['src/test.js']);
  harvestFiles(undefined, ['src/test.js']);
  const indexAfter = JSON.stringify(getFeatureIndex());
  assert.strictEqual(indexBefore, indexAfter, '空 tag 应不改变索引');
});

test('harvestFiles: filePaths 为空时静默跳过', () => {
  resetIndex();
  const tag = 'empty_paths_tag';
  harvestFiles(tag, ['src/file1.js', 'src/file2.js']);
  const entry = getFeature(tag);
  const countBefore = entry.files.length;
  harvestFiles(tag, null);
  harvestFiles(tag, []);
  harvestFiles(tag, undefined);
  const entryAfter = getFeature(tag);
  assert.strictEqual(entryAfter.files.length, countBefore, '空 filePaths 应不改变文件列表');
});

test('listFeatureTags: 返回已知标签', () => {
  resetIndex();
  const tag1 = 'list_tag_first';
  const tag2 = 'list_tag_second';
  harvestFiles(tag1, ['src/file1.js']);
  harvestFiles(tag2, ['src/file2.js']);
  const tags = listFeatureTags();
  assert.ok(tags.includes(tag1), `应包含「${tag1}」`);
  assert.ok(tags.includes(tag2), `应包含「${tag2}」`);
  assert.strictEqual(typeof tags, 'object', '应返回数组');
  assert.ok(Array.isArray(tags), '应是数组类型');
});

test('getTopFiles: 按频次排序返回前 N 条', () => {
  resetIndex();
  const tag = 'top_files_tag';
  harvestFiles(tag, ['a.js', 'b.js', 'c.js']);
  harvestFiles(tag, ['a.js', 'b.js']);
  harvestFiles(tag, ['a.js']);

  const top2 = getTopFiles(tag, 2);
  assert.strictEqual(top2.length, 2, '应返回前 2 条');
  assert.strictEqual(top2[0].path, 'a.js', '第一条应是最高频的');
  assert.strictEqual(top2[0].count, 3, 'a.js 计数应为 3');
  assert.strictEqual(top2[1].path, 'b.js', '第二条应是次高频的');
  assert.strictEqual(top2[1].count, 2, 'b.js 计数应为 2');
});

test('getTopFiles: 标签不存在时返回 null', () => {
  resetIndex();
  const result = getTopFiles('nonexistent_tag_002');
  assert.strictEqual(result, null, '不存在的标签应返回 null');
});
