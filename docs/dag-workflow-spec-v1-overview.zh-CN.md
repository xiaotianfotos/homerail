# WorkflowSpec v1 DSL 总体设计概要

> 范围说明：本文首先记录 PR #18 建立静态 WorkflowSpec v1 时的边界。后续
> runtime-primitives 工作已经在这套基础上实现受界 Advisor 调用、确定性
> command/compensation、持久审批/状态/触发器、workspace 权限和 run-local
> fan-out；任意动态 Graph Patch 仍不在当前范围内。

状态：`Proposed / WIP`

本文是 WorkflowSpec v1 的总体架构说明，用于设计评审，不代表协议已经冻结，
也不授权开始实现。当前 Draft PR 只包含文档和任务设计。

## 1. 一句话结论

HomeRail 不需要发明新的文本语言，但需要把当前隐式存在的 DAG 语言正式化：

- YAML 和 JSON 是供人类与 AI 编辑的序列化格式；
- WorkflowSpec v1 是公开、严格、版本化的 DSL；
- CanonicalWorkflowIR v1 是 Manager 内部唯一执行语义；
- RunPlan 是每次运行绑定到具体 workflow revision 的不可变快照；
- Graph Patch 是未来动态改图协议，不属于 WorkflowSpec v1。

```text
YAML / JSON
    |
    v
WorkflowSpec v1                 公开 DSL
    |
    | parse + schema validate + semantic validate + compile
    v
CanonicalWorkflowIR v1          唯一规范语义
    |
    | bind workflow revision + runtime profile
    v
RunPlan revision 0              单次运行的不可变起点
    |
    v
Runtime Graph State             node state / mailbox / counters
```

核心原则是：**源码、语义、运行状态必须是三个不同层次。**

## 2. 为什么现在需要 DSL

当前 HomeRail 已经有一套可工作的 YAML 语言，但它是由代码行为隐式定义的：

- [`parseDAGYaml()`](../homerail_manager/src/orchestration/yaml-loader.ts) 直接把
  YAML 转成 `ParsedDAG`；
- [`graph.ts`](../homerail_manager/src/orchestration/graph.ts) 同时承担源码结构、
  规范图和部分运行时接口的类型职责；
- 数据库保存原始 YAML 和 source hash，创建运行时再用当前 parser 重新解析；
- `type`、`node_type`、`gateway.kind`、`gateway.type` 等多种写法由兼容代码归一化；
- 未知字段、拼写错误和不适用于当前 node kind 的字段缺少统一严格校验；
- `outputs.to`、`after` 和 `to: ""` 分别隐式表达数据流、完成依赖和终止；
- handoff port 有名字，但没有机器可验证的 payload contract；
- 同一个 `workflow_id` 更新时覆盖旧源码，没有不可变 revision 历史。

这些问题在简单静态 DAG 中可以由测试和 prompt 约束兜底，但当 AI 自动生成 DAG、
模式开始组合、工作流长期复用、数据库保存多个版本，或者未来支持运行中改图时，
隐式语义会产生四类风险：

1. **静默错误**：字段拼错但 YAML 仍能解析，运行结果与作者意图不同。
2. **语义漂移**：Manager 升级 parser 后，数据库中同一份 YAML 产生不同图。
3. **不可复现**：只知道 `workflow_id`，无法证明某次运行使用的是哪个 revision。
4. **无法安全扩展**：动态图若直接操作当前松散结构，很难校验并发、审计和回放。

因此需要定义 DSL。这里的“DSL”不是新语法，而是 **字段、类型、约束、编译、
版本与执行语义的完整契约**。

## 3. 设计目标

### 3.1 必须实现

1. v1 文档在系统边界严格校验，未知字段直接报错。
2. YAML 和 JSON 表达同一份 WorkflowSpec，编译后得到相同 canonical hash。
3. 所有 node、gateway、port 和 edge 都有单一、明确的语义。
4. 运行时只消费 CanonicalWorkflowIR，不直接理解 YAML 兼容写法。
5. 现有未版本化 YAML 继续运行，行为不回归。
6. 每次语义修改生成不可变 workflow revision。
7. 每个 run 绑定确切 revision、canonical hash 和 compiler version。
8. Manager 通过 `GET /api/dag/schema` 向 CLI 和 AI 提供真实 Schema。
9. 错误包含 code、路径、行列和可执行修复信息。

