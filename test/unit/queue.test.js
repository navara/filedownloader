import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, importFresh, EXT_ID } from './fake-chrome.js';

const urls = n => Array.from({ length: n }, (_, i) => ({ url: `https://x.test/dl/${i + 1}`, text: `File ${i + 1}` }));

async function setup({ settings = {}, items = 5, job = {} } = {}) {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '{title}', nameTpl: '{name}',
        conflict: 'uniquify', ...settings } } });
    const q = await importFresh('lib/queue.js');
    const jobId = await q.enqueue({ pageUrl: 'https://battlezoo.com/downloads', pageTitle: 'Battlezoo: Downloads', items: urls(items),
        folderTpl: '{title}', nameTpl: '{n:3} {name}', conflict: 'uniquify', ...job });
    const dl = chrome.downloads;
    // downloads are started outside the serial chain; settled() waits until every started download has its id committed
    const states = async () => {
        await q.settled();
        return (await q.listJobs())[0].items.map(i => i.state);
    };
    const itemOf = async n => {
        await q.settled();
        return (await q.listJobs())[0].items[n];
    };
    await q.settled();
    return { chrome, q, jobId, dl, states, itemOf };
}

const complete = async (q, dl, id, filename = `C:\\dl\\f${id}.pdf`, mime = 'application/pdf') => {
    dl.set(id, { state: 'complete', filename, mime });
    await q.onDownloadChanged({ id, state: { previous: 'in_progress', current: 'complete' } });
    await q.settled();
};
const interrupt = async (q, dl, id, error, canResume, fields = {}) => {
    dl.set(id, { state: 'interrupted', error, canResume, ...fields });
    await q.onDownloadChanged({ id, state: { previous: 'in_progress', current: 'interrupted' }, error: { current: error } });
    await q.settled();
};

test('enqueue starts as many downloads as the parallel setting allows', async () => {
    const { dl, states } = await setup();
    assert.deepEqual(await states(), ['active', 'active', 'active', 'queued', 'queued']);
    assert.deepEqual(dl.started(), ['https://x.test/dl/1', 'https://x.test/dl/2', 'https://x.test/dl/3']);
    assert.equal(dl.calls.find(c => c[0] === 'download')[1].conflictAction, 'uniquify');
});

test('a completed download is done with its file name and the next one starts', async () => {
    const { q, dl, states, itemOf } = await setup();
    await complete(q, dl, 1, 'C:\\dl\\Battlezoo_ Downloads\\001 Real Name.pdf');
    assert.deepEqual(await states(), ['done', 'active', 'active', 'active', 'queued']);
    const first = await itemOf(0);
    assert.equal(first.filename, 'C:\\dl\\Battlezoo_ Downloads\\001 Real Name.pdf');
    assert.equal(first.mime, 'application/pdf');
});

test('a paused download frees its slot, unpausing makes it active again', async () => {
    const { q, dl, states } = await setup();
    dl.set(2, { paused: true, canResume: true });
    await q.onDownloadChanged({ id: 2, paused: { previous: false, current: true } });
    assert.deepEqual(await states(), ['active', 'paused', 'active', 'active', 'queued']);
    await q.onDownloadChanged({ id: 2, paused: { previous: true, current: false } });
    assert.deepEqual(await states(), ['active', 'active', 'active', 'active', 'queued']);
});

test('Pause all pauses running and waiting rows; Resume all starts them again within the limit', async () => {
    const { q, dl, jobId, states } = await setup();
    await q.jobAction(jobId, 'pauseAll');
    assert.deepEqual(dl.calls.filter(c => c[0] === 'pause').map(c => c[1]), [1, 2, 3]);
    assert.deepEqual(await states(), ['paused', 'paused', 'paused', 'paused', 'paused']);
    await complete(q, dl, 1);
    assert.equal(dl.started().length, 3);
    await q.jobAction(jobId, 'resumeAll');
    assert.deepEqual(dl.calls.filter(c => c[0] === 'resume').map(c => c[1]), [2, 3]);
    assert.deepEqual(await states(), ['done', 'active', 'active', 'active', 'queued']);
});

test('Queue adds files without starting them', async () => {
    const { q, dl, states } = await setup({ job: { start: false } });
    assert.deepEqual(await states(), Array(5).fill('paused'));
    assert.deepEqual(dl.started(), []);
    assert.deepEqual(await q.counts(), { unfinished: 5, busy: 0 });
    const [job] = await q.listJobs();
    assert.ok(job.items.every(i => i.downloadId === null));
    assert.equal('held' in job, false);
});

test('Start on one not-started file starts only that file', async () => {
    const { q, dl, jobId, states } = await setup({ job: { start: false } });
    await q.itemAction(jobId, '1', 'start');
    assert.deepEqual(await states(), ['paused', 'active', 'paused', 'paused', 'paused']);
    assert.deepEqual(dl.started(), ['https://x.test/dl/2']);
    assert.deepEqual(await q.counts(), { unfinished: 5, busy: 1 });
});

test('Retry failed queues failed rows only, not canceled ones', async () => {
    const { q, dl, jobId, states } = await setup({ settings: { retries: 0 }, items: 3 });
    await interrupt(q, dl, 1, 'SERVER_FAILED', false);
    await q.itemAction(jobId, '1', 'cancel');
    assert.deepEqual(await states(), ['failed', 'canceled', 'active']);
    await q.jobAction(jobId, 'retryFailed');
    assert.deepEqual(await states(), ['active', 'canceled', 'active']);
    assert.deepEqual(dl.started(), ['https://x.test/dl/1', 'https://x.test/dl/2', 'https://x.test/dl/3', 'https://x.test/dl/1']);
});

