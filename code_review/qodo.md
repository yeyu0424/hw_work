我整理了一份偏“工程实现 / 架构拆解”视角的 Qodo Code Review 调研。重点不是产品功能罗列，而是回答：Qodo 到底怎样完成一次代码检视、上下文怎么组织、Agent 怎么分工、结果怎么降噪，以及哪些设计值得自己实现。
说明：下面以 Qodo 2.x（2026 年） 为主，同时结合它早期的开源 PR-Agent / Qodo Merge 实现分析。Qodo 2.x 的核心服务端实现并未完整开源，因此涉及内部 Agent 调度器、Context Engine 内部索引算法等部分，我会明确标注“公开确认”与“架构推断”。
1. 先给结论：Qodo 的 Code Review 已经不是“把 diff 丢给 LLM”
Qodo 当前公开描述的架构可以抽象成：
                 ┌──────────────────────┐
                 │   GitHub / GitLab    │
                 │ Bitbucket / ADO      │
                 └──────────┬───────────┘
                            │ PR Event
                            ▼
                 ┌──────────────────────┐
                 │   Review Orchestrator│
                 └──────────┬───────────┘
                            │
                ┌───────────┼────────────┐
                │           │            │
                ▼           ▼            ▼
         ┌──────────┐ ┌──────────┐ ┌─────────────┐
         │ Context  │ │  Rules   │ │ PR History  │
         │  Engine  │ │  System  │ │ / Memory    │
         └────┬─────┘ └────┬─────┘ └──────┬──────┘
              │            │              │
              └────────────┼──────────────┘
                           ▼
                ┌──────────────────────┐
                │  Context Agent       │
                │  repo exploration    │
                │  dependency mapping  │
                │  requirement context │
                └──────────┬───────────┘
                           ▼
              ┌────────────────────────────┐
              │ Specialized Review Agents  │
              │                            │
              │ Bug / Logic                │
              │ Security                   │
              │ Breaking Change            │
              │ Rule / Compliance          │
              │ Requirement Gap            │
              │ Performance / Runtime      │
              │ ...                        │
              └────────────┬───────────────┘
                           │ findings
                           ▼
                  ┌──────────────────┐
                  │   Judge Agent    │
                  │ dedupe / verify  │
                  │ rank / filter    │
                  └────────┬─────────┘
                           ▼
                  ┌──────────────────┐
                  │ Finding Renderer │
                  │ summary + inline │
                  └────────┬─────────┘
                           ▼
                    GitHub PR Review
这个架构是 Qodo 当前公开资料中反复强调的核心：
Context Engine → 多专用 Review Agents → Judge Agent → 高置信度 Findings。
Qodo 2.0 官方明确说，它把代码审查拆成多个专用职责，每个 Agent 使用自己的上下文；最终由 Judge Agent 解决冲突、去重和低价值结果过滤。

2. 一次 Qodo Review 到底怎么跑
可以把一次 PR Review 拆成 9 个阶段。
Phase 1：PR 触发
最外层是 Git 平台事件：
PR opened
PR updated / synchronize
manual /review
CI / webhook
Qodo 支持自动或手工触发，并且现在可以在组织级配置：
是否自动 review
draft PR 是否 review
哪些 repo / branch / folder / file 纳入 review
findings 是否 inline
inline severity threshold
每次 review 的 findings 数量
这些配置已经进入 Qodo Portal，而不是只能写 repo 配置文件。
所以第一层其实是：
PR Event
   ↓
Review Policy
   ↓
Should Review?
   ↓
Scope / Trigger / Mode
这其实非常值得借鉴，因为**“什么时候审”本身就是 Review Engine 的一部分**。
3. Phase 2：先定义 Review Scope
Qodo 不会简单地：
diff = git.diff()
llm(diff)
而是先确定：
Base branch
Target commit
Changed files
Changed hunks
New files
Deleted files
PR metadata
PR description
Linked ticket
Repository state
同时判断：
哪些文件真正需要分析？
哪些文件应该忽略？
是否需要跨仓库？
是否需要 ticket context？
是否需要历史 PR？
早期 Qodo Merge / PR-Agent 中已经有比较成熟的 PR Compression + token-aware patch fitting 机制，会根据 token budget 对 PR 内容做压缩和筛选，而不是无脑把整个 diff 塞进模型。