### 3.2 明确不做

- 不发明类似编程语言的新文本语法；
- 不允许在 DSL 中嵌入任意脚本或表达式；
- 不在 workflow 中保存 provider、model、endpoint 或 secret；
- 不在首版实现动态 Graph Patch；
- 不借本次改造新增 Executor-Advisor、Human Approval 等运行时 node kind；
- 不自动重写用户已经保存的 legacy YAML；
- 不把 RuntimeProfile v1 强行纳入首个 WorkflowSpec 实现 PR。

## 4. 设计原则

### 4.1 声明式，而不是可编程

**Why**：任意表达式、脚本和模板求值会扩大安全面，使 Schema 无法完整描述行为，
也让 AI 难以预测运行结果。

**How**：condition 只支持有限字段选择和枚举路由；while 只支持有限比较运算；
所有循环必须有静态上限；真正的 shell/API 检查由未来受控 node kind 实现，而不是
塞进条件表达式。

### 4.2 Provider-independent

**Why**：DAG 描述工作分工和证据流，不应绑定某个账号、模型或部署地址。同一 DAG
应能在 Codex、Claude-compatible harness 或本地模型之间切换。

**How**：WorkflowSpec 只引用逻辑 agent role；运行前由数据库中的 RuntimeProfile
绑定 `llm_setting_id` 和 `agent_type`。Schema 明确禁止 credentials 和 provider URL。

### 4.3 严格边界，宽容迁移

**Why**：新文档必须尽早拒绝错误，但现有用户资产不能因升级突然失效。

**How**：有 `api_version` 的 v1 走严格 compiler；无版本文档走 legacy/v0 adapter。
两条输入路径最终编译到同一个 canonical IR，运行时不区分来源。

### 4.4 一种语义，一种规范表示

**Why**：如果同一条边既能写在 node 内，也能写在顶层，或者终点既能用空字符串又能
用 terminal node，Schema、AI 生成和未来 patch 都会出现分支组合。

**How**：v1 选择一个推荐写法；所有 legacy shorthand 只存在于 adapter，canonical IR
永远只有显式 node、port 和 edge。

### 4.5 Revision 表示语义，而不是文本

**Why**：缩进、注释和 key 顺序变化不应制造新的可执行版本；行为变化必须留下不可变
revision。

**How**：同时计算 source hash 和 canonical hash。只有 canonical hash 变化才增加
semantic revision；每次 sync 仍写 audit event，保留谁在何时提交了什么 source。

## 5. WorkflowSpec v1 文档结构

推荐的公开 envelope：

```yaml
api_version: homerail.ai/v1
kind: Workflow

metadata:
  id: release-review
  name: Release Review
  labels:
    domain: engineering

spec:
  description: Verify one release candidate and report a final verdict.
  workspace:
    mode: isolated

  contracts: {}
  agents: {}
  nodes: {}
  edges: []
  policies: {}
```

### 5.1 为什么使用 envelope

**Why**：当前 flat root 把身份、说明、执行定义和策略混在一起。未来若增加
`RuntimeProfile`、`Pattern` 或其他资源类型，只加 `schema_version` 无法可靠分派。

**How**：

- `api_version` 决定 parser/compiler 与兼容策略；
- `kind` 决定资源 Schema；
- `metadata` 只保存身份、名称、标签等控制面信息；
- `spec` 保存声明式期望状态；
- 运行状态、revision、hash、数据库 id 不由用户在 `spec` 中伪造。

代价是多两层缩进，但换来稳定资源模型、清晰升级路径和统一 API。

### 5.2 Metadata

建议 v1 首版只包含：

- `id`：稳定 `workflow_id`，必填；
- `name`：展示名称，必填或由 id 生成；
- `labels`：受限字符串 map，可选；
- `annotations`：受大小限制的非执行元数据，可选。

Revision 不由源码指定。Manager 接受 sync 后分配 revision，避免客户端覆盖或伪造历史。

### 5.3 Spec

`spec` 是可执行意图，包含：

- `description`；
- `workspace`；
- `contracts`；
- `agents`；
- `nodes`；
- `edges`；
- `policies`。

所有对象 `additionalProperties: false`，除非字段本身明确是用户命名 map。

