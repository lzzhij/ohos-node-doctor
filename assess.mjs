#!/usr/bin/env node
/**
 * assess.mjs —— 鸿蒙内嵌 Node 项目的「可交付性评估」
 *
 * 它做什么：先跑 ohos-node-doctor 拿到技术检查结果，再把每一项翻译成**商业判断**：
 *   · 能不能上线（阻断级 / 风险级 / 优化级）
 *   · 修起来要多少工作量（估的是**工作量**，不是报价 —— 报价见 SERVICES.md）
 *   · 该自己修还是该找人（判据写成明确的规则）
 *   · 交付前还差什么（比如"干净拷贝构建验证"这类硬要求）
 *
 * 为什么需要它：让潜在客户**在不看任何说明的情况下**，自己跑一遍就知道
 * "我卡在哪、代价多大"。这比任何自我介绍都有说服力。
 *
 * 用法：
 *   node assess.mjs <你的鸿蒙工程目录> [--json]
 *
 * 退出码：0 = 无阻断项；1 = 有阻断项（可直接用于 CI 门禁）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const ROOT = ARGV.find(a => !a.startsWith('--'));
const AS_JSON = ARGV.includes('--json');

if (!ROOT) {
  console.error('用法: node assess.mjs <你的鸿蒙工程目录> [--json]');
  process.exit(2);
}
if (!fs.existsSync(ROOT)) { console.error('目录不存在: ' + ROOT); process.exit(2); }

/* ───────────────── 找一个可用的 doctor ─────────────────
 * 优先同目录（本脚本与 doctor 同放时），其次仓库同级目录。
 * 找不到就明确报错并给获取方式 —— 不静默降级。 */
