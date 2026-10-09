/**
 * fixtures.mjs —— 测试样本构造器（供 selftest.mjs 与调试使用）
 *
 * 为什么单独成文件：早期版本把构造器写在 selftest.mjs 里，结果既不好复用、
 * 也没法单独拿来排查"工具为什么没识别出依赖"。共享后才好在两个方向上都可验证。
 *
 * 生成的样本是**迷你 ELF**（几百字节），不依赖任何 120 MB 的真实产物，
 * 所以任何人 clone 下来都能跑自检。
 */
import fs from 'node:fs';
import path from 'node:path';

export const PT_LOAD = 1, PT_DYNAMIC = 2, PT_INTERP = 3, PT_GNU_STACK = 0x6474e551;
export const DT_NULL = 0, DT_NEEDED = 1, DT_STRTAB = 5, DT_SONAME = 14;

/**
 * 生成一个结构合法、可被 ohos-node-doctor 解析的最小 ELF64 共享库。
 * @param {string[]} needs  DT_NEEDED 列表
 * @param {object} opts     { eType, withInterp, execStack, soname }
 * @returns {Buffer}
 */
export function buildElf(needs, opts = {}) {
  const eType = opts.eType ?? 3;                 // 3 = ET_DYN
  const withInterp = !!opts.withInterp;
  const execStack = !!opts.execStack;
  const soname = opts.soname ?? 'libnode.so.137';

  const s = (str) => Buffer.from(str + '\0', 'utf8');
  const dynstr = Buffer.concat([
    s('libnode.so.137'),
    s('libc++_shared.so'),
    s('libc.so'),
    s(soname),
  ]);
  const off = (name) => dynstr.indexOf(Buffer.from(name + '\0'));

  const dynstrOffset = 0x200;
  const dynOffset = 0x300;
  // ★★ 这个样本的布局规则（踩过两次坑，写在这里免得再犯）：
  //   1) 对每个 PT_LOAD 必须满足 (vaddr - offset) ≡ 0 (mod 页大小)；
  //   2) DT_NEEDED / DT_SONAME 的值必须是**相对 DT_STRTAB 起点的偏移**
  //      （解析器最终按 "DT_STRTAB 的文件位置 + 值" 读取，这与真实 ELF 一致）；
  //   3) 段之间不得在虚拟地址上重叠。
  //   违反 1) 或 2) 会让字符串全部读不出来，表现为 ELF-002 误报 PASS。
  const PAGE = 4096;
  const vaddr = (fileOff) => PAGE + fileOff;   // vaddr - offset = 4096，恒为页对齐
  const dynstrVaddr = vaddr(dynstrOffset);
  const dynVaddr = vaddr(dynOffset);

  const dynEntries = [];
  // 值为"表内偏移"（与真实 ELF 的语义一致）
  for (const n of needs) dynEntries.push([DT_NEEDED, off(n)]);
  dynEntries.push([DT_SONAME, off(soname)]);
  dynEntries.push([DT_STRTAB, dynstrVaddr]);
  dynEntries.push([DT_NULL, 0]);

  if (process.env.FIXTURE_DEBUG === '1') {
    console.error('  [buildElf] dynstrOffset=0x' + dynstrOffset.toString(16) + ' dynOffset=0x' + dynOffset.toString(16) + ' BASE=0x' + BASE.toString(16));
    console.error('  [buildElf] dynstrVaddr=0x' + dynstrVaddr.toString(16) + ' dynVaddr=0x' + dynVaddr.toString(16));
    console.error('  [buildElf] 各 NEEDED 的 off=' + JSON.stringify(needs.map(n => [n, off(n), '0x' + (dynstrVaddr + off(n)).toString(16)])));
    console.error('  [buildElf] dynEntries=' + JSON.stringify(dynEntries.map(([t, v]) => [t, '0x' + v.toString(16)])));
  }

  const dynCount = dynEntries.length;
  const dynSize = dynCount * 16;

  const shstr = Buffer.concat([s(''), s('.shstrtab'), s('.dynstr'), s('.text')]);
  const shstrOffset = 0x500;
  const shoff = 0x600;
  const shnum = 4;
  const shentsize = 64;

  const phs = [];
  phs.push({ type: PT_LOAD, flags: 6, offset: dynstrOffset, vaddr: dynstrVaddr, filesz: dynstr.length });
  phs.push({ type: PT_LOAD, flags: 6, offset: dynOffset, vaddr: dynVaddr, filesz: dynSize });
  if (withInterp) phs.push({ type: PT_INTERP, flags: 4, offset: 0x100, vaddr: vaddr(0x100), filesz: 28 });
  phs.push({ type: PT_DYNAMIC, flags: 6, offset: dynOffset, vaddr: dynVaddr, filesz: dynSize });
  phs.push({ type: PT_GNU_STACK, flags: execStack ? 7 : 6, offset: 0, vaddr: 0, filesz: 0 });

  const phnum = phs.length;
  const phentsize = 56;
  const phoff = 64;
  const total = Math.max(dynstrOffset + dynstr.length, dynOffset + dynSize,
                         shstrOffset + shstr.length, shoff + shnum * shentsize);
  // ★ 必须 0 填充：解析器会把未填充区域当真实头字段读取；
  //   早期用 0xaa 填充，得到天文数字的段大小并触发 ERR_OUT_OF_RANGE。
  const buf = Buffer.alloc(total, 0);

  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
  buf[4] = 2; buf[5] = 1; buf[6] = 1;
  buf.writeUInt16LE(eType, 16);
  buf.writeUInt16LE(183, 18);          // EM_AARCH64
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(BigInt(phoff), 32);
  buf.writeBigUInt64LE(BigInt(shoff), 40);
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(phentsize, 54);
  buf.writeUInt16LE(phnum, 56);
  buf.writeUInt16LE(shentsize, 58);
  buf.writeUInt16LE(shnum, 60);
  buf.writeUInt16LE(1, 62);            // shstrndx

  phs.forEach((p, i) => {
    const o = phoff + i * phentsize;
    buf.writeUInt32LE(p.type, o);
    buf.writeUInt32LE(p.flags, o + 4);
    buf.writeBigUInt64LE(BigInt(p.offset), o + 8);
    buf.writeBigUInt64LE(BigInt(p.vaddr), o + 16);
    buf.writeBigUInt64LE(BigInt(p.filesz), o + 32);
    buf.writeBigUInt64LE(BigInt(p.filesz), o + 40);
    buf.writeBigUInt64LE(8n, o + 48);
  });

  dynstr.copy(buf, dynstrOffset);
  dynEntries.forEach(([tag, val], i) => {
    const o = dynOffset + i * 16;
    buf.writeBigUInt64LE(BigInt(tag), o);
    buf.writeBigUInt64LE(BigInt(val), o + 8);
  });
  shstr.copy(buf, shstrOffset);

  buf.fill(0, shoff, shoff + shentsize);   // section 0 必须全 0
  const mkSh = (i, nameOff, type) => {
    const o = shoff + i * shentsize;
    buf.writeUInt32LE(nameOff, o);
    buf.writeUInt32LE(type, o + 4);
  };
  mkSh(1, shstr.indexOf(Buffer.from('.shstrtab\0')), 3);
  mkSh(2, shstr.indexOf(Buffer.from('.dynstr\0')), 3);
  mkSh(3, shstr.indexOf(Buffer.from('.text\0')), 1);

  return buf;
}

