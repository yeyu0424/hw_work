可以。下面我按你前面整理 **CodeRabbit / Qodo / Claude / Codex / Copilot / Bugbot** 的方式，专门从 **Code Review Harness / Agent Workflow / Context / Tools / Multi-Agent / Verification / Feedback Learning** 角度拆解 **Cubic**。

先说结论：**Cubic 最值得研究的地方不是“用了哪个模型”，而是它把 Code Review 做成了一个“Repository-aware + Multi-agent + Feedback-learning + Verification”的 Harness。** Cubic 官方也明确描述过，它早期采用单一大 Prompt，后来经过三次架构调整，转向显式 reasoning、更少工具和 specialized micro-agents，并报告 false positive 降低 51%。([Cubic][1])

---

# 1. Cubic 是什么

Cubic 是一个面向 GitHub 的 AI Code Review 平台，核心定位不是简单的：

> Diff → LLM → Comments

而是：

> **PR → Repository Context → Specialized Review Agents → Evidence/Reasoning → Finding Filtering → Verification → GitHub Comments → Developer Feedback → Memory**

官方目前把它定位为面向复杂代码库的 AI Code Reviewer，并强调 repository-level understanding，而不仅仅是 diff-level review。([cubic documentation][2])

它目前覆盖：

* GitHub PR Review
* PR Summary
* Custom Agents
* Codebase Context
* Team Review Learning / Memory
* Background Agents
* Codebase Scan
* Local CLI Review
* IDE / Coding Agent Integration
* AI Wiki
* Jira / Linear / Notion / Confluence 等上下文连接

这些能力共同组成了一个比较完整的 **AI Code Review Harness**。([Cubic][3])

---

# 2. Cubic 的整体 Code Review 架构

从公开资料可以还原出一个比较合理的架构：

```text
                         GitHub PR
                            │
                            ▼
                    ┌───────────────┐
                    │ Event Trigger │
                    │ GitHub Webhook│
                    └───────┬───────┘
                            │
                            ▼
                 ┌────────────────────┐
                 │ Review Orchestrator│
                 └─────────┬──────────┘
                           │
          ┌────────────────┼─────────────────┐
          │                │                 │
          ▼                ▼                 ▼
    PR / Diff         Repository        Team Memory
     Context           Context           / Learnings
          │                │                 │
          └────────────────┼─────────────────┘
                           ▼
                ┌────────────────────┐
                │ Review Planner      │
                │ / Agent Dispatcher  │
                └─────────┬──────────┘
                          │
             ┌────────────┼─────────────┐
             ▼            ▼             ▼
        Bug Agent    Security Agent   Duplication
             │            │             │
             ▼            ▼             ▼
        Architecture   Editorial     Custom Agents
             │            │             │
             └────────────┼─────────────┘
                          ▼
                 Candidate Findings
                          │
                          ▼
                ┌───────────────────┐
                │ Reasoning / Judge │
                └─────────┬─────────┘
                          │
                          ▼
                 Evidence / Verify
                          │
                          ▼
                ┌───────────────────┐
                │ Finding Filtering │
                │ Dedup / Priority  │
                └─────────┬─────────┘
                          │
                    ┌─────┴──────┐
                    ▼            ▼
               PR Summary    Inline Comments
                    │            │
                    └──────┬─────┘
                           ▼
                      Developer
                       Feedback
                           │
                  ┌────────┴────────┐
                  ▼                 ▼
               Fix Agent        Memory/Learning
                  │                 │
                  ▼                 │
              New Commit            │
                  │                 │
                  └───────┬─────────┘
                          ▼
                       Re-review
```

这里需要注意：**Cubic 没有公开完整内部源码，因此上图不是官方公布的内部类图，而是根据官方文档、工程博客和公开行为反推的 Harness 架构。**

---

# 3. 第一阶段：PR Event Trigger

Cubic 的 GitHub Review 从 PR 生命周期开始。

官方公开流程是：

```text
PR Opened
   │
   ▼
GitHub Webhook
   │
   ▼
Cubic Review
   │
   ▼
Analyze Diff + Context
   │
   ▼
Publish Review
```

官方安全文档明确描述：

