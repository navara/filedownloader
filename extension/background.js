// Wiring only: every listener is added synchronously at the top level, so Chrome finds them when it wakes the worker for an event.

import { mergeScan } from './lib/links.js';
import { saveSettings, validSetting } from './lib/settings.js';
import * as queue from './lib/queue.js';

const PANEL = 'panel/panel.html';
const KEEP_SCANS = 5;

chrome.action.onClicked.addListener(tab => openScan(tab));

chrome.runtime.onMessage.addListener((message, sender, reply) => {
    handle(message).then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: String(error?.message || error) }));
    return true;
});

// only downloads this extension started are renamed; for any other the listener returns without calling suggest, so Chrome keeps its own name
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (item.byExtensionId !== chrome.runtime.id) return false;
    queue.suggestName(item).then(s => (s ? suggest(s) : suggest()), () => suggest());
    return true;
});

// a queue step that fails (a storage write over quota, say) must show in the worker's console, not vanish as an unhandled rejection
const logged = promise => promise.catch(error => console.error('File Downloader:', error));

chrome.downloads.onChanged.addListener(delta => logged(queue.onDownloadChanged(delta)));
chrome.downloads.onErased.addListener(id => logged(queue.onDownloadErased(id)));
// the session check (queue.ensureSession) runs once per worker life; it starts here, at the top level, because enabling the extension starts the
// worker without onInstalled or onStartup (probe P4, 2026-11-18). The first check of a life also refreshes the badge: after a restart with only
// paused files nothing changes in storage, so the storage listener below would not.
const checkSession = () => logged(queue.ensureSession().then(first => first && updateBadge()));

chrome.runtime.onStartup.addListener(checkSession);
chrome.runtime.onInstalled.addListener(checkSession);
checkSession();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(k => k.startsWith('job:'))) updateBadge();
});

async function handle(message) {
    switch (message?.type) {
        case 'enqueue': {
            const { pageUrl, pageTitle, items, folderTpl, nameTpl, conflict, parallel, retries } = message;
            // the panel refuses these already; a template the settings would reject must not be swapped for the stored one behind the preview
            if (!validSetting('folderTpl', folderTpl) || !validSetting('nameTpl', nameTpl)) throw new Error('tpl_too_long');
            // the limits set on the Select view travel with the request, so they are stored before the first download starts
            const settings = await saveSettings({ folderTpl, nameTpl, conflict, parallel, retries });
            const jobId = await queue.enqueue({ pageUrl, pageTitle, items, folderTpl: settings.folderTpl, nameTpl: settings.nameTpl,
                conflict: settings.conflict, start: message.start !== false });
            return { jobId };
        }
        case 'jobs':
            await queue.allJobsAction(message.action);
            return {};
        case 'item':
            await queue.itemAction(message.jobId, message.itemId, message.action);
            return {};
        case 'job':
            await queue.jobAction(message.jobId, message.action);
            return {};
        case 'settings': {
            const settings = await saveSettings(message.patch || {});
            await queue.pump();
            return { settings };
        }
        default:
            throw new Error(`unknown message ${message?.type}`);
    }
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');

async function openScan(tab) {
    const id = randomId();
    let scan;
    try {
        // Chrome now and then answers at once with no frames at all although the page is loaded, and the same call works a moment later (frames
        // probe, 2026-11-18: 2 of 64 toolbar clicks); a page always has its top frame, so an empty list is asked again a few times
        let results = [];
        for (let attempt = 0; attempt < 4; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
            results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['scan.js'] });
            if (results.length) break;
        }
        const ordered = [...results].sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0)).map(r => r.result);
        scan = mergeScan(ordered);
        // the worker stores codes, the panel turns them into text (t('scan_<code>')); Chrome's own error messages are kept as they come
        if (!scan.frameCount) scan.errorCode = 'nothing';
    } catch (e) {
        scan = { error: String(e?.message || e), items: [], skipped: {}, frameCount: 0, unreadFrames: 0, pageUrl: '', title: '' };
    }
    scan.pageUrl ||= tab.url || '';
    scan.title ||= tab.title || '';
    scan.created = Date.now();
    // a scan that does not fit (session storage holds 10 MB) is stored again after the older scans are dropped, and when even that fails the panel
    // opens with the reason instead of the click doing nothing
    try {
        await storeScan(id, scan);
    } catch (error) {
        console.warn('File Downloader: storing the scan failed, dropping older scans:', error?.message || error);
        try {
            await dropScans();
            await chrome.storage.session.set({ [`scan:${id}`]: scan });
        } catch {
            const reason = { errorCode: 'too_big', items: [], skipped: {}, frameCount: 0, unreadFrames: 0, pageUrl: scan.pageUrl, title: scan.title,
                created: scan.created };
            await logged(chrome.storage.session.set({ [`scan:${id}`]: reason }));
        }
    }
    await logged(showPanel(id));
}

async function dropScans() {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('scan:'));
    if (keys.length) await chrome.storage.session.remove(keys);
}

async function storeScan(id, scan) {
    const all = await chrome.storage.session.get(null);
    const old = Object.entries(all).filter(([k]) => k.startsWith('scan:')).sort((a, b) => b[1].created - a[1].created).slice(KEEP_SCANS - 1);
    if (old.length) await chrome.storage.session.remove(old.map(([k]) => k));
    await chrome.storage.session.set({ [`scan:${id}`]: scan });
}

// one panel window: a click while it is open loads the new scan into it and brings it to the front
async function showPanel(scanId) {
    const url = chrome.runtime.getURL(`${PANEL}?scan=${scanId}`);
    const { panelWindowId } = await chrome.storage.session.get('panelWindowId');
    if (panelWindowId) {
        try {
            const [tab] = await chrome.tabs.query({ windowId: panelWindowId });
            if (tab) {
                await chrome.tabs.update(tab.id, { url });
                await chrome.windows.update(panelWindowId, { focused: true });
                return;
            }
        } catch {
            // the window is gone; open a new one
        }
    }
    const win = await chrome.windows.create({ url, type: 'popup', width: 960, height: 760 });
    await chrome.storage.session.set({ panelWindowId: win.id });
}

let badgeTimer = 0;

// the number of unfinished files (as the panel's "N left"); blue while something runs or waits for a slot, grey when only paused or not-started
// files remain, so "waiting for you" looks different from "working"
function updateBadge() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(async () => {
        const { unfinished, busy } = await queue.counts();
        await chrome.action.setBadgeBackgroundColor({ color: busy ? '#1d5fa3' : '#6b6b6b' });
        await chrome.action.setBadgeText({ text: unfinished ? String(unfinished) : '' });
    }, 200);
}
