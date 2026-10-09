#!/usr/bin/env node
/**
 * ohos-node-doctor —— 鸿蒙 App 内嵌 Node.js 项目的「本机可验证」体检工具
 *
 * 它只做一件事：**把「上机才会崩」的六个硬约束，变成在本机就能查出来的体检项。**
 * 每条结论都附：判据 → 证据 → 修法 → 验证命令。
 * 不猜、不评分粉饰：查不了的项目明确标 UNKNOWN，而不是假装通过。
 *
 * 用法：
 *   node ohos-node-doctor.mjs <鸿蒙工程根目录>
 *   node ohos-node-doctor.mjs F:\path\to\harmony --json      # 机器可读
 *   node ohos-node-doctor.mjs <dir> --llvm <llvm-readelf.exe># 指定 LLVM（默认自动找）
 *
 * 零依赖：纯 JS 自己解析 ELF（不依赖 shell、不依赖 llvm 是否安装）。
 * LLVM 只在需要看符号/动态段时作为增强，缺了也能跑。
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const ROOT = argv.find(a => !a.startsWith('--')) || '.';
const AS_JSON = argv.includes('--json');
const LLVM_ARG = (() => { const i = argv.indexOf('--llvm'); return i >= 0 ? argv[i + 1] : null; })();

const R = [];   // 结果集
const add = (id, sev, title, detail, fix, evidence) =>
  R.push({ id, sev, title, detail, fix, evidence: evidence ?? null });

const SEV = { FAIL: 3, WARN: 2, INFO: 1, PASS: 0, UNKNOWN: 1 };

/* ============================ ELF 解析（纯 JS） ============================ */

