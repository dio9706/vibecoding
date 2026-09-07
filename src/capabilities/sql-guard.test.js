/**
 * sql-guard 单测 —— 这是安全边界，用例密度要对得起它的职责。
 *
 * 两类断言同样重要：
 *   ① 写操作/危险构造必须被拒（漏一个就是不可逆事故）
 *   ② 正常分析查询必须放行（误杀会让功能不可用，用户只会绕回去找研发）
 * 第 ② 类尤其容易被忽视 —— 一个只会说「不」的校验器是安全的，也是没用的。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSql, maskLiterals, splitStatements, DEFAULT_PII_COLUMNS } from './sql-guard.js';

const ok = (sql, policy) => {
  const r = validateSql(sql, policy);
  assert.equal(r.ok, true, `本该放行却被拒：${r.reason || ''}\nSQL: ${sql}`);
};
const denied = (sql, code, policy) => {
  const r = validateSql(sql, policy);
  assert.equal(r.ok, false, `本该拒绝却放行了：\nSQL: ${sql}`);
  if (code) assert.equal(r.code, code, `拒绝原因分类不对：${r.code} != ${code}`);
};

describe('放行：正常的只读分析查询', () => {
  it('基础聚合', () => {
    ok('SELECT COUNT(*) FROM orders');
    ok('select count(*) as c from orders where status = 1');
  });

  it('分组 + 排序 + LIMIT', () => {
    ok('SELECT channel, COUNT(*) c FROM users GROUP BY channel ORDER BY c DESC LIMIT 10');
  });

  it('多表 JOIN', () => {
    ok(`SELECT u.channel, COUNT(DISTINCT o.id) AS orders
        FROM users u JOIN orders o ON o.uid = u.id
        WHERE o.created_at >= '2026-09-01'
        GROUP BY u.channel`);
  });

  it('CTE（WITH 开头）', () => {
    ok(`WITH recent AS (SELECT * FROM orders WHERE created_at >= '2026-09-01')
        SELECT COUNT(*) FROM recent`);
  });

  it('子查询与窗口函数', () => {
    ok('SELECT * FROM (SELECT uid, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY id) rn FROM ev) t WHERE rn = 1');
  });

  it('schema 探索', () => {
    ok("SELECT table_name FROM information_schema.tables WHERE table_schema = 'compass_prod'");
  });

  it('字面量里含分号、含危险词 —— 不得误杀', () => {
    // 这是最容易写错的一类：不屏蔽字面量就会把完全合法的查询拒掉
    ok("SELECT ';' AS semi");
    ok("SELECT COUNT(*) FROM t WHERE note = 'DROP TABLE users'");
    ok('SELECT COUNT(*) FROM t WHERE note = "please DELETE later"');
    ok("SELECT COUNT(*) FROM t WHERE a = 'it''s fine'");
  });

  it('反引号标识符里的关键字不得误杀', () => {
    ok('SELECT COUNT(*) FROM `update_log`');
    ok('SELECT `delete` FROM `t`');
  });

  it('普通注释不影响判定', () => {
    ok('-- 统计订单数\nSELECT COUNT(*) FROM orders');
    ok('/* 说明 */ SELECT COUNT(*) FROM orders');
    ok('SELECT COUNT(*) FROM orders # 行尾注释');
  });

  it('尾随分号的单条语句仍是单条', () => {
    ok('SELECT COUNT(*) FROM orders;');
    ok('SELECT COUNT(*) FROM orders;   ');
  });
});

describe('拒绝：写操作（每一条都是不可逆风险）', () => {
  const writes = [
    ['INSERT INTO t VALUES (1)', 'not_select'],
    ['UPDATE t SET a = 1', 'not_select'],
    ['DELETE FROM t', 'not_select'],
    ['DROP TABLE t', 'not_select'],
    ['TRUNCATE TABLE t', 'not_select'],
    ['ALTER TABLE t ADD COLUMN x INT', 'not_select'],
    ['CREATE TABLE t (a INT)', 'not_select'],
    ['GRANT ALL ON *.* TO x', 'not_select'],
    ['REPLACE INTO t VALUES (1)', 'not_select'],
    ['SET SESSION foo = 1', 'not_select'],
    ['CALL some_proc()', 'not_select'],
    ['FLUSH PRIVILEGES', 'not_select'],
  ];
  for (const [sql, code] of writes) {
    it(sql.slice(0, 40), () => denied(sql, code));
  }

  it('大小写混写不影响判定', () => {
    denied('DeLeTe FROM t');
    denied('dRoP TABLE t');
  });

  it('前导注释掩盖写操作', () => {
    denied('-- 只是看看\nDELETE FROM t');
    denied('/* SELECT */ DROP TABLE t');
  });

  it('WITH 开头但中途转写（第一关放行、必须靠关键字兜底）', () => {
    denied('WITH t AS (SELECT 1) DELETE FROM users WHERE id IN (SELECT * FROM t)', 'forbidden_keyword');
    denied('WITH t AS (SELECT 1) UPDATE users SET a = 1', 'forbidden_keyword');
  });
});

describe('SHOW / DESCRIBE / EXPLAIN：拒绝，但文案要指向替代工具', () => {
  // 它们本身只读，仍然拒（SHOW GRANTS / PROCESSLIST / VARIABLES 会泄露基础设施信息）。
  // 但这是模型最容易顺手写的语句，文案不指路它就会反复重试、把查询预算烧光。
  for (const sql of ['SHOW TABLES', 'DESCRIBE orders', 'DESC orders', 'EXPLAIN SELECT 1', 'SHOW GRANTS']) {
    it(sql, () => {
      const r = validateSql(sql);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'not_select');
      assert.match(r.reason, /list_tables|describe_table/, '要告诉模型改用哪个工具');
    });
  }
});

