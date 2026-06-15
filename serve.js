const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const authenticator = require("authenticator");

loadEnvFile(resolveEnvFilePath());

const root = __dirname;
const port = Number(process.env.PORT || 5173);
const publicHost = process.env.HOST || "127.0.0.1";
const baseUrl = (process.env.BASE_URL || `http://${publicHost}:${port}`).replace(/\/$/, "");
const redirectUri = process.env.DISCORD_REDIRECT_URI || `${baseUrl}/auth/discord/callback`;
const clientId = process.env.DISCORD_CLIENT_ID || "";
const clientSecret = process.env.DISCORD_CLIENT_SECRET || "";
const requiredGuildId = process.env.DISCORD_REQUIRED_GUILD_ID || "";
const allowedUserIds = parseCsv(process.env.DISCORD_ALLOWED_USER_IDS || "");
const secretManagerUserIds = parseCsv(process.env.DISCORD_SECRET_MANAGER_USER_IDS || "");
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const sessions = new Map();

let mysqlPool;

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/login") return renderLogin(request, response);
    if (url.pathname === "/auth/discord") return redirectToDiscord(response);
    if (url.pathname === "/auth/discord/callback") return handleDiscordCallback(url, response);
    if (url.pathname === "/logout") return handleLogout(request, response);

    const session = getSession(request);
    if (!session?.user) {
      if (url.pathname.startsWith("/api/")) return sendJson(response, 401, { error: "unauthorized" });
      redirect(response, "/login");
      return;
    }

    if (url.pathname === "/api/me") return renderCurrentUser(session, response);
    if (url.pathname === "/api/accounts" && request.method === "GET") return listAccounts(response);
    if (url.pathname === "/api/accounts" && request.method === "POST") return createAccount(request, response, session);

    const deleteMatch = url.pathname.match(/^\/api\/accounts\/(\d+)$/);
    if (deleteMatch && request.method === "DELETE") {
      return deleteAccount(Number(deleteMatch[1]), response, session);
    }

    serveStatic(url, response);
  } catch (error) {
    console.error(error);
    if (request.url?.startsWith("/api/")) {
      sendJson(response, 500, { error: "server_error" });
      return;
    }
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Server error");
  }
});

server.listen(port, publicHost, () => {
  console.log(`Shared MFA Vault: ${baseUrl}`);
  console.log(`Discord redirect URI: ${redirectUri}`);
});

async function listAccounts(response) {
  const [rows] = await getDb().execute(
    `SELECT id, service_name, account_name, role_name, encrypted_secret, iv, auth_tag
       FROM totp_accounts
      WHERE deleted_at IS NULL
      ORDER BY service_name ASC, account_name ASC`,
  );

  const accounts = rows.map((row) => {
    const secret = decryptSecret(row.encrypted_secret, row.iv, row.auth_tag);
    return {
      id: row.id,
      service: row.service_name,
      account: row.account_name,
      role: row.role_name || "Uncategorized",
      token: generateToken(secret),
    };
  });

  sendJson(response, 200, { accounts });
}

async function createAccount(request, response, session) {
  if (!canAddSecrets(session.user.id)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  const body = await readJson(request);
  const serviceName = String(body.service || "").trim();
  const accountName = String(body.account || "").trim();
  const roleName = String(body.role || "").trim() || null;
  const secret = normalizeSecret(String(body.secret || ""));

  if (!serviceName || !accountName || !secret) {
    sendJson(response, 400, { error: "missing_required_fields" });
    return;
  }

  generateToken(secret);
  const encrypted = encryptSecret(secret);

  const [result] = await getDb().execute(
    `INSERT INTO totp_accounts
      (service_name, account_name, role_name, encrypted_secret, iv, auth_tag, created_by_discord_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      serviceName,
      accountName,
      roleName,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      session.user.id,
    ],
  );

  sendJson(response, 201, { id: result.insertId });
}

async function deleteAccount(id, response, session) {
  if (!canAddSecrets(session.user.id)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  await getDb().execute(
    `UPDATE totp_accounts
        SET deleted_at = CURRENT_TIMESTAMP,
            updated_by_discord_id = ?
      WHERE id = ? AND deleted_at IS NULL`,
    [session.user.id, id],
  );

  sendJson(response, 200, { ok: true });
}

function redirectToDiscord(response) {
  assertDiscordConfig();

  const state = crypto.randomBytes(24).toString("hex");
  const authSession = createSession({ oauthState: state });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "identify guilds",
    state,
    redirect_uri: redirectUri,
    prompt: "none",
  });

  response.writeHead(302, {
    Location: `https://discord.com/oauth2/authorize?${params}`,
    "Set-Cookie": buildSessionCookie(authSession.id),
  });
  response.end();
}

