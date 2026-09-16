下面按“产品流程 → CLI / App Server 实现 → Reviewer Agent 内部流程 → GitHub PR 自动化 → 工程设计要点”来整理。资料以 2026-09-16 能查到的 OpenAI Codex 当前公开仓库与官方资料为主。
1. 先给结论：Codex 的 Code Review 是怎么做的
从公开实现看，Codex 的 review 可以抽象成：
Review Trigger
   │
   ├─ CLI: codex review
   ├─ App/Desktop: review/start
   ├─ GitHub Cloud: PR 自动触发 / @codex review
   └─ CI: codex exec / codex-action
   │
   ▼
Review Target Resolution
   │
   ├─ uncommitted
   ├─ base branch
   └─ commit
   │
   ▼
Repository Context
   │
   ├─ AGENTS.md / repo rules
   ├─ complete diff
   ├─ surrounding code
   ├─ call sites
   ├─ tests
   └─ git history / merge-base
   │
   ▼
Reviewer Orchestration
   │
   ├─ code-review orchestrator
   └─ multiple code-review-* specialist skills
   │
   ▼
Defect-first Analysis
   │
   ├─ correctness
   ├─ security
   ├─ performance
   └─ maintainability
   │
   ▼
Validation
   │
   ├─ tests
   ├─ call sites
   ├─ execution / reproduction
   └─ changed-path reasoning
   │
   ▼
Finding Filter
   │
   ├─ introduced by change?
   ├─ concrete?
   ├─ actionable?
   ├─ demonstrable?
   └─ author likely to fix?
   │
   ▼
Structured Findings
   │
   ├─ severity
   ├─ file
   ├─ line
   ├─ explanation
   └─ overall assessment / residual risks
   │
   ▼
Output
   ├─ CLI / App UI
   ├─ GitHub PR review/comment
   └─ CI structured JSON → SCM API
这个设计里最值得关注的其实不是 prompt，而是 “Review Target + Context + Reviewer Orchestration + Finding Gate + Validation” 五件事。
2. Codex 当前有哪些 Review 入口
2.1 CLI：codex review
当前 Codex CLI 已经把 review 做成了独立的一等命令，而不是普通 codex exec 的一个 prompt 模板。
公开 CLI 参数目前包括三种主要 review target：
codex review --uncommitted
codex review --base <branch>
codex review --commit <sha>
另外还支持自定义 review instructions / prompt。源码中的 ReviewArgs 明确把 uncommitted、base、commit、prompt 建模为 review 参数，并互相做冲突约束。
所以第一层设计非常重要：
Review 的输入不是“文本”，而是一个结构化 ReviewTarget。
可以抽象成：
enum ReviewTarget {
    UncommittedChanges,
    BaseBranch(String),
    Commit(String),
}
这比：
Review this diff...
这种 prompt-driven 设计更适合做工程系统。
3. App Server：Review 已经有独立的协议层
Codex 的 app-server 已经公开了专门的：
review/start
接口。
公开协议说明中，review 请求携带 thread + target，例如：
{
  "method": "review/start",
  "params": {
    "threadId": "…",
    "target": {
      "type": "uncommittedChanges"
    }
  }
}
同一个协议还支持：
uncommittedChanges
baseBranch
commit
等 review target。
这个点非常值得借鉴。
说明 Codex 的架构不是
UI
 ↓
拼 prompt
 ↓
LLM
而更接近：
UI
 ↓
Review API
 ↓
Review Target
 ↓
Review Engine
 ↓
Agent
这样 Desktop、CLI、其他 host 可以共享 review backend。
甚至公开 issue 中还讨论到了 Desktop 某些路径没有直接使用 review/start、而是在 UI 层自己解析 merge-base 并构建 prompt，从而产生缓存一致性问题；issue 给出的建议也是让语义上的 review target 回到 review/start，由服务端基于当前仓库状态解析。这个细节很能说明为什么 Review Target 应该是协议对象，而不是 UI 层拼接出来的一段 prompt。
4. Review 的核心：不是“看 diff”，而是“理解 change”
OpenAI 对 Codex Code Review 的公开描述很明确：
它会导航代码库、理解依赖关系，并运行代码和测试来验证正确性。
官方还特别把它与传统静态分析做了区分：review 会把 PR 声明的意图和实际 diff 联系起来，并结合整个代码库和依赖关系进行推理。
所以 Review Context 至少包括：
PR / Commit metadata
        +