/** 解析 ELF 头 + program headers，找出 e_type / PT_INTERP / PT_DYNAMIC 等。 */
function parseElf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const hdr = Buffer.alloc(64);
    fs.readSync(fd, hdr, 0, 64, 0);
    if (hdr[0] !== 0x7f || hdr.toString('ascii', 1, 4) !== 'ELF') return { error: '不是 ELF 文件' };

    const is64 = hdr[4] === 2;
    const little = hdr[5] === 1;
    if (!little) return { error: '仅支持小端 ELF' };

    const e_type = is64 ? hdr.readUInt16LE(16) : hdr.readUInt16LE(16);
    const e_machine = hdr.readUInt16LE(18);
    const phoff = is64 ? Number(hdr.readBigUInt64LE(32)) : hdr.readUInt32LE(28);
    const phentsize = hdr.readUInt16LE(is64 ? 54 : 42);
    const phnum = hdr.readUInt16LE(is64 ? 56 : 44);
    const shoff = is64 ? Number(hdr.readBigUInt64LE(40)) : hdr.readUInt32LE(32);
    const shentsize = hdr.readUInt16LE(is64 ? 58 : 46);
    const shnum = hdr.readUInt16LE(is64 ? 60 : 48);
    const shstrndx = hdr.readUInt16LE(is64 ? 62 : 50);

    const PH = [];
    for (let i = 0; i < phnum; i++) {
      const b = Buffer.alloc(phentsize);
      fs.readSync(fd, b, 0, phentsize, phoff + i * phentsize);
      PH.push({
        type: b.readUInt32LE(0),
        // 32 位 ELF 的 p_flags 在偏移 24，64 位在偏移 4 —— 早前这里写错过，导致
        // GNU_STACK 权限判断恒为 false（一条永不触发的死检查）。
        flags: is64 ? b.readUInt32LE(4) : b.readUInt32LE(24),
        offset: is64 ? Number(b.readBigUInt64LE(8)) : b.readUInt32LE(4),
        vaddr: is64 ? Number(b.readBigUInt64LE(16)) : b.readUInt32LE(8),
        filesz: is64 ? Number(b.readBigUInt64LE(32)) : b.readUInt32LE(16),
      });
    }

    // ★ 边界检查：体检工具遇到损坏/畸形 ELF 必须【报错】而不是崩。
    //   早期版本直接 Buffer.alloc(dyn.filesz)，遇到损坏样本会抛 ERR_OUT_OF_RANGE。
    const fileSize = fs.fstatSync(fd).size;
    const sane = (off, len) =>
      Number.isFinite(off) && Number.isFinite(len) && off >= 0 && len >= 0 &&
      off <= fileSize && len <= fileSize && off + len <= fileSize;

    // 读动态段 → NEEDED / SONAME / RPATH
    const dyn = PH.find(p => p.type === 2);               // PT_DYNAMIC
    let needed = [], soname = null, rpath = null;
    if (dyn && sane(dyn.offset, dyn.filesz) && dyn.filesz > 0) {
      const entsize = 16;
      const count = Math.floor(dyn.filesz / entsize);
      const dbuf = Buffer.alloc(dyn.filesz);
      fs.readSync(fd, dbuf, 0, dyn.filesz, dyn.offset);
      const strtabEntry = [];
      const tags = [];
      for (let i = 0; i < count; i++) {
        const tag = is64 ? Number(dbuf.readBigUInt64LE(i * entsize)) : dbuf.readUInt32LE(i * entsize);
        const val = is64 ? Number(dbuf.readBigUInt64LE(i * entsize + 8)) : dbuf.readUInt32LE(i * entsize + 4);
        tags.push({ tag, val });
        if (tag === 5) strtabEntry.push(val);              // DT_STRTAB
      }
      const strtabVaddr = strtabEntry[0];
      // ★★ 关键不变式：只有满足 (p.vaddr - p.offset) ≡ 0 (mod 页大小) 的 PT_LOAD
      //    才能用来做「虚拟地址 → 文件偏移」换算。真实 ELF 里所有 PT_LOAD 都满足；
      //    但畸形/构造的 ELF 可能不满足——此时若仍用第一个命中的段，
      //    算出来的偏移会严重错位、字符串读不出来，最终**静默**得到空依赖列表，
      //    让 ELF-002 误报 PASS。宁可明确报错，也不要给一个"看起来通过"的结论。
      const PAGE = 4096;
      const aligned = (p) => ((p.vaddr - p.offset) % PAGE + PAGE) % PAGE === 0;
      const strSeg = PH.find(p => Number.isFinite(strtabVaddr) &&
        strtabVaddr >= p.vaddr && strtabVaddr < p.vaddr + p.filesz && sane(p.offset, p.filesz) && aligned(p));
      const readStr = (off) => {
        if (!strSeg) return null;
        if (!Number.isFinite(off) || off < 0) return null;
        const base = strSeg.offset + (strtabVaddr - strSeg.vaddr) + off;
        if (!sane(base, 1)) return null;
        const chunk = Buffer.alloc(256);
        let n = 0;
        try { n = fs.readSync(fd, chunk, 0, 256, base); } catch { return null; }
        const z = chunk.subarray(0, n).indexOf(0);
        return chunk.toString('utf8', 0, z < 0 ? n : z);
      };
      for (const { tag, val } of tags) {
        if (tag === 1) needed.push(readStr(val));          // DT_NEEDED
        if (tag === 14) soname = readStr(val);             // DT_SONAME
        if (tag === 15 || tag === 29) rpath = readStr(val);
      }
      needed = needed.filter(Boolean);
    }

    // section headers → 找 .codesign
    let sections = [];
    if (shoff && shnum && sane(shoff, shnum * shentsize) && shstrndx < shnum) {
      const shstr = (() => {
        const b = Buffer.alloc(shentsize);
        fs.readSync(fd, b, 0, shentsize, shoff + shstrndx * shentsize);
        return { off: is64 ? Number(b.readBigUInt64LE(24)) : b.readUInt32LE(16),
                 size: is64 ? Number(b.readBigUInt64LE(32)) : b.readUInt32LE(20) };
      })();
      if (sane(shstr.off, shstr.size) && shstr.size > 0) {
        const names = Buffer.alloc(shstr.size);
        fs.readSync(fd, names, 0, shstr.size, shstr.off);
        for (let i = 0; i < shnum; i++) {
          const b = Buffer.alloc(shentsize);
          fs.readSync(fd, b, 0, shentsize, shoff + i * shentsize);
          const nameOff = b.readUInt32LE(0);
          if (nameOff >= names.length) { sections.push(''); continue; }
          const z = names.subarray(nameOff).indexOf(0);
          sections.push(names.toString('utf8', nameOff, z < 0 ? names.length : nameOff + z));
        }
      }
    }

    return {
      is64, e_type, e_machine, phnum,
      hasInterp: PH.some(p => p.type === 3),
      needed, soname, rpath, sections,
      // PT_GNU_STACK = 0x6474e551；PF_X = 0x1。可执行栈在现代目标上是危险信号，
      // 鸿蒙侧并不因此拒绝加载，但值得提示（尤其是自建产物）。
      execStack: PH.some(p => p.type === 0x6474e551 && (p.flags & 0x1) !== 0),
      hasGnuStack: PH.some(p => p.type === 0x6474e551),
    };
  } finally { fs.closeSync(fd); }
}