## 6. Agent、Node 与 Port

### 6.1 Agent 是能力配置，不是图节点

```yaml
agents:
  verifier:
    system: |
      Verify the supplied evidence against the acceptance contract.
    skills:
      - homerail-dag-ops
```

**Why**：同一种角色可能被多个 node 使用，模型绑定也应独立于拓扑。

**How**：node 通过 `agent` 引用逻辑 role；RuntimeProfile 按 role 绑定模型。Agent 定义
不能包含 provider、model 或 secret。

### 6.2 Node 是一次可调度行为或确定性控制点

建议首版 node kind 使用判别联合，而不是一个包含全部可选字段的大对象：

```text
agent
condition
join
foreach
while
terminal
```

每种 kind 有独立 Schema。例如 agent node：

```yaml
nodes:
  verify:
    kind: agent
    agent: verifier
    inputs:
      evidence:
        contract: VerificationInput
    outputs:
      verdict:
        contract: VerificationVerdict
```

**Why**：`condition` 不应该接受 agent 字段，`agent` 也不应该携带 join threshold。
判别联合能在同步前发现错误，并让 TypeScript 对 node kind 做穷尽检查。

**How**：Schema 先按 `kind` 选择分支，compiler 再生成 canonical node。未知 kind 在 v1
中报错；未来新增 node kind 必须通过版本化 Schema 发布，不能落入任意 `extra`。

### 6.3 Port 是节点的公开接口

Input port 定义节点愿意接收什么，output port 定义节点可能产生什么。拓扑不写在 port
内部，而由顶层 edge 连接。

```yaml
inputs:
  evidence:
    contract: VerificationInput
outputs:
  verdict:
    contract: VerificationVerdict
```

这样一个 node 可以在不同 workflow 中复用，port contract 不随连接目标改变。

## 7. Handoff Contract

推荐使用命名 contract，内容采用受限 JSON Schema：

```yaml
contracts:
  VerificationVerdict:
    type: object
    additionalProperties: false
    required: [verdict, evidence]
    properties:
      verdict:
        type: string
        enum: [pass, fail]
      evidence:
        type: array
        maxItems: 100
        items:
          type: string
```

### 7.1 Why

当前 gateway 依赖 prompt 约定 `status`、`vote`、`metric` 等字段。模型若返回空内容、
嵌套字段或拼写变化，通常只能在路由后或 scorecard 中发现。输入输出分别复制 Schema
又会产生漂移。

### 7.2 How

- contract 在 workflow 内命名一次；
- input/output port 通过名字引用同一 contract；
- compiler 校验 contract 存在，并检查 edge 两端是否引用兼容 contract；
- handoff 进入 mailbox 前执行运行时验证；
- contract violation 生成结构化 node failure，不能走 success edge；
- 错误证据记录 node、port、contract、JSON path 和实际值摘要；
- Schema 深度、属性数量、字符串长度和数组长度都受限。

首版不尝试证明任意两个 JSON Schema 的数学包含关系。最可靠规则是 edge 两端引用同一
命名 contract；显式兼容映射留给后续版本。

## 8. Edge 与依赖语义

推荐 v1 使用顶层显式 edge：

```yaml
edges:
  - from: triage.classified
    to: signal_gate.signal

  - from: signal_gate.actionable
    to: execute.task

  - from: verify.verdict
    to: verdict_gate.verdict
```

### 8.1 为什么不继续使用 `outputs.<port>.to`

**Why**：内联 route 把“节点接口”和“当前工作流拓扑”耦合在一起：

- 想查看所有边必须遍历每个 node；
- 一条 output 连多个目标时格式会变化；
- port contract 和 route 配置混在同一对象；
- reverse edge、diff、可视化和未来 Graph Patch 都更复杂；
- 同时支持 inline 与 top-level edge 会形成两个真相来源。

**How**：v1 node 只声明 port；所有连接在 `spec.edges`。Legacy adapter 把现有
`outputs.to` 降低为 canonical edge，用户旧 YAML 不需要立刻迁移。

### 8.2 数据边隐含完成依赖

普通数据 edge 表示：目标 node 必须等来源 node 完成并成功把 payload 送达后才能 ready。

**Why**：当前作者通常需要同时写：

```yaml
after: [plan]
outputs:
  planned:
    to: implement.in:plan
```