Diff
        +
Changed files
        +
Surrounding code
        +
Call sites
        +
Tests
        +
Repository rules
        +
Git history / merge-base
而不是：
git diff
直接扔给模型。
5. Codex 官方 Review Agent 的内部流程
这一部分是目前最有价值的公开实现。
OpenAI 在 Codex 仓库里直接提供了一个 review-agent skill sample。其描述是：
对指定代码变更执行 read-only、defect-first review，并返回所有 actionable findings。
核心流程是：
第一步：读取仓库规则
先读取：
AGENTS.md
再开始审查。
也就是说：
Review Policy
      ↓
Repository-local Policy
      ↓
Code Review
而不是所有 repository 使用一套固定审查标准。
第二步：检查完整 diff
不是只看变化最大的几个文件。
要求：
Inspect the complete diff
+
inspect enough surrounding code
因此模型需要把：
changed lines
扩展到：
changed function
changed class
caller
callee
related state
tests
6. 一个很关键的 Codex Review 原则：Defect-first
Codex 的 review agent 不是让模型：
指出所有可能的问题
而是：
找作者真正应该修的问题
公开规则要求一个 finding 必须满足多个条件：
1. 有意义地影响 correctness/security/performance/maintainability
2. 是离散、可操作的问题
3. 是本次 change 引入的
4. 能从代码中证明对应场景 / call path
5. 作者知道后大概率会修改
而明确要求排除：
- speculative concerns
- pre-existing problems
- intentional behavior changes
- 无意义 style nit
这个设计非常重要，因为：
发现问题数量
和
有效问题数量
不是同一个指标。
Codex 明显是在优化后者。
7. Codex 会继续往下验证，而不是找到第一个问题就结束
Review Agent 的公开步骤中明确要求：
发现问题
 ↓
继续检查整个 diff
 ↓
检查 tests
 ↓
检查 call sites
 ↓
确认 finding 是真实、可操作的问题
也就是：
Candidate Finding
       ↓
Evidence Gathering
       ↓
Validation
       ↓
Accepted Finding
而不是：
LLM thinks bug exists
→ output bug
这实际上已经很接近一个真正的 Review Harness。
8. Base Branch Review 更值得研究
Codex 对：
codex review --base main
不是简单做：
git diff main..HEAD
公开 review-agent 指令要求：
找到真正的 comparison ref
考虑 branch upstream
执行：
git merge-base HEAD <comparison-ref>
再基于 merge-base 检查最终真正会进入合并结果的变化。
也就是说它关心：
真正 merge 的 changeset
而不是：
两个 branch tip 的文本差异
这是做企业级 Review Harness 时非常值得直接借鉴的设计。
9. Review Orchestrator：Codex 不是只有一个 reviewer
Codex 当前仓库中存在一个专门的：
.codex/skills/code-review/SKILL.md
它本身是 orchestrator。
其设计明确写的是：
Use subagents to review code using all
code-review-* skills
other than this orchestrator.
One subagent per skill.
并要求使用较高 reasoning effort。
可以把它抽象成：
                 ┌─ reviewer A
                 │
Review ──> Orchestrator ── reviewer B
                 │
                 ├─ reviewer C
                 │
                 └─ reviewer D
                        ↓
                  collect findings
                        ↓
                    final report
这个架构的价值非常大：
把“审查维度”拆成多个独立 reviewer，而不是让一个 prompt 同时扮演所有角色。
10. 当前公开的 Review Skill 体系
目前可以直接看到至少两类：
code-review-context
负责思考：
model visible context
它提出几个非常明确的 context engineering 原则：
No history rewrite
avoid frequent context changes
all injected context bounded
single injected item < 10K tokens
large new context fragments need special attention
而且要求 injected fragments 由 core/context 中的结构化类型实现。
这其实揭示了 Codex Review 的一个底层原则：
Review 本质上也是 Context Engineering 问题。
code-review-testing
专门负责测试相关 review 约束。
它强调 agent 逻辑变化要有 integration test，而不是只依赖 unit test。
所以 Review 体系已经开始拆成：
Review
 ├── Context
 ├── Testing
 └── other code-review-* specialists
