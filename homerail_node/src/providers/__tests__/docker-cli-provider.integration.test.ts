import { afterEach, describe, expect, it } from "vitest";

import { DockerCliProvider } from "../docker-cli-provider.js";

describe("DockerCliProvider (integration, real Docker)", () => {
  const provider = new DockerCliProvider();
  let containerId: string | null = null;

  afterEach(async () => {
    if (!containerId) return;
    await provider.remove(containerId).catch(() => undefined);
    containerId = null;
  });

  it.runIf(process.env["DOCKER_TEST"] === "1")(
    "completes the container lifecycle",
    async () => {
      const created = await provider.create({
        image: "node:22-alpine",
        name: `homerail-smoke-test-${process.pid}`,
        command: [
          "/bin/sh",
          "-c",
          "while true; do sleep 3600; done",
        ],
      });
      expect(created.status).toBe("created");
      containerId = created.id;

      await provider.start(containerId);

      const result = await provider.exec(containerId, [
        "node",
        "-e",
        "console.log('ok')",
      ]);
      expect(result.stdout.trim()).toBe("ok");
      expect(result.exitCode).toBe(0);

      await provider.stop(containerId);
      await provider.remove(containerId);
      containerId = null;
    },
    60_000,
  );
});
