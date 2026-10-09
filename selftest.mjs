#!/usr/bin/env node
/**
 * selftest.mjs —— ohos-node-doctor 的自检：现场构造样本，断言工具必须报出预期结论。
 *
 * 为什么要它：一个只会说 OK 的体检工具等于没有。本脚本从两个方向验证：
 *   · 健康样本 → 必须全项通过（不含致命 FAIL）
 *   · 坏样本   → 必须准确报出对应 FAIL/WARN
 *
 * ★ 样本构造器只有一份，放在 fixtures.mjs，由本文件 import。
 *   早期版本在本文件里内联了一份副本，结果"修了 fixtures 却没修到自检用的那份"，
 *   在一个假失败上白白打转很久。**同一份逻辑只能有一个定义。**
 *
 * 用法：node selftest.mjs
 *       DOCTOR_REAL_PROJECT=<鸿蒙工程路径> node selftest.mjs   # 追加真实产物回归
 * 退出码：0 = 全部断言通过；1 = 有断言失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProject, GOOD_CPP, BAD_CPP, GOOD_MODULE, BAD_MODULE } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.join(HERE, 'ohos-node-doctor.mjs');

let pass = 0, fail = 0;
const ok = (m) => { console.log('  \u2713 ' + m); pass++; };
const no = (m) => { console.log('  \u2717 ' + m); fail++; };

function runDoctor(root) {
  try {
    return JSON.parse(execFileSync(process.execPath, [DOCTOR, root, '--json'], { encoding: 'utf8' }));
  } catch (e) {
    // 有 FAIL 时退出码为 1，stdout 里仍有完整 JSON
    const txt = (e.stdout || '').toString();
    try { return JSON.parse(txt); }
    catch { throw new Error('doctor 未产出可解析的 JSON：' + (e.message || '')); }
  }
}
const find = (r, id) => (r.findings || []).find(f => f.id === id);

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ohos-doctor-selftest-'));
  console.log('');
  console.log('══════ ohos-node-doctor 自检 ══════');
  console.log('  临时目录: ' + tmp);
  console.log('');

  // ── 样本 1：健康 ──
  console.log('样本 1：健康工程（应无 FAIL）');
  const good = makeProject(path.join(tmp, 'good'), {
    elfOpts: { eType: 3, withInterp: false, execStack: false },
    needed: ['libc++_shared.so', 'libc.so'],
    extraLibs: ['libc++_shared.so', 'libnode_ctl.so'],
    moduleJson: GOOD_MODULE,
    hostCpp: GOOD_CPP,
  });
  const r1 = runDoctor(good);
  const fails1 = r1.findings.filter(f => f.sev === 'FAIL');
  if (fails1.length === 0) ok('无 FAIL（' + r1.findings.filter(f => f.sev === 'PASS').length + ' 项 PASS）');
  else no('出现意外 FAIL: ' + fails1.map(f => f.id + ' ' + f.title).join('; '));

  if (find(r1, 'ELF-001')?.sev === 'PASS') ok('ELF-001 判定为真共享库（无 PT_INTERP）');
  else no('ELF-001 应为 PASS，实际 ' + find(r1, 'ELF-001')?.sev);

  if (find(r1, 'ELF-002')?.sev === 'PASS') ok('ELF-002 依赖齐备（成功读出了 NEEDED）');
  else no('ELF-002 应为 PASS，实际 ' + find(r1, 'ELF-002')?.sev + ' / ' + find(r1, 'ELF-002')?.title);

  for (const id of ['NAT-001', 'NAT-002', 'NAT-005']) {
    if (find(r1, id)?.sev === 'PASS') ok(id + ' 已识别宿主壳实现');
    else no(id + ' 应为 PASS，实际 ' + find(r1, id)?.sev + '（' + find(r1, id)?.title + '）');
  }
  if (find(r1, 'CFG-001')?.sev === 'PASS') ok('CFG-001 识别到 compressNativeLibs');
  else no('CFG-001 应为 PASS，实际 ' + find(r1, 'CFG-001')?.sev);

  // ── 样本 2：坏 ──
  console.log('');
  console.log('样本 2：坏工程（PIE + 缺 libc++_shared.so + 坏宿主壳 + 无压缩配置）');
  const bad = makeProject(path.join(tmp, 'bad'), {
    elfOpts: { eType: 2, withInterp: true, execStack: true },
    needed: ['libc++_shared.so', 'libc.so'],
    extraLibs: [],                       // 故意不放 libc++_shared.so
    moduleJson: BAD_MODULE,
    hostCpp: BAD_CPP,
  });
  const r2 = runDoctor(bad);

  for (const [id, what] of Object.entries({
    'ELF-001': 'PIE（带 PT_INTERP）',
    'ELF-002': '依赖库缺失',
    'NAT-001': '未放到独立线程',
    'NAT-002': '未装 SIGSYS shim',
    'NAT-005': '缺 --expose-internals',
  })) {
    const f = find(r2, id);
    if (f?.sev === 'FAIL') ok(id + ' 准确报出 FAIL（' + what + '）');
    else no(id + ' 应为 FAIL，实际 ' + (f ? f.sev + ' / ' + f.title : '未产出该检查项'));
  }
  for (const [id, what] of Object.entries({ 'ELF-005': '可执行栈', 'CFG-001': '未开 compressNativeLibs' })) {
    const f = find(r2, id);
    if (f?.sev === 'WARN') ok(id + ' 准确报出 WARN（' + what + '）');
    else no(id + ' 应为 WARN，实际 ' + (f ? f.sev : '未产出'));
  }

  // ── 样本 3：反向断言 ──
  console.log('');
  console.log('样本 3：反向断言（防止工具退化成只会说 OK）');
  if (r2.findings.some(f => f.sev === 'FAIL')) ok('坏样本确实产出了 FAIL（工具没有哑掉）');
  else no('坏样本竟然没有任何 FAIL —— 工具已失效');
  if (JSON.stringify(r1.findings) !== JSON.stringify(r2.findings)) ok('两个样本的结论不同（判定确实依赖输入）');
  else no('两个样本结论完全相同 —— 判定可能与输入无关');

  // ── 样本 4：真实产物（若指定）──
  const real = process.env.DOCTOR_REAL_PROJECT;
  if (real && fs.existsSync(real)) {
    console.log('');
    console.log('样本 4：真实工程 ' + real);
    const r3 = runDoctor(real);
    const f3 = r3.findings.filter(f => f.sev === 'FAIL');
    if (f3.length === 0) ok('真实工程无 FAIL');
    else no('真实工程出现 FAIL: ' + f3.map(f => f.id).join(', '));
    if (find(r3, 'ELF-002')?.sev === 'PASS') ok('真实工程依赖齐备（ELF-002 PASS）');
    else no('真实工程 ELF-002 应为 PASS');
  } else {
    console.log('');
    console.log('样本 4：跳过（设 DOCTOR_REAL_PROJECT=<工程路径> 可对真实产物回归）');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  console.log('──────────────────────────────────────────');
  console.log(`  断言通过 ${pass} · 失败 ${fail}`);
  console.log('──────────────────────────────────────────');
  console.log('');
  process.exit(fail > 0 ? 1 : 0);
}

main();
