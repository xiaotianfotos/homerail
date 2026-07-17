import { describe, expect, it } from "vitest";

import { resolveLocalNodeManagerWsUrl } from "../src/server/local-docker-node.js";

describe("managed local Docker Node", () => {
  it("uses the local Manager URL instead of a Docker-rewritten URL", () => {
    expect(resolveLocalNodeManagerWsUrl({
      managerRestUrl: "http://host.docker.internal:19191/api",
      localManagerUrl: "http://127.0.0.1:19191/api",
    })).toBe("ws://127.0.0.1:19191");
  });

  it("keeps managerRestUrl as the compatibility fallback", () => {
    expect(resolveLocalNodeManagerWsUrl({
      managerRestUrl: "http://127.0.0.1:29191/api",
    })).toBe("ws://127.0.0.1:29191");
  });
});