4. Phase 3：Context Engine 是 Qodo 最重要的基础设施
这是 Qodo 和早期普通“LLM Code Review Bot”最大的区别。
Qodo 官方现在把 Context Engine 定位成：
一个持续更新的、面向整个代码组织的代码智能层。
它不仅保存代码，还包括：
Repository
├── source code
├── file structure
├── dependencies
├── relationships
├── interfaces
├── tests
├── related repositories
│
├── PR history
├── review comments
├── accepted/rejected findings
│
├── tickets
├── specifications
├── design docs
│
└── organizational rules
Qodo 明确表示 review agent 获取的是：
当前 repository
PR history
code relationships
related repos
linked tickets/specs
而不是把整个 repo 一股脑放进 prompt。
5. Qodo 的一个关键设计：Context Agent
这是我认为 Qodo 架构里非常值得借鉴的一点。
它不是让每个 Reviewer Agent 自己从零搜索 repo。
而是先：
                PR Diff
                   │
                   ▼
          Context Agent
                   │
        ┌──────────┼───────────┐
        │          │           │
      owner      caller      tests
        │          │           │
      module     dependency   behavior
        │          │           │
        └──────────┼───────────┘
                   ▼
           Context Brief
Qodo 公开描述的流程是：
Context Agent 先探索 repository
找出与此次 change 相关的结构
生成一个针对当前 PR 的 walkthrough / briefing
代码引用要先验证是否真的存在
后面的 Review Agents 使用这个经过验证的 context，而不是直接面对整个代码库
这其实是一个很重要的 Context Engineering Pattern：
先研究，再审查。
而不是：
所有 Agent 自己查资料。
6. Context Engine 怎么查代码？
Qodo 在 2026 年 8 月的技术文章中已经公开了一些很有价值的实现细节。
Context Agent 使用一组受控导航工具，例如：
list directory
search by regex
match files by pattern
read file range
还可以调用：
history search
similar PR search
previous finding search
cross-repository analysis
ticket/spec connector
这个设计特别重要。
它意味着 Qodo 的 Agent 并不是：
LLM → arbitrary shell
而更接近：
LLM
 │
 ├── repo_search()
 ├── file_tree()
 ├── read_file()
 ├── search_history()
 ├── search_similar_pr()
 ├── find_consumers()
 └── get_ticket()
然后所有 Tool 都有：
权限边界
输出大小限制
workspace 隔离
step budget
Qodo 官方明确提到：
tool registry 是固定的
agent 不能任意发明工具
workspace 有边界
读操作有 allow-list
输出有上限
每个 Agent 有最大 exploration/reasoning step budget
这个设计对于你前面研究的 Harness-based Code Review 特别重要。
7. Phase 4：把 Review 拆成多个 Specialized Agents
Qodo 2.0 最核心的架构变化就是这里。
官方明确表示，Qodo 使用 十几个专门的 Review Agents，每个 Agent 针对一个特定质量维度。公开举例包括：
Critical Issues
Breaking Changes
Security
Rule violations
Requirement gaps
UI issues
Runtime failures
Performance
Accessibility
...
例如可以抽象成：
                     Review Context
                           │
          ┌────────────────┼─────────────────┐
          │                │                 │
          ▼                ▼                 ▼
    Bug Agent        Security Agent    Rule Agent
          │                │                 │
          ▼                ▼                 ▼
    Findings A        Findings B       Findings C

          ┌────────────────┼─────────────────┐
          │                │                 │
          ▼                ▼                 ▼
 Breaking Agent   Requirement Agent   Performance Agent
