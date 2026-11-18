// Loads the unpacked extension into a throw-away Chromium profile and drives the real thing against the playground server: the toolbar click (through
// CDP Extensions.triggerAction, which grants activeTab like a click), the panel window, the queue and the files on disk.
//
// Usage: npm run test:e2e
// Needs a full Chromium (not headless_shell): CHROMIUM=<chrome.exe>, else the newest under %LOCALAPPDATA%\ms-playwright.
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { start } = require('./playground/serve.cjs');

const EXT = path.resolve(__dirname, '..', 'extension');
const HELPER = path.resolve(__dirname, 'helper-ext');
const PORT = 8388;
const WEB = `http://127.0.0.1:${PORT}`;
const MESSAGES = JSON.parse(fs.readFileSync(path.join(EXT, '_locales', 'en', 'messages.json'), 'utf8'));
const msg = (key, ...subs) => MESSAGES[key].message.replace(/\$(\d)/g, (_, n) => subs[n - 1]);

function findChromium() {
    if (process.env.CHROMIUM) return process.env.CHROMIUM;
    const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    const found = (fs.existsSync(root) ? fs.readdirSync(root) : [])
        .filter(d => /^chromium-\d+$/.test(d))
        .sort((a, b) => parseInt(b.slice(9)) - parseInt(a.slice(9)))
        .map(d => path.join(root, d, 'chrome-win64', 'chrome.exe'))
        .find(p => fs.existsSync(p));
    if (!found) throw new Error(`no Chromium under ${root}; set CHROMIUM to a chrome.exe`);
    return found;
}

const SHOTS = path.join(__dirname, '..', 'STATE', 'shots');

// a screenshot of the panel at its window size, for looking at the layout; STATE/ is git-ignored
async function shot(page, name) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width: 960, height: 760 });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let passed = 0;
const step = text => console.log(`ok ${++passed} - ${text}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// polls fn until test passes; returns the last value either way, the caller asserts on it
async function until(fn, test, ms = 10000) {
    let v = await fn();
    for (let t = 0; !test(v) && t < ms; t += 100) {
        await sleep(100);
        v = await fn();
    }
    return v;
}

const errors = [];

// Chromium's own pages (chrome://new-tab-page, opened by a browser started outside Playwright) log their own network errors; only the extension's
// pages and the playground pages are this test's business
const ownPage = page => !page.url().startsWith('chrome://');

function watchPage(page) {
    page.on('pageerror', e => {
        if (ownPage(page)) errors.push(`${page.url()}: uncaught ${e.message}`);
    });
    page.on('console', m => {
        if (m.type() === 'error' && ownPage(page)) errors.push(`${page.url()}: console error ${m.text()}`);
    });
}

// a profile whose downloads go to <profile>/dl without asking
function makeProfile() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-e2e-'));
    const downloads = path.join(profile, 'dl');
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'),
        JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
    return { profile, downloads };
}

// Starts Chromium itself and attaches over CDP. A browser Playwright launches has its downloads redirected to a temp folder under GUID names until
// CDP Browser.setDownloadBehavior is sent, and the extension's worker acts at browser start, before that could be sent (a download restarted by the
// session check landed there). Attached to a browser it did not launch, Playwright leaves downloads to Chrome and the profile, as in real use.
async function launch(profile) {
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    // the helper extension observes the download UI setting and disables or enables File Downloader (test/helper-ext)
    const proc = spawn(findChromium(), [`--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run',
        '--no-default-browser-check', '--lang=en-US', '--enable-unsafe-extension-debugging', `--disable-extensions-except=${EXT},${HELPER}`,
        `--load-extension=${EXT},${HELPER}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    // Chromium may still be writing the file (EBUSY on Windows): read again until it holds a port
    const readPort = () => {
        try {
            return fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
        } catch {
            return '';
        }
    };
    const port = await until(readPort, Boolean, 15000);
    if (!port) {
        proc.kill();
        assert.fail('Chromium did not open its debugging port');
    }
    // noDefaults: Playwright applies none of its own context settings (download redirection included) to the browser's default context
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const ctx = browser.contexts()[0];
    ctx.on('page', watchPage);
    ctx.pages().forEach(watchPage);
    const env = { ctx, browser, proc, sw: await workerNamed(ctx, 'File Downloader'), helper: await workerNamed(ctx, 'FD test helper') };
    env.extId = new URL(env.sw.url()).host;
    env.session = await browser.newBrowserCDPSession();
    // Browser.close shuts Chromium down the normal way (running downloads end interrupted, as when a person closes Chrome)
    env.close = async () => {
        const exited = new Promise(resolve => (proc.exitCode !== null ? resolve() : proc.once('exit', resolve)));
        await env.session.send('Browser.close').catch(() => {});
        await Promise.race([exited, sleep(10000)]);
        if (proc.exitCode === null) proc.kill();
        await browser.close().catch(() => {});
    };
    return env;
}

// the service worker of the extension with that name (File Downloader, or the test helper loaded beside it), waiting for it if needed
async function workerNamed(ctx, name) {
    const found = await until(async () => {
        for (const w of ctx.serviceWorkers()) {
            if (!w.url().startsWith('chrome-extension://')) continue;
            if (await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => '') === name) return w;
        }
        return null;
    }, Boolean, 15000);
    assert.ok(found, `no service worker for ${name}`);
    if (!found.__watched) {
        found.__watched = true;
        found.on('console', m => {
            // a queue step that calls a chrome API while the restart step closes the browser is refused with exactly this; the step's own
            // assertions check that nothing is lost
            if (m.type() === 'error' && !m.text().endsWith('Error: The browser is shutting down.')) errors.push(`${name} worker: ${m.text()}`);
        });
    }
    return found;
}

// true while File Downloader has Chrome's download UI switched off (the helper's attempt to switch it on is refused)
const uiHidden = env => env.helper.evaluate(() => globalThis.uiHidden());

// clicks the toolbar button on the tab showing url and returns the panel page
async function clickAction(env, url) {
    const target = (await env.session.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find(t => t.url === url);
    assert.ok(target, `no tab for ${url}`);
    // every click stores a new scan, so the panel is the page showing a ?scan= address that no page showed before
    const panelUrl = `chrome-extension://${env.extId}/panel/panel.html?scan=`;
    const seen = new Set(env.ctx.pages().map(p => p.url()));
    await env.session.send('Extensions.triggerAction', { id: env.extId, targetId: target.targetId });
    const panel = await until(() => env.ctx.pages().find(p => p.url().startsWith(panelUrl) && !seen.has(p.url())), Boolean);
    assert.ok(panel, 'the panel window did not open');
    // a reused panel window shows the new address a moment before the new document has drawn: wait for that document and its first drawing
    const shown = panel.url();
    await panel.waitForFunction(expected => location.href === expected && document.querySelector('#tabSelect').textContent !== ''
        && document.querySelector('#items tr, #emptyList:not([hidden]), #scanNote:not([hidden])'), shown);
    return panel;
}

