# Video Cover M6 vertical slice

This example is the first executable Plugin vertical slice. Its Skill and Manifest select a sandboxed GPU Runtime Tool with exact `gpu.use` and `artifact.write` grants. The Runtime never receives a host path: it receives one single-use Artifact Broker capability for each exact digest, byte length, MIME type, plugin package, Tool request, and document scope.

`runtime/fake-gpu-runtime.mjs` is deterministic and model-free. `--fixture-plan` declares the exact PNG and JSON artifacts, and `--fixture` uploads those bytes through the real Manager HTTP broker. The Manager tests use both modes to verify the end-to-end contract without requiring a physical GPU or model download.