1. GitHub PR opened / updated
2. GitHub webhook 发送事件
3. Cubic 创建 isolated sandbox
4. AI 分析 PR diff + 必要 context
5. 通过 GitHub API 发布 review comments
6. sandbox 销毁

([cubic documentation][4])

所以它实际上已经具备一个标准的 **Review Job Runtime**：

```text
GitHub Event
     ↓
Review Job
     ↓
Ephemeral Sandbox
     ↓
Agent Execution
     ↓
Review Result
     ↓
GitHub
```

这一点对于你自己设计 Code Review Harness 很重要。

---

# 4. Context 获取：Cubic 的核心竞争力之一

Cubic 和传统：

```text
PR diff
   ↓
LLM
```

最大的区别是 **Repository Context**。

GitHub Marketplace 对 Cubic 的描述直接强调：

> analyzes your entire repository, not just the diff

并强调它会：

* 跳转 definition
* 搜索 files
* 理解 architecture
* 分析 broader system

([GitHub][5])

因此 Cubic 的 Context 可以抽象成：

```text
                    Review Context
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
      Diff          Changed Files    Repository
        │                │                │
        │                ▼                │
        │           Dependencies         │
        │                                 │
        └──────────────┬──────────────────┘
                       │
                       ▼
                Team Knowledge
                       │
                       ▼
               External Context
```

---

# 5. Repository Context 是怎么来的？

Cubic 官方文档明确支持多种 repository context 文件：

```text
README.md
CODEBASE-CONTEXT.md
*-context.md
AGENTS.md
.cursorrules
.ai/*
.cursor/*
.github/*
.continue/*
```

这些内容会帮助 Agent 理解：

* Architecture
* Coding conventions
* Domain knowledge
* Common patterns
* Dependencies

([cubic documentation][6])

这其实对应一个非常值得移植的设计：

```text
Repository
│
├── README.md
├── AGENTS.md
├── CODEBASE-CONTEXT.md
│
├── .ai/
│   └── ...
│
├── .cursor/
│
└── .github/
```

Agent 不应该只把代码作为 Context。

应该把：

```text
Code
+
Architecture
+
Rules
+
Team Knowledge
+
Historical Review
```

一起作为 Context。

---

# 6. AI Wiki：Repository-level Context Index

Cubic 还有一个非常有意思的组件：

**AI Wiki**

它会：

```text
Repository
     │
     ▼
Index Codebase
     │
     ▼
Generate Documentation
     │
     ├── Architecture
     ├── Components
     ├── Data Flow
     └── Source Links
```

官方称 AI Wiki 会把代码库转换成 searchable knowledge base，并生成：

* documentation
* source links
* architecture diagrams

([cubic documentation][7])

这意味着 Cubic 实际上不是每次 Review 都从零理解 Repository。

可以理解为：

```text
Repository
     │
     ▼
Codebase Understanding
     │
     ▼
Persistent Knowledge
     │
     ├── Architecture
     ├── Modules
     ├── Patterns
     └── Relationships
              │
              ▼
        Review Context
```

这是一个非常重要的优化。

---

# 7. Review Agent：从 Monolithic Agent 到 Micro Agents

这是 Cubic 最值得研究的部分。

Cubic 官方自己公开过早期架构：

```text
Diff
 ↓
Single Large Prompt
 ↓
Comments
```

结果出现大量：

* False Positive
* Nitpick
* 已经解决的问题
* Linter 已经检查过的问题
* 无价值建议

最终开发者开始忽略评论。

Cubic 进行了三次主要架构调整，并报告 false positives 降低 51%，同时没有牺牲 recall。([Cubic][1])

---

# 8. 第一版：Do-Everything Agent

早期：

```text
                    ┌─────────────┐
Diff ──────────────►│             │
                    │   Big LLM   │
Repository ───────►│             │
                    │             │
Rules ─────────────►│             │
                    └──────┬──────┘
                           │
                           ▼
                       Comments
```

优点：

* 简单
* 开发快
* Token context 集中

缺点：

* Context 太大
* Rule 太多
* Agent cognitive overload
* 很难调试
* 很难知道为什么产生某个 comment

这其实就是很多第一代 AI Code Review 工具的问题。

---

# 9. 第二个关键改造：Explicit Reasoning

Cubic 的一个关键变化是：

**不要直接让 Agent 输出 comment。**

