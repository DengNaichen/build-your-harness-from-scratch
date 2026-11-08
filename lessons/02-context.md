# 02 · 上下文从哪里来

> 代码版本：`0ea8214`（上下文加载与每轮重读）　·　预计 30 分钟

## 问题

`SYSTEM_PROMPT` 是写死在 `src/cli.ts` 里的一段常量：四条通用规则，和任何具体项目无关。
可"怎么在这个仓库里干活"是项目自己的事——用 `pnpm` 还是 `npm`、测试怎么跑、哪些目录不许碰、
提交信息怎么写。这些放不进通用提示词，也不该放在每一轮的用户消息里。

社区已经收敛出一个答案：把它写成一个文件，放进上下文。Codex 叫 `AGENTS.md`，
Claude Code 叫 `CLAUDE.md`，内容都是"给人看的项目规矩，顺便给模型看"。

**把它读进来、拼在 system prompt 后面，是三行代码。** 这一课真正要决定的是它前面那半句话——
*哪个文件*：

- 从哪一层开始找？root、当前目录、用户 home，还是三者都要？
- 往上找到哪一层停？root 之上的 `.git` 上级目录算不算"这个项目的规矩"？
- 一个仓库里有多份（根上一份、`packages/api/` 一份）时：模型看到一份还是两份？先看哪份？
- 找不到怎么办——`AGENTS.md` 是必需文件，还是可选增强？
- 同一层同时有 `AGENTS.md` 和 `CLAUDE.md`，合并、择一，还是都读？
- 一个 monorepo 有 20 个包、每包一份 2 KB 的规矩，全塞进去吗？**这份钱是每个 request 都要付一次的**。

所以这一课的重点不是"怎么拼"，是**把路径规则钉死，并且写成能失败的测试**。
拼接本身没什么可讲的，路径的每一个边界都是要你做决定的地方。

## 先说结论：三条规则

1. **只认两个名字**：`AGENTS.md`、`CLAUDE.md`。harness 的 `Host` 没有列目录的能力
   （只有 `run / read / write / exists`），所以**叫不出名字的文件就是看不见的文件**。
   这不是偷懒，是把"上下文包含什么"变成一份可以写在文档里、可以被审查的白名单。
2. **链只朝一个方向**：从 workspace root 一层层走到当前目录，**绝不上溯到 root 之外**，
   也不横着走到兄弟目录。root 是信任边界（`CONTRACTS.md` §3），上下文不能从边界外面来。
3. **越深越具体，排在后面，冲突时后者覆盖前者**。我们**不合并、不去重、不判断谁更权威**，
   只固定顺序，把解释权留给模型。

第 3 条是刻意的克制：合并听起来更聪明，但"两份文件说反话"时，合并的结果是一段谁都没写过的文本，
出了问题没人能解释它是哪来的。顺序至少是可复现的。

## 实验

三个实验都离线、不需要 API key，在仓库根目录运行。脚本放在 `lessons/02-context/`。

### 实验 1：同一棵树，三份规则

```
node lessons/02-context/where.ts
```

脚本造出这样一棵树，然后分别"在"不同目录下加载：

```
workspace:
  AGENTS.md                     <- 根：跑 npm test 再收工
  packages/AGENTS.md            <- 包是独立发布的，记得 bump 版本
  packages/api/AGENTS.md        <- API 包不许打印请求体
  packages/api/CLAUDE.md        <- API：用 node:fs/promises 的 readFile
  packages/web/AGENTS.md        <- web 是 React 19，不许用 class 组件
  docs/AGENTS.md                <- 旁支，不在任何链上
  AGENT.md                      <- 少了个 S，一个不该被捡起的笔误
```

实际输出（节选）：

```
--- working in <root> ---
  AGENTS.md  (49 B)

--- working in packages/api ---
  AGENTS.md  (49 B)
  packages/AGENTS.md  (55 B)
  packages/api/AGENTS.md  (46 B)
  packages/api/CLAUDE.md  (45 B)

--- working in docs ---
  AGENTS.md  (49 B)
  docs/AGENTS.md  (33 B)
```

四件值得停下来看一眼的事：

- **`packages/api` 拿到 4 份，顺序是 root → `packages` → `packages/api`**。深的在后，
  也就是最具体的规矩离"模型正在看的代码"最近。
