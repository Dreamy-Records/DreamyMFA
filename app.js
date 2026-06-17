const ACCOUNT_CACHE_KEY = "dreamy-mfa.accounts.v1";
const SERVICE_WORKER_CACHE = "dreamy-mfa-v6";

const state = {
  accounts: [],
  selectedId: "",
  canAddSecrets: false,
  cameraStream: null,
  qrFrameId: 0,
  serverTimeOffsetMs: 0,
  offlineMode: false,
  offlineReady: false,
  syncConfirmed: false,
  accessRevoked: false,
  lastSyncAt: 0,
  syncing: false,
};

const els = {
  workspace: document.querySelector("#workspace"),
  lockButton: document.querySelector("#lockButton"),
  secretForm: document.querySelector("#secretForm"),
  searchInput: document.querySelector("#searchInput"),
  accountList: document.querySelector("#accountList"),
  accountCount: document.querySelector("#accountCount"),
  template: document.querySelector("#accountTemplate"),
  emptyState: document.querySelector("#emptyState"),
  tokenView: document.querySelector("#tokenView"),
  selectedRole: document.querySelector("#selectedRole"),
  selectedService: document.querySelector("#selectedService"),
  selectedAccount: document.querySelector("#selectedAccount"),
  tokenText: document.querySelector("#tokenText"),
  copyTokenButton: document.querySelector("#copyTokenButton"),
  deleteButton: document.querySelector("#deleteButton"),
  timeLeft: document.querySelector("#timeLeft"),
  currentTime: document.querySelector("#currentTime"),
  syncStatus: document.querySelector("#syncStatus"),
  progressBar: document.querySelector("#progressBar"),
  serviceInput: document.querySelector("#serviceInput"),
  accountInput: document.querySelector("#accountInput"),
  roleInput: document.querySelector("#roleInput"),
  secretInput: document.querySelector("#secretInput"),
  addPanel: document.querySelector("#addPanel"),
  qrFileInput: document.querySelector("#qrFileInput"),
  qrFileButton: document.querySelector("#qrFileButton"),
  qrCameraButton: document.querySelector("#qrCameraButton"),
  qrStopButton: document.querySelector("#qrStopButton"),
  qrVideo: document.querySelector("#qrVideo"),
  qrCanvas: document.querySelector("#qrCanvas"),
  qrStatus: document.querySelector("#qrStatus"),
  cameraPanel: document.querySelector("#cameraPanel"),
  discordUser: document.querySelector("#discordUser"),
};

registerServiceWorker();
init();

els.lockButton.addEventListener("click", () => {
  stopQrCamera();
  localStorage.removeItem(ACCOUNT_CACHE_KEY);
  location.href = "/logout";
});

els.secretForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.canAddSecrets) {
    alert("このDiscordアカウントには追加権限がありません。");
    return;
  }
  if (state.offlineMode) {
    alert("オフライン中は追加できません。オンラインに戻ってから保存してください。");
    return;
  }

  const payload = {
    service: els.serviceInput.value.trim(),
    account: els.accountInput.value.trim(),
    role: els.roleInput.value.trim(),
    secret: els.secretInput.value.trim(),
  };

  if (!payload.service || !payload.account || !payload.secret) {
    alert("サービス名、アカウント、シードを入力してください。");
    return;
  }

  const response = await fetch("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    alert("保存できませんでした。入力内容または権限を確認してください。");
    return;
  }

  els.secretForm.reset();
  setQrStatus("保存しました。");
  await loadAccounts({ showError: true });
});

els.searchInput.addEventListener("input", renderAccounts);
els.qrFileButton.addEventListener("click", () => els.qrFileInput.click());
els.qrFileInput.addEventListener("change", handleQrFile);
els.qrCameraButton.addEventListener("click", startQrCamera);
els.qrStopButton.addEventListener("click", stopQrCamera);