而是先：

```text
Detect
 ↓
Reason
 ↓
Justify
 ↓
Comment
```

也就是：

```text
Candidate Issue
      │
      ▼
Why is this an issue?
      │
      ▼
What evidence supports it?
      │
      ▼
Could this be intentional?
      │
      ▼
Is this already handled?
      │
      ▼
Should we report it?
      │
      ▼
Final Finding
```

Cubic 明确表示，要求模型先解释其 reasoning，可以：

* 提高结构化思考
* 更容易 debug
* 找出错误 pattern
* 减少 arbitrary conclusions

([Cubic][1])

这实际上非常接近一个 **Review Judge Harness**。

---

# 10. 第三个关键改造：减少 Tools

Cubic 最初给 Agent 很多工具：

```text
LSP
Static Analysis
Test Runner
Terminal
...
```

后来发现：

> 工具越多不一定越好。

他们通过 reasoning logs 发现大量工具实际上很少被使用。

于是把工具缩减到核心：

```text
Simplified LSP
+
Basic Terminal
```

官方公开的经验是：删除使用率低于约 10% 的工具。([Cubic][1])

这个设计非常值得注意。

传统 Agent Framework 容易犯：

```text
Agent
 ├── Git
 ├── GitHub
 ├── Search
 ├── Browser
 ├── LSP
 ├── AST
 ├── Bash
 ├── Test
 ├── Docker
 ├── ...
```

Cubic 的思路反而是：

```text
                Review Agent
                    │
            ┌───────┴────────┐
            ▼                ▼
        Repository          Terminal
        Navigation
```

**Tool minimization 是提升 Agent precision 的手段。**

---

# 11. 第四个关键改造：Specialized Micro-Agents

这是 Cubic Harness 最值得移植的设计。

它没有继续往一个 Prompt 里添加：

```text
if test.ts → ignore
if init.py → ignore
if markdown → ignore
...
```

而是拆成多个 Specialized Agents。

官方举例包括：

```text
Planner
Security Agent
Duplication Agent
Editorial Agent
...
```

([Cubic][1])

可以抽象成：

```text
                     PR
                      │
                      ▼
                   Planner
                      │
          ┌───────────┼───────────┐
          │           │           │
          ▼           ▼           ▼
        Bug        Security    Duplication
       Agent         Agent        Agent
          │           │           │
          ▼           ▼           ▼
       Arch        Editorial    Custom
       Agent         Agent       Agents
          │           │           │
          └───────────┼───────────┘
                      ▼
                  Findings
```

---

# 12. 为什么 Micro-Agent 有效？

因为每个 Agent 可以拥有自己的：

```text
Prompt
Context
Tool
Reasoning
Output Schema
Evaluation
```

例如：

### Security Agent

```text
Goal:
Find security vulnerabilities

Context:
- changed code
- auth modules
- data flow

Tools:
- search
- LSP
- terminal

Output:
Finding[]
```

### Duplication Agent

```text
Goal:
Find duplicated logic

Context:
- changed functions
- related modules

Tools:
- repository search

Output:
Finding[]
```

### Architecture Agent

```text
Goal:
Find architectural violations

Context:
- module dependencies
- architecture rules
- CODEBASE-CONTEXT

Output:
Finding[]
```

于是可以独立优化：

```text
Security Agent
    ↓
Security benchmark

Duplication Agent
    ↓
Duplication benchmark

Architecture Agent
    ↓
Architecture benchmark
```

这比一个“大而全”的 Agent 更容易做 Evals。

---

# 13. Custom Agents：把 Review Rule Agent 化

Cubic 还有一个非常值得研究的设计：

**Custom Agents**

用户可以用自然语言定义：

> All API endpoints must include error handling...

或者：

> Avoid using `any` type in TypeScript function parameters

Cubic 会把它变成一个 review rule / agent。([cubic documentation][8])

架构可以理解成：

```text
Team Rule
   │
   ▼
Custom Agent Definition
   │
   ├── Scope
   ├── Prompt
   ├── Pattern
   └── Expected Behavior
          │
          ▼
     Review Agent
          │
          ▼
       Finding
```

更重要的是，它支持：

**一个 Agent Rule → 多个 Repository**

这已经不是简单 Prompt，而是：