- **在 `packages/web` 干活，看不到 api 的规矩。** 兄弟目录互不可见——否则一个 20 包的仓库，
  每个包都得读另外 19 个包的规矩。
- **`docs/AGENTS.md` 永远进不来。** 它不在这条链上。想让模型看到它，得让它去 `docs/` 干活，
  而不是把整棵树的 `AGENTS.md` 都塞进 system prompt。
- **`AGENT.md`（少个 S）进不来。** 白名单之外的名字，写错了就是静默失效——
  这是规则 1 的代价，也是它的收益：你永远不会意外加载了别的东西。

脚本最后对比了最直觉的实现——"从根上读 `AGENTS.md`，一次"：

```
--- naive: read AGENTS.md at the root, once ---
  bytes: 49
  contains the api rule: false

--- cascade: root -> packages/api ---
  bytes: 195
  contains the api rule: true
```

差 146 字节。但真正的差别不是字节，是**子项目的规矩根本没到模型手上**：
模型在 `packages/api` 里满怀信心地打印请求体，而那条禁令一直躺在磁盘上。

### 实验 2：这份钱每个 request 都付一次

```
node lessons/02-context/cost.ts
```

脚本造一个 20 个包的 monorepo，根 `AGENTS.md` 1500 B，每个包 2048 B，比较两种策略：

```
files on disk: 21 (1 root + 20 packages)

A. eager   : 21 files, 43.1 KB per request
B. cascade : 2 files, 3.5 KB per request
   difference: 12.2x

per turn (5 steps, one request each):
A. eager   : 215.5 KB
B. cascade : 17.7 KB

of A's 43.1 KB, how much can the model act on right now?
  3.5 KB (8%) — the rest describes packages it is not touching.
```

注意两件事：

- **"每个 request"不是修辞。** 一个 turn 里模型每调一次工具就要再发一次请求，上下文要跟着重发。
  第 0 课讲的 request / turn 关系，在这里变成了账单。
- **eager 需要"遍历目录"这个能力，而 harness 今天没有。** 想 eager 就得先加 `glob`。
  也就是说：grep/glob 这节课的顺序其实可以往后放——因为**上下文注入恰好只需要"叫得出名字的文件"**，
  而 eager 那种用法恰恰是你不想要的。

### 实验 3：改一条规矩，模型什么时候知道

前两个实验都是"只读一次"的世界。现在改一次文件：

```
node lessons/02-context/reload.ts
```

```
--- turn 1: startup ---
  changed: true
  context: AGENTS.md (27 B, sent every request)
  system bytes: 248
  says "npm":  true
  says "pnpm": false

    … the user edits AGENTS.md by hand, no restart …

--- turn 2: after the edit ---
  changed: true
  context: AGENTS.md (41 B, sent every request)
  system bytes: 262
  says "npm":  false
  says "pnpm": true

--- turn 3: nothing edited ---
  changed: false
  system bytes: 262
  byte-identical to turn 2: true

--- no AGENTS.md at all ---
  system equals the bare base prompt: true
  context: (none)
```

三件事：**改了就在下一条消息生效**（不用重启）；**没改就一个字节都不变**（第 3 行 `changed: false`，
这是 prompt cache 的前提）；**文件删了 prompt 退回纯 `SYSTEM_PROMPT`**，和这个功能不存在时逐字节相同。

在真的 REPL 里，第 2 行那笔账会自己走到你眼前：

```
context: AGENTS.md (19 B, sent every request)
context: AGENTS.md (48 B, sent every request)  ← reloaded
```

## 原因与最小修改

三处改动：

| 文件 | 改动 |
|---|---|
| `src/context.ts` | 新增：`loadContext` / `formatContext` / `describeContext`，外加 20 行的 `ContextTracker` |
| `src/cli.ts` | 每个 turn 开始前 `await reloadContext()`，用 `context.systemPrompt` 调模型 |
| `test/context.test.ts` | 新增，15 条 |

`loop.ts`、`types.ts`、`host.ts`、`tools.ts` **一行没改**。上下文注入不碰循环，也不碰工具。

### 路径就是这十几行