async function handleDiscordCallback(url, response) {
  assertDiscordConfig();

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const session = Array.from(sessions.values()).find((item) => item.oauthState === state);

  if (!code || !state || !session) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Discord login state is invalid. Please try again.");
    return;
  }

  const token = await exchangeDiscordCode(code);
  const [user, guilds] = await Promise.all([
    discordFetch("/users/@me", token.access_token),
    discordFetch("/users/@me/guilds", token.access_token),
  ]);

  const userAllowed = allowedUserIds.size === 0 || allowedUserIds.has(user.id);
  const guildAllowed = !requiredGuildId || guilds.some((guild) => guild.id === requiredGuildId);

  if (!userAllowed || !guildAllowed) {
    sessions.delete(session.id);
    response.writeHead(403, {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": clearSessionCookie(),
    });
    response.end(renderDeniedPage({ userAllowed, guildAllowed }));
    return;
  }

  session.oauthState = "";
  session.user = {
    id: user.id,
    username: user.username,
    globalName: user.global_name || "",
    avatar: user.avatar || "",
    canAddSecrets: canAddSecrets(user.id),
    guildIds: guilds.map((guild) => guild.id),
    loggedInAt: new Date().toISOString(),
  };

  response.writeHead(302, {
    Location: "/",
    "Set-Cookie": buildSessionCookie(session.id),
  });
  response.end();
}

async function exchangeDiscordCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) throw new Error(`Discord token exchange failed: ${response.status}`);
  return response.json();
}

async function discordFetch(resource, accessToken) {
  const response = await fetch(`https://discord.com/api/v10${resource}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) throw new Error(`Discord API request failed: ${resource} ${response.status}`);
  return response.json();
}

function renderLogin(request, response) {
  const session = getSession(request);
  if (session?.user) {
    redirect(response, "/");
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Discord Login - Shared MFA Vault</title>
    <style>
      body { align-items: center; background: #f5f7fb; color: #172033; display: flex; font-family: system-ui, sans-serif; min-height: 100vh; margin: 0; padding: 24px; }
      main { background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; box-shadow: 0 16px 42px rgba(20,35,65,.12); margin: auto; max-width: 520px; padding: 32px; }
      h1 { margin: 0 0 12px; }
      p { color: #667085; line-height: 1.7; }
      a { align-items: center; background: #5865f2; border-radius: 8px; color: #fff; display: inline-flex; font-weight: 800; min-height: 44px; padding: 0 18px; text-decoration: none; }
      .warn { background: #fff7e6; border-radius: 8px; color: #7a4b00; padding: 12px 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Discord Login</h1>
      <p>This page is available only to authorized Discord server members.</p>
      ${isDiscordConfigured() ? "" : '<p class="warn">Discord OAuth is not configured yet. Set your .env file.</p>'}
      <a href="/auth/discord">Continue with Discord</a>
    </main>
  </body>
</html>`);
}

