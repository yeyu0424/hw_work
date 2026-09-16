收集整理 github copilot 的 code review 流程 实现方式等资料
下面按“产品流程 → Agent/Harness 架构 → 上下文获取 → Review 推理 → 评论生成 → 修复闭环 → 工程设计 → 可迁移实现”来整理 GitHub Copilot Code Review。信息以 2026-09-16 GitHub 官方公开资料为准。
1. 先给结论：Copilot Code Review 已经不是“Diff + Prompt + LLM”
目前 GitHub Copilot Code Review 的核心形态已经演进成：
PR 事件 → Review Orchestrator → Agentic Context Gathering → Repository/Issue/MCP/Skill Context → 多阶段推理 → Finding 聚合/去噪 → Inline Review Comment → Suggested Fix / Cloud Agent → Re-review
GitHub 在 2026 年 3 月明确宣布 Copilot Code Review 切换到 agentic tool-calling architecture。它不再只是把 PR diff 塞进模型，而是会主动检索仓库上下文、目录结构、代码引用以及关联的 issue/PR，并在阅读过程中形成计划和记忆。
这点对你前面研究的 Code Review Harness 非常关键：Copilot 实际上已经越来越接近一个专门针对 Code Review 场景优化的 Agent Harness。

2. Copilot Code Review 的完整流程
可以抽象成下面这条链：
                    ┌──────────────────────┐
                    │ GitHub Pull Request  │
                    └──────────┬───────────┘
                               │
                open / draft / push / manual
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Review Orchestrator  │
                    │ 触发 / 配置 / 权限    │
                    └──────────┬───────────┘
                               │
                               ▼
                ┌────────────────────────────┐
                │   Review Runtime / Agent   │
                │   GitHub Actions Runner    │
                └─────────────┬──────────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
                 ▼                         ▼
        PR Diff / Metadata          Repository Context
                 │                         │
                 │                  ┌──────┼──────┐
                 │                  ▼      ▼      ▼
                 │               Files   Issues  History
                 │
                 └────────────┬───────────────┘
                              ▼
                    ┌──────────────────────┐
                    │ Agentic Review Loop  │
                    │                      │
                    │ Plan                 │
                    │ ↓                    │
                    │ Inspect              │
                    │ ↓                    │
                    │ Retrieve             │
                    │ ↓                    │
                    │ Reason               │
                    │ ↓                    │
                    │ Validate             │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ Finding Generation   │
                    │ bug/security/design  │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ Signal / Dedup / Rank│
                    └──────────┬───────────┘
                               ▼
                 ┌─────────────┴──────────────┐
                 ▼                            ▼
          Inline Comment               PR Summary /
          + Suggested Fix              Approval Assessment
                 │
                 ▼
        ┌──────────────────────┐
        │ Human Feedback       │
        │ 👍 / 👎 / resolve    │
        └──────────┬───────────┘
                   ▼
             Re-review / Fix
                   │
                   ▼
          Copilot Cloud Agent
                   │
                   ▼
             New commit / PR
其中最重要的变化是：
Review Agent 不再是一次性的 LLM 调用，而是一个具有工具调用、上下文检索、计划、记忆和多轮推理能力的 Agent。

GitHub 自己的工程文章明确描述了几个关键能力：阅读过程中持续发现问题、跨 review 保留记忆、对长 PR 建立显式 review plan、读取关联 issue/PR。

3. 第一阶段：Review Trigger
Copilot Code Review 当前支持几种触发方式。
手工 Review
开发者：
PR
 ↓
Reviewers
 ↓
Copilot
 ↓
Request
这是最传统模式。
Copilot 也提供 REST API，可以通过：

copilot-pull-request-reviewer[bot]
请求 review。
自动 Review
GitHub 提供自动触发：
PR Open
   ↓
Copilot Review
或者：
Draft PR
   ↓
Copilot Review
以及：
new push
   ↓
Copilot re-review
因此完整生命周期可以变成：
Draft
  │
  ▼
AI Review
  │
  ▼
Developer Fix
  │
  ▼
Push
  │
  ▼
AI Re-review
  │
  ▼