test('allJobsAction starts and pauses every job', async () => {
    const { q, dl } = await setup({ settings: { parallel: 10 }, items: 2, job: { start: false } });
    await q.enqueue({ pageUrl: 'https://y.test/', pageTitle: 'Y', items: [{ url: 'https://y.test/a', text: 'A' }], folderTpl: '', nameTpl: '{name}',
        conflict: 'uniquify', start: false });
    await q.allJobsAction('resumeAll');
    await q.settled();
    const all = async () => (await q.listJobs()).flatMap(j => j.items.map(i => i.state));
    assert.deepEqual(await all(), ['active', 'active', 'active']);
    await q.allJobsAction('pauseAll');
    await q.settled();
    assert.deepEqual(await all(), ['paused', 'paused', 'paused']);
    assert.equal(dl.calls.filter(c => c[0] === 'pause').length, 3);
});

test('a job stored with held from the earlier model is migrated and written back', async () => {
    const job = restartedJob([['a', 'queued', null], ['b', 'paused', 2], ['c', 'done', 3]], { held: true });
    const chrome = installChrome({ local: { 'job:j1': job, settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}',
        conflict: 'uniquify' } } });
    const q = await importFresh('lib/queue.js');
    const [migrated] = await q.listJobs();
    assert.deepEqual(migrated.items.map(i => i.state), ['paused', 'paused', 'done']);
    assert.equal('held' in migrated, false);
    await q.settled();
    const stored = chrome.storage.local.data['job:j1'];
    assert.equal('held' in stored, false);
    assert.deepEqual(stored.items.map(i => i.state), ['paused', 'paused', 'done']);
    assert.deepEqual(chrome.downloads.started(), []);
});

test('a resumable interruption is resumed up to the retries setting, then fails', async () => {
    const { q, dl, itemOf } = await setup({ items: 1 });
    await interrupt(q, dl, 1, 'NETWORK_FAILED', true);
    await interrupt(q, dl, 1, 'NETWORK_FAILED', true);
    assert.equal((await itemOf(0)).state, 'active');
    assert.equal((await itemOf(0)).attempts, 2);
    await interrupt(q, dl, 1, 'NETWORK_FAILED', true);
    const it = await itemOf(0);
    assert.deepEqual([it.state, it.error], ['failed', 'NETWORK_FAILED']);
    assert.equal(dl.calls.filter(c => c[0] === 'resume').length, 2);
});

test('an interruption that cannot be resumed fails with its error code', async () => {
    const { q, dl, itemOf } = await setup({ items: 1 });
    await interrupt(q, dl, 1, 'SERVER_FORBIDDEN', false);
    assert.deepEqual([(await itemOf(0)).state, (await itemOf(0)).error], ['failed', 'SERVER_FORBIDDEN']);
});

test('canceled in Chrome or erased from its list gives canceled and the queue moves on', async () => {
    const { q, dl, states } = await setup();
    await interrupt(q, dl, 1, 'USER_CANCELED', false);
    await q.onDownloadErased(2);
    assert.deepEqual(await states(), ['canceled', 'canceled', 'active', 'active', 'active']);
});

test('erasing a finished download from Chrome\'s list keeps it done', async () => {
    const { q, dl, states } = await setup({ items: 1 });
    await complete(q, dl, 1);
    await q.onDownloadErased(1);
    assert.deepEqual(await states(), ['done']);
});

test('a rejected download() fails the item and the next one starts', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 1, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    chrome.downloads.failNext = 'Invalid URL';
    const q = await importFresh('lib/queue.js');
    await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(2), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await q.settled();
    const items = (await q.listJobs())[0].items;
    assert.deepEqual(items.map(i => [i.state, i.error]), [['failed', 'Invalid URL'], ['active', '']]);
});

test('suggestName renames own downloads by the job rule and ignores others', async () => {
    const { q, dl } = await setup({ settings: { parallel: 10 }, items: 7 });
    const seventh = [...dl.items.values()].find(d => d.url === 'https://x.test/dl/7');
    assert.deepEqual(await q.suggestName({ id: seventh.id, url: seventh.url, filename: 'Real Name.pdf' }),
        { filename: 'Battlezoo_ Downloads/007 Real Name.pdf', conflictAction: 'uniquify' });
    assert.equal(await q.suggestName({ id: 999, url: 'https://other.test/x.zip', filename: 'x.zip' }), undefined);
});

test('suggestName uses the link text and the address name when the server gives none', async () => {
    const { q, dl } = await setup({ items: 1, job: { folderTpl: '{host}', nameTpl: '{text}' } });
    assert.deepEqual(await q.suggestName({ id: 1, url: 'https://x.test/dl/1', filename: 'download.pdf' }),
        { filename: 'battlezoo.com/File 1.pdf', conflictAction: 'uniquify' });
    assert.ok(dl);
});

test('overlapping change events lose no update', async () => {
    const { q, dl, states } = await setup({ settings: { parallel: 10 }, items: 10 });
    await Promise.all([...dl.items.keys()].map(id => complete(q, dl, id)));
    assert.deepEqual(await states(), Array(10).fill('done'));
});

test('Resume on a failed item resumes it when Chrome can, else queues it again', async () => {
    const { q, dl, jobId, itemOf } = await setup({ settings: { retries: 0 }, items: 2 });
    await interrupt(q, dl, 1, 'NETWORK_FAILED', true);
    await interrupt(q, dl, 2, 'SERVER_FAILED', false);
    const [a, b] = [await itemOf(0), await itemOf(1)];
    assert.deepEqual([a.state, b.state], ['failed', 'failed']);
    await q.itemAction(jobId, a.id, 'resume');
    assert.equal((await itemOf(0)).state, 'active');
    assert.deepEqual(dl.calls.filter(c => c[0] === 'resume').map(c => c[1]), [1]);
    await q.itemAction(jobId, b.id, 'retry');
    const again = await itemOf(1);
    assert.deepEqual([again.state, again.attempts, again.error], ['active', 0, '']);
    assert.equal(again.downloadId, 3);
});

