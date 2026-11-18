// The scanned addresses as one list, and the filters over it. Pure functions, shared by the worker and the panel.

export function extOf(url) {
    try {
        const last = decodeURIComponent(new URL(url).pathname).split('/').pop();
        const m = /\.([a-z0-9]{1,8})$/i.exec(last);
        return m ? m[1].toLowerCase() : '';
    } catch {
        return '';
    }
}

function hostOf(url) {
    try {
        return new URL(url).host;
    } catch {
        return '';
    }
}

function withoutFragment(url) {
    const hash = url.indexOf('#');
    return hash < 0 ? url : url.slice(0, hash);
}

// frames: the frames' scan results in executeScript order (top frame first); null for a frame that returned nothing
export function mergeScan(frames) {
    const read = frames.filter(Boolean);
    const byUrl = new Map();
    const skipped = {};
    let childFrames = 0;
    for (const f of read) {
        childFrames += f.childFrames || 0;
        for (const [scheme, count] of Object.entries(f.skipped || {})) skipped[scheme] = (skipped[scheme] || 0) + count;
        for (const it of f.items || []) {
            const url = withoutFragment(it.url);
            const seen = byUrl.get(url);
            if (seen) {
                if (!seen.text && it.text) seen.text = it.text;
                continue;
            }
            byUrl.set(url, { id: String(byUrl.size), url, text: it.text || '', kind: it.kind, ext: extOf(url), host: hostOf(url),
                download: it.download || '' });
        }
    }
    return {
        pageUrl: read[0]?.frameUrl || '',
        title: read[0]?.title || '',
        items: [...byUrl.values()],
        skipped,
        frameCount: read.length,
        unreadFrames: Math.max(0, 1 + childFrames - read.length),
    };
}

export function facets(items) {
    const counts = new Map();
    for (const it of items) counts.set(it.ext, (counts.get(it.ext) || 0) + 1);
    return [...counts].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}

function matcher(pattern, isRegex) {
    if (!pattern) return { match: () => true };
    if (isRegex) {
        try {
            const re = new RegExp(pattern, 'i');
            return { match: s => re.test(s) };
        } catch (e) {
            return { match: () => false, error: e.message };
        }
    }
    const needle = pattern.toLowerCase();
    return { match: s => s.toLowerCase().includes(needle) };
}

function decoded(url) {
    try {
        return decodeURIComponent(url);
    } catch {
        return url;
    }
}

// kinds / exts: undefined means every kind / extension; an array lists the allowed ones ('' is "no extension")
export function compileFilter({ text = '', textRegex = false, url = '', urlRegex = false, kinds, exts } = {}) {
    const t = matcher(text, textRegex);
    const u = matcher(url, urlRegex);
    const kindSet = kinds ? new Set(kinds) : null;
    const extSet = exts?.length ? new Set(exts) : null;
    const errors = {};
    if (t.error) errors.text = t.error;
    if (u.error) errors.url = u.error;
    const failed = t.error || u.error;
    return {
        errors,
        test: it => !failed && (!kindSet || kindSet.has(it.kind)) && (!extSet || extSet.has(it.ext)) && t.match(it.text || '')
            && (u.match(it.url) || (!urlRegex && u.match(decoded(it.url)))),
    };
}
