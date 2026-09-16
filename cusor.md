收集整理 Cursor Bugbot 的 code review 流程 实现方式等资料
我把 Cursor Bugbot 目前公开资料按「产品流程 → Agent/Harness → Review Pipeline → Context → Rules → 验证/去重 → Autofix → Feedback Learning → 工程基础设施 → 可借鉴架构」整理了一遍。重点放在你前面一直关注的 AI Code Review + Harness 方向。
说明：Cursor 没有公开 Bugbot 的完整内部源码，所以以下会明确区分「官方公开实现」和「基于公开资料可以推断的架构」。
1. Bugbot 是什么
Cursor Bugbot 是 Cursor 面向 PR 的代码审查 Agent，主要目标不是做传统 lint，而是发现：
Logic bugs
Edge cases
Security issues
Performance issues
Code-quality problems
项目特定的 invariant / coding rules
它直接接入 GitHub/GitLab/Bitbucket/Azure DevOps 的 PR/MR 流程，对 diff 进行分析并产生 inline review comments。
目前已经不只是一个简单的：

PR
 ↓
LLM
 ↓
Review comments
而更接近：
                 ┌─────────────────────┐
                 │      PR / MR        │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ Review Orchestrator │
                 └──────────┬──────────┘
                            │
            ┌───────────────┼────────────────┐
            ▼               ▼                ▼
       Diff/Repo         Rules           PR History
        Context          Context           Context
            │               │                │
            └───────────────┼────────────────┘
                            ▼
                 ┌─────────────────────┐
                 │   Agentic Reviewer   │
                 │                     │
                 │  Reason + Search    │
                 │  + Inspect + Verify │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ Findings / Evidence │
                 └──────────┬──────────┘
                            ▼
                 ┌─────────────────────┐
                 │ Validation / Filter │
                 │ Dedup / Ranking     │
                 └──────────┬──────────┘
                            ▼
                 ┌─────────────────────┐
                 │ GitHub Review       │
                 │ Inline Comments     │
                 └──────────┬──────────┘
                            │
                  ┌─────────┴─────────┐
                  ▼                   ▼
              Developer            Autofix
              Feedback          Cloud Agent
                  │                   │
                  └─────────┬─────────┘
                            ▼
                       Learned Rules
这个架构其实已经非常接近一个完整的 Code Review Agent Harness。
2. Bugbot 的完整 Review 流程
目前官方文档明确说明，Bugbot：
PR 更新时可以自动触发
可以通过 cursor review / bugbot run 手动触发
会读取 PR 已有的 top-level / inline comments
避免重复提出已经存在的问题
Review 完成后写入 SCM comment
同时产生 CI check status。
因此可以抽象成：
                PR Open / Push
                     │
                     ▼
              Trigger Detector
                     │
                     ▼
             Load PR Metadata
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
     Current Diff           Previous Review
          │                     │
          └──────────┬──────────┘
                     ▼
             Context Builder
                     │
          ┌──────────┼───────────┐
          ▼          ▼           ▼
       Repo       Rules       PR Comments
       Context    Context      Context
          │          │           │
          └──────────┼───────────┘
                     ▼
               Review Agent
                     │
             ┌───────┴────────┐
             │                │
         Search/Inspect    Reasoning
             │                │
             └───────┬────────┘
                     ▼
                  Findings
                     │
                     ▼
             Validation / Filter
                     │
                     ▼
              Deduplication
                     │
                     ▼
               Review Output
                     │
            ┌────────┼─────────┐
            ▼        ▼         ▼
         Inline    Summary    CI Status
         Comment
                     │
                     ▼
                 Feedback
这里最值得注意的是：Review Agent 并不是一次性把整个 Repository 塞给模型。
3. 最核心的变化：从 Pipeline Agent → Agentic Reviewer
这是 Bugbot 技术路线里最值得研究的一点。
Cursor 在 2026 年 1 月公开了 Bugbot 的演进过程。

早期 Bugbot 使用的是比较固定的 Pipeline：

8 parallel passes
       ↓
similar findings grouping
       ↓
majority voting
       ↓
description merging
       ↓
