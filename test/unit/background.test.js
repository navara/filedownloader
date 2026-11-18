import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, importFresh, EXT_ID } from './fake-chrome.js';

const scans = chrome => Object.entries(chrome.storage.session.data).filter(([k]) => k.startsWith('scan:')).map(([k, v]) => [k.slice(5), v]);

test('every listener is registered when the module is evaluated', async () => {
    const chrome = installChrome();
    await importFresh('background.js');
    for (const ev of [chrome.action.onClicked, chrome.runtime.onMessage, chrome.runtime.onStartup, chrome.runtime.onInstalled,
        chrome.downloads.onDeterminingFilename, chrome.downloads.onChanged, chrome.downloads.onErased, chrome.storage.onChanged]) {
        assert.equal(ev.listeners.length, 1);
    }
});

test('a toolbar click scans all frames, stores the merged scan and opens the panel on it', async () => {
    const chrome = installChrome();
    chrome.scripting.result = [
        { frameId: 5, result: { frameUrl: 'https://x.test/f', title: 'F', items: [{ url: 'https://x.test/b.pdf', text: 'B', kind: 'link' }], skipped: {} } },
        { frameId: 0, result: { frameUrl: 'https://x.test/', title: 'Top', items: [{ url: 'https://x.test/a.pdf', text: 'A', kind: 'link' }], skipped: {},
            childFrames: 2 } },
    ];
    await importFresh('background.js');
    await chrome.action.onClicked.listeners[0]({ id: 7, url: 'https://x.test/', title: 'Top' });
    assert.deepEqual(chrome.scripting.calls[0], { target: { tabId: 7, allFrames: true }, files: ['scan.js'] });
    const [[id, scan]] = scans(chrome);
    assert.equal(scan.title, 'Top');
    assert.deepEqual(scan.items.map(i => i.url), ['https://x.test/a.pdf', 'https://x.test/b.pdf']);
    assert.equal(scan.unreadFrames, 1);
    assert.deepEqual(chrome.windows.calls[0], ['create', { url: `chrome-extension://${EXT_ID}/panel/panel.html?scan=${id}`, type: 'popup', width: 960,
        height: 760 }]);
    assert.equal(chrome.storage.session.data.panelWindowId, 100);
});

test('a page that cannot be scanned still opens the panel, with the error stored', async () => {
    const chrome = installChrome();
    chrome.scripting.result = new Error('Cannot access a chrome:// URL');
    await importFresh('background.js');
    await chrome.action.onClicked.listeners[0]({ id: 1, url: 'chrome://settings/', title: 'Settings' });
    const [[, scan]] = scans(chrome);
    assert.equal(scan.error, 'Cannot access a chrome:// URL');
    assert.deepEqual(scan.items, []);
    assert.equal(scan.pageUrl, 'chrome://settings/');
    assert.equal(chrome.windows.calls.length, 1);
});

test('a page that returns nothing is stored with a code for the panel to translate, not an English sentence', async () => {
    const chrome = installChrome();
    chrome.scripting.result = [{ frameId: 0, result: null }];
    await importFresh('background.js');
    await chrome.action.onClicked.listeners[0]({ id: 1, url: 'https://x.test/', title: 'T' });
    const [[, scan]] = scans(chrome);
    assert.equal(scan.errorCode, 'nothing');
    assert.equal(scan.error, undefined);
});

// Chrome now and then answers executeScript at once with no frames at all, although the page is loaded; a moment later the same call works
// (frames probe, 2026-11-18: 2 of 64 toolbar clicks)
test('an empty frame list from executeScript is retried before the panel opens', async () => {
    const chrome = installChrome();
    const frame = { frameId: 0, result: { frameUrl: 'https://x.test/', title: 'T', items: [{ url: 'https://x.test/a', text: 'A', kind: 'link' }],
        skipped: {} } };
    chrome.scripting.sequence = [[], [frame]];
    await importFresh('background.js');
    await chrome.action.onClicked.listeners[0]({ id: 1, url: 'https://x.test/', title: 'T' });
    const [[, scan]] = scans(chrome);
    assert.equal(chrome.scripting.calls.length, 2);
    assert.deepEqual(scan.items.map(i => i.url), ['https://x.test/a']);
    assert.equal(scan.errorCode, undefined);
});

test('a frame list that stays empty ends as "nothing" after a few tries', async () => {
    const chrome = installChrome();
    chrome.scripting.result = [];
    await importFresh('background.js');
    await chrome.action.onClicked.listeners[0]({ id: 1, url: 'https://x.test/', title: 'T' });
    const [[, scan]] = scans(chrome);
    assert.equal(chrome.scripting.calls.length, 4);
    assert.equal(scan.errorCode, 'nothing');
});

