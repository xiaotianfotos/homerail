# E2E Fix：既定设计上的自动开发与 PR 返修 / Fixed-design repair

E2E Fix 接收调用者已经确定的设计，在一个原生工作流内执行：
本地模型开发 → 可信测试 → 创建或更新同一个 PR → 独立模型审查 → CI。
测试、审查或 CI 失败时，证据回到新的 Fixer 会话继续修改。
新任务没有 Planner/Judger 节点，不要求 Codex 安装、账号或登录。
设计和授权范围在准备时冻结；循环只调整实现，不重新调用设计者。当前准备入口适用于 Linux Manager 宿主；配置、候选库和冻结运行时
必须留在宿主私有目录，不能放进被修复仓库或挂载给模型 Worker。

状态：仓库提供准备、启动与启动应答丢失后的只读对账命令。
`prepared.json` 只证明准备完成，不代表模型可用、任务启动或验收通过。
不要直接用普通 `hr run` 启动本工作流：它必须使用冻结的 `root_run_id`，
并绑定同步得到的 workflow revision/hash 和 profile 版本。

## 准备

先按根目录的 `npm run build:packages` 构建共享包和 Manager。在 Manager 宿主执行：

```bash
node scripts/e2e-fix.mjs freeze-runtime /srv/homerail-private/runtime-v1
node scripts/e2e-fix.mjs prepare /srv/homerail-private/preparation-input.json
```

第一条命令复制已构建的 Manager、生产依赖和当前 Node，输出包含 `directory`
及 `sha256` 的 JSON 描述符。目标必须不存在。不要向运行时目录添加文件；
描述符应另存到旁边的文件。实际阶段执行前，bootstrap 会检查完整清单、文件
内容、依赖链接和解释器身份。准备阶段只检查清单摘要，不能代替该执行前检查。

第二条命令的输入是一个 JSON 对象，包含以下字段：

| 字段 | 内容 |
| --- | --- |
| `directory` | 不存在的绝对任务目录；其父目录须已存在且由运维控制 |
| `runtime` | 第一条命令输出的 `directory`、`sha256` |
| `config` | 下述冻结任务配置；`runtime_sha256` 必须等于上述摘要 |
| `profile` | `{ "profile_id": "同 root ID", "workflow_id": "同 root ID", "default": { "llm_setting_id": "Manager 设置 ID", "agent_type": "deepseek_harness" } }` |
| `stage_timeout_ms` | 单个原生命令超时（100–3600000 毫秒），须覆盖测试/CI 观察/宿主模型的预算 |

`profile.default` 必须显式引用设置 ID 或 `model_alias`。端点和凭证放在 Manager
凭证/模型设置中；profile 禁止直接提供 provider、model、API key 或 base URL。
准备不读取设置数据库；同步和运行准入仍须检查设置存在、激活及后端能力。

`config` 的完整类型是 `homerail_manager/src/runtime/e2e-fix-stage.ts` 中的
`E2eFixTaskConfig`，准备命令复用实际阶段的校验器。必须显式提供：

- `version: 1`、`mode: "production"`、稳定且唯一的 `task_id` / `root_run_id`；
  `source_repo` 为宿主仓库绝对路径，`repo` 为 GitHub 的 `owner/repo`，`base` 为完整 commit SHA。
- `issue` 的 number/title/body 快照、`allowed_paths` 和 `protected_paths`。
  issue 文本是模型输入，不能自行指定命令、凭证或变更验收策略。
- `tests`：每个测试的唯一 id、不可变 Docker image SHA、argv、cwd、timeout_ms、
  memory_mb/workspace_mb/cpus/pids_limit 和受信任的 `files`。定义见
  `homerail_manager/src/runtime/e2e-fix-test.ts`。先用实际隔离执行器复现基线缺陷。
  可选 `workspace_template` 从固定镜像复制依赖；可选 `setup_argv` 在断言前执行
  受信任的准备命令，例如 `["npm", "ci", "--offline", "--ignore-scripts"]`。
  准备和测试共享容器、工作副本与总超时；网络仍关闭，所需包须预置在镜像中。
  准备失败与 OOM/中断按 `max_infra_retries` 重试同一候选，耗尽后停止；
  真正的测试非零退出保留为代码失败，直接作为下一轮 Fixer 的反馈。
- `policy`：required_tests、required_ci_jobs、ci_workflow_path；reviewer_ids 固定为
  review_a/review_b/review_c，review_approvals 按批准的验收政策设置（本任务至少 2）。
