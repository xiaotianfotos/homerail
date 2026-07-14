#!/usr/bin/env node

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.byteLength);
  return chunk;
}

function fakeGpuPng(input) {
  const { prompt, width, height, style } = normalizeArguments(input);
  const seed = createHash("sha256").update(`${style}\0${prompt}`, "utf8").digest();
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      const rail = Math.abs(y - Math.round(height * 0.68)) <= 1
        || Math.abs(y - Math.round(height * 0.82)) <= 1;
      const glow = Math.max(0, 1 - Math.hypot(x - width * 0.72, y - height * 0.28) / (width * 0.42));
      raw[pixel] = rail ? 230 : Math.min(255, seed[0] + Math.round(glow * 90) + x % 17);
      raw[pixel + 1] = rail ? 235 : Math.min(255, seed[7] + Math.round(glow * 65) + y % 19);
      raw[pixel + 2] = rail ? 245 : Math.min(255, seed[15] + Math.round(glow * 35));
      raw[pixel + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function normalizeArguments(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("arguments must be an object");
  const keys = Object.keys(raw).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["height", "prompt", "style", "width"])) {
    throw new Error("arguments must use the closed video-cover schema");
  }
  if (typeof raw.prompt !== "string" || !raw.prompt.trim() || Buffer.byteLength(raw.prompt, "utf8") > 1000) {
    throw new Error("prompt is invalid");
  }
  if (!Number.isInteger(raw.width) || raw.width < 16 || raw.width > 640
    || !Number.isInteger(raw.height) || raw.height < 16 || raw.height > 640) {
    throw new Error("cover dimensions are invalid");
  }
  if (!["cinematic", "editorial", "minimal"].includes(raw.style)) throw new Error("style is invalid");
  return { prompt: raw.prompt, width: raw.width, height: raw.height, style: raw.style };
}

function generateArtifacts(rawArguments) {
  const args = normalizeArguments(rawArguments);
  const png = fakeGpuPng(args);
  const pngDigest = sha256(png);
  const provenance = Buffer.from(`${JSON.stringify({
    fixture_version: 1,
    generator: "com.homerail.video-cover/fake-gpu",
    prompt: args.prompt,
    width: args.width,
    height: args.height,
    style: args.style,
    cover: {
      uri: `artifact:sha256/${pngDigest}`,
      media_type: "image/png",
      digest: pngDigest,
      size_bytes: png.byteLength,
    },
  }, null, 2)}\n`, "utf8");
  return [{
    id: "cover",
    label: "Generated video cover",
    media_type: "image/png",
    digest: pngDigest,
    size_bytes: png.byteLength,
    content: png,
  }, {
    id: "metadata",
    label: "Video cover provenance",
    media_type: "application/json",
    digest: sha256(provenance),
    size_bytes: provenance.byteLength,
    content: provenance,
  }];
}

function publicPlan(artifact) {
  const { content: _content, ...declaration } = artifact;
  return declaration;
}

function passiveArtifact(artifact) {
  return {
    id: artifact.id,
    label: artifact.label,
    uri: `artifact:sha256/${artifact.digest}`,
    media_type: artifact.media_type,
    digest: artifact.digest,
    size_bytes: artifact.size_bytes,
  };
}

function exactDeclaration(artifact) {
  return {
    id: artifact.id,
    label: artifact.label,
    media_type: artifact.media_type,
    digest: artifact.digest,
    size_bytes: artifact.size_bytes,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw || "{}");
}

async function uploadFixture(input) {
  const artifacts = generateArtifacts(input.arguments);
  if (!Array.isArray(input.uploads) || input.uploads.length !== artifacts.length) {
    throw new Error("fixture requires one broker upload capability per artifact");
  }
  const published = [];
  for (const artifact of artifacts) {
    const upload = input.uploads.find((entry) => entry?.id === artifact.id);
    if (!upload || typeof upload.upload_url !== "string" || typeof upload.token !== "string") {
      throw new Error(`missing broker capability for ${artifact.id}`);
    }
    if (typeof upload.capability_id !== "string" || !upload.upload_url.endsWith(`/${encodeURIComponent(upload.capability_id)}`)) {
      throw new Error(`broker upload URL is not bound to ${artifact.id}`);
    }
    const response = await fetch(upload.upload_url, {
      method: "PUT",
      headers: {
        Authorization: `HomerailArtifact ${upload.token}`,
        "Content-Type": artifact.media_type,
      },
      body: artifact.content,
    });
    const envelope = await response.json();
    if (!response.ok || envelope?.data?.digest !== artifact.digest
      || envelope?.data?.size_bytes !== artifact.size_bytes
      || envelope?.data?.media_type !== artifact.media_type) {
      throw new Error(`Artifact Broker rejected ${artifact.id}: ${JSON.stringify(envelope)}`);
    }
    published.push({ id: artifact.id, ...envelope.data });
  }
  return {
    runtime_fixture_version: 1,
    gpu: { backend: "fake", device: "fake-gpu:0", verified: true },
    output: { artifacts: published.map(({ id, label, uri, media_type, digest, size_bytes }) => ({
      id, label, uri, media_type, digest, size_bytes,
    })) },
  };
}

function runEntrypointAbi(input) {
  if (input?.entrypoint_api_version !== 1 || typeof input.phase !== "string") {
    throw new Error("entrypoint ABI envelope is invalid");
  }
  const artifacts = generateArtifacts(input.arguments);
  if (input.phase === "prepare") {
    return {
      entrypoint_api_version: 1,
      phase: "prepare",
      artifact_declarations: artifacts.map(exactDeclaration),
      logs: [],
    };
  }
  if (input.phase !== "execute") throw new Error("entrypoint ABI phase is invalid");
  const expected = artifacts.map(exactDeclaration);
  if (JSON.stringify(input.artifact_declarations) !== JSON.stringify(expected)) {
    throw new Error("execute artifact declarations differ from the pure prepare phase");
  }
  const passive = artifacts.map(passiveArtifact);
  return {
    entrypoint_api_version: 1,
    phase: "execute",
    output: { type: "domain_output", output: { artifacts: passive } },
    artifacts: passive,
    broker_writes: artifacts.map((artifact) => ({
      id: artifact.id,
      media_type: artifact.media_type,
      digest: artifact.digest,
      size_bytes: artifact.size_bytes,
      content_base64: artifact.content.toString("base64"),
    })),
    logs: [],
  };
}

async function main() {
  const mode = process.argv[2];
  const input = await readStdin();
  if (mode === "--fixture-plan") {
    process.stdout.write(`${JSON.stringify({
      runtime_fixture_version: 1,
      gpu: { backend: "fake", device: "fake-gpu:0", verified: true },
      artifacts: generateArtifacts(input.arguments).map(publicPlan),
    })}\n`);
    return;
  }
  if (mode === "--stdio" && input?.entrypoint_api_version === 1) {
    process.stdout.write(`${JSON.stringify(runEntrypointAbi(input))}\n`);
    return;
  }
  if (mode === "--fixture" || mode === "--stdio") {
    process.stdout.write(`${JSON.stringify(await uploadFixture(input))}\n`);
    return;
  }
  throw new Error("expected --fixture-plan, --fixture, or --stdio");
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
});