els.copyTokenButton.addEventListener("click", async () => {
  const token = els.tokenText.textContent;
  if (!/^\d{6}$/.test(token)) return;
  await navigator.clipboard.writeText(token);
  els.copyTokenButton.querySelector("small").textContent = "コピーしました";
  window.setTimeout(() => {
    els.copyTokenButton.querySelector("small").textContent = "クリックしてコピー";
  }, 1400);
});

els.deleteButton.addEventListener("click", async () => {
  if (!state.canAddSecrets) {
    alert("このDiscordアカウントには削除権限がありません。");
    return;
  }
  if (state.offlineMode) {
    alert("オフライン中は削除できません。オンラインに戻ってから削除してください。");
    return;
  }

  const selected = currentAccount();
  if (!selected) return;
  const ok = confirm(`${selected.service} / ${selected.account} を削除しますか？`);
  if (!ok) return;

  const response = await fetch(`/api/accounts/${selected.id}`, { method: "DELETE" });
  if (!response.ok) {
    alert("削除できませんでした。");
    return;
  }

  state.selectedId = "";
  await loadAccounts({ showError: true });
});

window.addEventListener("online", () => loadAccounts({ showError: false }));
window.addEventListener("offline", () => enableOfflineFromCache());
window.setInterval(tick, 1000);

async function init() {
  await tick();

  const currentUser = await loadCurrentUser();
  if (!currentUser) {
    if (state.accessRevoked) return;
    if (shouldUseOfflineFallback()) {
      const restored = await enableOfflineFromCache();
      if (restored) return;
    }
    location.href = "/login";
    return;
  }

  state.canAddSecrets = Boolean(currentUser.canAddSecrets);
  state.offlineMode = false;
  updatePermissionUi();
  els.workspace.classList.remove("hidden");

  await loadAccounts({ showError: true });
  await tick();
}

async function loadAccounts({ showError = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;

  try {
    const response = await fetch("/api/accounts", { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      forceLogout();
      return;
    }
    if (!response.ok) throw new Error("accounts request failed");

    const data = await response.json();
    applyServerTime(data.serverTime);
    state.offlineMode = false;
    state.lastSyncAt = Date.now();
    state.accounts = await hydrateAccounts(data.accounts || []);
    cacheAccounts(state.accounts);
    await prepareOfflineApp();

    if (!state.accounts.some((account) => account.id === state.selectedId)) {
      state.selectedId = state.accounts[0]?.id || "";
    }

    updatePermissionUi();
    renderAccounts();
  } catch (error) {
    const restored = shouldUseOfflineFallback() ? await enableOfflineFromCache() : false;
    if (!restored && showError) {
      alert("認証コード一覧を読み込めませんでした。");
      state.accounts = [];
      renderAccounts();
    }
  } finally {
    state.syncing = false;
  }
}

async function hydrateAccounts(accounts) {
  const now = syncedNow();
  return Promise.all(
    accounts.map(async (account) => ({
      id: account.id,
      service: account.service,
      account: account.account,
      role: account.role || "未分類",
      secret: account.secret,
      token: account.secret ? await generateTotp(account.secret, now) : account.token,
    })),
  );
}

function renderAccounts() {
  const query = els.searchInput.value.trim().toLowerCase();
  const accounts = state.accounts.filter((account) => {
    const text = `${account.service} ${account.account} ${account.role}`.toLowerCase();
    return text.includes(query);
  });

  els.accountList.replaceChildren();
  els.accountCount.textContent = `${accounts.length}件`;

  for (const account of accounts) {
    const item = els.template.content.firstElementChild.cloneNode(true);
    item.classList.toggle("active", account.id === state.selectedId);
    item.querySelector(".account-service").textContent = account.service;
    item.querySelector(".account-name").textContent = account.account;
    item.querySelector(".account-role").textContent = account.role;
    item.addEventListener("click", () => {
      state.selectedId = account.id;
      renderAccounts();
      renderSelection();
    });
    els.accountList.append(item);
  }

  renderSelection();
}

function renderSelection() {
  const account = currentAccount();
  els.emptyState.classList.toggle("hidden", Boolean(account));
  els.tokenView.classList.toggle("hidden", !account);
  if (!account) return;

  els.selectedRole.textContent = account.role;
  els.selectedService.textContent = account.service;
  els.selectedAccount.textContent = account.account;
  els.tokenText.textContent = account.token || "------";
}

async function tick() {
  const now = syncedNow();
  const seconds = Math.floor(now / 1000);
  const remaining = 30 - (seconds % 30);

  els.timeLeft.textContent = String(remaining).padStart(2, "0");
  if (els.currentTime) els.currentTime.textContent = formatTime(now);
  els.progressBar.style.width = `${(remaining / 30) * 100}%`;
  updateSyncStatus();

  await refreshTokens(now);
  renderSelection();

  if (!state.offlineMode && navigator.onLine && Date.now() - state.lastSyncAt > 30_000) {
    await loadAccounts({ showError: false });
  }
}

async function refreshTokens(now) {
  for (const account of state.accounts) {
    if (account.secret) account.token = await generateTotp(account.secret, now);
  }
}

async function enableOfflineFromCache() {
  const cached = loadCachedAccounts();
  if (!cached.length) return false;

  state.accounts = await hydrateAccounts(cached);
  state.offlineMode = true;
  state.canAddSecrets = false;
  if (!state.accounts.some((account) => account.id === state.selectedId)) {
    state.selectedId = state.accounts[0]?.id || "";
  }

  els.discordUser.textContent = "オフラインモード";
  updatePermissionUi();
  els.workspace.classList.remove("hidden");
  renderAccounts();
  updateSyncStatus();
  return true;
}

function cacheAccounts(accounts) {
  const payload = accounts.map(({ id, service, account, role, secret }) => ({
    id,
    service,
    account,
    role,
    secret,
  }));
  localStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(payload));
}

function loadCachedAccounts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNT_CACHE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((account) => account.secret) : [];
  } catch (error) {
    return [];
  }
}