test('a scan that does not fit is stored after the older scans are dropped', async () => {
    const chrome = installChrome({ session: { 'scan:old1': { created: 1, items: [] }, 'scan:old2': { created: 2, items: [] } } });
    chrome.scripting.result = [{ frameId: 0, result: { frameUrl: 'https://x.test/', title: 'T', items: [{ url: 'https://x.test/a', text: 'A',
        kind: 'link' }], skipped: {} } }];
    const set = chrome.storage.session.set.bind(chrome.storage.session);
    let refused = false;
    chrome.storage.session.set = async items => {
        if (!refused && Object.keys(items).some(k => k.startsWith('scan:'))) {
            refused = true;
            throw new Error('Session storage quota bytes exceeded.');
        }
        return set(items);
    };
    await importFresh('background.js');
    await chrome.action.onClicked.listeners[0]({ id: 1, url: 'https://x.test/', title: 'T' });
    const stored = scans(chrome);
    assert.equal(stored.length, 1);
    assert.equal(stored[0][1].items.length, 1);
    assert.equal(chrome.windows.calls.filter(c => c[0] === 'create').length, 1);
});

test('when no scan can be stored the panel still opens and says why', async () => {
    const chrome = installChrome();
    chrome.scripting.result = [{ frameId: 0, result: { frameUrl: 'https://x.test/', title: 'T', items: [], skipped: {} } }];
    const set = chrome.storage.session.set.bind(chrome.storage.session);
    chrome.storage.session.set = async items => {
        const scan = Object.entries(items).find(([k]) => k.startsWith('scan:'));
        if (scan && scan[1].errorCode !== 'too_big') throw new Error('Session storage quota bytes exceeded.');
        return set(items);
    };
    await importFresh('background.js');
    await chrome.action.onClicked.listeners[0]({ id: 1, url: 'https://x.test/', title: 'T' });
    const [[, scan]] = scans(chrome);
    assert.equal(scan.errorCode, 'too_big');
    assert.equal(chrome.windows.calls.filter(c => c[0] === 'create').length, 1);
});

test('a second click reuses the open panel window and keeps at most five scans', async () => {
    const chrome = installChrome();
    chrome.scripting.result = [{ frameId: 0, result: { frameUrl: 'https://x.test/', title: 'T', items: [], skipped: {} } }];
    await importFresh('background.js');
    for (let i = 0; i < 7; i++) {
        await chrome.action.onClicked.listeners[0]({ id: 1, url: 'https://x.test/', title: 'T' });
        await new Promise(r => setTimeout(r, 2));
    }
    assert.equal(chrome.windows.calls.filter(c => c[0] === 'create').length, 1);
    assert.equal(chrome.windows.calls.filter(c => c[0] === 'update').length, 6);
    assert.equal(scans(chrome).length, 5);
    chrome.windows.open.clear();
    await chrome.action.onClicked.listeners[0]({ id: 1, url: 'https://x.test/', title: 'T' });
    assert.equal(chrome.windows.calls.filter(c => c[0] === 'create').length, 2);
});

test('onDeterminingFilename leaves foreign downloads alone and renames own ones asynchronously', async () => {
    const chrome = installChrome();
    await importFresh('background.js');
    const listener = chrome.downloads.onDeterminingFilename.listeners[0];
    let suggested = 'not called';
    assert.equal(listener({ id: 1, byExtensionId: 'other', filename: 'x.zip' }, s => { suggested = s; }), false);
    assert.equal(suggested, 'not called');
    const reply = new Promise(resolve => {
        assert.equal(listener({ id: 1, byExtensionId: EXT_ID, url: 'https://x.test/unknown', filename: 'x.zip' }, resolve), true);
    });
    assert.equal(await reply, undefined);
});

test('a queue write that fails after a download event is logged, not swallowed', async () => {
    const chrome = installChrome({ local: { 'job:j': { id: 'j', created: 1, pageUrl: '', pageTitle: '', folderTpl: '', nameTpl: '{name}',
        conflict: 'uniquify', held: false, items: [{ id: '0', n: 1, url: 'https://x.test/a', text: '', state: 'active', downloadId: 4, attempts: 0,
            error: '', filename: '', mime: '', target: '', startedAt: 1 }] } } });
    chrome.downloads.items.set(4, { id: 4, state: 'complete', filename: 'C:\\a', mime: '' });
    chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.map(String).join(' '));
    try {
        await importFresh('background.js');
        await chrome.downloads.onChanged.listeners[0]({ id: 4, state: { current: 'complete' } });
        // the queue writes changed jobs a moment later; settled() makes that write happen now
        await (await import('../../extension/lib/queue.js')).settled();
    } finally {
        console.error = original;
    }
    assert.ok(logged.some(line => line.includes('QUOTA_BYTES quota exceeded')), JSON.stringify(logged));
});

