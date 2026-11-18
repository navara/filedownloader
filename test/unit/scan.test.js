import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../../extension/scan.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function sandbox(extra = {}) {
    const context = vm.createContext({ URL, ...extra });
    const result = vm.runInContext(SOURCE, context, { filename: 'scan.js' });
    return { context, result };
}

// a tiny stand-in for the DOM: every element knows its tag and the properties the scanner reads
function el(tagName, props = {}) {
    return { tagName, getAttribute: name => props.attrs?.[name] ?? null, querySelector: () => props.img ?? null, ...props };
}

function doc(elements, extra = {}) {
    return { title: 'Page', baseURI: 'https://x.test/p/', querySelectorAll: sel => (sel === '*' ? elements : []), ...extra };
}

test('cleanText collapses whitespace', () => {
    const { context } = sandbox();
    assert.equal(context.cleanText('  Bestiary \n  PDF '), 'Bestiary PDF');
    assert.equal(context.cleanText(undefined), '');
});

test('largestFromSrcset picks the widest candidate, then the densest', () => {
    const { context } = sandbox();
    assert.equal(context.largestFromSrcset('a.jpg 320w, b.jpg 1280w, c.jpg 640w', 'https://x.test/p/'), 'https://x.test/p/b.jpg');
    assert.equal(context.largestFromSrcset('a.jpg, b.jpg 2x', 'https://x.test/'), 'https://x.test/b.jpg');
    assert.equal(context.largestFromSrcset('', 'https://x.test/'), '');
});

test('the script evaluates to null where there is no document (unit test realm)', () => {
    assert.equal(sandbox().result, null);
});

test('the script can be injected twice into the same realm', () => {
    const { context } = sandbox();
    assert.doesNotThrow(() => vm.runInContext(SOURCE, context));
});

test('scanDocument collects links, images and media with their texts', () => {
    const { context } = sandbox();
    const video = el('VIDEO', { src: '' });
    const elements = [
        el('A', { href: 'https://x.test/dl/1', innerText: ' Bestiary\n PDF ', attrs: { download: 'b.pdf' } }),
        el('A', { href: 'https://x.test/dl/2', innerText: '', title: '', attrs: { 'aria-label': 'Second' } }),
        el('A', { href: 'https://x.test/dl/3', innerText: '', img: { alt: 'Cover image' } }),
        el('A', { href: 'mailto:a@x.test', innerText: 'mail' }),
        el('AREA', { href: 'https://x.test/map.pdf', innerText: '', attrs: { alt: 'Map' } }),
        el('IMG', { srcset: 'small.jpg 100w, big.jpg 900w', currentSrc: 'https://x.test/p/small.jpg', src: 'https://x.test/p/small.jpg', alt: 'Dragon' }),
        el('IMG', { srcset: '', currentSrc: '', src: 'data:image/png;base64,xx', alt: '' }),
        video,
        el('SOURCE', { src: 'https://x.test/v.mp4', parentElement: video }),
        el('AUDIO', { src: 'https://x.test/a.mp3', title: 'Theme' }),
        el('SOURCE', { src: 'https://x.test/pic.webp', parentElement: el('PICTURE') }),
        el('IFRAME'),
    ];
    const result = plain(context.scanDocument(doc(elements), 'https://x.test/p/'));
    assert.equal(result.title, 'Page');
    assert.equal(result.frameUrl, 'https://x.test/p/');
    assert.equal(result.childFrames, 1);
    assert.deepEqual(result.skipped, { 'mailto:': 1, 'data:': 1 });
    assert.deepEqual(result.items, [
        { url: 'https://x.test/dl/1', text: 'Bestiary PDF', kind: 'link', download: 'b.pdf' },
        { url: 'https://x.test/dl/2', text: 'Second', kind: 'link', download: '' },
        { url: 'https://x.test/dl/3', text: 'Cover image', kind: 'link', download: '' },
        { url: 'https://x.test/map.pdf', text: 'Map', kind: 'link', download: '' },
        { url: 'https://x.test/p/big.jpg', text: 'Dragon', kind: 'image', download: '' },
        { url: 'https://x.test/v.mp4', text: '', kind: 'media', download: '' },
        { url: 'https://x.test/a.mp3', text: 'Theme', kind: 'media', download: '' },
    ]);
});

test('scanDocument reads links inside SVG', () => {
    const { context } = sandbox();
    const svgLink = el('a', { href: { baseVal: '/file/v.pdf' }, textContent: ' Vector  file ', innerText: undefined });
    const result = plain(context.scanDocument(doc([svgLink]), 'https://x.test/p/'));
    assert.deepEqual(result.items, [{ url: 'https://x.test/file/v.pdf', text: 'Vector file', kind: 'link', download: '' }]);
});

test('link text is capped at 300 characters', () => {
    const { context } = sandbox();
    const result = plain(context.scanDocument(doc([el('A', { href: 'https://x.test/a', innerText: 'word '.repeat(1000) })]), 'https://x.test/'));
    assert.equal(result.items[0].text.length, 300);
});

test('scanDocument looks into open shadow roots', () => {
    const { context } = sandbox();
    const inner = { querySelectorAll: () => [el('A', { href: 'https://x.test/shadow.pdf', innerText: 'In shadow' })] };
    const host = el('DIV', { shadowRoot: inner });
    const result = plain(context.scanDocument(doc([host]), 'https://x.test/'));
    assert.deepEqual(result.items.map(i => i.url), ['https://x.test/shadow.pdf']);
});
