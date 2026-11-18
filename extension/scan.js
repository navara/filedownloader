// Injected into every readable frame of the tab when the toolbar button is clicked (chrome.scripting.executeScript, files). The value of the last
// expression is the frame's result. The same isolated world gets this file again on every click, so the file holds only function declarations
// (which may be declared again) and no top-level const, let or class.
//
// Result: {frameUrl, title, items: [{url, text, kind: 'link' | 'image' | 'media', download}], skipped: {'<scheme>:': count}, childFrames}

function cleanText(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// the candidate with the largest width descriptor, else the largest density, as an absolute address; '' for an empty srcset
function largestFromSrcset(srcset, base) {
    let best = '';
    let bestSize = -1;
    for (const part of String(srcset || '').split(/,\s+/)) {
        const [url, descriptor = '1x'] = part.trim().split(/\s+/);
        if (!url) continue;
        const size = descriptor.endsWith('w') ? parseFloat(descriptor) * 1000 : parseFloat(descriptor) || 1;
        if (size > bestSize) {
            bestSize = size;
            best = url;
        }
    }
    if (!best) return '';
    try {
        return new URL(best, base).href;
    } catch {
        return '';
    }
}

// an SVG <a> (lowercase tagName) has an SVGAnimatedString href; its baseVal is resolved against the document
function hrefOf(el, base) {
    if (typeof el.href === 'string') return el.href;
    try {
        return el.href?.baseVal ? new URL(el.href.baseVal, base).href : '';
    } catch {
        return '';
    }
}

function linkText(el) {
    return cleanText(el.innerText ?? el.textContent) || cleanText(el.title) || cleanText(el.getAttribute('aria-label'))
        || cleanText(el.getAttribute('alt')) || cleanText(el.querySelector('img')?.alt);
}

function scanDocument(doc, frameUrl) {
    const items = [];
    const skipped = {};
    let childFrames = 0;

    const add = (url, text, kind, download = '') => {
        if (!url) return;
        let protocol;
        try {
            protocol = new URL(url).protocol;
        } catch {
            return;
        }
        // link text capped at 300 characters: a page whose links hold whole articles would otherwise fill the scan storage
        if (protocol === 'http:' || protocol === 'https:') items.push({ url, text: text.slice(0, 300), kind, download });
        else skipped[protocol] = (skipped[protocol] || 0) + 1;
    };

    const walk = root => {
        for (const el of root.querySelectorAll('*')) {
            switch (el.tagName) {
                case 'A':
                case 'AREA':
                case 'a':
                    add(hrefOf(el, doc.baseURI), linkText(el), 'link', el.getAttribute('download') ?? '');
                    break;
                case 'IMG':
                    add(largestFromSrcset(el.srcset, doc.baseURI) || el.currentSrc || el.src, cleanText(el.alt) || cleanText(el.title), 'image');
                    break;
                case 'VIDEO':
                case 'AUDIO':
                    add(el.src, cleanText(el.title), 'media');
                    break;
                case 'SOURCE':
                    if (el.parentElement?.tagName === 'VIDEO' || el.parentElement?.tagName === 'AUDIO') add(el.src, cleanText(el.parentElement.title), 'media');
                    break;
                case 'IFRAME':
                case 'FRAME':
                    childFrames++;
                    break;
            }
            if (el.shadowRoot) walk(el.shadowRoot);
        }
    };
    walk(doc);
    return { frameUrl, title: cleanText(doc.title), items, skipped, childFrames };
}

typeof document === 'undefined' ? null : scanDocument(document, location.href);