category filtering
       ↓
validator model
       ↓
dedup
官方明确披露过早期版本采用：
8 个并行 review pass
每次随机化 diff 顺序
合并相似 bug
majority voting
合并成统一描述
过滤不需要的类别
validator model
与之前结果 dedupe。
可以理解为：
                  PR Diff
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
      Pass 1       Pass 2       Pass N
        │            │            │
        ▼            ▼            ▼
     Finding      Finding      Finding
        │            │            │
        └────────────┼────────────┘
                     ▼
               Cluster Findings
                     │
                     ▼
              Majority Voting
                     │
                     ▼
              Merge Findings
                     │
                     ▼
             Category Filter
                     │
                     ▼
               Validator
                     │
                     ▼
                  Dedup
                     │
                     ▼
                 Comment
这个设计很适合解决 LLM Code Review 最典型的问题：
模型很容易“看起来发现了 bug”，但实际上是 False Positive。
多次独立推理 + voting，可以把：
一次偶然 hallucination
过滤掉。
4. 后来为什么转向 Agentic Architecture
Bugbot 后来的架构发生了非常重要的变化。
Cursor 官方明确表示，他们后来将 Bugbot 转成了 fully agentic design：

agent 可以 reasoning over diff、调用 tools，并自行决定哪里需要进一步深入。
也就是说：
老架构
Diff
 ↓
固定 Pipeline
 ↓
Pass 1
 ↓
Pass 2
 ↓
Validator
 ↓
Output
新架构
                    ┌──────────────┐
                    │   PR Diff    │
                    └──────┬───────┘
                           ▼
                  ┌──────────────────┐
                  │ Review Agent     │
                  │                  │
                  │ "这个改动有问题?" │
                  └────────┬─────────┘
                           │
                  ┌────────┴─────────┐
                  ▼                  ▼
             Search Code         Inspect Diff
                  │                  │
                  ▼                  ▼
            Read Related         Analyze Caller
              Files
                  │                  │
                  └────────┬─────────┘
                           ▼
                    More Reasoning
                           │
                  ┌────────┴────────┐
                  ▼                 ▼
              Enough Evidence?     No
                  │                 │
                 Yes                └──→ More Tools
                  │
                  ▼
               Finding
也就是说：
Bugbot 不再规定 Agent 必须按照固定步骤检查，而是让 Agent 自己决定什么时候搜索、搜索什么、需要多少上下文。
这是整个架构最值得借鉴的地方之一。
5. Harness 才是 Bugbot 的核心
Cursor 自己对 Agent Harness 的定义非常清晰：
Harness = Instructions + Tools + Model
即：
Agent Harness
├── Instructions
├── Tools
└── Model
而且 Cursor 强调：
不同模型需要不同的 instructions / tools 组合。
这对于 Bugbot 特别重要。
因此 Bugbot 可以理解成：

                 Bugbot Harness
                       │
       ┌───────────────┼────────────────┐
       │               │                │
       ▼               ▼                ▼
 Instructions        Tools            Model
       │               │                │
       │               │                │
       │          ┌────┴─────┐          │
       │          │          │          │
       │        Search      Read        │
       │        Diff        Repo        │
       │        PR          Files       │
       │                              │
       └──────────────┬───────────────┘
                      ▼
                 Review Agent
所以如果你要自己做 AI Code Review，我会把重点放在 Harness，而不是 Prompt。
6. Context 是 Bugbot 的另一个核心
Bug Review 最大的问题之一不是模型不会找 bug，而是：
模型不知道应该看什么。
Cursor 的做法是大量采用 Dynamic Context。
官方描述：

将更多信息从 static context 移到 dynamic context，让 Agent 在运行过程中自己获取需要的信息。
例如：
PR:
  修改 payment/service.go

Agent:
  ↓
  查看 diff
  ↓
  "这里调用了 PaymentService"
  ↓
  Search PaymentService
  ↓
  "这里又调用了 Transaction"
  ↓
  Search Transaction
  ↓
  "Transaction 有状态机"
  ↓
  Read state machine
  ↓
  发现状态转换问题
