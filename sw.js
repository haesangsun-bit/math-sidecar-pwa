"use strict";

const VERSION = "0.1.1";
const CACHE = `mathsidecar-pwa-${VERSION}`;
const SHARE_CACHE = "mathsidecar-pwa-shares-v1";
const CORE = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.json",
  "./mathjax-config.js",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-192.png",
  "./icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Do not make SW installation all-or-nothing. One optional asset must not
    // prevent Chrome from recognising the site as an installable PWA.
    await Promise.allSettled(CORE.map(async (url) => {
      try {
        const response = await fetch(url, { cache: "reload" });
        if (response.ok) await cache.put(url, response.clone());
      } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith("mathsidecar-pwa-") && key !== CACHE && key !== SHARE_CACHE)
      .map((key) => caches.delete(key)));
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
      const id = (self.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const shareCache = await caches.open(SHARE_CACHE);
      await shareCache.put(shareKey(id), new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json; charset=utf-8" }
      }));
      return Response.redirect(new URL(`./index.html?share=${encodeURIComponent(id)}`, self.registration.scope).href, 303);
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

  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    // Navigation: network first, with cached app shell fallback.
    if (event.request.mode === "navigate") {
      try {
        const fresh = await fetch(event.request);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put("./index.html", fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (_) {
        return (await caches.match("./index.html")) || (await caches.match("./")) || Response.error();
      }
    }

    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const fresh = await fetch(event.request);
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(event.request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (_) {
      return Response.error();
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "delete-share" && event.data.id) {
    event.waitUntil(caches.open(SHARE_CACHE).then((cache) => cache.delete(shareKey(String(event.data.id)))));
  }
});
