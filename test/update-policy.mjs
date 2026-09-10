import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function capture(options = {}) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd: process.cwd(),
      env: options.env || process.env,
      stdin: options.stdin,
      spawnSync: options.spawnSync,
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stdinFor(messages) {
  return {
    async *[Symbol.asyncIterator]() {
      yield `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    }
  };
}

async function testVersions() {
  const cli = capture();
  assert(await run(["--version"], cli.io) === 0, "thing --version should succeed");
  assert(/^thing \d+\.\d+\.\d+/.test(cli.stdout()), "thing --version should print the installed version");

  const mcp = capture();
  assert(await run(["mcp", "--version", "--json"], mcp.io) === 0, "thing mcp --version should succeed");
  const result = JSON.parse(mcp.stdout());
  assert(result.name === "thing-mcp" && result.version, "MCP version JSON should identify the MCP server");
}

async function testCliAdvisory() {
  const home = await mkdtemp(join(tmpdir(), "thing-cli-advisory-"));
  const env = { ...process.env, XDG_CONFIG_HOME: home, THING_TOKEN: "token" };
  let policyCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/client-policy") {
      policyCalls += 1;
      return json({
        client: "thing-cli",
        currentVersion: "0.6.0",
        latestVersion: "0.7.0",
        minimumVersion: "0.6.0",
        status: "update_available"
      });
    }
    if (url.pathname === "/api/v1/artifacts") return json({ artifacts: [] });
    return json({ error: "unexpected request" }, 404);
  };

  const first = capture({ env });
  assert(await run(["list"], first.io) === 0, "advisory updates must not block CLI commands");
  assert(first.stdout().trim() === "No artifacts", "the command result should remain unchanged");
  assert(first.stderr().includes("Update available: Thing CLI"), "the first advisory should be written to stderr");

  const second = capture({ env });
  assert(await run(["list"], second.io) === 0, "a repeated advisory command should succeed");
  assert(second.stderr() === "", "the same advisory should be rate limited");
  assert(policyCalls === 1, "a fresh cached policy should avoid another network check");

  const jsonHome = await mkdtemp(join(tmpdir(), "thing-cli-advisory-json-"));
  const jsonRun = capture({ env: { ...env, XDG_CONFIG_HOME: jsonHome } });
  assert(await run(["list", "--json"], jsonRun.io) === 0, "JSON commands should succeed during an advisory update");
  assert(jsonRun.stderr() === "", "advisory notices should be suppressed for JSON output");
  assert(Array.isArray(JSON.parse(jsonRun.stdout()).artifacts), "JSON stdout should contain only the command result");
}

async function testCliRequired() {
  const home = await mkdtemp(join(tmpdir(), "thing-cli-required-"));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: home,
    THING_TOKEN: "token",
    THING_NO_UPDATE_NOTICES: "1"
  };
  let artifactCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/client-policy") {
      return json({
        client: "thing-cli",
        latestVersion: "0.8.0",
        minimumVersion: "0.7.0",
        status: "update_required"
      });
    }
    if (url.pathname === "/api/v1/artifacts") artifactCalls += 1;
    return json({ artifacts: [] });
  };

  const textRun = capture({ env });
  assert(await run(["list"], textRun.io) === 3, "required updates should use exit code 3");
  assert(textRun.stderr().includes("is no longer supported"), "required updates should explain why the command stopped");
  assert(textRun.stderr().includes("npm install --global"), "required updates should include an update command");
  assert(artifactCalls === 0, "required updates should stop before the business request");

  const jsonHome = await mkdtemp(join(tmpdir(), "thing-cli-required-json-"));
  const jsonRun = capture({ env: { ...env, XDG_CONFIG_HOME: jsonHome } });
  assert(await run(["list", "--json"], jsonRun.io) === 3, "required updates should also block JSON commands");
  const payload = JSON.parse(jsonRun.stdout());
  assert(payload.code === "CLIENT_UPDATE_REQUIRED", "required JSON errors should have a stable code");
  assert(payload.minimumVersion === "0.7.0" && payload.latestVersion === "0.8.0", "required JSON errors should include policy versions");

  const version = capture({ env });
  assert(await run(["--version"], version.io) === 0, "version must remain available during required updates");
}

async function testServerEnforced426() {
  const home = await mkdtemp(join(tmpdir(), "thing-cli-426-"));
  const env = { ...process.env, XDG_CONFIG_HOME: home, THING_TOKEN: "token" };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/client-policy") {
      return json({ client: "thing-cli", latestVersion: "0.6.0", minimumVersion: "0.6.0", status: "current" });
    }
    return json({
      code: "CLIENT_UPDATE_REQUIRED",
      client: "thing-cli",
      latestVersion: "0.8.0",
      minimumVersion: "0.7.0"
    }, 426);
  };

  const result = capture({ env });
  assert(await run(["list", "--json"], result.io) === 3, "a server 426 must override a cached current policy");
  assert(JSON.parse(result.stdout()).code === "CLIENT_UPDATE_REQUIRED", "a server 426 should retain the update error code");
}

async function testMcpAdvisory() {
  const home = await mkdtemp(join(tmpdir(), "thing-mcp-advisory-"));
  const env = { ...process.env, XDG_CONFIG_HOME: home, THING_TOKEN: "token" };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/client-policy") {
      assert(init.headers["X-Thing-Client"].startsWith("thing-mcp/"), "MCP policy checks should identify the MCP client");
      return json({ client: "thing-mcp", latestVersion: "0.7.0", minimumVersion: "0.6.0", status: "update_available" });
    }
    if (url.pathname === "/api/v1/whoami") return json({ user: { email: "mcp@example.com" }, defaultTeam: null });
    return json({ error: "unexpected request" }, 404);
  };

  const stdin = stdinFor([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "server_info", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } }
  ]);
  const result = capture({ env, stdin });
  assert(await run(["mcp"], result.io) === 0, "MCP advisory session should complete");
  const messages = result.stdout().trim().split("\n").map((line) => JSON.parse(line));
  assert(messages[0].result.instructions.includes("Update available"), "MCP initialize instructions should carry the advisory");
  assert(messages[1].method === "notifications/message" && messages[1].params.level === "notice", "MCP should emit an advisory log notification");
  const serverInfo = JSON.parse(messages[2].result.content[0].text);
  assert(serverInfo.version && serverInfo.update.status === "update_available", "server_info should expose version and policy");
  assert(messages[3].result.content.length === 2, "the first business tool result should nudge the agent");
}

async function testMcpRequired() {
  const home = await mkdtemp(join(tmpdir(), "thing-mcp-required-"));
  const env = { ...process.env, XDG_CONFIG_HOME: home, THING_TOKEN: "token" };
  let artifactCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/client-policy") {
      return json({ client: "thing-mcp", latestVersion: "0.8.0", minimumVersion: "0.7.0", status: "update_required" });
    }
    if (url.pathname === "/api/v1/artifacts") artifactCalls += 1;
    return json({ artifacts: [] });
  };

  const stdin = stdinFor([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_artifacts", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "server_info", arguments: {} } }
  ]);
  const result = capture({ env, stdin });
  assert(await run(["mcp"], result.io) === 0, "MCP required-update session should stay alive to explain the problem");
  const messages = result.stdout().trim().split("\n").map((line) => JSON.parse(line));
  assert(messages[0].result.instructions.includes("no longer supported"), "MCP initialization should explain a required update");
  assert(messages[2].result.isError === true, "business tools should stop during a required update");
  assert(messages[2].result.structuredContent.code === "CLIENT_UPDATE_REQUIRED", "MCP required errors should be structured");
  assert(artifactCalls === 0, "blocked MCP tools should not reach the business API");
  const serverInfo = JSON.parse(messages[3].result.content[0].text);
  assert(serverInfo.update.status === "update_required", "server_info must remain available while blocked");
}

async function testMcpCommentTool() {
  const home = await mkdtemp(join(tmpdir(), "thing-mcp-comments-"));
  const env = { ...process.env, XDG_CONFIG_HOME: home, THING_TOKEN: "token" };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/client-policy") return json({ client: "thing-mcp", status: "current" });
    if (url.pathname === "/api/v1/artifacts") return json({ artifacts: [{ id: "artifact-1", slug: "weekly-report", title: "Weekly report" }] });
    if (url.pathname === "/api/v1/artifacts/artifact-1/comments") return json({ artifact: { id: "artifact-1", slug: "weekly-report" }, comments: [{ id: "comment-1", body: "Review this", versionNumber: 1, author: { email: "reviewer@example.com" } }] });
    return json({ error: "unexpected request" }, 404);
  };
  const stdin = stdinFor([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_artifact_comments", arguments: { name: "weekly-report" } } }
  ]);
  const result = capture({ env, stdin });
  assert(await run(["mcp"], result.io) === 0, "MCP comments session should complete");
  const messages = result.stdout().trim().split("\n").map((line) => JSON.parse(line));
  assert(messages[1].result.tools.some((tool) => tool.name === "list_artifact_comments"), "MCP should advertise the comments tool");
  const payload = JSON.parse(messages[2].result.content[0].text);
  assert(payload.artifact.slug === "weekly-report" && payload.comments[0].body === "Review this", "MCP should return pulled comments");
}

async function testForcedUpdate() {
  let invocation = null;
  const result = capture({
    spawnSync: (command, args) => {
      invocation = { command, args };
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  assert(await run(["update", "--force", "--manager", "npm", "--json"], result.io) === 0, "forced update should run the installer");
  assert(invocation?.command === "npm", "--manager npm should select npm");
  assert(invocation.args.join(" ") === "install --global @unravel-tech/thing@latest --force", "forced npm updates should reinstall and allow the binary link to be replaced");
  const payload = JSON.parse(result.stdout());
  assert(payload.updated === true && payload.forced === true, "forced update JSON should report what happened");
}

const originalFetch = globalThis.fetch;
try {
  await testVersions();
  await testCliAdvisory();
  await testCliRequired();
  await testServerEnforced426();
  await testMcpAdvisory();
  await testMcpRequired();
  await testMcpCommentTool();
  await testForcedUpdate();
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Update policy tests passed");
