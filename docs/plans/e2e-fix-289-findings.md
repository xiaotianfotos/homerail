# E2E Fix：统一问题清单

唯一汇总 issue：[#289](https://github.com/xiaotianfotos/homerail/issues/289)。
实施分支：`codex/e2e-fix-289`；相关实现和修复集中交付一个 PR。
完整目标、阶段和验收矩阵见 [实施计划](e2e-fix-289.md)。

## 跟踪规则（2026-09-09）

按维护者要求，本轮 AutoFix / E2E 排查发现的问题在本文件记录，不再逐项创建
GitHub issue。下面 16 个旧 issue 统一归入 #289 并关闭；这是跟踪方式调整，
**不代表每项已修复或验收通过**。旧 issue 的正文、讨论及证据链接仍保留，
原始正文也已归档到实验目录 `issue-consolidation/<number>.json`。
新增发现使用本地编号，记录复现、原因、修复与验证状态；在同一个实现 PR 中解决。
已有外部真实问题 #245 保持独立，冻结演练输入不因跟踪 issue 关闭而改变。

## 归并清单

“分支已修正”只描述当前实现，不表示已经合入主分支或完成真实 E2E 验收。

| 原 issue | 问题 | 当前证据状态 | 保留的验收要求 / 待办 |
| --- | --- | --- | --- |
| [#269](https://github.com/xiaotianfotos/homerail/issues/269) | 可信测试、持久续跑与发布对账 | 已实现部分原生阶段；总体验收未完成 | 继续覆盖 intent/执行/ack、并发与旧租约、篡改、GitHub 应答丢失；保留最佳候选、预算及全部历史。 |
| [#271](https://github.com/xiaotianfotos/homerail/issues/271) | 供应商请求归属与 token 完整性 | 仍需核对完整验收范围 | 请求关联 run/dispatch/turn；记录首 token、取消和最终 usage；区分 unknown/partial/final，验证终态后无多余推理、迟到与重复累计量不重计缓存输入。 |
| [#273](https://github.com/xiaotianfotos/homerail/issues/273) | 审查模型来源与多样性政策 | 仍需核对完整验收范围 | 报告程序解析的实际 provider/model/backend；区分独立采样与不同模型；按冻结政策验证别名、重复设置、设置变化及降级审查。 |
| [#290](https://github.com/xiaotianfotos/homerail/issues/290) | 快照文件权限受继承 ACL 影响 | 分支已修正并有回归 | 发布前归一化并核对权限；不能仅凭文件创建 mode 判断真实权限。 |
| [#291](https://github.com/xiaotianfotos/homerail/issues/291) | Docker 镜像精确 ID / RepoDigest 选择 | PR #304 已通过原生 E2E 独立验收；未合并 | 保留兼容行为及九项回归；修复正确性不能代替完整审查、发布与同 head CI。 |
| [#292](https://github.com/xiaotianfotos/homerail/issues/292) | 首次 Worker 派发前配置失败浪费 Planner | 已实现预检和严格恢复边界 | 只接受证据证明尚未派发的检查点；保留原预算、截止时间、计划与完成回执；不能用于已执行的模型失败。 |
| [#293](https://github.com/xiaotianfotos/homerail/issues/293) | HTTP 测试 fixture 丢失服务引用 | 分支已修正 | 参数化 fixture 跟踪并关闭每个已启动实例，验证调度器不会在 teardown 后继续运行。 |
| [#294](https://github.com/xiaotianfotos/homerail/issues/294) | 持久命令测试先于执行截止时间超时 | 分支已修正并有回归 | 等待覆盖执行 deadline 加有界观察开销；保留 1.1 秒合法执行、非法 JSON、退出码和唯一终态通知断言。 |
| [#295](https://github.com/xiaotianfotos/homerail/issues/295) | 输出截断后重复无效 handoff 纠正 | 已实现拒绝无证据的相同重试；模型收敛仍有限 | 同时覆盖 Worker/Node 传输和纠正预算边界；下一步必须改变批准的修复策略，保留成本；不能用停止重试宣称收敛。 |
| [#296](https://github.com/xiaotianfotos/homerail/issues/296) | 宿主 Codex schema、子进程与失败生命周期 | 分支已修正并有回归 | 严格 nullable schema；finally 清理子进程；失败命令进入原生终态并触发异常观察。 |
| [#297](https://github.com/xiaotianfotos/homerail/issues/297) | 单文件多段精确修改 | 分支已实现并有原生候选测试 | 验证不重叠的精确片段、身份与范围，拒绝含糊匹配。 |
| [#298](https://github.com/xiaotianfotos/homerail/issues/298) | 审查汇总超出上下文上限 | 已实现去重、源码 diff 投影及受限汇总恢复 | 保留全部 finding/原始报告/证据引用；真正超限仍拒绝；恢复不重跑 Fixer/测试，不重置预算。 |
| [#300](https://github.com/xiaotianfotos/homerail/issues/300) | 返修策略丢失及已驳回意见重复输入 | 分支已修正并有回归 | 所有返修分支保留 retry_strategy；只移除有完整有效证据的驳回项，历史报告不变。 |
| [#301](https://github.com/xiaotianfotos/homerail/issues/301) | 可选宿主 Fixer 与迭代异常观察 | 实现并取得真实宿主候选与测试证据 | 冻结 host_codex.fixer；观察使用真实 cycle 迭代；失败与未知执行不重发；尚需真实发布验收。 |
| [#302](https://github.com/xiaotianfotos/homerail/issues/302) | 只读测试 sandbox 与 Vitest loader 不兼容 | 具体 fixture 使用 native loader 已验证；通用机制未实现 | 需设计验收 harness 预检与受控策略修复；保留已验证候选，不修改旧失败回执冒充原测试成功。 |
| [#303](https://github.com/xiaotianfotos/homerail/issues/303) | approve 同时附 findings 的无效审查 | 新工作流已通过真实 Qwen 原生纠正验证 | 最多一次契约纠正；失败不得凑票。旧工作流已接受报告的迁移仍未实现，不能套用新 schema 宣称旧报告有效。 |

## 新增本地发现

- **L017：handoff 提示早于 Manager 接受。** 真实 Qwen 契约纠正演练中，Worker 对
  首次无效交接返回“交接成功”，随后 Manager 才以 schema 错误拒绝。当前接受账本
  正确，提示可能误导。修复方案已明确：改为“交接内容已记录，等待 Manager 校验。”，
  描述 Worker 本地暂存、由 PromptRunner 随后传输的阶段，保留参数错误语义。
  待当前演练结束再应用，避免运行中修改源码导致 Worker 指纹与镜像不一致。
- **L018：全任务 token 硬预算。** 已保存后端报告用量和未知项，但字节、轮次及
  时间上限不等于供应商 token 硬限制。需明确预留/准入与最终计费之间的边界。

## 最近验证与整体缺口

源码 `1eb3e04b95804c1fc5c9a0eefd50a2627e6b7dc9` 的完整本地 CI 已通过，
可信完成事件为 `904ebacc3a577a705cb39f3f1c9652a3882e56b95664533e59364759b7937c71`。
开始/结束 head 一致，runner 回执和原始日志摘要已复核。这不是远端 PR CI 验收。

原生单 Reviewer 故障注入 `issue291-review-contract-proof-1` 已验证：第一次输出
批准票加正面 findings 被 Manager 拒绝；原生纠正驱动第二次新进程调用，得到
合法批准票，保留正面说明。两次调用共报告输入 37425、输出 1186 token。
逻辑会话身份保留，DSH 进程/模型上下文重建；没有重复 Fixer、测试或发布。
该诊断只证明契约纠正，不能算真实 issue 修复或 PR 成功。

真实 #291 第三次宿主演练已产生通过两类可信测试的候选，但旧契约下三份审查
均存在 approve + findings 冲突，汇总还超过上下文上限。离线证据投影已从
71740 降为 33099 字节，全部 21 条 findings 保留；没有据此伪造原生恢复成功。
旧检查点修复/迁移须单独验证，不能重置原截止时间或重复已有模型结果。

整体目标仍未完成：两个不同真实问题的端到端交付、真实负反馈修正、创建并更新
同一 PR、最终同 head 必需 CI 全绿及至少两票独立完整批准，均须按实施计划
取得可审计证据。无效审查、人工辅助恢复和模拟 GitHub 结果不能计为这些成功。

## 输出额度调整（维护者要求）

后续本地 Qwen 执行至少预留 **65536 输出 token**。原 8192 限额来自实验
Worker 镜像环境变量；旧实验结果只证明该额度下发生截断，不能据此判定模型
无法完成复杂修复。历史任务、失败及成本保持原样，新的实验使用新的冻结配置。

已配置新的实验镜像并切换隔离 Manager，Node 保留、健康检查通过。实例化的
Worker 适配器读取到 65536；服务端接受 `max_completion_tokens: 65536` 的
简短真实请求（HTTP 200，报告输入 53、输出 41 token）。服务声明上下文
262144 token，当前适配器上下文描述为 200000，后续需在该边界内预留输入、
历史工具记录与输出。输出 token 额度和 artifact 字节上限分别核对，避免转而
被序列化大小或执行超时截断。该准备检查不证明已生成 64K 内容或修复已经收敛。

### 64K 真实修复演练已启动

根任务 `issue291-e2e-qwen64-4` 使用 Qwen Fixer/Reviewer 与 Codex Planner/Judger，
沿用原问题及两项可信测试。此前 Qwen 的已验证源码补丁作为输入保留；新模型
需要完成仓库回归测试，旧候选/测试/审查不能冒充新执行证据。原生 Planner 已完成，
Fixer 已派发；实际 Worker 镜像和适配器事件均确认输出额度为 65536。
新工作流使用已验证的审查契约纠正与上下文投影。程序监督仅在异常/完成时通知。
目前仅证明新额度进入真实执行，尚未取得本次候选、审查或 PR/CI 成功证据。

### 64K 首轮候选与可信测试证据

首轮 Qwen 完成三处修改：两处既有源码精确替换，以及新建约 11KB 回归测试。
后端报告输入 13548、输出 10186 token（单个 execution），输出实际超过旧 8192
额度。可信程序形成候选 `3172543977edb016ba09c6d9f526ead525251433`，独立行为
检查九项通过，候选内 Vitest 回归十项通过；已核对候选 Git 身份、计划、回执与
原始日志摘要。该结果证明此配置能够产生完整待审候选，纠正此前基于 8K 失败
过早推断模型能力的结论。修复质量、审查及最终 PR/CI 验收仍以剩余原生阶段为准。

### 原生真实发布与第二项演练

第一项 64K 演练已得到三份有效审查和原生 Codex 候选裁决，可信发布阶段创建了
[PR #304](https://github.com/xiaotianfotos/homerail/pull/304)，head 与上述候选一致。
CI 由图内阶段派发并观察，run 为 `34289031107`；最终 CI 验收仍待结果。
原始 GitHub 观察摘要、宿主裁决的原生命令及模型事件来源已独立复核。

第二项真实问题 #245 的完整仓库测试环境已预检：基线 19 项通过；旧的只改源码
候选有 18 项通过、1 项因 `initialized` 调用序列的旧断言失败。该预检不消耗
模型调用，证明测试环境可运行且能识别真实不一致。已将完整仓库测试加入必需
检查，启动 `issue245-e2e-qwen64-5`，Codex 方案完成，Qwen 以 65536 输出额度
执行。两项任务分别保留旧结果和成本，均不把启动或 PR 创建当作 E2E 完成。

### 首个真实原生 E2E 验收通过（#291 → PR #304）

`issue291-e2e-qwen64-4` 已自行完成单个根 DAG：Codex 方案、Qwen 修复、
可信测试、三个独立 Qwen 审查会话、Codex 裁决、真实发布及最终 CI。
独立只读核验重建验收门禁，核对全部原生命令、会话派发、测试回执、Git 候选、
原始 GitHub checkout 日志及当前远端 head。候选仍为
`3172543977edb016ba09c6d9f526ead525251433`，PR #304，CI run `34289031107`
的 Linux 20/24、Windows 24、UI coverage、Docker smoke 五项必需检查均成功，
三票有效批准。原生完成事件 `98b3190baecaccff2c424800add7a0f8db192dd5e061226446d90553516d9c85`
与独立审计持久保存；未重跑模型、测试或发布，未合并 PR。

这是预先提供修复方向与既有源码补丁输入后的首轮成功，三名 Reviewer 使用相同
Qwen 模型、独立会话；不代表模型多样性，也不证明任意问题都会收敛。
本轮没有候选返修或 CI 失败，真实同 PR 的 CI 失败→修改→再验收仍待证明。
第二项 `issue245-e2e-qwen64-5` 已由 Qwen 产出候选
`385821985b62f40487595a955c376b03264c0feb`，独立初始化检查及完整仓库测试
24 项通过，原生发布 PR #305，正在等待 CI。Fixer 报告输出 24105 token，
未再受旧 8K 上限截断。整体 #289 目标仍未完成。

### 成本清单与新增证据缺口

新增只读 `scripts/e2e-fix-report.mjs`，使用方式见
[成本与尝试记录](../e2e-fix-report.md)。按执行去重累计快照，缓存输入不再次
加入总量；保留失败 Host 日志及 Worker 失败投影中的已知成本，未知用量与耗时
保留为空/不完整。根任务副本不能重复计数，报告不宣称账单完整或 E2E 验收通过。

已读取九个不同历史根任务，保留全部报告而非只选成功样本。另一个同 root 的
初始配置目录没有执行轮次，未与后来的实际执行目录重复累计，原目录仍保留。
#291 第四次演练已保存图内调用报告输入 126833、输出 14452，总计 141285 token；
其中 Qwen Fixer/Reviewer 输入 69504、输出 13791，Host Codex 输入 57329、
输出 661。这不包含外部规划对话、诊断调用及任何尚未发现的丢失记录，不能作为
整体成本或与不同旧验收配置进行严格统计对照。脚本契约 218 项通过；增加累计
计数倒退和溢出反例后，报告专属五项再次通过。运行时源码未改，无需重复原 DAG。

- **L019：Worker 模型来源回执不完整。** 真实 Fixer/Reviewer 的 ModelEvidence
  中 `model:null`，原因是当前实现读取图中的 `agent.model`，而实际运行由数据库
  setting 解析。不能查询当前可变 setting 然后伪装历史执行身份，也不能因此宣称
  模型多样性。待补：派发时持久化不含凭证的实际 backend/provider/model 与
  session/execution 绑定，角色证据引用该快照；覆盖别名、设置变化、缺失和冲突。
  当前报告如实保留 null，既有单模型演练的配置证据另存，不重写旧角色回执。