11. Review 输出也做了严格约束
review-agent 的 finding 格式明确规定：
[P1] Imperative finding title — path/to/file.rs:line
然后：
one short paragraph
说明：
affected scenario
+
why behavior is wrong
而且要求：
引用行必须尽量小
并且必须与 reviewed diff 重叠
优先级定义为：
P0 = critical / release blocker
P1 = urgent defect
P2 = normal defect
P3 = low-impact but worthwhile
这意味着 Review Result 其实已经接近一种 schema：
interface Finding {
  priority: "P0" | "P1" | "P2" | "P3";
  title: string;
  file: string;
  line: number;
  explanation: string;
  evidence?: string;
}
这个对于你之前研究的 Code Review Harness 非常有参考价值。
12. Findings 不只是“发现”，还有一个 Gate
把 Codex 的规则抽象一下，可以得到：
Raw Model Observation
        ↓
Is it introduced by this change?
        ↓ yes
Is it concrete?
        ↓ yes
Can scenario be demonstrated?
        ↓ yes
Does it affect meaningful behavior?
        ↓ yes
Would author fix it?
        ↓ yes
──────────────
Accepted Finding
也就是一个：
Finding Acceptance Gate
这是我认为 Codex Review 设计中最重要的部分之一。
很多 AI Code Review 工具最大的问题不是：
找不到 bug
而是：
找到了大量“可能是 bug”的东西
Codex 明显在从流程层面压制这个问题。
13. GitHub Cloud 的产品化流程
OpenAI 官方描述的 Codex GitHub Review 流程是：
GitHub PR
  ↓
Codex 自动触发
  ↓
分析 PR
  ↓
发布 Review
  ↓
发现需要修改的问题
  ↓
继续在同一上下文里要求 Codex 修改
还可以显式通过：
@codex review
触发，并可以追加类似：
review for security vulnerabilities
review for outdated dependencies
这样的关注点。
官方另外明确描述了：
Codex 可以在 PR 从 draft 进入 ready 状态时自动 review。
14. GitHub PR Review 的 CI 实现
除了 Codex Cloud，本地 / 企业 CI 也可以直接复用 Codex review 能力。
OpenAI 官方 codex-action 给出的模型是：
GitHub PR
   ↓
checkout repository
   ↓
确保 base / head refs 存在
   ↓
构造 PR-specific prompt
   ↓
Codex
   ↓
final_message
   ↓
GitHub API
   ↓
PR comment
这实际上是一个非常标准的：
SCM Adapter
    +
Review Harness
结构。
15. 更有工程价值的版本：Structured Output
OpenAI Cookbook 给出了一个更加工程化的 Code Review 实现。
流程是：
Codex CLI
   ↓
Review Prompt
   ↓
Structured Output Schema
   ↓
JSON
   ↓
SCM API Adapter
   ↓
Inline Review Comment
公开示例明确建议：
1. install Codex CLI
2. headless mode
3. use Code Review prompt
4. JSON schema
5. parse result
6. create SCM comments
这意味着：
Codex 本身负责“发现和解释问题”，而 GitHub/GitLab/Azure DevOps/Jenkins 负责“承载 review 状态”。
这个边界非常合理。
16. 为什么 Structured Output 很重要
如果直接输出 Markdown：
There may be a race condition...
你的系统还要自己猜：
问题在哪个文件？
哪一行？
严重等级？
能否 inline？
而 structured output 可以直接：
{
  "findings": [
    {
      "priority": "P1",
      "file": "src/cache.rs",
      "start_line": 142,
      "end_line": 150,
      "title": "...",
      "body": "...",
      "confidence": 0.96
    }
  ]
}
之后：
LLM output
    ↓
Validator
    ↓
SCM comment adapter
这比让模型直接生成 GitHub API 调用安全得多。
OpenAI 官方 Cookbook 还强调了 file / line citation 必须精确，否则 comment 可能会被拒绝。
17. Codex 的 Review Prompt 思路
OpenAI Cookbook 公开的 review prompt 可以概括成以下几个核心约束：
你是 proposed code change 的 reviewer

