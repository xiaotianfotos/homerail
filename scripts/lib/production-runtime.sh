#!/usr/bin/env bash

load_or_create_production_token() {
  local node_bin="$1"
  local token_file="$2"
  local token_label="$3"
  if [ -e "$token_file" ] && [ ! -f "$token_file" ]; then
    echo "Production $token_label token path must be a regular file." >&2
    return 1
  fi
  if [ ! -e "$token_file" ]; then
    local generated_token token_tmp
    token_tmp="$token_file.$$.tmp"
    if ! generated_token="$($node_bin -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')" \
      || [ -z "$generated_token" ]; then
      rm -f "$token_tmp"
      echo "Production $token_label token generation failed." >&2
      return 1
    fi
    (umask 077; printf '%s\n' "$generated_token" > "$token_tmp")
    mv "$token_tmp" "$token_file"
  fi
  chmod 0600 "$token_file"
  local token
  token="$(tr -d '[:space:]' < "$token_file")"
  if [ -z "$token" ]; then
    rm -f "$token_file"
    echo "Production $token_label token must not be empty; removed for regeneration." >&2
    return 1
  fi
  printf '%s' "$token"
}

initialize_production_tokens() {
  local node_bin="$1"
  local secret_dir="$2"
  mkdir -p "$secret_dir"
  chmod 0700 "$secret_dir"
  HOMERAIL_NODE_TOKEN="$(load_or_create_production_token "$node_bin" "$secret_dir/node-registration.token" "Node registration")" || return 1
  HOMERAIL_WORKER_TOKEN="$(load_or_create_production_token "$node_bin" "$secret_dir/worker-registration.token" "Worker registration")" || return 1
  HOMERAIL_DAG_MUTATION_TOKEN="$(load_or_create_production_token "$node_bin" "$secret_dir/dag-mutation.token" "DAG mutation")" || return 1
  export HOMERAIL_NODE_TOKEN HOMERAIL_WORKER_TOKEN HOMERAIL_DAG_MUTATION_TOKEN
}
