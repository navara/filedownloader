// The Downloads view: one block per job, one row per file, redrawn when the jobs in storage change; byte progress is read from chrome.downloads once a
// second while the view is on screen. Buttons send commands to the worker, which owns the queue.

import { t } from '../lib/i18n.js';
import { initLimits } from './limits.js';
import { $, el, send, toast, errorText, watchStorage } from '../ui/dom.js';
import { rowModel, jobButtons, formatBytes, visibleItems, resumeLabel, allButtons, rowSignature, showPlan } from './downloads-model.js';

const UNFINISHED = new Set(['queued', 'starting', 'active', 'paused']);
const MAX_ROWS = 300;

let jobs = [];
// the drawn rows: "<jobId>/<itemId>" to the item, for the progress tick
let drawn = new Map();
let live = new Map();
let timer = 0;

async function loadJobs() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).filter(([k]) => k.startsWith('job:')).map(([, v]) => v).sort((a, b) => b.created - a.created);
}

function stateText(item, model) {
    return item.state === 'failed' ? t('state_failed', item.error || '?') : t(model.stateKey);
}

function meta(item, model) {
    const box = el('span', { className: 'item-meta' }, el('span', { className: 'item-state', text: stateText(item, model) }));
    const p = model.progress;
    if (p && item.state !== 'done') {
        const bar = el('progress', { attrs: { max: '100' } });
        if (p.percent !== null) bar.value = p.percent;
        const units = t('byte_units').split(' ');
        const size = n => formatBytes(n, units);
        box.append(bar, el('span', { className: 'item-bytes', text: p.total > 0 ? t('bytes_of', size(p.received), size(p.total)) : size(p.received) }));
    }
    return box;
}

function renderItem(job, item, model = rowModel(item, live.get(item.downloadId))) {
    return el('li', { data: { item: item.id, state: item.state, sig: rowSignature(item, model),
        ...(item.downloadId ? { download: String(item.downloadId) } : {}) } },
        el('span', { className: 'item-name', text: model.name, attrs: { dir: 'auto', title: item.url } }),
        el('span', { className: 'item-actions' }, ...model.buttons.map(action => el('button', { text: t(`btn_${action}`),
            data: { action }, attrs: { type: 'button' } }))),
        meta(item, model),
        model.warning ? el('p', { className: 'item-warning', text: t('warn_html') }) : null,
        model.hint ? el('p', { className: 'item-warning', text: t('hint_canceled_early') }) : null,
        model.danger ? el('p', { className: 'item-warning', text: t('warn_danger') }) : null);
}

function jobHead(job) {
    const done = job.items.filter(i => i.state === 'done').length;
    return el('div', { className: 'job-head' },
        el('p', { className: 'job-title', text: job.pageTitle || job.pageUrl, attrs: { dir: 'auto', title: job.pageUrl } }),
        el('span', { className: 'job-counts', text: t('job_counts', done, job.items.length) }),
        ...Object.entries(jobButtons(job)).map(([action, on]) => {
            const label = action === 'resumeAll' ? resumeLabel(job) : `job_${action}`;
            const b = el('button', { text: t(label), data: { jobAction: action }, attrs: { type: 'button' } });
            b.disabled = !on;
            return b;
        }));
}

// The head's counts, labels and enabled buttons, changed in place: a button taken out of the page between mouse press and release gets no click
// (review probe, 2026-11-18), and Pause all or Cancel all are pressed exactly while rows change. A focused button that becomes disabled hands focus
// to the next enabled one of the head.
function updateHead(head, job) {
    const done = job.items.filter(i => i.state === 'done').length;
    head.querySelector('.job-counts').textContent = t('job_counts', done, job.items.length);
    const buttons = [...head.querySelectorAll('button[data-job-action]')];
    for (const [action, on] of Object.entries(jobButtons(job))) {
        const button = head.querySelector(`button[data-job-action="${action}"]`);
        button.textContent = t(action === 'resumeAll' ? resumeLabel(job) : `job_${action}`);
        if (!on && document.activeElement === button) buttons.find(b => b !== button && !b.disabled)?.focus();
        button.disabled = !on;
    }
}

// Makes parent's children exactly `wanted`, in order, without taking any node out that stays: unwanted nodes go first, then a cursor walks the
// list and only new or misplaced nodes are inserted (inserting before a stale node shifted every later row before; review probe, 2026-11-18)
function placeChildren(parent, wanted) {
    const keep = new Set(wanted);
    for (const node of [...parent.children]) if (!keep.has(node)) node.remove();
    let cursor = parent.firstElementChild;
    for (const node of wanted) {
        if (node === cursor) cursor = cursor.nextElementSibling;
        else parent.insertBefore(node, cursor);
    }
}

// Brings a job's section up to date, reusing the rows whose signature did not change (a redraw then keeps keyboard focus on them and a click on
// them is not lost); a section seen for the first time is built whole.
function updateJob(section, job) {
    const rows = visibleItems(job.items, MAX_ROWS);
    for (const item of rows) drawn.set(`${job.id}/${item.id}`, item);
    const cappedText = rows.length < job.items.length ? t('rows_capped', rows.length, job.items.length) : '';
    if (!section) {
        return el('section', { className: 'job', data: { job: job.id } }, jobHead(job),
            el('p', { className: 'job-capped', text: cappedText, attrs: cappedText ? {} : { hidden: '' } }),
            el('ul', { className: 'job-items' }, ...rows.map(item => renderItem(job, item))));
    }
    updateHead(section.querySelector('.job-head'), job);
    const capped = section.querySelector('.job-capped');
    capped.textContent = cappedText;
    capped.hidden = !cappedText;
    const list = section.querySelector('.job-items');
    const old = new Map([...list.children].map(li => [li.dataset.item, li]));
    placeChildren(list, rows.map(item => {
        const model = rowModel(item, live.get(item.downloadId));
        const kept = old.get(item.id);
        return kept && kept.dataset.sig === rowSignature(item, model) ? kept : renderItem(job, item, model);
    }));
    return section;
}

