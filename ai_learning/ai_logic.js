// RonkBonk AI — heuristic pathfinding + Elite play-only brain (no training)

const AI_EMPTY_TRAIL = [];
const AI_BFS_QUEUE = [];
let AI_BFS_VISITED = new Uint16Array(400); // classic 20×20 local board — stamp ids, no full clear
let AI_BFS_GRID_COUNT = 0;
let AI_BFS_GEN = 1;
let AI_SPACE_CACHE_TICK = -1;
const AI_SPACE_CACHE = new Map();

const AI_DIRS = [
    { idx: 0, d: { x: 0, y: -1 } },
    { idx: 1, d: { x: 0, y: 1 } },
    { idx: 2, d: { x: -1, y: 0 } },
    { idx: 3, d: { x: 1, y: 0 } }
];

const AI_HELPERS = {
    occupancyGrid: null,
    
    sameBoardEnt(p, ent) {
        if (!p || !ent) return false;
        const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
        const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
        const esx = Number.isInteger(ent.boardSx) ? ent.boardSx : psx;
        const esy = Number.isInteger(ent.boardSy) ? ent.boardSy : psy;
        return esx === psx && esy === psy;
    },

    /** Same army (self / clones / owner) — always know own trail & cube. */
    aiSameArmy(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        const ab = String(a.id).split('_')[0];
        const bb = String(b.id).split('_')[0];
        return !!ab && ab === bb;
    },

    /** Invisible trail (passive or active) — enemies must not see exact trail cells. */
    aiCanSenseTrail(observer, target) {
        if (!target) return false;
        // Invisible AI (and its clones) still see their own trail/cube
        if (this.aiSameArmy(observer, target)) return true;
        if (target.selectedSkill === 'invisible' || target.hasInvisibleTrail) return false;
        if (target.fullInvisibleActive) return false;
        return true;
    },

    /** Full invis hide: enemies must not know exact cube coords. */
    aiCanSenseCube(observer, target) {
        if (!target) return false;
        if (this.aiSameArmy(observer, target)) return true;
        if (target.fullInvisibleActive) return false;
        return true;
    },

    /**
     * What the AI believes about the opponent.
     * Visible cube → exact. Full cloak → dead-reckon estimate from last sighting.
     */
    aiResolveOpponentView(observer, target) {
        if (!target) {
            return {
                x: 0, y: 0, boardSx: 1, boardSy: 1,
                dir: { x: 0, y: 0 },
                seeCube: false, seeTrail: false, confidence: 0
            };
        }
        const seeTrail = this.aiCanSenseTrail(observer, target);
        const seeCube = this.aiCanSenseCube(observer, target);
        if (!observer._aiOppSense) observer._aiOppSense = {};

        if (seeCube) {
            observer._aiOppSense = {
                x: target.x,
                y: target.y,
                boardSx: Number.isInteger(target.boardSx) ? target.boardSx : 1,
                boardSy: Number.isInteger(target.boardSy) ? target.boardSy : 1,
                dir: { x: target.dir?.x || 0, y: target.dir?.y || 0 },
                tick: typeof RonkAI !== 'undefined' ? RonkAI.globalTick : 0
            };
            return {
                x: target.x,
                y: target.y,
                boardSx: observer._aiOppSense.boardSx,
                boardSy: observer._aiOppSense.boardSy,
                dir: { ...observer._aiOppSense.dir },
                seeCube: true,
                seeTrail,
                confidence: 1
            };
        }

        // Full invis — estimate from last known + drift
        const last = observer._aiOppSense || null;
        const gc = (typeof GRID_COUNT === 'number') ? GRID_COUNT : 20;
        if (!last || last.x == null) {
            // No prior lock: wild guess near board center of last known board / current board
            const sx = Number.isInteger(target.boardSx) ? target.boardSx : (Number.isInteger(observer.boardSx) ? observer.boardSx : 1);
            const sy = Number.isInteger(target.boardSy) ? target.boardSy : (Number.isInteger(observer.boardSy) ? observer.boardSy : 1);
            const gx = Math.floor(gc / 2) + (Math.floor(Math.random() * 5) - 2);
            const gy = Math.floor(gc / 2) + (Math.floor(Math.random() * 5) - 2);
            return {
                x: Math.max(1, Math.min(gc - 2, gx)),
                y: Math.max(1, Math.min(gc - 2, gy)),
                boardSx: sx,
                boardSy: sy,
                dir: { x: target.dir?.x || 0, y: target.dir?.y || 0 },
                seeCube: false,
                seeTrail: false,
                confidence: 0.15
            };
        }

        const age = Math.max(0, ((typeof RonkAI !== 'undefined' ? RonkAI.globalTick : 0) - (last.tick || 0)));
        const drift = Math.min(8, 1 + Math.floor(age / 4));
        const dx = (last.dir?.x || 0) * Math.min(age, 6) + (Math.floor(Math.random() * (drift * 2 + 1)) - drift);
        const dy = (last.dir?.y || 0) * Math.min(age, 6) + (Math.floor(Math.random() * (drift * 2 + 1)) - drift);
        let ex = last.x + dx;
        let ey = last.y + dy;
        ex = Math.max(0, Math.min(gc - 1, ex));
        ey = Math.max(0, Math.min(gc - 1, ey));
        // Soft-update estimate so consecutive thinks stay coherent
        observer._aiOppSense = {
            x: ex,
            y: ey,
            boardSx: last.boardSx,
            boardSy: last.boardSy,
            dir: { x: last.dir?.x || 0, y: last.dir?.y || 0 },
            tick: last.tick
        };
        return {
            x: ex,
            y: ey,
            boardSx: last.boardSx,
            boardSy: last.boardSy,
            dir: { ...observer._aiOppSense.dir },
            seeCube: false,
            seeTrail: false,
            confidence: Math.max(0.12, 0.7 - age * 0.04)
        };
    },

    trailOnBoard(player, sx, sy) {
        if (!player || !Array.isArray(player.trail) || !player.trail.length) return AI_EMPTY_TRAIL;
        const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
        const gen = player._trailGen || 0;
        if (!player._trailByBoard || player._trailIndexLen !== player.trail.length || player._trailIndexGen !== gen) {
            const need = n * n;
            const boards = player._trailByBoard || [];
            while (boards.length < need) boards.push([]);
            for (let i = 0; i < need; i++) boards[i].length = 0;
            for (let i = 0, len = player.trail.length; i < len; i++) {
                const t = player.trail[i];
                const tsx = Number.isInteger(t.boardSx) ? t.boardSx : 1;
                const tsy = Number.isInteger(t.boardSy) ? t.boardSy : 1;
                if (tsx >= 0 && tsy >= 0 && tsx < n && tsy < n) {
                    boards[tsx + tsy * n].push({
                        x: Math.floor(Number(t.x)),
                        y: Math.floor(Number(t.y)),
                        boardSx: tsx,
                        boardSy: tsy
                    });
                }
            }
            player._trailByBoard = boards;
            player._trailIndexLen = player.trail.length;
            player._trailIndexGen = gen;
        }
        if (sx >= 0 && sy >= 0 && sx < n && sy < n) return player._trailByBoard[sx + sy * n];
        return AI_EMPTY_TRAIL;
    },

    fillOccupancyGrid(grid, p, opponent, gridCount) {
        grid.fill(0);
        const gc = gridCount;
        const sense = this.aiResolveOpponentView(p, opponent);
        const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
        const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
        const markTrailCells = (trail) => {
            if (!trail || !trail.length) return;
            const len = trail.length;
            const start = len > 480 ? len - 480 : 0;
            for (let i = start; i < len; i++) {
                const t = trail[i];
                const tx = Math.floor(Number(t.x));
                const ty = Math.floor(Number(t.y));
                if (tx >= 0 && tx < gc && ty >= 0 && ty < gc) grid[ty * gc + tx] = 1;
            }
        };

        const safeFromTrails = p.isImmune || p.isCharging || p.isDashing || p.chargeAnimTicks > 0 || p.dashAnimTicks > 0;
        if (!safeFromTrails) {
            if (sense.seeTrail && opponent) {
                markTrailCells(this.trailOnBoard(opponent, psx, psy));
            }
            // Own / same-army trail is NEVER lethal — do not mark as occupied
        }

        if (!p.isImmune && typeof laserLines !== 'undefined') {
            for (let i = 0, len = laserLines.length; i < len; i++) {
                const laser = laserLines[i];
                const skipLaser = (typeof isEnemyLaserLethalTo === 'function')
                    ? !isEnemyLaserLethalTo(laser, p)
                    : ((typeof isFriendlyLaserOwner === 'function' && isFriendlyLaserOwner(laser, p))
                        || (laser.owner === p || this.aiSameArmy(laser.owner, p)
                            || (laser.ownerId != null && String(laser.ownerId) === String(p.id).split('_')[0])));
                if (skipLaser) continue;
                if (Number.isInteger(laser.boardSx) && Number.isInteger(laser.boardSy)) {
                    if (laser.boardSx !== p.boardSx || laser.boardSy !== p.boardSy) continue;
                }
                const pos = Math.floor(Number(laser.pos));
                const warnTicks = laser.warningTicks
                    || Math.round((typeof TICK_RATE !== 'undefined' ? TICK_RATE : 13.5) * 0.5);
                // Solid phase only — warning strips are scored in scoreMove, not hard-blocked here
                if ((laser.ticks || 0) < warnTicks) continue;
                if (laser.isHorizontal) {
                    if (pos >= 0 && pos < gc) {
                        const row = pos * gc;
                        for (let x = 0; x < gc; x++) grid[row + x] = 1;
                    }
                } else if (pos >= 0 && pos < gc) {
                    for (let y = 0; y < gc; y++) grid[y * gc + pos] = 1;
                }
            }
        }

        // Enemy Friend Walls — bots must path around them (owner/clones pass through)
        if (typeof friendWalls !== 'undefined' && friendWalls.length) {
            for (let wi = 0; wi < friendWalls.length; wi++) {
                const wall = friendWalls[wi];
                if (!wall) continue;
                const wId = wall.ownerId != null ? String(wall.ownerId) : '';
                if (!wId && !wall.owner) continue;
                if (!Number.isInteger(wall.boardSx) || !Number.isInteger(wall.boardSy)) continue;
                if (wall.boardSx !== psx || wall.boardSy !== psy) continue;
                if (typeof isFriendlyWallOwner === 'function' && isFriendlyWallOwner(wall, p)) continue;
                const wx = Math.floor(Number(wall.x));
                const wy = Math.floor(Number(wall.y));
                if (wx >= 0 && wx < gc && wy >= 0 && wy < gc) grid[wy * gc + wx] = 1;
            }
        }

        if (typeof clones !== 'undefined') {
            const pBase = String(p.id).split('_')[0];
            for (let i = 0, len = clones.length; i < len; i++) {
                const clone = clones[i];
                if (!clone || clone.isDead) continue;
                if (String(clone.id).split('_')[0] === pBase) continue;
                if (!this.sameBoardEnt(p, clone)) continue;
                // Clones of an invisible owner: hide if full cloak
                const cloneOwner = (String(clone.id).split('_')[0] === String(opponent.id).split('_')[0])
                    ? opponent : null;
                if (cloneOwner && !this.aiCanSenseCube(p, cloneOwner)) continue;
                if (clone.x >= 0 && clone.x < gc && clone.y >= 0 && clone.y < gc) {
                    grid[clone.y * gc + clone.x] = 1;
                }
                if (!safeFromTrails && sense.seeTrail) {
                    const cloneTrail = clone.trail;
                    if (cloneTrail && cloneTrail.length) {
                        const tLen = cloneTrail.length;
                        const tStart = tLen > 320 ? tLen - 320 : 0;
                        for (let j = tStart; j < tLen; j++) {
                            const t = cloneTrail[j];
                            if (!this.sameBoardEnt(p, t)) continue;
                            if (t.x >= 0 && t.x < gc && t.y >= 0 && t.y < gc) grid[t.y * gc + t.x] = 1;
                        }
                    }
                }
            }
        }

        // Cube cell: exact if visible, estimated soft block if cloaked
        if (sense.boardSx === (Number.isInteger(p.boardSx) ? p.boardSx : 1)
            && sense.boardSy === (Number.isInteger(p.boardSy) ? p.boardSy : 1)
            && sense.x >= 0 && sense.x < gc && sense.y >= 0 && sense.y < gc) {
            if (sense.seeCube || sense.confidence > 0.35) {
                grid[sense.y * gc + sense.x] = 1;
            }
        }
    },

    bindGrid(grid) {
        this.occupancyGrid = grid;
    },

    isOccupied(nx, ny, p, opponent, gridCount) {
        // Walking off the local board is never a valid step.
        // Board travel is dash/charge only — Border Safe only prevents death (clamp), it does not walk-cross.
        if (nx < 0 || nx >= gridCount || ny < 0 || ny >= gridCount) {
            return true;
        }
        if (this.occupancyGrid) return this.occupancyGrid[ny * gridCount + nx] === 1;

        // Friend Walls (fallback when grid not built this tick)
        if (typeof friendWalls !== 'undefined' && friendWalls.length) {
            const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
            const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
            for (let wi = 0; wi < friendWalls.length; wi++) {
                const wall = friendWalls[wi];
                if (!wall) continue;
                if (!Number.isInteger(wall.boardSx) || !Number.isInteger(wall.boardSy)) continue;
                if (wall.boardSx !== psx || wall.boardSy !== psy) continue;
                if (typeof isFriendlyWallOwner === 'function' && isFriendlyWallOwner(wall, p)) continue;
                if (Math.floor(Number(wall.x)) === nx && Math.floor(Number(wall.y)) === ny) return true;
            }
        }

        const safeFromTrails = p.isImmune || p.isCharging || p.isDashing || p.chargeAnimTicks > 0 || p.dashAnimTicks > 0;
        if (!safeFromTrails) {
            // Own trail is safe — only enemy paint blocks
            const seeTrail = this.aiCanSenseTrail(p, opponent);
            if (seeTrail && opponent?.trail?.some(t => this.sameBoardEnt(p, t) && t.x === nx && t.y === ny)) {
                return true;
            }
        }
        const sense = this.aiResolveOpponentView(p, opponent);
        if (sense.seeCube && this.sameBoardEnt(p, opponent) && opponent.x === nx && opponent.y === ny) return true;
        if (!sense.seeCube && sense.confidence > 0.4
            && sense.boardSx === (Number.isInteger(p.boardSx) ? p.boardSx : 1)
            && sense.boardSy === (Number.isInteger(p.boardSy) ? p.boardSy : 1)
            && sense.x === nx && sense.y === ny) return true;
        return false;
    },

    crossesSector(_x0, _y0, x1, y1) {
        if (typeof GRID_COUNT !== 'number') return false;
        return x1 < 0 || x1 >= GRID_COUNT || y1 < 0 || y1 >= GRID_COUNT;
    },

    /** Distance to nearest lethal board edge. */
    distToSectorEdge(x, y, gridCount) {
        return Math.min(x, y, gridCount - 1 - x, gridCount - 1 - y);
    },

    boardHopDist(sx0, sy0, sx1, sy1) {
        const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
        const dx = Math.min(Math.abs(sx0 - sx1), n - Math.abs(sx0 - sx1));
        const dy = Math.min(Math.abs(sy0 - sy1), n - Math.abs(sy0 - sy1));
        return dx + dy;
    },

    /** Shortest signed wrap delta on a 3-board ring (−1, 0, or +1 typically). */
    signedBoardDelta(from, to) {
        const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
        let d = ((to - from) % n + n) % n;
        if (d > Math.floor(n / 2)) d -= n;
        return d;
    },

    wrapBoard(v) {
        const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
        return ((v % n) + n) % n;
    },

    boardOwnershipStats(ownerKey) {
        if (typeof worldBoards === 'undefined' || !worldBoards || !worldBoards.length) {
            return { owned: 0, oppOwned: 0, total: 0, unclaimed: 0 };
        }
        const tick = (typeof RonkAI !== 'undefined') ? RonkAI.globalTick : -1;
        if (this._ownTick === tick && this._ownKey === ownerKey && this._ownRes) return this._ownRes;
        const oppKey = ownerKey === 'player' ? 'enemy' : 'player';
        let owned = 0;
        let oppOwned = 0;
        for (let i = 0; i < worldBoards.length; i++) {
            const b = worldBoards[i];
            if (!b) continue;
            if (b.owner === ownerKey) owned++;
            else if (b.owner === oppKey) oppOwned++;
        }
        const result = {
            owned,
            oppOwned,
            total: worldBoards.length,
            unclaimed: worldBoards.length - owned - oppOwned
        };
        this._ownTick = tick;
        this._ownKey = ownerKey;
        this._ownRes = result;
        return result;
    },

    /**
     * Tic-tac-toe board strategy: complete our line > block theirs > center >
     * finish a board with 2 of our CPs > nearest claimable board.
     * Returns { sx, sy, cpX, cpY, dist, priority } or null.
     */
    pickBoardStrategyTarget(x, y, ownerKey, player, opts = null) {
        if (typeof worldBoards === 'undefined' || !worldBoards || !worldBoards.length) return null;
        const psx = player && Number.isInteger(player.boardSx) ? player.boardSx : 1;
        const psy = player && Number.isInteger(player.boardSy) ? player.boardSy : 1;
        const gc = (typeof GRID_COUNT === 'number') ? GRID_COUNT : 20;
        const oppKey = ownerKey === 'player' ? 'enemy' : 'player';
        const lines = (typeof BOARD_TTT_LINES !== 'undefined' && BOARD_TTT_LINES)
            ? BOARD_TTT_LINES
            : [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
        const excludeKeys = opts && opts.excludeKeys instanceof Set ? opts.excludeKeys : null;
        const tick = (typeof RonkAI !== 'undefined') ? RonkAI.globalTick : -1;
        let excludeSig = '';
        if (excludeKeys) excludeKeys.forEach((k) => { excludeSig += k + ','; });
        const priKey = ownerKey + '|' + (player && player._missionSx) + '_' + (player && player._missionSy) + '|' + excludeSig;
        let boardPri;
        if (player && player._aiPriTick === tick && player._aiPriKey === priKey && player._aiPri) {
            boardPri = player._aiPri;
        } else {
            boardPri = (player && player._aiPriBuf && player._aiPriBuf.length === worldBoards.length)
                ? player._aiPriBuf
                : new Int16Array(worldBoards.length);
            for (let i = 0; i < worldBoards.length; i++) {
                const b = worldBoards[i];
                if (!b || b.owner === ownerKey) {
                    boardPri[i] = -9999;
                    continue;
                }
                if (excludeKeys && excludeKeys.has(`${b.sx}_${b.sy}`)) {
                    boardPri[i] = -9999;
                    continue;
                }
                let pri = 100;
                if (!b.owner) pri += 220;
                if (b.sx === 1 && b.sy === 1) pri += 420;
                let ours = 0;
                const cps0 = b.checkpoints;
                if (cps0) {
                    for (let ci = 0; ci < cps0.length; ci++) {
                        if (cps0[ci] && cps0[ci].owner === ownerKey) ours++;
                    }
                }
                if (ours >= 2) pri += 2800;
                else if (ours === 1) pri += 400;
                boardPri[i] = pri;
            }

            if (player && Number.isInteger(player._missionSx) && Number.isInteger(player._missionSy)) {
                for (let i = 0; i < worldBoards.length; i++) {
                    const b = worldBoards[i];
                    if (!b || boardPri[i] <= -9000) continue;
                    if (b.sx === player._missionSx && b.sy === player._missionSy) {
                        boardPri[i] += 16000;
                    }
                }
            }

            for (let li = 0; li < lines.length; li++) {
                const line = lines[li];
                let ours = 0, opp = 0, emptyIdx = -1;
                for (let k = 0; k < 3; k++) {
                    const o = worldBoards[line[k]]?.owner;
                    if (o === ownerKey) ours++;
                    else if (o === oppKey) opp++;
                    else if (emptyIdx < 0) emptyIdx = line[k];
                    else emptyIdx = -2;
                }
                if (ours === 2 && emptyIdx >= 0 && boardPri[emptyIdx] > -9000) {
                    boardPri[emptyIdx] += 12000;
                }
                if (opp === 2 && emptyIdx >= 0 && boardPri[emptyIdx] > -9000) {
                    boardPri[emptyIdx] += 9000;
                }
                if (ours === 1 && opp === 0) {
                    for (let k = 0; k < 3; k++) {
                        const idx = line[k];
                        if (boardPri[idx] > -9000 && !worldBoards[idx]?.owner) boardPri[idx] += 650;
                    }
                }
            }
            if (player) {
                player._aiPriBuf = boardPri;
                player._aiPri = boardPri;
                player._aiPriTick = tick;
                player._aiPriKey = priKey;
            }
        }

        let best = null;
        for (let bi = 0; bi < worldBoards.length; bi++) {
            if (boardPri[bi] <= -9000) continue;
            const board = worldBoards[bi];
            const cps = board.checkpoints || [];
            for (let ci = 0; ci < cps.length; ci++) {
                const cp = cps[ci];
                if (cp.owner === ownerKey) continue;
                const hops = this.boardHopDist(psx, psy, board.sx, board.sy);
                let d;
                if (hops === 0) {
                    d = Math.abs(cp.x - x) + Math.abs(cp.y - y);
                } else {
                    // Distance to the edge that faces the target board (not any nearest rim)
                    const needDx = this.signedBoardDelta(psx, board.sx);
                    const needDy = this.signedBoardDelta(psy, board.sy);
                    let edgeToward = this.distToSectorEdge(x, y, gc);
                    if (needDx !== 0 && needDy !== 0) {
                        const ex = needDx < 0 ? x : (gc - 1 - x);
                        const ey = needDy < 0 ? y : (gc - 1 - y);
                        edgeToward = Math.min(ex, ey);
                    } else if (needDx < 0) edgeToward = x;
                    else if (needDx > 0) edgeToward = gc - 1 - x;
                    else if (needDy < 0) edgeToward = y;
                    else if (needDy > 0) edgeToward = gc - 1 - y;
                    // preferOffBoard softens hop cost so bots actually race other sectors
                    const hopScale = (opts && opts.preferOffBoard) ? 0.52 : 0.78;
                    d = hops * gc * hopScale
                        + edgeToward
                        + Math.min(cp.x, cp.y, gc - 1 - cp.x, gc - 1 - cp.y);
                }
                const score = boardPri[bi] * 1000 - d;
                if (!best || score > best.score) {
                    best = {
                        score,
                        priority: boardPri[bi],
                        dist: d,
                        sx: board.sx,
                        sy: board.sy,
                        cpX: cp.x,
                        cpY: cp.y,
                        hops
                    };
                }
            }
        }
        return best;
    },

    /** Prefer unclaimed / enemy checkpoints across the 9 independent boards. */
    nearestCheckpointDist(x, y, ownerKey, player) {
        const t = this.pickBoardStrategyTarget(x, y, ownerKey, player);
        return t ? t.dist : null;
    },

    /** Count our CPs on a board (0–3). */
    boardOursCpCount(board, ownerKey) {
        if (!board?.checkpoints) return 0;
        let n = 0;
        for (let i = 0; i < board.checkpoints.length; i++) {
            if (board.checkpoints[i]?.owner === ownerKey) n++;
        }
        return n;
    },

    /**
     * Infinite Trails lockdown target: claim the FIRST CP on boards we haven't touched,
     * then paint next to remaining CPs so walkers can't TTT — charge still pierces.
     */
    pickTrailLockTarget(x, y, ownerKey, player) {
        if (typeof worldBoards === 'undefined' || !worldBoards?.length) return null;
        const psx = player && Number.isInteger(player.boardSx) ? player.boardSx : 1;
        const psy = player && Number.isInteger(player.boardSy) ? player.boardSy : 1;
        const gc = (typeof GRID_COUNT === 'number') ? GRID_COUNT : 20;
        let hasVirgin = false;
        for (let bi = 0; bi < worldBoards.length; bi++) {
            const board = worldBoards[bi];
            if (!board || board.owner) continue;
            if (this.boardOursCpCount(board, ownerKey) === 0) {
                const cps0 = board.checkpoints || [];
                for (let i = 0; i < cps0.length; i++) {
                    if (cps0[i] && cps0[i].owner !== ownerKey) { hasVirgin = true; break; }
                }
            }
            if (hasVirgin) break;
        }
        let best = null;
        for (let bi = 0; bi < worldBoards.length; bi++) {
            const board = worldBoards[bi];
            if (!board || board.owner) continue;
            const ours = this.boardOursCpCount(board, ownerKey);
            // Spread first: lock ONE CP on every open board before caging leftovers
            if (hasVirgin && ours > 0) continue;
            const cps = board.checkpoints || [];
            for (let ci = 0; ci < cps.length; ci++) {
                const cp = cps[ci];
                if (!cp || cp.owner === ownerKey) continue;
                const hops = this.boardHopDist(psx, psy, board.sx, board.sy);
                let d;
                if (hops === 0) d = Math.abs(cp.x - x) + Math.abs(cp.y - y);
                else {
                    const needDx = this.signedBoardDelta(psx, board.sx);
                    const needDy = this.signedBoardDelta(psy, board.sy);
                    let edgeToward = this.distToSectorEdge(x, y, gc);
                    if (needDx < 0) edgeToward = x;
                    else if (needDx > 0) edgeToward = gc - 1 - x;
                    else if (needDy < 0) edgeToward = y;
                    else if (needDy > 0) edgeToward = gc - 1 - y;
                    d = hops * gc * 0.55 + edgeToward
                        + Math.min(cp.x, cp.y, gc - 1 - cp.x, gc - 1 - cp.y);
                }
                const firstLockPri = ours === 0 ? 18000 : (ours === 1 ? 2400 : 700);
                const score = firstLockPri * 1000 - d - hops * 40;
                if (!best || score > best.score) {
                    best = {
                        score, priority: firstLockPri, dist: d, hops,
                        sx: board.sx, sy: board.sy,
                        cpX: cp.x, cpY: cp.y, oursOnBoard: ours
                    };
                }
            }
        }
        return best;
    },

    /** Unclaimed CP on same board aligned with facing dir within leap (charge pierce). */
    checkpointOnChargeLine(p, leap, ownerKey) {
        if (!p?.dir || typeof worldBoards === 'undefined' || !worldBoards?.length) return null;
        const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
        const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
        const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
        const board = worldBoards[psy * n + psx];
        if (!board?.checkpoints || board.owner) return null;
        const dx = p.dir.x || 0;
        const dy = p.dir.y || 0;
        const maxLeap = Math.max(1, Math.floor(leap));
        let best = null;
        for (let i = 0; i < board.checkpoints.length; i++) {
            const cp = board.checkpoints[i];
            if (!cp || cp.owner === ownerKey) continue;
            if (dy === 0 && dx !== 0 && cp.y === p.y) {
                const gap = (cp.x - p.x) * Math.sign(dx);
                if (gap >= 1 && gap <= maxLeap) {
                    if (!best || gap < best.gap) best = { cp, gap, x: cp.x, y: cp.y };
                }
            } else if (dx === 0 && dy !== 0 && cp.x === p.x) {
                const gap = (cp.y - p.y) * Math.sign(dy);
                if (gap >= 1 && gap <= maxLeap) {
                    if (!best || gap < best.gap) best = { cp, gap, x: cp.x, y: cp.y };
                }
            }
        }
        return best;
    },

    /** True if opponent runs Infinite Trails (forever paint cages). */
    opponentHasInfiniteTrails(opponent) {
        if (!opponent) return false;
        if (typeof playerHasInfiniteTrails === 'function') return playerHasInfiniteTrails(opponent);
        return !!(opponent.infiniteTrailsActive || opponent.selectedSkill === 'infinite-trails');
    },

    getAccessibleSpace(startX, startY, p, opponent, gridCount, maxSearch = 200) {
        if (this.isOccupied(startX, startY, p, opponent, gridCount)) return 0;

        const gc = gridCount;
        const cap = Math.max(1, Math.floor(maxSearch));
        const tick = (typeof RonkAI !== 'undefined' && RonkAI.globalTick) || 0;
        if (tick !== AI_SPACE_CACHE_TICK) {
            AI_SPACE_CACHE.clear();
            AI_SPACE_CACHE_TICK = tick;
        }
        const pid = p && p.id != null ? String(p.id) : '0';
        const cacheKey = `${pid}|${startX}|${startY}|${cap}`;
        if (AI_SPACE_CACHE.has(cacheKey)) return AI_SPACE_CACHE.get(cacheKey);

        const gridSize = gc * gc;
        if (AI_BFS_GRID_COUNT !== gc || AI_BFS_VISITED.length < gridSize) {
            AI_BFS_GRID_COUNT = gc;
            if (AI_BFS_VISITED.length < gridSize) {
                AI_BFS_VISITED = new Uint16Array(Math.max(gridSize, 400));
            }
        }
        // Stamp BFS — skip O(n) visited.fill every flood (huge FPS win for elite)
        AI_BFS_GEN = (AI_BFS_GEN + 1) & 0xffff;
        if (AI_BFS_GEN === 0) {
            AI_BFS_VISITED.fill(0);
            AI_BFS_GEN = 1;
        }
        const visited = AI_BFS_VISITED;
        const gen = AI_BFS_GEN;

        AI_BFS_QUEUE.length = 0;
        AI_BFS_QUEUE.push(startX, startY);
        visited[startY * gc + startX] = gen;
        
        let count = 0;
        let head = 0;
        while (head < AI_BFS_QUEUE.length && count < cap) {
            const x = AI_BFS_QUEUE[head++];
            const y = AI_BFS_QUEUE[head++];
            count++;

            let nx = x, ny = y - 1;
            let idx = ny * gc + nx;
            if (ny >= 0 && visited[idx] !== gen && !this.isOccupied(nx, ny, p, opponent, gc)) {
                visited[idx] = gen;
                AI_BFS_QUEUE.push(nx, ny);
            }
            nx = x; ny = y + 1;
            idx = ny * gc + nx;
            if (ny < gc && visited[idx] !== gen && !this.isOccupied(nx, ny, p, opponent, gc)) {
                visited[idx] = gen;
                AI_BFS_QUEUE.push(nx, ny);
            }
            nx = x - 1; ny = y;
            idx = ny * gc + nx;
            if (nx >= 0 && visited[idx] !== gen && !this.isOccupied(nx, ny, p, opponent, gc)) {
                visited[idx] = gen;
                AI_BFS_QUEUE.push(nx, ny);
            }
            nx = x + 1; ny = y;
            idx = ny * gc + nx;
            if (nx < gc && visited[idx] !== gen && !this.isOccupied(nx, ny, p, opponent, gc)) {
                visited[idx] = gen;
                AI_BFS_QUEUE.push(nx, ny);
            }
        }
        AI_SPACE_CACHE.set(cacheKey, count);
        return count;
    },

    raycast(x, y, dx, dy, p, opponent, gridCount) {
        let dist = 0;
        let cx = x + dx;
        let cy = y + dy;
        const grid = this.occupancyGrid;
        const useGrid = grid && grid.length === gridCount * gridCount;
        const sense = this.aiResolveOpponentView(p, opponent);

        while (cx >= 0 && cx < gridCount && cy >= 0 && cy < gridCount) {
            if (useGrid) {
                if (grid[cy * gridCount + cx] === 1) break;
            } else {
            if (p.trail.some(t => t.x === cx && t.y === cy)) break;
            if (sense.seeTrail && opponent.trail.some(t => t.x === cx && t.y === cy)) break;
            if (sense.seeCube && opponent.x === cx && opponent.y === cy) break;
            if (!sense.seeCube && sense.confidence > 0.4 && sense.x === cx && sense.y === cy) break;
            }
            dist++;
            cx += dx;
            cy += dy;
        }
        return dist / gridCount;
    },

    dirToIndex(dir) {
        if (dir.x === 0 && dir.y === -1) return 0;
        if (dir.x === 0 && dir.y === 1) return 1;
        if (dir.x === -1 && dir.y === 0) return 2;
        if (dir.x === 1 && dir.y === 0) return 3;
        return 0;
    },

    indexToDir(index) {
        return AI_DIRS[index]?.d || { x: 0, y: -1 };
    },

    nearestAppleDist(x, y, player) {
        if (typeof apples === 'undefined' || !apples.length) return null;
        const psx = player && Number.isInteger(player.boardSx) ? player.boardSx : 1;
        const psy = player && Number.isInteger(player.boardSy) ? player.boardSy : 1;
        const gc = (typeof GRID_COUNT === 'number') ? GRID_COUNT : 20;
        let best = null;
        for (let i = 0; i < apples.length; i++) {
            const a = apples[i];
            if (!a || a.eaten) continue;
            const asx = Number.isInteger(a.boardSx) ? a.boardSx : psx;
            const asy = Number.isInteger(a.boardSy) ? a.boardSy : psy;
            const hops = this.boardHopDist(psx, psy, asx, asy);
            // Prefer same-board apples; still path to nearby boards when starving
            const d = hops === 0
                ? Math.abs(a.x - x) + Math.abs(a.y - y)
                : hops * gc
                    + Math.min(x, y, gc - 1 - x, gc - 1 - y)
                    + Math.min(a.x, a.y, gc - 1 - a.x, gc - 1 - a.y);
            if (best === null || d < best) best = d;
        }
        return best;
    },

    /** Nearest uneaten apple with board info (for travel dashes). */
    nearestAppleTarget(x, y, player) {
        if (typeof apples === 'undefined' || !apples.length) return null;
        const psx = player && Number.isInteger(player.boardSx) ? player.boardSx : 1;
        const psy = player && Number.isInteger(player.boardSy) ? player.boardSy : 1;
        const gc = (typeof GRID_COUNT === 'number') ? GRID_COUNT : 20;
        let best = null;
        for (let i = 0; i < apples.length; i++) {
            const a = apples[i];
            if (!a || a.eaten) continue;
            const asx = Number.isInteger(a.boardSx) ? a.boardSx : psx;
            const asy = Number.isInteger(a.boardSy) ? a.boardSy : psy;
            const hops = this.boardHopDist(psx, psy, asx, asy);
            const d = hops === 0
                ? Math.abs(a.x - x) + Math.abs(a.y - y)
                : hops * gc
                    + Math.min(x, y, gc - 1 - x, gc - 1 - y)
                    + Math.min(a.x, a.y, gc - 1 - a.x, gc - 1 - a.y);
            if (!best || d < best.dist) {
                best = { x: a.x, y: a.y, sx: asx, sy: asy, hops, dist: d };
            }
        }
        return best;
    }
};

const BOT_DIFFICULTY_PROFILES = {
    easy: {
        label: 'EASY',
        tier: 0,
        thinkInterval: 3,
        abilityInterval: 5,
        mistakeChance: 0.16,
        mistakeDepth: 3,
        wrongTurnChance: 0.1,
        hesitationChance: 0.14,
        keepStraightBias: 0.72,
        heuristicScale: 0.28,
        floodDepth: 36,
        aggression: 0.02,
        edgeAwareness: 1.15,
        dangerAwareness: 1.35,
        dashChance: 0.04,
        chargeChance: 0.02,
        skillChance: 0.03,
        chargeAggression: 0.03,
        skillTactics: false,
        skillCooldownMs: 3800,
        hungerSeek: 1.45,
        hungerPanicThreshold: 0.55,
        dodgeRange: 10,
        spaceAggressionMin: 420,
        punishMistakes: false,
        trapOpponent: false
    },
    medium: {
        label: 'MEDIUM',
        tier: 1,
        thinkInterval: 2,
        abilityInterval: 3,
        mistakeChance: 0.04,
        mistakeDepth: 2,
        wrongTurnChance: 0.02,
        hesitationChance: 0.02,
        heuristicScale: 2.1,
        floodDepth: 240,
        aggression: 0.32,
        edgeAwareness: 2.2,
        dangerAwareness: 2.0,
        dashChance: 0.42,
        chargeChance: 0.32,
        skillChance: 0.38,
        chargeAggression: 0.45,
        skillTactics: true,
        eliteReactions: false,
        skillCooldownMs: 900,
        hungerSeek: 1.7,
        hungerPanicThreshold: 0.58,
        dodgeRange: 40,
        spaceAggressionMin: 140,
        punishMistakes: false,
        trapOpponent: false
    },
    hard: {
        label: 'HARD',
        tier: 2,
        thinkInterval: 2,
        abilityInterval: 2,
        mistakeChance: 0.008,
        heuristicScale: 5.4,
        floodDepth: 80,
        aggression: 1.1,
        edgeAwareness: 4.2,
        dangerAwareness: 3.6,
        dashChance: 0.55,
        chargeChance: 0.5,
        skillChance: 0.55,
        chargeAggression: 1.15,
        skillTactics: true,
        eliteReactions: false,
        instantSkills: false,
        skillCooldownMs: 180,
        hungerSeek: 2.3,
        hungerPanicThreshold: 0.7,
        dodgeRange: 90,
        spaceAggressionMin: 80,
        punishMistakes: false,
        trapOpponent: false
    },
    invincible: {
        label: 'ELITE',
        tier: 3,
        thinkInterval: 3,
        abilityInterval: 3,
        mistakeChance: 0.045,
        wrongTurnChance: 0.035,
        hesitationChance: 0.02,
        heuristicScale: 8,
        floodDepth: 64,
        aggression: 2.35,
        edgeAwareness: 6.2,
        dangerAwareness: 5.0,
        dashChance: 1,
        chargeChance: 1,
        skillChance: 1,
        chargeAggression: 2.2,
        skillTactics: true,
        perfectReactions: true,
        unbeatableMode: true,
        instantSkills: true,
        skillCooldownMs: 80,
        hungerSeek: 2.2,
        hungerPanicThreshold: 0.75,
        dodgeRange: 90,
        spaceAggressionMin: 36,
        punishMistakes: false,
        trapOpponent: false,
        eliteReactions: true,
        minSafeSpace: 22
    }
};

/** Elite (invincible) only — exact 14 camp kits (2 jokers per skill family batch). */
const AI_ELITE_CAMP_KITS = [
    { skill: 'clones', jokers: ['rage-joker', 'double-effective'] },
    { skill: 'clones', jokers: ['rage-joker', 'extra-life'] },
    { skill: 'clones', jokers: ['rage-joker', 'disable-enemy'] },
    { skill: 'infinite-charge', jokers: ['disable-enemy', 'extra-life'] },
    { skill: 'infinite-charge', jokers: ['disable-enemy', 'rage-joker'] },
    { skill: 'infinite-charge', jokers: ['no-hunger', 'extra-life'] },
    { skill: 'laser', jokers: ['double-effective', 'rage-joker'] },
    { skill: 'laser', jokers: ['rage-joker', 'disable-enemy'] },
    { skill: 'infinite-trails', jokers: ['disable-enemy', 'dash-cooldown'] },
    { skill: 'infinite-trails', jokers: ['disable-enemy', 'extra-life'] },
    { skill: 'infinite-trails', jokers: ['no-hunger', 'extra-life'] },
    { skill: 'invisible', jokers: ['disable-enemy', 'extra-life'] },
    { skill: 'invisible', jokers: ['extra-life', 'trail-growth'] },
    { skill: 'invisible', jokers: ['trail-growth', 'no-hunger'] }
];

const AI_SKILL_JOKER_COMBOS = {
    // Tournament-ranked Elite kits (border-safe banned). Scores = win% from ultimate training.
    'clones': [
        { jokers: ['rage-joker', 'extra-life'], score: 71 },
        { jokers: ['no-hunger', 'extra-life'], score: 71 },
        { jokers: ['charge-plus', 'dash-cooldown'], score: 71 },
        { jokers: ['extra-life', 'disable-enemy'], score: 71 },
        { jokers: ['rage-joker', 'disable-enemy'], score: 69 },
        { jokers: ['double-effective', 'extra-life'], score: 69 },
        { jokers: ['rage-joker', 'dash-cooldown'], score: 67 },
        { jokers: ['no-hunger', 'rage-joker'], score: 65 },
        { jokers: ['dash-cooldown', 'extra-life'], score: 65 },
        { jokers: ['rage-joker', 'trail-growth'], score: 62 }
    ],
    'laser': [
        { jokers: ['double-effective', 'extra-life'], score: 81 },
        { jokers: ['rage-joker', 'extra-life'], score: 71 },
        { jokers: ['dash-cooldown', 'extra-life'], score: 67 },
        { jokers: ['friend-blocks', 'extra-life'], score: 65 },
        { jokers: ['trail-growth', 'extra-life'], score: 65 },
        { jokers: ['no-hunger', 'extra-life'], score: 58 },
        { jokers: ['extra-life', 'disable-enemy'], score: 58 },
        { jokers: ['charge-plus', 'extra-life'], score: 48 },
        { jokers: ['rage-joker', 'trail-growth'], score: 48 },
        { jokers: ['charge-plus', 'no-hunger'], score: 46 }
    ],
    'infinite-trails': [
        { jokers: ['friend-blocks', 'extra-life'], score: 77 },
        { jokers: ['no-hunger', 'extra-life'], score: 69 },
        { jokers: ['dash-cooldown', 'extra-life'], score: 67 },
        { jokers: ['rage-joker', 'extra-life'], score: 65 },
        { jokers: ['charge-plus', 'extra-life'], score: 62 },
        { jokers: ['double-effective', 'extra-life'], score: 58 },
        { jokers: ['no-hunger', 'friend-blocks'], score: 56 },
        { jokers: ['extra-life', 'disable-enemy'], score: 54 },
        { jokers: ['no-hunger', 'disable-enemy'], score: 48 },
        { jokers: ['friend-blocks', 'disable-enemy'], score: 48 }
    ],
    'infinite-charge': [
        { jokers: ['double-effective', 'extra-life'], score: 60 },
        { jokers: ['no-hunger', 'extra-life'], score: 58 },
        { jokers: ['friend-blocks', 'extra-life'], score: 56 },
        { jokers: ['dash-cooldown', 'extra-life'], score: 56 },
        { jokers: ['trail-growth', 'extra-life'], score: 56 },
        { jokers: ['extra-life', 'disable-enemy'], score: 56 },
        { jokers: ['rage-joker', 'extra-life'], score: 52 },
        { jokers: ['charge-plus', 'extra-life'], score: 46 },
        { jokers: ['friend-blocks', 'disable-enemy'], score: 38 },
        { jokers: ['dash-cooldown', 'disable-enemy'], score: 35 }
    ],
    'invisible': [
        { jokers: ['double-effective', 'extra-life'], score: 81 },
        { jokers: ['rage-joker', 'extra-life'], score: 69 },
        { jokers: ['extra-life', 'disable-enemy'], score: 69 },
        { jokers: ['trail-growth', 'extra-life'], score: 65 },
        { jokers: ['no-hunger', 'extra-life'], score: 62 },
        { jokers: ['friend-blocks', 'extra-life'], score: 60 },
        { jokers: ['dash-cooldown', 'extra-life'], score: 60 },
        { jokers: ['charge-plus', 'extra-life'], score: 58 },
        { jokers: ['dash-cooldown', 'disable-enemy'], score: 52 },
        { jokers: ['rage-joker', 'dash-cooldown'], score: 46 }
    ]
};

const AI_INVINCIBLE_LOADOUTS = AI_ELITE_CAMP_KITS.map((kit) => ({
    skill: kit.skill,
    jokers: [...kit.jokers],
    score: 100
}));

/** @deprecated use AI_SKILL_JOKER_COMBOS */
const AI_JOKER_SKILL_COMBOS = Object.fromEntries(
    Object.entries(AI_SKILL_JOKER_COMBOS).map(([skill, combos]) => [
        skill,
        combos.map((c) => [...c.jokers])
    ])
);

const AI_STRONG_SKILLS = ['clones', 'infinite-charge', 'laser', 'infinite-trails', 'invisible'];
const AI_GOOD_SKILLS = [...AI_STRONG_SKILLS];

const AI_BEST_LOADOUTS = AI_INVINCIBLE_LOADOUTS
    .slice()
    .sort((a, b) => b.score - a.score);

function allSkillIdsForAI() {
    return typeof SKILL_DATA !== 'undefined'
        ? SKILL_DATA.map((s) => s.id)
        : AI_STRONG_SKILLS;
}

function allJokerIdsForAI() {
    return typeof JOKER_DATA !== 'undefined'
        ? JOKER_DATA.map((j) => j.id)
        : [...new Set(AI_INVINCIBLE_LOADOUTS.flatMap((l) => l.jokers))];
}

function jokerSetKey(jokers) {
    return [...jokers].sort().join('|');
}

function isInvincibleCuratedLoadout(skill, jokers) {
    if (!Array.isArray(jokers) || jokers.length < 2) return false;
    const key = jokerSetKey(jokers);
    return AI_ELITE_CAMP_KITS.some((kit) => kit.skill === skill && jokerSetKey(kit.jokers) === key);
}

function pickRandomSkillForAI() {
    const all = allSkillIdsForAI();
    return all[Math.floor(Math.random() * all.length)];
}

function pickRandomJokersForAI(count = 2) {
    // AI never rolls border-safe — they must not rely on edge-slide
    const jokerIds = allJokerIdsForAI().filter((id) => id !== 'border-safe');
    const picked = [];
    while (picked.length < count && picked.length < jokerIds.length) {
        const id = jokerIds[Math.floor(Math.random() * jokerIds.length)];
        if (!picked.includes(id)) picked.push(id);
    }
    return picked;
}

/** Strip illegal joker/skill pairs (e.g. trail-growth + infinite-trails). */
function sanitizeAILoadout(skill, jokers) {
    const safeSkill = skill || pickRandomSkillForAI();
    let safeJokers = normalizeAIJokerList(jokers).filter((id) => id !== 'border-safe');
    if (safeSkill === 'infinite-trails') {
        safeJokers = safeJokers.filter((id) => id !== 'trail-growth');
    }
    while (safeJokers.length < 2) {
        const pool = allJokerIdsForAI().filter((id) => {
            if (id === 'border-safe') return false;
            if (safeJokers.includes(id)) return false;
            if (safeSkill === 'infinite-trails' && id === 'trail-growth') return false;
            return true;
        });
        if (!pool.length) break;
        safeJokers.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    return { skill: safeSkill, jokers: safeJokers.slice(0, 2) };
}

function normalizeAIJokerList(jokers) {
    if (!Array.isArray(jokers)) return [];
    return jokers.filter(Boolean).map((id) => (id === 'slow-enemy' ? 'double-effective' : id));
}

/** Easy: intentionally weak kits — never top meta combos, never border-safe. */
const AI_EASY_LOADOUTS = [
    { skill: 'invisible', jokers: ['friend-blocks', 'no-hunger'] },
    { skill: 'infinite-trails', jokers: ['friend-blocks', 'no-hunger'] },
    { skill: 'invisible', jokers: ['dash-cooldown', 'friend-blocks'] },
    { skill: 'laser', jokers: ['friend-blocks', 'no-hunger'] }
];

/** Easy/medium: random skill + jokers, never the invincible curated combos. */
function pickCasualRandomAILoadout() {
    for (let attempt = 0; attempt < 64; attempt++) {
        const skill = pickRandomSkillForAI();
        const jokers = pickRandomJokersForAI(2);
        if (!isInvincibleCuratedLoadout(skill, jokers)) {
            return sanitizeAILoadout(skill, jokers);
        }
    }
    return sanitizeAILoadout('invisible', ['extra-life', 'friend-blocks']);
}

function pickEasyAILoadout(rank = 0) {
    if (!AI_EASY_LOADOUTS.length) return pickCasualRandomAILoadout();
    const idx = ((rank % AI_EASY_LOADOUTS.length) + AI_EASY_LOADOUTS.length) % AI_EASY_LOADOUTS.length;
    const entry = AI_EASY_LOADOUTS[idx];
    return sanitizeAILoadout(entry.skill, [...entry.jokers]);
}

function pickRandomAILoadout() {
    return sanitizeAILoadout(pickRandomSkillForAI(), pickRandomJokersForAI(2));
}

const AI_INVINCIBLE_SKILL_PRIORITY = ['laser', 'invisible', 'infinite-trails', 'clones', 'infinite-charge'];

function sortInvincibleLoadouts() {
    return [...AI_INVINCIBLE_LOADOUTS].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const pa = AI_INVINCIBLE_SKILL_PRIORITY.indexOf(a.skill);
        const pb = AI_INVINCIBLE_SKILL_PRIORITY.indexOf(b.skill);
        return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    });
}