关注：
- correctness
- performance
- security
- maintainability
- developer experience

只报告：
- PR 引入的
- actionable
- 有意义的问题

每个问题：
- 简明说明
- file
- line range

优先严重问题
减少无意义 nit

最后：
- overall correctness
- justification
- confidence
值得注意的是，Prompt 只是表层控制，真正决定 review 质量的是前面的 harness。
18. Codex Review 的完整技术架构
综合公开代码，我建议把 Codex 的 Review Engine 理解成下面这个架构：
                         ┌─────────────────┐
                         │ Review Trigger  │
                         ├─────────────────┤
                         │ CLI             │
                         │ Desktop         │
                         │ GitHub          │
                         │ CI              │
                         └────────┬────────┘
                                  │
                                  ▼
                       ┌────────────────────┐
                       │ Review API         │
                       │ review/start       │
                       └─────────┬──────────┘
                                 │
                                 ▼
                       ┌────────────────────┐
                       │ Review Target      │
                       ├────────────────────┤
                       │ uncommitted        │
                       │ base branch        │
                       │ commit             │
                       └─────────┬──────────┘
                                 │
                                 ▼
                       ┌────────────────────┐
                       │ Target Resolver     │
                       ├────────────────────┤
                       │ merge-base         │
                       │ changed files      │
                       │ actual merge diff  │
                       └─────────┬──────────┘
                                 │
                                 ▼
                       ┌────────────────────┐
                       │ Context Builder    │
                       ├────────────────────┤
                       │ AGENTS.md          │
                       │ diff               │
                       │ source context     │
                       │ call sites         │
                       │ tests              │
                       │ history            │
                       └─────────┬──────────┘
                                 │
                                 ▼
                  ┌──────────────────────────────┐
                  │ Review Orchestrator          │
                  │                              │
                  │  ┌──────┐ ┌──────┐ ┌──────┐ │
                  │  │Rule  │ │Test  │ │Other │ │
                  │  │Review│ │Review│ │Review│ │
                  │  └──┬───┘ └──┬───┘ └──┬───┘ │
                  └─────┼────────┼────────┼─────┘
                        │        │        │
                        └────────┼────────┘
                                 ▼
                       ┌────────────────────┐
                       │ Evidence / Verify  │
                       ├────────────────────┤
                       │ tests              │
                       │ call paths         │
                       │ reproduction       │
                       └─────────┬──────────┘
                                 │
                                 ▼
                       ┌────────────────────┐
                       │ Finding Gate       │
                       ├────────────────────┤
                       │ introduced?        │
                       │ concrete?          │
                       │ actionable?        │
                       │ meaningful?        │
                       │ fix-worthy?        │
                       └─────────┬──────────┘
                                 │
                                 ▼
                       ┌────────────────────┐
                       │ Finding Model      │
                       ├────────────────────┤
                       │ P0/P1/P2/P3        │
                       │ file/line          │
                       │ explanation        │
                       └─────────┬──────────┘
                                 │
                  ┌──────────────┼──────────────┐
                  ▼              ▼              ▼
               CLI/App       GitHub PR       CI JSON
19. 从 Harness 角度看，Codex 最值得借鉴的 8 个设计
结合你前面一直在研究的 AI Code Review + Harness，我会重点关注这几个。
① Review Target 一等公民
不要：
prompt = "review this PR..."
应该：
ReviewRequest {
    target: {
        type: "base_branch",
        ref: "main"
    }
}
这样可以避免：
merge-base
HEAD
PR metadata
diff scope
全部依赖 prompt。
② Review 是独立 Agent Mode
不是：
General Agent
+ "please review code"
而是：
General Agent
├── coding mode
├── debugging mode
├── planning mode
└── review mode
Codex CLI 已经把 review 做成独立命令，App Server 也有独立 review API，这说明 Review 在产品架构层面是独立能力。
③ Reviewer Orchestrator + Specialists
推荐：
Review Orchestrator

    ├── Correctness Reviewer
    ├── Security Reviewer
    ├── Test Reviewer
    ├── Performance Reviewer
    └── Architecture Reviewer