而不是：
把整个 repo
↓
一次性塞进 Context
↓
LLM
7. Context 可以分成 5 层
根据目前公开资料，可以把 Bugbot 的 Context 模型抽象为：
                    Review Context
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
        ▼                ▼                 ▼
     Diff Context    Repository        PR Context
                        Context
        │                │                 │
        │                ├─ source files   ├─ comments
        │                ├─ dependencies   ├─ previous findings
        │                └─ patterns       └─ discussions
        │
        └────────────────┬─────────────────┘
                         │
                         ▼
                    Rule Context
                         │
                  ┌──────┼──────┐
                  ▼      ▼      ▼
                Team    Repo   Learned
                Rules   Rules   Rules
其中 PR comments 特别值得注意。
Bugbot 会把过去的 PR 评论作为 context，从而避免重复报告同一个问题。

这实际上是一个非常简单但有效的：

Review Memory

8. Rules 系统设计得非常成熟
Bugbot 的规则不是只有一个 BUGBOT.md。
目前至少存在：

Team Rules
     ↓
Repository Rules
     ↓
.cursor/BUGBOT.md
     ↓
Learned Rules
     ↓
Manual Rules
官方给出的组合顺序是：
Team Rules
    ↓
project .cursor/BUGBOT.md
    ↓
learned rules
    ↓
manual rules
并最终合并为 review-rules block。
9. BUGBOT.md 支持目录级规则
这是非常值得直接借鉴的设计。
例如：

