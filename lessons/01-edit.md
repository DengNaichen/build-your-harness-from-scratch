# 01 · 整文件覆盖的代价（为什么需要 edit，以及 edit 该拒绝什么）

> 代码版本：`be2612c`（`edit` 完成）　·　预计 40 分钟（含手敲）

## 问题

工具集里只有 `bash / read / write`。`write` 的语义是**整个文件就是新内容**，所以"改一行"必须
把整个文件重新写一遍。这带来两件事，第二件才是真问题：

1. **代价**：改动量 = 文件大小。改一个字符，也要把整个文件再发一遍。
2. **静默损坏**：如果模型重写时漏了行、漏了函数，`write` 发现不了。
   它只回答 `wrote 64 bytes to math.ts`——**它没有旧内容，所以它无法知道丢了什么**。
   文件变小了、测试红了，都由你自己发现。

第 2 点决定了 `edit` 不是一个"省 token 的小工具"，而是一个**校验器**：
它的职责是把"你以为你改的那一处"变成"唯一确定的一处，改不到就报错"。

## 实验

两个实验都离线、不需要 API key，在仓库根目录运行。脚本放在 `lessons/01-edit/`。

### 实验 1：`write` 不会告诉你丢了什么

```
node lessons/01-edit/loss.ts
```

脚本用一个**剧本模型**（`FakeModel`）在同一个文件上连续 `write` 两次，第二次本意是"只改 `sum`"，
但剧本里故意让它重写时漏掉了 `diff`。实际输出：

```
model said: done
tool result: "wrote 121 bytes to math.ts"
tool result: "wrote 64 bytes to math.ts"
--- file after ---
export function sum(a: number, b: number) { return a + b + 1; }
```

注意这个实验证明的是**harness 的盲区**，不是"真模型一定会漏"：漏行是剧本写死的。它只说明一件事——
**如果模型漏了，没有任何东西会告诉它或你。**

- 两次调用**都是成功**。没有 error，没有警告，`diff` 就这么没了。
- 模型也认为自己成功了（`done`）。
- 唯一能看出问题的是"你记得原来有两个函数"——而 harness 里没有任何东西记得。

### 实验 2：改一行要发多少字节

```
node lessons/01-edit/size.ts
```

脚本造一个 600 行的文件，比较"用 `write` 改一行"和"用 `edit` 改一行"时，模型要输出的**调用参数**大小：

```
file: 600 lines, 40584 bytes
write call arguments: 41216 bytes
edit  call arguments: 89 bytes
ratio: 463x
```

这是个合成的极端例子，比例随文件变大而变大。真实的数字见下面"模型真的会选 edit 吗"：
一个只有 41 行（2682 字节）的文件，模型改一个函数名时实际发出的 `edit` 参数是 168 字节。

## 为什么不干脆用 bash + sed / patch

`bash` 今天就能做字符串替换，但：