两处信息表达同一个常见依赖，容易漏写或写出矛盾。

**How**：compiler 从普通数据 edge 自动生成 runtime completion dependency。只有
“等待某节点完成但不接收数据”的情况才使用：

```yaml
depends_on: [audit]
```

### 8.3 Fan-out、Fan-in 与 Loop

- 一个 output port 可通过多条 edge fan-out；
- fan-in 必须进入显式 `join` node，不能靠 mailbox 数量猜测；
- 普通 edge 必须保持无环；
- 反馈 edge 只允许连接到 `foreach` 或 `while`，并声明静态 traversal 上限；
- compiler 把反馈 edge 与普通 edge 分开验证。

未来动态图仍复用同一种 canonical edge，不修改 WorkflowSpec 源文件。

## 9. Terminal Node

推荐用显式 terminal node 替代 `to: ""`：

```yaml
nodes:
  success:
    kind: terminal
    outcome: success
    inputs:
      result:
        contract: VerificationVerdict

  review_required:
    kind: terminal
    outcome: failure
    reason: review_required
```

### 9.1 Why

空字符串只能表示“没有目标”，无法表达：

- 这是成功、业务失败、取消还是等待人工；
- 哪个 payload 是最终证据；
- 多个终点中哪个决定 run outcome；
- 可视化和 API 应显示什么终态；
- 动态 patch 是否允许在该终点后追加节点。

### 9.2 How

- terminal 是不可调度、不调用模型的确定性 node；
- 它只能有 inputs，不能有 outputs；
- `outcome` 首版限定为 `success | failure | cancelled`；
- run outcome 由实际到达的 terminal 决定；
- 多 terminal 到达规则必须由 compiler 证明互斥，或定义明确的 outcome precedence；
- `waiting_for_approval` 不伪装成 terminal，它属于未来可暂停 node kind。

Legacy adapter 将 `to: ""` 映射为合成 terminal node，并根据来源 port 与 failure condition
推导 outcome；无法可靠推导时产生迁移 warning，但保持当前运行行为。

## 10. Gateway 语义

Gateway 是确定性控制节点，不调用模型。

### 10.1 Condition

```yaml
signal_gate:
  kind: condition
  input: signal
  config:
    field: status
    routes:
      actionable: actionable
      quiet: quiet
    default: quiet
```

不引入任意表达式，只读取已验证 payload 的受限 dotted field，并按精确值路由。

### 10.2 Join

```yaml
quorum:
  kind: join
  config:
    mode: n_of_m
    field: vote
    success_values: [act]
    threshold: 2
```

Join 明确声明等待集合、成功规则和输出 contract。首版保持当前“等待全部声明上游”的
行为；early completion/cancellation 属于后续 Pattern Runtime 能力。

### 10.3 Foreach

Foreach 对一个有限数组逐项执行，并聚合有序结果。输入数组和单项结果都必须有
contract；最大 item 数量受 workflow policy 限制。

### 10.4 While

While 只比较当前受控字段，必须声明 `max_iterations`。每次反馈 edge 也有独立 traversal
limit，避免 run-wide limit 成为唯一保险。

## 11. 完整示例

下面展示推荐语义，不代表字段名已经最终冻结：

```yaml
api_version: homerail.ai/v1
kind: Workflow

metadata:
  id: bounded-review
  name: Bounded Review

spec:
  description: Execute one task and independently verify it.
  workspace:
    mode: isolated

  contracts:
    Task:
      type: object
      additionalProperties: false
      required: [objective]
      properties:
        objective:
          type: string

    Result:
      type: object
      additionalProperties: false
      required: [status, evidence]
      properties:
        status:
          enum: [success, failure]
        evidence:
          type: array
          items:
            type: string

    Verdict:
      type: object
      additionalProperties: false
      required: [verdict, evidence]
      properties:
        verdict:
          enum: [pass, fail]
        evidence:
          type: array
          items:
            type: string

  agents:
    worker:
      system: Execute only the supplied objective and return evidence.
    verifier:
      system: Independently verify the result against the objective.

  nodes:
    execute:
      kind: agent
      agent: worker
      inputs:
        task: { contract: Task }
      outputs:
        result: { contract: Result }

    verify:
      kind: agent
      agent: verifier
      inputs:
        result: { contract: Result }
      outputs:
        verdict: { contract: Verdict }

    verdict_gate:
      kind: condition
      inputs:
        verdict: { contract: Verdict }
      outputs:
        passed: { contract: Verdict }
        failed: { contract: Verdict }
      config:
        field: verdict
        routes:
          pass: passed
          fail: failed
        default: failed

    done:
      kind: terminal
      outcome: success
      inputs:
        result: { contract: Verdict }

    review_required:
      kind: terminal
      outcome: failure
      reason: independent_verification_failed
      inputs:
        result: { contract: Verdict }

  edges:
    - from: execute.result
      to: verify.result
    - from: verify.verdict
      to: verdict_gate.verdict
    - from: verdict_gate.passed
      to: done.result
    - from: verdict_gate.failed
      to: review_required.result
```