> **Reusable Review Policy**

---

# 14. Review Rule Library

Cubic 的 Custom Agents 还有一个 Rule Library：

```text
              Agent Library
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      Security   Architecture  TypeScript
        │           │           │
        └───────────┼───────────┘
                    ▼
             Repository A
             Repository B
             Repository C
```

官方文档明确支持跨 repository 管理 custom agents。([cubic documentation][8])

如果你正在设计自己的 Code Review Harness，这个设计可以直接借鉴：

```text
ReviewPolicy
     │
     ├── global
     ├── organization
     ├── repository
     └── directory
```

---

# 15. Findings Pipeline

一个真正成熟的 Code Review Agent，核心不是：

```text
find issue
```

而是：

```text
find candidate
       ↓
validate
       ↓
deduplicate
       ↓
prioritize
       ↓
publish
```

Cubic 的公开资料虽然没有公布完整内部实现，但从它强调的：

* explicit reasoning
* specialized agents
* minimal comments
* addressed issue auto-resolution
* feedback learning

可以比较确定地还原出这样的逻辑：

```text
Agent Findings
       │
       ▼
Candidate Findings
       │
       ▼
Evidence Validation
       │
       ▼
Duplicate Detection
       │
       ▼
Existing Comment Check
       │
       ▼
Priority
       │
       ▼
Should Comment?
       │
       ▼
GitHub Comment
```

---

# 16. “少评论”其实是 Cubic 的核心目标

这一点非常重要。

传统 Code Review Agent：

```text
发现越多问题
       ↓
越多 comment
       ↓
看起来越厉害
```

Cubic 的方向相反：

```text
Potential Issues
       ↓
Filter
       ↓
High Confidence Issues
       ↓
Few Comments
```

Cubic 官方明确强调：

> only surfaces issues worth your attention

并且强调 minimal verbosity。([cubic documentation][2])

这实际上意味着它优化的 Objective 不是：

```text
Recall
```

而是：

```text
Developer Value
```

可以抽象成：

```text
Review Quality
=
True Positive
/
(Comments + False Positive)
```

---

# 17. Feedback Learning

这是 Cubic 的另一个核心能力。

用户可以：

```text
👍
👎
Reply
Fix
Resolve
```

这些行为都会成为后续 Review 的反馈。

官方明确表示，downvote 会影响后续 review，并且 Cubic 会从团队反馈中学习。([cubic documentation][9])

---

# 18. 更重要的是：学习历史 PR Review

Cubic 官网目前还明确强调：

> learns from senior developers

以及：

> onboards by reading your senior developers' comments

([Cubic][3])

所以它的 Memory 可以理解为：

```text
Historical PRs
      │
      ▼
Senior Engineer Comments
      │
      ▼
Review Patterns
      │
      ▼
Learned Rules
      │
      ▼
Future Reviews
```

这是非常值得移植到自己 Harness 的能力。

---

# 19. Memory 不应该只是 Vector DB

如果自己实现，我不建议简单做：

```text
PR comments
    ↓
Embedding
    ↓
Vector DB
    ↓
RAG
```

Cubic 这种场景更适合：

```text
Review History
      ↓
Pattern Extraction
      ↓
Structured Learning
      ↓
Review Policy
```

例如历史评论：

> Don't access DB directly from controller.

可以抽取成：

```yaml
rule:
  name: controller-db-boundary

scope:
  - controllers/**

violation:
  - direct database access

preferred:
  - service layer

severity:
  - warning
```

以后 Agent 才能稳定使用。

---

# 20. Incremental Review

另一个值得注意的设计是：

**PR 更新后不要完全重新 Review。**

Cubic 支持 incremental review。

官网对 reviewed lines 的定义也特别提到：

> incremental reviews only count newly reviewed changes

([Cubic][3])

因此合理的 Harness 应该是：

```text
PR v1
 ↓
Review
 ↓
Comments

PR v2
 ↓
Diff(v2, v1)
 ↓
Only changed areas
 ↓
Re-review
```

而不是：

```text
PR v2
 ↓
重新扫描整个 PR
```

---

# 21. Comment Resolution

Cubic 有一个非常关键的交互：

```text
AI Comment
     │
     ├── Developer fixes
     │
     ├── Developer rejects
     │
     └── Developer asks question
```