function updatePermissionUi() {
  els.addPanel.classList.toggle("hidden", !state.canAddSecrets || state.offlineMode);
  els.deleteButton.classList.toggle("hidden", !state.canAddSecrets || state.offlineMode);
}

function applyServerTime(serverTime) {
  if (Number.isFinite(serverTime)) {
    state.serverTimeOffsetMs = serverTime - Date.now();
    state.syncConfirmed = true;
  }
}

function syncedNow() {
  return Date.now() + state.serverTimeOffsetMs;
}

function updateSyncStatus() {
  if (!els.syncStatus) return;

  if (state.offlineMode) {
    els.syncStatus.textContent = "オフライン: 保存済みデータで生成中";
    return;
  }

  if (!state.syncConfirmed) {
    els.syncStatus.textContent = "サーバー同期確認中";
    return;
  }

  const drift = Math.round(state.serverTimeOffsetMs / 1000);
  const absolute = Math.abs(drift);
  const syncText = absolute <= 1
    ? "サーバー時刻と同期済み"
    : `サーバー時刻との差 ${drift > 0 ? "+" : ""}${drift}秒`;
  els.syncStatus.textContent = state.offlineReady ? `${syncText} / PWA準備OK` : syncText;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

async function prepareOfflineApp() {
  if (!("serviceWorker" in navigator) || !("caches" in window)) return;

  try {
    await navigator.serviceWorker.ready;
    const cache = await caches.open(SERVICE_WORKER_CACHE);
    const required = [
      "/index.html",
      "/styles.css",
      "/app.js",
      "/dist/authenticator.bundle.js",
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
    ];

    await Promise.all(
      required.map(async (url) => {
        const response = await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
        if (response.ok && response.type === "basic" && !response.redirected) {
          await cache.put(url, response);
        }
      }),
    );
    state.offlineReady = true;
    updateSyncStatus();
  } catch (error) {
    state.offlineReady = false;
  }
}

async function handleQrFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    setQrStatus("QR画像を読み取っています...");
    const image = await loadImage(file);
    const result = decodeQrFromSource(image);
    applyQrResult(result);
  } catch (error) {
    setQrStatus(error.message || "QRコードを読み取れませんでした。");
  } finally {
    els.qrFileInput.value = "";
  }
}