而不是一个 500 行超级 prompt。
Codex 当前公开 skill 已经采用 code-review-* 子 reviewer 的 orchestrator 模式。
④ Finding Gate
这是我最建议你直接复制的设计：
Candidate
   ↓
introduced?
   ↓
concrete?
   ↓
reproducible?
   ↓
actionable?
   ↓
meaningful?
   ↓
likely fix?
   ↓
Finding
这会明显减少：
AI review noise
而不是单纯追求：
recall
⑤ Evidence-driven Review
Review Agent 不只是：
LLM reasoning
而是：
LLM reasoning
+
repository evidence
+
tests
+
call sites
+
git structure
这是 Codex 与单纯“静态 diff prompt”方案之间非常重要的差异。
⑥ Merge-base 优先
Review branch：
BASE...HEAD
真正的工程实现应该解析：
merge-base
再确定 review scope。
这样才能减少：
把历史代码的问题算到本次 PR
的问题。Codex 的 review-agent 明确要求这样做。
⑦ Review Output Schema 化
推荐：
interface ReviewFinding {
    priority: "P0" | "P1" | "P2" | "P3"
    file: string
    startLine: number
    endLine: number

    title: string
    body: string

    evidence?: Evidence[]
}
模型：
只负责生成 Finding
而：
GitHub
GitLab
Gerrit
Azure DevOps
全部交给 Adapter。
OpenAI 的 CI / Cookbook 路线也是这个方向。
⑧ Review 输出和 Code Change 解耦
Codex 官方 review-agent 明确要求：
review only
do not modify files
do not commit
do not push
do not post review comments
即：
Reviewer
    ≠
Coder
这会显著降低：
self-review
self-fix
self-approve
形成的反馈闭环污染。
20. Codex 的实际 Review Loop
再把它压缩成开发者真正感受到的流程：
PR created
   │
   ▼
Codex Review
   │
   ├─ resolve actual diff
   ├─ read repository rules
   ├─ understand changed code
   ├─ trace dependencies/callers
   ├─ inspect tests
   ├─ run validation where useful
   │
   ▼
Findings
   │
   ├─ P0/P1/P2/P3
   ├─ file + line
   └─ evidence
   │
   ▼
Human / Agent receives findings
   │
   ▼
Implementation
   │
   ▼
Tests
   │
   ▼
Push new SHA
   │
   ▼
Review again
这其实已经形成：
Coding
 → Testing
 → Review
 → Fix
 → Re-review
的闭环。
OpenAI 自己公开的工程实践也把 testing、validation、review、feedback handling、recovery 编进了 agent 工作流。
21. 关于安全和执行权限
Review 本身应该尽可能是：
read-only
官方 CI 示例就使用了 read-only sandbox 来执行结构化 review。
OpenAI 公开的安全设计也强调 sandbox、审批、网络策略和 agent-native telemetry；Codex 的执行环境并不是默认开放网络权限。
因此一个企业级 Review Harness 建议设计为：
Reviewer
  ├── repository: read
  ├── git: read
  ├── tests: execute
  ├── build: execute
  ├── network: deny by default
  └── write: deny
这样 Review Agent 可以：
git diff
grep
read file
run tests
run static check
但不能：
修改源码
push
发布
22. 如果把 Codex Review 抽象成一个可移植 Harness
结合你前面研究的 CodeRabbit / Qodo / Claude Code，我会把 Codex 的核心抽象成：
class CodeReviewHarness {