- `github`：base_ref、job_names（逻辑检查 ID 到实际 GitHub job 名称的完整映射）、
  wait_ms、poll_ms 和 checkout_ref（受信任 checkout action 的完整 commit SHA）。
  发布使用宿主 `gh` 身份，默认创建 draft PR；模型不持有 GitHub 写入凭证。
- max_rounds、max_infra_retries、context_bytes、total_timeout_ms、runtime_sha256；
  `design: { "strategy": "已确定的设计、预期行为和实现要求" }`。
  新入口拒绝 `host_codex`，模型选择来自 profile 的 default 和各角色配置。
  Fixer 为 `fix`，三名 Reviewer 为 `review_a`、`review_b`、`review_c`；
  可以使用同一个本地模型的独立会话，也可以分别配置其他模型。

字节上限不是 token 上限。模型输出额度由所选后端/Worker 配置决定，prepare
不会调整它。需要 64K 输出时，必须另行配置并核验实际调用的 65536 限额；
不额外设置任务总 token 消费上限。上下文容量和输出额度仍须符合模型实际能力。

## 产物及下一步

输出目录包含 `task/config.json`、`task/config.sha256`、`runtime.json`、
`workflow.json`、`profile.json` 和最后写入的 `prepared.json` 摘要清单。
command 的路径已绑定最终目录，准备后不得移动。重复命令拒绝覆盖；中断目录
保留现场，没有 prepared.json 的目录不应启动。不要通过删除旧运行记录重置预算。

后续启动必须在同一宿主配置 `HOMERAIL_HOME`、固定解释器的
`HOMERAIL_DAG_COMMAND_ALLOWLIST`、模型设置、Docker 和 GitHub 身份。
只提交一次创建请求；应答未知时按原 root 对账，不另起 root。正常执行由 Manager
持续推进，后台程序仅在异常或结束通知。恢复约束见 [恢复协议](e2e-fix-recovery.md)，
费用汇总见 [证据报告](e2e-fix-report.md)，完整验收边界见 [实施计划](plans/e2e-fix-289.md)。

## 启动和对账

将 `HOMERAIL_MANAGER_URL` 显式指向隔离 Manager，按现有凭证机制设置
`HOMERAIL_DAG_MUTATION_TOKEN`（命令不保存 token），然后执行：

```bash
node scripts/e2e-fix.mjs start /srv/homerail-private/my-task
node scripts/e2e-fix.mjs reconcile /srv/homerail-private/my-task
```

start 先检查准备清单和 Manager 的创建身份能力，再同步 workflow/profile，
固定其 revision/hash/更新时间。创建请求发送前，原子保存 `launch-intent.json`；
同目录只有一个调用者能取得创建权。请求使用冻结 root ID，图内的业务阶段仍全部
由 Manager 驱动。随后通过只读接口核对原始创建请求摘要、workflow/head revision，
匹配后保存 `launched.json`。没有把 HTTP 创建应答本身当作核验结果。

重复 start 在已有 intent 时只查询，不再次同步或 POST 创建；reconcile 始终
不发送写请求。Manager URL 也被 intent 固定，不能把另一台 Manager 的同名 root
认作原任务。首次启动前，旧 Manager 若缺少身份查询能力则拒绝执行。

返回 `observed` 仅表示已核对根任务身份，`run_status` 才是其当前状态；
它不代表测试、审查或 PR 已通过。`unknown` 表示 intent 存在但 root 尚不可见，
`not_submitted` 表示未发现 intent，两者 CLI 退出码均为 2。网络错误、旧接口或
身份冲突退出码为 1。保留现场，并在有明确状态变化后再对账，避免不断询问模型。

若进程在写 intent 后、实际发送前退出，与“已发送但应答丢失”可能无法区分。
普通 start/reconcile 保留 unknown。确认原 Manager 数据仍在、修复准入环境后，
可显式运行 `node scripts/e2e-fix.mjs recover-start /absolute/prepared-directory`。
它先只读对账；若仍不可见，要求 Manager 声明创建幂等能力，再使用原 intent 中
完全相同的请求，最多消耗两个持久恢复名额，不重新同步配置或更换 root。
安全性依赖 Manager 按原始创建请求摘要去重，不是把 404 当作“之前没执行”。
已有 launched 回执或阶段证据却丢失 root 时拒绝重建，应恢复原 Manager 数据。
一个恢复名额已领取但回执不完整时也保留 unknown，不能自动跳到下一份执行。

创建结果保存在 `launch-response.json`，恢复结果单独保存。只记录 HTTP 状态和
已知错误码，不存任意响应正文、错误文本或凭证。旧版本丢失的创建应答无法事后
补造。配置准入失败的自动修复尚未提供；不要删除 intent 或换 root 试探重跑。
这项启动恢复不代表任意业务阶段可以恢复。准备/启动命令不安装监督器；运行完成或异常
唤醒应另接事件监督程序，不能把短连接 CLI 留作业务调度器。

