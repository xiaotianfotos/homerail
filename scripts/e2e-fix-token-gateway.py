#!/usr/bin/env python3
"""Optional text-only local-model route with tokenizer-based context admission.

This is an HTTP transport guard, not a task scheduler or a billing verifier.
Its policy and tokenizer are operator-owned. No model code is imported.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def digest(data):
    return hashlib.sha256(data).hexdigest()


def positive(value):
    return type(value) is int and value > 0


class AdmissionError(ValueError):
    def __init__(self, code, message, evidence=None):
        super().__init__(message)
        self.code = code
        self.evidence = evidence or {}


class Admission:
    def __init__(self, policy, tokenizer):
        self.policy = policy
        self.tokenizer = tokenizer
        if policy.get("request_format") != "freetoken-qwen-text-v1":
            raise ValueError("unsupported serving request normalization")
        for key in ("context_window", "min_output_tokens", "max_output_tokens"):
            if not positive(policy.get(key)):
                raise ValueError("invalid token policy")
        if not 65536 <= policy["min_output_tokens"] <= policy["max_output_tokens"] < policy["context_window"]:
            raise ValueError("policy must reserve at least 65536 output tokens below the context window")
        if not isinstance(policy.get("model"), str) or not policy["model"]:
            raise ValueError("missing model identity")
        if not isinstance(policy.get("reasoning_efforts"), list) or not all(isinstance(v, str) for v in policy["reasoning_efforts"]):
            raise ValueError("missing declared reasoning efforts")

    def check(self, body):
        p = self.policy
        if not isinstance(body, dict) or body.get("model") != p["model"]:
            raise AdmissionError("invalid_request_error", "model does not match frozen route")
        caps = [body[k] for k in ("max_tokens", "max_completion_tokens") if k in body]
        if len(caps) != 1 or not positive(caps[0]) or not p["min_output_tokens"] <= caps[0] <= p["max_output_tokens"]:
            raise AdmissionError("invalid_request_error", "explicit output limit does not match frozen reserve")
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            raise AdmissionError("invalid_request_error", "messages are required")
        normalized = []
        for original in messages:
            if not isinstance(original, dict) or original.get("role") not in ("system", "user", "assistant", "tool"):
                raise AdmissionError("invalid_request_error", "unsupported message shape")
            message = {k: v for k, v in original.items() if v is not None}
            content = message.get("content", "")
            if isinstance(content, list):
                if any(not isinstance(part, dict) or part.get("type") != "text" or not isinstance(part.get("text", ""), str) for part in content):
                    raise AdmissionError("invalid_request_error", "route requires text-only messages")
                message["content"] = "".join(part.get("text", "") for part in content)
            elif not isinstance(content, str):
                raise AdmissionError("invalid_request_error", "route requires text-only messages")
            if message.get("tool_calls"):
                calls = json.loads(json.dumps(message["tool_calls"]))
                for call in calls:
                    arguments = call["function"].get("arguments")
                    if isinstance(arguments, str):
                        try:
                            call["function"]["arguments"] = json.loads(arguments)
                        except ValueError:
                            pass
                message["tool_calls"] = calls
            reasoning = message.get("reasoning_content") or message.get("reasoning") or message.get("thinking")
            if reasoning:
                message.setdefault("reasoning_content", reasoning)
                if message["role"] == "assistant":
                    message.setdefault("content", "")
            normalized.append(message)
        tools = body.get("tools")
        if tools is not None and (not isinstance(tools, list) or any(not isinstance(t, dict) or t.get("type") != "function" for t in tools)):
            raise AdmissionError("invalid_request_error", "route requires function tool definitions")
        if tools is not None:
            # Match this route's declared serving adapter: its function model
            # renders name/description/parameters and ignores the wire-only
            # strict flag. Keep arbitrary nested JSON Schema values intact.
            tools = [{"type": "function", "function": {k: tool["function"][k]
                      for k in ("name", "description", "parameters")
                      if tool["function"].get(k) is not None}} for tool in tools]
        choice = body.get("tool_choice", "auto")
        if choice == "none":
            tools = None
        elif isinstance(choice, dict) and choice.get("type") == "function":
            tools = [t for t in tools or [] if t.get("function", {}).get("name") == choice.get("function", {}).get("name")]
        elif choice not in ("auto", "required"):
            raise AdmissionError("invalid_request_error", "unsupported tool selection")
        if body.get("chat_template_kwargs") or body.get("thinking") or body.get("response_format") or body.get("functions") or body.get("continue_final_message"):
            raise AdmissionError("invalid_request_error", "unconfigured template or structured-output override")
        kwargs = {}
        effort = body.get("reasoning_effort")
        if effort is not None:
            if effort not in p["reasoning_efforts"]:
                raise AdmissionError("invalid_request_error", "undeclared reasoning effort")
            kwargs["reasoning_effort"] = effort
        try:
            # Count the complete model input, including tool schemas, tool
            # results, system text, template framing and reasoning instructions.
            tokens = self.tokenizer.apply_chat_template(normalized, tools=tools, tokenize=True,
                                                        add_generation_prompt=True, **kwargs)
            count = len(tokens)
        except Exception as error:
            raise AdmissionError("invalid_request_error", "tokenizer could not render request") from error
        result = {"input_tokens": count, "output_reserve": caps[0], "context_window": p["context_window"],
                  "model": p["model"], "reasoning_effort": effort}
        if count + caps[0] > p["context_window"]:
            raise AdmissionError("context_length_exceeded", "input tokens plus requested output exceed the frozen model window", result)
        return result


class Gateway(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, policy, tokenizer, evidence, key, upstream_key=""):
        self.admission = Admission(policy, tokenizer)
        self.policy = policy
        target = urllib.parse.urlsplit(policy["upstream_url"])
        if target.scheme not in ("http", "https") or not target.hostname or target.username or target.password or target.query or target.fragment:
            raise ValueError("invalid upstream URL")
        self.upstream = policy["upstream_url"].rstrip("/")
        if not key:
            raise ValueError("gateway authentication key is required")
        self.key = key
        self.upstream_key = upstream_key
        self.evidence = Path(evidence)
        self.evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
        serialized = json.dumps(policy, sort_keys=True).encode()
        self.policy_sha256 = digest(serialized)
        policy_path = self.evidence / "policy.json"
        try:
            with policy_path.open("xb") as f:
                f.write(serialized)
                f.flush()
                os.fsync(f.fileno())
        except FileExistsError:
            if policy_path.read_bytes() != serialized:
                raise ValueError("cannot reuse evidence directory for another policy")
        self.lock = threading.Lock()
        super().__init__(address, Handler)

    def record(self, value):
        # Content-free, durable per-request evidence. Never log the bearer key,
        # request text, tool arguments or upstream error bodies.
        with self.lock:
            fd = os.open(self.evidence / "requests.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, (json.dumps({"at": time.time(), **value}) + "\n").encode())
                os.fsync(fd)
            finally:
                os.close(fd)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def error(self, status, code, message):
        data = json.dumps({"error": {"code": code, "message": message}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.key):
            self.error(401, "unauthorized", "gateway authentication required")
            return
        p = self.server.policy
        if self.path == "/v1/models":
            result = {"object": "list", "data": [{"id": p["model"], "object": "model",
                      "owned_by": "local", "context_length": p["context_window"]}]}
        elif self.path == "/v1/context-policy":
            result = {k: p[k] for k in ("model", "context_window", "min_output_tokens", "max_output_tokens")}
            result["policy_sha256"] = self.server.policy_sha256
        else:
            self.error(404, "not_found", "unsupported route")
            return
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.key):
            self.error(401, "unauthorized", "gateway authentication required")
            return
        if self.path != "/v1/chat/completions":
            self.error(404, "not_found", "unsupported route")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= 8 * 1024 * 1024 or self.headers.get("Transfer-Encoding"):
            self.error(400, "invalid_request_error", "bounded content length required")
            return
        self.connection.settimeout(120)
        raw = self.rfile.read(length)
        if len(raw) != length:
            self.error(400, "invalid_request_error", "incomplete request")
            return
        identity = {"request_id": str(uuid.uuid4()), "request_sha256": digest(raw)}
        try:
            body = json.loads(raw)
            admitted = self.server.admission.check(body)
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            code = error.code if isinstance(error, AdmissionError) else "invalid_request_error"
            self.server.record({**identity, **(error.evidence if isinstance(error, AdmissionError) else {}),
                                "status": "rejected", "code": code, "upstream_requests": 0})
            self.error(400, code, str(error) if isinstance(error, AdmissionError) else "invalid request JSON")
            return
        self.server.record({**identity, **admitted, "status": "admitted"})
        headers = {"Content-Type": "application/json"}
        if self.server.upstream_key:
            headers["Authorization"] = "Bearer " + self.server.upstream_key
        request = urllib.request.Request(self.server.upstream + "/chat/completions", data=raw, headers=headers)
        response_hash = hashlib.sha256()
        response_started = False
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                self.send_header("Connection", "close")
                self.end_headers()
                response_started = True
                while True:
                    chunk = response.read1(65536)
                    if not chunk:
                        break
                    response_hash.update(chunk)
                    self.wfile.write(chunk)
                    self.wfile.flush()
                self.server.record({**identity, "status": "forwarded", "response_sha256": response_hash.hexdigest(),
                                    "upstream_requests": 1, "billing_usage": "not_collected"})
        except Exception:
            self.server.record({**identity, "status": "transport_unknown", "upstream_requests": 1,
                                "billing_usage": "unknown"})
            if not response_started:
                self.error(502, "upstream_unavailable", "upstream outcome is unknown; do not infer no execution")
        finally:
            self.close_connection = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--listen", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    policy = json.loads(Path(args.policy).read_text())
    root = Path(policy["tokenizer_dir"])
    for name, key in (("tokenizer.json", "tokenizer_sha256"), ("tokenizer_config.json", "template_sha256")):
        if digest((root / name).read_bytes()) != policy[key]:
            raise ValueError("tokenizer differs from frozen policy")
    headers = {}
    key = os.environ.get("HOMERAIL_TOKEN_UPSTREAM_KEY", "")
    if key:
        headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request(policy["upstream_url"].rstrip("/") + "/models", headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        catalog = json.load(response)
    models = [m for m in catalog.get("data", []) if m.get("id") == policy["model"]]
    if len(models) != 1:
        raise ValueError("served model is not uniquely identified")
    window = models[0].get("context_length", models[0].get("max_model_len"))
    if not positive(window) or policy["context_window"] > window:
        raise ValueError("policy window exceeds advertised serving capacity")
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(str(root), local_files_only=True, trust_remote_code=False)
    server = Gateway((args.listen, args.port), policy, tokenizer, args.evidence,
                     os.environ.get("HOMERAIL_TOKEN_GATEWAY_KEY", ""),
                     os.environ.get("HOMERAIL_TOKEN_UPSTREAM_KEY", ""))
    print(json.dumps({"status": "listening", "port": server.server_port, "policy_sha256": server.policy_sha256}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
