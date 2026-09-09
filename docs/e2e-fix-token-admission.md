# Local-model token admission / 本地模型上下文准入

The optional `scripts/e2e-fix-token-gateway.py` route counts the complete Chat
Completions input before forwarding it. It includes system messages, function
schemas, tool results, chat-template framing and reasoning-effort instructions.
It rejects `input_tokens + requested_output_tokens > context_window` instead
of silently reducing the requested output allowance. It does not orchestrate
DAG stages or provide a task-wide/provider billing cap.

这个可选路由在转发前按 tokenizer 计算完整请求，并为输出保留至少 65536 token。
字节限制只用于限制 HTTP 请求大小，不替代 token 计数。当前实现针对经验证的
FreeToken + Qwen 文本/函数调用格式；其他服务、模板覆盖、多模态或结构化解码
需要对应的计数适配，不能直接沿用本路由的计数结论。

## Setup / 配置

Run on a trusted Linux host with Python 3, `transformers` and `tokenizers`.
The local validation used transformers 4.57.3 and tokenizers 0.22.2. No model
weights are loaded and `trust_remote_code` is disabled. Keep configuration,
authentication values and evidence outside the repaired repository. The
operator must supply tokenizer files matching the serving checkpoint/template.

Create a private policy JSON using these fields (paths and hashes below are
placeholders to replace with your deployment):

```json
{
  "request_format": "freetoken-qwen-text-v1",
  "model": "your-served-model-id",
  "upstream_url": "http://your-model-host:5000/v1",
  "tokenizer_dir": "/srv/private/model-tokenizer",
  "tokenizer_sha256": "SHA256 of tokenizer.json",
  "template_sha256": "SHA256 of tokenizer_config.json",
  "context_window": 262144,
  "min_output_tokens": 65536,
  "max_output_tokens": 65536,
  "reasoning_efforts": ["low", "medium", "xhigh"]
}
```

Supply `HOMERAIL_TOKEN_GATEWAY_KEY` through the environment. If the upstream
requires authentication, supply a separate `HOMERAIL_TOKEN_UPSTREAM_KEY`;
the incoming gateway key is not forwarded upstream. Start with:

```bash
python3 -B scripts/e2e-fix-token-gateway.py \
  --policy /srv/private/token-policy.json \
  --evidence /srv/private/token-admission \
  --listen 127.0.0.1 --port 49195
```

At startup the gateway checks the tokenizer hashes and the upstream model's
advertised capacity. Its first stdout record contains `policy_sha256`.
Configure the selected Manager model setting with the gateway's `/v1` base URL
and gateway key. For container Workers, bind a reachable private interface and
use its address instead of container-local `127.0.0.1`.

Set `HOMERAIL_DSH_MAX_TOKENS=65536` in the Worker process environment and set
`HOMERAIL_DSH_CONTEXT_POLICY_SHA256` to that policy digest (Worker environment
or the trusted dispatch environment). The Worker authenticates against
`/v1/context-policy` and checks the digest, model, window and output reserve
before starting DSH. A failed handshake does not start the model backend.
Absent this setting, existing backend behavior is preserved; do not claim
this admission protection for an unconfigured route.

必须同时配置路由和 Worker 的策略摘要。只有启动了网关，或只有普通输入字节上限，
都不能证明某个 DAG 已使用 tokenizer 准入。每个请求的事件只记录请求摘要、
计数和转发状态，不记录正文或密钥。`transport_unknown` 不是零消耗，也不允许据此
盲目重发。重新启动可复用相同策略的证据目录，不能将目录改绑另一份策略。

## Evidence and limits / 证据与限制

A Docker DSH adapter probe made two real local-model requests with one tool
call. Predicted inputs were 338 and 409 tokens; both matched the provider usage
deltas. Each reserved 65536 output tokens. A larger request was rejected with
HTTP 400 and made no additional upstream generation request. This proves the
transport boundary, not a complete root-DAG/PR run on the new configuration.

An earlier probe exposed two normalization details: reasoning effort changes
the Qwen template, and this serving adapter excludes the wire-only function
`strict` field from the template. Both are accounted for in the declared route.
The proof also exposed DSH's disjoint input/cache usage categories; HomeRail
now includes cache reads/writes in `input_tokens`, keeping the separate cache
fields as subsets. The final probe reported 747 input + 78 output tokens;
640 cache-read tokens are already included in that input total.

This route does not count native ChatGPT-authenticated Codex traffic. It does
not implement a cross-attempt global token ledger, infer absent provider usage,
or guarantee that another server/version uses the same template normalization.
Validate the serving configuration before enabling it; count agreement from a
small probe is not a universal tokenizer-compatibility guarantee.

本次统计也复核了四个主要真实问题/成本对照任务的已保存 DSH usage：它们报告的
缓存读写计数均为零，因此已有对照数字不受这次归一化修正影响。这个结论只涵盖
已核对的那些产物，不代表所有历史尝试或供应商未报告的缓存用量。

A subsequent local native DAG verified Manager → Node → provisioned Docker
Worker dispatch on the policy-bound route. One model request used 684 input
and 75 output tokens, with a 65536-token reserve in a 262144-token window.
The Manager retained the authenticated policy-handshake debug event and
matching execution-scoped usage; Docker events confirmed creation, start and
cleanup of the selected image. This local diagnostic had only a handoff node
and terminal nodes, with no repair or publication stage. It proves native
transport configuration; earlier real-issue E2E proofs remain separate.