```ts
export const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

export async function loadContext(host: Host, dir = ""): Promise<LoadContextResult> {
  const levels = ancestorChain(dir);          // "" -> [""];  "packages/api" -> ["", "packages", "packages/api"]

  const files: ContextFile[] = [];
  for (const level of levels) {
    for (const name of CONTEXT_FILE_NAMES) {
      const rel = level ? `${level}/${name}` : name;
      if (!(await host.exists(rel))) continue;
      const content = await host.read(rel);
      files.push({ path: rel, content, bytes: Buffer.byteLength(content) });
    }
  }

  return { files, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}
```

顺序由两层循环直接决定：**外层是层级（浅 → 深），内层是名字（`AGENTS.md` → `CLAUDE.md`）**。
没有排序、没有根据 mtime 或大小做什么聪明事。想改规则，只能改这两个数组。

### 拼在 system prompt 后面，不是塞进用户消息

```diff
+import { ContextTracker, describeContext } from "./context.ts";
+
 const host = createLocalHost(root);
 const tools = createTools(host);
+
+const context = new ContextTracker(host, SYSTEM_PROMPT, "");
+let reloads = 0;
+
+async function reloadContext(): Promise<void> {
+  try {
+    if (!(await context.refresh())) return; // unchanged: say nothing, send the same bytes
+    console.log(describeContext(context.result) + (reloads++ ? "  ← reloaded" : ""));
+  } catch (err) {
+    console.log(`context: FAILED to reload (...) — still using the previous one`);
+  }
+}
+
+await reloadContext();
```

`ContextTracker` 只是把"读一次"变成"读一次、记住上次的结果、只在真的变了才换 prompt"。
后面 `runTurn({ system: context.systemPrompt })`，别处一行没变。

为什么是 system，不是第一条 user 消息：

- **它描述的是"这个工作区怎么工作"，不是"这一轮我要你做什么"。** 前者在整个会话里恒定，
  后者每轮都变。混在一起，模型会把它当成一次性提醒，而它其实是长期约束。
- 放进 user 消息还会进入 transcript：跟着历史重发、被 `/reset` 清掉、被将来任何上下文压缩
  或截断碰到。system prompt 不进 transcript，这条线是干净的。
- **`/reset` 不清 context**，这是对的：清空的应该是对话，不是你对这个仓库的了解。

**每回合重读，但一回合内绝不重读。** 一个 turn 里可能发十几个 request，如果 system 在它们之间变化，
prompt cache 每一跳都作废。所以时机是：你按下回车、第一个 request 之前，重读一次；这个 turn 剩下的
request 全部用同一份。改完 `AGENTS.md` 发下一条消息就生效，不用重启——

```
context: AGENTS.md (0.0 KB, sent every request)
context: AGENTS.md (0.0 KB, sent every request)  ← reloaded
```

而且**文件没变就什么都不打印、发出去的字节也一个不差**。这一条比"能重载"更重要：重载如果顺手把
prompt 重新拼一遍，即使内容相同也可能带来顺序或空白上的差异，cache 就白丢了。`refresh()` 的返回值
就是"prompt 变了没有"，`false` 时连日志都不出。

### 每个边界都是一个决定

| 情况 | 行为 | 为什么 |
|---|---|---|
| 工作区里没有 `AGENTS.md` | 什么都不加，prompt **逐字节**和加这个功能之前相同 | 它是可选增强，不是必需文件。没有它的项目不该看到任何变化 |
| 链上的目录不存在（`packages/new`） | 跳过，不报错 | 模型可能正准备创建它 |
| `dir` 越界（`../elsewhere`、`/etc`） | **抛错**，不是悄悄夹到 root | 静默 clamp 会让"在 root 外干活"看起来像成功 |
| 文件存在但读不了（权限、是目录） | CLI 捕获、打印 `context: FAILED`、**照常启动** | 上下文坏了不该让整个会话起不来 |
| 同层 `AGENTS.md` + `CLAUDE.md` | 都读，顺序固定 | 不猜"谁是正统"，也不合并 |
| 文件末尾有空行 | 去掉 | 否则 prompt 字节数会随编辑器心情缓慢变化 |

报错文本沿用第 1 课的规矩：写给模型和写给人都要能看懂发生了什么、下一步是什么。

### 一个真的 bug：`../etc` 没被拦住

第一版里，越界检查长这样：

```ts
const normalized = path.posix.normalize(dir).replace(/^\.\/?/, "").replace(/\/$/, "");
```

