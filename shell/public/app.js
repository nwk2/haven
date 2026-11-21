// Haven shell app — Batch 2. Registry-driven home screen, Editorial themes,
// shell chrome (header Home control + bottom navigation). No framework; the
// shell owns the router, modules own everything below their prefix.
// Batch 2 adds Google-only sign-in (auth-code flow) and the household
// setup/roster screens. One session, issued once after Google sign-in, is
// accepted by every module route; modules run no auth of their own.
//
// Module client-chunk contract (spec §3): each chunk exports
//   description — one-line job description for the tile
//   mount(el)   — mount the module screen
//   widget()    — async; null when empty, or { title, body, href }
// The shell never reads a module's tables; the widget is the module's own
// summary, rendered by the shell. A widget that errors is hidden; the tile
// still opens the module (failure isolation, spec §3).
import {
  resolveTheme,
  greetingFor,
  formatHomeDate,
  chunkUrl,
  collectWidgets,
  collectTiles,
  iconSVG,
  escapeHTML,
  googleAuthUrl,
} from "/shell-logic.js";
import { confirmPrompt } from "/components.js";

// Google sign-in (Batch 2): the client ID is public by design (it is in
// the auth URL); only the secret is sensitive, and it lives only as a
// Worker secret. The redirect URI is the app root — it must match one of
// the URIs registered in Google Cloud Console exactly.
const GOOGLE_CLIENT_ID =
  "710021216622-hp6scvlvmm2q05adlrd5sijm2qltsanh.apps.googleusercontent.com";
const SESSION_KEY = "haven-session"; // the raw session token (only its hash is stored server-side)
const GOOGLE_STATE_KEY = "haven-google-state"; // one-time CSRF nonce for the Google round-trip
const INVITE_KEY = "haven-invite"; // an invite link opened before sign-in, kept across the round-trip

const app = document.getElementById("app");
const bottomNav = document.getElementById("bottomnav");
const themeToggle = document.getElementById("theme-toggle");
const signOutButton = document.getElementById("sign-out");

let modulesCache = null; // registry, fetched once from /api/modules

// Session + household, cached in memory for the lifetime of the page
// (same pattern as modulesCache): a fresh page load always refetches,
// but in-app navigations reuse the cached values instead of paying a
// round-trip per tab switch on a slow connection. Anything that can
// change what they hold clears them first — see clearSessionCaches().
let meCache = null; // /api/me response: { user, household }
let householdCache = null; // /api/household response: { household, invite_link, members }
function clearSessionCaches() {
  meCache = null;
  householdCache = null;
}

// --- Theme: stored choice wins, otherwise follow the system (spec §2). ---
function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function storedTheme() {
  try {
    return localStorage.getItem("haven-theme");
  } catch {
    return null;
  }
}
function currentTheme() {
  return resolveTheme(storedTheme(), systemPrefersDark());
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.innerHTML = iconSVG(theme === "dark" ? "sun" : "moon");
  themeToggle.setAttribute(
    "aria-label",
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
  );
}
themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("haven-theme", next);
  } catch {
    // Private mode: the theme still switches for this session.
  }
  applyTheme(next);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!storedTheme()) applyTheme(resolveTheme(null, systemPrefersDark()));
});
applyTheme(currentTheme());

// --- Session (Batch 2) ---
function getToken() {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
function setToken(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}
function storedInvite() {
  try {
    return localStorage.getItem(INVITE_KEY);
  } catch {
    return null;
  }
}
function clearInvite() {
  try {
    localStorage.removeItem(INVITE_KEY);
  } catch {}
}
function showSignOut(on) {
  signOutButton.hidden = !on;
}
signOutButton.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", "POST");
  } catch {
    // Still sign out locally: the server session just stays until it expires.
  }
  setToken(null);
  clearSessionCaches();
  modulesCache = null;
  void route();
});

