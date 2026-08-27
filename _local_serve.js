#!/usr/bin/env node
/**
 * Stable local static server for RonkBonk (original game).
 * Keeps running until killed. Bind 0.0.0.0:8888.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.RONK_PORT || 8888);
const ROOT = path.resolve(__dirname);
const DEBUG_LOG = path.join(ROOT, 'debug-736746.log');
const DEBUG_LOG_CURSOR = path.join(ROOT, '.cursor', 'debug-736746.log');

function appendDebugLogLine(line) {
    const payload = String(line || '').trim();
    if (!payload) return;
    const row = payload + '\n';
    try { fs.appendFileSync(DEBUG_LOG, row); } catch (_) { /* ignore */ }
    try {
        fs.mkdirSync(path.dirname(DEBUG_LOG_CURSOR), { recursive: true });
        fs.appendFileSync(DEBUG_LOG_CURSOR, row);
    } catch (_) { /* ignore */ }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json'
};

function send(res, code, body, type) {
    res.writeHead(code, {
        'Content-Type': type || 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

const server = http.createServer((req, res) => {
    try {
        let u = decodeURIComponent((req.url || '/').split('?')[0]);
        if (req.method === 'POST' && u === '/__debug_ingest') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8').trim();
                if (body) {
                    appendDebugLogLine(body);
                }
                res.writeHead(204, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type, X-Debug-Session-Id',
                    'Cache-Control': 'no-store'
                });
                res.end();
            });
            return;
        }
        if (req.method === 'OPTIONS' && u === '/__debug_ingest') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-Debug-Session-Id',
                'Cache-Control': 'no-store'
            });
            res.end();
            return;
        }
        if (u === '/') u = '/index.html';
        const fp = path.normalize(path.join(ROOT, u));
        if (!fp.startsWith(ROOT)) return send(res, 403, 'Forbidden');
        fs.stat(fp, (err, st) => {
            if (err || !st.isFile()) return send(res, 404, 'Not found');
            fs.readFile(fp, (readErr, data) => {
                if (readErr) return send(res, 404, 'Not found');
                const ext = path.extname(fp).toLowerCase();
                send(res, 200, data, MIME[ext] || 'application/octet-stream');
            });
        });
    } catch (e) {
        send(res, 500, String(e && e.message || e));
    }
});

server.on('error', (err) => {
    console.error('[ronk-serve]', err && err.message || err);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error('[ronk-serve] uncaught', err);
});

process.on('unhandledRejection', (err) => {
    console.error('[ronk-serve] rejection', err);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('RonkBonk serving http://localhost:' + PORT);
    console.log('ROOT ' + ROOT);
    console.log('Keep this process running.');
});
