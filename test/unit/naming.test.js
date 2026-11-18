import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSegment, splitName, renderTemplate, buildPath, batchStamp } from '../../extension/lib/naming.js';

test('sanitizeSegment replaces forbidden characters and collapses runs', () => {
    assert.equal(sanitizeSegment('a/b:c*?"<>|'), 'a_b_c_');
    assert.equal(sanitizeSegment('  Maps:  Vol. 2. '), 'Maps_ Vol. 2');
    assert.equal(sanitizeSegment('tab\there\u0001x'), 'tab_here_x');
});

// Chrome rejects the whole suggested path for these and saves under the server's name in the Downloads root (review probe, 2026-11-18)
test('sanitizeSegment drops invisible format characters and trims tildes', () => {
    assert.equal(sanitizeSegment('Zero\u200BWidth'), 'ZeroWidth');
    assert.equal(sanitizeSegment('Soft\u00ADHyphen'), 'SoftHyphen');
    assert.equal(sanitizeSegment('\u200Eleft to right\u200F'), 'left to right');
    assert.equal(sanitizeSegment('Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} pics'), 'Family \u{1F468}\u{1F469}\u{1F467} pics');
    assert.equal(sanitizeSegment('c1\u0085control'), 'c1_control');
    assert.equal(sanitizeSegment('line\u2028sep'), 'linesep');
    assert.equal(sanitizeSegment('~tilde~'), 'tilde');
    assert.equal(sanitizeSegment(' ~ . ~name~ . '), 'name');
    assert.equal(sanitizeSegment('mid~dle'), 'mid~dle');
    assert.equal(sanitizeSegment('\u200B'), '_');
});

// as folder names these make Chrome reject the whole path; ordinary dotted names (x.exe, Vol. 2, x.bat) are kept (probe, 2026-11-18)
test('sanitizeSegment defuses Windows shell names and shell extensions', () => {
    assert.equal(sanitizeSegment('desktop.ini'), '_desktop.ini');
    assert.equal(sanitizeSegment('Desktop.INI'), '_Desktop.INI');
    assert.equal(sanitizeSegment('thumbs.db'), '_thumbs.db');
    assert.equal(sanitizeSegment('CLOCK$'), '_CLOCK$');
    assert.equal(sanitizeSegment('conin$'), '_conin$');
    assert.equal(sanitizeSegment('conout$.txt'), '_conout$.txt');
    assert.equal(sanitizeSegment('x.lnk'), 'x_lnk');
    assert.equal(sanitizeSegment('Map.URL'), 'Map_URL');
    assert.equal(sanitizeSegment('a.scf'), 'a_scf');
    assert.equal(sanitizeSegment('b.local'), 'b_local');
    assert.equal(sanitizeSegment('x.{20D04FE0-3AEA-1069-A2D8-08002B30309D}'), 'x_{20D04FE0-3AEA-1069-A2D8-08002B30309D}');
    for (const kept of ['x.exe', 'Vol. 2', 'x.bat', 'x.download', 'thumbs.dbx', 'my desktop.ini notes']) assert.equal(sanitizeSegment(kept), kept);
});

test('sanitizeSegment does not cut an emoji in half at the length limit', () => {
    const cut = sanitizeSegment('x'.repeat(119) + '\u{1F600}\u{1F600}');
    assert.equal(/\p{Cs}/u.test(cut), false, 'a lone surrogate is left');
    assert.equal(cut, 'x'.repeat(119));
    const withExt = sanitizeSegment('x'.repeat(115) + '\u{1F600}' + 'y'.repeat(20) + '.pdf');
    assert.equal(/\p{Cs}/u.test(withExt), false);
    assert.ok(withExt.endsWith('.pdf') && withExt.length <= 120);
});

test('sanitizeSegment handles reserved, empty and dot-only names', () => {
    assert.equal(sanitizeSegment('CON'), '_CON');
    assert.equal(sanitizeSegment('lpt1.txt'), '_lpt1.txt');
    assert.equal(sanitizeSegment('Console'), 'Console');
    assert.equal(sanitizeSegment(''), '_');
    assert.equal(sanitizeSegment('..'), '_');
    assert.equal(sanitizeSegment(undefined), '_');
});

