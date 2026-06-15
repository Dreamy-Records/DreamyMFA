const COOKIE_SESSION = "mfa_session";
const COOKIE_OAUTH_STATE = "mfa_oauth_state";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/login") return renderLogin(request, env);
      if (url.pathname === "/auth/discord") return redirectToDiscord(request, env);
      if (url.pathname === "/auth/discord/callback") return handleDiscordCallback(request, env);
      if (url.pathname === "/logout") return logout();

      const session = await getSession(request, env);
      if (!session) {
        if (url.pathname.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
        return Response.redirect(`${url.origin}/login`, 302);
      }

      if (url.pathname === "/api/me") return currentUser(session, env);
      if (url.pathname === "/api/accounts" && request.method === "GET") return listAccounts(env);
      if (url.pathname === "/api/accounts" && request.method === "POST") return createAccount(request, env, session);

      const deleteMatch = url.pathname.match(/^\/api\/accounts\/(\d+)$/);
      if (deleteMatch && request.method === "DELETE") {
        return deleteAccount(Number(deleteMatch[1]), env, session);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "server_error" }, 500);
    }
  },
};

async function listAccounts(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, service_name, account_name, role_name, encrypted_secret, iv
       FROM totp_accounts
      WHERE deleted_at IS NULL
      ORDER BY service_name ASC, account_name ASC`,
  ).all();

  const accounts = [];
  for (const row of results) {
    const secret = await decryptSecret(row.encrypted_secret, row.iv, env);
    accounts.push({
      id: row.id,
      service: row.service_name,
      account: row.account_name,
      role: row.role_name || "未分類",
      secret,
      token: await generateTotp(secret),
    });
  }

  return json({ accounts, serverTime: Date.now() });
}

async function createAccount(request, env, session) {
  if (!canAddSecrets(session.id, env)) return json({ error: "forbidden" }, 403);

  const body = await request.json();
  const serviceName = String(body.service || "").trim();
  const accountName = String(body.account || "").trim();
  const roleName = String(body.role || "").trim();
  const secret = normalizeSecret(String(body.secret || ""));

  if (!serviceName || !accountName || !secret) {
    return json({ error: "missing_required_fields" }, 400);
  }

  await generateTotp(secret);
  const encrypted = await encryptSecret(secret, env);

  const result = await env.DB.prepare(
    `INSERT INTO totp_accounts
      (service_name, account_name, role_name, encrypted_secret, iv, created_by_discord_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(serviceName, accountName, roleName || null, encrypted.ciphertext, encrypted.iv, session.id)
    .run();

  return json({ id: result.meta.last_row_id }, 201);
}

async function deleteAccount(id, env, session) {
  if (!canAddSecrets(session.id, env)) return json({ error: "forbidden" }, 403);

  await env.DB.prepare(
    `UPDATE totp_accounts
        SET deleted_at = CURRENT_TIMESTAMP,
            updated_by_discord_id = ?
      WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(session.id, id)
    .run();

  return json({ ok: true });
}

async function renderLogin(request, env) {
  const session = await getSession(request, env);
  if (session) return Response.redirect(new URL("/", request.url), 302);

  return html(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0f1b31">
    <link rel="manifest" href="/manifest.webmanifest">
    <title>Discordログイン - Dreamy MFA</title>
    <style>
      body { align-items: center; background: #f5f7fb; color: #172033; display: flex; font-family: system-ui, sans-serif; min-height: 100vh; margin: 0; padding: 24px; }
      main { background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; box-shadow: 0 16px 42px rgba(20,35,65,.12); margin: auto; max-width: 520px; padding: 32px; }
      h1 { margin: 0 0 12px; }
      p { color: #667085; line-height: 1.7; }
      a { align-items: center; background: #5865f2; border-radius: 8px; color: #fff; display: inline-flex; font-weight: 800; min-height: 44px; padding: 0 18px; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>Dreamy MFA</h1>
      <p>このページは許可されたDiscordユーザーだけが利用できます。</p>
      <a href="/auth/discord">Discordで続行</a>
    </main>
  </body>
</html>`);
}

async function redirectToDiscord(request, env) {
  assertDiscordConfig(env);

  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const signedState = await signValue(state, env.SESSION_SECRET);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.DISCORD_CLIENT_ID,
    scope: "identify guilds",
    state,
    redirect_uri: redirectUri(request, env),
    prompt: "none",
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://discord.com/oauth2/authorize?${params}`,
      "Set-Cookie": cookie(COOKIE_OAUTH_STATE, signedState, url.protocol === "https:", OAUTH_STATE_MAX_AGE_SECONDS),
    },
  });
}