如果问题已经解决：

```text
Old Finding
     ↓
New Commit
     ↓
Re-evaluate
     ↓
Auto Resolve
```

这解决了 AI Code Review 的一个经典问题：

> 评论越来越多，但没有生命周期。

成熟的 Finding 应该是：

```text
OPEN
 │
 ├── FIXED
 │
 ├── REJECTED
 │
 └── INVALIDATED
```

而不是永久 comment。

---

# 22. Background Agent：Review → Fix

Cubic 现在已经把：

```text
Review
```

和：

```text
Fix
```

连接起来。

流程：

```text
Review
  │
  ▼
Finding
  │
  ▼
"Fix with cubic"
  │
  ▼
Background Agent
  │
  ▼
Modify Code
  │
  ▼
Commit
  │
  ├── push to current PR
  │
  └── create Fix PR
  │
  ▼
Re-review
```

官方文档明确说明，Background Agent 可以生成修复，并默认将 commit 推到 PR branch，也可以要求创建独立 fix PR。([cubic documentation][10])

---

# 23. Background Agent 的 Runtime

Cubic 的安全设计非常值得注意。

官方说明：

```text
Background Agent
        │
        ▼
Sandbox
        │
        ▼
Claude Code
        │
        ▼
Modify repository
        │
        ▼
Commit / PR
```

Review 本身也是 ephemeral sandbox：

```text
Sandbox
 ├── filesystem
 ├── memory
 └── logs

       ↓

destroy
```

并且 sandbox 没有 network egress。([cubic documentation][4])

所以它实际上具备：

> **Agent Runtime Isolation**

而不是直接让 LLM 在生产 repository 上执行 shell。

---

# 24. Local Review：把 Review 前移

Cubic 不只在 GitHub Review。

它还有 Local CLI：

```text
Developer
    │
    ▼
Local Changes
    │
    ▼
cubic review
    │
    ▼
AI Review
    │
    ▼
Fix
    │
    ▼
Review Again
```

甚至支持：

```text
"loop until clean"
```

即：

```text
Review
 ↓
Fix
 ↓
Review
 ↓
Fix
 ↓
Review
 ↓
Clean
```

官方 IDE Skills 文档明确描述了这个 loop。([cubic documentation][11])

---

# 25. Cubic Loop

这其实已经非常接近一个标准 Agent Harness：

```text
               ┌───────────────┐
               │   Run Review  │
               └───────┬───────┘
                       │
                       ▼
                 Findings?
                  /       \
                No         Yes
                │           │
                ▼           ▼
              Done        Fix
                            │
                            ▼
                       Re-review
                            │
                            └───────┐
                                    │
                                    ▼
                              Review Again
```

可以定义：

```python
while iteration < MAX_ITERATIONS:
    findings = review()

    if findings.empty():
        break

    fixes = agent.fix(findings)

    verify(fixes)
```

但真正成熟的版本还应该加入：

```text
Regression detection
Fix validation
Comment invalidation
Loop budget
Token budget
Confidence threshold
```

---

# 26. Cubic 的 IDE / Agent Integration

目前 Cubic 已经不是单纯 GitHub App。

它支持：

* Cursor
* Claude Code
* VS Code
* Codex
* Gemini CLI
* OpenCode
* 其他 coding agents

([cubic documentation][12])

而且可以通过 MCP：

```text
Coding Agent
      │
      ▼
Cubic MCP
      │
      ├── Review
      ├── Comments
      ├── Wiki
      ├── Learnings
      └── Scan
```

官方 MCP endpoint：

```text
https://www.cubic.dev/api/mcp
```

并使用 Bearer API Key。([cubic documentation][12])

这说明 Cubic 正在从：

> AI Code Review Tool

逐渐变成：

> **Code Review Infrastructure / Context Service**

---

# 27. Cubic 当前的 Harness 可以拆成 9 层

如果从你前面研究的 Harness 角度，我会把 Cubic 拆成：

