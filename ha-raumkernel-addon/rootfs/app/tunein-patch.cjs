'use strict';
// Loaded via  node --require ./tunein-patch.cjs index.js
// Runs before ANY other module is evaluated, so our patched http.request /
// http.get are captured by node-raumkernel's MediaListManager at its own
// module-load time.
//
// node-raumkernel's MediaListManager fetches the raw opml.radiotime.com
// relay URL stored in each renderer's AVTransportURI / AVTransportURIMetaData.
// TuneIn counts each such fetch as a new session request against the shared
// serial (78:a5:04:f1:82:ee), which triggers CDN-token throttle and causes
// simultaneous stream drops on all playing rooms.
//
// The kernel's own ebrowse session renewals are made from the kernel *binary*
// (a native process, not Node.js http), so this patch never affects them.

const http = require('http');
const { EventEmitter } = require('events');

const BLOCKED_HOST = 'opml.radiotime.com';
const FAKE_BODY = Buffer.from('#EXTM3U\n');

function isTuneIn(urlOrOpts) {
    let host = '';
    if (typeof urlOrOpts === 'string') {
        try { host = new URL(urlOrOpts).hostname; } catch { /* ignore */ }
    } else if (urlOrOpts && typeof urlOrOpts === 'object') {
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