8. 为什么不用一个 Agent？
Qodo 给出的核心解释是：
code review 其实包含多个互相独立的 reasoning task。
例如：
Bug Agent
问：这里会不会产生错误行为？

Security Agent
问：这里有没有安全风险？

Rule Agent
问：是否违反团队标准？

Breaking Change Agent
问：是否破坏其它 consumer？

Requirement Agent
问：代码是不是完成了 ticket 的要求？
如果让一个 Agent 同时完成：
bug
security
architecture
rule
requirement
performance
就很容易发生注意力竞争。
Qodo 因此采用：
one responsibility
      ↓
one specialized agent
      ↓
one focused context
这对你设计自己的 Code Review Harness 是一个非常强的参考。
9. Phase 5：每个 Agent 并不应该看到完全一样的 Context
这个地方很容易被忽略。
好的多 Agent Review 并不是：
diff
  ↓
所有 Agent 都拿同一个 prompt
而应该是：
Global Context
     │
     ▼
Context Planner
     │
     ├── Bug Agent
     │      ├── changed code
     │      ├── callers
     │      ├── tests
     │      └── runtime behavior
     │
     ├── Security Agent
     │      ├── changed code
     │      ├── trust boundary
     │      └── data flow
     │
     ├── Breaking Change Agent
     │      ├── interfaces
     │      ├── consumers
     │      └── dependent repos
     │
     └── Rule Agent
            ├── applicable rules
            └── past review decisions
Qodo 公开资料虽然没有披露完整的内部 prompt/router，但是它明确强调 不同 Agent 使用专属 context。
所以我认为这里更接近：
Context Retrieval
      +
Agent-specific context assembly
而非单纯 RAG。
10. Phase 6：Rule System
这是 Qodo 2.1 之后非常重要的一层。
Qodo 不是只做：
AI 找 bug
还开始回答：
“这个组织认为什么是对的？”
Rule System 的输入来源包括：
代码库
PR History
Markdown / docs
Wiki
best practices
existing rule files
review history
Qodo 可以把类似：
.cursorrules
agents.md
best_practices.md
内部 coding standards
review comments
中的“tribal knowledge”转成结构化规则。
11. Qodo 的 Rule 不是简单 Prompt
这是另一个值得借鉴的设计。
传统做法：
rules.md
   ↓
prepend prompt
   ↓
LLM
Qodo 做的是：
        Rule Lifecycle
              │
      ┌───────┼────────┐
      ▼       ▼        ▼
   Discover Define   Import
      │       │        │
      └───────┼────────┘
              ▼
          Structured Rule
              │
         ┌────┴─────┐
         ▼          ▼
      Scope      Severity
         │          │
         └────┬─────┘
              ▼
      Rule Enforcement Agent
              │
              ▼
          Finding
而且有：
duplicate detection
conflict detection
scope
adoption metrics
violation metrics
rule health
也就是说：
Qodo 正在把“Prompt Engineering”升级成“Policy Engineering”。
12. Phase 7：PR History 是另一个关键 Context
Qodo 2.2 引入了明显的 PR Knowledge / PR Memory。
它会学习：
过去 PR
   ↓
review comments
   ↓
accepted / rejected
   ↓
similar changes
   ↓
similar findings
然后在新 PR 上回答：
这个问题以前出现过吗？

以前 reviewer 是怎么处理的？

这个模式在团队里通常被接受还是拒绝？

这条建议是否真的与本仓库相关？
Qodo 2.2 的 Finding Recommendation Agent 就是在利用历史 PR context 来判断 finding 的 relevance。
这实际上形成：
       Review
          │
          ▼
      Findings
          │
          ▼
  Human decision
   │          │
 accept     reject
   │          │
   └────┬─────┘
        ▼
   PR History
        │
        ▼
 Future Review
