// The Downloads view's decisions without the DOM: what a row shows and which buttons a row and a job offer.

import { extOf } from '../lib/links.js';
import { splitName } from '../lib/naming.js';

const BUTTONS = {
    queued: ['pause', 'cancel', 'remove'],
    starting: ['cancel'],
    active: ['pause', 'cancel'],
    paused: ['resume', 'cancel', 'remove'],
    done: ['show', 'remove'],
    failed: ['retry', 'remove'],
    canceled: ['retry', 'remove'],
};

const UNFINISHED = new Set(['queued', 'starting', 'active', 'paused']);
const BUSY = new Set(['queued', 'starting', 'active']);

// a paused row without a download was added by Queue (or paused while waiting) and has not started yet
const notStarted = item => item.state === 'paused' && !Number.isInteger(item.downloadId);

// live: the chrome.downloads item while it is in progress, if known. stateKey: the message key of the state text (failed rows add their error).
export function rowModel(item, live) {
    let name = item.text || item.url;
    if (item.filename) {
        const { name: base, ext } = splitName(item.filename);
        name = ext ? `${base}.${ext}` : base;
    }
    let progress = null;
    if (item.state === 'done') progress = { percent: 100, received: null, total: null };
    else if (live) {
        progress = { percent: live.totalBytes > 0 ? Math.floor((live.bytesReceived / live.totalBytes) * 100) : null, received: live.bytesReceived,
            total: live.totalBytes };
    }
    // a link that is not a web page but brought one back: most often a sign-in page instead of the file
    const ext = extOf(item.url);
    const warning = item.state === 'done' && /^text\/html/.test(item.mime || '') && ext !== 'html' && ext !== 'htm';
    // Chrome canceled it before a byte arrived: most often its "Ask where to save each file" dialog
    const hint = item.state === 'canceled' && item.error === 'CANCELED_EARLY';
    const fresh = notStarted(item);
    // Chrome holds the file as possibly dangerous: Keep asks Chrome's own question (acceptDanger), Cancel discards it
    const danger = Boolean(item.danger) && UNFINISHED.has(item.state);
    return {
        name,
        buttons: danger ? ['keep', 'cancel'] : fresh ? ['start', 'cancel', 'remove'] : BUTTONS[item.state] || [],
        danger,
        stateKey: fresh ? 'state_notStarted' : `state_${item.state}`,
        progress,
        warning,
        hint,
    };
}

// Show in folder: 'show' when Chrome still lists this row's download and the file is there; 'gone' when Chrome no longer lists it (erased from its
// list, or the id now belongs to another download); 'missing' when the file was moved or deleted
export function showPlan(item, found) {
    if (!found || (item.filename && found.filename !== item.filename)) return 'gone';
    if (found.exists === false) return 'missing';
    return 'show';
}

// what a drawn row shows apart from its progress (the progress tick updates that in place): a row is drawn again only when this changes, so a
// redraw keeps keyboard focus and does not swallow a click on an unchanged row
export function rowSignature(item, model) {
    return JSON.stringify([item.state, item.error, item.downloadId ?? null, model.name, model.stateKey, model.buttons, model.warning, model.hint,
        model.danger]);
}

// which rows to draw: all of a job up to `cap`; beyond that, running and paused rows first, then failed, waiting (and not started) and finished
// ones, shown in batch order (drawing thousands of rows on every change made big batches crawl; review probe, 2026-11-18)
const TIERS = [
    i => (i.state === 'active' || i.state === 'starting' || i.state === 'paused') && !notStarted(i),
    i => i.state === 'failed',
    i => i.state === 'queued' || notStarted(i),
    i => i.state === 'done' || i.state === 'canceled',
];

export function visibleItems(items, cap) {
    if (items.length <= cap) return items;
    const chosen = [];
    for (const inTier of TIERS) {
        for (const item of items) {
            if (chosen.length >= cap) break;
            if (inTier(item)) chosen.push(item);
        }
    }
    return chosen.sort((a, b) => a.n - b.n);
}

export function jobButtons(job) {
    const has = test => job.items.some(i => test(i.state));
    return {
        pauseAll: has(s => BUSY.has(s)),
        resumeAll: has(s => s === 'paused'),
        retryFailed: has(s => s === 'failed'),
        cancelAll: has(s => UNFINISHED.has(s)),
        clearFinished: has(s => s === 'done' || s === 'canceled'),
    };
}

// "Start all" when nothing of the job was paused in the middle of a file (rows added by Queue), else "Resume all"
export function resumeLabel(job) {
    return job.items.some(i => i.state === 'paused' && Number.isInteger(i.downloadId)) || !job.items.some(notStarted) ? 'job_resumeAll' : 'job_startAll';
}

// Start everything / Pause everything on the Downloads page
export function allButtons(jobs) {
    const items = jobs.flatMap(j => j.items);
    return { start: items.some(i => i.state === 'paused'), pause: items.some(i => BUSY.has(i.state)) };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const ONE_DECIMAL = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

// units: the five unit names, from the message byte_units in the panel
export function formatBytes(n, units = UNITS) {
    if (!Number.isFinite(n) || n < 0) return '?';
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024;
        unit++;
    }
    return `${ONE_DECIMAL.format(n)} ${units[unit]}`;
}
