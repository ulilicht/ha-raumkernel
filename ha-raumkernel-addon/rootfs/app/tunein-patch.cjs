'use strict';
// Loaded via  node --require ./tunein-patch.cjs index.js
// Runs before ANY other module is evaluated, so our patched global.setTimeout,
// http.request, http.get and globalThis.fetch are captured by node-raumkernel
// at its own module-load time.
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// Problem 1 — UPnP subscription renewal burst (PRIMARY CAUSE OF STREAM DROPS)
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// All UPnP subscriptions (AVTransport + RenderingControl for every renderer,
// ~46 total) are created within a 5-second window at integration startup.
// The Raumfeld kernel typically grants a ~240-second subscription timeout.
// upnp-device-client schedules each renewal at (grantedTimeout − 30) seconds
// after creation, so ALL renewals fire simultaneously at T+210 s.  That
// second burst is as large as the startup burst and hits the kernel's HTTP
// server while Kueche's TuneIn CDN-session renewal is also due, causing the
// kernel to miss the renewal window → stream drops at ~T+211 s.
//
// Fix: intercept global.setTimeout and add 0–60 s of random jitter for calls
// whose delay falls in 120 000–300 000 ms.  That range is exclusive to UPnP
// subscription renewal timers (nothing else in node-raumkernel uses it).
// With jitter the ~46 renewals spread across a 60-second window
// (~0.8 renewals/s) — well within the kernel's capacity.
//
// Problem 2 — MediaListManager TuneIn relay fetches (secondary, now moot)
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// node-raumkernel's MediaListManager could fetch raw opml.radiotime.com relay
// URLs stored in renderer metadata, registering new TuneIn sessions against
// the shared serial and triggering CDN-token throttle.  The http/fetch patch
// below blocks those fetches.  (No intercepts have fired in recent logs —
// current code paths don't hit this path — but the guard stays in place.)
//
// The kernel's own ebrowse session renewals are made from the kernel *binary*
// (a native process, not Node.js http), so neither patch affects them.

// ── Startup diagnostic ───────────────────────────────────────────────────────
// These messages appear WITHOUT timestamps (console override runs later in
// index.js).  Their presence in the log confirms --require loaded this file.
process.stdout.write('[Command] [TuneIn-Intercept] CJS preloader active — patching http + fetch\n');

// ── UPnP subscription renewal jitter ─────────────────────────────────────────
const _origSetTimeout = global.setTimeout;
global.setTimeout = function jitteredSetTimeout(fn, delay, ...args) {
    // Intercept only the subscription-renewal-timer range: 120 s – 300 s.
    // upnp-device-client uses setTimeout(renew, renewTimeout * 1000) where
    // renewTimeout = max(grantedTimeout − 30, 30).  For a 240 s grant that
    // is 210 000 ms; for a 300 s grant it is 270 000 ms — both land here.
    // Nothing else in node-raumkernel uses a 2–5-minute timer.
    if (typeof delay === 'number' && delay >= 120000 && delay <= 300000) {
        const jitter = Math.floor(Math.random() * 60000); // 0–60 s
        return _origSetTimeout(fn, delay + jitter, ...args);
    }
    return _origSetTimeout(fn, delay, ...args);
};
process.stdout.write('[Command] [SubRenewal-Jitter] setTimeout patched — subscription renewal burst prevention active\n');

const http = require('http');
const { EventEmitter } = require('events');

const BLOCKED_HOST = 'opml.radiotime.com';
const FAKE_BODY = Buffer.from('#EXTM3U\n');

function isTuneIn(urlOrOpts) {
    let host = '';
    if (typeof urlOrOpts === 'string') {
        try { host = new URL(urlOrOpts).hostname; } catch { /* ignore */ }
    } else if (urlOrOpts && typeof urlOrOpts === 'object') {
        // Handles plain options objects AND URL instances (both have .hostname)
        host = (urlOrOpts.hostname || urlOrOpts.host || '').split(':')[0];
    }
    return host === BLOCKED_HOST;
}