这是典型的 Memory Feedback Loop。
13. Phase 8：多 Agent Findings → Judge Agent
这是 Qodo 里最关键的“降噪层”。
假设：
Bug Agent          → 7 findings
Security Agent     → 3 findings
Rule Agent         → 8 findings
Breaking Agent     → 4 findings
Requirement Agent  → 5 findings
总共 27 个。
不能直接全部发给开发者。
Qodo 会进入：
                27 Findings
                     │
                     ▼
               Judge Agent
                     │
       ┌─────────────┼─────────────┐
       │             │             │
    duplicate      conflict      weak
       │             │             │
       ▼             ▼             ▼
      merge       resolve       discard
                     │
                     ▼
              rank / prioritize
                     │
                     ▼
               Final Findings
官方明确说明 Judge Agent 会：
resolve conflicts
deduplicate
filter low-signal findings
只保留满足 confidence / relevance threshold 的问题
这和传统：
LLM → 评论
差别非常大。
实际上它已经变成：
LLM ensemble
      ↓
evidence aggregation
      ↓
judging
      ↓
publication policy
14. Finding 本身也是结构化对象
Qodo 不是只生成一句：
“这里可能有 bug。”
现在公开的 Finding 结构更接近：
{
  "type": "bug",
  "severity": "action_required",
  "title": "...",
  "description": "...",
  "file": "...",
  "line": 123,
  "evidence": "...",
  "reasoning": "...",
  "remediation_prompt": "..."
}
官方提到 Finding 包含：
issue explanation
semantic quality label
file path
relevant snippet
evidence/reasoning
remediation prompt
这一点对你自己实现 Review Engine 很重要：
内部 Finding 一定要结构化，不能直接让 LLM 输出 Markdown。
15. Qodo 的输出实际上有两条通道
                 Final Findings
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
       PR Summary          Inline Review
             │                   │
        aggregate             file/line
        findings             annotation
而且可以控制：
comments_location_policy
inline severity threshold
finding volume
例如当前文档示例：
[review_agent]
comments_location_policy = "both"

inline_comments_severity_threshold = 3
即只有达到对应严重性阈值的问题才进入 inline comment。
这是很典型的：
Detection 与 Presentation 解耦。
16. Phase 9：Ticket / Requirement Compliance
Qodo 还把“代码有没有实现需求”作为 Review 的一个独立维度。
例如：
Jira / Linear / ADO / GitHub Issue
             │
             ▼
       Ticket Context
             │
             ▼
      Requirement Agent
             │
     ┌───────┼────────┐
     ▼       ▼        ▼
   Fully   Partial    Not
 compliant compliant compliant
早期 Qodo Merge 已经会：
从 PR description 找 ticket
从 branch name 找 ticket
获取 Jira / Linear / ADO 等数据
在 review 中判断 PR 与 ticket intent 是否一致
例如返回：
Fully Compliant
Partially Compliant
Not Compliant
PR Code Verified
所以 Qodo 的 Review 不只是：
“代码有没有 bug”
而是：
Change
   ↓
Does it work?
   +
Does it violate architecture?
   +
Does it violate standards?
   +
Does it break consumers?
   +
Does it satisfy requirements?
17. Cross-Repo Review
Qodo 现在还把 review 从：
Repository A
扩展到：
Repo A
   │
   ├── shared library B
   ├── service C
   ├── SDK D
   └── API schema E
Context Engine 会根据：
dependency manifest
lockfile
production imports
ownership files
CI / infra definitions
OpenAPI
protobuf
识别真实的 repository relationships。
并不是简单把所有 repo 加进向量库，而是：
Evidence
  ↓
Candidate relation
  ↓
Deterministic validation
  ↓
