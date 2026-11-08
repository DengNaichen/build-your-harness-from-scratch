# 00 · 看见模型看到的东西

> 代码版本：见本课提交　·　预计 10 分钟

## 问题

harness 只做一件事：每一步把一堆东西发给模型，再处理它的回复。可是"一堆东西"到底是什么？
system prompt 在哪里？工具的描述是怎么传过去的？第 5 步时，前 4 步的结果还在吗？
你问一句话，它到底发了几次请求？

读代码只能知道"应该"发什么。要知道"实际"发了什么，必须在请求离开进程的那一刻看一眼。
之后每一课——工具报错、用量、历史重发——都要靠这个办法观察，所以它是第 0 课。

## 先分清三个词

| 词 | 含义 | 对应代码 |
|---|---|---|
| **request** | 一次发给模型的 HTTP 请求 | 一次 `model.complete`，也就是循环里的一个 step |
| **turn** | 从你发一条消息，到模型不再调用工具、给出最终回答 | 一次 `runTurn` |
| **trace** | 一份 transcript 的整个生命周期；`/reset` 之后换一个新的 | CLI 里的一次 `createTrace` |

一个 turn 里有 1 到 40 个 request：模型每调用一次工具，结果塞回对话后就得再发一次。
所以 request 的数量总是大于等于 turn 的数量。

## 实验

用真模型聊几句（需要 `HARNESS_API_KEY`），**另开一个终端**看：

```
# 终端 A
npm start
› 列一下当前目录的文件

# 终端 B（任何目录都行）
npm run view     # 打开 http://127.0.0.1:4317 ，每秒自动刷新
```

页面左边是 trace 和 turn 列表，右边是选中 turn 的每个 step。system prompt 和 tools 折叠在最上面
（每个请求都带着它们），每个 step 只显示**这一步新增**的消息，并附带原始请求 JSON。

观察三件事：

1. **system 和 tools** 在每一步都一模一样（overview 里会标出来）。tool 的 `description` 别小看，
   模型靠它决定什么时候用哪个工具，往往比 system prompt 更影响行为。
2. **每一步只新增了几条消息**——可是模型收到的是完整历史。第二个 turn 的 step 1 会显示
   `+5`：上一个 turn 的所有内容又被原样重发了一遍。模型没有记忆，每次都是整个重来。
3. 在 turn 之间的 `turn.json` 里看 `outcome`。按 Ctrl-C 中断一次，看它变成什么。

## 文件长什么样

```
.harness/traces/<trace-id>/
  trace.json                 在哪个工作目录、何时开始
  turn-001/
    turn.json                你说了什么、怎么结束的、几步
    req-001.json             发给 provider 的原始字节
    req-002.json
```

`.harness/` 在 harness 仓库自己的目录里（已在 `.gitignore`），不会写进你操作的项目；
用 `HARNESS_TRACE_DIR` 可以改位置。

## 原因与最小修改

关键是 `OpenAICompatibleModel` 里多了一个 `onRequest` 钩子（`src/model/openai.ts`）：

```ts
const body = JSON.stringify({ model, stream: true, messages, tools, … });
this.onRequest?.(body);
const res = await fetch(url, { …, body });
```

钩子拿到的是**实际发出去的同一个字符串**，不是重新序列化的副本，所以"看到的"就等于"收到的"；
请求体不加任何字段，层级信息只靠目录结构表达。请求体里也没有 API key（它在 `authorization` 头里），落盘是安全的。

写入靠 `src/trace.ts`，读取靠 `src/view.ts`（本机回环上的一个小服务，加一个纯 HTML 页面，零依赖）。分层靠 trace，CLI 在 `runTurn` 前后各通知一次，**`loop.ts` 和 `ModelClient` 接口一行没改**：

```ts
trace.beginTurn(message);   // 先写一份 outcome: "running"
…runTurn(…)…                // 期间每个请求经 onRequest 落盘为 req-NNN.json
trace.endTurn("answered");  // 覆盖成最终结果
```

`beginTurn` 时先写 `running` 是故意的：进程中途崩溃，留下的就是一个永远停在 `running` 的 turn，这本身就是线索。

## trace 不是 session 管理

两者骨架相似，目的不同。trace 只给**人**看：单向写入、写坏了无所谓、任何写入失败都被吞掉，绝不拖垮 agent，
也没有版本号，格式可以随便改。以后做"退出后恢复对话"，要的是给**程序**读的、带校验的存档，那是另一条线，不要塞进 trace。

## 验证

```
npm test
```

- `test/request-hook.test.ts`：钩子收到的字符串与真实请求体**逐字节相同**，且不含 API key。
- `test/view.test.ts`：API 的 trace → turn → request 结构；只有列出过的名字才会碰文件系统；Host 头不是本机的请求被拒绝。
- `test/trace.test.ts`：目录布局与编号、`running` → 终态、崩溃后仍是 `running`、同一毫秒也不会覆盖、写盘失败不抛错。

## 还没解决的

- 只记录了请求，没有记录模型的回复；回复是流式的，要看 SSE 原文得另想办法。
- trace 只增不删，没有清理。
