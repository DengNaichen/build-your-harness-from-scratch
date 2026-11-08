# 01 · 整文件覆盖的代价（为什么需要 edit，以及 edit 该拒绝什么）

> 代码版本：`97ed3d7`（`l1-edit` 分支起点，`edit` 尚未实现）　·　预计 10 分钟

## 问题

工具集里只有 `bash / read / write`。`write` 的语义是**整个文件就是新内容**，所以"改一行"必须
把整个文件重新写一遍。这带来两件事，第二件才是真问题：

1. **代价**：改动量 = 文件大小。一个 600 行的文件改一个字符，也要吐 9.8 KB。
2. **静默损坏**：模型抄写长文件时会漏行、漏函数、顺手"优化"掉别的东西。
   而 `write` 只回答 `wrote 64 bytes to math.ts`——**它没有旧内容，所以它无法知道丢了什么**。
   文件变小了、测试红了，都由你自己发现。

第 2 点决定了 `edit` 不是一个"省 token 的小工具"，而是一个**校验器**：
它的职责是把"你以为你改的那一处"变成"唯一确定的一处，改不到就报错"。

## 实验

离线，不需要 API key。把下面这段存成仓库根目录的 `demo-edit-loss.ts` 再运行
（`node demo-edit-loss.ts`，跑完删掉即可）。它用一个剧本模型在同一个文件上连续 `write` 两次，
第二次本意是"只改 `sum`"。

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalHost } from "./src/host.ts";
import { runTurn } from "./src/loop.ts";
import { createTools } from "./src/tools.ts";
import { FakeModel } from "./src/model/fake.ts";

const root = await mkdtemp(path.join(tmpdir(), "edit-loss-"));
const tools = createTools(createLocalHost(root));

const before = [
  "export function sum(a: number, b: number) { return a + b; }",
  "export function diff(a: number, b: number) { return a - b; }",
  "",
].join("\n");

const model = new FakeModel([
  { toolCalls: [{ name: "write", args: { path: "math.ts", content: before } }] },
  // meant to change only sum; diff gets lost while re-typing the file
  { toolCalls: [{ name: "write", args: { path: "math.ts",
      content: "export function sum(a: number, b: number) { return a + b + 1; }\n" } }] },
  { text: "done" },
]);

const transcript = [{ role: "user" as const, content: "add one to sum" }];
const answer = await runTurn({ model, system: "demo", tools, transcript, root });

console.log("model said:", answer);
for (const m of transcript.filter((m) => m.role === "tool")) console.log("tool result:", JSON.stringify(m.content));
console.log("--- file after ---\n" + (await readFile(path.join(root, "math.ts"), "utf8")));
```

实际输出：

```
model said: done
tool result: "wrote 121 bytes to math.ts"
tool result: "wrote 64 bytes to math.ts"
--- file after ---
export function sum(a: number, b: number) { return a + b + 1; }
```

三个事实，都值得盯一会儿：

- 两次调用**都是成功**。没有 error，没有警告，`diff` 就这么没了。
- 模型也认为自己成功了（`done`），它没有渠道发现自己抄漏了。
- 唯一能看出问题的是"你记得原来有两个函数"——而 harness 里没有任何东西记得。

再看代价。同一个仓库里 `src/loop.ts` 约 4.6 KB，改一个字符要重发 4.6 KB；
随便造一个 600 行的文件，一处改动就是 **329 倍**的负载：

```
file lines: 599 bytes: 9869
one line change needs write() payload bytes: 9869
edit payload (old+new): 30
ratio: 329x
```

## 为什么不干脆用 bash + sed / patch

`bash` 今天就能做字符串替换，但：

- **转义**：`sed` 里 `/`、`&`、`\`、换行全是坑，模型十次错三次。
- **没有唯一性**：`sed` 会默默替换它命中的第一处，你要靠事后 `grep` 才发现改错了地方。
- **失败信息不可读**：模型拿到的是 `sed: bad substitution`，而不是"这个字符串在文件里出现了 2 次"。

这三条正是 `edit` 要补的空白——不是"多一个工具"，而是把一次替换变成一次**可失败的断言**。

## 原因与最小修改

`write` 缺的不是写法，是**旧内容**。它只知道新内容，所以它没法回答"这一处原来是什么、
我改的到底是不是这一处"。补上这个能力，只需要让工具同时拿到 `old_string` 和 `new_string`。

> 下面这一段是**提案，尚未实现**。它的用途是让你先审语义；代码落地后本节会被替换成真实 diff。

形状（`src/tools.ts` 里加第四个工具，`loop.ts` / `types.ts` / `host.ts` **一行不改**）：

```ts
edit({ path, old_string, new_string, replace_all? })
```

必须拒绝的情况（每条都是抛异常，`loop.ts` 会把它变成 `error: edit failed: …` 回给模型）：

| 情况 | 报错 | 为什么 |
|---|---|---|
| `old_string` 为空 | `old_string must not be empty` | 空串在任意位置匹配，等于没约束 |
| 0 次命中 | `old_string not found in <path>` | 模型记错了文件内容 → 应当 `read` 后重试 |
| >1 次命中且 `replace_all` 为假 | `found N matches; add more context or set replace_all` | 唯一性是它唯一的正确性保证 |
| 路径越界 | `path escapes the workspace root` | 复用 `resolveInRoot` |

刻意的取舍：

- **不做模糊匹配、不做 trim、不做缩进归一化**。缩进对不上就失败，让模型去 `read`。
  一次"猜对了"的模糊替换，比一次报错危险得多。
- **不做多段替换、不做行号区间**。等真的需要，再单独一课。
- **失败时文件必须一个字节都没动**：先 `host.read`，在内存里算好新内容，再 `host.write`。
  副作用仍然只经过 `host`，CONTRACTS 第 3 条不破。
- 成功时返回**行号和命中数**（`replaced 1 occurrence at line 7 in src/a.ts`），
  这样模型下一条消息里就有位置线索，不用再猜。

## 跟着敲：第 1 步，先写一个会变红的测试

不要先写 `edit`。先把"我希望它做什么"写成测试，看它失败，再去让它通过。
下面是第一个测试，**手敲**进新文件 `test/edit.test.ts`（别复制粘贴，敲一遍才记得住）：

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalHost } from "../src/host.ts";
import { createTools } from "../src/tools.ts";

// Each test runs in its own temp directory, so tests cannot affect each other.
async function setup(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "edit-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  const edit = createTools(createLocalHost(dir)).find((t) => t.name === "edit");
  assert.ok(edit, "createTools() has no tool named edit");
  return { dir, edit, read: (name: string) => readFile(path.join(dir, name), "utf8") };
}

test("unique match: replaces only that spot, every other byte unchanged", async () => {
  const { dir, edit, read } = await setup({ "a.ts": "const x = 1;\nconst y = 2;\n" });

  const result = await edit.run({ path: "a.ts", old_string: "x = 1", new_string: "x = 10" }, { root: dir });

  assert.equal(await read("a.ts"), "const x = 10;\nconst y = 2;\n");
  assert.equal(typeof result, "string");
});
```