- **转义**：`sed` 里 `/`、`&`、`\`、换行全是坑，容易写错。
- **没有唯一性**：`sed` 会默默替换它命中的所有处（或第一处），你要靠事后 `grep` 才发现改错了地方。
- **失败信息不可读**：模型拿到的是 `sed: bad substitution`，而不是"这个字符串在文件里出现了 2 次"。

这三条正是 `edit` 要补的空白——不是"多一个工具"，而是把一次替换变成一次**可失败的断言**。

## 原因与最小修改

`write` 缺的不是写法，是**旧内容**。它只知道新内容，所以它没法回答"这一处原来是什么、
我改的到底是不是这一处"。补上这个能力，只需要让工具同时拿到 `old_string` 和 `new_string`。

形状（在 `src/tools.ts` 里加第四个工具）：

```ts
edit({ path, old_string, new_string, replace_all? })
```

`loop.ts`、`types.ts`、`host.ts` **一行没改**（见下面"验证"）。每条拒绝都是抛异常，
`loop.ts` 会把它包成 `error: edit failed: …` 回给模型：

| 情况 | 报错（节选） | 为什么 |
|---|---|---|
| `old_string` 为空 | `old_string must not be empty` | 空串在任意位置匹配，等于没约束；还会让后面的计数循环**死循环** |
| 新旧文字相同 | `old_string and new_string are identical` | 什么都不会改，几乎总是模型的错觉 |
| 文件不存在 | `file not found: x.ts; use write to create a new file` | 不把带绝对路径的 `ENOENT` 原样给模型，并告诉它下一步 |
| 0 次命中 | `old_string not found in x.ts; read the file again…` | 模型记错了文件内容 → 应当重新 `read` |
| >1 次命中且没设 `replace_all` | `old_string found N matches…include more surrounding text` | 唯一性是它唯一的正确性保证 |
| 路径越界 | `path escapes the workspace root` | 来自 `host`，`edit` 不用重复实现 |

报错是**写给模型看的**，所以每一条都包含两件事：发生了什么，以及下一步该做什么。

成功时返回 `replaced 1 occurrence in a.ts, first at line 2`，模型下一条消息里就有位置线索。

核心逻辑（`run` 的函数体）：

```ts
async run(args) {
  const filePath = String(args.path);
  const oldString = String(args.old_string);
  const newString = String(args.new_string);
  const replaceAll = args.replace_all === true;

  if (oldString === "") throw new Error("old_string must not be empty; it identifies the text to replace");
  if (oldString === newString) throw new Error("old_string and new_string are identical; nothing would change");

  let content: string;
  try {
    content = await host.read(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`file not found: ${filePath}; use write to create a new file`);
    }
    throw err;
  }

  const at = content.indexOf(oldString);
  if (at === -1) throw new Error(`old_string not found in ${filePath}; read the file again and copy the text exactly`);

  // Count non-overlapping matches, scanning left to right.
  let count = 0;
  for (let from = at; from !== -1; from = content.indexOf(oldString, from + oldString.length)) count += 1;
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string found ${count} matches in ${filePath}; include more surrounding text so it is unique, ` +
        "or set replace_all to change every one",
    );
  }

  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.slice(0, at) + newString + content.slice(at + oldString.length);
  await host.write(filePath, updated);

  const line = content.slice(0, at).split("\n").length;
  return `replaced ${count} occurrence${count === 1 ? "" : "s"} in ${filePath}, first at line ${line}`;
}
```

几个刻意的取舍：

- **不做模糊匹配、不做 trim、不做缩进归一化**。缩进对不上就失败，让模型重新 `read`。
  一次"猜对了"的模糊替换，比一次报错危险得多。
- **失败时文件一个字节都没动**：先 `host.read`，在内存里算好新内容，最后才 `host.write`。
  所有会抛错的检查都在写之前。
- **副作用仍然只经过 `host`**（`CONTRACTS.md` 第 3 条）。别往 `Host` 里加 `edit`：
  `edit` 是纯字符串逻辑，真正的副作用只有"读一次、写一次"，而这两个 `host` 已经有了。
  Host 是以后换沙箱、容器、远程执行的接口，每多一个方法，每种实现都得跟着做一遍。
- **替换时不用 `String.replace`**。当 `new_string` 是字符串时，JS 会解释里面的 `$&`、`$1`，
  模型写 shell 脚本和正则时经常带 `$`。这里用 `slice` 拼接和 `split/join`，两者都按字面处理。
  `"abc".replace("b", "$&$&")` 得到 `abbc`；本工具对同样的输入会老老实实写入 `$&$&`。

## 跟着敲：从红到绿，一次只加一个情况

这个工具是**测试先行**写出来的：每个情况先写测试，看它因为**正确的原因**变红，再改实现让它变绿。
仓库里对应的提交是一条连贯的历史（`git log --oneline` 可以看到）：

