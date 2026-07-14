import { describe, expect, it } from "vitest";
import {
  homerailPluginToolInvocationDigestInput,
  validateHomerailPluginToolCapabilityClaims,
  validateHomerailPluginToolConfirmationChallenge,
  validateHomerailPluginToolConfirmationDecision,
  validateHomerailPluginToolInvocation,
  validateHomerailPluginAuthorizedToolInvocation,
  validateHomerailPluginRuntimeRpcRequest,
  validateHomerailPluginRuntimeRpcResponse,
  type HomerailPluginEffectivePermissionGrantV1,
  type HomerailPluginActionTargetV1,
  type HomerailPluginToolBindingV1,
  type HomerailPluginToolInvocationV1,
  type HomerailPluginToolValidationOptionsV1,
  type HomerailPluginAuthorizedToolInvocationV1,
  type HomerailPluginRuntimeRpcRequestV1,
  type HomerailPluginRuntimeRpcResponseV1,
} from "../src/plugins/index.js";

const requestDigest = "d".repeat(64);
const actionInputDigest = "9".repeat(64);
type UiActionSource = Extract<HomerailPluginToolInvocationV1["source"], { type: "ui_action" }>;
type AgentSource = Extract<HomerailPluginToolInvocationV1["source"], { type: "agent" }>;

function effectiveGrants(): HomerailPluginEffectivePermissionGrantV1[] {
  return [{
    permission: "network.connect",
    hosts: ["api.example.com", "uploads.example.com:443"],
  }, {
    permission: "workspace.write",
    paths: ["/workspace/releases", "/workspace/selected.json"],
  }];
}

function binding(): HomerailPluginToolBindingV1 {
  return {
    plugin_id: "com.example.runtime",
    plugin_version: "1.2.3",
    manifest_digest: "a".repeat(64),
    package_digest: "b".repeat(64),
    context_digest: "c".repeat(64),
    registry_revision: 12,
    permission_revision: 7,
  };
}

function target(): HomerailPluginActionTargetV1 {
  return {
    document_id: "document-1",
    document_revision: 9,
    node_id: "com.example.runtime:node-1",
    node_revision: 4,
    action_id: "publish",
    action_intent: "com.example.runtime:publish",
  };
}

function uiActionSource(): UiActionSource {
  return {
    type: "ui_action",
    target: target(),
    action: {
      local_id: "publish",
      qualified_id: "com.example.runtime:publish",
    },
    input_digest: actionInputDigest,
  };
}

function agentSource(): AgentSource {
  return {
    type: "agent",
    call_id: "call-00000001",
    modality: "voice",
    scope: { type: "voice_session", id: "voice-session-1" },
    target: { document_id: "document-1", base_revision: 9 },
  };
}

function tool(): HomerailPluginToolInvocationV1["tool"] {
  return {
    local_id: "publish_release",
    qualified_id: "com.example.runtime:publish_release",
    wire_id: "publishRelease",
    handler: { type: "runtime", method: "publish_release" },
  };
}

function invocation(
  source: HomerailPluginToolInvocationV1["source"] = uiActionSource(),
): HomerailPluginToolInvocationV1 {
  return {
    tool_bus_version: 1,
    request_id: "req-00000001",
    idempotency_key: "idem-00000001",
    request_digest: requestDigest,
    invoked_at: "2026-07-12T00:00:00Z",
    deadline_at: "2026-07-12T00:10:00Z",
    source,
    tool: tool(),
    binding: binding(),
    policy: {
      effect: "external",
      permissions: ["network.connect", "workspace.write"],
      effective_grants: effectiveGrants(),
      confirmation: "always",
      confirmation_required: true,
    },
    arguments: { channel: "stable", note: "Publish the selected node." },
  };
}