/** Fair elite skill dealer — each skill appears once per bag before reshuffle (true equal odds). */
let _eliteSkillDealBag = [];

function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

function drawEliteSkillFair() {
    const pool = (AI_STRONG_SKILLS && AI_STRONG_SKILLS.length)
        ? AI_STRONG_SKILLS.slice()
        : ['clones', 'infinite-charge', 'laser', 'infinite-trails', 'invisible'];
    if (!_eliteSkillDealBag.length) {
        _eliteSkillDealBag = shuffleInPlace(pool);
    }
    return _eliteSkillDealBag.pop();
}

/** Fair elite kit dealer — shuffled bag of the 14 camp kits only. */
let _eliteKitDealBag = [];

function resetEliteKitDealBag() {
    _eliteKitDealBag = [];
}

function drawEliteCampKit() {
    if (!_eliteKitDealBag.length) {
        _eliteKitDealBag = shuffleInPlace(AI_ELITE_CAMP_KITS.map((_, i) => i));
    }
    const idx = _eliteKitDealBag.pop();
    return AI_ELITE_CAMP_KITS[idx];
}

function resetEliteSkillDealBag() {
    _eliteSkillDealBag = [];
    resetEliteKitDealBag();
}

function pickInvincibleComboForSkill(skillId, comboIndex = 0) {
    const combos = AI_SKILL_JOKER_COMBOS[skillId];
    if (!combos?.length) return pickRandomJokersForAI(2);
    // Prefer stronger tournament kits, but still rotate through all ranked loadouts
    let total = 0;
    for (let i = 0; i < combos.length; i++) total += Math.max(1, combos[i].score || 1);
    let roll = Math.random() * total;
    for (let i = 0; i < combos.length; i++) {
        roll -= Math.max(1, combos[i].score || 1);
        if (roll <= 0) return [...combos[i].jokers];
    }
    const idx = ((comboIndex % combos.length) + combos.length) % combos.length;
    return [...combos[idx].jokers];
}