const MACHINE = { 183: 'AArch64', 62: 'x86-64', 40: 'ARM', 3: 'x86' };

/* ============================ 定位工程结构 ============================ */

function findFiles(root, names, maxDepth = 6) {
  const hits = [];
  const walk = (dir, d) => {
    if (d > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'oh_modules' || e.name === '.git') continue;
        walk(p, d + 1);
      } else if (names.includes(e.name)) hits.push(p);
    }
  };
  walk(root, 0);
  return hits;
}

/* ============================ 体检项 ============================ */

function checkLibnode(root) {
  const libsDirs = findFiles(root, ['libnode.so'], 8);
  if (!libsDirs.length) {
    add('ELF-001', 'UNKNOWN', '没找到 libnode.so',
      '工程里没有名为 libnode.so 的文件，无法检查「真共享库」这条最致命的约束。',
      '把它放进 entry/libs/<abi>/libnode.so 后重跑本工具。');
    return null;
  }
  const so = libsDirs[0];
  const info = parseElf(so);
  if (info.error) {
    add('ELF-000', 'FAIL', 'libnode.so 不是合法 ELF', info.error, '确认下载/构建产物没有损坏。', so);
    return null;
  }

  const sizeMB = (fs.statSync(so).size / 1048576).toFixed(2);

  // ★ 硬约束 1：真共享库（ET_DYN 且无 PT_INTERP）
  if (info.hasInterp) {
    add('ELF-001', 'FAIL', 'libnode.so 带 PT_INTERP —— 是 PIE，dlopen 必崩',
      `e_type=${info.e_type} (DYN) 但存在 PT_INTERP 段。被 dlopen 后会把 local-exec 的 %fs TLS 别名到宿主 App 的 TLS 块，` +
      `V8 的 thread_local current_per_thread_assert_data 读到垃圾，release 版 CHECK AllowHeapAllocationInRelease 会在 Isolate::Initialize 的第一次堆分配就触发。`,
      '换成 --shared 构建的产物（PIC + 动态 TLS + SONAME）。校验：llvm-readelf -l libnode.so | grep -c INTERP 必须为 0。',
      so);
  } else {
    add('ELF-001', 'PASS', 'libnode.so 是真共享库（无 PT_INTERP）',
      `e_type=${info.e_type} (ET_DYN)、无 PT_INTERP、Machine=${MACHINE[info.e_machine] || info.e_machine}、大小 ${sizeMB} MB。` +
      `这条是 dlopen 能成功的前提。`, null, so);
  }

  // ★ 硬约束 2：NEEDED 里的库是否齐全
  const need = info.needed || [];
  const ABINAME = path.basename(path.dirname(so));
  const abiDir = path.dirname(so);
  const present = new Set();
  try { for (const f of fs.readdirSync(abiDir)) present.add(f); } catch {}

  const sysLibs = new Set(['libc.so', 'libm.so', 'libdl.so', 'libz.so', 'liblog.so', 'libhilog.so', 'ld-linux-aarch64.so.1']);
  const missing = need.filter(n => !sysLibs.has(n) && !present.has(n));
  if (missing.length) {
    add('ELF-002', 'FAIL', `libnode.so 依赖的 ${missing.length} 个库不在 ${ABINAME}/ 里`,
      `NEEDED 声明了 [${need.join(', ')}]，但 ${ABINAME}/ 目录下缺少 [${missing.join(', ')}]。` +
      `注意：漏掉 libc++_shared.so 时的症状【不是报错】—— dlopen 失败而 ArkTS 侧只拿到 undefined，很容易被误判成"类型声明没接上"。`,
      `从 NDK 取 native/llvm/lib/aarch64-linux-ohos/libc++_shared.so 放进 ${ABINAME}/。`,
      so);
  } else {
    add('ELF-002', 'PASS', 'libnode.so 的运行期依赖在同一 ABI 目录里齐备',
      `NEEDED=[${need.join(', ')}]；本地已具备 [${[...present].filter(f => f.endsWith('.so')).join(', ') || '（无其它 .so）'}]。`,
      null, so);
  }

  // SONAME（信息项）
  if (info.soname) {
    add('ELF-003', 'INFO', `SONAME = ${info.soname}`, '有 SONAME 说明是按共享库构建的，正常。', null, so);
  }

  // ★ 商用机签名校验（.codesign section）
  const hasCodesign = (info.sections || []).some(s => /codesign|\.sign/i.test(s));
  if (!hasCodesign) {
    add('ELF-004', 'WARN', 'libnode.so 里没有 .codesign 段',
      '鸿蒙商用版对 ELF 做代码签名校验，没有 .codesign section 的库在商用机上可能装上也用不了（开发机常无感）。',
      '用 OHOS 工具链签名：binary-sign-tool sign --in-file libnode.so --out-file libnode.signed.so --selfSign 1（注意要【在 strip 之后】签）。',
      so);
  } else {
    add('ELF-004', 'PASS', 'libnode.so 含签名段', '已有 .codesign 相关 section。', null, so);
  }

  // 可执行栈（危险信号，但不影响加载）
  if (info.execStack) {
    add('ELF-005', 'WARN', 'libnode.so 标记了可执行栈（PT_GNU_STACK 带 PF_X）',
      '自建产物常见此问题；鸿蒙不会因此拒绝加载，但它是安全加固的减分项。',
      '链接时加 -Wl,-z,noexecstack 重新构建。', so);
  } else if (info.hasGnuStack) {
    add('ELF-005', 'PASS', '栈不可执行（PT_GNU_STACK 无 PF_X）', '符合常规安全加固预期。', null, so);
  }

  return { so, info };
}