test('item pause, cancel and remove', async () => {
    const { q, dl, jobId, itemOf, states } = await setup();
    await q.itemAction(jobId, (await itemOf(0)).id, 'pause');
    assert.deepEqual(dl.calls.filter(c => c[0] === 'pause').map(c => c[1]), [1]);
    assert.deepEqual(await states(), ['paused', 'active', 'active', 'active', 'queued']);
    await q.itemAction(jobId, (await itemOf(1)).id, 'cancel');
    assert.deepEqual(dl.calls.filter(c => c[0] === 'cancel').map(c => c[1]), [2]);
    assert.deepEqual(await states(), ['paused', 'canceled', 'active', 'active', 'active']);
    await q.itemAction(jobId, (await itemOf(1)).id, 'remove');
    assert.equal((await q.listJobs())[0].items.length, 4);
    // three are running and the limit is three, so the resumed row waits for a slot
    await q.itemAction(jobId, (await itemOf(0)).id, 'resume');
    assert.deepEqual(await states(), ['queued', 'active', 'active', 'active']);
});

test('cancelAll, clearFinished and the unfinished count', async () => {
    const { q, dl, jobId, states } = await setup();
    assert.equal(await q.unfinishedCount(), 5);
    await complete(q, dl, 1);
    await q.jobAction(jobId, 'cancelAll');
    assert.deepEqual(await states(), ['done', 'canceled', 'canceled', 'canceled', 'canceled']);
    assert.equal(await q.unfinishedCount(), 0);
    await q.jobAction(jobId, 'clearFinished');
    assert.deepEqual(await q.listJobs(), []);
});

test('reconcile after a browser restart adopts, finishes, requeues and fails items without starting anything twice', async () => {
    const started = Date.now() - 5000;
    const job = {
        id: 'j1', created: started, pageUrl: 'https://x.test/', pageTitle: 'X', folderTpl: '', nameTpl: '{name}', conflict: 'uniquify', held: false,
        items: [
            { id: 'a', n: 1, url: 'https://x.test/a', text: '', state: 'starting', downloadId: null, attempts: 0, error: '', startedAt: started },
            { id: 'b', n: 2, url: 'https://x.test/b', text: '', state: 'active', downloadId: 11, attempts: 0, error: '', startedAt: started },
            { id: 'c', n: 3, url: 'https://x.test/c', text: '', state: 'active', downloadId: 12, attempts: 0, error: '', startedAt: started },
            { id: 'd', n: 4, url: 'https://x.test/d', text: '', state: 'active', downloadId: 13, attempts: 0, error: '', startedAt: started },
            { id: 'e', n: 5, url: 'https://x.test/e', text: '', state: 'active', downloadId: 14, attempts: 0, error: '', startedAt: started },
            { id: 'f', n: 6, url: 'https://x.test/f', text: '', state: 'active', downloadId: 15, attempts: 0, error: '', startedAt: started },
        ],
    };
    const chrome = installChrome({ local: { 'job:j1': job, settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}',
        conflict: 'uniquify' } } });
    const dl = chrome.downloads;
    const iso = ms => new Date(ms).toISOString();
    const put = (id, url, fields) => dl.items.set(id, { id, url, state: 'in_progress', paused: false, canResume: false, filename: '', mime: '',
        startTime: iso(started + 100), byExtensionId: EXT_ID, ...fields });
    put(10, 'https://x.test/a', {});
    put(11, 'https://x.test/b', { state: 'complete', filename: 'C:\\dl\\b.pdf', mime: 'application/pdf' });
    put(12, 'https://x.test/c', { state: 'interrupted', error: 'USER_CANCELED' });
    put(13, 'https://x.test/d', { state: 'interrupted', error: 'NETWORK_FAILED', canResume: true });
    put(14, 'https://x.test/e', { state: 'interrupted', error: 'SERVER_FORBIDDEN' });
    const q = await importFresh('lib/queue.js');
    await q.reconcile();
    await q.settled();
    const items = (await q.listJobs())[0].items;
    assert.deepEqual(items.map(i => [i.id, i.state, i.downloadId]), [
        ['a', 'active', 10], ['b', 'done', 11], ['c', 'active', 100], ['d', 'active', 13], ['e', 'failed', 14], ['f', 'failed', 15],
    ].map(([id, state, d]) => [id, state, d === 100 ? items[2].downloadId : d]));
    assert.deepEqual(dl.started(), ['https://x.test/c']);
    assert.deepEqual(dl.calls.filter(c => c[0] === 'resume').map(c => c[1]), [13]);
    assert.equal(items[4].error, 'SERVER_FORBIDDEN');
    assert.equal(items[5].error, 'GONE');
});

// a job as reconcile() finds it after a restart; items are [id, state, downloadId]
function restartedJob(items, fields = {}) {
    const started = Date.now() - 5000;
    return {
        id: 'j1', created: started, pageUrl: 'https://x.test/', pageTitle: 'X', folderTpl: '', nameTpl: '{name}', conflict: 'uniquify', held: false,
        items: items.map(([id, state, downloadId], i) => ({ id, n: i + 1, url: `https://x.test/${id}`, text: '', state, downloadId, attempts: 0,
            error: '', filename: '', mime: '', startedAt: started })),
        ...fields,
    };
}