| Layer              | Cubic 实现                                          |
| ------------------ | ------------------------------------------------- |
| Trigger            | GitHub Webhook                                    |
| Context            | Diff + Repository + Context Files                 |
| Knowledge          | AI Wiki + Review History                          |
| Planner            | Planner Agent                                     |
| Specialized Agents | Bug / Security / Duplication / Editorial / Custom |
| Tools              | Simplified LSP + Terminal                         |
| Reasoning          | Explicit reasoning / justification                |
| Judge              | Finding filtering / confidence                    |
| Output             | PR Summary + Inline Comments                      |
| Feedback           | 👍 / 👎 / Reply / Fix                             |
| Memory             | Team Review Patterns                              |
| Fix                | Background Agent                                  |
| Verification       | Re-review                                         |
| Runtime            | Ephemeral Sandbox                                 |
| Local Loop         | CLI Review + loop until clean                     |
| Analytics          | Comments / Fix Rate / Downvote / Merge Time       |

---

# 28. 和传统 LLM Code Review 最大的区别

可以画成：

### Traditional

```text
Diff
 ↓
Prompt
 ↓
LLM
 ↓
Comments
```

### Cubic

```text
                   Repository
                       │
              ┌────────┴────────┐
              │                 │
          Context            Memory
              │                 │
              └────────┬────────┘
                       ▼
                     Planner
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
        Bug        Security      Custom
        Agent        Agent        Agent
          │            │            │
          └────────────┼────────────┘
                       ▼
                    Reason
                       │
                       ▼
                   Validate
                       │
                       ▼
                    Filter
                       │
                       ▼
                   Comments
                       │
                       ▼
                    Feedback
                       │
                       ▼
                    Memory
```

**这才是 Cubic 真正值得研究的地方。**

---

# 29. Cubic 最值得学习的 8 个工程设计

如果你的目标是自己做一个 AI Code Review Harness，我认为最值得直接借鉴的是：

### ① Specialized Micro-Agent

不要：

```text
One Agent
+
100 条规则
```

而应该：

```text
Planner
 ├── Bug
 ├── Security
 ├── Architecture
 ├── Duplication
 ├── Test
 └── Custom
```

---

### ② Explicit Reasoning → Finding

不要：

```text
LLM → Comment
```

而应该：

```text
Candidate
 ↓
Evidence
 ↓
Reason
 ↓
Confidence
 ↓
Finding
```

---

### ③ Repository Context

不要只给：

```text
git diff
```

应该：

```text
Diff
+
Definitions
+
References
+
Architecture
+
Rules
+
Historical Review
```

---

### ④ Tool Minimization

不要无限增加工具。

应该：

```text
Measure tool usage
       ↓
Remove low-value tools
       ↓
Keep core tools
```

Cubic 自己就是这么演进的。([Cubic][1])

---

### ⑤ Review Memory

把：

```text
Human Review
```

转换成：

```text
Reusable Review Policy
```

这是 AI Code Review 从：

> Generic AI

走向：

> Team-specific AI

的关键。

---

### ⑥ Finding Lifecycle

每个 Finding 都应该有状态：

```text
Candidate
   ↓
Validated
   ↓
Published
   ↓
 ┌─┴────────┐
 ▼          ▼
Fixed     Rejected
 │
 ▼
Resolved
```

---

### ⑦ Review → Fix → Verify

不要停在：

```text
AI 找问题
```

而应该：

```text
Find
 ↓
Fix
 ↓
Test
 ↓
Review
 ↓
Verify
 ↓
Resolve
```

---

### ⑧ Offline Eval

Cubic 自己提到大量 **offline testing**，并通过架构调整来衡量 false positives / recall。([Cubic][1])

这说明 Code Review Agent 的核心研发闭环应该是：

```text
Real PR
   ↓
Ground Truth
   ↓
Replay
   ↓
Agent
   ↓
Metrics
   ↓
Prompt / Architecture
   ↓
Replay
```

而不是：

```text
Prompt
 ↓
感觉不错
 ↓
上线
```

---

# 30. Cubic 的 Code Review Benchmark 思路

如果我们把它抽象成评测：

```text
                    Code Review Eval
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
       Recall          Precision        Noise
          │                │                │
          ▼                ▼                ▼
   找到多少真实问题    有多少是真的    错误评论多少
```

但实际还应该增加：

```text
+ Comment usefulness
+ Duplicate rate
+ Fix success rate
+ Regression rate
+ Developer acceptance
+ Time-to-merge
+ Token cost
```

