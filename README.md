# ohos-node-doctor

> 鸿蒙（HarmonyOS / OpenHarmony）App 内嵌 Node.js 运行时的**本机体检工具**。
> 把「上机才会崩」的硬约束变成**在本机就能查出来**的结论——每条都附判据、证据、修法和验证命令。

```
npx ohos-node-doctor <你的鸿蒙工程根目录>
```

零依赖，纯 Node（≥ 18）。**自己解析 ELF**，不需要装 LLVM，也不需要 DevEco Studio。

---

## 为什么需要它

在鸿蒙 App 进程内跑真正的 Node.js，有 6 条硬约束。**违反任何一条，症状都不是报错，而是崩溃或静默失败**——最贵的那种 bug：

| 症状 | 真因 |
|---|---|
| `dlopen` 成功，但 `dlsym` 全部返回 null | 符号名靠猜；要用 `llvm-nm` 读真实二进制 |
| `node::Start` 里 SIGTRAP：`Check failed: 12 == (*__errno_location())` | V8 的 `PROT_EXEC` 被 W^X 拒绝 |
| 启动即 ANR：`APP_INPUT_BLOCK` | `dlopen`/`node::Start` 跑在 ArkTS UI 线程 |
| `dlopen` 失败，**ArkTS 侧只拿到 `undefined`**（不报错） | 漏了 `libc++_shared.so` |
| `internal/modules/*` 全部 `MODULE_NOT_FOUND` | 启动参数缺 `--expose-internals` |
| Node 拿到 NULL 参数，**5 毫秒内段错误** | `argc` 把 argv 末尾的 `nullptr` 哨兵算进去了 |

这些坑的共同点是：**你无法从报错里推断原因**。本工具的作用就是把它们提前到本机、在有报错的地方暴露出来。

---

## 检查项

| ID | 检查 | 等级 | 依据 |
|---|---|---|---|
| **ELF-001** | `libnode.so` 是否真共享库（`ET_DYN` 且**无 `PT_INTERP`**） | FAIL | 带 `PT_INTERP` 就是 PIE；被 `dlopen` 后会把 local-exec 的 `%fs` TLS 别名到宿主 TLS 块，V8 的 `thread_local` 读到垃圾，release 版在 `Isolate::Initialize` **第一次堆分配就崩** |
| **ELF-002** | `DT_NEEDED` 里的库是否与 `.so` 同目录齐备 | FAIL | 漏 `libc++_shared.so` 的症状**不是报错**，是 ArkTS 侧拿到 `undefined` |
| **ELF-003** | `SONAME` | INFO | 有 SONAME 说明是按共享库构建 |
| **ELF-004** | 是否有 `.codesign` 段 | WARN | 鸿蒙商用版校验 ELF 代码签名，未签名的库装上也用不了 |
| **ELF-005** | 栈是否可执行（`PT_GNU_STACK` 的 `PF_X`） | WARN | 安全加固减分项 |
| **CFG-001** | `module.json5` 的 **module 级** `compressNativeLibs` | WARN | 实测：`libnode.so` 120.9 MB → 43.0 MB，HAP 151.6 MB → **71.8 MB（-53%）** |
| **CFG-002** | 已申请的 `ohos.permission.*` 清单 | INFO | 上线时**必须与隐私声明完全一致**，否则被驳回 |
| **CFG-003** | `bundleName` / `versionCode` / `versionName` | INFO | 重传要递增 versionCode；包名需在 AGC 注册 |
| **NAT-001** | `dlopen`/`node::Start` 是否在独立线程 | FAIL | 跑在 UI 线程会触发 `APP_INPUT_BLOCK` ANR |
| **NAT-002** | 是否装 SIGSYS shim | FAIL | libuv **无条件**探测 `io_uring_setup(425)`，seccomp 会 trap 它 |
| **NAT-003** | 是否设 `UV_USE_IO_URING=0` | WARN | 第二道保险，且必须在 libuv 初始化**之前** |
| **NAT-004** | `argc` 是否排除 argv 末尾哨兵 | WARN | 多算一个 ⇒ Node 拿到 NULL ⇒ 5 ms 段错误 |
| **NAT-005** | 启动参数是否含 `--expose-internals` | FAIL | 否则 `internal/modules/*` 全 `MODULE_NOT_FOUND`（实测 5/5 失败） |
| **NAT-006** | 是否有崩溃处理器 | WARN | 沙箱日志连 debug 签名都不让 `hdc` 读 |

**它不检查什么**（诚实边界）：运行期行为——seccomp 实际拦截、W^X、后台冻结、`childProcessManager` 支持情况——**必须上真机实测**。本工具不会假装知道，查不了的项明确标 `UNKNOWN`。

---

## 用法

```bash
# 克隆后直接跑（零依赖，不需要 npm install）
node ohos-node-doctor.mjs /path/to/harmony

# 机器可读（便于接 CI）
node ohos-node-doctor.mjs /path/to/harmony --json

# Windows 上路径带空格要加引号
node ohos-node-doctor.mjs "F:\path\to\harmony"
```

**退出码**：`0` = 无 FAIL；`1` = 有 FAIL（可直接 `if` 判在 CI 里）。

对 `entry/libs/arm64-v8a/libnode.so` 手动复核时，等价命令是：

```bash
llvm-readelf -h libnode.so | grep -E 'Type|Machine'   # 期望 Type: DYN
llvm-readelf -l libnode.so | grep -c INTERP           # 期望 0
llvm-readelf -d libnode.so | grep NEEDED              # 期望含 libc++_shared.so
```

---

## 实测样本

工具的真假靠**两个方向的样本**验证，缺一不可：

| 样本 | 结果 |
|---|---|
| 一个真实跑通的鸿蒙内嵌 Node 工程 | **10 PASS / 1 WARN / 0 FAIL** |
| 人工构造的坏样本（`e_type` 改成 `EXEC`、首个 program header 改成 `PT_INTERP`、抽掉 `libc++_shared.so`、宿主壳缺线程与 shim） | **5 FAIL / 5 WARN**，准确报出 `带 PT_INTERP —— 是 PIE，dlopen 必崩` 与 `依赖的 1 个库不在 arm64-v8a/` |

> 一个只会说 OK 的工具等于没有。**能报通过、也能抓错误**，两个方向都测过才算数。

---

## 免责与边界

- 本工具**只做静态检查**，不连接设备、不修改你的工程。
- `NAT-*` 系列基于**源码特征匹配**，可能有假阴/假阳。**匹配不到时它会报 WARN 而不是 PASS**——宁可误报，也不把"没检测到"说成"通过"。
- 检测到的是**必要条件**，不是充分条件。最终必须用**同一份产物**在真机上跑一次：
  **"能构建"不等于"能运行"。**

## 许可

MIT