const jobsIn = page => page.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith('job:'))
    .map(([, v]) => v).sort((a, b) => a.created - b.created));
const searchDownloads = (page, query = {}) => page.evaluate(q => chrome.downloads.search(q), query);
const log = async () => (await fetch(`${WEB}/log`)).json();

async function openSite(env, url) {
    const page = await env.ctx.newPage();
    await page.goto(url);
    await page.bringToFront();
    return page;
}

async function basicRun(env, downloads) {
    await openSite(env, `${WEB}/set-cookies`);
    const site = await openSite(env, `${WEB}/basic.html`);
    const panel = await clickAction(env, `${WEB}/basic.html`);

    const rows = await panel.$$eval('#items tr', trs => trs.map(tr => [...tr.cells].slice(1).map(td => td.textContent)));
    assert.deepStrictEqual(rows, [
        ['Bestiary PDF', `${WEB}/dl/20387641-cc4a-49a1-ac15-007d1f9458c2?from=Download%20Page`, '-', 'link'],
        ['Maps volume one', `${WEB}/dl/8c1f-22aa?from=Download%20Page&name=Maps%20Vol%201.zip`, '-', 'link'],
        ['Tokens', `${WEB}/dl/77ab-0001?from=Download%20Page&name=Tokens.zip`, '-', 'link'],
        ['Handout', `${WEB}/file/handout.pdf`, 'pdf', 'link'],
        ['Notes', `${WEB}/file/notes.txt`, 'txt', 'link'],
        ['Cover picture', `${WEB}/file/cover.png`, 'png', 'image'],
    ]);
    assert.strictEqual(await panel.textContent('#tabSelect'), msg('tab_select', 6));
    assert.match(await panel.textContent('#scanNote'), /mailto: 1/);
    step('the toolbar click opens the panel listing the page\'s links and image once each, with types, the mail link reported as left out');

    assert.strictEqual(await panel.isDisabled('#download'), true);
    await panel.click('#selectShown');
    assert.strictEqual(await panel.textContent('#counter'), msg('counter', 6, 6, 6));
    await panel.uncheck('#items tr:nth-child(6) .pick');
    assert.strictEqual(await panel.textContent('#download'), msg('download_n', 5));
    await panel.fill('#nameTpl', '{n:3} {name}');
    await panel.click('#download');
    await panel.waitForSelector('#viewDownloads:not([hidden])');
    step('Select shown ticks all six, unticking one leaves five, Download switches to the Downloads view');

    const jobs = await until(() => jobsIn(panel), js => js.length === 1 && js[0].items.every(i => i.state === 'done'));
    assert.deepStrictEqual(jobs[0].items.map(i => i.state), Array(5).fill('done'), JSON.stringify(jobs[0].items));
    const names = jobs[0].items.map(i => path.relative(downloads, i.filename));
    assert.deepStrictEqual(names, ['basic\\001 Real Name.pdf', 'basic\\002 Maps Vol 1.zip', 'basic\\003 Tokens.zip', 'basic\\004 handout.pdf',
        'basic\\005 notes.txt']);
    for (const i of jobs[0].items) assert.ok(fs.existsSync(i.filename), `missing ${i.filename}`);
    step('five files land in Downloads\\basic named by the rule "{n:3} {name}" with the server\'s names for the generated links');

    const requests = (await log()).filter(r => r.path.startsWith('/dl/') || r.path.startsWith('/file/'));
    assert.ok(requests.length >= 5);
    for (const r of requests.filter(r => r.path !== '/file/cover.png')) assert.match(r.cookie, /lax=1/, `${r.path} without the Lax cookie`);
    step('the downloads carry the site\'s Lax cookie');

    await until(() => panel.$$eval('#jobs li[data-state="done"]', lis => lis.length), n => n === 5);
    assert.strictEqual(await panel.textContent('#jobs .job-counts'), msg('job_counts', 5, 5));
    assert.strictEqual(await panel.textContent('#tabDownloads'), msg('tab_downloads'));
    const badge = await until(() => env.sw.evaluate(() => chrome.action.getBadgeText({})), b => b === '');
    assert.strictEqual(badge, '');
    step('the Downloads view shows the job with five done rows; no badge once nothing is left');

    const first = jobs[0].items[0];
    await env.sw.evaluate(id => chrome.downloads.erase({ id }), first.downloadId);
    await panel.click('#jobs .job:first-child li[data-item="0"] button[data-action="show"]');
    const status = await until(() => panel.textContent('#status'), text => text.includes(first.filename));
    assert.strictEqual(status, msg('show_gone', first.filename));
    const second = jobs[0].items[1];
    fs.rmSync(second.filename);
    // Chrome checks whether files still exist at most every 10 s, for all downloads at once (exists probe, 2026-11-18): wait until it knows
    await until(() => env.sw.evaluate(id => chrome.downloads.search({ id }).then(([d]) => d.exists), second.downloadId), exists => !exists, 15000);
    await panel.click('#jobs .job:first-child li[data-item="1"] button[data-action="show"]');
    const missing = await until(() => panel.textContent('#status'), text => text.includes(second.filename), 3000);
    assert.strictEqual(missing, msg('show_missing', second.filename));
    step('Show in folder says so on the first click when the download is gone from Chrome\'s list or its file was deleted');
    await site.close();
    return panel;
}

