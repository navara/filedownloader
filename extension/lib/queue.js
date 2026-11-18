// The download queue. Jobs live in chrome.storage.local as `job:<id>`, so the queue survives the worker going to sleep and a browser restart; the
// worker keeps them in memory for its life (it is their only writer) and writes each changed job through. Every change runs through one promise
// chain (serial), so overlapping Chrome events cannot overwrite each other's writes. Only the worker imports this.
//
// Item states: queued, starting (download() called, id not yet known), active, paused, done, failed, canceled. Paused items do not take a slot.
// download() resolves only when the server's headers arrive, so it is called outside the chain (launch) and its id committed in a later step.

import { loadSettings } from './settings.js';
import { buildPath, splitName, batchStamp, relativeLimit, ASSUMED_DIR_LENGTH } from './naming.js';

const RUNNING = new Set(['starting', 'active']);
const UNFINISHED = new Set(['queued', 'starting', 'active', 'paused']);
// what Chrome reports for a download that the browser's own shutdown or crash stopped; the worker never hears about it as an event (probe, 2026-11-18)
const STOPPED_BY_BROWSER = new Set(['USER_CANCELED', 'USER_SHUTDOWN', 'CRASH']);

let chain = Promise.resolve();
const inflight = new Set();
let cache = null;

// What belongs to one worker life: whether the session check ran, and which starts this worker still waits on (a start left by an earlier worker
// is an orphan to adopt). Keyed on the chrome object, since the unit tests install a fresh fake per test while this module stays loaded.
let life = null;

function workerLife() {
    if (!life || life.chrome !== globalThis.chrome) life = { chrome: globalThis.chrome, checked: false, launched: new Set(), uiEnabled: undefined };
    return life;
}

const launchKey = (jobId, itemId, token) => `${jobId}/${itemId}/${token}`;
const launchedHere = (job, item) => workerLife().launched.has(launchKey(job.id, item.id, item.launch));

function serial(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
}

// resolves once every download started so far has its id committed, the chain is idle and the jobs are written (tests, and nothing else, wait on it)
export async function settled() {
    do {
        await Promise.all([...inflight]);
        await chain;
    } while (inflight.size);
    await flush();
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

// the cache belongs to one storage area; the unit tests install a fresh fake chrome per test while this module stays loaded
let cacheArea = null;

async function jobsMap() {
    if (!cache || cacheArea !== chrome.storage.local) {
        cacheArea = chrome.storage.local;
        const all = await chrome.storage.local.get(null);
        cache = new Map(Object.entries(all).filter(([k]) => k.startsWith('job:')).map(([, v]) => [v.id, v]));
        for (const job of cache.values()) if ('held' in job) migrateHeld(job);
    }
    return cache;
}

// Jobs no longer have `held` (Pause all pauses each row instead); a job stored by the earlier version gets its waiting rows paused and is written
// back, since the panel reads storage directly
function migrateHeld(job) {
    if (job.held) for (const item of job.items) if (item.state === 'queued') item.state = 'paused';
    delete job.held;
    dirty.set(job.id, job);
    flushTimer ||= setTimeout(flush, FLUSH_MS);
}

async function loadJobs() {
    return [...(await jobsMap()).values()].sort((a, b) => a.created - b.created);
}

// Changed jobs are written together at most every FLUSH_MS: rewriting a whole job on each of the five or so events per file made a 1000 file batch
// crawl (3.9 files/s, probe 2026-11-18). What a browser shutdown can lose in that window, reconcile() rebuilds from Chrome at the next start.
const FLUSH_MS = 200;
const dirty = new Map();
let flushTimer = 0;
let flushing = Promise.resolve();

function flush() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (!dirty.size) return flushing;
    const items = Object.fromEntries([...dirty.values()].map(job => [`job:${job.id}`, job]));
    dirty.clear();
    flushing = chrome.storage.local.set(items).catch(error => console.error('File Downloader: saving the queue failed:', error));
    return flushing;
}

async function saveJob(job) {
    (await jobsMap()).set(job.id, job);
    dirty.set(job.id, job);
    flushTimer ||= setTimeout(flush, FLUSH_MS);
}