运行时 task 如何进入 entry node 仍需最终设计：推荐把 run input 作为保留 source
`$run.input`，而不是创建虚假的 agent node。例如：

```yaml
edges:
  - from: $run.input
    to: execute.task
```

这项需要在 Schema 冻结前确认。

## 12. 编译器

WorkflowSpec compiler 是 DSL 的真正语义边界。

### 12.1 编译阶段

```text
1. Safe parse
2. Detect api_version and kind
3. Structural schema validation
4. Source normalization
5. Port and contract resolution
6. Edge lowering and dependency derivation
7. Semantic graph validation
8. Policy validation
9. Canonical ordering and serialization
10. canonical hash
```

### 12.2 Why

如果 parser、validator、runtime 各自理解一部分 YAML 语义，任何新增字段都需要在多个
地方同步修改，legacy alias 也会泄漏到运行时。

### 12.3 How

- v1 compiler 只接受严格 WorkflowSpec；
- legacy adapter 先把 v0 转成内部 source model，再复用后半段 compiler；
- runtime 只接收 CanonicalWorkflowIR；
- compiler output 是纯数据，可 snapshot、hash、diff 和缓存；
- compiler version 写入 revision 和 run metadata；
- CI 用 approved fixtures 证明相同输入始终得到相同 IR。

## 13. CanonicalWorkflowIR

Canonical IR 不是用户编辑格式。它必须：

- 不包含 YAML shorthand、anchor、注释和 key-order 差异；
- materialize 所有默认值；
- node 和 edge 使用结构化引用；
- map-derived collection 按稳定规则排序；
- 包含 derived entry、terminal、dependency 和 feedback metadata；
- 不包含 node status、mailbox、counter、worker id 或 secret；
- 能通过确定性 JSON serialization 计算 canonical hash。

```ts
interface CanonicalWorkflowIR {
  ir_version: "1";
  workflow_id: string;
  name: string;
  agents: Record<string, CanonicalAgentSpec>;
  contracts: Record<string, CanonicalContract>;
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
  entry_nodes: string[];
  terminal_nodes: string[];
  feedback_edges: string[];
  source_api_version: "homerail.ai/v1" | "legacy/v0";
  compiler_version: string;
}
```

现有 `ParsedDAG` 可以演化为 canonical IR，也可以成为它的 runtime projection；最终只应
保留一个 authoritative graph representation。

## 14. Workflow Revision 与数据库

### 14.1 数据模型

```text
dag_workflows
  workflow_id
  head_revision
  created_at
  updated_at

dag_workflow_revisions
  workflow_id
  revision
  api_version
  source_format
  source_text
  source_hash
  canonical_json
  canonical_hash
  compiler_version
  created_at

dag_workflow_sync_events
  workflow_id
  submitted_source_hash
  resulting_revision
  actor
  created_at
```

### 14.2 Why

当前 upsert 会替换同一 `workflow_id` 的 YAML。虽然运行元数据保存图状态，但无法从
workflow catalog 明确回答“当时同步的是第几版、后来为什么变化”。

### 14.3 How

- 首次 sync 创建 revision 1；
- canonical hash 改变时原子创建 N+1，并更新 head；
- canonical hash 相同的格式变化不创建 semantic revision；
- 每次提交都写 sync event；
- run creation 固定读取某个 revision，生成 immutable RunPlan；
- run metadata 写入 workflow id、revision、canonical hash、compiler version；
- 后续 sync 不改变 active 或 historical run。

