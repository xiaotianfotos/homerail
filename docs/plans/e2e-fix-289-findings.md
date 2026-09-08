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
| [#291](https://github.com/xiaotianfotos/homerail/issues/291) | Docker 镜像精确 ID / RepoDigest 选择 | 真实候选通过行为和仓库测试；尚无验收 PR | 保留兼容行为及九项回归；修复正确性不能代替完整审查、发布与同 head CI。 |
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
  正确，提示可能误导。待将提交应答描述改为“已提交，待 Manager 验证”，并核对
  工具错误语义；不能把传输提交当作业务接受。
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
