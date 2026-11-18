// A fake `chrome` for unit tests: in-memory storage.local and storage.session, a scriptable chrome.downloads, and listener registries that record what
// the worker registers. installChrome() puts it on globalThis before the modules under test are imported (or re-imported with importFresh).

function area() {
    const data = {};
    return {
        data,
        async get(keys) {
            if (keys === undefined || keys === null) return structuredClone(data);
            return Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, structuredClone(data[key])]));
        },
        async set(items) {
            Object.assign(data, structuredClone(items));
        },
        async remove(keys) {
            for (const key of [].concat(keys)) delete data[key];
        },
    };
}

function event() {
    const listeners = [];
    return { listeners, addListener: fn => listeners.push(fn), hasListener: fn => listeners.includes(fn) };
}

export const EXT_ID = 'fakeextensionid';

// downloads: every call is recorded in `calls`; `items` holds what search() returns. Tests change items with set() and then call the queue's
// event handlers themselves, as Chrome would.
function fakeDownloads() {
    let nextId = 1;
    const items = new Map();
    const calls = [];
    const gates = new Map();
    const api = {
        items,
        calls,
        failNext: null,
        // called with the new id right after a download is created, before download() resolves (a file that finishes at once)
        afterStart: null,
        // hold(url): download() for that address resolves only when the returned function is called (a server slow to send headers)
        hold(url) {
            let release;
            gates.set(url, new Promise(r => { release = r; }));
            return () => release();
        },
        // the next ids start after n (downloads put into `items` by hand)
        skipIds(n) {
            nextId = Math.max(nextId, n + 1);
        },
        async download(options) {
            calls.push(['download', options]);
            if (api.failNext) {
                const message = api.failNext;
                api.failNext = null;
                throw new Error(message);
            }
            if (gates.has(options.url)) {
                await gates.get(options.url);
                // failNextGated: the next held download() that is released rejects with this message
                if (api.failNextGated) {
                    const message = api.failNextGated;
                    api.failNextGated = null;
                    throw new Error(message);
                }
            }
            const id = nextId++;
            items.set(id, { id, url: options.url, finalUrl: options.url, state: 'in_progress', paused: false, canResume: false, error: undefined,
                filename: '', mime: '', startTime: new Date().toISOString(), bytesReceived: 0, totalBytes: -1, byExtensionId: EXT_ID, exists: true });
            api.afterStart?.(id);
            return id;
        },
        // like Chrome, a query field that is null or undefined does not filter (search({id: null}) returns every download; review probe, 2026-11-18)
        async search(query) {
            const fields = Object.entries(query).filter(([, v]) => v !== null && v !== undefined);
            return [...items.values()].filter(it => fields.every(([k, v]) => it[k] === v)).map(it => structuredClone(it));
        },
        async pause(id) {
            calls.push(['pause', id]);
            api.set(id, { paused: true, canResume: true });
        },
        async resume(id) {
            calls.push(['resume', id]);
            const it = items.get(id);
            if (!it?.canResume) throw new Error('Download must be resumable');
            api.set(id, { paused: false, state: 'in_progress', error: undefined, canResume: false });
        },
        async cancel(id) {
            calls.push(['cancel', id]);
            api.set(id, { state: 'interrupted', error: 'USER_CANCELED', canResume: false });
        },
        async show(id) {
            calls.push(['show', id]);
        },
        // uiFail: the next setUiOptions rejects with this message (as when another extension has the UI disabled)
        uiFail: null,
        async setUiOptions({ enabled }) {
            calls.push(['ui', enabled]);
            if (api.uiFail) {
                const message = api.uiFail;
                api.uiFail = null;
                throw new Error(message);
            }
        },
        ui: () => calls.filter(c => c[0] === 'ui').map(c => c[1]),
        set(id, fields) {
            const it = items.get(id);
            if (it) Object.assign(it, fields);
        },
        started: () => calls.filter(c => c[0] === 'download').map(c => c[1].url),
        onDeterminingFilename: event(),
        onChanged: event(),
        onErased: event(),
        onCreated: event(),
    };
    return api;
}

export function installChrome({ local = {}, session = {} } = {}) {
    const localArea = area();
    const sessionArea = area();
    Object.assign(localArea.data, structuredClone(local));
    Object.assign(sessionArea.data, structuredClone(session));
    const badge = {};
    globalThis.chrome = {
        runtime: {
            id: EXT_ID,
            getURL: p => `chrome-extension://${EXT_ID}/${p}`,
            onMessage: event(),
            onStartup: event(),
            onInstalled: event(),
        },
        storage: { local: localArea, session: sessionArea, onChanged: event() },
        downloads: fakeDownloads(),
        action: {
            onClicked: event(),
            badge,
            async setBadgeText({ text }) {
                badge.text = text;
            },
            async setBadgeBackgroundColor({ color }) {
                badge.color = color;
            },
        },
        i18n: { getMessage: (key, subs) => `${key}${subs ? `(${[].concat(subs).join(',')})` : ''}` },
        // scripting.result: the executeScript answer, or an Error to reject with; scripting.sequence: answers used first, one per call
        scripting: {
            result: [],
            sequence: [],
            calls: [],
            async executeScript(options) {
                this.calls.push(options);
                const answer = this.sequence.length ? this.sequence.shift() : this.result;
                if (answer instanceof Error) throw answer;
                return structuredClone(answer);
            },
        },
        windows: {
            open: new Map(),
            calls: [],
            nextId: 100,
            async create(options) {
                const id = this.nextId++;
                this.open.set(id, { id, url: options.url });
                this.calls.push(['create', options]);
                return { id };
            },
            async update(id, props) {
                if (!this.open.has(id)) throw new Error(`No window with id: ${id}.`);
                this.calls.push(['update', id, props]);
            },
        },
        tabs: {
            async query({ windowId }) {
                const win = globalThis.chrome.windows.open.get(windowId);
                if (!win) throw new Error(`No window with id: ${windowId}.`);
                return [{ id: windowId * 10, windowId }];
            },
            async update(tabId, props) {
                const win = globalThis.chrome.windows.open.get(tabId / 10);
                win.url = props.url;
            },
        },
    };
    return globalThis.chrome;
}

let generation = 0;

// a fresh instance of an extension module, so module-level state starts again against the chrome installed just before
export function importFresh(rel) {
    return import(new URL(`../../extension/${rel}?v=${++generation}`, import.meta.url));
}
