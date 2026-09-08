# E2E Fix 成本与尝试记录 / Cost and attempt inventory

运行只读报告命令，参数是已保存的任务目录，包含 `config.json` 和 `rounds/`：

Run this read-only command with retained task directories containing `config.json` and `rounds/`:

```bash
node scripts/e2e-fix-report.mjs /absolute/trial/task /absolute/another-trial/task
```

JSON 输出按根任务、轮次和角色列出候选 head、计划摘要、测试结果、PR、阶段动作、
模型会话、已报告用量及原始 artifact 的相对路径和摘要。它不启动模型、测试、
PR 或 CI。主配置中的 issue 正文、凭证及模型输出不复制到报告。

The JSON groups candidate heads, plan digests, tests, PRs, stage actions, model sessions,
reported usage and artifact references by root task, iteration and role. It starts no
model, test, PR or CI execution, and omits issue bodies, credentials and model output.

- Worker 累计快照按执行身份去重；Host Codex 按 thread 取最新累计量。
  缓存读取作为输入的子集单列，不再次加入总 token。
  Worker snapshots are deduplicated by execution; Host Codex uses the latest thread
  total. Cached input is reported separately as a subset of normalized input tokens.
- 失败 Host 调用从事件日志统计；Worker 失败投影保留已知消耗，标记原始日志仍需
  核验。没有用量、身份不完整或计数非法时保留 `incomplete`，不宣称零成本。
  Failed host calls retain journal usage. Worker failure projections retain known costs
  while flagging missing journal verification. Missing or invalid usage stays incomplete.
- 同时给出同一根任务的两个副本会报错，避免把恢复副本当作两次运行；累计计数
  冲突、倒退或超出整数精度也报错。模型身份缺失时输出 `null`，不从可变设置猜测。
  Duplicate root copies, conflicting or decreasing counters, and unsafe integer totals
  are rejected. Missing model identity remains null rather than inferred from mutable settings.
- 仅 Host 已保留 started/finished 时报告角色耗时。未知耗时为 `null`；不把 CI
  等待时间算作模型推理，也不推算缺少原始时间证据的生成速率。
  Role duration is available only from retained host start/finish times. Unknown duration
  remains null; CI waiting is not attributed to inference or used to infer generation speed.

`reported_artifacts_only` 表示所读取角色 artifact 的用量可汇总，**不表示账单完整**。
尚未落盘的角色、额外诊断调用或历史缺失记录可能不在其中。运行中的报告只是当时
已有文件的清单，不是原子终态快照。不能用这个报告判定 E2E 通过；独立验收仍须
核对原生命令、会话、候选、真实测试执行、审查意见和最终同 head 的 GitHub CI。

`reported_artifacts_only` means the loaded role artifacts can be totaled, **not complete
billing**. Unwritten roles, separate diagnostic calls and lost records may be absent.
An active-run inventory is not an atomic terminal snapshot. This tool cannot certify E2E
acceptance: native commands, sessions, candidates, test execution, review dispositions
and final-head GitHub CI still require independent verification.