project/
├── .cursor/
│   └── BUGBOT.md
│
├── backend/
│   ├── .cursor/
│   │   └── BUGBOT.md
│   └── payment/
│       └── ...
│
├── frontend/
│   ├── .cursor/
│   │   └── BUGBOT.md
│   └── ...
Bugbot Review：
修改 backend/payment/*
       │
       ▼
project/.cursor/BUGBOT.md
       +
backend/.cursor/BUGBOT.md
       ↓
Review Context
官方明确说明，Bugbot 会根据 changed files 向上遍历并加载相关 .cursor/BUGBOT.md。
这其实就是：

Path-aware Review Policy
非常适合企业代码库。
10. Rules 不是单纯 Prompt，而是 Policy Layer
例如：
# Payment Review

## Security

Changes under payment/** must:
- validate authorization
- avoid logging card information

## Transaction

Any modification to transaction state machine
must preserve:
PENDING -> SUCCESS
PENDING -> FAILED

## Testing

Payment logic changes require tests.
然后 Agent：
Diff
 ↓
Path Matcher
 ↓
Relevant Rules
 ↓
Agent
因此可以形成：
Global Policy
      │
      ▼
Repository Policy
      │
      ▼
Directory Policy
      │
      ▼
Learned Policy
      │
      ▼
PR-specific Policy
      │
      ▼
Review Agent
这已经不是普通的 Prompt Engineering，而是一个 Review Policy Engine。
11. Learned Rules：非常值得研究
这是我认为 Bugbot 目前最有意思的设计之一。
2026 年 4 月 Cursor 开始让 Bugbot 从真实 PR feedback 中学习规则。

它主要利用三类信号：

Developer Feedback
       │
       ├── 👎 Bugbot comment
       │
       ├── Reply to Bugbot
       │
       └── Human reviewer comment
然后：
Feedback
   ↓
Candidate Rule
   ↓
Evaluate on future PRs
   ↓
Enough evidence?
   │
   ├── Yes → Active Rule
   │
   └── No  → Candidate
如果一个 Active Rule 后来产生大量负反馈：
Active Rule
     ↓
Negative Signal
     ↓
Disable
官方就是这样描述其 learned-rule promotion / disabling 机制的。
12. @cursor remember 是一个很漂亮的产品设计
开发者甚至可以直接在 PR 中：
@cursor remember

This repository uses Result<T,E>
instead of throwing exceptions in service layer.
Bugbot 将其转化成 Learned Rule，并用于后续 Review。
因此：

Human Knowledge
       ↓
PR Comment
       ↓
Learned Rule
       ↓
Future Review
这实际上把：
Code Review → Knowledge Accumulation
串起来了。
13. Review 的核心质量控制
Bugbot 的一个核心目标不是：
找最多的问题
而是：
找到真正会被修复的问题。
Cursor 因此设计了一个非常重要的指标：
Resolution Rate
定义大致是：
Resolution Rate
=
被报告的问题中
最终在 PR merge 前被作者修复的问题
/
报告的问题总数
Cursor 用 AI 判断 PR merge 时某个 finding 是否已经被解决，并把它作为 Bugbot 的核心质量指标。
这比简单统计：

issues found = 1000
要有意义得多。
因为：

1000 findings
↓
950 false positives
显然不是高质量 Review。
而：

200 findings
↓
170 被修复
可能更有价值。
14. Bugbot 的 Evaluation Loop
这就形成一个完整的：
                 Review System
                       │
                       ▼
                  PR Findings
                       │
                       ▼
                  Developer
                  Resolution
                       │
                       ▼
                 Merge PR
                       │
                       ▼
               Resolution Judge
                       │
                       ▼
               Quality Metrics
                       │
                       ▼
                 Experiment
                       │
                       ▼
          Prompt / Model / Tool /
          Context / Pipeline
                       │
                       ▼
                 New Version
Cursor 公开表示，他们使用 resolution rate 做线上 hill-climbing，同时还有一个叫 BugBench 的离线 benchmark，里面包含真实代码 diff 和人工标注 bug。
这意味着 Bugbot 的研发不是：

工程师感觉这个 Prompt 好
而是：
Change
 ↓
Experiment
 ↓
Offline Eval
 ↓
Online Eval
 ↓
Resolution Rate
 ↓
Ship / Reject
15. Bugbot 早期是 Multi-Agent / Multi-Pass
这个点如果你准备实现自己的 Code Review Harness，非常值得借鉴。
早期：

                 PR Diff
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
     Agent1       Agent2       Agent8
       │            │            │
       ▼            ▼            ▼
    Finding       Finding       Finding
       │            │            │
       └────────────┼────────────┘
                    ▼
                 Voting
每个 pass 甚至会对 diff 做不同顺序排列，让模型从不同 reasoning path 去分析。
这个思想可以推广为：

Reviewer A
  → Logic

Reviewer B
  → Security

Reviewer C
  → Concurrency

Reviewer D
  → Performance

Reviewer E
  → API Compatibility
然后：
Finding Aggregator
       ↓
Evidence Aggregation
       ↓
Validator
16. 但是现在不是简单 Multi-Agent
这里要特别区分：
早期 Bugbot ≠ 当前 Bugbot。

Cursor 后来明确表示，最大的收益来自切换到 fully agentic architecture。

所以现在更接近：

             Review Agent
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
      Search    Inspect    Analyze
        │         │         │
        └─────────┼─────────┘
                  ▼
              Reasoning
                  │
                  ▼
             Need more?
              /      \
            Yes       No
             │         │
             ▼         ▼
          Tool call  Finding
这也是为什么我认为：
Bugbot 更应该被理解为一个 Code Review Harness，而不是一个 Prompt。
17. Effort Level：动态控制推理成本
2026 年 5 月以后，Bugbot 增加了：
Low
Default
High
Smart
其中：
Low：降低成本
Default：速度 / 成本平衡
High：投入更多 reasoning
Smart：根据条件动态选择。
可以抽象成：
PR
 │
 ├── trivial change
 │       ↓
 │     Low
 │
 ├── normal PR
 │       ↓
 │    Default
 │
 ├── security/payment/core
 │       ↓
 │     High
 │
 └── custom policy
         ↓
       Smart
这其实就是：
Adaptive Compute Allocation

18. 2026 年 6 月：增量 Review
Bugbot 后来增加了：
只 Review 上一次 Review 之后新增的代码。
例如：
Commit A
   ↓
Review A

Commit B
   ↓
只分析 B-A

Commit C
   ↓
只分析 C-B
而不是：
Commit A
 ↓
Commit B
 ↓
Commit C
 ↓
每次重新 Review A+B+C
这对大型 Repository 非常重要。
可以把它理解成：

Review State

last_review_commit = abc123

new commit = def456

review_target =
    diff(abc123, def456)
19. Review Cache / Review Memory
结合：
previous PR comments
previous review commit
dedup
incremental review
可以推导出 Bugbot 有一层很重要的：
Review Memory
大概可以建模为：
ReviewMemory
├── PR ID
├── Commit SHA
├── Findings
├── Finding location
├── Finding fingerprint
├── Resolution status
├── Previous comments
└── Review context
当新 commit 到来：
new findings
      ↓
fingerprint
      ↓
existing finding?
      │
      ├── Yes → update
      │
      └── No  → new comment
这是 Code Review Agent 中非常重要的工程能力。
20. Autofix：Review → Fix
2026 年 2 月 Bugbot 增加了 Autofix。
它的架构不是让原 Review Agent 直接修改代码，而是：

Bugbot
  │
  │ finding
  ▼
Cloud Agent
  │
  ▼
Isolated VM
  │
  ├── inspect code
  ├── modify code
  ├── run tests
  └── validate
       │
       ▼
    Proposed Fix
Cursor 明确表示 Autofix 会启动 Cloud Agent，在独立 VM 中工作并测试软件。
这个设计很重要：

Review Agent 和 Fix Agent 解耦。
21. 为什么 Review Agent 不应该直接 Fix
如果让一个 Agent：
发现问题
 ↓
自己改
 ↓
自己说改好了
容易出现：
False Finding
     ↓
错误修改
     ↓
测试刚好通过
     ↓
错误被自动提交
Bugbot 的方式更接近：
Reviewer
    │
    ▼
Finding
    │
    ▼
Fixer Agent
    │
    ├── modify
    ├── test
    └── validate
    │
    ▼
Human / PR
这是一个非常适合生产系统的 Agent Boundary。
22. 2026 年 6 月：本地 Review + PR Review 联动
现在还可以在 Cursor 本地使用：
/review
/review-bugbot
/review-security
先在 Push 前进行 Review。
更重要的是：

Local Review
     │
     ▼
Push
     │
     ▼
Create PR
     │
     ▼
Bugbot
如果 PR 的 diff 与本地已经 Review 的 diff 相同，Bugbot 可以识别并跳过重复 Review。
因此 Cursor 正在形成：

                 Code Review
                      │
         ┌────────────┴────────────┐
         ▼                         ▼
    Local Review              PR Review
         │                         │
         └────────────┬────────────┘
                      ▼
                 Shared State
这非常像一个统一 Review Engine。
23. CI/CD 层面的设计
Bugbot 还提供 CI status。
GitHub：

Cursor Bugbot
可以产生：
success
neutral
failure
默认发现问题时通常是 neutral，只有配置 fail-on-unresolved-issues 后，未解决 findings 才可以导致 failure。
所以：

                    Bugbot
                       │
                       ▼
                 Review Findings
                       │
                       ▼
                 Status Generator
                       │
           ┌───────────┼────────────┐
           ▼           ▼            ▼
        success      neutral      failure
           │           │            │
           └───────────┼────────────┘
                       ▼
                  Branch Policy
                       │
                       ▼
                     Merge
24. API 层
现在 Enterprise 还提供 Bugbot API。
核心接口：

POST /bugbot/review
提交 PR URL 后：
API Request
    ↓
Queue Review
    ↓
Async Review
    ↓
request_id
然后：
GET /analytics/team/bugbot-reviews
获取：
reviewed commit
findings count
billed cost
resolution data
dry-run findings 等。
还有一个很值得借鉴的功能：
Dry Run
{
  "prUrl": "...",
  "dryRun": true
}
它会：
完整执行 Review
        ↓
保存 Findings
        ↓
不发布 GitHub Comment
        ↓
用于 Evaluation
这对构建 Code Review Harness 非常重要。
25. Bugbot 的工程架构，我建议这样理解
综合 Cursor 已公开的信息，我会把它拆成 9 层：
┌───────────────────────────────────────────────┐
│                SCM Integration                │
│ GitHub / GitLab / Bitbucket / Azure DevOps   │
└──────────────────────┬────────────────────────┘
                       │
┌──────────────────────▼────────────────────────┐
│                 Trigger Layer                 │
│ PR Open / Push / Comment / API / Local Review│
└──────────────────────┬────────────────────────┘
                       │
┌──────────────────────▼────────────────────────┐
│               Review Orchestrator              │
│ Scheduling / Retry / Dedup / Incremental      │
└──────────────────────┬────────────────────────┘
                       │
┌──────────────────────▼────────────────────────┐
│                Context Engine                  │
│ Diff / Repo / Search / PR History / Rules     │
└──────────────────────┬────────────────────────┘
                       │
┌──────────────────────▼────────────────────────┐
│                 Review Harness                 │
│ Instructions + Tools + Model + Agent Loop     │
└──────────────────────┬────────────────────────┘
                       │
┌──────────────────────▼────────────────────────┐
│                Finding Engine                  │
│ Reasoning / Evidence / Classification         │
└──────────────────────┬────────────────────────┘
                       │
┌──────────────────────▼────────────────────────┐
│             Validation & Quality               │
│ Validator / Filter / Dedup / Ranking           │
└──────────────────────┬────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
┌───────────────────┐      ┌────────────────────┐
│ Review Output     │      │ Autofix Agent      │
│ Comments / Check  │      │ VM / Test / Patch  │
└─────────┬─────────┘      └──────────┬─────────┘
          │                           │
          └─────────────┬─────────────┘
                        ▼
              ┌──────────────────────┐
              │ Feedback / Learning  │
              │ Rules / Metrics      │
              └──────────────────────┘
26. 如果从 Harness 角度看，Bugbot 最值得借鉴的 8 个设计
结合你前面一直在研究的 Code Review Harness，我会重点关注下面这些：
设计	Bugbot 做法	对自研系统的价值
Agentic Review	Agent 自主决定搜索/深入	★★★★★
Dynamic Context	按需获取代码上下文	★★★★★
Multi-pass	早期并行 review + voting	★★★★☆
Validator	独立验证 finding	★★★★★
Review Memory	利用历史 comments / findings	★★★★★
Rules	Team/Repo/Path/Learned Rules	★★★★★
Resolution Rate	以“是否被修复”评价 Review	★★★★★
Learned Rules	从真实 Review feedback 学规则	★★★★★
27. 如果你要自己实现，我建议不要照搬早期 Bugbot
比较推荐的是：
                 Code Review Harness
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
    Instructions        Tools           Model
        │                │                │
        │          ┌─────┼─────┐          │
        │          ▼     ▼     ▼          │
        │        Search Read  Git         │
        │          │     │     │          │
        └──────────┼─────┼─────┼──────────┘
                   ▼     ▼     ▼
                 Agentic Loop
                       │
                       ▼
                 Finding Candidates
                       │
             ┌─────────┴──────────┐
             ▼                    ▼
         Validator            Evidence
             │                    │
             └─────────┬──────────┘
                       ▼
                  Dedup / Rank
                       │
                       ▼
                   Findings
                       │
              ┌────────┴────────┐
              ▼                 ▼
           Comment            Autofix
                                │
                                ▼
                              Test
                                │
                                ▼
                             Validate
即：
Agentic Reviewer + Harness + Validator + Review Memory + Feedback Loop
而不是：
Prompt
 ↓
LLM
 ↓
JSON
28. 一个可以直接落地的 Review Harness
如果按照 Bugbot 的思想，我建议你的 Harness 至少提供这些 Tool：
CodeReviewTools
├── get_pr_metadata()
├── get_pr_diff()
├── get_changed_files()
│
├── read_file()
├── search_code()
├── find_references()
├── find_definition()
├── get_callers()
├── get_callees()
│
├── get_previous_reviews()
├── get_previous_comments()
│
├── run_test()
├── run_linter()
├── run_typecheck()
├── run_build()
│
├── create_finding()
├── validate_finding()
└── mark_review_complete()
然后 Agent：
Review Agent
│
├── Understand PR
│
├── Identify risky changes
│
├── Search related code
│
├── Form hypothesis
│
├── Gather evidence
│
├── Test hypothesis
│
├── Produce finding
│
└── Decide whether confidence is sufficient
29. Finding 数据结构
一个非常关键的设计是不要让 Agent 直接输出 GitHub comment。
建议中间增加：

{
  "id": "...",
  "category": "logic_bug",
  "severity": "high",
  "confidence": 0.91,
  "title": "...",
  "description": "...",
  "location": {
    "file": "src/payment.ts",
    "start_line": 124,
    "end_line": 128
  },
  "evidence": [
    "...",
    "..."
  ],
  "rule_id": "...",
  "fingerprint": "...",
  "suggested_fix": "...",
  "needs_human_review": true
}
这样后面才能做：
Finding
 ↓
Validator
 ↓
Dedup
 ↓
Ranking
 ↓
Comment
 ↓
Resolution Tracking
而不是让 LLM 一步生成最终文本。
30. 最重要的一个闭环：Review → Resolution → Learning
如果要真正做到 Bugbot 级别，最后一定要做：
              PR Review
                  │
                  ▼
              Findings
                  │
                  ▼
             Developer
             Response
                  │
        ┌─────────┼──────────┐
        ▼         ▼          ▼
     Fixed     Rejected    Discussed
        │         │          │
        └─────────┼──────────┘
                  ▼
             Resolution
                Judge
                  │
                  ▼
             Review Metrics
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
     Harness               Rules
     Experiment           Learning
        │                    │
        └─────────┬──────────┘
                  ▼
             Next Review
这实际上就是：
Code Review Agent 的 Reinforcement Loop
而不是简单的“一次性 AI Review”。
31. Cursor Bugbot 的演进路线
把 2025 → 2026 的技术演进压缩一下，会非常清楚：
2025
│
├── LLM Code Review
│
├── Multi-pass
│     └── 8 parallel passes
│
├── Majority voting
│
├── Validator
│
└── Dedup
│
▼
2026 early
│
├── Agentic Architecture
│
├── Dynamic Context
│
├── Tool-driven reasoning
│
└── Harness optimization
│
▼
2026
│
├── Autofix
│
├── Learned Rules
│
├── Adaptive Effort
│
├── Incremental Review
│
├── Local + PR Review
│
└── API / Analytics
│
▼
Next direction
│
├── Self-verification
├── Deep research
├── Continuous scanning
└── More autonomous fixing
Cursor 自己也明确把后续方向描述为让 Bugbot 验证自己的 finding、对复杂问题做 deep research、持续扫描代码库。
32. 我认为最值得你研究的核心
如果你的目标是继续做你前面提到的：
“如何基于 Harness 做 Code Review”
那么 Cursor Bugbot 最值得拆解的不是 UI，也不是 Prompt，而是这 5 个核心模块：
① Review Harness
   Instructions + Tools + Model

② Dynamic Context Engine
   Diff → Search → Dependency → Runtime Context

③ Finding Validation
   Candidate → Evidence → Validator → Dedup

④ Review Memory
   Previous findings → PR comments → fingerprints

⑤ Learning Loop
   Developer feedback → Learned Rules → Future Reviews
尤其是：
Agentic Review
      +
Dynamic Context
      +
Validator
      +
Review Memory
      +
Resolution Rate
这五个组合起来，基本就是一个比较完整的 Production-grade AI Code Review Harness。
官方资料
Cursor Bugbot 官方文档
Building a better Bugbot：官方架构/研究文章
Bugbot Autofix
Bugbot Learned Rules
Bugbot 2026 年 6 月性能与增量 Review 更新
Cursor Code Review 实践
Cursor Agent Harness 最佳实践
如果你接下来要继续做这个方向，我可以直接把 Cursor Bugbot、CodeRabbit、Qodo、Claude Code、Codex、GitHub Copilot 的 Review Pipeline 按同一套 Harness 维度拆开，最后整理成一张 “主流 AI Code Review 架构对比 + 可直接落地的自研 Harness 架构”。
在使用额度在 15:19重置前，文件、图像和数据分析不可用。你可以继续仅使用文本聊天，或升级以获得更多使用权限。
免费试用 Plus





