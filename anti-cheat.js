/**
 * RonkBonk client-side anti-cheat (online-focused).
 * Host validates guest packets; both clients detect tamper/speed hacks.
 * Match-local kicks only — never Steam account bans.
 */
(function () {
    const MAX_STRIKES = 5;
    const MAX_MOVE_PER_TICK = 12;
    const MAX_PACKETS_PER_SEC = 72;
    const MIN_PACKET_INTERVAL_MS = 4;
    const MAX_TRAIL_POINTS_PER_PACKET = 8;
    const MIN_FRAME_MS = 2;
    const MAX_LOGIC_TICKS_PER_SEC = 90;

    const HOST_ONLY_TYPES = new Set([
        'game-start', 'continue-confirm', 'round-score', 'world-snapshot', 'fx-event'
    ]);

    const state = {
        strikes: 0,
        remote: null,
        packetTimes: [],
        frameTimes: [],
        logicTicks: 0,
        logicWindowStart: Date.now(),
        lastViolation: '',
        lastStrikeAt: 0,
        sessionSeed: Math.floor(Math.random() * 1e9),
        sessionSecret: null
    };

    function dist(ax, ay, bx, by) {
        return Math.abs(ax - bx) + Math.abs(ay - by);
    }

    function validDir(dx, dy) {
        const x = Number(dx);
        const y = Number(dy);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        if (x === 0 && y === 0) return true;
        return (Math.abs(x) + Math.abs(y)) === 1;
    }

    function checksum(packet, seed) {
        const copy = Object.assign({}, packet);
        delete copy.sig;
        const str = String(seed) + JSON.stringify(copy);
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
    }

    function hmacSeed() {
        if (state.sessionSecret) return checksum({ k: state.sessionSecret }, state.sessionSeed);
        return state.sessionSeed;
    }

    function createRemoteTracker() {
        return {
            x: null,
            y: null,
            bsx: null,
            bsy: null,
            lastPacketAt: 0
        };
    }

    function wrapDist1d(a, b, n) {
        const d = Math.abs(a - b);
        return Math.min(d, n - d);
    }

    function decayStrikes() {
        const now = Date.now();
        if (state.strikes > 0 && now - state.lastStrikeAt > 45000) {
            state.strikes = Math.max(0, state.strikes - 1);
            state.lastStrikeAt = now;
        }
    }

    function resetSession() {
        state.strikes = 0;
        state.remote = createRemoteTracker();
        state.packetTimes = [];
        state.frameTimes = [];
        state.logicTicks = 0;
        state.logicWindowStart = Date.now();
        state.lastViolation = '';
        state.lastStrikeAt = 0;
        state.sessionSeed = Math.floor(Math.random() * 1e9);
        // Keep sessionSecret if host already set lobby HMAC for this match
    }

    function setSessionSecret(secret) {
        state.sessionSecret = secret ? String(secret) : null;
    }

    function recordViolation(reason) {
        decayStrikes();
        state.strikes += 1;
        state.lastStrikeAt = Date.now();
        state.lastViolation = reason;
        console.warn('[AntiCheat]', reason, `strike ${state.strikes}/${MAX_STRIKES}`);
        if (typeof window.onAntiCheatViolation === 'function') {
            window.onAntiCheatViolation(reason, state.strikes);
        }
        return state.strikes >= MAX_STRIKES;
    }

    function validateSyncPacket(data, gridCount) {
        if (!data || (data.t !== 's' && data.type !== 'sync')) {
            return { valid: true };
        }

        decayStrikes();
        const now = Date.now();
        if (!state.remote) state.remote = createRemoteTracker();

        if (state.remote.lastPacketAt && now - state.remote.lastPacketAt < MIN_PACKET_INTERVAL_MS) {
            const kick = recordViolation('PACKET_FLOOD');
            return { valid: false, reason: 'PACKET_FLOOD', kick };
        }

        state.packetTimes.push(now);
        state.packetTimes = state.packetTimes.filter((t) => now - t < 1000);
        if (state.packetTimes.length > MAX_PACKETS_PER_SEC) {
            const kick = recordViolation('SPEED_HACK');
            return { valid: false, reason: 'SPEED_HACK', kick };
        }

        const x = Number(data.x);
        const y = Number(data.y);
        const dx = data.dx !== undefined ? Number(data.dx) : Number(data.dir && data.dir.x);
        const dy = data.dy !== undefined ? Number(data.dy) : Number(data.dir && data.dir.y);

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            const kick = recordViolation('INVALID_POSITION');
            return { valid: false, reason: 'INVALID_POSITION', kick };
        }

        if (x < 0 || y < 0 || x >= gridCount || y >= gridCount) {
            const kick = recordViolation('OUT_OF_BOUNDS');
            return { valid: false, reason: 'OUT_OF_BOUNDS', kick };
        }

        if (!validDir(dx, dy)) {
            const kick = recordViolation('INVALID_DIRECTION');
            return { valid: false, reason: 'INVALID_DIRECTION', kick };
        }

        if (Array.isArray(data.tr) && data.tr.length > MAX_TRAIL_POINTS_PER_PACKET) {
            const kick = recordViolation('TRAIL_OVERFLOW');
            return { valid: false, reason: 'TRAIL_OVERFLOW', kick };
        }

        if (state.remote.x !== null && state.remote.y !== null) {
            const bsx = Number.isInteger(data.bsx) ? data.bsx : state.remote.bsx;
            const bsy = Number.isInteger(data.bsy) ? data.bsy : state.remote.bsy;
            const boardChanged = (state.remote.bsx != null && bsx != null && bsx !== state.remote.bsx)
                || (state.remote.bsy != null && bsy != null && bsy !== state.remote.bsy);
            const jump = boardChanged
                ? (wrapDist1d(state.remote.x, x, gridCount) + wrapDist1d(state.remote.y, y, gridCount))
                : dist(state.remote.x, state.remote.y, x, y);
            const dashing = data.ds === 1 || data.isDashing === true;
            const charging = data.ch === 1 || data.isCharging === true;
            // Board hops + charge leaps need headroom (avoid false TELEPORT after lag)
            const maxJump = boardChanged ? MAX_MOVE_PER_TICK + 4
                : (dashing || charging ? MAX_MOVE_PER_TICK : 3);
            if (jump > maxJump) {
                const kick = recordViolation('TELEPORT');
                return { valid: false, reason: 'TELEPORT', kick };
            }
        }

        state.remote.x = x;
        state.remote.y = y;
        if (Number.isInteger(data.bsx)) state.remote.bsx = data.bsx;
        if (Number.isInteger(data.bsy)) state.remote.bsy = data.bsy;
        state.remote.lastPacketAt = now;
        return { valid: true };
    }

    function validateSettingsPacket(data) {
        if (!data || data.type !== 'settings') return { valid: true };

        if (data.nickname !== undefined) {
            const nick = String(data.nickname);
            if (nick.length > 24) {
                const kick = recordViolation('INVALID_NICKNAME');
                return { valid: false, reason: 'INVALID_NICKNAME', kick };
            }
        }

        if (data.image !== undefined && data.image !== null) {
            const img = String(data.image);
            if (img.length > 900000) {
                const kick = recordViolation('PAYLOAD_OVERFLOW');
                return { valid: false, reason: 'PAYLOAD_OVERFLOW', kick };
            }
        }

        return { valid: true };
    }

    function validateAuthorizedPacket(data, role) {
        if (!data || !data.type) return { valid: true };
        if (!HOST_ONLY_TYPES.has(data.type)) return { valid: true };
        if (role === 'host') {
            const kick = recordViolation('FORGED_HOST_PACKET');
            return { valid: false, reason: 'FORGED_HOST_PACKET', kick };
        }
        return { valid: true };
    }

    function sealPacket(packet) {
        const sealed = Object.assign({}, packet);
        sealed.ts = Date.now();
        // Prefer lobby shared secret so both peers verify the same way (not self-signed ac alone)
        const seed = state.sessionSecret
            ? checksum({ k: String(state.sessionSecret) }, 4887920)
            : state.sessionSeed;
        sealed.ac = seed;
        sealed.sig = checksum(sealed, seed);
        return sealed;
    }

    function verifySealedPacket(packet) {
        if (!packet || !packet.sig) return false;
        const seed = state.sessionSecret
            ? checksum({ k: String(state.sessionSecret) }, 4887920)
            : (packet.ac !== undefined ? packet.ac : state.sessionSeed);
        const expected = checksum(packet, seed);
        return packet.sig === expected;
    }

    function tickLogicFrame() {
        const now = Date.now();
        state.logicTicks += 1;

        if (now - state.logicWindowStart >= 1000) {
            if (state.logicTicks > MAX_LOGIC_TICKS_PER_SEC) {
                recordViolation('LOGIC_SPEED_HACK');
                state.logicTicks = 0;
                state.logicWindowStart = now;
                // Soft flag — hitch ≠ cheat; game.js resyncs instead of kicking
                return { valid: false, reason: 'LOGIC_SPEED_HACK', kick: false };
            }
            state.logicTicks = 0;
            state.logicWindowStart = now;
        }

        return { valid: true };
    }

    function tickRenderFrame(deltaMs) {
        if (!Number.isFinite(deltaMs) || deltaMs <= 0) return { valid: true };

        const now = Date.now();
        state.frameTimes.push(now);
        state.frameTimes = state.frameTimes.filter((t) => now - t < 1000);

        if (deltaMs < MIN_FRAME_MS && state.frameTimes.length > 320) {
            // Soft flag only — game.js prefers warn+resync over kick for RENDER_SPEED_HACK
            recordViolation('RENDER_SPEED_HACK');
            return { valid: false, reason: 'RENDER_SPEED_HACK', kick: false };
        }

        return { valid: true };
    }

    // Window-size DevTools heuristic removed (false positives on ultrawide / overlay).
    // Packaged Electron closes DevTools via main process only.
    function detectDevTools() {
        return false;
    }

    function watchDevTools() {
        // no-op — do not poll outer−inner dimensions
    }

    window.RonkAntiCheat = {
        resetSession,
        setSessionSecret,
        validateSyncPacket,
        validateSettingsPacket,
        validateAuthorizedPacket,
        sealPacket,
        sealSyncPacket: sealPacket,
        verifySealedPacket,
        tickLogicFrame,
        tickRenderFrame,
        detectDevTools,
        watchDevTools,
        getStrikes: () => state.strikes,
        getLastViolation: () => state.lastViolation,
        MAX_STRIKES
    };

    resetSession();
})();
