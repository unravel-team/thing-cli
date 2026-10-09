import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function setup(dir, ...args) {
  let stdout = "";
  let stderr = "";
  const code = await run(["setup", "claude", ...args], {
    cwd: dir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, XDG_CONFIG_HOME: join(dir, "xdg") },
    stdout: { write: (chunk) => { stdout += String(chunk); } },
    stderr: { write: (chunk) => { stderr += String(chunk); } }
  });
  return { code, stdout, stderr };
}

const settingsIn = (dir) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

// Fresh install: both lists keep Claude Code's defaults and gain thing's trust.
{
  const dir = await mkdtemp(join(tmpdir(), "thing-claude-"));
  const first = await setup(dir);
  assert(first.code === 0, `setup failed: ${first.stderr}`);
  const { autoMode } = settingsIn(dir);
  assert(autoMode.environment[0] === "$defaults" && autoMode.allow[0] === "$defaults", "new lists must keep $defaults first");
  assert(autoMode.environment.some((e) => e.includes("usething.ai")), "environment should trust usething.ai");
  assert(autoMode.allow.some((e) => e.includes("thing push")), "allow should cover thing push");
  assert(!autoMode.soft_deny && !autoMode.hard_deny, "deny lists must stay untouched");

  const again = await setup(dir);
  assert(again.stdout.includes("already trusts"), "a second run should report nothing to do");
  assert(settingsIn(dir).autoMode.environment.length === 3, "a second run must not duplicate entries");
}

// Existing settings: other keys and the person's own entries survive add and remove.
{
  const dir = await mkdtemp(join(tmpdir(), "thing-claude-"));
  const original = {
    model: "opus",
    permissions: { allow: ["Bash(npm test)"] },
    autoMode: { environment: ["$defaults", "Source control: github.com/acme"], soft_deny: ["$defaults", "Never touch prod"] }
  };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(original));
  await setup(dir);
  const merged = settingsIn(dir);
  assert(merged.model === "opus" && merged.permissions.allow[0] === "Bash(npm test)", "unrelated settings must be preserved");
  assert(merged.autoMode.environment[1] === "Source control: github.com/acme", "the person's entries must stay in place");
  assert(merged.autoMode.soft_deny.length === 2, "soft_deny must be untouched");

  const removed = await setup(dir, "--remove");
  assert(removed.code === 0, `remove failed: ${removed.stderr}`);
  assert(JSON.stringify(settingsIn(dir)) === JSON.stringify(original), `remove should restore the original settings: ${JSON.stringify(settingsIn(dir))}`);
}

// A list the person owns without $defaults is not given $defaults back.
{
  const dir = await mkdtemp(join(tmpdir(), "thing-claude-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ autoMode: { allow: ["My own allow rule"] } }));
  await setup(dir);
  const { allow } = settingsIn(dir).autoMode;
  assert(allow[0] === "My own allow rule" && !allow.includes("$defaults"), "an owned list must not gain $defaults");
}

// Dry run and broken settings never write.
{
  const dir = await mkdtemp(join(tmpdir(), "thing-claude-"));
  const dry = await setup(dir, "--dry-run");
  assert(dry.code === 0 && dry.stdout.includes("Would add"), "dry run should describe the change");
  assert(!existsSync(join(dir, "settings.json")), "dry run must not write");

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), "{ not json");
  const broken = await setup(dir);
  assert(broken.code !== 0 && broken.stderr.includes("not valid JSON"), "invalid settings should fail clearly");
  assert(readFileSync(join(dir, "settings.json"), "utf8") === "{ not json", "invalid settings must not be overwritten");
}

console.log("Setup claude tests passed");