async function afterRestart(job, downloads) {
    const chrome = installChrome({ local: { 'job:j1': job, settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}',
        conflict: 'uniquify' } } });
    for (const [id, fields] of downloads) {
        chrome.downloads.items.set(id, { id, url: `https://x.test/${id}`, state: 'in_progress', paused: false, canResume: false, filename: '',
            mime: '', startTime: new Date().toISOString(), byExtensionId: EXT_ID, ...fields });
    }
    chrome.downloads.skipIds(downloads.length);
    const q = await importFresh('lib/queue.js');
    await q.reconcile();
    await q.settled();
    return { q, dl: chrome.downloads, items: (await q.listJobs())[0].items };
}

// a worker whose browser session already ran the full check: storage.session has the flag
async function wokenWorker(job, downloads, { flag = true } = {}) {
    const chrome = installChrome({ local: { 'job:j1': job, settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}',
        conflict: 'uniquify' } }, session: flag ? { reconciled: true } : {} });
    for (const [id, fields] of downloads) {
        chrome.downloads.items.set(id, { id, url: `https://x.test/${fields.urlId || id}`, state: 'in_progress', paused: false, canResume: false,
            filename: '', mime: '', startTime: new Date().toISOString(), byExtensionId: EXT_ID, ...fields });
    }
    chrome.downloads.skipIds(Math.max(0, ...downloads.map(([id]) => id)));
    const q = await importFresh('lib/queue.js');
    return { chrome, q, dl: chrome.downloads };
}

