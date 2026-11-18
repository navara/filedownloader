// The Select view: filters over the scanned addresses, the ticked set, the name rule with a preview, and the Download button.

import { t } from '../lib/i18n.js';
import { compileFilter, facets } from '../lib/links.js';
import { batchStamp, relativeLimit, ASSUMED_DIR_LENGTH } from '../lib/naming.js';
import { validSetting } from '../lib/settings.js';
import { $, el, send, toast, errorText } from '../ui/dom.js';
import { Selection, previewLines } from './select-model.js';
import { initLimits } from './limits.js';
import { showView } from './panel.js';

const MAX_ROWS = 1000;

let scan;
let limits;
// the Downloads folder length the worker learned (storage.local downloadsDirLength), for the preview's path limit
let dirLength = ASSUMED_DIR_LENGTH;
let matches = [];
const selection = new Selection();
const pressedExts = new Set();

const shownIds = () => matches.slice(0, MAX_ROWS).map(i => i.id);

function readFilter() {
    const kinds = [['kLink', 'link'], ['kImage', 'image'], ['kMedia', 'media']].filter(([id]) => $(`#${id}`).checked).map(([, kind]) => kind);
    return { text: $('#fText').value, textRegex: $('#fTextRe').checked, url: $('#fUrl').value, urlRegex: $('#fUrlRe').checked, kinds,
        exts: [...pressedExts] };
}

function showError(input, box, message) {
    $(box).textContent = message || '';
    if (message) $(input).setAttribute('aria-invalid', 'true');
    else $(input).removeAttribute('aria-invalid');
}

function renderChips() {
    $('#chips').replaceChildren(...facets(scan.items).map(({ ext, count }) => el('button', {
        text: `${ext || t('type_none')} ${count}`,
        data: { ext },
        attrs: { type: 'button', 'aria-pressed': String(pressedExts.has(ext)), ...(ext ? {} : { title: t('type_none_title') }) },
    })));
}

function row(item) {
    return el('tr', { data: { id: item.id } },
        el('td', {}, el('input', { className: 'pick', attrs: { type: 'checkbox', 'aria-label': item.text || item.url } })),
        el('td', { text: item.text, attrs: { dir: 'auto', title: item.text } }),
        el('td', { className: 'address', text: item.url, attrs: { title: item.url } }),
        el('td', { text: item.ext || '-' }),
        el('td', { text: t(`kind_${item.kind}`) }));
}

function applyFilter() {
    const filter = compileFilter(readFilter());
    showError('#fText', '#fTextError', filter.errors.text);
    showError('#fUrl', '#fUrlError', filter.errors.url);
    matches = scan.items.filter(filter.test);
    $('#items').replaceChildren(...matches.slice(0, MAX_ROWS).map(row));
    $('#emptyList').hidden = matches.length > 0;
    $('#capNotice').textContent = t('cap_notice', MAX_ROWS, matches.length);
    $('#capNotice').hidden = matches.length <= MAX_ROWS;
    syncPicks();
}

function syncPicks() {
    for (const r of $('#items').rows) r.querySelector('.pick').checked = selection.has(r.dataset.id);
    const ids = shownIds();
    const n = selection.countIn(ids);
    $('#pickAll').checked = ids.length > 0 && n === ids.length;
    $('#pickAll').indeterminate = n > 0 && n < ids.length;
    $('#counter').textContent = t('counter', matches.length, scan.items.length, selection.size);
    $('#download').textContent = t('download_n', selection.size);
    $('#queue').textContent = t('queue_n', selection.size);
    $('#download').disabled = $('#queue').disabled = selection.size === 0 || !limits.valid() || !templatesValid();
    renderPreview();
}

// maxlength stops typing, not pasting into a script-filled field; the settings check is the rule (at most 200 characters)
function templatesValid() {
    let ok = true;
    for (const [id, key] of [['folderTpl', 'folderTpl'], ['nameTpl', 'nameTpl']]) {
        const bad = !validSetting(key, $(`#${id}`).value);
        $(`#${id}Error`).textContent = bad ? t('tpl_too_long', 200) : '';
        if (bad) $(`#${id}`).setAttribute('aria-invalid', 'true');
        else $(`#${id}`).removeAttribute('aria-invalid');
        ok &&= !bad;
    }
    return ok;
}

