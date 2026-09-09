# E2E Fix：宿主配置准备 / Host preparation

E2E Fix 把方案、修复、可信测试、审查、Judger、PR 和 CI 放在一个有界原生
工作流中。当前准备入口适用于 Linux Manager 宿主；配置、候选库和冻结运行时
必须留在宿主私有目录，不能放进被修复仓库或挂载给模型 Worker。

状态：仓库已提供可复现的准备命令；统一的启动与启动应答丢失对账命令仍待交付。
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
- `policy`：required_tests、required_ci_jobs、ci_workflow_path；reviewer_ids 固定为
  review_a/review_b/review_c，review_approvals 按批准的验收政策设置（本任务至少 2）。
- `github`：base_ref、job_names（逻辑检查 ID 到实际 GitHub job 名称的完整映射）、
  wait_ms、poll_ms 和 checkout_ref（受信任 checkout action 的完整 commit SHA）。
  发布使用宿主 `gh` 身份，默认创建 draft PR；模型不持有 GitHub 写入凭证。
- max_rounds、max_infra_retries、context_bytes、total_timeout_ms、runtime_sha256；
  `host_codex` 的 model、timeout_ms、output_bytes，及可选 fixer。
  Planner/Judger 始终走宿主 Codex；fixer=true 时 Fixer 也走宿主。

字节上限不是 token 上限。模型输出额度由所选后端/Worker 配置决定，prepare
不会调整它。需要 64K 输出时，必须另行配置并核验实际调用的 65536 限额；
任务总 token 硬预算目前仍未交付，不能以轮次/时间/字节预算冒称它已存在。

## 产物及下一步

输出目录包含 `task/config.json`、`task/config.sha256`、`runtime.json`、
`workflow.json`、`profile.json` 和最后写入的 `prepared.json` 摘要清单。
command 的路径已绑定最终目录，准备后不得移动。重复命令拒绝覆盖；中断目录
保留现场，没有 prepared.json 的目录不应启动。不要通过删除旧运行记录重置预算。

后续启动必须在同一宿主配置 `HOMERAIL_HOME`、固定解释器的
`HOMERAIL_DAG_COMMAND_ALLOWLIST`、宿主 Codex 登录、Docker 和 GitHub 身份。
只提交一次创建请求；应答未知时按原 root 对账，不另起 root。正常执行由 Manager
持续推进，后台程序仅在异常或结束通知。恢复约束见 [恢复协议](e2e-fix-recovery.md)，
费用汇总见 [证据报告](e2e-fix-report.md)，完整验收边界见 [实施计划](plans/e2e-fix-289.md)。

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

A consolidated start/reconciliation command remains pending. Ordinary `hr run` is
insufficient because the frozen root ID and synced workflow/profile revisions must
match. Never retry an uncertain creation with a new identity. Byte/time/round limits
are not a task-wide token budget or proof of model availability or E2E acceptance.
