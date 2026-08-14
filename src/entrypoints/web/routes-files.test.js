/** validateScriptName 单测：扩展名白名单、防穿越、文件名清洗、类型判定 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'files-test-'));
const { validateScriptName, handleScriptUpload } = await import('./routes-files.js');

test('.py → ok，scriptType=python', () => {
  assert.deepEqual(validateScriptName('get_qrcode.py'), {
    ok: true, scriptName: 'get_qrcode.py', scriptType: 'python',
  });
});

test('.js → ok，scriptType=node', () => {
  assert.deepEqual(validateScriptName('notify.js'), {
    ok: true, scriptName: 'notify.js', scriptType: 'node',
  });
});

test('非法扩展名 → 拒绝', () => {
  assert.equal(validateScriptName('evil.txt').ok, false);
});

test('路径穿越被 basename 拦截，只留文件名', () => {
  const r = validateScriptName('../../etc/evil.py');
  assert.equal(r.ok, true);
  assert.equal(r.scriptName, 'evil.py');
});

test('空格/特殊字符清洗为下划线', () => {
  assert.equal(validateScriptName('my script!.py').scriptName, 'my_script_.py');
});

test('中文文件名保留', () => {
  assert.equal(validateScriptName('二维码.py').scriptName, '二维码.py');
});

test('大写扩展名统一小写（scriptName 扩展名小写、类型正确）', () => {
  assert.deepEqual(validateScriptName('Test.PY'), {
    ok: true, scriptName: 'Test.py', scriptType: 'python',
  });
});

// ---- handleScriptUpload 流处理测试 ----
function mockRes() {
  return {
    code: null,
    json: null,
    writeHead(code) { this.code = code; return this; },
    end(body) { try { this.json = JSON.parse(body); } catch { this.json = body; } },
  };
}
function mockReq() {
  const r = new EventEmitter();
  r.method = 'POST';
  r.destroy = () => {};
  return r;
}
function uploadUrl(name) {
  return new URL('http://x/api/scripts/upload?name=' + encodeURIComponent(name));
}
const SCRIPTS_DIR = path.join(process.env.APP_DATA_DIR, 'scripts');

test('handleScriptUpload 正常上传 → 200 + 写盘', () => {
  const req = mockReq();
  const res = mockRes();
  handleScriptUpload(req, res, uploadUrl('probe_t.py'));
  req.emit('data', Buffer.from('print(1)\n'));
  req.emit('end');
  assert.equal(res.code, 200);
  assert.deepEqual(res.json, { scriptName: 'probe_t.py', scriptType: 'python' });
  assert.equal(fs.readFileSync(path.join(SCRIPTS_DIR, 'probe_t.py'), 'utf8'), 'print(1)\n');
});

test('handleScriptUpload 空内容 → 400', () => {
  const req = mockReq();
  const res = mockRes();
  handleScriptUpload(req, res, uploadUrl('empty_t.py'));
  req.emit('end');
  assert.equal(res.code, 400);
  assert.equal(res.json.error, '脚本内容为空');
  assert.equal(fs.existsSync(path.join(SCRIPTS_DIR, 'empty_t.py')), false);
});

test('handleScriptUpload 非法扩展名 → 400（不进入流）', () => {
  const req = mockReq();
  const res = mockRes();
  handleScriptUpload(req, res, uploadUrl('bad_t.txt'));
  assert.equal(res.code, 400);
});

test('handleScriptUpload 超过 1MB → 413', () => {
  const req = mockReq();
  const res = mockRes();
  handleScriptUpload(req, res, uploadUrl('big_t.py'));
  req.emit('data', Buffer.alloc(1024 * 1024 + 1));
  assert.equal(res.code, 413);
});