/** Elite loadout: fair bag over the 14 camp kits only — no random meta combos. */
function selectInvincibleLoadout(rank = 0) {
    if (rank > 0 && !_eliteKitDealBag.length) {
        _eliteKitDealBag = shuffleInPlace(AI_ELITE_CAMP_KITS.map((_, i) => i));
    }
    const kit = drawEliteCampKit();
    return sanitizeAILoadout(kit.skill, [...kit.jokers]);
}

/** Kept for callers — no longer forces a different skill (same kits are allowed). */
function selectInvincibleLoadoutAvoidingSkill(_avoidSkill, rank = 0) {
    return selectInvincibleLoadout(rank);
}

function getInvincibleLoadoutCount() {
    return AI_ELITE_CAMP_KITS.length;
}

function selectBestAILoadout(difficulty, rank = 0) {
    if (difficulty === 'invincible') {
        return selectInvincibleLoadout(rank);
    }
    if (difficulty === 'easy') {
        return pickEasyAILoadout(rank);
    }
    if (difficulty === 'medium') {
        return pickCasualRandomAILoadout();
    }
    return pickRandomAILoadout();
}

function selectAISkillForDifficulty(difficulty, rank = 0) {
    if (difficulty === 'invincible') {
        return selectInvincibleLoadout(rank).skill;
    }
    if (difficulty === 'easy') {
        return pickEasyAILoadout(rank).skill;
    }
    if (difficulty === 'medium') {
        return pickCasualRandomAILoadout().skill;
    }
    return pickRandomSkillForAI();
}

function selectAIJokersForSkill(skillId, difficulty, comboIndex = 0) {
    if (difficulty === 'invincible') {
        const match = AI_ELITE_CAMP_KITS.find((kit) => kit.skill === skillId);
        if (match) return sanitizeAILoadout(skillId, [...match.jokers]).jokers;
        return sanitizeAILoadout(skillId, pickInvincibleComboForSkill(skillId, comboIndex)).jokers;
    }
    if (difficulty === 'easy' || difficulty === 'medium') {
        for (let attempt = 0; attempt < 64; attempt++) {
            const jokers = pickRandomJokersForAI(2);
            if (!isInvincibleCuratedLoadout(skillId, jokers)) {
                return sanitizeAILoadout(skillId, jokers).jokers;
            }
        }
        return sanitizeAILoadout(skillId, ['extra-life', 'friend-blocks']).jokers;
    }
    return sanitizeAILoadout(skillId, pickRandomJokersForAI(2)).jokers;
}

/** Per-difficulty playbooks — distinct strategy DNA for every bot tier */
const AI_DIFFICULTY_PLAYBOOKS = {
    easy: {
        id: 'wanderer',
        claimWeight: 0.55,
        chaseWeight: 0.08,
        travelDashMult: 0.5,
        hopCooldown: 18,
        boardRace: 0.5,
        huntSameBoardOnly: true,
        boardDwellTicks: 260
    },
    medium: {
        id: 'mapper',
        claimWeight: 1.4,
        chaseWeight: 0.35,
        travelDashMult: 0.95,
        hopCooldown: 8,
        boardRace: 1.5,
        huntSameBoardOnly: false,
        boardDwellTicks: 90
    },
    hard: {
        id: 'tactician',
        claimWeight: 2.05,
        chaseWeight: 0.55,
        travelDashMult: 1.15,
        hopCooldown: 5,
        boardRace: 2.2,
        huntSameBoardOnly: false,
        boardDwellTicks: 55
    },
    invincible: {
        id: 'overlord',
        claimWeight: 2.55,
        chaseWeight: 0.42,
        travelDashMult: 3.2,
        hopCooldown: 1,
        boardRace: 5.5,
        huntSameBoardOnly: false,
        boardDwellTicks: 9
    }
};

/** Clone-only playbook: split across boards for TTT — hop early, don't stack */
const AI_CLONE_PLAYBOOK = {
    id: 'spreader',
    claimWeight: 3.6,
    chaseWeight: 0.08,
    travelDashMult: 2.4,
    hopCooldown: 1,
    boardRace: 4.8,
    huntSameBoardOnly: false,
    boardDwellTicks: 4
};

/**
 * Leave the current board sooner when camping, done locally, or map control is open.
 * Soft threshold (~45% of dwell) starts exploration without waiting for hard timeout.
 */
function aiShouldForceBoardExplore(p, playstyle, ownerKey, opponent, diff) {
    if (!p || typeof worldBoards === 'undefined' || !worldBoards?.length) return false;
    opponent = opponent ?? aiResolveOpponentFor(p);
    diff = diff ?? getPlayerDifficultyProfile(p);
    let dwellLimit = playstyle?.boardDwellTicks ?? 160;
    if (diff?.unbeatableMode && opponent) {
        const threat = aiAssessEnemyThreat(p, opponent, playstyle, diff);
        if (threat.level === 'none') dwellLimit = Math.max(dwellLimit, 14);
    }
    const dwell = p._aiBoardDwellTicks || 0;
    const trailLock = !!(playstyle?.lockFirstCpPerBoard || playstyle?.isPassiveKit
        || p.selectedSkill === 'infinite-trails');

    const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
    const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
    const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
    const board = worldBoards[psy * n + psx];
    if (!board) return false;
    if (board.owner === ownerKey) return true;

    // Clones: leave the owner's board immediately once a mission is off-board
    if (p.isClone && Number.isInteger(p._missionSx) && Number.isInteger(p._missionSy)) {
        if (psx !== p._missionSx || psy !== p._missionSy) return true;
    }

    const remaining = (board.checkpoints || []).filter((c) => c && c.owner !== ownerKey);
    if (remaining.length === 0) return true;

    const ours = (board.checkpoints || []).filter((c) => c && c.owner === ownerKey).length;
    if (trailLock) {
        // Stay until the first CP is locked, paint a cage, then hop to virgin boards
        if (ours < 1) return false;
        const stats = AI_HELPERS.boardOwnershipStats(ownerKey);
        const leaveAfterOne = Math.max(70, Math.floor(dwellLimit * 0.55));
        if (stats.unclaimed > 0 && dwell > leaveAfterOne) return true;
        return dwell > dwellLimit;
    }

    // Laser: passive grids hit off-board — rotate boards quickly after first CP or short camp
    if (p.selectedSkill === 'laser') {
        if (ours >= 1 && dwell > Math.max(16, Math.floor(dwellLimit * 0.2))) return true;
        if (dwell > Math.max(40, Math.floor(dwellLimit * 0.35))) return true;
    }

    if (dwell > dwellLimit) return true;
    // Soft explore: Elite / high boardRace leave early; lower tiers wait longer
    const race = playstyle?.boardRace || 1;
    const softFrac = race >= 4 ? 0.06 : (race >= 3 ? 0.1 : (race >= 2 ? 0.28 : 0.45));
    const softExploreAt = Math.max(race >= 4 ? 2 : (race >= 3 ? 3 : 10), Math.floor(dwellLimit * softFrac));
    if (dwell > softExploreAt) return true;

    if (typeof usesBoardControlMatchRules === 'function' && usesBoardControlMatchRules()) {
        const stats = AI_HELPERS.boardOwnershipStats(ownerKey);
        const leaveAfterOne = Math.max(race >= 4 ? 2 : (race >= 3 ? 3 : 8), Math.floor(dwellLimit * softFrac));
        if (ours >= 1 && stats.unclaimed > 0 && dwell > leaveAfterOne) {
            return true;
        }
        // Elite / board-race kits: hop after one CP — but paint lines when no threat
        if (ours >= 1 && stats.unclaimed > 0 && race >= 2.5) {
            const opp = opponent ?? aiResolveOpponentFor(p);
            const d = diff ?? getPlayerDifficultyProfile(p);
            const threat = opp ? aiAssessEnemyThreat(p, opp, playstyle, d) : { level: 'none' };
            const minDwell = threat.level === 'none'
                ? Math.max(8, Math.floor(dwellLimit * 0.45))
                : Math.max(1, Math.floor(dwellLimit * 0.06));
            if (dwell > minDwell) return true;
        }
    }
    return false;
}

function getDifficultyPlaybook(level) {
    const key = level || (typeof window !== 'undefined' && window.currentBotDifficulty) || 'medium';
    return AI_DIFFICULTY_PLAYBOOKS[key] || AI_DIFFICULTY_PLAYBOOKS.medium;
}

function getEntityPlaybook(p, diff) {
    if (p?.isClone || p?.aiPlaybook === 'spreader') return AI_CLONE_PLAYBOOK;
    if (p?.aiPlaybook && AI_DIFFICULTY_PLAYBOOKS[p.aiPlaybook]) {
        return AI_DIFFICULTY_PLAYBOOKS[p.aiPlaybook];
    }
    const level = (p && p.aiDifficulty) || (diff && diff.label && String(diff.label).toLowerCase()) || null;
    return getDifficultyPlaybook(level);
}

/**
 * Send each clone to a different unclaimed / TTT-critical board so the pack
 * claims the map instead of stacking on the owner.
 */
function assignCloneBoardMission(clone, owner) {
    if (!clone || typeof worldBoards === 'undefined' || !worldBoards?.length) return;
    const ownerKey = (String((owner || clone).id).split('_')[0] === '1') ? 'player' : 'enemy';
    const ownerSx = Number.isInteger(owner?.boardSx) ? owner.boardSx : clone.boardSx;
    const ownerSy = Number.isInteger(owner?.boardSy) ? owner.boardSy : clone.boardSy;
    const csx = Number.isInteger(clone.boardSx) ? clone.boardSx : ownerSx;
    const csy = Number.isInteger(clone.boardSy) ? clone.boardSy : ownerSy;

    // Already off the owner's board — claim here instead of hopping again
    if (csx !== ownerSx || csy !== ownerSy) {
        const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
        const board = worldBoards[csy * n + csx];
        if (board && board.owner !== ownerKey) {
            clone._missionSx = csx;
            clone._missionSy = csy;
            clone.aiPlaybook = 'spreader';
            return;
        }
    }

    const taken = new Set([`${ownerSx}_${ownerSy}`]);
    if (typeof clones !== 'undefined') {
        for (const c of clones) {
            if (!c || c === clone || c.isDead) continue;
            if (Number.isInteger(c._missionSx) && Number.isInteger(c._missionSy)) {
                taken.add(`${c._missionSx}_${c._missionSy}`);
            }
            // Also treat other clones' current boards as taken so missions stay unique
            if (Number.isInteger(c.boardSx) && Number.isInteger(c.boardSy)) {
                taken.add(`${c.boardSx}_${c.boardSy}`);
            }
        }
    }

    const target = AI_HELPERS.pickBoardStrategyTarget(
        clone.x, clone.y, ownerKey, clone, { excludeKeys: taken, missionBoost: true }
    );
    if (target) {
        clone._missionSx = target.sx;
        clone._missionSy = target.sy;
    } else {
        // Fallback: furthest unclaimed board from owner
        let best = null;
        for (const b of worldBoards) {
            if (!b || b.owner) continue;
            const key = `${b.sx}_${b.sy}`;
            if (taken.has(key)) continue;
            const hops = AI_HELPERS.boardHopDist(ownerSx, ownerSy, b.sx, b.sy);
            if (!best || hops > best.hops) best = { sx: b.sx, sy: b.sy, hops };
        }
        if (best) {
            clone._missionSx = best.sx;
            clone._missionSy = best.sy;
        }
    }
    clone.aiPlaybook = 'spreader';
}

function assignMainAIPlaybook(p, difficulty) {
    if (!p || p.isClone) return;
    const book = getDifficultyPlaybook(difficulty);
    p.aiPlaybook = book.id;
    p._missionSx = undefined;
    p._missionSy = undefined;
}

if (typeof window !== 'undefined') {
    window.assignCloneBoardMission = assignCloneBoardMission;
    window.assignMainAIPlaybook = assignMainAIPlaybook;
}

const AI_SKILL_PLAYSTYLES = {
    // LASER — coward kite: spam lasers, claim boards, never die for a fight
    'laser': {
        earlyTicks: 40,
        openSkillEarly: true,
        playsCoward: true,
        forceBoardFocus: true,
        aggressionEarly: 0.18,
        aggressionLate: 0.28,
        spaceAggressionMin: 9999,
        chaseWeightMult: 0.08,
        trapOpponent: false,
        survivalBias: 2.35,
        postSkillSurvivalMult: 1.45,
        evadeEnemy: true,
        spamSkill: true,
        kiteDash: true,
        preferInland: true,
        travelDashMult: 1.85,
        hopCooldown: 2,
        boardDwellTicks: 22,
        claimWeightBoost: 1.85,
        chargeBiasEarly: 0.02,
        noCombatDash: true,
        winSpeedDash: true
    },
    // CLONES — owner careful until full army (main+2); clone cubes always board-race
    'clones': {
        earlyTicks: 60,
        openSkillEarly: true,
        playsCoward: true,
        forceBoardFocus: true,
        braveryNeedsArmyGt2: true,
        aggressionEarly: 0.32,
        aggressionLate: 0.42,
        spaceAggressionMin: 65,
        chaseWeightMult: 0.4,
        trapOpponent: true,
        survivalBias: 1.9,
        postSkillSurvivalMult: 0.6,
        preferInland: true,
        claimWeightBoost: 1.85,
        hopCooldown: 2,
        boardDwellTicks: 24,
        travelDashMult: 1.75,
        noCombatDash: true
    },
    // INFINITE TRAILS — lock 1 CP per board with forever paint so walkers can't TTT;
    // charge still pierces cages (cube claims CP, trail does not)
    'infinite-trails': {
        earlyTicks: 160,
        openSkillEarly: false,
        isPassiveKit: true,
        playsCoward: true,
        forceBoardFocus: true,
        lockFirstCpPerBoard: true,
        paintCpCage: true,
        aggressionEarly: 0.22,
        aggressionLate: 0.32,
        spaceAggressionMin: 85,
        chaseWeightMult: 0.18,
        trapOpponent: true,
        jailEnemy: true,
        huntFromStart: false,
        chargeBiasEarly: 0.04,
        punishMistakes: false,
        survivalBias: 2.05,
        spacePressureMult: 2.4,
        preferInland: true,
        claimWeightBoost: 2.85,
        boardDwellTicks: 55,
        noCombatDash: true,
        travelDashMult: 1.75,
        hopCooldown: 3
    },
    // INFINITE CHARGE — ONLY always-brave kit: hunt hard, spam charge to catch runaways
    'infinite-charge': {
        earlyTicks: 0,
        openSkillEarly: true,
        isPassiveKit: false,
        playsBrave: true,
        aggressionEarly: 2.35,
        aggressionLate: 2.1,
        spaceAggressionMin: 1,
        chaseWeightMult: 2.15,
        trapOpponent: false,
        huntFromStart: true,
        catchRunaways: true,
        preferChargePursuit: true,
        chargeBiasEarly: 3.5,
        punishMistakes: true,
        survivalBias: 0.55,
        preferInland: true,
        travelDashMult: 1.45,
        hopCooldown: 3
    },
    // INVISIBLE — coward stealth: TTT / boards under cloak, hard edge avoidance
    'invisible': {
        earlyTicks: 100,
        playsCoward: true,
        forceBoardFocus: true,
        aggressionEarly: 0.25,
        aggressionLate: 0.35,
        spaceAggressionMin: 75,
        chaseWeightMult: 0.28,
        openWhenClose: 28,
        openSkillEarly: true,
        useFullInvisAmbush: true,
        useFullInvisOften: true,
        trapOpponent: true,
        survivalBias: 2.55,
        preferInland: true,
        edgeHateMult: 2.4,
        claimWeightBoost: 2.05,
        hopCooldown: 3,
        boardDwellTicks: 28,
        travelDashMult: 1.65,
        noCombatDash: true
    }
};

/** Invincible AI only — low = coward careful, high = brave hunt */
const AI_INVINCIBLE_SKILL_RISK = {
    'laser': 'low',
    'infinite-trails': 'low',  // TTT / boards
    'clones': 'low',           // brave only when army > 2 (runtime)
    'invisible': 'low',        // TTT / boards
    'infinite-charge': 'high'  // always brave
};

const AI_INVINCIBLE_RISK_TUNING = {
    low: {
        aggressionEarly: 0.32,
        aggressionLate: 0.38,
        spaceAggressionMin: 200,
        chaseWeightMult: 0.28,
        survivalBias: 1.85,
        trapOpponent: true,
        chargeBiasEarly: 0.12,
        postSkillSurvivalMult: 0.42
    },
    medium: {
        aggressionEarly: 0.55,
        aggressionLate: 0.78,
        spaceAggressionMin: 52,
        chaseWeightMult: 0.68,
        survivalBias: 1.38,
        trapOpponent: true,
        chargeBiasEarly: 0.48,
        postSkillSurvivalMult: 0.58
    },
    high: {
        aggressionEarly: 1.85,
        aggressionLate: 1.65,
        spaceAggressionMin: 18,
        chaseWeightMult: 1.75,
        survivalBias: 0.95,       // still hunt, but don't yeet for free
        trapOpponent: true,
        chargeBiasEarly: 1.55,
        postSkillSurvivalMult: 0.85,
        punishMistakes: true,
        preferInland: true
    }
};

function getInvincibleSkillRisk(p, diff) {
    if (!diff?.unbeatableMode || !p?.selectedSkill) return null;
    return AI_INVINCIBLE_SKILL_RISK[p.selectedSkill] || null;
}

/**
 * Choose safe board TTT (capture / three-in-a-row) vs hunt based on loadout + board state.
 * Elite (invincible) weighs this strongest so capture kits play for lines and combat kits chase.
 */
function resolveBoardVsHuntStrategy(p, opponent, diff, playstyle, boardStats, travelTarget, sameBoardOpp, boardHopsToOpp, threatIn) {
    const skill = p?.selectedSkill || '';
    const risk = playstyle?.invincibleRisk || getInvincibleSkillRisk(p, diff);
    const unbeatable = !!diff?.unbeatableMode;
    const hardPlus = unbeatable || !!diff?.perfectReactions || !!diff?.eliteReactions;
    const brave = aiPlaysBrave(p, playstyle);
    const threat = threatIn || aiAssessEnemyThreat(p, opponent, playstyle, diff);

    let boardScore = 0;
    let huntScore = 0;

    // Loadout bias — TTT/boards for cowards; hunt only for brave kits
    if (skill === 'laser') boardScore += 5.2;
    if (skill === 'infinite-trails') boardScore += unbeatable ? 5.8 : 3.6;
    if (skill === 'invisible') boardScore += unbeatable ? 5.5 : 3.4;
    if (skill === 'clones' || p?.isClone || playstyle?.playbookId === 'spreader') {
        // Clone cubes always board-race; owner boards until army is full
        boardScore += (p?.isClone || !brave) ? (unbeatable ? 5.0 : 3.2) : 0.8;
    }
    if (skill === 'infinite-charge') huntScore += 3.8;
    if (p?.jokerBorderSafe) boardScore += 1.4;
    if (p?.infiniteChargeActive) huntScore += 2.6;
    if (risk === 'low') boardScore += 2.6;
    if (risk === 'medium') boardScore += 0.6;
    if (risk === 'high') huntScore += 2.4;

    const openPhase = playstyle && typeof isSkillOpenPhase === 'function' && isSkillOpenPhase(p, playstyle);
    // Laser / forced board cowards: crush hunt
    if (skill === 'laser' || playstyle?.evadeEnemy || playstyle?.forceBoardFocus) {
        boardScore += unbeatable ? 4.2 : 2.4;
        if (!brave) huntScore *= unbeatable ? 0.06 : 0.18;
    }
    // Clones skill owner: coward TTT until army > 2, then moderate hunt (not psycho)
    if (skill === 'clones' && !p?.isClone) {
        if (!brave) {
            boardScore += unbeatable ? 4.2 : 2.4;
            huntScore *= unbeatable ? 0.12 : 0.3;
        } else {
            huntScore += unbeatable ? 2.0 : 1.2;
            boardScore += unbeatable ? 1.4 : 0.8; // still claim while pressuring
        }
    } else if (p?.isClone || playstyle?.playbookId === 'spreader') {
        boardScore += unbeatable ? 4.5 : 2.6;
        huntScore *= unbeatable ? 0.08 : 0.2;
    }
    // Trails + invisible: hard TTT / board race
    if (skill === 'infinite-trails' || skill === 'invisible' || playstyle?.isPassiveKit) {
        boardScore += unbeatable ? 4.6 : 2.8;
        huntScore *= unbeatable ? 0.18 : 0.35;
        if (playstyle?.jailEnemy && sameBoardOpp) huntScore += unbeatable ? 0.35 : 0.2;
    }
    // Active charge hunt
    if (brave && (skill === 'infinite-charge' || playstyle?.preferChargePursuit)) {
        huntScore += unbeatable ? 3.8 : 2.2;
        boardScore *= unbeatable ? 0.55 : 0.7;
    }
    if (openPhase && playstyle?.avoidFightEarly && skill === 'laser') {
        boardScore += unbeatable ? 2.2 : 1.2;
    }

    // Board / TTT state — cowards overweight lines
    const pri = travelTarget?.priority ?? 0;
    const tttAmp = (!brave && (playstyle?.forceBoardFocus || skill === 'invisible' || skill === 'infinite-trails'))
        ? (unbeatable ? 1.55 : 1.25)
        : 1;
    if (pri >= 9000) boardScore += (unbeatable ? 5.5 : 3.8) * tttAmp;
    else if (pri >= 2800) boardScore += (unbeatable ? 3.2 : 2.0) * tttAmp;
    if (boardStats) {
        if (boardStats.owned >= 2) boardScore += 1.6 * tttAmp;
        if (boardStats.oppOwned >= 2) boardScore += 2.2 * tttAmp;
        if (boardStats.unclaimed >= 4) boardScore += 1.1 * tttAmp;
        if (boardStats.owned + boardStats.oppOwned >= boardStats.total - 1) {
            if (brave) huntScore += 1.2;
            else boardScore += 1.6 * tttAmp;
        }
    }

    // Combat opportunity — only brave kits lean into it
    if (brave) {
        if (sameBoardOpp) huntScore += 2.4;
        if (boardHopsToOpp <= 1) huntScore += 1.3;
    } else {
        if (sameBoardOpp) boardScore += 0.8; // leave / claim instead of duel
        if (boardHopsToOpp >= 2) boardScore += 1.4;
    }
    if (boardHopsToOpp >= 3) boardScore += 1.1;

    const amp = unbeatable ? 1.45 : (hardPlus ? 1.15 : 1);
    boardScore *= amp;
    huntScore *= amp;

    const margin = unbeatable
        ? (brave ? 0.15 : -1.5)
        : (hardPlus ? 0.9 : 1.4);
    let preferBoard = boardScore >= huntScore + margin;
    let chaseScale = preferBoard
        ? (unbeatable ? (brave ? 0.1 : 0.04) : (hardPlus ? 0.22 : 0.4))
        : (unbeatable ? (brave ? 1.65 : 0.35) : (hardPlus ? 1.25 : 1.05));
    let claimScale = preferBoard
        ? (unbeatable ? (brave ? 2.55 : 3.2) : (hardPlus ? 1.9 : 1.45))
        : (unbeatable ? (brave ? 0.48 : 1.4) : (hardPlus ? 0.7 : 0.9));

    // Threat gate: safe = TTT paint; threatened brave = hunt
    if (threat.level === 'none') {
        preferBoard = true;
        chaseScale = unbeatable ? (brave ? 0.05 : 0.04) : 0.12;
        claimScale = unbeatable ? (brave ? 2.8 : 3.2) : (hardPlus ? 1.9 : 1.45);
    } else if (threat.level === 'high') {
        if (brave && (threat.sameBoard || threat.boardHops <= 1)) {
            preferBoard = false;
            chaseScale = unbeatable ? 1.8 : 1.25;
            claimScale = unbeatable ? 0.55 : 0.75;
        } else if (!brave) {
            preferBoard = true;
            chaseScale = unbeatable ? 0.08 : 0.15;
        }
    } else if (threat.level === 'low') {
        if (brave && (skill === 'infinite-charge' || playstyle?.preferChargePursuit)) {
            if (threat.boardHops <= 1) {
                preferBoard = boardScore >= huntScore;
                chaseScale = preferBoard ? 0.35 : (unbeatable ? 1.35 : 1.05);
            }
        }
    }

    return {
        preferBoardControl: preferBoard,
        strategyMode: preferBoard ? 'ttt' : 'hunt',
        chaseScale,
        claimScale
    };
}