| 步骤 | 做什么 | 红的原因应该是 |
|---|---|---|
| 1 | 写第一个测试（唯一命中） | `createTools() has no tool named edit` |
| 2 | 加 `edit` 骨架，`run` 先抛 `not implemented` | `Error: not implemented` |
| 3 | 实现最简主路径 | 变绿 |
| 4 | 找不到 → 抛错且文件不动 | `Missing expected rejection` |
| 5 | 空 `old_string`、多处命中、`replace_all`、相同字符串、文件不存在、返回行号 | 各不相同，逐个看 |
| 6 | 补上"本来就对"的情况：删除、`$&`、CRLF、路径越界 | 一开始就是绿的，用来**锁住**行为 |

**看到红，先看为什么红。** 红的原因不对，说明测试本身有 bug（拼错一个字符、少了一个空格都会这样），
这时去改实现，只会把实现改成能让一条错误的测试通过。

### 第 1 步：先写一个会变红的测试

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
> 例如 `src/tools.ts` 里写了一半的函数。一个语法错误会拖垮**所有** import 了 `tools.ts` 的测试文件，
> 所以开发时尽量让它保持"随时能加载"：先写骨架（`run` 里抛 `not implemented`），再逐步填。

**"测试真的被执行了吗"的可靠判据**：输出里要有 `# Subtest: unique match: …` 这一行。
单看 `# tests 1` 不够——文件加载失败时，Node 也会把整个文件算成"1 个失败的测试"。

#### 给不熟 TypeScript 的读者：这段代码在做什么

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

#### 为什么这样设计这个测试

- 比较的是**整个文件内容**，而不只是"包含新字符串"。这样"悄悄多改、少改了别处"也会被抓到，
  这正是 `edit` 要提供的保证。
- `setup` 先写成一个小函数，后面每一个新情况（找不到、命中多处……）都复用它，每个测试只多几行。

### 后面的步骤：几个值得记住的坑

- **"找不到"那一步为什么必须先做**：最初的实现里 `indexOf` 找不到会返回 `-1`，`slice` 算术会把
  新文字插进文件中间，还**重复**一大段旧内容，然后**悄悄写回去**。不报错，只是文件坏了。
  对 `"const x = 1;\nconst y = 2;\n"` 找 `"z = 3"`，得到的是
  `"const x = 1;\nconst y = 2;z = 30t x = 1;\nconst y = 2;\n"`。
- **计数循环里的死循环**：空字符串长度是 0，`from + oldString.length` 永远等于 `from`，循环不会前进。
  所以"拒绝空 `old_string`"不只是语义洁癖，它是防止模型把整个 agent 卡死的实际理由。
  这一条的测试必须在加计数循环**之前**就有。
- **测试里的一个空格也会骗你**：测试数据里 `"1; \n"` 多了个空格，而期望值里没有，
  等实现正确了，反而因为这个空格而失败。"悄悄多一个字符"正是 `edit` 要抓的那类问题，也最容易出在测试自己身上。

## 模型真的会选 edit 吗

加了工具不等于模型会用。第 0 课说过，模型靠工具的 `description` 决定怎么选，
所以这一步要用 trace 看**真实的选择**，而不是想当然。

我们在**没有改动 `write` 的描述和 system prompt** 的前提下，用真模型（`deepseek-flash`）在一个 41 行的临时文件上
跑了三个任务，每个都是单独一次对话，用 `npm run view`（或直接读 `.harness/traces`）查看每次请求里的工具调用：

| 任务 | 模型的工具调用 | 结果 |
|---|---|---|
| 把函数 `sum` 改名为 `add` | `bash`(看文件) → `edit` → `bash`(确认) | 对 |
| 在 `sum` 后面新增函数 `mul` | `bash` → `read` → `edit` → `bash` | 对，行数 41 → 42 |
| 给 `fn10/20/30/40` 各加一行注释 | `bash` → `bash`(一段 Python 脚本) → `bash` | 对，行数 41 → 45 |