Human Review
  │
  ▼
Merge
GitHub 官方现在甚至专门提供了“PR lifecycle”教程，将 draft review、open review、push review、merge 前 re-review 作为一套完整工作流。
4. 第二阶段：Review Runtime
这是 Copilot 最新架构中非常值得注意的一点。
目前 Copilot Code Review 的 agentic capabilities 跑在 GitHub Actions 上。

GitHub 官方明确说明：

Copilot code review uses GitHub Actions to run the agentic capabilities.
包括：
Full project context gathering
Tool calling
MCP
Agent Skills
Cloud Agent handoff
默认可以运行在：
GitHub-hosted runner
也支持：
Large GitHub-hosted runner
Self-hosted runner
如果 Agentic workflow 无法运行，Copilot 仍可以进行 review，但会退化成没有这些 Agentic 能力的更有限模式。
所以可以把 GitHub 当前的架构理解成：

GitHub PR
   │
   ▼
Review Service
   │
   ▼
GitHub Actions Runner
   │
   ▼
Copilot Review Agent
   │
   ├── tools
   ├── repository access
   ├── MCP
   ├── skills
   └── model
这与典型的 Code Review Harness 已经非常接近。
5. 第三阶段：Context Gathering
这是 Copilot 最重要的架构变化之一。
传统 AI Code Review：

PR Diff
 ↓
Prompt
 ↓
LLM
 ↓
Comments
Copilot 新架构：
PR Diff
  │
  ▼
Review Agent
  │
  ├── changed files
  ├── repository structure
  ├── related source files
  ├── symbol references
  ├── configuration
  ├── linked issues
  ├── linked PRs
  ├── repository instructions
  ├── skills
  ├── MCP context
  └── review history
GitHub 称之为：
Full project context gathering
即不仅分析 changed files，还主动理解整个项目中这些修改所处的位置。
6. 为什么 Copilot 要主动 Search Repository？
举一个典型例子：
+ authService.checkPermission(user)
仅从 diff 看：
看起来没问题
但 Agent 会继续查：
authService
   ↓
checkPermission()
   ↓
Role definition
   ↓
Middleware
   ↓
API route
   ↓
Existing usage
最终可能发现：
该 API 实际要求的是
checkPermission(user, resource)
这就是：
Local correctness
        ≠
Repository correctness
Copilot 2026 年的 agentic 架构就是针对这个问题设计的。
GitHub 官方明确说，新架构会探索 repository 来理解：

logic
architecture
specific invariants
而不是只看 PR diff。
7. 第四阶段：Review Plan
这是 GitHub 公开资料里非常值得注意的设计。
对于比较大的 PR，Agent 会先形成一个：

Review Plan
例如：
Review Plan

1. Understand changed architecture
2. Inspect authentication changes
3. Inspect database interaction
4. Trace changed APIs
5. Verify error handling
6. Check tests
7. Look for security implications
8. Consolidate findings
这样就不是：
for each file:
    ask LLM
而更接近：
Plan
 ↓
Explore
 ↓
Reason
 ↓
Verify
 ↓
Collect Findings
GitHub 表示，这种显式计划可以改善长 PR 上的表现，因为长上下文里容易遗忘之前发现的问题。
对 Harness 的意义
你的 Harness 不应该只设计：
review(diff)
而应该设计：
review(pr):
    plan = create_review_plan(pr)

    while plan.has_next():
        task = plan.next()

        context = retrieve(task)

        findings = inspect(
            task,
            context
        )

        memory.store(findings)

    return aggregate(findings)
8. Review Agent 的核心 Loop
从 GitHub 已公开的信息，可以比较合理地抽象出：
┌───────────────────────┐
│      Review Task      │
└───────────┬───────────┘
            ▼
      Create Plan
            │
            ▼
     Inspect Changed Code
            │
            ▼
       Need Context?
         /        \
       No          Yes
       │            │
       │            ▼
       │       Tool Call
       │            │
       │      ┌─────┴─────┐
       │      │           │
       │    Search       Read
       │      │           │
       │      └─────┬─────┘
       │            ▼
       └──────> Reason
                    │
                    ▼
                Finding?
                 /    \
               No      Yes
               │        │
               │        ▼
               │    Validate
               │        │
               │        ▼
               │    Store Finding
               │        │
               └────┬───┘
                    ▼
              Next Review Task
                    │
                    ▼
               Consolidation
