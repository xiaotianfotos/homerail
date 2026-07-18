import type { Command } from "commander";
import { getClient, type BaseResponse } from "../index.js";

interface GlobalOpts {
  baseUrl?: string;
  json?: boolean;
  requestTimeout?: number;
}

interface CredentialRecord {
  id: string;
  credential_type: string;
  name: string;
  status: string;
  version: number;
  secret_fields: string[];
  expires_at?: string;
}

interface CredentialResponse extends BaseResponse {
  data?: { credential?: CredentialRecord; credentials?: CredentialRecord[]; events?: unknown[] };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf8");
  if (!value) throw new Error("Credential stdin is empty");
  return value;
}

async function readSecret(opts: { field?: string; jsonStdin?: boolean }): Promise<Record<string, string>> {
  const value = await readStdin();
  if (!opts.jsonStdin) return { [opts.field ?? "value"]: value.replace(/\r?\n$/, "") };
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--json-stdin requires one JSON object");
  }
  const entries = Object.entries(parsed);
  if (!entries.every(([, secret]) => typeof secret === "string")) {
    throw new Error("Every --json-stdin credential field must be a string");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function output(globalOpts: GlobalOpts, value: unknown): void {
  console.log(JSON.stringify(value, null, globalOpts.json ? 2 : 0));
}

function printCredential(record: CredentialRecord): void {
  console.log(`${record.id}\t${record.credential_type}\t${record.status}\tv${record.version}\t${record.secret_fields.join(",")}`);
}

export function registerCredentialCommand(program: Command): void {
  const credential = program.command("credential").description("Manage encrypted execution credentials");

  credential.command("list").action(async () => {
    const globalOpts = program.opts<GlobalOpts>();
    const response = await getClient(globalOpts).get<CredentialResponse>("/api/credentials");
    if (globalOpts.json) output(globalOpts, response);
    else for (const record of response.data?.credentials ?? []) printCredential(record);
  });

  credential.command("show <id>").action(async (id: string) => {
    const globalOpts = program.opts<GlobalOpts>();
    const response = await getClient(globalOpts).get<CredentialResponse>(`/api/credentials/${encodeURIComponent(id)}`);
    if (globalOpts.json) output(globalOpts, response);
    else if (response.data?.credential) printCredential(response.data.credential);
  });

  credential.command("set <id>")
    .requiredOption("--type <type>", "api_key, oauth_token, bot, ssh_key, certificate, or opaque")
    .requiredOption("--name <name>", "Display name")
    .option("--field <name>", "Secret field for raw stdin", "value")
    .option("--json-stdin", "Read a JSON object of secret fields from stdin")
    .option("--expires-at <timestamp>", "RFC3339 expiration time")
    .action(async (id: string, opts: {
      type: string;
      name: string;
      field?: string;
      jsonStdin?: boolean;
      expiresAt?: string;
    }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const response = await getClient(globalOpts).post<CredentialResponse>("/api/credentials", {
        id,
        credential_type: opts.type,
        name: opts.name,
        secret: await readSecret(opts),
        expires_at: opts.expiresAt,
      });
      if (globalOpts.json) output(globalOpts, response);
      else if (response.data?.credential) printCredential(response.data.credential);
    });

  credential.command("rotate <id>")
    .option("--field <name>", "Secret field for raw stdin", "value")
    .option("--json-stdin", "Read a JSON object of secret fields from stdin")
    .option("--expires-at <timestamp>", "RFC3339 expiration time")
    .action(async (id: string, opts: { field?: string; jsonStdin?: boolean; expiresAt?: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const response = await getClient(globalOpts).post<CredentialResponse>(
        `/api/credentials/${encodeURIComponent(id)}/rotate`,
        { secret: await readSecret(opts), expires_at: opts.expiresAt },
      );
      if (globalOpts.json) output(globalOpts, response);
      else if (response.data?.credential) printCredential(response.data.credential);
    });

  credential.command("revoke <id>").action(async (id: string) => {
    const globalOpts = program.opts<GlobalOpts>();
    const response = await getClient(globalOpts).post<CredentialResponse>(
      `/api/credentials/${encodeURIComponent(id)}/revoke`,
    );
    if (globalOpts.json) output(globalOpts, response);
    else if (response.data?.credential) printCredential(response.data.credential);
  });

  credential.command("delete <id>").action(async (id: string) => {
    const globalOpts = program.opts<GlobalOpts>();
    const response = await getClient(globalOpts).delete<CredentialResponse>(`/api/credentials/${encodeURIComponent(id)}`);
    output(globalOpts, response);
  });

  credential.command("audit <id>").action(async (id: string) => {
    const globalOpts = program.opts<GlobalOpts>();
    const response = await getClient(globalOpts).get<CredentialResponse>(
      `/api/credentials/${encodeURIComponent(id)}/audit`,
    );
    output(globalOpts, response);
  });
}
