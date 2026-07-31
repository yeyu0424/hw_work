# Qoder code review + 自演进机制
## 一、代码审查流程
### 触发机制

每次user发消息时，系统会在上下文中注入一个 `<system-reminder>` 块，定义审查的触发条件和执行模式。user在对话中其实已经能看到它——就是消息中 `<system-reminder>` 标签里的内容。它大致规定了：

- **何时触发**：用户请求 code review 时
- **执行方式**：派遣 **3 个 CodeReview 子代理**并行工作
- **三个视角**：
  - `completeness` — 变更是否实现了原始需求意图
  - `correctness` — 是否存在编码错误、逻辑/安全问题
  - `impact` — 是否引入新的副作用或回归
- **输出格式**：按严重程度分三档（严重/警告/建议），每条包含标题、文件位置、问题描述、修复建议；最后附变更摘要

### 执行过程

```
user说 "review 最新提交"
       │
       ▼
  ① 主agent执行 git log -1 获取最新 commit hash 和 message
       │
       ▼
  ② 主agent执行 git show --stat 获取变更文件列表
       │
       ▼
  ③ 并行派遣 3 个 CodeReview 子代理（Agent 工具）
     每个子代理收到：
     - 视角名称 + 关注描述
     - 审查范围（commit hash + 文件列表）
     - 如有特殊前提（如user给的 _LANGSMITH_API_KEY_ENV 规则），
       主agent会额外写入子代理的 prompt 中
       │
       ▼
  ④ 每个子代理独立工作：
     - 自己执行 git show 读取 diff
     - 自己 Read 完整文件获取上下文
     - 自己搜索相关代码和调用方
     - 返回结构化报告（严重度/标题/位置/问题/修复）
       │
       ▼
  ⑤ 主agent合并 3 份报告：
     - 跨视角去重（同一问题只保留证据最丰富的）
     - 按严重程度分级
     - 输出最终中文报告
```

### 关于子代理能否感知沉淀知识

**不能。** CodeReview 子代理是**无状态的**——它：
- 看不到当前对话历史
- 看不到 `<user_memories>` 中的沉淀知识
- 看不到主agent拥有的任何记忆

它只能看到**主agent在派遣时写进 prompt 的内容**。所以如果某个审查前提来自沉淀的知识（比如user之前提的 `_LANGSMITH_API_KEY_ENV` 规则），主agent必须**手动把它写入子代理的 prompt**，子代理才能知道。这也是为什么主agent在第二次 review 时，在每个子代理的 prompt 里都加了 `ADDITIONAL REVIEW PREMISE` 段落。

---

## 二、知识沉淀流程

### 触发机制

同样由 `<system-reminder>` 中的记忆系统指引触发，核心规则包括：

- **用户触发**：user说"记住"、"以后都要"、"别忘了"等表达持久化意图的话
- **自动触发**：主agent发现可复用的模式、经验教训（标记为 `source: auto`）
- **修正/删除**：user说"记错了"、"忘掉"等

### 存储格式

知识**不是以 JSON 文件**存储的。它通过 `UpdateMemory` 工具调用，传入结构化字段：

```python
# 主agent调用 UpdateMemory 时的参数结构
{
    "action": "create",           # create / update / delete
    "source": "user",             # user（user要求的）/ auto（主agent主动的）
    "title": "简短标题（5-20字）",
    "content": "核心内容（20-1000字）",
    "category": "development_code_specification",  # 分类
    "keywords": "keyword1,keyword2,keyword3",
    "usage_scenario": ["场景1", "场景2", "场景3"]
}
```

可用的 `category` 分类包括：
- `user_info` / `user_hobby` / `user_communication` / `user_behavior`
- `development_code_specification` / `development_practice_specification`
- `project_introduction` / `project_tech_stack` / `project_environment_configuration`
- `common_pitfalls_experience` / `learned_skill_experience` 等

### 知识的可见格式

知识被持久化后，在后续会话中以 `<user_memories>` 和 `<memory_overview>` 的形式注入到上下文中。user能在对话开头看到它们，大致长这样：

```xml
<memory_overview>
├── 代码编写规范 (1个子节点)
│   └── _LANGSMITH_API_KEY_ENV 应废弃，改用 _LANGSMITH_API_KEY_ENV_NEW
└── development_code_specification (1个子节点)
    └── _LANGSMITH_API_KEY_ENV 应废弃并替换为 _LANGSMITH_API_KEY_ENV_NEW
</memory_overview>

<project_specification_memory>
<memory id="xxx" title="...">
  具体的规范内容文本...
</memory>
</project_specification_memory>
```

- `<memory_overview>` 是**索引/目录**，包含标题、关键词、使用场景（用于判断是否需要深入读取）
- `<project_specification_memory>` / `<user_memories>` 是**详细内容**，包含完整的记忆文本

### 检索机制

```
每次user发消息时：
       │
       ▼
  系统自动注入 <memory_overview>（目录）
  到对话上下文中
       │
       ▼
  主agent根据当前任务，判断是否需要更多知识：
  - 看到匹配的标题 → fetch 模式（精确获取）
  - 关键词模糊相关 → search 模式（广泛召回）
  - 需要探索知识树 → explore 模式（逐层展开）
       │
       ▼
  获取到的知识作为上下文约束，
  影响主agent的代码生成/审查/决策
```

---

