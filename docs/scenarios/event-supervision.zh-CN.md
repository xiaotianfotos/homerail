# Auto Fix 持久化事件监控

[English and complete spec](event-supervision.md)

宿主机监控器负责等待可信测试命令或指定 GitHub workflow，在异常、超时提醒或完成时通知
Judger。等待不调用模型。它独立于 Manager、Node 和 Worker，不生成修复方案，不自动重试
DAG，不批准修改，不发布 PR，也不部署系统。

## 安装与任务身份

要求 Linux、Python 3.9+、可访问的 `systemctl --user`，且用户 linger 已启用。
安装器检查这些条件，不修改系统服务或自动启用 linger。GitHub 观察还需要已认证的 `gh`。
macOS/Windows 不支持此 systemd 适配器。

按英文文档的完整 JSON 示例创建私有 spec。`event_dir` 必须在代码仓库和 Worker 挂载目录之外；
所有路径为绝对路径。`argv` 和 `queue_argv` 是参数数组，不隐式经过 shell。
不要写入密钥或 token；运行时使用现有凭证存储。`preflight_argv` 只用于只读检查。

`queue_argv` 是可配置的宿主机通知程序，监控器追加 `--thread ID --message TEXT`。
可配置真实的 Codex queue 入口，也可使用同样接口的传输程序。返回 0 只表示传输接受，
不能证明 Judger 已消费。显式配置 Node/npm/gh 所需的 PATH，避免后台服务与终端环境不同。

```bash
chmod 600 /absolute/private/job.json
python3 scripts/event-supervisor/durable.py install /absolute/private/job.json
```

命令返回注册文件路径和服务名。默认数据根目录为
`${HOMERAIL_HOME:-$HOME/.homerail}/event-supervision`；可在子命令之前使用 `--home` 覆盖。
服务安装到 `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`。`--unit-dir` 仅用于隔离测试，
真实安装必须使用用户 systemd 读取的目录。

安装时复制按内容哈希固定的监控代码，因此切换源仓库分支不会改变已经安装的监督器。
Python 解释器固定路径，未固定其二进制内容。外部命令由调用方固定：测试应使用冻结控制器和
候选提交，不能把一个可变 shell 脚本当成可信测试结果来源。

命令任务必须有稳定的 `execution_id`，包含任务、轮次、方案、提交及操作身份。
中断后继续使用原身份，不能改名再执行。通知标题或目录不同不能绕过同一数据根目录内的去重。
GitHub 任务用 `github` 对象代替 `argv`/`execution_id`，按 repo、PR、run、attempt、
workflow head、PR head 和 workflow path 去重。workflow 的提交与被审查 PR 的提交必须分别绑定。
内置观察器只读，不触发工作流，也不取消已有执行。

可选 `repo_dir`/`head` 检查命令前后都是指定完整提交，适合固定候选测试。
可选 `task_root`/`round`/`plan_digest`/`expected_phases` 检查 Auto Fix 的轮次和阶段。
新上下文、预算、最大重试与无进展升级仍由修复控制器和 Judger 管理。

## 恢复与结果消费

```bash
python3 scripts/event-supervisor/durable.py status /absolute/registration.json
python3 scripts/event-supervisor/durable.py reconcile /absolute/registration.json
```

监督器先记录启动意图，再启动独立的宿主机执行器。即使监督器被杀死，执行器仍能保存
`runner.json`（退出码、任务快照、日志摘要）。服务重启后复用完成收据；若原执行器仍存活，
按 boot ID 与进程启动标识接回观察，先发一次中断通知，完成后再通知，不重新运行命令。
`reconcile` 只观察已有执行；结果未知且原进程已消失时返回 75，不编造退出码或重启任务。
完成但命令失败与命令通过由 `status` 和事件 outcome 区分。

读取通知后核对本地事件、当前 round/plan/head、执行收据及独立测试/审查产物，再由 Judger
判断，并保存幂等消费回执。重复或过期事件只记录，不能因此重跑 DAG、测试或发布。
GitHub 观察失败不代表工作流失败，工作流绿色也不代表所有模型完成审查。

通知发送前保存尝试状态。送达失败、超时或不确定时不盲目重发，因此不承诺恰好一次外部修改或
必达唤醒。整机掉电仍可能发生在执行收据写入前；此时检查已保存的候选、实际远端执行和现有测试，
仅恢复真正缺失的阶段。哈希验证完整性，不能证明模型真的执行了测试；执行器与证据目录必须由
宿主机控制，不能让模型写入。

## 升级、回退与卸载

```bash
python3 scripts/event-supervisor/durable.py upgrade /absolute/registration.json
python3 scripts/event-supervisor/durable.py upgrade /absolute/registration.json --source /absolute/retained/runtime
python3 scripts/event-supervisor/durable.py uninstall /absolute/registration.json
```

使用安装时的同一 `--home`。只有服务不活动、执行已结束且原子进程不存活时才允许升级或卸载。
升级保留旧版本与历史；升级途中失败可用原命令重试修复服务文件。不要手改服务或把新任务方案混作升级。

卸载先持久化停用标记，再移除自己的服务，保留注册、代码版本和全部证据。它不会取消 DAG 或杀死
子进程。未知执行必须先由 Judger 核对；不能通过删除记录绕过。重新安装同一 spec 也不会重跑终态任务。

旧的 transient 监控器不自动迁移。先检查真实服务、锁、boot/process 身份及远端执行，保留结果并
消费事件；后续新任务使用正式安装器。手工旧观察器、不同数据根目录之间不提供全局去重。

## 验证边界

`node --test scripts/event-supervisor.test.mjs` 运行 Linux Python 标准库测试，包括真实进程中断和
模拟生命周期故障；测试不发送真实通知、不修改 systemd。它已纳入 `npm run test:live-validator`
和 `npm run ci`。真实服务重启、模拟 boot ID 与整机重启必须分别验收和报告。

在 Linux 测试宿主机上，可显式运行
`python3 scripts/event-supervisor/prove-systemd.py /absolute/new-proof-directory`。
它只安装一个测试服务、杀死该监督器，验证接回原进程和完成事件，再验证升级/卸载/重装并卸载自己的服务。
证据保留在新目录，通知使用本地桩，不调用模型、不重启机器。若断言失败，脚本允许测试子进程完成，
保留服务与证据供诊断；核对注册文件并恢复结果后再卸载。
