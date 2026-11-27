# 后续想法与可参与的方向

本项目即将停止主动开发，进入维护状态。下面这些想法维护者目前没有排期，但思路已经整理出来，欢迎任何人接手，或者提交一部分 PR。每条都写了大致难度、价值和起点文件。

难度和工时按“熟悉 JS/TS、借助 AI 写代码”的人来估算，仅供参考。路径前缀 `srvprotianti/`、`srvprotiantiweb/` 分别指服务端仓库和网页客户端仓库。

**参与方式：** 本项目大部分代码是维护者指挥 AI 写的，欢迎你也用自己的 AI 来改。动手前先读目标仓库的 `AGENTS.md`（模块路由与规则）。改动尽量小而独立，一个 PR 只做一件事。

## 适合先上手的

### 把服务端移植到其他环境的说明文档（PORTING）
- **现状：** 架构是插件化的，但以下内容都是为 1103 环境写死的：卡池与禁卡表、协议与规则版本（`srvprotianti/ops/versions.json`、`config/config.json`）、旧裁定脚本、卡组分类规则（`srvprotianti/plugins/deck_analysis/`）、官网介绍页文案、Bot 文案。
- **思路：** 写一份文档，逐项说明换一个环境时要改哪个文件、改动有多大、哪些可以照搬。暂不改代码。
- **难度：** 低，1～2 天，需要有人实际试着移植一次，再把踩过的坑补进去。

### 首次进入的新手引导
- **现状：** 网页版和天梯助手的功能已经比较全，但新玩家不一定知道从哪里开始。
- **思路：** 首次进入时显示三步提示：填昵称、进入 TT 匹配、查看录像。之后可以关掉，不再显示。
- **难度：** 低到中，2～3 天。

## 有价值但工作量较大的

### 网页版残局模式
- **现状：** 网页客户端已经在浏览器里运行一个本地 ocgcore 引擎，用于手牌测试（`srvprotiantiweb/src/practice/`）。残局本质上是一段调用 `Debug.*` 的 Lua 脚本。
- **思路：** 让本地引擎加载残局脚本，复用现有的对局界面。之后可以在旧裁定说明里放“点这里亲手试一下这条裁定”的链接。
- **难度：** 中，3～5 天，主要工作是引擎的脚本加载接口和残局胜负条件。

### 匿名对局数据集（战绩 + 卡组 + 录像，三者可以互相对应）
- **目标：** 让研究者能做细粒度分析，例如某张卡是否打出、对胜率有多大实际影响。因此三类数据必须能互相关联，而且全部匿名。
- **可能的思路（未经验证）：**
  1. 玩家名用“名字 + 不公开的盐”做哈希，映射成稳定的匿名 ID（例如 `P01234`）。同一个人在所有文件里的 ID 一致；盐由维护者保管，不随数据发布。
  2. 战绩表：对局 ID、日期、双方匿名 ID、胜者、卡组类型、先后手、等级分变化。
  3. 卡组表：每个对局中每位玩家的主卡组、额外卡组、副卡组卡片列表（来自 `duel_log_player` 的卡组字段）。
  4. 录像：改写 `.yrp` 文件头里的玩家名（录像格式的解析可参考 `srvprotiantiweb/src/replay/format.ts`），压缩录像要先解压、改写后再重新压缩；文件名一律改成对局 ID。
  5. 附一份示例脚本，从录像里提取“每张卡在哪一回合被打出”，降低使用门槛。
- **必须处理的风险：**
  - 官网排行和录像页本来就公开昵称和对局时间，研究者可能把匿名对局时间线和公开数据对上，反推出真人。可以把时间精度降到“天”，并且不发布等级分的绝对值。
  - 公开前应在社群公告，给玩家一段可以申请把自己排除在外的时间。
  - 发布前由第二个人核对一遍，确认文件中没有残留原名，同时检查 IP 字段已被丢弃。
- **难度：** 中到高，3～5 天，大部分时间花在录像改写和核对上。

