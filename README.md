# Harness G0

一个**零依赖、零构建**的最小 agent harness。大约 500 行，包含一个循环、三个工具、一个假模型、一个 OpenAI 兼容的流式客户端，以及一套离线回归测试。

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
  types.ts        三个契约：TranscriptEntry / Tool / ModelClient
  loop.ts         全部逻辑：调模型 → 执行工具 → 回填 → 再调
  host.ts         唯一有副作用的地方：文件、子进程、路径边界
  tools.ts        bash / read / write
  model/
    fake.ts       脚本化模型，测试靠它
    openai.ts     手写 SSE 流式客户端，含 tool_call 增量拼接
  cli.ts          REPL
test/
  loop.test.ts    循环不变量：工具顺序、maxSteps、错误兜底、路径越界
  openai.test.ts  SSE 解析：起一个假服务器，连 tool_call 跨帧拼接一起测
```

## 三个不许变的东西

见 [CONTRACTS.md](./CONTRACTS.md)。简单说：transcript 形状、tool 接口、host 边界。其余全部可以重写。

## 现在故意缺什么

| 缺的东西 | 什么时候加 | 为什么现在不加 |
|---|---|---|
| `edit` / `glob` / `grep` | G1 | 先用 `write` 整文件覆盖，你才会真正感觉到"该有 edit 了" |
| 上下文压缩 | 第一次撞到窗口上限时 | 没有真实的长对话，设计出来的都是猜的 |
| 流式打印 | G1 | 现在客户端收完整个流才返回，够用 |
| 审批 / 权限 | 让它碰真实仓库之前 | 现在有 `HARNESS_ROOT` 兜底 |
| supervisor + 自重启 | G3 | 自举到那一代才需要 |
| UI / 多 agent / 记忆 | 不知道，可能是永远 | 有具体痛之前都是负债 |

## 怎么加一个工具

1. 在 `src/tools.ts` 写一个返回 `Tool` 的函数，加进 `createTools` 的数组。
2. 在 `test/` 里给它写一个用例。
3. 就这么多——`loop.ts` 不认任何具体工具名。

## 下一步（G1）

- [ ] `edit` 工具（字符串替换，必须要求 old_string 唯一）
- [ ] `glob` / `grep`
- [ ] 流式打印 + token 计数
- [ ] transcript 落盘（JSONL），支持 `--resume`
- [ ] 把 `loop.test.ts` 扩成 replay 测试：录制真实 transcript，离线重放