`dir = "../etc"` 时，`normalize` 得到 `"../etc"`，然后 `replace(/^\.\/?/, "")` 把**第一个点**吃掉了
（正则里 `/` 是可选的），于是变成 `"./etc"`——越界检查看到的已经不是那个 `..` 了，
后面的拆分得到 `[".", "etc"]`，一副人畜无害的样子，**越界被无声放行**。

修法是先 `normalize`、再只剥 `./`：

```ts
const normalized = path.posix
  .normalize(dir.replaceAll("\\", "/"))
  .replace(/^\.\//, "")   // 不是 /^\.\/?/
  .replace(/\/$/, "");
```

这个 bug 是我手跑 `../etc` 时发现的，不是测试发现的——**测试是后来才写去锁它的**（第 7 条）。
顺序刚好反了：正常应该是先写那条测试、看它红、再修。第 1 课反复讲的就是这件事，
自己做的时候照样会忘，所以它值得写在这里而不是被悄悄修掉。

## 验证

```
npm test
```

```
# tests 56
# pass 56
# fail 0
```

41 → 56：新增 15 条，全部离线。它们锁住的是**路径规则**，不是拼接：

| 测试 | 锁住的规则 |
|---|---|
| no AGENTS.md | 空工作区产出空字符串，不是只有标题 |
| only the known names | `README.md` / `AGENT.md` / `docs/AGENTS.md` 都不读 |
| root → working directory | 顺序是浅→深，不是字典序 |
| sibling projects | 兄弟目录互不可见 |
| both names | 同层 `AGENTS.md` 在前、`CLAUDE.md` 在后 |
| missing directory on chain | 链上不存在的目录跳过 |
| outside the root | `../elsewhere`、`packages/../../elsewhere`、`/etc` 全部抛错 |
| trailing slash / `./` | `packages/api/`、`./packages/api`、`packages//api` 等价 |
| labelled with its path | 每段带 `## <相对路径>` 标题，模型能引用出处 |
| trailing blank lines | 尾部空行不会让 prompt 慢慢变长 |
| byte count | `totalBytes` 等于线上实际字节 |
| edit between turns | 改了文件，下一次 `refresh()` 拿到新内容 |
| untouched workspace | 文件没变就连字节都不差（cache 的前提） |
| vanished file | 文件被删，prompt 退回纯 `SYSTEM_PROMPT` |

### 真的进了请求吗

离线测试只证明"函数返回了我以为的内容"。要知道模型**实际**收到什么，还是得看线上——
用真模型跑一个只回答 `ok` 的会话，`AGENTS.md` 里放一条一眼能认出来的规矩：

```
d=$(mktemp -d)
printf '# House rules\n\n- Never run `npm test` in this repo; the runner is `node --test`.\n- Answer in exactly one line.\n' > "$d/AGENTS.md"
printf '只回复 ok 两个字，不要调用任何工具。\nexit\n' |
  HARNESS_ROOT="$d" HARNESS_TRACE_DIR="$d/.traces" node --env-file=.env src/cli.ts
```

然后直接读那一份请求 JSON 里的 system 消息：

```
$ find $d/.traces -name req-001.json -exec node -e '…' {} \;
system bytes: 623        (没有 AGENTS.md 时是 314)
```

```
You are a coding agent working inside a single workspace directory.

Rules:
- Every path you pass to a tool is relative to the workspace root.
...

# Workspace context
Files below describe how to work here. They were loaded from the workspace
root down to the current directory; later files are more specific and win
on conflict.

## AGENTS.md

# House rules

- Never run `npm test` in this repo; the runner is `node --test`.
- Answer in exactly one line.
```

314 → 623 字节，差的 307 就是那份文件加上一段框架文字。**这条规矩现在每一个 request 都在付钱，
所以实验 2 才不是纸上谈兵。**

证明契约没被顺手改掉：

```
git diff --stat HEAD~1 HEAD -- src
```

```
 src/cli.ts     | 21 +++++++++++++++++++--
 src/context.ts | 95 ++++++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 112 insertions(+), 4 deletions(-)
```

`loop.ts`、`types.ts`、`host.ts`、`tools.ts` 都不在改动里。

## skills：同一件事的另一种写法

这一课不实现 skills，但必须把它和 `AGENTS.md` 放在一起看，否则会误以为它们是同一个东西。

