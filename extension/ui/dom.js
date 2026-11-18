// Page helpers. Page-derived data (addresses, link texts, titles) only ever reaches the DOM through textContent and setAttribute, never through HTML
// parsing in the extension's own document.

import { t } from '../lib/i18n.js';

export const $ = (selector, root = document) => root.querySelector(selector);

// el('p', {className: 'x', text: 'y', attrs: {title: 'z'}, data: {id: '1'}}, child, ...)
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    if (props.className) node.className = props.className;
    if (props.text !== undefined) node.textContent = props.text;
    for (const [name, value] of Object.entries(props.attrs || {})) node.setAttribute(name, value);
    Object.assign(node.dataset, props.data || {});
    node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
    return node;
}

// a worker answers with a short code where it has its own reason (tpl_too_long); the text for it is the message err_<code>
export function errorText(error) {
    const text = String(error?.message || error);
    if (/^\w+$/.test(text)) {
        const translated = t(`err_${text}`);
        if (translated !== `err_${text}`) return translated;
    }
    return text;
}

// the first read failed: a lasting message where the list would be, never a blank page
export function showLoadError(error) {
    console.error('File Downloader:', error);
    const box = $('#loadError');
    box.textContent = t('load_failed', errorText(error));
    box.hidden = false;
}

let toastTimer = 0;

export function toast(text, isError = false) {
    const status = $('#status');
    status.textContent = text;
    status.classList.toggle('is-error', isError);
    status.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => status.classList.remove('is-visible'), isError ? 6000 : 2500);
}

// sends a command to the worker; rejects with the worker's error text
export async function send(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || 'no_reply');
    return reply;
}

// calls back once per burst of changes to the jobs or the settings in chrome.storage.local; a burst that goes on is still reported every maxWait ms
export function watchStorage(callback, delay = 150, maxWait = 1000) {
    let timer = 0;
    let since = 0;
    let pending = { jobs: false, settings: false };
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const keys = Object.keys(changes);
        pending.jobs ||= keys.some(k => k.startsWith('job:'));
        pending.settings ||= keys.includes('settings');
        if (!pending.jobs && !pending.settings) return;
        since ||= Date.now();
        clearTimeout(timer);
        timer = setTimeout(() => {
            const what = pending;
            pending = { jobs: false, settings: false };
            since = 0;
            callback(what);
        }, Math.max(0, Math.min(delay, since + maxWait - Date.now())));
    });
}
