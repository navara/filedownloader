import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Selection, previewLines, addressName } from '../../extension/panel/select-model.js';

test('Selection toggles, adds and removes groups, and survives a changed filter', () => {
    const s = new Selection();
    s.toggle('1', true);
    s.toggle('2', true);
    s.toggle('1', false);
    assert.deepEqual([...s.ids], ['2']);
    s.setAll(['3', '4', '5'], true);
    assert.equal(s.size, 4);
    s.setAll(['4'], false);
    assert.deepEqual([...s.ids].sort(), ['2', '3', '5']);
    assert.equal(s.countIn(['1', '2', '9']), 1);
    s.clear();
    assert.equal(s.size, 0);
});

test('Selection range sets everything between the anchor and the clicked row in shown order', () => {
    const s = new Selection();
    const shown = ['a', 'b', 'c', 'd', 'e'];
    s.click(shown, 'b', true, false);
    s.click(shown, 'd', true, true);
    assert.deepEqual([...s.ids].sort(), ['b', 'c', 'd']);
    s.click(shown, 'e', false, true);
    assert.deepEqual([...s.ids].sort(), ['b', 'c']);
    // an anchor no longer shown behaves like a plain click
    s.click(['x', 'y'], 'y', true, true);
    assert.deepEqual([...s.ids].sort(), ['b', 'c', 'y']);
});

test('addressName gives the file name in the address, or nothing for generated links', () => {
    assert.deepEqual(addressName({ url: 'https://x.test/files/My%20Map.webp', ext: 'webp' }), { name: 'My Map', ext: 'webp' });
    assert.deepEqual(addressName({ url: 'https://battlezoo.com/apps/digital-downloads/download/2038?from=Download%20Page', ext: '' }), null);
});

test('previewLines shows the first three picked files under the rule', () => {
    const items = [
        { url: 'https://x.test/a/Map.jpg', ext: 'jpg', text: 'Map' },
        { url: 'https://x.test/dl/2038', ext: '', text: 'Bestiary PDF' },
        { url: 'https://x.test/b.zip', ext: 'zip', text: 'Archive' },
        { url: 'https://x.test/c.zip', ext: 'zip', text: 'Fourth' },
    ];
    const lines = previewLines(items, { folderTpl: '{title}', nameTpl: '{n:3} {name}' }, { title: 'Battlezoo: Downloads', host: 'x.test',
        date: '2026-11-18', time: '101500' }, '[name from the server]');
    assert.deepEqual(lines, ['Battlezoo_ Downloads/001 Map.jpg', 'Battlezoo_ Downloads/002 [name from the server]', 'Battlezoo_ Downloads/003 b.zip']);
    assert.deepEqual(previewLines([], { folderTpl: '', nameTpl: '{name}' }, {}, '?'), []);
});