// api(): same-origin JSON call with the session token when one exists.
// A 401 means the session ended (or was revoked) — the caller re-routes
// to the sign-in screen. Requests time out after 15 s instead of hanging
// forever: a hung request must surface as an error the user can retry,
// never a blank page. A timeout throws an error with timedOut set.
const API_TIMEOUT_MS = 15000;
async function api(path, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
      signal: controller.signal,
    });
  } catch (err) {
    const error = new Error(
      controller.signal.aborted ? "request timed out" : "request failed",
    );
    error.timedOut = controller.signal.aborted;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

document.getElementById("home-control").addEventListener("click", () => {
  window.history.pushState(null, "", "/");
  void route();
});

// --- Sign-in screen (Batch 2) ---
function renderSignIn(notice) {
  showSignOut(false);
  bottomNav.innerHTML = "";
  app.innerHTML = `<div class="empty-state"><h2>Welcome to Haven</h2>`
    + `<p>One household app, one login. Sign in with Google to open your household.</p>`
    + (notice ? `<p class="error">${escapeHTML(notice)}</p>` : "")
    + `<p><button class="btn btn-primary" id="google-signin" type="button">Sign in with Google</button></p>`
    + `<p>Every household member needs a Google account. No password is stored.</p>`
    + `<div class="token-entry"><details><summary>Use a session token</summary>`
    + `<p><input class="field" id="session-token" type="text" placeholder="Session token" autocomplete="off" autocapitalize="off" spellcheck="false"></p>`
    + `<p><button class="btn" id="token-signin" type="button">Sign in with token</button></p>`
    + `</details></div></div>`;
  document.getElementById("google-signin").addEventListener("click", () => {
    const state = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      localStorage.setItem(GOOGLE_STATE_KEY, state);
    } catch {}
    window.location.href = googleAuthUrl(
      GOOGLE_CLIENT_ID,
      window.location.origin + "/",
      state,
    );
  });
  // Session-token entry (verification aid, not a second login): a token
  // pasted here is stored exactly like a Google-issued one and the normal
  // session check runs. The server only ever accepts an already-valid
  // token — this path can never mint a session. A paste field (not a
  // ?session= URL parameter) keeps the token out of logged URLs.
  document.getElementById("token-signin").addEventListener("click", () => {
    const token = document.getElementById("session-token").value.trim();
    if (!token) {
      renderSignIn("Paste a session token first.");
      return;
    }
    // Same fresh-session reset as the Google callback: store the token,
    // drop any cached /api/me + /api/household + module responses, then
    // run the normal session check. routeInner() calls /api/me and, on a
    // 401, clears the token and shows "Your session ended — sign in again."
    const btn = document.getElementById("token-signin");
    btn.disabled = true;
    setToken(token);
    clearSessionCaches();
    modulesCache = null;
    void route();
  });
}

// Google redirected back with ?code=...&state=... — verify the state nonce,
// exchange the code with the Worker, store the session token. Returns true
// when a session was established. Shows a loading state while the exchange
// runs, and on ANY failure renders the sign-in screen with a specific
// message — the sign-in button is the retry. Never leaves a bare page.
async function handleGoogleCallback(code, state) {
  history.replaceState(null, "", window.location.pathname);
  app.innerHTML = `<div class="empty-state"><p>Signing you in…</p></div>`;
  let stored = null;
  try {
    stored = localStorage.getItem(GOOGLE_STATE_KEY);
    localStorage.removeItem(GOOGLE_STATE_KEY);
  } catch {}
  if (!state || state !== stored) {
    renderSignIn("Sign-in didn’t complete — please try again.");
    return false;
  }
  let res;
  let data;
  try {
    ({ res, data } = await api("/api/auth/google", "POST", {
      code,
      redirect_uri: window.location.origin + "/",
    }));
  } catch (err) {
    renderSignIn(
      err.timedOut
        ? "Signing in took too long — check your connection and try again."
        : "Couldn’t reach Haven to finish signing in — check your connection and try again.",
    );
    return false;
  }
  if (!res.ok || !data.ok || !data.token) {
    renderSignIn("Google sign-in failed — please try again.");
    return false;
  }
  setToken(data.token);
  // A new session starts from fresh state: the caches may still hold the
  // previous user's /api/me and /api/household responses. routeInner()
  // refetches both on the way to the home screen.
  clearSessionCaches();
  return true;
}