function getAISkillPlaystyle(p, diff) {
    const tick = (typeof RonkAI !== 'undefined') ? RonkAI.globalTick : -1;
    const army = p ? (p._aiPsArmyLive = (typeof countAIClonesFor === 'function' ? countAIClonesFor(p) : 0)) : 0;
    if (p && p._aiPsTick === tick && p._aiPsDiff === diff && p._aiPsSkill === p.selectedSkill && p._aiPsArmy === army && p._aiPs) {
        return p._aiPs;
    }
    const book = getEntityPlaybook(p, diff);
    const skillBase = (p?.selectedSkill && AI_SKILL_PLAYSTYLES[p.selectedSkill])
        ? { ...AI_SKILL_PLAYSTYLES[p.selectedSkill] }
        : {};
    // Merge difficulty/clone playbook into skill style so every bot has a distinct plan
    let style = {
        ...skillBase,
        claimWeight: book.claimWeight,
        chaseWeightMult: (skillBase.chaseWeightMult ?? 1) * book.chaseWeight,
        travelDashMult: book.travelDashMult,
        hopCooldown: book.hopCooldown,
        boardRace: book.boardRace,
        huntSameBoardOnly: book.huntSameBoardOnly,
        boardDwellTicks: book.boardDwellTicks,
        playbookId: book.id
    };
    if (diff?.unbeatableMode && p?.selectedSkill) {
        const risk = getInvincibleSkillRisk(p, diff);
        if (risk) style = { ...style, ...AI_INVINCIBLE_RISK_TUNING[risk], invincibleRisk: risk };
        // Laser dodge kit: keep skill-authored low chase / high survival over risk-table aggression
        if (skillBase.evadeEnemy || skillBase.spamSkill || skillBase.avoidFightEarly) {
            if (skillBase.aggressionEarly != null) {
                style.aggressionEarly = Math.min(style.aggressionEarly ?? 1, skillBase.aggressionEarly);
            }
            if (skillBase.aggressionLate != null) {
                style.aggressionLate = Math.min(style.aggressionLate ?? 1, skillBase.aggressionLate);
            }
            if (skillBase.spaceAggressionMin != null) {
                style.spaceAggressionMin = Math.max(style.spaceAggressionMin ?? 0, skillBase.spaceAggressionMin);
            }
            if (skillBase.chaseWeightMult != null) {
                style.chaseWeightMult = skillBase.chaseWeightMult * book.chaseWeight;
            }
            style.evadeEnemy = !!skillBase.evadeEnemy;
            style.spamSkill = !!skillBase.spamSkill;
            style.avoidFightEarly = !!skillBase.avoidFightEarly;
        }
        // Passive trails: keep calm authored numbers (do NOT force huntFromStart)
        if (skillBase.isPassiveKit || p.selectedSkill === 'infinite-trails') {
            if (skillBase.aggressionEarly != null) {
                style.aggressionEarly = Math.min(style.aggressionEarly ?? 1, skillBase.aggressionEarly);
            }
            if (skillBase.aggressionLate != null) {
                style.aggressionLate = Math.min(style.aggressionLate ?? 1, skillBase.aggressionLate);
            }
            if (skillBase.spaceAggressionMin != null) {
                style.spaceAggressionMin = Math.max(style.spaceAggressionMin ?? 0, skillBase.spaceAggressionMin);
            }
            if (skillBase.chaseWeightMult != null) {
                style.chaseWeightMult = skillBase.chaseWeightMult * book.chaseWeight;
            }
            style.isPassiveKit = true;
            style.jailEnemy = !!skillBase.jailEnemy;
            style.lockFirstCpPerBoard = !!skillBase.lockFirstCpPerBoard;
            style.paintCpCage = !!skillBase.paintCpCage;
            style.huntFromStart = false;
            style.trapOpponent = !!skillBase.trapOpponent;
            if (skillBase.chargeBiasEarly != null) style.chargeBiasEarly = skillBase.chargeBiasEarly;
            if (skillBase.spacePressureMult != null) style.spacePressureMult = skillBase.spacePressureMult;
            if (skillBase.boardDwellTicks != null) style.boardDwellTicks = skillBase.boardDwellTicks;
        }
        // Active charge hunt kit: keep aggression hot
        else if (skillBase.huntFromStart || skillBase.preferChargePursuit) {
            if (skillBase.aggressionEarly != null) {
                style.aggressionEarly = Math.max(style.aggressionEarly ?? 1, skillBase.aggressionEarly);
            }
            if (skillBase.aggressionLate != null) {
                style.aggressionLate = Math.max(style.aggressionLate ?? 1, skillBase.aggressionLate);
            }
            if (skillBase.spaceAggressionMin != null) {
                style.spaceAggressionMin = Math.min(style.spaceAggressionMin ?? 99, skillBase.spaceAggressionMin);
            }
            if (skillBase.chaseWeightMult != null) {
                style.chaseWeightMult = skillBase.chaseWeightMult * book.chaseWeight;
            }
            style.huntFromStart = !!skillBase.huntFromStart;
            style.jailEnemy = !!skillBase.jailEnemy;
            if (skillBase.trapOpponent) style.trapOpponent = true;
            if (skillBase.chargeBiasEarly != null) style.chargeBiasEarly = skillBase.chargeBiasEarly;
            if (skillBase.spacePressureMult != null) style.spacePressureMult = skillBase.spacePressureMult;
            if (skillBase.catchRunaways) style.catchRunaways = true;
            if (skillBase.preferChargePursuit) style.preferChargePursuit = true;
        }
        // Preserve bravery / coward / board-focus flags through risk merge
        if (skillBase.playsBrave) style.playsBrave = true;
        if (skillBase.playsCoward) style.playsCoward = true;
        if (skillBase.forceBoardFocus) style.forceBoardFocus = true;
        if (skillBase.braveryNeedsArmyGt2) style.braveryNeedsArmyGt2 = true;
        if (skillBase.riskOnlyWithBackupLife) style.riskOnlyWithBackupLife = true;
        if (skillBase.neutralUntilBackup) style.neutralUntilBackup = true;
        if (skillBase.useFullInvisOften) style.useFullInvisOften = true;
        if (skillBase.useFullInvisAmbush) style.useFullInvisAmbush = true;
        if (skillBase.noCombatDash) style.noCombatDash = true;
        if (skillBase.kiteDash) style.kiteDash = true;
        if (skillBase.winSpeedDash) style.winSpeedDash = true;
        if (skillBase.preferInland) style.preferInland = true;
        if (skillBase.edgeHateMult != null) style.edgeHateMult = skillBase.edgeHateMult;
        if (skillBase.claimWeightBoost != null) {
            style.claimWeight = (style.claimWeight ?? 1) * skillBase.claimWeightBoost;
        }
        if (skillBase.travelDashMult != null) {
            style.travelDashMult = skillBase.travelDashMult * (book.travelDashMult ?? 1);
        }
        // Take the *faster* hop / shorter dwell when skill wants more board travel
        if (skillBase.hopCooldown != null) {
            style.hopCooldown = Math.min(style.hopCooldown ?? skillBase.hopCooldown, skillBase.hopCooldown);
        }
        if (skillBase.boardDwellTicks != null) {
            style.boardDwellTicks = Math.min(
                style.boardDwellTicks ?? skillBase.boardDwellTicks,
                skillBase.boardDwellTicks
            );
        }
    }
    if (p) {
        p._aiPsTick = tick;
        p._aiPsDiff = diff;
        p._aiPsSkill = p.selectedSkill;
        p._aiPsArmy = army;
        p._aiPs = style;
    }
    return style;
}

/** Main player for a clone (or self if not a clone). */
function aiResolveOwnerPlayer(p) {
    if (!p) return null;
    if (!p.isClone) return p;
    const base = typeof getPlayerBaseId === 'function'
        ? getPlayerBaseId(p.id)
        : String(p.id).split('_')[0];
    if (typeof p1 !== 'undefined' && p1 && getPlayerBaseId(p1.id) === base) return p1;
    if (typeof p2 !== 'undefined' && p2 && getPlayerBaseId(p2.id) === base) return p2;
    return p;
}

/** Friendly cubes for this side: owner + living clones. */
function aiLivingArmyCount(p) {
    const owner = aiResolveOwnerPlayer(p);
    if (!owner) return 0;
    if (typeof countFriendlyCubesFor === 'function') {
        return countFriendlyCubesFor(owner);
    }
    const mainAlive = owner.isDead ? 0 : 1;
    return mainAlive + countAIClonesFor(owner);
}

/** True when AI has a spare life (extra-life joker) or at least one living clone */
function aiHasBackupLife(p) {
    const owner = aiResolveOwnerPlayer(p);
    if (!owner) return false;
    if (owner.hasExtraLife && (owner.extraLives || 0) > 0) return true;
    return countAIClonesFor(owner) > 0;
}

/**
 * Brave = infinite-charge always, OR clone OWNER only when more than 2 bodies alive.
 * Clone cubes themselves never brave-hunt — they board-race carefully.
 */
function aiPlaysBrave(p, playstyle) {
    if (!p) return false;
    if (p.isClone) return false;
    const style = playstyle || null;
    if (p.selectedSkill === 'infinite-charge' || style?.playsBrave || style?.preferChargePursuit) {
        return true;
    }
    if (p.selectedSkill === 'clones' || style?.braveryNeedsArmyGt2) {
        return aiLivingArmyCount(p) > 2;
    }
    return false;
}

function aiIsSpectateMatch() {
    return typeof isSpectateMode !== 'undefined' && isSpectateMode;
}

function aiResolveOpponentFor(p) {
    try {
        if (typeof p1 !== 'undefined' && typeof p2 !== 'undefined' && p) {
            if (p === p1) return p2;
            if (p === p2) return p1;
        }
    } catch (_) { /* ignore */ }
    return null;
}

/**
 * How close / dangerous the enemy is — drives TTT vs chase for Elite spectate + play.
 */
function aiAssessEnemyThreat(p, opponent, playstyle, diff) {
    const out = {
        level: 'none',
        sameBoard: false,
        boardHops: 99,
        dist: 99,
        charging: false,
        seeCube: false,
        laserNear: false
    };
    if (!p || !opponent || opponent.isDead) return out;

    const sense = AI_HELPERS.aiResolveOpponentView(p, opponent);
    const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
    const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
    const boardHops = AI_HELPERS.boardHopDist(psx, psy, sense.boardSx, sense.boardSy);
    out.boardHops = boardHops;
    out.sameBoard = boardHops === 0;
    out.seeCube = !!sense.seeCube;
    out.dist = out.sameBoard
        ? Math.abs(p.x - sense.x) + Math.abs(p.y - sense.y)
        : boardHops * 20 + 10;

    const oDir = sense.dir || opponent.dir || { x: 0, y: 0 };
    const inLineX = p.x === sense.x;
    const inLineY = p.y === sense.y;
    const facingUs = (inLineY && Math.sign(p.x - sense.x) === Math.sign(oDir.x || 0))
        || (inLineX && Math.sign(p.y - sense.y) === Math.sign(oDir.y || 0));
    out.charging = !!(opponent.isCharging || opponent.infiniteChargeActive)
        && facingUs && sense.seeCube;

    if (typeof laserLines !== 'undefined' && laserLines.length) {
        for (let li = 0; li < laserLines.length; li++) {
            const laser = laserLines[li];
            if (typeof isEnemyLaserLethalTo === 'function' && !isEnemyLaserLethalTo(laser, p)) continue;
            if (laser.boardSx === psx && laser.boardSy === psy) {
                out.laserNear = true;
                break;
            }
        }
    }

    if (!sense.seeCube && boardHops >= 2) {
        out.level = 'none';
    } else if (out.charging || out.laserNear || (out.sameBoard && out.seeCube && out.dist <= 14)) {
        out.level = 'high';
    } else if (boardHops === 1 || (out.sameBoard && out.dist > 12 && out.dist <= 16)) {
        out.level = 'low';
    } else if (boardHops >= 2 || out.dist > 16) {
        out.level = 'none';
    } else {
        out.level = 'low';
    }
    return out;
}

function isSkillOpenPhase(p, style) {
    if (!style) return false;
    return (p.ticksAlive || 0) < (style.earlyTicks ?? 150);
}

function isSkillPressureActive(p) {
    const skill = p.selectedSkill;
    if (!skill) return false;
    if (skill === 'laser' && p.activeLaserRoutines?.length > 0) return true;
    if (skill === 'clones' && countAIClonesFor(p) > 0) return true; // ACTIVE
    // infinite-trails is PASSIVE — pressure is the permanent trail itself, not an "active buff window"
    if (skill === 'infinite-trails') return true;
    if (skill === 'infinite-charge' && p.infiniteChargeActive) return true; // ACTIVE
    if (skill === 'invisible') return !!p.fullInvisibleActive; // only full cloak counts as pressure
    return false;
}

function getPlaystyleAggression(p, diff, style) {
    const base = diff.aggression ?? 1;
    if (!style) return base;
    const early = style.aggressionEarly ?? 1;
    const late = style.aggressionLate ?? 1;
    const mult = isSkillOpenPhase(p, style) ? early : late;
    return base * (Number.isFinite(mult) ? mult : 1);
}

function getAIChargeLeapDistance(p) {
    return aiChargeDist(p);
}

function aiDashDist(p) {
    return Math.max(1, Math.floor((4 - (p.jokerDashNerf || 0)) + (p.jokerDashBonus || 0)));
}

function aiChargeDist(p) {
    const base = (p && p.infiniteChargeActive) ? 8.5 : 6.5;
    return Math.max(1, Math.floor(base + ((p && p.jokerChargeBonus) || 0)));
}

function aiSimulateLeap(p, dir, dist, gridCount) {
    const g = gridCount || 20;
    const dx = (dir && dir.x) || 0;
    const dy = (dir && dir.y) || 0;
    const steps = Math.max(1, Math.floor(dist));
    let x = p.x;
    let y = p.y;
    let hopped = false;
    let hopDx = 0;
    let hopDy = 0;
    if (!dx && !dy) {
        return { hopped: false, hopDx: 0, hopDy: 0, x, y, steps, landEdge: AI_HELPERS.distToSectorEdge(x, y, g) };
    }
    for (let i = 0; i < steps; i++) {
        x += dx;
        y += dy;
        if (x < 0 || x >= g || y < 0 || y >= g) {
            hopped = true;
            hopDx = x < 0 ? -1 : (x >= g ? 1 : hopDx);
            hopDy = y < 0 ? -1 : (y >= g ? 1 : hopDy);
            if (x < 0) x = g - 1;
            else if (x >= g) x = 0;
            if (y < 0) y = g - 1;
            else if (y >= g) y = 0;
        }
    }
    return { hopped, hopDx, hopDy, x, y, steps, landEdge: AI_HELPERS.distToSectorEdge(x, y, g) };
}

function aiBoardOursCpCount(p, ownerKey) {
    if (!p || typeof worldBoards === 'undefined' || !worldBoards?.length) return 0;
    const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
    const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
    const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
    const board = worldBoards[psy * n + psx];
    if (!board) return 0;
    if (board.owner === ownerKey) return 3;
    return (board.checkpoints || []).filter((c) => c && c.owner === ownerKey).length;
}

function aiBoardClaimed(p, ownerKey) {
    return aiBoardOursCpCount(p, ownerKey) >= 3;
}

function aiHopDirToBoard(p, sx, sy) {
    const needDx = AI_HELPERS.signedBoardDelta(p.boardSx ?? 1, sx);
    const needDy = AI_HELPERS.signedBoardDelta(p.boardSy ?? 1, sy);
    if (needDx < 0) return { x: -1, y: 0, needDx, needDy };
    if (needDx > 0) return { x: 1, y: 0, needDx, needDy };
    if (needDy < 0) return { x: 0, y: -1, needDx, needDy };
    if (needDy > 0) return { x: 0, y: 1, needDx, needDy };
    return null;
}

function aiLeapHopsToward(p, dir, dist, gridCount) {
    if (!p || !dir) return null;
    const sim = aiSimulateLeap(p, dir, dist, gridCount);
    if (!sim.hopped) return null;
    if (dir.x && sim.hopDx !== dir.x) return null;
    if (dir.y && sim.hopDy !== dir.y) return null;
    return sim;
}

function aiTravelLeapChoice(p, hopDir, gridCount) {
    if (!p || !hopDir) return null;
    const dashSim = aiLeapHopsToward(p, hopDir, aiDashDist(p), gridCount);
    const canCharge = !isAIChargeBusy(p);
    const chargeSim = canCharge ? aiLeapHopsToward(p, hopDir, aiChargeDist(p), gridCount) : null;
    if (chargeSim && dashSim) return chargeSim.landEdge > dashSim.landEdge ? 'charge' : 'dash';
    if (dashSim) return 'dash';
    if (chargeSim) return 'charge';
    return null;
}

function aiLeapQueued(p) {
    return !!(p && (p.isDashing || p.isCharging));
}

function aiFreezeDirForLeap(p, d) {
    if (!p || !d) return;
    p.dir = { x: d.x, y: d.y };
    p._aiLeapDirLock = { x: d.x, y: d.y };
}

function aiKeepLeapDir(p) {
    const lock = p && p._aiLeapDirLock;
    if (!lock || !aiLeapQueued(p)) {
        if (p) p._aiLeapDirLock = null;
        return;
    }
    p.dir = { x: lock.x, y: lock.y };
}

/** Pick the next board when local work is done or kit needs off-board pressure (laser). */
function aiPickOffBoardTarget(p, ownerKey, opponent, playstyle) {
    const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
    const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
    const exclude = new Set([`${psx}_${psy}`]);
    if (p.selectedSkill === 'laser' && opponent) {
        const osx = Number.isInteger(opponent.boardSx) ? opponent.boardSx : 1;
        const osy = Number.isInteger(opponent.boardSy) ? opponent.boardSy : 1;
        if (osx !== psx || osy !== psy) {
            const hops = AI_HELPERS.boardHopDist(psx, psy, osx, osy);
            if (hops >= 1 && hops <= 3) {
                return {
                    sx: osx, sy: osy, hops,
                    dist: Math.abs(p.x - opponent.x) + Math.abs(p.y - opponent.y),
                    priority: 8500,
                    laserBoard: true
                };
            }
        }
    }
    if (aiBoardClaimed(p, ownerKey) || aiShouldForceBoardExplore(p, playstyle, ownerKey)) {
        const next = AI_HELPERS.pickBoardStrategyTarget(p.x, p.y, ownerKey, p, {
            excludeKeys: exclude, preferOffBoard: true
        });
        if (next && next.hops > 0) return next;
    }
    return null;
}

/** True if a charge leap stays a hop/land — never a rim suicide or accidental hop. */
function aiChargePathOk(p, leap, gridCount, opts) {
    if (!p?.dir) return false;
    const dx = p.dir.x || 0;
    const dy = p.dir.y || 0;
    if (!dx && !dy) return false;
    const sim = aiSimulateLeap(p, p.dir, leap, gridCount);
    if (sim.hopped) {
        if (!(opts && opts.allowHop)) return false;
        const needDx = opts.needDx || 0;
        const needDy = opts.needDy || 0;
        if (needDx && sim.hopDx !== Math.sign(needDx)) return false;
        if (needDy && sim.hopDy !== Math.sign(needDy)) return false;
        if (!needDx && !needDy) return false;
        if (sim.landEdge < 2 && !p.jokerBorderSafe) return false;
        return true;
    }
    if (sim.landEdge <= 1 && !p.jokerBorderSafe) return false;
    return sim.steps >= 1;
}

/** Combat dash must stay inland; travel dash/charge only if the leap actually hops. */
function aiEliteDashDirSafe(p, d, gridCount, travelDash, opponent) {
    if (!p || !d) return false;
    const sim = aiSimulateLeap(p, d, aiDashDist(p), gridCount);
    if (travelDash) {
        if (!sim.hopped) return false;
        if (d.x && sim.hopDx !== d.x) return false;
        if (d.y && sim.hopDy !== d.y) return false;
        if (sim.landEdge < 2 && !p.jokerBorderSafe) return false;
        return true;
    }
    if (sim.hopped) return false;
    if (sim.landEdge < 3) return false;
    if (opponent && AI_HELPERS.isOccupied(sim.x, sim.y, p, opponent, gridCount)) return false;
    return true;
}

/** Current win goal for movement / dash progress checks. */
function aiWinGoal(p, opponent, playstyle) {
    const ownerKey = (String(p.id).split('_')[0] === '1') ? 'player' : 'enemy';
    const diff = getPlayerDifficultyProfile(p);
    const threat = aiAssessEnemyThreat(p, opponent, playstyle, diff);
    const hunger = RonkAI.hungerState(p, diff);

    // Brave + threatened: hunt the visible enemy cube first
    if (threat.level !== 'none' && opponent && aiPlaysBrave(p, playstyle)) {
        const sense = AI_HELPERS.aiResolveOpponentView(p, opponent);
        if (sense.seeCube) {
            return {
                kind: 'kill', x: sense.x, y: sense.y,
                sx: sense.boardSx, sy: sense.boardSy,
                hops: AI_HELPERS.boardHopDist(p.boardSx ?? 1, p.boardSy ?? 1, sense.boardSx, sense.boardSy),
                dist: Math.abs(p.x - sense.x) + Math.abs(p.y - sense.y)
            };
        }
    }

    if (hunger.urgentHunger || hunger.panicHunger || hunger.survivalFocus) {
        const apple = AI_HELPERS.nearestAppleTarget(p.x, p.y, p);
        if (apple) {
            return {
                kind: 'apple', x: apple.x, y: apple.y,
                sx: apple.sx, sy: apple.sy, hops: apple.hops, dist: apple.dist
            };
        }
    }
    if (playstyle?.lockFirstCpPerBoard || p.selectedSkill === 'infinite-trails') {
        const lock = AI_HELPERS.pickTrailLockTarget(p.x, p.y, ownerKey, p);
        if (lock) {
            return {
                kind: 'cp', x: lock.cpX, y: lock.cpY,
                sx: lock.sx, sy: lock.sy, hops: lock.hops, dist: lock.dist
            };
        }
    }
    if (typeof worldBoards !== 'undefined' && worldBoards?.length) {
        if (p.selectedSkill === 'laser' && aiBoardClaimed(p, ownerKey)) {
            const hopBoard = aiPickOffBoardTarget(p, ownerKey, opponent, playstyle);
            if (hopBoard && hopBoard.hops > 0) {
                return {
                    kind: 'cp', x: hopBoard.cpX, y: hopBoard.cpY,
                    sx: hopBoard.sx, sy: hopBoard.sy, hops: hopBoard.hops, dist: hopBoard.dist
                };
            }
        }
        const cp = AI_HELPERS.pickBoardStrategyTarget(p.x, p.y, ownerKey, p);
        if (cp) {
            return {
                kind: 'cp', x: cp.cpX, y: cp.cpY,
                sx: cp.sx, sy: cp.sy, hops: cp.hops, dist: cp.dist
            };
        }
    }
    return null;
}

function aiGoalDistAt(x, y, sx, sy, goal) {
    if (!goal) return 9999;
    const hops = AI_HELPERS.boardHopDist(sx, sy, goal.sx ?? sx, goal.sy ?? sy);
    if (hops > 0) {
        return hops * 40
            + AI_HELPERS.distToSectorEdge(x, y, (typeof GRID_COUNT === 'number') ? GRID_COUNT : 20);
    }
    if (Number.isFinite(goal.x) && Number.isFinite(goal.y)) {
        return Math.abs(x - goal.x) + Math.abs(y - goal.y);
    }
    return 9999;
}

/** True if landing is meaningfully closer to the win goal (or a board hop that reduces hops). */
function aiDashAdvancesGoal(p, d, gridCount, goal, travelDash) {
    if (!goal) return false;
    const sim = aiSimulateLeap(p, d, aiDashDist(p), gridCount);
    if (travelDash) {
        if (!sim.hopped) return false;
        const nextSx = AI_HELPERS.wrapBoard((p.boardSx ?? 1) + sim.hopDx);
        const nextSy = AI_HELPERS.wrapBoard((p.boardSy ?? 1) + sim.hopDy);
        const before = AI_HELPERS.boardHopDist(p.boardSx ?? 1, p.boardSy ?? 1, goal.sx, goal.sy);
        const after = AI_HELPERS.boardHopDist(nextSx, nextSy, goal.sx, goal.sy);
        return after < before;
    }
    if (sim.hopped) return false;
    if (sim.landEdge < 3) return false;
    if (goal.hops > 0) return false;
    const before = aiGoalDistAt(p.x, p.y, p.boardSx ?? 1, p.boardSy ?? 1, goal);
    const after = aiGoalDistAt(sim.x, sim.y, p.boardSx ?? 1, p.boardSy ?? 1, goal);
    return after <= before - 3;
}

/** Reject dashing back onto a cell we just left (back-and-forth spam). */
function aiDashIsOscillation(p, landX, landY) {
    const hist = p._aiDashHist;
    if (!Array.isArray(hist) || !hist.length) return false;
    const tick = p.aiAbilityTicks || 0;
    const dx = landX - p.x;
    const dy = landY - p.y;
    for (let i = hist.length - 1; i >= 0 && i >= hist.length - 6; i--) {
        const h = hist[i];
        if (!h || h.travel) continue;
        if (tick - (h.tick || 0) > 64) continue;
        if (h.fromX === landX && h.fromY === landY) return true;
        if (h.toX === landX && h.toY === landY) return true;
        if (h.toX === p.x && h.toY === p.y) return true;
        if (i === hist.length - 1 && h.dx === -Math.sign(dx) && h.dy === -Math.sign(dy)
            && (h.dx !== 0 || h.dy !== 0)) return true;
    }
    return false;
}