Cubic 自己的 Analytics 已经在关注：

* comments posted
* issues fixed
* merge time
* critical issues
* downvote rate
* CLI sessions
* fix PRs merged

([cubic documentation][9])

这个 Metrics 体系本身就值得借鉴。

---

# 31. 我认为 Cubic 的核心架构可以浓缩成这张图

```text
                         ┌───────────────┐
                         │    GitHub     │
                         │      PR       │
                         └───────┬───────┘
                                 │
                                 ▼
                      ┌───────────────────┐
                      │ Review Orchestrator│
                      └─────────┬─────────┘
                                │
             ┌──────────────────┼──────────────────┐
             │                  │                  │
             ▼                  ▼                  ▼
          PR Diff          Repository          Team Memory
             │               Context               │
             │                  │                   │
             └──────────────────┼───────────────────┘
                                ▼
                          ┌───────────┐
                          │  Planner  │
                          └─────┬─────┘
                                │
          ┌─────────────┬───────┼────────┬────────────┐
          ▼             ▼       ▼        ▼            ▼
        Bug         Security   Arch    Duplication  Custom
        Agent        Agent     Agent      Agent       Agent
          │             │       │          │            │
          └─────────────┴───────┼──────────┴────────────┘
                                ▼
                         Candidate Findings
                                │
                                ▼
                         Evidence / Reasoning
                                │
                                ▼
                            Judge / Filter
                                │
                         ┌──────┴──────┐
                         ▼             ▼
                    PR Summary     Inline Comments
                         │             │
                         └──────┬──────┘
                                ▼
                           Developer
                           Feedback
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
                 Memory                 Fix Agent
                    │                       │
                    │                       ▼
                    │                    Commit
                    │                       │
                    │                       ▼
                    │                    Verify
                    │                       │
                    └───────────────┬───────┘
                                    ▼
                                 Re-review
```

---

# 32. 如果和你之前研究的 6 家放在一起

从 **Harness Architecture** 角度，可以初步这样理解：

| 维度                   | Cubic                                             |
| -------------------- | ------------------------------------------------- |
| Context              | **Repository-level**                              |
| Diff                 | GitHub PR diff                                    |
| Repository Search    | 强                                                 |
| Architecture Context | 强                                                 |
| Memory               | **Team Review Learning**                          |
| Agent Loop           | Review → Fix → Review                             |
| Planner              | 有                                                 |
| Multi-Agent          | **Specialized Micro-Agents**                      |
| Security Agent       | 有                                                 |
| Duplication Agent    | 有                                                 |
| Custom Agent         | **有，且可复用**                                        |
| Tool Strategy        | **倾向少而精**                                         |
| Reasoning            | **显式 reasoning / justification**                  |
| Judge                | Finding filtering                                 |
| Dedup                | 有相关机制/行为，但公开实现细节有限                                |
| Verification         | Re-review / fix validation                        |
| Output               | Summary + Inline Comments                         |
| Feedback             | 👍 / 👎 / Reply                                   |
| Memory Update        | Feedback → learning                               |
| Fix Agent            | **Background Agent**                              |
| Runtime              | **Ephemeral Sandbox**                             |
| Local Review         | **CLI**                                           |
| IDE                  | Cursor / Claude Code / VS Code / Codex / Gemini 等 |
| MCP                  | **支持**                                            |
| Codebase Scan        | **支持**                                            |
| AI Wiki              | **支持**                                            |
| Analytics            | **完整**                                            |

---

# 33. 最值得深入研究的其实是这条链

如果你的最终目标是**自己实现一个类似 Cubic 的 Code Review Harness**，我建议重点拆这条：

```text
                    ┌──────────────┐
                    │ Context      │
                    │ Engine       │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │ Review       │
                    │ Planner      │
                    └──────┬───────┘
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
          Bug Agent   Security Agent   Custom Agent
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                    ┌──────────────┐
                    │ Evidence     │
                    │ / Reasoning  │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ Review Judge │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ Finding      │
                    │ Lifecycle    │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ GitHub       │
                    │ Comment      │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ Feedback     │
                    │ / Memory     │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ Fix Agent    │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │ Verification │
                    └──────────────┘
```

这基本就是一个可以独立实现的 **Code Review Agent Harness**。

---