test('a worker that wakes within the session leaves interrupted rows to their own events', async () => {
    const job = restartedJob([['a', 'active', 1]]);
    const { q, dl } = await wokenWorker(job, [[1, { urlId: 'a', state: 'interrupted', error: 'USER_CANCELED' }]]);
    assert.equal(await q.ensureSession(), true);
    await q.onDownloadChanged({ id: 1, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
    await q.settled();
    const [item] = (await q.listJobs())[0].items;
    assert.equal(item.state, 'canceled');
    assert.deepEqual(dl.started(), []);
});

test('the session check runs once per worker life and the full check once per browser session', async () => {
    const job = restartedJob([['a', 'active', 1]]);
    const { q, chrome } = await wokenWorker(job, [[1, { urlId: 'a', state: 'interrupted', error: 'USER_CANCELED' }]], { flag: false });
    assert.equal(await q.ensureSession(), true);
    assert.equal(await q.ensureSession(), false);
    await q.settled();
    assert.equal(chrome.storage.session.data.reconciled, true);
    // stopped by the browser (no flag yet): queued again and started
    assert.deepEqual(chrome.downloads.started(), ['https://x.test/a']);
});

test('a worker that wakes within the session marks rows whose download finished meanwhile done', async () => {
    const job = restartedJob([['a', 'active', 1], ['b', 'paused', 2]]);
    const { q } = await wokenWorker(job, [[1, { urlId: 'a', state: 'complete', filename: 'C:\\dl\\a.pdf' }], [2, { urlId: 'b', paused: true,
        canResume: true }]]);
    await q.ensureSession();
    await q.settled();
    const items = (await q.listJobs())[0].items;
    assert.deepEqual(items.map(i => [i.state, i.filename]), [['done', 'C:\\dl\\a.pdf'], ['paused', '']]);
});

test('the session check leaves a download this worker is still starting alone', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    const release = chrome.downloads.hold('https://x.test/dl/1');
    const q = await importFresh('lib/queue.js');
    await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(1), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await q.ensureSession();
    release();
    await q.settled();
    const [item] = (await q.listJobs())[0].items;
    assert.equal(item.state, 'active');
    assert.equal(chrome.downloads.started().length, 1);
    assert.equal(chrome.downloads.calls.some(c => c[0] === 'cancel'), false);
});

test('a starting row left by a worker that stopped is adopted when its download exists', async () => {
    const job = restartedJob([['a', 'starting', null]]);
    const { q, dl } = await wokenWorker(job, [[7, { urlId: 'a' }]]);
    await q.ensureSession();
    await q.settled();
    const [item] = (await q.listJobs())[0].items;
    assert.deepEqual([item.state, item.downloadId], ['active', 7]);
    assert.deepEqual(dl.started(), []);
});

test('a starting row whose download only appears later is adopted, and named, through onDeterminingFilename', async () => {
    const job = restartedJob([['a', 'starting', null]], { folderTpl: 'f', nameTpl: '{n:2} {name}' });
    const { q, dl } = await wokenWorker(job, []);
    await q.ensureSession();
    await q.settled();
    assert.equal((await q.listJobs())[0].items[0].state, 'starting');
    // the headers came: Chrome made the download and asks for its name
    dl.items.set(9, { id: 9, url: 'https://x.test/a', state: 'in_progress', paused: false, byExtensionId: EXT_ID, startTime: new Date().toISOString() });
    assert.deepEqual(await q.suggestName({ id: 9, url: 'https://x.test/a', filename: 'held.pdf' }), { filename: 'f/01 held.pdf', conflictAction: 'uniquify' });
    await q.settled();
    const [item] = (await q.listJobs())[0].items;
    assert.deepEqual([item.state, item.downloadId], ['active', 9]);
    assert.deepEqual(dl.started(), []);
});

test('Chrome\'s download UI is hidden before the first download starts and shown when nothing is left to run', async () => {
    const { q, dl } = await setup();
    const firstUi = dl.calls.findIndex(c => c[0] === 'ui');
    const firstDownload = dl.calls.findIndex(c => c[0] === 'download');
    assert.deepEqual(dl.calls[firstUi], ['ui', false]);
    assert.ok(firstUi < firstDownload);
    for (let id = 1; id <= 5; id++) await complete(q, dl, id);
    assert.deepEqual(dl.ui(), [false, true]);
});

test('paused and not-started files do not keep Chrome\'s download UI hidden', async () => {
    const { q, dl, jobId } = await setup({ job: { start: false } });
    assert.deepEqual(dl.ui(), [true]);
    await q.itemAction(jobId, '0', 'start');
    await q.settled();
    assert.deepEqual(dl.ui(), [true, false]);
    await q.jobAction(jobId, 'pauseAll');
    await q.settled();
    assert.deepEqual(dl.ui(), [true, false, true]);
});

test('Cancel all, Remove and Clear finished bring Chrome\'s download UI back', async () => {
    for (const action of ['cancelAll', 'remove', 'clearFinished']) {
        const { q, dl, jobId } = await setup({ items: 1 });
        if (action === 'cancelAll') await q.jobAction(jobId, 'cancelAll');
        if (action === 'remove') await q.itemAction(jobId, '0', 'remove');
        if (action === 'clearFinished') {
            await q.itemAction(jobId, '0', 'cancel');
            await q.jobAction(jobId, 'clearFinished');
        }
        await q.settled();
        assert.deepEqual(dl.ui(), [false, true], action);
    }
});

test('a worker that wakes with nothing to run switches Chrome\'s download UI on once', async () => {
    const job = restartedJob([['a', 'done', 1]]);
    const { q, dl } = await wokenWorker(job, [[1, { urlId: 'a', state: 'complete' }]]);
    await q.ensureSession();
    await q.settled();
    assert.deepEqual(dl.ui(), [true]);
});

test('a failing or missing setUiOptions does not stop the queue and logs no error', async () => {
    const errors = [];
    const original = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    const warn = console.warn;
    console.warn = () => {};
    try {
        const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
        chrome.downloads.uiFail = 'Another extension has disabled the download UI';
        let q = await importFresh('lib/queue.js');
        await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(2), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
        await q.settled();
        assert.equal(chrome.downloads.started().length, 2);
        const again = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
        delete again.downloads.setUiOptions;
        q = await importFresh('lib/queue.js');
        await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(2), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
        await q.settled();
        assert.equal(again.downloads.started().length, 2);
    } finally {
        console.error = original;
        console.warn = warn;
    }
    assert.deepEqual(errors, []);
});

test('a download Chrome holds as dangerous frees its slot, shows Chrome\'s bubble, and comes back when accepted', async () => {
    const { q, dl, states, itemOf } = await setup({ settings: { parallel: 1 }, items: 2 });
    dl.set(1, { danger: 'file' });
    await q.onDownloadChanged({ id: 1, danger: { previous: 'safe', current: 'file' } });
    await q.settled();
    assert.deepEqual(await states(), ['active', 'active']);
    assert.equal((await itemOf(0)).danger, 'file');
    assert.deepEqual(await q.counts(), { unfinished: 2, busy: 1 });
    // while the other file runs the bubble stays off (the row's Keep button asks Chrome's question); with only the held file left it comes back
    assert.equal(dl.ui().at(-1), false);
    await complete(q, dl, 2);
    assert.deepEqual(await states(), ['active', 'done']);
    assert.equal(dl.ui().at(-1), true);
    dl.set(1, { danger: 'accepted' });
    await q.onDownloadChanged({ id: 1, danger: { previous: 'file', current: 'accepted' } });
    await complete(q, dl, 1);
    assert.deepEqual(await states(), ['done', 'done']);
    assert.equal((await itemOf(0)).danger, undefined);
});

test('the Downloads folder length is learned from a finished download and caps the paths given afterwards', async () => {
    const { q, dl, chrome } = await setup({ settings: { parallel: 5 }, items: 3, job: { folderTpl: '{text}', nameTpl: '{text} {name}' } });
    const ids = [...dl.items.keys()];
    // before anything finished: a Downloads folder of 60 characters is assumed (243 - 60 - 1 - 8 = 174)
    const first = await q.suggestName({ id: ids[0], url: dl.items.get(ids[0]).url, filename: `${'n'.repeat(150)}.pdf` });
    assert.ok(first.filename.length <= 174, `${first.filename.length}`);
    const dir = `C:\\Users\\someone\\Downloads\\deep\\${'d'.repeat(60)}`;
    await complete(q, dl, ids[0], `${dir}\\File 1\\File 1 short.pdf`);
    assert.equal(chrome.storage.local.data.downloadsDirLength, dir.length);
    const second = await q.suggestName({ id: ids[1], url: dl.items.get(ids[1]).url, filename: `${'n'.repeat(150)}.pdf` });
    assert.ok(second.filename.length <= 243 - dir.length - 1 - 8, `${second.filename.length} for a folder of ${dir.length}`);
    assert.ok(second.filename.endsWith('.pdf'));
});

test('a Pause all that came while a row was starting does not pause that row after it was canceled and retried', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    const release = chrome.downloads.hold('https://x.test/dl/1');
    const q = await importFresh('lib/queue.js');
    const jobId = await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(1), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await q.jobAction(jobId, 'pauseAll');
    await q.itemAction(jobId, '0', 'cancel');
    release();
    await q.settled();
    await q.itemAction(jobId, '0', 'retry');
    await q.settled();
    const [item] = (await q.listJobs())[0].items;
    assert.equal(item.state, 'active');
    assert.equal(item.pauseOnStart, undefined);
});

test('a canceled or retried row does not keep the dangerous-file flag', async () => {
    const { q, dl, jobId, itemOf } = await setup({ items: 1 });
    dl.set(1, { danger: 'file' });
    await q.onDownloadChanged({ id: 1, danger: { current: 'file' } });
    await q.itemAction(jobId, '0', 'cancel');
    assert.equal((await itemOf(0)).danger, undefined);
    await q.itemAction(jobId, '0', 'retry');
    const retried = await itemOf(0);
    assert.deepEqual([retried.state, retried.danger], ['active', undefined]);
});

