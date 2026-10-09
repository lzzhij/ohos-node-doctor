#!/usr/bin/env node
/**
 * assess-selftest.mjs —— 验证 assess.mjs 真的能查出问题（而不是只会打印好看的话）
 *
 * 为什么需要：一个"永远报告一切正常"的工具和一个好工具，从输出上看不出区别。
 * 所以必须有一个**已知是坏的**样本，断言它**必须被查出**。
 *
 * 断言分三类：
 *   A. 坏样本（fixtures/broken-pie）必须报出指定的阻断项，且退出码为 1
 *   B. JSON 输出必须结构正确、与文本输出一致
 *   C. 好样本（若系统上有）必须不报阻断项 —— 防止"什么都报错"的假阳性
 *
 * 用法：node assess-selftest.mjs [好样本路径]
 *   好样本可用环境变量 ASSESS_GOOD_SAMPLE 指定；找不到就跳过 C 类（并明确说明）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSESS = path.join(HERE, 'assess.mjs');
const BAD = path.join(HERE, 'fixtures', 'broken-pie');
const GOOD = process.argv[2] || process.env.ASSESS_GOOD_SAMPLE || null;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else { console.log(`  \u2717 ${name}${extra ? '  (' + extra + ')' : ''}`); fail++; }
};

function run(dir, args = []) {
  try {
    const out = execFileSync(process.execPath, [ASSESS, dir, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '').toString() };
  }
}

console.log('');
console.log('=== assess.mjs 自测 ===');
console.log('');

/* ── A. 坏样本 ── */
console.log('A. 坏样本 fixtures/broken-pie 必须被查出');
if (!fs.existsSync(BAD)) {
  check('fixtures/broken-pie 存在', false, '缺失');
} else {
  // 断言坏样本本身确实"坏"：假 libnode.so 必须真的带 PT_INTERP
  const elf = fs.readFileSync(path.join(BAD, 'entry', 'libs', 'arm64-v8a', 'libnode.so'));
  check('坏样本的假 libnode.so 确实是 ET_DYN', elf.readUInt16LE(16) === 3);
  check('坏样本的假 libnode.so 确实带 PT_INTERP', elf.readUInt32LE(64) === 3);

  const r = run(BAD);
  check('退出码为 1（有阻断项）', r.code === 1, '实际 ' + r.code);
  check('报出 ELF-001（PIE 版 libnode.so）', /ELF-001/.test(r.out));
  check('报出 NAT-005（缺 --expose-internals）', /NAT-005/.test(r.out));
  check('结论为"无法上线"', /无法上线/.test(r.out));
  check('列出了阻断级小计工作量', /阻断项合计工作量量级/.test(r.out));
  check('给出"自己修还是找人"的判据', /该自己修还是找人/.test(r.out));
  check('给出"交付前还差什么"清单', /交付前还差什么/.test(r.out));
  check('明确标注不检查运行期行为', /不检查什么[\s\S]*真机实测/.test(r.out));
  check('费用与报价做了区分', /不是报价/.test(r.out));
}

/* ── B. JSON 输出 ── */
console.log('');
console.log('B. JSON 输出结构');
if (fs.existsSync(BAD)) {
  const { out } = run(BAD, ['--json']);
  let j = null;
  try { j = JSON.parse(out); } catch { /* */ }
  check('产出了合法 JSON', j !== null);
  if (j) {
    check('verdict = blocked', j.verdict === 'blocked', '实际 ' + j.verdict);
    check('counts.blocking >= 2', j.counts.blocking >= 2, '实际 ' + j.counts.blocking);
    check('effortHours.blocking > 0', j.effortHours.blocking > 0);
    check('recommendation 是已知取值', ['self-fix', 'borderline', 'seek-help'].includes(j.recommendation), '实际 ' + j.recommendation);
    check('items 数组非空且每项有 id/sev/impact', Array.isArray(j.items) && j.items.length > 0 && j.items.every(i => i.id && i.sev && i.impact));
    check('JSON 里没有混入文本输出', !/^═/m.test(out));
  }
}

/* ── C. 好样本（防假阳性）── */
console.log('');
console.log('C. 好样本不得报出阻断项（防"什么都报错"）');
if (!GOOD || !fs.existsSync(GOOD)) {
  console.log('  \u2013 跳过：未提供好样本。');
  console.log('    设置方式：node assess-selftest.mjs <你的已跑通工程目录>');
  console.log('    或：ASSESS_GOOD_SAMPLE=<目录> node assess-selftest.mjs');
} else {
  const r = run(GOOD);
  check('好样本退出码为 0', r.code === 0, '实际 ' + r.code);
  check('好样本不报"无法上线"', !/无法上线/.test(r.out));
  check('好样本不报 ELF-001', !/ELF-001/.test(r.out));
  const { out } = run(GOOD, ['--json']);
  let j = null; try { j = JSON.parse(out); } catch { /* */ }
  check('好样本 JSON verdict 不是 blocked', j && j.verdict !== 'blocked', j ? j.verdict : 'JSON 解析失败');
}

console.log('');
console.log(`=== ${pass} 通过 · ${fail} 失败 ===`);
console.log('');
process.exit(fail === 0 ? 0 : 1);