function findDoctor() {
  const cands = [
    path.join(HERE, 'ohos-node-doctor.mjs'),
    path.join(HERE, '..', '..', 'ohos-node-doctor', 'ohos-node-doctor.mjs'),
    path.join(HERE, '..', 'ohos-node-doctor', 'ohos-node-doctor.mjs'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return path.resolve(c);
  return null;
}

const doctor = findDoctor();
if (!doctor) {
  console.error('');
  console.error('  找不到 ohos-node-doctor.mjs。');
  console.error('  获取方式（零依赖，无需安装）：');
  console.error('    git clone https://github.com/lzzhij/ohos-node-doctor');
  console.error('  然后把 assess.mjs 与 ohos-node-doctor.mjs 放在同一目录，或：');
  console.error('    node assess.mjs <工程目录>  # 从 doctor 仓库目录内运行');
  console.error('');
  process.exit(2);
}

/* ───────────────── 把技术检查项翻译成商业判断 ─────────────────
 *
 * impact：blocking（不修则根本跑不起来）/ risk（能跑但会在特定场景崩）/ cost（只是浪费资源）
 * effort：工时量级（小时），用于给"自己修 vs 找人"提供判据
 *         —— 这是**工作量估算**，不是报价。报价见 SERVICES.md。
 */
const IMPACT = {
  'ELF-000': { impact: 'blocking', effort: 2, why: 'libnode.so 不合法，运行时无法加载' },
  'ELF-001': { impact: 'blocking', effort: 8, why: 'PIE 被 dlopen 会在 V8 第一次堆分配就崩；需换库或重建' },
  'ELF-002': { impact: 'blocking', effort: 1, why: '缺依赖库时 dlopen 失败但 ArkTS 侧只拿到 undefined，极难定位' },
  'ELF-003': { impact: 'cost', effort: 0.5, why: '无 SONAME 提示构建方式不规范，通常伴随其它问题' },
  'ELF-004': { impact: 'blocking', effort: 2, why: '商用机校验 ELF 签名，无 .codesign 装上也用不了' },
  'ELF-005': { impact: 'cost', effort: 1, why: '可执行栈是安全加固减分项，上架评审可能被提' },
  'CFG-001': { impact: 'cost', effort: 0.5, why: '不压缩会让 HAP 体积翻倍（实测 151.6→71.8 MB，一个字段的事）' },
  'CFG-002': { impact: 'risk', effort: 2, why: '权限清单与隐私声明不一致会被应用市场驳回' },
  'CFG-003': { impact: 'risk', effort: 1, why: '包名未注册 / versionCode 未递增会导致提审失败' },
  'NAT-000': { impact: 'blocking', effort: 0, why: '找不到宿主壳源码，无法评估线程/SIGSYS/哨兵这些必崩项' },
  'NAT-001': { impact: 'blocking', effort: 4, why: 'dlopen 在 UI 线程会触发 APP_INPUT_BLOCK ANR' },
  'NAT-002': { impact: 'blocking', effort: 6, why: 'io_uring_setup 被 seccomp trap，不处理会崩在 libuv 初始化' },
  'NAT-003': { impact: 'risk', effort: 1, why: 'UV_USE_IO_URING 是第二道保险，且必须在 libuv 初始化前设' },
  'NAT-004': { impact: 'blocking', effort: 2, why: 'argc 含哨兵会让 Node 拿到 NULL 参数，5 毫秒内段错误' },
  'NAT-005': { impact: 'blocking', effort: 3, why: '缺 --expose-internals 会让 internal/modules/* 全部 MODULE_NOT_FOUND' },
  'NAT-006': { impact: 'risk', effort: 3, why: '无崩溃处理器时，沙箱日志读不到，排查会极其被动' },
  'RUN-001': { impact: 'risk', effort: 1, why: '--jitless 会关掉 WebAssembly（fetch 依赖它），取舍需按业务定' },
};

/* ───────────────── 跑 doctor ───────────────── */
let report;
try {
  const out = execFileSync(process.execPath, [doctor, path.resolve(ROOT), '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  report = JSON.parse(out);
} catch (e) {
  const txt = (e.stdout || '').toString();
  try { report = JSON.parse(txt); }
  catch { console.error('doctor 未产出可解析的 JSON：' + (e.message || '')); process.exit(2); }
}

const findings = report.findings || [];
const withImpact = findings.map(f => {
  const m = IMPACT[f.id] || { impact: 'risk', effort: 2, why: '未分类的检查项' };
  return { ...f, ...m };
});

const blocking = withImpact.filter(f => f.sev === 'FAIL' && f.impact === 'blocking');
const otherFail = withImpact.filter(f => f.sev === 'FAIL' && f.impact !== 'blocking');
const risks = withImpact.filter(f => f.sev === 'WARN' && f.impact === 'risk');
const costs = withImpact.filter(f => f.sev === 'WARN' && f.impact === 'cost');
const unknown = withImpact.filter(f => f.sev === 'UNKNOWN');
const passes = withImpact.filter(f => f.sev === 'PASS');

const totalEffort = withImpact.filter(f => f.sev === 'FAIL' || f.sev === 'WARN')
  .reduce((s, f) => s + (f.effort || 0), 0);
const blockingEffort = blocking.reduce((s, f) => s + (f.effort || 0), 0);

/* ───────────────── 输出 ───────────────── */
const L = [];
L.push('');
L.push('════════════════════════════════════════════════════════════');
L.push('  鸿蒙内嵌 Node.js —— 可交付性评估');
L.push('  工程：' + path.resolve(ROOT));
L.push('  时间：' + new Date().toISOString().replace('T', ' ').slice(0, 19));
L.push('════════════════════════════════════════════════════════════');
L.push('');

/* 一句话结论 */
let verdict, verdictWhy;
if (blocking.length > 0) {
  verdict = '✗ 当前状态【无法上线】';
  verdictWhy = `有 ${blocking.length} 项阻断级问题，任一项存在都跑不起来。`;
} else if (otherFail.length > 0) {
  verdict = '△ 能跑，但有未解决项';
  verdictWhy = `无阻断项，但有 ${otherFail.length} 项 FAIL 需要确认。`;
} else if (risks.length > 0) {
  verdict = '○ 基本可用，有风险项';
  verdictWhy = `无 FAIL，但有 ${risks.length} 项风险（在特定场景或上架评审时会暴露）。`;
} else {
  verdict = '✓ 未发现阻断或高风险项';
  verdictWhy = '本工具能查的范围内没有问题。注意：运行期行为仍需真机实测。';
}
L.push('【结论】' + verdict);
L.push('        ' + verdictWhy);
L.push('');

/* 第一层：阻断级 */
L.push('────────────────────────────────────────────────────────────');
L.push('  一、阻断级（不修则根本跑不起来）');
L.push('────────────────────────────────────────────────────────────');
if (blocking.length === 0) {
  L.push('  无。');
} else {
  for (const f of blocking) {
    L.push(`  ✗ [${f.id}] ${f.title}`);
    L.push(`      ${f.detail || ''}`);
    L.push(`      → 影响：${f.why}`);
    if (f.fix) L.push(`      → 修法：${f.fix}`);
    L.push(`      → 量级：约 ${f.effort} 人时`);
    L.push('');
  }
  L.push(`  ⏱ 阻断项合计工作量量级：约 ${blockingEffort} 人时`);
}
L.push('');

/* 第二层：其它 FAIL */
if (otherFail.length) {
  L.push('────────────────────────────────────────────────────────────');
  L.push('  二、其它 FAIL（需确认，未必阻断）');
  L.push('────────────────────────────────────────────────────────────');
  for (const f of otherFail) {
    L.push(`  ✗ [${f.id}] ${f.title}`);
    L.push(`      → ${f.why}    量级：约 ${f.effort} 人时`);
  }
  L.push('');
}

/* 第三层：风险项 */
L.push('────────────────────────────────────────────────────────────');
L.push('  三、风险项（能跑，但会在特定场景暴露）');
L.push('────────────────────────────────────────────────────────────');
if (risks.length === 0) L.push('  无。');
else for (const f of risks) {
  L.push(`  ! [${f.id}] ${f.title}`);
  L.push(`      → ${f.why}`);
  if (f.fix) L.push(`      → 修法：${f.fix}`);
  L.push(`      → 量级：约 ${f.effort} 人时`);
}
L.push('');

/* 第四层：成本项 */
L.push('────────────────────────────────────────────────────────────');
L.push('  四、成本项（不影响正确性，但影响体积/评审）');
L.push('────────────────────────────────────────────────────────────');
if (costs.length === 0) L.push('  无。');
else for (const f of costs) {
  L.push(`  · [${f.id}] ${f.title}`);
  L.push(`      → ${f.why}    量级：约 ${f.effort} 人时`);
}
L.push('');

/* 第五层：无法自动判断的 */
if (unknown.length) {
  L.push('────────────────────────────────────────────────────────────');
  L.push('  五、无法自动判断（需人工确认）');
  L.push('────────────────────────────────────────────────────────────');
  for (const f of unknown) L.push(`  ? [${f.id}] ${f.title} —— ${f.detail || ''}`);
  L.push('');
}

/* 汇总与建议 */
L.push('════════════════════════════════════════════════════════════');
L.push('  汇总');
L.push('════════════════════════════════════════════════════════════');
L.push('');
L.push(`  阻断 ${blocking.length} · 其它 FAIL ${otherFail.length} · 风险 ${risks.length} · 成本 ${costs.length} · 未知 ${unknown.length} · 通过 ${passes.length}`);
L.push(`  需处理项合计工作量量级：约 ${totalEffort} 人时`);
L.push('');
L.push('  【该自己修还是找人？】判据（阈值可按你的情况调）');
if (blocking.length === 0 && risks.length === 0) {
  L.push('    → 你自己能处理。建议先跑一遍真机，用我们笔记里的四条观测通道抓日志。');
} else if (blockingEffort <= 4 && risks.length <= 2) {
  L.push('    → 自己修更划算（阻断项工作量量级 ≤ 4 人时）。');
  L.push('      上面每一项都给了修法，照做即可。');
} else if (blockingEffort <= 16) {
  L.push('    → 临界区。若团队已有人在啃这块，建议先花半天把上面的修法逐条验一遍；');
  L.push('      若已卡超过一周，找人诊断通常比继续试错便宜。');
} else {
  L.push('    → 建议找人。阻断项工作量量级已超过 16 人时，且这类问题的试错成本是非线性的');
  L.push('      （症状大多不报错，只能靠观测通道定位）。');
}
L.push('');
L.push('  【交付前还差什么】（本工具查不到、但交付必须做的）');
L.push('    □ 在一份【干净拷贝】上完整构建一次（证明不依赖本机状态）');
L.push('    □ 用【同一份产物】在目标机型上真机跑通（"能构建"≠"能运行"）');
L.push('    □ 若准备上架：权限清单与隐私声明逐条核对');
L.push('');
L.push('  【关于费用】');
L.push('    上面的"人时"是【工作量量级】，不是报价。');
L.push('    需要外部支持时的形态与起价：https://github.com/lzzhij/harmonyos-node-notes/blob/main/SERVICES.md');
L.push('    免费资料（22 条症状索引 + 排障总表）：https://github.com/lzzhij/harmonyos-node-notes');
L.push('');
L.push('  【本工具不检查什么】');
L.push('    运行期行为 —— seccomp 实际拦截、W^X、后台冻结、childProcessManager 支持情况 ——');
L.push('    **必须上真机实测**。本工具不会假装知道，查不了的项明确标 UNKNOWN。');
L.push('');

if (AS_JSON) {
  console.log(JSON.stringify({
    root: path.resolve(ROOT),
    verdict: blocking.length ? 'blocked' : (otherFail.length ? 'has-failures' : (risks.length ? 'usable-with-risks' : 'clean')),
    counts: { blocking: blocking.length, otherFail: otherFail.length, risks: risks.length, costs: costs.length, unknown: unknown.length, passes: passes.length },
    effortHours: { blocking: blockingEffort, total: totalEffort },
    recommendation: blockingEffort <= 4 && risks.length <= 2 ? 'self-fix' : (blockingEffort <= 16 ? 'borderline' : 'seek-help'),
    items: withImpact.map(f => ({ id: f.id, sev: f.sev, impact: f.impact, effort: f.effort, title: f.title, why: f.why, fix: f.fix || null })),
  }, null, 2));
} else {
  console.log(L.join('\n'));
}

process.exit(blocking.length > 0 ? 1 : 0);