test('the Downloads folder is learned only from a file saved in the folders it was given', async () => {
    const { q, dl, chrome } = await setup({ items: 2, job: { folderTpl: 'a/b', nameTpl: '{name}' } });
    const [one, two] = [...dl.items.keys()];
    await q.suggestName({ id: one, url: dl.items.get(one).url, filename: 'x.pdf' });
    // Chrome refused the suggested path and saved in the Downloads root
    await complete(q, dl, one, 'C:\\Users\\me\\Downloads\\x.pdf');
    assert.equal(chrome.storage.local.data.downloadsDirLength, undefined);
    await q.suggestName({ id: two, url: dl.items.get(two).url, filename: 'y.pdf' });
    await complete(q, dl, two, 'C:\\Users\\me\\Downloads\\a\\b\\y (1).pdf');
    assert.equal(chrome.storage.local.data.downloadsDirLength, 'C:\\Users\\me\\Downloads'.length);
});

test('a start left by a stopped worker that never produced a download is queued again after two minutes, and frees its slot', async () => {
    const job = restartedJob([['a', 'starting', null], ['b', 'queued', null]]);
    job.items[0].startedAt = Date.now() - 3 * 60 * 1000;
    const { q, dl } = await wokenWorker(job, []);
    await q.ensureSession();
    await q.settled();
    const items = (await q.listJobs())[0].items;
    assert.deepEqual(items.map(i => i.state), ['active', 'active']);
    assert.deepEqual(dl.started().sort(), ['https://x.test/a', 'https://x.test/b']);
});

test('two starting rows with one address do not both adopt the same download', async () => {
    const job = restartedJob([['a', 'starting', null], ['b', 'starting', null]]);
    job.items[1].url = job.items[0].url;
    const { q } = await wokenWorker(job, [[7, { urlId: 'a' }]]);
    await q.ensureSession();
    await q.settled();
    const items = (await q.listJobs())[0].items;
    assert.deepEqual(items.map(i => i.downloadId), [7, null]);
    assert.deepEqual(items.map(i => i.state), ['active', 'starting']);
});

test('the fake search, like Chrome, ignores a null id and returns every download', async () => {
    const chrome = installChrome();
    await chrome.downloads.download({ url: 'https://x.test/1' });
    await chrome.downloads.download({ url: 'https://x.test/2' });
    assert.equal((await chrome.downloads.search({ id: null })).length, 2);
});

test('reconcile keeps a waiting row the user paused paused, and never takes another download for it', async () => {
    const job = restartedJob([['a', 'done', 1], ['b', 'paused', null]]);
    const { items, dl } = await afterRestart(job, [[1, { state: 'complete', filename: 'C:\\dl\\a.pdf', mime: 'application/pdf' }]]);
    assert.deepEqual(items.map(i => [i.id, i.state, i.downloadId, i.filename]), [['a', 'done', 1, ''], ['b', 'paused', null, '']]);
    assert.deepEqual(dl.started(), []);
});

test('reconcile keeps paused rows paused after a restart, resumable or not', async () => {
    const job = restartedJob([['a', 'paused', 1], ['b', 'paused', 2], ['c', 'queued', null]]);
    const { items, dl } = await afterRestart(job, [
        [1, { state: 'interrupted', error: 'USER_CANCELED', canResume: false }],
        [2, { state: 'interrupted', error: 'NETWORK_FAILED', canResume: true }],
    ]);
    assert.deepEqual(items.map(i => [i.id, i.state, i.downloadId]), [['a', 'paused', null], ['b', 'paused', 2], ['c', 'active', 3]]);
    assert.deepEqual(dl.started(), ['https://x.test/c']);
    assert.deepEqual(dl.calls.filter(c => c[0] === 'resume'), []);
});

test('a row paused across a restart can be resumed afterwards', async () => {
    const job = restartedJob([['a', 'paused', 1], ['b', 'paused', 2]]);
    const { q, items, dl } = await afterRestart(job, [
        [1, { state: 'interrupted', error: 'USER_CANCELED', canResume: false }],
        [2, { state: 'interrupted', error: 'NETWORK_FAILED', canResume: true }],
    ]);
    await q.itemAction('j1', items[0].id, 'resume');
    await q.itemAction('j1', items[1].id, 'resume');
    await q.settled();
    const after = (await q.listJobs())[0].items;
    assert.deepEqual(after.map(i => i.state), ['active', 'active']);
    assert.deepEqual(dl.started(), ['https://x.test/a']);
    assert.deepEqual(dl.calls.filter(c => c[0] === 'resume').map(c => c[1]), [2]);
});

test('names that collide inside a batch get a number, also with overwrite', async () => {
    const { q, dl } = await setup({ settings: { parallel: 5 }, items: 4, job: { folderTpl: 'f', nameTpl: '{name}', conflict: 'overwrite' } });
    const ids = [...dl.items.keys()];
    const names = [];
    for (const id of ids.slice(0, 3)) names.push((await q.suggestName({ id, url: dl.items.get(id).url, filename: 'Same.pdf' })).filename);
    names.push((await q.suggestName({ id: ids[3], url: dl.items.get(ids[3]).url, filename: 'same.PDF' })).filename);
    assert.deepEqual(names, ['f/Same.pdf', 'f/Same (1).pdf', 'f/Same (2).pdf', 'f/same (3).PDF']);
    const again = await q.suggestName({ id: ids[0], url: dl.items.get(ids[0]).url, filename: 'Same.pdf' });
    assert.deepEqual(again, { filename: 'f/Same.pdf', conflictAction: 'overwrite' });
});