async function removeJob(job) {
    (await jobsMap()).delete(job.id);
    dirty.delete(job.id);
    await chrome.storage.local.remove(`job:${job.id}`);
}

const storeJob = job => (job.items.length ? saveJob(job) : removeJob(job));

// only unfinished rows: an id Chrome hands out again after its history was cleared must not match an old row
async function findByDownload(downloadId) {
    for (const job of await loadJobs()) {
        const item = job.items.find(i => i.downloadId === downloadId && UNFINISHED.has(i.state));
        if (item) return { job, item };
    }
    return null;
}

function hostOf(url) {
    try {
        return new URL(url).host;
    } catch {
        return '';
    }
}

// never search with a missing id: Chrome ignores a null field and returns every download (review probe, 2026-11-18)
async function downloadInfo(id) {
    if (!Number.isInteger(id)) return undefined;
    const [info] = await chrome.downloads.search({ id });
    return info;
}

// a retried row keeps its target: the name it was given stays its own
function requeue(item) {
    Object.assign(item, { state: 'queued', downloadId: null, attempts: 0, error: '', filename: '', mime: '' });
    clearFlags(item);
}

// flags that belong to one attempt: a Pause all that came while it was starting, Chrome holding its file as dangerous
function clearFlags(item) {
    delete item.pauseOnStart;
    delete item.danger;
}

// a row the user (or Chrome's downloads page) canceled
async function cancelRow(item) {
    await stopItem(item, 'cancel');
    item.state = 'canceled';
    clearFlags(item);
}

// A queued row that still owns a paused download (Resume waits for a free slot) gets it resumed; Chrome is asked first, so a download the user
// resumed or finished in chrome://downloads meanwhile is adopted instead of fetched again. 'freed': the row finished and took no slot; 'restart':
// the download is gone or cannot be resumed and the row starts afresh.
async function resumeQueued(item) {
    let info = await downloadInfo(item.downloadId);
    if (info && info.state !== 'complete' && !(info.state === 'in_progress' && !info.paused)) {
        try {
            await chrome.downloads.resume(item.downloadId);
            item.state = 'active';
            return null;
        } catch {
            info = await downloadInfo(item.downloadId);
        }
    }
    if (info?.state === 'complete') {
        await finished(item, info);
        return 'freed';
    }
    if (info?.state === 'in_progress' && !info.paused) {
        item.state = 'active';
        return null;
    }
    requeue(item);
    return 'restart';
}

const BUSY = new Set(['queued', 'starting', 'active']);

// A download Chrome holds as possibly dangerous waits for the person's decision: it keeps its row state but takes no slot and does not count as
// busy, so the next file starts and Chrome's own bubble (where Chrome asks) is shown. Chromium 1248 flags nothing (probe P6, 2026-11-18): only the
// unit tests and real Chrome exercise this.
const SAFE_DANGER = new Set(['safe', 'accepted']);

function setDanger(item, value) {
    if (value && !SAFE_DANGER.has(value)) item.danger = value;
    else delete item.danger;
}

const takesSlot = i => RUNNING.has(i.state) && !i.danger;
const isBusy = i => BUSY.has(i.state) && !i.danger;
const anyBusy = jobs => jobs.some(j => j.items.some(isBusy));

// Chrome's own download bubble is hidden while rows are waiting for a slot, starting or running, and shown again when none is (user, 2026-11-18:
// in the panel window, which has no toolbar, the bubble covers the panel's tabs). Paused and not-started rows do not count: a batch queued for later
// must not hide Chrome's downloads for days. Chrome keeps the setting across worker stops but not browser restarts (probe P1, 2026-11-18), so the
// first call of each worker life is always made. A refusal (another extension also controls it) is a warning, never a reason to stop.
async function syncUi(busy) {
    const current = workerLife();
    const enabled = !busy;
    if (current.uiEnabled === enabled) return;
    current.uiEnabled = enabled;
    if (typeof chrome.downloads.setUiOptions !== 'function') {
        console.warn('File Downloader: chrome.downloads.setUiOptions is missing; Chrome\'s download bubble stays as it is');
        return;
    }
    try {
        await chrome.downloads.setUiOptions({ enabled });
    } catch (error) {
        console.warn('File Downloader: could not switch Chrome\'s download bubble', enabled ? 'on:' : 'off:', error?.message || error);
    }
}

