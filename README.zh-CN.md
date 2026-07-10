# HomeRail

[English](README.md) | 中文

HomeRail 是一个 TypeScript 运行时，用于把一次性的 agent 对话，转化为可审计、可复用的工作流。它的名字就是它做的事：**Home**，它运行在你自己的 homelab、NAS 或家庭服务器上，服务于那里的人；**Rail**，即 DAG 的轨道形态——工作沿着明确的边，在节点之间流动，而不是堆积在一个聊天窗口里。整套设计的出发点很朴素：在一切自动化里，人的注意力都是最稀缺的资源，因此系统应当尽量少地占用它。

它最终想要成为的样子，是一个常驻于家庭数据中心的 agent——你开口说话，它听懂、去办，再把结果以你一眼就能看懂的形态呈现给你；而在它身后，则是一群按 DAG 编排起来的 agent 在分头工作。今天这个仓库里存放的，是支撑它的地基：一个 DAG 引擎、一个 CLI、一个语音面，以及生成式 UI 迈出的最初几步。

## 为什么做这件事

人这一端的带宽有限，而我们要完成的事情却往往复杂。HomeRail 的形态，是一个朝机器一侧不断张开的喇叭口：

- **语音**——首选的输入方式，因为它对你的占用最少。你说话，它聆听、确认，在做任何事之前先消除模糊地带。文字也始终可用，用于安静的场合、需要精确表达的时候，或单纯还没习惯跟电脑说话的人。
- **生成式 UI**——agent 不会把原始日志或 JSON 砸到你面前，而是根据当下的情境，生成一份便于阅读的界面。
- **DAG**——藏在两者背后的执行引擎。多个 agent、多种角色、多个环境，每一次交接都有迹可循，每一次运行都可以重放。

聊天这种形式，你看不到里面发生了什么；DAG 是一张你能审视、能重放、能迭代的图。HomeRail 就位于两者之间——人这一侧窄，机器那一侧宽。

## 今天能做什么

- **DAG 运行时**（*最成熟*）——多 agent 编排，具备显式的交接、按运行隔离的工作区、运行重放、评分卡以及运行评估。
- **CLI `hr`**——`start`、`config`、`doctor`、`run`、`smoke`、`dag supervise`、`scorecard`、`eval-run`、`replay`。这是操作 HomeRail 的主要入口。
- **语音面**——一份 Voice Surface Contract，包含 ASR / TTS / VAD，默认中文，通过桌面语音壳提供服务。agent 会在真正动手之前，跨多个轮次理清你的意图。
- **生成式 UI**（*探索中*）——agent 不再倾倒日志或 JSON，而是产出结构化的、为"一眼能看懂"而设计的视图。这套东西的形态仍在通过真实用例摸索，契约与 widget 集合还会继续变化。
- **Docker Worker**——Manager 和 Node 作为本地服务运行；Node 通过 Docker 拉起 Worker 容器，一个 DAG 节点对应一个容器，同一次运行共享一个工作区。

## 把这份 README 交给你的 agent

HomeRail 有一个设计目标：让它能被 agent 操作的程度，不亚于被人操作。这份 README 的写法，让它同时是一份 agent 可读的 runbook。下面的命令都是纯粹的 `hr` 调用，名字本身即说明用途，每一步也都写明了你会看到什么。你可以把整份文件交给你的 agent（Claude Code、Codex，或任何能执行 shell、读取输出的工具），让它照着 Quickstart，在你的机器上完成 HomeRail 的安装、配置与验证。

## Quickstart

先准备好这些：

- Node.js 20+ 和 npm 10+
- Docker，Node 用它来拉起 Worker 容器
- 一个兼容 Claude Agent SDK 的模型 endpoint，用于真实的 agent 运行

不同平台需要留意的点：