function authorization(
  source: HomerailPluginToolInvocationV1["source"] = uiActionSource(),
): HomerailPluginAuthorizedToolInvocationV1 {
  return {
    authorization_version: 1,
    invocation: invocation(source),
    capability: {
      capability_version: 1,
      capability_id: "cap-00000001",
      audience: "homerail.plugin-runtime",
      scope: "plugin.tool.execute",
      nonce: "nonce-00000001",
      single_use: true,
      request_id: "req-00000001",
      request_digest: requestDigest,
      binding: binding(),
      effect: "external",
      permissions: ["network.connect", "workspace.write"],
      effective_grants: effectiveGrants(),
      issued_at: "2026-07-12T00:02:01Z",
      expires_at: "2026-07-12T00:05:00Z",
    },
    confirmation: {
      challenge: {
        confirmation_version: 1,
        challenge_id: "challenge-00000001",
        request_id: "req-00000001",
        request_digest: requestDigest,
        effect: "external",
        permissions: ["network.connect", "workspace.write"],
        effective_grants: effectiveGrants(),
        message: "Publish this node to the external stable channel?",
        issued_at: "2026-07-12T00:01:00Z",
        expires_at: "2026-07-12T00:06:00Z",
      },
      decision: {
        confirmation_version: 1,
        challenge_id: "challenge-00000001",
        request_id: "req-00000001",
        request_digest: requestDigest,
        decision: "approved",
        actor: { type: "user", id: "user-1" },
        decided_at: "2026-07-12T00:02:00Z",
      },
    },
  };
}

function options(
  source: HomerailPluginToolInvocationV1["source"] = uiActionSource(),
): HomerailPluginToolValidationOptionsV1 {
  return {
    now_ms: Date.parse("2026-07-12T00:03:00Z"),
    expected: {
      source,
      tool: tool(),
      binding: binding(),
      policy: invocation(source).policy,
      request_id: "req-00000001",
      request_digest: requestDigest,
    },
  };
}

function executeRequest(
  source: HomerailPluginToolInvocationV1["source"] = uiActionSource(),
): HomerailPluginRuntimeRpcRequestV1 {
  return {
    runtime_rpc_version: 1,
    message_type: "request",
    method: "execute",
    rpc_id: "rpc-00000001",
    sent_at: "2026-07-12T00:02:02Z",
    params: { authorization: authorization(source) },
  };
}

function executeResult(): HomerailPluginRuntimeRpcResponseV1 {
  return {
    runtime_rpc_version: 1,
    message_type: "result",
    method: "execute",
    rpc_id: "rpc-00000001",
    completed_at: "2026-07-12T00:03:00Z",
    request_id: "req-00000001",
    request_digest: requestDigest,
    binding: binding(),
    output: { type: "domain_output", output: { published: true, release_id: "release-1" } },
    logs: [{
      sequence: 0,
      timestamp: "2026-07-12T00:02:30Z",
      level: "info",
      message: "Published release-1.",
    }],
    artifacts: [{
      id: "release",
      label: "Published release",
      uri: "artifact:release-1",
      media_type: "application/json",
      digest: "e".repeat(64),
      size_bytes: 128,
    }],
  };
}

