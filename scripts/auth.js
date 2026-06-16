/**
 * Shared-password auth for the Lambert API.
 *
 * On login, we hash the user's password with SHA-256 in the browser and
 * store the lowercase-hex digest in localStorage. Every request to
 * api/nyx/lambert.php carries it as X-Auth. PHP compares against a hash
 * in api/nyx/config.local.php via hash_equals.
 *
 * This is deliberately low-security — it's a gate against casual hot-linking,
 * not a defense against a determined attacker. Any authenticated user can
 * read the hash out of localStorage and replay it.
 */

const AUTH_KEY = "marslink_auth";
const PING_URL = "api/nyx/lambert.php?ping=1";

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function getAuthToken() {
  try { return localStorage.getItem(AUTH_KEY) || ""; } catch { return ""; }
}

export function isAuthed() {
  return getAuthToken().length === 64;
}

export function clearAuthToken() {
  try { localStorage.removeItem(AUTH_KEY); } catch {}
  updateAuthButton();
  window.dispatchEvent(new CustomEvent("marslink:auth-changed"));
}

/** Verify a password against the server. On success, persist and return true. */
export async function login(password) {
  const token = await sha256Hex(password);
  const resp = await fetch(PING_URL, { headers: { "X-Auth": token } });
  if (resp.status === 200) {
    try { localStorage.setItem(AUTH_KEY, token); } catch {}
    updateAuthButton();
    window.dispatchEvent(new CustomEvent("marslink:auth-changed"));
    return { ok: true };
  }
  let err = "auth_required";
  try { err = (await resp.json()).error || err; } catch {}
  return { ok: false, error: err, status: resp.status };
}

/** fetch() wrapper that attaches X-Auth. Throws a special error on 401. */
export async function authedFetch(url, opts = {}) {
  const token = getAuthToken();
  const headers = new Headers(opts.headers || {});
  if (token) headers.set("X-Auth", token);
  const resp = await fetch(url, { ...opts, headers });
  if (resp.status === 401) {
    // Surface a typed error so callers can distinguish auth from other failures.
    let code = "auth_required";
    try { code = (await resp.clone().json()).error || code; } catch {}
    clearAuthToken();
    const err = new Error(code);
    err.authRequired = true;
    err.code = code;
    throw err;
  }
  return resp;
}

// ---------------------------------------------------------------------------
// UI: login popup in the top bar
// ---------------------------------------------------------------------------

function updateAuthButton() {
  const btn = document.getElementById("auth-btn");
  if (!btn) return;
  btn.textContent = isAuthed() ? "Logout" : "Login";
  btn.setAttribute("aria-label", isAuthed() ? "Log out" : "Log in");
}

function openPopup(popup, btn) {
  popup.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  const input = popup.querySelector('input[type="password"]');
  if (input) {
    input.value = "";
    input.focus();
  }
  const status = popup.querySelector(".auth-status");
  if (status) status.textContent = "";
}
function closePopup(popup, btn) {
  popup.hidden = true;
  btn.setAttribute("aria-expanded", "false");
}

/**
 * Programmatically open the login popup. Used by in-chart "Log in" buttons
 * so callers don't have to synthesize a click on the top-bar button (which
 * is fragile because of the document-level outside-click listener).
 * No-op if the user is already logged in.
 */
export function openLoginPopup() {
  if (isAuthed()) return;
  const btn = document.getElementById("auth-btn");
  const popup = document.getElementById("auth-popup");
  if (!btn || !popup) return;
  if (popup.hidden) openPopup(popup, btn);
}

export function wireAuthUi() {
  const btn = document.getElementById("auth-btn");
  const popup = document.getElementById("auth-popup");
  if (!btn || !popup) return;

  updateAuthButton();

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isAuthed()) {
      clearAuthToken();
      return;
    }
    if (popup.hidden) openPopup(popup, btn);
    else closePopup(popup, btn);
  });

  document.addEventListener("click", (e) => {
    if (popup.hidden) return;
    if (popup.contains(e.target) || btn.contains(e.target)) return;
    closePopup(popup, btn);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popup.hidden) closePopup(popup, btn);
  });

  const form = popup.querySelector("form");
  const status = popup.querySelector(".auth-status");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = form.querySelector('input[type="password"]').value;
    if (!pw) return;
    status.textContent = "Checking…";
    const res = await login(pw);
    if (res.ok) {
      status.textContent = "";
      closePopup(popup, btn);
    } else if (res.error === "auth_not_configured") {
      status.textContent = "Server has no password set. Configure auth_hash in config.local.php.";
    } else {
      status.textContent = "Wrong password.";
    }
  });
}
