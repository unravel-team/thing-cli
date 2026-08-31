# Thing server: CLI and MCP update policy

This document specifies the server work required by `@unravel-tech/thing`'s update UX. It is written for the Thing server repository, whose backend is the Bun/Hono app under `apps/server`.

The server publishes two version thresholds for each client surface:

- `latestVersion`: versions below this receive an advisory update notice.
- `minimumVersion`: versions below this stop working and receive HTTP `426 Upgrade Required`.

The client derives one of three statuses:

| Comparison | Status | Result |
| --- | --- | --- |
| current >= latest | `current` | Continue silently |
| minimum <= current < latest | `update_available` | Continue and show a rate-limited notice |
| current < minimum | `update_required` | Stop protected operations and request an update |

CLI and MCP policies are independent even though both ship in the same npm package. This allows a protocol-specific MCP problem to be enforced without blocking the ordinary CLI.

## 1. Configuration

Add these fields to `apps/server/src/config.ts` and document them in `apps/server/.env.example`:

```env
THING_CLI_LATEST_VERSION=0.7.0
THING_CLI_MINIMUM_VERSION=0.6.0
THING_MCP_LATEST_VERSION=0.7.0
THING_MCP_MINIMUM_VERSION=0.6.0
```

Recommended config shape:

```ts
type ClientVersionPolicy = {
  latestVersion: string;
  minimumVersion: string;
};

type AppConfig = {
  // existing fields...
  clientVersions: Record<"thing-cli" | "thing-mcp", ClientVersionPolicy>;
};
```

Validate all four values as SemVer during startup and refuse invalid configurations. Also refuse a policy where `minimumVersion` is greater than `latestVersion`.

Use a real SemVer implementation so prereleases compare correctly:

```sh
cd apps/server
bun add semver
bun add --dev @types/semver
```

Start with both thresholds equal to the currently published CLI version. Changing `latestVersion` then enables notices without blocking anyone. Changing `minimumVersion` enables enforcement.

## 2. Client identification

The released CLI already sends one of these headers on every API request:

```http
X-Thing-Client: thing-cli/0.5.0
X-Thing-Client: thing-mcp/0.5.0
```

Only apply this policy to an exact `thing-cli` or `thing-mcp` match. Unknown, missing, or malformed client headers must continue through the API unchanged; the policy is not intended to gate the website or third-party API integrations.

Suggested parser for `apps/server/src/client-policy.ts`:

```ts
import semver from "semver";

export type ThingClient = "thing-cli" | "thing-mcp";
export type ClientStatus = "current" | "update_available" | "update_required";

export function parseThingClient(header: string | undefined): { client: ThingClient; version: string } | null {
  const match = /^(thing-(?:cli|mcp))\/(\S+)$/.exec(header ?? "");
  if (!match || !semver.valid(match[2])) return null;
  return { client: match[1] as ThingClient, version: match[2] };
}

export function clientStatus(
  currentVersion: string,
  policy: { latestVersion: string; minimumVersion: string }
): ClientStatus {
  if (semver.lt(currentVersion, policy.minimumVersion)) return "update_required";
  if (semver.lt(currentVersion, policy.latestVersion)) return "update_available";
  return "current";
}
```

## 3. Public policy endpoint

Add an unauthenticated endpoint:

```http
GET /api/v1/client-policy
X-Thing-Client: thing-mcp/0.5.0
```

Successful response:

```json
{
  "client": "thing-mcp",
  "currentVersion": "0.5.0",
  "latestVersion": "0.7.0",
  "minimumVersion": "0.6.0",
  "status": "update_required",
  "package": "@unravel-tech/thing"
}
```

Response requirements:

- Return `200` for every valid Thing client version, including a required update. The CLI needs to read this endpoint before deciding whether to run a local command.
- Return `400` with `{ "error": "Invalid X-Thing-Client header" }` when called directly without a valid Thing header.
- Set `Cache-Control: no-store`. The CLI owns its one-hour cache, and a proxy must not retain an emergency rollback.
- Do not require a token. MCP initialization and logged-out CLI commands need this endpoint.
- Do not include arbitrary operator-authored prompt text. The CLI renders fixed update wording from version fields.

Example Hono route:

```ts
import { Hono } from "hono";
import { config } from "./config";
import { clientStatus, parseThingClient } from "./client-policy";
import type { AppBindings } from "./types";

export const clientPolicyRoutes = new Hono<AppBindings>();

clientPolicyRoutes.get("/client-policy", (c) => {
  const parsed = parseThingClient(c.req.header("x-thing-client"));
  if (!parsed) return c.json({ error: "Invalid X-Thing-Client header" }, 400);

  const policy = config.clientVersions[parsed.client];
  c.header("Cache-Control", "no-store");
  return c.json({
    client: parsed.client,
    currentVersion: parsed.version,
    latestVersion: policy.latestVersion,
    minimumVersion: policy.minimumVersion,
    status: clientStatus(parsed.version, policy),
    package: "@unravel-tech/thing"
  });
});
```

