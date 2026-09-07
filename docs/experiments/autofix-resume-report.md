# Auto Fix 续跑机制技术验证

**结论：有价值的可续跑原型，尚未达到创建 PR 的标准。本次没有创建 PR。**

2026-09-07；实验分支 `codex/autofix-resume-poc`；基线 `e87403d662abd74af2ff9ef8dc757d213997fe6e`。使用真实 HomeRail DAG、DeepSeek Harness 和本地 `qwen38-flash-next`。测试任务提取自 Auto Fix broker 的 Git 文件模式缺陷：两份源码、36 个不可修改的验收用例。没有把它伪装成原生 Auto Fix 全仓库或真实 GitHub PR 验收。

## 已确认的能力与边界

- 四类组合故障连续两组通过：提交响应丢失、测试进程被杀、测试期间 Manager 重启、发布完成但确认丢失。最终组仍只有 2 个模型 run、3 次测试、1 个本地提交。
- 接着执行依靠持久化候选、测试收据和提交意图；不会让模型重新回忆整个任务。模型只交付修改和语义审查，宿主程序执行测试、生成收据和提交。
- 首 token 之后重启 Manager 的两组实验均丢失当前未交付结果，需替换一次编码 run。保存的阶段成果继续可用；正在消耗的推理无法承诺无损续接。
- 保存提交意图后、Manager 接收前断开时，当前原型保留证据并暂停，不能自动继续。已有请求丢回复可查询恢复；缺少可靠的幂等创建协议时不盲目重发。
- 基于 tree hash 的停滞检测能挡住完全重复候选，挡不住只改格式的语义重复。预算上限保证停止，不保证修对。暂停后尚无完整的操作员续跑/扩预算产品接口。
- 可信执行收据证明指定命令确实由独立程序执行，并绑定源码、镜像、命令和日志；它不证明验收覆盖充分或程序绝对正确。仍须模型语义审查及调用方维护测试标准。

## 每个任务的执行评估

| 任务 | 结果 | 实际模型 run | 测试尝试 | 已知 token | 评估 |
| --- | --- | ---: | ---: | ---: | --- |
| baseline-1 | completed | 5 | 5 | 31,423 | 测试器权限错误误判为代码失败；前三份修改语义已正确，仍反复修改格式。修正测试器后从原候选继续并完成。不是干净基线。 |
| baseline-2 | completed | 2 | 2 | 14,112 | 修正权限和退出分类后的独立基线。编码 DAG 内一次 correction 后交付；真实测试、独立审查和本地提交完成。 |
| faults | completed | 2 | 3 | 13,830 | 组合故障：提交响应丢失、kill 测试容器、测试期间重启 Manager、提交成功后 kill 控制器；全部从已有证据继续。 |
| manager-mid-model | completed | 2 | 2 | 9,471 | 运行已提交但首个模型 HTTP 请求尚未开始时重启；恢复成功。不能把这次样本当成推理途中恢复。 |
| measured-low | completed | 2 | 3 | 12,894 | 与 medium 同期启动。宿主 NAS 的权限语义触发额外检查失败，未调用模型；移入 tmpfs 恢复 Git 模式并更换测试器后，废弃旧测试容器，在同任务上完成。一次工具参数错误后修正。 |
| measured-medium | completed | 2 | 3 | 8,566 | 与 low 同期启动；同样保留一次被新测试器取代的尝试。模型首次交付通过，无 correction。单样本不足以判断 medium 优于 low。 |
| submission-before-send | needs_attention | 0 | 1 | 0 | 提交意图持久化后，代理在转发前断开。Manager 实际未收到请求；三次查询后保留证据暂停。模型调用为零。自动恢复验收未通过。 |
| during-inference | completed | 3 | 2 | 8,842 + 未知 | 首 token 后重启；原模型 run 失败，后续 coder+review 完成。此时代理尚未传播断开，上游继续生成受测量工具影响，不能据此推算原生取消成本。 |
| during-inference-cancel | completed | 3 | 2 | 8,869 + 未知 | 修正代理取消传播后重复首 token 故障；原请求被中断，无最终 usage。候选任务继续并完成，需重做一轮编码；消耗未知，不能记作零。 |
| faults-final | completed | 2 | 3 | 8,126 | 最终控制器及可传播取消的代理。四类组合故障全部通过，2 个模型 run、3 次测试、1 个提交；完成后再次执行无额外模型或测试。 |

