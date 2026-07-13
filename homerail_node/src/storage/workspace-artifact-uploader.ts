import * as fs from "node:fs";
import { createWorkspaceArtifactArchive, type WorkspaceArtifactArchiveRequest } from "./workspace-artifact.js";

export interface WorkspaceArtifactUploadSpec extends WorkspaceArtifactArchiveRequest {
  media_type: "application/gzip";
  upload_url: string;
  upload_token: string;
}

export interface WorkspaceArtifactUploadResult {
  sha256: string;
  size_bytes: number;
  uncompressed_bytes: number;
  file_count: number;
  entry_count: number;
}

function managerHttpBase(managerUrl: string): URL {
  const url = new URL(managerUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw new Error(`unsupported Manager WebSocket protocol: ${url.protocol}`);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function createWorkspaceArtifactUploader(
  managerUrl: string,
): (spec: WorkspaceArtifactUploadSpec) => Promise<WorkspaceArtifactUploadResult> {
  const base = managerHttpBase(managerUrl);
  return async (spec) => {
    if (!spec.upload_url.startsWith("/api/runs/") || spec.upload_url.startsWith("//")) {
      throw new Error("artifact upload_url must be a Manager run API path");
    }
    if (!spec.upload_token) throw new Error("artifact upload_token is required");
    const archive = await createWorkspaceArtifactArchive(spec);
    try {
      const response = await fetch(new URL(spec.upload_url, base), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${spec.upload_token}`,
          "Content-Type": spec.media_type,
          "Content-Length": String(archive.size_bytes),
          "X-Homerail-Artifact-Sha256": archive.sha256,
          "X-Homerail-Artifact-Uncompressed-Bytes": String(archive.uncompressed_bytes),
          "X-Homerail-Artifact-File-Count": String(archive.file_count),
        },
        body: fs.createReadStream(archive.path),
        duplex: "half",
      } as unknown as RequestInit & { duplex: "half" });
      if (!response.ok) {
        const details = (await response.text()).slice(0, 4_096);
        throw new Error(`Manager artifact upload failed (${response.status}): ${details}`);
      }
      return {
        sha256: archive.sha256,
        size_bytes: archive.size_bytes,
        uncompressed_bytes: archive.uncompressed_bytes,
        file_count: archive.file_count,
        entry_count: archive.entry_count,
      };
    } finally {
      fs.rmSync(archive.path, { force: true });
    }
  };
}