// --- Household setup screen (Batch 2) ---
// A signed-in user with no household yet: create one (they become its
// creator) or join one with an invite link. One household per user in v1.
function renderHouseholdSetup(notice) {
  showSignOut(true);
  bottomNav.innerHTML = "";
  app.innerHTML = `<div class="empty-state"><h2>Set up your household</h2>`
    + `<p>Haven is one household: its members, recipes, plans and shopping.</p>`
    + (notice ? `<p class="error">${escapeHTML(notice)}</p>` : "")
    + `<div class="setup-card"><h3>Create a household</h3>`
    + `<p>Start one — you become its creator and can invite the rest of the household.</p>`
    + `<p><input class="field" id="household-name" type="text" placeholder="Household name" autocomplete="off" maxlength="100"></p>`
    + `<p><button class="btn btn-primary" id="create-household" type="button">Create household</button></p></div>`
    + `<div class="setup-card"><h3>Join a household</h3>`
    + `<p>Someone shared an invite link with you — paste its code here.</p>`
    + `<p><input class="field" id="invite-code" type="text" placeholder="Invite code" autocomplete="off"></p>`
    + `<p><button class="btn btn-primary" id="join-household" type="button">Join household</button></p></div></div>`;
  document.getElementById("create-household").addEventListener("click", async () => {
    const name = document.getElementById("household-name").value.trim();
    if (!name) {
      renderHouseholdSetup("Give the household a name first.");
      return;
    }
    // Busy state: the create POST takes seconds on a slow connection and
    // the setup screen otherwise sits unchanged with no feedback. The
    // button is disabled while the request is in flight, so a double-tap
    // cannot issue a second create.
    const btn = document.getElementById("create-household");
    btn.disabled = true;
    btn.textContent = "Creating…";
    let res;
    let data;
    try {
      ({ res, data } = await api("/api/household", "POST", { name }));
    } catch {
      // Timeout / network: the request may or may not have landed. The
      // button is restored so the user can retry; the server rejects a
      // second household (already_in_household), so a retry can never
      // create a duplicate.
      btn.disabled = false;
      btn.textContent = "Create household";
      renderHouseholdSetup("Couldn’t create the household — please try again.");
      return;
    }
    if (!res.ok || !data.ok) {
      btn.disabled = false;
      btn.textContent = "Create household";
      renderHouseholdSetup("Couldn’t create the household — please try again.");
      return;
    }
    clearSessionCaches(); // the cached /api/me still says "no household"
    void route();
  });
  document.getElementById("join-household").addEventListener("click", async () => {
    const invite = document.getElementById("invite-code").value.trim();
    if (!invite) {
      renderHouseholdSetup("Paste the invite code first.");
      return;
    }
    // Busy state, same shape as create: the join POST takes seconds on a
    // slow connection. Disabled while in flight, so a double-tap cannot
    // issue a second join.
    const btn = document.getElementById("join-household");
    btn.disabled = true;
    btn.textContent = "Joining…";
    let joined;
    try {
      joined = await tryJoin(invite);
    } catch {
      // Timeout / network: restore the button so the user can retry. No
      // error is shown — the invalid-invite message would be wrong here,
      // and the screen is unchanged, so the user just taps again.
      btn.disabled = false;
      btn.textContent = "Join household";
      return;
    }
    if (joined) {
      clearInvite();
      clearSessionCaches(); // the cached /api/me still says "no household"
      void route();
    } else {
      btn.disabled = false;
      btn.textContent = "Join household";
      renderHouseholdSetup("That invite link isn’t valid — check the code and try again.");
    }
  });
}