- **macOS**——安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。默认的 `host.docker.internal` 映射即可直接使用。
- **Windows**——Docker Desktop（WSL 2 或 Hyper-V 后端均可），并且请从 Git Bash（或其他 POSIX 兼容的 shell）中运行 CLI。仓库里有些脚本假设类 Unix shell，在 `cmd.exe` 或 PowerShell 下会出现问题。
- **Linux**——Docker Engine。Worker 到 Manager 的网络可能需要额外配置，具体见 [配置](#配置) 中关于 Worker 回调 URL 的部分。

从源码检出安装并构建：

```bash
npm run install:all
npm run build
```

直接运行确定性检查可使用 `npm run ci`。若要在本地执行 GitHub Actions 的
Linux jobs，请先安装 Docker、[`act`](https://github.com/nektos/act) 和
[`actionlint`](https://github.com/rhysd/actionlint)，然后运行：

```bash
npm run ci:local
npm run ci:local -- core-linux  # 只运行一个 job
```

本地 Runner 覆盖 Linux 核心检查、UI 覆盖率和 Docker smoke；Windows job
仍由 GitHub 的 `windows-latest` Runner 执行。

CLI 通过 `hr` 暴露。先在本地 link 一下，后面的命令才能直接写成 `hr`：

```bash
cd homerail_cli && npm link && cd ..
hr --help
```

同时启动 Manager 和 Node。首次运行会构建 `homerail-worker:latest` 镜像；此后只要 worker 源码指纹发生变化，就会自动重建：

```bash
hr start
```

检查就绪状态。`hr doctor` 会告诉你：Manager 是否可达、Node 是否可用、当前的模型设置是什么、以及 Manager Agent harness 能否解析出某个 runtime：

```bash
hr doctor
```

先跑一个本地拓扑检查。这里使用 two-node 模板自带的离线确定性 profile，所以暂时不需要模型 provider：

```bash
hr run assets/orchestrations/public-two-node.yaml.template \
  --profile offline-deterministic \
  --prompt "Draft a short checklist for a backend release"
```

命令会返回一个 `run_id`；如果想看节点交接过程，可以用 `hr dag supervise <run_id>`。

若要同时启动浏览器中的 Agent UI：

```bash
hr start --ui
```

默认端口为：Manager `http://localhost:19191`、Agent UI `https://localhost:19192`、HTTP 回退 `http://localhost:19193`。Manager 默认绑定 `127.0.0.1`；除非你有意让它对 localhost 之外的地址开放，否则无需改动——需要开放时使用 `hr start --host 0.0.0.0`。

## 跑一个 DAG

显式加载一个模板来运行：

```bash
hr templates list
hr run assets/orchestrations/public-two-node.yaml.template \
  --prompt "Draft a short project checklist"
```

需要复用的工作流，先把 DAG 同步到 Manager 数据库。编辑 YAML 时保持
`workflow_id` 不变；只有想创建新工作流/新版本时才修改它。

```bash
hr dag sync assets/orchestrations/public-dev-5node.yaml.template
hr profile sync assets/profiles/example-runtime.profile.yaml.template \
  --workflow public-dev-5node-template
hr run \
  --workflow public-dev-5node-template \
  --profile example-runtime \
  --prompt "Draft a short project checklist"
```

记下返回的 `run_id`，然后审查这次运行：

```bash
hr dag supervise <run_id>
hr scorecard <run_id>
hr eval-run <run_id>
```

若暂时没有真实的模型 provider，只想验证拓扑，two-node 模板自带一个离线确定性 profile：

```bash
hr run assets/orchestrations/public-two-node.yaml.template \
  --profile offline-deterministic \
  --prompt "Draft a short checklist for a backend release"
```

## 让 coding agent 直接操作 CLI

除了对 Manager Agent 说话、或者自己敲命令之外，HomeRail 还有第二种用法：让你已经用顺手的 coding agent——Codex、Claude Code，或任何能执行 shell 命令的工具——直接驱动 `hr` CLI：`templates list`、`run`、`dag supervise`、`scorecard`、`replay`。

这种做法跳过的是 Manager Agent（那个把请求规划成 DAG 的 AI），而不是 Manager 服务（DAG 协调器）。规划的工作交给了你的 coding agent：它读模板、决定改哪里、跑一次 DAG、看结果、再迭代。这正是开发与调试 DAG、模板时最自然的工作循环——你既保有 DAG 运行时完整的审计与评估能力，又让一个你本来就在用它写代码的模型直接掌控这个循环。

```text
你 ↔ coding agent ↔ hr CLI ↔ Manager 服务 ↔ DAG 节点
       （规划）            （协调）         （执行）
```

如果你希望 HomeRail 从一个请求开始，端到端地把工作流规划并跑完，尤其是用语音，那 Manager Agent 仍然是合适的选择。而当你正在搭建或调校 DAG 本身时，直接驱动 CLI 更合适。

## 架构

| 包 | 职责 |
| --- | --- |
| `homerail_protocol` | 共享的消息与校验契约——运行时通信的单一真相源。 |
| `homerail_manager` | Manager 服务与 DAG 协调器。掌管语音面与生成式 UI 契约。 |
| `homerail_node` | Node 服务。负责拉起由 Docker 支撑的 Worker 容器。 |
| `homerail_worker` | Worker 运行时。Claude Agent SDK 与兼容 agent 后端的 harness 适配器。 |
| `homerail_cli` | `hr` CLI。用于配置、运行、审查 DAG 工作流。 |
| `agent-ui` | 解耦的浏览器 UI，用于操作 Manager。渲染语音面与 widget。 |

Manager 与 Node 都是本地服务。Manager 不应运行在 Worker 镜像中。Node 负责创建 Worker 容器；同一次运行的 Worker 共享 `${HOMERAIL_HOME}/workspace/<run_id>`。

### 聪明的头脑，高效的 worker

最贵的模型，不该什么都由它来做。每个 DAG 节点都运行在独立的上下文窗口里：拿到它需要的交接内容，完成自己的那部分，再把证据交给下一个节点。上下文永远不会膨胀成一个臃肿的巨型线程，也不会为了塞得下，就在压力之下遭到压缩、丢失信息。正因为节点彼此独立，每个节点都可以选用不同的模型——最聪明的那个负责规划与审查，便宜、token 效率高的那些负责大部分执行。模板通过 per-agent 的 `provider` / `model` 映射来表达这一点，并以 `"*"` 通配符作为兜底默认。

## 配置

`HOMERAIL_HOME` 是本地数据根目录——Manager 状态、运行工作区、日志、worker 镜像缓存，全部落在它下面。它默认是 `~/.homerail`，而且增长很快：每一次 DAG 运行都会往 `${HOMERAIL_HOME}/workspace/<run_id>/` 写入产物，并随着运行次数不断累积。因此，在开始跑真实工作之前，请把它指向一个容量充裕的磁盘（一个 NAS 挂载点，或一块大容量外置卷）：

```bash
export HOMERAIL_HOME="/mnt/nas/homerail"
```

Provider 凭证保存在 Manager 的加密设置中，绝不写入仓库文件。从 provider 目录配置一个模型：

```bash
hr model configure <provider-or-endpoint-alias> \
  --endpoint-id <endpoint-id> \
  --model-name <model-id> \
  --api-key-stdin
hr model list
```

模型配置好之后，再运行完整的公开 smoke DAG。它会走完五节点流程（plan → implement → test → review → summarize），并校验 scorecard 与 eval-run：

```bash
hr smoke dag \
  --template assets/orchestrations/public-dev-5node.yaml.template
```

跑通之后，产物会落在共享的运行工作区：

```text
${HOMERAIL_HOME}/workspace/<run_id>/snake-game/index.html
${HOMERAIL_HOME}/workspace/<run_id>/snake-game/TESTS.md
```

CLI 按以下顺序解析 Manager URL：`--base-url`、`HOMERAIL_MANAGER_URL`、`${HOMERAIL_HOME}/config.json`，最后是 `http://localhost:19191`。

若通过反向代理提供公网访问，需要通告外部 endpoint，并将 UI 绑定到机器 IP：

```bash
hr start --ui --public \
  --public-url https://homerail.example.com \
  --ui-public-url https://homerail-ui.example.com
```

Worker 容器通过 Manager 传给 Node 的那个 URL，回连到 Manager。在 Docker Desktop 上，默认的 `host.docker.internal` 映射通常就够了；在 Linux 上，要么使用 Docker 的 `host-gateway` 支持，要么设置 `HOMERAIL_MANAGER_WORKER_WS_BASE_URL`。不要在模板或提交的配置中硬编码 Docker 网桥地址。

运行时辅助命令：

```bash
hr runtime status
hr runtime logs
hr runtime stop
hr ui status
hr ui logs
hr ui stop
```

## 项目方向

HomeRail 最终要成为一个常驻于家庭数据中心的 agent——语音输入，生成式 UI 输出，多个节点、多种终端（手机、平板、TV、车机）。当前这个仓库是走向它的第一步，完整计划见 [ROADMAP.md](ROADMAP.md)。

对于语音 Manager Agent，**Codex（`codex_appserver`）是当前推荐的 harness**：它是目前唯一一条能够从模型的原生 reasoning 流，自动合成 `commentary` 语音频道的路径，因此用户能在工作发生的同时听到进度。其他 harness（`claude-sdk`、`kimi-code`）在执行过程中是静默的——这是 provider 能力的差异，并非 HomeRail 能够弥补。

## License

MIT。详见 [LICENSE](LICENSE)。