    async review(req: ReviewRequest) {

        // 1. Resolve target
        const target = await targetResolver.resolve(req.target)

        // 2. Build context
        const context = await contextBuilder.build({
            target,
            repoRules: true,
            surroundingCode: true,
            tests: true,
            history: true
        })

        // 3. Fan out reviewers
        const results = await orchestrator.run([
            correctnessReviewer,
            securityReviewer,
            testReviewer,
            performanceReviewer
        ], context)

        // 4. Validate findings
        const validated = await findingValidator.validate(
            results,
            context
        )

        // 5. Normalize
        const findings = normalize(validated)

        // 6. Publish
        return publisher.publish(findings)
    }
}
其中：
Target Resolver
Context Builder
Reviewer Orchestrator
Finding Validator
Publisher
是五个最核心模块。
23. 我对 Codex Review 架构的拆解
如果从你正在研究的 Agent Harness 架构师视角来看，我会把 Codex Review 分成三层：
Layer 1：Review Runtime
解决：
在哪里跑？
有什么权限？
代码从哪里来？
包括：
CLI
App Server
Cloud sandbox
GitHub Action
Layer 2：Review Intelligence
解决：
看什么？
怎么分析？
找什么问题？
怎么验证？
包括：
Review Target
Context
Reviewer Agent
Subagents
Skills
Tests
Git
Layer 3：Review Governance
解决：
什么才算 finding？
什么不能报？
谁能修改？
谁来决定是否接受？
包括：
Finding Gate
Severity
Evidence
Read-only boundary
Structured Output
Human Review
这个分层对你自己实现 Code Review Harness 很有价值。
24. 一个尤其值得注意的方向：Codex 正在把 Review 做成“工程闭环”
OpenAI 对 Codex 的公开工程文章里，已经不只是把 review 当一个独立工具，而是把：
validation
testing
review
feedback
recovery
统一进 agent engineering loop。
所以从长期架构看，我更建议把 Codex Review 理解成：
              ┌──────────────┐
              │     Plan     │
              └──────┬───────┘
                     ↓
              ┌──────────────┐
              │    Coding    │
              └──────┬───────┘
                     ↓
              ┌──────────────┐
              │    Tests     │
              └──────┬───────┘
                     ↓
              ┌──────────────┐
              │    Review    │
              └──────┬───────┘
                     ↓
              ┌──────────────┐
              │   Findings   │
              └──────┬───────┘
                     ↓
              ┌──────────────┐
              │     Fix      │
              └──────┬───────┘
                     ↓
              ┌──────────────┐
              │ Re-validation│
              └──────────────┘
这和单纯：
Diff → LLM → Comment
已经是两个完全不同的系统。
25. 最后给你一个“Codex Review 实现地图”
模块	Codex 当前公开实现/思路	对 Harness 的启发
Review Entry	CLI / App Server / GitHub / CI	Review 做成一等能力
Target	uncommitted / base / commit	ReviewTarget 类型化
Diff	merge-base / actual merge changes	不要简单 branch diff
Repo Rules	AGENTS.md	review policy repo-local 化
Context	diff + surrounding code + tests + callsites	Context Builder 独立
Orchestration	review orchestrator + code-review-*	多 reviewer fan-out
Review Style	defect-first	优先真实缺陷
Validation	tests / callsites / code evidence	Finding 必须有证据
Filtering	introduced / actionable / meaningful	Findings Gate
Severity	P0~P3	标准化 finding
Output	Markdown / structured JSON	LLM 与 SCM 解耦
Posting	GitHub / SCM adapter	Publisher 独立
Permissions	read-only review	Reviewer/Coder 权限隔离
Loop	review → fix → re-review	支持持续 review
关键资料
最值得直接读源码的是这几份：
1. Codex Review Orchestrator
.codex/skills/code-review/SKILL.md
2. Codex Review Agent
codex-rs/skills/src/assets/samples/review-agent/SKILL.md
这是目前公开资料里最值得研究的一份，里面基本把 reviewer 的行为规范写出来了。
3. Review Context
.codex/skills/code-review-context/SKILL.md
主要看 context engineering。
4. Review Testing
.codex/skills/code-review-testing/SKILL.md
主要看 Review 系统本身如何测试。
5. CLI ReviewArgs
codex-rs/exec/src/cli.rs
可以看 --uncommitted / --base / --commit / prompt 的一等建模。
6. App Server Review API
codex-rs/app-server
重点看 review/start 和 ReviewTarget 的协议设计。
7. OpenAI 官方 Code Review 实现指南
Codex SDK / GitHub Actions 的 structured review 示例。
8. OpenAI 官方 Code Review 产品说明
包含 GitHub 自动 review、@codex review、代码库/依赖分析、测试验证等产品层设计。