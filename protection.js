/**
 * RonkBonk client protection — copyright, tamper detection, casual copy deterrence.
 * (C) 2026 copoeric. All rights reserved.
 */
(function () {
    const COPYRIGHT = {
        owner: 'copoeric',
        product: 'RonkBonk',
        year: 2026,
        steamAppId: 4887920,
        notice: '© 2026 copoeric. RonkBonk — All Rights Reserved. Unauthorized copying, redistribution, or reverse engineering is prohibited.'
    };

    const PROGRESS_SIG_SALT = 'RB|4887920|prog|v2';
    let shieldState = { packaged: false, devMode: true, ownershipBlocked: false };

    function fnv1a(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
    }

    function isElectron() {
        return typeof process !== 'undefined' && !!process.versions?.electron;
    }

    function isProductionShield() {
        return shieldState.packaged && !shieldState.devMode;
    }

    async function initShieldState() {
        if (!isElectron()) {
            shieldState = { packaged: false, devMode: true, ownershipBlocked: false };
            return shieldState;
        }
        try {
            const ipc = require('electron').ipcRenderer;
            shieldState = await ipc.invoke('get-client-shield');
            if (typeof window !== 'undefined') {
                window.__ronkSteamOwnershipBlocked = !!shieldState.ownershipBlocked;
            }
        } catch (_) {
            shieldState = { packaged: false, devMode: true, ownershipBlocked: false };
        }
        return shieldState;
    }

    function sealUnlockProgress(progress) {
        const data = {
            skills: Array.isArray(progress?.skills) ? [...progress.skills] : [],
            jokers: Array.isArray(progress?.jokers) ? [...progress.jokers] : []
        };
        const sig = fnv1a(JSON.stringify(data) + PROGRESS_SIG_SALT);
        return JSON.stringify({ v: 2, data, sig });
    }

    function parseUnlockProgress(raw) {
        if (!raw) return { skills: [], jokers: [], tampered: false };
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.v === 2 && parsed.data && parsed.sig) {
                const expected = fnv1a(JSON.stringify(parsed.data) + PROGRESS_SIG_SALT);
                if (parsed.sig !== expected) {
                    return {
                        skills: Array.isArray(parsed.data.skills) ? parsed.data.skills : [],
                        jokers: Array.isArray(parsed.data.jokers) ? parsed.data.jokers : [],
                        tampered: true
                    };
                }
                return {
                    skills: Array.isArray(parsed.data.skills) ? parsed.data.skills : [],
                    jokers: Array.isArray(parsed.data.jokers) ? parsed.data.jokers : [],
                    tampered: false
                };
            }
            if (parsed && (Array.isArray(parsed.skills) || Array.isArray(parsed.jokers))) {
                return {
                    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
                    jokers: Array.isArray(parsed.jokers) ? parsed.jokers : [],
                    tampered: false,
                    legacy: true
                };
            }
        } catch (_) { /* ignore */ }
        return { skills: [], jokers: [], tampered: true };
    }

    function installHoneypots() {
        const trap = () => {
            if (typeof window.onRonkProtectionViolation === 'function') {
                window.onRonkProtectionViolation('HONEYPOT_CHEAT');
            }
        };
        try {
            Object.defineProperty(window, '__RONK_UNLOCK_ALL', {
                configurable: false,
                get() { trap(); return undefined; }
            });
            Object.defineProperty(window, '__RONK_DEBUG_CHEATS', {
                configurable: false,
                get() { trap(); return undefined; }
            });
            Object.defineProperty(window, '__RONK_DUMP_ASAR', {
                configurable: false,
                get() { trap(); return undefined; }
            });
        } catch (_) { /* ignore */ }
    }

    function blockCasualCopy() {
        document.addEventListener('contextmenu', (e) => {
            if (isProductionShield()) e.preventDefault();
        }, true);

        document.addEventListener('keydown', (e) => {
            if (!isProductionShield()) return;
            const key = (e.key || '').toLowerCase();
            if (key === 'f12') e.preventDefault();
            if (e.ctrlKey && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) e.preventDefault();
            if (e.ctrlKey && (key === 'u' || key === 's')) e.preventDefault();
        }, true);

        document.addEventListener('copy', (e) => {
            if (isProductionShield()) e.preventDefault();
        }, true);

        document.addEventListener('dragstart', (e) => {
            if (isProductionShield()) e.preventDefault();
        }, true);

        if (isProductionShield()) {
            try {
                document.documentElement.style.setProperty('user-select', 'none');
            } catch (_) { /* ignore */ }
        }
    }

    function applyProtectionClass() {
        if (isProductionShield()) {
            document.documentElement.classList.add('ronk-protected-client');
        }
    }

    function stampCopyrightElements() {
        document.querySelectorAll('[data-copyright-line]').forEach((el) => {
            el.textContent = COPYRIGHT.notice;
        });
        document.querySelectorAll('[data-copyright-menu]').forEach((el) => {
            el.textContent = COPYRIGHT.notice;
        });
        document.querySelectorAll('[data-copyright-owner]').forEach((el) => {
            el.textContent = `© ${COPYRIGHT.year} ${COPYRIGHT.owner}`;
        });
        document.querySelectorAll('[data-copyright-product]').forEach((el) => {
            el.textContent = COPYRIGHT.product;
        });
    }

    async function initRonkProtection() {
        await initShieldState();
        installHoneypots();
        blockCasualCopy();
        applyProtectionClass();
        stampCopyrightElements();
        if (window.RonkAntiCheat && isProductionShield()) {
            window.RonkAntiCheat.watchDevTools(1200);
        }
    }

    window.RonkProtection = {
        COPYRIGHT,
        initRonkProtection,
        sealUnlockProgress,
        parseUnlockProgress,
        isProductionShield,
        isElectron,
        getShieldState: () => ({ ...shieldState }),
        stampCopyrightElements
    };
})();
