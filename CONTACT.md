# 联系与支持

## 先试这个（免费，通常就够了）

```bash
node ohos-node-doctor.mjs /path/to/your/harmony
```

它会逐项列出你违反了哪条硬约束、以及**具体修法**。这覆盖本项目里 12 类已解问题。

**想知道每条约束"为什么"** → [鸿蒙内嵌 Node.js 实战笔记](https://github.com/lzzhij/harmonyos-node-notes)

## 开 issue（我会看到）

本仓库的 [Issues](https://github.com/lzzhij/ohos-node-doctor/issues)。

**请附上**：

- `node ohos-node-doctor.mjs <你的工程>` 的**完整输出**（可用 `--json`）
- 你的**症状原文**：错误码 / 崩溃栈 / 日志片段。**不要只写"报错了"** —— 那样我无法定位
- 设备型号 + 系统版本 + API 版本
- 三个必查项的输出：
  ```bash
  llvm-readelf -h libnode.so | grep -E 'Type|Machine'
  llvm-readelf -l libnode.so | grep -c INTERP      # 期望 0
  llvm-readelf -d libnode.so | grep NEEDED
  ```

> **为什么要求这些**：本项目最贵的两个坑（`argc` 多算一个 `nullptr` 哨兵、
> `dlopen` 了带 `PT_INTERP` 的 PIE）**都是靠原始输出一眼看出来的**。
> 给原始输出能省掉三轮来回。

## 付费支持

如果团队已在鸿蒙端侧运行时上卡了一段时间、或需要在确定期限内跑起来，
可以走付费路径（远程诊断 / 集成交付 / 上架支持）。

**联系邮箱**：`lzj031216@163.com`

邮件请写明：**症状 / 已尝试过什么 / 期望的最小可用状态 / 期限**。

## 边界（先说清，避免误会）

- ❌ 不承诺"上架一定通过"（审核不由开发者决定）
- ❌ 不承诺设备不支持的能力（如 `childProcessManager` 返回 `801`、
  后台无限常驻的 `9800005` / `9900002`）—— 这些有真机证据，**明确说"做不到"比硬接负责**
- ❌ **不索要你的密钥、证书或凭据**。诊断只需要日志与工程结构
- ✅ 本工具**不读取、不上传任何屏幕内容或代码**；它只在你本机做静态检查
