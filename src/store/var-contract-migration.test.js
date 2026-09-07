import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateConfig, MIGRATION_FLAG, MIGRATION_VERSION } from './var-contract-migration.js';

const cfgWith = (variables) => ({ id: 'ac_1', name: '清理账号数据', variables });

describe('migrateConfig —— 存量 env/phone 补 preset', () => {
  it('给 env / phone 补上对应 preset', () => {
    const { config, changed } = migrateConfig(
      cfgWith([
        { name: 'env', label: '环境', required: true },
        { name: 'phone', label: '手机号', required: true, persistent: true },
      ]),
    );
    assert.equal(changed, true);
    assert.equal(config.variables[0].preset, 'env');
    assert.equal(config.variables[1].preset, 'phone');
    assert.equal(config.variables[1].persistent, true, '原有字段不得丢失');
  });

  it('其它变量名不动（迁移只修这两个已知的历史硬编码）', () => {
    const { config } = migrateConfig(cfgWith([{ name: 'region' }, { name: '订单号' }]));
    assert.equal(config.variables[0].preset, undefined);
    assert.equal(config.variables[1].preset, undefined);
  });

  it('已自带抽取声明的变量不动（用户显式配置优先）', () => {
    const { config } = migrateConfig(
      cfgWith([
        { name: 'env', enum: ['a', 'b'] },
        { name: 'phone', pattern: '\\d+' },
        { name: 'env2', preset: 'env' },
      ]),
    );
    assert.equal(config.variables[0].preset, undefined);
    assert.deepEqual(config.variables[0].enum, ['a', 'b']);
    assert.equal(config.variables[1].preset, undefined);
  });
});

/**
 * 标记位是本次设计的关键取舍：若每次启动都按变量名重扫补 preset，用户在设置页
 * 手动删掉 `preset: "env"` 后一重启就被加回去 —— 等于这个字段用户改不掉，
 * 而 UI 上又摆着让他改。这批用例把「迁移只发生一次」钉死。
 */
describe('幂等 —— 标记位而非每次重扫', () => {
  it('第二次迁移不再改动（changed=false，不写盘）', () => {
    const first = migrateConfig(cfgWith([{ name: 'env' }]));
    assert.equal(first.changed, true);
    const second = migrateConfig(first.config);
    assert.equal(second.changed, false);
  });

  it('用户删掉 preset 后再迁移，**不得**被加回来', () => {
    const first = migrateConfig(cfgWith([{ name: 'env' }])).config;
    // 模拟用户在设置页把 preset 去掉
    const edited = { ...first, variables: [{ name: 'env' }] };
    const again = migrateConfig(edited);
    assert.equal(again.changed, false);
    assert.equal(again.config.variables[0].preset, undefined, 'preset 被强行加回 = 用户改不掉');
  });

  it('一个变量都没补也要打标（否则每次启动都重扫，且埋下上一条的坑）', () => {
    const { config, changed } = migrateConfig(cfgWith([{ name: 'region' }]));
    assert.equal(changed, true);
    assert.equal(config[MIGRATION_FLAG], MIGRATION_VERSION);
    assert.equal(migrateConfig(config).changed, false);
  });

  it('后来导入的旧配置（无标记）仍会被迁移一次', () => {
    const imported = cfgWith([{ name: 'env' }]); // 没有标记
    assert.equal(migrateConfig(imported).changed, true);
  });
});

describe('健壮性', () => {
  it('非对象输入原样返回，不炸', () => {
    for (const bad of [null, undefined, 'x', 42]) {
      const r = migrateConfig(bad);
      assert.equal(r.changed, false);
      assert.equal(r.config, bad);
    }
  });

  it('variables 缺失或非数组不炸，仍打标', () => {
    for (const vars of [undefined, null, 'x']) {
      const { config, changed } = migrateConfig({ id: 'a', variables: vars });
      assert.equal(changed, true);
      assert.equal(config[MIGRATION_FLAG], MIGRATION_VERSION);
    }
  });

  it('变量数组里混入非对象元素不炸', () => {
    const { config } = migrateConfig(cfgWith([null, 'x', { name: 'env' }]));
    assert.equal(config.variables[2].preset, 'env');
  });

  it('不就地改原对象（store 的读改写依赖不可变语义）', () => {
    const orig = cfgWith([{ name: 'env' }]);
    migrateConfig(orig);
    assert.equal(orig.variables[0].preset, undefined);
    assert.equal(orig[MIGRATION_FLAG], undefined);
  });
});