test('a slow server does not hold up the queue or other commands', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    const release = chrome.downloads.hold('https://x.test/dl/1');
    const q = await importFresh('lib/queue.js');
    const jobId = await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(3), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await new Promise(r => setTimeout(r, 20));
    let items = (await q.listJobs())[0].items;
    assert.deepEqual(items.map(i => i.state), ['starting', 'active', 'active']);
    await q.jobAction(jobId, 'pauseAll');
    items = (await q.listJobs())[0].items;
    assert.deepEqual(items.map(i => i.state), ['starting', 'paused', 'paused']);
    release();
    await q.settled();
    items = (await q.listJobs())[0].items;
    assert.equal(items[0].state, 'paused');
    assert.ok(chrome.downloads.calls.some(c => c[0] === 'pause' && c[1] === items[0].downloadId));
    // paused, not canceled: a one-time download link must not be spent
    assert.equal(chrome.downloads.calls.some(c => c[0] === 'cancel'), false);
});

test('a row canceled or removed while its download was starting cancels that download', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    const release1 = chrome.downloads.hold('https://x.test/dl/1');
    const release2 = chrome.downloads.hold('https://x.test/dl/2');
    const q = await importFresh('lib/queue.js');
    const jobId = await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(2), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await q.itemAction(jobId, '0', 'cancel');
    await q.itemAction(jobId, '1', 'remove');
    release1();
    release2();
    await q.settled();
    const items = (await q.listJobs())[0].items;
    assert.deepEqual(items.map(i => i.state), ['canceled']);
    assert.deepEqual(chrome.downloads.calls.filter(c => c[0] === 'cancel').map(c => c[1]).sort(), [1, 2]);
});

test('cancel and retry while the first download() is still waiting: each launch only commits to its own attempt', async () => {
    for (const order of [['1', '2'], ['2', '1']]) {
        const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
        const release = { 1: chrome.downloads.hold('https://x.test/dl/1') };
        const q = await importFresh('lib/queue.js');
        const jobId = await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(1), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
        await q.itemAction(jobId, '0', 'cancel');
        release[2] = chrome.downloads.hold('https://x.test/dl/1');
        await q.itemAction(jobId, '0', 'retry');
        // the second hold replaced the first gate; the first download() still waits on its own promise
        release[order[0]]();
        await new Promise(r => setTimeout(r, 5));
        release[order[1]]();
        await q.settled();
        const [item] = (await q.listJobs())[0].items;
        const canceled = chrome.downloads.calls.filter(c => c[0] === 'cancel').map(c => c[1]);
        assert.equal(item.state, 'active', `order ${order}`);
        assert.equal(canceled.length, 1, `order ${order}: ${JSON.stringify(chrome.downloads.calls)}`);
        assert.notEqual(item.downloadId, canceled[0], `order ${order}: the row follows the canceled download`);
        assert.equal(chrome.downloads.items.get(item.downloadId).url, 'https://x.test/dl/1');
    }
});

test('a first attempt that fails late does not fail the retried row', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    const releaseFirst = chrome.downloads.hold('https://x.test/dl/1');
    const q = await importFresh('lib/queue.js');
    const jobId = await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(1), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await q.itemAction(jobId, '0', 'cancel');
    const releaseSecond = chrome.downloads.hold('https://x.test/dl/1');
    await q.itemAction(jobId, '0', 'retry');
    chrome.downloads.failNextGated = 'Server refused';
    releaseFirst();
    await new Promise(r => setTimeout(r, 5));
    releaseSecond();
    await q.settled();
    const [item] = (await q.listJobs())[0].items;
    assert.deepEqual([item.state, item.error], ['active', '']);
});

test('names stay unique inside a batch even after rows were cleared, removed or retried', async () => {
    const { q, dl, jobId } = await setup({ settings: { parallel: 5 }, items: 3, job: { folderTpl: 'f', nameTpl: '{name}', conflict: 'overwrite' } });
    const [a, b, c] = [...dl.items.keys()];
    assert.equal((await q.suggestName({ id: a, url: dl.items.get(a).url, filename: 'same.pdf' })).filename, 'f/same.pdf');
    await complete(q, dl, a);
    await q.jobAction(jobId, 'clearFinished');
    assert.equal((await q.suggestName({ id: b, url: dl.items.get(b).url, filename: 'same.pdf' })).filename, 'f/same (1).pdf');
    await q.itemAction(jobId, '1', 'remove');
    assert.equal((await q.suggestName({ id: c, url: dl.items.get(c).url, filename: 'same.pdf' })).filename, 'f/same (2).pdf');
    // a retried row keeps its own name
    await interrupt(q, dl, c, 'SERVER_FAILED', false);
    await q.itemAction(jobId, '2', 'retry');
    await q.settled();
    const retried = (await q.listJobs())[0].items.find(i => i.id === '2');
    assert.equal((await q.suggestName({ id: retried.downloadId, url: retried.url, filename: 'same.pdf' })).filename, 'f/same (2).pdf');
});

test('enqueue fails, and starts nothing, when the job cannot be stored', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
    const q = await importFresh('lib/queue.js');
    await assert.rejects(q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(2), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' }),
        /QUOTA_BYTES/);
    await q.settled();
    assert.deepEqual(chrome.downloads.started(), []);
    assert.deepEqual(await q.listJobs(), []);
});