// Join with an invite code. Returns true on success, false when the invite
// is not valid (or the user is already in a household).
async function tryJoin(invite) {
  const { res, data } = await api("/api/household/join", "POST", { invite });
  return res.ok && data.ok;
}

// --- Household panel on the home screen (Batch 2) ---
async function loadHousehold() {
  if (householdCache) return householdCache;
  const { res, data } = await api("/api/household");
  if (!res.ok || !data.ok) return null;
  householdCache = data;
  return data;
}

function householdPanelHTML(hh, me) {
  const isCreator = hh.household.creator_id === me.id;
  const members = hh.members
    .map((m) => `<div class="list-row"><span>${escapeHTML(m.name)}</span>`
      + `<span class="muted">${escapeHTML(m.role)}</span>`
      + (isCreator && m.id !== me.id
        ? `<button class="btn btn-ghost" type="button" data-remove-member="${escapeHTML(m.id)}">Remove</button>`
        : "")
      + `</div>`)
    .join("");
  return `<h2 class="section-head">Household</h2>`
    + `<section class="household-panel"><p><strong>${escapeHTML(hh.household.name)}</strong></p>`
    + `<div class="list">${members}</div>`
    + `<p class="invite-row"><input class="field" id="invite-link" type="text" readonly value="${escapeHTML(hh.invite_link || "")}">`
    + `<button class="btn btn-ghost" id="copy-invite" type="button">Copy invite link</button></p>`
    + (isCreator
      ? `<p><button class="btn btn-ghost" id="revoke-invite" type="button">Revoke invite link</button></p>`
      : `<p class="muted">Only the household creator can revoke the invite link.</p>`)
    + `<p><button class="btn btn-ghost" id="leave-household" type="button">Leave household</button></p></section>`;
}

function wireHouseholdPanel(hh, me) {
  const copyBtn = document.getElementById("copy-invite");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const input = document.getElementById("invite-link");
      try {
        await navigator.clipboard.writeText(input.value);
        copyBtn.textContent = "Copied";
      } catch {
        input.select();
        copyBtn.textContent = "Select and copy";
      }
    });
  }
  const revokeBtn = document.getElementById("revoke-invite");
  if (revokeBtn) {
    revokeBtn.addEventListener("click", async () => {
      // Busy state: the revoke POST takes seconds on a slow connection.
      // Disabled while in flight, so a double-tap cannot revoke twice.
      revokeBtn.disabled = true;
      revokeBtn.textContent = "Revoking…";
      let res;
      let data;
      try {
        ({ res, data } = await api("/api/household/invite/revoke", "POST"));
      } catch {
        revokeBtn.disabled = false;
        revokeBtn.textContent = "Revoke invite link";
        return;
      }
      if (res.ok && data.ok) {
        clearSessionCaches(); // the cached household still has the old invite link
        void route();
      } else {
        revokeBtn.disabled = false;
        revokeBtn.textContent = "Revoke invite link";
      }
    });
  }
  const leaveBtn = document.getElementById("leave-household");
  if (leaveBtn) {
    leaveBtn.addEventListener("click", async () => {
      // Sole member: leaving deletes the household and all its kitchen
      // data (0.3.4 cascade) — the dialog must say so, not claim the
      // plans and shopping "stay with the remaining members" when there
      // are none. Multi-member: the existing wording stands.
      const soleMember = hh.members.length === 1;
      const yes = await confirmPrompt({
        title: "Leave household?",
        message: soleMember
          ? `You’re the only member — leaving deletes ${hh.household.name} and all its plans and shopping.`
          : `Leaving removes you from ${hh.household.name}. The household’s plans and shopping stay with the remaining members.`,
        confirmLabel: "Leave",
      });
      if (!yes) return;
      // Busy state on the button (the sheet is already closed): the leave
      // POST takes seconds on a slow connection. Disabled while in flight,
      // so a double-tap cannot leave twice.
      leaveBtn.disabled = true;
      leaveBtn.textContent = "Leaving…";
      try {
        await api("/api/household/leave", "POST");
      } catch {
        leaveBtn.disabled = false;
        leaveBtn.textContent = "Leave household";
        return;
      }
      clearSessionCaches(); // the cached /api/me still says "has household"
      modulesCache = null;
      void route();
    });
  }
  document.querySelectorAll("[data-remove-member]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.getAttribute("data-remove-member");
      const { res, data } = await api("/api/household/members/remove", "POST", { user_id: userId });
      if (res.ok && data.ok) {
        clearSessionCaches(); // the cached household still lists the removed member
        void route();
      }
    });
  });
}