Verified relationship
Qodo 官方特别强调这一点，以避免产生“模型猜测出来的 dependency”。
18. 这其实形成了一个完整 Review Harness
把 Qodo 抽象掉产品名字之后，它实际上非常接近一个成熟的 Code Review Harness：
                     ┌──────────────┐
                     │ Trigger      │
                     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │ Scope        │
                     └──────┬───────┘
                            │
              ┌─────────────▼─────────────┐
              │ Context Assembly          │
              │                           │
              │ repo / history / ticket   │
              │ dependency / rules        │
              └─────────────┬─────────────┘
                            │
                    ┌───────▼────────┐
                    │ Context Agent  │
                    └───────┬────────┘
                            │
      ┌─────────────────────┼─────────────────────┐
      │                     │                     │
      ▼                     ▼                     ▼
   Bug Agent           Security Agent        Rule Agent
      │                     │                     │
      └─────────────────────┼─────────────────────┘
                            ▼
                    ┌───────────────┐
                    │ Judge Agent   │
                    └───────┬───────┘
                            │
                    ┌───────▼────────┐
                    │ Finding Policy │
                    └───────┬────────┘
                            │
                 ┌──────────┴──────────┐
                 ▼                     ▼
              Summary               Inline
                 │                     │
                 └──────────┬──────────┘
                            ▼
                     Human Decision
                            │
                            ▼
                       Memory Update
这就是我认为目前最值得拿来作为你前面讨论的 “基于 Harness 实现 Code Review” 的参考蓝图。
19. Qodo 早期 PR-Agent 的工程实现其实也非常值得研究
如果你要自己做，不建议只研究 Qodo 2.x。
因为 Qodo 早期 PR-Agent 是开源的，能看到很多具体工程实现。
它的架构大致是：
CLI / Webhook / GitHub Action
              │
              ▼
          PRAgent
              │
        command dispatch
              │
    ┌─────────┼────────────┐
    ▼         ▼            ▼
 PRReviewer  PRDescription PRCodeSuggestions
    │
    ▼
GitProvider
    │
    ▼
PR diff / metadata / files
    │
    ▼
TokenHandler / compression
    │
    ▼
Prompt + JSON schema
    │
    ▼
LiteLLM
    │
    ▼
Structured output
    │
    ▼
Markdown / Git comments
公开源码分析显示核心类包括：
PRAgent
PRReviewer
PRDescription
PRCodeSuggestions
GitProvider
LiteLLMAIHandler
TokenHandler
20. PR-Agent 最值得借鉴的工程点：单 Tool 单 LLM Call
PR-Agent 一个非常明确的工程原则是：
每个 tool 尽量一次 LLM call。
例如：
/review
  ↓
1 LLM call

/improve
  ↓
1 LLM call

/describe
  ↓
1 LLM call
这样可以把一次操作控制在：
低延迟
低成本
可预测
虽然 Qodo 2.x 已经发展为多-agent architecture，但这里仍然有一个非常重要的思想：
不要让 Agent 无限循环。
这也是为什么 Qodo 现在强调每个 Agent 有：
tool whitelist
step budget
output limit
21. PR-Agent 的另一个亮点：PR Compression
早期很多 Code Review Agent 的最大问题是：
PR 1000 lines
      ↓
prompt 太大
      ↓
模型开始忽略细节
PR-Agent 做了一个非常工程化的解决方案：
PR
│
├── files
├── patches
├── hunks
└── metadata
       │
       ▼
Token-aware compression
       │
       ├── skip low-value files
       ├── truncate patches
       ├── fit token budget
       └── prioritize relevant changes
       │
       ▼
LLM Context
它还支持：
adaptive patch fitting
token-aware file patch fitting
ignored file extensions
configurable max token
对于你自己的 Review Harness，这其实比“上更大的模型”更加重要。
22. PR-Agent 还有一个很值得学习的机制：Self Reflection
早期 PR-Agent 的 suggestion workflow 中有：
First LLM call
      ↓
Generate suggestions
      ↓
Self-reflection
      ↓
Score each suggestion
      ↓
Filter low score
      ↓
Publish
公开资料描述的流程是：
suggestion
score 0~10
reason
threshold
低分建议直接被删除。
也就是说，它其实已经在实现一个简化版：
generator
   ↓
