/**
 * Elite play-only brain — loads ai_learning/elite-pretrained.json.
 * No training / no TensorFlow / no model.fit. Elite (invincible) only.
 * Picks among already-safe heuristic moves using the full-match 56-feature net.
 */
(function (root) {
    'use strict';

    const FULL_STATE = 56;
    const ACTIONS = 4;
    const LAYERS = [FULL_STATE, 128, 128, 64, ACTIONS];

    function clamp(v, a, b) {
        return v < a ? a : v > b ? b : v;
    }

    function zeros(n) {
        return new Float64Array(n);
    }

    function ownerKey(p) {
        return String(p && p.id).startsWith('2') ? 'enemy' : 'player';
    }

    function skillId(p) {
        return (p && p.selectedSkill) || '';
    }

    function hasJoker(p, id) {
        return !!(p && Array.isArray(p.activeJokers) && p.activeJokers.includes(id));
    }

    function boardOwnerGrid(boards) {
        const g = [null, null, null, null, null, null, null, null, null];
        if (!boards) return g;
        for (const b of boards) {
            if (!b) continue;
            const i = (b.sy | 0) * 3 + (b.sx | 0);
            if (i >= 0 && i < 9) g[i] = b.owner || null;
        }
        return g;
    }

    function lineThreat(grid, who) {
        const lines = [
            [0, 1, 2], [3, 4, 5], [6, 7, 8],
            [0, 3, 6], [1, 4, 7], [2, 5, 8],
            [0, 4, 8], [2, 4, 6]
        ];
        let two = 0;
        for (const line of lines) {
            let n = 0;
            let empty = 0;
            for (const i of line) {
                if (grid[i] === who) n++;
                else if (!grid[i]) empty++;
            }
            if (n === 2 && empty === 1) two = 1;
        }
        return { two };
    }

    function rayOpen(p, dx, dy, occ, grid) {
        let d = 0;
        let x = p.x + dx;
        let y = p.y + dy;
        while (x >= 0 && y >= 0 && x < grid && y < grid && d < grid) {
            const k = y * grid + x;
            if (occ && occ[k]) break;
            d++;
            x += dx;
            y += dy;
        }
        return d / grid;
    }

    function nearestApple(p, apples) {
        if (!p || !apples || !apples.length) return null;
        let best = null;
        let bestD = 1e9;
        for (const a of apples) {
            if (!a || a.eaten) continue;
            const same = (a.boardSx == null || p.boardSx == null)
                || (a.boardSx === p.boardSx && a.boardSy === p.boardSy);
            const hops = same
                ? 0
                : (Math.abs((a.boardSx || 1) - (p.boardSx || 1))
                    + Math.abs((a.boardSy || 1) - (p.boardSy || 1)));
            const d = hops * 20 + Math.abs((a.x || 0) - p.x) + Math.abs((a.y || 0) - p.y);
            if (d < bestD) {
                bestD = d;
                best = a;
            }
        }
        return best ? { a: best, dist: bestD } : null;
    }

    function nearestCheckpoint(p, boards) {
        if (!p || !boards) return null;
        const who = ownerKey(p);
        let best = null;
        let bestD = 1e9;
        for (const b of boards) {
            if (!b || b.owner || !b.checkpoints) continue;
            const hops = Math.abs((b.sx || 0) - (p.boardSx || 1))
                + Math.abs((b.sy || 0) - (p.boardSy || 1));
            for (const cp of b.checkpoints) {
                if (!cp || cp.owner === who) continue;
                const d = hops * 20 + Math.abs(cp.x - p.x) + Math.abs(cp.y - p.y);
                if (d < bestD) {
                    bestD = d;
                    best = cp;
                }
            }
        }
        return best ? { cp: best, dist: bestD } : null;
    }

    function countOwned(boards, who) {
        if (!boards) return 0;
        let n = 0;
        for (const b of boards) if (b && b.owner === who) n++;
        return n;
    }

    function cdReady(p, last, ms) {
        if (!p) return 0;
        const now = Date.now();
        const reduce = p.jokerCooldownReduce || 1;
        return now - (p[last] || 0) > (ms * reduce) ? 1 : 0;
    }

    function buildFullState(p, o, extras) {
        const s = zeros(FULL_STATE);
        if (!p) return s;
        const grid = (extras && extras.GRID_COUNT) || 20;
        const occ = p._occGrid || null;

        s[0] = rayOpen(p, 0, -1, occ, grid);
        s[1] = rayOpen(p, 0, 1, occ, grid);
        s[2] = rayOpen(p, -1, 0, occ, grid);
        s[3] = rayOpen(p, 1, 0, occ, grid);
        if (o) {
            s[4] = clamp((o.x - p.x) / grid, -1, 1);
            s[5] = clamp((o.y - p.y) / grid, -1, 1);
            s[6] = (o.boardSx === p.boardSx && o.boardSy === p.boardSy) ? 1 : 0;
            s[7] = clamp(
                (Math.abs((o.boardSx || 1) - (p.boardSx || 1))
                    + Math.abs((o.boardSy || 1) - (p.boardSy || 1))) / 4,
                0, 1
            );
        }
        const flood = extras && extras.flood != null ? extras.flood : 20;
        s[8] = clamp(flood / 64, 0, 1);
        s[9] = clamp(Math.min(p.x, p.y, grid - 1 - p.x, grid - 1 - p.y) / 10, 0, 1);
        s[10] = p.jokerNoHunger ? 0 : clamp((p.hungerTimer || 0) / Math.max(1, p.hungerDuration || 1), 0, 1);
        s[11] = o && !o.jokerNoHunger
            ? clamp((o.hungerTimer || 0) / Math.max(1, o.hungerDuration || 1), 0, 1)
            : 0;

        const ap = nearestApple(p, extras && extras.apples);
        if (ap) {
            s[12] = clamp((ap.a.x - p.x) / grid, -1, 1);
            s[13] = clamp((ap.a.y - p.y) / grid, -1, 1);
            s[14] = clamp(ap.dist / 40, 0, 1);
        }
        const boards = extras && extras.worldBoards;
        const cp = nearestCheckpoint(p, boards);
        if (cp) {
            s[15] = clamp((cp.cp.x - p.x) / grid, -1, 1);
            s[16] = clamp((cp.cp.y - p.y) / grid, -1, 1);
            s[17] = clamp(cp.dist / 40, 0, 1);
        }
        const me = ownerKey(p);
        const them = me === 'player' ? 'enemy' : 'player';
        s[18] = countOwned(boards, me) / 9;
        s[19] = countOwned(boards, them) / 9;
        const gridOwn = boardOwnerGrid(boards);
        const mine = lineThreat(gridOwn, me);
        const theirs = lineThreat(gridOwn, them);
        s[20] = mine.two;
        s[21] = theirs.two;
        s[22] = p.isCharging ? 1 : 0;
        s[23] = o && o.isCharging ? 1 : 0;
        s[24] = cdReady(p, 'lastDash', 500);
        s[25] = cdReady(p, 'lastCharge', 4000);
        s[26] = cdReady(p, 'lastSkillUsed', 4000);
        const sk = skillId(p);
        s[27] = sk === 'clones' ? 1 : 0;
        s[28] = sk === 'laser' ? 1 : 0;
        s[29] = sk === 'infinite-trails' ? 1 : 0;
        s[30] = sk === 'infinite-charge' ? 1 : 0;
        s[31] = sk === 'invisible' ? 1 : 0;
        s[32] = hasJoker(p, 'extra-life') ? 1 : 0;
        s[33] = hasJoker(p, 'no-hunger') ? 1 : 0;
        s[34] = hasJoker(p, 'rage-joker') ? 1 : 0;
        s[35] = hasJoker(p, 'dash-cooldown') ? 1 : 0;
        s[36] = hasJoker(p, 'charge-plus') ? 1 : 0;
        s[37] = hasJoker(p, 'border-safe')
            ? 1
            : (hasJoker(p, 'double-effective') ? 0.66 : (hasJoker(p, 'friend-blocks') ? 0.33 : 0));
        const dir = p.dir || { x: 1, y: 0 };
        s[38] = dir.y < 0 ? 1 : 0;
        s[39] = dir.y > 0 ? 1 : 0;
        s[40] = dir.x < 0 ? 1 : 0;
        s[41] = dir.x > 0 ? 1 : 0;
        s[42] = p.isImmune ? 1 : 0;
        s[43] = p.infiniteChargeActive ? 1 : 0;
        s[44] = clamp((p.applesEaten || p._applesEaten || 0) / 10, 0, 1);
        const here = boards && boards.find((b) => b && b.sx === p.boardSx && b.sy === p.boardSy);
        s[45] = here && here.owner === me ? 1 : here && here.owner ? -1 : 0;
        s[46] = clamp(((extras && extras.myClones) || 0) / 2, 0, 1);
        s[47] = clamp((p.activeLaserRoutines && p.activeLaserRoutines.length) || 0, 0, 1) / 3;
        s[48] = o ? (skillId(o) === 'clones' ? 1 : 0) : 0;
        s[49] = o ? (skillId(o) === 'laser' ? 1 : 0) : 0;
        s[50] = o ? (skillId(o) === 'infinite-charge' ? 1 : 0) : 0;
        s[51] = o ? (o.isImmune ? 1 : 0) : 0;
        s[52] = o ? (o.infiniteChargeActive ? 1 : 0) : 0;
        s[53] = p.isDashing ? 1 : 0;
        s[54] = clamp((p.boardSx || 1) / 2, 0, 1);
        s[55] = clamp((p.boardSy || 1) / 2, 0, 1);
        return s;
    }

    function EliteMLP() {
        this.W = [];
        this.b = [];
        this.ready = false;
        this.meta = null;
        for (let i = 0; i < LAYERS.length - 1; i++) {
            const inn = LAYERS[i];
            const out = LAYERS[i + 1];
            this.W.push(zeros(inn * out));
            this.b.push(zeros(out));
        }
    }

    EliteMLP.prototype.fromJSON = function (json) {
        if (!json || !Array.isArray(json.weights)) return false;
        try {
            for (let L = 0; L < this.W.length; L++) {
                const kernel = json.weights[L * 2];
                const bias = json.weights[L * 2 + 1];
                if (!kernel || !bias || !kernel.values || !bias.values) return false;
                const inn = LAYERS[L];
                const out = LAYERS[L + 1];
                for (let j = 0; j < out; j++) {
                    for (let i = 0; i < inn; i++) {
                        this.W[L][j * inn + i] = kernel.values[i * out + j];
                    }
                }
                this.b[L].set(bias.values);
            }
            this.meta = {
                kind: json.kind,
                games: json.games,
                trainedAt: json.trainedAt,
                architecture: json.architecture
            };
            this.ready = true;
            return true;
        } catch (_) {
            this.ready = false;
            return false;
        }
    };

    EliteMLP.prototype.forward = function (x) {
        let a = x;
        for (let L = 0; L < this.W.length; L++) {
            const inn = LAYERS[L];
            const out = LAYERS[L + 1];
            const w = this.W[L];
            const b = this.b[L];
            const next = zeros(out);
            const last = L === this.W.length - 1;
            for (let j = 0; j < out; j++) {
                let sum = b[j];
                const off = j * inn;
                for (let i = 0; i < inn; i++) sum += w[off + i] * a[i];
                next[j] = last ? sum : Math.max(0, sum);
            }
            a = next;
        }
        return a;
    };

    EliteMLP.prototype.act = function (state, valid) {
        if (!valid || !valid.length) return 0;
        const q = this.forward(state);
        let best = valid[0];
        let bestQ = -Infinity;
        for (let i = 0; i < valid.length; i++) {
            const a = valid[i];
            if (q[a] > bestQ) {
                bestQ = q[a];
                best = a;
            }
        }
        return best;
    };

    const net = new EliteMLP();
    let loadPromise = null;

    function collectExtras(p, gridCount) {
        const grid = gridCount || ((typeof GRID_COUNT === 'number') ? GRID_COUNT : 20);
        let appleList = null;
        let boards = null;
        let clonesList = null;
        try { if (typeof apples !== 'undefined') appleList = apples; } catch (_) { /* ignore */ }
        try { if (typeof worldBoards !== 'undefined') boards = worldBoards; } catch (_) { /* ignore */ }
        try { if (typeof clones !== 'undefined') clonesList = clones; } catch (_) { /* ignore */ }

        let myClones = 0;
        if (clonesList && p) {
            const base = String(p.id).split('_')[0];
            for (let i = 0; i < clonesList.length; i++) {
                const c = clonesList[i];
                if (c && !c.isDead && String(c.id).split('_')[0] === base) myClones++;
            }
        }
        let flood = 24;
        if (p && typeof AI_HELPERS !== 'undefined' && AI_HELPERS.getAccessibleSpace) {
            try {
                flood = AI_HELPERS.getAccessibleSpace(
                    p.x + (p.dir?.x || 0),
                    p.y + (p.dir?.y || 0),
                    p, null, grid, 48
                );
            } catch (_) { /* ignore */ }
        }
        return {
            GRID_COUNT: grid,
            apples: appleList,
            worldBoards: boards,
            myClones,
            flood
        };
    }

    function isEliteDiff(p, diff) {
        if (!p || p.isClone) return false;
        if (diff && diff.unbeatableMode) return true;
        const level = (p && p.aiDifficulty)
            || (typeof window !== 'undefined' && window.currentBotDifficulty)
            || '';
        if (String(level).toLowerCase() === 'invincible') return true;
        if (typeof isEliteAi === 'function') {
            try { return !!isEliteAi(p, diff); } catch (_) { /* ignore */ }
        }
        return false;
    }

    /**
     * Elite-only: among safe move indices, pick the net's favorite.
     * Works for play-vs-Elite and spectate Elite×Elite (any invincible AI cube).
     */
    function pickEliteSafeMove(p, opponent, gridCount, diff, safeIdxs, heuristicIdx) {
        if (!net.ready) return null;
        if (!p || p.isClone) return null;
        if (!isEliteDiff(p, diff)) return null;
        if (!safeIdxs || !safeIdxs.length) return null;
        try {
            const extras = collectExtras(p, gridCount);
            const state = buildFullState(p, opponent, extras);
            const chosen = net.act(state, safeIdxs);
            return Number.isInteger(chosen) ? chosen : null;
        } catch (_) {
            return heuristicIdx;
        }
    }

    function loadFromUrl(url) {
        if (loadPromise) return loadPromise;
        loadPromise = fetch(url)
            .then((r) => {
                if (!r.ok) throw new Error('elite brain HTTP ' + r.status);
                return r.json();
            })
            .then((json) => {
                const ok = net.fromJSON(json);
                if (ok) {
                    console.info('[EliteBrain] loaded', net.meta && net.meta.kind, 'games=', net.meta && net.meta.games);
                } else {
                    console.warn('[EliteBrain] weight load failed');
                }
                return ok;
            })
            .catch((err) => {
                console.warn('[EliteBrain] unavailable — Elite stays heuristic', err && err.message);
                return false;
            });
        return loadPromise;
    }

    function ensureReady() {
        if (net.ready) return true;
        if (!loadPromise) {
            autoLoad();
        }
        return net.ready;
    }

    function autoLoad() {
        const base = 'ai_learning/elite-pretrained.json';
        return loadFromUrl(base + '?v=202608262250');
    }

    const api = {
        ready: () => net.ready,
        ensureReady,
        meta: () => net.meta,
        loadFromUrl,
        autoLoad,
        pickEliteSafeMove,
        isEliteDiff,
        buildFullState
    };

    root.EliteBrain = api;
    if (typeof window !== 'undefined') {
        window.EliteBrain = api;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => { autoLoad(); });
        } else {
            autoLoad();
        }
    }
})(typeof globalThis !== 'undefined' ? globalThis : window);
