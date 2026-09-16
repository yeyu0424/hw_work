我把 Claude Code 的 Code Review 资料按“产品流程 → Agent 编排 → 上下文获取 → 误报过滤 → GitHub 集成 → 可落地架构”整理了一遍。重点基于 Anthropic 当前公开的 Claude Code 文档、官方 anthropics/claude-code / claude-plugins-official 源码，以及官方 claude-code-action。截至目前，Claude Code 实际上有两套值得区分的 Review 实现：托管式 Code Review 和 Claude Code Plugin / GitHub Actions 自托管式 Review。
1. 先看 Claude Code 的整体 Review 架构
可以把它抽象成下面这条链路：
                         ┌──────────────────────────┐
                         │       GitHub PR           │
                         └────────────┬─────────────┘
                                      │
                         PR opened / push / manual
                                      │
                    ┌─────────────────▼────────────────┐
                    │        Review Orchestrator        │
                    │                                   │
                    │  eligibility / dedup / scope      │
                    └─────────────────┬─────────────────┘
                                      │
                    ┌─────────────────▼─────────────────┐
                    │       Context Collection          │
                    │                                   │
                    │ diff / PR title / description     │
                    │ CLAUDE.md / comments / history    │
                    │ blame / previous PRs              │
                    └─────────────────┬─────────────────┘
                                      │
               ┌──────────────────────┼──────────────────────┐
               │                      │                      │
       ┌───────▼───────┐      ┌───────▼───────┐      ┌──────▼──────┐
       │ Reviewer #1   │      │ Reviewer #2   │      │ Reviewer #N │
       │ guideline     │      │ bug/security  │      │ history/... │
       └───────┬───────┘      └───────┬───────┘      └──────┬──────┘
               │                      │                     │
               └──────────────────────┼─────────────────────┘
                                      │
                           candidate findings
                                      │
                         ┌────────────▼────────────┐
                         │   Validation / Verify    │
                         │                           │
                         │ 是否真实问题？            │
                         │ 是否由本 PR 引入？        │
                         │ 是否符合规则？            │
                         └────────────┬────────────┘
                                      │
                              confidence filter
                                      │
                         ┌────────────▼────────────┐
                         │ Deduplicate / Severity   │
                         └────────────┬────────────┘
                                      │
                   ┌──────────────────┴──────────────────┐
                   │                                     │
          ┌────────▼────────┐                   ┌────────▼────────┐
          │ Inline comments │                   │ Review summary   │
          │ file:line       │                   │ Check Run        │
          └─────────────────┘                   └─────────────────┘
这个架构里最值得注意的不是“用 Claude 看 diff”，而是：
它实际上把 Review 做成了一个多 Agent + 验证器 + 规则上下文 + GitHub 输出的流水线。
官方托管 Code Review 文档明确描述了：多个 Agent 并行分析 diff 和周围代码，各自寻找不同类别的问题，然后再通过 verification step 验证候选问题、过滤误报，之后去重、按严重程度排序，并把结果发布成 inline comments。
2. 第一套：Claude 官方托管 Code Review
这是目前 Anthropic 官方提供的独立 Code Review 能力。
官方文档称它为：
Code Review
它并不是简单运行一个 claude 命令，而是 Anthropic 后端托管的 Review pipeline。当前文档标注为 research preview，并面向 Team / Enterprise。
2.1 触发方式
官方支持三种 Review Behavior：
模式	触发
Once after PR creation	PR 创建/Ready 后执行一次
After every push	PR 每次 push 都重新 review
Manual	手工 @claude review
One-shot manual	@claude review once
其中：
@claude review
会触发 Review，并让该 PR 后续 push 继续触发；
而：
@claude review once
只执行一次，不订阅后续 push。
这实际上形成：
PR
 ├── opened
 │     ↓
 │   review
 │
 ├── push
 │     ↓
 │   review
 │
 └── @claude review once
       ↓
     one-shot review
对于你研究 AI Code Review Harness 来说，这说明 Trigger 层和 Review Engine 是解耦的。
3. Review 的第一步其实不是“Review”
Claude Code 官方实现里首先做的是 Eligibility Check。
官方 code-review plugin 的 command 明确规定：
检查 PR 是否 closed
检查是否 draft
是否属于无需 review 的 trivial / automated PR
是否已经 review 过
符合任何条件就直接停止。
可以抽象成：
Review Request
      │
      ▼
