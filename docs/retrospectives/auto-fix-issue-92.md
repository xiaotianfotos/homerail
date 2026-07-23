# Auto Fix Issue #92 完整复盘

日期：2026-07-23

旧流程事故时间：2026-07-22 16:06 UTC 至 2026-07-23 09:41 UTC

恢复与验收时间：截至 2026-07-23 15:20 UTC

Issue：[#92](https://github.com/xiaotianfotos/homerail/issues/92)

## 一、结论摘要

旧版 Auto Fix 共运行四次，累计消耗 6 小时 24 分 11 秒，却没有发布任何 Draft PR。根因并不只是“模型太慢”或“补丁质量不好”，而是流程把整次 GitHub Action 当成了一笔要么全部成功、要么全部作废的事务：

- 只有所有模型节点和最终收尾节点都成功后，候选修改才会成为可获取的产物；
- 可信 CI 产生的验证失败没有保存，下一次运行无法基于它继续修正；
- 外层 runner 超时退出时，持久 DAG 仍可能继续运行；
- 即使三个初审节点全部批准，流程仍会无条件进入 revision，再做一轮重复审查。

第四次旧流程其实已经生成了一份质量较好的候选修改。它在 revision 前后的补丁字节完全一致，三个初审节点全部批准，独立的聚焦验证也通过。我们没有再让模型重新生成，而是把这份完全相同的候选修改恢复为“与 Issue revision 绑定的 Manager checkpoint”。

随后进行了五次受控的 checkpoint-resume 运行，把工作流缺陷与模型行为逐项分离。它们依次暴露出：

1. 反馈回路拓扑无法同步；
2. 未执行的分支导致 DAG 无法进入终态；
3. 稳定 Manager 重启时，外层 CLI 把瞬时断线当成永久失败；
4. Agent 无法发现真实工作区根目录；
5. 工作流声明了工具调用预算，但运行时没有执行；
6. 正向 checkpoint 下模型仍重复安装依赖、构建和修改 lockfile；
7. 离线验证容器的两个环境问题制造了假阴性。

第五次受控运行是最终的模型验收结果：

- Qwen3.6 负责调查、实现、仲裁和准备发布产物；
- 三个 Qwen3.8 Max 节点并行负责正确性、回归风险和对抗边界审查；
- 约 11 分 10 秒完成；
- 三个审查节点和仲裁节点一致批准；
- 没有进入 revision；
- 最终生成的 21 文件补丁与恢复的候选修改逐字节一致。

随后，这份候选修改在精确 base revision 上通过完整的固定离线 CI，包括真实 Chromium 隔离测试。手工验收运行没有自动发布 Draft PR，也没有合并任何结果。

在 PR 收口阶段还发现了一个独立的 CI 证据问题：手动 CI 虽然接收 `target_ref`，但四个非 Live job 没有使用它，导致一次“看起来验证了 PR、实际 checkout main”的假绿色。该问题已经修复并增加契约测试。最终 CI run 的 `headSha` 与 PR HEAD 完全一致。

## 二、旧流程时间线与恢复证据

| Action run | 耗时 | 最后一个有效阶段 | 结果 |
| --- | ---: | --- | --- |
| [29936533889](https://github.com/xiaotianfotos/homerail/actions/runs/29936533889) | 1:21:45 | 19 个节点完成，仲裁批准 | `finalize_publication` 把明显的测试凭据占位符误判为敏感信息。该假阳性已由 #108 独立修复。 |
| [29978048589](https://github.com/xiaotianfotos/homerail/actions/runs/29978048589) | 1:38:24 | DAG 完成并生成发布产物 | 可信 CI 拒绝了这份 3,432 行候选修改，因为面向浏览器的 protocol barrel 错误导出了仅能在 Node 使用的 `node:crypto`、`node:fs` 和 `node:path`。 |
| [29982395146](https://github.com/xiaotianfotos/homerail/actions/runs/29982395146) | 2:00:34 | 持久 DAG 仍处于活动状态 | runner 已超时，但 DAG 没有停止。只在成功时上传的产物既没有保留候选补丁，也没有保留有用的验证上下文。 |
| [29990777449](https://github.com/xiaotianfotos/homerail/actions/runs/29990777449) | 1:23:28 | 13 个节点完成，重复终审正在运行 | 初始候选已经修复 browser barrel 回归，三个审查者全部批准，但流程仍执行 revision 和第二轮完整审查。发布前手工停止了运行。 |

第二次候选修改共有 3,432 行、137,932 字节，摘要为：

`efcaa2f311730e762452b2408cb7dbaf02e93fbf2547db3880953ffdb81b8cfc`

它的浏览器构建缺陷是可信验证发现的，不是模型审查发现的。这证明模型审查不能替代固定、隔离的完整 CI。

从第四次旧运行恢复的候选修改包含 21 个文件、2,570 行、108,919 字节。revision 前后两次 collection handoff 的补丁字节完全相同，摘要均为：

`14f2c7e5c8d05d57a4926a0e2d918acade2a7aec318283f7322d2a063bc24ca7`

临时导出的补丁文件比标准候选多 1 字节，因为提取命令在末尾又添加了一个换行。因此临时文件摘要不是标准候选摘要。两个 handoff 的原始字节完全一致，证明无条件 revision 消耗了一整个 Agent 回合，却没有改变任何候选内容。

第四次旧运行保留了 13 个已完成 handoff：

- 确定性 checkout；
- 调查与调查 gate；
- 实现与实现 gate；
- candidate-v1 collection；
- 三个初审节点；
- revision 与 revision gate；
- candidate-v2 collection；
- 取消前完成的一个终审节点。

三个初审节点全部投票 `approve`。正确性审查只记录了两个不阻塞的问题：

1. 极少数 Docker 可执行文件异常可能被描述成 CLI 不存在；
2. Manager 侧同步执行 Docker 探测时，可能阻塞事件循环直到探测超时。

两项都不影响 Issue 的验收条件。

这次运行的聊天快照包含 3,104 条模型消息、523 次工具调用和 167 次工具错误。实现节点单独使用了 139 次工具。三个初审节点合计使用 199 次工具并产生 92 次错误；没有完成的重复终审又使用了 83 次工具并产生 70 次错误。审查深度与有效证据并不成正比。

| 旧版 Agent 节点 | 消息数 | 工具调用 | 工具错误 | 完成 handoff |
| --- | ---: | ---: | ---: | ---: |
| implement | 887 | 139 | 2 | 1 |
| review_adversarial_initial | 437 | 80 | 54 | 1 |
| investigate | 399 | 73 | 1 | 1 |
| review_regression_initial | 347 | 60 | 20 | 1 |
| review_correctness_initial | 324 | 59 | 18 | 1 |
| review_correctness_final | 202 | 38 | 27 | 0 |
| revise | 237 | 29 | 2 | 1 |
| review_adversarial_final | 153 | 24 | 23 | 0 |
| review_regression_final | 118 | 21 | 20 | 1 |

## 三、五次受控 checkpoint-resume 运行

五次受控运行都使用同一个不可变的 Issue revision 和恢复出的候选 checkpoint。第 3 至第 5 次运行把实现角色绑定到 Qwen3.6，把三个独立审查角色绑定到 Qwen3.8 Max。

这些是稳定 Manager 上的诊断和验收运行，不是 GitHub 发布运行。

| 运行 | 模型配置 | 结果 | 主要证据 |
| --- | --- | --- | --- |
| 1 | 全部 Qwen3.6 | 模型 dispatch 前被拒绝 | 标准编译通过，但 runtime DAGGraph 投影发现普通环路，因为有界反馈源没有声明它依赖的 `while` gateway。 |
| 2 | 全部 Qwen3.6 | 冷恢复后持久 DAG 完成，但外层 runner 失败 | 一致批准后正确跳过 revision。稳定 Manager 部署修复了卡住的 pending 分支，但等待中的 CLI 因瞬时 `fetch failed` 退出。恢复的候选含 22 个文件，其中包括不需要的根目录 lockfile。 |
| 3 | Qwen3.6 实现，Qwen3.8 Max 审查 | 主动取消 | 审查节点持续尝试无效工作区路径。普通 Manager `inject` 返回已送达，但没有影响当前活动回合，因为 Worker 只有在 interrupt 模式才把 inject 传给活动回合。 |
| 4 | Qwen3.6 实现，Qwen3.8 Max 审查 | 主动取消 | 根目录发现问题已修复，但由此暴露出声明的 80 次工具预算根本没有执行。实现节点对正向 checkpoint 重复安装、构建和测试，并污染了五个 package lockfile。 |
| 5 | Qwen3.6 实现/仲裁，Qwen3.8 Max 审查 | 约 11:10 验收通过 | 三个并行审查节点一致批准，跳过 revision；硬预算迫使 Agent 收敛，同时始终保留 DAG handoff；最终产物与恢复候选完全相同。 |

### 运行 2：业务结果成功，但外层等待失败

运行 `auto-fix-qwen36-issue92-resume-2` 的所有 Agent 角色都使用 Qwen3.6。冷恢复后，19 个节点完成、4 个节点跳过。

稳定 Manager 部署期间，外层 runner 已经因为 `fetch failed` 退出，所以标准产物收集没有执行。但 Manager 的持久证据仍然存在，使手工恢复成为可能。

| Agent 节点 | 消息数 | 工具记录 | 工具错误 |
| --- | ---: | ---: | ---: |
| investigate | 297 | 51 | 0 |
| implement | 255 | 37 | 3 |
| correctness | 147 | 28 | 0 |
| regression | 241 | 44 | 0 |
| adversarial | 249 | 47 | 0 |
| arbitrate | 153 | 26 | 0 |
| publish | 13 | 1 | 0 |

恢复结果包含 22 个文件、109,363 字节补丁，摘要为：

`7dbdccd9ffac5730e72a76e814368503bfde719c1631b6b142251ed72ef9d3c9`

它额外创建了不需要的根目录 `package-lock.json`，因此只能证明工作流已经取得进展，不能作为最终接受候选。

### 运行 3：合法根目录存在，但 Agent 无法发现

运行 `auto-fix-qwen36-qwen38-issue92-resume-3` 最终有 9 个节点完成、4 个取消、10 个跳过。

Claude SDK 从 `/workspace` 启动，而仓库 ACL 只暴露了 `source`。通用工具拒绝信息只说明哪些路径禁止访问，却不告诉 Agent 哪个路径有效，导致审查节点不断猜测根目录。

| Agent 节点 | 消息数 | 工具记录 | 工具错误 | Handoff |
| --- | ---: | ---: | ---: | ---: |
| investigate | 239 | 43 | 3 | 1 |
| implement | 192 | 27 | 0 | 1 |
| correctness | 341 | 68 | 68 | 0 |
| regression | 375 | 62 | 15 | 0 |
| adversarial | 161 | 32 | 31 | 0 |

操作员尝试了普通 Manager `inject`。API 返回“已送达”，但 Worker 通过 `dag_inbox` 消费普通队列输入，只有 `mode=interrupt` 时才会把 inject 应用到正在活动的回合。

因此，操作员看到的是成功确认，但活动审查节点并没有收到能纠正路径的指令。工作区根目录可发现性已经在执行 harness 中修复；普通 inject 的送达语义仍是单独的 P2。

### 运行 4：根目录修好后，暴露了失效的工具预算

运行 `auto-fix-qwen36-qwen38-issue92-resume-4` 证明安全根目录提示有效：

- correctness 从 68 条记录 68 次错误，下降到 83 条记录 0 次错误；
- adversarial 从 32 条记录 31 次错误，下降到 35 条记录 0 次错误。

同时它也证明 `max_tool_calls_per_node: 80` 虽然被解析和持久化，但 Manager 和 Worker 都没有真正执行这一限制。

| Agent 节点 | 消息数 | 工具记录 | 工具错误 | Handoff |
| --- | ---: | ---: | ---: | ---: |
| investigate | 203 | 35 | 2 | 1 |
| implement | 327 | 50 | 1 | 1 |
| correctness | 445 | 83 | 0 | 0 |
| regression | 463 | 81 | 3 | 0 |
| adversarial | 195 | 35 | 0 | 1 |

实现节点还忽略了正向 checkpoint 的提示，重复执行依赖安装、构建和测试，并修改了 Agent UI、CLI、Manager、Plugin SDK 和 Protocol 的 lockfile。

这份结果包含 26 个文件、130,093 字节补丁，因此被拒绝，并恢复标准 checkpoint。

### 运行 5：混合模型最终验收

运行 `auto-fix-qwen36-qwen38-issue92-resume-5`：

- 19 个节点完成；
- 4 个节点跳过；
- 产生 274 个持久事件；
- revision 和 revised-candidate collection 都没有运行；
- 三个 Qwen3.8 Max 审查节点并发运行并全部批准；
- Qwen3.6 仲裁节点批准。

| Agent 节点 / 模型 | 消息数 | 工具记录 | Handoff | 工具错误 |
| --- | ---: | ---: | ---: | ---: |
| investigate / Qwen3.6 | 159 | 27 | 1 | 0 |
| implement / Qwen3.6 | 109 | 18 | 1 | 0 |
| correctness / Qwen3.8 Max | 297 | 43 | 1 | 4 |
| regression / Qwen3.8 Max | 261 | 44 | 1 | 3 |
| adversarial / Qwen3.8 Max | 245 | 44 | 1 | 2 |
| arbitrate / Qwen3.6 | 139 | 23 | 1 | 0 |
| publish / Qwen3.6 | 13 | 1 | 1 | 0 |

每个审查节点的内置工具限制是 40 次。第 41 次内置工具调用会被明确拒绝，但 HomeRail DAG handoff 始终可用。因此工具记录数可能超过 40：其中包含被拒绝的第 41 次尝试和 DAG 工具活动。

regression 第一次提交了错误的 reviewer 名称；correctness 第一次额外提交了 `confidence` 字段。契约纠正机制在不重建 run 的情况下生成了合法 handoff，证明 schema 错误和预算耗尽都可以有界恢复。

实现节点没有：

- 安装依赖；
- 运行大范围构建；
- 修改任何 lockfile。

最终产物：

- `auto-fix.json`：120,983 字节；
- `auto-fix.md`：3,743 字节；
- `auto-fix.patch`：108,919 字节；
- 修改 21 个文件；
- 修改 0 个 lockfile；
- 补丁摘要：
  `14f2c7e5c8d05d57a4926a0e2d918acade2a7aec318283f7322d2a063bc24ca7`。

最终补丁与恢复的标准 checkpoint 逐字节一致。

## 四、哪些设计是有效的

- Manager 的持久 handoff 在 Actions 和 runner 结束后仍保留了精确补丁字节。
- 与 revision 绑定的 checkpoint 允许重试直接继续，不需要把大型补丁重复塞进每个模型 prompt。
- 三个独立审查角色分别关注正确性、回归和对抗边界；用 Qwen3.8 Max 审查、Qwen3.6 实现，也把审查行为与实现行为分离开。
- 隔离的可信 CI 找到了模型审查遗漏的浏览器专属缺陷。
- 精确 revision checkout 和确定性 collection 让模型文字不再是权威证据；真正的证据是补丁字节、DAG 状态和测试结果。
- 稳定 Manager 部署在版本切换时保留了模型配置和持久 DAG 状态。
- 契约纠正可以修复有界的格式错误 handoff，无需重建 run。

## 五、根因分析

### 1. 审查批准没有控制 revision

旧图把候选修改和三份审查投票直接传给 `revise`，审查与 revision 之间没有条件节点。批准只改变 reviser 看到的文字，并不改变控制流。

### 2. 候选修改的持久化依赖发布成功

只有最终发布产物存在，而且全部使用 `publish: success`。审查失败、取消、超时或 finalizer 拒绝，都会让有价值的候选修改无法通过标准 artifact API 获取。

### 3. Action adapter 丢弃了失败上下文

`hr dag run-template --wait` 失败后，runner 删除了临时 stdout。它既没有获取可选候选产物，也没有保存精简 DAG 证据，还不会停止比 Action 活得更久的 run。

### 4. 可信验证成为死路

隔离的 `npm run ci` 找到了真实的 browser barrel 缺陷，但下一次运行拿不到结构化 checkpoint，也拿不到有界的可信验证反馈。

### 5. 审查工作缺少边界

审查节点不知道应该聚焦哪些变更路径，也不会在证据充分后停止。重复探测和不存在的路径形成了很长、错误密集的尾部。

### 6. 验证依赖可能过期

早期独立检查复用了另一个 worktree 的旧 `node_modules`，产生 `detectDagResourcePlatform is not a function`。按候选重新构建依赖后错误消失。权威结果必须来自干净、与候选绑定的环境。

### 7. 只做编译的 asset 测试没有发现非法运行时图

两个反馈源没有声明有界 `while` gateway 是它们的执行依赖。标准编译通过，但 runtime DAGGraph 投影把反馈边识别为普通环路。现在 asset 测试还必须成功投影为运行时 DAGGraph。

### 8. 未执行的反馈源阻止 DAG 成功终态化

一致批准后，只在 revision 路径使用的反馈源仍保持 pending。它的一个前驱已被跳过，永远无法发出普通 promotion 所需的事件。

现在运行时 reconciliation 会：

- 提升已经稳定且可达的节点；
- 或把不可达分支标记为 skipped。

冷恢复也会对已经持久化的 run 执行相同修复。

### 9. 稳定 Manager 重启被当成 runner 永久失败

持久 run 在部署期间没有丢失，但等待中的 CLI 在第一次瞬时状态请求 `fetch failed` 时立即退出。

现在 run 与 artifact 轮询会：

- 容忍 Manager 连续不可用最多 180 秒；
- 成功轮询一次后重置故障窗口；
- 真正超时时保留最后一次轮询错误。

### 10. 工作区策略只拒绝错误路径，却不暴露合法根目录

checkout ACL 本身正确，但错误文字和 prompt 没有让 SDK 从工作目录发现 `source`。现在 harness 会提供安全的相对根目录提示，同时继续执行路径遏制。

### 11. 普通 inject 的确认不等于活动回合已收到

Worker 只有在 interrupt 模式才把 inject 传给活动回合；普通 Actor 队列输入使用 `dag_inbox`。因此诊断 API 确认了消息，却没有改变正在运行的审查。

这是操作员干预语义的缺口，仍保留为 P2。

### 12. 工具预算配置没有实际作用

工作流里存在 `max_tool_calls_per_node`，但 Manager 没有据此生成 Worker 限制，Worker 也没有执行内置工具预算。

现在运行时会：

- 传播可选的逐节点预算；
- 在节点预算和工作流预算中取更小值；
- 始终保留 HomeRail DAG 工具，让 Agent 在检查额度耗尽后仍能完成 handoff。

### 13. 正向 checkpoint 的软提示无法阻止破坏性忙碌

只有文字提示不能阻止模型重复安装依赖、大范围验证或修改 lockfile。

现在正向 checkpoint：

- 明确禁止这些操作；
- 使用 16 次工具的软验证目标；
- 同时受逐节点硬上限保护；
- 完整 CI 由可信验证节点负责，而不是实现节点负责。

### 14. 离线 validator 的环境制造了两个假阴性

第一次失败是因为容器用 `noexec` 挂载 `/tmp`。伪 Git fixture 无法执行，进程查找回落到真实 Git，随后在断网环境尝试网络访问。

现在候选验证使用：

- 可执行的隔离临时 `tmpfs`；
- 继续保留 `nosuid` 和 `nodev`。

第二次失败是因为通用 Node 镜像没有 Playwright 浏览器。现在 validator 默认使用：

- 摘要锁定的 Playwright 镜像；
- Node 24；
- 已知存在的 Chromium。

同时继续禁用网络、丢弃 capabilities、启用 `no-new-privileges`，且不挂载凭据或宿主 socket。

### 15. 手动 CI 声明了 target_ref，却没有真正 checkout

`workflow_dispatch` 提供了 `target_ref`，但原先只有 Live DAG job 使用它。Linux、Windows、Docker 和 Agent UI job 都使用默认 `github.ref`。当工作流从 `main` 发起并传入 PR SHA 时，界面显示 CI 全绿，但实际验证的是 `main`。

修复后：

- 四个非 Live checkout 全部使用手动指定的 `target_ref`；
- pull request 和 push 事件继续保留各自的 `github.ref` 行为；
- 契约测试会统计所有非 Live checkout，并要求每一个都遵守该规则；
- 最终 run 的 `headSha` 明确等于 PR HEAD。

## 六、修正后的流程设计

现在 Auto Fix 是一个有界、持久的状态机：

1. implementation 生成 `candidate-v1.json/.patch`，并使用 `publish: always`；
2. 三个独立审查节点并行执行；
3. 一致批准时跳过 revision，进入仲裁；
4. 出现明确拒绝时，只允许一次 revision 和一次复审；
5. 第二次拒绝会终止发布，但保留最新候选；
6. 稳定 runner 按仓库和 Issue 记录最新候选到 Manager 状态；
7. 同一不可变 revision 的重试会应用该候选，并提供最多 30 KB 可信验证反馈；
8. checkpoint 补丁不会放进模型可见的 Issue envelope；
9. 超时或命令失败会停止持久 run，并保存精简状态、聊天、handoff、候选 artifact 和 checkpoint metadata；
10. Draft PR 发布成功后，checkpoint 标记为完成并移除当前补丁；
11. asset 测试会编译标准工作流，并将其投影为经过验证的 runtime DAGGraph；
12. 每次状态转换和冷恢复时，runtime reconciliation 都会处理不可达 pending 分支；
13. 安全根目录提示只暴露允许访问的相对根目录；
14. 内置工具硬预算取节点和工作流限制的较小值，同时保留 DAG handoff；
15. 正向 checkpoint 角色不安装依赖、不修改 lockfile、不重复运行大范围测试；
16. 稳定 run 和 artifact 轮询可容忍有界的 Manager 重启；
17. 可信验证使用精确 revision、可执行的隔离 fixture 和摘要锁定的浏览器镜像；
18. 手动 CI 的所有非 Live job 都验证明确指定的目标 revision。

## 七、修正动作清单

| 优先级 | 动作 | 验证方式 |
| --- | --- | --- |
| P0 | 使用 `publish: always` 发布 v1/v2 候选 | 失败或取消后仍存在 ready candidate artifact |
| P0 | 记录与 revision 绑定的 Manager checkpoint | 只有 revision 完全一致时，重试才报告 `checkout.mode=resumed` |
| P0 | 让审查投票控制 revision | 一致批准跳过 `revise`；拒绝只允许一轮 |
| P0 | 停止比 runner 存活更久的 run | 超时后没有孤儿活动 DAG，并保留有界诊断 |
| P0 | 验证 runtime DAGGraph 投影 | 部署前由 asset 测试拒绝无法同步的反馈拓扑 |
| P0 | 循环退出后处理休眠反馈分支 | 未使用分支变为 skipped，成功 run 可以进入终态 |
| P0 | 执行内置工具预算 | 第 N+1 次调用被拒绝，但 DAG handoff 仍成功 |
| P0 | 以精确 base 的完整 CI 为权威 | 发布前固定离线命令（含 Chromium）通过 |
| P0 | 手动 CI 严格使用 `target_ref` | run 的 `headSha` 与 PR HEAD 一致，所有非 Live checkout 受契约测试保护 |
| P1 | 把可信验证失败反馈给重试 | investigation 最多收到最后 30 KB，且不重复补丁字节 |
| P1 | 暴露安全工作区根目录 | 审查节点从 `source` 开始，不泄露宿主路径 |
| P1 | 限制正向 checkpoint 验证 | 不安装依赖、不修改 lockfile、不跑大范围测试、不重写候选 |
| P1 | 容忍稳定 Manager 部署 | run 和 artifact 等待可跨越最多 180 秒瞬时故障 |
| P1 | 保持模型绑定私有且可替换 | 公共模板不含 provider、模型 URL 或 key；实现和审查既可共用模型，也可分别配置 |
| P2 | 让普通 inject 的确认与真实送达一致 | 确认必须表示活动回合已收到，或明确说明只进入 `dag_inbox` 队列 |

## 八、精确 base 验证结果

最终接受的 21 文件候选修改被应用到精确 base revision：

`2d1d885f15f98358528e1b4f2f5e58002ebe8473`

随后通过完整的固定离线验证命令：

- Protocol：24 个文件，304 项测试通过；
- Plugin SDK：7 个文件，35 项测试通过；
- Manager：128 个文件通过、1 个跳过；1,068 项测试通过、2 项跳过；
- Node：16 个文件通过、1 个跳过；187 项测试通过、2 项跳过；
- Worker：27 个文件；321 项测试通过、1 项跳过；
- CLI：18 个文件，251 项测试通过；
- Agent UI：80 个文件，418 项测试通过，包含真实 Chromium 隔离测试；
- live validator：在旧 base 加候选修改上有 66 项测试通过。

最终 validator 输出：

```text
Auto Fix 候选修改已在精确 base revision 2d1d885f15f98358528e1b4f2f5e58002ebe8473 上通过固定离线验证命令。
```

当前 PR 分支另外通过 73 项 live-validator 契约测试。精确 base 上数量较少，是因为它使用较早 base 加候选修改，并非跳过验证。

最终通过完整代码验收的 revision：

`b759ba6568955d5507989809340e3442e145d7bf`

[最终 CI run 30018442841](https://github.com/xiaotianfotos/homerail/actions/runs/30018442841) 的 `headSha` 与该 HEAD 一致，结果为：

- Core Linux / Node 20：通过；
- Core Linux / Node 24：通过；
- Core Windows / Node 24：通过；
- Docker smoke：通过；
- Agent UI coverage：通过；
- Live DAG job：本次按计划跳过，因为混合模型运行 5 已提供真实模型证据。

[最终部署 run 30018424894](https://github.com/xiaotianfotos/homerail/actions/runs/30018424894) 也使用同一个 HEAD，并完成构建、原子部署、健康检查和 DAG smoke。

该 revision 之后的提交只把本复盘翻译成中文并修正文档表述，不改变产品代码、运行时或工作流，因此没有重复消耗完整 CI 和生产部署。

## 九、退出条件与剩余工作

- **批准和恢复路径：已通过真实模型证明。** Qwen3.6 实现，加三个并行 Qwen3.8 Max 审查，精确复现 checkpoint 并跳过 revision。
- **停止后候选恢复：已通过真实运行证明。** 候选通过 Manager 持久状态 API 恢复，没有直接编辑数据库。
- **可信完整验证：已证明。** 精确 base 候选通过固定离线 CI，包括 Chromium。
- **稳定 Manager 重连：实现与回归测试完成。** CLI、live-validator 和最终 GitHub CI 通过；DAG 语义和候选字节没有变化，因此没有为此额外消耗一次模型运行。
- **拒绝和 revision 路径：确定性覆盖，但没有故意制造付费模型失败。** 测试证明一次拒绝只允许一次 revision/复审，第二次拒绝会终止。没有为了跑这个分支故意制造一份错误候选。
- **普通 inject 语义：仍是 P2。** 送达确认不能继续与活动回合干预混为一谈。

手工验收没有调用 GitHub 发布。生产 Action 中，只有可信验证通过后才能创建需要人工处理的 Draft PR。审查批准和最终合并始终由人决定。
