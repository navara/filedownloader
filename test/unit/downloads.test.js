import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowModel, jobButtons, formatBytes, visibleItems, resumeLabel, allButtons, rowSignature, showPlan }
    from '../../extension/panel/downloads-model.js';

const item = (state, fields = {}) => ({ id: '0', n: 1, url: 'https://x.test/dl/1', text: 'One', state, downloadId: 5, attempts: 0, error: '',
    filename: '', mime: '', ...fields });

test('rowModel offers the buttons that fit each state', () => {
    const buttons = state => rowModel(item(state)).buttons;
    assert.deepEqual(buttons('queued'), ['pause', 'cancel', 'remove']);
    assert.deepEqual(buttons('starting'), ['cancel']);
    assert.deepEqual(buttons('active'), ['pause', 'cancel']);
    assert.deepEqual(buttons('paused'), ['resume', 'cancel', 'remove']);
    assert.deepEqual(buttons('done'), ['show', 'remove']);
    assert.deepEqual(buttons('failed'), ['retry', 'remove']);
    assert.deepEqual(buttons('canceled'), ['retry', 'remove']);
});

test('a paused row that never started offers Start and says Not started', () => {
    const notStarted = rowModel(item('paused', { downloadId: null }));
    assert.deepEqual(notStarted.buttons, ['start', 'cancel', 'remove']);
    assert.equal(notStarted.stateKey, 'state_notStarted');
    const paused = rowModel(item('paused'));
    assert.deepEqual(paused.buttons, ['resume', 'cancel', 'remove']);
    assert.equal(paused.stateKey, 'state_paused');
    assert.equal(rowModel(item('queued')).stateKey, 'state_queued');
});

test('a download Chrome holds as dangerous offers Keep and Cancel with a warning', () => {
    const held = rowModel(item('active', { danger: 'uncommon' }));
    assert.deepEqual(held.buttons, ['keep', 'cancel']);
    assert.equal(held.danger, true);
    assert.equal(rowModel(item('active')).danger, false);
});

test('showPlan shows the file only when Chrome still lists the same download and the file is there', () => {
    const done = item('done', { filename: 'C:\\dl\\a.pdf' });
    assert.equal(showPlan(done, { id: 5, filename: 'C:\\dl\\a.pdf', exists: true }), 'show');
    assert.equal(showPlan(done, undefined), 'gone');
    // Chrome can hand an id out again after its history was cleared
    assert.equal(showPlan(done, { id: 5, filename: 'C:\\dl\\other.zip', exists: true }), 'gone');
    assert.equal(showPlan(done, { id: 5, filename: 'C:\\dl\\a.pdf', exists: false }), 'missing');
});

test('rowSignature changes only when what the row shows changes', () => {
    const sig = (it, live) => rowSignature(it, rowModel(it, live));
    const base = item('active');
    assert.equal(sig(base), sig({ ...base }));
    assert.equal(sig(base, { bytesReceived: 10, totalBytes: 100 }), sig(base, { bytesReceived: 90, totalBytes: 100 }));
    assert.equal(sig({ ...base, attempts: 2, startedAt: 5 }), sig(base));
    for (const changed of [{ state: 'paused' }, { error: 'X' }, { filename: 'C:\\a.pdf' }, { downloadId: 9 }, { danger: 'file' }, { text: 'Other' }]) {
        assert.notEqual(sig({ ...base, ...changed }), sig(base), JSON.stringify(changed));
    }
});

test('resumeLabel says Start all when nothing of the job was paused mid-file', () => {
    const job = items => ({ items });
    assert.equal(resumeLabel(job([item('paused', { downloadId: null }), item('done')])), 'job_startAll');
    assert.equal(resumeLabel(job([item('paused', { downloadId: null }), item('paused')])), 'job_resumeAll');
    assert.equal(resumeLabel(job([item('active')])), 'job_resumeAll');
});

test('allButtons enables Start everything and Pause everything by what the jobs hold', () => {
    assert.deepEqual(allButtons([]), { start: false, pause: false });
    assert.deepEqual(allButtons([{ items: [item('paused', { downloadId: null })] }, { items: [item('done')] }]), { start: true, pause: false });
    assert.deepEqual(allButtons([{ items: [item('queued')] }, { items: [item('starting')] }]), { start: false, pause: true });
});