const rowTexts = page => page.$$eval('#items tr', trs => trs.map(tr => tr.cells[1].textContent));

async function selectRun(env) {
    const site = await openSite(env, `${WEB}/basic.html`);
    const panel = await clickAction(env, `${WEB}/basic.html`);
    assert.strictEqual(await panel.isHidden('#viewSelect'), false);

    await panel.fill('#fText', 'tok');
    assert.deepStrictEqual(await rowTexts(panel), ['Tokens']);
    await panel.fill('#fText', '');
    await panel.fill('#fUrl', 'download page');
    assert.deepStrictEqual(await rowTexts(panel), ['Bestiary PDF', 'Maps volume one', 'Tokens']);
    await panel.fill('#fUrl', '/dl/[0-9a-f]{8}-');
    await panel.check('#fUrlRe');
    assert.deepStrictEqual(await rowTexts(panel), ['Bestiary PDF']);
    step('text and address filters: substring (case-insensitive, also on the decoded address) and regular expression');

    await panel.fill('#fUrl', '(');
    assert.match(await panel.textContent('#fUrlError'), /Invalid regular expression/);
    assert.strictEqual(await panel.getAttribute('#fUrl', 'aria-invalid'), 'true');
    assert.deepStrictEqual(await rowTexts(panel), []);
    await panel.fill('#fUrl', '');
    assert.strictEqual(await panel.textContent('#fUrlError'), '');
    assert.strictEqual(await panel.getAttribute('#fUrl', 'aria-invalid'), null);
    await panel.uncheck('#fUrlRe');
    step('an invalid expression shows its error, marks the field and matches nothing; clearing it restores the list');

    const chips = await panel.$$eval('#chips button', bs => bs.map(b => b.textContent));
    assert.deepStrictEqual(chips, [`${msg('type_none')} 3`, 'pdf 1', 'png 1', 'txt 1']);
    await panel.click(`#chips button[data-ext=""]`);
    assert.deepStrictEqual(await rowTexts(panel), ['Bestiary PDF', 'Maps volume one', 'Tokens']);
    await panel.click('#chips button[data-ext="pdf"]');
    assert.strictEqual((await rowTexts(panel)).length, 4);
    await panel.click(`#chips button[data-ext=""]`);
    await panel.click('#chips button[data-ext="pdf"]');
    await panel.uncheck('#kLink');
    assert.deepStrictEqual(await rowTexts(panel), ['Cover picture']);
    await panel.check('#kLink');
    step('type chips (with "(none)" for generated links) and kind toggles narrow the list');

    await panel.click('#items tr:nth-child(1) td:nth-child(2)');
    await panel.click('#items tr:nth-child(4) .pick', { modifiers: ['Shift'] });
    assert.strictEqual(await panel.textContent('#counter'), msg('counter', 6, 6, 4));
    await panel.fill('#fText', 'notes');
    assert.strictEqual(await panel.textContent('#counter'), msg('counter', 1, 6, 4));
    await panel.fill('#fText', '');
    const preview = await panel.$$eval('#preview li', lis => lis.map(li => li.textContent));
    assert.deepStrictEqual(preview, [`basic/001 ${msg('server_name')}`, `basic/002 ${msg('server_name')}`, `basic/003 ${msg('server_name')}`]);
    // set by script: maxlength stops typing but not a pasted or script-filled value
    await panel.$eval('#nameTpl', input => {
        input.value = 'x'.repeat(201);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.strictEqual(await panel.textContent('#nameTplError'), msg('tpl_too_long', 200));
    assert.strictEqual(await panel.isDisabled('#download'), true);
    assert.strictEqual(await panel.isDisabled('#queue'), true);
    await panel.fill('#nameTpl', '{n:3} {name}');
    assert.strictEqual(await panel.textContent('#nameTplError'), '');
    assert.strictEqual(await panel.isDisabled('#download'), false);
    await panel.fill('#folderTpl', '{host}/{title}');
    assert.match(await panel.textContent('#preview li'), /^127\.0\.0\.1_8388\/basic\/001 /);
    await shot(panel, 'select');
    step('a row click ticks it, shift-click ticks the range, ticks survive a filter change, the preview follows the rule');
    await site.close();

    const many = await openSite(env, `${WEB}/many.html`);
    const t0 = Date.now();
    const big = await clickAction(env, `${WEB}/many.html`);
    const opened = Date.now() - t0;
    assert.strictEqual(await big.$$eval('#items tr', trs => trs.length), 1000);
    assert.strictEqual(await big.textContent('#capNotice'), msg('cap_notice', 1000, 5000));
    await big.click('#selectShown');
    assert.strictEqual(await big.textContent('#counter'), msg('counter', 5000, 5000, 5000));
    const t1 = Date.now();
    await big.fill('#fText', 'file 49');
    const filtered = Date.now() - t1;
    assert.strictEqual(await big.isHidden('#capNotice'), true);
    assert.strictEqual(await big.$$eval('#items tr', trs => trs.length), 111);
    assert.ok(opened < 8000 && filtered < 2000, `slow: opened ${opened} ms, filtered ${filtered} ms`);
    step(`5000 links: 1000 rows with the cap notice, Select shown ticks all 5000, filtering is quick (opened ${opened} ms, filtered ${filtered} ms)`);
    await many.close();
}

const states = async page => (await jobsIn(page)).at(-1).items.map(i => i.state);
const rowButton = (n, action) => `#jobs .job:first-child li[data-item="${n}"] button[data-action="${action}"]`;

async function trackRun(env) {
    const site = await openSite(env, `${WEB}/track.html`);
    const panel = await clickAction(env, `${WEB}/track.html`);
    await panel.fill('#selParallel', '0');
    await panel.press('#selParallel', 'Enter');
    assert.strictEqual(await panel.textContent('#selParallelError'), msg('setting_range', 1, 10));
    assert.strictEqual(await panel.getAttribute('#selParallel', 'aria-invalid'), 'true');
    await panel.click('#selectShown');
    assert.strictEqual(await panel.isDisabled('#download'), true);
    // the stored value changes elsewhere (the Downloads view, another window): the rejected field takes it and Download is on again
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'settings', patch: { parallel: 2 } }));
    assert.strictEqual(await until(() => panel.inputValue('#selParallel'), v => v === '2'), '2');
    assert.strictEqual(await until(() => panel.isDisabled('#download'), d => !d), false);
    assert.strictEqual(await panel.textContent('#selParallelError'), '');
    await panel.click('#clearSelection');
    await panel.fill('#selParallel', '1');
    await panel.press('#selParallel', 'Enter');
    const stored = await until(() => panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings.parallel), v => v === 1);
    assert.strictEqual(stored, 1);
    assert.strictEqual(await panel.textContent('#selParallelError'), '');
    await panel.click('#tabDownloads');
    assert.strictEqual(await until(() => panel.inputValue('#parallel'), v => v === '1'), '1');
    step('"Downloads at once" on the Select view rejects 0 with a message (Download stays off), stores 1, and the Downloads view shows 1');

    await panel.click('#tabSelect');
    await panel.fill('#nameTpl', '{name}');
    await panel.click('#selectShown');
    await panel.click('#download');
    await panel.waitForSelector('#viewDownloads:not([hidden])');
    // download() is called outside the queue's chain now, so the row is "starting" until the server's headers arrive
    const first = await until(() => states(panel), v => v[0] === 'active');
    assert.deepStrictEqual(first, ['active', 'queued', 'queued', 'queued', 'queued']);
    await panel.waitForSelector('#jobs .job:first-child li[data-item="0"] progress');
    assert.match(await panel.textContent('#jobs .job:first-child li[data-item="0"] .item-bytes'), / of 1\.4 MB$/);
    assert.strictEqual(await uiHidden(env), true);
    step('with one download at once only the first file runs; its row shows a progress bar and bytes; Chrome\'s download bubble is off');

    // watch the waiting last row and the job's Cancel all button: a redraw must neither rebuild nor move them, since a node taken out of the page
    // between mouse press and release gets no click (review probe, 2026-11-18); a moved node is the same object, so removals are counted
    await panel.evaluate(() => {
        const row = document.querySelector('#jobs .job:first-child li[data-item="4"]');
        const button = document.querySelector('#jobs .job:first-child button[data-job-action="cancelAll"]');
        window.__taken = [];
        new MutationObserver(records => {
            for (const r of records) {
                for (const node of r.removedNodes) {
                    if (node === row || node.contains?.(row)) window.__taken.push('row 4');
                    if (node === button || node.contains?.(button)) window.__taken.push('Cancel all');
                }
            }
        }).observe(document.querySelector('#jobs'), { childList: true, subtree: true });
    });
    await panel.click(rowButton(0, 'pause'));
    await until(() => states(panel), s => s[0] === 'paused');
    await panel.waitForSelector(rowButton(0, 'resume'));
    assert.strictEqual(await panel.evaluate(() => document.activeElement?.closest('li')?.dataset.item ?? null), '0',
        'keyboard focus left the row whose Pause was clicked');
    const [big] = await searchDownloads(panel, { url: `${WEB}/slow/big.bin?size=1500000` });
    assert.strictEqual(big.paused, true);
    await panel.waitForSelector(rowButton(0, 'resume'));
    await panel.waitForSelector('#jobs .job:first-child li[data-item="1"] progress');
    await shot(panel, 'downloads');
    let s = await until(() => states(panel), v => v[1] === 'done' && v[2] === 'done' && v[3] === 'active', 20000);
    assert.deepStrictEqual(s, ['paused', 'done', 'done', 'active', 'queued']);
    const jobs = await jobsIn(panel);
    assert.strictEqual(fs.statSync(jobs.at(-1).items[1].filename).size, 400000);
    assert.strictEqual(jobs.at(-1).items[2].mime, 'text/html', JSON.stringify(jobs.at(-1).items[2]));
    await panel.waitForSelector('#jobs .job:first-child li[data-item="2"] .item-warning', { timeout: 3000 });
    assert.strictEqual(await panel.$('#jobs .job:first-child li[data-item="1"] .item-warning'), null);
    assert.deepStrictEqual(await panel.evaluate(() => window.__taken), [], 'a redraw took an unchanged row or a job button out of the page');
    step('pausing frees the slot; the broken connection is resumed by Chrome and ends with all 400000 bytes; the sign-in page gets the warning; '
        + 'redraws never take an unchanged row or a job button out of the page');

    await panel.click(rowButton(3, 'cancel'));
    s = await until(() => states(panel), v => v[3] === 'canceled' && v[4] === 'done', 20000);
    assert.deepStrictEqual(s, ['paused', 'done', 'done', 'canceled', 'done']);
    await panel.click(rowButton(0, 'resume'));
    s = await until(() => states(panel), v => v[0] === 'done', 20000);
    assert.deepStrictEqual(s, ['done', 'done', 'done', 'canceled', 'done']);
    assert.strictEqual(fs.statSync((await jobsIn(panel)).at(-1).items[0].filename).size, 1500000);
    assert.strictEqual(await until(() => uiHidden(env), hidden => !hidden), false);
    step('cancel moves the queue on; resuming the paused file finishes it with the right size; with nothing left, Chrome\'s bubble is back');

    await panel.click('#jobs .job:first-child button[data-job-action="clearFinished"]');
    const left = await until(() => jobsIn(panel), js => js.length === 1);
    assert.deepStrictEqual(left.map(j => j.pageTitle), ['basic']);
    await until(() => panel.$$eval('#jobs .job', els => els.length), n => n === 1);
    step('Clear finished removes done and canceled rows (the job disappears when empty)');
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'settings', patch: { parallel: 3 } }));
    await site.close();
}

