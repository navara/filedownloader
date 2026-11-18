// Test helper, driven by test/e2e.cjs through serviceWorker.evaluate.

// true while another extension (File Downloader) has Chrome's download UI switched off: enabling it is then refused (probe P1, 2026-11-18)
globalThis.uiHidden = () => chrome.downloads.setUiOptions({ enabled: true }).then(() => false, () => true);

globalThis.setEnabled = (id, enabled) => chrome.management.setEnabled(id, enabled);
