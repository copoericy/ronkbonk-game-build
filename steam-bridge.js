const STEAM_APP_ID = 4887920;
const PROGRESS_CLOUD_FILE = 'ronk_unlock_progress.dat';

/** API names — create matching achievements in Steamworks Partner (see STEAM_ACHIEVEMENTS.md). */
const ACHIEVEMENT_IDS = {
    // Legacy / current Partner set
    TUTORIAL_COMPLETE: 'ACH_TUTORIAL_COMPLETE',
    FIRST_WIN: 'ACH_FIRST_WIN',
    INVINCIBLE_SLAYER: 'ACH_INVINCIBLE_SLAYER',
    ONLINE_VICTORY: 'ACH_ONLINE_VICTORY',
    LOCAL_DUELIST: 'ACH_LOCAL_DUELIST',
    // Expanded set (steam-achievements.js) — publish these in Steamworks when ready
    TUTORIAL: 'ACH_TUTORIAL',
    WIN_EASY: 'ACH_WIN_EASY',
    WIN_MEDIUM: 'ACH_WIN_MEDIUM',
    WIN_HARD: 'ACH_WIN_HARD',
    WIN_INVINCIBLE: 'ACH_WIN_INVINCIBLE',
    WIN_PVP: 'ACH_WIN_PVP',
    FIRST_APPLE: 'ACH_FIRST_APPLE',
    FIRST_DASH: 'ACH_FIRST_DASH',
    FIRST_CHARGE: 'ACH_FIRST_CHARGE',
    FIRST_SKILL: 'ACH_FIRST_SKILL',
    SKILL_COLLECTOR: 'ACH_SKILL_COLLECTOR',
    FULL_SKILLS: 'ACH_FULL_SKILLS',
    FULL_JOKERS: 'ACH_FULL_JOKERS',
    PERFECT_MATCH: 'ACH_PERFECT_MATCH',
    TTT_WIN: 'ACH_TTT_WIN',
    SPECTATE_FRIEND: 'ACH_SPECTATE_FRIEND',
    APPLE_GLUTTON: 'ACH_APPLE_GLUTTON',
    DASH_MACHINE: 'ACH_DASH_MACHINE',
    CHARGE_SPAM: 'ACH_CHARGE_SPAM',
    BOARD_HOPPER: 'ACH_BOARD_HOPPER',
    THEME_HOPPER: 'ACH_THEME_HOPPER',
    ALL_THEMES: 'ACH_ALL_THEMES',
    COMEBACK: 'ACH_COMEBACK',
    SPECTATE_AI: 'ACH_SPECTATE_AI',
    LONG_TRAIL: 'ACH_LONG_TRAIL',
    ONLINE_QUEUE: 'ACH_ONLINE_QUEUE'
};

let client = null;
let activeLobby = null;
let initError = null;
let lobbyCallbacksRegistered = false;
const lobbyHandlers = new Set();

function ensureLobbyCallbacks(steamClient) {
    if (lobbyCallbacksRegistered || !steamClient) return;
    const steamworks = require('steamworks.js');
    registerLobbyCallbacks(steamClient, steamworks.SteamCallback);
    lobbyCallbacksRegistered = true;
}

function getClient() {
    if (client) return client;
    if (typeof process === 'undefined' || !process.versions?.electron) {
        initError = initError || 'Steam is only available in the desktop build.';
        return null;
    }
    try {
        if (global.__ronkSteamInitError) {
            initError = global.__ronkSteamInitError;
            return null;
        }
        if (global.__ronkSteamClient) {
            client = global.__ronkSteamClient;
            initError = null;
            ensureLobbyCallbacks(client);
            return client;
        }
        const steamworks = require('steamworks.js');
        client = steamworks.init(STEAM_APP_ID);
        global.__ronkSteamClient = client;
        initError = null;
        ensureLobbyCallbacks(client);
        return client;
    } catch (err) {
        initError = err.message || String(err);
        console.warn('[Steam] Unavailable:', initError);
        return null;
    }
}

function getInitError() {
    if (client) return null;
    getClient();
    return initError;
}

function registerLobbyCallbacks(steamClient, SteamCallback) {
    try {
        steamClient.callback.register(SteamCallback.LobbyDataUpdate, (data) => {
            lobbyHandlers.forEach((handler) => handler('data', data));
        });
        steamClient.callback.register(SteamCallback.LobbyChatUpdate, (data) => {
            lobbyHandlers.forEach((handler) => handler('chat', data));
        });
        steamClient.callback.register(SteamCallback.GameLobbyJoinRequested, (data) => {
            lobbyHandlers.forEach((handler) => handler('join-requested', data));
        });
    } catch (err) {
        console.warn('[Steam] Lobby callbacks unavailable:', err.message || err);
    }
}

function isAvailable() {
    return !!getClient();
}

function isOwnershipBlocked() {
    try {
        if (typeof global !== 'undefined' && global.__ronkSteamOwnershipBlocked) return true;
    } catch (_) { /* ignore */ }
    try {
        if (typeof window !== 'undefined' && window.__ronkSteamOwnershipBlocked) return true;
    } catch (_) { /* ignore */ }
    return false;
}

