// Copyright © 2026 Betttech Global Ventures (BGV) Limited. All rights reserved. See LICENSE.
(() => {
  // CITIES and REGIONS come from cities.js.
  const HOME = { GBP: 0.75, USD: 1, EUR: 0.86 }; // units per US dollar, approximate
  const MAX_DIGITS = 9;

  const $ = (id) => document.getElementById(id);
  // Storage keys keep the original name so prices people have already saved aren't lost.
  const KEY = "fairprice.v1", REPORTS = "fairprice.reports.v1";

  // ---------- state ----------
  let state = { city: "bangkok", home: "GBP", item: {} };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(KEY)) }; } catch {}
  if (!CITIES[state.city]) state.city = "bangkok";
  if (!HOME[state.home]) state.home = "GBP";
  let reports = [];
  try { reports = JSON.parse(localStorage.getItem(REPORTS)) || []; } catch {}
  const save = () => { localStorage.setItem(KEY, JSON.stringify(state)); localStorage.setItem(REPORTS, JSON.stringify(reports)); };

  // ---------- shared prices (see config.js) ----------
  const STATS = "bule.stats.v1", OUTBOX = "bule.outbox.v1", DEVICE = "bule.device.v1";
  const sharing = typeof SHARING !== "undefined" && SHARING.url && SHARING.anonKey;
  const MIN_PRICES = (sharing && SHARING.minPrices) || 10;
  let stats = {};   // "city/item" -> { n, p25, median, p75, last_at }
  let outbox = [];  // prices waiting to be sent, kept until we're online
  try { stats = JSON.parse(localStorage.getItem(STATS)) || {}; } catch {}
  try { outbox = JSON.parse(localStorage.getItem(OUTBOX)) || []; } catch {}
  let device = localStorage.getItem(DEVICE);
  if (!device) {
    device = crypto.randomUUID ? crypto.randomUUID()
      : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    localStorage.setItem(DEVICE, device);
  }

  // Once enough travellers have added prices, their middle half replaces the sample range.
  function withStats(it) {
    const st = stats[state.city + "/" + it.id];
    if (!st || st.n < MIN_PRICES || !(st.p75 > 0)) return { ...it, shared: st ? st.n : 0 };
    let low = st.p25, high = st.p75;
    if (high - low < high * 0.1) { low = st.median * 0.9; high = st.median * 1.1; } // everyone paid the same: allow a little room
    const r = (v) => city().decimals ? Math.round(v * 100) / 100 : Math.round(v);
    return { ...it, low: r(low), high: Math.max(r(high), r(low) + (city().decimals ? 0.01 : 1)), shared: st.n, live: true, last: st.last_at };
  }

  let digits = ""; // what's been punched into the keypad
  let lastVerdict = "empty";

  // Usage counts, through account.js. Only what happened, never the price typed.
  const track = (event, extra) => window.BuleAccount && BuleAccount.track(event, extra);
  // Counts a price check once the keypad has been left alone for a moment, so each digit isn't a check.
  let checkTimer = null, lastChecked = "";
  function trackCheck(it, verdict) {
    clearTimeout(checkTimer);
    if (!verdict) return;
    const key = `${state.city}/${it.id}/${digits}`;
    checkTimer = setTimeout(() => {
      if (key === lastChecked) return;
      lastChecked = key;
      track("check", { city_id: state.city, item_id: it.id, detail: verdict });
    }, 2500);
  }

  const city = () => CITIES[state.city];
  const item = () => withStats(city().items.find(i => i.id === state.item[state.city]) || city().items[0]);
  const mine = (itemId) => reports.filter(r => r.city === state.city && r.item === itemId).map(r => r.price);

  // ---------- formatting ----------
  const num = (v) => {
    const cents = city().decimals && Math.round(v * 100) % 100 !== 0;
    return new Intl.NumberFormat("en-GB", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(v);
  };
  // No conversion needed when the city already uses your money, like euros in Rome.
  const sameMoney = () => city().cur === state.home;
  const local = (v) => `${num(v)} ${city().unit}`;
  const range = (it) => `${num(it.low)} to ${num(it.high)} ${city().unit}`;
  const home = (v) => {
    const amt = v * city().toUSD * HOME[state.home];
    const d = amt < 20 ? 2 : 0;
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: state.home, minimumFractionDigits: d, maximumFractionDigits: d }).format(amt);
  };
  const roundTo = (v) => { const s = city().step; return Math.max(s, Math.round(Math.round(v / s) * s * 100) / 100); };

  // ---------- the verdict ----------
  // Thresholds: under 85% of low is suspiciously cheap, up to high is fair, up to 1.5x high is a bit high.
  function judge(it, q) {
    const extra = sameMoney() ? local(q - it.high) : home(q - it.high);
    const bargain = [
      { label: "Offer", v: roundTo(it.low) },
      { label: "Settle at", v: roundTo((it.low + it.high) / 2) },
      { label: "Walk away above", v: it.high },
    ];
    if (q < it.low * 0.85) return { state: "cheap", word: "Cheap.",
      advice: "Below the usual range. Check what's included, and agree the currency and the quantity before you pay." };
    if (q <= it.high) return { state: "fair", word: "Fair.",
      advice: it.haggle ? "Within the usual range. Pay it, or ask once for a little off." : "Within the usual range. Go ahead." };
    if (q <= it.high * 1.5) return it.haggle
      ? { state: "high", word: "A bit high.", advice: `About ${extra} more than usual. Bargain it down.`, move: bargain }
      : { state: "high", word: "A bit high.", advice: `About ${extra} more than usual, and this is normally a fixed price. ${it.tip || "Ask to see a menu or price list."}` };
    return it.haggle
      ? { state: "over", word: "Way over.", advice: `About ${extra} more than usual. Bargain hard, or walk away. There's usually another seller nearby.`, move: bargain }
      : { state: "over", word: "Way over.", advice: `About ${extra} more than usual, and this is normally a fixed price. Don't pay this. ${it.tip || "Try somewhere else."}` };
  }

  // ---------- render ----------
  function renderCity() {
    const c = city();
    $("city-nm").textContent = c.name;
    $("home").value = state.home;
    $("list-h").textContent = `Usual prices in ${c.name}`;
    $("phrases").innerHTML = c.phrases.map(p =>
      `<li class="phrase"><span class="say" lang="${c.lang}">${p.say}</span><span class="means">${p.means}</span></li>`).join("");
    $("city-tip").textContent = c.tip;
    renderPad();
    renderList();
    renderCheck();
  }

  function renderCheck() {
    const it = item();
    const q = digits ? Number(digits) : 0;
    const [whole, frac] = digits.split(".");

    $("item-nm").textContent = it.name;
    $("item-sub").textContent = it.unit;

    // Entry readout
    const entry = $("entry-wrap");
    $("entry").textContent = !digits ? "0"
      : new Intl.NumberFormat("en-GB").format(Number(whole || 0)) + (frac !== undefined ? "." + frac : "");
    $("entry-cur").textContent = city().unit;
    $("entry-home").textContent = q && !sameMoney() ? `About ${home(q)}` : "";
    entry.toggleAttribute("data-empty", !q && !digits);

    // Scale. Zones match the verdict thresholds.
    const max = Math.max(it.high * 2.2, q * 1.08);
    const pos = (v) => Math.min(100, (v / max) * 100);
    const edges = [0, it.low * 0.85, it.high, it.high * 1.5, max];
    $("zones").innerHTML = ["cheap", "fair", "high", "over"]
      .map((z, i) => `<i class="z-${z}" style="width:${pos(edges[i + 1]) - pos(edges[i])}%"></i>`).join("");
    const my = mine(it.id);
    $("mine-dots").innerHTML = my.map(p => `<span style="left:${pos(p)}%"></span>`).join("");
    $("scale-key").textContent = `Usually ${range(it)}` + (sameMoney() ? "." : `, about ${home(it.low)} to ${home(it.high)}.`) +
      (my.length ? ` You've paid ${my.map(num).join(", ")}.` : "");
    $("source").textContent = source(it);
    $("source").dataset.live = it.live ? "yes" : "no";

    // Verdict
    const verdict = $("verdict"), needle = $("needle"), move = $("move");
    const v = q ? judge(it, q) : null;
    const next = v ? v.state : "empty";
    verdict.dataset.state = next;
    $("word").textContent = v ? v.word : "How much?";
    $("advice").textContent = v ? v.advice : "Punch in the price they asked for.";
    move.hidden = !(v && v.move);
    move.innerHTML = v && v.move ? v.move.map(m => `<span><small>${m.label}</small><b>${num(m.v)}</b></span>`).join("") : "";
    needle.hidden = !q;
    if (q) needle.style.left = pos(q) + "%";
    if (next !== lastVerdict && next !== "empty") {
      verdict.classList.remove("pop"); void verdict.offsetWidth; verdict.classList.add("pop");
    }
    lastVerdict = next;
    trackCheck(it, v && v.state);

    // Add-what-you-paid button follows the keypad
    const paid = $("paid-btn");
    paid.disabled = !q;
    paid.textContent = q ? `Add ${local(q)} as what I paid` : "Type a price first";
  }

  function source(it) {
    if (it.live) {
      const when = new Date(it.last).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
      return `Based on ${it.shared} traveller prices, latest ${when}.`;
    }
    if (sharing && it.shared) return `Sample price. ${it.shared} of ${MIN_PRICES} traveller prices needed to replace it.`;
    return "Sample price, not yet checked.";
  }

  function renderList() {
    const cur = item().id;
    $("prices").innerHTML = city().items.map(withStats).map(it => `
      <li><button class="row" type="button" data-id="${it.id}" aria-current="${it.id === cur}">
        <span class="nm">${it.name}</span>
        <span class="rng">${num(it.low)} to ${num(it.high)}</span>
        <span class="how ${it.haggle ? "haggle" : ""}">${it.haggle ? "Haggle" : "Usually fixed"}${it.live ? `, ${it.shared} prices` : ""}</span>
        <span class="hm">${sameMoney() ? "" : `${home(it.low)} to ${home(it.high)}`}</span>
      </button></li>`).join("");
    $("clear").hidden = !reports.some(r => r.city === state.city);
  }

  function selectItem(id) {
    state.item[state.city] = id;
    save(); renderList(); renderCheck();
  }

  // ---------- keypad ----------
  function renderPad() {
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", city().decimals ? "." : "000", "0", "del"];
    $("pad").innerHTML = keys.map(k => k === "del"
      ? `<button class="key fn" type="button" data-k="del" aria-label="Delete. Hold to clear.">⌫</button>`
      : `<button class="key" type="button" data-k="${k}"${k === "." ? ' aria-label="Decimal point"' : ""}>${k}</button>`).join("");
  }

  function press(k) {
    if (k === "del") digits = digits.slice(0, -1);
    else if (k === "clear") digits = "";
    else if (k === ".") {
      if (!city().decimals || digits.includes(".")) return;
      digits = (digits || "0") + ".";
    } else {
      if (digits.includes(".") && digits.split(".")[1].length + k.length > 2) return; // cents only
      const nextDigits = (digits + k).replace(/^0+(?=\d)/, "");
      if (nextDigits.replace(".", "").length > MAX_DIGITS) return;
      digits = nextDigits;
    }
    renderCheck();
  }
  let holdTimer = null, held = false;
  $("pad").addEventListener("pointerdown", (e) => {
    const b = e.target.closest('[data-k="del"]'); if (!b) return;
    held = false;
    holdTimer = setTimeout(() => { held = true; press("clear"); if (navigator.vibrate) navigator.vibrate(15); }, 550);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach(t => $("pad").addEventListener(t, () => clearTimeout(holdTimer)));
  $("pad").addEventListener("click", (e) => {
    const b = e.target.closest(".key"); if (!b) return;
    if (b.dataset.k === "del" && held) { held = false; return; }
    press(b.dataset.k);
  });
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector("dialog[open]") || e.target.closest("input, select, textarea")) return;
    if (/^\d$/.test(e.key) || e.key === ".") { press(e.key); e.preventDefault(); }
    else if (e.key === "Backspace") { press("del"); e.preventDefault(); }
    else if (e.key === "Escape" && digits) { press("clear"); }
  });

  // ---------- picker sheet, for cities and items ----------
  const picker = $("picker"), pq = $("picker-q"), plist = $("picker-list");
  let pickerMode = "item", pickerOpener = null;
  const opt = (attr, id, cur, nm, sub) =>
    `<li><button type="button" ${attr}="${id}" aria-current="${id === cur}"><span class="nm">${nm}</span><span class="sub">${sub}</span></button></li>`;

  function renderPicker() {
    const term = pq.value.trim().toLowerCase();
    const has = (text) => !term || text.toLowerCase().includes(term);
    let html = "";
    if (pickerMode === "city") {
      for (const region of REGIONS) {
        const hits = Object.entries(CITIES).filter(([, c]) => c.region === region && has(c.name + " " + c.country))
          .sort(([, a], [, b]) => a.name.localeCompare(b.name));
        if (hits.length) html += `<li class="grp" role="presentation">${region}</li>` +
          hits.map(([id, c]) => opt("data-city", id, state.city, c.name, c.country)).join("");
      }
      if (!html) html = `<li class="empty">We don't have "${pq.value.replace(/[<>&"]/g, "")}" yet.</li>`;
      html += `<li class="req"><button type="button" data-request="country"><span class="nm">Request a country</span>` +
        `<span class="sub">Not on the list? Tell us where you're going.</span></button></li>`;
    } else {
      html = city().items.filter(i => has(i.name + " " + i.unit)).map(i => opt("data-id", i.id, item().id, i.name, i.unit)).join("");
      if (!html) html = `<li class="empty">Nothing matches "${pq.value.replace(/[<>&"]/g, "")}". Try a shorter word.</li>`;
      html += `<li class="req"><button type="button" data-request="price"><span class="nm">Request a price</span>` +
        `<span class="sub">Not on the list? Tell us what you're buying.</span></button></li>`;
    }
    plist.innerHTML = html;
  }
  function openPicker(mode, opener) {
    pickerMode = mode; pickerOpener = opener;
    $("picker-h").textContent = mode === "city" ? "Where are you?" : "What are you buying?";
    pq.setAttribute("aria-label", mode === "city" ? "Search cities and countries" : "Search items");
    pq.value = ""; renderPicker();
    picker.showModal();
    (plist.querySelector('[aria-current="true"]') || pq).focus();
  }
  $("item-btn").addEventListener("click", (e) => openPicker("item", e.currentTarget));
  $("city-btn").addEventListener("click", (e) => openPicker("city", e.currentTarget));
  pq.addEventListener("input", renderPicker);
  plist.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.request) {
      const term = pq.value.trim(); picker.close();
      if (b.dataset.request === "price") openPriceRequest(term); else openRequest(term);
      return;
    }
    if (b.dataset.city) setCity(b.dataset.city); else selectItem(b.dataset.id);
    picker.close();
  });
  picker.addEventListener("close", () => { if (pickerOpener) pickerOpener.focus(); });
  $("picker-x").addEventListener("click", () => picker.close());
  picker.addEventListener("click", (e) => { if (e.target === picker) picker.close(); });

  // ---------- other events ----------
  function setCity(id) {
    if (id === state.city) return;
    state.city = id; digits = ""; lastVerdict = "empty";
    $("add-msg").textContent = "";
    save(); renderCity();
    track("city", { city_id: id });
  }
  $("home").addEventListener("change", (e) => { state.home = e.target.value; save(); renderList(); renderCheck(); });
  $("prices").addEventListener("click", (e) => {
    const row = e.target.closest(".row"); if (!row) return;
    selectItem(row.dataset.id);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (innerWidth < 900) window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });
  $("add").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!digits) return;
    const p = Number(digits), it = item();
    reports.push({ city: state.city, item: it.id, price: p, at: Date.now() });
    // Prices far outside the range are probably typos, so they're kept on this phone but not shared.
    const plausible = p >= it.low / 10 && p <= it.high * 10;
    if (sharing && plausible) {
      outbox.push({ city_id: state.city, item_id: it.id, price: p, currency: city().cur, device_id: device });
      localStorage.setItem(OUTBOX, JSON.stringify(outbox));
    }
    save(); renderList(); renderCheck();
    $("add-msg").textContent = sharing && !plausible
      ? "That's far from the usual range, so it's saved on this phone but not shared. Check for a missing or extra zero." : "";
    toast(`Price added: ${local(p)} for ${it.name.toLowerCase()}`);
    track("price_added", { city_id: state.city, item_id: it.id });
    flush();
  });
  $("clear").addEventListener("click", () => {
    reports = reports.filter(r => r.city !== state.city);
    save(); renderList(); renderCheck();
    toast(`Removed your prices for ${city().name}`);
  });

  const api = (path, opts = {}) => fetch(SHARING.url.replace(/\/$/, "") + "/rest/v1/" + path, {
    ...opts,
    headers: { apikey: SHARING.anonKey, Authorization: "Bearer " + SHARING.anonKey, "Content-Type": "application/json", ...opts.headers },
  });

  let flushing = false;
  async function flush() {
    if (!sharing || flushing || !outbox.length || !navigator.onLine) return;
    flushing = true;
    try {
      const batch = outbox.slice(0, 20);
      const res = await api("price_reports", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(batch) });
      // 4xx means the server rejected them (bad data or the daily limit), so drop them rather than retry forever.
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        outbox = outbox.slice(batch.length);
        localStorage.setItem(OUTBOX, JSON.stringify(outbox));
        if (res.ok) loadStats();
        if (outbox.length) setTimeout(() => { flushing = false; flush(); }, 0);
      }
    } catch {} // offline or server down: try again later
    finally { flushing = false; }
  }

  async function loadStats() {
    if (!sharing || !navigator.onLine) return;
    try {
      const res = await api("price_stats?select=city_id,item_id,n,p25,median,p75,last_at");
      if (!res.ok) return;
      const next = {};
      for (const r of await res.json()) {
        next[r.city_id + "/" + r.item_id] = { n: r.n, p25: +r.p25, median: +r.median, p75: +r.p75, last_at: r.last_at };
      }
      stats = next;
      localStorage.setItem(STATS, JSON.stringify(stats));
      renderList(); renderCheck();
    } catch {}
  }

  // ---------- request a country ----------
  const request = $("request"), reqMsg = $("req-msg");
  function openRequest(term) {
    $("req-country").value = term || ""; $("req-city").value = ""; reqMsg.textContent = "";
    request.showModal();
    $("req-country").focus();
  }
  $("request-x").addEventListener("click", () => request.close());
  request.addEventListener("click", (e) => { if (e.target === request) request.close(); });
  $("request-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const country = $("req-country").value.trim(), cityName = $("req-city").value.trim(), email = $("req-email").value.trim();
    if (!country) { reqMsg.textContent = "Type a country first."; $("req-country").focus(); return; }
    if (email && !$("req-email").checkValidity()) { reqMsg.textContent = "That email address doesn't look right."; $("req-email").focus(); return; }
    const byEmail = () => {
      const body = `Please add ${cityName ? cityName + ", " : ""}${country} to Bule.`;
      location.href = `mailto:info@betttech.co.uk?subject=${encodeURIComponent("Bule: request a country")}&body=${encodeURIComponent(body)}`;
      request.close();
    };
    if (!sharing) return byEmail();
    if (!navigator.onLine) { reqMsg.textContent = "You're offline. Try again when you have signal."; return; }
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      const res = await api("city_requests", { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ country, city: cityName || null, email: email || null, device_id: device }) });
      if (res.ok) { request.close(); toast(`Thanks. We've noted ${cityName || country}.`); track("request_country"); }
      else if (res.status === 400 && (await res.text()).includes("Too many")) reqMsg.textContent = "You've sent a lot of requests today. Thanks! Try again tomorrow.";
      else byEmail();
    } catch { reqMsg.textContent = "Couldn't send that. Check your connection and try again."; }
    finally { if (btn) btn.disabled = false; }
  });

  // ---------- request a price ----------
  const preq = $("price-request"), preqMsg = $("preq-msg");
  function openPriceRequest(term) {
    $("preq-h").textContent = `Request a price in ${city().name}`;
    $("preq-item").value = term || ""; $("preq-details").value = ""; preqMsg.textContent = "";
    preq.showModal();
    $("preq-item").focus();
  }
  $("price-request-x").addEventListener("click", () => preq.close());
  preq.addEventListener("click", (e) => { if (e.target === preq) preq.close(); });
  $("price-request-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("preq-item").value.trim(), details = $("preq-details").value.trim(), email = $("preq-email").value.trim();
    if (!name) { preqMsg.textContent = "Type what you're buying first."; $("preq-item").focus(); return; }
    if (email && !$("preq-email").checkValidity()) { preqMsg.textContent = "That email address doesn't look right."; $("preq-email").focus(); return; }
    const done = () => { if (typeof gtag === "function") gtag("event", "request_price", { city_id: state.city }); };
    const byEmail = () => {
      const body = `Please add a price for ${name}${details ? " (" + details + ")" : ""} in ${city().name}, ${city().country}.`;
      location.href = `mailto:info@betttech.co.uk?subject=${encodeURIComponent("Bule: request a price")}&body=${encodeURIComponent(body)}`;
      preq.close(); done();
    };
    if (!sharing) return byEmail();
    if (!navigator.onLine) { preqMsg.textContent = "You're offline. Try again when you have signal."; return; }
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      const res = await api("item_requests", { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ city_id: state.city, item: name, details: details || null, email: email || null, device_id: device }) });
      if (res.ok) { preq.close(); toast(`Thanks. We've noted ${name.toLowerCase()}.`); done(); }
      else if (res.status === 400 && (await res.text()).includes("Too many")) preqMsg.textContent = "You've sent a lot of requests today. Thanks! Try again tomorrow.";
      else byEmail();
    } catch { preqMsg.textContent = "Couldn't send that. Check your connection and try again."; }
    finally { if (btn) btn.disabled = false; }
  });

  let toastTimer;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  // ---------- offline and install ----------
  const status = $("status");
  let offlineReady = false;
  function updateStatus() {
    if (!navigator.onLine) { status.hidden = false; status.className = "status off"; status.textContent = "Offline"; }
    else if (offlineReady) { status.hidden = false; status.className = "status"; status.textContent = "Works offline"; }
    else status.hidden = true;
  }
  addEventListener("online", () => { updateStatus(); flush(); loadStats(); });
  addEventListener("offline", updateStatus);

  // Service workers need https or localhost, so this does nothing when the file is opened directly.
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(() => { offlineReady = true; updateStatus(); })
      .catch(() => {});
  }
  updateStatus();

  // Chrome and Edge offer their own install prompt. Safari and Firefox don't, so we show the steps instead.
  let installPrompt = null;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installBtn = $("install"), installHelp = $("install-help");
  installBtn.hidden = !!standalone;
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });
  installBtn.addEventListener("click", async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      return;
    }
    const steps = ios ? ["Tap the Share button, the square with an arrow. In Safari it's at the bottom of the screen. In Chrome it's at the top.",
                         "Scroll down and tap <b>Add to Home Screen</b>.", "Tap <b>Add</b>."]
      : /android/i.test(ua) ? ["Open your browser's menu, the three dots.", "Tap <b>Install app</b> or <b>Add to Home screen</b>.",
                               "If you don't see either, open this page in Chrome and try again."]
      : /safari/i.test(ua) && !/chrome|chromium|edg/i.test(ua) ? ["In the menu bar, choose <b>File</b>, then <b>Add to Dock</b>."]
      : ["Look for the install icon at the right of the address bar, or open the browser menu and choose <b>Install Bule</b>.",
         "If there isn't one, open Bule on your phone instead, where it's most useful."];
    $("install-steps").innerHTML = steps.map(t => `<li>${t}</li>`).join("");
    installHelp.showModal();
  });
  $("install-x").addEventListener("click", () => installHelp.close());
  installHelp.addEventListener("click", (e) => { if (e.target === installHelp) installHelp.close(); });
  addEventListener("appinstalled", () => { installBtn.hidden = true; toast("Bule installed"); track("install"); });

  $("add-note").textContent = sharing
    ? "Your prices show as marks on the scale, and are shared with other travellers without your name. If you're offline, they're sent when you're back online."
    : "Your prices show as marks on the scale. They stay on this phone.";

  renderCity();
  // "home" tells you whether it was opened from the home screen or in the browser.
  track("open", { city_id: state.city, detail: standalone ? "home" : "browser" });
  flush();
  loadStats();
})();