function pageVars() {
    let host = '';
    try {
        host = new URL(scan.pageUrl).host;
    } catch {
        // a page without a web address keeps {host} empty
    }
    return { title: scan.title, host, ...batchStamp(new Date()) };
}

function renderPreview() {
    const picked = scan.items.filter(i => selection.has(i.id));
    const lines = previewLines(picked, { folderTpl: $('#folderTpl').value, nameTpl: $('#nameTpl').value }, pageVars(), t('server_name'), 3,
        relativeLimit(dirLength));
    $('#preview').replaceChildren(...lines.map(line => el('li', { text: line, attrs: { dir: 'auto', title: line } })));
}

// start false (Queue): the files are added without starting and the Select view stays, so more can be picked (from this page or another)
async function download(start) {
    const items = scan.items.filter(i => selection.has(i.id)).map(i => ({ url: i.url, text: i.text }));
    $('#download').disabled = $('#queue').disabled = true;
    try {
        await send({ type: 'enqueue', pageUrl: scan.pageUrl, pageTitle: scan.title, items, folderTpl: $('#folderTpl').value,
            nameTpl: $('#nameTpl').value, conflict: $('#conflict').value, start, ...limits.values() });
        toast(t(start ? 'enqueued' : 'queued_n', items.length));
        selection.clear();
        syncPicks();
        if (start) showView('Downloads');
    } catch (e) {
        toast(errorText(e), true);
        syncPicks();
    }
}

export function initSelect(theScan, settings) {
    scan = theScan;
    $('#tabSelect').textContent = t('tab_select', scan.items.length);
    $('#folderTpl').value = settings.folderTpl;
    $('#nameTpl').value = settings.nameTpl;
    $('#conflict').value = settings.conflict;
    limits = initLimits({ parallel: 'selParallel', retries: 'selRetries' }, settings, () => syncPicks());
    for (const id of ['#selParallel', '#selRetries']) $(id).addEventListener('input', syncPicks);
    chrome.storage.local.get('downloadsDirLength').then(({ downloadsDirLength }) => {
        if (!Number.isInteger(downloadsDirLength)) return;
        dirLength = downloadsDirLength;
        renderPreview();
    });
    const notes = [];
    if (scan.error) notes.push(t('scan_error', scan.error));
    if (scan.errorCode) notes.push(t(`scan_${scan.errorCode}`));
    if (scan.unreadFrames) notes.push(t('note_unread', scan.unreadFrames));
    const skipped = Object.entries(scan.skipped || {}).filter(([k]) => k !== 'javascript:').map(([k, n]) => `${k} ${n}`).join(', ');
    if (skipped) notes.push(t('note_skipped', skipped));
    $('#scanNote').textContent = notes.join(' ');
    $('#scanNote').hidden = notes.length === 0;

    for (const id of ['#fText', '#fUrl']) $(id).addEventListener('input', applyFilter);
    for (const id of ['#fTextRe', '#fUrlRe', '#kLink', '#kImage', '#kMedia']) $(id).addEventListener('change', applyFilter);
    $('#chips').addEventListener('click', e => {
        const chip = e.target.closest('button');
        if (!chip) return;
        const ext = chip.dataset.ext;
        if (pressedExts.has(ext)) pressedExts.delete(ext);
        else pressedExts.add(ext);
        chip.setAttribute('aria-pressed', String(pressedExts.has(ext)));
        applyFilter();
    });

    // a click anywhere on a row ticks it; with shift, every row from the last clicked one
    $('#items').addEventListener('click', e => {
        const r = e.target.closest('tr');
        if (!r) return;
        const box = r.querySelector('.pick');
        const on = e.target === box ? box.checked : !box.checked;
        selection.click(shownIds(), r.dataset.id, on, e.shiftKey);
        syncPicks();
    });
    $('#pickAll').addEventListener('change', e => {
        selection.setAll(shownIds(), e.target.checked);
        syncPicks();
    });
    $('#selectShown').addEventListener('click', () => {
        selection.setAll(matches.map(i => i.id), true);
        syncPicks();
    });
    $('#clearSelection').addEventListener('click', () => {
        selection.clear();
        syncPicks();
    });
    for (const id of ['#folderTpl', '#nameTpl']) $(id).addEventListener('input', syncPicks);
    $('#download').addEventListener('click', () => download(true));
    $('#queue').addEventListener('click', () => download(false));
    renderChips();
    applyFilter();
}
