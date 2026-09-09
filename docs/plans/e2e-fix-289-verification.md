# E2E Fix 验收账本

核验基线：实现 `1e769f38a03b7062dfe3a9a802fd30af65d2560d`。
这是原始 [实施计划](e2e-fix-289.md) 的逐项差距账本，不替换或缩减验收要求。
2026-09-09 的完整本地 `npm run ci` 已核验通过，启用了真实 Docker 原生阶段测试；
本地通过不代表实现 PR 的 Windows、UI coverage、Docker smoke 或独立审查通过。
运行产物留在宿主私有实验目录，不提交原始模型输出、账号配置或临时日志。

## 端到端交付证据

| 原要求 | 已核对证据 | 结论及剩余工作 |
| --- | --- | --- |
| 单逻辑根 DAG，测试失败→负面审查→修复，无外部逐轮推进 | `e2e-fix-workflow.test.ts` 三轮拓扑测试及 `e2e-fix-stage.test.ts` 的真实 Git/Docker 阶段 | 控制流已通过；测试模型是替身，不能代替真实修复能力 |
| 原生 Codex Planner/Judger、Qwen Fixer/Reviewer | #291 的 PR #304、#245 的 PR #305，均有原生命令、实际会话、测试及独立终态审计 | 两个真实任务首轮成功；不能单独证明反馈收敛 |
| 至少一个真实问题根据实际失败自动返修并最终完成 | #245 无旧补丁演练 `issue245-e2e-unseeded-6`，第一轮可信测试失败，第二轮通过并创建 PR #307 | 已发生真实候选反馈；第二轮 Windows CI 随后失败，第三轮更新仍是同 PR，但其修改未修复失败原因；终态核验待完成，不能凭后续绿灯宣称 CI 缺陷已修复 |
| 同 PR 的真实 CI 红→返修→绿 | 受控 PR #306，CI `34293274363` 失败→`34294533900` 五项成功，19 个可信命令、两轮同根/同 PR | 控制流通过；真实 GitHub/Git/Docker，全部模型角色是确定性替身，`production_eligible=false`；fixture 禁止合并 |
| 每轮新上下文、完整证据与成本 | #304/#305 独立审计通过；`scripts/e2e-fix-report.mjs` 去重累计 usage，保留未知字段 | 真实返修新会话需随 #307 最终审计；全任务 token 硬预算仍未实现 |
| 可重现产品入口 | `scripts/e2e-fix.mjs` prepare/start/reconcile/recover-start，#245 原 root 丢失创建结果后实际恢复成功 | 启动对账已验证；不能推导任意阶段/进程可无损恢复 |
| 一个集中实现 PR、同 head 必需 CI 全绿、至少两票完整独立审查、全部 finding 裁决 | 尚无最终实现 PR | 未完成；演练 PR 的票数不能给实现 PR 使用 |

## 原始故障矩阵

下列路径均相对于 `homerail_manager/tests/`，共享政策测试位于
`homerail_protocol/tests/e2e-fix.test.ts`。测试名称/源码说明覆盖范围，
通过证据来自上述完整本地 CI；额外新测试在单独通过前不计入。
“部分”表示仍须补齐原计划要求的执行前、执行未确认、执行已确认边界及副作用计数。