运行：

```
node --test test/edit.test.ts
```

**预期是红的**，并且能看到这句话：`createTools() has no tool named edit`。
看到这一句，说明测试本身没写错，只是功能还不存在。这正是这一步要的结果。

> 如果看到的是别的报错（比如 `SyntaxError`），先别往下走：通常是别处的文件还没写完，
> 例如 `src/tools.ts` 里写了一半的函数。把它补完或暂时注释掉，再跑一次。

### 给不熟 TypeScript 的读者：这段代码在做什么

- **`import … from "node:…"`**：引入 Node 自带的模块，和 Python 的 `import` 类似。
  `../src/host.ts` 里的 `../` 表示"上一级目录"，因为测试文件在 `test/` 里。
- **`async function` / `await`**：读写文件要等磁盘，`await` 的意思是"等这件事做完再往下"。
  只有写了 `async` 的函数里才能用 `await`。
- **`files: Record<string, string>`**：参数 `files` 是一个"名字 → 内容"的对象，
  比如 `{ "a.ts": "…内容…" }`。冒号后面是**类型标注**，只给人和编辑器看，运行时会被丢掉。
- **`Object.entries(files)`** 把对象变成 `[名字, 内容]` 的列表，`for (const [name, content] of …)`
  逐个取出来，同时把两项拆开赋给两个变量（叫"解构"）。
- **`.find((t) => t.name === "edit")`**：在工具列表里找第一个名字是 `edit` 的；找不到就得到 `undefined`。
  `(t) => …` 是匿名函数，等价于 Python 的 `lambda t: …`。
- **`assert.ok(edit, "提示")`**：断言 `edit` 不是 `undefined`，否则测试立刻失败并显示提示。
  它也让后面的代码能放心地使用 `edit`。
- **`return { dir, edit, read: … }`**：返回一个对象，把几样东西一起交给测试用。
  调用处的 `const { dir, edit, read } = await setup(…)` 再把它们拆出来。
- **`"x = 1"` 和 `"x = 10"` 里的 `\n`**：`\n` 是换行符；整个字符串里有两行，
  测试要证明**只有第一行的 `x` 变了，第二行连同结尾的换行都原样不动**。

### 为什么这样设计这个测试

- 比较的是**整个文件内容**，而不只是"包含新字符串"。这样"悄悄多改、少改了别处"也会被抓到，
  这正是 `edit` 要提供的保证。
- `setup` 先写成一个小函数，后面每一个新情况（找不到、命中多处……）都复用它，每个测试只多几行。

做到这里，把红的结果告诉我，再进入第 2 步：写最小的 `edit`，让它变绿。

## 验证

实现后应当能跑通这些（`test/edit.test.ts`，全部离线）：

```
npm test
```

- 唯一命中 → 内容被替换，其余字节不变；
- 0 命中 → 抛错，且**文件内容与调用前逐字节相同**；
- 2 命中且 `replace_all` 缺省 → 抛错，报错里带命中次数；
- `replace_all: true` → 全部替换，返回替换数量；
- `old_string` 为空 → 抛错；
- CRLF 文件 / 文件末尾无换行 → 原样保留，不擅自规范化；
- 路径 `../x` → 越界错误；
- `git diff --stat` 只有 `src/tools.ts` 和 `test/` 两个文件——用这个来证明契约没被顺手改掉。

## 还没解决的

- **读的成本没变**：改之前仍要 `read` 整个文件进上下文，长文件依旧贵。上下文压缩是另一课。
- **唯一性经常不成立**：生成出来的代码里重复模板很多，`old_string` 想唯一就得带一堆上下文，
  这到底是好事（逼模型看准）还是摩擦（逼它反复失败），要用一周真模型才知道。
- **表达不了移动**：把函数从上移到下，`edit` 只能拆成"删一次 + 加一次"，中间的失败状态没人管。
- **`replace_all` 是个危险的开关**：它把唯一的正确性保证关掉了，只靠模型自觉。