## 15. RuntimeProfile

RuntimeProfile 继续与 WorkflowSpec 分离。

```text
WorkflowSpec: verifier 是什么角色、有哪些 port、位于图中哪里
RuntimeProfile: verifier 使用哪个 llm_setting_id 和 agent_type
```

### Why

- 模型可用性和账号配置比 workflow 生命周期短；
- workflow 需要可移植、可分享；
- secret 必须留在 Manager encrypted store；
- 同一 revision 应能在不同 profile 下运行。

### How

- compiler 检查所有逻辑 agent role 都存在；
- run creation 绑定 profile 并生成 RunPlan；
- profile 只引用数据库 setting id 或 alias；
- WorkflowSpec Schema 拒绝 provider/model/key/url；
- strict RuntimeProfile v1 另开后续范围，不阻塞 WorkflowSpec v1。

## 16. Legacy YAML 兼容

### 16.1 兼容目标

所有当前可运行 YAML 必须继续运行，包括：

- flat root；
- `outputs.<port>.to`；
- `after`；
- `to: ""`；
- `type` / `node_type` alias；
- `gateway` / `gateway_config` alias；
- condition、loop、join、while 当前行为；
- runtime profile、pattern metadata 和 scorecard。

### 16.2 实现方式

```text
legacy YAML
    |
    v
LegacyParser v0
    |
    v
LegacyLoweringAdapter
    |
    v
CanonicalWorkflowIR v1
```

- 旧 source 不自动改写；
- legacy compiler 有 characterization tests；
- 新功能不继续加入 legacy alias；
- 新建 pattern/example 最终改为输出 v1；
- 未来可提供 `hr dag migrate` 生成供人工 review 的 v1 YAML；
- legacy 与等价 v1 必须有 transition parity test。

## 17. Schema 与 API

Manager 提供：

```text
GET /api/dag/schema
```

响应至少包含：

```json
{
  "api_version": "homerail.ai/v1",
  "kind": "Workflow",
  "schema": {},
  "schema_hash": "sha256:...",
  "compiler_version": "1"
}
```

### Why

CLI、Manager Agent 和其他 AI 不能依赖过时文档猜字段。Schema endpoint 必须返回
Manager 当前真正用于验证的同一份 Schema。

### How

- 一个 typed schema definition 同时产生运行时 validator、TypeScript type 和 JSON Schema；
- CI 比较导出 artifact，防止漂移；
- endpoint 支持 ETag/schema hash；
- schema 内容不包含已配置 provider 或 secret；
- CLI 可通过本地 bundled schema 离线验证，并显示 Manager schema version 是否兼容。

具体使用哪个 schema library 在实现前根据现有依赖和输出质量评估，不在概要中提前锁死。

## 18. 诊断模型

每个错误包含：

```json
{
  "code": "DAG_SCHEMA_UNKNOWN_FIELD",
  "path": "spec.nodes.review.gatway_config",
  "line": 24,
  "column": 7,
  "message": "unknown field 'gatway_config'",
  "hint": "did you mean 'gateway_config'?"
}
```

错误分层：

1. parse error；
2. schema error；
3. reference/contract error；
4. graph semantic error；
5. policy error；
6. runtime contract violation。

CLI 文本输出和 API JSON 输出使用同一 diagnostic model。Compiler 在安全情况下聚合
多个独立错误，避免 AI 每次只修一个 typo 后反复 sync。

## 19. 安全边界

- 禁止自定义 YAML tag 和不安全对象构造；
- 不执行 DSL 中的任意表达式或脚本；
- 对文档大小、node 数、edge 数、contract 深度和字符串长度设限；
- 所有 loop/retry/feedback 有静态上限；
- workflow 不含 provider credential；
- source hash 与 canonical hash 使用明确编码和确定性序列化；
- compiler 不访问网络、不启动 worker、不执行用户命令；
- sync 先完整 validate/compile，再在数据库事务中提交 revision。

## 20. 与六项 Pattern Runtime 缺口的关系

WorkflowSpec v1 基础 PR 没有实现六项能力；后续 runtime-primitives 实现状态如下：

