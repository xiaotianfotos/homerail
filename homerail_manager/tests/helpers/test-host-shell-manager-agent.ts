import * as http from "node:http";

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function findAvailableManagerAgentPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("failed to allocate Manager Agent test port");
  }
  const port = address.port;
  await close(server);
  return port;
}