function leaveLobby() {
    if (activeLobby) {
        try { activeLobby.leave(); } catch (_) { /* ignore */ }
        activeLobby = null;
    }
}

async function findOrCreatePublicLobby() {
    const steamClient = getClient();
    if (!steamClient) return null;

    leaveLobby();

    try {
        const lobbies = await steamClient.matchmaking.getLobbies();
        for (const lobby of lobbies) {
            const count = Number(lobby.getMemberCount());
            const limit = Number(lobby.getMemberLimit() || 2);
            if (count > 0 && count < limit) {
                activeLobby = await lobby.join();
                return activeLobby;
            }
        }

        activeLobby = await steamClient.matchmaking.createLobby(
            steamClient.matchmaking.LobbyType.Public,
            2
        );
        return activeLobby;
    } catch (err) {
        initError = err.message || String(err);
        console.warn('[Steam] findOrCreatePublicLobby failed:', initError);
        return null;
    }
}

async function createFriendsLobby() {
    const steamClient = getClient();
    if (!steamClient) return null;

    leaveLobby();
    activeLobby = await steamClient.matchmaking.createLobby(
        steamClient.matchmaking.LobbyType.FriendsOnly,
        2
    );
    return activeLobby;
}

async function joinLobbyById(lobbyId) {
    const steamClient = getClient();
    if (!steamClient) return null;

    leaveLobby();
    activeLobby = await steamClient.matchmaking.joinLobby(BigInt(lobbyId));
    return activeLobby;
}

function getActiveLobby() {
    return activeLobby;
}

function getCurrentLobbyId() {
    if (!activeLobby) return null;
    try {
        const id = activeLobby.id ?? activeLobby.lobbyId;
        return id != null ? String(id) : null;
    } catch (_) {
        return null;
    }
}

function isLobbyOwner() {
    const steamClient = getClient();
    if (!activeLobby || !steamClient) return false;
    const me = steamClient.localplayer.getSteamId().steamId64;
    return activeLobby.getOwner().steamId64 === me;
}

function getPeerRoomFromLobby() {
    return activeLobby ? activeLobby.getData('peer_room') : null;
}

function setPeerRoomOnLobby(roomId) {
    return activeLobby ? activeLobby.setData('peer_room', roomId) : false;
}

function setLobbyData(key, value) {
    if (!activeLobby || !key) return false;
    try {
        return !!activeLobby.setData(String(key), String(value ?? ''));
    } catch (err) {
        console.warn('[Steam] setLobbyData failed:', err.message || err);
        return false;
    }
}

function getLobbyData(key) {
    if (!activeLobby || !key) return null;
    try {
        return activeLobby.getData(String(key)) || null;
    } catch (_) {
        return null;
    }
}

async function createSpectateFriendsLobby() {
    const steamClient = getClient();
    if (!steamClient) return null;
    leaveLobby();
    activeLobby = await steamClient.matchmaking.createLobby(
        steamClient.matchmaking.LobbyType.FriendsOnly,
        3
    );
    if (!activeLobby) return null;
    setLobbyData('ronk_mode', 'spectate');
    setLobbyData('ronk_app', String(STEAM_APP_ID));
    return activeLobby;
}

function isSpectateLobby() {
    return getLobbyData('ronk_mode') === 'spectate';
}

function getOpponentSteamId() {
    const steamClient = getClient();
    if (!activeLobby || !steamClient) return null;
    const me = steamClient.localplayer.getSteamId().steamId64;
    for (const member of activeLobby.getMembers()) {
        if (member.steamId64 !== me) return member.steamId64.toString();
    }
    return null;
}

function inviteFriends() {
    if (!activeLobby) return false;
    try {
        activeLobby.openInviteDialog();
        return true;
    } catch (err) {
        const steamClient = getClient();
        if (!steamClient) return false;
        try {
            steamClient.overlay.activateInviteDialog(activeLobby.id);
            return true;
        } catch (err2) {
            console.warn('[Steam] Could not open invite dialog:', err2.message);
            return false;
        }
    }
}

function openAddFriendDialog(steamId64) {
    if (!steamId64) return false;
    try {
        const { shell } = require('electron');
        shell.openExternal(`steam://friends/add/${steamId64}`);
        return true;
    } catch (_) {
        const steamClient = getClient();
        if (!steamClient) return false;
        try {
            steamClient.overlay.activateDialogToUser(
                steamClient.overlay.Dialog.Friends,
                BigInt(steamId64)
            );
            return true;
        } catch (err2) {
            console.warn('[Steam] Could not open add-friend dialog:', err2.message);
            return false;
        }
    }
}

function getLocalSteamId() {
    const steamClient = getClient();
    return steamClient ? steamClient.localplayer.getSteamId().steamId64.toString() : null;
}

function getLocalName() {
    const steamClient = getClient();
    return steamClient ? steamClient.localplayer.getName() : null;
}

/** Steamworks.js has no friends-list API; live spectate needs Rich Presence + relay (not implemented). */
function getFriendsList() {
    return null;
}

