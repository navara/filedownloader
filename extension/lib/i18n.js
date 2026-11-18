// Every visible string comes from _locales/<code>/messages.json. English only for now; chrome.i18n picks the file.

export function t(key, ...subs) {
    return chrome.i18n.getMessage(key, subs.map(String)) || key;
}

// fills data-i18n (text), data-i18n-title, data-i18n-placeholder and data-i18n-aria-label inside root
export function localize(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const attr of ['title', 'placeholder', 'aria-label']) {
        const data = `i18n${attr.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`;
        for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.dataset[data]));
    }
}
