# Credential Store

HomeRail stores execution credentials in the Manager database as AES-256-GCM
ciphertext. A WorkflowSpec contains only a `credential_ref` and an explicit
projection policy. List, show, audit, and mutation responses expose metadata and
secret field names, never secret values.

Supported credential types are `api_key`, `oauth_token`, `bot`, `ssh_key`,
`certificate`, and `opaque`. Every create, rotate, revoke, delete, materialize,
and denied use is recorded in an append-only audit ledger.

## CLI

Secret values are accepted from stdin so they do not appear in process
arguments or shell history.

```bash
printf '%s' "$API_KEY" | homerail credential set build-api \
  --type api_key --name "Build API"

jq -n --arg app_id "$LARK_APP_ID" --arg app_secret "$LARK_APP_SECRET" \
  '{app_id:$app_id,app_secret:$app_secret}' \
  | homerail credential set lark-bot --type bot --name "Lark Bot" --json-stdin

jq -n --rawfile private_key ~/.ssh/id_ed25519 \
  --rawfile known_hosts ~/.ssh/known_hosts \
  '{private_key:$private_key,known_hosts:$known_hosts}' \
  | homerail credential set deploy-ssh --type ssh_key --name "Deploy SSH" --json-stdin

homerail credential list
homerail credential audit deploy-ssh
homerail credential revoke deploy-ssh
```

`rotate` reads replacement values using the same stdin forms. Revoked and
expired credentials fail closed at dispatch time.

## WorkflowSpec

Environment projection maps named encrypted fields to non-reserved variables:

```yaml
allowed_dag_tools: [handoff]
credentials:
  - credential_ref: lark-bot
    purpose: publish a report
    inject:
      mode: env
      mappings:
        app_id: LARK_APP_ID
        app_secret: LARK_APP_SECRET
```

File and stdin projections create a private per-turn directory. Linux Workers
use `/dev/shm`; other platforms use the OS temporary directory. Files are mode
`0600`, their path is exposed through the declared environment variable, and
the entire directory is removed in the Worker turn's `finally` block. `stdin`
means the consumer should redirect the temporary file to its process stdin.

```yaml
credentials:
  - credential_ref: deploy-ssh
    purpose: connect to the build host
    inject:
      mode: file
      field: private_key
      filename: id_ed25519
      env: SSH_KEY_PATH
  - credential_ref: deploy-ssh
    purpose: pin the build host key
    inject:
      mode: stdin
      field: known_hosts
      filename: known_hosts
      env: SSH_KNOWN_HOSTS_PATH
```

Manager broker projection keeps the credential entirely on the host. The
Worker receives only an opaque reference and may call only actions declared in
the WorkflowSpec. Broker calls use the authenticated Worker WebSocket and are
fenced to the current run, node, session, generation, and lease.

```yaml
allowed_dag_tools: [credential_broker_call, handoff]
credentials:
  - credential_ref: lark-bot
    purpose: inspect the configured application bot
    inject:
      mode: manager_broker
      broker: lark_bot
      allowed_actions: [bot_info]
```

The initial built-in broker is `lark_bot/bot_info`. Broker implementations are
registered in the Manager and receive decrypted fields only for the duration of
one action. Results are size-bounded and rejected if they reflect a secret
value. A Worker never receives the Lark tenant token or app secret.

## Security Boundary

- Workflow source, dispatch audit, session transcript, and API responses never
  contain stored plaintext.
- Worker text, debug events, tool telemetry, local audit files, and WebSocket
  output redact the actual turn-scoped values. A handoff that reflects one of
  those values is rejected before it can enter persistent DAG state.
- Remote Worker control planes must use the existing secure WebSocket policy;
  env/file projections necessarily traverse that authenticated channel.
- Environment variables are intended for command-line tools that require them.
  Prefer file projection for private keys and certificates, and Manager brokers
  when the external operation can remain host-side.
- JavaScript strings cannot be reliably zeroed. HomeRail minimizes plaintext
  lifetime and removes temporary files, but process memory remains inside the
  trusted Manager and Worker boundary.