critic
   ↓
filter
这和今天 Qodo 的：
multiple expert agents
   ↓
judge
在架构思想上是连续的。
23. Qodo 与传统 LLM Review 最大的区别
可以用这张表概括：
能力	传统 LLM Review	Qodo 2.x
Diff review	✅	✅
Full repo context	部分	✅
Cross-file reasoning	部分	✅
Multi-repo	少见	✅
PR history	很少	✅
Ticket context	部分	✅
Specialized agents	少见	✅
Judge agent	少见	✅
Organization rules	Prompt	Rule System
Historical memory	弱	✅
Rule lifecycle	无	✅
Finding dedupe	简单	✅
Finding prioritization	简单	✅
Inline policy	部分	✅
Governance analytics	少见	✅
Qodo 当前官方文档已经把产品定位成：
Code Review
+
Context Engine
+
Governance
+
Administration
+
Agent Skills
而不是一个单独的 PR Bot。
24. 对“Code Review Harness”最值得直接抄的 10 个设计
结合你前面一直在研究的 Harness，我认为最值得直接移植的是：
① Review Orchestrator
不要让 Agent 自己决定整个流程。
ReviewEngine.run(pr)
统一控制：
scope
context
agents
judge
policy
publish
memory
② Context Agent
先做：
repo exploration
再交给 reviewer。
而不是：
every reviewer searches everything
这可以显著降低重复检索和 token 消耗。
③ Specialized Review Agents
不要：
One Agent = Code Review
推荐：
BugAgent
SecurityAgent
ArchitectureAgent
BreakingChangeAgent
RequirementAgent
RuleAgent
TestAgent
④ Judge Agent
这是最重要的一层：
raw_findings
      ↓
Judge
      ↓
validated_findings
Judge 做：
dedupe
conflict resolution
severity
confidence
relevance
⑤ Finding Schema
统一：
Finding(
    id,
    category,
    severity,
    confidence,
    file,
    line,
    title,
    description,
    evidence,
    remediation,
)
从一开始就不要让 Agent 输出自由文本。
⑥ Rule Engine
将规则从：
prompt string
提升为：
Rule
 ├── scope
 ├── severity
 ├── category
 ├── source
 ├── version
 ├── enforcement
 └── lifecycle
⑦ Historical Memory
保存：
finding
review decision
accepted
rejected
fixed
ignored
然后用于下一次 review。
这比单纯 RAG 更有价值。
⑧ Context Retrieval 而不是 Context Dump
不要：
100k lines → model
而应该：
PR
 ↓
Context Planner
 ↓
retrieve relevant evidence
 ↓
bounded context
 ↓
agent
Qodo 当前 Context Engine 就是非常典型的这个路线。
⑨ Deterministic Checks + AI Checks
不要让所有问题都交给 LLM。
应该：
                  Review
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
 Deterministic             Agentic
 checks                    reasoning
        │                       │
 lint/test/SAST            architecture
 schema                    behavior
 dependency                requirements
        │                       │
        └──────────┬────────────┘
                   ▼
                Judge
这也是早期 Qodo Merge 就强调“static analysis + LLM logic”的方向。
⑩ Review → Memory → Rules 的闭环
这是最有价值的一点：
             ┌─────────────┐
             │    Review   │
             └──────┬──────┘
                    ▼
                 Findings
                    ▼
               Human Decision
              ┌─────┴─────┐
              ▼           ▼
           accepted     rejected
              │           │
              └─────┬─────┘
                    ▼
                PR Memory
                    ▼
               Rule Miner
                    ▼
              Structured Rules
                    ▼
               Next Review