function fakeRequest(callback) {
    const fakeReq = new EventEmitter();
    fakeReq.end          = () => fakeReq;
    fakeReq.write        = () => fakeReq;
    fakeReq.destroy      = () => {};
    fakeReq.abort        = () => {};
    fakeReq.setHeader    = () => {};
    fakeReq.removeHeader = () => {};
    fakeReq.setTimeout   = () => fakeReq;
    fakeReq.flushHeaders = () => {};
    fakeReq.socket       = null;
    fakeReq.headersSent  = false;
    setImmediate(() => {
        const fakeRes = new EventEmitter();
        fakeRes.statusCode    = 200;
        fakeRes.statusMessage = 'OK';
        fakeRes.headers       = { 'content-type': 'audio/x-mpegurl' };
        fakeRes.httpVersion   = '1.1';
        fakeRes.destroy = () => {};
        fakeRes.resume  = () => {};
        fakeRes.pipe    = () => fakeRes;
        if (callback) {
            callback(fakeRes);
        } else {
            fakeReq.emit('response', fakeRes);
        }
        setImmediate(() => {
            fakeRes.emit('data', FAKE_BODY);
            fakeRes.emit('end');
        });
    });
    return fakeReq;
}

// ── Patch http.request and http.get ─────────────────────────────────────────
const _origRequest = http.request.bind(http);
const _origGet     = http.get.bind(http);

http.request = function patchedRequest(url, options, cb) {
    const callback = typeof options === 'function' ? options : cb;
    if (isTuneIn(url)) {
        console.log('[Command] [TuneIn-Intercept] Blocked http.request → opml.radiotime.com (serial throttle prevented)');
        return fakeRequest(callback);
    }
    return _origRequest(url, options, cb);
};

http.get = function patchedGet(url, options, cb) {
    const callback = typeof options === 'function' ? options : cb;
    if (isTuneIn(url)) {
        console.log('[Command] [TuneIn-Intercept] Blocked http.get → opml.radiotime.com (serial throttle prevented)');
        const req = fakeRequest(callback);
        req.end(); // http.get always auto-calls end()
        return req;
    }
    return _origGet(url, options, cb);
};

// ── Patch globalThis.fetch (Node.js 18+ built-in / undici) ──────────────────
// node-fetch v3 may use the native global fetch when running on Node.js 18+,
// bypassing http.request entirely.  Patch it here while we still have the
// earliest possible execution slot.
if (typeof globalThis.fetch === 'function') {
    const _origFetch = globalThis.fetch;
    globalThis.fetch = function patchedFetch(resource, options) {
        let hostname = '';
        try {
            const urlStr = typeof resource === 'string'
                ? resource
                : (resource && resource.url ? resource.url : String(resource));
            hostname = new URL(urlStr).hostname;
        } catch { /* ignore */ }
        if (hostname === BLOCKED_HOST) {
            console.log('[Command] [TuneIn-Intercept] Blocked global fetch → opml.radiotime.com (serial throttle prevented)');
            // Return a minimal Response-like object that satisfies node-fetch's
            // internal consumer (text(), json(), body checks).
            const body = FAKE_BODY.toString();
            const fakeResponse = {
                ok: true, status: 200, statusText: 'OK',
                url: typeof resource === 'string' ? resource : (resource.url || ''),
                headers: {
                    get: (name) => name.toLowerCase() === 'content-type' ? 'audio/x-mpegurl' : null,
                    has: (name) => name.toLowerCase() === 'content-type',
                    forEach: (fn) => fn('audio/x-mpegurl', 'content-type'),
                },
                redirected: false, type: 'basic',
                text:        async () => body,
                json:        async () => ({}),
                arrayBuffer: async () => Buffer.from(body).buffer,
                blob:        async () => new Blob([body]),
                clone:       function() { return this; },
                body: null,
            };
            return Promise.resolve(fakeResponse);
        }
        return _origFetch.apply(this, arguments);
    };
    process.stdout.write('[Command] [TuneIn-Intercept] globalThis.fetch patched\n');
}