function onLobbyEvent(handler) {
    lobbyHandlers.add(handler);
    return () => lobbyHandlers.delete(handler);
}

function isCloudAvailable() {
    const steamClient = getClient();
    if (!steamClient?.cloud) return false;
    try {
        return steamClient.cloud.isEnabledForAccount() && steamClient.cloud.isEnabledForApp();
    } catch (_) {
        return false;
    }
}

async function readProgressCloud(filename = PROGRESS_CLOUD_FILE) {
    if (typeof process === 'undefined' || !process.versions?.electron) return null;
    try {
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('steam-cloud-read', filename);
        if (result?.ok) return result.data ?? null;
    } catch (err) {
        console.warn('[Steam] Cloud read failed:', err.message || err);
    }
    return null;
}

async function writeProgressCloud(content, filename = PROGRESS_CLOUD_FILE) {
    if (!content || typeof process === 'undefined' || !process.versions?.electron) return false;
    try {
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('steam-cloud-write', filename, content);
        return !!result?.ok;
    } catch (err) {
        console.warn('[Steam] Cloud write failed:', err.message || err);
        return false;
    }
}

function writeProgressCloudSync(content, filename = PROGRESS_CLOUD_FILE) {
    if (!content || typeof process === 'undefined' || !process.versions?.electron) return false;
    try {
        const { ipcRenderer } = require('electron');
        const result = ipcRenderer.sendSync('steam-cloud-write-sync', filename, content);
        return !!result?.ok;
    } catch (err) {
        console.warn('[Steam] Cloud sync write failed:', err.message || err);
        return false;
    }
}

const activatedAchievements = new Set();

function activateAchievement(achievementId) {
    if (!achievementId || activatedAchievements.has(achievementId)) return false;
    const steamClient = getClient();
    if (!steamClient?.achievement) return false;
    try {
        if (steamClient.achievement.isActivated(achievementId)) {
            activatedAchievements.add(achievementId);
            return true;
        }
        const ok = steamClient.achievement.activate(achievementId);
        if (ok) {
            activatedAchievements.add(achievementId);
            console.log('[Steam] Achievement unlocked:', achievementId);
        }
        return !!ok;
    } catch (err) {
        console.warn('[Steam] Achievement failed:', achievementId, err.message || err);
        return false;
    }
}

/** Alias used by steam-achievements.js */
function unlockAchievement(achievementId) {
    return activateAchievement(achievementId);
}

function openSteamOverlayUrl(url) {
    const steamClient = getClient();
    if (!steamClient?.overlay || !url) return false;
    try {
        if (typeof steamClient.overlay.activateToWebPage === 'function') {
            steamClient.overlay.activateToWebPage(url);
            return true;
        }
    } catch (err) {
        console.warn('[Steam] Overlay web page failed:', err.message || err);
    }
    try {
        const { shell } = require('electron');
        shell.openExternal(url);
        return true;
    } catch (_) {
        return false;
    }
}

function openStorePage() {
    // Steam client protocol — works even before Partner store page is public
    const steamUrl = `steam://store/${STEAM_APP_ID}`;
    const webUrl = `https://store.steampowered.com/app/${STEAM_APP_ID}/`;
    try {
        const { shell } = require('electron');
        shell.openExternal(steamUrl);
        return true;
    } catch (_) { /* fall through */ }
    return openSteamOverlayUrl(webUrl);
}

function openCommunityHub() {
    const url = `https://steamcommunity.com/app/${STEAM_APP_ID}`;
    return openSteamOverlayUrl(url);
}

function openSupportPage() {
    // Hub discussions until a dedicated support URL is set in Steamworks
    return openCommunityHub();
}

function getAchievementIds() {
    return { ...ACHIEVEMENT_IDS };
}

const RonkSteamBridgeAPI = {
    STEAM_APP_ID,
    PROGRESS_CLOUD_FILE,
    isAvailable,
    isOwnershipBlocked,
    getInitError,
    getClient,
    findOrCreatePublicLobby,
    createFriendsLobby,
    createSpectateFriendsLobby,
    joinLobbyById,
    leaveLobby,
    getActiveLobby,
    getCurrentLobbyId,
    isLobbyOwner,
    getPeerRoomFromLobby,
    setPeerRoomOnLobby,
    setLobbyData,
    getLobbyData,
    isSpectateLobby,
    getOpponentSteamId,
    inviteFriends,
    openAddFriendDialog,
    getLocalSteamId,
    getLocalName,
    getFriendsList,
    onLobbyEvent,
    isCloudAvailable,
    readProgressCloud,
    writeProgressCloud,
    writeProgressCloudSync,
    ACHIEVEMENT_IDS,
    activateAchievement,
    unlockAchievement,
    openSteamOverlayUrl,
    openStorePage,
    openCommunityHub,
    openSupportPage,
    getAchievementIds
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = RonkSteamBridgeAPI;
}
if (typeof window !== 'undefined') {
    window.__ronkSteamBridge = RonkSteamBridgeAPI;
}