GitHub 称它为 agentic tool-calling architecture。
9. Review Agent 可以使用哪些 Context？
目前官方公开的信息已经比较丰富。
Repository
例如：
src/
services/
controllers/
models/
tests/
configs/
可以用于理解代码结构。
Custom Instructions
Copilot 支持：
.github/copilot-instructions.md
用于 repository-wide review rules。
例如：

When performing a code review:

- Focus on security vulnerabilities.
- Do not flag intentional repository patterns.
- Require tests for public APIs.
- Avoid nested ternary expressions.
同时支持：
.github/instructions/**/*.instructions.md
用于路径级别规则。
比如：

src/api/**/*.instructions.md
只针对 API 层。
10. AGENTS.md
这是另一个很有意思的设计。
GitHub 当前让 Copilot Code Review 读取：

AGENTS.md
它不是 Copilot 专属配置，而是：
Agent-agnostic instructions
例如：
AGENTS.md

Architecture:
- Domain logic belongs in service layer.
- Controllers must remain thin.
- External API calls require timeout.
- Database access must use repository abstraction.
因此：
copilot-instructions.md
更像：
Copilot-specific policy
而：
AGENTS.md
更像：
Agent-wide repository contract
官方也明确区分了这两种用途。
11. Agent Skills
这是 2026 年新增的重要能力。
可以在：

.github/skills/
下面配置：
.github/skills/code-review/SKILL.md
例如：
.github/skills/

    code-review/
        SKILL.md

    security-review/
        SKILL.md

    database-review/
        SKILL.md
Skill 可以携带：
review methodology
team conventions
specialized checks
internal tooling
Copilot 根据任务选择是否调用。
2026-07-29，GitHub 已宣布 Agent Skills + MCP 对 Copilot Code Review 正式 GA。

这与传统：

Prompt = 所有规则
相比，是一个非常明显的架构升级：
Core Agent
    │
    ├── base capabilities
    │
    ├── code-review skill
    │
    ├── security-review skill
    │
    ├── database-review skill
    │
    └── framework-specific skill
也就是：
Review Agent + Skill Routing
12. MCP：把“代码以外的知识”拉进 Review
这是 Copilot 当前非常重要的一层。
例如：

PR
 ↓
Copilot
 ↓
MCP
 ├── Jira
 ├── Incident System
 ├── Documentation
 ├── Service Catalog
 └── Internal Knowledge Base
假设 PR description：
Fix PAY-3821
Agent 通过 MCP：
PAY-3821
 ↓
Jira
 ↓
Requirement
 ↓
Acceptance Criteria
于是 Review 不再是：
代码是否正确？
而是：
代码是否符合需求？
GitHub 官方明确给出的例子包括：
issue trackers
documentation systems
service catalogs
incident tooling
并且 Copilot Code Review 中的 MCP tool call 是 read-only。
13. 因此 Copilot 的 Context Architecture 可以抽象成
                         Review Agent
                              │
       ┌──────────────────────┼─────────────────────┐
       │                      │                     │
       ▼                      ▼                     ▼
   PR Context          Repository Context      External Context
       │                      │                     │
       ├─ title              ├─ source             ├─ Jira
       ├─ description        ├─ tests              ├─ Docs
       ├─ diff               ├─ configs            ├─ Incident
       ├─ commits            ├─ history            └─ Service Catalog
       └─ comments           └─ instructions
                              │
                              ▼
                      Skills / Instructions
这已经是一个非常标准的 Agent Context Fabric。
14. 第五阶段：Review Effort
Copilot 目前还加入了 Review Effort。
当前主要分成：

Lite
Balanced
Lite：
快速
常见问题
bug
security
style
Balanced：
复杂逻辑
安全敏感代码
跨服务修改
更高推理能力
Balanced 会消耗更多 AI credits，并可能增加 Actions 使用量。
这其实是一种：