function aiRecordDash(p, d, travelDash) {
    if (!p || !d) return;
    if (!Array.isArray(p._aiDashHist)) p._aiDashHist = [];
    const toX = travelDash ? p.x : p.x + d.x * 4;
    const toY = travelDash ? p.y : p.y + d.y * 4;
    p._aiDashHist.push({
        fromX: p.x, fromY: p.y,
        toX, toY,
        dx: d.x, dy: d.y,
        tick: p.aiAbilityTicks || 0,
        travel: !!travelDash
    });
    if (p._aiDashHist.length > 8) p._aiDashHist.shift();
    p._aiLastNonTravelDashTick = travelDash ? p._aiLastNonTravelDashTick : (p.aiAbilityTicks || 0);
}

/**
 * Elite never walks off / faces the death rim unless intentionally boarding.
 * Call after pickMove every think tick.
 */
function aiEliteStabilizeDir(p, gridCount, opponent, diff, playstyle) {
    if (!p || !(diff?.unbeatableMode || diff?.eliteReactions || diff?.perfectReactions)) return;
    const edge = AI_HELPERS.distToSectorEdge(p.x, p.y, gridCount);
    const dir = p.dir || { x: 1, y: 0 };
    const nx = p.x + (dir.x || 0);
    const ny = p.y + (dir.y || 0);
    const goal = aiWinGoal(p, opponent, playstyle);
    const wantsHop = !!(goal && goal.hops > 0);
    let onTravelEdge = false;
    let needDx = 0;
    let needDy = 0;
    if (wantsHop && goal) {
        needDx = AI_HELPERS.signedBoardDelta(p.boardSx ?? 1, goal.sx);
        needDy = AI_HELPERS.signedBoardDelta(p.boardSy ?? 1, goal.sy);
        onTravelEdge =
            (needDx < 0 && p.x <= 1) || (needDx > 0 && p.x >= gridCount - 2) ||
            (needDy < 0 && p.y <= 1) || (needDy > 0 && p.y >= gridCount - 2);
        if (onTravelEdge && edge <= 1) {
            if (needDx < 0 && p.x <= 1) p.dir = { x: -1, y: 0 };
            else if (needDx > 0 && p.x >= gridCount - 2) p.dir = { x: 1, y: 0 };
            else if (needDy < 0 && p.y <= 1) p.dir = { x: 0, y: -1 };
            else if (needDy > 0 && p.y >= gridCount - 2) p.dir = { x: 0, y: 1 };
            return;
        }
    }
    // Walking off the board next step → force inland
    const wouldLeave = nx < 0 || nx >= gridCount || ny < 0 || ny >= gridCount;
    const nextEdge = (nx >= 0 && nx < gridCount && ny >= 0 && ny < gridCount)
        ? AI_HELPERS.distToSectorEdge(nx, ny, gridCount)
        : -1;
    const wouldRim = nextEdge >= 0 && nextEdge < edge && edge <= 3;
    const huggingRim = edge <= 2 && !onTravelEdge;
    const divingRim = !onTravelEdge && edge >= 3 && nextEdge >= 0 && nextEdge <= 1;
    if (wouldLeave || wouldRim || huggingRim || divingRim) {
        let best = null;
        let bestScore = -Infinity;
        for (const pd of AI_DIRS) {
            const d = pd.d;
            const tx = p.x + d.x;
            const ty = p.y + d.y;
            if (tx < 0 || tx >= gridCount || ty < 0 || ty >= gridCount) continue;
            if (d.x === -dir.x && d.y === -dir.y) continue;
            if (opponent && AI_HELPERS.isOccupied(tx, ty, p, opponent, gridCount)) continue;
            const e = AI_HELPERS.distToSectorEdge(tx, ty, gridCount);
            let s = e * 120;
            if (e >= 3) s += 80;
            if (goal && goal.hops === 0 && Number.isFinite(goal.x)) {
                s -= (Math.abs(tx - goal.x) + Math.abs(ty - goal.y)) * 4;
            } else if (goal && goal.hops > 0) {
                if (needDx && d.x === Math.sign(needDx) && e >= 2) s += 30;
                if (needDy && d.y === Math.sign(needDy) && e >= 2) s += 30;
            }
            if (s > bestScore) { bestScore = s; best = d; }
        }
        if (best) p.dir = { x: best.x, y: best.y };
    }
}

/** Elite: drop rim/pocket suicides before heuristic/brain pick. Exit rim only when hopping. */
function eliteSurvivalMoves(p, opponent, gridCount, diff, safeList) {
    if (!safeList || !safeList.length) return safeList || [];
    const minSp = Math.max(12, diff.minSafeSpace || 20);
    const playstyle = getAISkillPlaystyle(p, diff);
    const goal = aiWinGoal(p, opponent, playstyle);
    const wantsHop = !!(goal && goal.hops > 0);
    let needDx = 0;
    let needDy = 0;
    if (wantsHop && goal) {
        needDx = AI_HELPERS.signedBoardDelta(p.boardSx ?? 1, goal.sx);
        needDy = AI_HELPERS.signedBoardDelta(p.boardSy ?? 1, goal.sy);
    }
    const curEdge = AI_HELPERS.distToSectorEdge(p.x, p.y, gridCount);
    const filtered = safeList.filter((s) => {
        if (!(s.space > minSp * 0.55)) return false;
        const dir = AI_HELPERS.indexToDir(s.idx);
        const nx = p.x + dir.x;
        const ny = p.y + dir.y;
        if (nx < 0 || nx >= gridCount || ny < 0 || ny >= gridCount) return false;
        const e = (s.edge != null) ? s.edge : AI_HELPERS.distToSectorEdge(nx, ny, gridCount);
        const onExit =
            wantsHop && (
                (needDx < 0 && nx <= 1 && dir.x <= 0) ||
                (needDx > 0 && nx >= gridCount - 2 && dir.x >= 0) ||
                (needDy < 0 && ny <= 1 && dir.y <= 0) ||
                (needDy > 0 && ny >= gridCount - 2 && dir.y >= 0)
            );
        if (e <= 0 && !onExit) return false;
        if (e <= 1 && !onExit && curEdge >= 2) return false;
        if (!onExit && curEdge >= 4 && e < curEdge && e <= 2) return false;
        if (!onExit && s.space < minSp && e <= 3) return false;
        return true;
    });
    if (filtered.length) return filtered;
    // Last resort: any move that is not immediate off-board / zero space
    return safeList.filter((s) => {
        const dir = AI_HELPERS.indexToDir(s.idx);
        const nx = p.x + dir.x;
        const ny = p.y + dir.y;
        if (nx < 0 || nx >= gridCount || ny < 0 || ny >= gridCount) return false;
        const e = (s.edge != null) ? s.edge : AI_HELPERS.distToSectorEdge(nx, ny, gridCount);
        return s.space > 2 && e >= 1;
    });
}

function getAIChargeAxisInfo(p, opponent) {
    const sense = AI_HELPERS.aiResolveOpponentView(p, opponent);
    const ox = sense.x;
    const oy = sense.y;
    const inLineX = p.x === ox;
    const inLineY = p.y === oy;
    if (!inLineX && !inLineY) {
        return { aligned: false, axisDist: Infinity, inLineX: false, inLineY: false };
    }
    const dir = p.dir || { x: 0, y: 0 };
    const facingEnemy = (inLineY && Math.sign(ox - p.x) === Math.sign(dir.x)) ||
        (inLineX && Math.sign(oy - p.y) === Math.sign(dir.y));
    const axisDist = inLineY ? Math.abs(ox - p.x) : Math.abs(oy - p.y);
    return { aligned: facingEnemy, axisDist, inLineX, inLineY, confidence: sense.confidence };
}

/** Infinite-charge Elite: snap onto the charge axis toward the rival before chaining leaps. */
function aiSnapChargeFacing(p, opponent) {
    if (!p || p.isClone) return;
    if (p.selectedSkill !== 'infinite-charge' && !p.infiniteChargeActive) return;
    const sense = AI_HELPERS.aiResolveOpponentView(p, opponent);
    const ox = sense.x;
    const oy = sense.y;
    if (p.x === ox && p.y === oy) return;
    // Already on same row/col — face them
    if (p.y === oy && p.x !== ox) {
        const sx = Math.sign(ox - p.x);
        if (sx) p.dir = { x: sx, y: 0 };
        return;
    }
    if (p.x === ox && p.y !== oy) {
        const sy = Math.sign(oy - p.y);
        if (sy) p.dir = { x: 0, y: sy };
        return;
    }
    // Off-axis: pick the longer remaining axis so the next leap closes distance
    const dx = ox - p.x;
    const dy = oy - p.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
        const sx = Math.sign(dx);
        if (sx) p.dir = { x: sx, y: 0 };
    } else {
        const sy = Math.sign(dy);
        if (sy) p.dir = { x: 0, y: sy };
    }
}

function isAIChargeBusy(p) {
    return p.isCharging || p.chargeAnimTicks > 0 || p.isDashing || p.dashAnimTicks > 0;
}

function evaluateTacticalCharge(p, opponent, gridCount, diff, ctx) {
    if (isAIChargeBusy(p)) return false;
    if (!p.dir || (p.dir.x === 0 && p.dir.y === 0)) return false;

    const { dist, space, facingEnemy, inLineX, inLineY } = ctx;
    const leap = getAIChargeLeapDistance(p);
    const normalLeap = Math.floor(6.5 + (p.jokerChargeBonus || 0));
    const axis = getAIChargeAxisInfo(p, opponent);
    const elite = diff.eliteReactions || diff.perfectReactions || diff.unbeatableMode;
    const hunger = RonkAI.hungerState(p, diff);
    const playstyle = getAISkillPlaystyle(p, diff);
    const openPhase = playstyle && isSkillOpenPhase(p, playstyle);
    const invRisk = playstyle?.invincibleRisk;
    const isInfCharge = p.selectedSkill === 'infinite-charge' || p.infiniteChargeActive;
    const brave = aiPlaysBrave(p, playstyle);

    if (hunger.urgentHunger && !(axis.aligned && axis.axisDist >= 1 && axis.axisDist <= leap + 1)) {
        return false;
    }

    if (!aiChargePathOk(p, leap, gridCount)) return false;

    // Charge pierces trails — cube still claims checkpoints. Use this to break forever-trail cages.
    const ownerKeyCh = (String(p.id).split('_')[0] === '1') ? 'player' : 'enemy';
    const cpPierce = AI_HELPERS.checkpointOnChargeLine(p, leap + 1, ownerKeyCh);
    const foeHasInfTrail = AI_HELPERS.opponentHasInfiniteTrails(opponent);
    if (cpPierce && (brave || isInfCharge || playstyle?.preferChargePursuit || foeHasInfTrail)) {
        // Land shouldn't be suicide rim unless hopping
        const landEdge = AI_HELPERS.distToSectorEdge(
            p.x + (p.dir.x || 0) * cpPierce.gap,
            p.y + (p.dir.y || 0) * cpPierce.gap,
            gridCount
        );
        if (landEdge >= 1 || p.jokerBorderSafe) {
            if (diff.unbeatableMode || foeHasInfTrail || isInfCharge) return true;
            if (Math.random() < 0.88) return true;
        }
    }

    // Cowards: almost never charge — only a short, safe, guaranteed hit (no suicide leaps)
    if (!brave && !isInfCharge) {
        if (playstyle?.evadeEnemy || playstyle?.forceBoardFocus || playstyle?.playsCoward
            || p.selectedSkill === 'infinite-trails' || p.selectedSkill === 'invisible'
            || p.selectedSkill === 'laser' || p.selectedSkill === 'clones') {
            // Trails kit: almost never combat-charge (paint lock is the wincon)
            if (p.selectedSkill === 'infinite-trails' || playstyle?.lockFirstCpPerBoard) {
                return false;
            }
            if (!(axis.aligned && axis.axisDist >= 2 && axis.axisDist <= Math.min(leap, 4)
                && space > 55 && AI_HELPERS.distToSectorEdge(p.x, p.y, gridCount) >= 3)) {
                return false;
            }
            return Math.random() < 0.18;
        }
    }

    // Direct strike: aligned opponent within charge hit range (brave / charge kits)
    if (axis.aligned && axis.axisDist >= 1 && axis.axisDist <= leap + 1) {
        // Elite: don't take a "guaranteed" hit that leaves you on the death rim
        if (diff.unbeatableMode) {
            const edge = AI_HELPERS.distToSectorEdge(p.x, p.y, gridCount);
            if (edge <= 1 && !p.jokerBorderSafe) return false;
        }
        return true;
    }

    // Laser dodge kit: only charge on guaranteed hits
    if ((invRisk === 'low' || playstyle?.evadeEnemy) && !isInfCharge) return false;

    // Infinite charge: spam charges to catch runaways (invuln during the leap)
    if (isInfCharge && (elite || diff.unbeatableMode || playstyle?.catchRunaways || playstyle?.preferChargePursuit)) {
        const ticksSince = (p.aiAbilityTicks || 0) - (p._aiLastChargeTick || -999);
        // Active window: chain every tick when path is safe
        const gap = p.infiniteChargeActive ? 0 : 2;
        const canChain = ticksSince >= gap;
        const onAxis = !!(inLineX || inLineY || axis.inLineX || axis.inLineY);
        const facing = !!(facingEnemy || axis.aligned);
        const edge = AI_HELPERS.distToSectorEdge(p.x, p.y, gridCount);

        // Same row/col and facing them — charge across almost any gap
        if (facing && onAxis && axis.axisDist >= 1 && axis.axisDist <= leap + 12 && canChain) {
            return true;
        }
        // Infinite-charge skill active: chain whenever on axis toward rival
        if (p.infiniteChargeActive && onAxis && axis.axisDist >= 1 && axis.axisDist <= leap + 14) {
            return canChain;
        }
        // Close the gap on a fleeing enemy even mid-range
        if (facing && onAxis && axis.axisDist > leap && axis.axisDist <= leap * 4 && canChain) {
            return true;
        }
        // Not perfectly aligned yet but already facing their general direction
        if (facing && dist < 100 && axis.axisDist <= leap + 8 && canChain) {
            return true;
        }
        // Active skill: spam any safe inland charge toward the fight
        if (p.infiniteChargeActive && canChain && edge >= 2 && dist < 140) {
            return true;
        }
        // Elite infinite-charge: pop skill then immediately charge if rival is anywhere nearby
        if (p.infiniteChargeActive && diff.unbeatableMode && dist < 140 && canChain) {
            return true;
        }
    }

    // Infinite trails: almost never combat-charge — lockdown paint is the kit
    if ((playstyle?.jailEnemy || p.selectedSkill === 'infinite-trails')
        && !brave
        && !cpPierce) {
        return false;
    }

    if (!axis.aligned) {
        if (p.infiniteChargeActive && (axis.inLineX || axis.inLineY)
            && axis.axisDist >= 1 && axis.axisDist <= leap + 14) {
            const ticksSince = (p.aiAbilityTicks || 0) - (p._aiLastChargeTick || -999);
            return ticksSince >= 1;
        }
        return false;
    }

    if (p.infiniteChargeActive) {
        const minGap = (diff.unbeatableMode && invRisk === 'high') ? 0 : (diff.unbeatableMode ? 0 : 6);
        const ticksSince = (p.aiAbilityTicks || 0) - (p._aiLastChargeTick || -999);
        const canChain = ticksSince >= minGap;

        if (axis.axisDist > normalLeap && axis.axisDist <= leap + 6 && dist < 90) {
            return canChain || axis.axisDist <= leap;
        }

        if (diff.unbeatableMode && invRisk === 'high') {
            if (axis.axisDist >= 1 && axis.axisDist <= leap + 12 && canChain) return true;
            if (axis.axisDist <= leap + 4) return true;
        }

        if (diff.unbeatableMode && axis.axisDist >= 1 && axis.axisDist <= leap + 8 && canChain && dist < 90) {
            return invRisk === 'high' ? true : Math.random() < 0.92;
        }
        if (p.infiniteChargeActive && diff.unbeatableMode && axis.axisDist >= 1 && canChain) {
            return true;
        }
        return false;
    }

    const chargeRange = (diff.unbeatableMode ? 70 : elite ? 28 : 18) + (p.jokerChargeBonus || 0) * 3;
    if (axis.axisDist >= 2 && axis.axisDist < chargeRange) {
        const chargeChanceMult = playstyle?.chargeBiasEarly || 1;
        let chargeRoll = Math.min(1, (elite ? 0.92 : diff.chargeChance) * chargeChanceMult);
        if (diff.unbeatableMode && isInfCharge) {
            chargeRoll = 0.98;
        } else if (invRisk === 'medium') {
            chargeRoll *= 0.72;
        }
        if (Math.random() < chargeRoll) {
            return true;
        }
    }
    return false;
}