┌───────────────────────────────┐
│     Review Eligibility Gate   │
│                               │
│ closed?                       │
│ draft?                        │
│ trivial?                      │
│ already reviewed?             │
└───────────────┬───────────────┘
                │
          eligible?
          /      \
        no        yes
        ↓          ↓
      STOP      REVIEW
这一步非常值得借鉴。
很多 AI Code Review 系统直接：
PR -> LLM
然后造成大量无效调用。
Claude 的做法是：
Event
 ↓
Eligibility
 ↓
Context
 ↓
Review
也就是把 成本控制放到了 Agent 之前。
4. 第二步：Context Collection
Claude Review 不只是获取：
git diff
而是主动收集上下文。
在官方 code-review plugin 里可以看到：
基本上下文
PR title
PR description
PR diff
modified files
项目规则
root CLAUDE.md
modified files 所在目录层级的 CLAUDE.md
历史上下文
git blame
git history
previous PRs
previous PR comments
文件上下文
modified file 中的 comments
这些信息会被不同 Reviewer 使用。
可以抽象为：
                 ┌──── PR title
                 │
                 ├──── PR description
                 │
Review Context ──┼──── git diff
                 │
                 ├──── CLAUDE.md
                 │
                 ├──── git blame
                 │
                 ├──── git history
                 │
                 ├──── previous PR
                 │
                 └──── source comments
这里其实体现了一个非常重要的设计：
Review Context ≠ Diff
而是：
Review Context = Diff + Intent + Rules + History + Local Context
5. CLAUDE.md 是 Claude Review 非常重要的一层
Claude Code 的一个核心设计是：
CLAUDE.md
它相当于 Repository-level policy / coding convention。
例如：
src/
  CLAUDE.md

  auth/
    CLAUDE.md
Review 时：
root CLAUDE.md
      +
src/CLAUDE.md
      +
auth/CLAUDE.md
会形成对应代码路径的规则上下文。
官方文档特别说明，Claude Code 会按目录层级读取 CLAUDE.md，子目录中的规则只适用于对应路径。
所以它实际上形成了一种：
Global Rules
     ↓
Repository Rules
     ↓
Directory Rules
     ↓
File / Code
这很适合做你之前研究的 AI Code Review Rule Engine。
6. REVIEW.md 是更“纯 Review”的规则层
这是一个很重要的新设计。
Claude Code 现在把：
CLAUDE.md
和：
REVIEW.md
区分开。
CLAUDE.md
属于：
General Agent Context
也就是说所有 Claude Code 工作都会使用。
REVIEW.md
属于：
Review Specific Policy
只用于 Code Review。
而且官方说明：
REVIEW.md 会被直接注入 Review pipeline 中每一个 Agent 的 system prompt，并作为最高优先级 Review instruction。
所以可以理解为：
                    Repository
                        │
        ┌───────────────┴──────────────┐
        │                              │
   CLAUDE.md                        REVIEW.md
        │                              │
General Agent Policy          Review Policy
        │                              │
        └──────────────┬───────────────┘
                       │
                 Review Agents
这一点对构建自己的 Review Harness 非常值得直接借鉴。
7. Reviewer 并不是一个 Agent
Claude Code 官方插件实际上采用了 Multi-Agent Review。
官方现有 code-review command 中可以看到：
Haiku
 ├── Eligibility checker
 ├── CLAUDE.md locator
 └── PR summarizer

        ↓

Parallel reviewers

 ├── Reviewer #1
 │     CLAUDE.md compliance
 │
 ├── Reviewer #2
 │     CLAUDE.md compliance
 │
 ├── Reviewer #3
 │     bug detection
 │
 └── Reviewer #4
       bug/security/logic
较早的官方插件实现则是 5 个并行 Sonnet Reviewer，其中额外引入：
Git history
Previous PR
Source code comments
等上下文。
所以它不是：
LLM → Review
而是：
                  PR
                   │
        ┌──────────┴──────────┐
        │                     │
   Context Agent          Summary Agent
        │                     │
        └──────────┬──────────┘
                   │
           Parallel Review
                   │
       ┌─────┬─────┼─────┬─────┐
       ↓     ↓     ↓     ↓     ↓
      Rule  Bug  History  PR  Comment
      Agent Agent Agent  Agent Agent
       └─────┴─────┼─────┴─────┘
                   ↓
               Validator