const badgeOf = env => env.sw.evaluate(() => chrome.action.getBadgeText({}));

async function queueRun(env) {
    const site = await openSite(env, `${WEB}/basic.html`);
    const panel = await clickAction(env, `${WEB}/basic.html`);
    await fetch(`${WEB}/log?clear`);
    await panel.fill('#folderTpl', 'queued');
    await panel.fill('#nameTpl', '{name}');
    for (const text of ['Handout', 'Notes']) await panel.click(`#items tr:has(td:text-is("${text}")) .pick`);
    assert.strictEqual(await panel.textContent('#queue'), msg('queue_n', 2));
    const before = new Set((await jobsIn(panel)).map(j => j.id));
    await panel.click('#queue');
    const jobs = await until(() => jobsIn(panel), js => js.some(j => !before.has(j.id)));
    const jobId = jobs.find(j => !before.has(j.id)).id;
    assert.strictEqual(await panel.isHidden('#viewSelect'), false);
    assert.deepStrictEqual((await jobById(panel, jobId)).items.map(i => i.state), ['paused', 'paused']);
    await sleep(500);
    assert.deepStrictEqual((await log()).filter(r => r.path.startsWith('/file/')), []);
    assert.strictEqual(await until(() => badgeOf(env), b => b === '2'), '2');
    assert.strictEqual(await uiHidden(env), false);
    step('Queue adds the ticked files without starting them: the Select view stays, nothing is requested, the badge shows 2, Chrome\'s bubble stays');

    await panel.click('#tabDownloads');
    const job = `#jobs [data-job="${jobId}"]`;
    await panel.waitForSelector(`${job} li[data-item="0"] button[data-action="start"]`);
    assert.strictEqual(await panel.textContent(`${job} li[data-item="0"] .item-state`), msg('state_notStarted'));
    assert.strictEqual(await panel.textContent(`${job} button[data-job-action="resumeAll"]`), msg('job_startAll'));
    await panel.click(`${job} li[data-item="0"] button[data-action="start"]`);
    let states = await until(async () => (await jobById(panel, jobId)).items.map(i => i.state), s => s[0] === 'done');
    assert.deepStrictEqual(states, ['done', 'paused']);
    step('a not-started row says so and offers Start; the job offers "Start all"; Start runs only that file');

    await panel.click('#allStart');
    states = await until(async () => (await jobById(panel, jobId)).items.map(i => i.state), s => s[1] === 'done');
    assert.deepStrictEqual(states, ['done', 'done']);
    assert.strictEqual(await until(() => badgeOf(env), b => b === ''), '');
    assert.strictEqual(await until(() => panel.isDisabled('#allStart'), Boolean), true);
    step('"Start everything" starts the rest; the badge clears when nothing is left');
    await site.close();
}