### 1103 环境专用 AI
- **为什么 1103 适合做 AI：** 卡池固定、规模小，规则也比现代环境简单，有可能比现代环境更容易做出强 AI。
- **三条路线，按成本从低到高（都未经验证）：**
  1. **WindBot（成本最低）：**
     - 宿主自带 WindBot 接口，配置项 `windbot` 默认关闭，见 `srvprotianti/data/default_config.json`。
     - [WindBot](https://github.com/IceYGO/windbot) 用 C# 为每套卡组手写一个出牌逻辑（executor），作为普通客户端连进房间，所以对局时用的就是服务器上的旧裁定脚本。
     - 思路：先给主流卡组（兔 beat、代行、六武等）各写一个 executor，用 AI 写 executor 应该很快。它的水平有限，适合陪练和新手练习，做不到强对手。
     - 难度：中，一套卡组 1～2 天。另外要确认 WindBot 在大师规则 2 下能正常运行。
  2. **固定卡组 + 预先验证的打法 + 被打断后重新规划（中等）：**
     - [YGO Lab](https://ygolab.net/practice) 是一个闭源的商业网站，面向 TCG 现行环境。从它公开的说明看，做法是：
       - 每个 AI 只用一套公开的固定卡组。
       - 先攻的展开路线事先在引擎上逐步算好、验证过。
       - 被手坑打断后，换一条后续路线，或者从当前场面重新规划。
       - 后攻时由 AI 决定什么时候发手坑。
       - 所有候选动作都来自引擎给出的合法选项，所以不会出现非法操作。
     - 引擎是 ygopro-core 加 Project Ignis 的脚本，网页上能玩，手机也能用。它的技术细节没有公开，以上是根据它对外的说明归纳的。
     - 用在 1103 上的折扣：1103 的长展开和手坑都少，胜负更多取决于盖卡时机和中盘的资源交换，所以“事先算好开局”的收益比现代环境小。可以借鉴的是框架本身：固定卡组，并且只在引擎给出的合法动作里搜索。
     - 难度：中到高。
  3. **强化学习自对弈（成本最高）：**
     - 已有基础：[sbl1996/ygo-agent](https://github.com/sbl1996/ygo-agent)，基于 ygopro-core 的强化学习环境与智能体，MIT 协议，曾接入 Neos 网页客户端；[MirrorForce](https://github.com/tommy85/MirrorForce)，首届 YGO AI 比赛冠军，采用自对弈强化学习。
     - 思路：①把卡库和旧裁定脚本换成本服的版本；②用本服卡组分类数据里的主流卡组组成对局池；③在单张 GPU 上做自对弈训练；④用上面的匿名录像评估 AI 的水平，也可以拿来做模仿学习的预训练。
     - 接入网页版：上游 Neos 曾集成过 ygo-agent，后来在提交 `dcc8cd4f` 中移除，可以从这次提交之前的历史里找回接入代码。
     - 难度：高，需要有强化学习经验的人投入数周。
- **部署：** 路线 2 和 3 的推理需要单独部署一个服务，不适合放在现在这台 4 核 4 GB 的游戏服务器上。WindBot 进程较轻，但也要先实测占用。

### 线上比赛：报名、自动配对、自动开下一轮
- **现状：** 本环境办过最多 128 人的线上赛，平时 32～64 人。现在没有比赛功能，只有 TT 天梯随机匹配。宿主自带的 `tournament_mode` / `challonge` 是给外部比赛平台用的，本服没启用。
- **思路：** 新写一个比赛插件，不放进宿主：报名表、按轮次配对（瑞士轮或单败）、到点自动建好每桌房间并通知双方、收结果后开下一轮。房间可以沿用 TT 的认证和结算前置（账号进房时验证、开局登记席位），比赛结果单独记表，不计入天梯积分。
- **服务器容量（2026-11-27 估算）：**
  - **密码哈希不是瓶颈。** 单次 scrypt 实测约 40 ms（i7-8750H，单核），128 人同时进房经 4 个执行槽约 1.5 秒排完，峰值内存约 64 MiB。进房排队默认 256 个，已能容纳 128 人同时进房；更大规模在 `ladder-core` 的 `passwordSecurity` 里调 `joinQueue`、`slots`。
  - **对局进程才是主要开销。** 每个房间一个 YGOPro 子进程，旧文档估算每房约 12 MB（未在新机实测）。128 人一轮是 64 桌同时开：子进程约 0.8 GB，加上 Node、PostgreSQL（约 0.2～0.4 GB）和系统，**4 GB 内存不够宽裕**；现网 4 核 4 GB 的 Windows 机还同时跑着机器人、隧道等进程，11-23 实测只剩约 0.7 GB 可用。
  - **建议：** 迁机后若要办 64 人以上的比赛，新机至少 4 核 8 GB；或者比赛时临时开一台按量计费的服务器单独跑比赛（不连天梯库），赛后释放。先在新机上开 64 个房间实测子进程内存和 CPU，再定规格。
- **难度：** 中到高，1～2 周；配对规则、掉线判负、迟到弃权这些规则要先和比赛组织者定下来。

## 评估后不打算做的
- **基于 KoishiPro 二次开发独立客户端：** C++ 客户端的构建、签名、分发和跟进上游都需要长期维护。网页版已经提供操作取消、随机猜拳、手牌测试这些功能。
- **YGOMobile 版天梯助手：** 维护者没有安卓设备，无法实机测试。改为写一份手机玩家手动更新脚本的说明。
- **独立的残局编辑器：** 用 AI 直接写残局 Lua 已经很快，写一份“如何让 AI 写残局”的教程更有用。
- **开启宿主自带的云录像（`cloud_replay`，玩家在客户端输入 `R#编号` 观看）：**
  - **来历：** 早期讨论换机时，曾把它当作录像方案。后来本服做了自己的录像体系：每局保存 `.yrp`，由录像站（`plugins/public-replay-web/`）公开，网页版按脚本版本播放。这套体系覆盖了它的用途，所以一直没开（`config.json` 里为 `enabled: false`）。
  - **它的长处：** 回放时服务器推送的是当时的对局消息，本地不重新运行脚本，所以不受本地脚本版本影响。
  - **不开的原因：**
    - 只有观战视角，看不到手牌，信息量不如 `.yrp`。
    - 只对开启之后的对局有效。
    - 聊天只在竞技模式或比赛模式下才会录入，本服这两个模式都没开。
    - 没有过期清理。
  - **如果要开，先改一处：** 每局录像会按玩家存一个查询键（`cloud_replay_player.key`，来自 `CLIENT_get_authorize_key`）。本服的这个键是 `昵称$密码` 明文，要先改成账号名或者哈希值。开启后再观察一天，确认表的增长量。

---

## Summary (English)

This project is entering maintenance mode. The ideas below are unscheduled; anyone is welcome to pick one up or send partial PRs. Most code here was written by directing AI agents. Feel free to use your own. Read the target repository's `AGENTS.md` first.

- **Good first tasks:**
  - A PORTING guide for running this server for another format.
  - A first-visit guide in the web client.
- **Larger:**
  - A puzzle mode in the web client (the local ocgcore engine already exists in `src/practice/`).
  - A possible approach to an anonymized, cross-linked dataset of results, decklists and replays, with pseudonymous IDs (salted hash) and rewritten replay headers.
  - A possible format-specific AI. There are three routes, from cheapest to most expensive:
    - WindBot deck executors: the server already has a disabled `windbot` hook.
    - Fixed decks with pre-verified lines and replanning, like [YGO Lab](https://ygolab.net/practice).
    - Self-play RL on [ygo-agent](https://github.com/sbl1996/ygo-agent) or [MirrorForce](https://github.com/tommy85/MirrorForce).
    - The fixed, small 2011 card pool may make it a good research environment.
  - Online tournaments (sign-up, automatic pairing and rounds; past events had up to 128 players). Password hashing is not the bottleneck (~40 ms per login); one engine process per table is, so a 64-table round wants at least 4 cores / 8 GB or a temporary separate server.
- **Not planned:**
  - A KoishiPro-based desktop client.
  - A YGOMobile companion app.
  - A standalone puzzle editor.
  - Enabling the host's built-in cloud replay (`cloud_replay`, `R#id`).
    - It is covered by our own `.yrp` archive and the version-aware web replay player.
    - It only records the spectator view and has no retention.
    - Before enabling it, change the per-player lookup key: here it is the plaintext `name$password`.