// chrome.downloads.show does nothing, silently, for a download Chrome no longer lists; say so instead, with the name the file was saved under
async function showInFolder(jobId, li) {
    const item = drawn.get(`${jobId}/${li.dataset.item}`);
    const id = Number(li.dataset.download);
    const look = async () => (Number.isInteger(id) ? (await chrome.downloads.search({ id }))[0] : undefined);
    let found = await look();
    // `exists` is checked when search() is called, at most every 10 s, and the first answer can still be the old value (docs; review probe,
    // 2026-11-18): when Chrome says the file is there, ask once more a moment later
    if (showPlan(item || {}, found) === 'show') {
        await new Promise(resolve => setTimeout(resolve, 400));
        found = await look();
    }
    const plan = showPlan(item || {}, found);
    if (plan === 'show') chrome.downloads.show(id);
    else toast(t(plan === 'gone' ? 'show_gone' : 'show_missing', item?.filename || ''), true);
}

// the button that has keyboard focus, as job, row and action, so it can get focus back if its row or head was drawn again
function focusedButton() {
    const button = document.activeElement?.closest?.('#jobs button');
    if (!button) return null;
    return { job: button.closest('[data-job]')?.dataset.job, item: button.closest('li')?.dataset.item, action: button.dataset.action,
        jobAction: button.dataset.jobAction };
}

function restoreFocus(was) {
    if (!was || document.activeElement?.closest?.('#jobs button')) return;
    const scope = `#jobs [data-job="${was.job}"]`;
    const target = was.item !== undefined
        ? $(`${scope} li[data-item="${was.item}"] button[data-action="${was.action}"]`) || $(`${scope} li[data-item="${was.item}"] button`)
        : $(`${scope} button[data-job-action="${was.jobAction}"]`);
    target?.focus();
}

async function render() {
    jobs = await loadJobs();
    drawn = new Map();
    const was = focusedButton();
    const container = $('#jobs');
    const old = new Map([...container.children].map(section => [section.dataset.job, section]));
    // newest job first; a section that stays is never taken out, so a press on one of its buttons is not lost
    placeChildren(container, jobs.map(job => updateJob(old.get(job.id), job)));
    restoreFocus(was);
    $('#noJobs').hidden = jobs.length > 0;
    const all = allButtons(jobs);
    $('#allStart').disabled = !all.start;
    $('#allPause').disabled = !all.pause;
    const running = jobs.reduce((n, j) => n + j.items.filter(i => UNFINISHED.has(i.state)).length, 0);
    $('#tabDownloads').textContent = running ? t('tab_downloads_active', running) : t('tab_downloads');
}

// refreshes the progress of running rows in place
async function tick() {
    if (document.hidden || $('#viewDownloads').hidden) return;
    live = new Map((await chrome.downloads.search({ state: 'in_progress' })).map(d => [d.id, d]));
    for (const li of document.querySelectorAll('#jobs li[data-download]')) {
        const item = drawn.get(`${li.closest('[data-job]').dataset.job}/${li.dataset.item}`);
        if (!item || !UNFINISHED.has(item.state)) continue;
        li.querySelector('.item-meta').replaceWith(meta(item, rowModel(item, live.get(item.downloadId))));
    }
}

function setTicking(on) {
    clearInterval(timer);
    timer = on ? setInterval(tick, 1000) : 0;
    if (on) tick();
}

async function onClick(e) {
    const button = e.target.closest('button');
    if (!button) return;
    const jobId = button.closest('[data-job]')?.dataset.job;
    try {
        if (button.dataset.jobAction) {
            await send({ type: 'job', jobId, action: button.dataset.jobAction });
            return;
        }
        const li = button.closest('li');
        if (button.dataset.action === 'show') {
            await showInFolder(jobId, li);
            return;
        }
        if (button.dataset.action === 'keep') {
            // only a visible page may call this (docs); Chrome then asks its own question, and the download goes on when the person agrees
            await chrome.downloads.acceptDanger(Number(li.dataset.download));
            return;
        }
        await send({ type: 'item', jobId, itemId: li.dataset.item, action: button.dataset.action });
    } catch (error) {
        toast(errorText(error), true);
    }
}

export async function initDownloads(settings) {
    initLimits({ parallel: 'parallel', retries: 'retries' }, settings);
    $('#jobs').addEventListener('click', onClick);
    for (const [id, action] of [['#allStart', 'resumeAll'], ['#allPause', 'pauseAll']]) {
        $(id).addEventListener('click', () => send({ type: 'jobs', action }).catch(error => toast(errorText(error), true)));
    }
    watchStorage(async what => {
        if (what.jobs) await render();
    });
    document.addEventListener('viewchange', e => setTicking(e.detail === 'Downloads'));
    document.addEventListener('visibilitychange', () => setTicking(!document.hidden && !$('#viewDownloads').hidden));
    await render();
}
