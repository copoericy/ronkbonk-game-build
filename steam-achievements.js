/**
 * RonkBonk Steam achievements.
 * API names MUST match Steamworks Partner → Stats & Achievements exactly.
 */
const LOCAL_UNLOCKED_KEY = 'ronk_steam_achievements_unlocked';
const THEMES_TRIED_KEY = 'ronk_themes_tried';

const ACHIEVEMENTS = {
    TUTORIAL: {
        id: 'ACH_TUTORIAL',
        name: 'First Steps',
        desc: 'Complete the tutorial by beating the training bot.'
    },
    TUTORIAL_COMPLETE: {
        id: 'ACH_TUTORIAL_COMPLETE',
        name: 'Tutorial Cleared',
        desc: 'Finish or clear tutorial progress.'
    },
    FIRST_WIN: {
        id: 'ACH_FIRST_WIN',
        name: 'First Victory',
        desc: 'Win your first match.'
    },
    WIN_EASY: {
        id: 'ACH_WIN_EASY',
        name: 'Warmup',
        desc: 'Win a match against an Easy bot.'
    },
    WIN_MEDIUM: {
        id: 'ACH_WIN_MEDIUM',
        name: 'Getting Serious',
        desc: 'Win a match against a Medium bot.'
    },
    WIN_HARD: {
        id: 'ACH_WIN_HARD',
        name: 'Hard Mode',
        desc: 'Win a match against a Hard bot.'
    },
    WIN_INVINCIBLE: {
        id: 'ACH_WIN_INVINCIBLE',
        name: 'Impossible?',
        desc: 'Win a match against an Elite bot.'
    },
    INVINCIBLE_SLAYER: {
        id: 'ACH_INVINCIBLE_SLAYER',
        name: 'Slayer',
        desc: 'Defeat an Elite bot.'
    },
    WIN_PVP: {
        id: 'ACH_WIN_PVP',
        name: 'Rivalry',
        desc: 'Win a local multiplayer or online match.'
    },
    ONLINE_VICTORY: {
        id: 'ACH_ONLINE_VICTORY',
        name: 'Online Victory',
        desc: 'Win an online match.'
    },
    LOCAL_DUELIST: {
        id: 'ACH_LOCAL_DUELIST',
        name: 'Local Duelist',
        desc: 'Win a local multiplayer match.'
    },
    FIRST_APPLE: {
        id: 'ACH_FIRST_APPLE',
        name: 'Hungry',
        desc: 'Eat an apple.'
    },
    FIRST_DASH: {
        id: 'ACH_FIRST_DASH',
        name: 'Quick Feet',
        desc: 'Use Dash.'
    },
    FIRST_CHARGE: {
        id: 'ACH_FIRST_CHARGE',
        name: 'Full Send',
        desc: 'Use Charge.'
    },
    FIRST_SKILL: {
        id: 'ACH_FIRST_SKILL',
        name: 'Special Move',
        desc: 'Activate a special skill.'
    },
    SKILL_COLLECTOR: {
        id: 'ACH_SKILL_COLLECTOR',
        name: 'Loadout Thief',
        desc: 'Unlock a skill by beating an opponent.'
    },
    FULL_SKILLS: {
        id: 'ACH_FULL_SKILLS',
        name: 'Complete Toolkit',
        desc: 'Unlock every special skill.'
    },
    FULL_JOKERS: {
        id: 'ACH_FULL_JOKERS',
        name: 'Joker Poker',
        desc: 'Unlock every joker.'
    },
    TTT_WIN: {
        id: 'ACH_TTT_WIN',
        name: 'Three in a Row',
        desc: 'Win a match by connecting 3 boards like tic-tac-toe.'
    },
    SPECTATE_FRIEND: {
        id: 'ACH_SPECTATE_FRIEND',
        name: 'Watch Party',
        desc: 'Open Spectate Friend from the menu.'
    },
    PERFECT_MATCH: {
        id: 'ACH_PERFECT_MATCH',
        name: 'Clean Sweep',
        desc: 'Win a match without losing a single round.'
    },
    APPLE_GLUTTON: {
        id: 'ACH_APPLE_GLUTTON',
        name: 'Apple Glutton',
        desc: 'Eat 10 apples in a single match.'
    },
    DASH_MACHINE: {
        id: 'ACH_DASH_MACHINE',
        name: 'Dash Demon',
        desc: 'Dash 20 times in a single match.'
    },
    CHARGE_SPAM: {
        id: 'ACH_CHARGE_SPAM',
        name: 'Full Battery',
        desc: 'Charge 10 times in a single match.'
    },
    BOARD_HOPPER: {
        id: 'ACH_BOARD_HOPPER',
        name: 'Board Hopper',
        desc: 'Travel from one board to another.'
    },
    THEME_HOPPER: {
        id: 'ACH_THEME_HOPPER',
        name: 'Mood Swing',
        desc: 'Change the visual theme.'
    },
    ALL_THEMES: {
        id: 'ACH_ALL_THEMES',
        name: 'Fashion Victim',
        desc: 'Try every visual theme at least once.'
    },
    COMEBACK: {
        id: 'ACH_COMEBACK',
        name: 'Comeback Kid',
        desc: 'Win a match after losing at least one round.'
    },
    SPECTATE_AI: {
        id: 'ACH_SPECTATE_AI',
        name: 'Couch Critic',
        desc: 'Spectate an AI vs AI match.'
    },
    LONG_TRAIL: {
        id: 'ACH_LONG_TRAIL',
        name: 'Long Boy',
        desc: 'Grow your trail by eating 15 apples in one match.'
    },
    ONLINE_QUEUE: {
        id: 'ACH_ONLINE_QUEUE',
        name: 'In Queue',
        desc: 'Start online matchmaking.'
    }
};

