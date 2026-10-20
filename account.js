// Copyright © 2026 Betttech Global Ventures (BGV) Limited. All rights reserved. See LICENSE.
(() => {
  // Optional accounts, and anonymous usage counts. SHARING comes from config.js.
  // Sign-in talks to Supabase Auth directly, so there's no extra library to download.
  // app.js records usage through window.BuleAccount.track().
  const $ = (id) => document.getElementById(id);
  const AUTH = "bule.auth.v1", USAGE = "bule.usage.v1", USAGE_OFF = "bule.usage.off", DEVICE = "bule.device.v1";
  const ready = typeof SHARING !== "undefined" && SHARING.url && SHARING.anonKey;
  const base = ready ? SHARING.url.replace(/\/$/, "") : "";
  const here = () => location.origin + location.pathname; // where Google and email links come back to

  // The same random ID app.js uses for shared prices. Made here because this file loads first.
  let device = localStorage.getItem(DEVICE);
  if (!device) {
    device = crypto.randomUUID ? crypto.randomUUID()
      : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    localStorage.setItem(DEVICE, device);
  }

  let session = null; // { access_token, refresh_token, expires_at, user: { id, email, name, provider } }
  try { session = JSON.parse(localStorage.getItem(AUTH)); } catch {}
  let queue = [];     // usage events waiting to be sent
  try { queue = JSON.parse(localStorage.getItem(USAGE)) || []; } catch {}
  let usageOn = localStorage.getItem(USAGE_OFF) !== "yes";

  // ---------- Supabase Auth ----------
  async function auth(path, { method = "POST", body, token } = {}) {
    const res = await fetch(`${base}/auth/v1/${path}`, {
      method,
      headers: { apikey: SHARING.anonKey, "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = {}; try { data = JSON.parse(text); } catch {}
    if (!res.ok) {
      const err = new Error(data.msg || data.error_description || data.message || data.error || res.statusText);
      err.status = res.status; err.code = data.error_code || data.error || "";
      throw err;
    }
    return data;
  }

  function keep(t) {
    const u = t.user || {}, meta = u.user_metadata || {};
    session = {
      access_token: t.access_token, refresh_token: t.refresh_token,
      expires_at: t.expires_at ? t.expires_at * 1000 : Date.now() + (Number(t.expires_in) || 3600) * 1000,
      user: { id: u.id, email: u.email || "", name: meta.full_name || meta.name || "", provider: (u.app_metadata && u.app_metadata.provider) || "email" },
    };
    localStorage.setItem(AUTH, JSON.stringify(session));
    renderButton();
  }
  function forget() { session = null; localStorage.removeItem(AUTH); renderButton(); }

  // A token that's good for at least another minute. Null when signed out or the account has gone.
  // Throws when there's no connection, so callers can try again later.
  async function token() {
    if (!session) return null;
    if (session.expires_at - Date.now() > 60000) return session.access_token;
    try {
      keep(await auth("token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token } }));
      return session.access_token;
    } catch (err) {
      if (err.status >= 400 && err.status < 500) { forget(); return null; } // signed out elsewhere, or account deleted
      throw err;
    }
  }

  // ---------- usage counts ----------
  // Only what people do, like opening the app or checking a price. Never the price itself or where they are.
  let flushing = false, flushTimer = null;
  function track(event, extra = {}) {
    if (!ready || !usageOn) return;
    queue.push({ device_id: device, event, city_id: extra.city_id || null, item_id: extra.item_id || null,
                 detail: extra.detail || null, occurred_at: new Date().toISOString() });
    if (queue.length > 300) queue = queue.slice(-300);
    localStorage.setItem(USAGE, JSON.stringify(queue));
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 3000);
  }

  async function flush() {
    if (!ready || flushing || !queue.length || !navigator.onLine) return;
    flushing = true;
    try {
      let t = null;
      try { t = await token(); } catch { return; } // offline: try again later
      const batch = queue.slice(0, 50);
      const send = (tok) => fetch(`${base}/rest/v1/usage_events`, {
        method: "POST", body: JSON.stringify(batch),
        headers: { apikey: SHARING.anonKey, Authorization: "Bearer " + (tok || SHARING.anonKey), "Content-Type": "application/json", Prefer: "return=minimal" },
      });
      let res = await send(t);
      if (res.status === 401 && t) res = await send(null); // the account's token was refused, so send them unlinked
      // 4xx means the server won't take them, so drop them rather than retry forever.
      // 404 means accounts-and-usage.sql hasn't been run yet, so keep them for later.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 404)) {
        queue = queue.slice(batch.length);
        localStorage.setItem(USAGE, JSON.stringify(queue));
        if (queue.length) setTimeout(flush, 0);
      }
    } catch {} // server down: try again later
    finally { flushing = false; }
  }

  // ---------- the account button and sheet ----------
  const sheet = $("account"), form = $("acc-form"), msg = $("acc-msg");
  let mode = "signin"; // signin, signup, forgot or reset
  let googleOn = null; // whether Google sign-in is turned on in Supabase, checked when the sheet opens

  function renderButton() {
    const b = $("acct");
    b.hidden = !ready;
    if (session) {
      const nm = session.user.name || session.user.email;
      b.textContent = (nm[0] || "?").toUpperCase();
      b.classList.add("in");
      b.setAttribute("aria-label", `Account: signed in as ${session.user.email}`);
    } else {
      b.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      b.classList.remove("in");
      b.setAttribute("aria-label", "Sign in");
    }
    $("foot-acct").textContent = session ? "Your account" : "Sign in or create an account";
  }

  const say = (text, good) => { msg.textContent = text; msg.classList.toggle("bad", !good); msg.classList.toggle("ok", !!good); };

  function setMode(m) {
    mode = m; say("");
    const titles = { signin: "Sign in", signup: "Create an account", forgot: "Reset your password", reset: "Choose a new password" };
    $("account-h").textContent = session && m !== "reset" ? "Your account" : titles[m];
    $("acc-out").hidden = !!session && m !== "reset";
    $("acc-in").hidden = !session || m === "reset";
    $("acc-name-f").hidden = m !== "signup";
    $("acc-email-f").hidden = m === "reset";
    $("acc-pass-f").hidden = m === "forgot";
    $("acc-pass-l").textContent = m === "reset" ? "New password" : "Password";
    $("acc-pass").autocomplete = m === "signin" ? "current-password" : "new-password";
    $("acc-pass-hint").textContent = m === "signin" ? "" : "At least 8 characters.";
    $("acc-submit").textContent = { signin: "Sign in", signup: "Create account", forgot: "Send reset link", reset: "Save new password" }[m];
    $("acc-intro").hidden = m === "reset";
    $("acc-links").hidden = m === "reset";
    $("acc-mode").textContent = m === "signin" ? "New to Bule? Create an account" : "Already have an account? Sign in";
    $("acc-forgot").hidden = m !== "signin";
    $("acc-google").hidden = $("acc-or").hidden = !googleOn || m === "forgot" || m === "reset";
    if (session) {
      const u = session.user;
      $("acc-who").textContent = `Signed in as ${u.name ? u.name + ", " : ""}${u.email}${u.provider === "google" ? ", with Google" : ""}.`;
      $("acc-in-msg").textContent = "";
    }
  }

  async function openAccount(m = "signin") {
    setMode(m);
    sheet.showModal();
    if (googleOn === null && navigator.onLine) {
      try { googleOn = !!(await auth("settings", { method: "GET" })).external.google; setMode(mode); } catch {}
    }
  }

  const friendly = (err) =>
    !err.status ? "Couldn't reach Bule just now. Try again in a minute."
    : /invalid_credentials|invalid_grant|Invalid login/i.test(err.code + err.message) ? "That email and password don't match."
    : /email_not_confirmed|not confirmed/i.test(err.code + err.message) ? "Confirm your email first, using the link we sent you."
    : /user_already_exists|already registered/i.test(err.code + err.message) ? "There's already an account with that email. Sign in instead."
    : /weak_password|password/i.test(err.code) ? "Choose a longer password, with at least 8 characters."
    : err.status === 429 ? "Too many tries. Wait a few minutes and try again."
    : /sending|smtp|email/i.test(err.message) && err.status >= 500 ? "We couldn't send the email just now. Try again later, or contact us."
    : err.message;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("acc-email").value.trim(), pass = $("acc-pass").value, name = $("acc-name").value.trim();
    if (mode !== "reset" && !$("acc-email").checkValidity()) { say("Type your email address."); $("acc-email").focus(); return; }
    if (mode !== "forgot" && (mode === "signin" ? !pass : pass.length < 8)) {
      say(mode === "signin" ? "Type your password." : "Choose a password with at least 8 characters."); $("acc-pass").focus(); return;
    }
    if (!navigator.onLine) { say("You need signal for this. Bule still works offline without an account."); return; }
    const btn = $("acc-submit"); btn.disabled = true; say("");
    try {
      if (mode === "signin") {
        keep(await auth("token?grant_type=password", { body: { email, password: pass } }));
        done("Signed in");
      } else if (mode === "signup") {
        const r = await auth(`signup?redirect_to=${encodeURIComponent(here())}`, { body: { email, password: pass, data: name ? { full_name: name } : {} } });
        if (r.access_token) { keep(r); done("Account created"); }
        else say(`Nearly done. We've sent a link to ${email}. Open it to confirm your account.`, true);
      } else if (mode === "forgot") {
        await auth(`recover?redirect_to=${encodeURIComponent(here())}`, { body: { email } });
        say(`If there's an account for ${email}, we've sent it a link to choose a new password.`, true);
      } else {
        const t = await token();
        if (!t) { say("That link has expired. Ask for a new one."); setTimeout(() => setMode("forgot"), 1500); return; }
        await auth("user", { method: "PUT", token: t, body: { password: pass } });
        $("acc-pass").value = "";
        sheet.close(); toast("New password saved");
      }
    } catch (err) { say(friendly(err)); }
    finally { btn.disabled = false; }
  });

  function done(text) {
    $("acc-pass").value = "";
    sheet.close(); toast(text);
    track("sign_in", { detail: session.user.provider });
  }

  $("acc-google").addEventListener("click", () => {
    if (!navigator.onLine) { say("You need signal to sign in."); return; }
    location.href = `${base}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(here())}`;
  });
  $("acc-mode").addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));
  $("acc-forgot").addEventListener("click", () => setMode("forgot"));
  $("acc-signout").addEventListener("click", async () => {
    const t = session && session.access_token;
    forget(); sheet.close(); toast("Signed out");
    if (t && navigator.onLine) auth("logout", { token: t }).catch(() => {});
  });
  $("acc-delete").addEventListener("click", async () => {
    if (!confirm("Delete your Bule account? This removes your email address and sign-in. Bule keeps working on this phone.")) return;
    const out = $("acc-in-msg");
    if (!navigator.onLine) { out.textContent = "You need signal to delete your account."; return; }
    try {
      const t = await token();
      if (!t) { sheet.close(); return; } // already gone
      const res = await fetch(`${base}/rest/v1/rpc/delete_my_account`, {
        method: "POST", body: "{}", headers: { apikey: SHARING.anonKey, Authorization: "Bearer " + t, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error();
      forget(); sheet.close(); toast("Your account has been deleted");
    } catch { out.textContent = "Couldn't delete it just now. Try again, or email info@betttech.co.uk and we'll do it for you."; }
  });

  $("acct").addEventListener("click", () => openAccount());
  $("foot-acct").addEventListener("click", () => openAccount());
  $("account-x").addEventListener("click", () => sheet.close());
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });

  // ---------- privacy note and the usage switch ----------
  const privacy = $("privacy");
  document.addEventListener("click", (e) => { if (e.target.closest("[data-privacy]")) { if (sheet.open) sheet.close(); privacy.showModal(); } });
  $("privacy-x").addEventListener("click", () => privacy.close());
  privacy.addEventListener("click", (e) => { if (e.target === privacy) privacy.close(); });
  const usageBox = $("usage-on");
  usageBox.checked = usageOn;
  usageBox.closest("p").hidden = !ready;
  usageBox.addEventListener("change", () => {
    usageOn = usageBox.checked;
    window["ga-disable-G-DRYF42HMZE"] = !usageOn; // Google Analytics, set up in the page's <head>
    if (usageOn) localStorage.removeItem(USAGE_OFF);
    else { localStorage.setItem(USAGE_OFF, "yes"); queue = []; localStorage.removeItem(USAGE); }
  });

  let toastTimer;
  function toast(m) {
    const t = $("toast"); t.textContent = m; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  // ---------- coming back from Google or an email link ----------
  // Supabase sends people back with the sign-in details, or an error, after the # in the address.
  async function fromLink() {
    const h = new URLSearchParams(location.hash.slice(1));
    const error = h.get("error_description") || new URLSearchParams(location.search).get("error_description");
    if (!h.get("access_token") && !error) return;
    history.replaceState(null, "", location.pathname);
    if (error) {
      await openAccount("signin");
      say(/expired|invalid/i.test(error) ? "That link has expired or was already used. Sign in, or ask for a new one." : error);
      return;
    }
    const t = { access_token: h.get("access_token"), refresh_token: h.get("refresh_token"),
                expires_in: h.get("expires_in"), expires_at: Number(h.get("expires_at")) || 0 };
    try { keep({ ...t, user: await auth("user", { method: "GET", token: t.access_token }) }); }
    catch { toast("Couldn't finish signing in. Try again."); return; }
    const type = h.get("type");
    if (type === "recovery") { openAccount("reset"); return; }
    toast(type === "signup" ? "Email confirmed. You're signed in." : "Signed in");
    track("sign_in", { detail: session.user.provider });
  }

  addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

  window.BuleAccount = { track };
  renderButton();
  if (ready) { fromLink(); flush(); }
})();