describe("HomeRail Tool Bus and Runtime RPC V1", () => {
  it("round-trips an exact authorized Tool and execute result", () => {
    const authorized = authorization();
    expect(validateHomerailPluginToolInvocation(authorized.invocation, options())).toMatchObject({ valid: true });
    expect(validateHomerailPluginToolCapabilityClaims(
      authorized.capability,
      authorized.invocation,
      options(),
    )).toMatchObject({ valid: true });
    expect(validateHomerailPluginToolConfirmationChallenge(
      authorized.confirmation?.challenge,
      authorized.invocation,
      options(),
    )).toMatchObject({ valid: true });
    expect(validateHomerailPluginToolConfirmationDecision(
      authorized.confirmation?.decision,
      authorized.invocation,
      authorized.confirmation?.challenge,
    )).toMatchObject({ valid: true });
    expect(validateHomerailPluginAuthorizedToolInvocation(
      JSON.parse(JSON.stringify(authorized)),
      options(),
    )).toMatchObject({ valid: true });
    expect(validateHomerailPluginRuntimeRpcRequest(
      JSON.parse(JSON.stringify(executeRequest())),
      options(),
    )).toMatchObject({ valid: true });
    expect(validateHomerailPluginRuntimeRpcResponse(
      JSON.parse(JSON.stringify(executeResult())),
      options(),
    )).toMatchObject({ valid: true });

    const digestInput = homerailPluginToolInvocationDigestInput(authorized.invocation);
    expect(digestInput).not.toHaveProperty("request_digest");
    expect(digestInput).toMatchObject({
      request_id: "req-00000001",
      source: {
        type: "ui_action",
        target: { node_revision: 4 },
        input_digest: actionInputDigest,
      },
      tool: {
        qualified_id: "com.example.runtime:publish_release",
        handler: { type: "runtime", method: "publish_release" },
      },
      binding: { package_digest: "b".repeat(64), context_digest: "c".repeat(64) },
      policy: {
        effective_grants: effectiveGrants(),
      },
    });
  });

  it("rejects stale target revisions and tampered package/context/request bindings", () => {
    const staleOptions = options();
    staleOptions.expected = {
      ...staleOptions.expected!,
      source: {
        ...uiActionSource(),
        target: { ...target(), node_revision: 5 },
      },
    };
    expect(validateHomerailPluginToolInvocation(invocation(), staleOptions).errors).toContainEqual(
      expect.objectContaining({ path: "/source/target/node_revision", keyword: "staleTarget" }),
    );

    const tampered = authorization();
    tampered.capability.binding.package_digest = "f".repeat(64);
    tampered.capability.binding.context_digest = "0".repeat(64);
    tampered.capability.request_digest = "1".repeat(64);
    expect(validateHomerailPluginAuthorizedToolInvocation(tampered, options()).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/capability/binding/package_digest", keyword: "bindingMismatch" }),
        expect.objectContaining({ path: "/capability/binding/context_digest", keyword: "bindingMismatch" }),
        expect.objectContaining({ path: "/capability/request_digest", keyword: "requestDigest" }),
      ]),
    );

    const unknown = authorization() as unknown as Record<string, unknown>;
    (unknown.capability as Record<string, unknown>).elevated = true;
    expect(validateHomerailPluginAuthorizedToolInvocation(unknown, options()).valid).toBe(false);
  });

  it("binds exact ui_action and agent sources plus the resolved Tool identity", () => {
    const uiTamper = invocation();
    if (uiTamper.source.type !== "ui_action") throw new Error("fixture");
    uiTamper.source.target.node_revision = 5;
    uiTamper.source.action.local_id = "archive";
    uiTamper.source.action.qualified_id = "com.example.runtime:archive";
    uiTamper.source.target.action_id = "archive";
    uiTamper.source.input_digest = "8".repeat(64);
    uiTamper.tool.wire_id = "publishReleaseV2";
    uiTamper.tool.handler = { type: "runtime", method: "publish_release_v2" };
    expect(validateHomerailPluginToolInvocation(uiTamper, options()).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/source/target/node_revision", keyword: "staleTarget" }),
        expect.objectContaining({ path: "/source/target/action_id", keyword: "staleTarget" }),
        expect.objectContaining({ path: "/source/action/local_id", keyword: "actionIdentity" }),
        expect.objectContaining({ path: "/source/action/qualified_id", keyword: "actionIdentity" }),
        expect.objectContaining({ path: "/source/input_digest", keyword: "requestDigest" }),
        expect.objectContaining({ path: "/tool/wire_id", keyword: "toolIdentity" }),
        expect.objectContaining({ path: "/tool/handler", keyword: "handlerIdentity" }),
      ]),
    );

    const expectedAgentSource = agentSource();
    expect(validateHomerailPluginToolInvocation(
      invocation(expectedAgentSource),
      options(expectedAgentSource),
    )).toMatchObject({ valid: true });
    expect(validateHomerailPluginRuntimeRpcRequest(
      executeRequest(expectedAgentSource),
      options(expectedAgentSource),
    )).toMatchObject({ valid: true });

    const agentTamper = invocation(agentSource());
    if (agentTamper.source.type !== "agent") throw new Error("fixture");
    agentTamper.source.call_id = "call-00000002";
    agentTamper.source.modality = "text";
    agentTamper.source.scope.id = "voice-session-2";
    agentTamper.source.target.base_revision = 8;
    expect(validateHomerailPluginToolInvocation(
      agentTamper,
      options(expectedAgentSource),
    ).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/source/call_id", keyword: "sourceIdentity" }),
      expect.objectContaining({ path: "/source/modality", keyword: "sourceIdentity" }),
      expect.objectContaining({ path: "/source/scope", keyword: "scopeIdentity" }),
      expect.objectContaining({ path: "/source/target", keyword: "staleTarget" }),
    ]));

    expect(validateHomerailPluginToolInvocation(
      invocation(uiActionSource()),
      options(expectedAgentSource),
    ).errors).toContainEqual(
      expect.objectContaining({ path: "/source/type", keyword: "sourceIdentity" }),
    );
  });

  it("enforces expiration, single use, and bounded request lifetimes", () => {
    const expiredOptions = options();
    expiredOptions.now_ms = Date.parse("2026-07-12T00:07:00Z");
    expect(validateHomerailPluginAuthorizedToolInvocation(
      authorization(),
      expiredOptions,
    ).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/capability/expires_at", keyword: "capabilityExpired" }),
      expect.objectContaining({ path: "/confirmation/challenge/expires_at", keyword: "confirmationExpired" }),
    ]));

    const replayOptions = options();
    replayOptions.consumed_capability_nonces = new Set(["nonce-00000001"]);
    expect(validateHomerailPluginAuthorizedToolInvocation(
      authorization(),
      replayOptions,
    ).errors).toContainEqual(expect.objectContaining({ keyword: "capabilityReplay" }));

    const longLived = authorization();
    longLived.capability.expires_at = "2026-07-12T00:09:00Z";
    expect(validateHomerailPluginAuthorizedToolInvocation(
      longLived,
      options(),
    ).errors).toContainEqual(expect.objectContaining({ keyword: "capabilityLifetime" }));

    const staleRequestOptions = options();
    staleRequestOptions.now_ms = Date.parse("2026-07-12T00:11:00Z");
    expect(validateHomerailPluginToolInvocation(
      invocation(),
      staleRequestOptions,
    ).errors).toContainEqual(expect.objectContaining({ keyword: "staleRequest" }));

    const sentAfterCapability = executeRequest();
    sentAfterCapability.sent_at = "2026-07-12T00:05:00Z";
    expect(validateHomerailPluginRuntimeRpcRequest(
      sentAfterCapability,
      options(),
    ).errors).toContainEqual(expect.objectContaining({ path: "/sent_at", keyword: "timestampOrder" }));
  });

  it("rejects permission/effect escalation and non-exact confirmation decisions", () => {
    const escalated = authorization();
    escalated.capability.permissions = ["network.connect", "secret.use", "workspace.write"];
    escalated.capability.effect = "destructive";
    expect(validateHomerailPluginAuthorizedToolInvocation(escalated, options()).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "permissionEscalation" }),
        expect.objectContaining({ keyword: "effectEscalation" }),
      ]),
    );

    const rewrittenPolicy = authorization();
    rewrittenPolicy.invocation.policy.permissions = ["network.connect", "secret.use", "workspace.write"];
    rewrittenPolicy.invocation.policy.effective_grants = [
      effectiveGrants()[0],
      { permission: "secret.use" },
      effectiveGrants()[1],
    ];
    rewrittenPolicy.capability.permissions = ["network.connect", "secret.use", "workspace.write"];
    rewrittenPolicy.capability.effective_grants = structuredClone(
      rewrittenPolicy.invocation.policy.effective_grants,
    );
    expect(validateHomerailPluginAuthorizedToolInvocation(
      rewrittenPolicy,
      options(),
    ).errors).toContainEqual(expect.objectContaining({
      path: "/invocation/policy/permissions",
      keyword: "permissionEscalation",
    }));

    const confirmationDowngrade = authorization();
    confirmationDowngrade.invocation.policy.confirmation = "never";
    confirmationDowngrade.invocation.policy.confirmation_required = false;
    delete confirmationDowngrade.confirmation;
    expect(validateHomerailPluginAuthorizedToolInvocation(
      confirmationDowngrade,
      options(),
    ).errors).toContainEqual(expect.objectContaining({ keyword: "confirmationPolicy" }));

    const denied = authorization();
    denied.confirmation!.decision.decision = "denied";
    expect(validateHomerailPluginAuthorizedToolInvocation(denied, options()).errors).toContainEqual(
      expect.objectContaining({ keyword: "confirmationDenied" }),
    );

    const swapped = authorization();
    swapped.confirmation!.challenge.request_digest = "2".repeat(64);
    swapped.confirmation!.decision.challenge_id = "challenge-00000002";
    expect(validateHomerailPluginAuthorizedToolInvocation(swapped, options()).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/confirmation/challenge/request_digest", keyword: "requestDigest" }),
        expect.objectContaining({ path: "/confirmation/decision/challenge_id", keyword: "challengeIdentity" }),
      ]),
    );
  });

  it("binds exact effective path/host grants through policy, confirmation, capability, and RPC", () => {
    const widenedCapability = authorization();
    widenedCapability.capability.effective_grants[0].hosts!.push("z.evil.example");
    expect(validateHomerailPluginAuthorizedToolInvocation(
      widenedCapability,
      options(),
    ).errors).toContainEqual(expect.objectContaining({
      path: "/capability/effective_grants",
      keyword: "permissionEscalation",
    }));

    const rewrittenConfirmation = authorization();
    rewrittenConfirmation.confirmation!.challenge.effective_grants[1].paths = ["/workspace"];
    expect(validateHomerailPluginAuthorizedToolInvocation(
      rewrittenConfirmation,
      options(),
    ).errors).toContainEqual(expect.objectContaining({
      path: "/confirmation/challenge/effective_grants",
      keyword: "permissionEscalation",
    }));

    const rewrittenPolicy = authorization();
    rewrittenPolicy.invocation.policy.effective_grants[1].paths = ["/workspace"];
    rewrittenPolicy.capability.effective_grants[1].paths = ["/workspace"];
    rewrittenPolicy.confirmation!.challenge.effective_grants[1].paths = ["/workspace"];
    expect(validateHomerailPluginAuthorizedToolInvocation(
      rewrittenPolicy,
      options(),
    ).errors).toContainEqual(expect.objectContaining({
      path: "/invocation/policy/effective_grants",
      keyword: "permissionEscalation",
    }));

    const rpcTamper = executeRequest();
    rpcTamper.params.authorization.capability.effective_grants[0].hosts = ["evil.example"];
    expect(validateHomerailPluginRuntimeRpcRequest(rpcTamper, options()).errors).toContainEqual(
      expect.objectContaining({
        path: "/params/authorization/capability/effective_grants",
        keyword: "permissionEscalation",
      }),
    );
  });

  it("rejects non-canonical, mismatched, and invalid effective grant scopes", () => {
    const mismatchedIndex = invocation();
    mismatchedIndex.policy.effective_grants = [effectiveGrants()[0]];
    expect(validateHomerailPluginToolInvocation(mismatchedIndex, options()).errors).toContainEqual(
      expect.objectContaining({ path: "/policy/effective_grants", keyword: "permissionEscalation" }),
    );

    const nonCanonical = invocation();
    nonCanonical.policy.effective_grants[0].hosts = ["uploads.example.com:443", "api.example.com"];
    expect(validateHomerailPluginToolInvocation(nonCanonical, options()).errors).toContainEqual(
      expect.objectContaining({
        path: "/policy/effective_grants/0/hosts",
        keyword: "canonicalOrder",
      }),
    );

    const invalidHost = invocation();
    invalidHost.policy.effective_grants[0].hosts = ["API.EXAMPLE.COM"];
    expect(validateHomerailPluginToolInvocation(invalidHost, options()).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/policy/effective_grants/0/hosts/0",
          keyword: "pattern",
        }),
      ]),
    );

    const invalidPath = invocation();
    invalidPath.policy.effective_grants[1].paths = ["/workspace/../secrets"];
    expect(validateHomerailPluginToolInvocation(
      invalidPath,
      { ...options(), expected: undefined },
    ).errors).toContainEqual(expect.objectContaining({
      path: "/policy/effective_grants/1/paths/0",
      keyword: "permissionScope",
    }));

    const missingNetworkScope = invocation();
    delete missingNetworkScope.policy.effective_grants[0].hosts;
    expect(validateHomerailPluginToolInvocation(
      missingNetworkScope,
      { ...options(), expected: undefined },
    ).errors).toContainEqual(expect.objectContaining({
      path: "/policy/effective_grants/0/hosts",
      keyword: "networkAllowlist",
    }));

    const invalidPermissionScope = invocation();
    invalidPermissionScope.policy.permissions = ["network.connect", "secret.use"];
    invalidPermissionScope.policy.effective_grants = [
      effectiveGrants()[0],
      { permission: "secret.use", hosts: ["secrets.example.com"] },
    ];
    expect(validateHomerailPluginToolInvocation(
      invalidPermissionScope,
      { ...options(), expected: undefined },
    ).errors).toContainEqual(expect.objectContaining({
      path: "/policy/effective_grants/1/hosts",
      keyword: "permissionScope",
    }));
  });

  it("requires effective grants in every authorization layer", () => {
    const missingPolicy = invocation() as unknown as Record<string, unknown>;
    delete (missingPolicy.policy as Record<string, unknown>).effective_grants;
    expect(validateHomerailPluginToolInvocation(missingPolicy, options()).errors).toContainEqual(
      expect.objectContaining({ path: "/policy", keyword: "required" }),
    );

    const missingCapability = authorization() as unknown as Record<string, unknown>;
    delete (missingCapability.capability as Record<string, unknown>).effective_grants;
    expect(validateHomerailPluginAuthorizedToolInvocation(missingCapability, options()).errors).toContainEqual(
      expect.objectContaining({ path: "/capability", keyword: "required" }),
    );

    const missingChallenge = authorization() as unknown as Record<string, unknown>;
    const confirmation = missingChallenge.confirmation as Record<string, unknown>;
    delete (confirmation.challenge as Record<string, unknown>).effective_grants;
    expect(validateHomerailPluginAuthorizedToolInvocation(missingChallenge, options()).errors).toContainEqual(
      expect.objectContaining({ path: "/confirmation/challenge", keyword: "required" }),
    );
  });

  it("distinguishes a true idempotent replay from an idempotency collision", () => {
    const records = new Map([[
      "idem-00000001",
      { request_id: "req-00000001", request_digest: requestDigest },
    ]]);
    expect(validateHomerailPluginToolInvocation(invocation(), {
      ...options(),
      idempotency_records: records,
    })).toMatchObject({ valid: true });

    records.set("idem-00000001", {
      request_id: "req-00000000",
      request_digest: "0".repeat(64),
    });
    expect(validateHomerailPluginToolInvocation(invocation(), {
      ...options(),
      idempotency_records: records,
    }).errors).toContainEqual(expect.objectContaining({ keyword: "idempotencyCollision" }));
  });

  it("validates cancel/health request-result-error envelopes", () => {
    const cancel: HomerailPluginRuntimeRpcRequestV1 = {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "cancel",
      rpc_id: "rpc-00000002",
      sent_at: "2026-07-12T00:03:00Z",
      params: {
        request_id: "req-00000001",
        request_digest: requestDigest,
        reason: "user",
      },
    };
    const health: HomerailPluginRuntimeRpcRequestV1 = {
      runtime_rpc_version: 1,
      message_type: "request",
      method: "health",
      rpc_id: "rpc-00000003",
      sent_at: "2026-07-12T00:03:00Z",
      params: { binding: binding() },
    };
    expect(validateHomerailPluginRuntimeRpcRequest(cancel, options())).toMatchObject({ valid: true });
    expect(validateHomerailPluginRuntimeRpcRequest(health, options())).toMatchObject({ valid: true });

    const cancelResult: HomerailPluginRuntimeRpcResponseV1 = {
      runtime_rpc_version: 1,
      message_type: "result",
      method: "cancel",
      rpc_id: "rpc-00000002",
      completed_at: "2026-07-12T00:03:01Z",
      request_id: "req-00000001",
      request_digest: requestDigest,
      status: "accepted",
      logs: [],
      artifacts: [],
    };
    const healthResult: HomerailPluginRuntimeRpcResponseV1 = {
      runtime_rpc_version: 1,
      message_type: "result",
      method: "health",
      rpc_id: "rpc-00000003",
      completed_at: "2026-07-12T00:03:01Z",
      binding: binding(),
      status: "ready",
      runtime_api: 1,
      started_at: "2026-07-12T00:00:00Z",
      active_requests: 1,
      logs: [],
      artifacts: [],
    };
    const executeError: HomerailPluginRuntimeRpcResponseV1 = {
      runtime_rpc_version: 1,
      message_type: "error",
      method: "execute",
      rpc_id: "rpc-00000001",
      completed_at: "2026-07-12T00:03:01Z",
      request_id: "req-00000001",
      request_digest: requestDigest,
      error: { code: "runtime_unavailable", message: "Runtime stopped.", retryable: true },
      logs: [],
      artifacts: [],
    };
    expect(validateHomerailPluginRuntimeRpcResponse(cancelResult, options())).toMatchObject({ valid: true });
    expect(validateHomerailPluginRuntimeRpcResponse(healthResult, options())).toMatchObject({ valid: true });
    expect(validateHomerailPluginRuntimeRpcResponse(executeError, options())).toMatchObject({ valid: true });

    const healthError: HomerailPluginRuntimeRpcResponseV1 = {
      runtime_rpc_version: 1,
      message_type: "error",
      method: "health",
      rpc_id: "rpc-00000003",
      completed_at: "2026-07-12T00:03:01Z",
      binding: binding(),
      error: { code: "runtime_unavailable", message: "Runtime stopped.", retryable: true },
      logs: [],
      artifacts: [],
    };
    expect(validateHomerailPluginRuntimeRpcResponse(healthError, options())).toMatchObject({ valid: true });

    const healthWithRequest = {
      ...executeError,
      method: "health",
    };
    expect(validateHomerailPluginRuntimeRpcResponse(healthWithRequest, options()).errors).toContainEqual(
      expect.objectContaining({ keyword: "requestIdentity" }),
    );
  });

  it("accepts a plugin-owned UI transaction and rejects mismatched transaction identity", () => {
    const result = executeResult();
    if (result.message_type !== "result" || result.method !== "execute") throw new Error("fixture");
    result.output = {
      type: "ui_transaction",
      transaction: {
        ir_version: 1,
        transaction_id: "req-00000001",
        document_id: "document-1",
        base_revision: 9,
        actor: {
          type: "plugin",
          id: "com.example.runtime:publish_release",
          plugin: { id: "com.example.runtime", version: "1.2.3" },
        },
        operations: [{
          op: "remove",
          node_id: "com.example.runtime:obsolete",
          if_revision: 1,
        }],
        created_at: "2026-07-12T00:02:30Z",
      },
    };
    expect(validateHomerailPluginRuntimeRpcResponse(result, options())).toMatchObject({ valid: true });

    if (result.output.type !== "ui_transaction") throw new Error("fixture");
    result.output.transaction.transaction_id = "req-00000002";
    result.output.transaction.base_revision = 8;
    result.output.transaction.actor.plugin = { id: "com.example.other", version: "1.2.3" };
    expect(validateHomerailPluginRuntimeRpcResponse(result, options()).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "requestIdentity" }),
        expect.objectContaining({ keyword: "staleTarget" }),
        expect.objectContaining({ keyword: "bindingMismatch" }),
      ]),
    );
  });

  it("rejects malformed bounds, unsafe artifacts, and unknown envelope fields", () => {
    const oversizedArguments = invocation();
    oversizedArguments.arguments = { value: "x".repeat(33 * 1024) };
    expect(validateHomerailPluginToolInvocation(oversizedArguments, options()).errors).toContainEqual(
      expect.objectContaining({ keyword: "maxPayloadBytes" }),
    );

    const oversizedOutput = executeResult();
    if (oversizedOutput.message_type !== "result" || oversizedOutput.method !== "execute") {
      throw new Error("fixture");
    }
    oversizedOutput.output = { type: "domain_output", output: { value: "x".repeat(257 * 1024) } };
    expect(validateHomerailPluginRuntimeRpcResponse(oversizedOutput, options()).errors).toContainEqual(
      expect.objectContaining({ keyword: "maxPayloadBytes" }),
    );

    const unsafe = executeResult();
    unsafe.artifacts[0]!.uri = "javascript:alert(1)";
    expect(validateHomerailPluginRuntimeRpcResponse(unsafe, options()).errors).toContainEqual(
      expect.objectContaining({ path: "/artifacts/0/uri", keyword: "artifactUri" }),
    );

    const tooManyLogs = executeResult();
    tooManyLogs.logs = Array.from({ length: 129 }, (_, sequence) => ({
      sequence,
      timestamp: "2026-07-12T00:02:30Z",
      level: "info" as const,
      message: "bounded",
    }));
    expect(validateHomerailPluginRuntimeRpcResponse(tooManyLogs, options()).valid).toBe(false);

    const unknown = executeRequest() as unknown as Record<string, unknown>;
    (unknown.params as Record<string, unknown>).debug = true;
    expect(validateHomerailPluginRuntimeRpcRequest(unknown, options()).valid).toBe(false);

    const malformed = executeRequest();
    malformed.sent_at = "2026-02-30T00:00:00Z";
    expect(validateHomerailPluginRuntimeRpcRequest(malformed, options()).errors).toContainEqual(
      expect.objectContaining({ path: "/sent_at", keyword: "date-time" }),
    );
  });
});