function checkConfig(root) {
  const mods = findFiles(root, ['module.json5'], 6);
  if (!mods.length) {
    add('CFG-001', 'UNKNOWN', '没找到 module.json5', '无法检查 compressNativeLibs 等打包配置。', '确认传入的是鸿蒙工程根目录（含 entry/src/main/module.json5）。');
    return;
  }
  const modFile = mods[0];
  const txt = (() => { try { return fs.readFileSync(modFile, 'utf8'); } catch { return ''; } })();

  // ★ compressNativeLibs 必须在 module 级（实测能省一半体积）
  const hasCompress = /"compressNativeLibs"\s*:\s*true/.test(txt);
  if (hasCompress) {
    add('CFG-001', 'PASS', 'compressNativeLibs 已开启（module 级）',
      '实测效果：libnode.so 120.9 MB → 43.0 MB，HAP 总大小 151.6 MB → 71.8 MB（-53%）。', null, modFile);
  } else {
    add('CFG-001', 'WARN', 'module.json5 里没有 compressNativeLibs: true',
      '不开它，HAP 里的 .so 会以 STORED（未压缩）方式打包，libnode.so 的 120 MB 会原样进包。',
      '在 entry/src/main/module.json5 的【module 级】加 "compressNativeLibs": true 与 "extractNativeLibs": true。' +
      '⚠ 注意：写进 build-profile.json5 的 buildOption / buildOption.nativeLib 会被 schema 拒绝，且【不告诉你正确位置】。',
      modFile);
  }

  // 权限（信息项，便于与隐私声明核对）
  const perms = [...txt.matchAll(/"(ohos\.permission\.[A-Z_]+)"/g)].map(m => m[1]);
  const uniq = [...new Set(perms)];
  add('CFG-002', 'INFO', `已申请权限：${uniq.length ? uniq.join(', ') : '（无）'}`,
    '上线时这份清单必须与隐私声明里写的完全一致，否则会被驳回。', null, modFile);

  // bundleName / 版本号
  const appJson = findFiles(root, ['app.json5'], 5)[0];
  if (appJson) {
    const a = fs.readFileSync(appJson, 'utf8');
    const bn = (a.match(/"bundleName"\s*:\s*"([^"]+)"/) || [])[1] || '?';
    const vc = (a.match(/"versionCode"\s*:\s*(\d+)/) || [])[1] || '?';
    const vn = (a.match(/"versionName"\s*:\s*"([^"]+)"/) || [])[1] || '?';
    add('CFG-003', 'INFO', `包名 ${bn} · 版本 ${vn} (code ${vc})`,
      '每次重传应用市场都要递增 versionCode；上架前该包名需在 AGC 完成注册并申请发布 Profile。', null, appJson);
  }
}