const RonkAI = {
    globalTick: 0,
    thinksThisTick: 0,
    cloneThinksThisTick: 0,

    beginFrame() {
        this.globalTick++;
        this.thinksThisTick = 0;
        this.cloneThinksThisTick = 0;
    },

    resolveOpponent(p) {
        if (!p || typeof p1 === 'undefined' || typeof p2 === 'undefined') return null;
        const base = typeof getPlayerBaseId === 'function' ? getPlayerBaseId(p.id) : String(p.id).split('_')[0];
        return base === '2' ? p1 : p2;
    },

    prepareGrid(p, opponent, gridCount) {
        const size = gridCount * gridCount;
        if (!p._occGrid || p._occGrid.length !== size) {
            p._occGrid = new Uint8Array(size);
        }
        if (p._occGridTick === this.globalTick) {
            AI_HELPERS.bindGrid(p._occGrid);
            return p._occGrid;
        }
        AI_HELPERS.fillOccupancyGrid(p._occGrid, p, opponent, gridCount);
        AI_HELPERS.bindGrid(p._occGrid);
        p._occGridTick = this.globalTick;
        return p._occGrid;
    },

    validActions(p) {
        const actions = [];
        const cur = AI_HELPERS.dirToIndex(p.dir || { x: 1, y: 0 });
        for (const pd of AI_DIRS) {
            if (!(pd.d.x === -p.dir.x && pd.d.y === -p.dir.y)) actions.push(pd.idx);
        }
        return actions.length ? actions : [cur];
    },

    floodCap(diff) {
        // Tiny floods — 520/400 vision on two Elites froze the whole UI
        if (diff.unbeatableMode) return Math.min(diff.floodDepth || 64, 64);
        if (diff.perfectReactions) return Math.min(diff.floodDepth || 80, 72);
        if (diff.eliteReactions) return Math.min(diff.floodDepth || 80, 72);
        const tier = diff.tier ?? 0;
        if (tier >= 1) return Math.min(diff.floodDepth || 80, 72);
        return Math.min(diff.floodDepth || 36, 36);
    },

    hungerState(p, diff) {
        if (p.jokerNoHunger || !(p.hungerDuration > 0)) {
            return { ratio: 0, survivalFocus: false, urgentHunger: false, panicHunger: false };
        }
        const ratio = p.hungerTimer / p.hungerDuration;
        const panicAt = diff.hungerPanicThreshold ?? 0.55;
        return {
            ratio,
            // Start caring about food early — don't wander until critical
            survivalFocus: ratio > 0.08,
            urgentHunger: ratio > Math.min(0.35, panicAt * 0.38),
            panicHunger: ratio > panicAt * 0.85
        };
    },

    safeMoves(scored, diff) {
        const minSpace = (diff && diff.unbeatableMode)
            ? Math.max(10, diff.minSafeSpace || 20)
            : 0;
        const safe = scored.filter(s => s.score > -1e9 && s.space > minSpace);
        if (safe.length) return safe;
        // Absolute last resort: any non-instant-death cell
        return scored.filter(s => s.score > -1e9 && s.space > 0);
    },

    scoreMove(p, opponent, gridCount, diff, idx, dir) {
            const nx = p.x + dir.x;
            const ny = p.y + dir.y;
        const edgeScale = (diff.edgeAwareness ?? 1) * (playstyle?.edgeHateMult ?? 1);
        const dangerScale = diff.dangerAwareness ?? 1;
        const flood = RonkAI.floodCap(diff);
        const sense = AI_HELPERS.aiResolveOpponentView(p, opponent);
        const ox = sense.x;
        const oy = sense.y;
        const oDir = sense.dir || opponent.dir || { x: 0, y: 0 };
        const sameBoardOpp = opponent && (
            sense.boardSx === (Number.isInteger(p.boardSx) ? p.boardSx : 1)
            && sense.boardSy === (Number.isInteger(p.boardSy) ? p.boardSy : 1)
        );

        if (AI_HELPERS.isOccupied(nx, ny, p, opponent, gridCount)) {
            return { idx, score: -1e10, space: 0, edge: -1 };
        }

        const eliteMove = !!(diff.unbeatableMode || diff.eliteReactions || diff.perfectReactions);
        // Elite: never step off the board by walking (hop only via dash/charge)
        if (eliteMove && (nx < 0 || nx >= gridCount || ny < 0 || ny >= gridCount)) {
            return { idx, score: -1e12, space: 0, edge: -1 };
        }
        // Elite: hard-reject walking onto death rim from inland (hop only via dash)
        if (eliteMove && !p.jokerBorderSafe) {
            const stepEdge = (nx >= 0 && nx < gridCount && ny >= 0 && ny < gridCount)
                ? AI_HELPERS.distToSectorEdge(nx, ny, gridCount)
                : -1;
            const curEdge = AI_HELPERS.distToSectorEdge(p.x, p.y, gridCount);
            if (stepEdge === 0 && curEdge >= 1) {
                return { idx, score: -1e11, space: 0, edge: stepEdge };
            }
        }

        let score = 0;
        const tierAntiLoop = !eliteMove && (diff.tier ?? 0) >= 1;
        if (eliteMove || tierAntiLoop) {
            if (p.dir && dir.x === -p.dir.x && dir.y === -p.dir.y) {
                score -= eliteMove ? 1.4e7 : 4.5e6;
            }
            const rec = p._aiRecentCells;
            if (Array.isArray(rec)) {
                let visits = 0;
                for (let i = rec.length - 1; i >= Math.max(0, rec.length - 12); i--) {
                    if (rec[i] && rec[i].x === nx && rec[i].y === ny) visits++;
                }
                const loopThreshold = eliteMove ? 2 : 1;
                if (visits >= loopThreshold) {
                    score -= visits * (eliteMove ? 5.5e6 : 1.8e6);
                }
            }
            if (eliteMove) {
                score += (Math.random() - 0.5) * 8e4;
            }
        }
        const space = AI_HELPERS.getAccessibleSpace(nx, ny, p, opponent, gridCount, flood);

        const hunger = RonkAI.hungerState(p, diff);
        const { ratio: hungerRatio, survivalFocus, urgentHunger, panicHunger } = hunger;
        // Space padding makes bots circle empty tiles instead of objectives
        const spaceWanderMul = panicHunger ? 0.08 : (urgentHunger ? 0.15 : (survivalFocus ? 0.35 : 1));
        score += space * 100 * diff.heuristicScale * spaceWanderMul;

        // Elite: hard reject tiny pockets (death traps)
        if (diff.unbeatableMode) {
            const minSp = diff.minSafeSpace || 20;
            if (space < minSp) score -= (minSp - space) * 4e6 * dangerScale;
            if (space < 10) score -= 8e8;
            if (space < 6) return { idx, score: -1e11, space, edge: AI_HELPERS.distToSectorEdge(nx, ny, gridCount) };
        }

        const boardHopsToOpp = opponent
            ? AI_HELPERS.boardHopDist(
                Number.isInteger(p.boardSx) ? p.boardSx : 1,
                Number.isInteger(p.boardSy) ? p.boardSy : 1,
                sense.boardSx,
                sense.boardSy
            )
            : 99;
        const distToOpponent = !opponent
            ? 99
            : (sameBoardOpp
                ? Math.abs(nx - ox) + Math.abs(ny - oy)
                : boardHopsToOpp * gridCount
                    + Math.min(nx, ny, gridCount - 1 - nx, gridCount - 1 - ny)
                    + Math.min(ox, oy, gridCount - 1 - ox, gridCount - 1 - oy));
        // When cloaked, soften chase / inflate survival — we're guessing
        if (!sense.seeCube) {
            score += space * 40 * (1 - sense.confidence) * diff.heuristicScale;
        }
        const ownerKeyMove = (String(p.id).split('_')[0] === '1') ? 'player' : 'enemy';
        const boardStatsMove = (typeof worldBoards !== 'undefined' && worldBoards && worldBoards.length)
            ? AI_HELPERS.boardOwnershipStats(ownerKeyMove)
            : null;
        const boardControlMode = typeof usesBoardControlMatchRules === 'function' && usesBoardControlMatchRules();
        const boardsStillOpen = boardStatsMove
            ? (boardStatsMove.unclaimed > 0 || (boardStatsMove.owned + boardStatsMove.oppOwned < boardStatsMove.total))
            : false;
        const prioritizeBoards = boardControlMode
            && !(typeof findTicTacToeWinner === 'function' && findTicTacToeWinner());
        const playstyle = getAISkillPlaystyle(p, diff);
        const threat = aiAssessEnemyThreat(p, opponent, playstyle, diff);
        // Peek a travel target early so TTT vs hunt can weigh critical lines
        let earlyTravel = (typeof worldBoards !== 'undefined' && worldBoards && worldBoards.length)
            ? AI_HELPERS.pickBoardStrategyTarget(nx, ny, ownerKeyMove, p)
            : null;
        const matchStrategy = resolveBoardVsHuntStrategy(
            p, opponent, diff, playstyle, boardStatsMove, earlyTravel, sameBoardOpp, boardHopsToOpp, threat
        );
        const aggressionMin = playstyle?.spaceAggressionMin ?? (diff.spaceAggressionMin ?? 100);
        let aggression = getPlaystyleAggression(p, diff, playstyle);
        const openPhaseMove = playstyle && isSkillOpenPhase(p, playstyle);
        const brave = aiPlaysBrave(p, playstyle);
        const spectate = aiIsSpectateMatch();
        // Laser: stay evasive — never lean into fights
        if (playstyle?.evadeEnemy || (openPhaseMove && playstyle?.avoidFightEarly && p.selectedSkill === 'laser')) {
            aggression *= diff.unbeatableMode ? 0.12 : 0.22;
        }
        // Cowards (laser / trails / invis / clones without army): soft aggression
        if (!brave && (playstyle?.playsCoward || playstyle?.forceBoardFocus
            || p.selectedSkill === 'infinite-trails' || p.selectedSkill === 'invisible'
            || p.selectedSkill === 'laser' || p.selectedSkill === 'clones')) {
            aggression *= diff.unbeatableMode ? 0.28 : 0.42;
        }
        // Clone OWNER with full army: mild pressure (not charge-level dive)
        if (brave && p.selectedSkill === 'clones' && !p.isClone) {
            aggression *= diff.unbeatableMode ? 1.2 : 1.1;
        }
        // Charge hunt kits: aggression bump from tick 0
        if (brave && (playstyle?.huntFromStart || playstyle?.preferChargePursuit)) {
            aggression *= diff.unbeatableMode ? 1.35 : 1.15;
        }
        // Clone cubes: always board workers — never pile aggression
        if (p.isClone || playstyle?.playbookId === 'spreader') {
            aggression *= 0.22;
        } else if (!brave && p.selectedSkill === 'clones') {
            aggression *= 0.55;
        }
        if (playstyle?.chaseWeightMult != null) {
            aggression *= playstyle.chaseWeightMult;
        }
        let chaseMult = playstyle?.chaseWeightMult ?? 1;
        let claimBoost = 1;
        if (prioritizeBoards || matchStrategy.preferBoardControl || (!brave && playstyle?.forceBoardFocus)) {
            const useStrategy = prioritizeBoards || diff.unbeatableMode || diff.perfectReactions || diff.eliteReactions
                || (!brave && playstyle?.forceBoardFocus);
            if (useStrategy) {
                chaseMult *= matchStrategy.chaseScale;
                claimBoost = matchStrategy.claimScale * ((!brave && playstyle?.forceBoardFocus) ? 1.25 : 1);
                if (matchStrategy.preferBoardControl || (!brave && playstyle?.forceBoardFocus)) {
                    aggression *= Math.min(1, 0.28 + matchStrategy.chaseScale);
                } else {
                    aggression *= Math.max(1, matchStrategy.chaseScale * 0.85);
                }
            } else if (prioritizeBoards) {
                aggression *= 0.3;
                chaseMult *= 0.2;
            }
        }
        if (p.infiniteChargeActive && diff.unbeatableMode && brave) {
            chaseMult *= 1.55;
            if (!survivalFocus) aggression *= 1.25;
        }
        if (spectate && diff.unbeatableMode && brave) {
            chaseMult *= 1.35;
        }
        if (playstyle?.postSkillSurvivalMult && isSkillPressureActive(p) && !p.infiniteChargeActive) {
            aggression *= playstyle.postSkillSurvivalMult;
            chaseMult *= playstyle.postSkillSurvivalMult;
        }
        const trapOpponent = playstyle?.trapOpponent ?? diff.trapOpponent;
        const huntOk = !(playstyle?.huntSameBoardOnly) || sameBoardOpp;
        let canChase = brave && huntOk && !survivalFocus && !urgentHunger && space > aggressionMin
            && (sameBoardOpp || boardHopsToOpp <= 1);
        // Laser forever dodges — never chase
        if (playstyle?.evadeEnemy || p.selectedSkill === 'laser') {
            canChase = false;
        }
        // Cowards never dive for kills
        if (!brave) {
            canChase = false;
        }
        // Infinite charge: chase as soon as space allows
        if (brave && (playstyle?.preferChargePursuit || playstyle?.huntFromStart
            || p.selectedSkill === 'infinite-charge')
            && !survivalFocus && !urgentHunger
            && huntOk && space > Math.min(aggressionMin, 8)) {
            canChase = sameBoardOpp || boardHopsToOpp <= 2;
        }
        // Brave clone OWNER: soft chase when army is stacked
        if (brave && p.selectedSkill === 'clones' && !p.isClone && !survivalFocus && huntOk && space > 35) {
            canChase = sameBoardOpp || boardHopsToOpp <= 1;
        }
        // Elite: never chase into a death pocket
        if (diff.unbeatableMode && canChase && space < Math.max(22, (diff.minSafeSpace || 14) + 8)) {
            canChase = false;
        }
        if (threat.level === 'none' && diff.unbeatableMode) {
            canChase = false;
            claimBoost *= 1.6;
        }
        if (threat.level === 'high' && brave && canChase) {
            chaseMult *= 1.5;
        }
        if (spectate && diff.unbeatableMode && brave && threat.level === 'high'
            && !survivalFocus && !urgentHunger && huntOk && space > 20) {
            if (boardHopsToOpp <= 2) canChase = true;
        }

        // Clone cubes: hard survival + leave fights, stick to mission boards
        if (p.isClone) {
            canChase = false;
            score += space * (diff.unbeatableMode ? 260 : 160) * diff.heuristicScale * spaceWanderMul;
            if (sameBoardOpp && distToOpponent < 16) {
                score += distToOpponent * (diff.unbeatableMode ? 32 : 18) * diff.heuristicScale;
            }
        }

        // Laser: reward distance + open space (keep kiting)
        if (playstyle?.evadeEnemy || p.selectedSkill === 'laser') {
            score += distToOpponent * (diff.unbeatableMode ? 22 : 14) * diff.heuristicScale;
            score += space * (diff.unbeatableMode ? 180 : 110) * diff.heuristicScale * spaceWanderMul;
        }

        // Cowards: hard survival — space + leave fights
        if (!brave) {
            score += space * (diff.unbeatableMode ? 220 : 140) * (playstyle?.survivalBias || 1.8)
                * diff.heuristicScale * spaceWanderMul;
            if (sameBoardOpp && distToOpponent < 14) {
                score += distToOpponent * (diff.unbeatableMode ? 28 : 16) * diff.heuristicScale;
            }
        }

        // Extra opponent BFS used to run here (jail / space-pressure). One flood
        // per candidate move is enough — extra searches froze the UI.

        if (playstyle?.survivalBias && (isSkillPressureActive(p) || !brave)) {
            score += space * 45 * playstyle.survivalBias * diff.heuristicScale;
        }

        // Invincible infinite-charge: align with sensed/estimated enemy and charge toward them
        if (diff.unbeatableMode && brave && (playstyle?.preferChargePursuit || p.selectedSkill === 'infinite-charge'
            || (playstyle?.invincibleRisk === 'high' && p.selectedSkill === 'infinite-charge'))) {
            const alignY = ny === oy && Math.sign(ox - nx) === Math.sign(dir.x);
            const alignX = nx === ox && Math.sign(oy - ny) === Math.sign(dir.y);
            if (alignY || alignX) {
                score -= distToOpponent * 42 * aggression * chaseMult * sense.confidence;
            } else if (nx === ox || ny === oy) {
                score -= distToOpponent * 22 * aggression * sense.confidence;
            } else {
                const rowClose = Math.abs(ny - oy);
                const colClose = Math.abs(nx - ox);
                score -= Math.min(rowClose, colClose) * 18 * aggression * sense.confidence;
            }
        }

        if ((canChase || p.isImmune) && !urgentHunger) {
            const chaseWeight = diff.unbeatableMode ? 7.5 : (diff.perfectReactions ? 5.5 : (diff.eliteReactions ? 4.2 : 2.5));
            const chaseScale = survivalFocus ? 0.05 : 1;
            score -= distToOpponent * chaseWeight * aggression * chaseScale * chaseMult * sense.confidence;

            if (canChase && trapOpponent && space > 50) {
                const trapPull = playstyle?.spacePressureMult ? 24 : (diff.unbeatableMode ? 18 : 8);
                score -= distToOpponent * trapPull * aggression * (playstyle?.trapOpponent ? 1.2 : 1);
            }
             } else {
            score += distToOpponent * (urgentHunger ? 18 : 12);
            score += space * (playstyle?.survivalBias ? 150 : 120) * diff.heuristicScale;
             }
             
             const distToEdge = AI_HELPERS.distToSectorEdge(nx, ny, gridCount);
        const ownerKeyEdge = (String(p.id).split('_')[0] === '1') ? 'player' : 'enemy';
        let travelTarget = (typeof worldBoards !== 'undefined' && worldBoards && worldBoards.length)
            ? (earlyTravel || AI_HELPERS.pickBoardStrategyTarget(nx, ny, ownerKeyEdge, p))
            : null;
        // Infinite Trails: race virgin boards for first-CP locks before finishing local 2nd/3rd
        if ((playstyle?.lockFirstCpPerBoard || p.selectedSkill === 'infinite-trails')
            && !survivalFocus && !urgentHunger && !panicHunger) {
            const lockTravel = AI_HELPERS.pickTrailLockTarget(nx, ny, ownerKeyEdge, p);
            if (lockTravel && lockTravel.oursOnBoard === 0
                && (!travelTarget || travelTarget.hops === 0 || lockTravel.hops > 0)) {
                travelTarget = lockTravel;
            }
        }
        // After camping / finishing local work, steer toward another board even if local CPs remain
        // Skip forced explore while hungry — go eat first
        const forceExploreEarly = !survivalFocus && !urgentHunger && !panicHunger
            && aiShouldForceBoardExplore(p, playstyle, ownerKeyEdge, opponent, diff);
        if (typeof worldBoards !== 'undefined' && worldBoards?.length
            && forceExploreEarly
            && (!travelTarget || travelTarget.hops === 0)) {
            const psx0 = Number.isInteger(p.boardSx) ? p.boardSx : 1;
            const psy0 = Number.isInteger(p.boardSy) ? p.boardSy : 1;
            const explore = AI_HELPERS.pickBoardStrategyTarget(
                nx, ny, ownerKeyEdge, p, {
                    excludeKeys: new Set([`${psx0}_${psy0}`]),
                    preferOffBoard: true
                }
            );
            if (explore && explore.hops > 0) travelTarget = explore;
        }
        // Hungry: chase the apple board instead of random board racing
        const appleTargetMove = (survivalFocus || urgentHunger || panicHunger)
            ? AI_HELPERS.nearestAppleTarget(nx, ny, p)
            : null;
        if (appleTargetMove && appleTargetMove.hops > 0
            && (!travelTarget || travelTarget.hops === 0
                || (urgentHunger || panicHunger)
                || appleTargetMove.dist < (travelTarget.dist || 999))) {
            travelTarget = {
                sx: appleTargetMove.sx,
                sy: appleTargetMove.sy,
                hops: appleTargetMove.hops,
                dist: appleTargetMove.dist,
                priority: panicHunger ? 12000 : 8000,
                appleHunt: true
            };
        }
        // Prefer strategy hops (not raw cp dist): when bots reach the hop rim, cp dist
        // falls to ~gridCount and the old `farCp > gridCount` gate flipped lethal edge
        // penalties back on — exactly when a travel dash is needed.
        const wantsBoardTravel = !!(travelTarget && travelTarget.hops > 0);
        let onTravelEdge = false;
        if (wantsBoardTravel) {
            const needDx = AI_HELPERS.signedBoardDelta(
                Number.isInteger(p.boardSx) ? p.boardSx : 1, travelTarget.sx
            );
            const needDy = AI_HELPERS.signedBoardDelta(
                Number.isInteger(p.boardSy) ? p.boardSy : 1, travelTarget.sy
            );
            onTravelEdge =
                (needDx < 0 && nx <= 1) ||
                (needDx > 0 && nx >= gridCount - 2) ||
                (needDy < 0 && ny <= 1) ||
                (needDy > 0 && ny >= gridCount - 2);
        }
        const chaseOffBoard = !!(opponent && !sameBoardOpp && boardHopsToOpp >= 1 && boardHopsToOpp <= 2)
            && !(matchStrategy.preferBoardControl && (diff.unbeatableMode || prioritizeBoards));
        if (wantsBoardTravel && onTravelEdge) {
            // Standing on the exit rim is desirable — only a tiny residual cost
            if (distToEdge === 0) score -= 400 * edgeScale;
            else if (distToEdge === 1) score -= 150 * edgeScale;
        } else if (diff.unbeatableMode && (wantsBoardTravel || chaseOffBoard) && !onTravelEdge) {
            // Elite bugfix: "traveling" used to nearly erase rim cost → edge suicides.
            // Wrong rim / inland approach still pays full inland death tax.
            if (distToEdge === 0) score -= 1e12 * edgeScale;
            else if (distToEdge === 1) score -= 5e10 * edgeScale;
            else if (distToEdge === 2) score -= 8e8 * edgeScale;
            else if (distToEdge === 3) score -= 2e7 * edgeScale;
            if (distToEdge >= 4) score += distToEdge * (diff.unbeatableMode ? 1.4e5 : 8e4) * edgeScale;
            if (chaseOffBoard && opponent && !wantsBoardTravel) {
                const odx = AI_HELPERS.signedBoardDelta(
                    Number.isInteger(p.boardSx) ? p.boardSx : 1,
                    Number.isInteger(opponent.boardSx) ? opponent.boardSx : 1
                );
                const ody = AI_HELPERS.signedBoardDelta(
                    Number.isInteger(p.boardSy) ? p.boardSy : 1,
                    Number.isInteger(opponent.boardSy) ? opponent.boardSy : 1
                );
                // Only reward the *correct* approach corridor, and only inland of the death cell
                if (odx < 0 && nx <= 3 && nx >= 2) score += 18000;
                if (odx > 0 && nx >= gridCount - 4 && nx <= gridCount - 3) score += 18000;
                if (ody < 0 && ny <= 3 && ny >= 2) score += 18000;
                if (ody > 0 && ny >= gridCount - 4 && ny <= gridCount - 3) score += 18000;
            }
        } else if (wantsBoardTravel && onTravelEdge === false && distToEdge <= 1) {
            // Wrong rim while trying to leave — avoid, but don't treat as suicide
            if (distToEdge === 0) score -= 14000 * edgeScale;
            else score -= 6000 * edgeScale;
        } else if (wantsBoardTravel || chaseOffBoard) {
            // Traveling / chasing across boards but still inland — mild edge caution only
            if (distToEdge === 0) score -= 6000 * edgeScale;
            else if (distToEdge === 1) score -= 2500 * edgeScale;
            else if (distToEdge === 2) score -= 900 * edgeScale;
            // Prefer the rim facing the opponent when chasing off-board
            if (chaseOffBoard && opponent && !wantsBoardTravel) {
                const odx = AI_HELPERS.signedBoardDelta(
                    Number.isInteger(p.boardSx) ? p.boardSx : 1,
                    Number.isInteger(opponent.boardSx) ? opponent.boardSx : 1
                );
                const ody = AI_HELPERS.signedBoardDelta(
                    Number.isInteger(p.boardSy) ? p.boardSy : 1,
                    Number.isInteger(opponent.boardSy) ? opponent.boardSy : 1
                );
                if (odx < 0 && nx <= 1) score += 28000;
                if (odx > 0 && nx >= gridCount - 2) score += 28000;
                if (ody < 0 && ny <= 1) score += 28000;
                if (ody > 0 && ny >= gridCount - 2) score += 28000;
            }
        } else {
            if (distToEdge === 0) score -= (diff.unbeatableMode ? 1e12 : 50000) * edgeScale;
            else if (distToEdge === 1) score -= (diff.unbeatableMode ? 5e10 : 20000) * edgeScale;
            else if (distToEdge === 2) score -= (diff.unbeatableMode ? 8e8 : 8000) * edgeScale;
            else if (diff.unbeatableMode && distToEdge === 3) score -= 2e7 * edgeScale;
            // Elite: reward walking inland
            if (diff.unbeatableMode && distToEdge >= 4) {
                score += distToEdge * 8e4 * edgeScale;
            }
        }

        // Elite / inland kits: never camp the death rim unless intentionally boarding / apple-hopping
        const appleHunting = !!(travelTarget && travelTarget.appleHunt);
        if ((diff.unbeatableMode || playstyle?.preferInland)
            && !wantsBoardTravel && !chaseOffBoard && !appleHunting
            && !(survivalFocus && appleTargetMove)) {
            if (distToEdge <= 1) score -= (diff.unbeatableMode ? 1e11 : 9e5) * edgeScale;
            if (distToEdge === 0) score -= (diff.unbeatableMode ? 1e12 : 2e6) * edgeScale;
            if (distToEdge <= 3) {
                const inlandX = Math.abs((gridCount - 1) / 2 - nx);
                const inlandY = Math.abs((gridCount - 1) / 2 - ny);
                score -= (inlandX + inlandY) * (diff.unbeatableMode ? 4200 : 400);
                // Prefer increasing edge distance
                const curE = AI_HELPERS.distToSectorEdge(p.x, p.y, gridCount);
                if (distToEdge > curE) score += (distToEdge - curE) * (diff.unbeatableMode ? 6e6 : 2e4);
            }
        } else if ((diff.unbeatableMode || playstyle?.preferInland) && (wantsBoardTravel || chaseOffBoard || appleHunting)) {
            if (distToEdge === 0 && !onTravelEdge) score -= 1e11 * edgeScale;
            if (diff.unbeatableMode && distToEdge === 0 && onTravelEdge && !p.jokerBorderSafe) {
                score -= 5e4; // mild — still allow the hop setup
            }
        }

             const inLineX = nx === ox;
             const inLineY = ny === oy;
             const inPathX = inLineX && Math.sign(ny - oy) === Math.sign(oDir.y || 0);
             const inPathY = inLineY && Math.sign(nx - ox) === Math.sign(oDir.x || 0);

        if (inPathX || inPathY || opponent.isCharging || opponent.infiniteChargeActive) {
            const pressAttack = p.infiniteChargeActive && diff.unbeatableMode && canChase && distToOpponent < 70;
            if (pressAttack) {
                score -= distToOpponent * 14 * aggression * chaseMult;
            } else {
            const dangerMult = (opponent.isCharging || opponent.infiniteChargeActive) ? 10 : 2;
            score -= 1e7 * dangerMult * dangerScale * (sense.seeCube ? 1 : 0.45);
            const perpendicular = (inLineY && dir.y !== 0) || (inLineX && dir.x !== 0);
            if (perpendicular) score += 8e6 * dangerMult * dangerScale;
            }
        }

        // Only dodge trails the AI can actually sense
        if (!p.isImmune && sense.seeTrail && opponent.trail?.length) {
            for (const trailPos of opponent.trail) {
                if (trailPos.x === nx && trailPos.y === ny) {
                    score -= 1e8 * dangerScale;
                }
            }
        } else if (canChase && (diff.eliteReactions || diff.perfectReactions || diff.unbeatableMode)
            && (Math.abs(nx - ox) < 12 || Math.abs(ny - oy) < 12)) {
            score += (diff.unbeatableMode ? 180000 : 80000) * (diff.aggression ?? 0.5) * sense.confidence;
        }

             if (typeof laserLines !== 'undefined' && !p.isImmune) {
                 for (const laser of laserLines) {
                if (typeof isEnemyLaserLethalTo === 'function') {
                    if (!isEnemyLaserLethalTo(laser, p)) continue;
                } else if (typeof isFriendlyLaserOwner === 'function'
                    ? isFriendlyLaserOwner(laser, p)
                    : (laser.owner === p || AI_HELPERS.aiSameArmy(laser.owner, p))) {
                    continue;
                }
                if (Number.isInteger(laser.boardSx) && Number.isInteger(laser.boardSy)) {
                    if (p.boardSx !== laser.boardSx || p.boardSy !== laser.boardSy) continue;
                } else {
                    continue;
                }
                const warnTicks = laser.warningTicks || Math.round((typeof TICK_RATE !== 'undefined' ? TICK_RATE : 13.5) * 0.5);
                const inWarning = (laser.ticks || 0) < warnTicks;
                const pos = Math.floor(Number(laser.pos));
                const onLaser = (laser.isHorizontal && ny === pos) || (!laser.isHorizontal && nx === pos);
                if (onLaser) {
                    const urgency = inWarning ? Math.max(0.35, 1 - (laser.ticks / warnTicks)) : 1;
                    score -= (inWarning ? 2e8 : 1e9) * urgency * dangerScale;
                    const escape = (laser.isHorizontal && dir.y !== 0) || (!laser.isHorizontal && dir.x !== 0);
                    if (escape) score += (inWarning ? 1.2e8 : 6e7) * dangerScale;
                } else if (inWarning) {
                    // Steer off the row/col one cell before the beam solidifies
                    const nearRow = laser.isHorizontal && Math.abs(ny - pos) === 1;
                    const nearCol = !laser.isHorizontal && Math.abs(nx - pos) === 1;
                    if (nearRow || nearCol) score -= 3.5e7 * dangerScale;
                }
            }
        }

        if (!p.jokerNoHunger && p.hungerDuration > 0) {
            const appleDist = AI_HELPERS.nearestAppleDist(nx, ny, p);
            const seek = (diff.hungerSeek ?? 0.75) * (diff.unbeatableMode ? 1.55 : 1.2);

            if (appleDist !== null && hungerRatio > 0.04) {
                let seekMult = 2.2;
                if (panicHunger) seekMult = 18;
                else if (urgentHunger) seekMult = 10;
                else if (survivalFocus) seekMult = 5.5;
                // Hard pull toward apples — overrides idle space-wandering
                score -= appleDist * 4200 * seek * seekMult;
                if (appleDist === 0) score += 2.5e6 * seekMult;
                if (appleDist <= 2) score += (3 - appleDist) * 4.5e5 * seekMult;
                if (appleDist <= 6) score += (7 - appleDist) * 8e4 * seekMult;
            }

            // When hungry, stop padding score with "more empty space" (causes circling)
            if (survivalFocus && !urgentHunger && !panicHunger) {
                score += space * 40 * hungerRatio * seek;
            }

            if (urgentHunger || panicHunger) {
                score += distToOpponent * (panicHunger ? 28 : 16);
                // Crush chase / roam incentives while starving
                if (canChase) score += distToOpponent * 40;
            }
        }

        // Soft checkpoint seeking — tic-tac-toe board strategy across 9 boards
        if (typeof worldBoards !== 'undefined' && worldBoards && worldBoards.length) {
            const ownerKey = ownerKeyMove;
            const target = travelTarget || AI_HELPERS.pickBoardStrategyTarget(nx, ny, ownerKey, p);
            const cpDist = target ? target.dist : null;
            const boardStats = boardStatsMove || AI_HELPERS.boardOwnershipStats(ownerKey);
            const claimW = (playstyle?.claimWeight ?? 1) * claimBoost;
            const raceW = (playstyle?.boardRace ?? 1) * (matchStrategy.preferBoardControl ? Math.max(1, claimBoost * 0.85) : 1);
            const dwellLimit = playstyle?.boardDwellTicks ?? 160;
            const dwellTicks = p._aiBoardDwellTicks || 0;
            const forceExplore = forceExploreEarly
                || aiShouldForceBoardExplore(p, playstyle, ownerKey, opponent, diff);
            const dwellTravelBoost = (forceExplore && target && target.hops > 0)
                ? (1.55 + Math.min(1.85, Math.max(0, dwellTicks - Math.floor(dwellLimit * 0.45))
                    / Math.max(1, dwellLimit * 0.55)))
                    * (diff.unbeatableMode || (playstyle?.boardRace || 0) >= 3 ? 1.55 : 1)
                : 1;
            // Hungry bots: damp board racing slightly so apples win, unless panic is over
            const hungerBoardDamp = (urgentHunger || panicHunger) ? 0.35 : (survivalFocus ? 0.7 : 1);
            const boardWinBoost = (1 + (boardStats.owned / Math.max(1, boardStats.total)) * 0.9)
                * (prioritizeBoards || matchStrategy.preferBoardControl ? 1.85 : 1)
                * claimW * raceW * dwellTravelBoost * hungerBoardDamp;
            const defendBoost = boardStats.oppOwned >= boardStats.total - 2 ? 1.45 : 1;
            const cpWeight = ((prioritizeBoards || matchStrategy.preferBoardControl || playstyle?.forceBoardFocus) ? 2.1 : 1.25)
                * claimW * (diff.unbeatableMode ? 1.35 : 1);
            const tttBoost = target && target.priority >= 9000 ? 2.2 : (target && target.priority >= 2800 ? 1.55 : 1);
            // Clones with a mission: even hungrier for their assigned board
            const missionBoost = (p.isClone && Number.isInteger(p._missionSx)
                && target && target.sx === p._missionSx && target.sy === p._missionSy) ? 1.6 : 1;
            const appleDistCp = (!p.jokerNoHunger && p.hungerDuration > 0)
                ? AI_HELPERS.nearestAppleDist(nx, ny, p)
                : null;
            if (cpDist !== null && !(panicHunger && appleDistCp != null && appleDistCp < 12)) {
                // Strong checkpoint magnet — stop random mid-board loops
                score -= cpDist * 1600 * boardWinBoost * defendBoost * cpWeight * tttBoost * missionBoost;
                if (cpDist === 0) score += 1.2e6 * cpWeight * tttBoost * missionBoost;
                else if (cpDist <= 3) score += (4 - cpDist) * 1.1e5 * cpWeight * tttBoost * missionBoost;
                else if (cpDist <= 8) score += (9 - cpDist) * 2.2e4 * cpWeight * missionBoost;
                // Same-board unfinished work: commit hard
                if (target.hops === 0 && cpDist > 0 && cpDist <= 14) {
                    score -= cpDist * 2200 * cpWeight;
                }
            }
            // Steer toward the edge that faces the strategic target board
            if (target && target.hops > 0) {
                const needDx = AI_HELPERS.signedBoardDelta(
                    Number.isInteger(p.boardSx) ? p.boardSx : 1, target.sx
                );
                const needDy = AI_HELPERS.signedBoardDelta(
                    Number.isInteger(p.boardSy) ? p.boardSy : 1, target.sy
                );
                // Clones still on a non-mission board: hard rim magnet so they peel off ASAP
                const cloneLeavingHome = !!(p.isClone && Number.isInteger(p._missionSx)
                    && (p.boardSx !== p._missionSx || p.boardSy !== p._missionSy));
                const rimSafe = AI_HELPERS.distToSectorEdge(nx, ny, gridCount) >= 1 || p.jokerBorderSafe;
                const edgePush = (p.isClone
                    ? (cloneLeavingHome ? 125000 : 42000)
                    : 78000) * tttBoost * raceW * missionBoost * dwellTravelBoost;
                if (rimSafe) {
                    if (needDx < 0 && nx <= 1) score += edgePush;
                    if (needDx > 0 && nx >= gridCount - 2) score += edgePush;
                    if (needDy < 0 && ny <= 1) score += edgePush;
                    if (needDy > 0 && ny >= gridCount - 2) score += edgePush;
                }
                // Prefer walking toward that edge (stronger when intentionally boarding)
                const walkW = (p.isClone
                    ? (cloneLeavingHome ? 520 : 180)
                    : 320) * raceW * dwellTravelBoost
                    * ((prioritizeBoards || matchStrategy.preferBoardControl || playstyle?.forceBoardFocus) ? 1.45 : 1);
                if (needDx < 0) score -= nx * walkW;
                if (needDx > 0) score += nx * walkW;
                if (needDy < 0) score -= ny * walkW;
                if (needDy > 0) score += ny * walkW;
                // Extra pull onto the exit rim cells
                if (onTravelEdge || (
                    (needDx < 0 && nx <= 2) || (needDx > 0 && nx >= gridCount - 3)
                    || (needDy < 0 && ny <= 2) || (needDy > 0 && ny >= gridCount - 3)
                )) {
                    score += 36000 * raceW * dwellTravelBoost;
                }
            }
            // Prefer finishing a board that already has 2 of our CPs
            const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
            const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
            for (let bi = 0; bi < worldBoards.length; bi++) {
                const board = worldBoards[bi];
                if (!board || board.owner) continue;
                const ours = (board.checkpoints || []).filter(c => c.owner === ownerKey).length;
                const missing = (board.checkpoints || []).filter(c => c.owner !== ownerKey);
                if (ours >= 2 && missing.length) {
                    const t = missing[0];
                    const hops = AI_HELPERS.boardHopDist(psx, psy, board.sx, board.sy);
                    const d = hops === 0
                        ? Math.abs(t.x - nx) + Math.abs(t.y - ny)
                        : hops * gridCount + AI_HELPERS.distToSectorEdge(nx, ny, gridCount);
                    score -= d * 1400 * claimW;
                    if (d === 0) score += 500000 * claimW;
                }
            }

            // Infinite Trails: lock FIRST CP on each board, then paint cages around the rest
            if (playstyle?.lockFirstCpPerBoard || p.selectedSkill === 'infinite-trails') {
                const lockT = AI_HELPERS.pickTrailLockTarget(nx, ny, ownerKey, p);
                if (lockT) {
                    const lockW = (diff.unbeatableMode ? 2.4 : 1.7) * claimW;
                    score -= lockT.dist * 2800 * lockW;
                    if (lockT.dist === 0) score += 2.2e6 * lockW;
                    else if (lockT.dist <= 3) score += (4 - lockT.dist) * 2.2e5 * lockW;
                    // Prefer virgin boards (oursOnBoard === 0) over finishing local 2nd/3rd early
                    if (lockT.oursOnBoard === 0) score += 4.5e5 * lockW;
                    if (lockT.hops > 0) {
                        const needDx = AI_HELPERS.signedBoardDelta(psx, lockT.sx);
                        const needDy = AI_HELPERS.signedBoardDelta(psy, lockT.sy);
                        if (needDx < 0) score -= nx * 280;
                        if (needDx > 0) score += nx * 280;
                        if (needDy < 0) score -= ny * 280;
                        if (needDy > 0) score += ny * 280;
                    }
                }
                // Paint forever trail adjacent to unclaimed CPs on THIS board (walker jail)
                if (playstyle?.paintCpCage || p.selectedSkill === 'infinite-trails') {
                    const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
                    const here = worldBoards[psy * n + psx];
                    if (here && !here.owner && here.checkpoints) {
                        const oursHere = AI_HELPERS.boardOursCpCount(here, ownerKey);
                        for (let ci = 0; ci < here.checkpoints.length; ci++) {
                            const cp = here.checkpoints[ci];
                            if (!cp || cp.owner === ownerKey) continue;
                            const manh = Math.abs(cp.x - nx) + Math.abs(cp.y - ny);
                            // Stand on CP to claim; then hug neighbors to cage it
                            if (manh === 0) score += 1.8e6 * claimW;
                            else if (manh === 1) {
                                // Cage bonus stronger after we already locked one here
                                score += (oursHere >= 1 ? 3.2e5 : 1.1e5) * claimW;
                            } else if (manh === 2 && oursHere >= 1) {
                                score += 6e4 * claimW;
                            }
                        }
                    }
                }
            }
        }

        // Charge kits: line up on a CP even through trail cages (cube claims, trail ignored while charging)
        if ((brave || playstyle?.preferChargePursuit || p.selectedSkill === 'infinite-charge'
            || AI_HELPERS.opponentHasInfiniteTrails(opponent))
            && !urgentHunger && !panicHunger) {
            const n = (typeof BOARDS_PER_SIDE === 'number') ? BOARDS_PER_SIDE : 3;
            const psxC = Number.isInteger(p.boardSx) ? p.boardSx : 1;
            const psyC = Number.isInteger(p.boardSy) ? p.boardSy : 1;
            const boardC = (typeof worldBoards !== 'undefined' && worldBoards?.length)
                ? worldBoards[psyC * n + psxC]
                : null;
            if (boardC && !boardC.owner && boardC.checkpoints) {
                const leap = Math.floor((p.infiniteChargeActive ? 8.5 : 6.5) + (p.jokerChargeBonus || 0));
                for (let ci = 0; ci < boardC.checkpoints.length; ci++) {
                    const cp = boardC.checkpoints[ci];
                    if (!cp || cp.owner === ownerKeyMove) continue;
                    const onRow = ny === cp.y;
                    const onCol = nx === cp.x;
                    const gap = onRow ? Math.abs(cp.x - nx) : (onCol ? Math.abs(cp.y - ny) : 99);
                    if ((onRow || onCol) && gap <= leap + 2) {
                        score += (leap + 3 - gap) * 9e4 * (diff.unbeatableMode ? 1.6 : 1);
                        // Prefer facing the CP for an immediate pierce charge
                        if (onRow && Math.sign(dir.x) === Math.sign(cp.x - nx) && dir.x) score += 2.8e5;
                        if (onCol && Math.sign(dir.y) === Math.sign(cp.y - ny) && dir.y) score += 2.8e5;
                    }
                }
            }
        }

        return { idx, score, space, edge: distToEdge };
    },

    pickMove(p, opponent, gridCount, diff, validActions) {
        const scored = validActions.map(idx =>
            RonkAI.scoreMove(p, opponent, gridCount, diff, idx, AI_HELPERS.indexToDir(idx))
        );
        scored.sort((a, b) => b.score - a.score);
        let safe = RonkAI.safeMoves(scored, diff);
        // Elite: strip rim/pocket suicides before brain/heuristic choose
        if (isEliteAi(p, diff)) {
            safe = eliteSurvivalMoves(p, opponent, gridCount, diff, safe);
        }
        let best = safe[0] || scored[0];
        if (!best) return validActions[0];

        const hunger = RonkAI.hungerState(p, diff);

        // Objective lock: don't "roomiest" wander when hungry or a CP/apple is close
        const appleNow = (!p.jokerNoHunger && p.hungerDuration > 0)
            ? AI_HELPERS.nearestAppleDist(p.x, p.y, p)
            : null;
        const ownerKeyPick = (String(p.id).split('_')[0] === '1') ? 'player' : 'enemy';
        const cpNow = (typeof worldBoards !== 'undefined' && worldBoards?.length)
            ? AI_HELPERS.pickBoardStrategyTarget(p.x, p.y, ownerKeyPick, p)
            : null;
        const objectiveLock = hunger.survivalFocus
            || hunger.urgentHunger
            || hunger.panicHunger
            || (appleNow != null && appleNow <= 10)
            || (cpNow && cpNow.dist != null && cpNow.dist <= 10 && cpNow.hops === 0);

        // Elite (any Elite bot): trained brain first, heuristics as safety net only
        const eliteBot = isEliteAi(p, diff);
        if (eliteBot && safe.length > 0) {
            if (typeof EliteBrain !== 'undefined') {
                try {
                    if (typeof EliteBrain.ensureReady === 'function') EliteBrain.ensureReady();
                    if (EliteBrain.ready && EliteBrain.ready()) {
                        const pool = safe.map(s => s.idx);
                        const nn = EliteBrain.pickEliteSafeMove(
                            p, opponent, gridCount, diff, pool, safe[0].idx
                        );
                        if (Number.isInteger(nn)) {
                            const brainPick = safe.find(s => s.idx === nn);
                            if (brainPick) return brainPick.idx;
                        }
                    }
                } catch (_) { /* fall through to heuristic Elite sort */ }
            }

            if (safe.length > 1) {
                const goal = aiWinGoal(p, opponent, getAISkillPlaystyle(p, diff));
                const topScore = best.score;
                const near = safe.filter(s => s.score >= topScore * 0.92);
                near.sort((a, b) => {
                    const ae = a.edge != null ? a.edge : 0;
                    const be = b.edge != null ? b.edge : 0;
                    if (objectiveLock || goal) {
                        return (b.score - a.score) || (b.space - a.space) || (be - ae);
                    }
                    return (b.space - a.space) || (be - ae) || (b.score - a.score);
                });
                best = near[0] || best;
            }
            return best.idx;
        }

        const mistakePool = safe.length > 1 ? safe : scored.filter(s => s.score > -1e9);
        // Elite / invincible: brain + heuristics only — no random throw picks
        if (!diff.unbeatableMode && diff.mistakeChance > 0 && mistakePool.length > 1 && !hunger.urgentHunger) {
            if (Math.random() < diff.mistakeChance) {
                const depth = Math.min(mistakePool.length - 1, diff.mistakeDepth || 2);
                return mistakePool[1 + Math.floor(Math.random() * depth)].idx;
            }
        }
        if (!diff.unbeatableMode && diff.wrongTurnChance > 0 && !hunger.survivalFocus && Math.random() < diff.wrongTurnChance) {
            const alt = mistakePool
                .map(s => s.idx)
                .filter(i => i !== AI_HELPERS.dirToIndex(p.dir));
            if (alt.length) return alt[Math.floor(Math.random() * alt.length)];
        }
        if (!diff.unbeatableMode && diff.hesitationChance > 0 && !hunger.urgentHunger && Math.random() < diff.hesitationChance) {
            const hold = mistakePool.find(s => s.idx === AI_HELPERS.dirToIndex(p.dir));
            if (hold && hold.score > -1e9) return hold.idx;
        }

        return best.idx;
    },

    useAbilities(p, opponent, gridCount, diff) {
        const nextX = p.x + (p.dir?.x || 0);
        const nextY = p.y + (p.dir?.y || 0);
        const space = AI_HELPERS.getAccessibleSpace(
            nextX, nextY, p, opponent, gridCount, Math.min(48, RonkAI.floodCap(diff) * 0.75)
        );
        const sense = AI_HELPERS.aiResolveOpponentView(p, opponent);
        const ox = sense.x;
        const oy = sense.y;
        const oDir = sense.dir || { x: 0, y: 0 };
        const inLineX = p.x === ox;
        const inLineY = p.y === oy;
        const dist = Math.abs(p.x - ox) + Math.abs(p.y - oy);
        const elite = diff.eliteReactions || diff.perfectReactions || diff.unbeatableMode;

        const facingUs = (inLineY && Math.sign(p.x - ox) === Math.sign(oDir.x || 0)) ||
            (inLineX && Math.sign(p.y - oy) === Math.sign(oDir.y || 0));
        const chargeThreat = (opponent.isCharging || opponent.infiniteChargeActive) && facingUs && sense.seeCube;
        const playstyle = getAISkillPlaystyle(p, diff);
        const brave = aiPlaysBrave(p, playstyle);
        const threat = aiAssessEnemyThreat(p, opponent, playstyle, diff);
        const spectate = aiIsSpectateMatch();
        const edgeNow = AI_HELPERS.distToSectorEdge(p.x, p.y, gridCount);
        const dodgeRange = (diff.dodgeRange ?? 15)
            + (p.hasExtraLife && !p.usedExtraLife ? 18 : 0)
            + ((playstyle?.evadeEnemy || playstyle?.kiteDash) ? 16 : 0)
            + (diff.unbeatableMode ? 24 : 0);
        const spacePanic = (diff.unbeatableMode ? 72 : elite ? 40 : 35) + (p.jokerBorderSafe ? 12 : 0);

        // Escape / combat dashes — real threats / kill setups only
        let shouldDash = false;
        let speedDash = false;
        const sameBoardOpp = !!(opponent && sense.boardSx === (p.boardSx ?? 1)
            && sense.boardSy === (p.boardSy ?? 1));
        const lethalFacing = chargeThreat && dist < Math.min(dodgeRange, 18);
        const pocketDeath = space < (diff.unbeatableMode ? 18 : 8) && edgeNow >= 4;
        if (edgeNow >= 4) {
            if (lethalFacing) shouldDash = true;
            else if (pocketDeath) shouldDash = true;
            else if (brave && sameBoardOpp && facingUs && dist <= 5 && space > 30) {
                shouldDash = true;
            }
        }

        // Win-mobility: dash ONLY if it advances a real goal (CP / board / kill / real kite).
        // No random spam — elite never oscillates the same tiles.
        const hasDashCd = !!(p.jokerDashNoCooldown || playerHasJoker(p, 'dash-cooldown'));
        const hasRage = !!(p.jokerCooldownReduce < 1 || playerHasJoker(p, 'rage-joker'));
        const hasDouble = !!(p.jokerDoubleEffective || playerHasJoker(p, 'double-effective'));
        const winMobility = !!(playstyle?.kiteDash || playstyle?.winSpeedDash || playstyle?.evadeEnemy
            || hasDashCd || hasRage || (hasDouble && (hasDashCd || hasRage))
            || (brave && (diff.unbeatableMode || elite)));
        const ticksSinceDash = (p.aiAbilityTicks || 0) - (p._aiLastNonTravelDashTick ?? -999);
        const dashGapNeed = (lethalFacing || pocketDeath)
            ? 2
            : (spectate && diff.unbeatableMode && brave && threat.level === 'high' && sameBoardOpp)
                ? Math.max(2, diff.unbeatableMode ? 8 : 6)
            : hasDashCd
                ? (diff.unbeatableMode ? 10 : 6)
                : (diff.unbeatableMode ? 16 : 10);
        const winGoal = aiWinGoal(p, opponent, playstyle);
        if (!shouldDash && winMobility && edgeNow >= 4 && ticksSinceDash >= dashGapNeed && winGoal) {
            const towardCp = winGoal.kind === 'cp' && winGoal.hops === 0
                && winGoal.dist > 3 && winGoal.dist <= 14;
            const towardBoard = winGoal.hops > 0 && winGoal.dist > 2;
            const towardApple = winGoal.kind === 'apple' && winGoal.dist > 3;
            const kiteAway = (playstyle?.kiteDash || playstyle?.evadeEnemy)
                && sameBoardOpp && sense.seeCube
                && (lethalFacing || (dist < 14 && facingUs));
            const chaseKill = brave && winGoal.kind === 'kill' && sameBoardOpp
                && dist >= 6 && dist <= 16 && space > 28;
            if (towardCp || towardBoard || towardApple || kiteAway || chaseKill) {
                // Preview: only commit if SOME inland dash direction advances the goal
                const previewDirs = AI_DIRS.map(d => d.d).filter(d =>
                    aiEliteDashDirSafe(p, d, gridCount, false, opponent)
                    && aiDashAdvancesGoal(p, d, gridCount, winGoal, false)
                    && !aiDashIsOscillation(p, p.x + d.x * 4, p.y + d.y * 4)
                );
                if (previewDirs.length) {
                    shouldDash = true;
                    speedDash = true;
                    // Face the best progress dir
                    let bestD = previewDirs[0];
                    let bestProg = Infinity;
                    for (const d of previewDirs) {
                        const lx = p.x + d.x * 4;
                        const ly = p.y + d.y * 4;
                        const prog = aiGoalDistAt(lx, ly, p.boardSx ?? 1, p.boardSy ?? 1, winGoal);
                        if (prog < bestProg) { bestProg = prog; bestD = d; }
                    }
                    p.dir = { x: bestD.x, y: bestD.y };
                }
            }
        }

        // Infinite charge: prefer charges unless escaping / proven win-mobility dash
        if (brave && (playstyle?.preferChargePursuit || p.selectedSkill === 'infinite-charge')) {
            if (!(lethalFacing || pocketDeath || speedDash)) shouldDash = false;
        }

        let travelDash = false;
        let travelCharge = false;
        if (typeof worldBoards !== 'undefined' && worldBoards && worldBoards.length) {
            const ownerKey = (String(p.id).split('_')[0] === '1') ? 'player' : 'enemy';
            const hungerAb = RonkAI.hungerState(p, diff);
            let target = AI_HELPERS.pickBoardStrategyTarget(p.x, p.y, ownerKey, p);
            if ((playstyle?.lockFirstCpPerBoard || p.selectedSkill === 'infinite-trails')
                && !(hungerAb.urgentHunger || hungerAb.panicHunger)) {
                const lockHop = AI_HELPERS.pickTrailLockTarget(p.x, p.y, ownerKey, p);
                if (lockHop && lockHop.hops > 0 && lockHop.oursOnBoard === 0) {
                    target = lockHop;
                }
            }
            const offBoard = aiPickOffBoardTarget(p, ownerKey, opponent, playstyle);
            if (offBoard && offBoard.hops > 0
                && !(hungerAb.urgentHunger || hungerAb.panicHunger)
                && (!target || target.hops === 0 || offBoard.priority >= (target.priority || 0))) {
                target = offBoard;
            }
            const appleT = (hungerAb.survivalFocus || hungerAb.urgentHunger || hungerAb.panicHunger)
                ? AI_HELPERS.nearestAppleTarget(p.x, p.y, p)
                : null;
            if (appleT && appleT.hops > 0
                && (hungerAb.urgentHunger || hungerAb.panicHunger
                    || !target || target.hops === 0
                    || appleT.dist <= (target.dist || 999) + 4)) {
                target = {
                    sx: appleT.sx,
                    sy: appleT.sy,
                    hops: appleT.hops,
                    dist: appleT.dist,
                    priority: 9000,
                    appleHunt: true
                };
            }
            const forceExplore = !(hungerAb.survivalFocus || hungerAb.urgentHunger || hungerAb.panicHunger)
                && aiShouldForceBoardExplore(p, playstyle, ownerKey, opponent, diff);
            if ((!target || target.hops === 0) && forceExplore) {
                const psx = Number.isInteger(p.boardSx) ? p.boardSx : 1;
                const psy = Number.isInteger(p.boardSy) ? p.boardSy : 1;
                const exclude = new Set([`${psx}_${psy}`]);
                const explore = AI_HELPERS.pickBoardStrategyTarget(
                    p.x, p.y, ownerKey, p, { excludeKeys: exclude, preferOffBoard: true }
                );
                if (explore && explore.hops > 0) target = explore;
            }
            if (aiBoardClaimed(p, ownerKey) && (!target || target.hops === 0)) {
                const nextBoard = aiPickOffBoardTarget(p, ownerKey, opponent, playstyle);
                if (nextBoard && nextBoard.hops > 0) target = nextBoard;
            }
            // Threat-aware hop: coward flees same-board pressure; else only when explore/claim warrants
            if (diff.unbeatableMode && !(hungerAb.urgentHunger || hungerAb.panicHunger)
                && threat.level === 'high' && !brave
                && (playstyle?.playsCoward || playstyle?.evadeEnemy || p.selectedSkill === 'laser')
                && sameBoardOpp && (!target || target.hops === 0)) {
                const flee = aiPickOffBoardTarget(p, ownerKey, opponent, playstyle);
                if (flee && flee.hops > 0) target = flee;
            }
            const ticksSinceHop = (p.aiAbilityTicks || 0) - (p._aiLastBoardHopTick || -999);
            const hopCdRaw = playstyle?.hopCooldown ?? (elite ? 10 : 14);
            const hopCd = (target && target.hops > 0)
                ? Math.min(hopCdRaw, elite || diff.unbeatableMode ? 1 : 5)
                : hopCdRaw;
            const hopReady = ticksSinceHop >= hopCd;
            const travelWorthIt = !!(target && target.hops > 0);
            const tryCommitHop = (hopTarget) => {
                if (!hopTarget || !hopReady || !travelWorthIt) return;
                const hopDir = aiHopDirToBoard(p, hopTarget.sx, hopTarget.sy);
                if (!hopDir) return;
                const leap = aiTravelLeapChoice(p, hopDir, gridCount);
                if (leap === 'dash') {
                    shouldDash = true;
                    travelDash = true;
                    p._aiTravelTarget = hopTarget;
                    p._aiTravelHopDir = hopDir;
                } else if (leap === 'charge') {
                    travelCharge = true;
                    p._aiTravelTarget = hopTarget;
                    p._aiTravelHopDir = hopDir;
                }
            };
            if (travelWorthIt) tryCommitHop(target);
            // Stuck on one board after explore — adjacent hop only when explore says leave
            if (!travelDash && !travelCharge && hopReady
                && (elite || diff.unbeatableMode)
                && !(hungerAb.urgentHunger || hungerAb.panicHunger)
                && aiShouldForceBoardExplore(p, playstyle, ownerKey, opponent, diff)) {
                const dirs = AI_DIRS.slice();
                for (let i = dirs.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    const t = dirs[i]; dirs[i] = dirs[j]; dirs[j] = t;
                }
                for (let i = 0; i < dirs.length; i++) {
                    const hopDir = dirs[i].d;
                    const leap = aiTravelLeapChoice(p, hopDir, gridCount);
                    if (leap === 'dash') {
                        shouldDash = true;
                        travelDash = true;
                        p._aiTravelTarget = {
                            sx: AI_HELPERS.wrapBoard((p.boardSx ?? 1) + hopDir.x),
                            sy: AI_HELPERS.wrapBoard((p.boardSy ?? 1) + hopDir.y),
                            hops: 1
                        };
                        p._aiTravelHopDir = hopDir;
                        break;
                    }
                    if (leap === 'charge') {
                        travelCharge = true;
                        p._aiTravelTarget = {
                            sx: AI_HELPERS.wrapBoard((p.boardSx ?? 1) + hopDir.x),
                            sy: AI_HELPERS.wrapBoard((p.boardSy ?? 1) + hopDir.y),
                            hops: 1
                        };
                        p._aiTravelHopDir = hopDir;
                        break;
                    }
                }
            }
            // Coward kits: flee shared board when opponent is close (laser sets passive grid then leaves)
            if (!travelDash && !travelCharge && hopReady && opponent && sameBoardOpp
                && threat.level === 'high'
                && dist <= 14 && (playstyle?.playsCoward || playstyle?.evadeEnemy || p.selectedSkill === 'laser')
                && !(hungerAb.urgentHunger || hungerAb.panicHunger)) {
                for (let i = 0; i < AI_DIRS.length; i++) {
                    const hopDir = AI_DIRS[i].d;
                    const leap = aiTravelLeapChoice(p, hopDir, gridCount);
                    if (leap === 'dash') {
                        shouldDash = true;
                        travelDash = true;
                        p._aiTravelTarget = {
                            sx: AI_HELPERS.wrapBoard((p.boardSx ?? 1) + hopDir.x),
                            sy: AI_HELPERS.wrapBoard((p.boardSy ?? 1) + hopDir.y),
                            hops: 1
                        };
                        p._aiTravelHopDir = hopDir;
                        break;
                    }
                    if (leap === 'charge') {
                        travelCharge = true;
                        p._aiTravelTarget = {
                            sx: AI_HELPERS.wrapBoard((p.boardSx ?? 1) + hopDir.x),
                            sy: AI_HELPERS.wrapBoard((p.boardSy ?? 1) + hopDir.y),
                            hops: 1
                        };
                        p._aiTravelHopDir = hopDir;
                        break;
                    }
                }
            }
            // Brave hunt: chase opponent across adjacent boards
            if (!travelDash && !travelCharge && hopReady && opponent && brave
                && (sense.boardSx !== (p.boardSx ?? 1) || sense.boardSy !== (p.boardSy ?? 1))
                && !(playstyle?.evadeEnemy || playstyle?.playsCoward)
                && !(hungerAb.urgentHunger || hungerAb.panicHunger)) {
                const hopsOpp = AI_HELPERS.boardHopDist(
                    p.boardSx ?? 1, p.boardSy ?? 1,
                    sense.boardSx, sense.boardSy
                );
                const huntChase = resolveBoardVsHuntStrategy(
                    p, opponent, diff, playstyle,
                    AI_HELPERS.boardOwnershipStats(ownerKey),
                    target,
                    false,
                    hopsOpp,
                    threat
                );
                const maxHuntHops = (spectate && threat.level === 'high') ? 3 : 2;
                if (hopsOpp >= 1 && hopsOpp <= maxHuntHops && !huntChase.preferBoardControl) {
                    const hopDir = aiHopDirToBoard(p, sense.boardSx, sense.boardSy);
                    if (hopDir) {
                        const leap = aiTravelLeapChoice(p, hopDir, gridCount);
                        if (leap === 'dash') {
                            shouldDash = true;
                            travelDash = true;
                            p._aiTravelTarget = { sx: sense.boardSx, sy: sense.boardSy, hops: hopsOpp };
                            p._aiTravelHopDir = hopDir;
                        } else if (leap === 'charge') {
                            travelCharge = true;
                            p._aiTravelTarget = { sx: sense.boardSx, sy: sense.boardSy, hops: hopsOpp };
                            p._aiTravelHopDir = hopDir;
                        }
                    }
                }
            }
        }

        // Near the rim: cancel non-travel dashes so elites don't walk/dash themselves off
        if (!travelDash && edgeNow <= 2) shouldDash = false;

        // Board hops must fire; speed dashes only when progress already proven
        const travelDashChance = travelDash
            ? (elite || diff.unbeatableMode ? 1 : Math.min(1, Math.max(0.92, diff.dashChance)))
            : speedDash
                ? 1 // already gated by progress + anti-oscillation
                : Math.min(1, (elite ? 0.55 : diff.dashChance) * (playstyle?.travelDashMult ?? 1));
        if (shouldDash && Math.random() < travelDashChance) {
            const cur = p.dir || { x: 1, y: 0 };
            const travelTarget = p._aiTravelTarget;
            const dashGoal = winGoal || aiWinGoal(p, opponent, playstyle)
                || (travelTarget ? {
                    kind: 'cp', x: travelTarget.cpX, y: travelTarget.cpY,
                    sx: travelTarget.sx, sy: travelTarget.sy,
                    hops: travelTarget.hops, dist: travelTarget.dist
                } : null);
            if (travelDash && travelTarget) {
                const hopDir = p._aiTravelHopDir || aiHopDirToBoard(p, travelTarget.sx, travelTarget.sy);
                if (hopDir && aiEliteDashDirSafe(p, hopDir, gridCount, true, opponent)) {
                    p.dir = { x: hopDir.x, y: hopDir.y };
                }
            }
            const face = (travelDash && p._aiTravelHopDir) ? p._aiTravelHopDir : (p.dir || cur);
            const dashLen = aiDashDist(p);
            const dashDirs = AI_DIRS.map(d => d.d).filter(d => {
                if (d.x === -face.x && d.y === -face.y) return false;
                if (!travelDash) {
                    if (inLineY && d.y === 0 && sense.seeCube && lethalFacing) return false;
                    if (inLineX && d.x === 0 && sense.seeCube && lethalFacing) return false;
                }
                if (!aiEliteDashDirSafe(p, d, gridCount, travelDash, opponent)) return false;
                if (travelDash) {
                    return !dashGoal || aiDashAdvancesGoal(p, d, gridCount, dashGoal, true);
                }
                const sim = aiSimulateLeap(p, d, dashLen, gridCount);
                if (AI_HELPERS.isOccupied(sim.x, sim.y, p, opponent, gridCount)) return false;
                if (aiDashIsOscillation(p, sim.x, sim.y)) return false;
                // Non-escape dashes must advance the win goal
                if (speedDash || !(lethalFacing || pocketDeath)) {
                    if (!dashGoal || !aiDashAdvancesGoal(p, d, gridCount, dashGoal, false)) return false;
                }
                return true;
            });
            if (dashDirs.length) {
                let best = dashDirs[0];
                if (!travelDash) {
                    let bestScore = -Infinity;
                    for (const d of dashDirs) {
                        const sim = aiSimulateLeap(p, d, dashLen, gridCount);
                        const s = AI_HELPERS.getAccessibleSpace(sim.x, sim.y, p, opponent, gridCount, 24);
                        let score = s + sim.landEdge * 80;
                        if (dashGoal) {
                            const before = aiGoalDistAt(p.x, p.y, p.boardSx ?? 1, p.boardSy ?? 1, dashGoal);
                            const after = aiGoalDistAt(sim.x, sim.y, p.boardSx ?? 1, p.boardSy ?? 1, dashGoal);
                            score += (before - after) * 40;
                        }
                        if (lethalFacing) {
                            score += (Math.abs(sim.x - ox) + Math.abs(sim.y - oy)) * 5;
                        }
                        if (d.x === face.x && d.y === face.y) score += 12;
                        if (score > bestScore) { bestScore = score; best = d; }
                    }
                } else {
                    const target = p._aiTravelTarget || dashGoal;
                    let bestScore = -Infinity;
                    for (const d of dashDirs) {
                        const sim = aiSimulateLeap(p, d, dashLen, gridCount);
                        let s = 0;
                        if (target && sim.hopped) {
                            const nextSx = AI_HELPERS.wrapBoard((p.boardSx ?? 1) + sim.hopDx);
                            const nextSy = AI_HELPERS.wrapBoard((p.boardSy ?? 1) + sim.hopDy);
                            const hopsNow = AI_HELPERS.boardHopDist(p.boardSx ?? 1, p.boardSy ?? 1, target.sx, target.sy);
                            const hopsAfter = AI_HELPERS.boardHopDist(nextSx, nextSy, target.sx, target.sy);
                            s = (hopsNow - hopsAfter) * 40;
                            const hopDir = p._aiTravelHopDir;
                            if (hopDir && d.x === hopDir.x && d.y === hopDir.y) s += 24;
                        }
                        if (d.x === face.x && d.y === face.y) s += 8;
                        if (s > bestScore) { bestScore = s; best = d; }
                    }
                    if (target && bestScore < 20) {
                        shouldDash = false;
                    }
                }
                if (shouldDash && best) {
                    aiFreezeDirForLeap(p, best);
                    const beforeSx = p.boardSx;
                    const beforeSy = p.boardSy;
                    aiRecordDash(p, best, travelDash);
                    p.dash();
                    if (travelDash || beforeSx !== p.boardSx || beforeSy !== p.boardSy) {
                        p._aiLastBoardHopTick = p.aiAbilityTicks || 0;
                    }
                }
            }
        }

        if (aiLeapQueued(p)) {
            aiKeepLeapDir(p);
        } else if ((diff.unbeatableMode || playstyle?.preferInland || elite) && edgeNow <= (p.selectedSkill === 'invisible' ? 2 : 1) && !travelDash && !travelCharge) {
            const inland = AI_DIRS.map(d => d.d).find(d => {
                const nx = p.x + d.x;
                const ny = p.y + d.y;
                if (nx < 0 || nx >= gridCount || ny < 0 || ny >= gridCount) return false;
                if (d.x === -(p.dir?.x || 0) && d.y === -(p.dir?.y || 0)) return false;
                return AI_HELPERS.distToSectorEdge(nx, ny, gridCount) > edgeNow;
            });
            if (inland) p.dir = inland;
        }

        const facingEnemy = (inLineY && Math.sign(ox - p.x) === Math.sign(p.dir.x)) ||
                            (inLineX && Math.sign(oy - p.y) === Math.sign(p.dir.y));
        const openPhase = playstyle && isSkillOpenPhase(p, playstyle);
        const rageMult = p.jokerCooldownReduce < 1 ? p.jokerCooldownReduce : 1;
        const skillCdAi = (diff.skillCooldownMs ?? 800) * rageMult;
        const skillCdReal = (typeof getSkillCooldownMs === 'function')
            ? getSkillCooldownMs(p) * rageMult
            : skillCdAi;
        const skillCd = Math.min(skillCdAi, skillCdReal);
        const ctx = { dist, space, facing: facingEnemy, inLineX, inLineY };
        const useTactics = elite || diff.instantSkills || diff.skillTactics;
        const shouldOpenSkill = playstyle?.openSkillEarly && openPhase && (p._skillsUsed || 0) === 0;
        const forceSpamLaser = p.selectedSkill === 'laser' && playstyle?.spamSkill
            && (p.activeLaserRoutines?.length || 0) < ((typeof MAX_LASER_ROUTINES === 'number') ? MAX_LASER_ROUTINES : 3);
        const forceOpenLaser = forceSpamLaser && (p._skillsUsed || 0) === 0
            && (diff.unbeatableMode || elite) && (p.ticksAlive || 0) < 90;
        const forceFullInvis = p.selectedSkill === 'invisible' && playstyle?.useFullInvisOften
            && !p.fullInvisibleActive && (diff.unbeatableMode || elite);
        const forceOpenInfCharge = p.selectedSkill === 'infinite-charge'
            && (diff.unbeatableMode || elite)
            && !p.infiniteChargeActive
            && ((p._skillsUsed || 0) === 0 || (p.ticksAlive || 0) < 50);

        // Infinite charge: activate skill BEFORE chase charges so the 5s window opens early
        if (!p.isClone && p.selectedSkill && Date.now() - p.lastSkillUsed >= skillCd) {
            if (useTactics && (forceOpenLaser || forceSpamLaser || forceFullInvis || forceOpenInfCharge
                || shouldOpenSkill
                || evaluateAISkillActivation(p, opponent, gridCount, diff, ctx))) {
                if (Math.random() < (elite || forceOpenLaser || forceSpamLaser || forceFullInvis || forceOpenInfCharge ? 1 : diff.skillChance)) {
                    const prev = p.lastSkillUsed;
                    p.activateSkill();
                    if (p.lastSkillUsed !== prev) {
                        p._skillsUsed = (p._skillsUsed || 0) + 1;
                    }
                }
            }
        }

        aiSnapChargeFacing(p, opponent);
        const chargeCtx = { dist, space, facingEnemy, inLineX, inLineY };

        if (aiLeapQueued(p)) {
            aiKeepLeapDir(p);
        } else if (travelCharge && p._aiTravelHopDir) {
            const hopDir = p._aiTravelHopDir;
            aiFreezeDirForLeap(p, hopDir);
            if (aiChargePathOk(p, aiChargeDist(p), gridCount, {
                allowHop: true,
                needDx: hopDir.needDx,
                needDy: hopDir.needDy
            })) {
                const beforeSx = p.boardSx;
                const beforeSy = p.boardSy;
                p.charge();
                p._aiLastChargeTick = p.aiAbilityTicks || 0;
                if (beforeSx !== p.boardSx || beforeSy !== p.boardSy) {
                    p._aiLastBoardHopTick = p.aiAbilityTicks || 0;
                }
            }
        } else if (evaluateTacticalCharge(p, opponent, gridCount, diff, chargeCtx)) {
            aiFreezeDirForLeap(p, p.dir);
            p.charge();
            p._aiLastChargeTick = p.aiAbilityTicks || 0;
        }
    },

    tick(p, opponent, gridCount) {
        if (typeof gameState !== 'undefined' && gameState !== 'PLAYING') return;
        if (!p || !opponent || p.isDead) return;

        if (!p.dir || (p.dir.x === 0 && p.dir.y === 0)) p.dir = { x: 1, y: 0 };

        if (!Array.isArray(p._aiRecentCells)) p._aiRecentCells = [];
        const lastCell = p._aiRecentCells[p._aiRecentCells.length - 1];
        if (!lastCell || lastCell.x !== p.x || lastCell.y !== p.y) {
            p._aiRecentCells.push({ x: p.x, y: p.y });
            if (p._aiRecentCells.length > 16) p._aiRecentCells.shift();
        }

        // Track how long this bot has camped on the same board (drives travel urgency)
        const boardKey = `${Number.isInteger(p.boardSx) ? p.boardSx : 1}_${Number.isInteger(p.boardSy) ? p.boardSy : 1}`;
        if (p._aiBoardKey !== boardKey) {
            p._aiBoardKey = boardKey;
            p._aiBoardDwellTicks = 0;
        } else {
            p._aiBoardDwellTicks = (p._aiBoardDwellTicks || 0) + 1;
        }

        // If a clone's mission board got claimed, pick a new one
        if (p.isClone && Number.isInteger(p._missionSx) && typeof worldBoards !== 'undefined' && worldBoards?.length) {
            const missionBoard = worldBoards.find(b => b && b.sx === p._missionSx && b.sy === p._missionSy);
            if (missionBoard && missionBoard.owner) {
                if (typeof assignCloneBoardMission === 'function') {
                    const ownerPlayer = (String(p.id).split('_')[0] === '1') ? p1 : p2;
                    assignCloneBoardMission(p, ownerPlayer);
                }
            }
        }

        const diff = getPlayerDifficultyProfile(p);

        p.aiThinkTicks = (p.aiThinkTicks || 0) + 1;
        p.aiAbilityTicks = (p.aiAbilityTicks || 0) + 1;

        const thinkEvery = p.isClone
            ? ((Number.isInteger(p._missionSx)
                && (p.boardSx !== p._missionSx || p.boardSy !== p._missionSy)) ? 3 : 4)
            : Math.max(2, diff.thinkInterval || 2);
        const abilityEvery = p.isClone ? 6 : Math.max(2, diff.abilityInterval || 2);
        const wantThink = p.aiThinkTicks % thinkEvery === 0;
        const wantAbility = p.aiAbilityTicks % abilityEvery === 0;

        let doThink = wantThink;
        if (wantThink) {
            if (p.isClone) {
                if (this.cloneThinksThisTick >= 2) {
                    p.aiThinkTicks--;
                    doThink = false;
                } else {
                    this.cloneThinksThisTick++;
                }
            } else if (this.thinksThisTick >= eliteMainThinkBudget()) {
                p.aiThinkTicks--;
                doThink = false;
            } else {
                this.thinksThisTick++;
            }
        }
        const doAbility = wantAbility
            || (!p.isClone && p.infiniteChargeActive && p.selectedSkill === 'infinite-charge');

        // Occupancy grid is only needed when thinking / using abilities
        if (doThink || doAbility) {
            RonkAI.prepareGrid(p, opponent, gridCount);
        }

        if (doThink) {
            const actions = RonkAI.validActions(p);
            let action = actions[0];
            try {
                action = RonkAI.pickMove(p, opponent, gridCount, diff, actions);
            } catch (err) {
                console.warn('[RonkAI] pickMove failed — holding course', err && err.message);
            }
            p.dir = AI_HELPERS.indexToDir(action);
        }

        if (doAbility) {
            RonkAI.useAbilities(p, opponent, gridCount, diff);
        }

        // Every tick (mains + clones): never walk off the rim between thinks
        {
            const style = getAISkillPlaystyle(p, diff);
            const edge = AI_HELPERS.distToSectorEdge(p.x, p.y, gridCount);
            const hopping = !!(p._aiTravelTarget && edge <= 1) || aiLeapQueued(p);
            if (!hopping) {
                aiEliteStabilizeDir(p, gridCount, opponent, diff, style);
            }
        }
    }
};