test('rowModel computes progress from the live download', () => {
    assert.deepEqual(rowModel(item('active'), { bytesReceived: 250, totalBytes: 1000 }).progress, { percent: 25, received: 250, total: 1000 });
    assert.deepEqual(rowModel(item('active'), { bytesReceived: 250, totalBytes: -1 }).progress, { percent: null, received: 250, total: -1 });
    assert.equal(rowModel(item('active')).progress, null);
    assert.deepEqual(rowModel(item('done')).progress, { percent: 100, received: null, total: null });
});

test('rowModel warns when a non-HTML link gave a web page', () => {
    assert.equal(rowModel(item('done', { mime: 'text/html' })).warning, true);
    assert.equal(rowModel(item('done', { mime: 'text/html', url: 'https://x.test/page.html' })).warning, false);
    assert.equal(rowModel(item('done', { mime: 'application/pdf' })).warning, false);
    assert.equal(rowModel(item('active', { mime: 'text/html' })).warning, false);
});

test('rowModel names the row by the saved file, else the link text, else the address', () => {
    assert.equal(rowModel(item('done', { filename: 'C:\\Users\\x\\Downloads\\basic\\001 Real Name.pdf' })).name, '001 Real Name.pdf');
    assert.equal(rowModel(item('queued')).name, 'One');
    assert.equal(rowModel(item('queued', { text: '' })).name, 'https://x.test/dl/1');
});

test('rowModel gives a hint when Chrome canceled before any byte arrived', () => {
    assert.equal(rowModel(item('canceled', { error: 'CANCELED_EARLY' })).hint, true);
    assert.equal(rowModel(item('canceled')).hint, false);
    assert.equal(rowModel(item('failed', { error: 'NETWORK_FAILED' })).hint, false);
});

test('visibleItems keeps every row of a small job in order', () => {
    const items = ['done', 'active', 'queued'].map((s, i) => item(s, { id: String(i), n: i + 1 }));
    assert.deepEqual(visibleItems(items, 5).map(i => i.id), ['0', '1', '2']);
});

test('visibleItems caps a big job, running, paused and failed rows first, then waiting, then finished, in batch order', () => {
    const states = ['done', 'done', 'queued', 'active', 'done', 'failed', 'queued', 'paused', 'canceled', 'starting'];
    const items = states.map((s, i) => item(s, { id: String(i), n: i + 1 }));
    assert.deepEqual(visibleItems(items, 6).map(i => i.id), ['2', '3', '5', '6', '7', '9']);
    assert.deepEqual(visibleItems(items, 3).map(i => i.id), ['3', '7', '9']);
});

test('visibleItems does not let not-started rows crowd out failed ones', () => {
    const items = [...Array.from({ length: 400 }, (_, i) => item('paused', { id: `p${i}`, n: i + 1, downloadId: null })),
        ...Array.from({ length: 5 }, (_, i) => item('failed', { id: `f${i}`, n: 401 + i }))];
    const shown = visibleItems(items, 300);
    assert.equal(shown.length, 300);
    assert.equal(shown.filter(i => i.state === 'failed').length, 5);
});

test('jobButtons enables only what can act', () => {
    const job = states => ({ items: states.map(s => item(s)) });
    assert.deepEqual(jobButtons(job(['active', 'queued', 'done'])),
        { pauseAll: true, resumeAll: false, retryFailed: false, cancelAll: true, clearFinished: true });
    assert.deepEqual(jobButtons(job(['paused', 'paused'])),
        { pauseAll: false, resumeAll: true, retryFailed: false, cancelAll: true, clearFinished: false });
    assert.deepEqual(jobButtons(job(['done', 'failed'])),
        { pauseAll: false, resumeAll: false, retryFailed: true, cancelAll: false, clearFinished: true });
});

test('formatBytes uses the units it is given', () => {
    assert.equal(formatBytes(1536, ['o', 'Ko', 'Mo', 'Go', 'To']), '1.5 Ko');
});

test('formatBytes uses binary units with one decimal', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
    assert.equal(formatBytes(-1), '?');
});