// fills free slots in batch order: resumes queued rows that own a paused download, marks the rest starting and starts them outside the chain; the
// download bubble is switched off before anything starts and on again when nothing is left to run
async function pumpLocked() {
    const { parallel } = await loadSettings();
    const jobs = await loadJobs();
    await settleOrphansLocked(jobs);
    await syncUi(anyBusy(jobs));
    let running = jobs.reduce((n, j) => n + j.items.filter(takesSlot).length, 0);
    let freed = false;
    for (const job of jobs) {
        if (running >= parallel) break;
        const starting = [];
        let changed = false;
        for (const item of job.items) {
            if (running >= parallel) break;
            if (item.state !== 'queued') continue;
            running++;
            changed = true;
            if (Number.isInteger(item.downloadId)) {
                const outcome = await resumeQueued(item);
                if (outcome === 'freed') {
                    running--;
                    freed = true;
                }
                if (outcome !== 'restart') continue;
            }
            item.state = 'starting';
            item.startedAt = Date.now();
            // each start gets its own number, so a late answer to an earlier start (canceled, then retried) cannot take over this one
            item.launch = (item.launch || 0) + 1;
            starting.push(item);
        }
        if (!changed) continue;
        await saveJob(job);
        for (const item of starting) launch(job.id, item.id, item.launch, item.url, job.conflict);
    }
    if (freed) await pumpLocked();
    else await syncUi(anyBusy(jobs));
}

function launch(jobId, itemId, token, url, conflict) {
    const key = launchKey(jobId, itemId, token);
    const launched = workerLife().launched;
    launched.add(key);
    const done = chrome.downloads.download({ url, conflictAction: conflict }).then(
        id => serial(() => commitStart(jobId, itemId, token, id)),
        error => serial(() => commitFailure(jobId, itemId, token, error)),
    );
    inflight.add(done);
    done.finally(() => {
        inflight.delete(done);
        launched.delete(key);
    });
}

async function startingRow(jobId, itemId, token) {
    const job = (await jobsMap()).get(jobId);
    const item = job?.items.find(i => i.id === itemId);
    return item?.state === 'starting' && item.launch === token ? { job, item } : null;
}

async function commitStart(jobId, itemId, token, downloadId) {
    const found = await startingRow(jobId, itemId, token);
    if (!found) {
        // canceled, removed or started again while the server was still answering: this download belongs to no row
        try {
            await chrome.downloads.cancel(downloadId);
        } catch {
            // already finished or gone
        }
        await pumpLocked();
        return;
    }
    const { job, item } = found;
    item.downloadId = downloadId;
    await applyCurrent(item, await downloadInfo(downloadId));
    await saveJob(job);
    await pumpLocked();
}

// a row that just got its download: events for that id that came before the id was stored found no row, so take the state Chrome reports now
async function applyCurrent(item, info) {
    item.state = 'active';
    setDanger(item, info?.danger);
    if (info?.state === 'complete') await finished(item, info);
    else if (info?.state === 'interrupted') await interrupted(item, info.error, info);
    else if (info?.paused) item.state = 'paused';
    else if (item.pauseOnStart) {
        // Pause all came while the server was still answering: paused, not canceled, so a one-time download link is not spent
        try {
            await chrome.downloads.pause(item.downloadId);
        } catch {
            // it may have finished in between; the next event says so
        }
        item.state = 'paused';
    }
    delete item.pauseOnStart;
}

// this extension's download for a row whose start an earlier worker made (its download() promise died with that worker; probe P3, 2026-11-18)
// a download another row already has is not taken again (two rows with one address would otherwise share one download)
async function ownDownloadFor(item) {
    const taken = new Set((await loadJobs()).flatMap(j => j.items.map(i => i.downloadId)).filter(Number.isInteger));
    return (await chrome.downloads.search({ url: item.url }))
        .find(d => d.byExtensionId === chrome.runtime.id && Date.parse(d.startTime) >= item.startedAt - 1000 && !taken.has(d.id));
}