test('the badge counts unfinished files: blue while something runs, grey when only paused or not-started files remain', async () => {
    const chrome = installChrome();
    await importFresh('background.js');
    const ask = message => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, {}, resolve));
    const changed = () => chrome.storage.onChanged.listeners[0]({ 'job:x': {} }, 'local');
    await ask({ type: 'enqueue', pageUrl: 'https://x.test/', pageTitle: 'X', items: [{ url: 'https://x.test/a', text: 'A' }, { url: 'https://x.test/b',
        text: 'B' }], folderTpl: '', nameTpl: '{name}', conflict: 'uniquify', start: false });
    changed();
    await new Promise(r => setTimeout(r, 260));
    assert.deepEqual([chrome.action.badge.text, chrome.action.badge.color], ['2', '#6b6b6b']);
    const jobId = Object.values(chrome.storage.local.data).find(v => v.items).id;
    await ask({ type: 'job', jobId, action: 'resumeAll' });
    changed();
    await new Promise(r => setTimeout(r, 260));
    assert.deepEqual([chrome.action.badge.text, chrome.action.badge.color], ['2', '#1d5fa3']);
});

test('a worker that starts with only paused files left shows them on the badge', async () => {
    const chrome = installChrome({ local: { 'job:j': { id: 'j', created: 1, pageUrl: '', pageTitle: '', folderTpl: '', nameTpl: '{name}',
        conflict: 'uniquify', targets: [], items: [{ id: '0', n: 1, url: 'https://x.test/a', text: '', state: 'paused', downloadId: null, attempts: 0,
            error: '', filename: '', mime: '', target: '', startedAt: 0, launch: 0 }] } } });
    await importFresh('background.js');
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual([chrome.action.badge.text, chrome.action.badge.color], ['1', '#6b6b6b']);
    assert.deepEqual(chrome.downloads.started(), []);
});

test('enqueue refuses a template that is too long instead of using the stored one', async () => {
    const chrome = installChrome();
    await importFresh('background.js');
    const ask = message => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, {}, resolve));
    const reply = await ask({ type: 'enqueue', pageUrl: 'https://x.test/', pageTitle: 'X', items: [{ url: 'https://x.test/a', text: 'A' }],
        folderTpl: '', nameTpl: 'x'.repeat(201), conflict: 'uniquify' });
    assert.deepEqual(reply, { ok: false, error: 'tpl_too_long' });
    await (await import('../../extension/lib/queue.js')).settled();
    assert.deepEqual(chrome.downloads.started(), []);
    assert.equal(Object.keys(chrome.storage.local.data).some(k => k.startsWith('job:')), false);
});

test('enqueue stores the limits it carries before anything starts', async () => {
    const chrome = installChrome();
    await importFresh('background.js');
    const ask = message => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, {}, resolve));
    const items = ['a', 'b', 'c'].map(x => ({ url: `https://x.test/${x}`, text: x }));
    const reply = await ask({ type: 'enqueue', pageUrl: 'https://x.test/', pageTitle: 'X', items, folderTpl: '', nameTpl: '{name}',
        conflict: 'uniquify', parallel: 1, retries: 0 });
    assert.equal(reply.ok, true);
    await (await import('../../extension/lib/queue.js')).settled();
    assert.deepEqual(chrome.downloads.started(), ['https://x.test/a']);
    assert.deepEqual([chrome.storage.local.data.settings.parallel, chrome.storage.local.data.settings.retries], [1, 0]);
});

test('a jobs message reaches every job', async () => {
    const chrome = installChrome();
    await importFresh('background.js');
    const ask = message => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, {}, resolve));
    for (const host of ['x', 'y']) {
        await ask({ type: 'enqueue', pageUrl: `https://${host}.test/`, pageTitle: host, items: [{ url: `https://${host}.test/a`, text: 'A' }],
            folderTpl: '', nameTpl: '{name}', conflict: 'uniquify', start: false });
    }
    assert.deepEqual(chrome.downloads.started(), []);
    assert.deepEqual(await ask({ type: 'jobs', action: 'resumeAll' }), { ok: true });
    await (await import('../../extension/lib/queue.js')).settled();
    assert.deepEqual(chrome.downloads.started().sort(), ['https://x.test/a', 'https://y.test/a']);
});

test('messages are answered with ok and errors are passed back', async () => {
    const chrome = installChrome();
    await importFresh('background.js');
    const ask = message => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, {}, resolve));
    const enq = await ask({ type: 'enqueue', pageUrl: 'https://x.test/', pageTitle: 'X', items: [{ url: 'https://x.test/a.pdf', text: 'A' }],
        folderTpl: '{host}', nameTpl: '{n} {name}', conflict: 'overwrite' });
    assert.equal(enq.ok, true);
    assert.ok(enq.jobId);
    assert.deepEqual(chrome.downloads.started(), ['https://x.test/a.pdf']);
    assert.equal(chrome.storage.local.data.settings.nameTpl, '{n} {name}');
    const bad = await ask({ type: 'nope' });
    assert.deepEqual(bad, { ok: false, error: 'unknown message nope' });
    const set = await ask({ type: 'settings', patch: { parallel: 7 } });
    assert.equal(set.settings.parallel, 7);
});
