import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, importFresh } from './fake-chrome.js';

test('loadSettings gives the defaults when nothing is stored', async () => {
    installChrome();
    const { loadSettings, DEFAULTS } = await importFresh('lib/settings.js');
    assert.deepEqual(DEFAULTS, { schema: 1, parallel: 3, retries: 2, folderTpl: '{title}', nameTpl: '{name}', conflict: 'uniquify' });
    assert.deepEqual(await loadSettings(), DEFAULTS);
});

test('loadSettings replaces invalid stored values by defaults', async () => {
    installChrome({ local: { settings: { schema: 1, parallel: 99, retries: 1, folderTpl: 5, nameTpl: '{n} {name}', conflict: 'prompt' } } });
    const { loadSettings } = await importFresh('lib/settings.js');
    assert.deepEqual(await loadSettings(), { schema: 1, parallel: 3, retries: 1, folderTpl: '{title}', nameTpl: '{n} {name}', conflict: 'uniquify' });
});

test('two saves that overlap both land', async () => {
    const chrome = installChrome();
    const { saveSettings } = await importFresh('lib/settings.js');
    await Promise.all([saveSettings({ parallel: 7 }), saveSettings({ retries: 4 })]);
    assert.deepEqual([chrome.storage.local.data.settings.parallel, chrome.storage.local.data.settings.retries], [7, 4]);
});

test('a failed write does not block the next save', async () => {
    const chrome = installChrome();
    const { saveSettings } = await importFresh('lib/settings.js');
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
    await assert.rejects(saveSettings({ parallel: 2 }), /QUOTA/);
    chrome.storage.local.set = set;
    await saveSettings({ parallel: 5 });
    assert.equal(chrome.storage.local.data.settings.parallel, 5);
});

test('saveSettings stores valid values and keeps the stored one for invalid values', async () => {
    const chrome = installChrome();
    const { saveSettings, validSetting } = await importFresh('lib/settings.js');
    let s = await saveSettings({ parallel: 5, retries: 0, conflict: 'overwrite', folderTpl: '' });
    assert.deepEqual([s.parallel, s.retries, s.conflict, s.folderTpl], [5, 0, 'overwrite', '']);
    s = await saveSettings({ parallel: 0, retries: 6, conflict: 'x', nameTpl: 'a'.repeat(201) });
    assert.deepEqual([s.parallel, s.retries, s.conflict, s.nameTpl], [5, 0, 'overwrite', '{name}']);
    assert.equal(chrome.storage.local.data.settings.parallel, 5);
    assert.equal(validSetting('parallel', 10), true);
    assert.equal(validSetting('parallel', 2.5), false);
    assert.equal(validSetting('retries', '2'), false);
});