| 故障或反例 | 可定位的现有证据 | 尚未证明的边界 |
| --- | --- | --- |
| create 已接受但应答丢失 | `e2e-fix-launch.test.ts` lost create / concurrent callers；原生创建幂等 HTTP 测试 | 显式恢复只复用相同 intent，已执行 root 的 Manager 数据丢失禁止重新创建；不保证跨丢失数据库恢复 |
| intent 后、进程启动前退出 | `durable-command.test.ts` intent prepared before restart，断言仅执行一次 | 按业务测试、CI、反馈三个阶段逐一映射仍待补齐 |
| 已启动但 ack 丢失 | `durable-command.test.ts` lost acknowledgement；`e2e-fix-test.test.ts` lost create acknowledgement | Docker 的 unknown 不能作为不存在；不覆盖任意第三方模型会话接续 |
| Manager 在等待/反馈边界重启 | `durable-command-workflow.test.ts` 实际 SIGKILL，原测试继续、恢复后仅消费一次；导出 owner epoch 和执行次数 | 新增独立 Manager 在第二轮 while/feedback 工作仍执行及已完成未消费时的实际 SIGKILL，均恢复两轮、两次执行且 owner epoch 为 1/2；真实 GitHub 等待断网/重启仍未独立注入 |
| 首 token 后 Worker/Manager 退出 | `e2e-fix-model-failure.test.ts` 终态/会话 usage 绑定，原失败演练保留截断与耗费 | 实际首 token 后进程杀死及新会话阶段恢复，尚无完整端到端证明 |
| 测试被杀/OOM/安装失败 | `e2e-fix-test.ts` 分类执行中断并在同一候选有限重试；新增真实 SIGKILL 路由回归已通过：同候选两个实际容器，bootstrap 记录 SIGKILL 并退出 125，未派发第二个 Fixer/任何审查或 Judger | OOM 和安装失败的全部独立注入未覆盖；不能把断言失败当基础设施重试 |
| 真实断言失败或负面审查 | 原生三轮测试、#245 第二轮实际返修、受控 #306 CI 失败日志反馈 | #245 最终成功待终态审计；不宣称任意 issue 收敛 |
| 双恢复/过期 owner | `durable-command.test.ts` superseded owners、一次消费；恢复事务与旧 lease 测试 | 业务阶段 × 前/中/后完整交叉矩阵仍为部分 |
| 重复事件、迟到回执、完成后篡改 | `durable-command-workflow.test.ts` cancellation fences late completion；测试回执/log 篡改拒绝；通知去重测试 | 当前任务已按用户要求取消自动通知，不能为了验收重新开启 |
| PR 创建/更新应答丢失 | `e2e-fix-github.test.ts` 两轮同 PR、push/create/dispatch 丢应答，断言次数 | 注入 API transport；真实 GitHub 丢应答注入尚未做，unknown 时保留暂停 |
| CI 断网、attempt/head 漂移 | `e2e-fix-github.test.ts` duplicate-run / attempt-drift / wrong-checkout / missing/skipped jobs；原生 unknown/stale CI 路由 | 断网后同观察恢复的完整实机故障演练待补齐 |
| 伪造报告、改 hash、删测试、改 runner | `durable-command.test.ts` model-written report 拒绝；candidate/runtime/test 专项篡改测试 | 测试证据来自可信程序和宿主权限边界；hash 自身不是执行证明 |
| 相同失败、无效修改、超预算 | `e2e-fix-candidates.test.ts` no-op/重叠/旧片段拒绝；工作流轮数上限；截断后相同计划拒绝 | 新增保守失败指纹：第二次重规划、第三次暂停，单元与真实 Docker 原生循环已通过；变动诊断可能不匹配。全任务 token 预算/预留、跨新 attempt 预算归并仍未完成 |
| 两票通过但有效 blocker/可证伪 finding | protocol 独立票/身份/完整处置测试；原生 unresolved/dismissed/duplicate-disposition | 实现 PR 的真实审查和逐条处置尚未进行 |

## 后续执行次序

1. 核验 #307 终态与实际反馈、原始测试、同会话 usage 和 GitHub checkout；保留失败尝试。
2. 补齐故障矩阵实质缺口及预算/停滞约束。每项新增测试须说明实际注入点、副作用数量和恢复边界。
3. 更新统一操作文档和两项真实问题报告，明确首次成功与反馈成功、模型替身与真实模型的分母。
4. 创建集中实现 PR，完成同 head 的全部必需 CI 与至少两票完整独立审查，处置有效问题后才可宣称交付。

自动唤醒属于产品可选运行机制；本任务的 `autofix-event` 注册与发送已由用户取消。
继续工作时直接复用程序记录，不为等待重新注册通知，也不伪造完成通知文件供审计使用。
