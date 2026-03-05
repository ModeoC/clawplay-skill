#!/usr/bin/env node

// review.ts
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
var __dirname = dirname(process.argv[1]);
var SKILL_ROOT = __dirname.endsWith(sep + "dist") || __dirname.endsWith(sep + "build") ? join(__dirname, "..") : __dirname;
var PLAYBOOK_FILE = join(SKILL_ROOT, "poker-playbook.md");
function readClawPlayConfig() {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "clawplay-config.json"), "utf8");
    const parsed = JSON.parse(raw);
    const config = {};
    if (typeof parsed.apiKeyEnvVar === "string" && parsed.apiKeyEnvVar) config.apiKeyEnvVar = parsed.apiKeyEnvVar;
    if (typeof parsed.accountId === "string" && parsed.accountId) config.accountId = parsed.accountId;
    if (typeof parsed.agentId === "string" && parsed.agentId) config.agentId = parsed.agentId;
    return config;
  } catch {
    return {};
  }
}
function resolveApiKey(config) {
  if (config.apiKeyEnvVar) return process.env[config.apiKeyEnvVar] || void 0;
  return process.env.CLAWPLAY_API_KEY_PRIMARY || void 0;
}

// poker-cli.ts
var BACKEND = "https://api.clawplay.fun";
var _resolved = null;
function resolveConfig() {
  if (!_resolved) {
    const config = readClawPlayConfig();
    _resolved = {
      apiKey: resolveApiKey(config),
      accountId: config.accountId
    };
  }
  return _resolved;
}
function die(msg, code = 1) {
  output({ error: msg });
  process.exit(code);
}
function requireAuth() {
  const { apiKey } = resolveConfig();
  if (!apiKey) die("CLAWPLAY_API_KEY_PRIMARY not set (env var, or apiKeyEnvVar in clawplay-config.json)");
  return { backend: BACKEND, apiKey };
}
async function api(method, path, body) {
  const { backend, apiKey } = requireAuth();
  const headers = { "x-api-key": apiKey };
  const opts = { method, headers, signal: AbortSignal.timeout(15e3) };
  if (body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${backend}${path}`, opts);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: resp.ok, status: resp.status, data };
}
function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}
function formatTelegramButtons(options) {
  return options.map((o) => [{ text: o.label, callback_data: o.value }]);
}
function formatDiscordComponents(options) {
  const blocks = [];
  for (let i = 0; i < options.length; i += 5) {
    blocks.push({
      type: "actions",
      buttons: options.slice(i, i + 5).map((o, idx) => ({
        label: o.label,
        style: i === 0 && idx === 0 ? "primary" : "secondary"
      }))
    });
  }
  return { blocks };
}
function formatButtonPayloads(options) {
  return {
    telegram: formatTelegramButtons(options),
    discord: formatDiscordComponents(options),
    fallback: options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")
  };
}
function getFlag(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}
function hasFlag(args, name) {
  return args.includes(name);
}
function getAllFlags(args, name) {
  const results = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      results.push(args[i + 1]);
    }
  }
  return results;
}
async function cmdSignup(username) {
  const resp = await fetch(`${BACKEND}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
    signal: AbortSignal.timeout(15e3)
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!resp.ok) die(`Signup failed (${resp.status}): ${JSON.stringify(data)}`);
  output(data);
}
async function cmdBalance() {
  const result = await api("GET", "/api/chips/balance");
  if (!result.ok) die(`Balance failed (${result.status}): ${JSON.stringify(result.data)}`);
  const raw = result.data;
  const chips = typeof raw === "number" ? raw : raw.balance;
  output({ chips });
}
async function cmdStatus() {
  const result = await api("GET", "/api/lobby/status");
  if (!result.ok) die(`Status failed (${result.status}): ${JSON.stringify(result.data)}`);
  const data = result.data;
  if (data.status === "playing") {
    output({ status: "playing", tableId: data.gameId });
  } else {
    output({ status: "idle", ...data.lastGameId ? { lastGameId: data.lastGameId } : {} });
  }
}
async function cmdModes(args) {
  const pick = hasFlag(args, "--pick");
  const modesResult = await api("GET", "/api/game-modes");
  if (!modesResult.ok) die(`Modes failed (${modesResult.status}): ${JSON.stringify(modesResult.data)}`);
  const modes = modesResult.data;
  if (!pick) {
    output(modes.map((m) => ({ id: m.id, name: m.name, buyIn: m.buyIn })));
    return;
  }
  const balResult = await api("GET", "/api/chips/balance");
  if (!balResult.ok) die(`Balance failed (${balResult.status}): ${JSON.stringify(balResult.data)}`);
  const rawBal = typeof balResult.data === "number" ? balResult.data : balResult.data.balance;
  if (rawBal == null || typeof rawBal !== "number") {
    die(`Unexpected balance response: ${JSON.stringify(balResult.data)}`);
  }
  const balance = rawBal;
  const affordable = modes.filter((m) => balance >= m.buyIn);
  if (affordable.length === 0) {
    die(`Not enough chips to join any game mode. Balance: ${balance} chips.`, 2);
  }
  const options = affordable.map((m) => ({
    label: `${m.name} \u2014 ${m.smallBlind}/${m.bigBlind}, ${m.buyIn} buy-in`,
    value: m.name
  }));
  output({
    chips: balance,
    modes: affordable.map((m) => ({ id: m.id, name: m.name })),
    buttons: formatButtonPayloads(options)
  });
}
async function cmdJoin(gameModeId) {
  const result = await api("POST", "/api/lobby/join", { gameModeId });
  if (!result.ok) die(`Join failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdSpectatorToken() {
  const result = await api("POST", "/api/me/game/spectator-token");
  if (!result.ok) die(`Spectator token failed (${result.status}): ${JSON.stringify(result.data)}`);
  const data = result.data;
  const url = `https://clawplay.fun/watch/${data.gameId}?token=${data.token}`;
  output({ url });
}
async function cmdRebuy() {
  const result = await api("POST", "/api/me/game/rebuy");
  if (!result.ok) die(`Rebuy failed (${result.status}): ${JSON.stringify(result.data)}`);
  const data = result.data;
  output({ chips: data.yourChips });
}
async function cmdLeave() {
  const result = await api("POST", "/api/me/game/leave");
  if (!result.ok) die(`Leave failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdGameState() {
  const result = await api("GET", "/api/me/game");
  if (!result.ok) die(`Game state failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdHandHistory(args) {
  const lastRaw = getFlag(args, "--last");
  if (lastRaw != null) {
    const n = Number(lastRaw);
    if (!Number.isInteger(n) || n < 1) die("--last must be a positive integer");
  }
  const query = lastRaw ? `?last=${lastRaw}` : "";
  const result = await api("GET", `/api/me/game/history${query}`);
  if (!result.ok) die(`Hand history failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdSessionSummary() {
  const result = await api("GET", "/api/me/game/session-summary");
  if (!result.ok) die(`Session summary failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdPlayerStats(args) {
  const userId = args[0] ?? resolveConfig().accountId;
  if (!userId) die("Usage: poker-cli player-stats [userId] (or set accountId in clawplay-config.json)");
  const resp = await fetch(`${BACKEND}/api/public/stats/${userId}`, {
    signal: AbortSignal.timeout(15e3)
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!resp.ok) die(`Player stats failed (${resp.status}): ${JSON.stringify(data)}`);
  output(data);
}
async function cmdPrompt(args) {
  const optionStrs = getAllFlags(args, "--option");
  if (optionStrs.length < 2) die('At least 2 --option flags required (format: "Label=value")');
  const options = optionStrs.map((s) => {
    const eq = s.indexOf("=");
    if (eq < 0) die(`Invalid --option format: "${s}" (expected "Label=value")`);
    return { label: s.slice(0, eq), value: s.slice(eq + 1) };
  });
  output({
    buttons: formatButtonPayloads(options)
  });
}
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    const help = [
      "Commands:",
      "  status            Check if currently in a game",
      "  balance           Get chip balance",
      "  modes             List available game modes",
      "  modes --pick      Get affordable modes with button payloads",
      "  join <MODE_ID>    Join the lobby for a game mode",
      "  game-state        Fetch live game state",
      "  hand-history      Get completed hand results (--last N to limit)",
      "  session-summary   Session stats (P&L, hands played, win rate)",
      "  player-stats      Lifetime stats across all sessions",
      "  spectator-token   Generate a spectator link",
      '  prompt            Build button payloads (--option "Label=value" ...)',
      "  rebuy             Rebuy after busting",
      "  leave             Leave the current game",
      "  signup <username> Create a new account"
    ];
    console.log(help.join("\n"));
    process.exit(0);
  }
  try {
    switch (cmd) {
      case "signup": {
        const username = args[1];
        if (!username) die("Usage: poker-cli signup <username>");
        await cmdSignup(username);
        break;
      }
      case "balance":
        await cmdBalance();
        break;
      case "status":
        await cmdStatus();
        break;
      case "modes":
        await cmdModes(args.slice(1));
        break;
      case "join": {
        const modeId = args[1];
        if (!modeId) die("Usage: poker-cli join <gameModeId>");
        await cmdJoin(modeId);
        break;
      }
      case "spectator-token":
        await cmdSpectatorToken();
        break;
      case "rebuy":
        await cmdRebuy();
        break;
      case "leave":
        await cmdLeave();
        break;
      case "game-state":
        await cmdGameState();
        break;
      case "hand-history":
        await cmdHandHistory(args.slice(1));
        break;
      case "session-summary":
        await cmdSessionSummary();
        break;
      case "player-stats":
        await cmdPlayerStats(args.slice(1));
        break;
      case "prompt":
        await cmdPrompt(args.slice(1));
        break;
      default:
        die(`Unknown command: ${cmd || "(none)"}

Commands: signup, balance, status, modes, join, game-state, hand-history, session-summary, spectator-token, rebuy, leave, player-stats, prompt`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    die(`Error: ${msg}`);
  }
}
main();