// ticks the rows whose link text matches and downloads them into the folder template given
async function downloadRows(panel, texts, folderTpl, nameTpl = '{name}') {
    await panel.click('#tabSelect');
    await panel.click('#clearSelection');
    await panel.fill('#fText', '');
    for (const text of texts) await panel.click(`#items tr:has(td:text-is("${text}")) .pick`);
    await panel.fill('#folderTpl', folderTpl);
    await panel.fill('#nameTpl', nameTpl);
    const before = new Set((await jobsIn(panel)).map(j => j.id));
    await panel.click('#download');
    await panel.waitForSelector('#viewDownloads:not([hidden])');
    // the worker writes a new job up to 200 ms later
    const jobs = await until(() => jobsIn(panel), js => js.some(j => !before.has(j.id)));
    return jobs.find(j => !before.has(j.id)).id;
}

const jobById = async (page, id) => (await jobsIn(page)).find(j => j.id === id);

// holder.env is replaced by the relaunched browser, so the caller closes the right one whatever fails
async function edgeRun(holder, profile, downloads) {
    let { env } = holder;
    let site = await openSite(env, `${WEB}/more.html`);
    let panel = await clickAction(env, `${WEB}/more.html`);
    assert.ok((await panel.$$eval('#items tr', trs => trs.map(tr => `${tr.cells[1].textContent} ${tr.cells[2].textContent}`)))
        .includes(`SVG link ${WEB}/file/vector.pdf`), 'the SVG link is missing');
    let jobId = await downloadRows(panel, ['Same name one', 'Same name two'], '{title}');
    let job = await until(() => jobById(panel, jobId), j => j.items.every(i => i.state === 'done'));
    assert.deepStrictEqual(job.items.map(i => path.relative(downloads, i.filename)).sort(), ['more\\same (1).pdf', 'more\\same.pdf']);
    step('a link inside SVG is listed; two links with the same server name both arrive: same.pdf and same (1).pdf');

    await panel.click('#tabSelect');
    await panel.selectOption('#conflict', 'overwrite');
    jobId = await downloadRows(panel, ['Same name one', 'Same name two'], 'ovr');
    job = await until(() => jobById(panel, jobId), j => j.items.every(i => i.state === 'done'));
    assert.deepStrictEqual(job.items.map(i => path.relative(downloads, i.filename)).sort(), ['ovr\\same (1).pdf', 'ovr\\same.pdf']);
    assert.deepStrictEqual(fs.readdirSync(path.join(downloads, 'ovr')).sort(), ['same (1).pdf', 'same.pdf']);
    jobId = await downloadRows(panel, ['Same name one'], 'ovr');
    job = await until(() => jobById(panel, jobId), j => j.items.every(i => i.state === 'done'));
    assert.strictEqual(path.relative(downloads, job.items[0].filename), 'ovr\\same.pdf');
    assert.deepStrictEqual(fs.readdirSync(path.join(downloads, 'ovr')).sort(), ['same (1).pdf', 'same.pdf']);
    await panel.click('#tabSelect');
    await panel.selectOption('#conflict', 'uniquify');
    step('"Replace it" numbers names that collide inside one batch, and replaces only files from an earlier batch');

    jobId = await downloadRows(panel, ['Erased', 'Restart two'], 'erase');
    const erased = await until(() => jobById(panel, jobId), j => j.items[0].state === 'active' && j.items[0].downloadId);
    await env.sw.evaluate(id => chrome.downloads.erase({ id }), erased.items[0].downloadId);
    job = await until(() => jobById(panel, jobId), j => j.items[0].state === 'canceled' && j.items[1].state === 'done');
    assert.deepStrictEqual(job.items.map(i => i.state), ['canceled', 'done']);
    step('a download erased from Chrome\'s list shows as canceled and the queue moves on');

    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'settings', patch: { parallel: 1 } }));
    jobId = await downloadRows(panel, ['Restart one', 'Restart two', 'Restart three'], 'restart');
    await until(() => jobById(panel, jobId), j => j.items[0].state === 'active');
    await panel.click(`#jobs [data-job="${jobId}"] li[data-item="2"] button[data-action="pause"]`);
    await until(() => jobById(panel, jobId), j => j.items[2].state === 'paused');
    await sleep(800);
    await fetch(`${WEB}/log?clear`);
    await env.close();
    env = holder.env = await launch(profile);
    const viewer = await env.ctx.newPage();
    await viewer.goto(`chrome-extension://${env.extId}/panel/panel.html`);
    // Chrome forgets the bubble setting when it restarts (probe P1): the new worker switches it off again while the restarted file runs
    await until(() => jobById(viewer, jobId), j => j?.items[0].state === 'active');
    assert.strictEqual(await uiHidden(env), true, 'Chrome\'s download bubble is on while a file runs after the restart');
    job = await until(() => jobById(viewer, jobId), j => j && j.items[0].state === 'done' && j.items[1].state === 'done', 30000);
    assert.deepStrictEqual(job.items.map(i => i.state), ['done', 'done', 'paused'], JSON.stringify(job.items));
    assert.deepStrictEqual(fs.readdirSync(path.join(downloads, 'restart')).sort(), ['r1.bin', 'r2.bin'],
        JSON.stringify(job.items.map(i => [i.state, i.filename, i.target, i.downloadId])));
    assert.deepStrictEqual((await log()).filter(r => r.path === '/slow/r3.bin'), []);
    // only the paused row is left: the new worker's session check puts it on the badge although storage did not change
    assert.strictEqual(await until(() => badgeOf(env), b => b === '1'), '1');
    await viewer.click('#tabDownloads');
    // paused while it was still waiting, so it never had a download: the row offers Start
    await viewer.click(`#jobs [data-job="${jobId}"] li[data-item="2"] button[data-action="start"]`);
    job = await until(() => jobById(viewer, jobId), j => j.items[2].state === 'done', 20000);
    assert.strictEqual(job.items[2].state, 'done');
    const files = fs.readdirSync(path.join(downloads, 'restart')).sort();
    assert.deepStrictEqual(files, ['r1.bin', 'r2.bin', 'r3.bin']);
    assert.strictEqual(fs.statSync(path.join(downloads, 'restart', 'r1.bin')).size, 2500000);
    const requested = (await log()).map(r => r.path);
    assert.deepStrictEqual(requested.filter(p => p === '/slow/r2.bin'), ['/slow/r2.bin']);
    assert.deepStrictEqual(requested.filter(p => p === '/slow/r3.bin'), ['/slow/r3.bin']);
    step('after a browser restart mid-batch the queue continues: the interrupted file starts again, the rest once each, no duplicates; a row '
        + 'paused before the restart stays paused until Resume; Chrome\'s bubble is off again while the restarted file runs');
    await viewer.evaluate(() => chrome.runtime.sendMessage({ type: 'settings', patch: { parallel: 3 } }));

    // disable File Downloader while one of its files downloads, let the file finish, enable it again: the worker starts without onInstalled or
    // onStartup (probe P4) and its session check marks the row done
    site = await openSite(env, `${WEB}/more.html`);
    panel = await clickAction(env, `${WEB}/more.html`);
    jobId = await downloadRows(panel, ['Erased'], 'disable');
    await until(() => jobById(panel, jobId), j => j.items[0].state === 'active');
    await env.helper.evaluate(id => globalThis.setEnabled(id, false), env.extId);
    const finishedMeanwhile = await until(() => env.helper.evaluate(u => chrome.downloads.search({ url: u }).then(d => d.map(x => x.state)),
        `${WEB}/slow/e1.bin?size=3000000`), states => states.includes('complete'), 30000);
    assert.ok(finishedMeanwhile.includes('complete'), JSON.stringify(finishedMeanwhile));
    await env.helper.evaluate(id => globalThis.setEnabled(id, true), env.extId);
    env.sw = await workerNamed(env.ctx, 'File Downloader');
    const afterEnable = await env.ctx.newPage();
    await afterEnable.goto(`chrome-extension://${env.extId}/panel/panel.html`);
    job = await until(() => jobById(afterEnable, jobId), j => j?.items[0].state === 'done', 15000);
    assert.strictEqual(job.items[0].state, 'done');
    assert.ok(fs.existsSync(path.join(downloads, 'disable', 'e1.bin')));
    step('a file that finishes while the extension is disabled is marked done when it is enabled again');
    await afterEnable.close();
    await site.close().catch(() => {});

    const title = 'Zero\u200BWidth ~ Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}~';
    const titleUrl = `${WEB}/title.html?t=${encodeURIComponent(title)}`;
    site = await openSite(env, titleUrl);
    panel = await clickAction(env, titleUrl);
    jobId = await downloadRows(panel, ['Titled file'], '{title}');
    job = await until(() => jobById(panel, jobId), j => j.items[0].state === 'done');
    assert.strictEqual(path.relative(downloads, job.items[0].filename), 'ZeroWidth ~ Family \u{1F468}\u{1F469}\u{1F467}\\titled.pdf');
    step('a page title with a zero width space, a joined emoji and edge tildes still gives the folder (Chrome rejected the raw name)');
    await site.close();

    // three folders of a 110-character title plus a long name: far over Chrome's 243-character absolute limit, which ended canceled before
    const longTitle = `Long ${'title '.repeat(18)}end`.slice(0, 110);
    const longUrl = `${WEB}/title.html?t=${encodeURIComponent(longTitle)}`;
    site = await openSite(env, longUrl);
    panel = await clickAction(env, longUrl);
    jobId = await downloadRows(panel, ['Titled file'], '{title}/{title}/{title}', '{title} {name}');
    job = await until(() => jobById(panel, jobId), j => ['done', 'failed', 'canceled'].includes(j.items[0].state), 15000);
    assert.strictEqual(job.items[0].state, 'done', JSON.stringify(job.items[0]));
    const relative = path.relative(downloads, job.items[0].filename);
    assert.strictEqual(relative.split('\\').length, 4, relative);
    assert.ok(relative.length <= 243 - downloads.length - 1 - 8, `${relative.length} characters: ${relative}`);
    assert.ok(relative.endsWith('.pdf') && fs.existsSync(job.items[0].filename));
    step('a path far over Chrome\'s limit is shortened to fit the learned Downloads folder and saved in its three folders');
    await site.close();

    site = await openSite(env, 'chrome://version/');
    panel = await clickAction(env, 'chrome://version/');
    assert.match(await panel.textContent('#scanNote'), new RegExp(`^${msg('scan_error', '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.+`));
    assert.strictEqual(await panel.isVisible('#emptyList'), true);
    step('a chrome:// page opens the panel with the reason it cannot be read, not a blank list');
    await site.close();

    site = await openSite(env, `${WEB}/frames.html`);
    await site.waitForLoadState('load');
    panel = await clickAction(env, `${WEB}/frames.html`);
    assert.deepStrictEqual(await rowTexts(panel), ['Top file', 'Same origin frame file'],
        `note: ${await panel.textContent('#scanNote')}; url: ${panel.url()}; tab: ${await panel.textContent('#tabSelect')}`);
    assert.strictEqual(await panel.textContent('#scanNote'), msg('note_unread', 1));
    step('frames: links of the page and its same-origin frame are listed, the cross-origin frame is reported as unread');
    await site.close();
}

(async () => {
    const server = await start(PORT);
    const { profile, downloads } = makeProfile();
    const holder = {};
    try {
        const env = holder.env = await launch(profile);
        step('the extension loads');
        await basicRun(env, downloads);
        await selectRun(env);
        await trackRun(env);
        await queueRun(env);
        await edgeRun(holder, profile, downloads);
        assert.deepStrictEqual(errors, [], errors.join('\n'));
        step('no uncaught errors or console errors in pages or the worker');
        console.log(`\nall ${passed} steps passed`);
    } catch (e) {
        console.error(`\nnot ok ${passed + 1} - ${e.stack}`);
        if (errors.length) console.error(`\nerrors seen:\n${errors.join('\n')}`);
        process.exitCode = 1;
    } finally {
        await holder.env?.close().catch(() => {});
        await server.close();
        try {
            fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
        } catch (e) {
            console.warn(`the test profile could not be removed: ${e.message}`);
        }
    }
})();