| 后续能力 | 当前实现 |
| --- | --- |
| Executor-Advisor | agent `advisors` + 同 turn `consult_advisor` + 独立 runtime binding 和审计 |
| Deterministic check/rollback | `command` node + allowlist + timeout + typed output + compensation route |
| Human Approval | `approval` node + `WAITING_FOR_APPROVAL` + proposal hash + actor + 冷恢复 |
| Artifact ownership | `workspace_access` + 延迟 handoff + 文件快照/只读/写路径校验 |
| Durable state/triggers | versioned state/history + interval/event trigger + 幂等和 overlap policy |
| Dynamic fan-out/heterogeneous roles | run-local bounded `fanout` + early cancel + per-agent profile binding |

这些能力没有通过 prompt 偷渡；每项均进入 Schema、compiler、IR、persistence/runtime
和测试。任意 Graph Patch 仍需单独协议。

## 21. 未来 Dynamic Graph Patch

动态图不修改已入库 WorkflowSpec。一次 run 从 immutable RunPlan revision 0 开始，未来
通过独立协议追加受审计 patch：

```json
{
  "operation": "add_node",
  "base_revision": 4,
  "idempotency_key": "plan-item-3",
  "actor": "orchestrator",
  "reason": "planner produced a third independent task",
  "node": {}
}
```

Graph Patch 的核心规则将在独立设计中确定：

- optimistic concurrency；
- idempotency；
- completed/traversed region 保护；
- patch 后完整图校验；
- graph revision、snapshot 和 replay；
- actor capability 与预算限制；
- add/remove/replace 操作边界。

WorkflowSpec v1 现在只需保证 canonical node/edge 可复用、RunPlan 有 revision、运行图可
序列化。不能为了“以后可能动态”把 patch 语义提前混进静态 DSL。

## 22. 实施顺序

推荐按以下顺序实现，而不是一次大改：

1. **冻结 legacy 行为**：为全部现有资产建立 characterization tests。
2. **Schema 与 diagnostics**：先能严格解释 v1，暂不接 runtime。
3. **Canonical IR/compiler**：v1 与 legacy 都编译到同一 IR。
4. **Runtime 迁移**：executor、recovery、scorecard 消费 canonical IR。
5. **Revision persistence**：迁移数据库并绑定 run provenance。
6. **Schema API/CLI/Manager Agent**：公开真实契约。
7. **迁移 built-in patterns/examples**：用等价与 live tests 证明无回归。

每一步都必须保持 legacy DAG 可运行。Dynamic Graph Patch 只有在以上全部稳定后才开始。

## 23. 验收标准

WorkflowSpec v1 只有同时满足以下条件才算完成：

- strict v1 unknown field test 通过；
- YAML/JSON 等价 source 产生相同 IR/hash；
- 所有 node/gateway kind 有 Schema 和 exhaustiveness test；
- handoff contract 在编译期解析、运行时执行；
- legacy 全资产与等价 v1 transition parity 通过；
- 数据库 migration 不丢 workflow/profile；
- semantic update 创建 revision，格式变化不创建 semantic revision；
- run cold recovery/replay 保留 revision/hash/compiler；
- `/api/dag/schema` 与内部 validator 是同一 Schema；
- CLI 和 Manager Agent 能获得结构化 diagnostics；
- Linux、Windows、Docker、public smoke 和 live pattern CI 全绿；
- 没有 Graph Patch 或新增 pattern runtime 能力混入首版。

## 24. 已确认的 v1 决策

以下决策已于 2026-07-11 确认并进入增量实现：

1. 使用 `api_version / kind / metadata / spec` envelope；
2. v1 只使用顶层显式 `edges`；
3. 普通数据 edge 隐含完成依赖，`depends_on` 只做控制屏障；
4. 使用显式 terminal node，淘汰空字符串终点；
5. handoff 两端引用同一命名 JSON Schema contract；
6. typed schema definition 是 validator、TypeScript type、JSON Schema 的单一来源；
7. RuntimeProfile v1 独立后续实现；
8. 格式变化只写 sync audit，不增加 semantic revision；
9. run input 使用保留 source `$run.input`；
10. v1 node kind 名称采用 `agent / condition / join / foreach / while / terminal`。

这些条目是 WorkflowSpec v1 的实现边界。若后续要改变 envelope、edge、terminal、contract
或 revision 语义，应重新进入设计评审，而不是在 parser 中增加隐式 alias。