观察：

- **单处修改，模型自己选了 `edit`**，没有用 `write` 去覆盖整个文件。真实的参数只有 168 字节：
  `{"path":"math.ts","old_string":"export function sum(…) { return a + b; }","new_string":"export function add(…) { return a + b; }"}`；
  而整个文件是 2682 字节。
- **插入不需要单独的工具。** 第二个任务里模型用的是**锚点**：把 `sum` 那一行当作 `old_string`，
  `new_string` 是"那一行 + 新函数"。
- **多处修改，模型绕开了 `edit`**，写了一段 Python 脚本通过 `bash` 一次性改完。结果是对的，
  但这段脚本**没有任何唯一性校验**，正是前面"为什么不用 bash + sed"担心的那条路。
  `edit` 一次只改一处，要改四处就得调四次，模型显然觉得脚本更省事。

所以这一步我们**没有**去改 `write` 的描述或 system prompt：证据显示在单处修改上用不着，
没有证据就去改，只是在猜。上面的结论只来自 **1 个模型、3 个任务**，样本很小，
换成别的模型、更长的文件、更含糊的指令，结论可能不同。

## 验证

```
npm test
```

整套测试全部通过。`test/edit.test.ts` 里有 12 条，全部离线：

| 测试 | 锁住的行为 |
|---|---|
| unique match | 只替换那一处，其余字节不变 |
| not found | 抛错，且文件与调用前**逐字节相同** |
| several matches | 抛错，报错里带命中次数，文件不动 |
| empty old_string | 抛错，文件不动 |
| replace_all | 全部替换，返回替换数量 |
| identical strings | 抛错，文件不动 |
| missing file | 报 `file not found`，并指向 `write` |
| path outside the workspace | 越界被拒绝 |
| empty new_string | 合法的删除 |
| dollar sequences | `$&` 原样写入 |
| CRLF | 没动的行仍是 `\r\n` |
| the result | 返回里有命中数和行号 |

证明契约没有被顺手改掉：以本课起点 `97ed3d7` 为基线，`src` 里只有一个文件变了：

```
git diff --stat 97ed3d7 HEAD -- src
```

```
 src/tools.ts | 89 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++----
 1 file changed, 84 insertions(+), 5 deletions(-)
```

`loop.ts`、`types.ts`、`host.ts` 都没有出现在改动里。

另外，`test/openai.test.ts` 之前把请求里的工具名写死成 `["bash", "read", "write"]`，
加了 `edit` 后它会失败。它真正想证明的是"请求里带着工具的 schema"，所以我们改成和传入的 `tools` 对比，
以后再加工具就不用回来改它了。

## 还没解决的

- **读的成本没变**：改之前仍要 `read` 整个文件进上下文，长文件依旧贵。上下文压缩是另一课。
- **多处修改**：`edit` 一次只能改一处（或用 `replace_all` 改同一段文字的所有处）。要在不同位置改不同内容，
  模型会转去写 `bash` 脚本，绕过唯一性校验。这是否值得再加一个"批量编辑"能力，要看更多真实数据。
- **CRLF 的坑**：文件是 `\r\n` 换行时，模型发来的**多行** `old_string`（用 `\n`）会匹配不上，
  报的只是"找不到"，模型会被误导。单行不受影响。
- **唯一性经常不成立**：生成出来的代码里重复模板很多，`old_string` 想唯一就得带一堆上下文，
  这到底是好事（逼模型看准）还是摩擦（逼它反复失败），要长期用真模型才知道。
- **表达不了移动**：把函数从上移到下，`edit` 只能拆成"删一次 + 加一次"，中间的失败状态没人管。
- **`replace_all` 是个危险的开关**：它把唯一的正确性保证关掉了，只靠模型自觉。
- **没有"先读后改"的强制**：模型没读过文件也可以调 `edit`，只是更容易被"找不到"拦下。