Dynamic Compute Allocation
即：
简单 PR
   ↓
Low-cost Agent

复杂 PR
   ↓
High-reasoning Agent
而不是所有 PR 都使用同样昂贵的推理流程。
对于你正在研究的 Harness，这个设计非常值得采用：

risk = estimate_pr_risk(pr)

if risk < threshold:
    mode = LITE
else:
    mode = BALANCED
风险可以由：
changed files
LOC
security-sensitive paths
database changes
API changes
cross-service changes
dependency changes
共同决定。
15. 第六阶段：Finding Generation
Copilot 不只是生成一段总结。
核心输出实际上是：

Finding
大致可以抽象为：
{
  "severity": "high",
  "file": "src/auth.ts",
  "line_start": 42,
  "line_end": 48,
  "title": "...",
  "problem": "...",
  "reasoning": "...",
  "suggestion": "...",
  "confidence": 0.92
}
GitHub UI 会给 Review Comment 标记：
High
Medium
Low
并在能做到的时候直接提供 Suggested Change。
16. 一个很重要的设计：不是“发现多少报多少”
GitHub 的工程文章特别强调：
more comments ≠ better review
他们现在优化的是：
high-signal feedback
而不是：
maximum findings
官方公开数据中，2026 年 3 月文章称约 71% 的 reviews 产生 actionable feedback，其余 review 可以选择什么都不说；平均约 5.1 条 comments。
这里其实体现了一个很重要的 Review Harness 原则：

Candidate Findings
        │
        ▼
   Validation
        │
        ▼
Confidence Filter
        │
        ▼
Deduplication
        │
        ▼
Importance Filter
        │
        ▼
Final Findings
而不是：
LLM output
   ↓
直接 comment
17. Review Comment 的粒度也发生了变化
以前：
comment → line
现在更强调：
comment → logical code range
即：
line 42
变成：
line 42 ~ 48
这样 Review Agent 可以解释：
为什么这一段代码整体存在问题
而不是机械地指出：
第 45 行有问题
GitHub 公开说明了他们从 single-line comments 转向 multi-line logical ranges，以提高可理解性和修复体验。
18. Duplicate Findings / Finding Clustering
另一个非常重要的工程点：
假设发现：

10 个地方
都存在同一个错误模式
Copilot 不会简单生成：
comment 1
comment 2
comment 3
...
comment 10
而会尽量：
Pattern Finding
 ├─ location A
 ├─ location B
 ├─ location C
 └─ location D
GitHub 明确提到会把相同 pattern 的多个 comments 聚合成更一致的 review feedback。
这本质上属于：

Finding Deduplication + Clustering
19. Suggestion / Autofix
Copilot Review 不只是：
发现问题
还可以：
问题
 ↓
Suggested Change
 ↓
Apply
支持：
Single Suggestion
以及：
Batch Suggestions
可以一次修复一整类问题。
所以 Review Agent 实际输出最好拆成：

Finding
 ├── explanation
 ├── severity
 ├── location
 ├── confidence
 ├── suggested patch
 └── remediation action
20. Fix → Cloud Agent
这是非常值得注意的“Review → Coding Agent”闭环。
当前流程可以是：

Copilot Review
       │
       ▼
Review Comment
       │
       ▼
Fix with Copilot
       │
       ▼
Copilot Cloud Agent
       │
       ├── understand issue
       ├── modify code
       ├── run validation
       └── create PR / commit
官方当前支持从 review comment 触发：
Fix with Copilot
然后选择：
new pull request
或：
same PR
来落实修复。
因此整个 Copilot Developer Loop 已经形成：

Code
 ↓
PR
 ↓
Review Agent
 ↓
Findings
 ↓
Fix Agent
 ↓
Tests
 ↓
New Commit
 ↓
Re-review
 ↓
Merge
21. 人类反馈也进入 Copilot Evaluation Loop
Copilot Review 支持：
👍
👎
开发者可以对具体 comment 提供反馈。
GitHub 表示这些反馈会用于持续改进 Review Agent。

