import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extOf, mergeScan, facets, compileFilter } from '../../extension/lib/links.js';

const BZ = 'https://battlezoo.com/apps/digital-downloads/download/20387641-cc4a-49a1-ac15-007d1f9458c2?from=Download%20Page';

test('extOf reads the extension of the address path', () => {
    assert.equal(extOf('https://x.test/a/b.PDF?x=1'), 'pdf');
    assert.equal(extOf(BZ), '');
    assert.equal(extOf('https://x.test/archive.tar.gz'), 'gz');
    assert.equal(extOf('https://x.test/v1.2/'), '');
    assert.equal(extOf('https://x.test/page.html#x'), 'html');
    assert.equal(extOf('https://x.test/My%20Map.webp'), 'webp');
    assert.equal(extOf('https://x.test/weird.not-an-ext'), '');
    assert.equal(extOf('not a url'), '');
});

const frame = (frameUrl, items, extra = {}) => ({ frameUrl, title: 'T', items, skipped: {}, childFrames: 0, ...extra });
const item = (url, text = '', kind = 'link') => ({ url, text, kind, download: '' });

test('mergeScan joins frames, drops duplicate addresses and keeps the first text', () => {
    const merged = mergeScan([
        frame('https://x.test/', [item('https://x.test/a.pdf'), item('https://x.test/b.zip#top', 'B'), item(BZ, 'Bestiary')],
            { skipped: { 'mailto:': 1 }, childFrames: 2, title: 'Top title' }),
        frame('https://x.test/f', [item('https://x.test/a.pdf', 'A text'), item('https://x.test/b.zip', 'other'), item('https://x.test/c.jpg', 'C', 'image')],
            { skipped: { 'mailto:': 2, 'blob:': 1 }, title: 'Frame title' }),
    ]);
    assert.equal(merged.title, 'Top title');
    assert.equal(merged.pageUrl, 'https://x.test/');
    assert.equal(merged.frameCount, 2);
    assert.equal(merged.unreadFrames, 1);
    assert.deepEqual(merged.skipped, { 'mailto:': 3, 'blob:': 1 });
    assert.deepEqual(merged.items.map(i => [i.id, i.url, i.text, i.kind, i.ext, i.host]), [
        ['0', 'https://x.test/a.pdf', 'A text', 'link', 'pdf', 'x.test'],
        ['1', 'https://x.test/b.zip', 'B', 'link', 'zip', 'x.test'],
        ['2', BZ, 'Bestiary', 'link', '', 'battlezoo.com'],
        ['3', 'https://x.test/c.jpg', 'C', 'image', 'jpg', 'x.test'],
    ]);
});

test('mergeScan ignores frames without a result', () => {
    const merged = mergeScan([null, frame('https://x.test/', [item('https://x.test/a.pdf')])]);
    assert.equal(merged.items.length, 1);
    assert.equal(merged.frameCount, 1);
});

test('facets counts extensions, most frequent first, none as empty string', () => {
    const items = mergeScan([frame('https://x.test/', [item('https://x.test/1.pdf'), item('https://x.test/2.pdf'), item(BZ), item('https://x.test/3.zip'),
        item('https://x.test/dl/4'), item('https://x.test/dl/5')])]).items;
    assert.deepEqual(facets(items), [{ ext: '', count: 3 }, { ext: 'pdf', count: 2 }, { ext: 'zip', count: 1 }]);
});

test('compileFilter matches text, address, kinds and extensions', () => {
    const items = mergeScan([frame('https://x.test/', [item(BZ, 'Bestiary PDF'), item('https://x.test/cover.jpg', 'Cover', 'image'),
        item('https://x.test/a.zip', 'Archive')])]).items;
    const pick = opts => items.filter(compileFilter(opts).test).map(i => i.text);
    assert.deepEqual(pick({}), ['Bestiary PDF', 'Cover', 'Archive']);
    assert.deepEqual(pick({ text: 'best' }), ['Bestiary PDF']);
    assert.deepEqual(pick({ url: 'download page' }), ['Bestiary PDF']);
    assert.deepEqual(pick({ url: '/download/[0-9a-f-]{36}', urlRegex: true }), ['Bestiary PDF']);
    assert.deepEqual(pick({ text: '^c', textRegex: true }), ['Cover']);
    assert.deepEqual(pick({ exts: [''] }), ['Bestiary PDF']);
    assert.deepEqual(pick({ exts: ['jpg', 'zip'] }), ['Cover', 'Archive']);
    assert.deepEqual(pick({ kinds: ['image'] }), ['Cover']);
    assert.deepEqual(pick({ kinds: [] }), []);
});

test('compileFilter reports an invalid expression and matches nothing', () => {
    const filter = compileFilter({ text: '(', textRegex: true });
    assert.ok(filter.errors.text);
    assert.equal(filter.errors.url, undefined);
    assert.equal(filter.test({ text: '(', url: 'x', kind: 'link', ext: '' }), false);
});

test('compileFilter over 5000 items is fast', () => {
    const many = Array.from({ length: 5000 }, (_, n) => ({ id: String(n), url: `https://x.test/dl/${n}?from=Download%20Page`, text: `File ${n}`,
        kind: 'link', ext: n % 2 ? 'pdf' : '', host: 'x.test' }));
    const t0 = performance.now();
    const filter = compileFilter({ text: 'file 4', url: '/dl/[0-9]+', urlRegex: true, exts: ['pdf'], kinds: ['link'] });
    const shown = many.filter(filter.test);
    const ms = performance.now() - t0;
    assert.ok(shown.length > 0);
    assert.ok(ms < 50, `took ${ms} ms`);
});