这是 Claude Code Review 最值得学习的架构之一。
8. 为什么要多个 Agent？
因为不同 Review 类型需要不同的上下文。
例如：
Reviewer A：Rules
关注：
CLAUDE.md
architecture rules
coding conventions
repository policy
Reviewer B：Bug
关注：
logic
runtime
security
incorrect behavior
Reviewer C：History
关注：
git blame
historical changes
existing implementation intent
Reviewer D：Previous PR
关注：
previous discussions
previous fixes
known problems
Reviewer E：Comments
关注：
source code comments
documentation
local assumptions
官方公开 command 文件就是这样拆分的。
这其实是一个很典型的：
Specialized Review Agents
模式。
9. Claude 特别重视 Diff Scope
这是它非常重要的设计原则。
官方 review prompt 明确要求：
主要检查 PR 引入的代码。
尤其 bug reviewer：
不要因为上下文中发现已有 bug
就把它报告出来
只有：
introduced by PR
才是主要 review 对象。
所以判断关系实际上是：
Existing Bug
      │
      └── 不由本 PR 引入
              ↓
            Ignore
而：
New Code
   ↓
Potential Bug
   ↓
Validate
   ↓
Report
这非常重要。
否则：
整个 Repository Review
很容易变成：
Repository Bug Discovery
这会极大增加噪声。
10. Claude 的一个核心机制：Candidate → Verification
这是我认为 Claude Review 最值得你研究的地方。
它不是：
Reviewer发现问题
       ↓
直接评论
而是：
Reviewer
   ↓
Candidate Finding
   ↓
Verification Agent
   ↓
是否真实？
   ↓
是否由 PR 引入？
   ↓
是否真的违反 Rule？
   ↓
Confidence
   ↓
Filter
官方 Plugin 明确规定：
对 Review Agent 找到的每一个 issue，再启动一个 Agent 对该问题进行验证。
例如：
Agent #3：

"line 73 使用了未定义变量 x"

            ↓

Verifier：

读取代码
↓
检查作用域
↓
检查 import
↓
检查上下文
↓
确认 x 是否真的不存在

            ↓

TRUE / FALSE
这样实际上构成：
Generator → Verifier
而不是单 Agent。
11. Confidence Scoring
Verification 后还不是直接输出。
Claude 会给 Finding 一个：
0 - 100
confidence score。
官方 Plugin 给出的语义大致是：
0
↓
明显误报

25
↓
可能是问题

50
↓
大概率是真的，但价值不高

75
↓
高度可信

100
↓
几乎确定
默认只保留：
>= 80
的问题。
所以整体结构其实变成：
                    Reviewer
                       │
                       ▼
                 Candidate Issue
                       │
                       ▼
                   Validator
                       │
                       ▼
                 Confidence 0-100
                       │
                ┌──────┴──────┐
                │             │
              < 80           >= 80
                │             │
              Drop          Report
这本质上就是：
LLM-based precision filter
12. Claude 对 False Positive 有明确的“负面知识”
这点非常值得做成自己的 Review Harness。
官方 prompt 明确要求不要报告：
pre-existing issues
不要报告：
lint / compiler 能发现的问题
不要报告：
pedantic nitpicks
不要报告：
subjective style preferences
不要报告：
general quality concerns
除非：
CLAUDE.md explicitly requires it
也不要报告用户没有修改的代码产生的问题。
可以抽象成：
Finding Candidate
       │
       ├── Pre-existing?
       │      └── Drop
       │
       ├── Compiler/Linter catches?
       │      └── Drop
       │
       ├── Nitpick?
       │      └── Drop
       │
       ├── Subjective?
       │      └── Drop
       │
       ├── Outside diff?
       │      └── Drop
       │
       └── Real + introduced + actionable
                    ↓
                  Keep
这实际上是降低 AI Code Review 噪声的核心方法。
13. Git History 为什么要加入 Review？
Claude 的 Review 不完全是“静态 diff 分析”。
它还会利用：
git blame
git history
previous PR
previous comments
例如：
- timeout = 1000
+ timeout = 100
单看 diff：
1000 → 100
不一定知道是不是 bug。
但是：
git blame
   ↓
发现上一版本刚修改过 timeout
   ↓
