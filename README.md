# Harness G0.1

一个**零依赖、零构建**的最小 agent harness。大约 700 行，包含一个循环、三个工具、一个假模型、一个 OpenAI 兼容的流式客户端、一个终端渲染层，以及一套离线回归测试。

```bash
cd harness
node src/cli.ts          # 没有 API key 时自动进离线 demo
npm test                 # 离线跑全部测试，不花钱、不联网
```

接真实模型（DeepSeek 与 OpenAI 协议兼容）：

```bash
export HARNESS_API_KEY=sk-...
# 可选，默认值如下：
export HARNESS_BASE_URL=https://api.deepseek.com
export HARNESS_MODEL=deepseek-chat
export HARNESS_ROOT=$(pwd)     # agent 能碰到的目录边界
node src/cli.ts
```

> 如果 DeepSeek 控制台显示的模型 ID 已经不是 `deepseek-chat`（比如换成了 V4 的某个名字），只改 `HARNESS_MODEL` 即可，代码不用动。
>
> 也可以把配置写进 `.env`，用 `node --env-file=.env src/cli.ts` 启动。

## 结构

```
src/
  types.ts          三个契约：TranscriptEntry / Tool / ModelClient（+ CompleteOptions）
  loop.ts           全部逻辑：调模型 → 执行工具 → 回填 → 再调
  host.ts           唯一有副作用的地方：文件、子进程、路径边界、中断
  tools.ts          bash / read / write
  model/
    fake.ts         脚本化模型，测试靠它
    openai.ts       手写 SSE 流式客户端，含 tool_call 增量拼接
  renderer/
    repl.ts         终端渲染：流式、颜色、折叠。loop.ts 不知道它存在
  cli.ts            组装 + REPL 输入
test/
  loop.test.ts      循环不变量：工具顺序、maxSteps、错误兜底、路径越界
  abort.test.ts     中断之后 transcript 仍然合法
  openai.test.ts    SSE 解析：假服务器 + tool_call 跨帧拼接
  renderer.test.ts  折叠、去框、流式文本不重复打印
```

## 交互

| 操作 | 作用 |
|---|---|
| `Enter` | 发送 |
| 行尾 `\` | 续行，可以写多行 prompt |
| `Ctrl-C` | 中断当前回合，**不退出**；空闲时按才退出 |
| `/reset` | 清空历史 |
| `exit` | 退出 |

工具结果在终端只画前 3 行，后面用 `… +N 行` 收起来——**模型拿到的是全文**，折叠只影响你眼睛看到的。`NO_COLOR=1` 或重定向到管道时自动关颜色。

## 三个不许变的东西

见 [CONTRACTS.md](./CONTRACTS.md)。简单说：transcript 形状、tool 接口、host 边界。其余全部可以重写。

## 现在故意缺什么

| 缺的东西 | 什么时候加 | 为什么现在不加 |
|---|---|---|
| `edit` / `glob` / `grep` | G1 | 先用 `write` 整文件覆盖，你才会真正感觉到"该有 edit 了" |
| 上下文压缩 | 第一次撞到窗口上限时 | 没有真实的长对话，设计出来的都是猜的 |
| `-p` 单次执行模式 | 想让 harness 进脚本 / 被别的 agent 调用时 | 交互先顺手，非交互是第二步 |
| 审批 / 权限 | 让它碰真实仓库之前 | 现在有 `HARNESS_ROOT` 兜底 |
| supervisor + 自重启 | G3 | 自举到那一代才需要 |
| 全屏 TUI | 富 REPL 用一周后仍然想"往回翻" | 见下方"为什么不是 TUI" |
| UI / 多 agent / 记忆 | 不知道，可能是永远 | 有具体痛之前都是负债 |

### 为什么不是全屏 TUI

渲染层和内核是分开的：`loop.ts` 只发事件，`renderer/repl.ts` 负责画。要上全屏 TUI，就是再写一个 `Renderer`，`loop.ts` 一行不改。

现在不上，是因为 TUI 真正多出来的能力只有"回看/展开"；而它要自己管 raw mode、光标、resize 和**中文宽字符对齐**（CJK 占两列，手写渲染极容易错位），成本远高于收益。等富 REPL 真的让你难受了，再上。

## 怎么加一个工具

1. 在 `src/tools.ts` 写一个返回 `Tool` 的函数，加进 `createTools` 的数组。
2. 在 `test/` 里给它写一个用例。
3. 就这么多——`loop.ts` 不认任何具体工具名。

## 下一步（G1）

- [ ] `edit` 工具（字符串替换，必须要求 old_string 唯一）
- [ ] `glob` / `grep`
- [ ] token 计数与成本显示
- [ ] `-p` 单次执行模式（对齐 `dsh headless`）
- [ ] transcript 落盘（JSONL），支持 `--resume`
- [ ] 把 `loop.test.ts` 扩成 replay 测试：录制真实 transcript，离线重放