/** Per-match counters (human P1 actions). */
let matchCounters = { apples: 0, dashes: 0, charges: 0 };

function resetMatchCounters() {
    matchCounters = { apples: 0, dashes: 0, charges: 0 };
}

function loadLocalUnlocked() {
    try {
        const raw = localStorage.getItem(LOCAL_UNLOCKED_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) {
        return new Set();
    }
}

function markLocalUnlocked(apiName) {
    const set = loadLocalUnlocked();
    if (set.has(apiName)) return;
    set.add(apiName);
    localStorage.setItem(LOCAL_UNLOCKED_KEY, JSON.stringify([...set]));
}

function getBridge() {
    try {
        if (typeof steamBridge !== 'undefined' && steamBridge) return steamBridge;
        if (typeof window !== 'undefined' && window.__ronkSteamBridge) return window.__ronkSteamBridge;
        if (typeof require === 'function') return require('./steam-bridge.js');
        return null;
    } catch (_) {
        return null;
    }
}

let pendingSteamUnlocks = [];

function isLiveGameplay() {
    try {
        if (typeof document !== 'undefined' && document.body?.classList.contains('in-game')) {
            if (typeof gameState === 'undefined') return true;
            return gameState === 'PLAYING' || gameState === 'COUNTDOWN';
        }
    } catch (_) { /* ignore */ }
    return false;
}

function sendSteamUnlock(apiName) {
    const bridge = getBridge();
    if (bridge?.isAvailable?.()) {
        return !!bridge.unlockAchievement(apiName);
    }
    return false;
}

function flushPendingSteamUnlocks() {
    if (!pendingSteamUnlocks.length) return;
    const ids = pendingSteamUnlocks.splice(0, pendingSteamUnlocks.length);
    for (const id of ids) sendSteamUnlock(id);
}

function unlock(apiName) {
    if (!apiName) return false;
    const local = loadLocalUnlocked();
    if (local.has(apiName)) return true;

    markLocalUnlocked(apiName);
    if (isLiveGameplay()) {
        pendingSteamUnlocks.push(apiName);
        return false;
    }
    sendSteamUnlock(apiName);
    return true;
}

function unlockKey(key) {
    const ach = ACHIEVEMENTS[key];
    if (!ach) return false;
    return unlock(ach.id);
}

function onMatchWon(ctx = {}) {
    const {
        isTutorial = false,
        isSpectate = false,
        isMultiplayer = false,
        isOnline = false,
        botDifficulty = null,
        playerRoundScore = 0,
        opponentRoundScore = 0,
        boardWin = false
    } = ctx;

    if (isSpectate) return;

    if (isTutorial) {
        unlockKey('TUTORIAL');
        unlockKey('TUTORIAL_COMPLETE');
        return;
    }

    unlockKey('FIRST_WIN');

    if (isMultiplayer || isOnline) {
        unlockKey('WIN_PVP');
        if (isOnline) unlockKey('ONLINE_VICTORY');
        if (isMultiplayer && !isOnline) unlockKey('LOCAL_DUELIST');
    } else if (botDifficulty === 'easy') {
        unlockKey('WIN_EASY');
    } else if (botDifficulty === 'medium') {
        unlockKey('WIN_MEDIUM');
    } else if (botDifficulty === 'hard') {
        unlockKey('WIN_HARD');
    } else if (botDifficulty === 'invincible') {
        unlockKey('WIN_INVINCIBLE');
        unlockKey('INVINCIBLE_SLAYER');
    }

    if (boardWin) unlockKey('TTT_WIN');

    if (opponentRoundScore === 0 && playerRoundScore > 0) {
        unlockKey('PERFECT_MATCH');
    }

    if (opponentRoundScore > 0 && playerRoundScore > opponentRoundScore) {
        unlockKey('COMEBACK');
    }
}

function onAppleEaten() {
    unlockKey('FIRST_APPLE');
    matchCounters.apples += 1;
    if (matchCounters.apples >= 10) unlockKey('APPLE_GLUTTON');
    if (matchCounters.apples >= 15) unlockKey('LONG_TRAIL');
}

function onDashUsed() {
    unlockKey('FIRST_DASH');
    matchCounters.dashes += 1;
    if (matchCounters.dashes >= 20) unlockKey('DASH_MACHINE');
}

function onChargeUsed() {
    unlockKey('FIRST_CHARGE');
    matchCounters.charges += 1;
    if (matchCounters.charges >= 10) unlockKey('CHARGE_SPAM');
}

function onSkillUsed() {
    unlockKey('FIRST_SKILL');
}

function onBoardHopped() {
    unlockKey('BOARD_HOPPER');
}

function onThemeChanged(themeClass) {
    if (!themeClass) return;
    unlockKey('THEME_HOPPER');
    try {
        const raw = localStorage.getItem(THEMES_TRIED_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        const set = new Set(Array.isArray(arr) ? arr : []);
        set.add(String(themeClass));
        localStorage.setItem(THEMES_TRIED_KEY, JSON.stringify([...set]));
        // theme-ronk, theme-white-black, theme-pinkcore, theme-hacker, theme-pixel
        if (set.size >= 5) unlockKey('ALL_THEMES');
    } catch (_) { /* ignore */ }
}

function onSpectateFriendOpened() {
    unlockKey('SPECTATE_FRIEND');
}

function onSpectateAiStarted() {
    unlockKey('SPECTATE_AI');
}

function onOnlineMatchmakingStarted() {
    unlockKey('ONLINE_QUEUE');
}

function onLoadoutProgress(skillsUnlocked = [], jokersUnlocked = [], totalSkills = 5, totalJokers = 10) {
    if ((skillsUnlocked || []).length > 0) {
        unlockKey('SKILL_COLLECTOR');
    }
    if ((skillsUnlocked || []).length >= totalSkills) {
        unlockKey('FULL_SKILLS');
    }
    if ((jokersUnlocked || []).length >= totalJokers) {
        unlockKey('FULL_JOKERS');
    }
}

/** Call after Steam init — syncs progress already stored in this browser. */
function syncFromLocalProgress() {
    if (typeof localStorage === 'undefined') return;

    if (localStorage.getItem('ronk_tutorial_v2_complete') === 'true') {
        unlockKey('TUTORIAL');
        unlockKey('TUTORIAL_COMPLETE');
    }

    try {
        const progress = JSON.parse(localStorage.getItem('ronk_unlock_progress') || '{}');
        const skills = progress.skills || [];
        const jokers = progress.jokers || [];
        onLoadoutProgress(skills, jokers, 5, 10);
    } catch (_) { /* ignore */ }

    try {
        const raw = localStorage.getItem(THEMES_TRIED_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr) && arr.length >= 5) unlockKey('ALL_THEMES');
    } catch (_) { /* ignore */ }

    for (const id of loadLocalUnlocked()) {
        const bridge = getBridge();
        if (bridge?.isAvailable?.()) bridge.unlockAchievement(id);
    }
}

function listForSteamworks() {
    return Object.values(ACHIEVEMENTS).map((a) => ({
        apiName: a.id,
        displayName: a.name,
        description: a.desc,
        hidden: false
    }));
}

const RonkSteamAchievementsAPI = {
    ACHIEVEMENTS,
    unlock,
    unlockKey,
    resetMatchCounters,
    onMatchWon,
    onAppleEaten,
    onDashUsed,
    onChargeUsed,
    onSkillUsed,
    onBoardHopped,
    onThemeChanged,
    onSpectateFriendOpened,
    onSpectateAiStarted,
    onOnlineMatchmakingStarted,
    flushPendingSteamUnlocks,
    onLoadoutProgress,
    syncFromLocalProgress,
    listForSteamworks
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = RonkSteamAchievementsAPI;
}
if (typeof window !== 'undefined') {
    window.RonkSteamAchievements = RonkSteamAchievementsAPI;
}