async function handleDiscordCallback(request, env) {
  assertDiscordConfig(env);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const signedState = parseCookies(request.headers.get("Cookie") || "")[COOKIE_OAUTH_STATE];
  const verifiedState = signedState ? await verifySignedValue(signedState, env.SESSION_SECRET) : "";

  if (!code || !state || verifiedState !== state) {
    return new Response("Discord login state is invalid. Please try again.", { status: 400 });
  }

  const token = await exchangeDiscordCode(code, request, env);
  const [user, guilds] = await Promise.all([
    discordFetch("/users/@me", token.access_token),
    discordFetch("/users/@me/guilds", token.access_token),
  ]);

  const allowedUsers = parseCsv(env.DISCORD_ALLOWED_USER_IDS || "");
  const userAllowed = allowedUsers.size === 0 || allowedUsers.has(user.id);
  const guildAllowed = !env.DISCORD_REQUIRED_GUILD_ID || guilds.some((guild) => guild.id === env.DISCORD_REQUIRED_GUILD_ID);

  if (!userAllowed || !guildAllowed) {
    return html("<h1>アクセスできません</h1><p>必要なDiscord権限が確認できませんでした。</p>", 403);
  }

  const sessionPayload = {
    id: user.id,
    username: user.username,
    globalName: user.global_name || "",
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const signedSession = await signJson(sessionPayload, env.SESSION_SECRET);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookie(COOKIE_SESSION, signedSession, url.protocol === "https:"));
  headers.append("Set-Cookie", clearCookie(COOKIE_OAUTH_STATE));

  return new Response(null, { status: 302, headers });
}

function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie": clearCookie(COOKIE_SESSION),
    },
  });
}

function currentUser(session, env) {
  return json({
    authenticated: true,
    serverTime: Date.now(),
    user: {
      id: session.id,
      username: session.username,
      globalName: session.globalName,
      canAddSecrets: canAddSecrets(session.id, env),
    },
  });
}

async function exchangeDiscordCode(code, request, env) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(request, env),
  });

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`)}`,
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

function redirectUri(request, env) {
  if (env.DISCORD_REDIRECT_URI) return env.DISCORD_REDIRECT_URI;
  return `${new URL(request.url).origin}/auth/discord/callback`;
}

async function getSession(request, env) {
  const signed = parseCookies(request.headers.get("Cookie") || "")[COOKIE_SESSION];
  if (!signed) return null;

  const session = await verifySignedJson(signed, env.SESSION_SECRET);
  if (!session || session.exp < Math.floor(Date.now() / 1000)) return null;
  return session;
}

async function encryptSecret(secret, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getVaultKey(env);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret)),
  );
  return { ciphertext, iv };
}

async function decryptSecret(ciphertext, iv, env) {
  const key = await getVaultKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBytes(iv) },
    key,
    toBytes(ciphertext),
  );
  return new TextDecoder().decode(plain);
}

async function getVaultKey(env) {
  if (!env.VAULT_ENCRYPTION_KEY) throw new Error("VAULT_ENCRYPTION_KEY is required.");
  const raw = /^[0-9a-f]{64}$/i.test(env.VAULT_ENCRYPTION_KEY)
    ? hexToBytes(env.VAULT_ENCRYPTION_KEY)
    : await sha256Bytes(env.VAULT_ENCRYPTION_KEY);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function generateTotp(secret, timestamp = Date.now()) {
  const key = await crypto.subtle.importKey(
    "raw",
    base32ToBytes(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = Math.floor(timestamp / 1000 / 30);
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setUint32(4, counter);
  const hash = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
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

function base32ToBytes(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value === -1) throw new Error("Invalid base32 secret.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

async function signJson(payload, secret) {
  return signValue(base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload))), secret);
}

async function verifySignedJson(value, secret) {
  const payload = await verifySignedValue(value, secret);
  if (!payload) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch (error) {
    return null;
  }
}

async function signValue(value, secret) {
  const signature = await hmacSha256(value, secret);
  return `${value}.${base64UrlEncode(signature)}`;
}

async function verifySignedValue(value, secret) {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return "";
  const expected = base64UrlEncode(await hmacSha256(payload, secret));
  return timingSafeEqual(signature, expected) ? payload : "";
}

async function hmacSha256(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function cookie(name, value, secure, maxAge = SESSION_MAX_AGE_SECONDS) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge};${secure ? " Secure;" : ""}`;
}

function clearCookie(name) {
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    const value = valueParts.join("=");
    if (key && value) cookies[key] = value;
  }
  return cookies;
}

function canAddSecrets(userId, env) {
  const managers = parseCsv(env.DISCORD_SECRET_MANAGER_USER_IDS || "");
  if (managers.size > 0) return managers.has(userId);
  return parseCsv(env.DISCORD_ALLOWED_USER_IDS || "").has(userId);
}

function parseCsv(value) {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function assertDiscordConfig(env) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    throw new Error("Discord OAuth is not configured.");
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}
