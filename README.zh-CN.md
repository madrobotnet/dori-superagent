<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# dori-superagent

一个主动式、多会话的编程 Agent harness：约 660 行 TypeScript，跑在 [herdr](https://github.com/herdrdev/herdr) 和 [omo](https://github.com/code-yeongyu/oh-my-openagent) 之上。

[English](README.md) | [한국어](README.ko.md) | 简体中文 | [日本語](README.ja.md)

和你对话的只有一个 lead 会话。每个任务是一条 lane：一个独立的 omo 会话，开在自己的 herdr 标签页里，从一份写好的任务简报（brief）启动，以一条必须附带证据的 READY 收尾。duty 循环负责催没动静的 lane、向 lead 上报，并把发给忙碌窗格（pane）的消息先存起来，等它能读了再送。合并要过一道门禁：精确 head 上的 CLEAR 评审回执，加上全绿的检查项。

## 缘起

DeepSeek 发布了 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（首次提交 2026-10-31），大约一天后又发了文章 "Exploring Super-agent Design: Towards a More Autonomous Agent System"。他们的设计是：一个长期存活的 Router 会话，只和人对话、只负责派活；彼此隔离的 Worker 会话，一个 ticket 一个；事件触发按轮次批量送达；外加一个 watchdog。他们的 README 把它定位为研究原型，写明的理念是 "take as little human attention as possible, and give as much value as possible"。

同样的结构，我们已经公开跑了大约六个月：

- 2026-04-18：团队模式合入 omo，多个 Agent 会话各占一个终端窗格，各带一个 worktree（[f1268c0](https://github.com/code-yeongyu/oh-my-openagent/commit/f1268c0)、[e303fee](https://github.com/code-yeongyu/oh-my-openagent/commit/e303fee)）。
- 2026-05-06：Dori 这个名字进入 omo 的 README（[#3807](https://github.com/code-yeongyu/oh-my-openagent/pull/3807)）。
- 2026-10-07：本仓库以 `omo-dori-mode-experimental` 的名字发布 Dori 模式（[ce53e4d](https://github.com/sisyphuslabs/dori-superagent/commit/ce53e4d)）：一个 Agent 把每项工作交给 herdr 标签页里独立的 Agent 会话，活干完了才关掉它。git 历史是公开的。
- 2026-10-31：DeepSeek 原型的首次提交。
- 2026-11-01 前后：DeepSeek 的文章。

我们每天就是这么干活的。omo 有 70k+ star。从 2026-10-03 到 2026-11-02 的 31 天里，[作者的 GitHub 贡献日历](https://github.com/code-yeongyu)记录了 38,656 次贡献：平均每天约 1,250 次，峰值是 2026-10-16 的 2,227 次和 2026-10-29 的 2,001 次。也就是一天最多约 2,000 次贡献，全部出自这套方案的完整版。

仓库根目录的 harness 是它的最小版本：只保留光靠 herdr 和 omo 就能跑起来的那部分，其他什么都没接。

## 结构相同，理念相同

把 DeepSeek 原型的文档和 Dori 放在一起看，概念是一一对应的。结构对得上：

![Dori vs DeepSeek](docs/dori-vs-deepseek.en.png)

| DeepSeek dsh-superagent | Dori |
|---|---|
| Source（GitHub、Feishu） | Dori 就在聊天工具里：Slack、Discord、Telegram |
| Trigger -> Eval -> Ticket | 在聊天里提的一个任务，就是一张工单 |
| 每个 ticket 一个 Executor 会话（一个会话，一个工作目录） | 每个任务一个编程 Agent 会话，跑在 omo 上，多条并行 |
| Channel（在原来的对话里回复，比如带上 PR） | 在同一个频道里汇报，每个任务一条状态消息，原地编辑更新 |
| Panel（只展示需要人处理的事） | 工单看板和 Notion 自己保持最新 |

他们的[理念文档](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)里的每一条也对得上：

| DeepSeek dsh-superagent | Dori |
|---|---|
| 占用人最少的注意力，交付最多的价值 | 消息短，不用表情，合并完成之后才 @ 人 |
| 只在有人要求、或团队的书面规则允许时才行动 | 方向和新想法由人来定；没人要求的活，Dori 不会自己开工 |
| 只在需要人出面时才开口，一次只问一个问题 | 每个决策都带着选项、Dori 自己的建议和一张图 |
| 如实汇报，从不绕过阻塞 | 没有证据不说“完成”；在真实案例上核对过，汇报的是已合并的结果 |

Dori 这一列是我们生产环境里的 Dori 和 Dori 模式（`skills/dori-mode`）；仓库根目录的 harness 在 herdr + omo 上实现了其中 lane、收件箱、duty 和合并门禁这一部分。

## 架构

![architecture](docs/architecture.png)

三个角色，每个都是 herdr 窗格里的一个 omo 会话。herdr 提供工作区、标签页和窗格，能识别出窗格里跑的 omo 是一个 Agent，并通过 CLI 报告它的状态（idle、working、blocked、done）。dori 对任何窗格动手之前，先读这个状态。

lead 是唯一和你对话的会话。它把你的请求写成 brief，用 `dori start` 开一条 lane，读 lane 发回来的东西，然后合并。

一条 lane 就是一个 omo 会话，开在自己的 herdr 标签页里，启动时拿到一份 brief，后面附着 lane 规则（`prompts/lane-footer.md`）。它用 `dori report` 汇报阶段进展，用 `dori ready` 收尾；`dori ready` 没有证据链接就不会发出去。

duty 循环是 `dori duty --interval 60`，一个普通进程，跑在 duty omo 会话旁边的窗格里。每一轮它把排队的消息送进已经空闲的窗格，催一下沉默太久的 lane，向 lead 上报，并把窗格已经消失的 lane 标记为 lost。

状态是 `~/.dori`（或 `$DORI_HOME`）下的 JSON 文件：`lanes/`、`inbox/`、`briefs/`、`receipts/`。harness 新增的常驻进程只有 duty 循环一个，运行时依赖只有 Bun 一个。

![lane lifecycle](docs/lane-flow.png)

`dori start <key> --brief FILE` 把 brief 加上 lane 规则写到 `~/.dori/briefs/<key>.md`，开一个标签页，运行 `omo 'Read your brief at <path> and execute it. Your lane key is <key>.'`，把 lane 记为 `working`，再给 lead 发一条 `[START <key>]`。之后 lane 汇报进展（`[REPORT <key>]`；被自己窗格之外的事卡住时是 `[REPORT <key> WAITING]`），最后以 `[READY <key>]` 加证据链接收尾。lead 核对证据，有 PR 就跑 `dori review` 和 `dori merge`，再用 `dori done <key>` 关掉这条 lane。一直空闲的 lane 会在 10 分钟和 20 分钟各被催一次，40 分钟时上报给 lead（`[ESCALATE <key>]`）。READY 之前窗格就没了的 lane，会被报告为 `[LOST <key>]`。

## 与 DeepSeek super-agent 的对应关系

| DeepSeek super-agent | dori | 在本仓库里 |
|---|---|---|
| Router 会话：和人对话，分派工作 | LEAD 会话：唯一和人对话的会话；开 lane，合并 | `prompts/lead.md`，`src/cli.ts` 里的 `up()` |
| Worker 会话，一个 ticket 一个 | LANE：每个任务一个 omo 会话，有自己的 herdr 标签页和自己的 brief | `src/harness.ts` 里的 `startLane()`，`prompts/lane-footer.md` |
| Ticket + Mandate | brief 文件 + lane 规则页脚，以及必须附带证据的 READY | `~/.dori/briefs/<key>.md`，`src/harness.ts` 里的 `ready()` |
| 触发器批处理：事件按轮次成批送达 | 窗格收件箱：发给忙碌窗格的消息先排队，等它空闲时合成一批送达 | `src/harness.ts` 里的 `send()`、`flushInbox()`；`src/store.ts` 里的 `inbox/` |
| Watchdog | DUTY 循环：清空收件箱，10/20 分钟催促，40 分钟上报，检测消失的窗格 | `src/harness.ts` 里的 `dutyTick()`，`prompts/duty.md`，`prompts/nudge.md` |
| 准入矩阵、`maxWorkers`（默认 3） | 没有；`dori start` 只拒绝已经开着的 key | `src/harness.ts` 里的 `startLane()` |
| 原型里没有 | 合并门禁：精确 head SHA 上的 CLEAR 评审回执，加全绿的检查项；空的检查列表永远不算绿 | `src/harness.ts` 里的 `review()`、`mergeGate()`，`prompts/review.md`，`src/store.ts` 里的 `receipts/` |
| 原型里没有 | 单一出口规则：lane 和 duty 从不直接和人说话 | `prompts/lead.md`，`prompts/duty.md`，`prompts/lane-footer.md` |
| 原型里没有 | 全文答案台账：每条 lane 的最终答案、证据链接和日志都落盘保存 | `src/store.ts` 里的 `Lane.final`、`Lane.log` |

## 快速开始

需要 Bun 1.3 或更高版本、herdr、omo，以及 GitHub CLI `gh`（用来读 PR 的 head SHA、检查项状态，以及执行合并）。

```sh
git clone https://github.com/sisyphuslabs/dori-superagent
cd dori-superagent
bun install
bun link   # puts `dori` on your PATH; or write `bun src/cli.ts` wherever `dori` appears below
```

启动 herdr，然后在 shell 里：

```sh
dori up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 home=~/.dori
```

这会开一个名为 `dori` 的 herdr 工作区，里面有一个 lead 窗格（system prompt 末尾附加了 `prompts/lead.md` 的 omo）、一个 duty 窗格（附加了 `prompts/duty.md` 的 omo），下面是 duty 循环。和 lead 窗格对话即可。它会自己写 brief（目标、输入、交付物、停止条件、约束；见 [`examples/brief.md`](examples/brief.md)）并开 lane，你也可以在 shell 里手动做同样的事：

```sh
dori start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p4 brief=~/.dori/briefs/fix-flaky-login.md
dori status
# lead=w1:p1 duty=w1:p2 home=~/.dori
# fix-flaky-login          working  w1:p4    active 0m ago  start: examples/brief.md
```

lane 的 key 要匹配 `^[a-z][a-z0-9-]{1,40}$`，已经开着的 key 会被拒绝。

在 lane 里，omo 用 lane 规则交给它的命令来汇报和收尾：

```sh
dori report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
dori report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
dori ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

lead 收到 `[READY fix-flaky-login]` 之后：

```sh
dori review owner/repo#12            # fresh omo reviewer pinned to the head SHA; writes a receipt; exit 0 on CLEAR
dori merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run), or MERGE_REFUSED <why> with exit 2
dori merge owner/repo#12             # gh pr merge --squash --match-head-commit <sha>
dori done fix-flaky-login            # closes the lane's pane; only a READY lane can be closed
```

`dori send <lead|duty|key|pane> --text '...'` 把一条消息送到某个窗格，窗格忙的时候就排队。`dori role <lead|duty> [PANE]` 用于没走 `dori up` 时手动注册窗格。省略 `--text` 则从 stdin 读消息。Agent 看到的命令渲染时带着 `src/cli.ts` 的完整路径，并且设置了 `DORI_HOME`，所以它们的 PATH 上不需要有 `dori`。环境变量：`DORI_HOME`（状态目录，默认 `~/.dori`）、`DORI_AGENT_CMD`（默认 `omo`）、`DORI_HERDR_SESSION`（具名的 herdr 会话）、`DORI_CMD`（告诉 Agent 怎么调用 dori）。

## harness 强制的规则

只有一个出口。lead 是唯一和你对话的会话（`prompts/lead.md`）。lane 规则要求，所有要给人看的事实一律发给 lead（`prompts/lane-footer.md` 第 3 条）；duty 会话从不合并，也从不和人说话（`prompts/duty.md`）。lane 做的每件事都以 prompt 的形式到达 lead 窗格：`[START]`、`[REPORT]`、`[READY]`、`[LOST]`、`[ESCALATE]`。

READY 必须带证据。没有至少一个 `--evidence` 链接，或者没有最终答案文本，`dori ready` 就会拒绝（`src/harness.ts` 里的 `ready()`）。文本和链接作为 `final` 存在 lane 记录上；`dori done` 拒绝任何状态不是 `ready` 的 lane，所以没有哪条 lane 能在没留下答案的情况下关闭。

忙碌的窗格不会被打断。`dori send` 先向 herdr 查询窗格里 Agent 的状态。`idle`、`done` 或普通 shell 立刻收到消息；其他状态下消息进入 `~/.dori/inbox/` 排队，命令打印 `QUEUED`。等窗格空闲下来，duty 循环把队列合成一条消息送达，开头是 "N messages arrived while you were busy"（`src/harness.ts` 里的 `send()` 和 `flushInbox()`）。`dori done` 也是同样的等法：herdr 报告为 working 或 blocked 的窗格，它拒绝关闭。

10 分钟、20 分钟催，40 分钟上报。`src/harness.ts` 里有 `NUDGE_MINUTES = [10, 20, 40]`。一条 lane 10 分钟没有汇报、窗格也不在 working，就会在自己的窗格里收到 `prompts/nudge.md`；20 分钟时再收一次；到 40 分钟，duty 循环不再催，改为给 lead 发 `[ESCALATE <key>]`。`working` 状态的窗格会重置空闲计时；汇报过 `--status waiting` 或窗格处于 `blocked` 的 lane 不会被打扰；任何一次新汇报都把催促次数清零；窗格消失则报告为 `[LOST <key>]`。

合并要有精确 head 上的 CLEAR 回执，检查项还得全绿。`dori merge` 用 `gh` 读出 PR 的 head SHA，然后要求 `~/.dori/receipts/` 里存在该 SHA 的、结论为 `CLEAR` 的回执。能写回执的只有 `dori review`。它拿固定在该 SHA 上的 `prompts/review.md` 起一个全新的非交互 omo（`omo -p --no-session`，可选 `--model`）；评审者没有打印 `VERDICT:` 行，就不写回执。接着 `gh pr checks` 必须返回至少一项检查，每一项都必须是 `pass` 或 `skipping`，并且至少有一项是 `pass`。空的检查列表会被拒绝，理由是 "an empty check list is never green"。合并本身是 `gh pr merge --squash --match-head-commit <sha>`。评审之后再 push 会改变 head SHA，回执就对不上了，合并随之被拒绝（`src/harness.ts` 里的 `review()` 和 `mergeGate()`）。

## Dori 模式（`skills/dori-mode`）

Dori 模式是面向 IM 的那一半，2026-10-07 在本仓库发布。它把一个编程 Agent 会话变成常驻的 Agent，你在 IM 里和它说话。这个会话把每项工作交给 herdr 标签页里独立的 Agent 会话，为自己启动过的每个会话维护一份注册表，只有在工作被证明完成之后才关掉它：PR 已合并、issue 已关闭、版本已发布，或者一项它自己能跑的检查。它以一个 skill（`skills/dori-mode/SKILL.md` 加 `references/`）和自己的 Bun + TypeScript CLI 的形式发布，这个 CLI 也叫 `dori`。

```sh
curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/dori-superagent/main/install.sh | bash
```

这条命令把本仓库克隆到 `~/.dori/src`，把 skill 链接到 `~/.agents/skills/dori-mode`，用 `bun link` 把 Dori 模式的 `dori` 放到 PATH 上，再把示例配置复制到 `~/.dori/config.json`。命令、配置、路由和 done 协议见 [`skills/dori-mode/SKILL.md`](skills/dori-mode/SKILL.md) 和它的 [`references/`](skills/dori-mode/references/)。

harness 和 Dori 模式都带一个叫 `dori` 的命令。一台机器只装其中一个，或者用 `bun src/cli.ts` 跑 harness，把 `dori` 留给 Dori 模式。harness 自己的 prompt 用 `src/cli.ts` 的完整路径来调用，所以它起的 Agent 从不依赖 PATH 上的 `dori` 是哪一个。

## 这不是什么

一个最小实验。harness 是 Bun 上约 660 行 TypeScript，零运行时依赖，它不是我们的生产栈。有意不放进来的：跨机器的 mesh、heavy-slot 调度、聊天工具和工单系统的桥接，以及覆盖整个测试套件的回执。放进来的是光靠 herdr 和 omo 就能跑的部分：角色、lane、收件箱、duty 循环，以及评审加合并门禁。`skills/dori-mode` 里的 Dori 模式是一个独立的 CLI，有自己的 IM 组件、主机守护和 heavy-slot 运行器；harness 不从它导入任何东西。

## 遥测

dori 和 omo 用同一种方式发送匿名的使用计数：OTLP/HTTP JSON 日志，发到 omo 的收集端 `https://t.omo.dev`。身份标识是一个随机的安装 id，存在 `~/.dori/telemetry.json` 里，发出去的只有它的 sha256。第一次发送时，收集端用这个哈希给这次安装签发一把专属的 ingest key（`POST /v1/register`），key 缓存在 `~/.dori/telemetry.json` 里，收集端返回 401 时就重新签发。代码里不带任何共享 key。第一次运行会打印一行提示。设置 `DORI_TELEMETRY=0` 即可关闭（`DO_NOT_TRACK=1` 也行）；`DORI_TELEMETRY_ENDPOINT` 用来改写收集端的 URL。

| 事件 | 何时 | 字段 |
|---|---|---|
| `dori.installed` | 首次运行 | 无 |
| `dori.daily_active` | 任何 dori 命令，每个 UTC 日一次 | `day_utc` |
| `dori.lane_started` | `dori start` | `open_lanes` |
| `dori.lane_ready` | `dori ready` | `evidence_count`、`lane_minutes` |
| `dori.review_completed` | `dori review` | `verdict`：`CLEAR` 或 `BLOCK` |
| `dori.merge_decided` | 不带 `--dry-run` 的 `dori merge` | `outcome`：`merged`、`no_receipt`、`review_block`、`no_checks`、`checks_red`、`checks_all_skipped` |
| `dori.duty_summary` | duty 循环，每小时最多一次 | `ticks`、`flushed`、`nudges`、`escalations`、`lost` |

日活、周活、月活就是从 `dori.daily_active` 算出来的。活跃数按安装计算，所以两个同时启动的运行偶尔多发一次，也不会改变数字。每条记录还带着资源字段：服务名和版本、安装哈希、CI 标志、操作系统类型（`darwin`、`linux` 或 `windows`；其他系统什么都不发）和版本、CPU 架构。永远不会发送的：路径、仓库名、PR 编号、lane 的 key、brief、消息，以及任何其他文本。发送在后台进行，每个请求超时 2 秒；命令退出前最多等它 2 秒，遥测失败也从不让命令失败。

## 测试

在仓库根目录跑 `bun test ./test/`，执行 harness 的 20 个测试，不调用任何模型。直接跑 `bun test` 会把 Dori 模式的测试也带上。

8 个 harness 单元测试（`test/harness.test.ts`）跑在一个假 herdr（`test/fake.ts`）上：它是一个录制器，顶替 `herdr` 和 `gh` 二进制，持有若干 Agent 状态可设置的窗格，还带一个由测试拨动的时钟。覆盖的场景有：lane 启动与 READY，lead 忙碌时的排队与成批送达，拒绝未知目标，10 和 20 分钟的催促、40 分钟的上报以及 WAITING 的 lane 不被打扰，working 和 lost 状态，合并门禁的每一个分支（没有回执、BLOCK、空检查列表、一项红色检查、全部跳过、CLEAR 加全绿），以及一个没有 VERDICT 行的评审者。

11 个遥测单元测试（`test/telemetry.test.ts`）覆盖：关闭开关；首次提示和每天一次的 `dori.daily_active`；每次安装只签发一次、缓存起来、401 之后重新签发的 key；与注册的 schema 相符的载荷（scope 名称和版本，只有允许的资源键，只有计数）；收集端在 200 响应里拒收的记录（`partialSuccess.rejectedLogRecords`）会被计数；每小时一次的 duty 汇总；离线首次运行时 `dori.installed` 和 `dori.daily_active` 会保留到发送成功为止；状态文件权限为 0600，状态文件损坏也不会抛出异常；调用立即返回，flush 到期限就放弃；同一个目录下同时启动的两次首次运行只会得到一个安装 id；以及收集端不可达或注册被拒时从不抛出异常，也不发送任何日志。

1 个端到端测试（`test/e2e.test.ts`）在隔离的具名会话里起一个真实的 herdr 服务器，创建工作区，注册 lead 窗格，再启动一条 lane，其 Agent 用 `test/fixtures/fake-agent.sh` 顶替 omo。脚本读取 brief，调用 `dori report` 和 `dori ready`；测试检查 `[START]`、`[REPORT]`、`[READY]` 是否到达 lead 窗格，以及 `dori done` 是否关掉了这条 lane。PATH 上没有 `herdr` 时它会被跳过，运行时带着 `DORI_TELEMETRY=0`。`bun run typecheck` 执行 `tsc --noEmit`。

Dori 模式有自己的 122 个测试，跑在假的 herdr、git 和 gh 上：

```sh
cd skills/dori-mode/scripts && bun install && bun test
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
