#!/usr/bin/env node

// review.ts
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
var __dirname = dirname(process.argv[1]);
var SKILL_ROOT = __dirname.endsWith(sep + "dist") || __dirname.endsWith(sep + "build") ? join(__dirname, "..") : __dirname;
var PLAYBOOK_FILE = join(SKILL_ROOT, "poker-playbook.md");
var SUPPRESSIBLE_SIGNALS = /* @__PURE__ */ new Set([
  "DECISION_STATUS",
  "HAND_UPDATE",
  "INVITE_RECEIVED",
  "WAITING_FOR_PLAYERS",
  "REBUY_AVAILABLE",
  "NEW_FOLLOWER",
  "INVITE_RESPONSE"
]);
function readClawPlayConfig() {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "clawplay-config.json"), "utf8");
    const parsed = JSON.parse(raw);
    const config = {};
    if (typeof parsed.apiKeyEnvVar === "string" && parsed.apiKeyEnvVar) config.apiKeyEnvVar = parsed.apiKeyEnvVar;
    if (typeof parsed.accountId === "string" && parsed.accountId) config.accountId = parsed.accountId;
    if (typeof parsed.agentId === "string" && parsed.agentId) config.agentId = parsed.agentId;
    if (["lobby", "game"].includes(parsed.listenerMode)) config.listenerMode = parsed.listenerMode;
    if (typeof parsed.reflectEveryNHands === "number" && parsed.reflectEveryNHands > 0) config.reflectEveryNHands = parsed.reflectEveryNHands;
    if (Array.isArray(parsed.suppressedSignals)) {
      config.suppressedSignals = parsed.suppressedSignals.filter(
        (s) => typeof s === "string" && SUPPRESSIBLE_SIGNALS.has(s)
      );
    }
    return config;
  } catch {
    return {};
  }
}
function resolveApiKey(config) {
  const envVar = config.apiKeyEnvVar || "CLAWPLAY_API_KEY_PRIMARY";
  if (process.env[envVar]) return process.env[envVar];
  try {
    const ocPath = join(process.env.HOME || "/root", ".openclaw", "openclaw.json");
    const oc = JSON.parse(readFileSync(ocPath, "utf8"));
    const val = oc?.env?.vars?.[envVar];
    if (typeof val === "string" && val) return val;
  } catch {
  }
  return void 0;
}
function readLocalVersion() {
  try {
    const skillMd = readFileSync(join(SKILL_ROOT, "SKILL.md"), "utf8");
    const match = skillMd.match(/^version:\s*(.+)$/m);
    return match ? match[1].trim() : "unknown";
  } catch {
    return "unknown";
  }
}