## English

Run the two commands above on the Linux Manager host after building all packages.
`freeze-runtime` creates a new pinned runtime; `prepare` accepts the five-field JSON
input described above and creates private, immutable task/workflow/profile artifacts.
This is preparation only: it performs no model calls, tests, GitHub requests or run
creation. Offline profile parsing does not replace live setting resolution at admission.

Keep the output outside the candidate repository and do not move or overwrite it.
An incomplete directory is retained for investigation. The runtime manifest is pinned
during preparation; the bootstrap verifies the entire inventory before stage execution.
Use trusted test definitions and an explicit GitHub check policy. Model credentials
belong in Manager settings, and GitHub publication uses the host identity.
An optional frozen `setup_argv` runs after dependency/source copying and before
assertions in the same isolated container and timeout. Networking stays disabled;
provide offline dependencies in the pinned image. Preparation failures, OOM and
interruptions use bounded retries of the same candidate, then stop. Ordinary test
failures remain code feedback. The model cannot rewrite this test definition.

Use `start` / `reconcile` with an explicit `HOMERAIL_MANAGER_URL` and the existing
mutation-token environment. Start verifies capability support, syncs the frozen
workflow/profile, atomically records a pinned creation intent and submits once.
All later calls reconcile through GET only; matching persisted request identity
produces `launched.json`. Credentials are never saved. Ordinary `hr run` cannot
replace this identity contract. An observed root is not E2E acceptance.

Ordinary start/reconcile never retry an unknown creation. After repairing admission
and verifying that the original Manager data is intact, explicit `recover-start`
permits two persisted retries of the exact original request against a Manager that
advertises idempotent creation. It never resyncs policy or creates another identity.
A missing previously observed/executed root requires restoring Manager state; an
unfinished claimed retry remains unknown. Structured HTTP outcomes are retained
without arbitrary error bodies or credentials. Completion/exception supervision
is configured separately. Byte/time/round
limits are not a task-wide token budget or a proof of successful execution.

## 多票审查与同一 PR / Review and revision

本地测试通过后，可信程序创建或更新任务自己的 PR，再向三名独立 Reviewer
发送该 PR 的仓库、编号、候选 head、设计、差异和真实测试证据。Reviewer
不会提前看到其他人的票。每个新 head 都重新审查，旧票不能给新提交使用。

完成门禁直接使用冻结的 `review_approvals`（至少 2）：独立完整通过票达到
阈值、必需测试及同 head CI 全部通过。程序不再要求额外 AI Judger 批准，
也不伪造 Judger 会话或把少数意见改写成“已驳回”。少数反对意见照常保留；
相关性判断交给 Reviewer，多数票决定审查是否通过。单份 approve 报告的
findings 必须为空，正面说明放在 summary。

票数不足时，所有 findings 和审查摘要送回 Fixer。测试失败直接反馈真实日志；
CI 失败则反馈失败 job 日志。下一轮继续同一 PR，使用新的 Fixer/Reviewer 会话。
发布本身不代表审查通过，只有完成回执才表示全部门禁满足。程序仍负责 Git/PR
写入与身份对账，模型不持有 GitHub 发布凭证。

Independent reviewers see the published PR identity, fixed design, candidate diff
and trusted test evidence. The configured majority directly decides review passage;
there is no Planner or model Judger in newly prepared workflows. Dissent is retained,
not rewritten as a model dismissal. Each new head receives fresh reviews. Failed
local tests, insufficient votes and failed CI feed the next fresh Fixer session,
which updates the same PR. Publication alone is not acceptance.

## 失败与恢复 / Failure and recovery

设计不随返修变化。重复失败第二次出现时，Fixer 收到改变实现方式的提示；
第三次仍无变化则保留候选和证据并暂停。确认的输出截断可反馈重试；未知模型
执行、未知发布结果或越界修改不被当作成功，也不盲目重复副作用。已声明的
持久阶段恢复继续保留，详见[恢复协议](e2e-fix-recovery.md)。

Older frozen runs may contain host Codex roles and their original recovery protocol.
Their evidence remains readable; new `prepare` calls require a fixed design and
reject host Codex configuration. Byte/time/round controls are not token billing caps.

本地 FreeToken/Qwen 可配置[tokenizer 请求前准入](e2e-fix-token-admission.md)。
该路由与 Worker 策略摘要须一起配置，不能把原有字节上限或模型声明的窗口误称为已启用 token 校验。
