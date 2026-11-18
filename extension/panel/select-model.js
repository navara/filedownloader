// The Select view's state without the DOM: the ticked set and the name preview.

import { buildPath, splitName } from '../lib/naming.js';

// the ticked addresses by id; separate from what the filters show, so a filter change keeps the ticks
export class Selection {
    constructor() {
        this.ids = new Set();
        this.anchor = null;
    }

    get size() {
        return this.ids.size;
    }

    has(id) {
        return this.ids.has(id);
    }

    toggle(id, on) {
        if (on) this.ids.add(id);
        else this.ids.delete(id);
    }

    setAll(ids, on) {
        for (const id of ids) this.toggle(id, on);
    }

    countIn(ids) {
        return ids.reduce((n, id) => n + (this.ids.has(id) ? 1 : 0), 0);
    }

    clear() {
        this.ids.clear();
        this.anchor = null;
    }

    // a click on a row's box: with shift, every row from the last clicked one to this one (in shown order) takes the new state
    click(shownIds, id, on, shift) {
        const from = shift && this.anchor !== null ? shownIds.indexOf(this.anchor) : -1;
        const to = shownIds.indexOf(id);
        if (from >= 0 && to >= 0) this.setAll(shownIds.slice(Math.min(from, to), Math.max(from, to) + 1), on);
        else this.toggle(id, on);
        this.anchor = id;
    }
}

// the file name in the address, or null where the address has none (a generated link: the server names the file)
export function addressName(item) {
    if (!item.ext) return null;
    try {
        return splitName(decodeURIComponent(new URL(item.url).pathname));
    } catch {
        return null;
    }
}

// page: {title, host, date, time}; serverName stands for the name only the server knows
// maxLen: the relative path limit the worker will apply (relativeLimit of the learned Downloads folder length), so the preview shows the same name
export function previewLines(items, rule, page, serverName, count = 3, maxLen = undefined) {
    return items.slice(0, count).map((item, i) => {
        const fromAddress = addressName(item);
        const vars = { ...page, text: item.text, n: i + 1, name: fromAddress ? fromAddress.name : serverName, ext: fromAddress ? fromAddress.ext : '' };
        return buildPath(rule, vars, maxLen);
    });
}