function getBotDifficultyProfile(level) {
    const key = level || (typeof window !== 'undefined' && window.currentBotDifficulty) || 'medium';
    return BOT_DIFFICULTY_PROFILES[key] || BOT_DIFFICULTY_PROFILES.medium;
}

function getPlayerDifficultyProfile(p) {
    const level = (p && p.aiDifficulty) || (typeof window !== 'undefined' && window.currentBotDifficulty) || 'medium';
    return getBotDifficultyProfile(level);
}

/** True for any Elite / invincible bot — play vs Elite, spectate Elite, dual Elite, etc. */
function isEliteAi(p, diff) {
    if (!p || p.isClone) return false;
    if (diff && diff.unbeatableMode) return true;
    const level = (p && p.aiDifficulty)
        || (typeof window !== 'undefined' && window.currentBotDifficulty)
        || '';
    if (String(level).toLowerCase() === 'invincible') return true;
    const profile = diff || getPlayerDifficultyProfile(p);
    return !!(profile && profile.unbeatableMode);
}

/** Spectate Elite vs Elite: both mains may think this tick. Vs human: keep one. */
function eliteMainThinkBudget() {
    let n = 0;
    try {
        if (typeof p1 !== 'undefined' && p1 && p1.isAI && !p1.isDead && isEliteAi(p1)) n++;
        if (typeof p2 !== 'undefined' && p2 && p2.isAI && !p2.isDead && isEliteAi(p2)) n++;
    } catch (_) { /* ignore */ }
    return Math.max(1, Math.min(2, n));
}