function checkNativeShell(root) {
  const cpps = findFiles(root, ['node_ctl.cpp', 'node_launcher.c'], 8)
    .concat(findFiles(root, ['node_ctl.cpp'], 8));
  const uniqCpp = [...new Set(cpps)];
  if (!uniqCpp.length) {
    add('NAT-000', 'UNKNOWN', '没找到 native 宿主壳源码（node_ctl.cpp）',
      '无法检查 detached 线程 / SIGSYS shim / argc 哨兵这三条必崩项。',
      '若你的宿主壳文件名不同，请把源码路径告诉我，我把检查项对上。');
    return;
  }
  const f = uniqCpp[0];
  const c = fs.readFileSync(f, 'utf8');

  // 结构：id / 检测 / 命中时的等级 / 措辞。
  // ★ 纪律：措辞分【命中】与【未命中】两套，绝不复用 —— 早期版本把 FAIL 的文案
  //   在 PASS 分支里复用，报告出现「没有 X … ✓ 通过」这种自相矛盾的结论，
  //   对一份要卖出去的诊断报告来说这是致命的（会直接毁掉可信度）。
  const checks = [
    {
      id: 'NAT-001', hit: /pthread_create|std::thread|detach/.test(c), sev: 'FAIL',
      pass: 'dlopen/node::Start 在独立线程里执行',
      passDetail: '源码里检测到线程创建；内联在 ArkTS UI 线程会阻塞到触发 APP_INPUT_BLOCK ANR 看门狗。',
      fail: '没检测到把 dlopen/node::Start 放到独立线程',
      failDetail: '若它跑在 ArkTS UI 线程，会阻塞到触发 APP_INPUT_BLOCK ANR 看门狗。',
      fix: '用 pthread_create / std::thread 起一个 detached bootstrap 线程，在里面做 dlopen + node::Start。',
    },
    {
      id: 'NAT-002', hit: /SIGSYS/.test(c), sev: 'FAIL',
      pass: '已装 SIGSYS shim',
      passDetail: 'libuv 初始化时【无条件】探测 io_uring_setup(425)，鸿蒙 seccomp 会 trap 它；有 shim 才不会崩在 loop init。',
      fail: '没检测到 SIGSYS shim',
      failDetail: 'libuv 初始化时【无条件】探测 io_uring_setup(425)，鸿蒙 seccomp 会 trap 它，不处理就崩在 loop init。',
      fix: '装 SIGSYS handler，把 trap 转成【正好 -1】（不是 -ENOSYS，libuv 的守卫才认）。',
    },
    {
      id: 'NAT-003', hit: /UV_USE_IO_URING/.test(c), sev: 'WARN',
      pass: '已设 UV_USE_IO_URING=0',
      passDetail: 'io_uring 问题的第二道保险；注意它必须在 libuv 初始化【之前】设置才有效。',
      fail: '没检测到 UV_USE_IO_URING=0',
      failDetail: '这是 io_uring 问题的第二道保险，缺了只靠 SIGSYS shim 兜底。',
      fix: 'setenv("UV_USE_IO_URING", "0", 1) —— 位置要在 dlopen/node::Start 之前。',
    },
    {
      // 同时接受两种写法：带空格 `size()) - 1` 与紧凑 `size())-1`
      id: 'NAT-004', hit: /argc\s*=\s*[^;]*size\(\)\s*\)?\s*-\s*1/.test(c), sev: 'WARN',
      pass: 'argc 已排除 argv 末尾的哨兵',
      passDetail: 'argv 末尾压了 nullptr 哨兵；把它算进 argc 会让 Node 拿到 NULL 参数，实测 5 毫秒内段错误。',
      fail: '没检测到「argc 排除 argv 末尾哨兵」的写法',
      failDetail: 'argv 末尾压了 nullptr 哨兵，若 argc 把它算进去，Node 会拿到 NULL 参数，实测 5 毫秒内段错误。',
      fix: 'const int argc = (int)argv.size() - 1; 并把每个 argv[i] 打进日志核对（看到 (null) 就是多算了）。',
    },
    {
      id: 'NAT-005', hit: /--expose-internals/.test(c), sev: 'FAIL',
      pass: '启动参数含 --expose-internals',
      passDetail: '有它 + 一个约 20 行的 JS 桩，就能完全免掉原生 require-builtin 插件（实测 13/13 通过）。',
      fail: '启动参数里没有 --expose-internals',
      failDetail: '没有它，internal/modules/* 会全部 MODULE_NOT_FOUND（实测 5/5 失败）。',
      fix: '在 argv 里加 --expose-internals，并用约 20 行 JS 桩替代原生 require-builtin 插件。',
    },
    {
      id: 'NAT-006', hit: /backtrace|crashHandler|sigaction\s*\(/.test(c), sev: 'WARN',
      pass: '已装崩溃处理器',
      passDetail: '沙箱日志文件连 debug 签名都不让 hdc 读；有处理器才能拿到 backtrace。',
      fail: '没检测到崩溃处理器',
      failDetail: '沙箱日志文件连 debug 签名都不让 hdc 读，native 侧不留 hilog/文件就很难查。',
      fix: '装信号处理器把 backtrace + fault PC 写进日志文件【并同时打 hilog】。',
    },
  ];

  for (const k of checks) {
    if (k.hit) add(k.id, 'PASS', k.pass, k.passDetail, null, f);
    else add(k.id, k.sev, k.fail, k.failDetail, k.fix, f);
  }
}

