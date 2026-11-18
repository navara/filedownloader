// "Downloads at once" and "Automatic retries": the same two fields on the Select view (set before a batch starts) and on the Downloads view (they
// still apply to what is waiting). Each pair stores a valid value on change, marks a rejected one with a message and leaves the stored value alone,
// and follows the stored settings when the other pair or another window changes them.

import { t } from '../lib/i18n.js';
import { validSetting, loadSettings } from '../lib/settings.js';
import { $, send, toast, errorText, watchStorage } from '../ui/dom.js';

const RANGES = { parallel: [1, 10], retries: [0, 5] };

// ids: {parallel: '<input id>', retries: '<input id>'}; the error box of an input is '<input id>Error'. changed() runs after every check and
// refill, so a page can enable or disable what depends on valid limits (an invalid value replaced by a stored one from elsewhere)
export function initLimits(ids, settings, changed = () => {}) {
    const lastStored = {};

    const showError = (key, bad) => {
        const input = $(`#${ids[key]}`);
        $(`#${ids[key]}Error`).textContent = bad ? t('setting_range', ...RANGES[key]) : '';
        if (bad) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
    };

    const read = key => {
        const raw = $(`#${ids[key]}`).value.trim();
        return raw === '' ? NaN : Number(raw);
    };

    const fill = stored => {
        for (const key of Object.keys(RANGES)) {
            if (lastStored[key] !== stored[key]) {
                $(`#${ids[key]}`).value = String(stored[key]);
                showError(key, false);
            }
            lastStored[key] = stored[key];
        }
    };

    for (const key of Object.keys(RANGES)) {
        $(`#${ids[key]}`).addEventListener('change', async () => {
            const value = read(key);
            const bad = !validSetting(key, value);
            showError(key, bad);
            changed();
            if (bad) return;
            try {
                await send({ type: 'settings', patch: { [key]: value } });
            } catch (error) {
                toast(errorText(error), true);
            }
        });
    }
    watchStorage(async what => {
        if (what.settings) {
            fill(await loadSettings());
            changed();
        }
    });
    fill(settings);

    return {
        valid: () => Object.keys(RANGES).every(key => validSetting(key, read(key))),
        values: () => Object.fromEntries(Object.keys(RANGES).map(key => [key, read(key)])),
    };
}