function getBotDifficultyLabel(level) {
    const key = level || 'medium';
    try {
        const lang = (typeof localStorage !== 'undefined' && localStorage.getItem('ronk_language')) || 'en';
        const t = (typeof translations !== 'undefined' && translations[lang]) || {};
        if (key === 'invincible' && t['INVINCIBLE']) return t['INVINCIBLE'];
        const upper = String(key).toUpperCase();
        if (t[upper]) return t[upper];
    } catch (_) { /* ignore */ }
    return getBotDifficultyProfile(key).label || 'MEDIUM';
}

function countAIClonesFor(p) {
    if (typeof countAliveClonesFor === 'function') return countAliveClonesFor(p);
    if (typeof clones === 'undefined') return 0;
    const baseId = String(p.id).split('_')[0];
    return clones.filter(c => c && !c.isDead && (c.ownerId === baseId || String(c.id).split('_')[0] === baseId)).length;
}

function isPlayerOnEnemyLaser(p) {
    if (typeof laserLines === 'undefined') return false;
    ensurePlayerBoard?.(p);
    for (const laser of laserLines) {
        if (typeof isFriendlyLaserOwner === 'function'
            ? isFriendlyLaserOwner(laser, p)
            : (laser.owner === p || AI_HELPERS.aiSameArmy(laser.owner, p))) {
            continue;
        }
        if (Number.isInteger(laser.boardSx) && Number.isInteger(laser.boardSy)) {
            if (p.boardSx !== laser.boardSx || p.boardSy !== laser.boardSy) continue;
        } else {
            continue;
        }
        if ((laser.isHorizontal && p.y === laser.pos) || (!laser.isHorizontal && p.x === laser.pos)) return true;
    }
    return false;
}

function playerHasJoker(p, id) {
    return Array.isArray(p.activeJokers) && p.activeJokers.includes(id);
}

function evaluateAISkillActivation(p, opponent, gridCount, diff, ctx) {
    const skill = p.selectedSkill;
    if (!skill || p.isClone) return false;

    const inv = diff.unbeatableMode || diff.instantSkills;
    const style = getAISkillPlaystyle(p, diff);
    const openPhase = style && isSkillOpenPhase(p, style);
    const { dist, space, facing, inLineX, inLineY } = ctx;
    const chargeBonus = p.jokerChargeBonus || 0;
    const oppSpace = 40;
    const neverUsed = (p._skillsUsed || 0) === 0;

    switch (skill) {
        case 'infinite-charge': {
            // Pop the skill ASAP then keep it online for chase charges
            if (inv && style?.openSkillEarly && neverUsed) return true;
            if (inv && (style?.preferChargePursuit || style?.catchRunaways || style?.invincibleRisk === 'high')) {
                return true;
            }
            if (inv && style?.openSkillEarly && openPhase) return true;
            const range = (inv ? 80 : 34) + chargeBonus * 3;
            if (!facing || dist > range || dist < 2) return false;
            if (opponent.isCharging || opponent.infiniteChargeActive) return true;
            if (inv && style?.invincibleRisk === 'high') return true;
            return space > oppSpace * 0.5;
        }
        case 'clones': {
            const maxClones = typeof MAX_CLONES_ALIVE !== 'undefined' ? MAX_CLONES_ALIVE : 2;
            const alive = countAIClonesFor(p);
            if (alive >= maxClones) return false;
            // Always refill to 2 clones (3 cubes total) ASAP
            if (inv && style?.openSkillEarly && (neverUsed || alive === 0)) return true;
            if (inv && alive < maxClones) return space > 8;
            return space > oppSpace + 6 || (inv && space > 22);
        }
        case 'laser': {
            // Crazy spam — stack waves ASAP and keep restacking off CD
            const maxStacks = (typeof MAX_LASER_ROUTINES === 'number') ? MAX_LASER_ROUTINES : 3;
            const stacks = p.activeLaserRoutines?.length || 0;
            if (stacks >= maxStacks) return false;
            if (inv && (style?.spamSkill || style?.openSkillEarly)) {
                if (neverUsed || stacks === 0) return true;
                return true; // restack whenever CD ready
            }
            if (stacks > 0) {
                return dist < 42 || (inLineX || inLineY);
            }
            if (inv && style?.invincibleRisk === 'low') return dist < 48 || ((inLineX || inLineY) && dist < 50);
            return dist < (inv ? 60 : 45) || (inv && (inLineX || inLineY) && dist < 55);
        }
        case 'infinite-trails':
            // Passive — always painting; never needs activation
            return false;
        case 'invisible': {
            // Passive trail hide always on; activate FULL 3s cube+trail cloak often
            if (p.fullInvisibleActive) return false;
            if (style?.useFullInvisOften) {
                if (p.fullInvisibleActive) return false; // never refresh mid-cloak — hard 3s windows
                if (inv && neverUsed) return true;
                if (inv) return true; // every CD — each activate is still only 3s
                if (dist < 55 || space < 40) return true;
            }
            if (style?.useFullInvisAmbush && dist <= (style.openWhenClose || 36)) return true;
            if (inv && style?.invincibleRisk === 'low') return dist < 50 || space < 32;
            return dist < (inv ? 55 : 38) || space < (inv ? 35 : 28);
        }
        default:
            return dist < 40 && space > 15;
    }
}

function handleAdvancedAI(p, opponent, gridCount) {
    RonkAI.tick(p, opponent, gridCount);
}

function resolveAIOpponent(p) {
    return RonkAI.resolveOpponent(p);
}

if (typeof window !== 'undefined') {
    window.RonkAI = RonkAI;
    window.AI_HELPERS = AI_HELPERS;
    window.handleAdvancedAI = handleAdvancedAI;
    window.resolveAIOpponent = resolveAIOpponent;
    window.getBotDifficultyProfile = getBotDifficultyProfile;
    window.getBotDifficultyLabel = getBotDifficultyLabel;
    window.getPlayerDifficultyProfile = getPlayerDifficultyProfile;
    window.isEliteAi = isEliteAi;
    window.BOT_DIFFICULTY_PROFILES = BOT_DIFFICULTY_PROFILES;
    window.AI_JOKER_SKILL_COMBOS = AI_JOKER_SKILL_COMBOS;
    window.AI_BEST_LOADOUTS = AI_BEST_LOADOUTS;
    window.selectBestAILoadout = selectBestAILoadout;
    window.selectInvincibleLoadoutAvoidingSkill = selectInvincibleLoadoutAvoidingSkill;
    window.resetEliteSkillDealBag = resetEliteSkillDealBag;
    window.selectAISkillForDifficulty = selectAISkillForDifficulty;
    window.selectAIJokersForSkill = selectAIJokersForSkill;
    window.getInvincibleLoadoutCount = getInvincibleLoadoutCount;
    window.getPlayerDifficultyProfile = getPlayerDifficultyProfile;
}
