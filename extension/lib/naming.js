// File name rules: templates for the folder and the file name, and sanitising so that every path segment is valid on Windows (the strictest
// target). Paths are relative to Chrome's Downloads folder and use / between folders.

// Windows device names, and Chrome's own list of names it will not create (clock$, conin$, conout$ with any extension; desktop.ini and thumbs.db
// exactly): a folder segment like that makes Chrome reject the whole path (probe, 2026-11-18). A leading _ defuses them.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$|conin\$|conout\$)(\.|$)|^(desktop\.ini|thumbs\.db)$/i;
// shell-integrated extensions: Chrome renames such files to .download itself, but rejects a folder named like that (probe, 2026-11-18)
const SHELL_EXT = /\.(lnk|url|scf|local|\{[0-9a-f-]+\})$/i;
const TOKENS = new Set(['name', 'ext', 'text', 'title', 'host', 'n', 'date', 'time']);

// Invisible format characters (zero width space and joiner, soft hyphen, direction marks), unassigned code points, line and paragraph separators
// and lone surrogates are dropped, and a tilde may not start or end a segment: Chrome rejects the whole suggested path for any of them and saves under
// the server's name in the Downloads root (review probe, 2026-11-18). Control characters become _ like the characters Windows forbids.
const INVISIBLE = /[\p{Cf}\p{Cn}\p{Zl}\p{Zp}\p{Cs}]/gu;
const EDGES = /^[\s.~]+|[\s.~]+$/g;

export function sanitizeSegment(text, maxLen = 120) {
    let s = String(text ?? '')
        .replace(INVISIBLE, '')
        .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
        .replace(/_+/g, '_')
        .replace(/\s+/g, ' ')
        .replace(EDGES, '');
    if (!s) return '_';
    if (RESERVED.test(s)) s = `_${s}`;
    s = s.replace(SHELL_EXT, (whole, ext) => `_${ext}`);
    if (s.length > maxLen) {
        const { name, ext } = splitName(s);
        const tail = ext && ext.length < 16 ? `.${ext}` : '';
        // the cut can split a surrogate pair; the half left over is dropped
        s = (tail ? name : s).slice(0, maxLen - tail.length).replace(INVISIBLE, '').replace(/[\s.~]+$/, '') + tail;
    }
    return s;
}

export function splitName(filename) {
    const base = String(filename ?? '').split(/[\\/]/).pop();
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return { name: base, ext: '' };
    return { name: base.slice(0, dot), ext: base.slice(dot + 1) };
}

export function renderTemplate(tpl, vars) {
    return String(tpl ?? '').replace(/\{(\w+)(?::(\d+))?\}/g, (whole, token, width) => {
        if (!TOKENS.has(token)) return whole;
        const value = vars[token];
        if (value === undefined || value === null) return '';
        return width ? String(value).padStart(Number(width), '0') : String(value);
    });
}

// Chrome saves a path intact up to 243 characters absolute (Downloads folder + separator + relative path); longer, it cuts the file name, and when
// the folders leave too little room it cancels the download (probe P5, 2026-11-18). The relative limit keeps 8 characters for Chrome's " (12)".
export const ASSUMED_DIR_LENGTH = 60;
export const relativeLimit = (dirLength = ASSUMED_DIR_LENGTH) => 243 - dirLength - 1 - 8;
const MIN_SEGMENT = 20;

export function buildPath(rule, vars, maxLen = relativeLimit()) {
    // a slash inside a value (a page title like "A/B") must not create a folder; only the template's own slashes do
    const flat = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/[\\/]/g, '_') : v]));
    const folder = rule.folderTpl ? renderTemplate(rule.folderTpl, flat).split('/').map(seg => sanitizeSegment(seg)) : [];
    const ext = vars.ext ? `.${vars.ext}` : '';
    let name = renderTemplate(rule.nameTpl, flat).trim();
    if (!/\{ext\}/.test(rule.nameTpl ?? '') && name) name += ext;
    if (!sanitizeSegment(name).replace(/[_.]/g, '')) name = `${vars.name || ''}${ext}`;
    const segments = [...folder, sanitizeSegment(name)];
    // too long: the longest part over MIN_SEGMENT characters is shortened (the file name keeps its extension) until the path fits
    for (let length = segments.join('/').length; length > maxLen; length = segments.join('/').length) {
        let longest = -1;
        segments.forEach((seg, i) => {
            if (seg.length > MIN_SEGMENT && (longest < 0 || seg.length > segments[longest].length)) longest = i;
        });
        if (longest < 0) break;
        segments[longest] = sanitizeSegment(segments[longest], Math.max(MIN_SEGMENT, segments[longest].length - (length - maxLen)));
    }
    return segments.join('/');
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function batchStamp(date) {
    return {
        date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    };
}
