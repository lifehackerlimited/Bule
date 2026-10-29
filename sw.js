// Copyright © 2026 Betttech Global Ventures (BGV) Limited. All rights reserved. See LICENSE.
// Saves the app on the phone so it opens with no connection.
// Bump VERSION whenever app files change, so phones pick up the new copy.
const VERSION = "bule-v22";
const FONTS = "bule-fonts";
const SHELL = [
  "./",
  "index.html",
  "app.css",
  "config.js",
  "cities.js",
  "account.js",
  "app.js",
  "scout.html",
  "scout.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Font files never change at a given URL, so keep the first copy.
  if (url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then((c) =>
      c.match(req).then((hit) => hit || fetch(req).then((res) => { c.put(req, res.clone()); return res; }))
    ));
    return;
  }

  // The font stylesheet: use the saved copy, and refresh it when online.
  if (url.hostname === "fonts.googleapis.com") {
    e.respondWith(staleWhileRevalidate(req, FONTS));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Opening a page: answer from the saved copy, so it starts instantly with no signal.
  // scout.html is its own page. Anything else in the app opens the price checker.
  if (req.mode === "navigate") {
    const page = url.pathname.endsWith("/scout.html") ? "scout.html" : "index.html";
    e.respondWith(
      caches.match(page).then((hit) => {
        const fresh = fetch(req).then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(page, res.clone()));
          return res;
        });
        if (hit) { fresh.catch(() => {}); return hit; }
        return fresh;
      })
    );
    return;
  }

  e.respondWith(staleWhileRevalidate(req, VERSION));
});

function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then((c) =>
    c.match(req).then((hit) => {
      const fresh = fetch(req)
        // The font stylesheet comes back opaque (no CORS), which still caches fine.
        .then((res) => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; })
        .catch(() => hit);
      return hit || fresh;
    })
  );
}