describe('拒绝：语句堆叠', () => {
  it('SELECT 后跟 DROP', () => {
    denied('SELECT 1; DROP TABLE t', 'multi_statement');
  });
  it('三条语句', () => {
    denied('SELECT 1; SELECT 2; SELECT 3', 'multi_statement');
  });
  it('分号在注释里不算分隔', () => {
    ok('SELECT COUNT(*) FROM t -- ; DROP TABLE x\n');
  });
});

describe('拒绝：文件与资源耗尽构造', () => {
  it('INTO OUTFILE / DUMPFILE', () => {
    denied("SELECT * FROM t INTO OUTFILE '/tmp/x'");
    denied("SELECT * FROM t INTO DUMPFILE '/tmp/x'");
  });
  it('LOAD_FILE', () => {
    denied("SELECT LOAD_FILE('/etc/passwd')");
  });
  it('BENCHMARK / SLEEP', () => {
    denied('SELECT BENCHMARK(100000000, MD5(1))');
    denied('SELECT SLEEP(30)');
  });
  it('SELECT ... INTO @var', () => {
    denied('SELECT COUNT(*) INTO @c FROM t');
  });
});

describe('拒绝：MySQL 版本注释（静态检查最易被绕过的一处）', () => {
  it('/*! */ 里的内容 MySQL 会执行，一律拒', () => {
    // 解析器当注释跳过，MySQL 当代码执行 —— 这个不对称是绕过的经典手法
    denied('SELECT 1 /*!50000 UNION SELECT password FROM mysql.user */', 'version_comment');
    denied('/*!DELETE FROM t*/', 'version_comment');
  });
});

describe('拒绝：残缺输入', () => {
  it('未闭合引号', () => denied("SELECT * FROM t WHERE a = 'x", 'unterminated'));
  it('未闭合块注释', () => denied('SELECT 1 /* 没关', 'unterminated'));
  it('空查询', () => {
    denied('', 'empty');
    denied('   \n  ', 'empty');
  });
});

describe('PII 策略', () => {
  it('默认拒绝敏感列', () => {
    denied('SELECT phone FROM users', 'pii_denied');
    denied('SELECT u.email FROM users u', 'pii_denied');
    denied('SELECT id_card FROM users', 'pii_denied');
  });

  it('拒绝文案要引导到聚合写法', () => {
    const r = validateSql('SELECT phone FROM users');
    assert.match(r.reason, /聚合|COUNT/);
  });

  it('聚合查询不碰敏感列则放行', () => {
    ok('SELECT COUNT(*) FROM users WHERE status = 1');
  });

  it('策略可关闭（名单内的人不受限时）', () => {
    ok('SELECT phone FROM users', { piiColumns: [] });
  });

  it('表黑名单', () => {
    denied('SELECT COUNT(*) FROM payroll', 'table_denied', { deniedTables: ['payroll'] });
  });

  it('PII 规则先于表黑名单命中（防线重叠，两者都能独立拦下）', () => {
    // 表名里含 PII 子串时由 pii_denied 先拦；这不是 bug，是两层都生效的表现
    denied('SELECT COUNT(*) FROM internal_secrets', 'pii_denied', { deniedTables: ['internal_secrets'] });
  });

  it('已知取舍：子串匹配会误杀含 PII 词的正常表名', () => {
    // 记录既有行为而非主张它完美 —— 误杀的代价是换个写法，漏放的代价是隐私事故。
    // 真被挡住时用户可以改成不提该表名的聚合写法，或由管理员调 piiColumns。
    denied('SELECT COUNT(*) FROM email_templates', 'pii_denied');
    denied('SELECT COUNT(*) FROM user_addresses', 'pii_denied');
  });

  it('默认清单覆盖常见 PII 列名', () => {
    for (const c of ['phone', 'email', 'id_card', 'password']) {
      assert.ok(DEFAULT_PII_COLUMNS.includes(c), `默认 PII 清单缺 ${c}`);
    }
  });
});

describe('maskLiterals / splitStatements 内部行为', () => {
  it('屏蔽后长度不变（后续按位置切分依赖这一点）', () => {
    const sql = "SELECT 'abc' /* x */ FROM t -- tail";
    assert.equal(maskLiterals(sql).skeleton.length, sql.length);
  });

  it('保留换行（报错时行号才有意义）', () => {
    const { skeleton } = maskLiterals('SELECT 1\n-- 注释\nFROM t');
    assert.equal((skeleton.match(/\n/g) || []).length, 2);
  });

  it('splitStatements 丢弃空段', () => {
    assert.deepEqual(splitStatements('SELECT 1;;  ; SELECT 2'), ['SELECT 1', 'SELECT 2']);
  });
});

describe('返回形状', () => {
  it('放行只返回 ok', () => {
    assert.deepEqual(validateSql('SELECT 1'), { ok: true });
  });
  it('拒绝带 code 与中文 reason（code 供审计统计，reason 给用户看）', () => {
    const r = validateSql('DROP TABLE t');
    assert.equal(r.ok, false);
    assert.equal(typeof r.code, 'string');
    assert.ok(r.reason && /[一-龥]/.test(r.reason), 'reason 应为中文');
  });
});
