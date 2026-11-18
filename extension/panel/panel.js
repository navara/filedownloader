// The panel window: the Select view for the scan named in ?scan=<id>, and the Downloads view of the queue. The panel only reads storage and sends
// commands; the worker owns the queue.

import { localize, t } from '../lib/i18n.js';
import { loadSettings } from '../lib/settings.js';
import { $, showLoadError } from '../ui/dom.js';
import { initSelect } from './select.js';
import { initDownloads } from './downloads.js';

export function showView(name) {
    for (const [tab, view] of [['tabSelect', 'viewSelect'], ['tabDownloads', 'viewDownloads']]) {
        const on = view === `view${name}`;
        $(`#${tab}`).setAttribute('aria-selected', String(on));
        $(`#${view}`).hidden = !on;
    }
    document.dispatchEvent(new CustomEvent('viewchange', { detail: name }));
}

async function start() {
    localize();
    $('#tabSelect').addEventListener('click', () => showView('Select'));
    $('#tabDownloads').addEventListener('click', () => showView('Downloads'));
    const scanId = new URLSearchParams(location.search).get('scan');
    const [stored, settings] = await Promise.all([scanId ? chrome.storage.session.get(`scan:${scanId}`) : {}, loadSettings()]);
    const scan = stored[`scan:${scanId}`];
    await initDownloads(settings);
    if (!scan) {
        $('#tabSelect').textContent = t('tab_select', 0);
        $('#viewSelect').hidden = true;
        showView('Downloads');
        return;
    }
    $('#pageInfo').textContent = scan.title || scan.pageUrl;
    $('#pageInfo').title = scan.pageUrl;
    initSelect(scan, settings);
}

start().catch(showLoadError);