async function startQrCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setQrStatus("このブラウザではカメラ読み取りを利用できません。QR画像を選択してください。");
    return;
  }

  try {
    stopQrCamera();
    setQrStatus("カメラを起動しています...");
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    els.qrVideo.srcObject = state.cameraStream;
    els.cameraPanel.classList.remove("hidden");
    await els.qrVideo.play();
    setQrStatus("QRコードをカメラに向けてください。");
    scanQrVideo();
  } catch (error) {
    setQrStatus("カメラを起動できませんでした。権限を確認するか、QR画像を選択してください。");
  }
}

function scanQrVideo() {
  if (!state.cameraStream) return;

  try {
    const result = decodeQrFromSource(els.qrVideo);
    applyQrResult(result);
    stopQrCamera();
  } catch (error) {
    state.qrFrameId = window.requestAnimationFrame(scanQrVideo);
  }
}

function stopQrCamera() {
  if (state.qrFrameId) {
    window.cancelAnimationFrame(state.qrFrameId);
    state.qrFrameId = 0;
  }
  if (state.cameraStream) {
    for (const track of state.cameraStream.getTracks()) {
      track.stop();
    }
  }
  state.cameraStream = null;
  els.qrVideo.srcObject = null;
  els.cameraPanel.classList.add("hidden");
}

function decodeQrFromSource(source) {
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  if (!width || !height) {
    throw new Error("QRコードを読み取る準備ができていません。");
  }

  const canvas = els.qrCanvas;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const result = window.SharedQr?.decode(imageData.data, width, height);
  if (!result) {
    throw new Error("QRコードを読み取れませんでした。");
  }
  return result;
}

function applyQrResult(value) {
  const parsed = parseOtpAuth(value);
  if (!parsed.secret) {
    throw new Error("TOTP用のQRコードではありません。");
  }

  els.secretInput.value = value;
  els.serviceInput.value = parsed.issuer || els.serviceInput.value || "X";
  els.accountInput.value = parsed.account || els.accountInput.value;
  els.roleInput.value = els.roleInput.value || "SNS";
  setQrStatus("QRコードを読み取りました。内容を確認して保存してください。");
}

function parseOtpAuth(value) {
  if (!value.startsWith("otpauth://")) {
    return { secret: value.trim(), issuer: "", account: "" };
  }

  const url = new URL(value);
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const [labelIssuer, ...accountParts] = label.split(":");
  const issuer = url.searchParams.get("issuer") || (accountParts.length ? labelIssuer : "");
  const account = accountParts.length ? accountParts.join(":") : labelIssuer;

  return {
    secret: url.searchParams.get("secret") || "",
    issuer,
    account,
  };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(image.src);
      resolve(image);
    };
    image.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    image.src = URL.createObjectURL(file);
  });
}

function setQrStatus(message) {
  els.qrStatus.textContent = message;
}

async function loadCurrentUser() {
  try {
    const response = await fetch("/api/me", { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      forceLogout();
      return null;
    }
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.authenticated) return null;
    applyServerTime(data.serverTime);
    const name = data.user.globalName || data.user.username || data.user.id;
    els.discordUser.textContent = name;
    return data.user;
  } catch (error) {
    els.discordUser.textContent = "オフラインモード";
    return null;
  }
}

function forceLogout() {
  state.accessRevoked = true;
  state.offlineMode = false;
  state.accounts = [];
  localStorage.removeItem(ACCOUNT_CACHE_KEY);
  location.replace("/login");
}

function shouldUseOfflineFallback() {
  return !state.accessRevoked && navigator.onLine === false;
}

function currentAccount() {
  return state.accounts.find((account) => account.id === state.selectedId);
}

async function generateTotp(secret, timestamp) {
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

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
    } catch (error) {
      state.offlineReady = false;
    }
  });
}