// A start an earlier worker made and that never produced a download (the request died with that worker) would hold its slot, and keep Chrome's
// download bubble off, until the next browser start: after ORPHAN_MS it is adopted if its download exists by then, else queued again.
const ORPHAN_MS = 2 * 60 * 1000;

async function settleOrphansLocked(jobs) {
    for (const job of jobs) {
        let changed = false;
        for (const item of job.items) {
            if (item.state !== 'starting' || launchedHere(job, item) || Date.now() - item.startedAt < ORPHAN_MS) continue;
            const own = await ownDownloadFor(item);
            if (own) {
                item.downloadId = own.id;
                await applyCurrent(item, own);
            } else {
                requeue(item);
            }
            changed = true;
        }
        if (changed) await saveJob(job);
    }
}

async function commitFailure(jobId, itemId, token, error) {
    const found = await startingRow(jobId, itemId, token);
    if (found) {
        found.item.state = 'failed';
        found.item.error = String(error?.message || error);
        clearFlags(found.item);
        await saveJob(found.job);
    }
    await pumpLocked();
}

export const pump = () => serial(pumpLocked);

// start false (the Queue button): the rows are added paused without a download ("Not started") and wait for Start
export function enqueue({ pageUrl, pageTitle, items, folderTpl, nameTpl, conflict, start = true }) {
    return serial(async () => {
        const job = {
            id: randomId(), created: Date.now(), pageUrl, pageTitle, folderTpl, nameTpl, conflict,
            items: items.map((it, i) => ({ id: String(i), n: i + 1, url: it.url, text: it.text || '', state: start ? 'queued' : 'paused',
                downloadId: null, attempts: 0, error: '', filename: '', mime: '', target: '', startedAt: 0, launch: 0 })),
            targets: [],
        };
        // written at once, not batched: a job that cannot be stored must fail the request before any download starts
        await chrome.storage.local.set({ [`job:${job.id}`]: job });
        (await jobsMap()).set(job.id, job);
        await pumpLocked();
        return job.id;
    });
}

// the result of an interruption: resumed (retries left and Chrome can), canceled (the user did it in Chrome), else failed
async function interrupted(item, error, info) {
    const { retries } = await loadSettings();
    const code = error || info?.error || 'FAILED';
    if (code === 'USER_CANCELED') {
        item.state = 'canceled';
        clearFlags(item);
        // nothing arrived: most often Chrome's "Ask where to save each file" dialog was closed, or the download was refused at once
        item.error = info && !info.bytesReceived ? 'CANCELED_EARLY' : '';
        return;
    }
    if (info?.canResume && item.attempts < retries) {
        item.attempts++;
        try {
            await chrome.downloads.resume(item.downloadId);
            item.state = 'active';
            return;
        } catch {
            // fall through to failed with Chrome's code
        }
    }
    item.state = 'failed';
    item.error = code;
}

async function finished(item, info) {
    info ||= await downloadInfo(item.downloadId);
    item.state = 'done';
    delete item.danger;
    item.filename = info?.filename || item.filename;
    item.mime = info?.mime || '';
    item.error = '';
    await learnDownloadsDir(item);
}

// The Downloads folder's length, for the path limit (relativeLimit in naming.js): a finished file's absolute path minus as many parts as its
// relative path has (Chrome may change only the last part, " (1)" or a shortened name). Stored as downloadsDirLength in storage.local.
async function learnDownloadsDir(item) {
    if (!item.target || !item.filename) return;
    const parts = item.filename.split(/[\\/]/);
    const target = item.target.split('/');
    const depth = target.length;
    if (parts.length <= depth) return;
    // only a file saved in the folders it was given tells where Downloads is (Chrome saves a refused path in the Downloads root)
    const folders = parts.slice(-depth, -1).map(p => p.toLowerCase());
    if (folders.join('/') !== target.slice(0, -1).map(p => p.toLowerCase()).join('/')) return;
    const length = parts.slice(0, -depth).join('\\').length;
    if (length === await downloadsDirLength()) return;
    workerLife().dirLength = length;
    await chrome.storage.local.set({ downloadsDirLength: length });
}

