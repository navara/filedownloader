// The stored settings (chrome.storage.local `settings`). A value that fails its check is never stored and never used: loading falls back to the
// default, saving keeps what was stored before.

export const DEFAULTS = Object.freeze({ schema: 1, parallel: 3, retries: 2, folderTpl: '{title}', nameTpl: '{name}', conflict: 'uniquify' });

const CHECKS = {
    schema: v => v === 1,
    parallel: v => Number.isInteger(v) && v >= 1 && v <= 10,
    retries: v => Number.isInteger(v) && v >= 0 && v <= 5,
    folderTpl: v => typeof v === 'string' && v.length <= 200,
    nameTpl: v => typeof v === 'string' && v.length <= 200,
    conflict: v => v === 'uniquify' || v === 'overwrite',
};

export function validSetting(key, value) {
    return Boolean(CHECKS[key]?.(value));
}

export async function loadSettings() {
    const { settings = {} } = await chrome.storage.local.get('settings');
    return Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, validSetting(k, settings[k]) ? settings[k] : d]));
}

// saves run one after another: two overlapping read-modify-write saves (the Select view and the Downloads view both store limits) would otherwise
// lose one of the changes; a failed write does not block the next
let saving = Promise.resolve();

export function saveSettings(patch) {
    const run = saving.then(async () => {
        const current = await loadSettings();
        for (const [k, v] of Object.entries(patch)) {
            if (validSetting(k, v)) current[k] = v;
        }
        await chrome.storage.local.set({ settings: current });
        return current;
    });
    saving = run.catch(() => {});
    return run;
}