test('sanitizeSegment cuts long names and keeps the extension', () => {
    const long = sanitizeSegment('x'.repeat(200) + '.pdf');
    assert.equal(long.length, 120);
    assert.ok(long.endsWith('.pdf'));
    assert.equal(sanitizeSegment('y'.repeat(300)).length, 120);
});

test('splitName separates the last extension and ignores folders', () => {
    assert.deepEqual(splitName('Map Pack.v2.zip'), { name: 'Map Pack.v2', ext: 'zip' });
    assert.deepEqual(splitName('README'), { name: 'README', ext: '' });
    assert.deepEqual(splitName('.htaccess'), { name: '.htaccess', ext: '' });
    assert.deepEqual(splitName('C:\\Users\\x\\Downloads\\a.pdf'), { name: 'a', ext: 'pdf' });
    assert.deepEqual(splitName('sub/b.tar.gz'), { name: 'b.tar', ext: 'gz' });
});

test('renderTemplate fills known tokens, pads numbers and keeps unknown tokens', () => {
    assert.equal(renderTemplate('{n:3} {name} {nope}', { n: 7, name: 'a' }), '007 a {nope}');
    assert.equal(renderTemplate('{n}-{text}', { n: 12 }), '12-');
    assert.equal(renderTemplate('{n:2}', { n: 123 }), '123');
});

test('buildPath joins a sanitised folder and file name', () => {
    assert.equal(buildPath({ folderTpl: '{title}', nameTpl: '{n:3} {name}' },
        { title: 'Battlezoo: Downloads', name: 'Dragons', ext: 'pdf', n: 7 }), 'Battlezoo_ Downloads/007 Dragons.pdf');
    assert.equal(buildPath({ folderTpl: '{host}/{date}', nameTpl: '{text}.{ext}' },
        { host: 'battlezoo.com', date: '2026-11-17', text: 'Bestiary PDF', name: 'x', ext: 'pdf' }), 'battlezoo.com/2026-11-17/Bestiary PDF.pdf');
    assert.equal(buildPath({ folderTpl: '', nameTpl: '{name}' }, { name: 'a', ext: '' }), 'a');
    assert.equal(buildPath({ folderTpl: '{title}', nameTpl: '{text}' }, { title: '', text: '', name: 'srv', ext: 'zip' }), '_/srv.zip');
});

test('buildPath keeps slashes inside values from creating folders', () => {
    assert.equal(buildPath({ folderTpl: '{title}', nameTpl: '{text}' }, { title: 'A/B\\C', text: 'x/y', name: 'n', ext: 'pdf' }), 'A_B_C/x_y.pdf');
    assert.equal(buildPath({ folderTpl: '../{title}', nameTpl: '{name}' }, { title: 't', name: 'n', ext: '' }), '_/t/n');
});

test('buildPath keeps the whole relative path within the limit, shortening the longest parts first', () => {
    const t120 = 'T'.repeat(120);
    const rule = { folderTpl: '{title}/{title}/{title}', nameTpl: '{title} {name}' };
    const out = buildPath(rule, { title: t120, name: 'server', ext: 'pdf' }, 180);
    assert.ok(out.length <= 180, `${out.length}`);
    assert.ok(out.endsWith('.pdf'));
    for (const seg of out.split('/')) {
        assert.ok(seg.length >= 1 && !/[ .]$/.test(seg), JSON.stringify(seg));
    }
    assert.equal(out.split('/').length, 4);
    assert.equal(buildPath({ folderTpl: 'a', nameTpl: '{name}' }, { name: 'b', ext: 'pdf' }, 180), 'a/b.pdf');
    assert.equal(buildPath({ folderTpl: 'abc', nameTpl: '{name}' }, { name: 'x'.repeat(200), ext: 'zip' }, 60).length, 60);
});

test('batchStamp gives local date and time', () => {
    assert.deepEqual(batchStamp(new Date(2026, 10, 17, 9, 5, 3)), { date: '2026-11-17', time: '090503' });
});