test('Resume never runs more than the limit; a resumed row waits for a slot', async () => {
    const { q, dl, jobId, states } = await setup({ settings: { parallel: 2 }, items: 4 });
    await q.itemAction(jobId, '0', 'pause');
    await q.itemAction(jobId, '1', 'pause');
    assert.deepEqual(await states(), ['paused', 'paused', 'active', 'active']);
    await q.itemAction(jobId, '0', 'resume');
    await q.itemAction(jobId, '1', 'resume');
    assert.deepEqual(await states(), ['queued', 'queued', 'active', 'active']);
    assert.equal(dl.calls.filter(c => c[0] === 'resume').length, 0);
    await complete(q, dl, 3);
    assert.deepEqual(await states(), ['active', 'queued', 'done', 'active']);
    assert.deepEqual(dl.calls.filter(c => c[0] === 'resume').map(c => c[1]), [1]);
    assert.equal(dl.started().length, 4);
});

test('Cancel on a waiting row that owns a paused download cancels it in Chrome', async () => {
    const { q, dl, jobId, states } = await setup({ settings: { parallel: 1 }, items: 2 });
    await q.itemAction(jobId, '0', 'pause');
    await q.itemAction(jobId, '0', 'resume');
    assert.deepEqual(await states(), ['queued', 'active']);
    await q.itemAction(jobId, '0', 'cancel');
    assert.deepEqual(dl.calls.filter(c => c[0] === 'cancel').map(c => c[1]), [1]);
    assert.deepEqual(await states(), ['canceled', 'active']);
});

test('a waiting row the user resumed in Chrome meanwhile is adopted, not downloaded twice', async () => {
    const { q, dl, jobId, states } = await setup({ settings: { parallel: 1 }, items: 2 });
    await q.itemAction(jobId, '0', 'pause');
    await q.itemAction(jobId, '0', 'resume');
    dl.set(1, { paused: false });
    await complete(q, dl, 2);
    assert.deepEqual(await states(), ['active', 'done']);
    assert.equal(dl.started().length, 2);
    assert.equal(dl.calls.filter(c => c[0] === 'resume').length, 0);
});

test('a waiting row whose paused download is gone starts again', async () => {
    const { q, dl, jobId, states, itemOf } = await setup({ settings: { parallel: 1 }, items: 2 });
    await q.itemAction(jobId, '0', 'pause');
    await q.itemAction(jobId, '0', 'resume');
    dl.items.delete(1);
    await complete(q, dl, 2);
    assert.deepEqual(await states(), ['active', 'done']);
    assert.deepEqual(dl.started(), ['https://x.test/dl/1', 'https://x.test/dl/2', 'https://x.test/dl/1']);
    assert.equal((await itemOf(0)).downloadId, 3);
});

test('an interruption already handled when the id was stored is not handled twice', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 1, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    const dl = chrome.downloads;
    dl.afterStart = id => dl.set(id, { state: 'interrupted', error: 'NETWORK_FAILED', canResume: true });
    const q = await importFresh('lib/queue.js');
    await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(1), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await q.settled();
    // the same interruption, delivered as an event that was queued behind the commit; Chrome already resumed the download
    await q.onDownloadChanged({ id: 1, state: { previous: 'in_progress', current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
    await q.settled();
    const [item] = (await q.listJobs())[0].items;
    assert.deepEqual([item.state, item.attempts], ['active', 1]);
    assert.equal(dl.calls.filter(c => c[0] === 'resume').length, 1);
});

test('a download that finished before its id was stored is still marked done', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 3, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    chrome.downloads.afterStart = id => chrome.downloads.set(id, { state: 'complete', filename: 'C:\\dl\\x.pdf', mime: 'application/pdf' });
    const q = await importFresh('lib/queue.js');
    await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(1), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await q.settled();
    const [item] = (await q.listJobs())[0].items;
    assert.deepEqual([item.state, item.filename], ['done', 'C:\\dl\\x.pdf']);
});

test('a download canceled by Chrome before any byte arrived carries a hint', async () => {
    const { q, dl, itemOf } = await setup({ items: 2 });
    await interrupt(q, dl, 1, 'USER_CANCELED', false, { bytesReceived: 0 });
    await interrupt(q, dl, 2, 'USER_CANCELED', false, { bytesReceived: 5000 });
    assert.deepEqual([(await itemOf(0)).state, (await itemOf(0)).error], ['canceled', 'CANCELED_EARLY']);
    assert.deepEqual([(await itemOf(1)).state, (await itemOf(1)).error], ['canceled', '']);
});

test('a burst of events is written to storage in a few writes, and what is written is the final state', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 10, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    const q = await importFresh('lib/queue.js');
    await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(10), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await q.settled();
    let writes = 0;
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = items => {
        writes++;
        return set(items);
    };
    await Promise.all([...chrome.downloads.items.keys()].map(id => {
        chrome.downloads.set(id, { state: 'complete', filename: `C:\\dl\\${id}`, mime: 'application/pdf' });
        return q.onDownloadChanged({ id, state: { current: 'complete' } });
    }));
    await q.settled();
    assert.ok(writes <= 2, `${writes} writes`);
    const [stored] = Object.entries(chrome.storage.local.data).filter(([k]) => k.startsWith('job:')).map(([, v]) => v);
    assert.deepEqual(stored.items.map(i => i.state), Array(10).fill('done'));
});

test('the worker reads all of storage once, not on every event', async () => {
    const chrome = installChrome({ local: { settings: { schema: 1, parallel: 10, retries: 2, folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' } } });
    let fullReads = 0;
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = keys => {
        if (keys === null || keys === undefined) fullReads++;
        return get(keys);
    };
    const q = await importFresh('lib/queue.js');
    await q.enqueue({ pageUrl: 'https://x.test/', pageTitle: 'X', items: urls(10), folderTpl: '', nameTpl: '{name}', conflict: 'uniquify' });
    await q.settled();
    for (const id of [...chrome.downloads.items.keys()]) await complete(q, chrome.downloads, id);
    assert.equal(fullReads, 1);
});