## 34. 一个特别重要的判断

从目前能公开验证的资料来看，**Cubic 的内部 orchestrator、完整 prompt、agent 间消息协议、dedup/judge 的具体实现并没有公开**，所以不能把上面所有内部模块都当成 Cubic 官方公布的源码级实现。

能够比较确定的，是 Cubic **公开承认/展示**的这些设计：

1. 从 single large prompt 演进到 specialized micro-agents；
2. Planner / Security / Duplication / Editorial 等专业 Agent；
3. 显式 reasoning；
4. 精简工具；
5. Repository-level context；
6. Custom Agents；
7. Review feedback → learning；
8. Background Agent；
9. Local review loop；
10. Ephemeral sandbox；
11. Codebase-wide scanning；
12. AI Wiki / repository knowledge；
13. GitHub + IDE + MCP integration。([Cubic][1])

因此，如果是做**架构复刻/技术研究**，最值得复刻的不是 Cubic 的 UI 或某个 Prompt，而是它的 **Harness 思路：**

> **Repository Context → Planner → Specialized Agents → Evidence/Reasoning → Judge/Filtering → Finding Lifecycle → Feedback Memory → Fix Agent → Verification → Re-review**

这条链比单纯的 `LLM + Git diff` 要成熟一个架构层级。

### 官方资料

* [Cubic AI Review Documentation](https://docs.cubic.dev/ai-review/introduction?utm_source=chatgpt.com)
* [Cubic Developer Quickstart](https://docs.cubic.dev/ai-review/quickstart?utm_source=chatgpt.com)
* [Cubic — Learnings from building AI agents](https://www.cubic.dev/blog/learnings-from-building-ai-agents?utm_source=chatgpt.com)
* [Cubic Custom Agents](https://docs.cubic.dev/ai-review/custom-agents?utm_source=chatgpt.com)
* [Cubic IDE Skills](https://docs.cubic.dev/ide/skills?utm_source=chatgpt.com)
* [Cubic Security / Runtime Architecture](https://docs.cubic.dev/account/privacy-security?utm_source=chatgpt.com)

如果按照你前面正在做的 **CodeRabbit / Qodo / Claude / Codex / Copilot / Bugbot 六家 Harness 对比**，下一步最有价值的是把 **Cubic 也加入，形成「7 家 Code Review Harness 架构对比表」**，并进一步把每一家统一拆成 **Context → Planner → Agent Loop → Tools → Multi-Agent → Judge → Dedup → Verification → Memory → Comment → Fix → Benchmark**，这样会非常适合直接拿来设计你自己的 Code Review Harness。

[1]: https://www.cubic.dev/blog/learnings-from-building-ai-agents?utm_source=chatgpt.com "cubic blog: Learnings from building AI agents"
[2]: https://docs.cubic.dev/ai-review/introduction?utm_source=chatgpt.com "Introduction - cubic documentation"
[3]: https://www.cubic.dev/?utm_source=chatgpt.com "AI code reviews for complex codebases | cubic | Try free now"
[4]: https://docs.cubic.dev/account/privacy-security?utm_source=chatgpt.com "Privacy & security - cubic documentation"
[5]: https://github.com/marketplace/cubic-ai-code-reviews?utm_source=chatgpt.com "cubic · AI code reviews for complex codebases · GitHub Marketplace · GitHub"
[6]: https://docs.cubic.dev/ai-review/custom-context?utm_source=chatgpt.com "Custom context - cubic documentation"
[7]: https://docs.cubic.dev/wiki/ai-wiki?utm_source=chatgpt.com "AI wiki - cubic documentation"
[8]: https://docs.cubic.dev/ai-review/custom-agents?utm_source=chatgpt.com "Custom agents - cubic documentation"
[9]: https://docs.cubic.dev/analytics/ai-review?utm_source=chatgpt.com "AI review - cubic documentation"
[10]: https://docs.cubic.dev/ai-review/quickstart?utm_source=chatgpt.com "Developer quickstart - cubic documentation"
[11]: https://docs.cubic.dev/ide/skills?utm_source=chatgpt.com "Skills - cubic documentation"
[12]: https://docs.cubic.dev/ide/agent-setup?utm_source=chatgpt.com "Connect cubic to your IDE - cubic documentation"