他们还跟踪：

Developer feedback
+
Whether findings are fixed before merge
作为生产质量信号。
这构成：

Review
 ↓
Human Feedback
 ↓
Production Signal
 ↓
Evaluation
 ↓
Prompt / Agent / Model Improvement
 ↓
New Review
从 Harness 角度看，这是：
Offline Eval + Online Eval
的组合。
22. GitHub 公开透露的 Agent Memory
这一点尤其值得关注。
GitHub 现在公开描述 Copilot Code Review：

可以维护跨 review 的 memory。
例如一次 review 发现：
Repository uses a special retry abstraction
以后 review 可以复用：
retry abstraction
避免重新推导。
GitHub 也明确将 memory 列为当前 Code Review agent 的组成部分。

所以 Harness 可以增加：

Review Memory

Repository invariants
Known patterns
Accepted exceptions
Previous findings
Resolved false positives
Architecture knowledge
这比简单 RAG 更接近：
Agentic Review Memory
23. 文件过滤也是一个重要工程点
Copilot 并不是 Review 所有文件。
GitHub 对很多：

generated files
vendor files
lock files
logs
SVG
dist
coverage
node_modules
bundle files
进行排除。
例如：

package-lock.json
yarn.lock
Cargo.lock
go.sum
dist/**
node_modules/**
generated/**
vendor/**
coverage/**
这背后的意义是：
减少无价值 token
+
减少噪声
+
降低成本
+
提高 Review signal
所以一个成熟 Harness 一定应该有：
File Eligibility Filter
而不是：
git diff → 全部送模型
24. Security / Content Boundary
Copilot Code Review 还支持 Content Exclusion。
组织可以配置：

secret/
internal/
generated/
sensitive/
之类的路径不提供给 Copilot。
官方说明 Content Exclusion 会影响 Copilot Code Review，排除文件不会被 Review 使用。

再加上 2026 年 7 月新增的：

Firewall
使 Review Agent 的运行环境进一步受到网络边界约束。GitHub 当前默认让 Copilot Code Review 运行在 firewall 后面。
所以完整安全边界大致是：

Repository
 │
 ├── allowed files
 ├── excluded files
 │
 ▼
Runner Sandbox
 │
 ├── filesystem
 ├── tools
 ├── network firewall
 └── secrets
      │
      ▼
   Review Agent
25. 当前 Copilot Code Review 的整体架构
把公开资料合起来，可以得到一个比较接近真实产品形态的“逻辑架构图”：
                         GitHub Pull Request
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │ Review Trigger Layer   │
                     │                        │
                     │ Manual / Open / Draft  │
                     │ Push / API / Re-review │
                     └────────────┬───────────┘
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │ Review Orchestrator    │
                     │                        │
                     │ policy                 │
                     │ permission             │
                     │ effort selection       │
                     │ billing                │
                     └────────────┬───────────┘
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │ GitHub Actions Runner  │
                     │                        │
                     │ sandbox / firewall     │
                     └────────────┬───────────┘
                                  │
                                  ▼
              ┌─────────────────────────────────────────┐
              │              Review Agent               │
              │                                         │
              │  Plan                                   │
              │    ↓                                    │
              │  Explore                                │
              │    ↓                                    │
              │  Retrieve                               │
              │    ↓                                    │
              │  Reason                                 │
              │    ↓                                    │
              │  Validate                               │
              └──────┬──────────────────────────────────┘
                     │
        ┌────────────┼──────────────┬───────────────┐
        │            │              │               │
        ▼            ▼              ▼               ▼
   Repository      Skills         MCP           Memory
   Context
        │            │              │               │
        ├─ files    ├─ review      ├─ Jira         ├─ prior
        ├─ refs     ├─ security    ├─ docs         │ findings
        ├─ issues   └─ domain      ├─ incident     └─ repo
        └─ history                 └─ services       knowledge
        │
        └─────────────────┬───────────────────────────
                          ▼
                 ┌────────────────────┐
                 │ Finding Pipeline   │
                 │                    │
                 │ detect             │
                 │ validate           │
                 │ rank               │
                 │ dedupe             │
                 │ cluster            │
                 └──────────┬─────────┘
                            ▼
                 ┌────────────────────┐
                 │ Review Output      │
                 │                    │
                 │ inline comments    │
                 │ summary            │
                 │ severity           │
                 │ suggested changes  │
                 │ approval signal    │
                 └──────────┬─────────┘
                            │
                ┌───────────┴────────────┐
                ▼                        ▼
           Human Review            Copilot Fix
                │                        │
                └───────────┬────────────┘
                            ▼
                       New Commit
                            │
                            ▼
                         Re-review
这部分是我根据 GitHub 官方公开架构、文档和产品行为做的工程化抽象；GitHub 并没有公开 Copilot Code Review 的全部内部实现代码，所以其中的模块边界和内部组件名称不能视为 GitHub 官方公布的内部类图。GitHub 已公开确认的关键组件包括 agentic tool calling、Actions runners、repository context、memory、skills、MCP、review effort、finding/comment pipeline 等。
26. Copilot 最值得借鉴的 8 个工程设计
结合你前面研究的 Code Review Harness，我认为真正值得拆出来的是下面这些模式。
Copilot 设计	核心思想	Harness 中对应模块
Agentic Review	Review 是 Agent task，不是单次 LLM call	Review Agent
Repository Context	根据需要主动查代码	Context Engine
Review Plan	复杂 PR 先规划再执行	Planner
Tool Calling	搜索、读取、关联信息	Tool Runtime
Skills	按 review 类型加载能力	Skill Registry
MCP	获取外部业务知识	External Context
Finding Dedup	控制评论噪声	Finding Aggregator
Review→Fix	Review 和 Coding Agent 闭环	Remediation Agent
27. 一个值得直接移植的 Harness 架构
结合 Copilot 当前路线，可以设计：
                    Code Review Harness
                           │
        ┌──────────────────┼─────────────────┐
        │                  │                 │
        ▼                  ▼                 ▼
   Trigger Layer      Policy Layer      Context Layer
        │                  │                 │
        │            severity rules      repo search
        │            file rules          symbol refs
        │            security rules      history
        │                                 issues
        │
        ▼
      Planner
        │
        ▼
   Review Agent
        │
   ┌────┼────┬─────────┐
   │    │    │         │
   ▼    ▼    ▼         ▼
 Git  Search MCP     Skills
   │    │
   └────┴─────────────┐
                     ▼
                  Validator
                     │
                     ▼
              Finding Aggregator
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
      Bug         Security      Design
        │
        ▼
     Ranker
        │
        ▼
  Comment Generator
        │
        ▼
 GitHub PR Comment
        │
        ▼
 Remediation Agent
        │
        ▼
    Re-review
28. 最重要的一个认识：Review Agent ≠ Reviewer Prompt
如果现在要自己做 AI Code Review，很多系统容易这样设计：
prompt = """
Review this pull request.
Find bugs.
"""
llm(prompt + diff)
这与 Copilot 当前架构相比已经落后一个层级。
更接近 Copilot 的设计应该是：

class ReviewAgent:

    def review(self, pr):

        plan = self.planner.create(pr)

        while plan.has_next():

            task = plan.next()

            context = self.context_engine.retrieve(task)

            result = self.llm.reason(
                task=task,
                context=context
            )

            self.memory.store(result)

        findings = self.validator.validate(
            self.memory.findings
        )

        findings = self.deduper.merge(findings)

        findings = self.ranker.filter(findings)

        return self.renderer.render(findings)
也就是说：
Prompt Engineering
         ↓
Agent Engineering
         ↓
Review System Engineering
这是 Copilot Code Review 这轮架构升级最值得关注的地方。
29. Copilot 当前几个特别值得研究的“黑盒接口”
如果你后续准备自己实现一个 Harness，我建议重点逆向分析这几个能力，而不是只研究它的 prompt：
A. Context Retrieval
重点研究：
为什么查这个文件？
什么时候查？
查到什么程度停止？
这是 Agent Review 的核心。
B. Plan
研究：
PR → Review Tasks
如何拆：
security
logic
architecture
testing
performance
C. Finding Validation
研究：
一个 finding
如何确认是真的？
这是减少 AI false positives 的核心。
D. Finding Dedup
研究：
多个 observation
→ 一个 review comment
E. Effort Routing
研究：
简单 PR → cheap model
复杂 PR → reasoning model
F. Memory
研究：
Repository invariant
+
Historical findings
+
Developer feedback
如何变成长期知识。
30. 一个非常关键的产品哲学
GitHub 当前对 Code Review 的优化目标已经发生变化：
早期：

Review ≈ 尽可能发现更多问题
现在：
Review ≈ 尽可能发现重要问题
GitHub 在 2026 年的官方工程文章直接把目标描述成：
Accuracy
Signal
Speed
并强调“更多评论不意味着更好的 Review”。
因此一个成熟的 Code Review Harness 的最终目标应该是：

                HIGH SIGNAL
                    ▲
                    │
        ┌───────────┼───────────┐
        │           │           │
    correctness   relevance   actionability
        │           │           │
        └───────────┼───────────┘
                    │
                 Finding
                    │
              Developer Trust
而不是：
每个 PR 生成 30 条评论
31. 目前能确认的 Copilot 技术演进路线
从 GitHub 官方资料可以看到非常清晰的演进：
2024
Prompt / LLM-based Review
        │
        ▼
2025
Repository-aware Review
        │
        ▼
2026 Mar
Agentic Tool Calling
        │
        ├── Repo Exploration
        ├── Planning
        ├── Memory
        └── Issue / PR Context
        │
        ▼
2026 Jun
Skills + MCP
        │
        ├── Organization Knowledge
        ├── Internal Tools
        └── External Context
        │
        ▼
2026 Jul
Skills + MCP GA
        │
        ▼
Review Agent
        +
Coding Agent
        +
Memory
        +
External Knowledge
GitHub 2026 年 7 月已经宣布 Agent Skills 和 MCP 对 Copilot Code Review GA。
32. 如果从“Code Review Harness”角度重新定义 Copilot
可以把 GitHub Copilot Code Review 看成：
┌──────────────────────────────────────────────┐
│              Code Review Harness             │
│                                              │
│  Trigger                                     │
│    ↓                                         │
│  Context Manager                             │
│    ↓                                         │
│  Review Planner                              │
│    ↓                                         │
│  Agent Runtime                               │
│    ├── Repository Tools                      │
│    ├── GitHub Tools                          │
│    ├── MCP                                   │
│    ├── Skills                                │
│    └── Memory                                │
│    ↓                                         │
│  Reasoning                                   │
│    ↓                                         │
│  Finding Validation                          │
│    ↓                                         │
│  Finding Dedup / Ranking                     │
│    ↓                                         │
│  Review Renderer                             │
│    ↓                                         │
│  Fix Agent                                   │
│    ↓                                         │
│  Re-review                                   │
└──────────────────────────────────────────────┘
所以从工程角度看，GitHub Copilot Code Review 已经可以作为一个比较完整的“Code Review Agent Harness”参考实现来研究。
官方资料
GitHub 当前最值得直接阅读的几篇资料：
GitHub Copilot Code Review 官方概览

Copilot Code Review 使用与自动 Review

PR Lifecycle 中使用 Copilot Code Review

Agentic Architecture 官方工程文章

Agent Skills + MCP GA

Copilot Code Review 环境、Runner、Firewall 等配置

结合你前面已经整理的 CodeRabbit、Qodo、Claude Code、Codex，下一步很适合直接做一份 《主流 AI Code Review Agent 架构对比》：把 Copilot / CodeRabbit / Qodo / Claude Code / Codex 按 Trigger、Harness、Context、Planner、Tools、MCP、Skills、Finding、Validation、Fix、Memory、Feedback、成本控制 横向拆开。这样基本就能反推出一套你自己的 Code Review Harness 参考架构。
在使用额度在 15:19重置前，文件、图像和数据分析不可用。你可以继续仅使用文本聊天，或升级以获得更多使用权限。
免费试用 Plus





