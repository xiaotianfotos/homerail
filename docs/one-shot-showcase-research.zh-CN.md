# HomeRail One-shot Showcase 研究

状态：首轮基线（2026-07-19）

## 目标

找出一句提示就能在 HomeRail 主画布稳定生成以下两类展示的写法：

1. 一个沉浸式 `3×2` HTML Artifact；
2. 三个可独立更新的 Actor / A2UI Block。

“好看”不是唯一验收条件。一次成功还必须满足：本轮真正挂到画布、内容有证据、布局数量确定、后续更新复用稳定 id、1920×1080 下不溢出，并且交互式 Artifact 可以在卡片内部滚动。

## 首轮结论

- **需要一张强视觉总览时，用 Manager-owned HTML Artifact。** 六个部分属于同一主题时，生成一个根级 `HrArtifact`，内部排成 `3×2`，比强行创建六个顶层 Block 更连贯，也更容易形成截图级画面。
- **需要三个结果并行推进、单独纠正或持续更新时，用 supervised DAG。** 三个 Actor 必须职责互斥、共享同一来源身份，并拥有稳定 Surface；不能把同一份报告装饰性地拆成三块。
- **需要原生 HomeRail 风格和高可靠结构时，用 A2UI。** HTML Artifact 适合自由视觉表达；指标、状态、证据和可更新的运行面板优先使用受控组件目录。
- **一句提示必须写明完成条件。** 当前基线提示成功发布了 HTML，但第一轮没有把 `HrArtifact` 挂到画布，直到用户追问才补做。可靠提示必须明确：`publish_artifact` 和 `upsert_generated_view` 都成功后才能宣告完成。

这和外部成熟方案的共同方向一致：Vercel 的 Generative UI 把真实 Tool 结果连接到组件；Google A2UI 强调由宿主目录控制样式、以可更新的声明式数据传递 UI；Anthropic 把 Artifact 定位为自包含、可迭代和可复用的成果；OpenAI 的 Apps SDK 示例强调紧凑卡片、设计令牌和清晰单一价值。参考：[Vercel AI SDK](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)、[Google A2UI](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/)、[Anthropic Artifacts](https://www.anthropic.com/news/artifacts)、[OpenAI Apps SDK UI](https://github.com/openai/apps-sdk-ui)、[OpenAI Apps SDK examples](https://github.com/openai/openai-apps-sdk-examples)。

## 一句话的稳定结构

一条可复现的 showcase 提示应同时写出六件事：

1. **对象**：研究哪个项目、版本或问题；
2. **证据**：允许读取哪些真实来源，禁止编造什么；
3. **拓扑**：一个 `3×2` Artifact，还是三个独立 Surface；
4. **视觉语法**：每格承担什么信息，避免六格重复；
5. **生命周期**：稳定 id、是否持续更新、是否保留 follow-up；
6. **提交门槛**：哪些 Tool 调用成功后才算完成。

## 候选提示

### A. 产品自展示：内置 DAG 图鉴（Manager / 3×2 Artifact）

当前首选，主题天然适合六格，也能直接展示 HomeRail 自身能力。

> 研究 HomeRail 当前版本里真正存在的内置 DAG 模式，生成并发布一个可滚动的单页 HTML Artifact，在主画布用 3×2 六张差异化卡片展示六个最有代表性的模式，每张只放模式名、控制流、适用场景和一个边界条件，整体采用克制的深色技术图鉴风格且禁止编造；必须在本轮先成功调用 `publish_artifact`，再用根级 HTML `HrArtifact`、稳定 id 和 `canvas_size: 3x3` 调用 `upsert_generated_view` 挂到主画布，两个结果都成功后才能回复完成。

### B. 仓库 X 光片（Manager / 3×2 Artifact）

更适合公开 demo：有故事、有数据，也能观察 Agent 是否真的读了仓库。

> 读取当前仓库的 README、核心目录、最近 20 条提交和测试脚本，生成并发布一张“项目 X 光片”可滚动单页 HTML Artifact，用 3×2 六张视觉不同但风格统一的卡片分别呈现产品定位、系统架构、关键工作流、质量证据、当前风险和下一步机会，每张只写一条结论与最多两条可核实证据并标明来源，禁止猜测；本轮必须完成 `publish_artifact`，再以根级 HTML `HrArtifact`、稳定 id 和 `canvas_size: 3x3` 挂到主画布，两个调用都成功后才总结。

### C. 三块决策台（Manager / 3 个原生 Block）

用于验证 Manager 是否能正确判断“彼此独立有用”，而不是装饰性拆分。

> 读取当前仓库同一 revision，把发布前判断做成三个可独立复用的主画布 Block：①“架构地图”使用 `2x2` 与 `HrDag` 展示关键模块和调用关系，②“交付健康”使用 `1x2` 展示测试、变更和风险指标，③“下一步决策”使用 `1x2` 展示三个优先动作、理由与验证方法；三块使用不同稳定 id、共享同一 source revision、只写可核实事实，并且三个 `upsert_generated_view` 都返回 committed 后才回复完成。

### D. 发布情报会（Supervised DAG / 3 个 Live Surface）

最适合体现 DAG 的持续更新和 follow-up，而不是只展示一张静态图。

> 基于当前仓库同一 revision 做一场发布前情报会：启动 supervised three-Actor live report，让 `research` 只盘点可归因事实与缺口，`synthesis` 独立判断发布风险、证据质量和置信度，`visual_story` 只把经核实的结论排成截图级发布简报；三块保持稳定 Surface id，分别完成 `started → partial → final`，共享来源约束，最终停在可继续定向追问的 `await_command` 状态，未启动真实 Workflow 或未完成三块 final 时不得宣告完成。

## 评测方法

每条提示至少跑三次，记录：

| 指标 | 通过条件 |
| --- | --- |
| One-shot 完成 | 无需“没有看到”之类的第二轮补救 |
| 拓扑准确 | Artifact 恰好一块且内部 3×2，或 DAG 恰好三个 Surface |
| 证据可信 | 结论能回指实际文件、提交、测试或 Tool 结果 |
| 视觉差异 | 六格/三块职责与视觉语法不重复 |
| 画布适配 | 1920×1080 无页面级溢出；移动端可降级 |
| Artifact 交互 | 主卡片填满可用高度，iframe 内滚动不带动外层画布 |
| 后续稳定性 | 修改其中一块时复用 id，未修改的兄弟块保持不变 |
| 运行真实性 | DAG 有真实 Actor 生命周期和 handoff，不以提示词伪造并行 |

现有 `agent-ui/scripts/three-worker-showcase-visual.mjs` 已覆盖“三个稳定 `1x2` Surface、1920×1080、移动端和刷新后 id 不漂移”的视觉验收，可直接作为 D 类提示的自动化基线。A/B 类下一步应增加 Manager session 驱动器，自动检查 `publish_artifact → upsert_generated_view` 的完整链路和根级 iframe 的实际高度、滚动位置。