Register it under `/api/v1` in `apps/server/src/index.ts` before the ordinary artifact routes.

## 4. Required-update middleware

The policy endpoint provides early UX, but it is not enforcement. Every protected `/api/v1` operation must independently reject a recognized client below its minimum version.

Add Hono middleware before the API routes:

```ts
import type { MiddlewareHandler } from "hono";
import { config } from "./config";
import { clientStatus, parseThingClient } from "./client-policy";
import type { AppBindings } from "./types";

export const enforceClientVersion: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.req.path === "/api/v1/client-policy") return next();

  const parsed = parseThingClient(c.req.header("x-thing-client"));
  if (!parsed) return next();

  const policy = config.clientVersions[parsed.client];
  const status = clientStatus(parsed.version, policy);
  c.header("X-Thing-Latest-Version", policy.latestVersion);
  c.header("X-Thing-Minimum-Version", policy.minimumVersion);

  if (status === "update_required") {
    return c.json({
      code: "CLIENT_UPDATE_REQUIRED",
      client: parsed.client,
      currentVersion: parsed.version,
      latestVersion: policy.latestVersion,
      minimumVersion: policy.minimumVersion,
      status,
      package: "@unravel-tech/thing"
    }, 426);
  }

  await next();
};
```

Register it before `app.route("/api/v1/auth", authRoutes)` and `app.route("/api/v1", artifactRoutes)`:

```ts
app.use("/api/v1/*", enforceClientVersion);
app.route("/api/v1", clientPolicyRoutes);
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1", artifactRoutes);
```

This middleware deliberately covers login and token endpoints as well as artifact endpoints. An obsolete client should retain only its local `--help`, `--version`, and `update` paths.

## 5. Client behavior already implemented

### Advisory: `update_available`

The CLI:

- Continues the requested command.
- Writes the notice to `stderr`, leaving successful stdout stable.
- Checks the policy at most once per hour.
- Shows the same target-version notice at most once per 24 hours.
- Suppresses advisory notices for `--json`, CI, or `THING_NO_UPDATE_NOTICES=1`.

The MCP server:

- Includes the notice in initialization `instructions`.
- Advertises MCP logging and emits one `notifications/message` notice after `notifications/initialized`.
- Adds a notice to the first successful business-tool result in the session so the model sees it even when the host hides MCP logs or instructions.
- Keeps every tool working.

### Required: `update_required`

The CLI:

- Stops normal commands with exit code `3`.
- Produces `code: "CLIENT_UPDATE_REQUIRED"` and all policy versions under `--json`.
- Keeps `--help`, `--version`, and `update` available.
- Does not allow `THING_NO_UPDATE_NOTICES` or CI to suppress enforcement.

The MCP server:

- Completes initialization so hosts and agents receive a useful explanation.
- Keeps `server_info` available.
- Rejects business tools with `isError: true` and structured `CLIENT_UPDATE_REQUIRED` data.
- Tells the user to update Thing and restart the MCP client.

The server's `426` remains authoritative even when the client's cached policy said `current` or its policy check failed.

## 6. Rollout procedure

Never raise the minimum before the compatible npm package is available.

1. Publish and verify the new `@unravel-tech/thing` release.
2. Leave `minimumVersion` at the old supported version.
3. Raise `latestVersion` to begin advisory notices.
4. Observe adoption and error telemetry.
5. For a compatibility or emergency requirement, raise `minimumVersion`.
6. If the rollout causes trouble, lower `minimumVersion` immediately. `Cache-Control: no-store`, forced MCP startup checks, and per-operation `426` enforcement make rollback converge quickly.

For `npx` MCP configurations, use an explicit latest tag and restart the MCP host:

```json
{
  "command": "npx",
  "args": ["-y", "@unravel-tech/thing@latest", "mcp"]
}
```

## 7. Server tests

Add coverage to the Thing server's Bun tests for:

- CLI and MCP headers select independent policies.
- Current, advisory, and required comparisons.
- Equality with `minimumVersion` is supported, not blocked.
- Versions newer than `latestVersion` remain current.
- SemVer prerelease ordering.
- Invalid configuration fails server startup.
- Missing, malformed, and unknown client headers bypass middleware.
- The public policy endpoint does not require authentication.
- The policy endpoint is never blocked by its own middleware.
- Required clients receive status `426` and `CLIENT_UPDATE_REQUIRED` on auth and artifact routes.
- Advisory clients continue normally.
- Lowering the minimum immediately stops new `426` responses.

## Security boundary

Version enforcement is compatibility and product UX, not authentication or vulnerability mitigation. A caller can spoof `X-Thing-Client`. Any security-sensitive behavior must also be fixed or rejected based on the request itself, independent of the claimed client version.