首次权限分类错误多消耗的三个编码 run 报告了 **24,447 token**（3,820 + 10,367 + 10,260）；不能从总体成功率中隐藏这笔浪费。随后用最终测试器对前三份保存的候选分别补跑，三份均通过全部 36 个用例，确认第一份修改已正确；这些追溯测试与原任务当时的测试收据分开保存。最初 `/work` 权限问题已改为可写 tmpfs 子目录，并以退出码 125 区分测试启动/准备失败。宿主 NAS 无法忠实表达 POSIX 模式，最终测试器在 tmpfs 内按 Git tree 恢复文件模式；旧测试器的容器会被标为 superseded 后重测同一候选。

## 逐个模型 run

下表是 DAG 报告的 input + output + cache-read + cache-creation token 总量（缓存输入在适配器内已拆分，不能重复加到 provider 的 prompt_tokens 上）。`未知` 表示未收到最终用量，不按 0 处理。耗时为 run 生命周期，不等同于模型推理时长。

| 任务 / 序号 | 职责 | Run ID | 秒 | 已知 token | 交付评估 |
| --- | --- | --- | ---: | ---: | --- |
| baseline-1 / 1 | propose | `195541e889c334f40a9b761b` | 8.924 | 2907 | 候选已保存，后由独立测试验证；当轮测试器未实际进入断言 |
| baseline-1 / 2 | propose | `c60a705d6a55f3568872f0f8` | 16.722 | 3820 | 候选已保存，后由独立测试验证；当轮测试器未实际进入断言 |
| baseline-1 / 3 | propose | `d2425b2f7169eb58d918d37e` | 32.615 | 10367 | 候选已保存，后由独立测试验证；1 次工具参数错误；当轮测试器未实际进入断言 |
| baseline-1 / 4 | propose | `88410096fdb939ef7be42b33` | 83.371 | 10260 | 候选已保存，后由独立测试验证；当轮测试器未实际进入断言 |
| baseline-1 / 5 | review | `924a0b56c4c9dcdf913fcfce` | 15.749 | 4069 | 语义审查 clean |
| baseline-2 / 1 | propose | `06680389285fec5ba2f2cd62` | 16.566 | 8861 | 候选已保存，后由独立测试验证；DAG correction 后交付 |
| baseline-2 / 2 | review | `e9e33fc5ec89410daabf5d5d` | 20.876 | 5251 | 语义审查 clean |
| faults / 1 | propose | `19f0e64b300679ead27abc24` | 9.173 | 7783 | 候选已保存，后由独立测试验证；1 次工具参数错误 |
| faults / 2 | review | `95123464ac05a21a9cf76c77` | 30.671 | 6047 | 语义审查 clean |
| manager-mid-model / 1 | propose | `9fbcdad26d301d97f089dd82` | 8.266 | 3768 | 候选已保存，后由独立测试验证 |
| manager-mid-model / 2 | review | `e145a6358e0db4f8b202665f` | 26.414 | 5703 | 语义审查 clean |
| measured-low / 1 | propose | `8866926c9b44bc4d97d19224` | 11.800 | 7957 | 候选已保存，后由独立测试验证；1 次工具参数错误 |
| measured-low / 2 | review | `9bdbf914d63d70fdd9603eed` | 19.676 | 4937 | 语义审查 clean |
| measured-medium / 1 | propose | `3c87c72b27b3780bb2d7b209` | 6.019 | 3719 | 候选已保存，后由独立测试验证 |
| measured-medium / 2 | review | `6a94589f3d729da37cf93df9` | 20.611 | 4847 | 语义审查 clean |
| during-inference / 1 | propose | `1f5f5ff65623ab46b70bac2e` | 3.631 | 未知 | 推理中断，无可恢复的交付物；重试同阶段 |
| during-inference / 2 | propose | `cd73a15ffe807ad76063cf09` | 9.834 | 4096 | 候选已保存，后由独立测试验证 |
| during-inference / 3 | review | `89db279bff86292b8ecc8179` | 16.361 | 4746 | 语义审查 clean |
| during-inference-cancel / 1 | propose | `879ed4df4448afce7b627220` | 3.432 | 未知 | 推理中断，无可恢复的交付物；重试同阶段 |
| during-inference-cancel / 2 | propose | `f50681086c49eddf32f25fb8` | 8.971 | 4070 | 候选已保存，后由独立测试验证 |
| during-inference-cancel / 3 | review | `34803562535fc86c4c0a8e04` | 16.828 | 4799 | 语义审查 clean |
| faults-final / 1 | propose | `19ae1f272693aab145089199` | 6.314 | 3816 | 候选已保存，后由独立测试验证 |
| faults-final / 2 | review | `bbd416b9afc3d0ff4adf89f3` | 11.566 | 4310 | 语义审查 clean |