查看对应 PR
   ↓
发现业务约束要求 >= 1000ms
这时 Review Agent 才可能判断：
new change violates historical intent
官方 plugin 的 Reviewer #3 和 #4 就分别针对 git history / previous PR。
这说明 Claude 的 Review Context 更接近：
Code + History + Intent
而不是：
Diff Only
14. Review 输出不是简单的“AI报告”
Claude 最终输出主要分成两部分：
1. Inline comment
直接落到：
file:line
例如：
src/auth/session.ts:142
2. Summary
整个 Review 形成：
Review Summary
托管版还会产生：
Claude Code Review Check Run
并带 severity 和 annotations。
所以：
Finding
   │
   ├──── Inline comment
   │
   └──── Review summary / Check Run
这是典型的：
Machine finding → Native Code Review UX
15. Severity 模型
托管 Code Review 当前公开的 severity 包括：
🔴 Important
🟡 Nit
🟣 Pre-existing
含义分别对应重要问题、小问题、以及虽然存在但并非由当前 PR 引入的问题。
这里很重要的一点是：
它并没有把所有问题都变成“阻塞 PR”。
官方托管 Review 明确不会 approve 或 block PR，而是保持原有 review workflow 不变。Check Run 也采用 neutral conclusion。
也就是：
AI Review
    ↓
Finding
    ↓
Human Review
    ↓
Existing Merge Policy
而不是：
AI says fail
    ↓
PR blocked
16. GitHub Inline Comment 的实现
对于自托管 Plugin，Claude Code 主要通过：
gh CLI
以及官方的：
mcp__github_inline_comment__create_inline_comment
发布结果。
官方 command 对 inline comment 还有非常明确的约束：
1 comment / unique issue
full commit SHA
repo must match
line range
context lines
小型修复还可以直接给：
suggestion block
大的结构化修改只给文字建议，不直接给可提交 suggestion。
这说明输出层本身也是一个完整的：
Finding → Comment Formatter → GitHub Publisher
17. 第二套：Claude Code + GitHub Actions
如果不是使用 Anthropic 的托管 Code Review，还可以自己部署：
GitHub Actions
       ↓
anthropics/claude-code-action@v1
       ↓
Claude Code
       ↓
Review
       ↓
GitHub Comment
Anthropic 官方文档明确说明：
Claude Code GitHub Actions 是构建在 Claude Agent SDK 之上的。
因此它其实给了你一个非常适合自定义 Harness 的入口。
18. 官方 CI Review 示例
Anthropic 官方仓库直接提供了 PR review 示例：
name: Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest

    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

          prompt: |
            Perform a comprehensive code review...
官方示例还展示了：
Code Quality
Security
Performance
Testing
Documentation
等 Review 维度，并允许 Claude 通过：
mcp__github_inline_comment__create_inline_comment
gh pr diff
gh pr view
gh pr comment
等工具进行 PR 分析与评论。
19. 两套架构的区别
这一点对于你的研究很重要。
维度	Managed Code Review	Plugin / GitHub Actions
运行环境	Anthropic infrastructure	你的 CI / Claude Code
Trigger	PR / Push / Manual	GitHub Actions / 自定义
Agent orchestration	Anthropic 内部托管	Command / Prompt 自定义
Review rules	CLAUDE.md + REVIEW.md	CLAUDE.md + 自定义 Prompt
Agent 数量	多 Agent	自己定义
Verification	内置	可以自己设计
Confidence filter	内置	可以自己实现
Git history	支持	可通过 Git/gh
Inline comment	原生	gh / MCP
Merge gate	默认不阻塞	自己决定
可扩展性	较低	很高
适合自建 Harness	参考实现	非常适合
20. Claude 的 Review Harness 可以抽象成 8 个组件
结合官方实现，我建议把 Claude Code Review 的工程结构抽象为：
┌──────────────────────────────────────────────┐
│               Review Trigger                 │
│ GitHub Event / CLI / @claude review          │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│              Eligibility Gate                │
│ duplicate / draft / trivial / closed         │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│             Context Builder                  │
│ diff / PR / repo / rules / history           │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│            Reviewer Dispatcher                │
│ rule / bug / security / history / test       │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│            Parallel Reviewers                │
│        N independent agents                  │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│              Finding Validator                │
│ verify / reproduce / scope / intent           │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│          Confidence + Dedup Engine            │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│                Publisher                     │
│ Inline Comment / Summary / Check Run         │
└──────────────────────────────────────────────┘
21. 如果从 Harness 角度看，Claude 最值得借鉴的几个设计
结合你前面在研究的 “如何基于 Harness 实现 Code Review”，Claude Code 这套实现里面有几个设计特别值得直接抽象。
21.1 Review 前置 Gate
不要：
Event → Agent
而应该：
Event
 ↓
