# 契约

这个仓库唯一需要你克制的地方。自举到第三代时，模型会大段重写代码，**这三样东西是唯一能防止它把地基挖掉的东西**。

修改它们不是禁止，但必须是一次显式的、有记录的迁移。

## 1. TranscriptEntry

```ts
{ role, content, toolCalls?, toolCallId?, name? }
```

- 这是对话的唯一真相。模型客户端只负责把它翻译成 wire 格式，不许反向修改它。
- **不变量**：一条带 `toolCalls` 的 assistant 记录，后面必须紧跟相同数量、相同顺序的 `role: "tool"` 记录，每条带对应的 `toolCallId`。上下文压缩也必须保住这条，否则 provider 会直接拒绝历史。
- 改变形状 → 必须 bump `TRANSCRIPT_VERSION`（在 `src/types.ts`），并在这里写一段迁移说明。

## 2. Tool

```ts
{ name, description, inputSchema, run(args, ctx) }
```

- `run` 抛异常 = 失败结果回给模型，不崩循环。
- 参数校验只做「必填 + 基本类型」，故意不引 schema 库。
- **不变量**：`loop.ts` 里不允许出现任何工具名的字符串特判。要特殊行为，就在工具内部实现。

## 3. Host

```ts
{ root, run, read, write, exists }
```

- 所有副作用必须经过这里。`loop.ts` 和 `tools.ts` 不许直接 `fs.` 或 `child_process`。
- 这条为将来换沙箱/容器/远程执行留的口子，一旦破了就再也补不回来。

## 测试是第四次契约

`node --test` 必须永远能离线通过。任何一代如果让测试变红、然后你去改测试而不是改代码——那就是退化，不是进步。