function checkJitlessTradeoff(root) {
  const cpps = findFiles(root, ['node_ctl.cpp'], 8);
  if (!cpps.length) return;
  const c = fs.readFileSync(cpps[0], 'utf8');
  const jitlessCommented = /\/\/[^\n]*--jitless/.test(c);
  const jitlessActive = /"(?:--jitless)"/.test(c.replace(/\/\/[^\n]*/g, ''));
  if (jitlessActive) {
    add('RUN-001', 'INFO', '已启用 --jitless',
      '它会关闭 WebAssembly ⇒ 若用到 fetch（Node 内置 undici 的 llhttp 是 WASM）会启动即崩。',
      '若你用 fetch，请把 --jitless 去掉先试一次：部分设备并不需要它（无 SIGTRAP）。', cpps[0]);
  } else if (jitlessCommented) {
    add('RUN-001', 'INFO', '--jitless 被注释掉（说明本机实测不需要它）',
      '这是对的取舍：保留它会让 fetch 不可用。若哪天换设备出现 SIGTRAP（Check failed: 12 == (*__errno_location())），再打开它。',
      null, cpps[0]);
  }
}

/* ============================ 输出 ============================ */

function main() {
  if (!fs.existsSync(ROOT)) { console.error(`目录不存在：${ROOT}`); process.exit(1); }
  const abs = path.resolve(ROOT);

  // 调试开关：把 ELF 解析的原始结论打出来。排查"工具为什么没认出依赖"时用。
  if (argv.includes('--debug-elf')) {
    const so = findFiles(abs, ['libnode.so'], 8)[0];
    if (!so) { console.error('没找到 libnode.so'); process.exit(1); }
    const info = parseElf(so);
    console.error('── parseElf 原始输出 ──');
    console.error('  文件: ' + so);
    console.error('  大小: ' + fs.statSync(so).size + ' 字节');
    console.error('  is64=' + info.is64 + ' e_type=' + info.e_type + ' e_machine=' + info.e_machine + ' phnum=' + info.phnum);
    console.error('  hasInterp=' + info.hasInterp + ' hasGnuStack=' + info.hasGnuStack + ' execStack=' + info.execStack);
    console.error('  soname=' + JSON.stringify(info.soname));
    console.error('  needed=' + JSON.stringify(info.needed));
    console.error('  sections=' + JSON.stringify(info.sections));
    console.error('  error=' + JSON.stringify(info.error ?? null));
    process.exit(0);
  }

  checkLibnode(abs);
  checkConfig(abs);
  checkNativeShell(abs);
  checkJitlessTradeoff(abs);

  if (AS_JSON) { console.log(JSON.stringify({ root: abs, findings: R }, null, 2)); return; }

  const order = ['FAIL', 'WARN', 'UNKNOWN', 'INFO', 'PASS'];
  const icon = { FAIL: '✗', WARN: '!', UNKNOWN: '?', INFO: 'i', PASS: '✓' };
  const counts = R.reduce((a, r) => (a[r.sev] = (a[r.sev] || 0) + 1, a), {});

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  鸿蒙内嵌 Node.js · 本机体检报告');
  console.log('  工程：' + abs);
  console.log('  时间：' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  console.log('════════════════════════════════════════════════════════════');

  for (const sev of order) {
    const group = R.filter(r => r.sev === sev);
    if (!group.length) continue;
    console.log('');
    for (const r of group) {
      console.log(`  ${icon[sev]} [${r.sev}] ${r.title}`);
      if (r.detail) console.log(`      ${r.detail.replace(/\n/g, '\n      ')}`);
      if (r.fix)    console.log(`      → 修法：${r.fix}`);
      if (r.evidence) console.log(`      证据：${r.evidence}`);
      console.log('');
    }
  }

  console.log('────────────────────────────────────────────────────────────');
  console.log(`  失败 ${counts.FAIL || 0} · 警告 ${counts.WARN || 0} · 未知 ${counts.UNKNOWN || 0} · 通过 ${counts.PASS || 0}`);
  console.log('────────────────────────────────────────────────────────────');
  console.log('');
  console.log('  说明：本工具只检查【能在本机验证】的硬约束。');
  console.log('        运行期行为（seccomp、W^X、后台冻结、子进程支持）必须上真机实测，');
  console.log('        本工具不会假装知道。');
  console.log('');

  process.exit((counts.FAIL || 0) > 0 ? 1 : 0);
}

main();