真正的差别不在文件在哪，而在**什么时候进上下文**：

| | `AGENTS.md` | skill |
|---|---|---|
| 进上下文的内容 | 文件全文 | 只有 `name` + `description`（索引） |
| 时机 | 每个 request 都带（eager） | 模型决定要用时才 `read` 正文（lazy） |
| 代价 | 字节数 × request 数 | 索引（小）+ 真正被用到的那几次 |

lazy 把路径问题换了个形状，但一点没让它变简单：

- **索引里的名字成了路径的压缩形式。** 名字必须短、必须全局唯一——两个 skill 叫 `test`，
  模型就没法通过名字推出该读哪个文件。这等价于规则 1 的白名单，只是约束从"路径"搬到了"名字"。
- **正文路径必须能从索引唯一推导出来。** 例如固定成 `skills/<name>/SKILL.md`：
  模型看到 `name: pdf` 就知道读 `skills/pdf/SKILL.md`，不需要再问、也不需要列目录。
  路径有规律，是 lazy 成立的前提。
- **多级来源一样是"顺序"问题**：项目 `./skills/`、用户 `~/.harness/skills/`，同名怎么办？
  和 `AGENTS.md` 一样——固定顺序，深的优先，不合并。
- **lazy 有一笔 `AGENTS.md` 不用付的税**：模型凭什么知道该去读那个 skill？
  只能靠 `description` 写得好。写得含糊，这个 skill 就等于不存在——而且**不会报任何错**，
  只是永远不被选中。这是 lazy 最贵的地方，也是它和 eager 最本质的区别。

一句话：`AGENTS.md` 是**路径问题**，skill 是**路径问题 + 选择问题**。这一课解决前者。

## 还没解决的

- **"当前目录"这个概念还不存在。** `host.run` 永远 `cwd = root`，`loadContext(host, "")` 也永远传 `""`，
  所以链今天长度总是 1：多级链的代码和测试都在，但 CLI 里还没有 `--cd` / `HARNESS_CWD`。
  加不加，取决于真的有没有"在子目录里干活"的需求——现在没有证据，就不加。
- **没有预算，也不截断。** 一个 43 KB 的 `AGENTS.md` 会原样进 prompt。要不要截、截浅的还是深的、
  截了要不要告诉模型"我截了"，全是没答案的问题。先让它可见（`describeContext` 在启动和每次重载时打印），
  不做没证据的取舍。
- **冲突只有顺序，没有裁决。** 根说"用 npm"，包说"用 pnpm"，模型看到两句反话，
  遵守哪个全看它自己。真实项目里这种情况很常见。
- **`host.exists` 是用 `readFile` 实现的。** 检查 20 个候选路径 = 把 20 个文件读进内存再丢掉。
  正确实现应该是 `stat`。这是 `Host` 上一处效率债，本课没有动它（`Host` 是契约，改要单独记录）。
- **重载的粒度是"一个 turn"，不是一个 request。** 模型在一个 turn 里跑十条命令的途中改 `AGENTS.md`，
  这一轮看不到，下一轮才看到。想让改动在 turn 中间生效，等于要求每个 request 重新拼 prompt——
  那就把 prompt cache 换掉了。这个取舍今天没得商量，因为这笔账我们还没量过。
- **重载是"每次回车读几个文件"，没有 `stat`/mtime 检查。** `host.exists` 本身是 `readFile`
  实现的，所以每个 turn 都在真读。文件小、turn 少时无所谓，变成慢 IO 的那天再谈。
- **邻居不进来。** 模型 `read` 一个文件时，那个文件**旁边的** `AGENTS.md` 不会自动加载
  （Claude Code 会做这件事）。这是另一个设计，不是 bug；但它是"路径问题"的下一个形态：
  路径不再只由"我在哪个目录"决定，还要由"我刚碰了哪个文件"决定。
- **没测的边界**：空的 `AGENTS.md`、`AGENTS.md` 是个目录、符号链接指向 root 之外、
  文件内容是二进制。前两个是几行测试的事，后两个要先决定"要不要跟链接"。
- **`/reset` 与 context 的关系**只靠"`/reset` 不碰 `ContextTracker`"这句话成立，没有测试盯着。
  热重载进来之后，这条从"显然成立"变成了"需要有人守着"。