async function loadModules() {
  if (modulesCache) return modulesCache;
  const { res, data } = await api("/api/modules");
  if (res.status === 401) {
    const err = new Error("session ended");
    err.status = 401;
    throw err;
  }
  if (res.status === 403) {
    const err = new Error("no household");
    err.status = 403;
    throw err;
  }
  if (!res.ok || !data.ok || !Array.isArray(data.modules)) {
    throw new Error("modules request failed");
  }
  modulesCache = data.modules;
  return modulesCache;
}

function loadChunk(mod) {
  return import(chunkUrl(mod.route_prefix));
}

function renderBottomNav(activeId) {
  const items = [
    { module_id: "home", name: "Home", icon: "home", route_prefix: "/" },
    ...modulesCache,
  ];
  bottomNav.innerHTML = items
    .map((item) => {
      const active = item.module_id === activeId
        ? ' class="active" aria-current="page"'
        : "";
      return `<a href="${escapeHTML(item.route_prefix)}" data-route="${escapeHTML(item.module_id)}"${active}>`
        + `${iconSVG(item.icon)}<span>${escapeHTML(item.name)}</span></a>`;
    })
    .join("");
}

async function renderHome(me) {
  const now = new Date();
  let html = `<p class="greeting">${greetingFor(now)}</p>`
    + `<p class="home-date">${formatHomeDate(now)}</p>`;

  // Widget feed first (what is relevant now), then the stable launcher.
  const widgets = await collectWidgets(modulesCache, loadChunk);
  if (widgets.length > 0) {
    html += `<section class="widget-feed" aria-label="Updates">${widgets.join("")}</section>`;
  }

  const tiles = await collectTiles(modulesCache, loadChunk);
  html += `<h2 class="section-head">Modules</h2>`
    + `<section class="tile-grid">${tiles.join("")}</section>`;

  // Household roster (Batch 2): members, invite link, leave.
  const hh = await loadHousehold();
  if (hh) html += householdPanelHTML(hh, me.user);

  app.innerHTML = html;
  renderBottomNav("home");
  if (hh) wireHouseholdPanel(hh, me.user);
}

async function openModule(mod) {
  app.innerHTML = `<div class="empty-state"><p>Loading ${escapeHTML(mod.name)}…</p></div>`;
  renderBottomNav(mod.module_id);
  try {
    const chunk = await loadChunk(mod);
    app.innerHTML = "";
    chunk.mount(app);
  } catch (err) {
    console.warn("module failed to load: " + mod.module_id, err);
    app.innerHTML = `<div class="empty-state"><h2>${escapeHTML(mod.name)} couldn’t load</h2>`
      + `<p>Something went wrong opening this module.</p>`
      + `<p><button class="btn btn-primary" id="retry-module" type="button">Try again</button></p></div>`;
    document.getElementById("retry-module").addEventListener("click", () => void route());
  }
}

