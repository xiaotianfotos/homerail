import { describe, expect, it } from "vitest";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";

describe("parseDAGYaml image defaults", () => {
  it("leaves node image unset when the YAML does not explicitly configure one", () => {
    const parsed = parseDAGYaml(`
name: image-default
agents:
  worker:
    system: HANDOFF port=done content=ok
nodes:
  first:
    agent: worker
    outputs:
      done:
        to: ""
`);

    expect(parsed.graph.nodes[0]?.image).toBeUndefined();
  });

  it("applies a root image when configured", () => {
    const parsed = parseDAGYaml(`
name: image-default
image: homerail-worker:custom
agents:
  worker:
    system: HANDOFF port=done content=ok
nodes:
  first:
    agent: worker
    outputs:
      done:
        to: ""
`);

    expect(parsed.graph.nodes[0]?.image).toBe("homerail-worker:custom");
  });

  it("classifies all supported runtime gateway types without agent image defaults", () => {
    const parsed = parseDAGYaml(`
name: gateway-types
image: homerail-worker:custom
nodes:
  actor: { agent: worker }
  command: { type: command_gateway }
  approval: { type: approval_gateway }
  state: { type: state_gateway }
  fanout: { type: fanout_gateway }
  suspend:
    type: await_command
    gateway_config:
      primitive_version: 1
      target_actors: [actor]
`);
    const nodes = Object.fromEntries(parsed.graph.nodes.map((node) => [node.node_id, node]));

    expect(nodes.actor).toMatchObject({ node_type: "agent", agent: "worker", image: "homerail-worker:custom" });
    for (const nodeId of ["command", "approval", "state", "fanout", "suspend"]) {
      expect(nodes[nodeId]?.agent).toBe("__gateway__");
      expect(nodes[nodeId]?.image).toBeUndefined();
    }
    expect(nodes.suspend?.node_type).toBe("await_command_gateway");
  });
});