## 模型性能

最终可传播取消的测量代理记录了 5 个请求，其中 4 个完整返回 usage，1 个在推理中被中断。四个完整请求对应最后两组实验的编码与审查：

| 样本 | HTTP 秒 | 首 token 秒 | 输出 token | 流式输出 token/秒 |
| --- | ---: | ---: | ---: | ---: |
| 编码 1 | 7.39 | 0.79 | 608 | 92.7 |
| 审查 1 | 15.27 | 1.17 | 1305 | 92.8 |
| 编码 2 | 4.79 | 1.17 | 332 | 92.6 |
| 审查 2 | 9.99 | 1.17 | 818 | 93.1 |

吞吐按输出 token 数除以首个到最后一个流式内容事件的间隔计算，包含推理/工具参数输出；不是 GPU 硬件 benchmark。首 token 含本地转发与服务等待。缓存命中、并发、输出长短都会影响数字，四个完整请求不能外推到复杂仓库。

最终组合故障组已知消耗 **8,126 token**。同一个简单修复通常只需要一次编码加一次新会话审查；但 structured handoff 参数错误和过长推理会明显放大成本。此前 low/medium 同期样本只有各一个，不能证明 medium 更快或更准。建议保留低推理强度作为实验基准，以失败指纹、交付正确率、每个完成 issue 的总成本决定何时升级规划或审查。

早期代理有一笔完成后追加请求的 4,380 token 与 DAG 用量不一致。但该版本未向上游传播断开，因此不能声称这 4,380 就是原生运行时泄漏。修正代理并补取消传播回归后，确认中断请求有真实首 token，但最终 usage 缺失；精确消耗仍未知。已单独记录调查 issue，未把可疑数据当成性能结论。

## 验证与复现

- 完整 `VITEST_MAX_WORKERS=4 npm run ci`：退出码 0，3,619 passed、3 skipped。它包含该时点的 23 个原型回归。后续增加两项测量代理回归和一项双控制器锁回归，再跑原型全部 26 项，全部通过。
- 回归覆盖提案越界/路径穿越/超限、保留 Git 模式、快照篡改、计划绑定、失联提交复用/暂停、失效模型输出反馈、重复候选停滞、预算、收据/日志修改、head 漂移、一次提交及测试器/代理故障分类。
- 真实执行与单元测试分开：单元测试可构造 fixture 状态，真实实验均使用公开 API、Docker 和本地 Git；没有写 Manager 私有状态来伪造成功。
- [复现入口与分层说明](autofix-resume-poc.md)；[逐次数据与故障时间线](autofix-resume-results.json)。运行原始快照、聊天、日志和测试收据保存在本地实验目录，不把私有运行配置或凭证加入 Git。

## 后续问题与 PR 门槛

- [#269：可信测试与跨 DAG 的持久化续跑](https://github.com/xiaotianfotos/homerail/issues/269)。需要代表性真实 issue、失败指纹/停滞升级、可操作的暂停续跑、实际 GitHub 发布验收。
- [#270：创建 run 的幂等与不确定提交恢复](https://github.com/xiaotianfotos/homerail/issues/270)。实测重复创建返回已有 round 的 400，原 run 未被覆盖；需要显式、可测试的 request fingerprint/冲突/恢复协议。
- [#271：DSH 请求与用量完整性](https://github.com/xiaotianfotos/homerail/issues/271)。需要请求归属、取消与最终 usage 的完整证据。

当前实现仍是小文件提案控制器。模型设置/工作流运行时引用没有形成完整的不可变版本契约；宿主级可信状态也不是抗恶意宿主的签名系统。GitHub 的认证、push 和 PR 幂等性本次没有配置给模型，也没有实测。现有本地 Git 发布不能替代这些验收，因此保留实验分支和 issue，不创建 PR。