async function routeInner() {
  const params = new URLSearchParams(window.location.search);

  // 1. Google redirected back (?code=...&state=...).
  const code = params.get("code");
  if (code) {
    const signedIn = await handleGoogleCallback(code, params.get("state"));
    if (!signedIn) return;
  }

  // 2. Invite link opened (?invite=...): keep it across sign-in, then join.
  const invite = params.get("invite");
  if (invite) {
    try {
      localStorage.setItem(INVITE_KEY, invite);
    } catch {}
    history.replaceState(null, "", window.location.pathname);
  }

  // 3. Sign-in gate: no session, no app.
  if (!getToken()) {
    renderSignIn();
    return;
  }

  // 4. Who is this, and do they have a household? The session check runs
  // once per page load and is cached in memory (meCache) — later
  // navigations reuse it instead of paying a fresh /api/me round-trip
  // per tab switch. A fresh page load starts with empty caches, so boot
  // always refetches. A failed session check (timeout, network) is not a
  // signed-out user: show the sign-in screen with a specific message
  // instead of a blank page — the sign-in button is the retry.
  let res;
  let data;
  if (meCache) {
    res = { status: 200, ok: true };
    data = meCache;
  } else {
    try {
      ({ res, data } = await api("/api/me"));
    } catch (err) {
      setToken(null);
      clearSessionCaches();
      modulesCache = null;
      renderSignIn(
        err.timedOut
          ? "Haven didn’t respond in time — check your connection and try again."
          : "Couldn’t reach Haven — check your connection and try again.",
      );
      return;
    }
    if (res.status === 401 || !res.ok || !data.ok) {
      setToken(null);
      clearSessionCaches();
      modulesCache = null;
      renderSignIn("Your session ended — sign in again.");
      return;
    }
    meCache = data;
  }
  const me = data;
  showSignOut(true);

  if (!me.household) {
    // An invite kept from before sign-in joins now.
    const kept = storedInvite();
    if (kept) {
      if (await tryJoin(kept)) {
        clearInvite();
        clearSessionCaches(); // the cached /api/me still says "no household"
        void route();
        return;
      }
      clearInvite();
      renderHouseholdSetup("That invite link isn’t valid — check the code and try again.");
      return;
    }
    renderHouseholdSetup();
    return;
  }
  clearInvite();

  // 5. Member: normal routing (home screen + modules).
  let modules;
  try {
    modules = await loadModules();
  } catch (err) {
    if (err.status === 401) {
      setToken(null);
      clearSessionCaches();
      modulesCache = null;
      renderSignIn("Your session ended — sign in again.");
      return;
    }
    if (err.status === 403) {
      renderHouseholdSetup();
      return;
    }
    console.warn("registry unavailable", err);
    app.innerHTML = `<div class="empty-state"><h2>Couldn’t load Haven</h2>`
      + `<p>The module list didn’t load. Check your connection and try again.</p>`
      + `<p><button class="btn btn-primary" id="retry-home" type="button">Try again</button></p></div>`;
    document.getElementById("retry-home").addEventListener("click", () => {
      clearSessionCaches();
      modulesCache = null;
      void route();
    });
    return;
  }
  const path = window.location.pathname;
  const mod = modules.find(
    (m) => path === m.route_prefix
      || path === m.route_prefix.replace(/\/$/, "")
      || path.startsWith(m.route_prefix),
  );
  if (mod) {
    await openModule(mod);
    return;
  }
  await renderHome(me);
}

// Error state with a retry: any unexpected throw inside the router lands
// here instead of leaving the static loading text (or a blank page) on
// screen with no way forward.
function renderErrorState(message) {
  showSignOut(false);
  bottomNav.innerHTML = "";
  app.innerHTML = `<div class="empty-state"><h2>Something went wrong</h2>`
    + `<p>${escapeHTML(message)}</p>`
    + `<p><button class="btn btn-primary" id="retry-route" type="button">Try again</button></p></div>`;
  document.getElementById("retry-route").addEventListener("click", () => void route());
}

// route() is the only entry point; routeInner() does the work. A throw
// anywhere in the router (bad module chunk, failed render, unexpected
// response shape) renders the error state above instead of dying silently.
async function route() {
  try {
    await routeInner();
  } catch (err) {
    console.warn("route failed", err);
    renderErrorState("Haven hit a problem loading this screen — please try again.");
  }
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link) return;
  event.preventDefault();
  window.history.pushState(null, "", link.getAttribute("href"));
  void route();
});

window.addEventListener("popstate", () => void route());
void route();
