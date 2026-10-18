// Copyright © 2026 Betttech Global Ventures (BGV) Limited. All rights reserved. See LICENSE.
(() => {
  // The scout page. Prices are saved on the phone first, then sent when there's signal,
  // so scouts can keep working in markets with no connection.
  // CITIES comes from cities.js, SHARING from config.js.
  const $ = (id) => document.getElementById(id);
  const ME = "bule.scout.v1", SENT = "bule.scout.sent.v1";
  const ready = typeof SHARING !== "undefined" && SHARING.url && SHARING.anonKey;
  const base = ready ? SHARING.url.replace(/\/$/, "") : "";
  const headers = ready ? { apikey: SHARING.anonKey, Authorization: "Bearer " + SHARING.anonKey } : {};

  let me = null;   // { code, name, city_id }
  let sent = [];   // short record of what's been sent, for the progress list
  try { me = JSON.parse(localStorage.getItem(ME)); } catch {}
  try { sent = JSON.parse(localStorage.getItem(SENT)) || []; } catch {}

  const uuid = () => crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const city = () => me && CITIES[me.city_id];

  // ---------- the queue, in IndexedDB because photos are too big for localStorage ----------
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((ok, fail) => {
    const r = indexedDB.open("bule-scout", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("queue", { keyPath: "client_id" });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((ok, fail) => {
      const t = d.transaction("queue", mode), out = fn(t.objectStore("queue"));
      t.oncomplete = () => ok(out && out.result);
      t.onerror = () => fail(t.error);
    });
  };
  const queueAll = () => tx("readonly", s => s.getAll());
  const queuePut = (row) => tx("readwrite", s => s.put(row));
  const queueDel = (id) => tx("readwrite", s => s.delete(id));

  // ---------- server ----------
  async function rpc(fn, body) {
    const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (!res.ok) { const err = new Error((data && data.message) || text || res.statusText); err.status = res.status; throw err; }
    return data;
  }

  async function uploadPhoto(row) {
    const path = `${me.code}/${row.client_id}.jpg`;
    const res = await fetch(`${base}/storage/v1/object/scout-photos/${path}`, {
      method: "POST", headers: { ...headers, "Content-Type": row.photo.type || "image/jpeg" }, body: row.photo,
    });
    // 409 means it's already there from an earlier try that lost its connection.
    if (res.ok || res.status === 409) return path;
    const err = new Error(`Photo upload failed (${res.status})`); err.status = res.status; throw err;
  }

  // Photos straight from a phone camera are 3 to 10 MB. Shrink them so they send quickly on mobile data.
  async function shrink(file) {
    try {
      const img = await (window.createImageBitmap ? createImageBitmap(file) : new Promise((ok, fail) => {
        const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = URL.createObjectURL(file);
      }));
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.8));
    } catch {
      return /^image\/(jpeg|png|webp)$/.test(file.type) && file.size < 5e6 ? file : null;
    }
  }

  // ---------- sending ----------
  let sending = false;
  async function send() {
    if (!ready || sending || !navigator.onLine || !me) return;
    sending = true; render();
    try {
      for (const row of await queueAll()) {
        try {
          if (row.photo && !row.photo_path) { row.photo_path = await uploadPhoto(row); row.error = ""; await queuePut(row); }
          await rpc("scout_submit", { p_code: me.code, p_rows: [{
            client_id: row.client_id, item_id: row.item_id, date: row.date, place: row.place,
            first_quote: row.first_quote, final_price: row.final_price, bought: row.bought,
            photo: row.photo_path || "", notes: row.notes,
          }] });
          sent.push({ item_id: row.item_id, place: row.place.toLowerCase(), final_price: row.final_price, at: Date.now() });
          localStorage.setItem(SENT, JSON.stringify(sent));
          await queueDel(row.client_id);
        } catch (err) {
          if (!err.status) break; // lost the connection: stop and try again later
          if (/scout code/i.test(err.message)) { signOut("That code has been turned off. Contact us if you think that's wrong."); return; }
          row.error = err.message.replace(/^.*?:\s*/, ""); await queuePut(row); // keep it, and show why
        }
      }
    } finally { sending = false; render(); }
  }

  // ---------- rendering ----------
  async function render() {
    const status = $("status");
    status.hidden = false;
    status.className = navigator.onLine ? "status" : "status off";
    status.textContent = navigator.onLine ? "Online" : "Offline";

    $("signin").hidden = !!me;
    $("work").hidden = $("sent-panel").hidden = !me;
    if (!me) return;

    const c = city();
    const queue = (await queueAll()).sort((a, b) => b.created - a.created);
    const nameOf = (id) => (c.items.find(i => i.id === id) || { name: id }).name;
    const amount = (v) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(v) + " " + c.unit;

    $("queue-note").textContent = !queue.length ? `${sent.length} sent from this phone. Nothing waiting.`
      : navigator.onLine ? (sending ? "Sending…" : `${queue.length} waiting to send.`)
      : `${queue.length} saved on this phone. They'll send when you have signal. Keep this page open, or open it again later.`;
    $("queue").innerHTML = queue.map(r => `
      <li><span class="nm">${esc(nameOf(r.item_id))}: ${esc(amount(r.final_price))}</span>
        <span class="sub">${esc(r.place)}, ${esc(r.date)}${r.photo ? ", with photo" : ""}</span>
        ${r.error ? `<span class="err">Not sent: ${esc(r.error)}</span>` : ""}
        <span class="acts"><button class="link" type="button" data-del="${r.client_id}">Delete</button></span></li>`).join("");
    $("send").hidden = !queue.length || !navigator.onLine || sending;

    const all = [...sent, ...queue.map(r => ({ item_id: r.item_id, place: r.place.toLowerCase() }))];
    $("progress").innerHTML = c.items.map(it => {
      const mine = all.filter(r => r.item_id === it.id), places = new Set(mine.map(r => r.place)).size;
      const done = mine.length >= 5 && places >= 3;
      return `<li><span class="nm">${done ? "✓ " : ""}${esc(it.name)}</span>
        <span class="sub">${mine.length} of 5 prices, ${places} of 3 sellers</span></li>`;
    }).join("");
  }

  function startWork() {
    const c = city();
    $("hello").textContent = `Hello ${me.name}. You're pricing ${c.name}, in ${c.unit}. Save each price as soon as you get it.`;
    $("item").innerHTML = c.items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join("");
    showItemHint();
    $("date").value = today();
    render();
    send();
  }
  // Show what to price, but not the expected range, so it doesn't sway the scout.
  const showItemHint = () => { const it = city().items.find(i => i.id === $("item").value); $("item-hint").textContent = it ? it.unit : ""; };
  $("item").addEventListener("change", showItemHint);

  function signOut(msg) {
    me = null; localStorage.removeItem(ME);
    $("code").value = ""; $("code-msg").textContent = msg || "";
    render();
  }

  // ---------- sign in with a code ----------
  async function signIn(code) {
    const msg = $("code-msg");
    code = code.trim().toUpperCase();
    if (!code) { msg.textContent = "Type your code first."; return; }
    if (!ready) { msg.textContent = "The scout page isn't set up yet. Contact us."; return; }
    if (!navigator.onLine) { msg.textContent = "You need signal to check your code. After that, you can work offline."; return; }
    msg.textContent = "Checking…";
    try {
      const rows = await rpc("scout_whoami", { p_code: code });
      if (!rows || !rows.length) { msg.textContent = "That code isn't right. Check it and try again."; return; }
      if (!CITIES[rows[0].city_id]) { msg.textContent = "Your city isn't in the app yet. Contact us."; return; }
      me = { code, name: rows[0].name, city_id: rows[0].city_id };
      localStorage.setItem(ME, JSON.stringify(me));
      msg.textContent = "";
      startWork();
    } catch { msg.textContent = "Couldn't check your code. Try again in a minute."; }
  }
  $("code-form").addEventListener("submit", (e) => { e.preventDefault(); signIn($("code").value); });

  // ---------- saving a price ----------
  $("photo").addEventListener("change", () => {
    const f = $("photo").files[0], img = $("photo-preview");
    if (img.src) URL.revokeObjectURL(img.src);
    img.hidden = !f; if (f) img.src = URL.createObjectURL(f);
  });

  const price = (raw) => {
    let s = String(raw || "").replace(/[\s,]/g, "");
    if (!city().decimals) s = s.replace(/\./g, ""); // 35.000 means thirty-five thousand where there are no cents
    const v = Number(s);
    return s && isFinite(v) && v > 0 ? v : null;
  };

  $("price-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("price-msg");
    const it = city().items.find(i => i.id === $("item").value);
    const place = $("place").value.trim(), final = price($("final").value);
    const first = $("first").value.trim() ? price($("first").value) : null;
    if (!place) { msg.textContent = "Say where it was."; $("place").focus(); return; }
    if (!final) { msg.textContent = "Type the final price as a number, like 35000."; $("final").focus(); return; }
    if ($("first").value.trim() && !first) { msg.textContent = "Type the first price as a number, or leave it empty."; $("first").focus(); return; }
    if (!$("date").value) { msg.textContent = "Choose the date."; $("date").focus(); return; }
    if ((final < it.low / 10 || final > it.high * 10) &&
        !confirm(`${final} ${city().unit} is very different from what we expected. Is there a missing or extra zero? Save it anyway?`)) return;

    const btn = e.submitter; if (btn) btn.disabled = true;
    msg.textContent = "";
    try {
      const file = $("photo").files[0];
      const photo = file ? await shrink(file) : null;
      await queuePut({
        client_id: uuid(), created: Date.now(), item_id: it.id, place, date: $("date").value,
        first_quote: first, final_price: final, bought: document.querySelector('input[name="bought"]:checked').value === "yes",
        notes: $("notes").value.trim(), photo, photo_path: "", error: "",
      });
      // Keep the place and date, since the next price is often from the same spot.
      $("first").value = $("final").value = $("notes").value = $("photo").value = "";
      $("photo-preview").hidden = true;
      document.querySelector('input[name="bought"][value="no"]').checked = true;
      toast(file && !photo ? "Saved, but the photo couldn't be used. Try a JPEG." : `Saved: ${it.name}`);
      await render();
      send();
    } catch {
      msg.textContent = "Couldn't save that on this phone. Is storage full?";
    } finally { if (btn) btn.disabled = false; }
  });

  $("queue").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    if (!confirm("Delete this price? It hasn't been sent.")) return;
    await queueDel(b.dataset.del); render();
  });
  $("send").addEventListener("click", send);
  $("signout").addEventListener("click", async () => {
    if ((await queueAll()).length && !confirm("Some prices haven't been sent yet. They'll stay on this phone and send under the next code. Continue?")) return;
    signOut();
  });

  let toastTimer;
  function toast(m) {
    const t = $("toast"); t.textContent = m; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  addEventListener("online", () => { render(); send(); });
  addEventListener("offline", render);
  setInterval(send, 60000); // markets have patchy signal, so keep trying

  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // A link like scout.html?code=AB12CD34 signs the scout in straight away.
  const fromLink = new URLSearchParams(location.search).get("code");
  if (fromLink) history.replaceState(null, "", location.pathname);
  if (me && !CITIES[me.city_id]) me = null;
  if (me) startWork();
  else { render(); if (fromLink) { $("code").value = fromLink; signIn(fromLink); } }
})();