/** 可用的宿主壳源码样本 */
export const GOOD_CPP = `
#include <pthread.h>
#include <signal.h>
#include <cstdlib>
static void sigsysHandler(int, siginfo_t*, void*) {}
static void crashHandler(int) {}
extern "C" void boot() {
  pthread_t t; pthread_create(&t, nullptr, [](void*)->void*{
    struct sigaction sa; sa.sa_sigaction = sigsysHandler; ::sigaction(SIGSYS, &sa, nullptr);
    ::signal(SIGSEGV, crashHandler);
    ::setenv("UV_USE_IO_URING", "0", 1);
    return nullptr;
  }, nullptr); pthread_detach(t);
}
int run(int ac, char** av) { const int argc = ac - 1; return argc; }
static const char* kArgv[] = { "node", "--expose-internals", "--no-verify-heap" };
`;

export const BAD_CPP = `
extern "C" int run(int ac, char** av) {
  void* h = dlopen("libnode.so", RTLD_NOW);
  const int argc = ac;            // 故意：把哨兵也算进去
  return argc;
}
`;

export const GOOD_MODULE = `{
  "module": {
    "name": "entry",
    "compressNativeLibs": true,
    "extractNativeLibs": true,
    "requestPermissions": [ { "name": "ohos.permission.INTERNET" } ]
  }
}
`;

export const BAD_MODULE = `{\n  "module": {\n    "name": "entry"\n  }\n}\n`;

/**
 * 造一个鸿蒙工程骨架。
 */
export function makeProject(dir, { elfOpts, needed, extraLibs = [], moduleJson, hostCpp }) {
  const abi = path.join(dir, 'entry', 'libs', 'arm64-v8a');
  const main = path.join(dir, 'entry', 'src', 'main');
  fs.mkdirSync(abi, { recursive: true });
  fs.mkdirSync(main, { recursive: true });

  fs.writeFileSync(path.join(abi, 'libnode.so'), buildElf(needed, elfOpts));
  for (const l of extraLibs) fs.writeFileSync(path.join(abi, l), Buffer.alloc(16));

  if (moduleJson) fs.writeFileSync(path.join(main, 'module.json5'), moduleJson);
  if (hostCpp) fs.writeFileSync(path.join(main, 'node_ctl.cpp'), hostCpp);

  fs.mkdirSync(path.join(dir, 'AppScope'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'AppScope', 'app.json5'),
    '{\n  "app": {\n    "bundleName": "com.example.selftest",\n    "versionCode": 1000000,\n    "versionName": "0.1.0"\n  }\n}\n');
  return dir;
}