async function downloadsDirLength() {
    const current = workerLife();
    if (current.dirLength === undefined) {
        const { downloadsDirLength: stored } = await chrome.storage.local.get('downloadsDirLength');
        current.dirLength = Number.isInteger(stored) ? stored : ASSUMED_DIR_LENGTH;
    }
    return current.dirLength;
}

export function onDownloadChanged(delta) {
    return serial(async () => {
        const found = await findByDownload(delta.id);
        if (!found) return;
        const { job, item } = found;
        if (delta.filename?.current) item.filename = delta.filename.current;
        if (delta.danger) setDanger(item, delta.danger.current);
        if (delta.paused) {
            if (delta.paused.current && item.state === 'active') item.state = 'paused';
            // resumed outside the panel (chrome://downloads), also while the row was waiting for a slot
            if (!delta.paused.current && (item.state === 'paused' || item.state === 'queued')) item.state = 'active';
        }
        if (delta.state?.current === 'complete') {
            await finished(item);
        } else if (delta.state?.current === 'interrupted') {
            // an event can trail behind a step that already handled this interruption (commitStart's re-read resumed it): act only while Chrome
            // still reports the download interrupted; a download Chrome no longer lists is judged by the event's own code
            const info = await downloadInfo(item.downloadId);
            if (!info || info.state === 'interrupted') await interrupted(item, delta.error?.current, info);
        }
        await saveJob(job);
        await pumpLocked();
    });
}

export function onDownloadErased(downloadId) {
    return serial(async () => {
        const found = await findByDownload(downloadId);
        if (!found) return;
        found.item.state = 'canceled';
        clearFlags(found.item);
        await saveJob(found.job);
        await pumpLocked();
    });
}

// a path the job never handed out before: "name (k).ext" from k = 1, compared without case (Windows). job.targets keeps every path given, also of
// rows cleared or removed since, because their files are still on disk. Chrome's uniquify only looks at files already on disk, and overwrite would
// let two files of the same batch replace each other (review probe, 2026-11-18).
function uniqueInJob(job, path) {
    job.targets ||= job.items.filter(i => i.target).map(i => i.target.toLowerCase());
    const taken = new Set(job.targets);
    let result = path;
    if (taken.has(path.toLowerCase())) {
        const slash = path.lastIndexOf('/');
        const dir = path.slice(0, slash + 1);
        const { name, ext } = splitName(path.slice(slash + 1));
        for (let k = 1; taken.has(result.toLowerCase()); k++) result = `${dir}${name} (${k})${ext ? `.${ext}` : ''}`;
    }
    job.targets.push(result.toLowerCase());
    return result;
}

// The name Chrome should save an own download under, or undefined for a download this queue did not start. Chrome calls onDeterminingFilename after
// download() has resolved (probe, 2026-11-18); the id is usually committed by then, and matching by address among starting items covers the rest.
export function suggestName(downloadItem) {
    return serial(async () => {
        const jobs = await loadJobs();
        let job;
        let item;
        for (const j of jobs) {
            item = j.items.find(i => i.downloadId === downloadItem.id && UNFINISHED.has(i.state));
            if (item) {
                job = j;
                break;
            }
        }
        if (!item) {
            for (const j of jobs) {
                item = j.items.find(i => i.state === 'starting' && (i.url === downloadItem.url || i.url === downloadItem.finalUrl));
                if (item) {
                    job = j;
                    break;
                }
            }
        }
        if (!item) return undefined;
        if (item.state === 'starting' && !launchedHere(job, item)) {
            // started by a worker that stopped before the server answered: Chrome made the download when the headers came, and this is the
            // first this worker hears of it (probe P3, 2026-11-18)
            item.downloadId = downloadItem.id;
            item.state = 'active';
            if (item.pauseOnStart) {
                try {
                    await chrome.downloads.pause(item.downloadId);
                    item.state = 'paused';
                } catch {
                    // it may have finished in between; the next event says so
                }
            }
            delete item.pauseOnStart;
            await saveJob(job);
        }
        if (!item.target) {
            const { name, ext } = splitName(downloadItem.filename);
            const stamp = batchStamp(new Date(job.created));
            const path = buildPath({ folderTpl: job.folderTpl, nameTpl: job.nameTpl },
                { name, ext, text: item.text, title: job.pageTitle, host: hostOf(job.pageUrl), n: item.n, date: stamp.date, time: stamp.time },
                relativeLimit(await downloadsDirLength()));
            item.target = uniqueInJob(job, path);
            await saveJob(job);
        }
        return { filename: item.target, conflictAction: job.conflict };
    });
}