function renderDeniedPage({ userAllowed, guildAllowed }) {
  const reasons = [];
  if (!userAllowed) reasons.push("This Discord account is not allowed.");
  if (!guildAllowed) reasons.push("Required Discord server membership was not found.");

  return `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8"><title>Access denied</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 32px;">
    <h1>Access denied</h1>
    <p>${reasons.join("<br>")}</p>
    <p><a href="/login">Back to login</a></p>
  </body>
</html>`;
}

function renderCurrentUser(session, response) {
  sendJson(response, 200, {
    authenticated: true,
    user: {
      ...session.user,
      canAddSecrets: canAddSecrets(session.user.id),
    },
  });
}

function handleLogout(request, response) {
  const session = getSession(request);
  if (session) sessions.delete(session.id);
  response.writeHead(302, {
    Location: "/login",
    "Set-Cookie": clearSessionCookie(),
  });
  response.end();
}

function serveStatic(url, response) {
  const pathname = decodeURIComponent(url.pathname);
  const safePath = path
    .normalize(pathname === "/" ? "/index.html" : pathname)
    .replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, safePath);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(content);
  });
}

function getDb() {
  if (mysqlPool) return mysqlPool;

  let mysql;
  try {
    mysql = require("mysql2/promise");
  } catch (error) {
    throw new Error("mysql2 is not installed. Run npm install before starting the server.");
  }

  mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
    namedPlaceholders: false,
  });
  return mysqlPool;
}

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getVaultEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decryptSecret(ciphertext, iv, authTag) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", getVaultEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function getVaultEncryptionKey() {
  const value = process.env.VAULT_ENCRYPTION_KEY || "";
  if (!value) throw new Error("VAULT_ENCRYPTION_KEY is required.");

  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");

  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) return decoded;
  } catch (error) {
    // Fall through to deterministic derivation for compatibility.
  }

  return crypto.createHash("sha256").update(value).digest();
}

function normalizeSecret(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("otpauth://")) {
    const url = new URL(trimmed);
    return (url.searchParams.get("secret") || "").replace(/\s+/g, "").toUpperCase();
  }

  return trimmed.replace(/\s+/g, "").toUpperCase();
}

function generateToken(secret) {
  return authenticator.generateToken(secret).replace(/\s+/g, "").padStart(6, "0");
}

function createSession(data = {}) {
  const session = {
    id: crypto.randomBytes(32).toString("hex"),
    createdAt: Date.now(),
    ...data,
  };
  sessions.set(session.id, session);
  return session;
}

function getSession(request) {
  const cookie = parseCookies(request.headers.cookie || "").mfa_session;
  if (!cookie) return null;

  const [id, signature] = cookie.split(".");
  if (!id || !signature || sign(id) !== signature) return null;
  return sessions.get(id) || null;
}

function buildSessionCookie(sessionId) {
  const secure = baseUrl.startsWith("https://") ? " Secure;" : "";
  return `mfa_session=${sessionId}.${sign(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400;${secure}`;
}

function clearSessionCookie() {
  return "mfa_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((cookie) => cookie.trim().split("="))
      .filter(([key, value]) => key && value),
  );
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function isDiscordConfigured() {
  return Boolean(clientId && clientSecret);
}

function assertDiscordConfig() {
  if (!isDiscordConfigured()) {
    throw new Error("DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required.");
  }
}

function parseCsv(value) {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function canAddSecrets(userId) {
  if (secretManagerUserIds.size > 0) {
    return secretManagerUserIds.has(userId);
  }
  return allowedUserIds.size > 0 && allowedUserIds.has(userId);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = cleanEnvValue(rawValue);
  }
}

function resolveEnvFilePath() {
  if (!process.env.ENV_FILE) {
    return path.join(__dirname, ".env");
  }

  if (!path.isAbsolute(process.env.ENV_FILE)) {
    throw new Error("ENV_FILE must be an absolute path.");
  }

  return process.env.ENV_FILE;
}

function cleanEnvValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed.replace(/\s+#.*$/, "").trim();
}
