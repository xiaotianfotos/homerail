# Control-Plane WebSocket Security

HomeRail has two privileged control-plane WebSocket paths:

- `/ws/projects/<project>/workers/<worker>` carries model configuration, tasks, handoffs, and evidence.
- `/ws/projects/<project>/nodes/<node>` carries Worker lifecycle requests for Docker-capable Nodes.

These paths authenticate during the HTTP upgrade, before a socket can register.

## Authentication defaults

- A connection without a configured token is accepted only from a loopback address.
- `HOMERAIL_WORKER_TOKEN` authenticates external Workers.
- `HOMERAIL_NODE_TOKEN` authenticates external Nodes.
- `HOMERAIL_CONTROL_PLANE_TOKEN` is a shared fallback when separate credentials are not required.
- When a token is explicitly configured, every connection must send it, including loopback and reverse-proxy connections.

Manager-created Docker Workers receive a generated token automatically. The token is stored at
`${HOMERAIL_HOME}/manager/secrets/control-plane.token` with private file permissions so surviving Workers can reconnect after a Manager restart. It is not stored in the database, run evidence, or repository.

For an external Worker, configure the same credential on Manager and Worker:

```bash
export HOMERAIL_WORKER_TOKEN="$(openssl rand -base64 32)"
# Start Manager with this environment, then pass the same value to the Worker.
```

For an external Node, use `HOMERAIL_NODE_TOKEN` in both processes. Prefer separate Worker and Node tokens because a Node can create and destroy Worker containers.

## Transport encryption

Remote Worker and Node clients reject plaintext `ws://` URLs by default. Local loopback and `host.docker.internal` remain available for local development and Docker Desktop. Use `wss://` for multi-host deployments.

Manager does not own production certificate renewal. Terminate TLS in a reverse proxy, keep Manager bound to loopback, and forward the upgrade and authorization headers:

```nginx
location /ws/ {
    proxy_pass http://127.0.0.1:19191;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Authorization $http_authorization;
}
```

Then configure clients with the external endpoint:

```bash
export HOMERAIL_MANAGER_WS_URL="wss://homerail.example.com"
```

For a private certificate authority, configure Node.js trust with `NODE_EXTRA_CA_CERTS`. Do not disable TLS verification.

`HOMERAIL_ALLOW_INSECURE_REMOTE_WS=1` is an explicit compatibility escape hatch for an isolated trusted network. It affects only the client-side transport check; Manager authentication is still required. Do not use it on public, shared, or untrusted networks.

This policy covers Worker and Node control-plane sockets. Browser events and voice WebSockets have separate trust boundaries and are not granted Worker or Node privileges.