Eligibility
 ↓
Context
 ↓
Agent
这样第一层就能降低成本和噪音。
21.2 Reviewer Specialized
不要：
一个 Agent 检查一切
而应该：
Rule Reviewer
Bug Reviewer
Security Reviewer
History Reviewer
Test Reviewer
Architecture Reviewer
然后：
parallel
这也是 Claude Code 当前 Plugin 设计的核心。
21.3 Reviewer 和 Validator 分离
这个设计尤其值得移植：
Reviewer
   ↓
Candidate
   ↓
Validator
   ↓
Final finding
Review Agent 的职责是：
发现可能的问题
Validator 的职责是：
证明这个问题是真的
这样比：
单 Agent 自己发现 + 自己确认
更容易提高 precision。
22. 一个更适合你自己实现的版本
如果你要自己做一个 AI Code Review Harness，我建议直接参考 Claude 的模式：
                         GitHub PR
                             │
                             ▼
                     ┌──────────────┐
                     │ Event Trigger│
                     └──────┬───────┘
                            │
                            ▼
                  ┌───────────────────┐
                  │ Eligibility Gate  │
                  │                   │
                  │ duplicate        │
                  │ trivial          │
                  │ draft            │
                  │ ignored paths    │
                  └─────────┬─────────┘
                            │
                            ▼
                  ┌───────────────────┐
                  │ Context Builder   │
                  │                   │
                  │ diff              │
                  │ repo structure    │
                  │ CLAUDE.md         │
                  │ REVIEW.md         │
                  │ history           │
                  │ PR discussion     │
                  └─────────┬─────────┘
                            │
                    ┌───────┴────────┐
                    │                │
                    ▼                ▼
              Reviewer Pool     Context Pool
                    │
        ┌───────────┼─────────────┐
        ▼           ▼             ▼
      Bug        Security       Rules
      Agent      Agent          Agent
        │           │             │
        └───────────┼─────────────┘
                    ▼
             Candidate Findings
                    │
                    ▼
             Validation Agents
                    │
                    ▼
            Confidence Scoring
                    │
                    ▼
                Dedup
                    │
                    ▼
              Severity Class
                    │
              ┌─────┴──────┐
              ▼            ▼
        Inline Comment    Summary
这个结构已经很接近 Claude Code 自己公开出来的 Review 思路。
23. Claude Code Review 的“核心方法论”
如果把整个实现进一步压缩，我认为可以总结成：
                   Claude Code Review
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
     Context            Agents            Verification
        │                  │                  │
    ┌───┼───┐        ┌─────┼─────┐       ┌────┼────┐
    │   │   │        │     │     │       │    │    │
   Diff Rule History Bug  Security Rules  Verify Scope
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ↓
                     High Precision
                           ↓
                    GitHub Native UX
真正的重点不是模型本身，而是：
Context Engineering + Multi-Agent Decomposition + Verification + Noise Filtering + Native Review Integration。
这也是 Claude Code Review 和简单的：
git diff | LLM | output
之间最大的工程差异。
24. 对你正在研究的 AI Code Review Harness，建议重点拆这 6 个模块
结合你前面研究的 Qodo、CodeRabbit、Claude Code，我建议把 Claude Code 的研究重点进一步落到：
1. Review Orchestrator
   └── 如何调度 Reviewer

2. Context Engine
   └── Diff / Repo / Rule / History / PR

3. Reviewer Pool
   └── Bug / Security / Rule / Architecture

4. Verification Engine
   └── Candidate → Validate

5. Finding Engine
   └── confidence / severity / dedup / scope

6. GitHub Publisher
   └── inline comment / summary / check
其中 Verification Engine + Finding Engine 是我认为最值得继续深入逆向分析的部分，因为它们直接决定 AI Code Review 的 precision，而不是单纯决定“能不能发现问题”。