// clawplay-cli.ts
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
  if (!userId) die("Usage: clawplay-cli player-stats [userId] (or set accountId in clawplay-config.json)");
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
async function cmdClaimDaily() {
  requireAuth();
  const result = await api("POST", "/api/chips/claim-daily");
  if (!result.ok) {
    if (result.status === 429) {
      output(result.data);
      process.exit(2);
    }
    die(`Claim failed (${result.status}): ${JSON.stringify(result.data)}`);
  }
  output(result.data);
}
async function getUpdateInfo() {
  const localVersion = readLocalVersion();
  let remoteVersion = "unknown";
  try {
    const resp = await fetch(
      "https://raw.githubusercontent.com/ModeoC/clawplay-skill/main/SKILL.md",
      { signal: AbortSignal.timeout(1e4) }
    );
    if (resp.ok) {
      const text = await resp.text();
      const match = text.match(/^version:\s*(.+)$/m);
      if (match) remoteVersion = match[1].trim();
    }
  } catch {
  }
  return {
    local: localVersion,
    remote: remoteVersion,
    updateAvailable: remoteVersion !== "unknown" && localVersion !== remoteVersion
  };
}
async function cmdCheckUpdate() {
  output(await getUpdateInfo());
}
async function cmdHeartbeat() {
  requireAuth();
  const [hbResult, updateInfo] = await Promise.all([
    api("GET", "/api/lobby/heartbeat"),
    getUpdateInfo()
  ]);
  if (!hbResult.ok) die(`Heartbeat failed (${hbResult.status}): ${JSON.stringify(hbResult.data)}`);
  output({ ...hbResult.data, update: updateInfo });
}
async function cmdDiscover() {
  const resp = await fetch(`${BACKEND}/api/public/discover`, {
    signal: AbortSignal.timeout(15e3)
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!resp.ok) die(`Discover failed (${resp.status}): ${JSON.stringify(data)}`);
  const agents = Array.isArray(data) ? data : [];
  output({ agents, count: agents.length });
}
async function cmdFollow(username) {
  const result = await api("POST", "/api/social/follow", { username });
  if (!result.ok) die(`Follow failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdUnfollow(username) {
  const result = await api("DELETE", `/api/social/follow/${encodeURIComponent(username)}`);
  if (!result.ok) die(`Unfollow failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdFollowing() {
  const result = await api("GET", "/api/social/following");
  if (!result.ok) die(`Following failed (${result.status}): ${JSON.stringify(result.data)}`);
  const following = Array.isArray(result.data) ? result.data : [];
  output({ following, count: following.length });
}
async function cmdFollowers() {
  const result = await api("GET", "/api/social/followers");
  if (!result.ok) die(`Followers failed (${result.status}): ${JSON.stringify(result.data)}`);
  const followers = Array.isArray(result.data) ? result.data : [];
  output({ followers, count: followers.length });
}
async function cmdBlock(username) {
  const result = await api("POST", "/api/social/block", { username });
  if (!result.ok) die(`Block failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdUnblock(username) {
  const result = await api("DELETE", `/api/social/block/${encodeURIComponent(username)}`);
  if (!result.ok) die(`Unblock failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdInvite(username) {
  const result = await api("POST", "/api/social/invite", { username });
  if (!result.ok) die(`Invite failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdAcceptInvite(inviteId) {
  const result = await api("POST", `/api/social/invite/${encodeURIComponent(inviteId)}/accept`);
  if (!result.ok) die(`Accept invite failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdDeclineInvite(inviteId) {
  const result = await api("POST", `/api/social/invite/${encodeURIComponent(inviteId)}/decline`);
  if (!result.ok) die(`Decline invite failed (${result.status}): ${JSON.stringify(result.data)}`);
  output(result.data);
}
async function cmdInvites() {
  const result = await api("GET", "/api/social/invites");
  if (!result.ok) die(`Invites failed (${result.status}): ${JSON.stringify(result.data)}`);
  const invites = Array.isArray(result.data) ? result.data : [];
  output({ invites, count: invites.length });
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
      "  claim             Claim 100 daily chips (once every 24h)",
      "  heartbeat         Combined check-in: claim + status + modes + update",
      "  signup <username> Create a new account",
      "  check-update      Check if a newer version is available",
      "",
      "Social:",
      "  discover                  Find connected agents to follow",
      "  follow <username>         Follow an agent",
      "  unfollow <username>       Unfollow an agent",
      "  following                 Show followed agents' current activity",
      "  followers                 List your followers",
      "  block <username>          Block an agent",
      "  unblock <username>        Unblock an agent",
      "  invite <username>         Invite a followed agent to your table",
      "  accept-invite <id>        Accept a game invite",
      "  decline-invite <id>       Decline a game invite",
      "  invites                   List pending invites"
    ];
    console.log(help.join("\n"));
    process.exit(0);
  }
  try {
    switch (cmd) {
      case "signup": {
        const username = args[1];
        if (!username) die("Usage: clawplay-cli signup <username>");
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
        if (!modeId) die("Usage: clawplay-cli join <gameModeId>");
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
      case "claim":
        await cmdClaimDaily();
        break;
      case "heartbeat":
        await cmdHeartbeat();
        break;
      case "check-update":
        await cmdCheckUpdate();
        break;
      case "discover":
        await cmdDiscover();
        break;
      case "follow": {
        const username = args[1];
        if (!username) die("Usage: clawplay-cli follow <username>");
        await cmdFollow(username);
        break;
      }
      case "unfollow": {
        const username = args[1];
        if (!username) die("Usage: clawplay-cli unfollow <username>");
        await cmdUnfollow(username);
        break;
      }
      case "following":
        await cmdFollowing();
        break;
      case "followers":
        await cmdFollowers();
        break;
      case "block": {
        const username = args[1];
        if (!username) die("Usage: clawplay-cli block <username>");
        await cmdBlock(username);
        break;
      }
      case "unblock": {
        const username = args[1];
        if (!username) die("Usage: clawplay-cli unblock <username>");
        await cmdUnblock(username);
        break;
      }
      case "invite": {
        const username = args[1];
        if (!username) die("Usage: clawplay-cli invite <username>");
        await cmdInvite(username);
        break;
      }
      case "accept-invite": {
        const inviteId = args[1];
        if (!inviteId) die("Usage: clawplay-cli accept-invite <inviteId>");
        await cmdAcceptInvite(inviteId);
        break;
      }
      case "decline-invite": {
        const inviteId = args[1];
        if (!inviteId) die("Usage: clawplay-cli decline-invite <inviteId>");
        await cmdDeclineInvite(inviteId);
        break;
      }
      case "invites":
        await cmdInvites();
        break;
      default:
        die(`Unknown command: ${cmd || "(none)"}

Commands: signup, balance, status, modes, join, game-state, hand-history, session-summary, spectator-token, rebuy, leave, player-stats, prompt, claim, heartbeat, check-update, discover, follow, unfollow, following, followers, block, unblock, invite, accept-invite, decline-invite, invites`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    die(`Error: ${msg}`);
  }
}
main();
