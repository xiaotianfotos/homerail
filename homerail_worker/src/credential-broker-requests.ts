import type {
  DagCredentialBrokerCallRequest,
  DagCredentialBrokerCallResult,
} from "homerail-protocol";
import {
  dagCredentialBrokerCallIdentity,
  matchesDagCredentialBrokerCallIdentity,
} from "homerail-protocol";

type PendingRequest = {
  request: DagCredentialBrokerCallRequest;
  resolve: (result: DagCredentialBrokerCallResult) => void;
  removeAbortListener?: () => void;
};

/**
 * Tracks Manager-broker requests for the lifetime of the Worker connection.
 *
 * Broker actions can legitimately take longer than an arbitrary local timer
 * (for example, an atomic GitHub commit that uploads many blobs). The Manager
 * owns action completion and durable receipts, so the Worker waits for the
 * matching result or connection shutdown instead of inventing a timeout.
 */
export class CredentialBrokerRequestRegistry {
  private readonly pending = new Map<string, PendingRequest>();

  call(
    request: DagCredentialBrokerCallRequest,
    send: (payload: string) => void,
    signal?: AbortSignal,
  ): Promise<DagCredentialBrokerCallResult> {
    return new Promise((resolve) => {
      if (this.pending.has(request.request_id)) {
        resolve({
          request_id: request.request_id,
          identity: dagCredentialBrokerCallIdentity(request),
          ok: false,
          outcome: "failed_pre_dispatch",
          error: "Duplicate credential broker request id",
        });
        return;
      }
      if (signal?.aborted) {
        resolve({
          request_id: request.request_id,
          identity: dagCredentialBrokerCallIdentity(request),
          ok: false,
          outcome: "cancelled",
          error: "Credential broker request cancelled before dispatch",
        });
        return;
      }
      const pending: PendingRequest = { request: structuredClone(request), resolve };
      if (signal) {
        const onAbort = () => {
          try {
            const {
              request_id,
              idempotency_key,
              transport_kind,
              run_id,
              node_id,
              session_id,
              round_id,
              actor_id,
              generation,
              lease_generation,
              command_id,
            } = request;
            send(JSON.stringify({
              type: "credential_broker_cancel",
              data: {
                request_id,
                idempotency_key,
                transport_kind,
                run_id,
                node_id,
                session_id,
                round_id,
                actor_id,
                generation,
                lease_generation,
                ...(command_id ? { command_id } : {}),
              },
            }));
          } catch {
            // The operation was already dispatched, so a send failure cannot
            // make its provider outcome safe to assume.
          } finally {
            if (this.pending.get(request.request_id) === pending) {
              this.pending.delete(request.request_id);
              pending.removeAbortListener?.();
              resolve({
                request_id: request.request_id,
                identity: dagCredentialBrokerCallIdentity(request),
                ok: false,
                outcome: "indeterminate",
                error: "Credential broker caller cancelled; Manager reconciliation continues",
              });
            }
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(request.request_id, pending);
      try {
        send(JSON.stringify({ type: "credential_broker_call", data: request }));
      } catch {
        this.pending.delete(request.request_id);
        pending.removeAbortListener?.();
        resolve({
          request_id: request.request_id,
          identity: dagCredentialBrokerCallIdentity(request),
          ok: false,
          outcome: "failed_pre_dispatch",
          error: "Credential broker request could not be sent",
        });
      }
    });
  }

  settle(result: DagCredentialBrokerCallResult): boolean {
    const pending = this.pending.get(result.request_id);
    if (!pending || !matchesDagCredentialBrokerCallIdentity(pending.request, result.identity)) return false;
    this.pending.delete(result.request_id);
    pending.removeAbortListener?.();
    pending.resolve(result);
    return true;
  }

  close(error = "Worker shutting down"): void {
    for (const [requestId, pending] of this.pending) {
      pending.removeAbortListener?.();
      pending.resolve({
        request_id: requestId,
        identity: dagCredentialBrokerCallIdentity(pending.request),
        ok: false,
        outcome: "indeterminate",
        error,
      });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
