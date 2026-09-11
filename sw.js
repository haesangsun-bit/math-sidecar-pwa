"use strict";

const VERSION = "0.1.0";
const CACHE = `mathsidecar-pwa-${VERSION}`;
const SHARE_CACHE = "mathsidecar-pwa-shares-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.json",
  "./mathjax-config.js",
  "./vendor/mathjax/tex-svg-full.js",
  "./vendor/mathjax/LICENSE",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("mathsidecar-pwa-") && key !== CACHE && key !== SHARE_CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function shareKey(id) {
  return new Request(new URL(`./__share__/${encodeURIComponent(id)}`, self.registration.scope).href);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith((async () => {
      const form = await event.request.formData();
      const payload = {
        title: String(form.get("title") || ""),
        text: String(form.get("text") || ""),
        url: String(form.get("url") || ""),
        receivedAt: Date.now()
      };
      const id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const shareCache = await caches.open(SHARE_CACHE);
      await shareCache.put(shareKey(id), new Response(JSON.stringify(payload), { headers: { "content-type": "application/json; charset=utf-8" } }));
      const destination = new URL(`./index.html?share=${encodeURIComponent(id)}`, self.registration.scope).href;
      return Response.redirect(destination, 303);
    })());
    return;
  }

  if (event.request.method === "GET" && url.pathname.includes("/__share__/")) {
    event.respondWith((async () => {
      const shareCache = await caches.open(SHARE_CACHE);
      return (await shareCache.match(event.request)) || new Response("Not found", { status: 404 });
    })());
    return;
  }

  if (event.request.method === "GET" && url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      try {
        const fresh = await fetch(event.request);
        if (fresh.ok && event.request.destination !== "document") {
          const cache = await caches.open(CACHE);
          cache.put(event.request, fresh.clone());
        }
        return fresh;
      } catch {
        if (event.request.mode === "navigate") return (await caches.match("./index.html")) || Response.error();
        return Response.error();
      }
    })());
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "delete-share" && event.data.id) {
    event.waitUntil(caches.open(SHARE_CACHE).then((cache) => cache.delete(shareKey(String(event.data.id)))));
  }
});
