// Local web server for the browser test, the probes and trying the extension by hand. It listens on 127.0.0.1 and ::1, so http://127.0.0.1:<port>
// and http://localhost:<port> are two origins of one server (the frames page uses that for a cross-origin frame).
//
// Usage: node test/playground/serve.cjs [port]      (default 8378)
//
// /<name>.html             a page from this folder; {{PORT}} in it becomes the port
// /frames.html             top page with a same-origin and a cross-origin frame
// /many.html?n=            n generated download links (default 5000)
// /title.html?t=           a page titled t (set from script) with one download link
// /set-cookies             sets the cookies plain, lax (SameSite=Lax) and strict (SameSite=Strict)
// /dl/<id>?name=<file>     a download without a file name in the address: Content-Disposition attachment, default "Real Name.pdf"
// /file/<name>             a file under its own name, content type from the extension
// /login/<id>              an HTML page where a file was expected (what a site sends when the session has expired)
// /slow/<name>?size=&cut=  size bytes in 16 KB chunks every 50 ms, resumable (Range, ETag); with cut the first request without Range breaks at cut bytes
// /log                     JSON list of the requests to /dl, /file, /login and /slow with their cookies and Referer; /log?clear empties it
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const TYPES = { pdf: 'application/pdf', zip: 'application/zip', jpg: 'image/jpeg', png: 'image/png', txt: 'text/plain', mp4: 'video/mp4',
    mp3: 'audio/mpeg', html: 'text/html; charset=utf-8' };

// a 1 x 1 PNG, so <img> tags on the pages render
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function start(port = 8378) {
    const log = [];
    const cutDone = new Set();

    const handler = (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const p = decodeURIComponent(url.pathname);
        const record = () => log.push({ path: p, query: url.search, cookie: req.headers.cookie || '', referer: req.headers.referer || '',
            range: req.headers.range || '' });

        if (p === '/favicon.ico') return res.writeHead(204).end();
        if (p === '/log') {
            if (url.searchParams.has('clear')) log.length = 0;
            return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(log));
        }
        if (p === '/set-cookies') {
            res.setHeader('set-cookie', ['plain=1; Path=/', 'lax=1; Path=/; SameSite=Lax', 'strict=1; Path=/; SameSite=Strict']);
            return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Cookies set</title><p>cookies set');
        }
        if (p.startsWith('/dl/')) {
            record();
            const name = url.searchParams.get('name') || 'Real Name.pdf';
            const ext = name.split('.').pop().toLowerCase();
            const body = Buffer.from(`file ${p} ${name}\n`.repeat(64));
            return res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': body.length,
                'content-disposition': `attachment; filename="${name}"` }).end(body);
        }
        if (p.startsWith('/file/')) {
            record();
            const name = p.slice(6);
            const ext = name.split('.').pop().toLowerCase();
            const body = ext === 'png' ? PNG : Buffer.from(`file ${name}\n`.repeat(64));
            return res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': body.length }).end(body);
        }
        if (p.startsWith('/login/')) {
            record();
            return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Sign in</title><form>Sign in</form>');
        }
        if (p.startsWith('/slow/')) {
            record();
            return slow(req, res, url, p, cutDone);
        }
        if (p === '/frames.html') {
            return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>Frames</title>
<a href="/file/top.pdf">Top file</a>
<iframe src="/frame-a.html"></iframe>
<iframe src="http://localhost:${port}/frame-b.html"></iframe>`);
        }
        if (p === '/title.html') {
            // the title is set from script so any character survives, including ones HTML would fold
            const title = JSON.stringify(url.searchParams.get('t') || '').replace(/</g, '\\u003c');
            return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>x</title>
<script>document.title = ${title};</script><a href="/dl/title-1?name=titled.pdf">Titled file</a>`);
        }
        if (p === '/many.html') {
            const n = Number(url.searchParams.get('n')) || 5000;
            const links = Array.from({ length: n }, (_, i) => `<a href="/dl/many-${i}?name=file-${i}.pdf">File ${i}</a>`).join('\n');
            return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>many</title>${links}`);
        }
        if (p === '/frame-a.html') {
            return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                .end('<!doctype html><title>A</title><a href="/file/same-origin.pdf">Same origin frame file</a>');
        }
        if (p === '/frame-b.html') {
            return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                .end('<!doctype html><title>B</title><a href="/file/cross-origin.pdf">Cross origin frame file</a>');
        }
        const file = path.join(__dirname, path.basename(p));
        if (p.endsWith('.html') && fs.existsSync(file)) {
            const html = fs.readFileSync(file, 'utf8').replaceAll('{{PORT}}', String(port));
            return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
        }
        res.writeHead(404).end();
    };

    const servers = ['127.0.0.1', '::1'].map(host => new Promise((resolve, reject) => {
        const s = http.createServer(handler);
        s.on('error', reject);
        s.listen(port, host, () => resolve(s));
    }));
    return Promise.allSettled(servers).then(results => {
        const up = results.filter(r => r.status === 'fulfilled').map(r => r.value);
        if (!up.length) throw results[0].reason;
        return { port, log, close: () => Promise.all(up.map(s => new Promise(r => { s.closeAllConnections(); s.close(r); }))) };
    });
}

function slow(req, res, url, p, cutDone) {
    const size = Number(url.searchParams.get('size')) || 1024 * 1024;
    const cut = Number(url.searchParams.get('cut')) || 0;
    const name = p.slice(6);
    const etag = `"${name}-${size}"`;
    let from = 0;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag, 'last-modified': 'Tue, 17 Nov 2026 10:00:00 GMT',
        'content-disposition': `attachment; filename="${name}"` };
    if (range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
        from = Number(range[1]);
        res.writeHead(206, { ...headers, 'content-length': size - from, 'content-range': `bytes ${from}-${size - 1}/${size}` });
    } else {
        res.writeHead(200, { ...headers, 'content-length': size });
    }
    const key = `${name}?${url.search}`;
    const breakAt = cut && !range && !cutDone.has(key) ? cut : 0;
    let sent = from;
    const timer = setInterval(() => {
        if (breakAt && sent >= breakAt) {
            cutDone.add(key);
            clearInterval(timer);
            res.socket.destroy();
            return;
        }
        const n = Math.min(16384, size - sent);
        res.write(Buffer.alloc(n, 120));
        sent += n;
        if (sent >= size) {
            clearInterval(timer);
            res.end();
        }
    }, 50);
    res.on('close', () => clearInterval(timer));
}

module.exports = { start };

if (require.main === module) {
    const port = Number(process.argv[2]) || 8378;
    start(port).then(() => console.log(`File Downloader playground: http://127.0.0.1:${port}/basic.html  (log: /log)`));
}