// a queued row can own a paused download too (it waits for a slot to resume it)
async function stopItem(item, how) {
    if (Number.isInteger(item.downloadId) && UNFINISHED.has(item.state)) {
        try {
            await chrome.downloads[how](item.downloadId);
        } catch {
            // already finished or gone; the state set by the caller is what the user asked for
        }
    }
}

// Resume and Retry only put the row back in line; pumpLocked resumes its download, or starts it, when a slot is free ("Downloads at once" holds)
async function resumeItem(item) {
    if (item.state === 'paused') {
        item.state = 'queued';
        return;
    }
    if (item.state === 'failed' || item.state === 'canceled') {
        const info = await downloadInfo(item.downloadId);
        if (info?.canResume) Object.assign(item, { state: 'queued', attempts: 0, error: '' });
        else requeue(item);
    }
}

export function itemAction(jobId, itemId, action) {
    return serial(async () => {
        const job = (await jobsMap()).get(jobId);
        const item = job?.items.find(i => i.id === itemId);
        if (!item) return;
        if (action === 'pause') {
            if (item.state === 'active') await stopItem(item, 'pause');
            if (item.state === 'active' || item.state === 'queued') item.state = 'paused';
        } else if (action === 'resume' || action === 'retry' || action === 'start') {
            await resumeItem(item);
        } else if (action === 'cancel') {
            if (UNFINISHED.has(item.state)) {
                await cancelRow(item);
            }
        } else if (action === 'remove') {
            if (UNFINISHED.has(item.state)) await stopItem(item, 'cancel');
            job.items = job.items.filter(i => i !== item);
        }
        await storeJob(job);
        await pumpLocked();
    });
}

// Pause all pauses each row: running ones in Chrome, waiting ones in place (a row that owns a paused download keeps it), and a row whose server is
// still answering is paused as soon as its download exists. Resume all puts paused rows back in line; Retry failed does that for failed rows only
// (canceled ones were the user's choice).
async function applyJobAction(job, action) {
    if (action === 'pauseAll') {
        for (const item of job.items) {
            if (item.state === 'active') await stopItem(item, 'pause');
            if (item.state === 'active' || item.state === 'queued') item.state = 'paused';
            if (item.state === 'starting') item.pauseOnStart = true;
        }
    } else if (action === 'resumeAll') {
        for (const item of job.items) {
            if (item.state === 'paused') await resumeItem(item);
            delete item.pauseOnStart;
        }
    } else if (action === 'retryFailed') {
        for (const item of job.items) if (item.state === 'failed') await resumeItem(item);
    } else if (action === 'cancelAll') {
        for (const item of job.items) {
            if (UNFINISHED.has(item.state)) {
                await cancelRow(item);
            }
        }
    } else if (action === 'clearFinished') {
        job.items = job.items.filter(i => i.state !== 'done' && i.state !== 'canceled');
    }
    await storeJob(job);
}

export function jobAction(jobId, action) {
    return serial(async () => {
        const job = (await jobsMap()).get(jobId);
        if (!job) return;
        await applyJobAction(job, action);
        await pumpLocked();
    });
}

// Start everything / Pause everything on the Downloads page
export function allJobsAction(action) {
    return serial(async () => {
        if (action !== 'pauseAll' && action !== 'resumeAll') throw new Error(`unknown action ${action}`);
        for (const job of await loadJobs()) await applyJobAction(job, action);
        await pumpLocked();
    });
}