这已经不再是：
AI 帮我 review。
而是：
AI Review System 持续学习一个组织到底如何 review code。
这也是 Qodo 从 2.0 → 2.1 → 2.2 → 2.3/2.4 演进最明显的方向。
25. 我对 Qodo 架构的最终抽象
如果把 Qodo 当前体系进一步抽象，我会定义成：
                ┌─────────────────────┐
                │   Governance Layer  │
                │ rules / policy      │
                └─────────┬───────────┘
                          │
       ┌──────────────────▼──────────────────┐
       │            Context Layer             │
       │                                      │
       │ repo / dependency / history / spec  │
       │ ticket / cross-repo / memory        │
       └──────────────────┬──────────────────┘
                          │
       ┌──────────────────▼──────────────────┐
       │          Agent Reasoning Layer       │
       │                                      │
       │ bug / security / architecture /     │
       │ breaking / requirement / rules ...  │
       └──────────────────┬──────────────────┘
                          │
                    ┌─────▼─────┐
                    │   Judge   │
                    └─────┬─────┘
                          │
                    ┌─────▼─────┐
                    │  Finding  │
                    │  Engine   │
                    └─────┬─────┘
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
         PR Review                  Memory
             │                         │
             └────────────┬────────────┘
                          ▼
                       Learning
所以从架构师角度看，Qodo 真正的护城河不是某个 Prompt，也不是某个模型，而是四个系统的组合：
Context Engine + Specialized Agents + Judge + Organizational Memory/Rules
这四者组合起来以后，才形成了 Qodo 所说的 context-aware agentic code review。
26. 一个特别重要的判断：Qodo v1 和 v2 不应该混为一谈
这点在你后面做技术方案时很容易踩坑。
Qodo v1 / PR-Agent
更接近：
PR
 ↓
Diff Compression
 ↓
Prompt
 ↓
LLM
 ↓
JSON
 ↓
Comment
优秀工程点：
token management
configuration
git abstraction
structured output
self reflection
RAG
incremental review
Qodo v2
变成：
PR
 ↓
Review Scope
 ↓
Context Engine
 ↓
Context Agent
 ↓
Multi-Agent Review
 ↓
Judge
 ↓
Rule Enforcement
 ↓
Finding Ranking
 ↓
PR
 ↓
Memory
 ↓
Rules evolution
这是一个明显的架构升级。Qodo 官方把 2026-02-04 的 Qodo 2.0 定义为下一代 agentic code review，并明确将 multi-agent + full repository context + PR history 作为核心基础。
27. 对你当前“基于 Harness 做 Code Review”的直接启示
如果你的目标是自己实现一个类似 Qodo 的 Code Review Harness，我不会建议一开始就照搬 Qodo 十几个 Agent。
更合理的 MVP 是：
                   Review Harness
                         │
          ┌──────────────┴──────────────┐
          │                             │
      Context Agent                Rule Engine
          │                             │
          └──────────────┬──────────────┘
                         ▼
                ┌─────────────────┐
                │ 3 Review Agents │
                │                 │
                │ Bug             │
                │ Security        │
                │ Architecture    │
                └────────┬────────┘
                         ▼
                    Judge Agent
                         ▼
                  Finding Schema
                         ▼
                 GitHub PR Comment
                         ▼
                    Review Memory
先把这条链跑通：
Context → Specialized Review → Judge → Finding → Feedback
然后再增加：
Cross-repo
Ticket Agent
Test Agent
Rule Miner
Historical Recommendation
Governance Analytics
这样会比一开始堆 10～20 个 Agent 更容易工程落地。
另外，Qodo 最近在 2026-09-09 刚发布 Agentic Toolbox，把“代码理解、规则、独立 Review、Review Finding Resolution”进一步前移到 Claude Code、Cursor CLI、Codex 等 coding-agent workflow 中；这说明 Qodo 正从“PR 审查 Bot”继续演进成 独立的代码质量 / Governance Harness。
我也可以下一步直接把 Qodo 的完整 Review Harness 按 Orchestrator / Context Engine / Agent / Judge / Memory / Rule / Git Provider 拆成可实现的类图、调用时序图和 Python/TypeScript 项目目录结构。