// a row the user paused stays paused across a restart: Chrome reports a paused download as interrupted USER_CANCELED after a restart (review
// probe, 2026-11-18); when it cannot be resumed the row keeps no download, and Resume queues it again
function reconcilePaused(item, info) {
    if (!info || info.state === 'interrupted' && !info.canResume) {
        item.downloadId = null;
        item.state = 'paused';
    } else if (info.state === 'complete') {
        return 'finished';
    } else {
        item.state = 'paused';
    }
    return null;
}

// At browser start (and install): bring every item that was running into line with what Chrome now reports, then start what may start.
export const reconcile = () => serial(reconcileLocked);

async function reconcileLocked() {
    for (const job of await loadJobs()) {
        for (const item of job.items) {
            if (item.state === 'starting') {
                // a start this worker is still waiting on is left to its own commit
                if (launchedHere(job, item)) continue;
                const own = await ownDownloadFor(item);
                if (!own) {
                    requeue(item);
                    continue;
                }
                item.downloadId = own.id;
                item.state = 'active';
            }
            if (item.state === 'paused') {
                if (!item.downloadId) continue;
                const info = await downloadInfo(item.downloadId);
                if (reconcilePaused(item, info) === 'finished') await finished(item, info);
                continue;
            }
            if (item.state !== 'active') continue;
            const info = await downloadInfo(item.downloadId);
            if (!info) {
                item.state = 'failed';
                item.error = 'GONE';
            } else if (info.state === 'complete') {
                await finished(item, info);
            } else if (info.state === 'in_progress') {
                item.state = info.paused ? 'paused' : 'active';
            } else if (info.canResume) {
                try {
                    await chrome.downloads.resume(item.downloadId);
                    item.state = 'active';
                } catch {
                    requeue(item);
                }
            } else if (STOPPED_BY_BROWSER.has(info.error)) {
                requeue(item);
            } else {
                item.state = 'failed';
                item.error = info.error || 'FAILED';
            }
        }
        await saveJob(job);
    }
    await pumpLocked();
}

// A worker that wakes within a browser session: the event that woke it comes right after this, so only what cannot be a live event is fixed here:
// starts an earlier worker left behind are adopted, downloads that finished meanwhile are marked done. Interrupted rows are left to their events.
async function wakeCheckLocked() {
    for (const job of await loadJobs()) {
        let changed = false;
        for (const item of job.items) {
            if (item.state === 'starting' && !launchedHere(job, item)) {
                const own = await ownDownloadFor(item);
                if (own) {
                    item.downloadId = own.id;
                    await applyCurrent(item, own);
                    changed = true;
                }
            } else if (UNFINISHED.has(item.state) && Number.isInteger(item.downloadId)) {
                const info = await downloadInfo(item.downloadId);
                if (info?.state === 'complete') {
                    await finished(item, info);
                    changed = true;
                }
            }
        }
        if (changed) await saveJob(job);
    }
    await pumpLocked();
}

// Runs once per worker life, called at the worker's start (enabling the extension starts the worker with no onInstalled or onStartup; probe P4,
// 2026-11-18). The full reconcile runs once per browser session: storage.session is empty after a browser start, a reload and a disable/enable,
// exactly when downloads may have been stopped by the browser. Resolves true the first time in a worker life.
export function ensureSession() {
    const current = workerLife();
    if (current.checked) return Promise.resolve(false);
    current.checked = true;
    return serial(async () => {
        const { reconciled } = await chrome.storage.session.get('reconciled');
        if (reconciled) {
            await wakeCheckLocked();
        } else {
            await reconcileLocked();
            await chrome.storage.session.set({ reconciled: true });
        }
        return true;
    });
}

export const listJobs = () => serial(async () => structuredClone(await loadJobs()));

export const unfinishedCount = () => serial(async () => (await loadJobs()).reduce((n, j) => n + j.items.filter(i => UNFINISHED.has(i.state)).length, 0));

// unfinished: every row still to do (the badge number, the tab's "left"); busy: rows waiting for a slot, starting or running (not paused ones)
export const counts = () => serial(async () => {
    const items = (await loadJobs()).flatMap(j => j.items);
    return { unfinished: items.filter(i => UNFINISHED.has(i.state)).length, busy: items.filter(isBusy).length };
});
