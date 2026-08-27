// --- AUDIO SYSTEM ---
const SFX = {
    ctx: null,
    enabled: true,
    volume: 1.0,
    noiseBuffer: null,
    _masterGain: null,
    // Bus boost so SFX cut through BGM (Music uses a separate context — leave it alone)
    _busGain: 2.6,
    _activeNodes: [],
    _activeByType: {},
    _lastPlayed: {},
    _maxConcurrent: 32,
    _unlocked: false,
    _debounceMs: {
        move: 60,
        charge: 220,
        dash: 160,
        laser: 450,
        fall: 260,
        hit: 90,
        shatter: 180,
        skill: 180,
        apple: 120,
        button: 40
    },
    // Soft caps — never hard-block dash/charge/button/hit (those must always be audible)
    _typeMaxConcurrent: {
        move: 6,
        laser: 3,
        fall: 2,
        skill: 2
    },
    _priorityTypes: { button: 1, dash: 1, charge: 1, hit: 1, shatter: 1, win: 1, laser: 1 },
    init() {
        if (!this.ctx) {
            // Own AudioContext — do NOT share with Music. Sharing broke SFX after
            // Music started routing HTMLAudio through createMediaElementSource.
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this._masterGain = this.ctx.createGain();
            this._masterGain.gain.value = this._busGain;
            this._masterGain.connect(this.ctx.destination);
            // Pre-create noise buffer for 'hit' sound to avoid allocation during gameplay
            const bufferSize = this.ctx.sampleRate * 0.2;
            this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
            const data = this.noiseBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
        }
        this._ensureMasterGain();
        this.resumeCtx();
    },
    resumeCtx() {
        if (!this.ctx) return null;
        if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
            try { return this.ctx.resume(); } catch (_) { return null; }
        }
        return Promise.resolve();
    },
    /** Call from any user gesture — unlocks WebAudio so later keydash SFX work. */
    unlock() {
        this.init();
        const p = this.resumeCtx();
        if (this._unlocked || !this.ctx) return p;
        try {
            // Silent one-shot forces the graph awake (more reliable than resume alone)
            const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            const g = this.ctx.createGain();
            g.gain.value = 0.0001;
            src.connect(g);
            g.connect(this._getOutput());
            src.start(0);
            this._unlocked = true;
        } catch (_) { /* ignore */ }
        return p;
    },
    _ensureMasterGain() {
        if (!this.ctx) return;
        if (!this._masterGain) {
            this._masterGain = this.ctx.createGain();
            this._masterGain.gain.value = this._busGain;
            this._masterGain.connect(this.ctx.destination);
            this._masterConnected = true;
            return;
        }
        if (typeof this._masterGain.gain.value !== 'number' || this._masterGain.gain.value <= 0) {
            this._masterGain.gain.value = this._busGain;
        } else if (this._masterGain.gain.value < this._busGain * 0.9) {
            // Heal accidental mute / stale low bus without fighting live automation
            this._masterGain.gain.value = this._busGain;
        }
        // Only (re)connect when we know the bus was torn down — never disconnect live audio
        if (!this._masterConnected) {
            try {
                this._masterGain.connect(this.ctx.destination);
                this._masterConnected = true;
            } catch (_) { /* already connected */ this._masterConnected = true; }
        }
    },
    _getOutput() {
        this._ensureMasterGain();
        return this._masterGain || (this.ctx && this.ctx.destination);
    },
    _pruneActiveNodes() {
        this._activeNodes = this._activeNodes.filter(entry => entry.alive);
        this._activeByType = {};
        this._activeNodes.forEach(entry => {
            this._activeByType[entry.type] = (this._activeByType[entry.type] || 0) + 1;
        });
    },
    _stealOldestSlot() {
        const victim = this._activeNodes.find(e => e.alive && e.type === 'move')
            || this._activeNodes.find(e => e.alive);
        if (!victim) return;
        victim.alive = false;
        victim.parts.forEach(node => {
            try { if (node.stop) node.stop(); } catch (_) {}
            try { node.disconnect(); } catch (_) {}
        });
        this._pruneActiveNodes();
    },
    _trackNode(type, parts, durationSec = 0.5) {
        const entry = { type, alive: true, parts };
        const release = () => {
            if (!entry.alive) return;
            entry.alive = false;
            parts.forEach(node => {
                // Never disconnect the shared master bus
                if (node === this._masterGain) return;
                try { node.disconnect(); } catch (_) {}
            });
            this._pruneActiveNodes();
        };
        let awaiting = 0;
        parts.forEach(node => {
            if (node && typeof node.stop === 'function') {
                awaiting++;
                const onEnd = () => {
                    awaiting--;
                    if (awaiting <= 0) release();
                };
                try {
                    if (typeof node.addEventListener === 'function') {
                        node.addEventListener('ended', onEnd, { once: true });
                    }
                } catch (_) { /* ignore */ }
                try { node.onended = onEnd; } catch (_) { /* ignore */ }
            }
        });
        // Release promptly after the sound should have finished (ended can be flaky)
        const ms = Math.max(250, Math.min(2500, Math.ceil((durationSec + 0.15) * 1000)));
        setTimeout(release, ms);
        this._activeNodes.push(entry);
        this._activeByType[type] = (this._activeByType[type] || 0) + 1;
    },
    stopAll() {
        this._activeNodes.forEach(entry => {
            entry.alive = false;
            entry.parts.forEach(node => {
                if (node === this._masterGain) return;
                try {
                    if (node.stop) node.stop();
                    node.disconnect();
                } catch (_) {}
            });
        });
        this._activeNodes = [];
        this._activeByType = {};
        // Keep the output bus alive + connected
        this._ensureMasterGain();
    },
    getTheme() {
        return typeof themes !== 'undefined' && typeof currentThemeIndex !== 'undefined' 
            ? themes[currentThemeIndex] 
            : 'theme-ronk';
    },
    play(type, volume = 1.0, isResumeRetry = false) {
        if (!this.enabled) return;
        
        // Auto-init if ctx is missing (this will only work after first user gesture)
        if (!this.ctx) this.init();
        if (!this.ctx) return;

        // Resume if needed — but DO NOT early-return.
        // Prior bug: returning while suspended meant oscillators were never scheduled,
        // so button/dash/charge were silent whenever AudioContext hadn't finished resume().
        // Web Audio allows scheduling while suspended; audio starts when ctx runs.
        if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
            this.resumeCtx();
        }

        this._pruneActiveNodes();
        const nowMs = Date.now();
        const debounce = this._debounceMs[type] || 0;
        if (debounce && this._lastPlayed[type] && (nowMs - this._lastPlayed[type]) < debounce) return;
        const typeMax = this._typeMaxConcurrent[type];
        if (typeMax && (this._activeByType[type] || 0) >= typeMax) return;
        if (this._activeNodes.length >= this._maxConcurrent) {
            if (this._priorityTypes[type]) this._stealOldestSlot();
            else return;
        }
        this._lastPlayed[type] = nowMs;

        // Apply global SFX volume + mild headroom so dashes/hits stay above BGM
        volume = Math.min(3.2, Math.max(0, volume * this.volume * 1.55));
        if (volume <= 0) return;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const output = this._getOutput();
        osc.connect(gain);
        gain.connect(output);
        const now = this.ctx.currentTime;
        const theme = this.getTheme();
        const trackedParts = [osc, gain];
        let trackDuration = 0.12;
        const playThemeSound = (oscType, freqStart, freqEnd, duration, gainVal) => {
            osc.type = oscType;
            osc.frequency.setValueAtTime(freqStart, now);
            if (freqEnd !== freqStart) {
                osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 20), now + duration);
            }
            gain.gain.setValueAtTime(gainVal * volume, now);
            gain.gain.linearRampToValueAtTime(0, now + duration);
            osc.start(now);
            osc.stop(now + duration);
            trackDuration = Math.max(trackDuration, duration);
        };

        switch(type) {
            case 'move':
                if (theme === 'theme-ronk') {
                    playThemeSound('sine', 80, 40, 0.1, 0.05);
                } else if (theme === 'theme-white-black') {
                    playThemeSound('sine', 120, 60, 0.08, 0.04);
                } else if (theme === 'theme-pinkcore') {
                    playThemeSound('triangle', 200, 100, 0.1, 0.06);
                } else if (theme === 'theme-hacker') {
                    playThemeSound('square', 150, 75, 0.05, 0.03);
                } else if (theme === 'theme-pixel') {
                    playThemeSound('square', 100, 50, 0.06, 0.05);
                } else {
                    playThemeSound('sine', 80, 40, 0.1, 0.05);
                }
                break;
            case 'dash':
                if (theme === 'theme-ronk') {
                    playThemeSound('square', 440, 110, 0.2, 0.2);
                } else if (theme === 'theme-white-black') {
                    playThemeSound('sawtooth', 660, 165, 0.15, 0.18);
                } else if (theme === 'theme-pinkcore') {
                    playThemeSound('triangle', 523, 261, 0.2, 0.22);
                } else if (theme === 'theme-hacker') {
                    playThemeSound('square', 800, 200, 0.1, 0.26);
                } else if (theme === 'theme-pixel') {
                    playThemeSound('square', 300, 75, 0.15, 0.2);
                } else {
                    playThemeSound('square', 440, 110, 0.2, 0.2);
                }
                break;
            case 'charge':
                if (theme === 'theme-ronk') {
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(110, now);
                    osc.frequency.linearRampToValueAtTime(880, now + 0.5);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.2 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.5);
                    osc.start(now);
                    osc.stop(now + 0.5);
                } else if (theme === 'theme-white-black') {
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(165, now);
                    osc.frequency.linearRampToValueAtTime(1320, now + 0.4);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.18 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.4);
                    osc.start(now);
                    osc.stop(now + 0.4);
                } else if (theme === 'theme-pinkcore') {
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(220, now);
                    osc.frequency.linearRampToValueAtTime(1760, now + 0.45);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.22 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.45);
                    osc.start(now);
                    osc.stop(now + 0.45);
                } else if (theme === 'theme-hacker') {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(100, now);
                    osc.frequency.linearRampToValueAtTime(800, now + 0.3);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.14 * volume, now + 0.05);
                    gain.gain.linearRampToValueAtTime(0, now + 0.3);
                    osc.start(now);
                    osc.stop(now + 0.3);
                } else if (theme === 'theme-pixel') {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(150, now);
                    osc.frequency.linearRampToValueAtTime(1200, now + 0.5);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.2 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.5);
                    osc.start(now);
                    osc.stop(now + 0.5);
                } else {
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(110, now);
                    osc.frequency.linearRampToValueAtTime(880, now + 0.5);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.2 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.5);
                    osc.start(now);
                    osc.stop(now + 0.5);
                }
                break;
            case 'hit':
                if (theme === 'theme-ronk') {
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(100, now);
                    osc.frequency.exponentialRampToValueAtTime(20, now + 0.5);
                    gain.gain.setValueAtTime(0.34 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.5);
                    osc.start(now);
                    osc.stop(now + 0.5);
                    
                    if (this.noiseBuffer) {
                        const noise = this.ctx.createBufferSource();
                        noise.buffer = this.noiseBuffer;
                        const nGain = this.ctx.createGain();
                        nGain.gain.setValueAtTime(0.26 * volume, now);
                        nGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
                        noise.connect(nGain);
                        nGain.connect(this._getOutput());
                        noise.start(now);
                        noise.stop(now + 0.2);
                        trackedParts.push(noise, nGain);
                        trackDuration = Math.max(trackDuration, 0.5);
                    }
                } else if (theme === 'theme-white-black') {
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(80, now);
                    osc.frequency.exponentialRampToValueAtTime(20, now + 0.4);
                    gain.gain.setValueAtTime(0.28 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.4);
                    osc.start(now);
                    osc.stop(now + 0.4);
                } else if (theme === 'theme-pinkcore') {
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(150, now);
                    osc.frequency.exponentialRampToValueAtTime(15, now + 0.35);
                    gain.gain.setValueAtTime(0.38 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.35);
                    osc.start(now);
                    osc.stop(now + 0.35);
                } else if (theme === 'theme-hacker') {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(60, now);
                    osc.frequency.exponentialRampToValueAtTime(15, now + 0.3);
                    gain.gain.setValueAtTime(0.2 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.3);
                    osc.start(now);
                    osc.stop(now + 0.3);
                } else if (theme === 'theme-pixel') {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(120, now);
                    osc.frequency.exponentialRampToValueAtTime(10, now + 0.4);
                    gain.gain.setValueAtTime(0.3 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.4);
                    osc.start(now);
                    osc.stop(now + 0.4);
                } else {
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(100, now);
                    osc.frequency.exponentialRampToValueAtTime(20, now + 0.5);
                    gain.gain.setValueAtTime(0.34 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.5);
                    osc.start(now);
                    osc.stop(now + 0.5);
                    
                    if (this.noiseBuffer) {
                        const noise = this.ctx.createBufferSource();
                        noise.buffer = this.noiseBuffer;
                        const nGain = this.ctx.createGain();
                        nGain.gain.setValueAtTime(0.26 * volume, now);
                        nGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
                        noise.connect(nGain);
                        nGain.connect(this._getOutput());
                        noise.start(now);
                        noise.stop(now + 0.2);
                        trackedParts.push(noise, nGain);
                        trackDuration = Math.max(trackDuration, 0.5);
                    }
                }
                break;
            case 'f1':
                const baseFreq = 100 + volume * 400;
                if (theme === 'theme-ronk') {
                    playThemeSound('sawtooth', baseFreq, baseFreq * 1.5, 0.1, 0.05);
                } else if (theme === 'theme-white-black') {
                    playThemeSound('sine', baseFreq * 1.2, baseFreq * 1.8, 0.08, 0.04);
                } else if (theme === 'theme-pinkcore') {
                    playThemeSound('triangle', baseFreq, baseFreq * 2, 0.1, 0.06);
                } else if (theme === 'theme-hacker') {
                    playThemeSound('square', baseFreq * 0.8, baseFreq * 1.4, 0.06, 0.05);
                } else if (theme === 'theme-pixel') {
                    playThemeSound('square', baseFreq, baseFreq * 1.6, 0.08, 0.05);
                } else {
                    playThemeSound('sawtooth', baseFreq, baseFreq * 1.5, 0.1, 0.05);
                }
                break;
            case 'win':
                if (theme === 'theme-ronk') {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(523.25, now);
                    osc.frequency.setValueAtTime(659.25, now + 0.1);
                    osc.frequency.setValueAtTime(783.99, now + 0.2);
                    osc.frequency.setValueAtTime(1046.50, now + 0.3);
                    gain.gain.setValueAtTime(0.1 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.6);
                    osc.start(now);
                    osc.stop(now + 0.6);
                } else if (theme === 'theme-white-black') {
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(523.25, now);
                    osc.frequency.setValueAtTime(659.25, now + 0.1);
                    osc.frequency.setValueAtTime(783.99, now + 0.2);
                    osc.frequency.setValueAtTime(1046.50, now + 0.3);
                    gain.gain.setValueAtTime(0.08 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.6);
                    osc.start(now);
                    osc.stop(now + 0.6);
                } else if (theme === 'theme-pinkcore') {
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(659.25, now);
                    osc.frequency.setValueAtTime(783.99, now + 0.1);
                    osc.frequency.setValueAtTime(1046.50, now + 0.2);
                    osc.frequency.setValueAtTime(1318.50, now + 0.3);
                    gain.gain.setValueAtTime(0.12 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.6);
                    osc.start(now);
                    osc.stop(now + 0.6);
                } else if (theme === 'theme-hacker') {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(440, now);
                    osc.frequency.setValueAtTime(554.37, now + 0.08);
                    osc.frequency.setValueAtTime(659.25, now + 0.16);
                    osc.frequency.setValueAtTime(880, now + 0.24);
                    gain.gain.setValueAtTime(0.06 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.5);
                    osc.start(now);
                    osc.stop(now + 0.5);
                } else if (theme === 'theme-pixel') {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(392, now);
                    osc.frequency.setValueAtTime(523.25, now + 0.12);
                    osc.frequency.setValueAtTime(659.25, now + 0.24);
                    osc.frequency.setValueAtTime(783.99, now + 0.36);
                    gain.gain.setValueAtTime(0.1 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.6);
                    osc.start(now);
                    osc.stop(now + 0.6);
                } else {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(523.25, now);
                    osc.frequency.setValueAtTime(659.25, now + 0.1);
                    osc.frequency.setValueAtTime(783.99, now + 0.2);
                    osc.frequency.setValueAtTime(1046.50, now + 0.3);
                    gain.gain.setValueAtTime(0.1 * volume, now);
                    gain.gain.linearRampToValueAtTime(0, now + 0.6);
                    osc.start(now);
                    osc.stop(now + 0.6);
                }
                break;
            case 'button':
                if (theme === 'theme-ronk') {
                    playThemeSound('sawtooth', 60, 30, 0.1, 0.3);
                } else if (theme === 'theme-white-black') {
                    // Louder click — must punch through BGM on laptop speakers
                    playThemeSound('sine', 720, 360, 0.08, 0.28);
                } else if (theme === 'theme-pinkcore') {
                    playThemeSound('triangle', 440, 880, 0.1, 0.22);
                } else if (theme === 'theme-hacker') {
                    playThemeSound('square', 200, 400, 0.06, 0.16);
                } else if (theme === 'theme-pixel') {
                    playThemeSound('square', 150, 10, 0.1, 0.22);
                } else {
                    playThemeSound('sine', 440, 110, 0.1, 0.22);
                }
                break;
            case 'fall':
                if (theme === 'theme-ronk') {
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(100, now);
                    osc.frequency.exponentialRampToValueAtTime(800, now + 0.5);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.1 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.5);
                    osc.start(now);
                    osc.stop(now + 0.5);
                } else if (theme === 'theme-white-black') {
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(80, now);
                    osc.frequency.exponentialRampToValueAtTime(600, now + 0.4);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.08 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.4);
                    osc.start(now);
                    osc.stop(now + 0.4);
                } else if (theme === 'theme-pinkcore') {
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(120, now);
                    osc.frequency.exponentialRampToValueAtTime(700, now + 0.45);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.12 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.45);
                    osc.start(now);
                    osc.stop(now + 0.45);
                } else if (theme === 'theme-hacker') {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(60, now);
                    osc.frequency.exponentialRampToValueAtTime(500, now + 0.35);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.06 * volume, now + 0.05);
                    gain.gain.linearRampToValueAtTime(0, now + 0.35);
                    osc.start(now);
                    osc.stop(now + 0.35);
                } else if (theme === 'theme-pixel') {
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(90, now);
                    osc.frequency.exponentialRampToValueAtTime(650, now + 0.4);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.09 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.4);
                    osc.start(now);
                    osc.stop(now + 0.4);
                } else {
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(100, now);
                    osc.frequency.exponentialRampToValueAtTime(800, now + 0.5);
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.1 * volume, now + 0.1);
                    gain.gain.linearRampToValueAtTime(0, now + 0.5);
                    osc.start(now);
                    osc.stop(now + 0.5);
                }
                break;
            case 'shatter':
                if (theme === 'theme-ronk') {
                    playThemeSound('square', 150, 10, 0.3, 0.32);
                } else if (theme === 'theme-white-black') {
                    playThemeSound('sine', 200, 15, 0.25, 0.26);
                } else if (theme === 'theme-pinkcore') {
                    playThemeSound('triangle', 180, 12, 0.28, 0.34);
                } else if (theme === 'theme-hacker') {
                    playThemeSound('square', 100, 8, 0.2, 0.18);
                } else if (theme === 'theme-pixel') {
                    playThemeSound('square', 130, 10, 0.25, 0.28);
                } else {
                    playThemeSound('square', 150, 10, 0.3, 0.32);
                }
                break;
            case 'laser':
                if (theme === 'theme-ronk') {
                    playThemeSound('sawtooth', 800, 100, 0.2, 0.42);
                } else if (theme === 'theme-white-black') {
                    playThemeSound('sine', 1000, 150, 0.18, 0.36);
                } else if (theme === 'theme-pinkcore') {
                    playThemeSound('triangle', 900, 120, 0.2, 0.45);
                } else if (theme === 'theme-hacker') {
                    playThemeSound('square', 1200, 200, 0.15, 0.32);
                } else if (theme === 'theme-pixel') {
                    playThemeSound('square', 700, 80, 0.2, 0.4);
                } else {
                    playThemeSound('sawtooth', 800, 100, 0.2, 0.42);
                }
                break;
            case 'apple':
                if (theme === 'theme-ronk') {
                    playThemeSound('sine', 660, 880, 0.15, 0.18);
                } else if (theme === 'theme-white-black') {
                    playThemeSound('sine', 780, 1040, 0.12, 0.16);
                } else if (theme === 'theme-pinkcore') {
                    playThemeSound('triangle', 600, 900, 0.15, 0.2);
                } else if (theme === 'theme-hacker') {
                    playThemeSound('square', 500, 700, 0.1, 0.12);
                } else if (theme === 'theme-pixel') {
                    playThemeSound('square', 550, 750, 0.12, 0.16);
                } else {
                    playThemeSound('sine', 660, 880, 0.15, 0.18);
                }
                break;
            case 'skill':
                if (theme === 'theme-ronk') {
                    playThemeSound('sawtooth', 300, 600, 0.2, 0.26);
                } else if (theme === 'theme-white-black') {
                    playThemeSound('sine', 400, 800, 0.18, 0.22);
                } else if (theme === 'theme-pinkcore') {
                    playThemeSound('triangle', 350, 700, 0.2, 0.3);
                } else if (theme === 'theme-hacker') {
                    playThemeSound('square', 250, 500, 0.15, 0.18);
                } else if (theme === 'theme-pixel') {
                    playThemeSound('square', 280, 560, 0.18, 0.24);
                } else {
                    playThemeSound('sawtooth', 300, 600, 0.2, 0.26);
                }
                break;
        }
        // Manual branches (charge/hit/win/fall) don't always update trackDuration via playThemeSound
        if (type === 'charge' || type === 'hit' || type === 'fall') trackDuration = Math.max(trackDuration, 0.5);
        if (type === 'win') trackDuration = Math.max(trackDuration, 0.6);
        this._trackNode(type, trackedParts, trackDuration);
    }
};

const Music = {
    // HTMLAudioElement for decode/seek, routed once through Web Audio (centered
    // stereo → both ears) and kept alive via a dedicated AudioContext.
    ctx: null,
    masterGain: null,
    enabled: true,
    theme: null,
    currentAudio: null,
    currentFilename: null,
    audioCache: {},
    // Catalog of known BGM files (preload / eviction). Playback stays on the
    // active visual theme's track — do NOT rotate across themes on `ended`.
    playlist: Object.freeze([
        'tron.mp3',
        'My Movie 1.mp3',
        'top.mp3',
        'heck.mp3',
        'Pixelville.mp3',
        'gggg.mp3'
    ]),
    _wantPlaying: false,
    _playGeneration: 0,
    _lastStartAt: 0,
    _volumeFadeTimer: null,
    _watchdogTimer: null,
    _pausedByVisibility: false,
    _recoverAttempts: 0,
    _stallTicks: 0,
    _usingWebAudio: false,

    init() {
        if (!this.ctx) {
            try {
                // Dedicated context for music MediaElementSource — never share with SFX.
                this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (_) {
                this.ctx = null;
            }
        }
        if (this.ctx && !this.masterGain) {
            try {
                this.masterGain = this.ctx.createGain();
                this.masterGain.gain.value = this.getCombinedVolume();
                this.masterGain.connect(this.ctx.destination);
            } catch (_) {
                this.masterGain = null;
            }
        }
        this._resumeCtx();
        this._ensureWatchdog();
    },

    _resumeCtx() {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
            this.ctx.resume().catch(() => {});
        }
    },

    _ensureWatchdog() {
        if (this._watchdogTimer) return;
        this._watchdogTimer = setInterval(() => this._watchdogTick(), 2000);
    },

    _watchdogTick() {
        if (!this.enabled || !this._wantPlaying) return;
        if (typeof introFinished !== 'undefined' && !introFinished) return;
        // Keep healing music during game pause — theme BGM must continue
        if (typeof document !== 'undefined' && document.hidden) return;
        const inMatch = typeof document !== 'undefined' && document.body.classList.contains('in-game');
        if (inMatch) {
            const playing = this.currentAudio;
            if (playing && !playing.paused && !playing.ended) {
                this._stallTicks = 0;
                return;
            }
        }

        this._resumeCtx();

        // Kill any non-current track that somehow started (buzz source)
        Object.keys(this.audioCache).forEach((key) => {
            const a = this.audioCache[key];
            if (a && a !== this.currentAudio && !a.paused) {
                this._safePause(a, true);
            }
        });

        const audio = this.currentAudio;
        if (!audio) {
            this.play({ forceRestart: true });
            return;
        }

        this.setAudioVolume(audio, this.getCombinedVolume());

        // Stall detection: require 2 consecutive bad ticks (~4s) before recovering,
        // so large WAV buffering / loop seeks don't thrash into silence.
        const t = Number(audio.currentTime) || 0;
        const lastT = this._lastWatchTime;
        this._lastWatchTime = t;
        const timeAdvances = (typeof lastT === 'number') && (t > lastT + 0.015 || t < lastT - 0.35);
        const unexpectedlyPaused = audio.paused && !audio.ended;
        const ended = !!audio.ended;
        const frozenWhilePlaying = !audio.paused && !ended && typeof lastT === 'number' && !timeAdvances;
        const ctxDead = this._usingWebAudio && this.ctx && this.ctx.state !== 'running';

        if (unexpectedlyPaused || ended || frozenWhilePlaying || ctxDead) {
            this._stallTicks++;
            if (this._stallTicks < 2 && !ended && !unexpectedlyPaused) {
                this._resumeCtx();
                return;
            }
            this._recoverAttempts++;
            this._stallTicks = 0;
            if (this._recoverAttempts > 4) {
                this._recoverAttempts = 0;
                this._lastWatchTime = undefined;
                this.play({ forceRestart: true });
            } else if (ended) {
                this._restartLoop(audio);
            } else {
                this._resumeCtx();
                this.resume();
            }
            return;
        }
        this._stallTicks = 0;
        this._recoverAttempts = 0;
        // Heal cross-theme drift (playlist used to rotate into other themes)
        this.ensureThemeTrack({ quiet: true });
    },

    /** Keep Music.theme locked to the active body / currentThemeIndex theme. */
    syncThemeFromGame() {
        let theme = null;
        if (typeof themes !== 'undefined' && typeof currentThemeIndex !== 'undefined') {
            theme = themes[currentThemeIndex] || null;
        }
        if (!theme && typeof document !== 'undefined' && document.body) {
            const cls = [...document.body.classList].find((c) => c.startsWith('theme-'));
            if (cls) theme = cls;
        }
        if (theme) this.theme = theme;
        return this.theme;
    },

    expectedFilename() {
        this.syncThemeFromGame();
        return this.themeFilename(this.theme);
    },

    /** If the playing file isn't this theme's BGM, switch immediately. */
    ensureThemeTrack(opts = {}) {
        if (!this.enabled || !this._wantPlaying) return false;
        if (typeof introFinished !== 'undefined' && !introFinished) return false;
        const expected = this.expectedFilename();
        if (!expected) return false;
        if (this.currentFilename === expected && this.currentAudio && !this.currentAudio.paused && !this.currentAudio.ended) {
            return false;
        }
        if (opts.quiet && this.currentFilename === expected) {
            // Same file but paused/ended — resume path handles it
            return false;
        }
        this.playFile(expected, { forceRestart: true });
        return true;
    },

    _restartLoop(audio) {
        // Same theme track forever — seek + play (native loop is primary)
        const a = audio && this.currentAudio === audio ? audio : this.currentAudio;
        if (a) {
            try {
                a._rbAdvanceArmed = false;
                a.currentTime = 0;
            } catch (_) { /* ignore */ }
            this._resumeCtx();
            const p = a.play();
            if (p) {
                p.catch(() => {
                    const track = this.currentFilename || this.expectedFilename();
                    if (track) this.playFile(track, { forceRestart: true, fromEnded: true });
                });
                return;
            }
        }
        this.playNext({ fromEnded: true });
    },

    /** Re-loop current theme BGM when a track ends — stays visual-theme-locked. */
    playNext(opts = {}) {
        if (!this.enabled || !this._wantPlaying) return;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        // Collapses ended + timeupdate + watchdog double-fires into one advance
        if (this._lastAdvanceAt && (now - this._lastAdvanceAt) < 400) return;
        this._lastAdvanceAt = now;
        // Prefer in-place restart of the same element (smoother than stopAll thrash)
        if (opts.fromEnded && this.currentAudio && this.currentFilename) {
            const a = this.currentAudio;
            try {
                a.loop = true;
                a._rbAdvanceArmed = false;
                a.currentTime = 0;
            } catch (_) { /* ignore */ }
            this._resumeCtx();
            const p = a.play();
            if (p) {
                p.then(() => {
                    this._stallTicks = 0;
                    this._recoverAttempts = 0;
                }).catch(() => {
                    this.playFile(this.currentFilename, { forceRestart: true, fromEnded: true });
                });
                return;
            }
        }
        const themeTrack = this.expectedFilename();
        if (!themeTrack) {
            this.play({ forceRestart: true });
            return;
        }
        this.playFile(themeTrack, { forceRestart: true, fromEnded: !!opts.fromEnded });
    },

    // Soft-cap so hot masters (near 0 dBFS) don't crackle on some outputs
    getCombinedVolume() {
        try {
            const masterValue = readVolumePref('master', 70) / 100;
            const musicValue = readVolumePref('music', 60) / 100;
            return Math.max(0, Math.min(0.92, masterValue * musicValue));
        } catch (_) {
            return 0.42;
        }
    },

    setAudioVolume(audio, volume, { fadeMs = 0 } = {}) {
        const target = Math.max(0, Math.min(1, volume));
        if (this._volumeFadeTimer) {
            clearInterval(this._volumeFadeTimer);
            this._volumeFadeTimer = null;
        }
        // Always snap — theme switches must not fade in
        if (this._usingWebAudio && this.masterGain) {
            try {
                const g = this.masterGain.gain;
                const ctx = this.ctx;
                if (ctx && typeof g.cancelScheduledValues === 'function') {
                    g.cancelScheduledValues(ctx.currentTime);
                    g.setValueAtTime(target, ctx.currentTime);
                } else {
                    g.value = target;
                }
            } catch (_) {
                try { this.masterGain.gain.value = target; } catch (_) {}
            }
            if (audio) {
                try { audio.volume = 1; } catch (_) {}
            }
            return;
        }
        if (audio) {
            try { audio.volume = target; } catch (_) {}
        }
    },

    _safePause(audio, resetTime = false) {
        if (!audio) return;
        try {
            audio.pause();
            if (resetTime) {
                try { audio.currentTime = 0; } catch (_) {}
            }
        } catch (_) {}
    },

    /** Hard silence every cached element — prevents stacked buzz. */
    stopAll(resetTime = true) {
        Object.keys(this.audioCache).forEach((key) => {
            this._safePause(this.audioCache[key], resetTime);
        });
    },

    /**
     * Route element through Web Audio with a centered stereo path.
     * Avoid ChannelSplitter/Merger folds — on Safari/WebKit they can mute one ear.
     * Falls back to plain HTMLAudio if wiring fails.
     */
    _wireElement(audio) {
        if (!audio || audio._rbWired) return !!audio._rbWired;
        this.init();
        if (!this.ctx || !this.masterGain) return false;
        try {
            // createMediaElementSource can only be called once per element
            const src = this.ctx.createMediaElementSource(audio);
            // True stereo → both ears. StereoPanner(0) keeps the image centered.
            let node = src;
            if (typeof this.ctx.createStereoPanner === 'function') {
                const panner = this.ctx.createStereoPanner();
                panner.pan.value = 0;
                src.connect(panner);
                node = panner;
                audio._rbPanner = panner;
            }
            node.connect(this.masterGain);
            audio._rbWired = true;
            audio._rbMediaSource = src;
            this._usingWebAudio = true;
            try { audio.volume = 1; } catch (_) {}
            return true;
        } catch (e) {
            console.warn('Music WebAudio wire failed, using HTML path:', e && e.message);
            return false;
        }
    },

    _bindAudioGuards(audio, filename) {
        if (audio._musicGuardsBound) return;
        audio._musicGuardsBound = true;
        // Theme BGM must keep playing — native loop is the reliable path
        audio.loop = true;
        // metadata until play — same quality once playing, far less idle decode RAM
        audio.preload = 'metadata';

        audio.addEventListener('ended', () => {
            // Backup when engines ignore .loop (some MediaElementSource paths)
            if (!this.enabled || !this._wantPlaying) return;
            if (this.currentAudio !== audio) return;
            this._restartLoop(audio);
        });

        // Near-end backup only if loop somehow failed to re-arm
        audio.addEventListener('timeupdate', () => {
            if (!this.enabled || !this._wantPlaying) return;
            if (this.currentAudio !== audio || audio.paused) return;
            if (audio.loop) return;
            if (audio._rbAdvanceArmed) return;
            const dur = Number(audio.duration);
            if (!dur || !isFinite(dur) || dur < 1) return;
            if (audio.currentTime >= dur - 0.12) {
                audio._rbAdvanceArmed = true;
                this._restartLoop(audio);
            }
        });

        audio.addEventListener('error', (e) => {
            console.error('Music error:', filename, e);
            if (this._wantPlaying && this.currentFilename === filename) {
                setTimeout(() => {
                    if (this._wantPlaying) this.playNext({ fromEnded: true });
                }, 400);
            }
        });

        audio.addEventListener('stalled', () => {
            if (!this._wantPlaying || this.currentAudio !== audio) return;
            this._resumeCtx();
            const p = audio.play();
            if (p) p.catch(() => {});
        });

        audio.addEventListener('waiting', () => {
            if (!this._wantPlaying || this.currentAudio !== audio) return;
            this._resumeCtx();
        });

        audio.addEventListener('playing', () => {
            if (this.currentAudio === audio) {
                this._recoverAttempts = 0;
                this._stallTicks = 0;
                audio._rbAdvanceArmed = false;
                try { audio.loop = true; } catch (_) { /* ignore */ }
            }
        });
    },

    preload(filename) {
        if (!this.audioCache[filename]) {
            const audio = new Audio(filename);
            audio.preload = 'metadata';
            this._bindAudioGuards(audio, filename);
            // Wire MediaElementSource only on first play — wiring locks the element in RAM
            this.setAudioVolume(audio, this.getCombinedVolume());
            this.audioCache[filename] = audio;
        }
        return this.audioCache[filename];
    },

    /** Fully drop a track so Chromium can free decoded PCM. */
    _disposeAudioElement(audio) {
        if (!audio) return;
        this._safePause(audio, true);
        try {
            if (audio._rbPanner) {
                try { audio._rbPanner.disconnect(); } catch (_) {}
                audio._rbPanner = null;
            }
            if (audio._rbMediaSource) {
                try { audio._rbMediaSource.disconnect(); } catch (_) {}
                audio._rbMediaSource = null;
            }
        } catch (_) {}
        try {
            audio.removeAttribute('src');
            audio.src = '';
            audio.load();
        } catch (_) {}
        audio._rbWired = false;
        audio._rbAdvanceArmed = false;
    },

    /** Keep catalog theme tracks cached so cycling Theme is instant. */
    _evictIdleTracks(keepFilename) {
        const keep = new Set(this.playlist);
        if (keepFilename) keep.add(keepFilename);
        Object.keys(this.audioCache).forEach((key) => {
            if (keep.has(key)) return;
            const a = this.audioCache[key];
            if (!a) {
                delete this.audioCache[key];
                return;
            }
            if (a === this.currentAudio) return;
            this._disposeAudioElement(a);
            delete this.audioCache[key];
        });
    },

    changeTheme(theme) {
        this.theme = theme;
        const expected = this.themeFilename(theme);
        // Only skip restart when the CORRECT theme file is already playing
        if (
            expected
            && this.currentFilename === expected
            && this.currentAudio
            && !this.currentAudio.paused
            && this._wantPlaying
        ) {
            return;
        }
        if (this.enabled && typeof introFinished !== 'undefined' && introFinished && expected) {
            // Instant cut — keep cached tracks so the new song starts at full volume
            this.playFile(expected, { forceRestart: true, instant: true });
        } else {
            this.stop({ clearWant: false });
            this.currentAudio = null;
            this.currentFilename = null;
        }
    },

    themeFilename(theme) {
        switch (theme) {
            case 'theme-ronk': return 'tron.mp3';
            case 'theme-pinkcore': return 'My Movie 1.mp3';
            case 'theme-white-black': return 'top.mp3';
            case 'theme-hacker': return 'heck.mp3';
            case 'theme-pixel': return 'Pixelville.mp3';
            default: return null;
        }
    },

    play(opts = {}) {
        const forceRestart = !!opts.forceRestart;
        this.init();
        if (!this.enabled) return;
        if (typeof introFinished !== 'undefined' && !introFinished) return;

        this.syncThemeFromGame();
        if (!this.theme && typeof themes !== 'undefined' && typeof currentThemeIndex !== 'undefined') {
            this.theme = themes[currentThemeIndex];
        }

        const filename = this.themeFilename(this.theme);
        if (!filename) return;
        if (!this._catalogPreloaded) {
            this._catalogPreloaded = true;
            this.playlist.forEach((f) => {
                try {
                    const a = this.preload(f);
                    if (a && !a._rbWired) this._wireElement(a);
                } catch (_) { /* ignore */ }
            });
        }
        this.playFile(filename, { forceRestart });
    },

    playFile(filename, opts = {}) {
        const forceRestart = !!opts.forceRestart;
        try {
            this._wantPlaying = true;
            this._pausedByVisibility = false;
            this._resumeCtx();
            if (!this._catalogPreloaded) {
                this._catalogPreloaded = true;
                this.playlist.forEach((f) => {
                    try {
                        const a = this.preload(f);
                        if (a && !a._rbWired) this._wireElement(a);
                    } catch (_) { /* ignore */ }
                });
            }
            // Drop other themes first so peak decode RAM stays ~1 track
            this._evictIdleTracks(filename);
            const audio = this.preload(filename);
            if (!audio) {
                console.warn('Audio not found in cache, skipping:', filename);
                return;
            }
            if (!audio._rbWired) this._wireElement(audio);
            try { audio.preload = 'auto'; } catch (_) {}
            // Re-attach src if previously evicted
            if (!audio.src || audio.src === '' || audio.networkState === 0) {
                audio.src = filename;
                try { audio.load(); } catch (_) {}
            }

            // Packing sometimes shipped .wav only — fall back if .mp3 404s
            if (!audio._rbMissingFallback) {
                audio._rbMissingFallback = true;
                audio.addEventListener('error', () => {
                    if (!filename.toLowerCase().endsWith('.mp3')) return;
                    const wav = filename.replace(/\.mp3$/i, '.wav');
                    console.warn('[Music] Failed to load', filename, '— trying', wav);
                    delete this.audioCache[filename];
                    this.playFile(wav, { forceRestart: true });
                }, { once: true });
            }

            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const sameTrack = this.currentAudio === audio && this.currentFilename === filename;

            if (sameTrack && !audio.paused && !forceRestart) {
                this.setAudioVolume(audio, this.getCombinedVolume());
                return;
            }
            if (sameTrack && !forceRestart && audio.paused) {
                this.stopAll(false);
                this.currentAudio = audio;
                this.setAudioVolume(audio, this.getCombinedVolume());
                const playPromise = audio.play();
                if (playPromise) {
                    playPromise.catch((e) => {
                        if (e.name !== 'AbortError') {
                            console.warn('Music resume failed for ' + filename + ':', e.message);
                            this.play({ forceRestart: true });
                        }
                    });
                }
                return;
            }
            if (!forceRestart && sameTrack && (now - this._lastStartAt) < 280) {
                return;
            }

            const generation = ++this._playGeneration;

            this.stopAll(true);

            try { audio.currentTime = 0; } catch (_) {}

            this.currentAudio = audio;
            this.currentFilename = filename;
            try { audio.loop = true; } catch (_) { /* ignore */ }
            audio._rbAdvanceArmed = false;
            this.setAudioVolume(audio, this.getCombinedVolume());
            this._lastStartAt = now;
            this._lastWatchTime = undefined;
            this._stallTicks = 0;

            const playPromise = audio.play();
            if (playPromise) {
                playPromise.then(() => {
                    if (generation !== this._playGeneration) return;
                    this._evictIdleTracks(filename);
                }).catch((e) => {
                    if (generation !== this._playGeneration) return;
                    if (e.name !== 'AbortError') {
                        console.warn('Music play failed for ' + filename + ':', e.message);
                    }
                });
            } else {
                this._evictIdleTracks(filename);
            }
        } catch (e) {
            console.error('Error in playFile for ' + filename, e);
        }
    },

    /** Pause without resetting position (game pause / overlay). */
    pause() {
        this._wantPlaying = false;
        if (this.currentAudio) {
            this._safePause(this.currentAudio, false);
        }
        Object.keys(this.audioCache).forEach((key) => {
            const a = this.audioCache[key];
            if (a && a !== this.currentAudio && !a.paused) {
                this._safePause(a, true);
            }
        });
    },

    /** Resume current track, or start theme music if none. */
    resume() {
        if (!this.enabled) return;
        if (typeof introFinished !== 'undefined' && !introFinished) return;
        this._wantPlaying = true;
        this._pausedByVisibility = false;
        this.init();
        this._resumeCtx();
        // Never resume a track that belongs to a different theme
        if (this.ensureThemeTrack()) return;
        if (this.currentAudio) {
            // Restore src if eviction cleared it while paused on another theme path
            if (this.currentFilename && (!this.currentAudio.src || this.currentAudio.networkState === 0)) {
                this.currentAudio.src = this.currentFilename;
                try { this.currentAudio.load(); } catch (_) {}
            }
            Object.keys(this.audioCache).forEach((key) => {
                const a = this.audioCache[key];
                if (a && a !== this.currentAudio && !a.paused) {
                    this._safePause(a, true);
                }
            });
            this.setAudioVolume(this.currentAudio, this.getCombinedVolume());
            if (this.currentAudio.paused || this.currentAudio.ended) {
                const playPromise = this.currentAudio.play();
                if (playPromise) {
                    playPromise.catch(() => {
                        this.play({ forceRestart: true });
                    });
                }
            }
            return;
        }
        this.play({ forceRestart: true });
    },

    /** Ensure theme music is audible — recovers from silent/paused orphans. */
    ensurePlaying() {
        if (!this.enabled) return;
        if (typeof introFinished !== 'undefined' && !introFinished) return;
        // Allowed during game pause so BGM can keep playing / recover
        this._wantPlaying = true;
        this.init();
        this._resumeCtx();
        // Wrong-theme file still "playing" must be swapped before resume shortcuts
        if (this.ensureThemeTrack()) return;
        if (this.currentAudio && !this.currentAudio.paused && !this.currentAudio.ended) {
            this.setAudioVolume(this.currentAudio, this.getCombinedVolume());
            return;
        }
        if (this.currentAudio && (this.currentAudio.paused || this.currentAudio.ended)) {
            this.resume();
            return;
        }
        this.play({ forceRestart: true });
    },

    stop(opts = {}) {
        const clearWant = opts.clearWant !== false;
        if (clearWant) this._wantPlaying = false;
        this.stopAll(true);
    },

    isAudible() {
        return !!(this.currentAudio && !this.currentAudio.paused && this._wantPlaying);
    }
};

// Global Error Handler for debugging
window.onerror = function(msg, url, line, col, error) {
    console.error('GLOBAL ERROR:', msg, 'at', url, ':', line, ':', col, error);
    // alert('Game Error: ' + msg + '\nLine: ' + line); // Removed alert for Line 0 errors
    return false;
};

// --- CLASSES (HOISTED FOR INITIALIZATION) ---
class Player {
    constructor(x, y, color, controls, id, isAI = false) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.prevX = x;
        this.prevY = y;
        this.color = color;
        this.controls = controls;
        this.isAI = isAI;
        this.owner = id === 1 ? 'player' : 'enemy';
        this.dir = { x: 0, y: 0 };
        this.trail = [];
        this._trailPaintSet = new Set();
        this.boardSx = MIDDLE_BOARD_SX;
        this.boardSy = MIDDLE_BOARD_SY;
        this.isDead = false;
        this.isDashing = false;
        this.isCharging = false;
        this.lastDash = 0;
        this.lastCharge = 0;
        this.dashAnimTicks = 0;
        this.chargeAnimTicks = 0;
        this.chargeEffect = 0; 
        this.rollProgress = 1;
        this.ticksAlive = 0;
        this.inputQueue = [];
        this.deathType = 'hit'; // 'hit' or 'fall'
        this.deathAnimTicks = 0;
        this.deathOrder = -1;
        this.deathPos = null;
        this.moveBuffer = []; // For zero-delay rapid input
        this._lastDirKey = null;
        this._spawnGraceTicks = 0;
        this._landGraceTicks = 0;

        // --- SPECIAL SKILLS ---
        this.selectedSkill = null; // Chosen in UI
        this.lastSkillUsed = 0;
        this.activeSkill = null;
        this.skillTimer = 0; // Duration remaining
        this.isImmune = false;
        this.hasInvisibleTrail = false;
        this.infiniteTrailsActive = false;
        this.infiniteChargeActive = false;
        this.activeLaserRoutines = []; // Array of active laser routines (stackable!
        this.isClone = false;
        this.hasExtraLife = false;
        this.usedExtraLife = false;
        this.extraLives = 1; // Number of extra lives granted by extra-life joker
        this.jokerTrailTouchCount = {};
        this.jokerTrailBonusLength = 0;
        this.growTrailBonus = 0; // Permanent trail length bonus from eating apples this round
        this.friendlyWalls = [];
        this.secondSkill = null;
        this.jokerChargeBonus = 0;
        
        // --- HUNGER MECHANIC ---
        this.hungerTimer = 0; // Time since last apple eaten (in ticks)
        this.hungerDuration = 28 * TICK_RATE; // 28s — 12s starved rounds before anyone played the 9-board
        this.lastAppleEaten = Date.now(); // Timestamp of last apple eaten
        this.jokerDashNerf = 0;
        this.jokerDashBonus = 0;
        this.jokerBorderSafe = false;
        this.jokerTrailReduce = 0;
        this.jokerDisableEnemy = false;
        this.jokerDashNoCooldown = false;
        this.jokerCooldownReduce = 1; // Default 1 = no reduction, 0.5 = 50% faster cooldowns
        this.jokerNoHunger = false;
        this.jokerTrailGrowth = false; // Passive: +1 trail every 2.5s
        this.jokerTrailGrowthTicks = 0;
        this.jokerTrailGrowthRate = 1; // Multiplier for trail growth (1 = normal, 2 = double)
        this.jokerDoubleEffective = false; // Doubles effectiveness of other jokers
        this.fullInvisibleActive = false; // Active: hide cube+trail from enemies
        this.immuneTimer = 0;
    }

    // Mid-match round reset: reuse this object so huge Infinite Trails GC during freeze, not as new Player()
    resetForNewRound(x, y, color, controls, isAI = false) {
        this.x = x;
        this.y = y;
        this.prevX = x;
        this.prevY = y;
        this.color = color;
        if (controls) this.controls = controls;
        this.isAI = isAI;
        this.dir = { x: 0, y: 0 };
        if (typeof clearPlayerTrailState === 'function') clearPlayerTrailState(this);
        else {
            this.trail = [];
            if (this._trailPaintSet) this._trailPaintSet.clear();
        }
        this._frozenTrailRef = null;
        this.boardSx = MIDDLE_BOARD_SX;
        this.boardSy = MIDDLE_BOARD_SY;
        this.isDead = false;
        this.isDashing = false;
        this.isCharging = false;
        this.lastDash = 0;
        this.lastCharge = 0;
        this.dashAnimTicks = 0;
        this.chargeAnimTicks = 0;
        this.chargeEffect = 0;
        this.rollProgress = 1;
        this.ticksAlive = 0;
        this.inputQueue = [];
        this.deathType = 'hit';
        this.deathAnimTicks = 0;
        this.deathOrder = -1;
        this.deathPos = null;
        this.moveBuffer = [];
        this._lastDirKey = null;
        this._spawnGraceTicks = 0;
        this._landGraceTicks = 0;
        this.lastSkillUsed = 0;
        this.activeSkill = null;
        this.skillTimer = 0;
        this.isImmune = false;
        this.hasInvisibleTrail = false;
        this.infiniteTrailsActive = false;
        this.infiniteChargeActive = false;
        this.activeLaserRoutines = [];
        this.hasExtraLife = false;
        this.usedExtraLife = false;
        this.extraLives = 1;
        this.jokerTrailTouchCount = {};
        this.jokerTrailBonusLength = 0;
        this.growTrailBonus = 0;
        this.friendlyWalls = [];
        this.secondSkill = null;
        this.jokerChargeBonus = 0;
        this.hungerTimer = 0;
        this.hungerDuration = 28 * TICK_RATE;
        this.lastAppleEaten = Date.now();
        this.jokerDashNerf = 0;
        this.jokerDashBonus = 0;
        this.jokerBorderSafe = false;
        this.jokerTrailReduce = 0;
        this.jokerDisableEnemy = false;
        this.jokerDashNoCooldown = false;
        this.jokerCooldownReduce = 1;
        this.jokerNoHunger = false;
        this.jokerTrailGrowth = false;
        this.jokerTrailGrowthTicks = 0;
        this.jokerTrailGrowthRate = 1;
        this.jokerDoubleEffective = false;
        this.fullInvisibleActive = false;
        this.immuneTimer = 0;
        this._revived = false;
        this._aiRecentCells = [];
        this._missionSx = undefined;
        this._missionSy = undefined;
        this.aiThinkTicks = 0;
        this.aiAbilityTicks = 0;
        this._skillsUsed = 0;
        this._aiTravelTarget = null;
        this._aiBoardDwellTicks = 0;
        this._aiBoardKey = undefined;
        this._aiDashHist = [];
        this._aiLastChargeTick = -999;
        this._aiLastNonTravelDashTick = -999;
        this._aiLastBoardHopTick = -999;
        this._occGridTick = -1;
        this.tutorialFrozen = false;
    }

    update() {
        if (this.isDead) {
            this.deathAnimTicks++;
            return;
        }

        // Online remote cube: pose comes from peer packets — don't dual-sim movement
        if (this._netRemoteDriven && typeof isOnline !== 'undefined' && isOnline) {
            this.prevX = this.x;
            this.prevY = this.y;
            this.rollProgress = 1;
            if (this._spawnGraceTicks > 0) this._spawnGraceTicks--;
            if (this._landGraceTicks > 0) this._landGraceTicks--;
            if (this.dashAnimTicks > 0) this.dashAnimTicks--;
            if (this.chargeAnimTicks > 0) this.chargeAnimTicks--;
            if (this.immuneTimer > 0) {
                this.immuneTimer--;
                if (this.immuneTimer === 0) this.isImmune = false;
            }
            return;
        }

        // Round / match decided — freeze living cubes (death anim still runs above)
        if (typeof gameState !== 'undefined'
            && (gameState === 'GAME_OVER' || gameState === 'ROUND_OVER')) {
            // Kill interpolation smear: without this, rollProgress keeps oscillating
            // between prev/current and the cube flickers across neighboring tiles
            this.prevX = this.x;
            this.prevY = this.y;
            this.rollProgress = 1;
            if (this.dashAnimTicks > 0) this.dashAnimTicks--;
            if (this.chargeAnimTicks > 0) this.chargeAnimTicks--;
            if (this._landGraceTicks > 0) this._landGraceTicks--;
            return;
        }
        
        this.ticksAlive++;
        if (this._spawnGraceTicks > 0) this._spawnGraceTicks--;
        if (this._landGraceTicks > 0) this._landGraceTicks--;
        
        // --- HUNGER MECHANIC UPDATE ---
        const tutorialPractice = typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase();
        const tutorialFightWait = typeof isTutorialFightWaiting === 'function' && isTutorialFightWaiting();
        const hungerTutorial = typeof isTutorialHungerStep === 'function' && isTutorialHungerStep() && this === p1;
        if (!this.jokerNoHunger && ((!tutorialPractice && !tutorialFightWait) || hungerTutorial)) {
            this.hungerTimer++;
            if (this.hungerTimer >= this.hungerDuration) {
                // Player dies from hunger
                this.die('hunger');
            }
        }

        this.prevX = this.x;
        this.prevY = this.y;
        this.rollProgress = 0;

        // --- SKILL UPDATE ---
        if (this.skillTimer > 0) {
            this.skillTimer--;
            if (this.skillTimer === 0) {
                this.deactivateSkill();
            }
        }

        // Joker 9 (extra-life): Handle temporary immunity from extra life
        if (this.immuneTimer > 0) {
            this.immuneTimer--;
            if (this.immuneTimer === 0) {
                this.isImmune = false;
            }
        }

        // Charge Recovery Effect
        if (this.chargeEffect > 0) {
            this.chargeEffect *= 0.92;
            if (this.chargeEffect < 0.05) this.chargeEffect = 0;
        }

        if (this.isAI) {
            if (this.tutorialFrozen) return;
            if (typeof gameState !== 'undefined' && gameState === 'PLAYING') {
                const opponent = typeof resolveAIOpponent === 'function'
                    ? resolveAIOpponent(this)
                    : (String(this.id).startsWith('2') ? p1 : p2);
                if (opponent && typeof handleAdvancedAI !== 'undefined') {
                    try {
                        handleAdvancedAI(this, opponent, GRID_COUNT);
                    } catch (e) {
                        console.error('AI logic failed for player ' + this.id, e);
                        if (!this.dir || (this.dir.x === 0 && this.dir.y === 0)) {
                            this.dir = { x: 1, y: 0 };
                        }
                    }
                } else if (!this.dir || (this.dir.x === 0 && this.dir.y === 0)) {
                    this.dir = { x: 1, y: 0 };
                }
            } else if (!this.dir || (this.dir.x === 0 && this.dir.y === 0)) {
                // Keep bots moving after round transitions before PLAYING
                this.dir = { x: 1, y: 0 };
            }
        }

        const tutorialChargeHold = this === p1
            && typeof isTutorialChargePracticeStep === 'function'
            && isTutorialChargePracticeStep()
            && !this.isCharging
            && !this.isDashing
            && this.chargeAnimTicks <= 0
            && this.dashAnimTicks <= 0;
        if (tutorialChargeHold) {
            if (this.dashAnimTicks > 0) this.dashAnimTicks--;
            if (this.chargeAnimTicks > 0) this.chargeAnimTicks--;
            return;
        }

        const tutorialTrailDemo = this === p1
            && typeof isTutorialTrailDemoStep === 'function'
            && isTutorialTrailDemoStep()
            && !this.isDead;
        if (tutorialTrailDemo) {
            this._tutorialTrailTicks = (this._tutorialTrailTicks || 0) + 1;
            const freezeTicks = Math.round(1.2 * TICK_RATE);
            if (this._tutorialTrailTicks <= freezeTicks) {
                this.dir = { x: 0, y: 0 };
                if (this.dashAnimTicks > 0) this.dashAnimTicks--;
                if (this.chargeAnimTicks > 0) this.chargeAnimTicks--;
                return;
            }
            this.dir = { x: 1, y: 0 };
        }

        if (this.dir && (this.dir.x !== 0 || this.dir.y !== 0)) {
            if (!this.isClone && (this.ticksAlive & 1) === 0) SFX.play('move', 0.15);
            
            // Dashing and Charging don't leave a normal trail during the tick move, 
            // but we add a point for the starting position before the leap.
            if (!this.isDashing) {
                // Infinite Trails (passive): keep painting forever — trim never shortens below map cap
                if (this.selectedSkill === SKILL_TYPES.INFINITE_TRAILS) {
                    this.infiniteTrailsActive = true;
                }
                if (typeof pushPlayerTrailCell === 'function') {
                    pushPlayerTrailCell(this, this.x, this.y, this.boardSx, this.boardSy);
                } else {
                    this.trail.push({ x: this.x, y: this.y, boardSx: this.boardSx, boardSy: this.boardSy });
                    if (typeof trimPlayerTrail === 'function') trimPlayerTrail(this);
                }
            }

            const isCharge = this.isCharging;
            const isDash = this.isDashing;

            if (isCharge || isDash) {
                // Infinite charge adds +2 to distance (6.5 + 2 = 8.5)
                // Joker charge-plus adds +2 to distance
                const dist = isCharge
                    ? (this.infiniteChargeActive ? 8.5 : 6.5) + this.jokerChargeBonus
                    : (4 - this.jokerDashNerf) + (this.jokerDashBonus || 0);
                const opponent = String(this.id).startsWith('1') ? p2 : p1;
                
                for (let i = 0; i < Math.floor(dist); i++) {
                    const fromX = this.x;
                    const fromY = this.y;
                    this.x += this.dir.x;
                    this.y += this.dir.y;

                    // Dash/charge: cross into adjacent board (wrap at map edges)
                    if (typeof resolveSectorMove === 'function') {
                        resolveSectorMove(this, fromX, fromY, true);
                    } else {
                        if (this.x < 0) { this.x = GRID_COUNT - 1; this.prevX = this.x + 1; }
                        else if (this.x >= GRID_COUNT) { this.x = 0; this.prevX = -1; }
                        if (this.y < 0) { this.y = GRID_COUNT - 1; this.prevY = this.y + 1; }
                        else if (this.y >= GRID_COUNT) { this.y = 0; this.prevY = -1; }
                    }

                    // Register checkpoints on every cell the dash/charge passes through
                    if (typeof tryClaimCheckpointsAt === 'function') {
                        tryClaimCheckpointsAt(this);
                    }

                    // Charge always paints; dash paints only with Infinite Trails (passive forever trail)
                    if (isCharge || (isDash && typeof playerHasInfiniteTrails === 'function'
                        && playerHasInfiniteTrails(this))) {
                        if (isCharge) {
                            if (opponent && sameBoardCoords(this, opponent) && this.x === opponent.x && this.y === opponent.y && !opponent.isImmune) {
                                opponent.die('hit');
                                if (this === p1 && typeof notifyTutorialChargeHit === 'function') {
                                    notifyTutorialChargeHit();
                                }
                                // Stop charging if we hit them to avoid flying off the board after victory
                                break;
                            }
                            const enemyTrailIndex = opponent
                                ? opponent.trail.findIndex(t => t.x === this.x && t.y === this.y && sameBoardCoords(this, t))
                                : -1;
                            if (enemyTrailIndex !== -1) {
                                const cut = opponent.trail.splice(enemyTrailIndex, 1)[0];
                                if (cut && opponent._trailPaintSet) {
                                    opponent._trailPaintSet.delete(trailPaintKey(
                                        cut.x, cut.y, cut.boardSx, cut.boardSy
                                    ));
                                }
                            }
                        }
                        // Leave trail; Infinite Trails = never decay those cells
                        if (typeof pushPlayerTrailCell === 'function') {
                            pushPlayerTrailCell(this, this.x, this.y, this.boardSx, this.boardSy);
                        } else {
                            this.trail.push({ x: this.x, y: this.y, boardSx: this.boardSx, boardSy: this.boardSy });
                            if (typeof trimPlayerTrail === 'function') trimPlayerTrail(this);
                        }
                    }
                }
                
                if (isCharge) {
                    this.isCharging = false; 
                    this.chargeAnimTicks = 12;
                    this._landGraceTicks = Math.max(this._landGraceTicks || 0, Math.round(0.4 * TICK_RATE));
                    // Charge paints the landing cell under the head — strip it so self-trail
                    // collision doesn't KO the moment charge anim ends
                    if (typeof removePlayerTrailCellAt === 'function') {
                        removePlayerTrailCellAt(this, this.x, this.y, this.boardSx, this.boardSy);
                    }
                } else {
                    this.isDashing = false;
                    this.dashAnimTicks = 5;
                    this._landGraceTicks = Math.max(this._landGraceTicks || 0, Math.round(0.35 * TICK_RATE));
                    if (typeof playerHasInfiniteTrails === 'function' && playerHasInfiniteTrails(this)
                        && typeof removePlayerTrailCellAt === 'function') {
                        removePlayerTrailCellAt(this, this.x, this.y, this.boardSx, this.boardSy);
                    }
                }

            } else {
                const fromX = this.x;
                const fromY = this.y;
                this.x += this.dir.x;
                this.y += this.dir.y;
                // Walking into a sector border kills (border-safe slides along the rim)
                if (typeof resolveSectorMove === 'function') {
                    resolveSectorMove(this, fromX, fromY, false);
                } else if (this.jokerBorderSafe) {
                    this.x = Math.max(0, Math.min(GRID_COUNT - 1, this.x));
                    this.y = Math.max(0, Math.min(GRID_COUNT - 1, this.y));
                }
            }
        }

        // Laser logic: only the Laser skill owner fires waves (clones have no skill)
        if (!this.isClone && this.selectedSkill === SKILL_TYPES.LASER
            && Array.isArray(this.activeLaserRoutines) && this.activeLaserRoutines.length) {
            for (let i = this.activeLaserRoutines.length - 1; i >= 0; i--) {
                const routine = this.activeLaserRoutines[i];
                routine.ticks++;
                
                // Spawn 2 lines every 1 second
                if (routine.ticks % Math.round(TICK_RATE * 1) === 0) {
                    this.spawnLaserLine();
                }
                
                // Remove routine when duration expires
                if (routine.ticks >= routine.duration) {
                    this.activeLaserRoutines.splice(i, 1);
                }
            }
        } else if (this.isClone && Array.isArray(this.activeLaserRoutines) && this.activeLaserRoutines.length) {
            this.activeLaserRoutines.length = 0;
        }
        
        // TRAIL GROWTH Joker: +1 trail every 2.5s (faster with double effective)
        if (this.jokerTrailGrowth) {
            this.jokerTrailGrowthTicks++;
            const interval = Math.max(1, Math.round((TICK_RATE * 2.5) / Math.max(0.25, this.jokerTrailGrowthRate)));
            if (this.jokerTrailGrowthTicks % interval === 0) {
                this.growTrailBonus = Math.min(40, this.growTrailBonus + 1);
            }
        }
        
        if (this.dashAnimTicks > 0) this.dashAnimTicks--;
        if (this.chargeAnimTicks > 0) this.chargeAnimTicks--;

        // Claim checkpoints on the multi-board world
        if (typeof tryClaimCheckpointsAt === 'function') {
            tryClaimCheckpointsAt(this);
        }
        if (typeof notePlayerBoardPresence === 'function') {
            notePlayerBoardPresence(this);
        }
    }

    dash() {
        if (gameState !== 'PLAYING') return; // Lock abilities during countdown
        
        const now = Date.now();
        const effectiveDashCooldown = DASH_COOLDOWN * this.jokerCooldownReduce;
        if (now - this.lastDash > (this.jokerDashNoCooldown ? 0 : effectiveDashCooldown) && (this.dir.x !== 0 || this.dir.y !== 0)) {
            this.isDashing = true;
            this.lastDash = now;
            SFX.play('dash');
            if (this === p1) {
                notifyTutorialDash();
                if (!this.isAI) window.RonkSteamAchievements?.onDashUsed?.();
            }
        }
    }

    charge() {
        if (gameState !== 'PLAYING') return; // Lock abilities during countdown
        
        const now = Date.now();
        
        // Fix: Ensure infinite charge removal of cooldown works correctly
        // Joker 6 (short-trail): Enemy trail is reduced by 2 grids
        const tutorialNoChargeCooldown = this === p1
            && typeof isTutorialChargePracticeStep === 'function'
            && isTutorialChargePracticeStep();
        const baseCooldown = (this.infiniteChargeActive || tutorialNoChargeCooldown)
            ? 0
            : CHARGE_COOLDOWN * this.jokerCooldownReduce;
        const cooldown = baseCooldown;
        
        if (now - this.lastCharge > cooldown && (this.dir.x !== 0 || this.dir.y !== 0)) {
            this.isCharging = true;
            this.lastCharge = now;
            if (tutorialNoChargeCooldown) {
                this._tutorialChargeWhiffPending = true;
            }
            SFX.play('charge');
            if (this === p1 && !this.isAI) window.RonkSteamAchievements?.onChargeUsed?.();
        }
    }

    activateSkill(opts = null) {
        if (gameState !== 'PLAYING' || !this.selectedSkill) return;
        if (currentGamemode === 'simplistic') return; // Skills disabled in simplistic mode
        if (isPassiveSkill(this.selectedSkill)) return; // Always on from loadout — no activation

        // Clone cubes have no skill — never laser, never re-clone, never anything
        if (this.isClone) return;

        const now = Date.now();
        const tutorialSkillNoCooldown = this === p1
            && typeof isTutorialSkillPracticeStep === 'function'
            && isTutorialSkillPracticeStep();
        const effectiveSkillCooldown = tutorialSkillNoCooldown
            ? 0
            : getSkillCooldownMs(this) * this.jokerCooldownReduce;
        if (now - this.lastSkillUsed < effectiveSkillCooldown) return;
        if (this.selectedSkill === SKILL_TYPES.CLONES && countAliveClonesFor(this) >= MAX_CLONES_ALIVE) return;
        if (this.selectedSkill === SKILL_TYPES.LASER
            && Array.isArray(this.activeLaserRoutines)
            && this.activeLaserRoutines.length >= (
                (typeof isPerformanceMode === 'function' && isPerformanceMode()) ? 2 : MAX_LASER_ROUTINES
            )) return;

        this.lastSkillUsed = now;
        this.activeSkill = this.selectedSkill;
        SFX.play('skill', 1.2);
        if (this === p1 && !this.isAI) {
            window.RonkSteamAchievements?.onSkillUsed?.();
        }
        if (typeof notifySkillActivatedInMatch === 'function') {
            notifySkillActivatedInMatch(this.selectedSkill, this);
        }
        if (!opts?.fromRemote && typeof sendOnlineSkillActivate === 'function') {
            sendOnlineSkillActivate(this);
        }

        switch(this.activeSkill) {
            case SKILL_TYPES.INFINITE_CHARGE:
                this.infiniteChargeActive = true;
                this.skillTimer = 5 * TICK_RATE; // Infinite charge lasts 5 seconds
                break;
            case SKILL_TYPES.CLONES:
                this.spawnClones();
                this.skillTimer = 1;
                if (this === p1 && typeof notifyTutorialSkillUsed === 'function') {
                    notifyTutorialSkillUsed();
                }
                break;
            case SKILL_TYPES.INVISIBLE:
                // Activate ONLY: full cube+trail cloak for enemies — exactly 3 seconds
                this.hasInvisibleTrail = true;
                this.fullInvisibleActive = true;
                this.skillTimer = Math.round(INVISIBLE_FULL_DURATION_SEC * TICK_RATE);
                break;
            case SKILL_TYPES.INFINITE_TRAILS:
                // Passive only — should never reach here (blocked by isPassiveSkill)
                this.infiniteTrailsActive = true;
                this.skillTimer = 0;
                break;
            case SKILL_TYPES.LASER:
                // Stack a NEW wave — older routines keep firing until they expire
                this.activeLaserRoutines.push({
                    ticks: 0,
                    duration: 6 * TICK_RATE // Lasts 6 seconds total
                });
                this.skillTimer = 1; // Deactivate skill immediately
                break;
        }
    }

    deactivateSkill() {
        this.infiniteChargeActive = false;
        this.isImmune = false;
        this.activeSkill = null;
        this.fullInvisibleActive = false;
        // Passive skills stay on for the whole match
        if (this.selectedSkill === SKILL_TYPES.INFINITE_TRAILS) {
            this.infiniteTrailsActive = true;
        } else {
            this.infiniteTrailsActive = false;
        }
        // Passive trail cloak stays on while Invisible is equipped
        if (this.selectedSkill !== SKILL_TYPES.INVISIBLE) {
            this.hasInvisibleTrail = false;
        } else {
            this.hasInvisibleTrail = true;
        }
        // activeLaserRoutines stays - they expire on their own schedule!
    }

    spawnClones() {
        if (this._cloneSpawnLock) return;
        this._cloneSpawnLock = true;
        try {
            const timestamp = Date.now();
            const baseId = getPlayerBaseId(this.id);
            // Always fill up to 2 living clones (owner + 2 = 3 total). Never stop at 1.
            const slotsNeeded = Math.max(0, MAX_CLONES_ALIVE - countAliveClonesFor(this));
            if (slotsNeeded <= 0) return;

            const usedCells = new Set();
            let spawned = 0;
            const cellKey = (sx, sy, bsx, bsy) => `${bsx},${bsy},${sx},${sy}`;

            const enemyOnCell = (sx, sy, bsx, bsy) => {
                const on = (pl) => pl && !pl.isDead
                    && (Number.isInteger(pl.boardSx) ? pl.boardSx : MIDDLE_BOARD_SX) === bsx
                    && (Number.isInteger(pl.boardSy) ? pl.boardSy : MIDDLE_BOARD_SY) === bsy
                    && pl.x === sx && pl.y === sy
                    && getPlayerBaseId(pl.id) !== baseId;
                return on(p1) || on(p2);
            };

            const allyOnCell = (sx, sy, bsx, bsy, soft) => {
                if (sx === this.x && sy === this.y
                    && (this.boardSx ?? MIDDLE_BOARD_SX) === bsx
                    && (this.boardSy ?? MIDDLE_BOARD_SY) === bsy) {
                    return !soft; // hard-block owner tile unless last-resort soft
                }
                if (usedCells.has(cellKey(sx, sy, bsx, bsy))) return true;
                return clones.some(c => c && !c.isDead
                    && (c.ownerId === baseId || getPlayerBaseId(c.id) === baseId)
                    && (c.boardSx ?? MIDDLE_BOARD_SX) === bsx
                    && (c.boardSy ?? MIDDLE_BOARD_SY) === bsy
                    && c.x === sx && c.y === sy);
            };

            const pushClone = (sx, sy, bsx, bsy, off) => {
                const clone = new Player(sx, sy, this.color, {}, `${baseId}_clone_${spawned}_${timestamp}`, true);
                clone.isClone = true;
                clone.ownerId = baseId;
                clone.selectedSkill = null;
                clone.activeSkill = null;
                clone.activeLaserRoutines = [];
                clone.infiniteChargeActive = false;
                clone.fullInvisibleActive = false;
                clone.hasInvisibleTrail = false;
                clone.infiniteTrailsActive = false;
                clone.dir = this.dir && (this.dir.x !== 0 || this.dir.y !== 0)
                    ? { ...this.dir }
                    : { x: off?.x || 1, y: off?.y || 0 };
                clone.lastDash = Date.now();
                clone.lastCharge = Date.now();
                clone.lastSkillUsed = Date.now();
                clone.jokerNoHunger = true;
                clone.jokerTrailTouchCount = { ...this.jokerTrailTouchCount };
                clone.jokerTrailBonusLength = this.jokerTrailBonusLength;
                clone.jokerChargeBonus = this.jokerChargeBonus;
                clone.jokerDashNerf = this.jokerDashNerf;
                clone.jokerDashBonus = this.jokerDashBonus;
                clone.jokerBorderSafe = this.jokerBorderSafe;
                clone.jokerTrailReduce = this.jokerTrailReduce;
                clone.jokerDisableEnemy = this.jokerDisableEnemy;
                clone.jokerDashNoCooldown = this.jokerDashNoCooldown;
                clone.jokerCooldownReduce = this.jokerCooldownReduce;
                clone.jokerTrailGrowth = this.jokerTrailGrowth;
                clone.jokerTrailGrowthRate = this.jokerTrailGrowthRate;
                clone.jokerDoubleEffective = this.jokerDoubleEffective;
                clone.hasExtraLife = false;
                clone.usedExtraLife = false;
                clone.extraLives = 0;
                clone.aiDifficulty = this.aiDifficulty;
                clone.activeJokers = Array.isArray(this.activeJokers) ? [...this.activeJokers] : [];
                clone.boardSx = bsx;
                clone.boardSy = bsy;
                clone.prevX = sx;
                clone.prevY = sy;
                clone.rollProgress = 1;
                clone.aiPlaybook = 'spreader';
                clone.isImmune = true;
                clone.immuneTimer = Math.round(0.6 * TICK_RATE);
                clones.push(clone);
                if (typeof assignCloneBoardMission === 'function') {
                    assignCloneBoardMission(clone, this);
                }
                // Face the exit rim toward mission so the peel-off starts immediately
                if (Number.isInteger(clone._missionSx) && Number.isInteger(clone._missionSy)
                    && (clone._missionSx !== bsx || clone._missionSy !== bsy)
                    && typeof AI_HELPERS !== 'undefined' && AI_HELPERS.signedBoardDelta) {
                    const needDx = AI_HELPERS.signedBoardDelta(bsx, clone._missionSx);
                    const needDy = AI_HELPERS.signedBoardDelta(bsy, clone._missionSy);
                    if (needDx !== 0 || needDy !== 0) {
                        clone.dir = Math.abs(needDx) >= Math.abs(needDy)
                            ? { x: needDx < 0 ? -1 : 1, y: 0 }
                            : { x: 0, y: needDy < 0 ? -1 : 1 };
                    }
                }
                usedCells.add(cellKey(sx, sy, bsx, bsy));
                spawned++;
            };

            const tryPlaceOne = (originX, originY, bsx, bsy, soft) => {
                if (spawned >= slotsNeeded) return false;
                for (let radius = 1; radius <= 8; radius++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        for (let dy = -radius; dy <= radius; dy++) {
                            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                            const sx = originX + dx;
                            const sy = originY + dy;
                            if (sx < 0 || sx >= GRID_COUNT || sy < 0 || sy >= GRID_COUNT) continue;
                            if (enemyOnCell(sx, sy, bsx, bsy)) continue;
                            if (allyOnCell(sx, sy, bsx, bsy, soft)) continue;
                            pushClone(sx, sy, bsx, bsy, { x: dx || 1, y: dy });
                            return true;
                        }
                    }
                }
                return false;
            };

            const ownerSx = Number.isInteger(this.boardSx) ? this.boardSx : MIDDLE_BOARD_SX;
            const ownerSy = Number.isInteger(this.boardSy) ? this.boardSy : MIDDLE_BOARD_SY;

            // Pop out beside the owner on the same board, then AI peels off ASAP
            while (spawned < slotsNeeded && tryPlaceOne(this.x, this.y, ownerSx, ownerSy, false)) { /* fill near cube */ }
            // Soft: any free cell on owner board
            if (spawned < slotsNeeded) {
                for (let sy = 0; sy < GRID_COUNT && spawned < slotsNeeded; sy++) {
                    for (let sx = 0; sx < GRID_COUNT && spawned < slotsNeeded; sx++) {
                        if (enemyOnCell(sx, sy, ownerSx, ownerSy)) continue;
                        if (allyOnCell(sx, sy, ownerSx, ownerSy, false)) continue;
                        pushClone(sx, sy, ownerSx, ownerSy, { x: 1, y: 0 });
                    }
                }
            }
            // Last resort: force-place next to owner even on soft-blocked tiles (not on enemy)
            if (spawned < slotsNeeded) {
                const forced = [
                    { x: this.x + 1, y: this.y }, { x: this.x - 1, y: this.y },
                    { x: this.x, y: this.y + 1 }, { x: this.x, y: this.y - 1 },
                    { x: this.x + 1, y: this.y + 1 }, { x: this.x - 1, y: this.y - 1 },
                    { x: this.x + 2, y: this.y }, { x: this.x, y: this.y + 2 }
                ];
                for (const f of forced) {
                    if (spawned >= slotsNeeded) break;
                    let sx = f.x;
                    let sy = f.y;
                    if (sx < 0 || sx >= GRID_COUNT || sy < 0 || sy >= GRID_COUNT) continue;
                    if (enemyOnCell(sx, sy, ownerSx, ownerSy)) continue;
                    if (usedCells.has(cellKey(sx, sy, ownerSx, ownerSy))) continue;
                    pushClone(sx, sy, ownerSx, ownerSy, { x: Math.sign(sx - this.x) || 1, y: Math.sign(sy - this.y) });
                }
            }
        } finally {
            this._cloneSpawnLock = false;
        }
    }

    spawnLaserLine() {
        // Laser is a loadout skill — clone cubes never fire beams
        if (this.isClone || this.selectedSkill !== SKILL_TYPES.LASER) return;
        SFX.play('laser', 1.0); // Play at full volume
        if (typeof laserLines === 'undefined') return;

        const enemyRoot = (this === p1) ? p2 : ((this === p2) ? p1 : null);
        const enemyBase = enemyRoot ? getPlayerBaseId(enemyRoot.id) : null;
        const boardBuckets = new Map();

        const addEntity = (ent) => {
            if (!ent || ent.isDead) return;
            if (typeof ensurePlayerBoard === 'function') ensurePlayerBoard(ent);
            const bsx = Number.isInteger(ent.boardSx) ? ent.boardSx : MIDDLE_BOARD_SX;
            const bsy = Number.isInteger(ent.boardSy) ? ent.boardSy : MIDDLE_BOARD_SY;
            const key = `${bsx},${bsy}`;
            if (!boardBuckets.has(key)) {
                boardBuckets.set(key, {
                    boardSx: bsx,
                    boardSy: bsy,
                    ents: []
                });
            }
            boardBuckets.get(key).ents.push({
                x: Math.max(0, Math.min(GRID_COUNT - 1, Math.floor(ent.x))),
                y: Math.max(0, Math.min(GRID_COUNT - 1, Math.floor(ent.y)))
            });
        };

        addEntity(enemyRoot);
        if (enemyBase && typeof clones !== 'undefined' && Array.isArray(clones)) {
            for (let i = 0; i < clones.length; i++) {
                const c = clones[i];
                if (!c || c.isDead) continue;
                if (getPlayerBaseId(c.id) === enemyBase || c.ownerId === enemyBase) addEntity(c);
            }
        }

        let boards = [...boardBuckets.values()];
        if (!boards.length) {
            if (typeof ensurePlayerBoard === 'function') ensurePlayerBoard(this);
            boards = [{
                boardSx: Number.isInteger(this.boardSx) ? this.boardSx : MIDDLE_BOARD_SX,
                boardSy: Number.isInteger(this.boardSy) ? this.boardSy : MIDDLE_BOARD_SY,
                ents: [{
                    x: Math.max(0, Math.min(GRID_COUNT - 1, Math.floor(this.x))),
                    y: Math.max(0, Math.min(GRID_COUNT - 1, Math.floor(this.y)))
                }]
            }];
        }

        const pushShot = (board, isHorizontal, pos) => {
            const shot = {
                isHorizontal,
                pos: Math.max(0, Math.min(GRID_COUNT - 1, pos)),
                boardSx: board.boardSx,
                boardSy: board.boardSy,
                owner: this,
                ownerId: getPlayerBaseId(this.id),
                color: this.color || '#ffffff',
                ticks: 0,
                warningTicks: Math.round(TICK_RATE * 0.5)
            };
            laserLines.push(shot);
            // Remote cubes don't sim lasers — broadcast so both screens see enemy beams
            try {
                if (typeof isOnline !== 'undefined' && isOnline && !this._netRemoteDriven
                    && typeof sendOnlineLaserSpawn === 'function') {
                    sendOnlineLaserSpawn(shot);
                }
            } catch (_) { /* ignore */ }
        };

        // Classic cross look: on one enemy board fire H+V through them.
        // Multiple enemy boards (clones): split the 2 lines across those boards.
        if (boards.length === 1) {
            const board = boards[0];
            const ent = board.ents[Math.floor(Math.random() * board.ents.length)] || board.ents[0];
            pushShot(board, true, ent.y);
            pushShot(board, false, ent.x);
        } else {
            // Round-robin the classic 2-line budget across boards with enemy cubes
            for (let i = 0; i < 2; i++) {
                const board = boards[i % boards.length];
                const ent = board.ents[Math.floor(Math.random() * board.ents.length)] || board.ents[0];
                const isHorizontal = (i % 2 === 0);
                pushShot(board, isHorizontal, isHorizontal ? ent.y : ent.x);
            }
        }
    }

    die(type = 'hit', cause = '') {
        // Round-start / land grace: block hit + shatter (falls still resolve separately)
        if (this._spawnGraceTicks > 0 || this._landGraceTicks > 0) {
            if (type === 'hit' || type === 'shatter') return;
        }

        const playDeathSfx = (deathType) => {
            if (deathType === 'fall') SFX.play('fall', 1.1);
            else if (deathType === 'shatter') SFX.play('shatter', 1.0);
            else SFX.play('hit', 1.0);
        };
        // Joker 9 (extra-life): survive first death from hit / fall / shatter / hunger
        const extraLifeTypes = type === 'hit' || type === 'fall' || type === 'shatter' || type === 'hunger';
        if (this.hasExtraLife && this.extraLives > 0 && extraLifeTypes) {
            this.extraLives--;
            if (this.extraLives === 0) {
                this.hasExtraLife = false;
            }
            // Revive with 1 second immunity (clamp onto board after a fall)
            this.isDead = false;
            this.x = Math.max(0, Math.min(GRID_COUNT - 1, Number.isFinite(this.prevX) ? this.prevX : this.x));
            this.y = Math.max(0, Math.min(GRID_COUNT - 1, Number.isFinite(this.prevY) ? this.prevY : this.y));
            if (typeof ensurePlayerBoard === 'function') ensurePlayerBoard(this);
            this.isImmune = true;
            this.immuneTimer = Math.round(1 * TICK_RATE); // 1 second immunity
            playDeathSfx(type === 'fall' ? 'fall' : (type === 'shatter' ? 'shatter' : 'hit'));
            return;
        }
        if (!this.isDead) {
            this.isDead = true;
            this.deathType = type;
            this.deathCause = cause || type || '';
            this.deathAnimTicks = 0;
            this.deathOrder = ++deathCounter;
            
            // Lock current visual position for the animation to prevent jitter
            this.deathPos = {
                x: this.prevX + (this.x - this.prevX) * this.rollProgress,
                y: this.prevY + (this.y - this.prevY) * this.rollProgress
            };
            
            playDeathSfx(type);
            try {
                if (typeof notifyLocalDeathCause === 'function') {
                    notifyLocalDeathCause(this, type, cause);
                }
            } catch (_) { /* ignore */ }
        }
    }

    draw(mode = 'all') {
        if (this.isDead && this.deathAnimTicks > 120) return;
        const wantTrails = mode !== 'body';
        const wantBody = mode !== 'trails';

        const isLocalHumanCube = isOnline
            ? (onlineRole === 'guest' ? this === p2 : this === p1)
            : this === p1;
        const currentActiveImg = this.customImage
            || (isLocalHumanCube && currentColorIndex === neonColors.length - 1 ? playerImage : null);

        const runAtBoard = (off, fn) => {
            if (!off || !off.visible) return;
            if (typeof withBoardWorldOffset === 'function') withBoardWorldOffset(off.ox, off.oy, fn);
            else fn();
        };

        // Trails: draw on view board + any visible neighbor peek edges
        // Invisible: enemies can't see trail; you / spectate see a LIGHT tint of your colour (passive feedback)
        const showTrail = wantTrails && (typeof canLocalViewerSeePlayerVisuals !== 'function'
            || canLocalViewerSeePlayerVisuals(this, 'trail'));
        if (showTrail) {
            const len = this.trail.length;
            const invisTrailFeedback = typeof playerHasPassiveInvisibleTrail === 'function'
                && playerHasPassiveInvisibleTrail(this);
            const trailColor = invisTrailFeedback
                ? (typeof getInvisibleSelfFeedbackColor === 'function'
                    ? getInvisibleSelfFeedbackColor(this.color, this)
                    : this.adjustColor(this.color, 72))
                : this.color;
            const trailAlphaMul = invisTrailFeedback ? 0.55 : 1;
            if (len > 0) {
                // Infinite Trails must draw every cell (stride skips look like dash ghosts)
                const hasInf = typeof playerHasInfiniteTrails === 'function'
                    ? playerHasInfiniteTrails(this)
                    : !!(this.infiniteTrailsActive || this.selectedSkill === 'infinite-trails');
                const stride = hasInf ? 1
                    : (typeof isPerformanceMode === 'function' && isPerformanceMode()
                        ? (len > 80 ? 4 : (len > 40 ? 3 : 2))
                        : ((typeof getFrameBudgetTier === 'function' && getFrameBudgetTier() !== 'low'
                            && typeof renderScale === 'number' && renderScale >= 1.0)
                            ? (len > 180 ? 2 : 1)
                            : (len > 120 ? 3 : (len > 60 ? 2 : 1))));
                const vsx = typeof viewBoardSx === 'number' ? viewBoardSx : 1;
                const vsy = typeof viewBoardSy === 'number' ? viewBoardSy : 1;
                // Infinite Trails = painted floor at full strength. Age-fade + 'lighter'
                // made a 200-cell path look like a 3-cell dash ghost in spectate.
                const useTexTrail = currentActiveImg && !invisTrailFeedback && !hasInf;
                if (useTexTrail) {
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter';
                    
                    for (let index = 0; index < len; index += stride) {
                        const pos = this.trail[index];
                        const psx = Number.isInteger(pos.boardSx) ? pos.boardSx : vsx;
                        const psy = Number.isInteger(pos.boardSy) ? pos.boardSy : vsy;
                        if (Math.abs(psx - vsx) > 1 || Math.abs(psy - vsy) > 1) continue;
                        const trailProgress = (index + 1) / len;
                        const alpha = 0.4 + (trailProgress * 0.6);
                        if (psx === vsx && psy === vsy) {
                            ctx.globalAlpha = alpha * 0.6;
                            const p1_p = project(pos.x * GRID_SIZE - 2, pos.y * GRID_SIZE - 2, 0, draw2dQuad[0]);
                            const p2_p = project(pos.x * GRID_SIZE + GRID_SIZE + 2, pos.y * GRID_SIZE - 2, 0, draw2dQuad[1]);
                            const p3_p = project(pos.x * GRID_SIZE + GRID_SIZE + 2, pos.y * GRID_SIZE + GRID_SIZE + 2, 0, draw2dQuad[2]);
                            const p4_p = project(pos.x * GRID_SIZE - 2, pos.y * GRID_SIZE + GRID_SIZE + 2, 0, draw2dQuad[3]);
                            this.drawTexturedFace(p1_p, p2_p, p3_p, p4_p, currentActiveImg);
                            continue;
                        }
                        const off = typeof getBoardVisualOffset === 'function'
                            ? getBoardVisualOffset(psx, psy)
                            : { ox: 0, oy: 0, ndx: 0, ndy: 0, visible: isOnViewBoard(pos) };
                        if (!off.visible) continue;
                        if (typeof isLocalCellInNeighborPeek === 'function'
                            && !isLocalCellInNeighborPeek(off.ndx, off.ndy, pos.x, pos.y)) continue;
                        runAtBoard(off, () => {
                            ctx.globalAlpha = alpha * 0.6;
                            const p1_p = project(pos.x * GRID_SIZE - 2, pos.y * GRID_SIZE - 2, 0, draw2dQuad[0]);
                            const p2_p = project(pos.x * GRID_SIZE + GRID_SIZE + 2, pos.y * GRID_SIZE - 2, 0, draw2dQuad[1]);
                            const p3_p = project(pos.x * GRID_SIZE + GRID_SIZE + 2, pos.y * GRID_SIZE + GRID_SIZE + 2, 0, draw2dQuad[2]);
                            const p4_p = project(pos.x * GRID_SIZE - 2, pos.y * GRID_SIZE + GRID_SIZE + 2, 0, draw2dQuad[3]);
                            this.drawTexturedFace(p1_p, p2_p, p3_p, p4_p, currentActiveImg);
                        });
                    }
                    
                    ctx.restore();
                } else if (hasInf && currentThemeIndex != null && themes[currentThemeIndex] !== 'theme-pixel' && themes[currentThemeIndex] !== 'theme-hacker') {
                    // Same pixels as per-cell draw2D — one fill per board instead of hundreds
                    const infAlpha = 0.92 * trailAlphaMul;
                    const baseKey = [
                        vsx, vsy, trailColor, infAlpha,
                        floorQuadCacheEpoch || '', viewW, viewH, GRID_COUNT
                    ].join('|');
                    let pack = this._infFloorPack;
                    const canAppend = pack
                        && pack.baseKey === baseKey
                        && pack.layerMap
                        && pack.len < len
                        && len - pack.len <= 4;
                    if (canAppend) {
                        for (let ai = pack.len; ai < len; ai++) {
                            const pos = this.trail[ai];
                            const psx = Number.isInteger(pos.boardSx) ? pos.boardSx : vsx;
                            const psy = Number.isInteger(pos.boardSy) ? pos.boardSy : vsy;
                            if (Math.abs(psx - vsx) > 1 || Math.abs(psy - vsy) > 1) continue;
                            const layerKey = psx + ',' + psy;
                            let layer = pack.layerMap.get(layerKey);
                            if (!layer) {
                                layer = { path: new Path2D() };
                                pack.layers.push(layer);
                                pack.layerMap.set(layerKey, layer);
                            }
                            const q = typeof getCachedFloorQuad === 'function'
                                ? getCachedFloorQuad(pos.x, pos.y)
                                : null;
                            if (!q) continue;
                            const path = layer.path;
                            if (psx === vsx && psy === vsy) {
                                path.moveTo(q[0].x, q[0].y);
                                path.lineTo(q[1].x, q[1].y);
                                path.lineTo(q[2].x, q[2].y);
                                path.lineTo(q[3].x, q[3].y);
                                path.closePath();
                            } else {
                                const off = typeof getBoardVisualOffset === 'function'
                                    ? getBoardVisualOffset(psx, psy)
                                    : { ox: 0, oy: 0, ndx: 0, ndy: 0, visible: false };
                                if (!off.visible) continue;
                                if (typeof isLocalCellInNeighborPeek === 'function'
                                    && !isLocalCellInNeighborPeek(off.ndx, off.ndy, pos.x, pos.y)) continue;
                                runAtBoard(off, () => {
                                    path.moveTo(q[0].x, q[0].y);
                                    path.lineTo(q[1].x, q[1].y);
                                    path.lineTo(q[2].x, q[2].y);
                                    path.lineTo(q[3].x, q[3].y);
                                    path.closePath();
                                });
                            }
                        }
                        pack.len = len;
                    } else {
                    const packKey = baseKey + '|' + len;
                    if (!pack || pack.key !== packKey) {
                        const byBoard = new Map();
                        for (let i = 0; i < len; i++) {
                            const pos = this.trail[i];
                            const psx = Number.isInteger(pos.boardSx) ? pos.boardSx : vsx;
                            const psy = Number.isInteger(pos.boardSy) ? pos.boardSy : vsy;
                            if (Math.abs(psx - vsx) > 1 || Math.abs(psy - vsy) > 1) continue;
                            const key = psx + ',' + psy;
                            let bucket = byBoard.get(key);
                            if (!bucket) {
                                bucket = { psx, psy, cells: [] };
                                byBoard.set(key, bucket);
                            }
                            bucket.cells.push(pos);
                        }
                        const layers = [];
                        const layerMap = new Map();
                        byBoard.forEach((bucket) => {
                            let cells = bucket.cells;
                            const isHome = bucket.psx === vsx && bucket.psy === vsy;
                            let off = null;
                            if (!isHome) {
                                off = typeof getBoardVisualOffset === 'function'
                                    ? getBoardVisualOffset(bucket.psx, bucket.psy)
                                    : { ox: 0, oy: 0, ndx: 0, ndy: 0, visible: false };
                                if (!off.visible) return;
                                if (typeof isLocalCellInNeighborPeek === 'function') {
                                    cells = cells.filter((pos) => isLocalCellInNeighborPeek(off.ndx, off.ndy, pos.x, pos.y));
                                }
                                if (!cells.length) return;
                            }
                            const path = new Path2D();
                            const build = () => {
                                for (let c = 0; c < cells.length; c++) {
                                    const q = typeof getCachedFloorQuad === 'function'
                                        ? getCachedFloorQuad(cells[c].x, cells[c].y)
                                        : null;
                                    if (!q) continue;
                                    path.moveTo(q[0].x, q[0].y);
                                    path.lineTo(q[1].x, q[1].y);
                                    path.lineTo(q[2].x, q[2].y);
                                    path.lineTo(q[3].x, q[3].y);
                                    path.closePath();
                                }
                            };
                            if (isHome) build();
                            else runAtBoard(off, build);
                            const layer = { path };
                            layers.push(layer);
                            layerMap.set(bucket.psx + ',' + bucket.psy, layer);
                        });
                        pack = { key: packKey, baseKey, len, layers, layerMap };
                        this._infFloorPack = pack;
                    }
                    }
                    const fillCol = getCachedRgba(trailColor, infAlpha);
                    for (let li = 0; li < pack.layers.length; li++) {
                        ctx.fillStyle = fillCol;
                        ctx.fill(pack.layers[li].path);
                    }
                } else {
                    for (let i = 0; i < len; i += stride) {
                        const pos = this.trail[i];
                        const psx = Number.isInteger(pos.boardSx) ? pos.boardSx : vsx;
                        const psy = Number.isInteger(pos.boardSy) ? pos.boardSy : vsy;
                        if (Math.abs(psx - vsx) > 1 || Math.abs(psy - vsy) > 1) continue;
                        const trailProgress = (i + 1) / len;
                        const alpha = hasInf
                            ? 0.92 * trailAlphaMul
                            : (0.4 + (trailProgress * 0.6)) * trailAlphaMul;
                        if (psx === vsx && psy === vsy) {
                            this.draw2D(pos.x, pos.y, trailColor, alpha);
                            continue;
                        }
                        const off = typeof getBoardVisualOffset === 'function'
                            ? getBoardVisualOffset(psx, psy)
                            : { ox: 0, oy: 0, ndx: 0, ndy: 0, visible: isOnViewBoard(pos) };
                        if (!off.visible) continue;
                        if (typeof isLocalCellInNeighborPeek === 'function'
                            && !isLocalCellInNeighborPeek(off.ndx, off.ndy, pos.x, pos.y)) continue;
                        runAtBoard(off, () => this.draw2D(pos.x, pos.y, trailColor, alpha));
                    }
                }
            }
        }

        if (!wantBody) {
            ctx.globalAlpha = 1.0;
            return;
        }

        const selfOff = typeof getBoardVisualOffset === 'function'
            ? getBoardVisualOffset(this.boardSx, this.boardSy)
            : { ox: 0, oy: 0, ndx: 0, ndy: 0, visible: isOnViewBoard(this) };
        const rollT = this.rollProgress || 0;
        const peekX = this.prevX + (this.x - this.prevX) * rollT;
        const peekY = this.prevY + (this.y - this.prevY) * rollT;
        const cubeOnPeek = selfOff.visible && (
            (typeof isLocalCellInNeighborPeek !== 'function')
            || isLocalCellInNeighborPeek(selfOff.ndx, selfOff.ndy, peekX, peekY)
            || isLocalCellInNeighborPeek(selfOff.ndx, selfOff.ndy, this.x, this.y)
            || isLocalCellInNeighborPeek(selfOff.ndx, selfOff.ndy, this.prevX, this.prevY)
        );
        if (!cubeOnPeek) {
            ctx.globalAlpha = 1.0;
            return;
        }

        // Full invis: enemies can't see your cube; you still can
        const showCube = typeof canLocalViewerSeePlayerVisuals !== 'function'
            || canLocalViewerSeePlayerVisuals(this, 'cube');
        if (!showCube) {
            ctx.globalAlpha = 1.0;
            return;
        }

        runAtBoard(selfOff, () => {
            // Optimization: Draw dash ghosts only if needed
            if (this.dashAnimTicks > 0 && this.trail.length > 0) {
                const opacity = this.dashAnimTicks / 5;
                const ghostCount = Math.min(3, this.trail.length);
                for (let i = 1; i <= ghostCount; i++) {
                    const pos = this.trail[this.trail.length - i];
                    if (!pos) continue;
                    const gOff = typeof getBoardVisualOffset === 'function'
                        ? getBoardVisualOffset(pos.boardSx, pos.boardSy)
                        : selfOff;
                    if (!gOff.visible) continue;
                    if (typeof isLocalCellInNeighborPeek === 'function'
                        && !isLocalCellInNeighborPeek(gOff.ndx, gOff.ndy, pos.x, pos.y)) continue;
                    const alpha = opacity * (1 - i / (ghostCount + 1)) * 0.3;
                    // Ghosts on same board as cube already have selfOff applied; other-board ghosts need nested offset
                    if (gOff.ox === selfOff.ox && gOff.oy === selfOff.oy) {
                        this.draw2D(pos.x, pos.y, '#ffffff', alpha);
                    } else if (typeof withBoardWorldOffset === 'function') {
                        // Temporarily swap to ghost board (outer offset already set — compose absolute)
                        withBoardWorldOffset(gOff.ox, gOff.oy, () => this.draw2D(pos.x, pos.y, '#ffffff', alpha));
                    }
                }
            }

            ctx.globalAlpha = 1.0;
            let cubeColor = this.color;
            const fullInvisActive = typeof playerHasActiveFullInvisibility === 'function'
                && playerHasActiveFullInvisibility(this);
            // Activate feedback for self/spectate: cube goes light tint while full cloak is on
            if (fullInvisActive) {
                cubeColor = typeof getInvisibleSelfFeedbackColor === 'function'
                    ? getInvisibleSelfFeedbackColor(this.color, this)
                    : this.adjustColor(this.color, 72);
            }
            if (this.dashAnimTicks > 0) {
                cubeColor = '#fff';
            } else if (this.chargeAnimTicks > 0) {
                cubeColor = this.chargeAnimTicks % 2 === 0 ? '#fff' : cubeColor;
            }

            const t = this.rollProgress;
            const curX = this.prevX + (this.x - this.prevX) * t;
            const curY = this.prevY + (this.y - this.prevY) * t;
            
            if (this.isDead) {
                this.drawDeathAnim(curX, curY, cubeColor, currentActiveImg);
            } else {
                if (this.isImmune) {
                    const hue = (Date.now() / 3) % 360;
                    cubeColor = `hsl(${hue}, 100%, 55%)`;
                }
                if (fullInvisActive && !this.isImmune && this.dashAnimTicks <= 0) {
                    ctx.globalAlpha = 0.72;
                }
                this.drawCube(curX, curY, cubeColor, !this.isAI, currentActiveImg);
                ctx.globalAlpha = 1.0;
            }
        });
    }

    drawDeathAnim(gx, gy, color, customImg = null) {
        // Use alpha for smooth sub-tick animation
        const t = this.deathAnimTicks + (accumulator / tickDuration);
        const currentTheme = themes[currentThemeIndex];
        
        // Use the locked death position to prevent jitter
        const curX = this.deathPos ? this.deathPos.x : gx;
        const curY = this.deathPos ? this.deathPos.y : gy;

        if (this.deathType === 'fall') {
            const fallProgress = t / 120;
            const opacity = Math.max(0, 1 - fallProgress);
            
            // Only 1 shard (the cube itself) falling down
            const fallZ = t * 15 + (fallProgress * fallProgress * 5000); // Faster fall speed
            
            // Move outwards based on the direction they fell to fall outside the board
            const moveOutX = (this.dir.x || 0) * t * 10;
            const moveOutY = (this.dir.y || 0) * t * 10;
            
            const sx = curX * GRID_SIZE + GRID_SIZE/2 + moveOutX;
            const sy = curY * GRID_SIZE + GRID_SIZE/2 + moveOutY;
            const sz = -GRID_SIZE/2 + fallZ;
            
            this.draw3DShard(sx, sy, sz, GRID_SIZE, color, opacity, t * 0.08, t * 0.03, 0, customImg);
        } else {
            const shardCount = 4; // Only 4 clean cube shards
            const explosionDuration = 120;
            const explosionProgress = t / explosionDuration;
            const opacity = Math.max(0, 1 - explosionProgress);
            
            for (let i = 0; i < shardCount; i++) {
                const seed = this.id * 5000 + i;
                const angle = (i / shardCount) * Math.PI * 2 + (Math.sin(seed) * 0.5);
                const verticalAngle = -Math.PI / 4 + (Math.sin(seed * 2) * 0.2);
                const speed = 10 + Math.sin(seed * 2.1) * 3; // Slightly faster shards
                const dist = t * speed;
                
                // Parabolic trajectory (falling)
                const sx = curX * GRID_SIZE + GRID_SIZE/2 + Math.cos(angle) * dist;
                const sy = curY * GRID_SIZE + GRID_SIZE/2 + Math.sin(angle) * dist;
                // Heavy gravity fall
                const sz = -GRID_SIZE/2 + Math.sin(verticalAngle) * dist + (0.8 * t * t); // Increased gravity multiplier from 0.5 to 0.8
                
                const shardSize = GRID_SIZE / 2; // Each shard is half the cube size
                const rotX = t * 0.1 + seed;
                const rotY = t * 0.08 + seed * 0.5;

                if (opacity > 0) {
                    this.draw3DShard(sx, sy, sz, shardSize, color, opacity, rotX, rotY, i, customImg);
                }
            }
        }
    }

    draw3DShard(sx, sy, sz, shardSize, color, opacity, rotX, rotY, seed, customImg = null) {
        const currentTheme = themes[currentThemeIndex];
        const s = shardSize;
        
        // Always use perfect cube vertices for "normal cubes"
        const shardBaseVertices = baseVertices; 
        
        const cosY = Math.cos(rotY);
        const sinY = Math.sin(rotY);
        const cosX = Math.cos(rotX);
        const sinX = Math.sin(rotX);

        // OPTIMIZATION: Reuse pre-allocated projected verts / depth buffer
        const projected = shardProjectedVerts;
        const worldZ = shardWorldZ;

        for (let i = 0; i < 8; i++) {
            const v = shardBaseVertices[i];
            const vx = v.x * s;
            const vy = v.y * s;
            const vz = v.z * s;
            
            // Rotate
            let x1 = vx * cosY - vz * sinY;
            let z1 = vx * sinY + vz * cosY;
            let y1 = vy * cosX - z1 * sinX;
            let z2 = vy * sinX + z1 * cosX;
            
            // Translate
            const wx = x1 + sx;
            const wy = y1 + sy;
            const wz = z2 + sz;
            worldZ[i] = wz;
            project(wx, wy, wz, projected[i]);
        }

        const faces = [
            { indices: [0, 1, 2, 3], color: color },
            { indices: [4, 5, 1, 0], color: this.adjustColor(color, -15) },
            { indices: [5, 6, 2, 1], color: this.adjustColor(color, -30) },
            { indices: [6, 7, 3, 2], color: this.adjustColor(color, -10) },
            { indices: [7, 4, 0, 3], color: this.adjustColor(color, -20) }
        ];

        faces.forEach(f => { 
            f.avgZ = (worldZ[f.indices[0]] + worldZ[f.indices[1]] + worldZ[f.indices[2]] + worldZ[f.indices[3]]) / 4; 
        });
        faces.sort((a, b) => b.avgZ - a.avgZ);

        ctx.save();
        ctx.globalAlpha = opacity;

        faces.forEach(f => {
            const p0 = projected[f.indices[0]];
            const p1 = projected[f.indices[1]];
            const p2 = projected[f.indices[2]];
            const p3 = projected[f.indices[3]];

            if (customImg) {
                this.drawTexturedFace(p0, p1, p2, p3, customImg);
            } else {
                ctx.fillStyle = f.color; 
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.lineTo(p3.x, p3.y);
                ctx.closePath();
                ctx.fill();
            }

            if (currentTheme === 'theme-pixel') {
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.stroke();
            } else {
                // Keep edge strokes in low gfx so shards stay cube-shaped
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
        });
        ctx.restore();
    }

    draw2D(gx, gy, color, opacity = 1.0) {
        const currentTheme = themes[currentThemeIndex];
        const q = (typeof getCachedFloorQuad === 'function') ? getCachedFloorQuad(gx, gy) : null;
        const p1_p = q ? q[0] : project(gx * GRID_SIZE + 2, gy * GRID_SIZE + 2, 0, draw2dQuad[0]);
        const p2_p = q ? q[1] : project(gx * GRID_SIZE + GRID_SIZE - 2, gy * GRID_SIZE + 2, 0, draw2dQuad[1]);
        const p3_p = q ? q[2] : project(gx * GRID_SIZE + GRID_SIZE - 2, gy * GRID_SIZE + GRID_SIZE - 2, 0, draw2dQuad[2]);
        const p4_p = q ? q[3] : project(gx * GRID_SIZE + 2, gy * GRID_SIZE + GRID_SIZE - 2, 0, draw2dQuad[3]);
        
        ctx.fillStyle = getCachedRgba(color, opacity);
        ctx.beginPath();
        ctx.moveTo(p1_p.x, p1_p.y);
        ctx.lineTo(p2_p.x, p2_p.y);
        ctx.lineTo(p3_p.x, p3_p.y);
        ctx.lineTo(p4_p.x, p4_p.y);
        ctx.closePath();
        ctx.fill();
        
        if (currentTheme === 'theme-pixel') {
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 3;
            ctx.stroke();
        } else if (currentTheme === 'theme-hacker') {
            ctx.strokeStyle = getCachedRgba(color, 0.5); 
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }

    drawCube(gx, gy, color, isPlayer = false, customImg = null, opacity = 1.0, zOffset = 0, scaleOverride = null, rotation = 0, heightScale = 1.0) {
        const s = GRID_SIZE;
        const halfS = s / 2;
        const currentTheme = themes[currentThemeIndex];
        const scaleFactor = scaleOverride !== null ? scaleOverride : 1.1;
        const projected = cubeProjectedVerts;
        const worldZ = cubeWorldZ;
        const rotCos = rotation !== 0 ? Math.cos(rotation) : 1;
        const rotSin = rotation !== 0 ? Math.sin(rotation) : 0;

        for (let i = 0; i < 8; i++) {
            const v = baseVertices[i];
            let wx = v.x;
            let wz = v.z;
            if (rotation !== 0) {
                wx = v.x * rotCos - v.z * rotSin;
                wz = v.x * rotSin + v.z * rotCos;
            }
            wx = wx * scaleFactor * s + gx * s + halfS;
            const wy = v.y * scaleFactor * heightScale * s + gy * s + halfS;
            const worldZValue = (wz * scaleFactor * s * 1.2) + zOffset;
            worldZ[i] = worldZValue;
            project(wx, wy, worldZValue, projected[i]);
        }

        const faces = cubeFaceTemplates;
        faces[0].color = color;
        faces[1].color = this.adjustColor(color, -10);
        faces[2].color = this.adjustColor(color, -25);
        faces[3].color = this.adjustColor(color, -5);
        faces[4].color = this.adjustColor(color, -15);

        for (let fi = 0; fi < 5; fi++) {
            const f = faces[fi];
            const i0 = f.indices[0], i1 = f.indices[1], i2 = f.indices[2], i3 = f.indices[3];
            f.avgZ = (worldZ[i0] + worldZ[i1] + worldZ[i2] + worldZ[i3]) * 0.25;
            f.avgY = (projected[i0].y + projected[i1].y + projected[i2].y + projected[i3].y) * 0.25;
        }

        faces.sort((a, b) => b.avgZ - a.avgZ || a.avgY - b.avgY);
        ctx.globalAlpha = opacity;
        
        faces.forEach(f => {
            const activeImg = customImg || (isPlayer && playerImage && currentColorIndex === neonColors.length - 1 ? playerImage : null);
            const isEmptyUploadCube = isPlayer && currentColorIndex === neonColors.length - 1 && !activeImg;
            if (activeImg) {
                this.drawTexturedFace(projected[f.indices[0]], projected[f.indices[1]], projected[f.indices[2]], projected[f.indices[3]], activeImg);
            } else if (isEmptyUploadCube) {
                ctx.fillStyle = f.color;
                ctx.beginPath();
                ctx.moveTo(projected[f.indices[0]].x, projected[f.indices[0]].y);
                ctx.lineTo(projected[f.indices[1]].x, projected[f.indices[1]].y);
                ctx.lineTo(projected[f.indices[2]].x, projected[f.indices[2]].y);
                ctx.lineTo(projected[f.indices[3]].x, projected[f.indices[3]].y);
                ctx.closePath();
                ctx.fill();
            } else {
                if (currentTheme === 'theme-pixel') {
                    ctx.fillStyle = f.color;
                } else if (currentTheme === 'theme-hacker') {
                    ctx.fillStyle = getCachedRgba(color, 0.2); 
                } else if (currentTheme === 'theme-white-black') {
                    const p0 = projected[f.indices[0]];
                    const p2 = projected[f.indices[2]];
                    const faceBright = wbCubeShadeHex(f.color, 2, 0.2);
                    const faceMid = wbCubeShadeHex(f.color, -10, 0.3);
                    const faceDark = wbCubeShadeHex(f.color, -26, 0.44);
                    const gKey = `${Math.round(p0.x / 8)}|${Math.round(p0.y / 8)}|${Math.round(p2.x / 8)}|${Math.round(p2.y / 8)}|${faceBright}|${faceMid}|${faceDark}`;
                    let grad = gradientCache.get(gKey);
                    if (!grad) {
                        grad = ctx.createLinearGradient(p0.x, p0.y, p2.x, p2.y);
                        grad.addColorStop(0, faceBright);
                        grad.addColorStop(0.55, faceMid);
                        grad.addColorStop(1, faceDark);
                        gradientCache.set(gKey, grad);
                        if (gradientCache.size > 768) gradientCache.clear();
                    }
                    ctx.fillStyle = grad;
                } else {
                    ctx.fillStyle = f.color;
                }
                ctx.beginPath();
                ctx.moveTo(projected[f.indices[0]].x, projected[f.indices[0]].y);
                ctx.lineTo(projected[f.indices[1]].x, projected[f.indices[1]].y);
                ctx.lineTo(projected[f.indices[2]].x, projected[f.indices[2]].y);
                ctx.lineTo(projected[f.indices[3]].x, projected[f.indices[3]].y);
                ctx.closePath();
                ctx.fill();
            }
            // Always keep outlines so low gfx still reads as cubes (skip only expensive glow)
            if (currentTheme === 'theme-pixel') {
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 4;
            } else if (currentTheme === 'theme-hacker') {
                ctx.strokeStyle = color;
                ctx.lineWidth = 3;
                // Canvas shadowBlur is a Chrome hitch magnet — skip on Blink / perf mode
                if (!isPerformanceMode() && !blinkBrowser) {
                    ctx.shadowBlur = 15;
                    ctx.shadowColor = color;
                }
            } else if (currentTheme === 'theme-white-black') {
                ctx.strokeStyle = 'rgba(150, 118, 210, 0.32)';
                ctx.lineWidth = 1.25;
            } else {
                ctx.strokeStyle = 'rgba(255,255,255,0.4)';
                ctx.lineWidth = 1.5;
            }
            ctx.lineJoin = 'round';
            ctx.stroke();
            ctx.shadowBlur = 0;
        });
        ctx.globalAlpha = 1.0;
    }

    drawTexturedFace(p0, p1, p2, p3, img) {
        // Prefer pattern fill (one clip path) — same look, less save/restore churn than clip+drawImage
        if (img && img.complete && img.naturalWidth) {
            let pat = img.__ronkTrailPattern;
            if (!pat || img.__ronkTrailPatternCtx !== ctx) {
                try {
                    pat = ctx.createPattern(img, 'repeat');
                    img.__ronkTrailPattern = pat;
                    img.__ronkTrailPatternCtx = ctx;
                } catch (_) {
                    pat = null;
                }
            }
            if (pat) {
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.lineTo(p3.x, p3.y);
                ctx.closePath();
                const prev = ctx.fillStyle;
                ctx.fillStyle = pat;
                ctx.fill();
                ctx.fillStyle = prev;
                return;
            }
        }
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.clip();
        const minX = Math.min(p0.x, p1.x, p2.x, p3.x);
        const minY = Math.min(p0.y, p1.y, p2.y, p3.y);
        const maxX = Math.max(p0.x, p1.x, p2.x, p3.x);
        const maxY = Math.max(p0.y, p1.y, p2.y, p3.y);
        ctx.drawImage(img, minX, minY, maxX - minX, maxY - minY);
        ctx.restore();
    }

    adjustColor(hex, percent) {
        const cacheKey = `adj_${hex}_${percent}`;
        if (colorCache.has(cacheKey)) return colorCache.get(cacheKey);

        let parsedHex = hex;
        if (!parsedHex.startsWith('#')) return parsedHex;
        if (parsedHex.length === 4) parsedHex = '#' + parsedHex[1] + parsedHex[1] + parsedHex[2] + parsedHex[2] + parsedHex[3] + parsedHex[3];
        const num = parseInt(parsedHex.replace('#',''), 16);
        const amt = Math.round(2.55 * percent);
        const R = (num >> 16) + amt;
        const G = (num >> 8 & 0x00FF) + amt;
        const B = (num & 0x0000FF) + amt;
        const result = '#' + (0x1000000 + (R<255?R<0?0:R:255)*0x10000 + (G<255?G<0?0:G:255)*0x100 + (B<255?B<0?0:B:255)).toString(16).slice(1);
        
        colorCache.set(cacheKey, result);
        if (colorCache.size > 1024) colorCache.clear();
        return result;
    }
}

// Global interaction listener to enable audio context (Autoplay policy)
document.addEventListener('mousedown', () => {
    SFX.init();
    Music.init();
}, { once: true });
let canvas, ctx, menu, customPage, gameUi, startBtn, spectateBtn, openCustomBtn, closeCustomBtn, mainPlayBtn, multiplayerTierBtn, menuTiers, backTierBtns, restartBtn, backToMenuBtn, colorPreview, prevColorBtn, nextColorBtn, gameOverDiv, winnerMsg, gameOverHintEl, dashBar, chargeBar, onlineMatchmakePanel, onlineFriendsPanel, matchmakeBtn, playFriendBtn, myIdEl, joinIdInput, connectBtn, multiplayerBtn, themeBtn, displayModeBtn, displayModeWrap, pauseMenu, loadoutPage, loadoutStartBtn, loadoutBackBtn, loadoutJokerBtn, loadoutSkillBtn, loadoutSkillPanel, loadoutJokerPanel, loadoutCubePreview, loadoutPrevColorBtn, loadoutNextColorBtn, loadoutUploadBtn, loadoutSkillDoneBtn, loadoutJokerDoneBtn, prevSkillBtn, nextSkillBtn, jokersGrid, openSettingsBtn, settingsPage, closeSettingsBtn;
let p1DashLetter, p1ChargeLetter, p1SkillLetter, p2DashLetter, p2ChargeLetter, p2SkillLetter;
let p1JokerContainer, p1Joker1, p1Joker2, p2JokerContainer, p2Joker1, p2Joker2;
let p1HungerBarFill, p2HungerBarFill, hungerBarsContainer;
let roundAnnouncerEl, roundTextEl, countdownTextEl, p1HudEl, p2HudEl;
let p1ScoreEl, p2ScoreEl, p1NameTag, p2NameTag;

let nickname = localStorage.getItem('ronk_nickname') || "";
let onlineLogTarget = 'matchmake';
let isThemeSwitching = false;
let activeNavigation = { screen: 'main-menu', menuTier: 'main-menu-tier' };

function syncNicknameFromInputs() {
    const matchInput = document.getElementById('matchmake-nickname');
    const friendInput = document.getElementById('friend-nickname');
    const value = (matchInput && matchInput.value.trim()) || (friendInput && friendInput.value.trim()) || nickname;
    if (value) {
        nickname = value;
        localStorage.setItem('ronk_nickname', nickname);
        if (matchInput) matchInput.value = nickname;
        if (friendInput) friendInput.value = nickname;
    }
}

function bindNicknameInputs() {
    ['matchmake-nickname', 'friend-nickname'].forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.value = nickname;
        input.addEventListener('input', (e) => {
            nickname = e.target.value.trim();
            localStorage.setItem('ronk_nickname', nickname);
            const otherId = id === 'matchmake-nickname' ? 'friend-nickname' : 'matchmake-nickname';
            const other = document.getElementById(otherId);
            if (other) other.value = nickname;
        });
    });
}

function openOnlinePanel(panel, logTarget) {
    onlineLogTarget = logTarget;
    forceHideMenu();
    hideOverlayPanel(onlineMatchmakePanel);
    hideOverlayPanel(onlineFriendsPanel);
    showOverlayPanel(panel);
    const screen = panel === onlineMatchmakePanel ? 'online-matchmake' : 'online-friends';
    setActiveNavigation(screen);
    syncNicknameFromInputs();
    if (steamBridge && steamBridge.isAvailable() && steamBridge.getLocalName() && !nickname) {
        nickname = steamBridge.getLocalName();
        localStorage.setItem('ronk_nickname', nickname);
        bindNicknameInputs();
    }
    updateSteamOnlineStatus(panel);
}
let isReady = false;
let enemyReady = false;
let enemyNickname = "";
let enemyColor = "";
let enemyImage = null;
let gameLoop, animLoop;

function initDOMElements() {
    canvas = document.getElementById('gameCanvas');
    if (canvas) {
        // alpha:true so HTML theme backdrops (Tron, marble wave, matrix…) show through the canvas
        const ctxOpts = blinkBrowser
            ? { alpha: true, desynchronized: false }
            : { alpha: true, desynchronized: true };
        ctx = canvas.getContext('2d', ctxOpts);
        if (!ctx) ctx = canvas.getContext('2d');
        if (ctx) applyCanvasQuality(ctx);
    }
    menu = document.getElementById('menu');
    customPage = document.getElementById('custom-page');
    gameUi = document.getElementById('game-ui');
    startBtn = document.getElementById('start-btn');
    spectateBtn = document.getElementById('spectate-btn');
    openCustomBtn = document.getElementById('open-custom-btn');
    closeCustomBtn = document.getElementById('close-custom-btn');
    mainPlayBtn = document.getElementById('main-play-btn');
    multiplayerTierBtn = document.getElementById('multiplayer-tier-btn');
    menuTiers = document.querySelectorAll('.menu-tier');
    backTierBtns = document.querySelectorAll('.back-tier-btn');
    restartBtn = document.getElementById('restart-btn');
    backToMenuBtn = document.getElementById('back-to-menu-btn');
    colorPreview = document.getElementById('cube-preview');
    prevColorBtn = document.getElementById('prev-color');
    nextColorBtn = document.getElementById('next-color');
    gameOverDiv = document.getElementById('game-over');
    winnerMsg = document.getElementById('winner-msg');
    gameOverHintEl = document.getElementById('game-over-hint');
    dashBar = document.getElementById('dash-bar');
    chargeBar = document.getElementById('charge-bar');
    onlineMatchmakePanel = document.getElementById('online-matchmake');
    onlineFriendsPanel = document.getElementById('online-friends');
    
    // Initialize gamemode button to show "GAMEMODE: NORMAL" by default
    const openGamemodeBtn = document.getElementById('open-gamemode-btn');
    if (openGamemodeBtn) {
        currentGamemode = 'normal';
        const savedLanguage = localStorage.getItem('ronk_language') || 'en';
        const t = translations[savedLanguage] || translations['en'];
        openGamemodeBtn.textContent = t['GAMEMODE: CLASSIC'] || 'GAMEMODE: CLASSIC';
    }
    matchmakeBtn = document.getElementById('matchmake-btn');
    playFriendBtn = document.getElementById('play-friend-btn');
    myIdEl = document.getElementById('my-id');
    joinIdInput = document.getElementById('join-id');
    connectBtn = document.getElementById('connect-btn');
    multiplayerBtn = document.getElementById('multiplayer-btn');
    themeBtn = document.getElementById('theme-btn');
    displayModeWrap = document.getElementById('display-mode-wrap');
    displayModeBtn = document.getElementById('display-mode-btn');
    pauseMenu = document.getElementById('pause-menu');
    loadoutPage = document.getElementById('loadout-page');
    loadoutStartBtn = document.getElementById('loadout-start-btn');
    loadoutBackBtn = document.getElementById('loadout-back-btn');
    loadoutJokerBtn = document.getElementById('loadout-joker-btn');
    loadoutSkillBtn = document.getElementById('loadout-skill-btn');
    loadoutSkillPanel = document.getElementById('loadout-skill-panel');
    loadoutJokerPanel = document.getElementById('loadout-joker-panel');
    loadoutCubePreview = document.getElementById('loadout-cube-canvas');
    initLoadoutCubeCanvas();
    loadoutPrevColorBtn = document.getElementById('loadout-prev-color');
    loadoutNextColorBtn = document.getElementById('loadout-next-color');
    loadoutUploadBtn = document.getElementById('loadout-upload-btn');
    loadoutSkillDoneBtn = document.getElementById('loadout-skill-done-btn');
    loadoutJokerDoneBtn = document.getElementById('loadout-joker-done-btn');
    prevSkillBtn = document.getElementById('prev-skill');
    nextSkillBtn = document.getElementById('next-skill');
    jokersGrid = document.getElementById('jokers-grid');
    openSettingsBtn = document.getElementById('open-settings-btn');
    
    // Add simplistic-mode class to body if in simplistic mode on startup
    if (currentGamemode === 'simplistic') {
        document.body.classList.add('simplistic-mode');
    }
    settingsPage = document.getElementById('settings-page');
    closeSettingsBtn = document.getElementById('close-settings-btn');

    p1DashLetter = document.getElementById('p1-dash-letter');
    p1ChargeLetter = document.getElementById('p1-charge-letter');
    p1SkillLetter = document.getElementById('p1-skill-letter');
    p2DashLetter = document.getElementById('p2-dash-letter');
    p2ChargeLetter = document.getElementById('p2-charge-letter');
    p2SkillLetter = document.getElementById('p2-skill-letter');
    p1JokerContainer = document.getElementById('p1-joker-container');
    p1Joker1 = document.getElementById('p1-joker-1');
    p1Joker2 = document.getElementById('p1-joker-2');
    p2JokerContainer = document.getElementById('p2-joker-container');
    p2Joker1 = document.getElementById('p2-joker-1');
    p2Joker2 = document.getElementById('p2-joker-2');
    p1HungerBarFill = document.getElementById('p1-hunger-bar-fill');
    p2HungerBarFill = document.getElementById('p2-hunger-bar-fill');
    hungerBarsContainer = document.querySelector('.hunger-bars-container');
    roundAnnouncerEl = document.getElementById('round-announcer');
    roundTextEl = document.getElementById('round-text');
    countdownTextEl = document.getElementById('countdown-text');
    p1HudEl = document.getElementById('p1-hud');
    p2HudEl = document.getElementById('p2-hud');
    p1ScoreEl = document.getElementById('p1-score-val');
    p2ScoreEl = document.getElementById('p2-score-val');
    p1NameTag = document.getElementById('p1-name-tag');
    p2NameTag = document.getElementById('p2-name-tag');
    
    // Menu stays hidden until intro finishes and showMainMenu runs
    if (menu) {
        hideOverlayPanel(menu);
    }
    hideOverlayPanel(settingsPage);
    hideOverlayPanel(loadoutPage);
    hideOverlayPanel(customPage);
    
    // New waiting room elements
    bindNicknameInputs();

    const waitingChangeBtn = document.getElementById('waiting-change-btn');
    if (waitingChangeBtn) {
        waitingChangeBtn.addEventListener('click', () => {
            const waitingRoom = document.getElementById('waiting-room');
            if (waitingRoom) hideOverlayPanel(waitingRoom);
            showOverlayPanel(customPage);
            
            // Override the back button behavior in custom page to return to waiting room
            const customBackBtn = document.getElementById('close-custom-btn');
            if (customBackBtn) {
                const originalClick = customBackBtn.onclick;
                customBackBtn.onclick = (e) => {
                    e.preventDefault();
                    customPage.classList.add('hidden');
                    if (waitingRoom) showOverlayPanel(waitingRoom);
                    // Restore original behavior
                    customBackBtn.onclick = originalClick;
                };
            }
        });
    }

    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) {
        readyBtn.addEventListener('click', () => {
            isReady = !isReady;
            readyBtn.textContent = isReady ? "CANCEL" : "READY";
            const indicator = document.getElementById('self-ready');
            if (indicator) {
                indicator.textContent = isReady ? "READY" : "NOT READY";
                indicator.classList.toggle('is-ready', isReady);
            }
            syncSettings();
            checkBothReady();
        });
    }

    const waitingExitBtn = document.getElementById('waiting-exit-btn');
    if (waitingExitBtn) {
        waitingExitBtn.addEventListener('click', () => {
            if (steamBridge) steamBridge.leaveLobby();
            if (peer) peer.destroy();
            location.reload();
        });
    }

    const continueBtn = document.getElementById('continue-btn');
    if (continueBtn) {
        continueBtn.addEventListener('click', () => {
            hasVotedContinue = true;
            continueBtn.disabled = true;
            continueBtn.textContent = "WAITING...";
            const statusEl = document.getElementById('vote-status');
            if (statusEl) statusEl.textContent = enemyVotedContinue ? "BOTH READY!" : "WAITING FOR RIVAL...";
            syncSettings();
            checkBothVoted();
        });
    }

    attachEventListeners();
    initAntiCheatHandlers();
    initProtectionHandlers();
    if (p1) {
        p1.selectedSkill = localStorage.getItem('ronk_selectedSkill');
        if (p1.selectedSkill) {
            const selectedCard = document.querySelector(`.skill-card[data-skill="${p1.selectedSkill}"]`);
            if (selectedCard) selectedCard.classList.add('selected');
        }
    }
    finishClientBootstrap().catch((err) => {
        console.warn('[Bootstrap] Fatal init error — continuing to intro:', err?.message || err);
        try {
            initIntroSequence();
            initTutorialGate();
            initPlayUnlockHint();
            updateThemeOnLoad();
            initReportSystemUI();
        } catch (introErr) {
            console.error('[Bootstrap] Intro init failed:', introErr);
        }
    });
}

async function finishClientBootstrap() {
    if (window.RonkProtection?.initRonkProtection) {
        try {
            await RonkProtection.initRonkProtection();
            if (RonkProtection.parseUnlockProgress && localStorage.getItem(PROGRESSION_STORAGE_KEY)) {
                const parsed = RonkProtection.parseUnlockProgress(localStorage.getItem(PROGRESSION_STORAGE_KEY));
                if (parsed.legacy && !parsed.tampered) {
                    saveUnlockProgress(validateUnlockProgress({ skills: parsed.skills, jokers: parsed.jokers }));
                }
            }
            RonkProtection.stampCopyrightElements?.();
        } catch (_) {}
    }
    unlockProgressHydrated = false;
    hydrateUnlockProgressFromStorage();
    try {
        await Promise.race([
            Promise.all([syncPlayerPrefsFromCloud(), syncUnlockProgressFromCloud()]),
            new Promise((resolve) => setTimeout(resolve, 5000))
        ]);
    } catch (err) {
        console.warn('[Bootstrap] Cloud sync skipped:', err?.message || err);
    }
    refreshUnlockProgressUI();
    // Playtest unlock helper (disabled for Steam builds — call from DevTools if needed):
    // unlockAllSkillsAndJokersForTest();
    applySavedVolumePrefs();
    updateSoundButtons();
    initIntroSequence();
    initTutorialGate();
    initPlayUnlockHint();
    updateThemeOnLoad();
    syncSpectateMenuUI();
    initReportSystemUI();
}


function initTutorialGate() {
    const playBtn = document.getElementById('tutorial-gate-play-btn');
    const skipBtn = document.getElementById('tutorial-gate-skip-btn');
    if (playBtn) {
        playBtn.addEventListener('click', () => {
            SFX.play('button');
            hideTutorialGate();
            launchTutorialMatch();
        });
    }
    if (skipBtn) {
        skipBtn.addEventListener('click', () => {
            skipTutorialToMenu();
        });
    }
}

function showTutorialGate() {
    const gate = document.getElementById('tutorial-gate-overlay');
    if (!gate) {
        showMainMenu();
        resetToMainTier();
        return;
    }
    hideAllMenuPanels();
    document.body.classList.remove('main-menu-visible', 'in-game');
    document.body.classList.add('tutorial-gate-active');
    gate.classList.remove('hidden');
    gate.style.display = 'flex';
    gate.style.visibility = 'visible';
    gate.style.opacity = '1';
    gate.style.pointerEvents = 'auto';
    setThemeBtnVisible(false);
    const lang = localStorage.getItem('ronk_language') || 'en';
    const t = translations[lang] || translations['en'];
    const playBtn = document.getElementById('tutorial-gate-play-btn');
    const skipBtn = document.getElementById('tutorial-gate-skip-btn');
    const subtitle = document.getElementById('tutorial-gate-subtitle');
    if (playBtn) playBtn.textContent = t['TUTORIAL'] || 'TUTORIAL';
    if (skipBtn) skipBtn.textContent = t['SKIP TUTORIAL'] || 'SKIP TUTORIAL';
    if (subtitle) subtitle.textContent = t['TUTORIAL_GATE_SUBTITLE'] || t['NEW PLAYER TRAINING'] || '9 boards · checkpoints · new ways to win';
    const skipHint = document.getElementById('tutorial-gate-skip-hint');
    if (skipHint) {
        skipHint.textContent = t['TUTORIAL_SKIP_HINT']
            || 'New here? Play the tutorial — or skip anytime below.';
    }
}

function hideTutorialGate() {
    const gate = document.getElementById('tutorial-gate-overlay');
    if (!gate) return;
    gate.classList.add('hidden');
    gate.style.display = 'none';
    gate.style.pointerEvents = 'none';
    document.body.classList.remove('tutorial-gate-active');
}

function hasSeenPlayUnlockHint() {
    return localStorage.getItem(PLAY_UNLOCK_HINT_KEY) === 'true';
}

function markPlayUnlockHintSeen() {
    localStorage.setItem(PLAY_UNLOCK_HINT_KEY, 'true');
    savePlayerPrefs({ playUnlockHintSeen: true });
}

function getPlayUnlockHintCopy() {
    const lang = localStorage.getItem('ronk_language') || 'en';
    const t = translations[lang] || translations['en'];
    return {
        title: t['FIRST_PLAY_UNLOCK_TITLE'] || 'SKILLS & JOKERS LOCKED',
        body: t['FIRST_PLAY_UNLOCK_BODY'] || t['BEAT_BOTS_TO_UNLOCK']
            || 'All skills and jokers start locked. Beat bots (easy through elite) or win online to unlock what they were using.',
        button: t['GOT IT'] || 'GOT IT'
    };
}

function updatePlayUnlockHintText() {
    const copy = getPlayUnlockHintCopy();
    const titleEl = document.getElementById('play-unlock-hint-title');
    const bodyEl = document.getElementById('play-unlock-hint-body');
    const btn = document.getElementById('play-unlock-hint-btn');
    if (titleEl) titleEl.textContent = copy.title;
    if (bodyEl) bodyEl.textContent = copy.body;
    if (btn) btn.textContent = copy.button;
}

let playUnlockHintContinue = null;

function showPlayUnlockHint(onContinue) {
    const overlay = document.getElementById('play-unlock-hint-overlay');
    if (!overlay) {
        onContinue?.();
        return;
    }
    updatePlayUnlockHintText();
    playUnlockHintContinue = onContinue;
    overlay.classList.remove('hidden');
    overlay.style.display = 'block';
    overlay.style.visibility = 'visible';
    overlay.style.opacity = '1';
    overlay.style.pointerEvents = 'auto';
    document.body.classList.add('play-unlock-hint-active');
    setThemeBtnVisible(false);
}

function hidePlayUnlockHint() {
    const overlay = document.getElementById('play-unlock-hint-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.body.classList.remove('play-unlock-hint-active');
    setThemeBtnVisible(true);
    playUnlockHintContinue = null;
}

function dismissPlayUnlockHint() {
    SFX.play('button');
    markPlayUnlockHintSeen();
    const continueFn = playUnlockHintContinue;
    hidePlayUnlockHint();
    continueFn?.();
}

function initPlayUnlockHint() {
    const btn = document.getElementById('play-unlock-hint-btn');
    if (btn) {
        btn.addEventListener('click', dismissPlayUnlockHint);
    }
}

function handleMainPlayClick() {
    SFX.init();
    Music.init();
    if (isInActiveGameView()) return;
    if (!hasSeenPlayUnlockHint()) {
        showPlayUnlockHint(() => showTier('start-mode-tier'));
        return;
    }
    showTier('start-mode-tier');
}

/** 'solo' | 'online-matchmake' | 'online-friend' | 'local-pvp' */
let pendingPlayPath = 'solo';
/** Loadout UI: 'single' | 'dual' */
let loadoutPageMode = 'single';
/** Which slot skill/joker pickers edit in dual mode */
let loadoutEditSlot = 1;
let p2ColorIndex = parseInt(localStorage.getItem('ronk_p2_colorIndex'), 10);
if (!Number.isFinite(p2ColorIndex) || p2ColorIndex < 0) p2ColorIndex = 1;
/** In-memory P2 jokers while editing dual loadout */
let p2LoadoutJokers = [];
let playerImageP2 = null;
try {
    const p2ImgRaw = localStorage.getItem('ronk_p2_cubeImage');
    if (p2ImgRaw && p2ImgRaw.startsWith('data:image/')) {
        playerImageP2 = new Image();
        playerImageP2.src = p2ImgRaw;
    }
} catch (_) { /* ignore */ }

let tutorialReplayActive = false;

function tutorialAllowsPractice() {
    return !!(isTutorialMatch && (!isTutorialComplete() || tutorialReplayActive));
}

function skipTutorialToMenu() {
    try { SFX.play('win', 0.4); } catch (_) {}
    try { SFX.play('button', 0.55); } catch (_) {}
    // First-time skip marks complete; replay skip must NOT wipe unlocks
    if (!isTutorialComplete()) markTutorialComplete();
    tutorialReplayActive = false;
    hideTutorialGate();
    hideTutorialOverlay();
    isTutorialMatch = false;
    showMainMenu();
    resetToMainTier();
}

/** Wipe tutorial-complete so the exact post-intro gate / practice match can run again. */
function clearTutorialCompleteFlag() {
    try { localStorage.setItem(TUTORIAL_COMPLETE_KEY, 'false'); } catch (_) {}
    const merged = {
        tutorialComplete: false,
        playUnlockHintSeen: hasSeenPlayUnlockHint()
    };
    if (steamBridge?.writeProgressCloud) {
        const payload = JSON.stringify({ v: 1, ...merged });
        Promise.resolve(steamBridge.writeProgressCloud(payload, PLAYER_PREFS_CLOUD_FILE)).catch(() => {});
    }
}

/** Exact same gate as after intro: TUTORIAL / SKIP TUTORIAL.
 *  Does NOT clear progression — completed players keep unlocks on replay.
 */
function openTutorialGateExact() {
    tutorialReplayActive = isTutorialComplete();
    hideTutorialOverlay();
    isTutorialMatch = false;
    tutorialPracticeActive = false;
    tutorialFightWaitingForStart = false;
    tutorialObjectiveDone = false;
    tutorialStep = 0;
    hideAllMenuPanels();
    if (menu) {
        menu.classList.add('hidden');
        menu.style.display = 'none';
    }
    document.body.classList.remove('main-menu-visible', 'in-game');
    showTutorialGate();
}

function initIntroSequence() {
    const introOverlay = document.getElementById('intro-overlay');
    const introCanvas = document.getElementById('intro-canvas');
    const introTitle = document.getElementById('intro-title');
    const introStartBtn = document.getElementById('intro-start-btn');
    const introSkipHint = document.getElementById('intro-skip-hint');

    if (!introOverlay || !introCanvas || !window.RonkIntroAnimation) return;

    document.body.classList.add('intro-active');
    setThemeBtnVisible(false);

    introOverlay.style.display = 'flex';
    introOverlay.style.pointerEvents = 'auto';
    introOverlay.style.visibility = 'visible';
    introOverlay.classList.remove('hidden');

    let introCtrl = null;
    let introDone = false;

    const finishIntro = () => {
        if (introDone) return;
        introDone = true;
        if (introCtrl) introCtrl.stop();
        SFX.stopAll();
        introOverlay.classList.add('intro-fade-out');

        if (Music.enabled) {
            SFX.init();
            Music.init();
        }

        setTimeout(() => {
            introOverlay.style.display = 'none';
            introOverlay.style.pointerEvents = 'none';
            introOverlay.classList.remove('intro-fade-out');
            document.body.classList.remove('intro-active');
            document.body.classList.add('intro-finished');
            introFinished = true;
            // Drop intro bitmap RAM immediately (~full-window canvas)
            try {
                const introCanvas = document.getElementById('intro-canvas');
                if (introCanvas) {
                    introCanvas.width = 0;
                    introCanvas.height = 0;
                }
            } catch (_) { /* ignore */ }
            // Jump / opening animation landing is Ronk-only — never redirect to another theme.
            // changeTheme({ force:true }) sets isThemeSwitching until rAF finishes — a sync
            // showMainMenu() would no-op and leave a black screen with music playing.
            const ronkIndex = Math.max(0, themes.indexOf('theme-ronk'));
            const revealAfterIntro = () => {
                if (!isTutorialComplete()) {
                    showTutorialGate();
                } else {
                    showMainMenu();
                    resetToMainTier();
                }
                if (steamBatchCapture) {
                    maybeStartSteamBatchCapture();
                }
                if (trailerBatchCapture) {
                    maybeStartTrailerBatchCapture();
                }
                if (Music.enabled) {
                    Music.play();
                }
            };
            changeTheme(ronkIndex, { force: false, onComplete: revealAfterIntro });
        }, RonkIntroAnimation.TIMING.FADE_MS);
    };

    introCtrl = RonkIntroAnimation.start({
        canvas: introCanvas,
        overlay: introOverlay,
        titleEl: introTitle,
        startBtn: introStartBtn,
        skipHint: introSkipHint,
        creditEl: document.getElementById('intro-credit'),
        creditShowEl: document.getElementById('intro-credit-show'),
        sfx: SFX,
        onFinish: finishIntro
    });

    const introStartTime = introCtrl ? introCtrl.getStartTime() : Date.now();

    introOverlay.addEventListener('click', (e) => { if (e.target !== introStartBtn) finishIntro(); });
    if (introStartBtn) introStartBtn.addEventListener('click', (e) => { e.stopPropagation(); finishIntro(); SFX.play('button'); });

    if (steamBatchCapture || trailerBatchCapture) {
        introOverlay.style.pointerEvents = 'none';
        if (trailerBatchHQ) {
            runTrailerIntroCapture(introStartTime)
                .then(() => finishIntro())
                .catch((err) => {
                    console.error('[TrailerCapture] Intro capture failed', err);
                    finishIntro();
                });
        } else if (trailerBatchCapture) {
            runTrailerIntroCapture(introStartTime)
                .then(() => finishIntro())
                .catch((err) => {
                    console.error('[TrailerCapture] Intro capture failed', err);
                    finishIntro();
                });
        } else {
            runSteamIntroCapture(introStartTime)
                .then(() => finishIntro())
                .catch((err) => {
                    console.error('[SteamCapture] Intro capture failed', err);
                    finishIntro();
                });
        }
    }
}


function setThemeBtnVisible(visible) {
    if (!themeBtn) return;
    if (document.body.classList.contains('intro-active')) {
        visible = false;
    }
    const menuReady = document.body.classList.contains('main-menu-visible');
    const inGame = document.body.classList.contains('in-game');
    const overlay = document.body.classList.contains('overlay-screen');
    if (visible && (!introFinished || (!menuReady && !inGame && !overlay))) return;
    themeBtn.hidden = !visible;
    themeBtn.setAttribute('aria-hidden', visible ? 'false' : 'true');
    themeBtn.style.display = visible ? '' : 'none';
    themeBtn.style.visibility = visible ? 'visible' : 'hidden';
    themeBtn.style.opacity = visible ? '1' : '0';
    themeBtn.style.pointerEvents = visible ? 'auto' : 'none';
    setDisplayModeBtnVisible(visible);
}

function getDisplayModeControl() {
    if (typeof process !== 'undefined' && process.versions?.electron) {
        try {
            return { type: 'electron', ipc: require('electron').ipcRenderer };
        } catch (_) {
            return null;
        }
    }
    const root = document.documentElement;
    if (root.requestFullscreen || root.webkitRequestFullscreen) {
        return { type: 'browser' };
    }
    return null;
}

function isBrowserFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/** Prefer browser fullscreen until the WINDOW button is clicked (ESC must not drop it). */
let preferBrowserFullscreen = false;

async function lockEscapeKeyForFullscreen() {
    try {
        if (navigator.keyboard && typeof navigator.keyboard.lock === 'function') {
            await navigator.keyboard.lock(['Escape']);
        }
    } catch (_) { /* unsupported / denied */ }
}

function unlockEscapeKeyForFullscreen() {
    try {
        if (navigator.keyboard && typeof navigator.keyboard.unlock === 'function') {
            navigator.keyboard.unlock();
        }
    } catch (_) { /* ignore */ }
}

/** Hide OS cursor while actively playing; show for pause / game-over / settings. */
function syncGameplayCursor() {
    if (!document.body) return;
    const inGame = document.body.classList.contains('in-game');
    const gameOverOpen = !!(gameOverDiv && !gameOverDiv.classList.contains('hidden')
        && gameOverDiv.style.display !== 'none');
    const settingsOpen = !!(settingsPage && !settingsPage.classList.contains('hidden'));
    const hide = inGame && !isPaused && !gameOverOpen && !settingsOpen
        && gameState !== 'GAME_OVER';
    document.body.classList.toggle('cursor-hidden', hide);
}

function formatDisplayModeLabel(label) {
    if (!label) return 'FULLSCREEN';
    if (label === 'WINDOWED') return 'WINDOW';
    return label;
}

function applyDisplayModeButtonState(state) {
    if (!displayModeBtn || !state) return;
    const label = formatDisplayModeLabel(state.label);
    displayModeBtn.textContent = label;
    displayModeBtn.title = state.title
        || (state.fullscreen === false || state.mode === 'windowed'
            ? 'Switch to fullscreen mode'
            : 'Switch to windowed mode');
}

async function syncDisplayModeButtonLabel(state) {
    if (!displayModeBtn) return;
    if (state?.label) {
        applyDisplayModeButtonState(state);
        return;
    }
    const control = getDisplayModeControl();
    if (!control) return;
    if (control.type === 'electron') {
        try {
            const nextState = await control.ipc.invoke('get-display-mode');
            applyDisplayModeButtonState(nextState);
        } catch (_) { /* ignore */ }
        return;
    }
    const fullscreen = isBrowserFullscreen();
    applyDisplayModeButtonState({
        label: fullscreen ? 'WINDOW' : 'FULLSCREEN',
        title: fullscreen
            ? 'Switch to windowed mode (ESC only pauses — does not leave fullscreen)'
            : 'Switch to fullscreen mode',
        fullscreen
    });
}

function setDisplayModeBtnVisible(visible) {
    const wrap = displayModeWrap || displayModeBtn;
    if (!wrap) return;
    const control = getDisplayModeControl();
    if (!control) {
        wrap.hidden = true;
        if (displayModeBtn) displayModeBtn.hidden = true;
        return;
    }
    if (document.body.classList.contains('intro-active')) {
        visible = false;
    }
    const menuReady = document.body.classList.contains('main-menu-visible');
    const inGame = document.body.classList.contains('in-game');
    const overlay = document.body.classList.contains('overlay-screen');
    if (visible && (!introFinished || (!menuReady && !inGame && !overlay))) return;
    wrap.hidden = !visible;
    wrap.setAttribute('aria-hidden', visible ? 'false' : 'true');
    wrap.style.display = visible ? '' : 'none';
    wrap.style.visibility = visible ? 'visible' : 'hidden';
    wrap.style.opacity = visible ? '1' : '0';
    wrap.style.pointerEvents = visible ? 'auto' : 'none';
    if (displayModeBtn) {
        displayModeBtn.hidden = !visible;
        displayModeBtn.setAttribute('aria-hidden', visible ? 'false' : 'true');
        displayModeBtn.style.display = visible ? '' : 'none';
        displayModeBtn.style.visibility = visible ? 'visible' : 'hidden';
        displayModeBtn.style.opacity = visible ? '1' : '0';
        displayModeBtn.style.pointerEvents = visible ? 'auto' : 'none';
    }
    if (visible) syncDisplayModeButtonLabel();
}

function initDisplayModeButton() {
    if (!displayModeBtn) return;
    const control = getDisplayModeControl();
    if (!control) {
        if (displayModeWrap) displayModeWrap.hidden = true;
        displayModeBtn.hidden = true;
        return;
    }

    displayModeBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
    });
    displayModeBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
            if (control.type === 'electron') {
                const nextState = await control.ipc.invoke('cycle-display-mode');
                applyDisplayModeButtonState(nextState);
            } else {
                const root = document.documentElement;
                if (isBrowserFullscreen()) {
                    preferBrowserFullscreen = false;
                    unlockEscapeKeyForFullscreen();
                    if (document.exitFullscreen) await document.exitFullscreen();
                    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                } else if (root.requestFullscreen) {
                    preferBrowserFullscreen = true;
                    await root.requestFullscreen();
                    await lockEscapeKeyForFullscreen();
                } else if (root.webkitRequestFullscreen) {
                    preferBrowserFullscreen = true;
                    root.webkitRequestFullscreen();
                    await lockEscapeKeyForFullscreen();
                }
                await syncDisplayModeButtonLabel();
            }
        } catch (_) { /* ignore */ }
        displayModeBtn.blur();
    });

    if (control.type === 'electron') {
        control.ipc.on('display-mode-changed', (_event, payload) => {
            applyDisplayModeButtonState(payload);
        });
        control.ipc.invoke('get-display-mode').then((state) => {
            applyDisplayModeButtonState(state);
        }).catch(() => {});
    } else {
        const onFsChange = async () => {
            await syncDisplayModeButtonLabel();
            if (isBrowserFullscreen()) {
                if (preferBrowserFullscreen) await lockEscapeKeyForFullscreen();
            } else {
                unlockEscapeKeyForFullscreen();
                // ESC tried to leave FS — bounce back if preference is still fullscreen
                if (preferBrowserFullscreen) {
                    const root = document.documentElement;
                    try {
                        if (root.requestFullscreen) await root.requestFullscreen();
                        else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
                        await lockEscapeKeyForFullscreen();
                    } catch (_) {
                        // Re-enter needs a gesture in some browsers — keep preference for next click
                    }
                    // Browser stole Escape to leave FS — open pause if that was the intent
                    if (typeof isActiveMatchForPause === 'function' && isActiveMatchForPause()
                        && !isPaused && typeof togglePauseFromInput === 'function') {
                        togglePauseFromInput();
                    }
                }
            }
        };
        document.addEventListener('fullscreenchange', onFsChange);
        document.addEventListener('webkitfullscreenchange', onFsChange);
    }
    syncDisplayModeButtonLabel();
}

function initThemeBackground(themeClass, opts = {}) {
    const force = !!(opts && opts.force);
    if (themeClass !== 'theme-white-black') destroyLiquidBackground();

    // Avoid wipe→rebuild flashes (looks like a sudden black screen mid-match / on resume)
    if (!force && themeBackgroundReady(themeClass)) {
        document.querySelector('.liquid-container')?.classList.toggle(
            'liquid-active',
            themeClass === 'theme-white-black'
        );
        return;
    }

    if (themeClass === 'theme-ronk') {
        initRonkBackground();
        initRonkTitleFlicker();
    } else {
        clearRonkTitleFlicker();
    }
    if (themeClass === 'theme-pinkcore') initClouds();
    if (themeClass === 'theme-hacker') initMatrix();
    if (themeClass === 'theme-pixel') initPixelBg();
    if (themeClass === 'theme-white-black') initLiquidBackground({ reuse: true });
    // Waves stay on for menu + loadout + in-game (Bapbap only)
    document.querySelector('.liquid-container')?.classList.toggle(
        'liquid-active',
        themeClass === 'theme-white-black'
    );
}

/** True when the HTML theme backdrop that sits behind the transparent canvas is alive. */
function themeBackgroundReady(themeClass) {
    if (!themeClass) return false;
    if (themeClass === 'theme-ronk') {
        return !!document.querySelector('.ronk-container .ronk-tron-scene');
    }
    if (themeClass === 'theme-hacker') {
        return !!document.querySelector('.matrix-container .matrix-line, .matrix-container .matrix-fallback');
    }
    if (themeClass === 'theme-pixel') {
        // Require pipes + bird so a dead Flappy RAF / wiped bird triggers rebuild
        return !!document.querySelector('.pixel-bg-container .pixel-pipe')
            && !!document.querySelector('.pixel-bg-container .pixel-flappy-bird');
    }
    if (themeClass === 'theme-pinkcore') {
        return !!document.querySelector('.clouds-container .cloud');
    }
    if (themeClass === 'theme-white-black') {
        return !!document.querySelector('.liquid-container canvas, .liquid-container.liquid-active');
    }
    return true;
}

let _rbThemeBgHealAt = 0;
function healThemeBackgroundIfNeeded() {
    const themeClass = themes[currentThemeIndex];
    if (!themeClass) return;
    // Pixel Flappy RAF may die mid-match — always allow a lightweight resume
    if (themeClass === 'theme-pixel') {
        try { ensurePixelFlappyRunning(); } catch (_) { /* ignore */ }
    }
    // Full wipe/rebuild stays menu/lobby-only (avoid mid-match flashes)
    if (document.body.classList.contains('in-game')) return;
    if (themeBackgroundReady(themeClass)) return;
    const now = performance.now();
    if (now - _rbThemeBgHealAt < 750) return;
    _rbThemeBgHealAt = now;
    try { initThemeBackground(themeClass, { force: false }); } catch (_) { /* ignore */ }
}

function updateThemeOnLoad() {
    if (!themeBtn) return;

    // Steam/Electron: calm heavy CSS glitch layers that look broken + cause lag
    try {
        if (/Electron/i.test(navigator.userAgent || '')) {
            document.body.classList.add('perf-steam');
            // Cap canvas buffer immediately so first match isn't a hitchy Retina monster
            try { updateEffectiveDpr(); resizeCanvas(); } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }

    setThemeBtnVisible(false);

    // Opening animation path always boots on Ronk — never apply a saved non-Ronk
    // theme under the intro (that caused other-theme chrome to flash mid-jump).
    const ronkIndex = Math.max(0, themes.indexOf('theme-ronk'));
    currentThemeIndex = ronkIndex;
    localStorage.setItem('ronk_themeIndex', String(ronkIndex));
    const bootTheme = themes[ronkIndex] || 'theme-ronk';
    const bootTrack = Music.themeFilename(bootTheme);
    if (bootTrack) Music.preload(bootTrack);
    changeTheme(ronkIndex, { skipBackgroundInit: false, force: true });
    
    hideOverlayPanel(settingsPage);
    hideOverlayPanel(loadoutPage);
    hideOverlayPanel(customPage);
}

let introFinished = false;

function updateSoundButtons() {
    const soundToggleBtn = document.getElementById('sound-toggle-btn');
    const soundState = `SOUND: ${SFX.enabled ? 'ON' : 'OFF'}`;
    if (soundToggleBtn) soundToggleBtn.textContent = soundState;
    Music.enabled = SFX.enabled;
    // Only play music if sound is enabled AND intro has finished
    if (SFX.enabled && introFinished) {
        Music.play();
    } else {
        Music.stop();
    }
}

function clearThemeBackgroundContainers() {
    stopPixelFlappyBird();
    ['.clouds-container', '.matrix-container', '.matrix-code-layer', '.pixel-bg-container', '.ronk-container', '.liquid-container'].forEach(selector => {
        const el = document.querySelector(selector);
        if (el) el.innerHTML = '';
    });
}

function forceHideMenu() {
    if (!menu) return;
    menu.classList.add('hidden');
    menu.style.display = 'none';
    menu.style.visibility = 'hidden';
    menu.style.opacity = '0';
    menu.style.pointerEvents = 'none';
}

function setActiveNavigation(screen, extra = {}) {
    activeNavigation = { screen, ...extra };
    if (screen === 'menu' && !extra.menuTier) {
        activeNavigation.menuTier = getVisibleMenuTierId();
    }
    syncOverlayScreenClass();
}

function getVisibleMenuTierId() {
    if (!menuTiers || menuTiers.length === 0) menuTiers = document.querySelectorAll('.menu-tier');
    for (const tier of menuTiers) {
        if (!tier.classList.contains('hidden') && tier.style.display !== 'none') return tier.id;
    }
    return 'main-menu-tier';
}

function isOverlayScreenActive() {
    const waitingRoom = document.getElementById('waiting-room');
    return (loadoutPage && !loadoutPage.classList.contains('hidden')) ||
        (settingsPage && !settingsPage.classList.contains('hidden')) ||
        (customPage && !customPage.classList.contains('hidden')) ||
        (onlineMatchmakePanel && !onlineMatchmakePanel.classList.contains('hidden')) ||
        (onlineFriendsPanel && !onlineFriendsPanel.classList.contains('hidden')) ||
        (waitingRoom && !waitingRoom.classList.contains('hidden'));
}

function syncOverlayScreenClass() {
    document.body.classList.toggle('overlay-screen', isOverlayScreenActive());
}

function captureNavigationState() {
    if (isInActiveGameView()) {
        return { screen: 'in-game', paused: isPaused };
    }
    if (isLoadoutPageVisible()) {
        return {
            screen: 'loadout',
            pickerOpen: loadoutPage.classList.contains('loadout-picker-open'),
            skillOpen: !!(loadoutSkillPanel && !loadoutSkillPanel.classList.contains('hidden')),
            jokerOpen: !!(loadoutJokerPanel && !loadoutJokerPanel.classList.contains('hidden')),
        };
    }
    if (settingsPage && !settingsPage.classList.contains('hidden')) return { screen: 'settings' };
    if (customPage && !customPage.classList.contains('hidden')) return { screen: 'custom' };
    if (onlineMatchmakePanel && !onlineMatchmakePanel.classList.contains('hidden')) return { screen: 'online-matchmake' };
    if (onlineFriendsPanel && !onlineFriendsPanel.classList.contains('hidden')) return { screen: 'online-friends' };
    const waitingRoom = document.getElementById('waiting-room');
    if (waitingRoom && !waitingRoom.classList.contains('hidden')) return { screen: 'waiting-room' };
    return { screen: 'menu', menuTier: getVisibleMenuTierId() };
}

function restoreNavigationState(state) {
    if (!state) return;
    activeNavigation = { ...state };

    switch (state.screen) {
        case 'in-game':
            syncGameplayThemeFx();
            if (gameState !== 'LOBBY') prerenderGrid();
            if (state.paused && !isPaused) setGamePaused(true);
            syncOverlayScreenClass();
            return;
        case 'loadout': {
            forceHideMenu();
            showOverlayPanel(loadoutPage, 'block');
            const pickerOpen = !!(state.pickerOpen || state.skillOpen || state.jokerOpen);
            if (loadoutPage) {
                loadoutPage.classList.toggle('loadout-picker-open', pickerOpen);
            }
            document.body.classList.toggle('loadout-picker-open', pickerOpen);
            if (loadoutSkillPanel) loadoutSkillPanel.classList.toggle('hidden', !state.skillOpen);
            if (loadoutJokerPanel) loadoutJokerPanel.classList.toggle('hidden', !state.jokerOpen);
            requestAnimationFrame(() => startLoadoutCubeRender());
            setThemeBtnVisible(introFinished);
            syncOverlayScreenClass();
            return;
        }
        case 'settings':
            forceHideMenu();
            showOverlayPanel(settingsPage);
            setThemeBtnVisible(introFinished);
            syncOverlayScreenClass();
            return;
        case 'custom':
            forceHideMenu();
            showOverlayPanel(customPage);
            setThemeBtnVisible(introFinished);
            syncOverlayScreenClass();
            return;
        case 'online-matchmake':
            forceHideMenu();
            showOverlayPanel(onlineMatchmakePanel);
            syncOverlayScreenClass();
            return;
        case 'online-friends':
            forceHideMenu();
            showOverlayPanel(onlineFriendsPanel);
            syncOverlayScreenClass();
            return;
        case 'waiting-room': {
            const waitingRoom = document.getElementById('waiting-room');
            if (waitingRoom) showOverlayPanel(waitingRoom);
            syncOverlayScreenClass();
            return;
        }
        case 'menu':
        case 'main-menu':
            [customPage, onlineMatchmakePanel, onlineFriendsPanel, loadoutPage, settingsPage].forEach(hideOverlayPanel);
            if (menu) {
                menu.classList.remove('hidden');
                menu.style.display = 'flex';
                menu.style.visibility = 'visible';
                menu.style.opacity = '1';
                menu.style.pointerEvents = 'auto';
            }
            document.body.classList.add('main-menu-visible');
            showTier(state.menuTier || 'main-menu-tier');
            setThemeBtnVisible(introFinished);
            syncOverlayScreenClass();
            return;
    }
}

function refreshThemeOnCurrentScreen() {
    restoreNavigationState(captureNavigationState());
}

function applyBodyThemeClass(themeClass) {
    if (!themeClass || !document.body) return;
    // Add target FIRST so body never paints with zero theme-* (galaxy FOUC) or dual themes.
    document.body.classList.add(themeClass);
    if (typeof themes !== 'undefined') {
        themes.forEach((t) => {
            if (t && t !== themeClass) document.body.classList.remove(t);
        });
    }
    // Strip any stray theme-* not in the catalog (legacy dreamcore/galaxy, etc.)
    Array.from(document.body.classList).forEach((cls) => {
        if (cls.startsWith('theme-') && cls !== themeClass) {
            document.body.classList.remove(cls);
        }
    });
}

function changeTheme(index, options = {}) {
    if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
    }

    const nextIndex = ((index % themes.length) + themes.length) % themes.length;
    const themeClass = themes[nextIndex];
    const runThemeComplete = () => {
        if (typeof options.onComplete === 'function') {
            try { options.onComplete(); } catch (err) {
                console.warn('[Theme] onComplete failed:', err?.message || err);
            }
        }
    };
    if (!themeClass) {
        runThemeComplete();
        return;
    }

    // Same theme with a live HTML backdrop — never wipe DOM (intro landing / refresh)
    if (
        currentThemeIndex === nextIndex &&
        document.body.classList.contains(themeClass) &&
        themeBackgroundReady(themeClass) &&
        !options.rebuildBackground
    ) {
        if (!options.skipBackgroundInit) {
            initThemeBackground(themeClass);
        }
        if (typeof Music !== 'undefined' && Music.enabled && introFinished) {
            try { Music.changeTheme(themeClass); } catch (_) { /* ignore */ }
        }
        syncOverlayScreenClass();
        setThemeBtnVisible(introFinished);
        if (themeBtn) {
            const themeName = themeClass === 'theme-white-black'
                ? 'BAPBAP'
                : themeClass.replace('theme-', '').toUpperCase().replace('-', ' ');
            themeBtn.textContent = 'THEME: ' + themeName;
        }
        runThemeComplete();
        return;
    }

    // Same theme: keep body class stable (no remove/re-add thrash that flashes other chrome)
    if (
        !options.force &&
        currentThemeIndex === nextIndex &&
        document.body.classList.contains(themeClass)
    ) {
        if (!options.skipBackgroundInit) {
            initThemeBackground(themeClass);
        }
        // Still heal BGM if playlist/resume left the wrong track playing
        if (typeof Music !== 'undefined' && Music.enabled && introFinished) {
            try { Music.changeTheme(themeClass); } catch (_) { /* ignore */ }
        }
        syncOverlayScreenClass();
        setThemeBtnVisible(introFinished);
        runThemeComplete();
        return;
    }

    isThemeSwitching = true;
    document.body.classList.add('theme-switching');

    currentThemeIndex = nextIndex;
    localStorage.setItem('ronk_themeIndex', currentThemeIndex);
    applyBodyThemeClass(themeClass);
    if (introFinished) window.RonkSteamAchievements?.onThemeChanged?.(themeClass);
    
    if (themeBtn) {
        let themeName = themeClass === 'theme-white-black'
            ? 'BAPBAP'
            : themeClass.replace('theme-', '').toUpperCase().replace('-', ' ');
        themeBtn.textContent = "THEME: " + themeName;
    }

    Music.changeTheme(themeClass);
    // Tear down GL before wiping DOM so WebGL memory is released cleanly
    destroyLiquidBackground();
    clearThemeBackgroundContainers();
    
    cachedThemeColorKey = '';
    lastGridCacheKey = '';
    updateThemeColors();
    // Theme change can change effective DPR (pixel theme uses a sharper in-match buffer)
    if (canvas && ctx) {
        try { resizeCanvas(); } catch (_) { /* ignore */ }
    }
    if (gameState !== 'LOBBY') {
        prerenderGrid();
    }

    const finishThemeSwitch = () => {
        // Re-assert theme class in case any mid-switch UI rewrote body classes
        applyBodyThemeClass(themeClass);
        if (isInActiveGameView()) {
            syncGameplayThemeFx();
            if (canvas && ctx) {
                try { resizeCanvas(); } catch (_) { /* ignore */ }
            }
            if (gameState !== 'LOBBY') prerenderGrid();
        } else {
            syncThemeBackdrop();
            if (isLoadoutPageVisible()) {
                requestAnimationFrame(() => startLoadoutCubeRender());
            }
        }
        syncOverlayScreenClass();
        setThemeBtnVisible(introFinished);
        if (typeof applyLanguage === 'function') {
            try { applyLanguage(localStorage.getItem('ronk_language') || 'en'); } catch (_) { /* ignore */ }
        }
        // Language rebuild must not leave a stale dual-theme class from stacked labels
        applyBodyThemeClass(themeClass);
        isThemeSwitching = false;
        document.body.classList.remove('theme-switching');
        runThemeComplete();
    };

    if (!options.skipBackgroundInit) {
        requestAnimationFrame(() => {
            initThemeBackground(themeClass, { force: true });
            finishThemeSwitch();
        });
    } else {
        requestAnimationFrame(finishThemeSwitch);
    }
}

function closeAllOverlayPanels() {
    hideAllMenuPanels();
    showMainMenu();
}

const SKILL_DATA = [
    { id: 'infinite-charge', icon: '⚡', name: 'INFINITE CHARGE', desc: '5s: Continuous charging with +2 blocks range.' },
    { id: 'clones', icon: '👥', name: 'CLONE CREATION', desc: 'Spawns 2 AI clones per use (3 cubes total: yours + 2 clones).' },
    { id: 'invisible', icon: '👻', name: 'INVISIBLE', desc: 'Passive: enemies cannot see your trail (you / spectate see a light tint). Activate: 3s full invis (cube + trail) — you still see yourself light.' },
    { id: 'infinite-trails', icon: '♾️', name: 'INFINITE TRAILS', desc: 'Passive: trail never decays. Lock 1 checkpoint per board with forever paint to deny TTT — charge can still pierce cages to claim.' },
    { id: 'laser', icon: '📡', name: 'LASER TRAIL', desc: '6s: Laser lines on enemy boards every 1s. Stack up to 3 waves — fire again to overlap (0.5s faster cooldown).' }
];

const JOKER_DATA = [
    { id: 'charge-plus', icon: '🔋', name: 'CHARGE+', desc: 'Your charge moves 2 extra grids.' },
    { id: 'no-hunger', icon: '🍎', name: 'NO HUNGER', desc: 'Your hunger bar never goes down! No need to eat apples.' },
    { id: 'rage-joker', icon: '⚡', name: 'RAGE', desc: 'All cooldowns are 50% shorter.' },
    { id: 'dash-cooldown', icon: '💨', name: 'FAST DASH', desc: 'Dash has no cooldown.' },
    { id: 'border-safe', icon: '🛡️', name: 'BORDER SAFE', desc: 'Hit an edge and you auto-slide along it — never fall off.' },
    { id: 'double-effective', icon: '🌟', name: 'DOUBLE EFFECTIVE', desc: 'Doubles effectiveness of your other jokers!' },
    { id: 'friend-blocks', icon: '🧱', name: 'FRIEND WALLS', desc: 'Spawn 2 passable walls only you can use.' },
    { id: 'trail-growth', icon: '🌱', name: 'TRAIL GROWTH', desc: 'Your trail grows +1 every 2.5 seconds!' },
    { id: 'extra-life', icon: '❤️', name: 'EXTRA LIFE', desc: 'Survive your first death.' },
    { id: 'disable-enemy', icon: '🚫', name: 'DISABLE', desc: 'Randomly disable one of enemy\'s jokers!' }
];
const VALID_SKILL_IDS = new Set(SKILL_DATA.map((skill) => skill.id));
const VALID_JOKER_IDS = new Set(JOKER_DATA.map((joker) => joker.id));
const jokerIconMap = Object.fromEntries(JOKER_DATA.map(j => [j.id, j.icon]));
let currentJokerIndex = 0;
let jokerPreviewFocusId = null;
let p1SelectedJoker = null;
let p2SelectedJoker = [];
/** Match-only kits — never write these into the player's saved loadout. */
let p1MatchJokers = [];
let p2MatchJokers = [];
let p1DisplayJokers = []; // Full selected jokers (disabled ones still shown, grayed)
let p2DisplayJokers = [];
let p1DisabledJokers = [];
let p2DisabledJokers = [];
let currentSkillIndex = 0;

const LANGUAGE_NATIVE_NAMES = Object.freeze({
    en: 'English',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    ja: '日本語',
    zh: '中文',
    ko: '한국어'
});

function syncLanguageSelectLabels() {
    const select = document.getElementById('language-select');
    if (!select) return;
    Array.from(select.options).forEach((opt) => {
        const native = LANGUAGE_NATIVE_NAMES[opt.value];
        if (native) opt.textContent = native;
    });
}

const translations = {
    en: {
        // Menu
        'RONKBONK': 'RONKBONK',
        // Classic keys must stay classic. Pinkcore-only strings use separate keys below.
        'LOCAL GAME': 'LOCAL',
        'LOCAL': 'LOCAL',
        'LOCAL PVP': 'LOCAL PVP',
        'LOCAL PVP SUB': 'Same screen · 2 players',
        'ONLINE': 'ONLINE',
        'ONLINE PVP': 'ONLINE PVP',
        'ONLINE MATCHMAKE': 'ONLINE MATCHMAKE',
        'ONLINE MATCHMAKE SUB': 'Online PvP · random rival',
        'ONLINE WITH FRIEND': 'ONLINE WITH FRIEND',
        'ONLINE WITH FRIEND SUB': 'Online PvP · host or join code',
        'MULTIPLAYER PVP': 'MULTIPLAYER PVP',
        'MULTIPLAYER PVP SUB': 'Online or same-screen',
        'PLAY VS BOT': 'PLAY VS BOT',
        'PLAY VS BOT SUB': 'Solo · fight AI',
        'SPECTATE SUB': 'AI vs AI · Steam friend',
        'SPECTATE TIER HINT': 'Watch a match — pick a mode',
        'SPECTATE AI': 'SPECTATE AI VS AI',
        'SPECTATE AI SUB': 'Local · two bots fight',
        'SPECTATE STEAM FRIEND': 'SPECTATE STEAM FRIEND',
        'SPECTATE FRIEND SUB': 'Coming soon — not live yet',
        'PLAY TIER HINT': 'Pick how you want to fight',
        'MULTIPLAYER TIER HINT': 'Online PvP · Local shared-screen PvP',
        'ONLINE MATCHMAKE DESC': 'Online PvP — find a random opponent on the internet.',
        'ONLINE WITH FRIEND DESC': 'Online PvP — host a private room or join with a friend\'s code.',
        'Play online against a random opponent.': 'Play online against a random opponent.',
        'Host a private room or join with a friend\'s code.': 'Host a private room or join with a friend\'s code.',
        'CUSTOMIZE': 'CUSTOMIZE',
        'SETTINGS': 'SETTINGS',
        // Settings
        'CONTROLS': 'CONTROLS',
        'Move Up': 'Move Up',
        'Move Down': 'Move Down',
        'Move Left': 'Move Left',
        'Move Right': 'Move Right',
        'Dash': 'Dash',
        'Charge': 'Charge',
        'Skill': 'Skill',
        'Pause': 'Pause',
        'VOLUME': 'VOLUME',
        'Master Volume': 'Master Volume',
        'Music Volume': 'Music Volume',
        'SFX Volume': 'SFX Volume',
        'Sound': 'Sound',
        'LANGUAGE': 'LANGUAGE',
        'SAVE': 'SAVE',
        'SPECIAL SKILLS': 'SPECIAL SKILLS',
        'CONFIRM': 'CONFIRM',
        'JOKER POWERS': 'JOKER POWERS',
        'LOADOUT': 'LOADOUT',
        'Prepare your cube, skill, and jokers': 'Prepare your cube, skill, and jokers',
        'Choose your special skill and joker powers': 'Choose your special skill and joker powers',
        'SPECIAL SKILL': 'SPECIAL SKILL',
        'START': 'START',
        'UPLOAD IMAGE': 'UPLOAD IMAGE',
        'SKILL': 'SKILL',
        'JOKERS': 'JOKERS',
        'None': 'NONE',
        'EXIT GAME': 'EXIT GAME',
        'Passive abilities that last the whole match': 'Passive abilities that last the whole match',
        'INFINITE CHARGE': 'INFINITE CHARGE',
        '5s: Continuous charging with +2 blocks range.': '5s: Continuous charging with +2 blocks range.',
        'CLONE CREATION': 'CLONE CREATION',
        'Permanent: Spawn 2 friendly AI clones.': 'Spawns 2 AI clones per use (3 cubes total: yours + 2 clones).',
        'INVISIBLE TRAIL': 'INVISIBLE',
        'INVISIBLE': 'INVISIBLE',
        'Passive: Opponents cannot see your trail.': 'Passive: enemies cannot see your trail. Activate: 3s full invis (cube + trail) — you still see yourself.',
        'Passive: enemies cannot see your trail. Activate: 3s full invis (cube + trail) — you still see yourself.': 'Passive: enemies cannot see your trail. Activate: 3s full invis (cube + trail) — you still see yourself.',
        'INFINITE TRAILS': 'INFINITE TRAILS',
        'Passive: Your trail never decays.': 'Passive: Your trail never decays.',
        'LASER TRAIL': 'LASER TRAIL',
        '6s: Global laser lines every 1s.': '6s: Random laser lines on boards that have enemy cubes every 1s.',
        '6s: Laser cross on your board every 1s.': '6s: Random laser lines on boards that have enemy cubes every 1s.',
        '6s: Random laser lines on boards that have enemy cubes every 1s.': '6s: Laser lines on enemy boards every 1s. Stack up to 3 waves — fire again to overlap.',
        '6s: Laser lines on enemy boards every 1s. Stack up to 3 waves — fire again to overlap.': '6s: Laser lines on enemy boards every 1s. Stack up to 3 waves — fire again to overlap.',
        'CHARGE+': 'CHARGE+',
        'Your charge moves 2 extra grids.': 'Your charge moves 2 extra grids.',
        'NO HUNGER': 'NO HUNGER',
        'Your hunger bar never goes down! No need to eat apples.': 'Your hunger bar never goes down! No need to eat apples.',
        'RAGE': 'RAGE',
        'All cooldowns are 50% shorter.': 'All cooldowns are 50% shorter.',
        'FAST DASH': 'FAST DASH',
        'Dash has no cooldown.': 'Dash has no cooldown.',
        'BORDER SAFE': 'BORDER SAFE',
        'Slide along board edges — you never fall off.': 'Hit an edge and you auto-slide along it — never fall off.',
        'Hit an edge and you auto-slide along it — never fall off.': 'Hit an edge and you auto-slide along it — never fall off.',
        'You cannot die from border contact.': 'Hit an edge and you auto-slide along it — never fall off.',
        'DOUBLE EFFECTIVE': 'DOUBLE EFFECTIVE',
        'Doubles effectiveness of your other jokers!': 'Doubles effectiveness of your other jokers!',
        'FRIEND WALLS': 'FRIEND WALLS',
        'TRAIL GROWTH': 'TRAIL GROWTH',
        'Your trail grows +1 every second!': 'Your trail grows +1 every 2.5 seconds!',
        'Your trail grows +1 every 2.5 seconds!': 'Your trail grows +1 every 2.5 seconds!',
        'EXTRA LIFE': 'EXTRA LIFE',
        'Survive your first death.': 'Survive your first death.',
        'DISABLE': 'DISABLE',
        'Randomly disable one of enemy\'s jokers!': 'Randomly disable one of enemy\'s jokers!',
        // Additional menu and UI text
        'PLAY': 'PLAY',
        'CHANGE COLOUR': 'CHANGE COLOUR',
        'START (VS AI)': 'START (VS AI)',
        'BOT DIFFICULTY': 'BOT DIFFICULTY',
        'EASY': 'EASY',
        'MEDIUM': 'MEDIUM',
        'HARD': 'HARD',
        'INVINCIBLE': 'ELITE',
        'START': 'START',
        'START MATCH': 'START MATCH',
        'SINGLE PLAYER': 'SINGLE PLAYER',
        'MULTIPLAYER': 'MULTIPLAYER',
        'SPECTATE': 'SPECTATE',
        'SPECTATE BOT': 'SPECTATE BOT',
        'SPECTATE FRIEND': 'SPECTATE FRIEND',
        'SPECTATE FRIEND UNAVAILABLE': 'Live Steam friend spectate is not available yet. Use SPECTATE AI VS AI to watch two bots fight.',
        'BACK': 'BACK',
        'HOST ROOM': 'HOST ROOM',
        'JOIN ROOM': 'JOIN ROOM',
        'ENTER NICKNAME': 'ENTER NICKNAME',
        'ENTER ROOM NAME': 'ENTER ROOM NAME',
        'FEATURED ROOMS': 'FEATURED ROOMS',
        'YOUR RECENT ROOMS': 'YOUR RECENT ROOMS',
        'NO RECENT ROOMS': 'NO RECENT ROOMS',
        'READY TO PLAY': 'READY TO PLAY',
        'LOG: WAITING FOR USER...': 'LOG: WAITING FOR USER...',
        'WAITING ROOM': 'WAITING ROOM',
        'YOU': 'YOU',
        'ENEMY': 'ENEMY',
        'WAITING...': 'WAITING...',
        'NOT READY': 'NOT READY',
        'READY': 'READY',
        'CHANGE CUBE': 'CHANGE CUBE',
        'COPY JOIN LINK': 'COPY JOIN LINK',
        'EXIT LOBBY': 'EXIT LOBBY',
        'CUSTOMIZE CUBE': 'CUSTOMIZE CUBE',
        'CHANGE YOUR CUBE COLOUR': 'CHANGE YOUR CUBE COLOUR',
        'CONFIRM COLOUR': 'CONFIRM COLOUR',
        'ONLINE LOBBY': 'ONLINE LOBBY',
        'SOUND: ON': 'SOUND: ON',
        'SOUND: OFF': 'SOUND: OFF',
        'GOT IT': 'GOT IT',
        'VS': 'VS',
        'CLOSE': 'CLOSE',
        'NEXT': 'NEXT',
        'ENTER GAME': 'ENTER GAME',
        'CLICK TO SKIP': 'CLICK TO SKIP',
        'TUTORIAL': 'TUTORIAL',
        'SKIP TUTORIAL': 'SKIP TUTORIAL',
        'TUTORIAL_SKIP_HINT': 'New here? Play the tutorial — or skip anytime below.',
        'NEW PLAYER TRAINING': 'NEW PLAYER TRAINING',
        'REFRESH': 'REFRESH',
        'ENTER ROOM NAME (e.g. RONK123)': 'ENTER ROOM NAME (e.g. RONK123)',
        'MATCHMAKING': 'MATCHMAKING',
        'MATCHMAKE': 'MATCHMAKE',
        'PLAY WITH FRIEND': 'PLAY WITH FRIEND',
        'STEAM FRIENDS': 'STEAM FRIENDS',
        'FIND MATCH': 'FIND MATCH',
        'CANCEL': 'CANCEL',
        'CANCEL SEARCH': 'CANCEL SEARCH',
        'HOST': 'HOST',
        'JOIN FRIEND': 'JOIN FRIEND',
        'INVITE STEAM FRIEND': 'INVITE STEAM FRIEND',
        'HOST OR JOIN A FRIEND': 'HOST OR JOIN A FRIEND',
        'FRIEND\'S ROOM CODE': 'FRIEND\'S ROOM CODE',
        'ADD STEAM FRIEND': 'ADD STEAM FRIEND',
        'REPORT RIVAL': 'REPORT RIVAL',
        'REPORT': 'REPORT',
        'REPORT_MODAL_SUB': 'Choose a reason. False reports may be ignored.',
        'REPORT_HACK': 'HACK / CHEAT',
        'REPORT_NSFW': '18+ / INAPPROPRIATE IMAGE',
        'REPORT_HARASSMENT': 'HARASSMENT / TOXIC',
        'REPORT_OTHER': 'OTHER',
        'SEARCHING FOR OPPONENT...': 'SEARCHING FOR OPPONENT...',
        'MATCHMAKING CANCELLED': 'MATCHMAKING CANCELLED',
        'WAITING FOR PLAYER...': 'WAITING FOR PLAYER...',
        'JOINING MATCH...': 'JOINING MATCH...',
        'MATCH TIMED OUT': 'MATCH TIMED OUT',
        'FRIEND LOBBY OPEN — INVITE SENT': 'FRIEND LOBBY OPEN — INVITE SENT',
        'STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.': 'STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.',
        // Tutorial text
        'TUTORIAL_MSG_0': 'WASD to move',
        'TUTORIAL_MSG_1': 'F to dash',
        'TUTORIAL_MSG_2': 'C to charge',
        'TUTORIAL_MSG_3': 'Enemy trails kill',
        'TUTORIAL_MSG_4': 'Dash off the edge · watch the map move',
        'TUTORIAL_MSG_4_ARRIVAL': 'You changed boards — map shows where you are',
        'TUTORIAL_MSG_5': 'Claim 3 white squares',
        'TUTORIAL_MSG_6': 'Y for skill',
        'TUTORIAL_MSG_7': 'Eat apples',
        'TUTORIAL_MSG_8': 'Map starts white — claimed boards keep your color',
        'TUTORIAL_MSG_10': '1 kill wins the round',
        'TUTORIAL_MSG_11': 'Round: 1 kill · or 3 boards in a line',
        'TUTORIAL_MSG_12': 'Travel · checkpoints · hunger · skills',
        'TUTORIAL_MSG_13': 'Match: first to 3',
        'TUTORIAL_GATE_SUBTITLE': '9 boards · kill or line · first to 6',
        'NOTIFY_LOSS_KILLS': 'Round = 1 kill or 3 in a line. Match = first to 6.',
        'NOTIFY_LOSS_BOARDS': '3 boards in a line wins the round. Or 1 kill.',
        'SKILL_LOCKED': 'LOCKED — Beat bots',
        'JOKER_LOCKED': 'LOCKED',
        'UNLOCKED': 'UNLOCKED',
        'SKILL UNLOCKED': 'SKILL UNLOCKED',
        'JOKER UNLOCKED': 'JOKER UNLOCKED',
        'BEAT_BOTS_TO_UNLOCK': 'Win vs easy, medium, hard, or elite bots — or beat a player online — to unlock their skill & jokers',
        'BEAT_PLAYER_TO_UNLOCK': 'Beat another player in multiplayer to unlock their skill and jokers',
        'COMPLETE_TUTORIAL_TO_UNLOCK': 'Finish the tutorial first — then beat bots to unlock skills and jokers',
        'TUTORIAL_UNLOCK_HINT': 'Skills and jokers are locked — beat bots or online players to unlock their loadouts first.',
        'NOTIFY_FIRST_SKILL_KICKER': 'First skill unlocked',
        'NOTIFY_FIRST_JOKER_KICKER': 'First joker unlocked',
        'NOTIFY_SKILL_KICKER': 'Skill unlocked',
        'NOTIFY_JOKER_KICKER': 'Joker unlocked',
        'NOTIFY_SKILL_HINT': 'Equip in Loadout → Skills before your next match',
        'NOTIFY_JOKER_HINT': 'Equip in Loadout → Jokers (pick up to 2)',
        'NOTIFY_TUTORIAL_DONE_TITLE': 'Tutorial complete',
        'NOTIFY_TUTORIAL_DONE_BODY': 'Beat rivals to unlock their skills and jokers.',
        'NOTIFY_FIRST_BOARD_TITLE': 'Board captured',
        'NOTIFY_FIRST_BOARD_BODY': 'Line up 3 boards — or win the round with a kill.',
        'NOTIFY_FIRST_SKILL_USE_TITLE': 'Skill activated',
        'NOTIFY_FIRST_SKILL_USE_HINT': 'Press Y during a match to use your equipped skill',
        'FIRST_PLAY_UNLOCK_TITLE': 'SKILLS & JOKERS LOCKED',
        'FIRST_PLAY_UNLOCK_BODY': 'All skills and jokers start locked. Beat bots (easy through elite) or win online to unlock what they were using.',
        'PAUSED': 'PAUSED',
        'RESUME': 'RESUME',
        'QUIT TO MENU': 'QUIT TO MENU',
        'CONTINUE': 'CONTINUE',
        'WAITING FOR RIVAL...': 'WAITING FOR RIVAL...',
        'PLAY AGAIN': 'PLAY AGAIN',
        'MENU': 'MENU',
        // Gamemode
        'GAMEMODE': 'GAMEMODE',
        'GAMEMODE: CLASSIC': 'GAMEMODE: CLASSIC',
        'GAMEMODE: SIMPLISTIC': 'GAMEMODE: SIMPLISTIC',
        'CLASSIC': 'CLASSIC',
        'SIMPLISTIC': 'SIMPLISTIC',
        'RESOLUTION': 'RESOLUTION',
        'PROFILE & CHALLENGES': 'PROFILE & CHALLENGES',
        'HOW TO PLAY': 'HOW TO PLAY',
        'CREDITS': 'CREDITS',
        'STEAM STORE': 'STEAM STORE',
        'STEAM SUPPORT': 'STEAM SUPPORT',
        'LEGAL': 'LEGAL',
        'NOTIFY_RES_KICKER': 'Display',
        'NOTIFY_RES_480_TITLE': '480p',
        'NOTIFY_RES_480_BODY': 'Half render scale. Faster on weak PCs. Pixel Flappy stays faint in this mode.',
        'NOTIFY_RES_480_HINT': 'Change anytime in Settings',
        'NOTIFY_RES_720_TITLE': '720p',
        'NOTIFY_RES_720_BODY': 'Balanced sharpness and speed.',
        'NOTIFY_RES_1080_TITLE': '1080p',
        'NOTIFY_RES_1080_BODY': 'Standard look. Auto-adaptive sharpness when FPS has headroom.',
        'NOTIFY_RES_ULTRA_TITLE': 'Ultra',
        'NOTIFY_RES_ULTRA_BODY': 'Higher internal sharpness for strong PCs. Auto-adaptive still scales down if FPS drops.',
        'NOTIFY_RES_2K_TITLE': '2K',
        'NOTIFY_RES_2K_BODY': 'Sharper. Needs a stronger GPU.',
        'NOTIFY_RES_4K_TITLE': '4K',
        'NOTIFY_RES_4K_BODY': 'Max detail. Heavy.',
        'LEGAL_NOTICE': 'Unauthorized copying, redistribution, or reverse engineering of RonkBonk is prohibited. See COPYRIGHT.txt in the game install folder.',
        'REPORT_NO_RIVAL': 'No online rival to report.',
        'REPORT_ALREADY': 'Already reported this rival recently.',
        'REPORT_SUBMITTED': 'Report submitted. Thanks for keeping RonkBonk safe.',
        'SAFE_UPLOAD_BLOCKED': 'Upload blocked by content safety.',
        'SAFE_SYSTEM_UNAVAILABLE': 'Content safety system unavailable — upload blocked.',
        'SAFE_PROCESS_FAIL': 'Could not process that image safely.',
        'SAFE_PEER_OFFLINE': 'Blocked unsafe shared image (safety offline).',
        'SAFE_PEER_BLOCKED': 'Blocked unsafe shared image.',
        'SAFE_BAD_SIGNATURE': 'File is not a real image (blocked for safety).',
        'SAFE_MALWARE': 'Unsafe content detected in file. Upload blocked.',
        'SAFE_FORBIDDEN_FORMAT': 'That file type is not allowed.',
        'SAFE_READ_FAIL': 'Could not read that file.',
        'SAFE_DECODE_FAIL': 'Could not decode image. Try another JPG/PNG.',
        'SAFE_TOO_SMALL': 'Image is too small.',
        'SAFE_DIMENSIONS': 'Image dimensions too large.',
        'SAFE_AGE_RESTRICTED': 'Image blocked — may be inappropriate for all ages.',
        'SAFE_AGE_FAIL': 'Image failed safety checks.',
        'SAFE_PIXEL_FAIL': 'Could not inspect image.',
        'SAFE_ENCODE_FAIL': 'Could not sanitize image.',
        'SAFE_SHARED_AGE': 'Shared image blocked — may be inappropriate for all ages.',
        'SAFE_SHARED_FAIL': 'Shared image failed safety checks.',
        'SAFE_SHARED_PIXEL': 'Could not inspect shared image.',
        'SAFE_SHARED_ENCODE': 'Could not sanitize shared image.',
        'SAFE_MALWARE_DATA': 'Unsafe image data blocked.',
        'unlocked': 'unlocked',

    },
    es: {
        'RONKBONK': 'RONKBONK',
        'LOCAL GAME': 'PVP LOCAL',
        'LOCAL PVP': 'PVP LOCAL',
        'LOCAL PVP SUB': 'Misma pantalla · 2 jugadores',
        'ONLINE PVP': 'PVP ONLINE',
        'ONLINE MATCHMAKE': 'MATCHMAKING ONLINE',
        'ONLINE MATCHMAKE SUB': 'PvP online · rival aleatorio',
        'ONLINE WITH FRIEND': 'ONLINE CON AMIGO',
        'ONLINE WITH FRIEND SUB': 'PvP online · crear o unirse',
        'MULTIPLAYER PVP': 'MULTIJUGADOR PVP',
        'MULTIPLAYER PVP SUB': 'Online o misma pantalla',
        'PLAY VS BOT': 'JUGAR VS BOT',
        'PLAY VS BOT SUB': 'Solo · contra IA',
        'SPECTATE SUB': 'IA vs IA · amigo Steam',
        'SPECTATE TIER HINT': 'Mira una partida — elige modo',
        'SPECTATE AI': 'ESPECTEAR IA VS IA',
        'SPECTATE AI SUB': 'Local · dos bots pelean',
        'SPECTATE FRIEND SUB': 'Ver a un amigo online',
        'PLAY TIER HINT': 'Elige cómo quieres pelear',
        'MULTIPLAYER TIER HINT': 'PvP online · PvP local pantalla compartida',
        'ONLINE MATCHMAKE DESC': 'PvP online — busca un rival aleatorio en internet.',
        'ONLINE WITH FRIEND DESC': 'PvP online — crea una sala o únete con un código.',
        'ONLINE': 'EN LÍNEA',
        'CUSTOMIZE': 'PERSONALIZAR',
        'SETTINGS': 'CONFIGURACIÓN',
        'CONTROLS': 'CONTROLES',
        'Move Up': 'Arriba',
        'Move Down': 'Abajo',
        'Move Left': 'Izquierda',
        'Move Right': 'Derecha',
        'Dash': 'Impulso',
        'Charge': 'Carga',
        'Skill': 'Habilidad',
        'Pause': 'Pausa',
        'VOLUME': 'VOLUMEN',
        'Master Volume': 'Volumen Principal',
        'Music Volume': 'Volumen de Música',
        'SFX Volume': 'Volumen de Efectos',
        'Sound': 'Sonido',
        'LANGUAGE': 'IDIOMA',
        'SAVE': 'GUARDAR',
        'SPECIAL SKILLS': 'HABILIDADES ESPECIALES',
        'CONFIRM': 'CONFIRMAR',
        'JOKER POWERS': 'PODERES COMODÍN',
        'LOADOUT': 'EQUIPAMIENTO',
        'Prepare your cube, skill, and jokers': 'Prepara tu cubo, habilidad y comodines',
        'START': 'INICIAR',
        'UPLOAD IMAGE': 'SUBIR IMAGEN',
        'SKILL': 'HABILIDAD',
        'JOKERS': 'COMODINES',
        'None': 'NINGUNO',
        'Choose your special skill and joker powers': 'Elige tu habilidad especial y poderes comodín',
        'SPECIAL SKILL': 'HABILIDAD ESPECIAL',
        'EXIT GAME': 'SALIR DEL JUEGO',
        'Passive abilities that last the whole match': 'Habilidades pasivas que duran toda la partida',
        'INFINITE CHARGE': 'CARGA INFINITA',
        '5s: Continuous charging with +2 blocks range.': '5s: Carga continua con +2 rango.',
        'CLONE CREATION': 'CREACIÓN DE CLONES',
        'Permanent: Spawn 2 friendly AI clones.': 'Permanente: invoca 2 clones aliados controlados por IA.',
        'INVISIBLE TRAIL': 'RASTRO INVISIBLE',
        '4s: Your trail becomes invisible to everyone.': '4 s: tu rastro se vuelve invisible para todos.',
        'INFINITE TRAILS': 'RASTROS INFINITOS',
        'Forever: Trails do not decay during activation.': 'Permanente: los rastros no desaparecen mientras está activo.',
        'LASER TRAIL': 'RASTRO LÁSER',
        '6s: Global laser lines every 1s.': '6 s: líneas láser globales cada segundo.',
        'CHARGE+': 'CARGA+',
        'Your charge moves 2 extra grids.': 'Tu carga avanza 2 casillas extra.',
        'NO HUNGER': 'SIN HAMBRE',
        'Your hunger bar never goes down! No need to eat apples.': '¡Tu barra de hambre no baja! No necesitas comer manzanas.',
        'RAGE': 'RABIA',
        'All cooldowns are 50% shorter.': 'Todos los tiempos de recarga son un 50 % más cortos.',
        'FAST DASH': 'IMPULSO RÁPIDO',
        'Dash has no cooldown.': 'El impulso no tiene tiempo de recarga.',
        'BORDER SAFE': 'BORDE SEGURO',
        'You cannot die from border contact.': 'Deslízate por los bordes — nunca caes.',
        'Slide along board edges — you never fall off.': 'Deslízate por los bordes — nunca caes.',
        'DOUBLE EFFECTIVE': 'DOBLE EFECTIVO',
        'Doubles effectiveness of your other jokers!': '¡Duplica la efectividad de tus otros comodines!',
        'FRIEND WALLS': 'MUROS AMIGOS',
        'Spawn 2 passable walls only you can use.': 'Genera 2 muros transitables que solo tú puedes usar.',
        'TRAIL GROWTH': 'RASTRO CRECIENTE',
        'Your trail grows +1 every second!': '¡Tu rastro crece +1 cada segundo!',
        'EXTRA LIFE': 'VIDA EXTRA',
        'Survive your first death.': 'Sobrevive a tu primera muerte.',
        'DISABLE': 'DESACTIVAR',
        'Randomly disable one of enemy\'s jokers!': '¡Desactiva aleatoriamente uno de los comodines del enemigo!',
        'PLAY': 'JUGAR',
        'CHANGE COLOUR': 'CAMBIAR COLOR',
        'START (VS AI)': 'INICIAR (VS IA)',
        'SPECTATE': 'ESPECTADOR',
        'MULTIPLAYER': 'MULTIJUGADOR',
        'BACK': 'ATRÁS',
        'HOST ROOM': 'CREAR SALA',
        'JOIN ROOM': 'UNIRSE A SALA',
        'ENTER NICKNAME': 'INGRESAR APODO',
        'ENTER ROOM NAME': 'INGRESAR NOMBRE DE SALA',
        'FEATURED ROOMS': 'SALAS DESTACADAS',
        'YOUR RECENT ROOMS': 'TUS SALAS RECIENTES',
        'NO RECENT ROOMS': 'SIN SALAS RECIENTES',
        'READY TO PLAY': 'LISTO PARA JUGAR',
        'LOG: WAITING FOR USER...': 'REGISTRO: ESPERANDO USUARIO...',
        'WAITING ROOM': 'SALA DE ESPERA',
        'YOU': 'TÚ',
        'ENEMY': 'ENEMIGO',
        'WAITING...': 'ESPERANDO...',
        'NOT READY': 'NO LISTO',
        'READY': 'LISTO',
        'CHANGE CUBE': 'CAMBIAR CUBO',
        'COPY JOIN LINK': 'COPIAR ENLACE',
        'EXIT LOBBY': 'SALIR DEL LOBBY',
        'CUSTOMIZE CUBE': 'PERSONALIZAR CUBO',
        'CHANGE YOUR CUBE COLOUR': 'CAMBIAR COLOR DEL CUBO',
        'CONFIRM COLOUR': 'CONFIRMAR COLOR',
        'ONLINE LOBBY': 'SALA EN LÍNEA',
        'SOUND: ON': 'SONIDO: SÍ',
        'SOUND: OFF': 'SONIDO: NO',
        'GOT IT': 'ENTENDIDO',
        'VS': 'VS',
        'CLOSE': 'CERRAR',
        'NEXT': 'SIGUIENTE',
        'ENTER GAME': 'ENTRAR AL JUEGO',
        'CLICK TO SKIP': 'CLIC PARA OMITIR',
        'REFRESH': 'ACTUALIZAR',
        'ENTER ROOM NAME (e.g. RONK123)': 'INGRESAR NOMBRE DE SALA (ej: RONK123)',
        'TUTORIAL_0': 'MUÉVETE CON WASD',
        'TUTORIAL_1': 'IMPULSO CON F',
        'TUTORIAL_2': 'CARGA CON C',
        'TUTORIAL_3': 'HABILIDADES ESPECIALES: abre «Habilidades especiales»',
        'TUTORIAL_4': 'ELIGE HABILIDAD: usa las flechas',
        'TUTORIAL_5': 'ACTIVA LA HABILIDAD: pulsa Y en partida',
        'TUTORIAL_MSG_4': 'Dash fuera del borde · mira el mapa moverse',
        'PAUSED': 'PAUSADO',
        'RESUME': 'REANUDAR',
        'QUIT TO MENU': 'SALIR AL MENÚ',
        'CONTINUE': 'CONTINUAR',
        'WAITING FOR RIVAL...': 'ESPERANDO RIVAL...',
        'PLAY AGAIN': 'JUGAR DE NUEVO',
        'MENU': 'MENÚ',
        // Gamemode
        'GAMEMODE': 'MODO DE JUEGO',
        'GAMEMODE: CLASSIC': 'MODO DE JUEGO: CLÁSICO',
        'GAMEMODE: SIMPLISTIC': 'MODO DE JUEGO: SIMPLIFICADO',
        'CLASSIC': 'CLÁSICO',
        'SIMPLISTIC': 'SIMPLIFICADO',
        '5s: Continuous charging with +2 blocks range.': '5 s: carga continua con +2 casillas de alcance.',
        'Your trail grows +1 every second!': '¡Tu rastro crece +1 cada segundo!',
        'Randomly disable one of enemy\'s jokers!': '¡Desactiva al azar uno de los comodines del enemigo!',
        'BOT DIFFICULTY': 'DIFICULTAD DEL BOT',
        'EASY': 'FÁCIL',
        'MEDIUM': 'MEDIO',
        'HARD': 'DIFÍCIL',
        'INVINCIBLE': 'ÉLITE',
        'MATCHMAKING': 'EMPAREJAMIENTO',
        'MATCHMAKE': 'BUSCAR PARTIDA',
        'PLAY WITH FRIEND': 'JUGAR CON AMIGO',
        'STEAM FRIENDS': 'AMIGOS DE STEAM',
        'FIND MATCH': 'BUSCAR PARTIDA',
        'CANCEL': 'CANCELAR',
        'CANCEL SEARCH': 'CANCELAR BÚSQUEDA',
        'HOST': 'CREAR PARTIDA',
        'JOIN FRIEND': 'UNIRSE A AMIGO',
        'INVITE STEAM FRIEND': 'INVITAR AMIGO DE STEAM',
        'HOST OR JOIN A FRIEND': 'CREA O ÚNETE A UNA PARTIDA',
        'FRIEND\'S ROOM CODE': 'CÓDIGO DE SALA DEL AMIGO',
        'ADD STEAM FRIEND': 'AÑADIR AMIGO DE STEAM',
        'REPORT RIVAL': 'REPORTAR RIVAL',
        'REPORT': 'REPORTAR',
        'REPORT_MODAL_SUB': 'Elige un motivo. Los reportes falsos pueden ignorarse.',
        'REPORT_HACK': 'HACK / TRAMPA',
        'REPORT_NSFW': 'CONTENIDO +18 / INAPROPIADO',
        'REPORT_HARASSMENT': 'ACOSO / TÓXICO',
        'REPORT_OTHER': 'OTRO',
        'SEARCHING FOR OPPONENT...': 'BUSCANDO OPONENTE...',
        'MATCHMAKING CANCELLED': 'EMPAREJAMIENTO CANCELADO',
        'WAITING FOR PLAYER...': 'ESPERANDO JUGADOR...',
        'JOINING MATCH...': 'UNIÉNDOSE A LA PARTIDA...',
        'MATCH TIMED OUT': 'TIEMPO DE BÚSQUEDA AGOTADO',
        'FRIEND LOBBY OPEN — INVITE SENT': 'SALA ABIERTA — INVITACIÓN ENVIADA',
        'STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.': 'SE REQUIERE STEAM PARA JUGAR CON AMIGOS. Inicia el juego desde Steam.',
        'Passive: Opponents cannot see your trail.': 'Pasiva: los rivales no pueden ver tu rastro.',
        'Passive: Your trail never decays.': 'Pasiva: tu rastro nunca desaparece.',
        'SPECTATE FRIEND': 'ESPECTEAR AMIGO',
        'SPECTATE FRIEND UNAVAILABLE': 'Espectear amigos en vivo aún no está disponible. Las salas de amigos de Steam permiten jugar juntos, pero esta versión no tiene retransmisión de espectador. Usa ESPECTEAR para un duelo élite IA vs IA.',
        'TUTORIAL': 'TUTORIAL',
        'SKIP TUTORIAL': 'SALTAR TUTORIAL',
        'NEW PLAYER TRAINING': 'ENTRENAMIENTO PARA NUEVOS',
        'TUTORIAL_MSG_0': 'WASD para moverte',
        'TUTORIAL_MSG_1': 'F para dash',
        'TUTORIAL_MSG_2': 'C para cargar',
        'TUTORIAL_MSG_3': 'Los rastros enemigos matan',
        'TUTORIAL_MSG_4_ARRIVAL': 'Cambiaste de tablero — el mapa muestra dónde estás',
        'TUTORIAL_MSG_5': 'Reclama las 3 casillas blancas para poseer este tablero',
        'TUTORIAL_MSG_6': 'Y para la habilidad',
        'TUTORIAL_MSG_7': 'Come manzanas',
        'TUTORIAL_MSG_8': 'El mapa empieza en blanco — los tableros reclamados conservan tu color',
        'TUTORIAL_MSG_10': 'Mata al rival para ganar la ronda — carga a través de él',
        'TUTORIAL_MSG_11': 'Ronda: 1 kill · o 3 tableros en línea',
        'TUTORIAL_MSG_12': 'Viaje · checkpoints · hambre · skills',
        'TUTORIAL_MSG_13': 'Partida: primero a 3',
        'TUTORIAL_GATE_SUBTITLE': '9 tableros · kill o línea · primero a 6',
        'NOTIFY_LOSS_KILLS': 'Ronda = 1 kill o 3 en línea. Partida = primero a 6.',
        'NOTIFY_LOSS_BOARDS': '3 tableros en línea ganan la ronda. O 1 kill.',
        'SKILL_LOCKED': 'BLOQUEADO — Vence bots para desbloquear',
        'JOKER_LOCKED': 'BLOQUEADO',
        'UNLOCKED': 'DESBLOQUEADO',
        'SKILL UNLOCKED': 'HABILIDAD DESBLOQUEADA',
        'JOKER UNLOCKED': 'JOKER DESBLOQUEADO',
        'BEAT_BOTS_TO_UNLOCK': 'Gana vs bots fácil, medio, difícil o élite — o vence a un jugador online — para desbloquear su habilidad y jokers',
        'BEAT_PLAYER_TO_UNLOCK': 'Vence a otro jugador en multijugador para desbloquear su habilidad y jokers',
        'COMPLETE_TUTORIAL_TO_UNLOCK': 'Termina el tutorial primero — luego vence bots para desbloquear habilidades y jokers',
        'TUTORIAL_UNLOCK_HINT': 'Habilidades y jokers bloqueados — vence bots o jugadores online para desbloquear sus loadouts.',
        'NOTIFY_FIRST_SKILL_KICKER': 'Primera habilidad desbloqueada',
        'NOTIFY_FIRST_JOKER_KICKER': 'Primer joker desbloqueado',
        'NOTIFY_SKILL_KICKER': 'Habilidad desbloqueada',
        'NOTIFY_JOKER_KICKER': 'Joker desbloqueado',
        'NOTIFY_SKILL_HINT': 'Equípala en Loadout → Habilidades antes de la siguiente partida',
        'NOTIFY_JOKER_HINT': 'Equípala en Loadout → Jokers (elige hasta 2)',
        'NOTIFY_TUTORIAL_DONE_TITLE': 'Tutorial completado',
        'NOTIFY_TUTORIAL_DONE_BODY': 'Vence rivales para desbloquear sus habilidades y jokers.',
        'NOTIFY_FIRST_BOARD_TITLE': 'Tablero capturado',
        'NOTIFY_FIRST_BOARD_BODY': 'Alinea 3 tableros — o gana con 1 kill.',
        'NOTIFY_FIRST_SKILL_USE_TITLE': 'Habilidad activada',
        'NOTIFY_FIRST_SKILL_USE_HINT': 'Pulsa Y durante la partida para usar tu habilidad equipada',
        'FIRST_PLAY_UNLOCK_TITLE': 'HABILIDADES Y JOKERS BLOQUEADOS',
        'FIRST_PLAY_UNLOCK_BODY': 'Todas las habilidades y jokers empiezan bloqueados. Vence bots (fácil a élite) o gana online para desbloquear lo que usaban.',
        'RESOLUTION': 'RESOLUCIÓN',
        'LEGAL': 'LEGAL',
        'LEGAL_NOTICE': 'Queda prohibida la copia, redistribución o ingeniería inversa no autorizada de RonkBonk. Consulta COPYRIGHT.txt en la carpeta de instalación.',
        'REPORT_NO_RIVAL': 'No hay rival online para reportar.',
        'REPORT_ALREADY': 'Ya reportaste a este rival hace poco.',
        'REPORT_SUBMITTED': 'Reporte enviado. Gracias por cuidar RonkBonk.',
        'SAFE_UPLOAD_BLOCKED': 'Subida bloqueada por seguridad de contenido.',
        'SAFE_SYSTEM_UNAVAILABLE': 'Sistema de seguridad no disponible — subida bloqueada.',
        'SAFE_PROCESS_FAIL': 'No se pudo procesar esa imagen de forma segura.',
        'SAFE_PEER_OFFLINE': 'Imagen compartida bloqueada (seguridad desconectada).',
        'SAFE_PEER_BLOCKED': 'Imagen compartida insegura bloqueada.',
        'SAFE_BAD_SIGNATURE': 'El archivo no es una imagen real (bloqueado por seguridad).',
        'SAFE_MALWARE': 'Contenido inseguro detectado. Subida bloqueada.',
        'SAFE_FORBIDDEN_FORMAT': 'Ese tipo de archivo no está permitido.',
        'SAFE_READ_FAIL': 'No se pudo leer ese archivo.',
        'SAFE_DECODE_FAIL': 'No se pudo decodificar la imagen. Prueba otro JPG/PNG.',
        'SAFE_TOO_SMALL': 'La imagen es demasiado pequeña.',
        'SAFE_DIMENSIONS': 'Las dimensiones de la imagen son demasiado grandes.',
        'SAFE_AGE_RESTRICTED': 'Imagen bloqueada — puede no ser apta para todas las edades.',
        'SAFE_AGE_FAIL': 'La imagen no pasó las comprobaciones de seguridad.',
        'SAFE_PIXEL_FAIL': 'No se pudo inspeccionar la imagen.',
        'SAFE_ENCODE_FAIL': 'No se pudo sanitizar la imagen.',
        'SAFE_SHARED_AGE': 'Imagen compartida bloqueada — puede no ser apta para todas las edades.',
        'SAFE_SHARED_FAIL': 'La imagen compartida no pasó las comprobaciones.',
        'SAFE_SHARED_PIXEL': 'No se pudo inspeccionar la imagen compartida.',
        'SAFE_SHARED_ENCODE': 'No se pudo sanitizar la imagen compartida.',
        'SAFE_MALWARE_DATA': 'Datos de imagen inseguros bloqueados.',
        'unlocked': 'desbloqueado',

    },
    fr: {
        'RONKBONK': 'RONKBONK',
        'LOCAL GAME': 'PVP LOCAL',
        'LOCAL PVP': 'PVP LOCAL',
        'LOCAL PVP SUB': 'Même écran · 2 joueurs',
        'ONLINE PVP': 'PVP EN LIGNE',
        'ONLINE MATCHMAKE': 'MATCHMAKING EN LIGNE',
        'ONLINE MATCHMAKE SUB': 'PvP en ligne · rival aléatoire',
        'ONLINE WITH FRIEND': 'EN LIGNE AVEC UN AMI',
        'ONLINE WITH FRIEND SUB': 'PvP en ligne · héberger ou rejoindre',
        'MULTIPLAYER PVP': 'MULTIJOUEUR PVP',
        'MULTIPLAYER PVP SUB': 'En ligne ou même écran',
        'PLAY VS BOT': 'JOUER VS BOT',
        'PLAY VS BOT SUB': 'Solo · contre l\'IA',
        'SPECTATE SUB': 'IA vs IA · ami Steam',
        'SPECTATE TIER HINT': 'Regarde un match — choisis un mode',
        'SPECTATE AI': 'SPECTATEUR IA VS IA',
        'SPECTATE AI SUB': 'Local · deux bots s\'affrontent',
        'SPECTATE FRIEND SUB': 'Regarder un ami en ligne',
        'PLAY TIER HINT': 'Choisis comment tu veux combattre',
        'MULTIPLAYER TIER HINT': 'PvP en ligne · PvP local écran partagé',
        'ONLINE MATCHMAKE DESC': 'PvP en ligne — trouve un adversaire aléatoire sur internet.',
        'ONLINE WITH FRIEND DESC': 'PvP en ligne — héberge une salle ou rejoins avec un code.',
        'ONLINE': 'EN LIGNE',
        'CUSTOMIZE': 'PERSONNALISER',
        'SETTINGS': 'PARAMÈTRES',
        'CONTROLS': 'COMMANDES',
        'Move Up': 'Haut',
        'Move Down': 'Bas',
        'Move Left': 'Gauche',
        'Move Right': 'Droite',
        'Dash': 'Ruée',
        'Charge': 'Charge',
        'Skill': 'Compétence',
        'Pause': 'Pause',
        'VOLUME': 'VOLUME',
        'Master Volume': 'Volume Principal',
        'Music Volume': 'Volume Musique',
        'SFX Volume': 'Volume Effets',
        'Sound': 'Son',
        'LANGUAGE': 'LANGUE',
        'SAVE': 'ENREGISTRER',
        'SPECIAL SKILLS': 'COMPÉTENCES SPÉCIALES',
        'CONFIRM': 'CONFIRMER',
        'JOKER POWERS': 'POUVOIRS JOKER',
        'LOADOUT': 'ÉQUIPEMENT',
        'Prepare your cube, skill, and jokers': 'Préparez votre cube, compétence et jokers',
        'START': 'DÉMARRER',
        'UPLOAD IMAGE': 'IMPORTER IMAGE',
        'SKILL': 'COMPÉTENCE',
        'JOKERS': 'JOKERS',
        'None': 'AUCUN',
        'Choose your special skill and joker powers': 'Choisissez votre compétence spéciale et vos pouvoirs joker',
        'SPECIAL SKILL': 'COMPÉTENCE SPÉCIALE',
        'EXIT GAME': 'QUITTER LE JEU',
        'Passive abilities that last the whole match': 'Capacités passives qui durent toute la partie',
        'INFINITE CHARGE': 'CHARGE INFINIE',
        '5s: Continuous charging with +2 blocks range.': '5s: Charge continue avec +2 portée.',
        'CLONE CREATION': 'CRÉATION DE CLONES',
        'Permanent: Spawn 2 friendly AI clones.': 'Permanent : invoque 2 clones alliés contrôlés par l\'IA.',
        'INVISIBLE TRAIL': 'PISTE INVISIBLE',
        '4s: Your trail becomes invisible to everyone.': '4 s : votre traînée devient invisible pour tous.',
        'INFINITE TRAILS': 'PISTES INFINIES',
        'Forever: Trails do not decay during activation.': 'Permanent : les traînées ne disparaissent pas tant que c\'est actif.',
        'LASER TRAIL': 'PISTE LASER',
        '6s: Global laser lines every 1s.': '6 s : lignes laser globales chaque seconde.',
        'CHARGE+': 'CHARGE+',
        'Your charge moves 2 extra grids.': 'Votre charge avance de 2 cases supplémentaires.',
        'NO HUNGER': 'SANS FAIM',
        'Your hunger bar never goes down! No need to eat apples.': 'Votre barre de faim ne descend jamais ! Pas besoin de manger des pommes.',
        'RAGE': 'RAGE',
        'All cooldowns are 50% shorter.': 'Tous les temps de recharge sont 50% plus courts.',
        'FAST DASH': 'RUÉE RAPIDE',
        'Dash has no cooldown.': 'La ruée n\'a pas de temps de recharge.',
        'BORDER SAFE': 'BORDURE SÛRE',
        'You cannot die from border contact.': 'Glisse le long des bords — tu ne tombes jamais.',
        'Slide along board edges — you never fall off.': 'Glisse le long des bords — tu ne tombes jamais.',
        'DOUBLE EFFECTIVE': 'DOUBLE EFFICACE',
        'Doubles effectiveness of your other jokers!': 'Double l\'efficacité de vos autres jokers !',
        'FRIEND WALLS': 'MURS AMIS',
        'Spawn 2 passable walls only you can use.': 'Fait apparaître 2 murs traversables que seul vous pouvez utiliser.',
        'TRAIL GROWTH': 'TRAÎNÉE GRANDISSANTE',
        'Your trail grows +1 every second!': 'Votre piste grandit de +1 chaque seconde !',
        'EXTRA LIFE': 'VIE SUPPLÉMENTAIRE',
        'Survive your first death.': 'Survivez à votre première mort.',
        'DISABLE': 'DÉSACTIVER',
        'Randomly disable one of enemy\'s jokers!': 'Désactive aléatoirement l\'un des jokers de l\'ennemi !',
        'PLAY': 'JOUER',
        'CHANGE COLOUR': 'CHANGER COULEUR',
        'START (VS AI)': 'COMMENCER (VS IA)',
        'SPECTATE': 'SPECTATEUR',
        'MULTIPLAYER': 'MULTIJOUEUR',
        'BACK': 'RETOUR',
        'HOST ROOM': 'CRÉER SALLE',
        'JOIN ROOM': 'REJOINDRE SALLE',
        'ENTER NICKNAME': 'ENTRER SURNOM',
        'ENTER ROOM NAME': 'ENTRER NOM SALLE',
        'FEATURED ROOMS': 'SALLES EN VEDETTE',
        'YOUR RECENT ROOMS': 'VOS SALLES RÉCENTES',
        'NO RECENT ROOMS': 'AUCUNE SALLE RÉCENTE',
        'READY TO PLAY': 'PRÊT À JOUER',
        'LOG: WAITING FOR USER...': 'LOG: EN ATTENTE D\'UTILISATEUR...',
        'WAITING ROOM': 'SALLE D\'ATTENTE',
        'YOU': 'VOUS',
        'ENEMY': 'ENNEMI',
        'WAITING...': 'EN ATTENTE...',
        'NOT READY': 'NON PRÊT',
        'READY': 'PRÊT',
        'CHANGE CUBE': 'CHANGER CUBE',
        'COPY JOIN LINK': 'COPIER LIEN',
        'EXIT LOBBY': 'QUITTER SALON',
        'CUSTOMIZE CUBE': 'PERSONNALISER CUBE',
        'CHANGE YOUR CUBE COLOUR': 'CHANGER COULEUR CUBE',
        'CONFIRM COLOUR': 'CONFIRMER COULEUR',
        'ONLINE LOBBY': 'SALON EN LIGNE',
        'SOUND: ON': 'SON: ON',
        'SOUND: OFF': 'SON: OFF',
        'GOT IT': 'COMPRIS',
        'VS': 'VS',
        'CLOSE': 'FERMER',
        'NEXT': 'SUIVANT',
        'ENTER GAME': 'ENTRER DANS LE JEU',
        'CLICK TO SKIP': 'CLIQUEZ POUR PASSER',
        'REFRESH': 'ACTUALISER',
        'ENTER ROOM NAME (e.g. RONK123)': 'ENTRER LE NOM DE LA SALLE (ex: RONK123)',
        'TUTORIAL_0': 'DÉPLACEZ-VOUS AVEC WASD',
        'TUTORIAL_1': 'RUÉE AVEC F',
        'TUTORIAL_2': 'CHARGE AVEC C',
        'TUTORIAL_3': 'COMPÉTENCES SPÉCIALES : ouvrez « Compétences spéciales »',
        'TUTORIAL_4': 'CHOISIR : utilisez les flèches',
        'TUTORIAL_5': 'ACTIVER : appuyez sur Y en jeu',
        'TUTORIAL_MSG_4': 'Dash hors du bord · regarde la carte bouger',
        'PAUSED': 'EN PAUSE',
        'RESUME': 'REPRENDRE',
        'QUIT TO MENU': 'QUITTER AU MENU',
        'CONTINUE': 'CONTINUER',
        'WAITING FOR RIVAL...': 'EN ATTENTE DU RIVAL...',
        'PLAY AGAIN': 'REJOUER',
        'MENU': 'MENU',
        // Gamemode
        'GAMEMODE': 'MODE DE JEU',
        'GAMEMODE: CLASSIC': 'MODE DE JEU: CLASSIQUE',
        'GAMEMODE: SIMPLISTIC': 'MODE DE JEU: SIMPLIFIÉ',
        'CLASSIC': 'CLASSIQUE',
        'SIMPLISTIC': 'SIMPLIFIÉ',
        '5s: Continuous charging with +2 blocks range.': '5 s : charge continue avec +2 cases de portée.',
        'BOT DIFFICULTY': 'DIFFICULTÉ DU BOT',
        'EASY': 'FACILE',
        'MEDIUM': 'MOYEN',
        'HARD': 'DIFFICILE',
        'INVINCIBLE': 'ÉLITE',
        'MATCHMAKING': 'MATCHMAKING',
        'MATCHMAKE': 'TROUVER UNE PARTIE',
        'PLAY WITH FRIEND': 'JOUER AVEC UN AMI',
        'STEAM FRIENDS': 'AMIS STEAM',
        'FIND MATCH': 'TROUVER UNE PARTIE',
        'CANCEL': 'ANNULER',
        'CANCEL SEARCH': 'ANNULER LA RECHERCHE',
        'HOST': 'HÉBERGER',
        'JOIN FRIEND': 'REJOINDRE UN AMI',
        'INVITE STEAM FRIEND': 'INVITER UN AMI STEAM',
        'HOST OR JOIN A FRIEND': 'HÉBERGEZ OU REJOIGNEZ UN AMI',
        'FRIEND\'S ROOM CODE': 'CODE DE SALLE DE L\'AMI',
        'ADD STEAM FRIEND': 'AJOUTER UN AMI STEAM',
        'REPORT RIVAL': 'SIGNALER LE RIVAL',
        'REPORT': 'SIGNALER',
        'REPORT_MODAL_SUB': 'Choisis une raison. Les faux signalements peuvent être ignorés.',
        'REPORT_HACK': 'HACK / TRICHE',
        'REPORT_NSFW': 'CONTENU 18+ / INAPPROPRIÉ',
        'REPORT_HARASSMENT': 'HARCÈLEMENT / TOXIQUE',
        'REPORT_OTHER': 'AUTRE',
        'SEARCHING FOR OPPONENT...': 'RECHERCHE D\'UN ADVERSAIRE...',
        'MATCHMAKING CANCELLED': 'MATCHMAKING ANNULÉ',
        'WAITING FOR PLAYER...': 'EN ATTENTE D\'UN JOUEUR...',
        'JOINING MATCH...': 'CONNEXION À LA PARTIE...',
        'MATCH TIMED OUT': 'DÉLAI DE RECHERCHE DÉPASSÉ',
        'FRIEND LOBBY OPEN — INVITE SENT': 'SALLE OUVERTE — INVITATION ENVOYÉE',
        'STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.': 'STEAM EST REQUIS POUR JOUER AVEC DES AMIS. Lancez le jeu via Steam.',
        'Passive: Opponents cannot see your trail.': 'Passif : les adversaires ne voient pas ta traînée.',
        'Passive: Your trail never decays.': 'Passif : ta traînée ne disparaît jamais.',
        'SPECTATE FRIEND': 'SPECTATEUR AMI',
        'SPECTATE FRIEND UNAVAILABLE': 'Spectater un ami en direct n’est pas encore disponible. Les lobbies Steam permettent de jouer ensemble, mais cette version n’a pas de relais spectateur. Utilise SPECTATE pour un match élite IA vs IA.',
        'TUTORIAL': 'TUTORIEL',
        'SKIP TUTORIAL': 'PASSER LE TUTORIEL',
        'NEW PLAYER TRAINING': 'ENTRAÎNEMENT NOUVEAU JOUEUR',
        'TUTORIAL_MSG_0': 'WASD pour bouger',
        'TUTORIAL_MSG_1': 'F pour dash',
        'TUTORIAL_MSG_2': 'C pour charger',
        'TUTORIAL_MSG_3': 'Les traînées ennemies tuent',
        'TUTORIAL_MSG_4_ARRIVAL': 'Tu as changé de plateau — la carte montre où tu es',
        'TUTORIAL_MSG_5': 'Prends les 3 cases blanches pour posséder ce plateau',
        'TUTORIAL_MSG_6': 'Y pour la compétence',
        'TUTORIAL_MSG_7': 'Mange des pommes',
        'TUTORIAL_MSG_8': 'La carte commence blanche — les plateaux pris gardent ta couleur',
        'TUTORIAL_MSG_10': 'Tue le rival pour gagner la manche — charge à travers lui',
        'TUTORIAL_MSG_11': 'Manche: 1 kill · ou 3 plateaux alignés',
        'TUTORIAL_MSG_12': 'Voyage · checkpoints · faim · skills',
        'TUTORIAL_MSG_13': 'Match: premier à 3',
        'TUTORIAL_GATE_SUBTITLE': '9 plateaux · kill ou ligne · premier à 6',
        'NOTIFY_LOSS_KILLS': 'Manche = 1 kill ou 3 alignés. Match = premier à 6.',
        'NOTIFY_LOSS_BOARDS': '3 plateaux alignés gagnent la manche. Ou 1 kill.',
        'SKILL_LOCKED': 'VERROUILLÉ — Bats des bots pour débloquer',
        'JOKER_LOCKED': 'VERROUILLÉ',
        'UNLOCKED': 'DÉBLOQUÉ',
        'SKILL UNLOCKED': 'COMPÉTENCE DÉBLOQUÉE',
        'JOKER UNLOCKED': 'JOKER DÉBLOQUÉ',
        'BEAT_BOTS_TO_UNLOCK': 'Gagne vs bots facile, moyen, difficile ou élite — ou bats un joueur en ligne — pour débloquer sa compétence et ses jokers',
        'BEAT_PLAYER_TO_UNLOCK': 'Bats un autre joueur en multijoueur pour débloquer sa compétence et ses jokers',
        'COMPLETE_TUTORIAL_TO_UNLOCK': 'Termine d’abord le tutoriel — puis bats des bots pour débloquer compétences et jokers',
        'TUTORIAL_UNLOCK_HINT': 'Compétences et jokers verrouillés — bats des bots ou joueurs en ligne pour débloquer leurs loadouts.',
        'NOTIFY_FIRST_SKILL_KICKER': 'Première compétence débloquée',
        'NOTIFY_FIRST_JOKER_KICKER': 'Premier joker débloqué',
        'NOTIFY_SKILL_KICKER': 'Compétence débloquée',
        'NOTIFY_JOKER_KICKER': 'Joker débloqué',
        'NOTIFY_SKILL_HINT': 'Équipe-la dans Loadout → Compétences avant le prochain match',
        'NOTIFY_JOKER_HINT': 'Équipe-la dans Loadout → Jokers (jusqu’à 2)',
        'NOTIFY_TUTORIAL_DONE_TITLE': 'Tutoriel terminé',
        'NOTIFY_TUTORIAL_DONE_BODY': 'Bats des rivaux pour débloquer leurs compétences et jokers.',
        'NOTIFY_FIRST_BOARD_TITLE': 'Plateau capturé',
        'NOTIFY_FIRST_BOARD_BODY': 'Aligne 3 plateaux — ou gagne avec 1 kill.',
        'NOTIFY_FIRST_SKILL_USE_TITLE': 'Compétence activée',
        'NOTIFY_FIRST_SKILL_USE_HINT': 'Appuie sur Y pendant un match pour utiliser ta compétence équipée',
        'FIRST_PLAY_UNLOCK_TITLE': 'COMPÉTENCES ET JOKERS VERROUILLÉS',
        'FIRST_PLAY_UNLOCK_BODY': 'Toutes les compétences et jokers commencent verrouillés. Bats des bots (facile à élite) ou gagne en ligne pour débloquer ce qu’ils utilisaient.',
        'RESOLUTION': 'RÉSOLUTION',
        'LEGAL': 'MENTIONS LÉGALES',
        'LEGAL_NOTICE': 'La copie, la redistribution ou l’ingénierie inverse non autorisées de RonkBonk sont interdites. Voir COPYRIGHT.txt dans le dossier d’installation.',
        'REPORT_NO_RIVAL': 'Aucun rival en ligne à signaler.',
        'REPORT_ALREADY': 'Tu as déjà signalé ce rival récemment.',
        'REPORT_SUBMITTED': 'Signalement envoyé. Merci de protéger RonkBonk.',
        'SAFE_UPLOAD_BLOCKED': 'Envoi bloqué par la sécurité du contenu.',
        'SAFE_SYSTEM_UNAVAILABLE': 'Système de sécurité indisponible — envoi bloqué.',
        'SAFE_PROCESS_FAIL': 'Impossible de traiter cette image en toute sécurité.',
        'SAFE_PEER_OFFLINE': 'Image partagée bloquée (sécurité hors ligne).',
        'SAFE_PEER_BLOCKED': 'Image partagée dangereuse bloquée.',
        'SAFE_BAD_SIGNATURE': 'Le fichier n’est pas une vraie image (bloqué pour sécurité).',
        'SAFE_MALWARE': 'Contenu dangereux détecté. Envoi bloqué.',
        'SAFE_FORBIDDEN_FORMAT': 'Ce type de fichier n’est pas autorisé.',
        'SAFE_READ_FAIL': 'Impossible de lire ce fichier.',
        'SAFE_DECODE_FAIL': 'Impossible de décoder l’image. Essaie un autre JPG/PNG.',
        'SAFE_TOO_SMALL': 'L’image est trop petite.',
        'SAFE_DIMENSIONS': 'Dimensions d’image trop grandes.',
        'SAFE_AGE_RESTRICTED': 'Image bloquée — peut être inappropriée pour tous les âges.',
        'SAFE_AGE_FAIL': 'L’image a échoué aux contrôles de sécurité.',
        'SAFE_PIXEL_FAIL': 'Impossible d’inspecter l’image.',
        'SAFE_ENCODE_FAIL': 'Impossible de nettoyer l’image.',
        'SAFE_SHARED_AGE': 'Image partagée bloquée — peut être inappropriée pour tous les âges.',
        'SAFE_SHARED_FAIL': 'L’image partagée a échoué aux contrôles.',
        'SAFE_SHARED_PIXEL': 'Impossible d’inspecter l’image partagée.',
        'SAFE_SHARED_ENCODE': 'Impossible de nettoyer l’image partagée.',
        'SAFE_MALWARE_DATA': 'Données d’image dangereuses bloquées.',
        'unlocked': 'débloqué',

    },
    de: {
        'RONKBONK': 'RONKBONK',
        'LOCAL GAME': 'LOKALES PVP',
        'LOCAL PVP': 'LOKALES PVP',
        'LOCAL PVP SUB': 'Gleicher Bildschirm · 2 Spieler',
        'ONLINE PVP': 'ONLINE-PVP',
        'ONLINE MATCHMAKE': 'ONLINE MATCHMAKE',
        'ONLINE MATCHMAKE SUB': 'Online-PvP · Zufallsgegner',
        'ONLINE WITH FRIEND': 'ONLINE MIT FREUND',
        'ONLINE WITH FRIEND SUB': 'Online-PvP · hosten oder beitreten',
        'MULTIPLAYER PVP': 'MEHRSPIELER-PVP',
        'MULTIPLAYER PVP SUB': 'Online oder gleicher Bildschirm',
        'PLAY VS BOT': 'SPIELEN VS BOT',
        'PLAY VS BOT SUB': 'Solo · gegen KI',
        'SPECTATE SUB': 'KI vs KI · Steam-Freund',
        'SPECTATE TIER HINT': 'Match ansehen — Modus wählen',
        'SPECTATE AI': 'KI VS KI ZUSCHAUEN',
        'SPECTATE AI SUB': 'Lokal · zwei Bots kämpfen',
        'SPECTATE FRIEND SUB': 'Freund online zuschauen',
        'PLAY TIER HINT': 'Wähle, wie du kämpfen willst',
        'MULTIPLAYER TIER HINT': 'Online-PvP · Lokales geteiltes PVP',
        'ONLINE MATCHMAKE DESC': 'Online-PvP — finde einen zufälligen Gegner im Internet.',
        'ONLINE WITH FRIEND DESC': 'Online-PvP — erstelle einen Raum oder tritt mit Code bei.',
        'ONLINE': 'ONLINE',
        'CUSTOMIZE': 'ANPASSEN',
        'SETTINGS': 'EINSTELLUNGEN',
        'CONTROLS': 'STEUERUNG',
        'Move Up': 'Nach oben',
        'Move Down': 'Nach unten',
        'Move Left': 'Nach links',
        'Move Right': 'Nach rechts',
        'Dash': 'Dash',
        'Charge': 'Ladung',
        'Skill': 'Fähigkeit',
        'Pause': 'Pause',
        'VOLUME': 'LAUTSTÄRKE',
        'Master Volume': 'Hauptlautstärke',
        'Music Volume': 'Musiklautstärke',
        'SFX Volume': 'Effektlautstärke',
        'Sound': 'Ton',
        'LANGUAGE': 'SPRACHE',
        'SAVE': 'SPEICHERN',
        'SPECIAL SKILLS': 'BESONDERE FÄHIGKEITEN',
        'CONFIRM': 'BESTÄTIGEN',
        'JOKER POWERS': 'JOKER-KRÄFTE',
        'LOADOUT': 'AUSRÜSTUNG',
        'Prepare your cube, skill, and jokers': 'Bereite Würfel, Skill und Joker vor',
        'START': 'START',
        'UPLOAD IMAGE': 'BILD HOCHLADEN',
        'SKILL': 'SKILL',
        'JOKERS': 'JOKER',
        'None': 'KEINE',
        'Choose your special skill and joker powers': 'Wähle deine Spezialfähigkeit und Joker-Kräfte',
        'SPECIAL SKILL': 'SPEZIALFÄHIGKEIT',
        'EXIT GAME': 'SPIEL BEENDEN',
        'Passive abilities that last the whole match': 'Passive Fähigkeiten, die das ganze Spiel anhalten',
        'INFINITE CHARGE': 'UNENDLICHE LADUNG',
        '5s: Continuous charging with +2 blocks range.': '5s: Dauerhaftes Laden mit +2 Reichweite.',
        'CLONE CREATION': 'KLON-ERSTELLUNG',
        'Permanent: Spawn 2 friendly AI clones.': 'Permanent: Beschwört 2 verbündete KI-Klone.',
        'INVISIBLE TRAIL': 'UNSICHTBARER PFAD',
        '4s: Your trail becomes invisible to everyone.': '4 s: Deine Spur wird für alle unsichtbar.',
        'INFINITE TRAILS': 'UNENDLICHE PFADE',
        'Forever: Trails do not decay during activation.': 'Permanent: Spuren verschwinden nicht, solange aktiv.',
        'LASER TRAIL': 'LASER PFAD',
        '6s: Global laser lines every 1s.': '6 s: Globale Laserlinien jede Sekunde.',
        'CHARGE+': 'AUFLADUNG+',
        'Your charge moves 2 extra grids.': 'Deine Ladung bewegt sich 2 Felder weiter.',
        'NO HUNGER': 'KEIN HUNGER',
        'Your hunger bar never goes down! No need to eat apples.': 'Dein Hungerbalken sinkt nie! Du musst keine Äpfel essen.',
        'RAGE': 'WUT',
        'All cooldowns are 50% shorter.': 'Alle Abklingzeiten sind 50% kürzer.',
        'FAST DASH': 'SCHNELLER DASH',
        'Dash has no cooldown.': 'Dash hat keine Abklingzeit.',
        'BORDER SAFE': 'GRENZE SICHER',
        'You cannot die from border contact.': 'Am Rand entlanggleiten — du fällst nie.',
        'Slide along board edges — you never fall off.': 'Am Rand entlanggleiten — du fällst nie.',
        'DOUBLE EFFECTIVE': 'DOPPELT EFFEKTIV',
        'Doubles effectiveness of your other jokers!': 'Verdoppelt die Effektivität deiner anderen Joker!',
        'FRIEND WALLS': 'FREUNDLICHE WÄNDE',
        'Spawn 2 passable walls only you can use.': 'Erzeugt 2 passierbare Wände, die nur du nutzen kannst.',
        'TRAIL GROWTH': 'PFAD WACHSTUM',
        'Your trail grows +1 every second!': 'Dein Pfad wächst jede Sekunde um +1!',
        'EXTRA LIFE': 'EXTRA LEBEN',
        'Survive your first death.': 'Überlebe deinen ersten Tod.',
        'DISABLE': 'DEAKTIVIEREN',
        'Randomly disable one of enemy\'s jokers!': 'Deaktiviere zufällig einen Joker des Feindes!',
        'PLAY': 'SPIELEN',
        'CHANGE COLOUR': 'FARBE ÄNDERN',
        'START (VS AI)': 'STARTEN (VS KI)',
        'SPECTATE': 'ZUSCHAUEN',
        'MULTIPLAYER': 'MEHRSPIELER',
        'BACK': 'ZURÜCK',
        'HOST ROOM': 'RAUM ERSTELLEN',
        'JOIN ROOM': 'RAUM BEITRETEN',
        'ENTER NICKNAME': 'NICKNAME EINGEBEN',
        'ENTER ROOM NAME': 'Raumname eingeben',
        'FEATURED ROOMS': 'AUSGEWÄHLTE RÄUME',
        'YOUR RECENT ROOMS': 'IHRE LETZTEN RÄUME',
        'NO RECENT ROOMS': 'KEINE LETZTEN RÄUME',
        'READY TO PLAY': 'BEREIT ZU SPIELEN',
        'LOG: WAITING FOR USER...': 'PROTOKOLL: WARTE AUF BENUTZER...',
        'WAITING ROOM': 'WARTEZIMMER',
        'YOU': 'DU',
        'ENEMY': 'GEGNER',
        'WAITING...': 'WARTEN...',
        'NOT READY': 'NICHT BEREIT',
        'READY': 'BEREIT',
        'CHANGE CUBE': 'CUBE ÄNDERN',
        'COPY JOIN LINK': 'LINK KOPIEREN',
        'EXIT LOBBY': 'LOBBY VERLASSEN',
        'CUSTOMIZE CUBE': 'CUBE ANPASSEN',
        'CHANGE YOUR CUBE COLOUR': 'CUBE-FARBE ÄNDERN',
        'CONFIRM COLOUR': 'FARBE BESTÄTIGEN',
        'ONLINE LOBBY': 'ONLINE-LOBBY',
        'SOUND: ON': 'TON: AN',
        'SOUND: OFF': 'TON: AUS',
        'GOT IT': 'VERSTANDEN',
        'VS': 'VS',
        'CLOSE': 'SCHLIESSEN',
        'NEXT': 'WEITER',
        'ENTER GAME': 'SPIEL STARTEN',
        'CLICK TO SKIP': 'Klicken zum Überspringen',
        'REFRESH': 'AKTUALISIEREN',
        'ENTER ROOM NAME (e.g. RONK123)': 'RAUMNAME EINGEBEN (z.B. RONK123)',
        'TUTORIAL_0': 'BEWEGEN MIT WASD',
        'TUTORIAL_1': 'DASH MIT F',
        'TUTORIAL_2': 'LADUNG MIT C',
        'TUTORIAL_3': 'SPEZIALFÄHIGKEITEN: Öffne „Spezialfähigkeiten“',
        'TUTORIAL_4': 'AUSWÄHLEN: Pfeiltasten benutzen',
        'TUTORIAL_5': 'AKTIVIEREN: Y im Spiel drücken',
        'TUTORIAL_MSG_4': 'Dash über den Rand · beobachte die Karte',
        'PAUSED': 'ANGEHALTEN',
        'RESUME': 'FORTSETZEN',
        'QUIT TO MENU': 'ZUM MENÜ',
        'CONTINUE': 'WEITER',
        'WAITING FOR RIVAL...': 'WARTEN AUF RIVALEN...',
        'PLAY AGAIN': 'WIEDER SPIELEN',
        'MENU': 'MENÜ',
        // Gamemode
        'GAMEMODE': 'SPIELMODUS',
        'GAMEMODE: CLASSIC': 'SPIELMODUS: KLASSISCH',
        'GAMEMODE: SIMPLISTIC': 'SPIELMODUS: EINFACH',
        'CLASSIC': 'KLASSISCH',
        'SIMPLISTIC': 'EINFACH',
        '5s: Continuous charging with +2 blocks range.': '5 s: Dauerladung mit +2 Feldern Reichweite.',
        'BOT DIFFICULTY': 'BOT-SCHWIERIGKEIT',
        'EASY': 'LEICHT',
        'MEDIUM': 'MITTEL',
        'HARD': 'SCHWER',
        'INVINCIBLE': 'ELITE',
        'MATCHMAKING': 'MATCHMAKING',
        'MATCHMAKE': 'SCHNELLSUCHE',
        'PLAY WITH FRIEND': 'MIT FREUND SPIELEN',
        'STEAM FRIENDS': 'STEAM-FREUNDE',
        'FIND MATCH': 'GEGNER SUCHEN',
        'CANCEL': 'ABBRECHEN',
        'CANCEL SEARCH': 'SUCHE ABBRECHEN',
        'HOST': 'HOSTEN',
        'JOIN FRIEND': 'FREUND BEITRETEN',
        'INVITE STEAM FRIEND': 'STEAM-FREUND EINLADEN',
        'HOST OR JOIN A FRIEND': 'HOSTEN ODER FREUND BEITRETEN',
        'FRIEND\'S ROOM CODE': 'RAUMCODE DES FREUNDES',
        'ADD STEAM FRIEND': 'STEAM-FREUND HINZUFÜGEN',
        'REPORT RIVAL': 'GEGNER MELDEN',
        'REPORT': 'MELDEN',
        'REPORT_MODAL_SUB': 'Wähle einen Grund. Falsche Meldungen können ignoriert werden.',
        'REPORT_HACK': 'HACK / BETRUG',
        'REPORT_NSFW': '18+ / UNANGEBRACHTES BILD',
        'REPORT_HARASSMENT': 'BELÄSTIGUNG / TOXISCH',
        'REPORT_OTHER': 'SONSTIGES',
        'SEARCHING FOR OPPONENT...': 'GEGNER WIRD GESUCHT...',
        'MATCHMAKING CANCELLED': 'MATCHMAKING ABGEBROCHEN',
        'WAITING FOR PLAYER...': 'WARTE AUF SPIELER...',
        'JOINING MATCH...': 'SPIEL WIRD BEIGETRETEN...',
        'MATCH TIMED OUT': 'ZEITÜBERSCHREITUNG BEI DER SUCHE',
        'FRIEND LOBBY OPEN — INVITE SENT': 'FREUNDESLOBBY OFFEN — EINLADUNG GESENDET',
        'STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.': 'STEAM IST FÜR FREUNDESLOBBYS ERFORDERLICH. Starte das Spiel über Steam.',
        'Passive: Opponents cannot see your trail.': 'Passiv: Gegner sehen deine Spur nicht.',
        'Passive: Your trail never decays.': 'Passiv: deine Spur verschwindet nie.',
        'SPECTATE FRIEND': 'FREUND ZUSCHAUEN',
        'SPECTATE FRIEND UNAVAILABLE': 'Freunde live zuzuschauen ist noch nicht verfügbar. Steam-Freundelobbys unterstützen gemeinsames Spielen, aber dieser Build hat keinen Zuschauer-Relay. Nutze ZUSCHAUEN für ein Elite-KI-vs-KI-Match.',
        'TUTORIAL': 'TUTORIAL',
        'SKIP TUTORIAL': 'TUTORIAL ÜBERSPRINGEN',
        'NEW PLAYER TRAINING': 'TRAINING FÜR NEUE SPIELER',
        'TUTORIAL_MSG_0': 'WASD zum Bewegen',
        'TUTORIAL_MSG_1': 'F zum Dash',
        'TUTORIAL_MSG_2': 'C zum Aufladen',
        'TUTORIAL_MSG_3': 'Gegnerspuren töten',
        'TUTORIAL_MSG_4_ARRIVAL': 'Du hast das Brett gewechselt — die Karte zeigt, wo du bist',
        'TUTORIAL_MSG_5': 'Nimm alle 3 weißen Felder, um dieses Brett zu besitzen',
        'TUTORIAL_MSG_6': 'Y für die Fähigkeit',
        'TUTORIAL_MSG_7': 'Äpfel essen',
        'TUTORIAL_MSG_8': 'Karte startet weiß — beanspruchte Bretter behalten deine Farbe',
        'TUTORIAL_MSG_10': 'Töte den Rivalen, um die Runde zu gewinnen — lade durch ihn hindurch',
        'TUTORIAL_MSG_11': 'Runde: 1 Kill · oder 3 Bretter in Linie',
        'TUTORIAL_MSG_12': 'Reisen · Checkpoints · Hunger · Skills',
        'TUTORIAL_MSG_13': 'Match: zuerst 3',
        'TUTORIAL_GATE_SUBTITLE': '9 Bretter · Kill oder Linie · zuerst 6',
        'NOTIFY_LOSS_KILLS': 'Runde = 1 Kill oder 3 in Linie. Match = zuerst 6.',
        'NOTIFY_LOSS_BOARDS': '3 Bretter in Linie gewinnen die Runde. Oder 1 Kill.',
        'SKILL_LOCKED': 'GESPERRT — Besiege Bots zum Freischalten',
        'JOKER_LOCKED': 'GESPERRT',
        'UNLOCKED': 'FREIGESCHALTET',
        'SKILL UNLOCKED': 'FÄHIGKEIT FREIGESCHALTET',
        'JOKER UNLOCKED': 'JOKER FREIGESCHALTET',
        'BEAT_BOTS_TO_UNLOCK': 'Siege vs Bots leicht, mittel, schwer oder Elite — oder besiege einen Online-Spieler — um Fähigkeit & Joker freizuschalten',
        'BEAT_PLAYER_TO_UNLOCK': 'Besiege einen anderen Spieler im Mehrspieler, um Fähigkeit und Joker freizuschalten',
        'COMPLETE_TUTORIAL_TO_UNLOCK': 'Beende zuerst das Tutorial — dann besiege Bots, um Fähigkeiten und Joker freizuschalten',
        'TUTORIAL_UNLOCK_HINT': 'Fähigkeiten und Joker gesperrt — besiege Bots oder Online-Spieler, um ihre Loadouts freizuschalten.',
        'NOTIFY_FIRST_SKILL_KICKER': 'Erste Fähigkeit freigeschaltet',
        'NOTIFY_FIRST_JOKER_KICKER': 'Erster Joker freigeschaltet',
        'NOTIFY_SKILL_KICKER': 'Fähigkeit freigeschaltet',
        'NOTIFY_JOKER_KICKER': 'Joker freigeschaltet',
        'NOTIFY_SKILL_HINT': 'Im Loadout → Fähigkeiten vor dem nächsten Match ausrüsten',
        'NOTIFY_JOKER_HINT': 'Im Loadout → Joker ausrüsten (bis zu 2)',
        'NOTIFY_TUTORIAL_DONE_TITLE': 'Tutorial abgeschlossen',
        'NOTIFY_TUTORIAL_DONE_BODY': 'Besiege Rivalen, um ihre Fähigkeiten und Joker freizuschalten.',
        'NOTIFY_FIRST_BOARD_TITLE': 'Brett erobert',
        'NOTIFY_FIRST_BOARD_BODY': '3 Bretter in Linie — oder 1 Kill.',
        'NOTIFY_FIRST_SKILL_USE_TITLE': 'Fähigkeit aktiviert',
        'NOTIFY_FIRST_SKILL_USE_HINT': 'Drücke Y im Match, um deine ausgerüstete Fähigkeit zu nutzen',
        'FIRST_PLAY_UNLOCK_TITLE': 'FÄHIGKEITEN & JOKER GESPERRT',
        'FIRST_PLAY_UNLOCK_BODY': 'Alle Fähigkeiten und Joker starten gesperrt. Besiege Bots (leicht bis Elite) oder siege online, um freizuschalten, was sie genutzt haben.',
        'RESOLUTION': 'AUFLÖSUNG',
        'LEGAL': 'RECHTLICHES',
        'LEGAL_NOTICE': 'Unbefugtes Kopieren, Weiterverbreiten oder Reverse Engineering von RonkBonk ist verboten. Siehe COPYRIGHT.txt im Installationsordner.',
        'REPORT_NO_RIVAL': 'Kein Online-Gegner zum Melden.',
        'REPORT_ALREADY': 'Dieser Gegner wurde kürzlich schon gemeldet.',
        'REPORT_SUBMITTED': 'Meldung gesendet. Danke, dass du RonkBonk schützt.',
        'SAFE_UPLOAD_BLOCKED': 'Upload durch Inhaltsschutz blockiert.',
        'SAFE_SYSTEM_UNAVAILABLE': 'Sicherheitssystem nicht verfügbar — Upload blockiert.',
        'SAFE_PROCESS_FAIL': 'Bild konnte nicht sicher verarbeitet werden.',
        'SAFE_PEER_OFFLINE': 'Geteiltes Bild blockiert (Sicherheit offline).',
        'SAFE_PEER_BLOCKED': 'Unsicheres geteiltes Bild blockiert.',
        'SAFE_BAD_SIGNATURE': 'Datei ist kein echtes Bild (aus Sicherheitsgründen blockiert).',
        'SAFE_MALWARE': 'Unsicherer Inhalt erkannt. Upload blockiert.',
        'SAFE_FORBIDDEN_FORMAT': 'Dieser Dateityp ist nicht erlaubt.',
        'SAFE_READ_FAIL': 'Datei konnte nicht gelesen werden.',
        'SAFE_DECODE_FAIL': 'Bild konnte nicht dekodiert werden. Anderes JPG/PNG versuchen.',
        'SAFE_TOO_SMALL': 'Bild ist zu klein.',
        'SAFE_DIMENSIONS': 'Bildabmessungen zu groß.',
        'SAFE_AGE_RESTRICTED': 'Bild blockiert — möglicherweise nicht für alle Altersgruppen geeignet.',
        'SAFE_AGE_FAIL': 'Bild hat Sicherheitsprüfungen nicht bestanden.',
        'SAFE_PIXEL_FAIL': 'Bild konnte nicht geprüft werden.',
        'SAFE_ENCODE_FAIL': 'Bild konnte nicht bereinigt werden.',
        'SAFE_SHARED_AGE': 'Geteiltes Bild blockiert — möglicherweise nicht für alle Altersgruppen geeignet.',
        'SAFE_SHARED_FAIL': 'Geteiltes Bild hat Prüfungen nicht bestanden.',
        'SAFE_SHARED_PIXEL': 'Geteiltes Bild konnte nicht geprüft werden.',
        'SAFE_SHARED_ENCODE': 'Geteiltes Bild konnte nicht bereinigt werden.',
        'SAFE_MALWARE_DATA': 'Unsichere Bilddaten blockiert.',
        'unlocked': 'freigeschaltet',

    },
    ja: {
        'RONKBONK': 'RONKBONK',
        'LOCAL GAME': 'ローカルPVP',
        'LOCAL PVP': 'ローカルPVP',
        'LOCAL PVP SUB': '同じ画面 · 2人',
        'ONLINE PVP': 'オンラインPVP',
        'ONLINE MATCHMAKE': 'オンラインマッチ',
        'ONLINE MATCHMAKE SUB': 'オンラインPVP · ランダム対戦',
        'ONLINE WITH FRIEND': 'フレンドとオンライン',
        'ONLINE WITH FRIEND SUB': 'オンラインPVP · ホスト/参加',
        'MULTIPLAYER PVP': 'マルチプレイヤーPVP',
        'MULTIPLAYER PVP SUB': 'オンラインまたは同じ画面',
        'PLAY VS BOT': 'ボットと対戦',
        'PLAY VS BOT SUB': 'ソロ · AI対戦',
        'SPECTATE SUB': 'AI対AI · Steamフレンド',
        'SPECTATE TIER HINT': '観戦モードを選んでください',
        'SPECTATE AI': 'AI対AIを観戦',
        'SPECTATE AI SUB': 'ローカル · ボット同士',
        'SPECTATE FRIEND SUB': 'フレンドの試合を観戦',
        'PLAY TIER HINT': '遊び方を選んでください',
        'MULTIPLAYER TIER HINT': 'オンラインPVP · ローカル共有画面PVP',
        'ONLINE MATCHMAKE DESC': 'オンラインPVP — インターネット上のランダムな相手と対戦。',
        'ONLINE WITH FRIEND DESC': 'オンラインPVP — 部屋を作るかコードで参加。',
        'ONLINE': 'オンライン',
        'CUSTOMIZE': 'カスタマイズ',
        'SETTINGS': '設定',
        'CONTROLS': 'コントロール',
        'Move Up': '上に移動',
        'Move Down': '下に移動',
        'Move Left': '左に移動',
        'Move Right': '右に移動',
        'Dash': 'ダッシュ',
        'Charge': 'チャージ',
        'Skill': 'スキル',
        'Pause': '一時停止',
        'VOLUME': '音量',
        'Master Volume': 'マスター音量',
        'Music Volume': '音楽音量',
        'SFX Volume': '効果音音量',
        'Sound': 'サウンド',
        'LANGUAGE': '言語',
        'SAVE': '保存',
        'SPECIAL SKILLS': '特殊スキル',
        'CONFIRM': '確認',
        'JOKER POWERS': 'ジョーカーパワー',
        'LOADOUT': 'ロードアウト',
        'Prepare your cube, skill, and jokers': 'キューブ・スキル・ジョーカーを選んでください',
        'START': 'スタート',
        'UPLOAD IMAGE': '画像をアップロード',
        'SKILL': 'スキル',
        'JOKERS': 'ジョーカー',
        'None': 'なし',
        'Choose your special skill and joker powers': '特殊スキルとジョーカーパワーを選んでください',
        'SPECIAL SKILL': '特殊スキル',
        'EXIT GAME': 'ゲームを終了',
        'Passive abilities that last the whole match': '試合全体続くパッシブ能力',
        'INFINITE CHARGE': '無限チャージ',
        '5s: Continuous charging with +2 blocks range.': '5秒: +2ブロック rangeで連続チャージ.',
        'CLONE CREATION': 'クローン作成',
        'Permanent: Spawn 2 friendly AI clones.': '常時：味方AIクローンを2体召喚。',
        'INVISIBLE TRAIL': '透明トレイル',
        '4s: Your trail becomes invisible to everyone.': '4秒間：自分のトレイルが全員に見えなくなる。',
        'INFINITE TRAILS': '無限トレイル',
        'Forever: Trails do not decay during activation.': '常時：発動中はトレイルが消えない。',
        'LASER TRAIL': 'レーザートレイル',
        '6s: Global laser lines every 1s.': '6秒間：1秒ごとに全体レーザー発射。',
        'CHARGE+': 'チャージ+',
        'Your charge moves 2 extra grids.': 'チャージの移動距離が2マス増える。',
        'NO HUNGER': '空腹なし',
        'Your hunger bar never goes down! No need to eat apples.': '空腹ゲージが減らない！りんごは不要。',
        'RAGE': '怒り',
        'All cooldowns are 50% shorter.': 'すべてのクールダウンが50%短くなる.',
        'FAST DASH': '早ダッシュ',
        'Dash has no cooldown.': 'ダッシュはクールダウンなし.',
        'BORDER SAFE': 'ボーダー安全',
        'You cannot die from border contact.': '外周に沿って滑る — 落ちない。',
        'Slide along board edges — you never fall off.': '外周に沿って滑る — 落ちない。',
        'DOUBLE EFFECTIVE': '2倍効果的',
        'Doubles effectiveness of your other jokers!': '他のジョーカーの効果を2倍にする!',
        'FRIEND WALLS': '友好壁',
        'Spawn 2 passable walls only you can use.': '自分だけ通れる壁を2つ生成。',
        'TRAIL GROWTH': 'トレイル成長',
        'Your trail grows +1 every second!': 'あなたの道は毎秒+1成長する!',
        'EXTRA LIFE': '余命',
        'Survive your first death.': '最初の死亡を免れる。',
        'DISABLE': '無効化',
        'Randomly disable one of enemy\'s jokers!': '-Montesrandomly 敵のジョーカー1つを無効化!',
        'PLAY': 'プレイ',
        'CHANGE COLOUR': '色を変更',
        'START (VS AI)': '開始 (VS AI)',
        'SPECTATE': '観戦',
        'MULTIPLAYER': 'マルチプレイヤー',
        'BACK': '戻る',
        'HOST ROOM': 'ルーム作成',
        'JOIN ROOM': 'ルーム参加',
        'ENTER NICKNAME': 'ニックネーム入力',
        'ENTER ROOM NAME': 'ルーム名入力',
        'FEATURED ROOMS': '注目のルーム',
        'YOUR RECENT ROOMS': '最近のルーム',
        'NO RECENT ROOMS': '最近のルームなし',
        'READY TO PLAY': 'プレイ準備完了',
        'LOG: WAITING FOR USER...': 'ログ: ユーザー待機中...',
        'WAITING ROOM': '待機ルーム',
        'YOU': 'あなた',
        'ENEMY': '敵',
        'WAITING...': '待機中...',
        'NOT READY': '未準備',
        'READY': '準備完了',
        'CHANGE CUBE': 'キューブ変更',
        'COPY JOIN LINK': '参加リンクコピー',
        'EXIT LOBBY': 'ロビーを出る',
        'CUSTOMIZE CUBE': 'Cubeカスタマイズ',
        'CHANGE YOUR CUBE COLOUR': 'Cube色を変更',
        'CONFIRM COLOUR': '色を確認',
        'ONLINE LOBBY': 'オンラインロビー',
        'SOUND: ON': 'サウンド: オン',
        'SOUND: OFF': 'サウンド: オフ',
        'GOT IT': '了解',
        'VS': 'VS',
        'CLOSE': '閉じる',
        'NEXT': '次へ',
        'ENTER GAME': 'ゲームに入る',
        'CLICK TO SKIP': 'クリックしてスキップ',
        'REFRESH': 'リフレッシュ',
        'ENTER ROOM NAME (e.g. RONK123)': 'ルーム名を入力 (例: RONK123)',
        'TUTORIAL_0': 'WASDで移動',
        'TUTORIAL_1': 'Fでダッシュ',
        'TUTORIAL_2': 'Cでチャージ',
        'TUTORIAL_3': '特殊スキル：「特殊スキル」を開く',
        'TUTORIAL_4': 'スキル選択：矢印キーで選ぶ',
        'TUTORIAL_5': 'スキル発動：対戦中にYキー',
        'TUTORIAL_MSG_4': '端からダッシュ · マップの移動を見よう',
        'PAUSED': 'ポーズ',
        'RESUME': '再開',
        'QUIT TO MENU': 'メニューに戻る',
        'CONTINUE': '続行',
        'WAITING FOR RIVAL...': 'ライバルを待っています...',
        'PLAY AGAIN': 'もう一度プレイ',
        'MENU': 'メニュー',
        // Gamemode
        'GAMEMODE': 'ゲームモード',
        'GAMEMODE: CLASSIC': 'ゲームモード: クラシック',
        'GAMEMODE: SIMPLISTIC': 'ゲームモード: 簡易',
        'CLASSIC': 'クラシック',
        'SIMPLISTIC': '簡易',
        '5s: Continuous charging with +2 blocks range.': '5秒間：射程+2マスで連続チャージ。',
        'Your trail grows +1 every second!': '毎秒トレイルが+1伸びる！',
        'Randomly disable one of enemy\'s jokers!': '相手のジョーカーを1つランダムで無効化！',
        'BOT DIFFICULTY': 'ボット難易度',
        'EASY': 'かんたん',
        'MEDIUM': 'ふつう',
        'HARD': 'むずかしい',
        'INVINCIBLE': 'エリート',
        'MATCHMAKING': 'マッチメイク',
        'MATCHMAKE': 'マッチメイク',
        'PLAY WITH FRIEND': 'フレンドとプレイ',
        'STEAM FRIENDS': 'Steamフレンド',
        'FIND MATCH': '対戦相手を探す',
        'CANCEL': 'キャンセル',
        'CANCEL SEARCH': '検索をキャンセル',
        'HOST': 'ホスト',
        'JOIN FRIEND': 'フレンドに参加',
        'INVITE STEAM FRIEND': 'Steamフレンドを招待',
        'HOST OR JOIN A FRIEND': 'ホストまたはフレンドに参加',
        'FRIEND\'S ROOM CODE': 'フレンドのルームコード',
        'ADD STEAM FRIEND': 'Steamフレンドを追加',
        'REPORT RIVAL': '相手を通報',
        'REPORT': '通報',
        'REPORT_MODAL_SUB': '理由を選んでください。虚偽の通報は無視される場合があります。',
        'REPORT_HACK': 'チート / 不正行為',
        'REPORT_NSFW': '18禁 / 不適切な画像',
        'REPORT_HARASSMENT': '迷惑行為 / 荒らし',
        'REPORT_OTHER': 'その他',
        'SEARCHING FOR OPPONENT...': '対戦相手を検索中...',
        'MATCHMAKING CANCELLED': 'マッチメイクをキャンセルしました',
        'WAITING FOR PLAYER...': 'プレイヤーを待機中...',
        'JOINING MATCH...': 'マッチに参加中...',
        'MATCH TIMED OUT': 'マッチの待機がタイムアウトしました',
        'FRIEND LOBBY OPEN — INVITE SENT': 'フレンドロビー開設 — 招待を送信しました',
        'STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.': 'フレンド対戦にはSteamが必要です。Steamからゲームを起動してください。',
        'Passive: Opponents cannot see your trail.': 'パッシブ：相手に軌跡が見えない。',
        'Passive: Your trail never decays.': 'パッシブ：軌跡が消えない。',
        'SPECTATE FRIEND': 'フレンド観戦',
        'SPECTATE FRIEND UNAVAILABLE': 'フレンドのライブ観戦はまだ未対応です。Steamフレンドロビーでは一緒にプレイできますが、このビルドに観戦リレーはありません。SPECTATEで無敵AI対AIを観戦してください。',
        'TUTORIAL': 'チュートリアル',
        'SKIP TUTORIAL': 'チュートリアルをスキップ',
        'NEW PLAYER TRAINING': '初心者トレーニング',
        'TUTORIAL_MSG_0': 'WASDで移動',
        'TUTORIAL_MSG_1': 'Fでダッシュ',
        'TUTORIAL_MSG_2': 'Cでチャージ',
        'TUTORIAL_MSG_3': '敵の軌跡は即死',
        'TUTORIAL_MSG_4_ARRIVAL': 'ボードを移動した — マップが現在地を示す',
        'TUTORIAL_MSG_5': '白いマス3つを取ってこのボードを占領',
        'TUTORIAL_MSG_6': 'Yでスキル',
        'TUTORIAL_MSG_7': 'リンゴを食べる',
        'TUTORIAL_MSG_8': 'マップは白から開始 — 占領したボードは自分の色のまま',
        'TUTORIAL_MSG_10': 'ライバルを倒してラウンド勝利 — チャージで突き抜けろ',
        'TUTORIAL_MSG_11': 'ラウンド：1キル · またはボード3つ一直線',
        'TUTORIAL_MSG_12': '移動 · チェックポイント · 空腹 · スキル',
        'TUTORIAL_MSG_13': 'マッチ：先に3',
        'TUTORIAL_GATE_SUBTITLE': '9ボード · キルか一直線 · 先に6',
        'NOTIFY_LOSS_KILLS': 'ラウンド＝1キルか一直線。マッチ＝先に6。',
        'NOTIFY_LOSS_BOARDS': 'ボード3つ一直線でラウンド勝利。または1キル。',
        'SKILL_LOCKED': 'ロック — ボットに勝って解除',
        'JOKER_LOCKED': 'ロック',
        'UNLOCKED': '解除',
        'SKILL UNLOCKED': 'スキル解除',
        'JOKER UNLOCKED': 'ジョーカー解除',
        'BEAT_BOTS_TO_UNLOCK': 'イージー〜エリートのボットに勝つ、またはオンラインでプレイヤーに勝つと、そのスキルとジョーカーを解除',
        'BEAT_PLAYER_TO_UNLOCK': 'マルチで他プレイヤーに勝つと、そのスキルとジョーカーを解除',
        'COMPLETE_TUTORIAL_TO_UNLOCK': 'まずチュートリアルを完了 — その後ボットに勝ってスキルとジョーカーを解除',
        'TUTORIAL_UNLOCK_HINT': 'スキルとジョーカーはロック中 — ボットやオンライン相手に勝ってロードアウトを解除しよう。',
        'NOTIFY_FIRST_SKILL_KICKER': '最初のスキル解除',
        'NOTIFY_FIRST_JOKER_KICKER': '最初のジョーカー解除',
        'NOTIFY_SKILL_KICKER': 'スキル解除',
        'NOTIFY_JOKER_KICKER': 'ジョーカー解除',
        'NOTIFY_SKILL_HINT': '次の試合前にロードアウト → スキルで装備',
        'NOTIFY_JOKER_HINT': 'ロードアウト → ジョーカーで装備（最大2つ）',
        'NOTIFY_TUTORIAL_DONE_TITLE': 'チュートリアル完了',
        'NOTIFY_TUTORIAL_DONE_BODY': 'ライバルに勝ってスキルとジョーカーを解除しよう。',
        'NOTIFY_FIRST_BOARD_TITLE': 'ボード占領',
        'NOTIFY_FIRST_BOARD_BODY': 'ボード3つ一直線 — または1キル。',
        'NOTIFY_FIRST_SKILL_USE_TITLE': 'スキル発動',
        'NOTIFY_FIRST_SKILL_USE_HINT': '試合中にYで装備スキルを使う',
        'FIRST_PLAY_UNLOCK_TITLE': 'スキル＆ジョーカーはロック中',
        'FIRST_PLAY_UNLOCK_BODY': 'スキルとジョーカーは最初すべてロック。ボット（イージー〜エリート）に勝つかオンラインで勝つと、相手が使っていたものを解除。',
        'RESOLUTION': '解像度',
        'LEGAL': '法的情報',
        'LEGAL_NOTICE': 'RonkBonkの無断コピー、再配布、リバースエンジニアリングは禁止です。インストールフォルダの COPYRIGHT.txt を参照してください。',
        'REPORT_NO_RIVAL': '通報できるオンラインの相手がいません。',
        'REPORT_ALREADY': 'この相手は最近すでに通報済みです。',
        'REPORT_SUBMITTED': '通報を送信しました。RonkBonkを安全に保ってくれてありがとう。',
        'SAFE_UPLOAD_BLOCKED': 'コンテンツ安全によりアップロードがブロックされました。',
        'SAFE_SYSTEM_UNAVAILABLE': '安全システムが利用できません — アップロードをブロックしました。',
        'SAFE_PROCESS_FAIL': 'その画像を安全に処理できませんでした。',
        'SAFE_PEER_OFFLINE': '共有画像をブロックしました（安全機能オフライン）。',
        'SAFE_PEER_BLOCKED': '不安全な共有画像をブロックしました。',
        'SAFE_BAD_SIGNATURE': '実画像ではないファイルです（安全のためブロック）。',
        'SAFE_MALWARE': '不安全な内容を検出。アップロードをブロックしました。',
        'SAFE_FORBIDDEN_FORMAT': 'そのファイル形式は許可されていません。',
        'SAFE_READ_FAIL': 'ファイルを読み取れませんでした。',
        'SAFE_DECODE_FAIL': '画像をデコードできません。別の JPG/PNG を試してください。',
        'SAFE_TOO_SMALL': '画像が小さすぎます。',
        'SAFE_DIMENSIONS': '画像サイズが大きすぎます。',
        'SAFE_AGE_RESTRICTED': '画像をブロック — 全年齢向けでない可能性があります。',
        'SAFE_AGE_FAIL': '画像が安全チェックに失敗しました。',
        'SAFE_PIXEL_FAIL': '画像を検査できませんでした。',
        'SAFE_ENCODE_FAIL': '画像を浄化できませんでした。',
        'SAFE_SHARED_AGE': '共有画像をブロック — 全年齢向けでない可能性があります。',
        'SAFE_SHARED_FAIL': '共有画像が安全チェックに失敗しました。',
        'SAFE_SHARED_PIXEL': '共有画像を検査できませんでした。',
        'SAFE_SHARED_ENCODE': '共有画像を浄化できませんでした。',
        'SAFE_MALWARE_DATA': '不安全な画像データをブロックしました。',
        'unlocked': '解除済み',

    },
    zh: {
        'RONKBONK': 'RONKBONK',
        'LOCAL GAME': '本地对战',
        'LOCAL PVP': '本地对战',
        'LOCAL PVP SUB': '同屏 · 双人',
        'ONLINE PVP': '在线对战',
        'ONLINE MATCHMAKE': '在线匹配',
        'ONLINE MATCHMAKE SUB': '在线PvP · 随机对手',
        'ONLINE WITH FRIEND': '与好友在线',
        'ONLINE WITH FRIEND SUB': '在线PvP · 创建或加入房间',
        'MULTIPLAYER PVP': '多人PvP',
        'MULTIPLAYER PVP SUB': '在线或同屏',
        'PLAY VS BOT': '对战机器人',
        'PLAY VS BOT SUB': '单人 · 打AI',
        'SPECTATE SUB': 'AI对AI · Steam好友',
        'SPECTATE TIER HINT': '观看比赛 — 选择模式',
        'SPECTATE AI': '观战 AI 对 AI',
        'SPECTATE AI SUB': '本地 · 两个机器人对战',
        'SPECTATE FRIEND SUB': '观战在线好友',
        'PLAY TIER HINT': '选择游玩方式',
        'MULTIPLAYER TIER HINT': '在线PvP · 本地同屏PvP',
        'ONLINE MATCHMAKE DESC': '在线PvP — 在网上匹配随机对手。',
        'ONLINE WITH FRIEND DESC': '在线PvP — 创建房间或用好友代码加入。',
        'ONLINE': '在线',
        'CUSTOMIZE': '自定义',
        'SETTINGS': '设置',
        'CONTROLS': '控制',
        'Move Up': '向上移动',
        'Move Down': '向下移动',
        'Move Left': '向左移动',
        'Move Right': '向右移动',
        'Dash': '冲刺',
        'Charge': '蓄力',
        'Skill': '技能',
        'Pause': '暂停',
        'VOLUME': '音量',
        'Master Volume': '主音量',
        'Music Volume': '音乐音量',
        'SFX Volume': '音效音量',
        'Sound': '声音',
        'LANGUAGE': '语言',
        'SAVE': '保存',
        'SPECIAL SKILLS': '特殊技能',
        'CONFIRM': '确认',
        'JOKER POWERS': '王牌能力',
        'LOADOUT': '配装',
        'Prepare your cube, skill, and jokers': '配置你的方块、技能和王牌',
        'START': '开始',
        'UPLOAD IMAGE': '上传图片',
        'SKILL': '技能',
        'JOKERS': '王牌',
        'None': '无',
        'Choose your special skill and joker powers': '选择特殊技能和王牌能力',
        'SPECIAL SKILL': '特殊技能',
        'EXIT GAME': '退出游戏',
        'Passive abilities that last the whole match': '持续整场比赛的被动能力',
        'INFINITE CHARGE': '无限蓄力',
        '5s: Continuous charging with +2 blocks range.': '5秒: +2范围连续蓄力.',
        'CLONE CREATION': '克隆创造',
        'Permanent: Spawn 2 friendly AI clones.': '永久：召唤2个友方AI分身。',
        'INVISIBLE TRAIL': '隐形轨迹',
        '4s: Your trail becomes invisible to everyone.': '4秒：你的轨迹对所有人不可见。',
        'INFINITE TRAILS': '无限轨迹',
        'Forever: Trails do not decay during activation.': '永久：激活期间轨迹不会消失。',
        'LASER TRAIL': '激光轨迹',
        '6s: Global laser lines every 1s.': '6秒：每秒发射全图激光。',
        'CHARGE+': '蓄力+',
        'Your charge moves 2 extra grids.': '蓄力额外前进2格。',
        'NO HUNGER': '无饥饿',
        'Your hunger bar never goes down! No need to eat apples.': '饥饿值不会下降！无需吃苹果。',
        'RAGE': '愤怒',
        'All cooldowns are 50% shorter.': '所有冷却时间缩短50%.',
        'FAST DASH': '快速冲刺',
        'Dash has no cooldown.': '冲刺无冷却.',
        'BORDER SAFE': '边界安全',
        'You cannot die from border contact.': '沿边界滑动 — 不会掉落。',
        'Slide along board edges — you never fall off.': '沿边界滑动 — 不会掉落。',
        'DOUBLE EFFECTIVE': '双倍效果',
        'Doubles effectiveness of your other jokers!': '使其他小丑效果翻倍!',
        'FRIEND WALLS': '友方墙',
        'Spawn 2 passable walls only you can use.': '生成2道只有你能通过的墙。',
        'TRAIL GROWTH': '轨迹增长',
        'Your trail grows +1 every second!': '轨迹每秒增长+1!',
        'EXTRA LIFE': '额外生命',
        'Survive your first death.': '抵消第一次死亡。',
        'DISABLE': '禁用',
        'Randomly disable one of enemy\'s jokers!': '随机禁用敌人一个小丑!',
        'PLAY': '开始',
        'CHANGE COLOUR': '改变颜色',
        'START (VS AI)': '开始 (VS AI)',
        'SPECTATE': '观战',
        'MULTIPLAYER': '多人游戏',
        'BACK': '返回',
        'HOST ROOM': '创建房间',
        'JOIN ROOM': '加入房间',
        'ENTER NICKNAME': '输入昵称',
        'ENTER ROOM NAME': '输入房间名称',
        'FEATURED ROOMS': '特色房间',
        'YOUR RECENT ROOMS': '你最近的房间',
        'NO RECENT ROOMS': '没有最近的房间',
        'READY TO PLAY': '准备玩游戏',
        'LOG: WAITING FOR USER...': '日志: 等待用户...',
        'WAITING ROOM': '等候室',
        'YOU': '你',
        'ENEMY': '敌人',
        'WAITING...': '等待中...',
        'NOT READY': '未准备',
        'READY': '准备完毕',
        'CHANGE CUBE': '更改方块',
        'COPY JOIN LINK': '复制加入链接',
        'EXIT LOBBY': '退出大厅',
        'CUSTOMIZE CUBE': '自定义方块',
        'CHANGE YOUR CUBE COLOUR': '更改方块颜色',
        'CONFIRM COLOUR': '确认颜色',
        'ONLINE LOBBY': '在线大厅',
        'SOUND: ON': '声音: 开',
        'SOUND: OFF': '声音: 关',
        'GOT IT': '知道了',
        'VS': 'VS',
        'CLOSE': '关闭',
        'NEXT': '下一步',
        'ENTER GAME': '进入游戏',
        'CLICK TO SKIP': '点击跳过',
        'REFRESH': '刷新',
        'ENTER ROOM NAME (e.g. RONK123)': '输入房间名 (例如: RONK123)',
        'TUTORIAL_0': '用 WASD 移动',
        'TUTORIAL_1': '按 F 冲刺',
        'TUTORIAL_2': '按 C 蓄力',
        'TUTORIAL_3': '特殊技能：打开「特殊技能」',
        'TUTORIAL_4': '选择技能：用方向键切换',
        'TUTORIAL_5': '发动技能：对战中按 Y',
        'TUTORIAL_MSG_4': '冲出边缘 · 观察地图移动',
        'PAUSED': '暂停',
        'RESUME': '继续',
        'QUIT TO MENU': '返回菜单',
        'CONTINUE': '继续',
        'WAITING FOR RIVAL...': '等待对手...',
        'PLAY AGAIN': '再玩一次',
        'MENU': '菜单',
        // Gamemode
        'GAMEMODE': '游戏模式',
        'GAMEMODE: CLASSIC': '游戏模式: 经典',
        'GAMEMODE: SIMPLISTIC': '游戏模式: 简单',
        'CLASSIC': '经典',
        'SIMPLISTIC': '简单',
        '5s: Continuous charging with +2 blocks range.': '5秒：连续蓄力，射程+2格。',
        'Your trail grows +1 every second!': '轨迹每秒+1！',
        'Randomly disable one of enemy\'s jokers!': '随机禁用对手一张鬼牌！',
        'BOT DIFFICULTY': '人机难度',
        'EASY': '简单',
        'MEDIUM': '普通',
        'HARD': '困难',
        'INVINCIBLE': '精英',
        'MATCHMAKING': '匹配',
        'MATCHMAKE': '快速匹配',
        'PLAY WITH FRIEND': '与好友对战',
        'STEAM FRIENDS': 'Steam 好友',
        'FIND MATCH': '寻找对局',
        'CANCEL': '取消',
        'CANCEL SEARCH': '取消搜索',
        'HOST': '创建房间',
        'JOIN FRIEND': '加入好友',
        'INVITE STEAM FRIEND': '邀请 Steam 好友',
        'HOST OR JOIN A FRIEND': '创建或加入好友房间',
        'FRIEND\'S ROOM CODE': '好友房间代码',
        'ADD STEAM FRIEND': '添加 Steam 好友',
        'REPORT RIVAL': '举报对手',
        'REPORT': '举报',
        'REPORT_MODAL_SUB': '请选择原因。恶意举报可能会被忽略。',
        'REPORT_HACK': '外挂 / 作弊',
        'REPORT_NSFW': '18+ / 不当图片',
        'REPORT_HARASSMENT': '骚扰 / 辱骂',
        'REPORT_OTHER': '其他',
        'SEARCHING FOR OPPONENT...': '正在寻找对手...',
        'MATCHMAKING CANCELLED': '已取消匹配',
        'WAITING FOR PLAYER...': '等待玩家...',
        'JOINING MATCH...': '正在加入对局...',
        'MATCH TIMED OUT': '匹配超时',
        'FRIEND LOBBY OPEN — INVITE SENT': '好友房间已开启 — 邀请已发送',
        'STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.': '好友对战需要 Steam。请通过 Steam 启动游戏。',
        'Passive: Opponents cannot see your trail.': '被动：对手看不到你的轨迹。',
        'Passive: Your trail never decays.': '被动：你的轨迹永不消失。',
        'SPECTATE FRIEND': '观战好友',
        'SPECTATE FRIEND UNAVAILABLE': '实时观战好友尚未开放。Steam 好友大厅可一起玩，但本版本没有观战中继。请用「观战」观看无敌 AI 对战。',
        'TUTORIAL': '教程',
        'SKIP TUTORIAL': '跳过教程',
        'NEW PLAYER TRAINING': '新人训练',
        'TUTORIAL_MSG_0': 'WASD 移动',
        'TUTORIAL_MSG_1': 'F 冲刺',
        'TUTORIAL_MSG_2': 'C 蓄力',
        'TUTORIAL_MSG_3': '碰到敌方轨迹会死亡',
        'TUTORIAL_MSG_4_ARRIVAL': '你换了棋盘 — 地图显示你的位置',
        'TUTORIAL_MSG_5': '占领全部 3 个白色方块以拥有此棋盘',
        'TUTORIAL_MSG_6': 'Y 使用技能',
        'TUTORIAL_MSG_7': '吃苹果',
        'TUTORIAL_MSG_8': '地图从白色开始 — 已占领的棋盘保持你的颜色',
        'TUTORIAL_MSG_10': '击杀对手赢得回合 — 蓄力贯穿他们',
        'TUTORIAL_MSG_11': '回合：1 击杀 · 或三连棋盘',
        'TUTORIAL_MSG_12': '穿梭 · 检查点 · 饥饿 · 技能',
        'TUTORIAL_MSG_13': '比赛：先到 3',
        'TUTORIAL_GATE_SUBTITLE': '9 棋盘 · 击杀或连线 · 先到 6',
        'NOTIFY_LOSS_KILLS': '回合＝1 击杀或三连。比赛＝先到 6。',
        'NOTIFY_LOSS_BOARDS': '三连棋盘赢回合。或 1 击杀。',
        'SKILL_LOCKED': '锁定 — 击败机器人解锁',
        'JOKER_LOCKED': '锁定',
        'UNLOCKED': '已解锁',
        'SKILL UNLOCKED': '技能已解锁',
        'JOKER UNLOCKED': '小丑已解锁',
        'BEAT_BOTS_TO_UNLOCK': '击败简单/中等/困难/精英机器人，或在线击败玩家，即可解锁其技能与小丑',
        'BEAT_PLAYER_TO_UNLOCK': '在多人模式击败其他玩家以解锁其技能与小丑',
        'COMPLETE_TUTORIAL_TO_UNLOCK': '先完成教程 — 再击败机器人解锁技能与小丑',
        'TUTORIAL_UNLOCK_HINT': '技能与小丑已锁定 — 先击败机器人或在线玩家解锁其配置。',
        'NOTIFY_FIRST_SKILL_KICKER': '首个技能已解锁',
        'NOTIFY_FIRST_JOKER_KICKER': '首个小丑已解锁',
        'NOTIFY_SKILL_KICKER': '技能已解锁',
        'NOTIFY_JOKER_KICKER': '小丑已解锁',
        'NOTIFY_SKILL_HINT': '下场比赛前在 Loadout → 技能 中装备',
        'NOTIFY_JOKER_HINT': '在 Loadout → 小丑 中装备（最多 2 个）',
        'NOTIFY_TUTORIAL_DONE_TITLE': '教程完成',
        'NOTIFY_TUTORIAL_DONE_BODY': '击败对手以解锁其技能与小丑。',
        'NOTIFY_FIRST_BOARD_TITLE': '棋盘已占领',
        'NOTIFY_FIRST_BOARD_BODY': '三连棋盘 — 或 1 击杀。',
        'NOTIFY_FIRST_SKILL_USE_TITLE': '技能已激活',
        'NOTIFY_FIRST_SKILL_USE_HINT': '比赛中按 Y 使用已装备的技能',
        'FIRST_PLAY_UNLOCK_TITLE': '技能与小丑已锁定',
        'FIRST_PLAY_UNLOCK_BODY': '所有技能与小丑初始锁定。击败机器人（简单到精英）或在线获胜，即可解锁对方使用的内容。',
        'RESOLUTION': '分辨率',
        'LEGAL': '法律信息',
        'LEGAL_NOTICE': '禁止未经授权复制、再分发或逆向工程 RonkBonk。请查看安装文件夹中的 COPYRIGHT.txt。',
        'REPORT_NO_RIVAL': '没有可举报的在线对手。',
        'REPORT_ALREADY': '最近已举报过该对手。',
        'REPORT_SUBMITTED': '举报已提交。感谢维护 RonkBonk 的安全。',
        'SAFE_UPLOAD_BLOCKED': '内容安全已拦截上传。',
        'SAFE_SYSTEM_UNAVAILABLE': '内容安全系统不可用 — 已拦截上传。',
        'SAFE_PROCESS_FAIL': '无法安全处理该图片。',
        'SAFE_PEER_OFFLINE': '已拦截不安全的共享图片（安全系统离线）。',
        'SAFE_PEER_BLOCKED': '已拦截不安全的共享图片。',
        'SAFE_BAD_SIGNATURE': '该文件不是真实图片（已出于安全拦截）。',
        'SAFE_MALWARE': '检测到不安全内容。已拦截上传。',
        'SAFE_FORBIDDEN_FORMAT': '不允许该文件类型。',
        'SAFE_READ_FAIL': '无法读取该文件。',
        'SAFE_DECODE_FAIL': '无法解码图片。请换一张 JPG/PNG。',
        'SAFE_TOO_SMALL': '图片太小。',
        'SAFE_DIMENSIONS': '图片尺寸过大。',
        'SAFE_AGE_RESTRICTED': '图片已拦截 — 可能不适合所有年龄。',
        'SAFE_AGE_FAIL': '图片未通过安全检查。',
        'SAFE_PIXEL_FAIL': '无法检查图片。',
        'SAFE_ENCODE_FAIL': '无法净化图片。',
        'SAFE_SHARED_AGE': '共享图片已拦截 — 可能不适合所有年龄。',
        'SAFE_SHARED_FAIL': '共享图片未通过安全检查。',
        'SAFE_SHARED_PIXEL': '无法检查共享图片。',
        'SAFE_SHARED_ENCODE': '无法净化共享图片。',
        'SAFE_MALWARE_DATA': '已拦截不安全的图片数据。',
        'unlocked': '已解锁',

    },
    ko: {
        'RONKBONK': 'RONKBONK',
        'LOCAL GAME': '로컬 PVP',
        'LOCAL PVP': '로컬 PVP',
        'LOCAL PVP SUB': '같은 화면 · 2인',
        'ONLINE PVP': '온라인 PVP',
        'ONLINE MATCHMAKE': '온라인 매치메이크',
        'ONLINE MATCHMAKE SUB': '온라인 PvP · 랜덤 상대',
        'ONLINE WITH FRIEND': '친구와 온라인',
        'ONLINE WITH FRIEND SUB': '온라인 PvP · 호스트/참가',
        'MULTIPLAYER PVP': '멀티플레이어 PVP',
        'MULTIPLAYER PVP SUB': '온라인 또는 같은 화면',
        'PLAY VS BOT': '봇과 플레이',
        'PLAY VS BOT SUB': '솔로 · AI 대전',
        'SPECTATE SUB': 'AI vs AI · Steam 친구',
        'SPECTATE TIER HINT': '관전 모드를 고르세요',
        'SPECTATE AI': 'AI vs AI 관전',
        'SPECTATE AI SUB': '로컬 · 봇 대 봇',
        'SPECTATE FRIEND SUB': '온라인 친구 관전',
        'PLAY TIER HINT': '플레이 방식을 고르세요',
        'MULTIPLAYER TIER HINT': '온라인 PvP · 로컬 공유 화면 PvP',
        'ONLINE MATCHMAKE DESC': '온라인 PvP — 인터넷에서 랜덤 상대를 찾습니다.',
        'ONLINE WITH FRIEND DESC': '온라인 PvP — 방을 만들거나 코드로 참가하세요.',
        'ONLINE': '온라인',
        'CUSTOMIZE': '사용자 지정',
        'SETTINGS': '설정',
        'CONTROLS': '조작',
        'Move Up': '위로 이동',
        'Move Down': '아래로 이동',
        'Move Left': '왼쪽으로 이동',
        'Move Right': '오른쪽으로 이동',
        'Dash': '대시',
        'Charge': '차지',
        'Skill': '스킬',
        'Pause': '일시정지',
        'VOLUME': '음량',
        'Master Volume': '마스터 음량',
        'Music Volume': '음악 음량',
        'SFX Volume': '효과음 음량',
        'Sound': '소리',
        'LANGUAGE': '언어',
        'SAVE': '저장',
        'SPECIAL SKILLS': '특수 스킬',
        'CONFIRM': '확인',
        'JOKER POWERS': '조커 능력',
        'LOADOUT': '로드아웃',
        'Prepare your cube, skill, and jokers': '큐브, 스킬, 조커를 준비하세요',
        'START': '시작',
        'UPLOAD IMAGE': '이미지 업로드',
        'SKILL': '스킬',
        'JOKERS': '조커',
        'None': '없음',
        'Choose your special skill and joker powers': '특수 스킬과 조커 능력을 선택하세요',
        'SPECIAL SKILL': '특수 스킬',
        'EXIT GAME': '게임 종료',
        'Passive abilities that last the whole match': '전체 경기 동안 지속되는 패시브 능력',
        'INFINITE CHARGE': '무한 차지',
        '5s: Continuous charging with +2 blocks range.': '5초: 사거리 +2칸 연속 차지.',
        'CLONE CREATION': '클론 생성',
        'Permanent: Spawn 2 friendly AI clones.': '영구: 아군 AI 클론 2기 소환.',
        'INVISIBLE TRAIL': '투명 궤적',
        '4s: Your trail becomes invisible to everyone.': '4초: 내 궤적이 모두에게 보이지 않음.',
        'INFINITE TRAILS': '무한 궤적',
        'Forever: Trails do not decay during activation.': '영구: 활성화 중 궤적이 사라지지 않음.',
        'LASER TRAIL': '레이저 궤적',
        '6s: Global laser lines every 1s.': '6초: 매초 전역 레이저 발사.',
        'CHARGE+': '차지+',
        'Your charge moves 2 extra grids.': '차지가 2칸 더 멀리 이동.',
        'NO HUNGER': '배고픔 없음',
        'Your hunger bar never goes down! No need to eat apples.': '배고픔 게이지가 줄지 않음! 사과 불필요.',
        'RAGE': '분노',
        'All cooldowns are 50% shorter.': '모든 쿨타임이 50% 단축됩니다.',
        'FAST DASH': '빠른 대시',
        'Dash has no cooldown.': '대시에 쿨타임이 없습니다.',
        'BORDER SAFE': '경계 안전',
        'You cannot die from border contact.': '가장자리를 따라 미끄러짐 — 떨어지지 않음.',
        'Slide along board edges — you never fall off.': '가장자리를 따라 미끄러짐 — 떨어지지 않음.',
        'DOUBLE EFFECTIVE': '2배 효과',
        'Doubles effectiveness of your other jokers!': '다른 조커의 효과를 2배로 늘립니다!',
        'FRIEND WALLS': '아군 벽',
        'Spawn 2 passable walls only you can use.': '나만 지나갈 수 있는 벽 2개 생성.',
        'TRAIL GROWTH': '궤적 성장',
        'Your trail grows +1 every second!': '매초 궤적이 +1 증가!',
        'EXTRA LIFE': '추가 생명',
        'Survive your first death.': '첫 사망을 버팀.',
        'DISABLE': '무효화',
        'Randomly disable one of enemy\'s jokers!': '상대 조커 하나를 무작위로 비활성화!',
        'PLAY': '플레이',
        'CHANGE COLOUR': '색상 변경',
        'START (VS AI)': '시작 (VS AI)',
        'SPECTATE': '관전',
        'MULTIPLAYER': '멀티플레이어',
        'BACK': '뒤로',
        'HOST ROOM': '방 만들기',
        'JOIN ROOM': '방 참가',
        'ENTER NICKNAME': '닉네임 입력',
        'ENTER ROOM NAME': '방 이름 입력',
        'FEATURED ROOMS': '추천 방',
        'YOUR RECENT ROOMS': '최근 방',
        'NO RECENT ROOMS': '최근 방 없음',
        'READY TO PLAY': '게임 준비 완료',
        'LOG: WAITING FOR USER...': '로그: 사용자 대기 중...',
        'WAITING ROOM': '대기실',
        'YOU': '당신',
        'ENEMY': '적',
        'WAITING...': '대기 중...',
        'NOT READY': '준비 안 됨',
        'READY': '준비 완료',
        'CHANGE CUBE': '큐브 변경',
        'COPY JOIN LINK': '가입 링크 복사',
        'EXIT LOBBY': '로비 나가기',
        'CUSTOMIZE CUBE': '큐브 사용자 지정',
        'CHANGE YOUR CUBE COLOUR': '큐브 색상 변경',
        'CONFIRM COLOUR': '색상 확인',
        'ONLINE LOBBY': '온라인 로비',
        'SOUND: ON': '소리: 켬',
        'SOUND: OFF': '소리: 끔',
        'GOT IT': '알았습니다',
        'VS': 'VS',
        'CLOSE': '닫기',
        'NEXT': '다음',
        'ENTER GAME': '게임 진입',
        'CLICK TO SKIP': '클릭하여 건너뛰기',
        'REFRESH': '새로 고침',
        'ENTER ROOM NAME (e.g. RONK123)': '방 이름 입력 (예: RONK123)',
        'TUTORIAL_0': 'WASD로 이동',
        'TUTORIAL_1': 'F로 대시',
        'TUTORIAL_2': 'C로 차지',
        'TUTORIAL_3': '특수 스킬: «특수 스킬» 메뉴 열기',
        'TUTORIAL_4': '스킬 선택: 방향키로 고르기',
        'TUTORIAL_5': '스킬 사용: 게임 중 Y 키',
        'TUTORIAL_MSG_4': '가장자리에서 대시 · 맵 이동을 보세요',
        'PAUSED': '일시정지',
        'RESUME': '재개',
        'QUIT TO MENU': '메뉴로 돌아가기',
        'CONTINUE': '계속',
        'WAITING FOR RIVAL...': '상대 대기 중...',
        'PLAY AGAIN': '다시 플레이',
        'MENU': '메뉴',
        // Gamemode
        'GAMEMODE': '게임 모드',
        'GAMEMODE: CLASSIC': '게임 모드: 클래식',
        'GAMEMODE: SIMPLISTIC': '게임 모드: 단순',
        'CLASSIC': '클래식',
        'SIMPLISTIC': '단순',
        'BOT DIFFICULTY': '봇 난이도',
        'EASY': '쉬움',
        'MEDIUM': '보통',
        'HARD': '어려움',
        'INVINCIBLE': '엘리트',
        'MATCHMAKING': '매치메이킹',
        'MATCHMAKE': '빠른 매칭',
        'PLAY WITH FRIEND': '친구와 플레이',
        'STEAM FRIENDS': 'Steam 친구',
        'FIND MATCH': '매칭 찾기',
        'CANCEL': '취소',
        'CANCEL SEARCH': '검색 취소',
        'HOST': '방 만들기',
        'JOIN FRIEND': '친구 참가',
        'INVITE STEAM FRIEND': 'Steam 친구 초대',
        'HOST OR JOIN A FRIEND': '방 만들기 또는 친구 참가',
        'FRIEND\'S ROOM CODE': '친구 방 코드',
        'ADD STEAM FRIEND': 'Steam 친구 추가',
        'REPORT RIVAL': '상대 신고',
        'REPORT': '신고',
        'REPORT_MODAL_SUB': '신고 사유를 선택하세요. 허위 신고는 무시될 수 있습니다.',
        'REPORT_HACK': '핵 / 치트',
        'REPORT_NSFW': '19금 / 부적절한 이미지',
        'REPORT_HARASSMENT': '괴롭힘 / 비매너',
        'REPORT_OTHER': '기타',
        'SEARCHING FOR OPPONENT...': '상대를 찾는 중...',
        'MATCHMAKING CANCELLED': '매치메이킹 취소됨',
        'WAITING FOR PLAYER...': '플레이어 대기 중...',
        'JOINING MATCH...': '매치 참가 중...',
        'MATCH TIMED OUT': '매칭 시간 초과',
        'FRIEND LOBBY OPEN — INVITE SENT': '친구 로비 개설 — 초대 전송됨',
        'STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.': '친구 대전에는 Steam이 필요합니다. Steam으로 게임을 실행하세요.',
        'Passive: Opponents cannot see your trail.': '패시브: 상대가 내 궤적을 볼 수 없음.',
        'Passive: Your trail never decays.': '패시브: 궤적이 사라지지 않음.',
        'SPECTATE FRIEND': '친구 관전',
        'SPECTATE FRIEND UNAVAILABLE': '친구 실시간 관전은 아직 지원되지 않습니다. Steam 친구 로비에서는 함께 플레이할 수 있지만, 이 빌드에는 관전 중계가 없습니다. SPECTATE로 무적 AI 대 AI를 관전하세요.',
        'TUTORIAL': '튜토리얼',
        'SKIP TUTORIAL': '튜토리얼 건너뛰기',
        'NEW PLAYER TRAINING': '신규 플레이어 훈련',
        'TUTORIAL_MSG_0': 'WASD로 이동',
        'TUTORIAL_MSG_1': 'F로 대시',
        'TUTORIAL_MSG_2': 'C로 차지',
        'TUTORIAL_MSG_3': '적 궤적은 즉사',
        'TUTORIAL_MSG_4_ARRIVAL': '보드를 이동했습니다 — 맵이 위치를 표시합니다',
        'TUTORIAL_MSG_5': '흰 칸 3개를 모두 차지해 이 보드를 소유하세요',
        'TUTORIAL_MSG_6': 'Y로 스킬',
        'TUTORIAL_MSG_7': '사과를 먹으세요',
        'TUTORIAL_MSG_8': '맵은 흰색으로 시작 — 점령한 보드는 내 색을 유지',
        'TUTORIAL_MSG_10': '라이벌을 처치해 라운드 승리 — 차지로 돌파하세요',
        'TUTORIAL_MSG_11': '라운드: 1킬 · 또는 보드 3개 일직선',
        'TUTORIAL_MSG_12': '이동 · 체크포인트 · 허기 · 스킬',
        'TUTORIAL_MSG_13': '매치: 먼저 3',
        'TUTORIAL_GATE_SUBTITLE': '9보드 · 킬 또는 일직선 · 먼저 6',
        'NOTIFY_LOSS_KILLS': '라운드=1킬 또는 일직선. 매치=먼저 6.',
        'NOTIFY_LOSS_BOARDS': '보드 3개 일직선으로 라운드 승리. 또는 1킬.',
        'SKILL_LOCKED': '잠김 — 봇을 이겨 해제',
        'JOKER_LOCKED': '잠김',
        'UNLOCKED': '해제됨',
        'SKILL UNLOCKED': '스킬 해제',
        'JOKER UNLOCKED': '조커 해제',
        'BEAT_BOTS_TO_UNLOCK': '쉬움~엘리트 봇을 이기거나 온라인에서 플레이어를 이기면 해당 스킬과 조커 해제',
        'BEAT_PLAYER_TO_UNLOCK': '멀티플레이에서 다른 플레이어를 이겨 스킬과 조커 해제',
        'COMPLETE_TUTORIAL_TO_UNLOCK': '먼저 튜토리얼을 완료하세요 — 그다음 봇을 이겨 스킬과 조커를 해제하세요',
        'TUTORIAL_UNLOCK_HINT': '스킬과 조커가 잠겨 있습니다 — 봇이나 온라인 상대를 이겨 로드아웃을 먼저 해제하세요.',
        'NOTIFY_FIRST_SKILL_KICKER': '첫 스킬 해제',
        'NOTIFY_FIRST_JOKER_KICKER': '첫 조커 해제',
        'NOTIFY_SKILL_KICKER': '스킬 해제',
        'NOTIFY_JOKER_KICKER': '조커 해제',
        'NOTIFY_SKILL_HINT': '다음 매치 전 로드아웃 → 스킬에서 장착',
        'NOTIFY_JOKER_HINT': '로드아웃 → 조커에서 장착 (최대 2개)',
        'NOTIFY_TUTORIAL_DONE_TITLE': '튜토리얼 완료',
        'NOTIFY_TUTORIAL_DONE_BODY': '라이벌을 이겨 스킬과 조커를 해제하세요.',
        'NOTIFY_FIRST_BOARD_TITLE': '보드 점령',
        'NOTIFY_FIRST_BOARD_BODY': '보드 3개 일직선 — 또는 1킬.',
        'NOTIFY_FIRST_SKILL_USE_TITLE': '스킬 발동',
        'NOTIFY_FIRST_SKILL_USE_HINT': '매치 중 Y를 눌러 장착한 스킬 사용',
        'FIRST_PLAY_UNLOCK_TITLE': '스킬 & 조커 잠김',
        'FIRST_PLAY_UNLOCK_BODY': '모든 스킬과 조커는 처음엔 잠깁니다. 봇(쉬움~엘리트)을 이기거나 온라인에서 이기면 상대가 쓰던 것을 해제합니다.',
        'RESOLUTION': '해상도',
        'LEGAL': '법적 고지',
        'LEGAL_NOTICE': 'RonkBonk의 무단 복사, 재배포 또는 리버스 엔지니어링은 금지됩니다. 설치 폴더의 COPYRIGHT.txt를 확인하세요.',
        'REPORT_NO_RIVAL': '신고할 온라인 상대가 없습니다.',
        'REPORT_ALREADY': '이 상대는 최근에 이미 신고했습니다.',
        'REPORT_SUBMITTED': '신고가 접수되었습니다. RonkBonk를 안전하게 지켜 주셔서 감사합니다.',
        'SAFE_UPLOAD_BLOCKED': '콘텐츠 보안으로 업로드가 차단되었습니다.',
        'SAFE_SYSTEM_UNAVAILABLE': '보안 시스템을 사용할 수 없음 — 업로드 차단됨.',
        'SAFE_PROCESS_FAIL': '해당 이미지를 안전하게 처리할 수 없습니다.',
        'SAFE_PEER_OFFLINE': '공유 이미지를 차단했습니다(보안 오프라인).',
        'SAFE_PEER_BLOCKED': '안전하지 않은 공유 이미지를 차단했습니다.',
        'SAFE_BAD_SIGNATURE': '실제 이미지가 아닌 파일입니다(보안상 차단).',
        'SAFE_MALWARE': '안전하지 않은 내용이 감지됨. 업로드 차단됨.',
        'SAFE_FORBIDDEN_FORMAT': '허용되지 않는 파일 형식입니다.',
        'SAFE_READ_FAIL': '파일을 읽을 수 없습니다.',
        'SAFE_DECODE_FAIL': '이미지를 디코딩할 수 없습니다. 다른 JPG/PNG를 시도하세요.',
        'SAFE_TOO_SMALL': '이미지가 너무 작습니다.',
        'SAFE_DIMENSIONS': '이미지 크기가 너무 큽니다.',
        'SAFE_AGE_RESTRICTED': '이미지 차단 — 모든 연령에 부적절할 수 있습니다.',
        'SAFE_AGE_FAIL': '이미지가 안전 검사를 통과하지 못했습니다.',
        'SAFE_PIXEL_FAIL': '이미지를 검사할 수 없습니다.',
        'SAFE_ENCODE_FAIL': '이미지를 정리할 수 없습니다.',
        'SAFE_SHARED_AGE': '공유 이미지 차단 — 모든 연령에 부적절할 수 있습니다.',
        'SAFE_SHARED_FAIL': '공유 이미지가 안전 검사를 통과하지 못했습니다.',
        'SAFE_SHARED_PIXEL': '공유 이미지를 검사할 수 없습니다.',
        'SAFE_SHARED_ENCODE': '공유 이미지를 정리할 수 없습니다.',
        'SAFE_MALWARE_DATA': '안전하지 않은 이미지 데이터를 차단했습니다.',
        'unlocked': '해제됨',

    }
};

function updateCollectionProgress(el, unlocked, total) {
    if (!el) return;
    const savedLanguage = localStorage.getItem('ronk_language') || 'en';
    const t = translations[savedLanguage] || translations['en'];
    const suffix = t['unlocked'] || 'unlocked';
    el.textContent = `${unlocked} / ${total} ${suffix}`;
}

function countUnlockedSkills() {
    return SKILL_DATA.filter((skill) => isSkillUnlocked(skill.id)).length;
}

function countUnlockedJokers() {
    return JOKER_DATA.filter((joker) => isJokerUnlocked(joker.id)).length;
}

function updateSkillProgressUI() {
    updateCollectionProgress(document.getElementById('skills-unlock-progress'), countUnlockedSkills(), SKILL_DATA.length);
    const counterEl = document.getElementById('skill-carousel-counter');
    if (counterEl) {
        counterEl.textContent = `${currentSkillIndex + 1} / ${SKILL_DATA.length}`;
    }
}

function updateJokerProgressUI() {
    updateCollectionProgress(document.getElementById('jokers-unlock-progress'), countUnlockedJokers(), JOKER_DATA.length);
}

function setSkillPreviewLockOverlay(previewCard, locked) {
    if (!previewCard) return;
    // Lock state shows on the spinning plane + emoji — no extra overlay box
    let lockOverlay = previewCard.querySelector('.collection-lock-overlay');
    if (lockOverlay) lockOverlay.remove();
}

function updateSkillDescStrip(skill, locked, t) {
    const nameEl = document.getElementById('skill-preview-name');
    const descEl = document.getElementById('skill-preview-desc');
    const stripEl = document.getElementById('skill-preview-info');
    if (!nameEl || !descEl) return;

    if (locked || !skill) {
        nameEl.textContent = t['SKILL_LOCKED'] || t['JOKER_LOCKED'] || 'LOCKED';
        descEl.textContent = '';
        if (stripEl) stripEl.classList.add('locked');
        return;
    }

    nameEl.textContent = t[skill.name] || skill.name;
    descEl.textContent = t[skill.desc] || skill.desc;
    if (stripEl) stripEl.classList.remove('locked');
}

function updateJokerDescStrip() {
    const nameEl = document.getElementById('joker-preview-name');
    const descEl = document.getElementById('joker-preview-desc');
    const stripEl = document.getElementById('joker-preview-info');
    if (!nameEl || !descEl) return;

    const savedLanguage = localStorage.getItem('ronk_language') || 'en';
    const t = translations[savedLanguage] || translations['en'];

    let focusId = jokerPreviewFocusId;
    if (!focusId && Array.isArray(p1SelectedJoker) && p1SelectedJoker.length > 0) {
        focusId = p1SelectedJoker[p1SelectedJoker.length - 1];
    }

    if (!focusId) {
        nameEl.textContent = '';
        descEl.textContent = '';
        if (stripEl) stripEl.classList.remove('locked');
        return;
    }

    const joker = JOKER_DATA.find((entry) => entry.id === focusId);
    if (!joker) {
        nameEl.textContent = '';
        descEl.textContent = '';
        return;
    }

    const locked = !isJokerUnlocked(joker.id);
    if (locked) {
        nameEl.textContent = t['JOKER_LOCKED'] || 'LOCKED';
        descEl.textContent = '';
        if (stripEl) stripEl.classList.add('locked');
        return;
    }

    nameEl.textContent = t[joker.name] || joker.name;
    descEl.textContent = t[joker.desc] || joker.desc;
    if (stripEl) stripEl.classList.remove('locked');
}

function updateSkillPreview() {
    const iconEl = document.getElementById('skill-preview-icon');
    const previewCard = document.getElementById('skill-preview-card');
    const unlockedIndices = getUnlockedSkillIndices();
    const savedLanguage = localStorage.getItem('ronk_language') || 'en';
    const t = translations[savedLanguage] || translations['en'];

    if (isUnlockProgressionEnabled() && unlockedIndices.length === 0) {
        if (previewCard) previewCard.classList.add('locked');
        setSkillPreviewLockOverlay(previewCard, true);
        if (iconEl) iconEl.textContent = '🔒';
        if (p1) p1.selectedSkill = null;
        updateSkillDescStrip(null, true, t);
        updateLoadoutSummary();
        updateSkillProgressUI();
        return;
    }

    const skill = SKILL_DATA[currentSkillIndex];
    if (!skill) return;

    const locked = !isSkillUnlocked(skill.id);
    if (previewCard) previewCard.classList.toggle('locked', locked);
    setSkillPreviewLockOverlay(previewCard, locked);

    if (locked) {
        if (iconEl) iconEl.textContent = '🔒';
        if (p1) p1.selectedSkill = null;
        updateSkillDescStrip(skill, true, t);
        updateLoadoutSummary();
        updateSkillProgressUI();
        return;
    }

    if (iconEl) iconEl.textContent = skill.icon;
    setSkillPreviewLockOverlay(previewCard, false);

    if (loadoutEditSlot === 2 && loadoutPageMode === 'dual') {
        localStorage.setItem('ronk_p2_selectedSkill', skill.id);
        if (skill.id === 'infinite-trails' && Array.isArray(p2LoadoutJokers) && p2LoadoutJokers.includes('trail-growth')) {
            p2LoadoutJokers = p2LoadoutJokers.filter((id) => id !== 'trail-growth');
            localStorage.setItem('ronk_p2_selectedJoker', JSON.stringify(p2LoadoutJokers));
            if (typeof renderJokersGrid === 'function') renderJokersGrid();
        }
    } else {
        if (p1) p1.selectedSkill = skill.id;
        localStorage.setItem('ronk_selectedSkill', skill.id);
        if (skill.id === 'infinite-trails' && Array.isArray(p1SelectedJoker) && p1SelectedJoker.includes('trail-growth')) {
            p1SelectedJoker = p1SelectedJoker.filter((id) => id !== 'trail-growth');
            localStorage.setItem('ronk_selectedJoker', JSON.stringify(p1SelectedJoker));
            if (typeof renderJokersGrid === 'function') renderJokersGrid();
        }
    }
    updateSkillDescStrip(skill, false, t);
    updateLoadoutSummary();
    updateSkillProgressUI();
}

function toggleJokerSelection(jokerId) {
    if (!jokerId || !isJokerUnlocked(jokerId)) {
        SFX.play('button');
        return;
    }
    const editingP2 = loadoutEditSlot === 2 && loadoutPageMode === 'dual';
    let bag = editingP2
        ? (Array.isArray(p2LoadoutJokers) ? p2LoadoutJokers : [])
        : (Array.isArray(p1SelectedJoker) ? p1SelectedJoker : (p1SelectedJoker ? [p1SelectedJoker] : []));
    if (!editingP2 && !Array.isArray(p1SelectedJoker)) {
        p1SelectedJoker = bag;
    }
    const skillId = editingP2
        ? localStorage.getItem('ronk_p2_selectedSkill')
        : ((p1 && p1.selectedSkill) || localStorage.getItem('ronk_selectedSkill'));
    if (jokerId === 'trail-growth' && skillId === 'infinite-trails' && !bag.includes(jokerId)) {
        SFX.play('button');
        return;
    }
    if (bag.includes(jokerId)) {
        bag = bag.filter((id) => id !== jokerId);
    } else if (bag.length < 2) {
        bag = [...bag, jokerId];
    } else {
        SFX.play('button');
        return;
    }
    jokerPreviewFocusId = jokerId;
    if (editingP2) {
        p2LoadoutJokers = bag;
        localStorage.setItem('ronk_p2_selectedJoker', JSON.stringify(p2LoadoutJokers));
    } else {
        p1SelectedJoker = bag;
        localStorage.setItem('ronk_selectedJoker', JSON.stringify(p1SelectedJoker));
    }
    renderJokersGrid();
    updateLoadoutSummary();
    SFX.play('button');
}

function handleJokerGridPointer(e) {
    if (!jokersGrid) return;
    const card = e.target.closest('.collection-item');
    if (!card || !jokersGrid.contains(card)) return;

    if (e.type === 'click') {
        e.preventDefault();
        toggleJokerSelection(card.dataset.jokerId);
        return;
    }

    if (e.type === 'mouseover') {
        jokerPreviewFocusId = card.dataset.jokerId || null;
        updateJokerDescStrip();
        return;
    }

    if (e.type === 'mouseout') {
        const related = e.relatedTarget;
        if (related && card.contains(related)) return;
        jokerPreviewFocusId = null;
        updateJokerDescStrip();
    }
}

function bindJokerGridEvents() {
    if (!jokersGrid || jokersGrid.dataset.delegateBound === '1') return;
    jokersGrid.dataset.delegateBound = '1';
    jokersGrid.addEventListener('click', handleJokerGridPointer);
    jokersGrid.addEventListener('mouseover', handleJokerGridPointer);
    jokersGrid.addEventListener('mouseout', handleJokerGridPointer);
    jokersGrid.addEventListener('focusin', (e) => {
        const card = e.target.closest('.collection-item');
        if (!card || !jokersGrid.contains(card)) return;
        jokerPreviewFocusId = card.dataset.jokerId || null;
        updateJokerDescStrip();
    });
    jokersGrid.addEventListener('focusout', (e) => {
        const card = e.target.closest('.collection-item');
        if (!card || !jokersGrid.contains(card)) return;
        const related = e.relatedTarget;
        if (related && card.contains(related)) return;
        jokerPreviewFocusId = null;
        updateJokerDescStrip();
    });
    jokersGrid.addEventListener('keydown', (e) => {
        const card = e.target.closest('.collection-item');
        if (!card || !jokersGrid.contains(card)) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleJokerSelection(card.dataset.jokerId);
        }
    });
}

function renderJokersGrid() {
    if (!jokersGrid) return;
    bindJokerGridEvents();
    jokersGrid.innerHTML = '';
    const editingP2 = loadoutEditSlot === 2 && loadoutPageMode === 'dual';
    if (!editingP2 && !Array.isArray(p1SelectedJoker)) {
        p1SelectedJoker = p1SelectedJoker ? [p1SelectedJoker] : [];
    }
    if (!editingP2) {
        p1SelectedJoker = p1SelectedJoker.filter((id) => isJokerUnlocked(id));
    } else {
        p2LoadoutJokers = (Array.isArray(p2LoadoutJokers) ? p2LoadoutJokers : []).filter((id) => isJokerUnlocked(id));
    }
    const selectedBag = editingP2 ? p2LoadoutJokers : p1SelectedJoker;
    const skillId = editingP2
        ? localStorage.getItem('ronk_p2_selectedSkill')
        : ((p1 && p1.selectedSkill) || localStorage.getItem('ronk_selectedSkill'));
    JOKER_DATA.forEach((joker) => {
        const locked = !isJokerUnlocked(joker.id);
        const incompatible = joker.id === 'trail-growth' && skillId === 'infinite-trails';
        const card = document.createElement('div');
        card.className = 'collection-item'
            + (selectedBag.includes(joker.id) ? ' selected' : '')
            + (locked ? ' locked' : '')
            + (incompatible ? ' locked' : '');
        card.dataset.jokerId = joker.id;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', (locked || incompatible) ? '-1' : '0');
        card.setAttribute('aria-pressed', selectedBag.includes(joker.id) ? 'true' : 'false');
        card.innerHTML = `
            <div class="collection-item-icon">${locked || incompatible ? '🔒' : joker.icon}</div>
            ${locked || incompatible ? '<div class="collection-lock-overlay" aria-hidden="true"><span class="collection-lock-icon">🔒</span></div>' : ''}
        `;
        jokersGrid.appendChild(card);
    });
    updateJokerDescStrip();
    updateJokerProgressUI();
    updateLoadoutSummary();
}

let loadoutCubeCanvas = null;
let loadoutCubeCtx = null;
let loadoutCubeAnimId = null;
let loadoutCubeIntervalId = null;
let loadoutCubeRy = 0;
let loadoutUploadLabelCache = null;
let loadoutUploadLabelSize = 0;
const LOADOUT_CUBE_RX = -0.22;
const LOADOUT_CUBE_RZ = 0.16;
const LOADOUT_CUBE_SPIN_MS = 10000;
let loadoutCubeLastFrameTime = 0;

function isLoadoutPageVisible() {
    return loadoutPage && !loadoutPage.classList.contains('hidden');
}

function initLoadoutCubeCanvas() {
    loadoutCubeCanvas = document.getElementById('loadout-cube-canvas');
    if (!loadoutCubeCanvas) return;
    loadoutCubeCtx = loadoutCubeCanvas.getContext('2d', { alpha: true });
    loadoutCubeCanvas.style.background = 'transparent';
    resizeLoadoutCubeCanvas();
}

let loadoutCubeHalf = 100;

function resizeLoadoutCubeCanvas() {
    if (!loadoutCubeCanvas) return;
    const stage = loadoutCubeCanvas.closest('.loadout-cube-stage');
    /* Viewport-only size — ignore stage CSS so theme switches never change canvas geometry */
    const viewportCap = Math.min(window.innerWidth * 0.42, window.innerHeight * 0.42, 380);
    const size = Math.max(220, Math.min(viewportCap || 360, 380));
    // Must match drawLoadoutCubeFrame dpr math — effectiveDpr mismatch skewed the cube off-center
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    loadoutCubeCanvas.width = Math.floor(size * dpr);
    loadoutCubeCanvas.height = Math.floor(size * dpr);
    loadoutCubeCanvas.style.width = `${size}px`;
    loadoutCubeCanvas.style.height = `${size}px`;
    if (stage) {
        stage.style.width = `${size}px`;
        stage.style.height = `${size}px`;
    }
    if (loadoutCubeCtx) {
        loadoutCubeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    loadoutCubeHalf = calcLoadoutCubeHalf(size, size);
}

/** Fixed size for the spin — computed once on resize, not per frame. Optional fixedRy fits a single export pose. */
function calcLoadoutCubeHalf(w, h, rx = LOADOUT_CUBE_RX, rz = LOADOUT_CUBE_RZ, fixedRy = null) {
    const margin = Math.min(w, h) * (fixedRy != null ? 0.08 : 0.1);
    let half = Math.min(w, h) * (fixedRy != null ? 0.42 : 0.36);
    const rySamples = fixedRy != null
        ? [fixedRy]
        : Array.from({ length: 36 }, (_, i) => (i / 36) * Math.PI * 2);
    for (let attempt = 0; attempt < 20; attempt++) {
        let fitsAll = true;
        for (const ry of rySamples) {
            const pts = computeLoadoutCubeProjected(w, h, half, rx, ry, rz);
            const xs = pts.map((p) => p.x);
            const ys = pts.map((p) => p.y);
            if (
                Math.min(...xs) < margin ||
                Math.max(...xs) > w - margin ||
                Math.min(...ys) < margin ||
                Math.max(...ys) > h - margin
            ) {
                fitsAll = false;
                break;
            }
        }
        if (fitsAll) return half;
        half *= 0.94;
    }
    return half;
}

function stopLoadoutCubeRender() {
    if (loadoutCubeAnimId) {
        cancelAnimationFrame(loadoutCubeAnimId);
        loadoutCubeAnimId = null;
    }
    if (loadoutCubeIntervalId) {
        clearInterval(loadoutCubeIntervalId);
        loadoutCubeIntervalId = null;
    }
    loadoutCubeLastFrameTime = 0;
}

/** Free loadout cube framebuffer while the page is closed (rebuilds on reopen). */
function releaseLoadoutCubeMemory() {
    stopLoadoutCubeRender();
    if (loadoutCubeCanvas) {
        try {
            loadoutCubeCanvas.width = 0;
            loadoutCubeCanvas.height = 0;
        } catch (_) { /* ignore */ }
    }
    loadoutUploadLabelCache = null;
    loadoutUploadLabelSize = 0;
}

function startLoadoutCubeRender() {
    if (loadoutPageMode === 'dual') {
        stopLoadoutCubeRender();
        loadoutCubeAnimId = requestAnimationFrame(animateLoadoutCube);
        return;
    }
    if (!loadoutCubeCanvas) initLoadoutCubeCanvas();
    if (!loadoutCubeCtx) return;
    resizeLoadoutCubeCanvas();
    stopLoadoutCubeRender();
    loadoutCubeAnimId = requestAnimationFrame(animateLoadoutCube);
}

function animateLoadoutCube(timestamp) {
    if (document.hidden) {
        stopLoadoutCubeRender();
        return;
    }
    if (!isLoadoutPageVisible()) {
        stopLoadoutCubeRender();
        return;
    }
    if (!loadoutCubeLastFrameTime) loadoutCubeLastFrameTime = timestamp - 33;
    const dt = Math.min(timestamp - loadoutCubeLastFrameTime, 48);
    // Decorative spin — ~30 FPS is enough; frees RAF for menus/match
    if (dt < 32) {
        loadoutCubeAnimId = requestAnimationFrame(animateLoadoutCube);
        return;
    }
    loadoutCubeLastFrameTime = timestamp;
    loadoutCubeRy += (2 * Math.PI / LOADOUT_CUBE_SPIN_MS) * dt;
    if (loadoutPageMode === 'dual') {
        drawDualLoadoutCubes();
    } else {
        drawLoadoutCubeFrame();
    }
    loadoutCubeAnimId = requestAnimationFrame(animateLoadoutCube);
}

function ensureLoadoutCubeCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const stage = canvas.closest('.loadout-cube-stage');
    const dual = loadoutPageMode === 'dual';
    const maxSize = dual
        ? Math.min(window.innerWidth * 0.42, window.innerHeight * 0.46, 340)
        : 280;
    const minSize = dual ? 160 : 120;
    const fallback = dual ? 280 : 220;
    const size = stage
        ? Math.max(minSize, Math.min(stage.clientWidth || fallback, stage.clientHeight || fallback, maxSize))
        : fallback;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(size * dpr);
    canvas.height = Math.floor(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx2 = canvas.getContext('2d', { alpha: true });
    if (ctx2) ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { canvas, ctx: ctx2, size, dpr, half: calcLoadoutCubeHalf(size, size) };
}

function drawDualLoadoutCubes() {
    const p1 = ensureLoadoutCubeCanvas('loadout-cube-canvas-p1')
        || ensureLoadoutCubeCanvas('loadout-cube-canvas');
    const p2 = ensureLoadoutCubeCanvas('loadout-cube-canvas-p2');
    if (p1?.ctx) {
        drawLoadoutCubeFrame({
            ctx: p1.ctx,
            canvas: p1.canvas,
            dpr: p1.dpr,
            w: p1.size,
            h: p1.size,
            half: p1.half,
            ry: loadoutCubeRy,
            color: neonColors[currentColorIndex],
            colorIndex: currentColorIndex,
            customImage: (currentColorIndex === neonColors.length - 1) ? playerImage : null
        });
    }
    if (p2?.ctx) {
        drawLoadoutCubeFrame({
            ctx: p2.ctx,
            canvas: p2.canvas,
            dpr: p2.dpr,
            w: p2.size,
            h: p2.size,
            half: p2.half,
            ry: loadoutCubeRy + 0.35,
            color: neonColors[p2ColorIndex],
            colorIndex: p2ColorIndex,
            customImage: (p2ColorIndex === neonColors.length - 1) ? playerImageP2 : null
        });
    }
}

function parseLoadoutHex(hex) {
    if (!hex || !hex.startsWith('#')) return { r: 255, g: 0, b: 80 };
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return {
        r: parseInt(h.slice(0, 2), 16) || 0,
        g: parseInt(h.slice(2, 4), 16) || 0,
        b: parseInt(h.slice(4, 6), 16) || 0
    };
}

function adjustLoadoutHex(hex, percent) {
    let parsedHex = hex;
    if (!parsedHex.startsWith('#')) return parsedHex;
    if (parsedHex.length === 4) {
        parsedHex = '#' + parsedHex[1] + parsedHex[1] + parsedHex[2] + parsedHex[2] + parsedHex[3] + parsedHex[3];
    }
    const num = parseInt(parsedHex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.min(255, Math.max(0, (num >> 16) + amt));
    const G = Math.min(255, Math.max(0, (num >> 8 & 0x00FF) + amt));
    const B = Math.min(255, Math.max(0, (num & 0x0000FF) + amt));
    return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}

/** Bapbap ambient — deeper purple wash so cubes sit in liquid-noir, not neon plastic. */
const WB_CUBE_AMBIENT = { r: 118, g: 68, b: 188 };

function mixLoadoutRgb(a, b, t) {
    const k = Math.max(0, Math.min(1, t));
    return {
        r: Math.round(a.r + (b.r - a.r) * k),
        g: Math.round(a.g + (b.g - a.g) * k),
        b: Math.round(a.b + (b.b - a.b) * k)
    };
}

const wbShadeCache = new Map();
function wbCubeShadeHex(hex, lightAmt, purpleMix = 0.2) {
    const key = `${hex}|${lightAmt}|${purpleMix}`;
    if (wbShadeCache.has(key)) return wbShadeCache.get(key);
    const lit = adjustLoadoutHex(hex, lightAmt);
    const mixed = mixLoadoutRgb(parseLoadoutHex(lit), WB_CUBE_AMBIENT, purpleMix);
    const result = '#' + (0x1000000 + mixed.r * 0x10000 + mixed.g * 0x100 + mixed.b).toString(16).slice(1);
    wbShadeCache.set(key, result);
    if (wbShadeCache.size > 2048) wbShadeCache.clear();
    return result;
}

const LOADOUT_FACE_LIGHT = {
    '0,1,2,3': 0,
    '5,4,7,6': -12,
    '4,0,3,7': -28,
    '1,5,6,2': -6,
    '3,2,6,7': -18,
    '4,5,1,0': -32
};

const WB_LOADOUT_FACE_LIGHT = {
    '0,1,2,3': -4,
    '5,4,7,6': -14,
    '4,0,3,7': -24,
    '1,5,6,2': -8,
    '3,2,6,7': -16,
    '4,5,1,0': -28
};

function loadoutFacePath(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
}

function drawLoadoutCubeGroundShadow(ctx, pts, theme) {
    if (theme !== 'theme-white-black' && theme !== 'theme-pinkcore') return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = Math.max(...ys) + 8;
    const rx = (Math.max(...xs) - Math.min(...xs)) * 0.42;
    const ry = rx * 0.28;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (theme === 'theme-pinkcore') {
        ctx.fillStyle = 'rgba(255, 105, 180, 0.22)';
    } else {
        ctx.fillStyle = 'rgba(42, 18, 82, 0.34)';
    }
    ctx.filter = 'blur(7px)';
    ctx.fill();
    ctx.restore();
}

function fillLoadoutGrayCubeFace(ctx, points, shade, baseHex = '#888888') {
    loadoutFacePath(ctx, points);
    const { r } = parseLoadoutHex(baseHex);
    const bright = Math.min(255, Math.floor(r * (0.88 + shade * 0.22)));
    const mid = Math.min(255, Math.floor(r * (0.68 + shade * 0.22)));
    const dark = Math.min(255, Math.floor(r * (0.48 + shade * 0.20)));
    const grad = ctx.createLinearGradient(points[0].x, points[0].y, points[2].x, points[2].y);
    grad.addColorStop(0, `rgb(${bright},${bright},${bright})`);
    grad.addColorStop(0.55, `rgb(${mid},${mid},${mid})`);
    grad.addColorStop(1, `rgb(${dark},${dark},${dark})`);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
}

function fillLoadoutCubeFace(ctx, points, theme, color, faceKey, rgb, shade = 1) {
    const { r, g, b } = rgb;
    loadoutFacePath(ctx, points);

    if (theme === 'theme-hacker') {
        ctx.fillStyle = getCachedRgba(color, 0.2);
        ctx.fill();
        return;
    }

    if (theme === 'theme-white-black') {
        // Liquid-noir material: picker color stays readable, lighting leans purple/cool.
        const light = WB_LOADOUT_FACE_LIGHT[faceKey] ?? -14;
        const bright = wbCubeShadeHex(color, light + 4, 0.2);
        const base = wbCubeShadeHex(color, light - 6, 0.28);
        const dark = wbCubeShadeHex(color, light - 24, 0.4);
        const cool = wbCubeShadeHex(color, light - 34, 0.48);
        const grad = ctx.createLinearGradient(points[0].x, points[0].y, points[2].x, points[2].y);
        grad.addColorStop(0, bright);
        grad.addColorStop(0.38, base);
        grad.addColorStop(0.78, dark);
        grad.addColorStop(1, cool);
        ctx.fillStyle = grad;
        ctx.fill();

        if (faceKey === '3,2,6,7' || faceKey === '0,1,2,3' || faceKey === '1,5,6,2') {
            ctx.save();
            loadoutFacePath(ctx, points);
            ctx.clip();
            const hx = points[0].x + (points[1].x - points[0].x) * 0.28;
            const hy = points[0].y + (points[1].y - points[0].y) * 0.26;
            const radius = Math.hypot(points[2].x - points[0].x, points[2].y - points[0].y) * 0.48;
            const highlight = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius);
            highlight.addColorStop(0, 'rgba(168, 140, 220, 0.16)');
            highlight.addColorStop(0.45, 'rgba(120, 78, 190, 0.07)');
            highlight.addColorStop(1, 'rgba(50, 24, 95, 0)');
            ctx.fillStyle = highlight;
            const minX = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
            const minY = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
            const maxX = Math.max(points[0].x, points[1].x, points[2].x, points[3].x);
            const maxY = Math.max(points[0].y, points[1].y, points[2].y, points[3].y);
            ctx.fillRect(minX - 2, minY - 2, maxX - minX + 4, maxY - minY + 4);
            ctx.restore();
        }
        return;
    }

    if (theme === 'theme-pinkcore') {
        const light = LOADOUT_FACE_LIGHT[faceKey] ?? -8;
        const base = adjustLoadoutHex(color, light);
        const grad = ctx.createLinearGradient(points[0].x, points[0].y, points[2].x, points[2].y);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.62)');
        grad.addColorStop(0.22, adjustLoadoutHex(color, light + 14));
        grad.addColorStop(0.58, base);
        grad.addColorStop(1, `rgba(${Math.min(255, r + 48)}, ${Math.min(255, g + 24)}, ${Math.min(255, b + 36)}, 0.92)`);
        ctx.fillStyle = grad;
        ctx.fill();

        if (faceKey === '3,2,6,7' || faceKey === '0,1,2,3' || faceKey === '1,5,6,2') {
            ctx.save();
            loadoutFacePath(ctx, points);
            ctx.clip();
            const glossY = points[0].y + (points[3].y - points[0].y) * 0.28;
            const gloss = ctx.createLinearGradient(points[0].x, points[0].y, points[0].x, glossY + 12);
            gloss.addColorStop(0, 'rgba(255, 255, 255, 0.48)');
            gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = gloss;
            ctx.fillRect(points[0].x - 2, points[0].y - 2, points[2].x - points[0].x + 4, points[3].y - points[0].y + 4);
            ctx.restore();
        }
        return;
    }

    const sr = Math.floor(r * shade);
    const sg = Math.floor(g * shade);
    const sb = Math.floor(b * shade);
    const sr2 = Math.floor(r * shade * 0.65);
    const sg2 = Math.floor(g * shade * 0.65);
    const sb2 = Math.floor(b * shade * 0.65);
    const grad = ctx.createLinearGradient(points[0].x, points[0].y, points[2].x, points[2].y);
    if (theme === 'theme-pixel') {
        grad.addColorStop(0, `rgb(${sr},${sg},${sb})`);
        grad.addColorStop(1, `rgb(${sr},${sg},${sb})`);
    } else {
        grad.addColorStop(0, `rgb(${sr},${sg},${sb})`);
        grad.addColorStop(1, `rgb(${sr2},${sg2},${sb2})`);
    }
    ctx.fillStyle = grad;
    ctx.fill();
}

function rotateLoadoutPoint(x, y, z, rx, ry, rz = 0) {
    const cosZ = Math.cos(rz);
    const sinZ = Math.sin(rz);
    let x0 = x * cosZ - y * sinZ;
    let y0 = x * sinZ + y * cosZ;
    const cosY = Math.cos(ry);
    const sinY = Math.sin(ry);
    const x1 = x0 * cosY + z * sinY;
    const z1 = -x0 * sinY + z * cosY;
    const cosX = Math.cos(rx);
    const sinX = Math.sin(rx);
    const y2 = y0 * cosX - z1 * sinX;
    const z2 = y0 * sinX + z1 * cosX;
    return { x: x1, y: y2, z: z2 };
}

function computeLoadoutCubeProjected(w, h, half, rx, ry, rz) {
    const focal = 880;
    const cx = w / 2;
    const cy = h / 2;
    const unitCorners = [
        { x: -1, y: -1, z: -1 }, { x: 1, y: -1, z: -1 }, { x: 1, y: 1, z: -1 }, { x: -1, y: 1, z: -1 },
        { x: -1, y: -1, z: 1 }, { x: 1, y: -1, z: 1 }, { x: 1, y: 1, z: 1 }, { x: -1, y: 1, z: 1 }
    ];
    return unitCorners.map((c) => {
        const rot = rotateLoadoutPoint(c.x * half, c.y * half, c.z * half, rx, ry, rz);
        return loadoutCubeProject(rot.x, rot.y, rot.z, cx, cy, focal);
    });
}

function loadoutCubeProject(x, y, z, cx, cy, focal) {
    const f = focal / (focal + z);
    return { x: cx + x * f, y: cy + y * f, z, f };
}

function drawLoadoutCubeFaceScanlines(ctx, points) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.clip();
    const minY = Math.min(...points.map((p) => p.y));
    const maxY = Math.max(...points.map((p) => p.y));
    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    for (let y = minY; y <= maxY; y += 3) {
        ctx.fillRect(minX - 2, y, (maxX - minX) + 4, 1);
    }
    ctx.restore();
}

function drawLoadoutTexturedFace(ctx, p0, p1, p2, p3, img) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (!img || w < 1 || h < 1) return;
    drawLoadoutImageQuad(ctx, img, p0, p1, p2, p3);
}

function loadoutConvexHull(points) {
    const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
}

function drawLoadoutRonkCubeOutline(ctx, pts) {
    const hull = loadoutConvexHull(pts.map((p) => ({ x: p.x, y: p.y })));
    if (hull.length < 3) return;

    ctx.save();
    ctx.beginPath();
    hull.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.98)';
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 16;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.95)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
}

function insetLoadoutQuad(points, amount = 0.12) {
    const cx = (points[0].x + points[1].x + points[2].x + points[3].x) * 0.25;
    const cy = (points[0].y + points[1].y + points[2].y + points[3].y) * 0.25;
    const scale = 1 - amount;
    return points.map((p) => ({
        x: cx + (p.x - cx) * scale,
        y: cy + (p.y - cy) * scale
    }));
}

function drawLoadoutImageTriangle(ctx, img, sx0, sy0, sx1, sy1, sx2, sy2, dx0, dy0, dx1, dy1, dx2, dy2) {
    const denom = (sx0 - sx2) * (sy1 - sy2) - (sx1 - sx2) * (sy0 - sy2);
    if (Math.abs(denom) < 0.001) return;

    const a = ((dx0 - dx2) * (sy1 - sy2) - (dx1 - dx2) * (sy0 - sy2)) / denom;
    const b = ((dy0 - dy2) * (sy1 - sy2) - (dy1 - dy2) * (sy0 - sy2)) / denom;
    const c = ((dx0 - dx2) * (sx1 - sx2) - (dx1 - dx2) * (sx0 - sx2)) / denom;
    const d = ((dy0 - dy2) * (sx1 - sx2) - (dy1 - dy2) * (sx0 - sx2)) / denom;
    const e = dx2 - a * sx2 - c * sy2;
    const f = dy2 - b * sx2 - d * sy2;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dx0, dy0);
    ctx.lineTo(dx1, dy1);
    ctx.lineTo(dx2, dy2);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
}

/** Maps a rectangular label onto a face quad (p0=bl, p1=br, p2=tr, p3=tl). */
function drawLoadoutImageQuad(ctx, img, p0, p1, p2, p3) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return;
    drawLoadoutImageTriangle(ctx, img, 0, h, w, h, w, 0, p0.x, p0.y, p1.x, p1.y, p2.x, p2.y);
    drawLoadoutImageTriangle(ctx, img, 0, h, w, 0, 0, 0, p0.x, p0.y, p2.x, p2.y, p3.x, p3.y);
}

function getLoadoutUploadLabel(faceSize) {
    const size = Math.max(72, Math.min(220, Math.round(faceSize)));
    if (!loadoutUploadLabelCache || loadoutUploadLabelSize !== size) {
        const canvas = document.createElement('canvas');
        const w = Math.round(size * 1.35);
        const h = size;
        canvas.width = w;
        canvas.height = h;
        const c = canvas.getContext('2d');
        c.clearRect(0, 0, w, h);
        c.fillStyle = 'rgba(255, 255, 255, 0.96)';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = `700 ${size * 0.34}px Orbitron, Rajdhani, sans-serif`;
        c.fillText('+', w * 0.5, h * 0.42);
        c.font = `600 ${size * 0.12}px Orbitron, Rajdhani, sans-serif`;
        c.fillText('UPLOAD', w * 0.5, h * 0.68);
        loadoutUploadLabelCache = canvas;
        loadoutUploadLabelSize = size;
    }
    return loadoutUploadLabelCache;
}

function drawLoadoutUploadOnFace(ctx, points) {
    const edgeW = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    const edgeH = Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y);
    const faceSize = Math.min(edgeW, edgeH);
    if (faceSize < 24) return;

    const inset = insetLoadoutQuad(points, 0.14);
    const label = getLoadoutUploadLabel(faceSize * 0.78);
    drawLoadoutImageQuad(ctx, label, inset[0], inset[1], inset[2], inset[3]);
}

function strokeLoadoutCubeFace(ctx, points, theme, color) {
    loadoutFacePath(ctx, points);

    if (theme === 'theme-ronk') {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 12;
        ctx.shadowColor = 'rgba(255, 255, 255, 0.88)';
        ctx.stroke();
        ctx.shadowBlur = 0;
        return;
    }

    if (theme === 'theme-pixel') {
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;
        ctx.shadowBlur = 0;
        ctx.stroke();
        return;
    }

    if (theme === 'theme-hacker') {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.shadowBlur = 15;
        ctx.shadowColor = color;
        ctx.stroke();
        ctx.shadowBlur = 0;
        return;
    }

    if (theme === 'theme-white-black') {
        ctx.strokeStyle = 'rgba(150, 118, 210, 0.34)';
        ctx.lineWidth = 1.25;
        ctx.shadowBlur = 4;
        ctx.shadowColor = 'rgba(95, 52, 160, 0.28)';
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(88, 52, 145, 0.2)';
        ctx.lineWidth = 1;
        ctx.stroke();
        return;
    }

    if (theme === 'theme-pinkcore') {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)';
        ctx.lineWidth = 1.8;
        ctx.shadowBlur = 18;
        ctx.shadowColor = 'rgba(255, 105, 180, 0.75)';
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255, 182, 193, 0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
        return;
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 0;
    ctx.stroke();
}

function hasLoadoutCustomImage() {
    if (!playerImage) return false;
    const w = playerImage.naturalWidth || playerImage.width || 0;
    const h = playerImage.naturalHeight || playerImage.height || 0;
    return w > 0 && h > 0;
}

function drawLoadoutCubeFrame(exportOpts) {
    const opts = exportOpts && typeof exportOpts === 'object' ? exportOpts : null;
    const ctx = opts?.ctx || loadoutCubeCtx;
    const canvas = opts?.canvas || loadoutCubeCanvas;
    if (!ctx || !canvas) return;

    const dpr = opts?.dpr ?? Math.min(window.devicePixelRatio || 1, 2);
    // Prefer CSS box size so buffer/dpr never disagree (that skewed the cube vs arrows)
    const cssW = opts?.w ?? (parseFloat(canvas.style.width) || canvas.clientWidth || 0);
    const cssH = opts?.h ?? (parseFloat(canvas.style.height) || canvas.clientHeight || 0);
    const w = cssW > 0 ? cssW : (canvas.width / dpr);
    const h = cssH > 0 ? cssH : (canvas.height / dpr);
    const half = opts?.half ?? loadoutCubeHalf;
    const ry = opts?.ry ?? loadoutCubeRy;
    const rx = opts?.rx ?? LOADOUT_CUBE_RX;
    const rz = opts?.rz ?? LOADOUT_CUBE_RZ;
    const skipUpload = opts?.skipUpload === true;
    const grayExport = opts?.grayExport === true;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const theme = themes[currentThemeIndex];
    const color = opts?.color ?? neonColors[currentColorIndex];
    const colorIndexForCustom = opts?.colorIndex != null
        ? opts.colorIndex
        : (opts?.color ? -1 : currentColorIndex);
    const isCustom = colorIndexForCustom === neonColors.length - 1;
    const customImg = opts?.customImage
        || (isCustom && hasLoadoutCustomImage() ? playerImage : null);
    const isEmptyCustomSlot = isCustom && !customImg;
    const { r, g, b } = parseLoadoutHex(color);

    const pts = computeLoadoutCubeProjected(w, h, half, rx, ry, rz);

    const faces = [
        { idx: [0, 1, 2, 3], shade: 1.0 },
        { idx: [5, 4, 7, 6], shade: 0.72 },
        { idx: [4, 0, 3, 7], shade: 0.84 },
        { idx: [1, 5, 6, 2], shade: 0.9 },
        { idx: [3, 2, 6, 7], shade: 0.76 },
        { idx: [4, 5, 1, 0], shade: 0.64 }
    ];

    faces.forEach((f) => {
        f.z = (pts[f.idx[0]].z + pts[f.idx[1]].z + pts[f.idx[2]].z + pts[f.idx[3]].z) / 4;
    });
    faces.sort((a, b) => b.z - a.z);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    faces.forEach((f) => {
        const p = f.idx.map((i) => pts[i]);
        const faceKey = f.idx.join(',');
        const isModelFrontFace = f.idx[0] === 0 && f.idx[1] === 1 && f.idx[2] === 2 && f.idx[3] === 3;

        if (grayExport) {
            fillLoadoutGrayCubeFace(ctx, p, f.shade, color);
        } else {
            fillLoadoutCubeFace(ctx, p, theme, color, faceKey, { r, g, b }, f.shade);
        }

        if (customImg && isModelFrontFace) {
            drawLoadoutTexturedFace(ctx, p[0], p[1], p[2], p[3], customImg);
        }

        if (theme === 'theme-ronk') {
            drawLoadoutCubeFaceScanlines(ctx, p);
        }

        if (!skipUpload && isEmptyCustomSlot && isModelFrontFace) {
            drawLoadoutUploadOnFace(ctx, p);
        }

        strokeLoadoutCubeFace(ctx, p, theme, color);
    });

    if (theme === 'theme-ronk') {
        drawLoadoutRonkCubeOutline(ctx, pts);
    }

    ctx.restore();
}

function syncLoadoutCube3D() {
    const overlay = document.getElementById('loadout-upload-overlay');
    if (overlay) overlay.classList.add('hidden');

    if (isLoadoutPageVisible()) {
        if (!loadoutCubeAnimId) startLoadoutCubeRender();
        else drawLoadoutCubeFrame();
    }
}

function syncCubePreviewElement(el, overlayEl) {
    if (!el) return;
    const color = neonColors[currentColorIndex];
    const isCustomSlot = currentColorIndex === neonColors.length - 1;
    el.style.backgroundColor = isCustomSlot && !playerImage ? '#888888' : color;
    el.style.color = color;
    if (isCustomSlot) {
        if (overlayEl) overlayEl.classList.toggle('hidden', !!playerImage);
        if (playerImage) {
            const previewUrl = playerImagePreviewUrl || playerImage.src || null;
            el.style.backgroundImage = previewUrl ? `url(${previewUrl})` : 'none';
        } else {
            el.style.backgroundImage = 'none';
        }
    } else {
        if (overlayEl) overlayEl.classList.add('hidden');
        el.style.backgroundImage = 'none';
    }
}

function cycleCubeColor(delta) {
    currentColorIndex = (currentColorIndex + delta + neonColors.length) % neonColors.length;
    localStorage.setItem('ronk_colorIndex', currentColorIndex);
    updateColorPreview();
}

function resizePlayerImageToCanvas(source) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, size, size);
    return canvas;
}

function applyPlayerImageUpload(canvasResizer) {
    let dataUrl = null;
    try {
        // Prefer PNG for peer sync (JPEG-only path dropped transparent / sharp cubes)
        dataUrl = canvasResizer.toDataURL('image/png');
        if (!dataUrl || dataUrl.length > 850000) {
            dataUrl = canvasResizer.toDataURL('image/jpeg', 0.82);
        }
    } catch (_) {
        dataUrl = null;
    }
    if (!dataUrl || !(dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/png'))) {
        notifyContentSafetyBlock(tUi('SAFE_ENCODE_FAIL', 'Could not sanitize image.'));
        return;
    }

    const img = new Image();
    img.src = dataUrl;
    playerImage = img;
    playerImagePreviewUrl = dataUrl;
    currentColorIndex = neonColors.length - 1;
    localStorage.setItem('ronk_colorIndex', currentColorIndex);
    try { localStorage.setItem('ronk_playerImage', dataUrl); } catch (_) { /* ignore quota */ }
    updateColorPreview();
    syncLoadoutCube3D();

    if (typeof syncSettings === 'function') syncSettings();
    if (typeof isOnline !== 'undefined' && isOnline && typeof onlineRole !== 'undefined' && onlineRole === 'host') {
        syncSettings();
    }
}

function getUiLang() {
    return localStorage.getItem('ronk_language') || 'en';
}

function tUi(key, fallback) {
    const t = translations[getUiLang()] || translations['en'];
    return (t && t[key]) || fallback || key;
}

function translateContentSafetyResult(result) {
    if (!result || result.ok) return '';
    const map = {
        BAD_SIGNATURE: 'SAFE_BAD_SIGNATURE',
        MALWARE_PATTERN: 'SAFE_MALWARE',
        MALWARE_DATA: 'SAFE_MALWARE_DATA',
        FORBIDDEN_FORMAT: 'SAFE_FORBIDDEN_FORMAT',
        READ_FAIL: 'SAFE_READ_FAIL',
        DECODE_FAIL: 'SAFE_DECODE_FAIL',
        TOO_SMALL: 'SAFE_TOO_SMALL',
        DIMENSIONS: 'SAFE_DIMENSIONS',
        AGE_RESTRICTED: 'SAFE_AGE_RESTRICTED',
        AGE_FAIL: 'SAFE_AGE_FAIL',
        PIXEL_FAIL: 'SAFE_PIXEL_FAIL',
        ENCODE_FAIL: 'SAFE_ENCODE_FAIL',
        CANVAS_FAIL: 'SAFE_PROCESS_FAIL',
        TOO_LARGE: 'SAFE_DIMENSIONS',
        NO_DATA: 'SAFE_PEER_BLOCKED',
        BAD_DATA_URL: 'SAFE_BAD_SIGNATURE',
        BAD_TYPE: 'SAFE_FORBIDDEN_FORMAT',
        SHARED_AGE: 'SAFE_SHARED_AGE',
        SHARED_FAIL: 'SAFE_SHARED_FAIL',
        SHARED_PIXEL: 'SAFE_SHARED_PIXEL',
        SHARED_ENCODE: 'SAFE_SHARED_ENCODE'
    };
    const key = map[result.reason];
    if (key) return tUi(key, result.message);
    return result.message || tUi('SAFE_UPLOAD_BLOCKED', 'Upload blocked by content safety.');
}

function notifyContentSafetyBlock(message) {
    const msg = message || tUi('SAFE_UPLOAD_BLOCKED', 'Upload blocked by content safety.');
    if (typeof showAntiCheatToast === 'function') {
        showAntiCheatToast(msg, true);
    } else {
        alert(msg);
    }
}

function clearUnsafePlayerImage(reason) {
    playerImage = null;
    playerImagePreviewUrl = null;
    try { localStorage.removeItem('ronk_playerImage'); } catch (_) { /* ignore */ }
    if (typeof updateColorPreview === 'function') updateColorPreview();
    if (typeof syncLoadoutCube3D === 'function') syncLoadoutCube3D();
    if (reason) notifyContentSafetyBlock(reason);
}

async function applySafePlayerImageDataUrl(dataUrl) {
    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
    });
    const canvasResizer = resizePlayerImageToCanvas(img);
    applyPlayerImageUpload(canvasResizer);
}

function handleCubeImageFile(file) {
    if (!file) return;
    if (!window.RonkContentSafety || typeof RonkContentSafety.sanitizeUploadFile !== 'function') {
        notifyContentSafetyBlock(tUi('SAFE_SYSTEM_UNAVAILABLE', 'Content safety system unavailable — upload blocked.'));
        return;
    }

    RonkContentSafety.sanitizeUploadFile(file)
        .then((result) => {
            if (!result || !result.ok) {
                notifyContentSafetyBlock(translateContentSafetyResult(result));
                return;
            }
            return applySafePlayerImageDataUrl(result.dataUrl);
        })
        .catch(() => {
            notifyContentSafetyBlock(tUi('SAFE_PROCESS_FAIL', 'Could not process that image safely.'));
        });
}

async function loadPeerCustomImage(dataUrl, assignFn) {
    if (!dataUrl) {
        assignFn(null);
        return;
    }
    if (!window.RonkContentSafety || typeof RonkContentSafety.sanitizeDataUrl !== 'function') {
        assignFn(null);
        notifyContentSafetyBlock(tUi('SAFE_PEER_OFFLINE', 'Blocked unsafe shared image (safety offline).'));
        return;
    }
    try {
        const result = await RonkContentSafety.sanitizeDataUrl(dataUrl);
        if (!result || !result.ok) {
            assignFn(null);
            notifyContentSafetyBlock(translateContentSafetyResult(result));
            return;
        }
        const img = new Image();
        img.onload = () => { assignFn(img); updateWaitingRoomPreviews(); };
        img.onerror = () => assignFn(null);
        img.src = result.dataUrl;
    } catch (_) {
        assignFn(null);
        notifyContentSafetyBlock(tUi('SAFE_PEER_BLOCKED', 'Blocked unsafe shared image.'));
    }
}

function updateLoadoutSummary() {
    const savedLanguage = localStorage.getItem('ronk_language') || 'en';
    const t = translations[savedLanguage] || translations['en'];

    const fillSkill = (el, skillId) => {
        if (!el) return;
        if (!skillId || !isSkillUnlocked(skillId)) {
            el.textContent = t['SKILL_LOCKED'] || (skillId ? 'LOCKED' : '—');
            return;
        }
        const skill = SKILL_DATA.find((s) => s.id === skillId);
        el.textContent = skill ? (t[skill.name] || skill.name) : '—';
    };
    const fillJokers = (el, jokersIn) => {
        if (!el) return;
        let jokers = (Array.isArray(jokersIn) ? jokersIn : []).filter((id) => isJokerUnlocked(id));
        if (jokers.length === 0) {
            el.textContent = t['None'] || 'NONE';
            return;
        }
        el.textContent = jokers.map((id) => {
            const joker = JOKER_DATA.find((j) => j.id === id);
            return joker ? (t[joker.name] || joker.name) : id;
        }).join(' · ');
    };

    const p1Skill = (typeof currentSkillIndex !== 'undefined' && SKILL_DATA[currentSkillIndex]
        && isSkillUnlocked(SKILL_DATA[currentSkillIndex].id))
        ? SKILL_DATA[currentSkillIndex].id
        : localStorage.getItem('ronk_selectedSkill');
    const p1Jokers = Array.isArray(p1SelectedJoker) ? p1SelectedJoker : [];

    fillSkill(document.getElementById('loadout-skill-summary'), p1Skill);
    fillJokers(document.getElementById('loadout-joker-summary'), p1Jokers);
    fillSkill(document.getElementById('loadout-skill-summary-p1'), p1Skill);
    fillJokers(document.getElementById('loadout-joker-summary-p1'), p1Jokers);

    const p2Skill = localStorage.getItem('ronk_p2_selectedSkill');
    fillSkill(document.getElementById('loadout-skill-summary-p2'), p2Skill);
    fillJokers(document.getElementById('loadout-joker-summary-p2'), p2LoadoutJokers);
}

function initDualLoadoutSelections() {
    try {
        const raw = JSON.parse(localStorage.getItem('ronk_p2_selectedJoker') || '[]');
        p2LoadoutJokers = (Array.isArray(raw) ? raw : []).filter((id) => isJokerUnlocked(id));
    } catch (_) {
        p2LoadoutJokers = [];
    }
    localStorage.setItem('ronk_p2_selectedJoker', JSON.stringify(p2LoadoutJokers));

    let p2Skill = localStorage.getItem('ronk_p2_selectedSkill');
    if (p2Skill && !isSkillUnlocked(p2Skill)) p2Skill = null;
    if (!p2Skill) {
        const unlocked = getUnlockedSkillIndices();
        if (unlocked.length) {
            p2Skill = SKILL_DATA[unlocked[0]]?.id || null;
            if (p2Skill) localStorage.setItem('ronk_p2_selectedSkill', p2Skill);
        }
    }

    if (!Number.isFinite(p2ColorIndex) || p2ColorIndex < 0 || p2ColorIndex >= neonColors.length) {
        p2ColorIndex = Math.min(1, neonColors.length - 1);
    }
    // Prefer a different color from P1 when both on solid colors
    if (p2ColorIndex === currentColorIndex && currentColorIndex < neonColors.length - 1) {
        p2ColorIndex = (currentColorIndex + 1) % Math.max(1, neonColors.length - 1);
        localStorage.setItem('ronk_p2_colorIndex', String(p2ColorIndex));
    }
    updateLoadoutSummary();
    syncDualSlotActiveClass();
}

function syncDualSlotActiveClass() {
    const p1 = document.getElementById('loadout-slot-p1');
    const p2 = document.getElementById('loadout-slot-p2');
    if (p1) p1.classList.toggle('is-active-slot', loadoutEditSlot === 1);
    if (p2) p2.classList.toggle('is-active-slot', loadoutEditSlot === 2);
}

function openLoadoutEditorForSlot(slot, kind) {
    loadoutEditSlot = slot === 2 ? 2 : 1;
    syncDualSlotActiveClass();
    if (kind === 'skill') {
        if (loadoutEditSlot === 2) {
            const sid = localStorage.getItem('ronk_p2_selectedSkill');
            const idx = SKILL_DATA.findIndex((s) => s.id === sid);
            if (idx !== -1) currentSkillIndex = idx;
        }
        openLoadoutPanel(loadoutSkillPanel);
    } else {
        openLoadoutPanel(loadoutJokerPanel);
    }
}

function openLoadoutPanel(panel) {
    if (!panel || !loadoutPage) return;
    if (loadoutSkillPanel && loadoutSkillPanel !== panel) loadoutSkillPanel.classList.add('hidden');
    if (loadoutJokerPanel && loadoutJokerPanel !== panel) loadoutJokerPanel.classList.add('hidden');
    panel.classList.remove('hidden');
    panel.style.display = 'flex';
    panel.style.pointerEvents = 'auto';
    loadoutPage.classList.add('loadout-picker-open');
    document.body.classList.add('loadout-picker-open');
    if (panel === loadoutSkillPanel) {
        updateSkillPreview();
    } else if (panel === loadoutJokerPanel) {
        renderJokersGrid();
    }
    setActiveNavigation('loadout', {
        pickerOpen: true,
        skillOpen: panel === loadoutSkillPanel,
        jokerOpen: panel === loadoutJokerPanel,
    });
}

function closeLoadoutPanel(panel) {
    if (!panel) return;
    panel.classList.add('hidden');
    panel.style.display = 'none';
    const skillOpen = loadoutSkillPanel && !loadoutSkillPanel.classList.contains('hidden');
    const jokerOpen = loadoutJokerPanel && !loadoutJokerPanel.classList.contains('hidden');
    if (!skillOpen && !jokerOpen) {
        if (loadoutPage) loadoutPage.classList.remove('loadout-picker-open');
        document.body.classList.remove('loadout-picker-open');
    }
    setActiveNavigation('loadout', {
        pickerOpen: skillOpen || jokerOpen,
        skillOpen,
        jokerOpen,
    });
    updateLoadoutSummary();
}

function initLoadoutSelections() {
    // Always reload the PLAYER's saved kit from disk — never trust in-memory match/AI state
    restorePlayerPersistentLoadout();
    sanitizeStoredLoadout();
    p1SelectedJoker = (Array.isArray(p1SelectedJoker) ? p1SelectedJoker : []).filter(id => isJokerUnlocked(id));
    localStorage.setItem('ronk_selectedJoker', JSON.stringify(p1SelectedJoker));

    const savedSkill = localStorage.getItem('ronk_selectedSkill');
    if (savedSkill && isSkillUnlocked(savedSkill)) {
        const idx = SKILL_DATA.findIndex(s => s.id === savedSkill);
        if (idx !== -1) currentSkillIndex = idx;
    } else if (shouldEnforceUnlockLocks()) {
        const unlocked = getUnlockedSkillIndices();
        currentSkillIndex = unlocked.length ? unlocked[0] : 0;
    }
    updateSkillPreview();
    renderJokersGrid();
    updateLoadoutSummary();
    updateColorPreview();
}

/** Reload skill/jokers the human actually equipped (ignore spectate/AI match kits). */
function restorePlayerPersistentLoadout() {
    let jokers = [];
    try {
        jokers = JSON.parse(localStorage.getItem('ronk_selectedJoker') || '[]');
    } catch (_) {
        jokers = [];
    }
    if (!Array.isArray(jokers)) jokers = jokers ? [jokers] : [];
    jokers = normalizeJokerIds(jokers).slice(0, 2);
    p1SelectedJoker = jokers;

    const savedSkill = localStorage.getItem('ronk_selectedSkill');
    if (savedSkill) {
        const idx = SKILL_DATA.findIndex((s) => s.id === savedSkill);
        if (idx !== -1) currentSkillIndex = idx;
        if (p1 && !isSpectateMode) p1.selectedSkill = savedSkill;
    }
}

function syncLoadoutP2ToggleUI() {
    /* unused — dual loadout replaces the old toggle */
}

function updatePauseControlsHint() {
    const hint = document.getElementById('pause-controls-hint');
    if (hint) {
        hint.hidden = true;
        hint.textContent = '';
    }
}

function setLoadoutPageMode(mode) {
    loadoutPageMode = mode === 'dual' ? 'dual' : 'single';
    if (loadoutPage) {
        loadoutPage.classList.toggle('loadout-dual-mode', loadoutPageMode === 'dual');
    }
    const single = document.getElementById('loadout-single');
    const dual = document.getElementById('loadout-dual');
    if (single) single.classList.toggle('hidden', loadoutPageMode === 'dual');
    if (dual) dual.classList.toggle('hidden', loadoutPageMode !== 'dual');
}

function showLoadoutPage(opts = {}) {
    if (isInActiveGameView()) return;
    const mode = opts.mode === 'dual' ? 'dual' : 'single';
    if (opts.path) pendingPlayPath = opts.path;
    returnToLobbyState({ stopLoop: true });
    gameState = 'LOBBY';
    gameHasStarted = false;
    forceHideMenu();
    if (loadoutSkillPanel) loadoutSkillPanel.classList.add('hidden');
    if (loadoutJokerPanel) loadoutJokerPanel.classList.add('hidden');
    if (loadoutPage) loadoutPage.classList.remove('loadout-picker-open');
    document.body.classList.remove('loadout-picker-open');
    loadoutEditSlot = 1;
    setLoadoutPageMode(mode);
    initLoadoutSelections();
    if (mode === 'dual') initDualLoadoutSelections();
    showOverlayPanel(loadoutPage, 'block');
    setActiveNavigation('loadout', { pickerOpen: false, skillOpen: false, jokerOpen: false });
    if (introFinished) setThemeBtnVisible(true);
    syncThemeBackdrop();
    requestAnimationFrame(() => {
        try {
            const startEl = document.getElementById(
                mode === 'dual' ? 'loadout-dual-start-btn' : 'loadout-start-btn'
            );
            if (startEl) {
                startEl.blur();
                startEl.classList.remove('ronk-pad-focus');
            }
            loadoutPage?.querySelectorAll?.('.ronk-pad-focus').forEach((el) => el.classList.remove('ronk-pad-focus'));
            if (document.activeElement && loadoutPage?.contains?.(document.activeElement)) {
                try { document.activeElement.blur(); } catch (_) {}
            }
        } catch (_) { /* ignore */ }
        startLoadoutCubeRender();
    });
}

function continueFromLoadout() {
    hideOverlayPanel(loadoutPage);
    stopLoadoutCubeRender();
    const path = pendingPlayPath || 'solo';

    if (path === 'local-pvp') {
        launchGameMode({ spectate: false, multiplayer: true });
        return;
    }

    if (path === 'online-matchmake') {
        if (menu) {
            menu.classList.remove('hidden');
            menu.style.display = 'flex';
            menu.style.visibility = 'visible';
            menu.style.opacity = '1';
            menu.style.pointerEvents = 'auto';
        }
        openOnlinePanel(onlineMatchmakePanel, 'matchmake');
        return;
    }

    if (path === 'online-friend') {
        if (menu) {
            menu.classList.remove('hidden');
            menu.style.display = 'flex';
            menu.style.visibility = 'visible';
            menu.style.opacity = '1';
            menu.style.pointerEvents = 'auto';
        }
        openOnlinePanel(onlineFriendsPanel, 'friend');
        return;
    }

    // solo → bot difficulty
    if (menu) {
        menu.classList.remove('hidden');
        menu.style.display = 'flex';
        menu.style.visibility = 'visible';
        menu.style.opacity = '1';
        menu.style.pointerEvents = 'auto';
    }
    setActiveNavigation('menu', { menuTier: 'bot-difficulty-tier' });
    showTier('bot-difficulty-tier');
    updateBotDifficultyUI();
}

function getLoadoutBackTarget() {
    if (loadoutPageMode === 'dual' || pendingPlayPath === 'local-pvp') return 'multiplayer-menu-tier';
    if (pendingPlayPath === 'online-matchmake' || pendingPlayPath === 'online-friend') {
        return 'multiplayer-menu-tier';
    }
    return 'start-mode-tier';
}

function isAndroidPlatform() {
    return /Android/i.test(navigator.userAgent) ||
        (typeof window.Capacitor !== 'undefined' && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android');
}

function exitGame() {
    if (typeof SFX !== 'undefined') SFX.play('button');

    try {
        const appPlugin = window.Capacitor?.Plugins?.App;
        if (appPlugin?.exitApp) {
            appPlugin.exitApp();
            return;
        }
    } catch (_) { /* ignore */ }

    window.close();
}

// --- GAMEPAD INPUT (Steam Input / Xbox / PlayStation / generic) ---
const GAMEPAD_STICK_DEADZONE = 0.38;
const GAMEPAD_MENU_STICK_DEADZONE = 0.55;
const GAMEPAD_BTN = { dash: 0, charge: 1, skill: 2, pause: 9, confirm: 0, back: 1, start: 9, select: 8 };
const GAMEPAD_DPAD = { up: 12, down: 13, left: 14, right: 15 };
/** Button edge state keyed by stable gamepad.index (not Gamepad object identity). */
const gamepadButtonPrevByIndex = new Map();
const gamepadLastDirByIndex = new Map();
const gamepadMenuNavAtByIndex = new Map();
const GAMEPAD_MENU_NAV_MS = 180;
/**
 * Stable pad → player slots. Values are Gamepad.index (or null).
 * Never reassign a remaining pad to P1 when P1's pad disconnects mid-match.
 * playerPadId keeps Gamepad.id so reconnect / OS re-index can restore the same slot.
 */
const playerPadIndex = { p1: null, p2: null };
const playerPadId = { p1: null, p2: null };
/** While true during a live match, empty slots are not filled by the other player's pad. */
let gamepadRebindLocked = false;
let usingGamepadInput = false;
let lastMouseActivityAt = 0;
let lastGamepadMenuNavPadIndex = null;

function getAllGamepadSlots() {
    if (!navigator.getGamepads) return [];
    return [...navigator.getGamepads()];
}

function getConnectedGamepads() {
    return getAllGamepadSlots().filter((gp) => gp && gp.connected);
}

function getGamepadByIndex(index) {
    if (index == null || index < 0 || !navigator.getGamepads) return null;
    const gp = navigator.getGamepads()[index];
    return gp && gp.connected ? gp : null;
}

function isLocalHumanVsHuman() {
    return !!(isMultiplayer && !isOnline && p1 && !p1.isAI && p2 && !p2.isAI);
}

function setUsingGamepadInput(active) {
    if (usingGamepadInput === !!active) return;
    usingGamepadInput = !!active;
    document.body.classList.toggle('using-gamepad', usingGamepadInput);
    if (typeof updateTutorialUI === 'function' && typeof shouldShowTutorialOverlay === 'function' && shouldShowTutorialOverlay()) {
        try { updateTutorialUI(tutorialStep); } catch (_) { /* ignore */ }
    }
    try { updateActionPromptLabels(); } catch (_) { /* ignore */ }
}

function markMouseActivity() {
    lastMouseActivityAt = performance.now();
    if (usingGamepadInput) setUsingGamepadInput(false);
}

function markGamepadActivity() {
    setUsingGamepadInput(true);
}

function stickToCardinalDirection(x, y, deadzone = GAMEPAD_STICK_DEADZONE) {
    const ax = Math.abs(x) > deadzone ? x : 0;
    const ay = Math.abs(y) > deadzone ? y : 0;
    if (!ax && !ay) return null;
    if (Math.abs(ax) >= Math.abs(ay)) return ax < 0 ? 'left' : 'right';
    return ay < 0 ? 'up' : 'down';
}

function getGamepadCardinalDirection(gp, deadzone = GAMEPAD_STICK_DEADZONE) {
    const dir = stickToCardinalDirection(gp.axes[0] || 0, gp.axes[1] || 0, deadzone);
    if (dir) return dir;
    const btns = gp.buttons || [];
    if (btns[GAMEPAD_DPAD.up]?.pressed) return 'up';
    if (btns[GAMEPAD_DPAD.down]?.pressed) return 'down';
    if (btns[GAMEPAD_DPAD.left]?.pressed) return 'left';
    if (btns[GAMEPAD_DPAD.right]?.pressed) return 'right';
    return null;
}

function wasGamepadButtonJustPressed(gp, buttonIndex) {
    if (!gp) return false;
    const pressed = !!(gp.buttons[buttonIndex]?.pressed);
    let prev = gamepadButtonPrevByIndex.get(gp.index);
    if (!prev) {
        prev = {};
        gamepadButtonPrevByIndex.set(gp.index, prev);
    }
    const just = pressed && !prev[buttonIndex];
    prev[buttonIndex] = pressed;
    return just;
}

function clearGamepadEdgeState(index) {
    if (index == null) return;
    gamepadButtonPrevByIndex.delete(index);
    gamepadLastDirByIndex.delete(index);
    gamepadMenuNavAtByIndex.delete(index);
}

function clearPlayerPadSlot(slot, { keepId = false } = {}) {
    playerPadIndex[slot] = null;
    if (!keepId) playerPadId[slot] = null;
}

function bindPadToPlayerSlot(slot, gp) {
    if (!gp || (slot !== 'p1' && slot !== 'p2')) return;
    playerPadIndex[slot] = gp.index;
    playerPadId[slot] = gp.id || null;
}

function resetGamepadPlayerSlots() {
    clearPlayerPadSlot('p1');
    clearPlayerPadSlot('p2');
    gamepadRebindLocked = false;
}

function rematchPadByStoredId(gp) {
    if (!gp || !gp.id) return false;
    if (playerPadId.p1 === gp.id && playerPadIndex.p1 == null
        && playerPadIndex.p2 !== gp.index) {
        bindPadToPlayerSlot('p1', gp);
        return true;
    }
    if (playerPadId.p2 === gp.id && playerPadIndex.p2 == null
        && playerPadIndex.p1 !== gp.index) {
        bindPadToPlayerSlot('p2', gp);
        return true;
    }
    return false;
}

/** Assign free pads to empty player slots without stealing another player's binding. */
function assignGamepadToFreeSlot(gp) {
    if (!gp || !gp.connected) return;
    const idx = gp.index;
    if (playerPadIndex.p1 === idx || playerPadIndex.p2 === idx) return;

    // Prefer historical owner when OS re-enumerates indices after a disconnect
    if (rematchPadByStoredId(gp)) return;

    // Never hand P2's physical pad to P1 while P2's slot still claims that id
    if (playerPadId.p2 && gp.id === playerPadId.p2) {
        if (isLocalHumanVsHuman() && playerPadIndex.p2 == null) {
            bindPadToPlayerSlot('p2', gp);
        }
        return;
    }
    if (playerPadId.p1 && gp.id === playerPadId.p1) {
        if (playerPadIndex.p1 == null) bindPadToPlayerSlot('p1', gp);
        return;
    }

    if (playerPadIndex.p1 == null) {
        bindPadToPlayerSlot('p1', gp);
        return;
    }
    if (isLocalHumanVsHuman() && playerPadIndex.p2 == null && playerPadIndex.p1 !== idx) {
        bindPadToPlayerSlot('p2', gp);
    }
}

/** Reconcile slots with currently connected pads. Does NOT rematch a pad into another player's slot. */
function syncGamepadPlayerBindings({ allowAssign = true } = {}) {
    if (playerPadIndex.p1 != null && !getGamepadByIndex(playerPadIndex.p1)) {
        clearPlayerPadSlot('p1', { keepId: true });
    }
    if (playerPadIndex.p2 != null && !getGamepadByIndex(playerPadIndex.p2)) {
        clearPlayerPadSlot('p2', { keepId: true });
    }

    const pads = getConnectedGamepads().sort((a, b) => a.index - b.index);

    // Always try id rematch first (handles reconnect + index reshuffle)
    for (const gp of pads) rematchPadByStoredId(gp);

    // Mid-match after a disconnect: do not promote the remaining pad into the empty slot
    if (gamepadRebindLocked && typeof canPauseGameplay === 'function' && canPauseGameplay()) {
        return;
    }

    if (!allowAssign) return;

    for (const gp of pads) assignGamepadToFreeSlot(gp);

    // Local PvP: if P2 still unbound and an unused pad exists, claim it
    if (isLocalHumanVsHuman() && playerPadIndex.p2 == null) {
        const unused = pads.find((gp) =>
            gp.index !== playerPadIndex.p1
            && gp.id !== playerPadId.p1
        );
        if (unused) bindPadToPlayerSlot('p2', unused);
    }
}

function pauseForGamepadDisconnect(disconnectedIndex) {
    if (!canPauseGameplay()) return;
    if (!isPaused) {
        setGamePaused(true);
        SFX.play?.('button');
    }
    console.log('[Gamepad] Disconnected pad index', disconnectedIndex, '— paused; bindings kept per-player');
}

function handleGamepadConnected(e) {
    const gp = e.gamepad;
    if (!gp) return;
    console.log('[Gamepad] Connected:', gp.id || 'controller', 'index', gp.index);
    markGamepadActivity();
    if (!rematchPadByStoredId(gp)) {
        if (!(gamepadRebindLocked && canPauseGameplay())) {
            assignGamepadToFreeSlot(gp);
        }
    }
    if (gamepadRebindLocked && playerPadIndex.p1 != null
        && (!isLocalHumanVsHuman() || playerPadIndex.p2 != null || !playerPadId.p2)) {
        gamepadRebindLocked = false;
    }
    syncGamepadPlayerBindings({ allowAssign: !(gamepadRebindLocked && canPauseGameplay()) });
}

function handleGamepadDisconnected(e) {
    const idx = e.gamepad?.index;
    if (idx == null) return;
    clearGamepadEdgeState(idx);

    const wasP1 = playerPadIndex.p1 === idx;
    const wasP2 = playerPadIndex.p2 === idx;
    if (wasP1) clearPlayerPadSlot('p1', { keepId: true });
    if (wasP2) clearPlayerPadSlot('p2', { keepId: true });

    // Critical Steam fix: do NOT rebind the remaining pad to P1 mid-match.
    // Lock auto-assign so OS re-index of pad 2 cannot fill P1.
    if (canPauseGameplay() && (wasP1 || wasP2)) {
        gamepadRebindLocked = true;
    }
    pauseForGamepadDisconnect(idx);
    syncGamepadPlayerBindings({ allowAssign: false });
}

function controlsKeyForDirection(player, direction) {
    return (player.controls && player.controls[direction]) || direction;
}

let _ronkControlsParsed = null;
function getRonkControlsParsed() {
    if (!_ronkControlsParsed) {
        try {
            _ronkControlsParsed = JSON.parse(localStorage.getItem('ronk_controls') || '{}');
        } catch (_) {
            _ronkControlsParsed = {};
        }
    }
    return _ronkControlsParsed;
}
function bustRonkControlsCache() { _ronkControlsParsed = null; }

function directionLabelForKey(player, key) {
    if (!player?.controls || !key) return null;
    const c = player.controls;
    const k = String(key).toLowerCase();
    if (k === c.up) return 'up';
    if (k === c.down) return 'down';
    if (k === c.left) return 'left';
    if (k === c.right) return 'right';
    return null;
}

function refreshPlayerLastDirKey(player) {
    if (!player?.controls) return;
    const c = player.controls;
    const candidates = [player._lastDirKey, c.up, c.down, c.left, c.right].filter(Boolean);
    const seen = new Set();
    for (const k of candidates) {
        const norm = String(k).toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        if (keys[norm]) {
            player._lastDirKey = norm;
            return;
        }
    }
    player._lastDirKey = null;
}

function resolveHeldDirection(player) {
    if (!player?.controls) return null;
    const c = player.controls;
    const last = player._lastDirKey;
    const fromLast = directionLabelForKey(player, last);
    if (last && keys[last] && fromLast) return fromLast;
    for (const k of [c.up, c.down, c.left, c.right]) {
        if (k && keys[k]) return directionLabelForKey(player, k);
    }
    return null;
}

function pollKeyboardHeldInput() {
    if (gameState !== 'PLAYING' || isPaused || isResuming || isSpectateMode) return;

    const poll = (player) => {
        if (!player || player.isAI || player.isDead) return;
        if (isOnlineRemotePlayer(player)) return;
        if (player === p1 && (isTutorialChargePracticeStep() || isTutorialTrailDemoStep())) return;
        const dir = resolveHeldDirection(player);
        if (dir) applyPlayerDirectionInput(player, dir, { fromPoll: true });
    };

    if (isOnline) poll(getLocalHumanPlayer());
    else {
        poll(p1);
        poll(p2);
    }
}

function applyPlayerDirectionInput(player, direction, { flashKey = null, fromPoll = false } = {}) {
    if (!player || player.isAI || player.isDead) return;
    if (isOnlineRemotePlayer(player)) return;
    if (gameState !== 'PLAYING' || isPaused || isResuming) return;

    const chargeTutorialOnly = player === p1 && isTutorialChargePracticeStep();
    const trailDemoOnly = player === p1 && isTutorialTrailDemoStep();
    if (chargeTutorialOnly || trailDemoOnly) return;

    const cur = player.dir || { x: 0, y: 0 };
    let nextDir = null;
    if (direction === 'up' && cur.y === 0) nextDir = { x: 0, y: -1 };
    else if (direction === 'down' && cur.y === 0) nextDir = { x: 0, y: 1 };
    else if (direction === 'left' && cur.x === 0) nextDir = { x: -1, y: 0 };
    else if (direction === 'right' && cur.x === 0) nextDir = { x: 1, y: 0 };
    if (!nextDir) return;
    if (nextDir.x === cur.x && nextDir.y === cur.y) return;
    if ((nextDir.x !== 0 && nextDir.x === -cur.x) || (nextDir.y !== 0 && nextDir.y === -cur.y)) return;

    const keyLabel = flashKey || controlsKeyForDirection(player, direction);
    if (!fromPoll && player === p1 && isTutorialPracticePhase() && tutorialStep === 0) {
        flashTutorialKey(keyLabel);
        const startDir = player._tutorialStartDir || cur;
        const turned = nextDir.x !== startDir.x || nextDir.y !== startDir.y;
        if (turned) notifyTutorialMoveInput();
    }

    // Dir only — body keeps sliding until the next logic tick (smooth tron corner)
    player.dir = nextDir;
    // If we're already past mid-cell, pull the next tick sooner (snappier corner, no teleport)
    if (typeof accumulator === 'number' && typeof tickDuration === 'number'
        && accumulator >= tickDuration * 0.45) {
        accumulator = tickDuration - 1;
    }
}

function applyPlayerActionInput(player, action) {
    if (!player || player.isDead) return;
    // Spectate: HUD buttons control that cube even though both sides are AI
    if (player.isAI && !isSpectateMode) return;
    if (!isSpectateMode && isOnlineRemotePlayer(player)) return;
    if (gameState !== 'PLAYING' || isPaused || isResuming) return;

    const chargeTutorialOnly = player === p1 && isTutorialChargePracticeStep();
    const trailDemoOnly = player === p1 && isTutorialTrailDemoStep();

    if (action === 'dash') {
        if (chargeTutorialOnly || trailDemoOnly) return;
        if (player === p1) flashTutorialKey(player.controls.dash || 'f');
        player.dash();
    } else if (action === 'charge') {
        if (trailDemoOnly) return;
        if (player === p1) flashTutorialKey(player.controls.charge || 'c');
        player.charge();
    } else if (action === 'skill') {
        if (player === p1 && isTutorialSkillPracticeStep()) {
            flashTutorialKey('y');
            player.selectedSkill = SKILL_TYPES.CLONES;
            player.lastSkillUsed = 0;
            player.activateSkill();
        } else {
            player.activateSkill();
        }
    }
}

function isActiveMatchForPause() {
    return gameState === 'PLAYING' || gameState === 'COUNTDOWN' || gameState === 'ROUND_OVER' || gameState === 'TUTORIAL_WAIT';
}

function isPauseMenuVisible() {
    return !!(pauseMenu && !pauseMenu.classList.contains('hidden') && pauseMenu.style.display !== 'none');
}

function getGamepadNavButtons(scope) {
    if (!scope) return [];
    return [...scope.querySelectorAll('button:not([disabled]):not(.hidden):not([hidden])')]
        .filter((btn) => {
            if (btn.offsetParent === null && btn.getClientRects().length === 0) return false;
            const style = window.getComputedStyle(btn);
            return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
        });
}

function getActiveGamepadNavScope() {
    if (isPauseMenuVisible()) return pauseMenu;
    if (settingsPage && !settingsPage.classList.contains('hidden')) return settingsPage;
    const help = document.getElementById('help-overlay');
    if (help && !help.classList.contains('hidden')) return help;
    const credits = document.getElementById('credits-overlay');
    if (credits && !credits.classList.contains('hidden')) return credits;
    const gate = document.getElementById('tutorial-gate-overlay');
    if (gate && !gate.classList.contains('hidden')) return gate;
    const gameOver = document.getElementById('game-over');
    if (gameOver && !gameOver.classList.contains('hidden')) return gameOver;
    const tier = document.querySelector('.menu-tier:not(.hidden)');
    if (tier) return tier;
    const loadout = document.getElementById('loadout-page');
    if (loadout && !loadout.classList.contains('hidden')) return loadout;
    const panel = document.querySelector('#online-matchmake:not(.hidden), #online-friends:not(.hidden), #waiting-room:not(.hidden)');
    return panel || null;
}

function focusGamepadNavButton(btn) {
    if (!btn || typeof btn.focus !== 'function') return;
    document.querySelectorAll('.ronk-pad-focus').forEach((el) => {
        if (el !== btn) el.classList.remove('ronk-pad-focus');
    });
    try {
        btn.focus({ preventScroll: true });
    } catch (_) {
        btn.focus();
    }
    btn.classList.add('ronk-pad-focus');
}

function ensureGamepadMenuFocus() {
    const scope = getActiveGamepadNavScope();
    if (!scope) return;
    const buttons = getGamepadNavButtons(scope);
    if (!buttons.length) return;
    const active = document.activeElement;
    if (active && buttons.includes(active)) {
        active.classList.add('ronk-pad-focus');
        return;
    }
    // Prefer Resume on pause menu
    const resume = scope.id === 'pause-menu' ? document.getElementById('resume-btn') : null;
    focusGamepadNavButton((resume && buttons.includes(resume)) ? resume : buttons[0]);
}

function navigateGamepadMenu(direction) {
    const scope = getActiveGamepadNavScope();
    if (!scope) return;
    const buttons = getGamepadNavButtons(scope);
    if (!buttons.length) return;

    markGamepadActivity();

    let idx = buttons.indexOf(document.activeElement);
    if (idx < 0) {
        const focusedCls = buttons.findIndex((b) => b.classList.contains('ronk-pad-focus'));
        idx = focusedCls >= 0 ? focusedCls : 0;
    }

    if (direction === 'up' || direction === 'left') idx = (idx - 1 + buttons.length) % buttons.length;
    else if (direction === 'down' || direction === 'right') idx = (idx + 1) % buttons.length;
    else return;

    focusGamepadNavButton(buttons[idx]);
    SFX.play?.('button');
}

function openSettingsFromPause() {
    const inGame = isActiveMatchForPause();
    if (!inGame || isResuming) return;

    if (!isPaused) setGamePaused(true);

    settingsOpenedFromPause = true;
    if (pauseMenu) {
        pauseMenu.classList.add('hidden');
        pauseMenu.style.display = 'none';
    }
    showOverlayPanel(settingsPage);
    setActiveNavigation('in-game', { paused: true });
    syncGameplayCursor();
    try {
        loadSettings();
    } catch (error) {
        console.error('Error in loadSettings() from pause:', error);
    }
    if (usingGamepadInput) {
        requestAnimationFrame(() => ensureGamepadMenuFocus());
    }
}

function closeSettingsFromPause() {
    try {
        persistGameSettings?.();
    } catch (error) {
        console.error('Error saving settings from pause:', error);
    }
    settingsOpenedFromPause = false;
    hideOverlayPanel(settingsPage);
    if (pauseMenu && isPaused) {
        pauseMenu.classList.remove('hidden');
        pauseMenu.style.display = 'flex';
    }
    setActiveNavigation('in-game', { paused: true });
    syncGameplayCursor();
    if (usingGamepadInput) {
        requestAnimationFrame(() => ensureGamepadMenuFocus());
    }
}

function closeSettingsOutsideGame() {
    try {
        persistGameSettings?.();
    } catch (error) {
        console.error('Error saving settings:', error);
    }
    settingsOpenedFromPause = false;
    hideOverlayPanel(settingsPage);
    const returnState = settingsReturnState;
    settingsReturnState = null;
    if (returnState) {
        restoreNavigationState(returnState);
    } else {
        showMainMenu();
        resetToMainTier();
    }
}

/** Open Settings from menus/loadout/etc. Never used during active match pause flow. */
function openSettingsOutsideGame() {
    if (!introFinished || isResuming) return false;
    if (isActiveMatchForPause()) return false;
    if (settingsPage && !settingsPage.classList.contains('hidden') && !settingsOpenedFromPause) {
        closeSettingsOutsideGame();
        return true;
    }

    settingsOpenedFromPause = false;
    settingsReturnState = captureNavigationState();
    if (loadoutPage) loadoutPage.classList.remove('loadout-picker-open');
    document.body.classList.remove('loadout-picker-open');
    if (loadoutSkillPanel) loadoutSkillPanel.classList.add('hidden');
    if (loadoutJokerPanel) loadoutJokerPanel.classList.add('hidden');
    [menu, customPage, onlineMatchmakePanel, onlineFriendsPanel, loadoutPage].forEach(hideOverlayPanel);
    const waitingRoom = document.getElementById('waiting-room');
    if (waitingRoom) hideOverlayPanel(waitingRoom);

    showOverlayPanel(settingsPage);
    setActiveNavigation('settings');
    try {
        loadSettings();
    } catch (error) {
        console.error('Error in loadSettings() outside game:', error);
    }
    if (usingGamepadInput) {
        requestAnimationFrame(() => ensureGamepadMenuFocus());
    }
    return true;
}

function togglePauseFromInput() {
    if (isResuming) return;
    // Online PvP: no pause / quit mid-match
    if (isOnline && isActiveMatchForPause()) {
        if (typeof enqueueGameNotification === 'function') {
            enqueueGameNotification({
                kicker: 'Online',
                title: 'No pause',
                body: 'Pause and quit are disabled in online matches. Finish the match or leave by closing the connection.',
                duration: 2800
            });
        }
        return;
    }
    if (!isActiveMatchForPause()) {
        if (settingsPage && !settingsPage.classList.contains('hidden') && !settingsOpenedFromPause) {
            closeSettingsOutsideGame();
            SFX.play('button');
            return;
        }
        if (openSettingsOutsideGame()) SFX.play('button');
        return;
    }

    // ESC while settings-from-pause is open → return to pause menu
    if (settingsOpenedFromPause && settingsPage && !settingsPage.classList.contains('hidden')) {
        closeSettingsFromPause();
        SFX.play('button');
        return;
    }

    // ESC toggles pause menu (NOT settings). Settings only via pause button.
    if (isPaused) {
        settingsOpenedFromPause = false;
        setGamePaused(false, true);
    } else {
        setGamePaused(true);
    }
    SFX.play('button');
}

function clickFocusedOrPrimaryButton() {
    const focused = document.activeElement;
    if (focused && focused !== document.body && typeof focused.click === 'function' && !focused.disabled
        && !focused.classList.contains('hidden')) {
        focused.click();
        return;
    }
    const padFocused = document.querySelector('.ronk-pad-focus');
    if (padFocused && typeof padFocused.click === 'function' && !padFocused.disabled) {
        padFocused.click();
        return;
    }
    const panel = getActiveGamepadNavScope()
        || document.querySelector('.menu-tier:not(.hidden), #pause-menu:not(.hidden), #settings-page:not(.hidden), #loadout-page:not(.hidden), #game-over:not(.hidden), #tutorial-gate-overlay:not(.hidden)');
    const scope = panel || document;
    const btn = scope.querySelector('button:not([disabled]):not(.hidden):not([hidden])');
    if (btn) btn.click();
}

function pollGamepadMenuNav(gp) {
    const now = performance.now();
    const dir = getGamepadCardinalDirection(gp, GAMEPAD_MENU_STICK_DEADZONE);
    const lastAt = gamepadMenuNavAtByIndex.get(gp.index) || 0;
    if (!dir) {
        gamepadMenuNavAtByIndex.set(gp.index, 0);
        return;
    }
    if (now - lastAt < GAMEPAD_MENU_NAV_MS) return;
    gamepadMenuNavAtByIndex.set(gp.index, now);
    markGamepadActivity();
    navigateGamepadMenu(dir);
}

function isTypingIntoField() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

function pickMenuGamepad(pads) {
    if (!pads.length) return null;
    const p1Pad = getGamepadByIndex(playerPadIndex.p1);
    if (p1Pad) return p1Pad;
    const p2Pad = getGamepadByIndex(playerPadIndex.p2);
    if (p2Pad) return p2Pad;
    if (lastGamepadMenuNavPadIndex != null) {
        const last = pads.find((gp) => gp.index === lastGamepadMenuNavPadIndex);
        if (last) return last;
    }
    return pads[0];
}

function pollGamepadMenuInput(gp) {
    lastGamepadMenuNavPadIndex = gp.index;
    // Don't yank focus out of nickname / room-code fields
    if (!isTypingIntoField()) {
        ensureGamepadMenuFocus();
        pollGamepadMenuNav(gp);
    }

    if (wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.confirm)) {
        markGamepadActivity();
        if (!isTypingIntoField()) clickFocusedOrPrimaryButton();
    }
    // B / cancel: leave settings → pause, or unpause / close overlays
    if (wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.back)) {
        markGamepadActivity();
        if (isTypingIntoField()) {
            try { document.activeElement.blur(); } catch (_) { /* ignore */ }
        } else if (settingsOpenedFromPause && settingsPage && !settingsPage.classList.contains('hidden')) {
            closeSettingsFromPause();
            SFX.play('button');
        } else if (isPauseMenuVisible()) {
            settingsOpenedFromPause = false;
            setGamePaused(false, true);
            SFX.play('button');
        } else if (settingsPage && !settingsPage.classList.contains('hidden') && !settingsOpenedFromPause) {
            closeSettingsOutsideGame();
            SFX.play('button');
        } else {
            const help = document.getElementById('help-overlay');
            const credits = document.getElementById('credits-overlay');
            if (help && !help.classList.contains('hidden')) {
                closeHelpOverlay();
                SFX.play('button');
            } else if (credits && !credits.classList.contains('hidden')) {
                closeCreditsOverlay();
                SFX.play('button');
            }
        }
    }
    if (wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.pause) || wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.select)) {
        markGamepadActivity();
        togglePauseFromInput();
    }
}

function pollGamepadGameplayInput(gp, player) {
    const dir = getGamepadCardinalDirection(gp);
    const lastDir = gamepadLastDirByIndex.get(gp.index);
    if (dir !== lastDir) {
        if (dir) {
            markGamepadActivity();
            applyPlayerDirectionInput(player, dir);
        }
        gamepadLastDirByIndex.set(gp.index, dir);
    }

    if (wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.dash)) {
        markGamepadActivity();
        applyPlayerActionInput(player, 'dash');
    }
    if (wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.charge)) {
        markGamepadActivity();
        applyPlayerActionInput(player, 'charge');
    }
    if (wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.skill)) {
        markGamepadActivity();
        applyPlayerActionInput(player, 'skill');
    }
    if (wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.pause) || wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.select)) {
        markGamepadActivity();
        togglePauseFromInput();
    }
}

function pollGamepadInput() {
    syncGamepadPlayerBindings();

    const pads = getConnectedGamepads();
    if (!pads.length) return;

    const inGameplay = gameState === 'PLAYING' && !isPaused && !isResuming;
    if (inGameplay) {
        const p1Pad = getGamepadByIndex(playerPadIndex.p1);
        const p2Pad = getGamepadByIndex(playerPadIndex.p2);
        if (isLocalHumanVsHuman()) {
            if (p1 && !p1.isAI && p1Pad) pollGamepadGameplayInput(p1Pad, p1);
            if (p2 && !p2.isAI && p2Pad) pollGamepadGameplayInput(p2Pad, p2);
        } else {
            // Solo / online: one local human — always the P1 pad slot (guest online = side 2)
            const localSide = (typeof getLocalPlayerSide === 'function') ? getLocalPlayerSide() : 1;
            const localPlayer = localSide === 2 ? p2 : p1;
            if (localPlayer && !localPlayer.isAI && p1Pad) {
                pollGamepadGameplayInput(p1Pad, localPlayer);
            }
        }
        // Start on any bound/unbound pad still opens pause
        for (const gp of pads) {
            if (gp === p1Pad || gp === p2Pad) continue;
            if (wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.pause) || wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.select)) {
                markGamepadActivity();
                togglePauseFromInput();
            }
        }
    } else {
        // Menus / pause: one pad owns nav/confirm to avoid dual-pad double-clicks
        const menuPad = pickMenuGamepad(pads);
        if (menuPad) pollGamepadMenuInput(menuPad);
        // Still edge-track other pads so Start/Select can open/close pause without stale edges
        for (const gp of pads) {
            if (gp === menuPad) continue;
            if (wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.pause) || wasGamepadButtonJustPressed(gp, GAMEPAD_BTN.select)) {
                markGamepadActivity();
                togglePauseFromInput();
            } else {
                // Keep button edge map fresh without acting
                const btns = gp.buttons || [];
                let prev = gamepadButtonPrevByIndex.get(gp.index);
                if (!prev) {
                    prev = {};
                    gamepadButtonPrevByIndex.set(gp.index, prev);
                }
                for (let i = 0; i < btns.length; i++) prev[i] = !!btns[i]?.pressed;
            }
        }
    }
}

let gamepadPollRaf = null;
let gamepadPollLastMs = 0;
const GAMEPAD_MENU_POLL_MS = 33; // ~30 Hz — enough for menus, less RAF contention

function scheduleGamepadPoll() {
    if (gamepadPollRaf != null) return;
    if (document.hidden) return;
    if (document.body.classList.contains('in-game') && animLoop) return;
    gamepadPollRaf = requestAnimationFrame(gamepadPollLoop);
}

function gamepadPollLoop(ts) {
    gamepadPollRaf = null;
    if (document.body.classList.contains('in-game') && animLoop) {
        return;
    }
    const now = typeof ts === 'number' ? ts : performance.now();
    const pads = (typeof navigator.getGamepads === 'function') ? navigator.getGamepads() : null;
    let anyPad = false;
    if (pads) {
        for (let i = 0; i < pads.length; i++) {
            if (pads[i]) { anyPad = true; break; }
        }
    }
    // No pad connected — poll rarely so we still notice connect events cheaply
    const minGap = anyPad ? GAMEPAD_MENU_POLL_MS : 250;
    if (!animLoop && (now - gamepadPollLastMs >= minGap)) {
        gamepadPollLastMs = now;
        if (anyPad || usingGamepadInput) pollGamepadInput();
    }
    if (!document.hidden && !(document.body.classList.contains('in-game') && animLoop)) {
        scheduleGamepadPoll();
    }
}

function initGamepadInput() {
    if (!navigator.getGamepads) return;
    window.addEventListener('gamepadconnected', handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', handleGamepadDisconnected);
    window.addEventListener('mousemove', markMouseActivity, { passive: true });
    window.addEventListener('mousedown', markMouseActivity, { passive: true });
    window.addEventListener('wheel', markMouseActivity, { passive: true });
    window.addEventListener('keydown', (e) => {
        // Typing / keyboard play restores cursor + keyboard prompt mode
        if (e.key === 'Escape') return;
        markMouseActivity();
    }, { passive: true });

    syncGamepadPlayerBindings();
    scheduleGamepadPoll();
}

function grantSteamAchievementsOnMatchEnd(playerWonMatch, wasTutorialMatch) {
    if (!playerWonMatch || isSpectateMode) return;
    const boardWin = lastBoardWinReason === 'ttt' || lastBoardWinReason === 'boards';
    const api = (typeof window !== 'undefined' && window.RonkSteamAchievements) || null;
    if (api?.onMatchWon) {
        api.onMatchWon({
            isTutorial: !!wasTutorialMatch,
            isSpectate: !!isSpectateMode,
            isMultiplayer: !!isMultiplayer,
            isOnline: !!isOnline,
            botDifficulty: (p2?.isAI ? currentBotDifficulty : null),
            playerRoundScore: p1Score,
            opponentRoundScore: p2Score,
            boardWin
        });
    } else if (steamBridge?.activateAchievement) {
        if (wasTutorialMatch) {
            steamBridge.activateAchievement('ACH_TUTORIAL_COMPLETE');
            return;
        }
        steamBridge.activateAchievement('ACH_FIRST_WIN');
        if (p2?.isAI && currentBotDifficulty === 'invincible') {
            steamBridge.activateAchievement('ACH_INVINCIBLE_SLAYER');
        }
        if (isOnline) steamBridge.activateAchievement('ACH_ONLINE_VICTORY');
        if (isMultiplayer && !isOnline) steamBridge.activateAchievement('ACH_LOCAL_DUELIST');
        if (boardWin) steamBridge.activateAchievement('ACH_TTT_WIN');
    }
    recordPlayerMatchStats(playerWonMatch, wasTutorialMatch, boardWin);
}

const PLAYER_STATS_KEY = 'ronk_player_stats_v1';

function defaultPlayerStats() {
    return {
        matches: 0,
        wins: 0,
        losses: 0,
        kills: 0,
        boardsClaimed: 0,
        tttWins: 0,
        botWins: { easy: 0, medium: 0, hard: 0, invincible: 0 },
        onlineWins: 0,
        localWins: 0,
        challengesClaimed: {}
    };
}

function loadPlayerStats() {
    try {
        const raw = localStorage.getItem(PLAYER_STATS_KEY);
        return raw ? { ...defaultPlayerStats(), ...JSON.parse(raw) } : defaultPlayerStats();
    } catch (_) {
        return defaultPlayerStats();
    }
}

function savePlayerStats(stats) {
    try {
        localStorage.setItem(PLAYER_STATS_KEY, JSON.stringify(stats));
    } catch (_) { /* ignore */ }
    if (steamBridge?.writeProgressCloud) {
        Promise.resolve(steamBridge.writeProgressCloud(JSON.stringify(stats), 'ronk_player_stats.dat')).catch(() => {});
    }
}

function recordPlayerMatchStats(playerWonMatch, wasTutorialMatch, boardWin) {
    if (isSpectateMode || wasTutorialMatch) return;
    const stats = loadPlayerStats();
    stats.matches++;
    if (playerWonMatch) {
        stats.wins++;
        if (isOnline) stats.onlineWins++;
        else if (isMultiplayer) stats.localWins++;
        else if (p2?.isAI && stats.botWins[currentBotDifficulty] != null) {
            stats.botWins[currentBotDifficulty]++;
        }
    } else {
        stats.losses++;
    }
    // Host scoreboard: p1 = you. Guest: your wins are p2Score (you are the right-side player).
    const myRoundWins = (isOnline && onlineRole === 'guest')
        ? Math.max(0, p2Score || 0)
        : Math.max(0, p1Score || 0);
    stats.kills += myRoundWins;
    stats.tttWins += Math.max(0, sessionTttRoundWins || 0);
    savePlayerStats(stats);
    refreshPlayerMetaPanel();
    checkChallengeMilestones(stats);
}

function getPlayerChallenges(stats) {
    const s = stats || loadPlayerStats();
    return [
        { id: 'win_3', label: 'Win 3 matches', cur: s.wins, goal: 3 },
        { id: 'win_10', label: 'Win 10 matches', cur: s.wins, goal: 10 },
        { id: 'ttt_1', label: 'Win 1 round by tic-tac-toe', cur: s.tttWins, goal: 1 },
        { id: 'ttt_5', label: 'Win 5 rounds by tic-tac-toe', cur: s.tttWins, goal: 5 },
        { id: 'hard_1', label: 'Beat a Hard bot', cur: s.botWins.hard || 0, goal: 1 },
        { id: 'inv_1', label: 'Beat Elite', cur: s.botWins.invincible || 0, goal: 1 },
        { id: 'online_1', label: 'Win online once', cur: s.onlineWins, goal: 1 },
        { id: 'kills_25', label: 'Win 25 rounds', cur: s.kills, goal: 25 }
    ];
}

function checkChallengeMilestones(stats) {
    const s = stats || loadPlayerStats();
    let changed = false;
    getPlayerChallenges(s).forEach((ch) => {
        if (ch.cur >= ch.goal && !s.challengesClaimed[ch.id]) {
            s.challengesClaimed[ch.id] = Date.now();
            changed = true;
            if (typeof enqueueGameNotification === 'function') {
                enqueueGameNotification({
                    kicker: 'Challenge complete',
                    title: ch.label,
                    body: 'Keep going — more goals unlock as you play.',
                    milestone: true,
                    duration: 3800
                });
            }
        }
    });
    if (changed) savePlayerStats(s);
}

function refreshPlayerMetaPanel() {
    const statsEl = document.getElementById('player-stats-panel');
    const listEl = document.getElementById('player-challenges-list');
    if (!statsEl && !listEl) return;
    const s = loadPlayerStats();
    if (statsEl) {
        statsEl.innerHTML = [
            `<div><span>Matches</span><b>${s.matches}</b></div>`,
            `<div><span>Wins</span><b>${s.wins}</b></div>`,
            `<div><span>Losses</span><b>${s.losses}</b></div>`,
            `<div><span>Rounds won</span><b>${s.kills}</b></div>`,
            `<div><span>TTT rounds</span><b>${s.tttWins}</b></div>`,
            `<div><span>Online wins</span><b>${s.onlineWins}</b></div>`
        ].join('');
    }
    if (listEl) {
        listEl.innerHTML = getPlayerChallenges(s).map((ch) => {
            const done = ch.cur >= ch.goal;
            const pct = Math.min(100, Math.round((ch.cur / ch.goal) * 100));
            return `<li class="${done ? 'challenge-done' : ''}"><span>${ch.label}</span><em>${Math.min(ch.cur, ch.goal)}/${ch.goal}</em><i style="width:${pct}%"></i></li>`;
        }).join('');
    }
}

function openHelpOverlay() {
    const el = document.getElementById('help-overlay');
    if (el) el.classList.remove('hidden');
}
function closeHelpOverlay() {
    const el = document.getElementById('help-overlay');
    if (el) el.classList.add('hidden');
}
function openCreditsOverlay() {
    const el = document.getElementById('credits-overlay');
    if (el) el.classList.remove('hidden');
}
function closeCreditsOverlay() {
    const el = document.getElementById('credits-overlay');
    if (el) el.classList.add('hidden');
}

function isSteamSpectateAvailable() {
    return !!(steamBridge && typeof steamBridge.isAvailable === 'function' && steamBridge.isAvailable());
}

/** Show Spectate Friend in the menu (Steam path). Live match relay may still be limited. */
function isSpectateFriendLiveReady() {
    return true; // Always offer the choice; startSpectateFriendFlow handles availability
}

function syncSpectateMenuUI() {
    const friendBtn = document.getElementById('spectate-friend-btn');
    const steamOk = isSteamSpectateAvailable();
    if (friendBtn) {
        friendBtn.classList.remove('hidden');
        friendBtn.disabled = false;
        friendBtn.title = steamOk
            ? 'Spectate a Steam friend'
            : 'Steam friend spectate (Steam client recommended)';
    }
}

async function startSpectateFriendFlow() {
    const t = translations[localStorage.getItem('ronk_language') || 'en'] || translations['en'];
    const friendBtn = document.getElementById('spectate-friend-btn');
    if (friendBtn) {
        friendBtn.disabled = true;
        friendBtn.title = t['SPECTATE FRIEND UNAVAILABLE'] || 'Not available yet';
    }
    enqueueGameNotification({
        kicker: 'Coming soon',
        title: t['SPECTATE FRIEND'] || 'SPECTATE FRIEND',
        body: t['SPECTATE FRIEND UNAVAILABLE']
            || 'Live friend spectate is not available yet. Use SPECTATE BOT for AI vs AI.',
        duration: 4800
    });
    setTimeout(() => {
        if (friendBtn) {
            friendBtn.disabled = false;
            friendBtn.title = 'Coming soon — use SPECTATE AI VS AI';
        }
        syncSpectateMenuUI();
    }, 500);
}

function initTouchControls() {
    if (!isAndroidPlatform()) return;
    const panel = document.getElementById('touch-controls');
    if (!panel) return;
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('touch-mode');

    const saved = JSON.parse(localStorage.getItem('ronk_controls') || '{}');
    const map = {
        up: (saved.up || 'w').toLowerCase(),
        down: (saved.down || 's').toLowerCase(),
        left: (saved.left || 'a').toLowerCase(),
        right: (saved.right || 'd').toLowerCase(),
        dash: (saved.dash || 'f').toLowerCase(),
        charge: (saved.charge || 'c').toLowerCase(),
        skill: (saved.skill || 'y').toLowerCase()
    };

    const pressKey = (key) => {
        keys[key] = true;
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    };
    const releaseKey = (key) => {
        keys[key] = false;
        window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    };

    panel.querySelectorAll('[data-touch]').forEach((btn) => {
        const key = map[btn.dataset.touch] || btn.dataset.touch;
        const onDown = (e) => { e.preventDefault(); pressKey(key); };
        const onUp = (e) => { e.preventDefault(); releaseKey(key); };
        btn.addEventListener('touchstart', onDown, { passive: false });
        btn.addEventListener('touchend', onUp);
        btn.addEventListener('touchcancel', onUp);
        btn.addEventListener('mousedown', onDown);
        btn.addEventListener('mouseup', onUp);
        btn.addEventListener('mouseleave', onUp);
    });
}

function attachEventListeners() {
    // --- GLOBAL BUTTON SOUNDS ---
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled) return;
        if (btn.classList.contains('hidden') || btn.hidden) return;
        SFX.play('button');
    });

    if (themeBtn) {
        themeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            themeBtn.blur();
            changeTheme(currentThemeIndex + 1);
        });
    }

    initDisplayModeButton();

    // Menus/loadout: if a plate covers a button, still hit the button (not during live match)
    document.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        if (gameState === 'PLAYING' && !isPaused) return;
        const origin = e.target;
        if (origin && origin.closest && origin.closest('button, .cooldown-letter, a, input, select, textarea, label, canvas, .joker-card, .skill-card, .skill-card-single, .loadout-summary-item')) {
            return;
        }
        const stack = (typeof document.elementsFromPoint === 'function')
            ? document.elementsFromPoint(e.clientX, e.clientY)
            : [];
        const hit = stack.find((node) => {
            if (!node || node.nodeType !== 1) return false;
            const el = node.closest?.('button, .cooldown-letter');
            if (!el) return false;
            if (el.disabled || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
            return true;
        });
        const btn = hit && hit.closest ? hit.closest('button, .cooldown-letter') : null;
        if (!btn || btn === origin || (origin && origin.contains && origin.contains(btn))) return;
        e.preventDefault();
        e.stopPropagation();
        btn.click();
    }, true);

    if (prevSkillBtn) {
        prevSkillBtn.addEventListener('click', () => {
            const unlocked = getUnlockedSkillIndices();
            if (isUnlockProgressionEnabled() && unlocked.length === 0) {
                SFX.play('button');
                return;
            }
            currentSkillIndex = (currentSkillIndex - 1 + SKILL_DATA.length) % SKILL_DATA.length;
            updateSkillPreview();
            SFX.play('button');
        });
    }

    if (nextSkillBtn) {
        nextSkillBtn.addEventListener('click', () => {
            const unlocked = getUnlockedSkillIndices();
            if (isUnlockProgressionEnabled() && unlocked.length === 0) {
                SFX.play('button');
                return;
            }
            currentSkillIndex = (currentSkillIndex + 1) % SKILL_DATA.length;
            updateSkillPreview();
            SFX.play('button');
        });
    }

    if (loadoutStartBtn) {
        loadoutStartBtn.addEventListener('click', () => {
            if (isInActiveGameView()) return;
            continueFromLoadout();
        });
    }

    const dualStartBtn = document.getElementById('loadout-dual-start-btn');
    if (dualStartBtn) {
        dualStartBtn.addEventListener('click', () => {
            if (isInActiveGameView()) return;
            pendingPlayPath = 'local-pvp';
            continueFromLoadout();
        });
    }

    if (loadoutBackBtn) {
        loadoutBackBtn.addEventListener('click', () => {
            const skillOpen = loadoutSkillPanel && !loadoutSkillPanel.classList.contains('hidden');
            const jokerOpen = loadoutJokerPanel && !loadoutJokerPanel.classList.contains('hidden');
            if (skillOpen) {
                closeLoadoutPanel(loadoutSkillPanel);
                SFX.play('button');
                return;
            }
            if (jokerOpen) {
                closeLoadoutPanel(loadoutJokerPanel);
                SFX.play('button');
                return;
            }
            hideOverlayPanel(loadoutPage);
            stopLoadoutCubeRender();
            showMainMenu();
            const backTier = getLoadoutBackTarget();
            showTier(backTier);
            SFX.play('button');
        });
    }

    document.querySelectorAll('.collection-back-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.closePanel;
            if (target === 'skill' && loadoutSkillPanel) closeLoadoutPanel(loadoutSkillPanel);
            else if (target === 'joker' && loadoutJokerPanel) closeLoadoutPanel(loadoutJokerPanel);
            SFX.play('button');
        });
    });

    if (loadoutJokerBtn) {
        loadoutJokerBtn.addEventListener('click', () => {
            loadoutEditSlot = 1;
            openLoadoutPanel(loadoutJokerPanel);
        });
    }

    if (loadoutSkillBtn) {
        loadoutSkillBtn.addEventListener('click', () => {
            loadoutEditSlot = 1;
            openLoadoutPanel(loadoutSkillPanel);
        });
    }

    ['p1', 'p2'].forEach((who) => {
        const slot = who === 'p2' ? 2 : 1;
        document.getElementById(`loadout-skill-btn-${who}`)?.addEventListener('click', () => {
            SFX.play('button');
            openLoadoutEditorForSlot(slot, 'skill');
        });
        document.getElementById(`loadout-joker-btn-${who}`)?.addEventListener('click', () => {
            SFX.play('button');
            openLoadoutEditorForSlot(slot, 'joker');
        });
        document.getElementById(`loadout-prev-color-${who}`)?.addEventListener('click', () => {
            SFX.play('button');
            cycleLoadoutSlotColor(slot, -1);
        });
        document.getElementById(`loadout-next-color-${who}`)?.addEventListener('click', () => {
            SFX.play('button');
            cycleLoadoutSlotColor(slot, 1);
        });
        document.getElementById(`loadout-upload-btn-${who}`)?.addEventListener('click', () => {
            SFX.play('button');
            document.getElementById(`loadout-cube-image-input-${who}`)?.click();
        });
        document.getElementById(`loadout-cube-image-input-${who}`)?.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleLoadoutSlotImageFile(slot, file);
            e.target.value = '';
        });
    });

    function cycleLoadoutSlotColor(slot, delta) {
        if (slot === 2) {
            p2ColorIndex = (p2ColorIndex + delta + neonColors.length) % neonColors.length;
            localStorage.setItem('ronk_p2_colorIndex', String(p2ColorIndex));
        } else {
            currentColorIndex = (currentColorIndex + delta + neonColors.length) % neonColors.length;
            localStorage.setItem('ronk_colorIndex', String(currentColorIndex));
            if (typeof updateColorPreview === 'function') updateColorPreview();
        }
    }

    function handleLoadoutSlotImageFile(slot, file) {
        if (!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            if (!dataUrl.startsWith('data:image/')) return;
            if (slot === 2) {
                p2ColorIndex = neonColors.length - 1;
                localStorage.setItem('ronk_p2_colorIndex', String(p2ColorIndex));
                localStorage.setItem('ronk_p2_cubeImage', dataUrl);
                playerImageP2 = new Image();
                playerImageP2.src = dataUrl;
            } else if (typeof handleCubeImageFile === 'function') {
                // Reuse P1 path via data URL blob
                fetch(dataUrl).then((r) => r.blob()).then((blob) => {
                    handleCubeImageFile(new File([blob], 'cube.png', { type: blob.type || 'image/png' }));
                }).catch(() => {
                    currentColorIndex = neonColors.length - 1;
                    localStorage.setItem('ronk_colorIndex', String(currentColorIndex));
                    playerImage = new Image();
                    playerImage.src = dataUrl;
                    localStorage.setItem('ronk_cubeImage', dataUrl);
                });
            }
        };
        reader.readAsDataURL(file);
    }

    if (loadoutJokerDoneBtn) {
        loadoutJokerDoneBtn.addEventListener('click', () => closeLoadoutPanel(loadoutJokerPanel));
    }

    if (loadoutSkillDoneBtn) {
        loadoutSkillDoneBtn.addEventListener('click', () => closeLoadoutPanel(loadoutSkillPanel));
    }


    if (loadoutPrevColorBtn) {
        loadoutPrevColorBtn.addEventListener('click', () => {
            SFX.play('button');
            cycleCubeColor(-1);
        });
    }

    if (loadoutNextColorBtn) {
        loadoutNextColorBtn.addEventListener('click', () => {
            SFX.play('button');
            cycleCubeColor(1);
        });
    }

    if (loadoutUploadBtn) {
        loadoutUploadBtn.addEventListener('click', () => {
            SFX.play('button');
            currentColorIndex = neonColors.length - 1;
            localStorage.setItem('ronk_colorIndex', currentColorIndex);
            updateColorPreview();
            const input = document.getElementById('loadout-cube-image-input') || document.getElementById('cube-image-input');
            if (input) input.click();
        });
    }

    const loadoutCubeStage = document.querySelector('.loadout-cube-stage');
    if (loadoutCubeStage) {
        loadoutCubeStage.style.cursor = 'pointer';
        loadoutCubeStage.addEventListener('click', () => {
            if (currentColorIndex === neonColors.length - 1) {
                const input = document.getElementById('loadout-cube-image-input') || document.getElementById('cube-image-input');
                if (input) input.click();
            } else {
                cycleCubeColor(1);
            }
        });
    }

    window.addEventListener('resize', () => {
        if (isLoadoutPageVisible()) resizeLoadoutCubeCanvas();
    });

    const loadoutImageInput = document.getElementById('loadout-cube-image-input');
    if (loadoutImageInput) {
        loadoutImageInput.addEventListener('change', (e) => {
            handleCubeImageFile(e.target.files[0]);
            e.target.value = '';
        });
    }

    const exitGameBtn = document.getElementById('exit-game-btn');
    if (exitGameBtn) {
        exitGameBtn.addEventListener('click', () => {
            if (gameState !== 'LOBBY') return;
            exitGame();
        });
    }

    if (openSettingsBtn) {
        openSettingsBtn.addEventListener('click', () => {
            openSettingsOutsideGame();
        });
    }

    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener('click', () => {
            try {
                saveSettings();
            } catch (error) {
                console.error('Error in saveSettings():', error);
            }

            if (settingsOpenedFromPause) {
                closeSettingsFromPause();
                SFX.play('button');
                return;
            }

            closeSettingsOutsideGame();
            SFX.play('button');
        });
    }

    document.getElementById('open-help-btn')?.addEventListener('click', () => {
        openHelpOverlay();
        SFX.play('button');
    });
    document.getElementById('help-overlay-close')?.addEventListener('click', () => {
        closeHelpOverlay();
        SFX.play('button');
    });
    document.getElementById('open-credits-btn')?.addEventListener('click', () => {
        openCreditsOverlay();
        SFX.play('button');
    });
    document.getElementById('credits-overlay-close')?.addEventListener('click', () => {
        closeCreditsOverlay();
        SFX.play('button');
    });
    document.getElementById('help-overlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'help-overlay') closeHelpOverlay();
    });
    document.getElementById('credits-overlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'credits-overlay') closeCreditsOverlay();
    });

    // Resolution: apply the moment the dropdown changes (no wait for SAVE)
    const resolutionSelectLive = document.getElementById('resolution-select');
    if (resolutionSelectLive) {
        resolutionSelectLive.addEventListener('change', () => {
            const resolution = normalizeResolution(resolutionSelectLive.value || DEFAULT_RESOLUTION);
            localStorage.setItem('ronk_resolution', resolution);
            if (resolution === '480p') localStorage.setItem('ronk_keep_480p', '1');
            else localStorage.removeItem('ronk_keep_480p');
            applyResolution(resolution);
            notifyResolutionChange(resolution);
            SFX.play('button');
        });
    }

    // Volume slider functionality
    const volumeMaster = document.getElementById('volume-master');
    const volumeMasterValue = document.getElementById('volume-master-value');
    const volumeMusic = document.getElementById('volume-music');
    const volumeMusicValue = document.getElementById('volume-music-value');
    const volumeSfx = document.getElementById('volume-sfx');
    const volumeSfxValue = document.getElementById('volume-sfx-value');

    // Apply volume changes
    function applyVolume() {
        const masterValue = volumeMaster ? volumeMaster.value / 100 : 0.7;
        const musicValue = volumeMusic ? volumeMusic.value / 100 : 0.6;
        const sfxValue = volumeSfx ? volumeSfx.value / 100 : 0.8;
        const combinedMusicVolume = Math.max(0, Math.min(0.92, masterValue * musicValue));

        // Persist live so Music.getCombinedVolume / watchdog stay in sync
        try {
            localStorage.setItem('ronk_volume', JSON.stringify({
                master: volumeMaster ? volumeMaster.value : 70,
                music: volumeMusic ? volumeMusic.value : 60,
                sfx: volumeSfx ? volumeSfx.value : 80
            }));
        } catch (_) {}

        Music.setAudioVolume(Music.currentAudio, combinedMusicVolume);
        Object.values(Music.audioCache).forEach(audio => {
            if (audio !== Music.currentAudio) Music.setAudioVolume(audio, combinedMusicVolume);
        });

        SFX.volume = masterValue * sfxValue;
    }

    if (volumeMaster) {
        volumeMaster.addEventListener('input', (e) => {
            const value = e.target.value;
            volumeMasterValue.textContent = value + '%';
            applyVolume();
        });
    }

    if (volumeMusic) {
        volumeMusic.addEventListener('input', (e) => {
            const value = e.target.value;
            volumeMusicValue.textContent = value + '%';
            applyVolume();
        });
    }

    if (volumeSfx) {
        volumeSfx.addEventListener('input', (e) => {
            const value = e.target.value;
            volumeSfxValue.textContent = value + '%';
            applyVolume();
        });
    }

    // Control input functionality
    const controlInputs = [
        'control-up', 'control-down', 'control-left', 'control-right',
        'control-dash', 'control-charge', 'control-skill', 'control-pause'
    ];

    controlInputs.forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('keydown', (e) => {
                e.preventDefault();
                const key = e.key.toUpperCase();
                if (key.length === 1 || key === 'ESC' || key === 'SPACE') {
                    input.value = key;
                }
            });
        }
    });

    // Language select functionality - using global translations

    function applyLanguage(lang) {
        syncLanguageSelectLabels();
        const t = translations[lang] || translations['en'];
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (t[key]) {
                el.textContent = t[key];
            }
        });
        // Update menu buttons using correct IDs
        const mainPlayBtn = document.getElementById('main-play-btn');
        if (mainPlayBtn) mainPlayBtn.textContent = t['START'] || 'START';
        const startSpectateBtnEl = document.getElementById('start-spectate-btn');
        if (startSpectateBtnEl) startSpectateBtnEl.textContent = t['SPECTATE'] || 'SPECTATE';
        const singlePlayerBtnEl = document.getElementById('single-player-btn');
        if (singlePlayerBtnEl) singlePlayerBtnEl.textContent = t['SINGLE PLAYER'] || 'SINGLE PLAYER';
        const multiplayerModeBtnEl = document.getElementById('multiplayer-mode-btn');
        if (multiplayerModeBtnEl) multiplayerModeBtnEl.textContent = t['MULTIPLAYER'] || 'MULTIPLAYER';
        const dualStartEl = document.getElementById('loadout-dual-start-btn');
        if (dualStartEl) dualStartEl.textContent = t['START MATCH'] || 'START MATCH';
        const mainTutorialBtn = document.getElementById('main-tutorial-btn');
        if (mainTutorialBtn) mainTutorialBtn.textContent = t['TUTORIAL'] || 'TUTORIAL';
        const loadoutTitle = document.querySelector('.loadout-title');
        if (loadoutTitle) loadoutTitle.textContent = t['LOADOUT'] || 'LOADOUT';
        const loadoutSubtitle = document.querySelector('.loadout-subtitle');
        if (loadoutSubtitle) loadoutSubtitle.textContent = t['Prepare your cube, skill, and jokers'] || 'Prepare your cube, skill, and jokers';
        const loadoutStartBtnEl = document.getElementById('loadout-start-btn');
        if (loadoutStartBtnEl) loadoutStartBtnEl.textContent = t['START'] || 'START';
        const loadoutJokerBtnEl = document.getElementById('loadout-joker-btn');
        if (loadoutJokerBtnEl) loadoutJokerBtnEl.textContent = t['JOKER POWERS'] || 'JOKER POWERS';
        const loadoutSkillBtnEl = document.getElementById('loadout-skill-btn');
        if (loadoutSkillBtnEl) loadoutSkillBtnEl.textContent = t['SPECIAL SKILLS'] || 'SPECIAL SKILL';
        const loadoutUploadBtnEl = document.getElementById('loadout-upload-btn');
        if (loadoutUploadBtnEl) loadoutUploadBtnEl.textContent = t['UPLOAD IMAGE'] || 'UPLOAD IMAGE';
        const loadoutBackBtnEl = document.getElementById('loadout-back-btn');
        if (loadoutBackBtnEl) loadoutBackBtnEl.textContent = t['BACK'] || 'BACK';
        const loadoutSkillDoneBtnEl = document.getElementById('loadout-skill-done-btn');
        if (loadoutSkillDoneBtnEl) loadoutSkillDoneBtnEl.textContent = t['CONFIRM'] || 'CONFIRM';
        const loadoutJokerDoneBtnEl = document.getElementById('loadout-joker-done-btn');
        if (loadoutJokerDoneBtnEl) loadoutJokerDoneBtnEl.textContent = t['CONFIRM'] || 'CONFIRM';
        const loadoutSkillPanelTitle = document.querySelector('#loadout-skill-panel .collection-title');
        if (loadoutSkillPanelTitle) loadoutSkillPanelTitle.textContent = t['SPECIAL SKILLS'] || 'SPECIAL SKILLS';
        const loadoutJokerPanelTitle = document.querySelector('#loadout-joker-panel .collection-title');
        if (loadoutJokerPanelTitle) loadoutJokerPanelTitle.textContent = t['JOKER POWERS'] || 'JOKER POWERS';
        document.querySelectorAll('.loadout-summary-label').forEach((el, i) => {
            el.textContent = i === 0 ? (t['SKILL'] || 'SKILL') : (t['JOKERS'] || 'JOKERS');
        });
        const exitGameBtn = document.getElementById('exit-game-btn');
        if (exitGameBtn) exitGameBtn.textContent = t['EXIT GAME'] || 'EXIT GAME';
        const openSettingsBtn = document.getElementById('open-settings-btn');
        if (openSettingsBtn) openSettingsBtn.textContent = t['SETTINGS'] || 'SETTINGS';
        
        // Update gamemode button
        const openGamemodeBtn = document.getElementById('open-gamemode-btn');
        if (openGamemodeBtn) {
            const textKey = currentGamemode === 'normal' ? 'GAMEMODE: CLASSIC' : 'GAMEMODE: SIMPLISTIC';
            openGamemodeBtn.textContent = t[textKey] || textKey;
        }
        
        // Update gamemode menu buttons (CLASSIC/SIMPLISTIC)
        const gamemodeNormalBtn = document.getElementById('gamemode-normal-btn');
        if (gamemodeNormalBtn) gamemodeNormalBtn.textContent = t['CLASSIC'] || 'CLASSIC';
        const gamemodeSimplisticBtn = document.getElementById('gamemode-simplistic-btn');
        if (gamemodeSimplisticBtn) gamemodeSimplisticBtn.textContent = t['SIMPLISTIC'] || 'SIMPLISTIC';
        
        // Play / multiplayer difficulty buttons (stacked Online·Local labels applied below)
        const botEasyBtn = document.getElementById('bot-easy-btn');
        if (botEasyBtn) botEasyBtn.textContent = t['EASY'] || 'EASY';
        const botMediumBtn = document.getElementById('bot-medium-btn');
        if (botMediumBtn) botMediumBtn.textContent = t['MEDIUM'] || 'MEDIUM';
        const botHardBtn = document.getElementById('bot-hard-btn');
        if (botHardBtn) botHardBtn.textContent = t['HARD'] || 'HARD';
        const botInvincibleBtn = document.getElementById('bot-invincible-btn');
        if (botInvincibleBtn) botInvincibleBtn.textContent = t['INVINCIBLE'] || 'ELITE';
        syncSpectateMenuUI();
        // Pinkcore: stacked main+subtitle labels. Other themes: classic single-line labels only.
        const isPinkcore = document.body.classList.contains('theme-pinkcore');
        const setMenuBtnLabel = (id, mainKey, subKey, mainFallback, subFallback, classicKey, classicFallback) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            if (isPinkcore) {
                let mainEl = btn.querySelector('.btn-main');
                let subEl = btn.querySelector('.btn-sub');
                const main = t[mainKey] || t[classicKey] || mainFallback;
                const sub = t[subKey] || subFallback;
                if (!mainEl || !subEl) {
                    btn.textContent = '';
                    mainEl = document.createElement('span');
                    mainEl.className = 'btn-main';
                    subEl = document.createElement('span');
                    subEl.className = 'btn-sub';
                    btn.appendChild(mainEl);
                    btn.appendChild(subEl);
                }
                btn.classList.add('menu-btn-stack');
                mainEl.textContent = main;
                subEl.textContent = sub;
            } else {
                btn.classList.remove('menu-btn-stack');
                // textContent clears any leftover .btn-main / .btn-sub stack from a prior pinkcore visit
                const classic = t[classicKey] || classicFallback || classicKey;
                btn.textContent = classic;
            }
        };
        setMenuBtnLabel('start-btn', 'PLAY VS BOT', 'PLAY VS BOT SUB', 'PLAY VS BOT', 'Solo · fight AI', 'PLAY', 'PLAY');
        setMenuBtnLabel('multiplayer-tier-btn', 'MULTIPLAYER PVP', 'MULTIPLAYER PVP SUB', 'MULTIPLAYER PVP', 'Online or same-screen', 'MULTIPLAYER PVP', 'MULTIPLAYER PVP');
        setMenuBtnLabel('spectate-btn', 'SPECTATE', 'SPECTATE SUB', 'SPECTATE', 'AI vs AI · Steam friend', 'SPECTATE', 'SPECTATE');
        setMenuBtnLabel('spectate-bot-btn', 'SPECTATE AI', 'SPECTATE AI SUB', 'SPECTATE AI VS AI', 'Local · two bots fight', 'SPECTATE BOT', 'SPECTATE BOT');
        // Pinkcore main uses SPECTATE STEAM FRIEND; classic key SPECTATE FRIEND stays plain.
        setMenuBtnLabel('spectate-friend-btn', 'SPECTATE STEAM FRIEND', 'SPECTATE FRIEND SUB', 'SPECTATE STEAM FRIEND', 'Watch a friend online', 'SPECTATE FRIEND', 'SPECTATE FRIEND');
        setMenuBtnLabel('matchmake-btn', 'ONLINE MATCHMAKE', 'ONLINE MATCHMAKE SUB', 'ONLINE MATCHMAKE', 'Online PvP · random rival', 'ONLINE MATCHMAKE', 'ONLINE MATCHMAKE');
        setMenuBtnLabel('play-friend-btn', 'ONLINE WITH FRIEND', 'ONLINE WITH FRIEND SUB', 'ONLINE WITH FRIEND', 'Online PvP · host or join code', 'ONLINE WITH FRIEND', 'ONLINE WITH FRIEND');
        setMenuBtnLabel('multiplayer-btn', 'LOCAL PVP', 'LOCAL PVP SUB', 'LOCAL PVP', 'Same screen · 2 players', 'LOCAL PVP', 'LOCAL PVP');

        const playTierHint = document.getElementById('play-tier-hint');
        if (playTierHint) {
            playTierHint.textContent = t['PLAY TIER HINT'] || 'Pick how you want to fight';
            playTierHint.hidden = !isPinkcore;
            playTierHint.style.display = isPinkcore ? '' : 'none';
        }
        const multiplayerTierHint = document.getElementById('multiplayer-tier-hint');
        if (multiplayerTierHint) {
            multiplayerTierHint.textContent = t['MULTIPLAYER TIER HINT'] || 'Online PvP · Local shared-screen PvP';
            multiplayerTierHint.hidden = false;
            multiplayerTierHint.style.display = '';
            multiplayerTierHint.removeAttribute('hidden');
        }
        const spectateTierHint = document.getElementById('spectate-tier-hint');
        if (spectateTierHint) {
            spectateTierHint.textContent = t['SPECTATE TIER HINT'] || 'Watch a match — pick a mode';
            spectateTierHint.hidden = !isPinkcore;
            spectateTierHint.style.display = isPinkcore ? '' : 'none';
        }

        const matchmakeBackBtn = document.getElementById('matchmake-back-btn');
        if (matchmakeBackBtn) matchmakeBackBtn.textContent = t['BACK'] || 'BACK';
        const friendBackBtn = document.getElementById('friend-back-btn');
        if (friendBackBtn) friendBackBtn.textContent = t['BACK'] || 'BACK';
        
        const hostBtn = document.getElementById('host-btn');
        if (hostBtn) hostBtn.textContent = t['HOST'] || 'HOST';
        const connectBtn = document.getElementById('connect-btn');
        if (connectBtn) connectBtn.textContent = t['JOIN FRIEND'] || 'JOIN FRIEND';
        const findMatchBtn = document.getElementById('find-match-btn');
        if (findMatchBtn && findMatchBtn.textContent !== 'SEARCHING...') {
            findMatchBtn.textContent = t['FIND MATCH'] || 'FIND MATCH';
        }
        const cancelMatchBtn = document.getElementById('cancel-match-btn');
        if (cancelMatchBtn) cancelMatchBtn.textContent = t['CANCEL'] || 'CANCEL';
        const steamInviteBtn = document.getElementById('steam-invite-btn');
        if (steamInviteBtn) steamInviteBtn.textContent = t['INVITE STEAM FRIEND'] || 'INVITE STEAM FRIEND';
        const addSteamFriendBtn = document.getElementById('add-steam-friend-btn');
        if (addSteamFriendBtn) addSteamFriendBtn.textContent = t['ADD STEAM FRIEND'] || 'ADD STEAM FRIEND';
        const gameOverAddFriendBtn = document.getElementById('gameover-add-steam-friend-btn');
        if (gameOverAddFriendBtn) gameOverAddFriendBtn.textContent = t['ADD STEAM FRIEND'] || 'ADD STEAM FRIEND';
        const lobbyReportBtn = document.getElementById('lobby-report-btn');
        if (lobbyReportBtn) lobbyReportBtn.textContent = t['REPORT'] || 'REPORT';
        const hudReportBtn = document.getElementById('hud-report-btn');
        if (hudReportBtn) hudReportBtn.textContent = t['REPORT'] || 'REPORT';
        const gameOverReportBtn = document.getElementById('gameover-report-btn');
        if (gameOverReportBtn) gameOverReportBtn.textContent = t['REPORT RIVAL'] || 'REPORT RIVAL';

        const matchmakeNickname = document.getElementById('matchmake-nickname');
        if (matchmakeNickname) matchmakeNickname.placeholder = t['ENTER NICKNAME'] || 'ENTER NICKNAME';
        const friendNickname = document.getElementById('friend-nickname');
        if (friendNickname) friendNickname.placeholder = t['ENTER NICKNAME'] || 'ENTER NICKNAME';
        const joinId = document.getElementById('join-id');
        if (joinId) joinId.placeholder = t['FRIEND\'S ROOM CODE'] || 'FRIEND\'S ROOM CODE';

        const matchmakeTitle = document.querySelector('#online-matchmake h2');
        if (matchmakeTitle) {
            matchmakeTitle.textContent = isPinkcore
                ? (t['ONLINE MATCHMAKE'] || t['MATCHMAKE'] || 'ONLINE MATCHMAKE')
                : (t['MATCHMAKE'] || 'MATCHMAKE');
        }
        const friendTitle = document.querySelector('#online-friends h2');
        if (friendTitle) {
            friendTitle.textContent = isPinkcore
                ? (t['ONLINE WITH FRIEND'] || t['PLAY WITH FRIEND'] || 'ONLINE WITH FRIEND')
                : (t['PLAY WITH FRIEND'] || 'PLAY WITH FRIEND');
        }
        const matchmakeKicker = document.querySelector('#online-matchmake .mp-panel-kicker');
        if (matchmakeKicker) matchmakeKicker.textContent = isPinkcore ? (t['ONLINE PVP'] || 'ONLINE PVP') : (t['ONLINE'] || 'ONLINE');
        const friendKicker = document.querySelector('#online-friends .mp-panel-kicker');
        if (friendKicker) friendKicker.textContent = isPinkcore ? (t['ONLINE PVP'] || 'ONLINE PVP') : (t['ONLINE'] || 'ONLINE');
        const matchmakeDesc = document.querySelector('#online-matchmake .online-mode-desc');
        if (matchmakeDesc) {
            matchmakeDesc.textContent = isPinkcore
                ? (t['ONLINE MATCHMAKE DESC'] || 'Online PvP — find a random opponent on the internet.')
                : (t['Play online against a random opponent.'] || 'Play online against a random opponent.');
        }
        const friendDesc = document.querySelector('#online-friends .online-mode-desc');
        if (friendDesc) {
            friendDesc.textContent = isPinkcore
                ? (t['ONLINE WITH FRIEND DESC'] || 'Online PvP — host a private room or join with a friend\'s code.')
                : (t['Host a private room or join with a friend\'s code.'] || 'Host a private room or join with a friend\'s code.');
        }

        document.querySelectorAll('.back-tier-btn').forEach(btn => {
            btn.textContent = t['BACK'] || 'BACK';
        });
        
        // Update waiting room buttons
        const waitingChangeBtn = document.getElementById('waiting-change-btn');
        if (waitingChangeBtn) waitingChangeBtn.textContent = t['CHANGE CUBE'] || 'CHANGE CUBE';
        const readyBtn = document.getElementById('ready-btn');
        if (readyBtn) readyBtn.textContent = t['READY'] || 'READY';
        const copyLinkBtn = document.getElementById('copy-link-btn');
        if (copyLinkBtn) copyLinkBtn.textContent = t['COPY JOIN LINK'] || 'COPY JOIN LINK';
        const waitingExitBtn = document.getElementById('waiting-exit-btn');
        if (waitingExitBtn) waitingExitBtn.textContent = t['EXIT LOBBY'] || 'EXIT LOBBY';
        
        // Update custom page button
        const closeCustomBtn = document.getElementById('close-custom-btn');
        if (closeCustomBtn) closeCustomBtn.textContent = t['CONFIRM COLOUR'] || 'CONFIRM COLOUR';
        
        // Update intro overlay
        const introStartBtn = document.getElementById('intro-start-btn');
        if (introStartBtn) introStartBtn.textContent = t['ENTER GAME'] || 'ENTER GAME';
        const introSkipHint = document.getElementById('intro-skip-hint');
        if (introSkipHint) introSkipHint.textContent = t['CLICK TO SKIP'] || 'CLICK TO SKIP';

        const tutorialGatePlayBtn = document.getElementById('tutorial-gate-play-btn');
        if (tutorialGatePlayBtn) tutorialGatePlayBtn.textContent = t['TUTORIAL'] || 'TUTORIAL';
        const tutorialGateSkipBtn = document.getElementById('tutorial-gate-skip-btn');
        if (tutorialGateSkipBtn) tutorialGateSkipBtn.textContent = t['SKIP TUTORIAL'] || 'SKIP TUTORIAL';
        const tutorialGateSubtitle = document.getElementById('tutorial-gate-subtitle');
        if (tutorialGateSubtitle) tutorialGateSubtitle.textContent = t['TUTORIAL_GATE_SUBTITLE'] || t['NEW PLAYER TRAINING'] || '9 boards · checkpoints · new ways to win';

        updatePlayUnlockHintText();
        
        // Update lobby text
        const matchmakeStatus = document.getElementById('matchmake-status');
        if (matchmakeStatus) matchmakeStatus.textContent = t['READY'] || 'READY';
        const friendStatus = document.getElementById('friend-status');
        if (friendStatus) friendStatus.textContent = t['HOST OR JOIN A FRIEND'] || 'HOST OR JOIN A FRIEND';
        
        // Update settings page section headers
        const settingsSections = document.querySelectorAll('.settings-section h3');
        if (settingsSections[0]) settingsSections[0].textContent = t['CONTROLS'] || 'CONTROLS';
        if (settingsSections[1]) settingsSections[1].textContent = t['VOLUME'] || 'VOLUME';
        if (settingsSections[2]) settingsSections[2].textContent = t['LANGUAGE'] || 'LANGUAGE';
        if (settingsSections[3]) settingsSections[3].textContent = t['RESOLUTION'] || 'RESOLUTION';
        const profileHeader = document.querySelector('#player-meta-section h3');
        if (profileHeader) profileHeader.textContent = t['PROFILE & CHALLENGES'] || 'PROFILE & CHALLENGES';
        const legalHeader = document.querySelector('.settings-legal-section h3');
        if (legalHeader) legalHeader.textContent = t['LEGAL'] || 'LEGAL';
        const legalNotice = document.querySelector('.settings-legal-small');
        if (legalNotice) legalNotice.textContent = t['LEGAL_NOTICE'] || legalNotice.textContent;
        
        // Update control labels
        const controlLabels = document.querySelectorAll('.control-item label');
        const controlKeys = ['Move Up', 'Move Down', 'Move Left', 'Move Right', 'Dash', 'Charge', 'Skill', 'Pause'];
        controlLabels.forEach((el, i) => {
            if (controlKeys[i] && t[controlKeys[i]]) el.textContent = t[controlKeys[i]];
        });
        
        // Update volume labels
        const volumeLabels = document.querySelectorAll('.volume-item label');
        const volumeKeys = ['Master Volume', 'Music Volume', 'SFX Volume', 'Sound'];
        volumeLabels.forEach((el, i) => {
            if (volumeKeys[i] && t[volumeKeys[i]]) el.textContent = t[volumeKeys[i]];
        });
        
        // Update close buttons
        const closeSettingsBtn = document.getElementById('close-settings-btn');
        if (closeSettingsBtn) closeSettingsBtn.textContent = t['SAVE'] || 'SAVE';
        
        // Update page titles
        const settingsTitle = document.querySelector('#settings-page h2');
        if (settingsTitle) settingsTitle.textContent = t['SETTINGS'] || 'SETTINGS';
        
        // Update custom page title
        const customTitle = document.getElementById('custom-title');
        if (customTitle) customTitle.textContent = t['CUSTOMIZE CUBE'] || 'CUSTOMIZE CUBE';
        

        // Update waiting room title
        const waitingRoomTitle = document.querySelector('#waiting-room h2');
        if (waitingRoomTitle) waitingRoomTitle.textContent = t['WAITING ROOM'] || 'WAITING ROOM';
        
        // Update waiting room labels
        const selfSlotLabel = document.querySelector('#self-slot .slot-label');
        if (selfSlotLabel) selfSlotLabel.textContent = t['YOU'] || 'YOU';
        const enemySlotLabel = document.querySelector('#enemy-slot .slot-label');
        if (enemySlotLabel) enemySlotLabel.textContent = t['ENEMY'] || 'ENEMY';
        const enemyName = document.getElementById('enemy-name');
        if (enemyName) enemyName.textContent = t['WAITING...'] || 'WAITING...';
        const selfReady = document.getElementById('self-ready');
        if (selfReady) selfReady.textContent = t['NOT READY'] || 'NOT READY';
        const enemyReady = document.getElementById('enemy-ready');
        if (enemyReady) enemyReady.textContent = t['NOT READY'] || 'NOT READY';
        
        // Update waiting room labels
        // Update tutorial overlay if active (fight brief uses START, practice hides the button)
        if (typeof shouldShowTutorialOverlay === 'function' && shouldShowTutorialOverlay()) {
            updateTutorialUI(tutorialStep);
        } else if (typeof isTutorialActive !== 'undefined' && isTutorialActive) {
            updateTutorialText(tutorialStep, lang);
        }

        // Update pause menu
        const pauseMenuH2 = document.querySelector('#pause-menu h2');
        if (pauseMenuH2) pauseMenuH2.textContent = t['PAUSED'] || 'PAUSED';
        const resumeBtn = document.getElementById('resume-btn');
        if (resumeBtn) resumeBtn.textContent = t['RESUME'] || 'RESUME';
        const pauseSettingsBtn = document.getElementById('pause-settings-btn');
        if (pauseSettingsBtn) pauseSettingsBtn.textContent = t['SETTINGS'] || 'SETTINGS';
        const pauseBackToMenuBtn = document.getElementById('pause-back-to-menu-btn');
        if (pauseBackToMenuBtn) pauseBackToMenuBtn.textContent = t['QUIT TO MENU'] || 'QUIT TO MENU';
        
        // Update game over buttons
        const continueBtn = document.getElementById('continue-btn');
        if (continueBtn) continueBtn.textContent = t['CONTINUE'] || 'CONTINUE';
        const voteStatus = document.getElementById('vote-status');
        if (voteStatus) voteStatus.textContent = t['WAITING FOR RIVAL...'] || 'WAITING FOR RIVAL...';
        const restartBtn = document.getElementById('restart-btn');
        if (restartBtn) restartBtn.textContent = t['PLAY AGAIN'] || 'PLAY AGAIN';
        const backToMenuBtn = document.getElementById('back-to-menu-btn');
        if (backToMenuBtn) backToMenuBtn.textContent = t['MENU'] || 'MENU';

        // Update in-game DASH/CHARGE/SKILL buttons (keyboard labels; gamepad overrides via updateActionPromptLabels)
        updateActionPromptLabels();

        // Update skill preview and joker grid
        updateSkillPreview();
        renderJokersGrid();
        updateLoadoutSummary();
    }

    const languageSelect = document.getElementById('language-select');
    if (languageSelect) {
        languageSelect.addEventListener('change', (e) => {
            const language = e.target.value;
            localStorage.setItem('ronk_language', language);
            applyLanguage(language);
        });
    }

    // Load saved jokers on page load
    const savedJokerOnLoad = localStorage.getItem('ronk_selectedJoker');
    if (savedJokerOnLoad) {
        try {
            p1SelectedJoker = JSON.parse(savedJokerOnLoad);
            if (!Array.isArray(p1SelectedJoker)) {
                p1SelectedJoker = p1SelectedJoker ? [p1SelectedJoker] : [];
            }
        } catch (e) {
            p1SelectedJoker = savedJokerOnLoad ? [savedJokerOnLoad] : [];
        }
    } else {
        p1SelectedJoker = [];
    }
    hydrateUnlockProgressFromStorage();
    // Apply saved language on page load
    const savedLanguageOnLoad = localStorage.getItem('ronk_language') || 'en';
    syncLanguageSelectLabels();
    applyLanguage(savedLanguageOnLoad);

    // Settings sound toggle functionality
    const settingsSoundToggleBtn = document.getElementById('settings-sound-toggle-btn');
    if (settingsSoundToggleBtn) {
        settingsSoundToggleBtn.addEventListener('click', () => {
            SFX.enabled = !SFX.enabled;
            updateSettingsSoundButton();
            SFX.play('button');
        });
    }

    function updateSettingsSoundButton() {
        const settingsSoundToggleBtn = document.getElementById('settings-sound-toggle-btn');
        if (settingsSoundToggleBtn) {
            if (SFX.enabled) {
                settingsSoundToggleBtn.textContent = 'ON';
                settingsSoundToggleBtn.classList.remove('off');
            } else {
                settingsSoundToggleBtn.textContent = 'OFF';
                settingsSoundToggleBtn.classList.add('off');
            }
        }
    }

    function loadSettings() {
        // Load saved settings
        const savedControls = JSON.parse(localStorage.getItem('ronk_controls') || '{}');
        const savedVolume = JSON.parse(localStorage.getItem('ronk_volume') || '{}');
        const savedLanguage = localStorage.getItem('ronk_language') || 'en';
        const savedResolution = normalizeResolution(localStorage.getItem('ronk_resolution'));

        // Load controls
        controlInputs.forEach(id => {
            const input = document.getElementById(id);
            if (input) {
                const key = id.replace('control-', '');
                input.value = savedControls[key] || getDefaultControl(key);
            }
        });

        // Load volume
        const masterPref = Number.isFinite(Number(savedVolume.master)) ? Number(savedVolume.master) : 70;
        const musicPref = Number.isFinite(Number(savedVolume.music)) ? Number(savedVolume.music) : 60;
        const sfxPref = Number.isFinite(Number(savedVolume.sfx)) ? Number(savedVolume.sfx) : 80;
        if (volumeMaster) volumeMaster.value = masterPref;
        if (volumeMasterValue) volumeMasterValue.textContent = masterPref + '%';
        if (volumeMusic) volumeMusic.value = musicPref;
        if (volumeMusicValue) volumeMusicValue.textContent = musicPref + '%';
        if (volumeSfx) volumeSfx.value = sfxPref;
        if (volumeSfxValue) volumeSfxValue.textContent = sfxPref + '%';

        // Load language
        if (languageSelect) languageSelect.value = savedLanguage;
        applyLanguage(savedLanguage);

        // Load resolution
        const resolutionSelect = document.getElementById('resolution-select');
        if (resolutionSelect) resolutionSelect.value = savedResolution;

        // Update sound toggle button
        updateSettingsSoundButton();
        refreshPlayerMetaPanel();

        // Apply volume settings
        applyVolume();

        // Ensure music keeps playing when entering settings (including from pause)
        if (Music.enabled && introFinished) {
            Music.ensurePlaying();
        }
        applyVolume();
    }

    function saveSettings() {
        // Save controls
        const controls = {};
        controlInputs.forEach(id => {
            const input = document.getElementById(id);
            if (input) {
                const key = id.replace('control-', '');
                controls[key] = input.value;
            }
        });

        // Save volume
        const volume = {
            master: volumeMaster ? volumeMaster.value : 70,
            music: volumeMusic ? volumeMusic.value : 60,
            sfx: volumeSfx ? volumeSfx.value : 80
        };

        // Save resolution
        const resolutionSelect = document.getElementById('resolution-select');
        const resolution = normalizeResolution(resolutionSelect ? resolutionSelect.value : DEFAULT_RESOLUTION);
        localStorage.setItem('ronk_resolution', resolution);
        if (resolution === '480p') localStorage.setItem('ronk_keep_480p', '1');
        else localStorage.removeItem('ronk_keep_480p');

        // Apply resolution change immediately
        applyResolution(resolution);

        // Save to localStorage
        localStorage.setItem('ronk_controls', JSON.stringify(controls));
        bustRonkControlsCache();
        localStorage.setItem('ronk_volume', JSON.stringify(volume));
    }
    persistGameSettings = saveSettings;

    function getDefaultControl(key) {
        const defaults = {
            up: 'W',
            down: 'S',
            left: 'A',
            right: 'D',
            dash: 'F',
            charge: 'C',
            skill: 'Y',
            pause: 'ESC'
        };
        return defaults[key] || '?';
    }

    const soundToggleBtn = document.getElementById('sound-toggle-btn');
    if (soundToggleBtn) {
        soundToggleBtn.addEventListener('click', () => {
            SFX.enabled = !SFX.enabled;
            updateSoundButtons();
            if (SFX.enabled) SFX.init();
        });
    }

    // Online matchmake / friend / local PvP — routed via #menu click delegation

    const findMatchBtn = document.getElementById('find-match-btn');
    if (findMatchBtn) {
        findMatchBtn.addEventListener('click', () => startMatchmaking());
    }

    const cancelMatchBtn = document.getElementById('cancel-match-btn');
    if (cancelMatchBtn) {
        cancelMatchBtn.addEventListener('click', () => cancelMatchmaking());
    }

    const matchmakeBackBtn = document.getElementById('matchmake-back-btn');
    if (matchmakeBackBtn) {
        matchmakeBackBtn.addEventListener('click', () => {
            cancelMatchmaking();
            hideOverlayPanel(onlineMatchmakePanel);
            showMainMenu();
            showTier('multiplayer-menu-tier');
        });
    }

    const friendBackBtn = document.getElementById('friend-back-btn');
    if (friendBackBtn) {
        friendBackBtn.addEventListener('click', () => {
            if (steamBridge) steamBridge.leaveLobby();
            hideOverlayPanel(onlineFriendsPanel);
            showMainMenu();
            showTier('multiplayer-menu-tier');
        });
    }

    const steamInviteBtn = document.getElementById('steam-invite-btn');
    if (steamInviteBtn) {
        steamInviteBtn.addEventListener('click', () => {
            if (steamBridge) steamBridge.inviteFriends();
        });
    }

    const addSteamFriendBtn = document.getElementById('add-steam-friend-btn');
    if (addSteamFriendBtn) {
        addSteamFriendBtn.addEventListener('click', () => addSteamFriendFromMatch());
    }

    const gameOverAddFriendBtn = document.getElementById('gameover-add-steam-friend-btn');
    if (gameOverAddFriendBtn) {
        gameOverAddFriendBtn.addEventListener('click', () => addSteamFriendFromMatch());
    }

    const hostBtn = document.getElementById('host-btn');
    if (hostBtn) {
        hostBtn.addEventListener('click', () => hostFriendRoom());
    }

    if (connectBtn) {
        connectBtn.addEventListener('click', () => {
            syncNicknameFromInputs();
            const roomName = joinIdInput.value.trim().toLowerCase();
            onlineMatchMode = 'friends';
            joinRoom(roomName);
        });
    }

    const urlParams = new URLSearchParams(window.location.search);
    const urlRoom = urlParams.get('room');
    if (urlRoom) {
        setTimeout(() => {
            if (joinIdInput) joinIdInput.value = urlRoom;
            if (menu) hideOverlayPanel(menu);
            if (onlineFriendsPanel) openOnlinePanel(onlineFriendsPanel, 'friend');
            onlineMatchMode = 'friends';
            joinRoom(urlRoom);
        }, 500);
    }

    if (prevColorBtn) {
        prevColorBtn.addEventListener('click', () => {
            SFX.play('button');
            cycleCubeColor(-1);
        });
    }

    if (nextColorBtn) {
        nextColorBtn.addEventListener('click', () => {
            SFX.play('button');
            cycleCubeColor(1);
        });
    }

    if (colorPreview) {
        colorPreview.addEventListener('click', () => {
            if (currentColorIndex === neonColors.length - 1) {
                const imageInput = document.getElementById('cube-image-input');
                if (imageInput) imageInput.click();
            }
        });
    }

    const imageInput = document.getElementById('cube-image-input');
    if (imageInput) {
        imageInput.addEventListener('change', (e) => {
            handleCubeImageFile(e.target.files[0]);
            e.target.value = '';
        });
    }

    if (mainPlayBtn) {
        mainPlayBtn.addEventListener('click', () => {
            handleMainPlayClick();
        });
    }

    const startSpectateBtn = document.getElementById('start-spectate-btn');
    if (startSpectateBtn) {
        startSpectateBtn.addEventListener('click', () => {
            SFX.play('button');
            syncSpectateMenuUI();
            showTier('spectate-choice-tier');
        });
    }

    const singlePlayerBtn = document.getElementById('single-player-btn');
    if (singlePlayerBtn) {
        singlePlayerBtn.addEventListener('click', () => {
            SFX.play('button');
            pendingPlayPath = 'solo';
            showLoadoutPage({ mode: 'single', path: 'solo' });
        });
    }

    const multiplayerModeBtn = document.getElementById('multiplayer-mode-btn');
    if (multiplayerModeBtn) {
        multiplayerModeBtn.addEventListener('click', () => {
            SFX.play('button');
            showTier('multiplayer-menu-tier');
        });
    }

    // Gamemode selection
    const openGamemodeBtn = document.getElementById('open-gamemode-btn');
    const gamemodeNormalBtn = document.getElementById('gamemode-normal-btn');
    const gamemodeSimplisticBtn = document.getElementById('gamemode-simplistic-btn');
    
    if (openGamemodeBtn) {
        openGamemodeBtn.addEventListener('click', () => {
            showTier('gamemode-menu-tier');
        });
    }
    
    if (gamemodeNormalBtn) {
        gamemodeNormalBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            selectGamemode('normal');
        });
    }
    
    if (gamemodeSimplisticBtn) {
        gamemodeSimplisticBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            selectGamemode('simplistic');
        });
    }

    function selectGamemode(mode) {
        
        // Set the gamemode
        currentGamemode = mode;
        
        // Update the button text with translation
        const openGamemodeBtn = document.getElementById('open-gamemode-btn');
        if (openGamemodeBtn) {
            const savedLanguage = localStorage.getItem('ronk_language') || 'en';
            const t = translations[savedLanguage] || translations['en'];
            const textKey = mode === 'normal' ? 'GAMEMODE: CLASSIC' : 'GAMEMODE: SIMPLISTIC';
            openGamemodeBtn.textContent = t[textKey] || textKey;
        }
        
        // Add/remove simplistic-mode class on body for CSS-based hiding
        if (mode === 'simplistic') {
            document.body.classList.add('simplistic-mode');
        } else {
            document.body.classList.remove('simplistic-mode');
        }
        
        // Hide all tiers and show main menu
        showTier('main-menu-tier');
    }

    if (multiplayerTierBtn) {
        multiplayerTierBtn.addEventListener('click', (e) => {
            showTier('multiplayer-menu-tier');
        });
    }

    updateBotDifficultyUI();

    BOT_DIFFICULTY_KEYS.forEach((level) => {
        const btn = document.getElementById(`bot-${level}-btn`);
        if (btn) {
            btn.addEventListener('click', () => {
                setBotDifficulty(level);
                returnToLobbyState({ stopLoop: true });
                launchGameMode({ spectate: false, multiplayer: false });
            });
        }
    });

    if (backTierBtns) {
        backTierBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const target = btn.dataset.back;
                if (target === 'loadout-page') {
                    const mode = (pendingPlayPath === 'local-pvp') ? 'dual' : 'single';
                    showLoadoutPage({ mode, path: pendingPlayPath || 'solo' });
                } else if (target) {
                    showTier(target);
                }
            });
        });
    }

    if (startBtn) {
        startBtn.style.pointerEvents = 'auto';
        startBtn.style.cursor = 'pointer';
    }

    if (multiplayerBtn) {
        multiplayerBtn.style.pointerEvents = 'auto';
        multiplayerBtn.style.cursor = 'pointer';
    }

    if (spectateBtn) {
        spectateBtn.style.pointerEvents = 'auto';
        spectateBtn.style.cursor = 'pointer';
    }

    // Menu click delegation — reliable even if tier buttons re-render
    if (menu) {
        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.id === 'start-btn') {
                e.preventDefault();
                e.stopPropagation();
                showTier('bot-difficulty-tier');
                updateBotDifficultyUI();
            } else if (btn.id === 'main-tutorial-btn') {
                e.preventDefault();
                e.stopPropagation();
                SFX.play('button');
                openTutorialGateExact();
            } else if (btn.id === 'start-spectate-btn' || btn.id === 'spectate-btn') {
                e.preventDefault();
                e.stopPropagation();
                syncSpectateMenuUI();
                showTier('spectate-choice-tier');
            } else if (btn.id === 'single-player-btn') {
                e.preventDefault();
                e.stopPropagation();
                pendingPlayPath = 'solo';
                showLoadoutPage({ mode: 'single', path: 'solo' });
            } else if (btn.id === 'multiplayer-mode-btn') {
                e.preventDefault();
                e.stopPropagation();
                showTier('multiplayer-menu-tier');
            } else if (btn.id === 'spectate-bot-btn') {
                e.preventDefault();
                e.stopPropagation();
                setBotDifficulty('invincible');
                window.RonkSteamAchievements?.onSpectateAiStarted?.();
                launchGameMode({ spectate: true, multiplayer: false });
            } else if (btn.id === 'spectate-friend-btn') {
                e.preventDefault();
                e.stopPropagation();
                // Stub only — do NOT grant ACH_SPECTATE_FRIEND for a toast
                startSpectateFriendFlow();
            } else if (btn.id === 'multiplayer-btn') {
                e.preventDefault();
                e.stopPropagation();
                pendingPlayPath = 'local-pvp';
                showLoadoutPage({ mode: 'dual', path: 'local-pvp' });
            } else if (btn.id === 'matchmake-btn') {
                e.preventDefault();
                e.stopPropagation();
                pendingPlayPath = 'online-matchmake';
                showLoadoutPage({ mode: 'single', path: 'online-matchmake' });
            } else if (btn.id === 'play-friend-btn') {
                e.preventDefault();
                e.stopPropagation();
                pendingPlayPath = 'online-friend';
                showLoadoutPage({ mode: 'single', path: 'online-friend' });
            }
        });
    }

    if (openCustomBtn) {
        openCustomBtn.addEventListener('click', () => {
            forceHideMenu();
            showOverlayPanel(customPage);
            setActiveNavigation('custom');
        });
    }

    if (closeCustomBtn) {
        closeCustomBtn.addEventListener('click', () => {
            hideOverlayPanel(customPage);
            showMainMenu();
            resetToMainTier();
        });
    }

    if (restartBtn) {
        restartBtn.addEventListener('click', () => {
            if (returnToMenuAfterGameOver) {
                returnToMenuAfterGameOver = false;
                returnToLobbyState({ stopLoop: true });
                showMainMenu();
                resetToMainTier();
                return;
            }
            // NEW MATCH / TRY AGAIN must wipe match scores or the next death
            // immediately re-triggers GAME_OVER from the previous final score.
            resetMatchScoreState();
            if (gameOverDiv) gameOverDiv.classList.add('hidden');
            if (gameOverHintEl) {
                gameOverHintEl.textContent = '';
                gameOverHintEl.classList.add('hidden');
            }
            initGame();
        });
    }
    
    if (backToMenuBtn) {
        backToMenuBtn.addEventListener('click', () => {
            gameState = 'LOBBY';
            clearRoundEndTimer();
            showMainMenu();
            resetToMainTier();
            if (animLoop) cancelAnimationFrame(animLoop);
            
            if (Music.enabled) {
                SFX.init();
                Music.init();
                Music.ensurePlaying();
            }
        });
    }

    // Pause Menu Listeners
    const resumeBtn = document.getElementById('resume-btn');
    const pauseSettingsBtn = document.getElementById('pause-settings-btn');
    const pauseBackToMenuBtn = document.getElementById('pause-back-to-menu-btn');

    if (resumeBtn) {
        resumeBtn.addEventListener('click', () => {
            settingsOpenedFromPause = false;
            setGamePaused(false, true);
        });
    }

    if (pauseSettingsBtn) {
        pauseSettingsBtn.addEventListener('click', () => {
            SFX.play('button');
            openSettingsFromPause();
        });
    }

    if (pauseBackToMenuBtn) {
        pauseBackToMenuBtn.addEventListener('click', () => {
            if (isOnline) {
                if (typeof enqueueGameNotification === 'function') {
                    enqueueGameNotification({
                        kicker: 'Online',
                        title: 'No quit mid-match',
                        body: 'Finish the online match first. Closing the game disconnects.',
                        duration: 2800
                    });
                }
                return;
            }
            settingsOpenedFromPause = false;
            isPaused = false;
            isResuming = false;
            gameState = 'LOBBY';
            SFX.stopAll();
            clearRoundEndTimer();
            if (pauseMenu) {
                pauseMenu.classList.add('hidden');
                pauseMenu.style.display = 'none';
            }
            showMainMenu();
            resetToMainTier();
            if (gameLoop) clearInterval(gameLoop);
            if (animLoop) cancelAnimationFrame(animLoop);

            const roundAnnouncer = document.getElementById('round-announcer');
            if (roundAnnouncer) roundAnnouncer.classList.add('hidden');

            if (Music.enabled) {
                SFX.init();
                Music.init();
                Music.ensurePlaying();
            }
        });
    }

    if (p1SkillLetter) {
        p1SkillLetter.style.cursor = 'pointer';
        p1SkillLetter.title = 'Activate skill';
        p1SkillLetter.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            applyPlayerActionInput(p1, 'skill');
        });
    }
    const bindHudAction = (el, playerGetter, action, title) => {
        if (!el) return;
        el.style.cursor = 'pointer';
        if (title) el.title = title;
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            applyPlayerActionInput(playerGetter(), action);
        });
    };
    bindHudAction(p1DashLetter, () => p1, 'dash', 'Dash');
    bindHudAction(p1ChargeLetter, () => p1, 'charge', 'Charge');
    bindHudAction(p2DashLetter, () => p2, 'dash', 'Dash');
    bindHudAction(p2ChargeLetter, () => p2, 'charge', 'Charge');
    bindHudAction(p2SkillLetter, () => p2, 'skill', 'Activate skill');


    // Tutorial — fight brief auto-dismisses; no manual advance during practice
    const tutorialNextBtn = document.getElementById('tutorial-next');
    if (tutorialNextBtn) {
        tutorialNextBtn.addEventListener('click', () => {
            if (!isTutorialFightWaiting()) return;
            SFX.play('button');
            startTutorialFight();
        });
    }

    window.addEventListener('keydown', e => {
        const key = e.key.toLowerCase();

        if (steamScreenshotMode && key === 'f9') {
            if (e.repeat) return;
            e.preventDefault();
            captureSteamScreenshotManual();
            return;
        }
        
        // Get custom pause key from settings
        const savedCtrl = getRonkControlsParsed();
        const pauseKey = (savedCtrl.pause || 'esc').toLowerCase();
        
        // Esc / pause key: in-match → toggle pause menu; outside game → Settings
        // Never exits fullscreen — only the FULLSCREEN/WINDOW button does that.
        if (key === 'escape' || key === 'esc' || key === pauseKey) {
            if (e.repeat) return;
            e.preventDefault();
            e.stopPropagation();
            togglePauseFromInput();
            return;
        }

        keys[key] = true;

        // Spectate free-cam: WASD moves which board you watch (no AI board snap)
        if (isSpectateMode && handleSpectateViewInput(key)) {
            e.preventDefault();
            return;
        }
        
        // Block all gameplay inputs during countdown, if paused, or while resuming
        if (gameState !== 'PLAYING' || isPaused || isResuming) return;

        const skillKey = (savedCtrl.skill || 'y').toLowerCase();
        const isActionRepeat = e.repeat;

        const steerFromKey = (player, controlKey) => {
            if (key !== controlKey) return false;
            player._lastDirKey = key;
            applyPlayerDirectionInput(player, directionLabelForKey(player, key), { flashKey: key });
            return true;
        };

        // Online: WASD / custom binds always drive YOUR cube (host=p1, guest=p2).
        if (isOnline && !isSpectateMode) {
            const local = getLocalHumanPlayer();
            if (local && !local.isAI && !local.isDead && local.controls) {
                const c = local.controls;
                if (steerFromKey(local, c.up) || steerFromKey(local, c.down)
                    || steerFromKey(local, c.left) || steerFromKey(local, c.right)) {
                    return;
                }
                if (!isActionRepeat) {
                    if (key === c.dash || key === 'f') applyPlayerActionInput(local, 'dash');
                    if (key === c.charge || key === 'c') applyPlayerActionInput(local, 'charge');
                    if (key === skillKey || key === 'y') local.activateSkill();
                }
            }
            return;
        }

        if (p1 && !p1.isAI && !p1.isDead) {
            const chargeTutorialOnly = isTutorialChargePracticeStep();
            const trailDemoOnly = isTutorialTrailDemoStep();

            if (!chargeTutorialOnly && !trailDemoOnly) {
                const c = p1.controls;
                if (steerFromKey(p1, c.up) || steerFromKey(p1, c.down)
                    || steerFromKey(p1, c.left) || steerFromKey(p1, c.right)) {
                    return;
                }
            }

            if (!isActionRepeat) {
                if (!chargeTutorialOnly && !trailDemoOnly && (key === p1.controls.dash || key === 'f')) {
                    applyPlayerActionInput(p1, 'dash');
                }
                if (!trailDemoOnly && (key === p1.controls.charge || key === 'c')) {
                    applyPlayerActionInput(p1, 'charge');
                }
                if (isTutorialSkillPracticeStep()) {
                    if (key === 'y' || key === skillKey) {
                        flashTutorialKey(key === 'y' ? 'y' : skillKey);
                        p1.selectedSkill = SKILL_TYPES.CLONES;
                        p1.lastSkillUsed = 0;
                        p1.activateSkill();
                    }
                } else if (key === skillKey || key === 'y') {
                    p1.activateSkill();
                }
            }
        }
        
        if (p2 && !p2.isAI && !p2.isDead) {
            const c = p2.controls;
            if (steerFromKey(p2, c.up) || steerFromKey(p2, c.down)
                || steerFromKey(p2, c.left) || steerFromKey(p2, c.right)) {
                return;
            }
            if (!isActionRepeat) {
                if (key === c.dash) p2.dash();
                if (key === c.charge) p2.charge();
                if (key === (c.skill || 'control')) p2.activateSkill();
            }
        }
    });

    window.addEventListener('keyup', e => {
        const key = e.key.toLowerCase();
        keys[key] = false;
        keys[e.key] = false;
        if (p1 && !p1.isAI && directionLabelForKey(p1, key)) refreshPlayerLastDirKey(p1);
        if (p2 && !p2.isAI && directionLabelForKey(p2, key)) refreshPlayerLastDirKey(p2);
        if (isOnline && !isSpectateMode) {
            const local = getLocalHumanPlayer();
            if (local && directionLabelForKey(local, key)) refreshPlayerLastDirKey(local);
        }
    });

    window.addEventListener('resize', scheduleResizeCanvas);

    // Keep music / AudioContext alive after any user gesture (autoplay + long-session recover)
    let _lastMusicGestureAt = 0;
    const nudgeMusicFromGesture = () => {
        const now = Date.now();
        if (now - _lastMusicGestureAt < 400) return;
        _lastMusicGestureAt = now;
        // Unlock SFX AudioContext on first gesture (separate from Music's context)
        try { SFX.unlock(); } catch (_) { try { SFX.init(); } catch (__) {} }
        Music.init();
        Music._resumeCtx();
        // Keep BGM alive through pause menu gestures; skip only when tab is hidden
        if (Music.enabled && introFinished && !document.hidden) {
            Music.ensurePlaying();
        }
    };
    document.addEventListener('pointerdown', nudgeMusicFromGesture, { passive: true });
    document.addEventListener('keydown', nudgeMusicFromGesture, { passive: true });
    // Earliest possible unlock — before click handlers that play button SFX
    document.addEventListener('pointerdown', () => { try { SFX.unlock(); } catch (_) {} }, { passive: true, capture: true });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            forcePauseOnLeave();
            if (animLoop) {
                cancelAnimationFrame(animLoop);
                animLoop = null;
            }
            // Outside active gameplay, pause music cleanly on hide to avoid
            // Steam overlay / background glitches stacking on resume.
            if (!canPauseGameplay() && Music.currentAudio && !Music.currentAudio.paused) {
                Music.pause();
                Music._pausedByVisibility = true;
            }
        } else {
            if (Music._pausedByVisibility && Music.enabled && introFinished && !isPaused) {
                Music._pausedByVisibility = false;
                Music.ensurePlaying();
            }
            try { healThemeBackgroundIfNeeded(); } catch (_) { /* ignore */ }
            try {
                if (document.body.classList.contains('theme-pixel')) ensurePixelFlappyRunning();
            } catch (_) { /* ignore */ }
            try { scheduleGamepadPoll(); } catch (_) { /* ignore */ }
            try {
                const liq = document.querySelector('.liquid-container canvas');
                if (liq && liq.__ronkLiquidRestart) liq.__ronkLiquidRestart();
            } catch (_) { /* ignore */ }
            if (isLoadoutPageVisible()) {
                try { startLoadoutCubeRender(); } catch (_) { /* ignore */ }
            }
            const liveMatch = gameState === 'PLAYING' || gameState === 'COUNTDOWN'
                || gameState === 'ROUND_OVER' || gameState === 'GAME_OVER' || gameState === 'TUTORIAL';
            if (!animLoop && liveMatch && document.body.classList.contains('in-game')) {
                lastFrameTime = performance.now();
                animate(lastFrameTime);
            }
        }
    });

    window.addEventListener('pagehide', () => {
        forcePauseOnLeave();
    });

    window.addEventListener('blur', () => {
        requestAnimationFrame(() => {
            if (!document.hasFocus()) forcePauseOnLeave();
        });
    });

    window.addEventListener('focus', () => {
        // Recover from silent AudioContext/SFX state; music is HTMLAudio-based
        // but ensurePlaying still heals paused orphans after overlay focus loss.
        if (Music.enabled && introFinished && !isPaused && !document.hidden) {
            if (canPauseGameplay()) return; // user must resume via pause menu
            Music.ensurePlaying();
        }
    });

    // Steam Overlay often steals input without a reliable GameOverlayActivated in steamworks.js —
    // pause if the page loses focus while a match is live.
    setInterval(() => {
        if (canPauseGameplay() && !isPaused && (document.hidden || !document.hasFocus())) {
            forcePauseOnLeave();
        }
    }, 400);

    // Soft memory trim in lobby — frees idle buffers without touching look/sound quality
    setInterval(() => {
        if (gameState !== 'LOBBY') return;
        if (document.hidden) return;
        try {
            if (typeof Music !== 'undefined' && Music._evictIdleTracks) {
                Music._evictIdleTracks(Music.currentFilename);
            }
            if (typeof colorCache !== 'undefined' && colorCache && colorCache.size > 128) {
                colorCache.clear();
            }
            if (loadoutPage && loadoutPage.classList.contains('hidden')) {
                releaseLoadoutCubeMemory();
            }
        } catch (_) { /* ignore */ }
    }, 45000);

    initTouchControls();
    initGamepadInput();
}

function joinRoom(roomName, opts = {}) {
    if (isSteamOwnershipBlocked()) {
        assertSteamOnlineAllowed();
        return;
    }
    if (!roomName) {
        alert("PLEASE ENTER YOUR FRIEND'S ROOM CODE!");
        return;
    }
    if (!ensureOnlineNickname()) return;
    onlineLogTarget = opts.logTarget || 'friend';
    saveRecentRoom(roomName);
    lastOnlineRoomId = roomName;
    onlineReconnectAttempted = false;
    onlineSpectateRole = 'player';
    
    // Guest uses a random ID to connect to the host's named room
    initPeer(null); 
    
    const connectBtn = document.getElementById('connect-btn');
    if (connectBtn) {
        connectBtn.textContent = "CONNECTING...";
        connectBtn.disabled = true;
    }

    let attempts = 0;
    const maxAttempts = 4;
    const tryConnect = () => {
        if (!peer || !peer.open) return;
        attempts++;
        logLobby(`JOIN ATTEMPT ${attempts}/${maxAttempts}…`, '#00ff41');
        const connection = peer.connect(roomName, { reliable: true, metadata: { role: 'player' } });
        let opened = false;
        const failTimer = setTimeout(() => {
            if (opened) return;
            try { connection.close(); } catch (_) { /* ignore */ }
            if (attempts < maxAttempts) {
                setTimeout(tryConnect, 400);
            } else {
                logLobby('JOIN FAILED — CHECK ROOM CODE / FIREWALL', '#ff0040');
                if (connectBtn) {
                    connectBtn.textContent = 'CONNECT';
                    connectBtn.disabled = false;
                }
            }
        }, 3500);
        connection.on('open', () => {
            opened = true;
            clearTimeout(failTimer);
            setupConnection(connection);
            onlineRole = 'guest';
        });
        connection.on('error', () => {
            if (opened) return;
            clearTimeout(failTimer);
            if (attempts < maxAttempts) setTimeout(tryConnect, 400);
        });
    };

    // Wait for peer to be ready before connecting
    const checkPeer = setInterval(() => {
        if (peer && peer.open) {
            clearInterval(checkPeer);
            tryConnect();
        }
    }, 100);
    setTimeout(() => clearInterval(checkPeer), 12000);
}

// --- CONSTANTS & STATE ---
function detectLowEndDevice() {
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const saveData = navigator.connection && navigator.connection.saveData;
    // Do NOT flag Chrome/Retina as low-end — that forced soft 720p defaults and
    // still left expensive CSS/WebGL FX on, which is why Chrome felt worse than Safari.
    return cores <= 4 || memory <= 4 || isMobile || !!saveData;
}

/** Ultra-low (~2GB RAM / dual-core): force cheapest defaults so the game stays playable. */
function detectUltraLowDevice() {
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory;
    // deviceMemory is undefined on some browsers — treat missing + low cores cautiously via lowEnd
    if (typeof memory === 'number' && memory > 0 && memory <= 2) return true;
    return cores <= 2;
}

/** Blink (Chrome / Edge / Electron) — canvas + CSS filters hitch harder than Safari. */
const blinkBrowser = (typeof navigator !== 'undefined') && (() => {
    try {
        const ua = navigator.userAgent || '';
        return /Chrome|Chromium|Edg|CriOS|Electron/i.test(ua);
    } catch (_) {
        return false;
    }
})();

const lowEndDevice = detectLowEndDevice();
const ultraLowDevice = detectUltraLowDevice();
let forceLowGfxLaunch = false;

function syncBlinkPerfClass() {
    try {
        document.body.classList.toggle('perf-chrome', !!blinkBrowser);
    } catch (_) { /* ignore */ }
}

/** First-run default: ultra-low → 480p; weak → 720p; high-end → 1080p. */
function getDefaultResolutionForDevice() {
    if (ultraLowDevice) return '480p';
    return lowEndDevice ? '720p' : DEFAULT_RESOLUTION;
}

// --- STEAM STORE SCREENSHOT CAPTURE (1920×1080 / 16:9) ---
const STEAM_CAPTURE_W = 1920;
const STEAM_CAPTURE_H = 1080;
let steamScreenshotMode = false;
let steamBatchCapture = false;
let trailerCaptureMode = false;
let trailerBatchCapture = false;
let trailerBatchV2 = false;
let trailerBatchHQ = false;
let trailerBatchFull = false;
let trailerObsCapture = false;
let trailerGameplayPerfActive = false;
let trailerForceRecapture = false;
let trailerSpectateLaser = false;
let trailerStartThemeFolder = '';
let trailerOneTheme = false;
let exportLoadoutCubeMode = false;
let artBackgroundCaptureMode = false;
let steamManualCaptureIndex = 0;
let steamCaptureHintEl = null;
let steamBatchRunning = false;

function getSteamCaptureIpc() {
    if (typeof process === 'undefined' || !process.versions?.electron) return null;
    try {
        return require('electron').ipcRenderer;
    } catch (_) {
        return null;
    }
}

function initSteamScreenshotModeFromLaunch() {
    const launchParams = new URLSearchParams(window.location.search);
    steamScreenshotMode = launchParams.get('steamScreenshot') === '1';
    steamBatchCapture = launchParams.get('steamBatch') === '1';
    trailerCaptureMode = launchParams.get('trailerCapture') === '1';
    trailerBatchHQ = launchParams.get('trailerBatchHQ') === '1';
    trailerBatchFull = launchParams.get('trailerBatchFull') === '1';
    trailerObsCapture = launchParams.get('trailerObsCapture') === '1';
    trailerForceRecapture = launchParams.get('trailerForceRecapture') === '1';
    trailerStartThemeFolder = launchParams.get('trailerFromTheme') || '';
    trailerOneTheme = launchParams.get('trailerOneTheme') === '1';
    trailerBatchV2 = launchParams.get('trailerBatchV2') === '1' || trailerBatchHQ || trailerBatchFull;
    trailerBatchCapture = launchParams.get('trailerBatch') === '1' || trailerBatchV2 || trailerBatchHQ || trailerBatchFull;
    exportLoadoutCubeMode = launchParams.get('exportLoadoutCube') === '1';
    artBackgroundCaptureMode = launchParams.get('artBackgroundCapture') === '1';
    const steamStoreCapture = launchParams.get('steamStoreCapture') === '1';
    if (steamScreenshotMode || steamBatchCapture || trailerCaptureMode || trailerBatchCapture || artBackgroundCaptureMode || steamStoreCapture) {
        localStorage.setItem('ronk_resolution', '1080p');
        // Solid black body kills Tron/clouds under Electron dumps — skip for store capture.
        if (!steamStoreCapture) {
            document.documentElement.style.background = '#000';
            document.body.style.background = '#000';
        }
    }
    if (trailerBatchCapture) {
        trailerGameplayPerfActive = false;
    }
    if (steamStoreCapture) {
        document.body.classList.add('steam-store-capture');
        try {
            localStorage.setItem('ronk_tutorial_v2_complete', 'true');
            localStorage.setItem('ronk_play_unlock_hint_seen', 'true');
        } catch (_) { /* ignore */ }
        setTimeout(() => {
            try {
                if (typeof SKILL_DATA !== 'undefined' && typeof JOKER_DATA !== 'undefined') {
                    unlockProgressCache = {
                        skills: SKILL_DATA.map((s) => s.id),
                        jokers: JOKER_DATA.map((j) => j.id)
                    };
                    unlockProgressHydrated = true;
                }
                document.body.classList.remove('performance-mode', 'perf-chrome');
                if (typeof applyResolution === 'function') applyResolution('1080p');
                const themeClass = themes[currentThemeIndex];
                if (themeClass && typeof initThemeBackground === 'function') {
                    initThemeBackground(themeClass, { force: true });
                }
            } catch (_) { /* ignore */ }
        }, 900);
    }
    if (steamBatchCapture || trailerBatchCapture || exportLoadoutCubeMode || artBackgroundCaptureMode || steamStoreCapture) {
        localStorage.setItem('ronk_tutorial_v2_complete', 'true');
        localStorage.setItem('ronk_play_unlock_hint_seen', 'true');
    }
}

const LOADOUT_CUBE_EXPORT_SIZE = 1024;
const LOADOUT_CUBE_ART_GRAY = '#888888';
/** 3/4 isometric export pose: yaw 45°, pitch ~30° up, slight roll — top + two side faces visible. */
const LOADOUT_CUBE_ART_RY = Math.PI * 0.25;
const LOADOUT_CUBE_ART_RX = 0.52;
const LOADOUT_CUBE_ART_RZ = 0.12;

function suppressIntroForCubeArtExport() {
    introFinished = true;
    document.body.classList.remove('intro-active');
    const introOverlay = document.getElementById('intro-overlay');
    if (introOverlay) {
        introOverlay.style.display = 'none';
        introOverlay.style.pointerEvents = 'none';
        introOverlay.classList.add('hidden');
    }
}

function renderLoadoutCubeArtToCanvas(size, exportAngles = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const rx = exportAngles.rx ?? LOADOUT_CUBE_ART_RX;
    const ry = exportAngles.ry ?? LOADOUT_CUBE_ART_RY;
    const rz = exportAngles.rz ?? LOADOUT_CUBE_ART_RZ;
    const isGrayExport = (exportAngles.color ?? LOADOUT_CUBE_ART_GRAY) === LOADOUT_CUBE_ART_GRAY;
    const half = calcLoadoutCubeHalf(size, size, rx, rz, ry);
    drawLoadoutCubeFrame({
        canvas,
        ctx,
        w: size,
        h: size,
        half,
        rx,
        ry,
        rz,
        color: exportAngles.color ?? LOADOUT_CUBE_ART_GRAY,
        dpr: 1,
        skipShadow: true,
        skipUpload: true,
        grayExport: isGrayExport
    });
    return canvas;
}

async function runLoadoutCubeTransparentExport() {
    const ipc = getSteamCaptureIpc();
    if (!ipc) {
        console.error('[CubeArtCapture] Electron IPC unavailable');
        return;
    }

    suppressIntroForCubeArtExport();

    const size = LOADOUT_CUBE_EXPORT_SIZE;
    const exportAngles = {
        rx: LOADOUT_CUBE_ART_RX,
        ry: LOADOUT_CUBE_ART_RY,
        rz: LOADOUT_CUBE_ART_RZ,
        color: LOADOUT_CUBE_ART_GRAY
    };
    const saved = [];

    const grayThemeIndex = themes.indexOf('theme-white-black');
    if (grayThemeIndex >= 0) {
        if (typeof changeTheme === 'function') {
            changeTheme(grayThemeIndex, { skipBackgroundInit: true });
        } else {
            document.body.className = themes[grayThemeIndex];
        }
        await sleep(40);
        const grayCanvas = renderLoadoutCubeArtToCanvas(size, exportAngles);
        const grayResult = await ipc.invoke('save-loadout-cube-png', {
            filename: 'cube_gray_transparent.png',
            data: grayCanvas.toDataURL('image/png'),
            width: size,
            height: size
        });
        if (grayResult?.ok) {
            saved.push(grayResult.path);
            console.log('[CubeArtCapture] Saved', grayResult.path, `${size}x${size}`, 'gray', LOADOUT_CUBE_ART_GRAY);
        } else {
            console.error('[CubeArtCapture] Failed gray export', grayResult?.error);
        }
    }

    for (let themeIndex = 0; themeIndex < themes.length; themeIndex++) {
        if (typeof changeTheme === 'function') {
            changeTheme(themeIndex, { skipBackgroundInit: true });
        } else {
            document.body.className = themes[themeIndex];
        }
        await sleep(40);

        const themeFolder = getSteamThemeFolderName(themes[themeIndex]);
        const filename = `cube_${themeFolder}_transparent.png`;
        const canvas = renderLoadoutCubeArtToCanvas(size, exportAngles);
        const dataUrl = canvas.toDataURL('image/png');
        const result = await ipc.invoke('save-loadout-cube-png', {
            filename,
            data: dataUrl,
            width: size,
            height: size
        });

        if (result?.ok) {
            saved.push(result.path);
            console.log('[CubeArtCapture] Saved', result.path, `${size}x${size}`);
        } else {
            console.error('[CubeArtCapture] Failed', themeFolder, result?.error);
        }
    }

    console.log(`[CubeArtCapture] Complete — ${saved.length} PNG(s) in d:\\mysteamgame\\art\\cube\\`);
    await ipc.invoke('export-loadout-cube-complete');
}

function maybeStartLoadoutCubeExport() {
    if (!exportLoadoutCubeMode) return;
    setTimeout(() => {
        runLoadoutCubeTransparentExport().catch((err) => console.error('[LoadoutCubeExport]', err));
    }, 400);
}

function injectArtBackgroundCaptureStyles() {
    if (document.getElementById('art-bg-capture-style')) return;
    const style = document.createElement('style');
    style.id = 'art-bg-capture-style';
    style.textContent = `
        body.art-bg-capture-active #menu,
        body.art-bg-capture-active #game-ui,
        body.art-bg-capture-active #theme-btn,
        body.art-bg-capture-active #display-mode-btn,
        body.art-bg-capture-active #intro-overlay,
        body.art-bg-capture-active #steam-capture-hint,
        body.art-bg-capture-active #tutorial-gate,
        body.art-bg-capture-active #game-over,
        body.art-bg-capture-active #pause-menu,
        body.art-bg-capture-active #status,
        body.art-bg-capture-active #gameCanvas,
        body.art-bg-capture-active #game-fx-overlay,
        body.art-bg-capture-active .overlay-panel,
        body.art-bg-capture-active .ronk-container,
        body.art-bg-capture-active .clouds-container,
        body.art-bg-capture-active .matrix-container,
        body.art-bg-capture-active .pixel-bg-container {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
        body.art-bg-capture-active.main-menu-visible #menu {
            background: transparent !important;
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }
    `;
    document.head.appendChild(style);
    document.body.classList.add('art-bg-capture-active');
}

async function runWhiteBlackBackgroundArtCapture() {
    const ipc = getSteamCaptureIpc();
    if (!ipc) {
        console.error('[ArtBgCapture] Electron IPC unavailable');
        return;
    }

    suppressIntroForCubeArtExport();
    introFinished = true;
    document.body.classList.remove('intro-active', 'in-game');
    document.body.classList.add('main-menu-visible');

    const wbIndex = themes.indexOf('theme-white-black');
    if (wbIndex >= 0) {
        if (typeof changeTheme === 'function') {
            changeTheme(wbIndex);
        } else {
            document.body.className = 'theme-white-black main-menu-visible';
        }
    }
    initLiquidBackground();
    injectArtBackgroundCaptureStyles();
    document.querySelector('.liquid-container canvas')?.__ronkResize?.();

    await sleep(1200);

    const result = await ipc.invoke('capture-art-screenshot', 'white-black_background.png');
    if (result?.ok) {
        console.log('[ArtBgCapture] Saved', result.path, `${result.width}x${result.height}`);
    } else {
        console.error('[ArtBgCapture] Failed', result?.error);
    }

    await ipc.invoke('art-background-capture-complete');
}

function maybeStartArtBackgroundCapture() {
    if (!artBackgroundCaptureMode) return;
    setTimeout(() => {
        runWhiteBlackBackgroundArtCapture().catch((err) => console.error('[ArtBgCapture]', err));
    }, 600);
}

function ensureSteamCaptureHint() {
    if (steamCaptureHintEl || !steamScreenshotMode || steamBatchCapture) return;
    steamCaptureHintEl = document.createElement('div');
    steamCaptureHintEl.id = 'steam-capture-hint';
    steamCaptureHintEl.textContent = 'Press F9 to capture Steam screenshot (1920×1080)';
    Object.assign(steamCaptureHintEl.style, {
        position: 'fixed',
        left: '50%',
        bottom: '18px',
        transform: 'translateX(-50%)',
        zIndex: '99999',
        padding: '10px 18px',
        borderRadius: '8px',
        background: 'rgba(0,0,0,0.78)',
        color: '#fff',
        fontFamily: 'Orbitron, sans-serif',
        fontSize: '13px',
        letterSpacing: '0.06em',
        pointerEvents: 'none',
        border: '1px solid rgba(255,105,180,0.55)',
        boxShadow: '0 0 18px rgba(255,105,180,0.25)'
    });
    document.body.appendChild(steamCaptureHintEl);
}

function setSteamCaptureHint(text, isError) {
    if (!steamCaptureHintEl) return;
    steamCaptureHintEl.textContent = text;
    steamCaptureHintEl.style.borderColor = isError ? 'rgba(255,60,60,0.8)' : 'rgba(255,105,180,0.55)';
}

function hideSteamCaptureHintForCapture() {
    if (steamCaptureHintEl) steamCaptureHintEl.style.visibility = 'hidden';
}

function showSteamCaptureHintAfterCapture() {
    if (steamCaptureHintEl) steamCaptureHintEl.style.visibility = 'visible';
}

async function captureSteamScreenshot(filename) {
    const ipc = getSteamCaptureIpc();
    if (!ipc) {
        console.warn('[SteamCapture] Electron IPC unavailable');
        return { ok: false, error: 'no_electron' };
    }
    hideSteamCaptureHintForCapture();
    await sleep(80);
    draw();
    await sleep(50);
    const result = await ipc.invoke('capture-steam-screenshot', filename || null);
    showSteamCaptureHintAfterCapture();
    if (result?.ok) {
        console.log('[SteamCapture] Saved', result.path);
        if (steamScreenshotMode && !steamBatchCapture) {
            setSteamCaptureHint(`Saved ${result.filename} → d:\\mysteamgame\\pciture\\`, false);
        }
    } else {
        console.error('[SteamCapture] Failed', result?.error);
        setSteamCaptureHint(`Capture failed: ${result?.error || 'unknown'}`, true);
    }
    return result;
}

async function captureSteamScreenshotManual() {
    if (!steamScreenshotMode || steamBatchRunning) return;
    steamManualCaptureIndex += 1;
    const slot = Math.min(steamManualCaptureIndex, 8);
    return captureSteamScreenshot(`steam-${String(slot).padStart(2, '0')}.png`);
}

function waitForSteamCapture(conditionFn, timeoutMs = 20000, intervalMs = 100) {
    return new Promise((resolve, reject) => {
        const started = performance.now();
        const tick = () => {
            try {
                if (conditionFn()) {
                    resolve(true);
                    return;
                }
            } catch (_) { /* retry */ }
            if (performance.now() - started >= timeoutMs) {
                reject(new Error('steam_capture_timeout'));
                return;
            }
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

const STEAM_INTRO_FALL_BEGIN_MS = (typeof RonkIntroAnimation !== 'undefined')
    ? RonkIntroAnimation.fallBeginMs()
    : (700 + Math.round(2.0 * 1000));
const STEAM_INTRO_SPIN_HOLD_MS = Math.round(STEAM_INTRO_FALL_BEGIN_MS * 0.5);
const STEAM_INTRO_THEME_FOLDERS = ['ronk', 'white-black', 'pinkcore', 'hacker', 'pixel'];

async function waitUntilIntroElapsed(introStartTime, targetMs) {
    const waitMs = Math.max(0, introStartTime + targetMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    await sleep(120);
}

function hideIntroUiForCapture() {
    const introSkipHint = document.getElementById('intro-skip-hint');
    const introStartBtn = document.getElementById('intro-start-btn');
    if (introSkipHint) introSkipHint.style.visibility = 'hidden';
    if (introStartBtn) introStartBtn.style.visibility = 'hidden';
}

async function runSteamIntroCapture(introStartTime) {
    if (!steamBatchCapture) return;
    console.log('[SteamCapture] Intro capture — spinning hold at ~' + STEAM_INTRO_SPIN_HOLD_MS + 'ms (pre-fall)');

    await waitUntilIntroElapsed(introStartTime, STEAM_INTRO_SPIN_HOLD_MS);
    hideIntroUiForCapture();
    await captureSteamScreenshot('common/00-intro-animation.png');
}

async function exitActiveGameForSteamBatch() {
    if (isInActiveGameView()) {
        returnToLobbyState({ stopLoop: true });
        hideGameplayUI();
        document.body.classList.remove('in-game');
    }
    showMainMenu();
    resetToMainTier();
    await sleep(400);
}

async function waitForGameplayReady() {
    await waitForSteamCapture(() => gameState === 'PLAYING' && p1 && p2, 25000);
    await sleep(3500);
}

function getSteamThemeFolderName(themeClass) {
    if (themeClass === 'theme-white-black') return 'white-black';
    return themeClass.replace(/^theme-/, '');
}

function getSteamThemeScreenshotPath(themeFolder, slot) {
    return `${themeFolder}/steam-${String(slot).padStart(2, '0')}.png`;
}

async function captureSteamBatchScenesForTheme(themeFolder) {
    showMainMenu();
    resetToMainTier();
    await sleep(600);
    await captureSteamScreenshot(getSteamThemeScreenshotPath(themeFolder, 1));

    showLoadoutPage();
    await sleep(900);
    await captureSteamScreenshot(getSteamThemeScreenshotPath(themeFolder, 2));
    hideOverlayPanel(loadoutPage);

    setBotDifficulty('invincible');
    launchGameMode({ spectate: false, multiplayer: false, botDifficulty: 'invincible' });
    await waitForGameplayReady();
    await captureSteamScreenshot(getSteamThemeScreenshotPath(themeFolder, 3));
    await exitActiveGameForSteamBatch();

    launchGameMode({ spectate: true, multiplayer: false });
    await waitForGameplayReady();
    await captureSteamScreenshot(getSteamThemeScreenshotPath(themeFolder, 4));
    await exitActiveGameForSteamBatch();

    hideOverlayPanel(menu);
    showOverlayPanel(settingsPage);
    setActiveNavigation('settings');
    await sleep(500);
    await captureSteamScreenshot(getSteamThemeScreenshotPath(themeFolder, 5));
    hideOverlayPanel(settingsPage);

    openOnlinePanel(onlineMatchmakePanel, 'matchmake');
    await sleep(700);
    await captureSteamScreenshot(getSteamThemeScreenshotPath(themeFolder, 6));
    hideOverlayPanel(onlineMatchmakePanel);

    showLoadoutPage();
    openLoadoutPanel(loadoutSkillPanel);
    await sleep(700);
    await captureSteamScreenshot(getSteamThemeScreenshotPath(themeFolder, 7));
    closeLoadoutPanel(loadoutSkillPanel);
    openLoadoutPanel(loadoutJokerPanel);
    renderJokersGrid();
    await sleep(700);
    await captureSteamScreenshot(getSteamThemeScreenshotPath(themeFolder, 8));
    closeLoadoutPanel(loadoutJokerPanel);
    hideOverlayPanel(loadoutPage);
}

async function runSteamBatchCapture() {
    if (!steamBatchCapture || steamBatchRunning) return;
    steamBatchRunning = true;
    const ipc = getSteamCaptureIpc();
    const themeCount = themes.length;
    console.log(`[SteamCapture] Multi-theme batch capture starting (${themeCount} themes × 10 scenes incl. intro)…`);
    try {
        if (!introFinished) {
            await waitForSteamCapture(() => introFinished, 30000);
            await sleep(800);
        }
        hideTutorialGate();

        for (let themeIndex = 0; themeIndex < themeCount; themeIndex++) {
            const themeClass = themes[themeIndex];
            const themeFolder = getSteamThemeFolderName(themeClass);
            console.log(`[SteamCapture] Theme ${themeIndex + 1}/${themeCount}: ${themeFolder}`);
            changeTheme(themeIndex);
            await sleep(1200);
            await captureSteamBatchScenesForTheme(themeFolder);
        }

        console.log(`[SteamCapture] Batch complete — ${themeCount * 10} files in d:\\mysteamgame\\pciture\\`);
        if (ipc) await ipc.invoke('steam-batch-complete');
    } catch (err) {
        console.error('[SteamCapture] Batch failed', err);
        if (ipc) await ipc.invoke('steam-batch-complete');
    } finally {
        steamBatchRunning = false;
    }
}

function maybeStartSteamBatchCapture() {
    if (!steamBatchCapture || steamBatchRunning) return;
    setTimeout(() => {
        runSteamBatchCapture().catch((err) => console.error('[SteamCapture]', err));
    }, 500);
}

// --- TRAILER VIDEO CAPTURE (1920×1080, wall-clock sync — no speed-up) ---
const TRAILER_CLIP_MS = {
    intro: 7000,
    menu: 10000,
    loadout: 12000,
    skills: 10000,
    jokers: 10000,
    gameplay: 25000,
    spectate: 15000
};
const TRAILER_CLIP_MS_HQ = {
    menu: 10000,
    loadout: 12000,
    skillsAll: 12000,
    jokersAll: 12000,
    spectate: 22000
};
/** ~10 min per theme — menu, loadout cube, skills, jokers, settings, online, gameplay, spectate */
const TRAILER_CLIP_MS_FULL = {
    menu: 45000,
    loadout: 120000,
    skillsAll: 90000,
    jokersAll: 90000,
    settings: 30000,
    online: 20000,
    gameplay: 180000,
    spectate: 125000
};
let trailerBatchRunning = false;

function ensureTrailerShowcaseUnlocks() {
    const allSkills = SKILL_DATA.map((skill) => skill.id);
    const allJokers = JOKER_DATA.map((joker) => joker.id);
    unlockProgressCache = { skills: allSkills, jokers: allJokers };
    unlockProgressHydrated = true;
}

function hideTrailerCaptureUi() {
    const ids = ['intro-skip-hint', 'steam-capture-hint', 'theme-btn', 'display-mode-btn', 'loadout-skill-done-btn', 'loadout-joker-done-btn'];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.visibility = 'hidden';
    });
}

function stopTrailerCaptureStream() {
    /* legacy no-op — HQ capture uses main-process frame subscription */
}

async function waitTrailerFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** Record MP4 — game runs real-time; frames captured at fixed interval; encode matches wall clock. */
async function recordTrailerVideoClip(clipPath, durationMs, setupFn, onTick) {
    const ipc = getSteamCaptureIpc();
    if (!ipc) throw new Error('no_electron_ipc');

    const existing = await ipc.invoke('trailer-clip-exists', { clip: clipPath });
    if (existing?.exists && !trailerForceRecapture) {
        console.log(`[TrailerCapture] Skip existing ${clipPath}`);
        return;
    }

    if (setupFn) await setupFn();
    ensureTrailerFullQuality();
    await sleep(900);
    hideTrailerCaptureUi();
    resizeCanvas();
    window.dispatchEvent(new Event('resize'));
    await sleep(200);

    const started = await ipc.invoke('trailer-start-recording', { clip: clipPath, durationMs });
    if (!started?.ok) throw new Error(started?.error || 'trailer_start_failed');

    console.log(`[TrailerCapture] ${clipPath} — ${(durationMs / 1000).toFixed(1)}s real-time`);

    const wallStart = performance.now();
    const endAt = wallStart + durationMs;

    while (performance.now() < endAt) {
        const elapsed = performance.now() - wallStart;
        if (onTick) {
            try { onTick(elapsed, durationMs); } catch (_) { /* continue */ }
        }
        draw();
        await waitTrailerFrame();
    }

    const actualDurationMs = performance.now() - wallStart;
    const result = await ipc.invoke('trailer-stop-recording', { durationMs: actualDurationMs });
    if (!result?.ok) throw new Error(result?.error || 'trailer_stop_failed');
    console.log(`[TrailerCapture] Saved ${result.path} (${result.frames} frames, ${result.durationSec?.toFixed(1)}s)`);
}

function ensureTrailerFullQuality() {
    if (!trailerBatchCapture) return;
    trailerGameplayPerfActive = false;
    localStorage.setItem('ronk_resolution', '1080p');
    renderScale = 1.0;
    applyResolution('1080p');
    document.body.classList.add('trailer-capture-active');
    document.body.classList.remove('performance-mode');
    const themeClass = themes[currentThemeIndex];
    if (themeClass) initThemeBackground(themeClass);
    resizeCanvas();
    window.dispatchEvent(new Event('resize'));
    document.querySelector('.liquid-container canvas')?.__ronkResize?.();
}

function setTrailerGameplayPerf(active) {
    if (!trailerBatchHQ) return;
    /* Trailer capture always uses full quality — never enable performance mode */
    trailerGameplayPerfActive = false;
    document.body.classList.remove('performance-mode');
    updateEffectiveDpr();
    offscreenGrid = null;
    lastGridCacheKey = '';
    resizeCanvas();
    const themeClass = themes[currentThemeIndex];
    if (themeClass) initThemeBackground(themeClass);
}

async function runTrailerIntroCapture(introStartTime) {
    if (!trailerBatchCapture) return;
    const clipPath = 'common/00_intro';
    const durationMs = TRAILER_CLIP_MS.intro;
    const endAt = introStartTime + durationMs;

    const ipc = getSteamCaptureIpc();
    const existing = await ipc.invoke('trailer-clip-exists', { clip: clipPath });
    if (existing?.exists && !trailerForceRecapture) {
        console.log(`[TrailerCapture] Skip existing intro ${clipPath}`);
        return;
    }

    await sleep(Math.max(0, introStartTime + 200 - Date.now()));
    ensureTrailerFullQuality();
    hideTrailerCaptureUi();

    const started = await ipc.invoke('trailer-start-recording', { clip: clipPath, durationMs });
    if (!started?.ok) {
        console.error('[TrailerCapture] Intro start failed', started?.error);
        return;
    }

    console.log(`[TrailerCapture] intro ${clipPath} — ${(durationMs / 1000).toFixed(1)}s real-time`);
    const recordStart = Date.now();
    while (Date.now() < endAt) {
        hideTrailerCaptureUi();
        draw();
        await waitTrailerFrame();
    }

    const actualDurationMs = Date.now() - recordStart;
    const result = await ipc.invoke('trailer-stop-recording', { durationMs: actualDurationMs });
    if (result?.ok) console.log(`[TrailerCapture] Saved ${result.path}`);
}

async function runTrailerClipsForTheme(themeFolder) {
    const p = (name) => `${themeFolder}/${name}`;

    await recordTrailerVideoClip(p('02_menu'), TRAILER_CLIP_MS.menu, async () => {
        showMainMenu();
        resetToMainTier();
    });

    await recordTrailerVideoClip(p('03_loadout'), TRAILER_CLIP_MS.loadout, async () => {
        showLoadoutPage();
        await sleep(300);
    });

    await recordTrailerVideoClip(p('04_skills'), TRAILER_CLIP_MS.skills, async () => {
        showLoadoutPage();
        openLoadoutPanel(loadoutSkillPanel);
        await sleep(300);
    }, (elapsed) => {
        const idx = Math.floor(elapsed / 2800) % SKILL_DATA.length;
        if (idx !== currentSkillIndex) {
            currentSkillIndex = idx;
            updateSkillPreview();
        }
    });
    closeLoadoutPanel(loadoutSkillPanel);

    await recordTrailerVideoClip(p('05_jokers'), TRAILER_CLIP_MS.jokers, async () => {
        showLoadoutPage();
        openLoadoutPanel(loadoutJokerPanel);
        renderJokersGrid();
        await sleep(300);
    });
    closeLoadoutPanel(loadoutJokerPanel);
    hideOverlayPanel(loadoutPage);

    setBotDifficulty('hard');
    await recordTrailerVideoClip(p('06_gameplay'), TRAILER_CLIP_MS.gameplay, async () => {
        launchGameMode({ spectate: false, multiplayer: false, botDifficulty: 'hard' });
        await waitForGameplayReady();
    });
    await exitActiveGameForSteamBatch();

    await recordTrailerVideoClip(p('07_spectate'), TRAILER_CLIP_MS.spectate, async () => {
        launchGameMode({ spectate: true, multiplayer: false });
        await waitForGameplayReady();
    });
    await exitActiveGameForSteamBatch();
}

async function runTrailerClipsForThemeHQ(themeFolder) {
    const p = (name) => `${themeFolder}/${name}`;
    ensureTrailerShowcaseUnlocks();

    await recordTrailerVideoClip(p('02_menu'), TRAILER_CLIP_MS_HQ.menu, async () => {
        ensureTrailerFullQuality();
        showMainMenu();
        resetToMainTier();
    });

    await recordTrailerVideoClip(p('03_loadout'), TRAILER_CLIP_MS_HQ.loadout, async () => {
        ensureTrailerFullQuality();
        showLoadoutPage();
        await sleep(300);
    });

    await recordTrailerVideoClip(p('04_skills'), TRAILER_CLIP_MS_HQ.skillsAll, async () => {
        ensureTrailerFullQuality();
        showLoadoutPage();
        if (loadoutSkillPanel) loadoutSkillPanel.classList.add('hidden');
        if (loadoutJokerPanel) loadoutJokerPanel.classList.add('hidden');
        if (loadoutPage) loadoutPage.classList.remove('loadout-picker-open');
        document.body.classList.remove('loadout-picker-open');
        await sleep(500);
    }, (elapsed) => {
        const idx = Math.floor(elapsed / 2800) % SKILL_DATA.length;
        if (idx !== currentSkillIndex) {
            currentSkillIndex = idx;
            updateLoadoutSummary();
        }
    });

    await recordTrailerVideoClip(p('05_jokers'), TRAILER_CLIP_MS_HQ.jokersAll, async () => {
        ensureTrailerFullQuality();
        showLoadoutPage();
        if (loadoutSkillPanel) loadoutSkillPanel.classList.add('hidden');
        if (loadoutJokerPanel) loadoutJokerPanel.classList.add('hidden');
        if (loadoutPage) loadoutPage.classList.remove('loadout-picker-open');
        document.body.classList.remove('loadout-picker-open');
        p1SelectedJoker = JOKER_DATA.slice(0, 2).map((joker) => joker.id);
        updateLoadoutSummary();
        await sleep(500);
    }, (elapsed) => {
        const idx = Math.floor(elapsed / 2500) % JOKER_DATA.length;
        const j1 = JOKER_DATA[idx];
        const j2 = JOKER_DATA[(idx + 5) % JOKER_DATA.length];
        if (j1 && j2) {
            p1SelectedJoker = [j1.id, j2.id];
            updateLoadoutSummary();
        }
    });
    hideOverlayPanel(loadoutPage);

    await recordTrailerVideoClip(p('07_spectate_a'), TRAILER_CLIP_MS_HQ.spectate, async () => {
        ensureTrailerFullQuality();
        trailerSpectateLaser = true;
        launchGameMode({ spectate: true, multiplayer: false, botDifficulty: 'invincible' });
        await waitForGameplayReady();
    });
    await exitActiveGameForSteamBatch();
    trailerSpectateLaser = false;
    ensureTrailerFullQuality();

    await recordTrailerVideoClip(p('08_spectate_b'), TRAILER_CLIP_MS_HQ.spectate, async () => {
        ensureTrailerFullQuality();
        localStorage.setItem('ronk_selectedSkill', 'clones');
        p1SelectedJoker = ['friend-blocks', 'trail-growth'];
        launchGameMode({ spectate: true, multiplayer: false, botDifficulty: 'invincible' });
        await waitForGameplayReady();
    });
    await exitActiveGameForSteamBatch();
    ensureTrailerFullQuality();
}

async function runTrailerClipsForThemeFull(themeFolder) {
    const p = (name) => `${themeFolder}/${name}`;
    const ms = TRAILER_CLIP_MS_FULL;
    ensureTrailerShowcaseUnlocks();

    await recordTrailerVideoClip(p('02_menu'), ms.menu, async () => {
        ensureTrailerFullQuality();
        showMainMenu();
        resetToMainTier();
    });

    await recordTrailerVideoClip(p('03_loadout'), ms.loadout, async () => {
        ensureTrailerFullQuality();
        showLoadoutPage();
        if (loadoutSkillPanel) loadoutSkillPanel.classList.add('hidden');
        if (loadoutJokerPanel) loadoutJokerPanel.classList.add('hidden');
        if (loadoutPage) loadoutPage.classList.remove('loadout-picker-open');
        document.body.classList.remove('loadout-picker-open');
        await sleep(400);
    });

    await recordTrailerVideoClip(p('04_skills'), ms.skillsAll, async () => {
        ensureTrailerFullQuality();
        showLoadoutPage();
        openLoadoutPanel(loadoutSkillPanel);
        await sleep(400);
    }, (elapsed) => {
        const idx = Math.floor(elapsed / 2800) % SKILL_DATA.length;
        if (idx !== currentSkillIndex) {
            currentSkillIndex = idx;
            updateSkillPreview();
        }
    });
    closeLoadoutPanel(loadoutSkillPanel);

    await recordTrailerVideoClip(p('05_jokers'), ms.jokersAll, async () => {
        ensureTrailerFullQuality();
        showLoadoutPage();
        openLoadoutPanel(loadoutJokerPanel);
        renderJokersGrid();
        await sleep(400);
    }, (elapsed) => {
        const idx = Math.floor(elapsed / 2500) % JOKER_DATA.length;
        const j1 = JOKER_DATA[idx];
        const j2 = JOKER_DATA[(idx + 5) % JOKER_DATA.length];
        if (j1 && j2) {
            p1SelectedJoker = [j1.id, j2.id];
            renderJokersGrid();
        }
    });
    closeLoadoutPanel(loadoutJokerPanel);
    hideOverlayPanel(loadoutPage);

    await recordTrailerVideoClip(p('06_settings'), ms.settings, async () => {
        ensureTrailerFullQuality();
        hideOverlayPanel(menu);
        showOverlayPanel(settingsPage);
        setActiveNavigation('settings');
        await sleep(500);
    });
    hideOverlayPanel(settingsPage);

    await recordTrailerVideoClip(p('07_online'), ms.online, async () => {
        ensureTrailerFullQuality();
        showMainMenu();
        resetToMainTier();
        openOnlinePanel(onlineMatchmakePanel, 'matchmake');
        await sleep(500);
    });
    hideOverlayPanel(onlineMatchmakePanel);

    setBotDifficulty('hard');
    await recordTrailerVideoClip(p('08_gameplay'), ms.gameplay, async () => {
        ensureTrailerFullQuality();
        launchGameMode({ spectate: false, multiplayer: false, botDifficulty: 'hard' });
        await waitForGameplayReady();
    });
    await exitActiveGameForSteamBatch();

    await recordTrailerVideoClip(p('09_spectate'), ms.spectate, async () => {
        ensureTrailerFullQuality();
        launchGameMode({ spectate: true, multiplayer: false, botDifficulty: 'invincible' });
        await waitForGameplayReady();
    });
    await exitActiveGameForSteamBatch();
    ensureTrailerFullQuality();
}

async function runTrailerClipsForThemeV2(themeFolder) {
    return runTrailerClipsForThemeHQ(themeFolder);
}

async function runTrailerBatchCaptureFull() {
    if (!trailerBatchFull || trailerBatchRunning) return;
    trailerBatchRunning = true;
    const ipc = getSteamCaptureIpc();
    const themeCount = themes.length;
    const ms = TRAILER_CLIP_MS_FULL;
    const perThemeSec = (ms.menu + ms.loadout + ms.skillsAll + ms.jokersAll + ms.settings + ms.online + ms.gameplay + ms.spectate) / 1000;
    const totalSec = perThemeSec * themeCount;
    console.log(`[TrailerCapture] FULL walkthrough — ${themeCount} themes × ~${Math.round(perThemeSec)}s (~${Math.round(totalSec / 60)} min total), 1920×1080 + audio`);
    console.log('[TrailerCapture] Output: steam-marketing/trailer/clips/<theme>/*.mp4');
    try {
        if (!introFinished) {
            await waitForSteamCapture(() => introFinished, 45000);
            await sleep(600);
        }
        hideTutorialGate();
        ensureTrailerShowcaseUnlocks();
        ensureTrailerFullQuality();
        if (Music.enabled) Music.play();

        let startIndex = 0;
        if (trailerStartThemeFolder) {
            const idx = themes.findIndex((t) => getSteamThemeFolderName(t) === trailerStartThemeFolder);
            if (idx >= 0) startIndex = idx;
        }

        for (let themeIndex = startIndex; themeIndex < themeCount; themeIndex++) {
            const themeFolder = getSteamThemeFolderName(themes[themeIndex]);
            if (trailerOneTheme && trailerStartThemeFolder && themeFolder !== trailerStartThemeFolder) continue;
            console.log(`[TrailerCapture] FULL theme ${themeIndex + 1}/${themeCount}: ${themeFolder} (~${Math.round(perThemeSec / 60)} min)`);
            changeTheme(themeIndex);
            await sleep(1500);
            await runTrailerClipsForThemeFull(themeFolder);
            if (trailerOneTheme) break;
        }

        console.log('[TrailerCapture] FULL batch done');
        if (ipc) await ipc.invoke('trailer-batch-complete');
    } catch (err) {
        console.error('[TrailerCapture] FULL batch failed', err);
        stopTrailerCaptureStream();
        if (ipc) await ipc.invoke('trailer-batch-complete');
    } finally {
        trailerBatchRunning = false;
    }
}

async function runTrailerBatchCapture() {
    if (!trailerBatchCapture || trailerBatchRunning) return;
    trailerBatchRunning = true;
    const ipc = getSteamCaptureIpc();
    const themeCount = themes.length;
    const perThemeSec = (TRAILER_CLIP_MS.menu + TRAILER_CLIP_MS.loadout + TRAILER_CLIP_MS.skills
        + TRAILER_CLIP_MS.jokers + TRAILER_CLIP_MS.gameplay + TRAILER_CLIP_MS.spectate) / 1000;
    const totalSec = perThemeSec * themeCount + TRAILER_CLIP_MS.intro / 1000;
    console.log(`[TrailerCapture] Batch — ${themeCount} themes, ~${Math.round(totalSec)}s, MP4 1920×1080`);
    console.log('[TrailerCapture] Output: d:\\mysteamgame\\trailer\\clips\\<theme>\\*.mp4');
    try {
        if (!introFinished) {
            await waitForSteamCapture(() => introFinished, 45000);
            await sleep(600);
        }
        hideTutorialGate();

        for (let themeIndex = 0; themeIndex < themeCount; themeIndex++) {
            const themeFolder = getSteamThemeFolderName(themes[themeIndex]);
            if (trailerStartThemeFolder && themeFolder !== trailerStartThemeFolder && trailerOneTheme) continue;
            if (trailerStartThemeFolder && !trailerOneTheme) {
                const startIdx = themes.findIndex((t) => getSteamThemeFolderName(t) === trailerStartThemeFolder);
                if (startIdx >= 0 && themeIndex < startIdx) continue;
            }
            console.log(`[TrailerCapture] Theme ${themeIndex + 1}/${themeCount}: ${themeFolder}`);
            changeTheme(themeIndex);
            await sleep(1500);
            await runTrailerClipsForTheme(themeFolder);
            if (trailerOneTheme) break;
        }

        console.log(`[TrailerCapture] Done — MP4 clips ready`);
        if (ipc) await ipc.invoke('trailer-batch-complete');
    } catch (err) {
        console.error('[TrailerCapture] Batch failed', err);
        stopTrailerCaptureStream();
        if (ipc) await ipc.invoke('trailer-batch-complete');
    } finally {
        trailerBatchRunning = false;
    }
}

async function runTrailerBatchCaptureHQ() {
    if (!trailerBatchHQ || trailerBatchRunning) return;
    trailerBatchRunning = true;
    const ipc = getSteamCaptureIpc();
    const themeCount = themes.length;
    const perThemeSec = (TRAILER_CLIP_MS_HQ.menu + TRAILER_CLIP_MS_HQ.loadout + TRAILER_CLIP_MS_HQ.skillsAll
        + TRAILER_CLIP_MS_HQ.jokersAll + TRAILER_CLIP_MS_HQ.spectate * 2) / 1000;
    const totalSec = perThemeSec * themeCount;
    console.log(`[TrailerCapture] HQ batch — ${themeCount} themes, ~${Math.round(totalSec)}s, 1920×1080@60`);
    console.log('[TrailerCapture] Clips: intro, menu, loadout, skills, jokers, 2× spectate');
    console.log('[TrailerCapture] Output: d:\\mysteamgame\\trailer\\clips\\<theme>\\*.mp4');
    try {
        if (!introFinished) {
            await waitForSteamCapture(() => introFinished, 45000);
            await sleep(600);
        }
        hideTutorialGate();
        ensureTrailerShowcaseUnlocks();
        ensureTrailerFullQuality();

        let startIndex = 0;
        if (trailerStartThemeFolder) {
            const idx = themes.findIndex((t) => getSteamThemeFolderName(t) === trailerStartThemeFolder);
            if (idx >= 0) startIndex = idx;
        }

        for (let themeIndex = startIndex; themeIndex < themeCount; themeIndex++) {
            const themeFolder = getSteamThemeFolderName(themes[themeIndex]);
            console.log(`[TrailerCapture] HQ theme ${themeIndex + 1}/${themeCount}: ${themeFolder}`);
            changeTheme(themeIndex);
            await sleep(1500);
            await runTrailerClipsForThemeHQ(themeFolder);
        }

        console.log(`[TrailerCapture] HQ done — ~${Math.round(totalSec / 60)} min in d:\\mysteamgame\\trailer\\clips\\`);
        if (ipc) await ipc.invoke('trailer-batch-complete');
    } catch (err) {
        console.error('[TrailerCapture] HQ batch failed', err);
        stopTrailerCaptureStream();
        if (ipc) await ipc.invoke('trailer-batch-complete');
    } finally {
        trailerBatchRunning = false;
    }
}

async function runTrailerBatchCaptureV2() {
    if (!trailerBatchV2 || trailerBatchHQ || trailerBatchRunning) return;
    trailerBatchRunning = true;
    const ipc = getSteamCaptureIpc();
    const themeCount = themes.length;
    const perThemeSec = (TRAILER_CLIP_MS_HQ.skillsAll + TRAILER_CLIP_MS_HQ.jokersAll + TRAILER_CLIP_MS_HQ.spectate * 2) / 1000;
    const totalSec = perThemeSec * themeCount;
    console.log(`[TrailerCapture] V2 batch — ${themeCount} themes, ~${Math.round(totalSec)}s, no gameplay`);
    console.log('[TrailerCapture] Clips: skills, jokers, 2× spectate');
    console.log('[TrailerCapture] Output: d:\\mysteamgame\\trailer\\clips\\<theme>\\*.mp4');
    try {
        hideTutorialGate();
        ensureTrailerShowcaseUnlocks();

        for (let themeIndex = 0; themeIndex < themeCount; themeIndex++) {
            const themeFolder = getSteamThemeFolderName(themes[themeIndex]);
            console.log(`[TrailerCapture] V2 theme ${themeIndex + 1}/${themeCount}: ${themeFolder}`);
            changeTheme(themeIndex);
            await sleep(1500);
            await runTrailerClipsForThemeV2(themeFolder);
        }

        console.log(`[TrailerCapture] V2 done — new MP4s added alongside existing clips (~${Math.round(totalSec / 60)} min)`);
        if (ipc) await ipc.invoke('trailer-batch-complete');
    } catch (err) {
        console.error('[TrailerCapture] V2 batch failed', err);
        stopTrailerCaptureStream();
        if (ipc) await ipc.invoke('trailer-batch-complete');
    } finally {
        trailerBatchRunning = false;
    }
}

function maybeStartTrailerBatchCapture() {
    if (!trailerBatchCapture || trailerBatchRunning) return;
    setTimeout(() => {
        const runner = trailerBatchFull
            ? runTrailerBatchCaptureFull
            : (trailerBatchHQ
                ? runTrailerBatchCaptureHQ
                : (trailerBatchV2 ? runTrailerBatchCaptureV2 : runTrailerBatchCapture));
        runner().catch((err) => console.error('[TrailerCapture]', err));
    }, trailerBatchFull ? 800 : (trailerBatchHQ ? 500 : (trailerBatchV2 ? 300 : 500)));
}

// Initialize when everything is ready
window.addEventListener('load', () => {
    const launchParams = new URLSearchParams(window.location.search);
    initSteamScreenshotModeFromLaunch();
    forceLowGfxLaunch = launchParams.get('launch') === 'low';
    if (forceLowGfxLaunch) {
        // Session-only low gfx — never permanently overwrite the player's saved resolution
        applyResolution('480p');
    } else {
        const saved = localStorage.getItem('ronk_resolution');
        // Older builds wrongly persisted 480p after one low-gfx launch
        if (saved === '480p' && localStorage.getItem('ronk_keep_480p') !== '1') {
            const restored = getDefaultResolutionForDevice();
            localStorage.setItem('ronk_resolution', restored);
            applyResolution(restored);
        } else if (!saved || !RESOLUTION_SCALES[saved]) {
            const restored = getDefaultResolutionForDevice();
            localStorage.setItem('ronk_resolution', restored);
            applyResolution(restored);
        } else if (saved === '5k' || saved === '8k') {
            localStorage.setItem('ronk_resolution', '4k');
            applyResolution('4k');
        } else {
            applyResolution(saved);
        }
    }
    initDOMElements();
    syncBlinkPerfClass();
    updateColorPreview();
    if (steamScreenshotMode) {
        ensureSteamCaptureHint();
    }
    maybeStartLoadoutCubeExport();
    maybeStartArtBackgroundCapture();
});

const RESOLUTION_SCALES = {
    '480p': 0.5,
    '720p': 0.75,
    '1080p': 1.0,
    'ultra': 1.35, // between 1080p and 2k — sharper buffer without 2k GPU cost
    '2k': 1.85,
    '4k': 2.65
};

let renderScale = 1.0;
let effectiveDpr = window.devicePixelRatio || 1;
// Magenta/purple slots remapped to reds — no purple cubes / HUD accents
const neonColors = ['#ff2d55', '#00f2ff', '#39ff14', '#ffff00', '#ff3131', '#e0144c', '#ff5e00', '#888888'];
const colorNames = { '#ff2d55': 'PINK', '#00f2ff': 'CYAN', '#39ff14': 'GREEN', '#ffff00': 'YELLOW', '#ff3131': 'RED', '#e0144c': 'CRIMSON', '#ff5e00': 'ORANGE', '#888888': 'GRAY' };

// Load persistent data
let currentColorIndex = parseInt(localStorage.getItem('ronk_colorIndex')) || 0;
let playerImageSrc = localStorage.getItem('ronk_playerImage');
let playerImage = null;
let playerImagePreviewUrl = null;
(function hydrateSafePlayerImage() {
    if (!playerImageSrc) return;
    const apply = (dataUrl) => {
        playerImage = new Image();
        playerImagePreviewUrl = dataUrl;
        playerImage.onload = () => {
            if (typeof updateColorPreview === 'function') updateColorPreview();
        };
        playerImage.src = dataUrl;
        try { localStorage.setItem('ronk_playerImage', dataUrl); } catch (_) { /* ignore */ }
    };
    if (window.RonkContentSafety && typeof RonkContentSafety.sanitizeDataUrl === 'function') {
        RonkContentSafety.sanitizeDataUrl(playerImageSrc).then((result) => {
            if (result && result.ok) {
                apply(result.dataUrl);
            } else {
                try { localStorage.removeItem('ronk_playerImage'); } catch (_) { /* ignore */ }
                playerImageSrc = null;
                if (typeof showAntiCheatToast === 'function') {
                    showAntiCheatToast(
                        (result && result.message) || 'Saved custom image removed — failed all-ages safety check.',
                        true
                    );
                }
            }
        }).catch(() => {
            try { localStorage.removeItem('ronk_playerImage'); } catch (_) { /* ignore */ }
            playerImageSrc = null;
        });
    } else {
        // Safety module missing — do not trust raw stored image
        try { localStorage.removeItem('ronk_playerImage'); } catch (_) { /* ignore */ }
        playerImageSrc = null;
    }
})();

const colorCache = new Map();
const gradientCache = new Map();
const baseVertices = [ { x: -0.5, y: -0.5, z: -0.5 }, { x: 0.5, y: -0.5, z: -0.5 }, { x: 0.5, y: 0.5, z: -0.5 }, { x: -0.5, y: 0.5, z: -0.5 }, { x: -0.5, y: -0.5, z: 0.5 }, { x: 0.5, y: -0.5, z: 0.5 }, { x: 0.5, y: 0.5, z: 0.5 }, { x: -0.5, y: 0.5, z: 0.5 } ];

// Pre-allocate projection objects to avoid GC pressure
const projPool = Array.from({ length: 64 }, () => ({ x: 0, y: 0 }));
const draw2dQuad = [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }
];
let projIdx = 0;
function getProjObj() {
    const obj = projPool[projIdx];
    projIdx = (projIdx + 1) % projPool.length;
    return obj;
}
const cubeProjectedVerts = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));
const cubeWorldZ = new Float32Array(8);
const shardProjectedVerts = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));
const shardWorldZ = new Float32Array(8);
const cubeFaceTemplates = [
    { indices: [0, 1, 2, 3], color: '', name: 'top', avgZ: 0, avgY: 0 },
    { indices: [4, 5, 1, 0], color: '', name: 'front', avgZ: 0, avgY: 0 },
    { indices: [5, 6, 2, 1], color: '', name: 'right', avgZ: 0, avgY: 0 },
    { indices: [6, 7, 3, 2], color: '', name: 'back', avgZ: 0, avgY: 0 },
    { indices: [7, 4, 0, 3], color: '', name: 'left', avgZ: 0, avgY: 0 }
];
// Classic single-board size — each of the 9 boards uses this (never shrink to a mega-grid)
const GRID_COUNT = 20;
const GRID_SIZE = 120;
const BOARDS_PER_SIDE = 3; // 3×3 = 9 independent boards
const BOARD_SIZE = GRID_COUNT; // cells per board (alias for AI / legacy names)
const CHECKPOINTS_PER_BOARD = 3;
const MIDDLE_BOARD_SX = 1; // board 5 in 1–9 numbering
const MIDDLE_BOARD_SY = 1;

/** Opt-in local debug only — never posts to ingest in retail. Enable: localStorage ronk_agent_debug=1 */
function agentDebugLog(payload) {
    try {
        if (typeof localStorage === 'undefined' || localStorage.getItem('ronk_agent_debug') !== '1') return;
        if (!payload || typeof payload !== 'object') return;
        if (typeof console !== 'undefined' && console.debug) console.debug('[ronk-debug]', payload);
    } catch (_) { /* ignore */ }
}

const TICK_RATE = 13.5; 
const ROUND_COUNTDOWN_NUMBER_SEC = 1 - (0.7 / 3); // 3-2-1 steps: 0.7s faster overall
const ROUND_COUNTDOWN_GO_SEC = 0.4;
// Match round-start pacing so pause → resume doesn't feel sluggish
const RESUME_COUNTDOWN_NUMBER_SEC = ROUND_COUNTDOWN_NUMBER_SEC;
const RESUME_COUNTDOWN_GO_SEC = ROUND_COUNTDOWN_GO_SEC;
const TRAIL_LENGTH = 23;
/** Hard ceiling for trail arrays — full 3×3 map cell count. Extra points can't cover more board. */
function getMaxTrailPoints() {
    return BOARDS_PER_SIDE * BOARDS_PER_SIDE * GRID_COUNT * GRID_COUNT;
}

/**
 * Global trail cap — FIFO oldest-first, regardless of board.
 * Infinite Trails (passive): keep every painted cell forever (map-sized ceiling only).
 */
function playerHasInfiniteTrails(player) {
    if (!player) return false;
    if (player.infiniteTrailsActive) return true;
    if (player.selectedSkill === SKILL_TYPES.INFINITE_TRAILS) return true;
    if (player === p1 && p1SelectedSkillForMatch === 'infinite-trails') return true;
    if (player === p2 && p2SelectedSkillForMatch === 'infinite-trails') return true;
    return false;
}

function trailPaintKey(x, y, boardSx, boardSy) {
    const sx = Number.isInteger(boardSx) ? boardSx : MIDDLE_BOARD_SX;
    const sy = Number.isInteger(boardSy) ? boardSy : MIDDLE_BOARD_SY;
    return `${sx}|${sy}|${Math.floor(Number(x))}|${Math.floor(Number(y))}`;
}

function trailOccKey(x, y, boardSx, boardSy) {
    const sx = Number.isInteger(boardSx) ? boardSx : MIDDLE_BOARD_SX;
    const sy = Number.isInteger(boardSy) ? boardSy : MIDDLE_BOARD_SY;
    return `${sx}|${sy}|${Math.floor(Number(x))}|${Math.floor(Number(y))}`;
}

function syncPlayerTrailOccSet(player) {
    if (!player) return;
    if (!player._trailOccSet) player._trailOccSet = new Set();
    player._trailOccSet.clear();
    const trail = player.trail;
    if (!trail || !trail.length) {
        player._trailOccSyncedGen = player._trailGen || 0;
        return;
    }
    const defSx = Number.isInteger(player.boardSx) ? player.boardSx : MIDDLE_BOARD_SX;
    const defSy = Number.isInteger(player.boardSy) ? player.boardSy : MIDDLE_BOARD_SY;
    for (let i = 0, len = trail.length; i < len; i++) {
        const t = trail[i];
        player._trailOccSet.add(trailOccKey(
            Math.floor(Number(t.x)),
            Math.floor(Number(t.y)),
            Number.isInteger(t.boardSx) ? t.boardSx : defSx,
            Number.isInteger(t.boardSy) ? t.boardSy : defSy
        ));
    }
    player._trailOccSyncedGen = player._trailGen || 0;
}

/** Wipe trail paint + occupancy caches (round reset / lobby — prevents phantom trail KOs). */
function clearPlayerTrailState(player) {
    if (!player) return;
    if (Array.isArray(player.trail)) player.trail.length = 0;
    else player.trail = [];
    if (player._trailPaintSet) player._trailPaintSet.clear();
    if (player._trailOccSet) player._trailOccSet.clear();
    player._trailGen = 0;
    player._trailOccSyncedGen = 0;
    player._trailByBoard = null;
    player._trailIndexLen = 0;
    player._trailIndexGen = 0;
}

function playerTrailOccupiesCell(player, x, y, boardSx, boardSy) {
    if (!player) return false;
    if (!player.trail || !player.trail.length) return false;
    // Query board = where the victim stands (passed in). Never default to trail owner's board.
    const qsx = Number.isInteger(boardSx) ? boardSx : MIDDLE_BOARD_SX;
    const qsy = Number.isInteger(boardSy) ? boardSy : MIDDLE_BOARD_SY;
    const ix = Math.floor(Number(x));
    const iy = Math.floor(Number(y));
    const key = trailOccKey(ix, iy, qsx, qsy);
    if (player._trailOccSet) {
        if (player._trailOccSyncedGen !== (player._trailGen || 0)) {
            syncPlayerTrailOccSet(player);
        }
        return player._trailOccSet.has(key);
    }
    if (!player.trail || !player.trail.length) return false;
    const defSx = Number.isInteger(player.boardSx) ? player.boardSx : MIDDLE_BOARD_SX;
    const defSy = Number.isInteger(player.boardSy) ? player.boardSy : MIDDLE_BOARD_SY;
    for (let i = 0, len = player.trail.length; i < len; i++) {
        const t = player.trail[i];
        const tsx = Number.isInteger(t.boardSx) ? t.boardSx : defSx;
        const tsy = Number.isInteger(t.boardSy) ? t.boardSy : defSy;
        if (Math.floor(Number(t.x)) === ix && Math.floor(Number(t.y)) === iy
            && tsx === qsx && tsy === qsy) return true;
    }
    return false;
}

/** Paint one cell. Infinite Trails: unique cells forever (painted floor, not a fading snake). */
function pushPlayerTrailCell(player, x, y, boardSx, boardSy) {
    if (!player) return;
    if (!Array.isArray(player.trail)) player.trail = [];
    const ix = Math.floor(Number(x));
    const iy = Math.floor(Number(y));
    const sx = Number.isInteger(boardSx) ? boardSx
        : (Number.isInteger(player.boardSx) ? player.boardSx : MIDDLE_BOARD_SX);
    const sy = Number.isInteger(boardSy) ? boardSy
        : (Number.isInteger(player.boardSy) ? player.boardSy : MIDDLE_BOARD_SY);
    if (playerHasInfiniteTrails(player)) {
        player.infiniteTrailsActive = true;
        if (!player._trailPaintSet) player._trailPaintSet = new Set();
        if (player.trail.length === 0 && player._trailPaintSet.size) player._trailPaintSet.clear();
        const key = trailPaintKey(ix, iy, sx, sy);
        if (player._trailPaintSet.has(key)) return;
        player._trailPaintSet.add(key);
    }
    player.trail.push({ x: ix, y: iy, boardSx: sx, boardSy: sy });
    player._trailGen = (player._trailGen || 0) + 1;
    if (!player._trailOccSet) player._trailOccSet = new Set();
    player._trailOccSet.add(trailOccKey(ix, iy, sx, sy));
    if (typeof trimPlayerTrail === 'function') trimPlayerTrail(player);
}

/** Remove one trail cell (e.g. charge landing under the head so self-collision isn't instant). */
function removePlayerTrailCellAt(player, x, y, boardSx, boardSy) {
    if (!player || !Array.isArray(player.trail) || !player.trail.length) return;
    const sx = Number.isInteger(boardSx) ? boardSx : player.boardSx;
    const sy = Number.isInteger(boardSy) ? boardSy : player.boardSy;
    const ix = Math.floor(Number(x));
    const iy = Math.floor(Number(y));
    const occ = trailOccKey(ix, iy, sx, sy);
    const paint = trailPaintKey(ix, iy, sx, sy);
    let removed = false;
    for (let i = player.trail.length - 1; i >= 0; i--) {
        const t = player.trail[i];
        const tsx = Number.isInteger(t.boardSx) ? t.boardSx : player.boardSx;
        const tsy = Number.isInteger(t.boardSy) ? t.boardSy : player.boardSy;
        if (Math.floor(Number(t.x)) === ix && Math.floor(Number(t.y)) === iy && tsx === sx && tsy === sy) {
            player.trail.splice(i, 1);
            removed = true;
            break; // only the newest matching head cell
        }
    }
    if (!removed) return;
    player._trailGen = (player._trailGen || 0) + 1;
    if (player._trailOccSet) player._trailOccSet.delete(occ);
    if (player._trailPaintSet) player._trailPaintSet.delete(paint);
}

function trimPlayerTrail(player, maxOverride = null) {
    if (!player || !Array.isArray(player.trail)) return;
    // Keep flag in sync — Infinite Trails is passive and must stay on
    if (playerHasInfiniteTrails(player)) {
        player.infiniteTrailsActive = true;
    }
    const mapCap = getMaxTrailPoints();
    let maxTrail;
    if (Number.isFinite(maxOverride) && !playerHasInfiniteTrails(player)) {
        maxTrail = Math.max(1, Math.min(mapCap, maxOverride));
    } else if (playerHasInfiniteTrails(player)) {
        maxTrail = mapCap; // forever — only hard map ceiling
    } else {
        maxTrail = Math.max(1, Math.min(
            mapCap,
            TRAIL_LENGTH + (player.jokerTrailBonusLength || 0) + (player.growTrailBonus || 0) - (player.jokerTrailReduce || 0)
        ));
    }
    while (player.trail.length > maxTrail) {
        const dropped = player.trail.shift();
        player._trailGen = (player._trailGen || 0) + 1;
        if (player._trailPaintSet && dropped) {
            player._trailPaintSet.delete(trailPaintKey(
                dropped.x, dropped.y, dropped.boardSx, dropped.boardSy
            ));
        }
        if (player._trailOccSet && dropped) {
            const dsx = Number.isInteger(dropped.boardSx) ? dropped.boardSx : player.boardSx;
            const dsy = Number.isInteger(dropped.boardSy) ? dropped.boardSy : player.boardSy;
            player._trailOccSet.delete(trailOccKey(dropped.x, dropped.y, dsx, dsy));
        }
    }
}

function rebuildPlayerTrailOcc(player) {
    syncPlayerTrailOccSet(player);
}
const DASH_COOLDOWN = 500; 
const CHARGE_COOLDOWN = 4000; 
const SKILL_COOLDOWN = 4000; // 4s universal cooldown (faster!)
const MAX_LASER_ROUTINES = 3;
/** While a laser wave is already running, restack is allowed sooner. */
const LASER_STACK_COOLDOWN = 1700; // was 2200 — 0.5s faster
/** First laser cast also 0.5s faster than universal skill CD. */
const LASER_BASE_COOLDOWN = 3500;
/** Full invis (cube + trail hide from enemies) — activate duration only. */
const INVISIBLE_FULL_DURATION_SEC = 3;
/** Invisible skill activate CD is +2s vs the universal 4s base. */
const INVISIBLE_SKILL_COOLDOWN_EXTRA = 2000;

function getSkillCooldownMs(player) {
    if (!player?.selectedSkill) return SKILL_COOLDOWN;
    if (player.selectedSkill === SKILL_TYPES.LASER) {
        if (Array.isArray(player.activeLaserRoutines) && player.activeLaserRoutines.length > 0) {
            return LASER_STACK_COOLDOWN;
        }
        return LASER_BASE_COOLDOWN;
    }
    const cloneExtra = (player.selectedSkill === SKILL_TYPES.CLONES) ? 1000 : 0;
    const invisExtra = (player.selectedSkill === SKILL_TYPES.INVISIBLE) ? INVISIBLE_SKILL_COOLDOWN_EXTRA : 0;
    return SKILL_COOLDOWN + cloneExtra + invisExtra;
}

// --- 9 INDEPENDENT BOARDS + CHECKPOINTS (only current board is rendered) ---
let worldBoards = []; // 9 boards, each GRID_COUNT×GRID_COUNT locally
let boardCaptureFlash = 0;
let lastBoardWinReason = null; // 'kill' | 'ttt'
const BOARD_TTT_LINES = Object.freeze([
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
]);
let _hudFocusBoardKey = '';
let _boardHudCache = '';
let viewBoardSx = MIDDLE_BOARD_SX;
let viewBoardSy = MIDDLE_BOARD_SY;

function middleBoardOrigin() {
    // Positions are always board-local; start coords live on middle board via boardSx/Sy
    return { ox: 0, oy: 0 };
}

function boardIndexFromSector(sx, sy) {
    return sy * BOARDS_PER_SIDE + sx;
}

function wrapBoardIndex(v) {
    const n = BOARDS_PER_SIDE;
    return ((v % n) + n) % n;
}

function ensurePlayerBoard(player) {
    if (!player) return;
    if (!Number.isInteger(player.boardSx)) player.boardSx = MIDDLE_BOARD_SX;
    if (!Number.isInteger(player.boardSy)) player.boardSy = MIDDLE_BOARD_SY;
}

function cellToBoardCoords(x, y, entity) {
    // Local coords + board id on the entity (player / trail / apple / etc.)
    if (entity && Number.isInteger(entity.boardSx) && Number.isInteger(entity.boardSy)) {
        return { sx: entity.boardSx, sy: entity.boardSy };
    }
    return { sx: viewBoardSx, sy: viewBoardSy };
}

function sameBoardCoords(a, b) {
    if (!a || !b) return false;
    const as = Number.isInteger(a.boardSx) ? a.boardSx : viewBoardSx;
    const ay = Number.isInteger(a.boardSy) ? a.boardSy : viewBoardSy;
    const bs = Number.isInteger(b.boardSx) ? b.boardSx : viewBoardSx;
    const by = Number.isInteger(b.boardSy) ? b.boardSy : viewBoardSy;
    return as === bs && ay === by;
}

function isOnViewBoard(entity) {
    if (!entity) return false;
    const sx = Number.isInteger(entity.boardSx) ? entity.boardSx : viewBoardSx;
    const sy = Number.isInteger(entity.boardSy) ? entity.boardSy : viewBoardSy;
    return sx === viewBoardSx && sy === viewBoardSy;
}

/** Pixel stride between platform boards (board size + visual gap). */
function getBoardStridePx() {
    return GRID_COUNT * GRID_SIZE + (typeof BOARD_PLATFORM_GAP === 'number' ? BOARD_PLATFORM_GAP : GRID_SIZE);
}

const BOARD_VIS_HIDDEN = Object.freeze({ ox: 0, oy: 0, ndx: 0, ndy: 0, visible: false });
const BOARD_VIS_HOME = Object.freeze({ ox: 0, oy: 0, ndx: 0, ndy: 0, visible: true });
const boardVisPool = Array.from({ length: 16 }, () => ({ ox: 0, oy: 0, ndx: 0, ndy: 0, visible: true }));
let boardVisIdx = 0;

/**
 * Visual world offset for a board relative to the focused view board.
 * Includes platform gap so peeks line up with neighbor grid strips.
 */
function getBoardVisualOffset(sx, sy) {
    const nsx = Number.isInteger(sx) ? sx : viewBoardSx;
    const nsy = Number.isInteger(sy) ? sy : viewBoardSy;
    const ndx = nsx - viewBoardSx;
    const ndy = nsy - viewBoardSy;
    if (ndx === 0 && ndy === 0) return BOARD_VIS_HOME;
    if (Math.abs(ndx) > 1 || Math.abs(ndy) > 1) return BOARD_VIS_HIDDEN;
    if (nsx < 0 || nsx >= BOARDS_PER_SIDE || nsy < 0 || nsy >= BOARDS_PER_SIDE) {
        return BOARD_VIS_HIDDEN;
    }
    const stride = getBoardStridePx();
    const out = boardVisPool[boardVisIdx];
    boardVisIdx = (boardVisIdx + 1) & 15;
    out.ox = ndx * stride;
    out.oy = ndy * stride;
    out.ndx = ndx;
    out.ndy = ndy;
    out.visible = true;
    return out;
}

/** True if a local cell on neighbor (ndx,ndy) sits inside the visible peek strip. */
function isLocalCellInNeighborPeek(ndx, ndy, lx, ly) {
    if (ndx === 0 && ndy === 0) return true;
    const edge = typeof NEIGHBOR_EDGE_CELLS === 'number' ? NEIGHBOR_EDGE_CELLS : 5;
    const cx = Math.floor(Number(lx));
    const cy = Math.floor(Number(ly));
    if (ndx === 1 && cx >= edge) return false;
    if (ndx === -1 && cx < GRID_COUNT - edge) return false;
    if (ndy === 1 && cy >= edge) return false;
    if (ndy === -1 && cy < GRID_COUNT - edge) return false;
    return true;
}

/** Inclusive cell bounds of the visible strip for a neighbor (or full board for view). */
function getPeekCellBounds(ndx, ndy) {
    let x0 = 0;
    let x1 = GRID_COUNT - 1;
    let y0 = 0;
    let y1 = GRID_COUNT - 1;
    const edge = typeof NEIGHBOR_EDGE_CELLS === 'number' ? NEIGHBOR_EDGE_CELLS : 5;
    if (ndx === 1) {
        x0 = 0;
        x1 = edge - 1;
    } else if (ndx === -1) {
        x0 = GRID_COUNT - edge;
        x1 = GRID_COUNT - 1;
    }
    if (ndy === 1) {
        y0 = 0;
        y1 = edge - 1;
    } else if (ndy === -1) {
        y0 = GRID_COUNT - edge;
        y1 = GRID_COUNT - 1;
    }
    return { x0, x1, y0, y1 };
}

/**
 * Call fn for the view board and every real adjacent peek board.
 * fn({ sx, sy, ndx, ndy, ox, oy, bounds })
 */
function forEachVisibleBoardSurface(fn) {
    if (typeof fn !== 'function') return;
    const visit = (sx, sy, ndx, ndy) => {
        if (sx < 0 || sx >= BOARDS_PER_SIDE || sy < 0 || sy >= BOARDS_PER_SIDE) return;
        const off = getBoardVisualOffset(sx, sy);
        if (!off.visible) return;
        fn({
            sx,
            sy,
            ndx,
            ndy,
            ox: off.ox,
            oy: off.oy,
            bounds: getPeekCellBounds(ndx, ndy)
        });
    };
    visit(viewBoardSx, viewBoardSy, 0, 0);
    for (let ndx = -1; ndx <= 1; ndx++) {
        for (let ndy = -1; ndy <= 1; ndy++) {
            if (ndx === 0 && ndy === 0) continue;
            visit(viewBoardSx + ndx, viewBoardSy + ndy, ndx, ndy);
        }
    }
}

/** View board OR visible neighbor peek edge. */
function isEntityVisibleFromView(entity, cellX, cellY) {
    if (!entity) return false;
    const sx = Number.isInteger(entity.boardSx) ? entity.boardSx : viewBoardSx;
    const sy = Number.isInteger(entity.boardSy) ? entity.boardSy : viewBoardSy;
    const off = getBoardVisualOffset(sx, sy);
    if (!off.visible) return false;
    const lx = cellX !== undefined && cellX !== null ? cellX : entity.x;
    const ly = cellY !== undefined && cellY !== null ? cellY : entity.y;
    return isLocalCellInNeighborPeek(off.ndx, off.ndy, lx, ly);
}

function updateViewBoard() {
    // Spectate: free camera — player WASD moves the view; never force-follow AI boards
    if (typeof isSpectateMode !== 'undefined' && isSpectateMode) return;
    const focus = p1;
    if (focus) {
        ensurePlayerBoard(focus);
        if (viewBoardSx === focus.boardSx && viewBoardSy === focus.boardSy) return;
        viewBoardSx = focus.boardSx;
        viewBoardSy = focus.boardSy;
    }
}

function getSpectateViewControls() {
    try {
        const saved = getRonkControlsParsed();
        return {
            up: (saved.up || 'w').toLowerCase(),
            down: (saved.down || 's').toLowerCase(),
            left: (saved.left || 'a').toLowerCase(),
            right: (saved.right || 'd').toLowerCase()
        };
    } catch (_) {
        return { up: 'w', down: 's', left: 'a', right: 'd' };
    }
}

/** Move spectate camera one board with WASD (or remapped move keys). Returns true if handled. */
function handleSpectateViewInput(key) {
    if (!isSpectateMode) return false;
    if (gameState !== 'PLAYING' && gameState !== 'COUNTDOWN' && gameState !== 'ROUND_OVER') return false;
    if (isPaused || isResuming) return false;
    const c = getSpectateViewControls();
    let dx = 0;
    let dy = 0;
    if (key === c.up || key === 'arrowup') dy = -1;
    else if (key === c.down || key === 'arrowdown') dy = 1;
    else if (key === c.left || key === 'arrowleft') dx = -1;
    else if (key === c.right || key === 'arrowright') dx = 1;
    else return false;
    viewBoardSx = wrapBoardIndex(viewBoardSx + dx);
    viewBoardSy = wrapBoardIndex(viewBoardSy + dy);
    return true;
}

function getBoardAtCell(x, y, entity) {
    const { sx, sy } = cellToBoardCoords(x, y, entity);
    return worldBoards[boardIndexFromSector(sx, sy)] || null;
}

/**
 * Border Safe auto-ride: when walking into a rim, turn parallel and keep moving
 * without needing a manual key press. Slide side is 50/50 each impact.
 */
function pickBorderSafeSlideDir(player, hitDx, hitDy) {
    if (!player) return null;

    let a = null;
    let b = null;
    if (hitDx < 0 || hitDx > 0) {
        // Hit left/right wall — slide up or down
        a = { x: 0, y: -1 };
        b = { x: 0, y: 1 };
    } else if (hitDy < 0 || hitDy > 0) {
        // Hit top/bottom wall — slide left or right
        a = { x: -1, y: 0 };
        b = { x: 1, y: 0 };
    } else {
        return null;
    }

    const canStep = (d) => {
        const nx = player.x + d.x;
        const ny = player.y + d.y;
        return nx >= 0 && nx < GRID_COUNT && ny >= 0 && ny < GRID_COUNT;
    };

    const first = Math.random() < 0.5 ? a : b;
    const second = first === a ? b : a;
    if (canStep(first)) return first;
    if (canStep(second)) return second;
    return null;
}

/**
 * After a 1-cell step: leaving the current board (local GRID_COUNT edge)
 * either kills (walk), auto-slides along the rim (border-safe), or switches boardId +
 * wraps to opposite edge (dash/charge only).
 * Returns true if the player died.
 */
function resolveSectorMove(player, fromX, fromY, allowCross) {
    if (!player || player.isDead) return true;
    ensurePlayerBoard(player);

    let dx = 0;
    let dy = 0;
    if (player.x < 0) dx = -1;
    else if (player.x >= GRID_COUNT) dx = 1;
    if (player.y < 0) dy = -1;
    else if (player.y >= GRID_COUNT) dy = 1;

    if (dx === 0 && dy === 0) return false;

    // Border Safe: auto-slide along the border line (no board hop, no death).
    // Only dash/charge (allowCross) may hop to an adjacent board.
    if (!allowCross) {
        if (player.jokerBorderSafe) {
            player.x = Math.max(0, Math.min(GRID_COUNT - 1, player.x));
            player.y = Math.max(0, Math.min(GRID_COUNT - 1, player.y));

            const slide = pickBorderSafeSlideDir(player, dx, dy);
            if (slide) {
                player.dir = { x: slide.x, y: slide.y };
                if (Array.isArray(player.moveBuffer)) player.moveBuffer.length = 0;
                // Take the slide step immediately so movement doesn't stall for a tick
                const nx = player.x + slide.x;
                const ny = player.y + slide.y;
                if (nx >= 0 && nx < GRID_COUNT && ny >= 0 && ny < GRID_COUNT) {
                    player.x = nx;
                    player.y = ny;
                }
            }
            return false;
        }
        player.x = Math.max(0, Math.min(GRID_COUNT - 1, fromX));
        player.y = Math.max(0, Math.min(GRID_COUNT - 1, fromY));
        player.die('fall', 'resolveSectorMove');
        return true;
    }

    const nsx = wrapBoardIndex(player.boardSx + dx);
    const nsy = wrapBoardIndex(player.boardSy + dy);

    let lx = fromX;
    let ly = fromY;
    if (dx < 0) lx = GRID_COUNT - 1;
    else if (dx > 0) lx = 0;
    if (dy < 0) ly = GRID_COUNT - 1;
    else if (dy > 0) ly = 0;

    player.boardSx = nsx;
    player.boardSy = nsy;
    player.x = lx;
    player.y = ly;
    if (player === p1 && !player.isAI) {
        window.RonkSteamAchievements?.onBoardHopped?.();
    }
    // Landing: always snap pose so hops don't smear across neighboring peek tiles
    player.prevX = lx;
    player.prevY = ly;
    player.rollProgress = 1;
    return false;
}

function averageColorFromImage(img) {
    try {
        if (!img || !img.complete || !img.naturalWidth) return null;
        const c = document.createElement('canvas');
        c.width = 16; c.height = 16;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, 16, 16);
        const data = cx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a < 40) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
        if (!n) return null;
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        return `rgb(${r},${g},${b})`;
    } catch (_) {
        return null;
    }
}

function getOwnerCaptureColor(ownerKey) {
    if (ownerKey === 'player') {
        const imgColor = (typeof playerImage !== 'undefined' && playerImage && currentColorIndex === neonColors.length - 1)
            ? averageColorFromImage(playerImage)
            : null;
        return imgColor || (p1 && p1.color) || '#ff3355';
    }
    if (ownerKey === 'enemy') {
        const img = p2 && p2.customImage ? averageColorFromImage(p2.customImage) : null;
        return img || (p2 && p2.color) || '#33aaff';
    }
    return 'rgba(255,255,255,0.15)';
}

function ownerKeyForPlayer(player) {
    if (!player) return null;
    const base = getPlayerBaseId(player.id);
    if (base === '1' || player === p1 || player.owner === 'player') return 'player';
    return 'enemy';
}

/** Shared online match RNG — host sends matchSeed so boards/apples match. */
let matchSeed = 0;
let _matchRngState = 0;
function mulberry32(a) {
    return function () {
        let t = (a += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
let _matchRngNext = null;
function setMatchSeed(seed) {
    matchSeed = (Number(seed) >>> 0) || (Math.floor(Math.random() * 0xffffffff) >>> 0);
    _matchRngState = matchSeed;
    _matchRngNext = mulberry32(matchSeed);
}
function matchRandom() {
    if (!_matchRngNext) setMatchSeed(Math.floor(Math.random() * 0xffffffff));
    return _matchRngNext();
}

function initWorldBoards() {
    worldBoards = [];
    boardCaptureFlash = 0;
    lastBoardWinReason = null;
    _hudFocusBoardKey = '';
    viewBoardSx = MIDDLE_BOARD_SX;
    viewBoardSy = MIDDLE_BOARD_SY;
    const midY = Math.floor(GRID_COUNT / 2);

    for (let sy = 0; sy < BOARDS_PER_SIDE; sy++) {
        for (let sx = 0; sx < BOARDS_PER_SIDE; sx++) {
            const occupied = new Set();
            if (sx === MIDDLE_BOARD_SX && sy === MIDDLE_BOARD_SY) {
                occupied.add(`1_${midY}`);
                occupied.add(`${GRID_COUNT - 2}_${midY}`);
            }
            const checkpoints = buildCheckpointsForBoard(sx, sy, occupied);
            worldBoards.push({
                sx, sy,
                owner: null,
                captureColor: null,
                checkpoints
            });
        }
    }
    _boardHudCache = '';
    _hudFocusBoardKey = '';
    updateBoardOwnershipHud();
}

function buildCheckpointsForBoard(sx, sy, reservedCells) {
    const reserved = new Set(reservedCells || []);
    const candidates = [];
    for (let y = 1; y < GRID_COUNT - 1; y++) {
        for (let x = 1; x < GRID_COUNT - 1; x++) {
            const key = `${x}_${y}`;
            if (reserved.has(key)) continue;
            candidates.push({ x, y });
        }
    }
    // Fresh layout every board — online uses shared matchSeed via matchRandom()
    for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(matchRandom() * (i + 1));
        const tmp = candidates[i];
        candidates[i] = candidates[j];
        candidates[j] = tmp;
    }
    const checkpoints = [];
    const reserveCaptureFootprint = (x, y) => {
        // Keep capture crosses from overlapping so precision still matters
        const cells = [
            [x, y],
            [x + 1, y], [x - 1, y],
            [x, y + 1], [x, y - 1]
        ];
        for (const [cx, cy] of cells) {
            if (cx < 0 || cy < 0 || cx >= GRID_COUNT || cy >= GRID_COUNT) continue;
            reserved.add(`${cx}_${cy}`);
        }
    };
    for (const cell of candidates) {
        if (checkpoints.length >= CHECKPOINTS_PER_BOARD) break;
        const key = `${cell.x}_${cell.y}`;
        if (reserved.has(key)) continue;
        const ortho = [
            [cell.x + 1, cell.y], [cell.x - 1, cell.y],
            [cell.x, cell.y + 1], [cell.x, cell.y - 1]
        ];
        if (ortho.some(([ox, oy]) => reserved.has(`${ox}_${oy}`))) continue;
        reserveCaptureFootprint(cell.x, cell.y);
        checkpoints.push({
            x: cell.x,
            y: cell.y,
            boardSx: sx,
            boardSy: sy,
            owner: null,
            pulse: matchRandom() * Math.PI * 2
        });
    }
    return checkpoints;
}

function isPlayerOnCheckpointCell(player, cp) {
    if (!player || !cp) return false;
    ensurePlayerBoard(player);
    const bsx = Number.isInteger(cp.boardSx) ? cp.boardSx : MIDDLE_BOARD_SX;
    const bsy = Number.isInteger(cp.boardSy) ? cp.boardSy : MIDDLE_BOARD_SY;
    if (player.boardSx !== bsx || player.boardSy !== bsy) return false;
    const px = Math.round(player.x);
    const py = Math.round(player.y);
    const dx = Math.abs(px - cp.x);
    const dy = Math.abs(py - cp.y);
    // Center + 4 orthogonal neighbors (5 cells): must line up on row/col — precise, not free 3×3
    if ((dx + dy) <= 1) return true;
    if (typeof isTutorialCheckpointStep === 'function' && isTutorialCheckpointStep() && player === p1) {
        return dx <= 1 && dy <= 1;
    }
    return false;
}

function tryClaimCheckpointsAt(player) {
    if (!player || player.isDead || !worldBoards.length) return;
    if (gameState !== 'PLAYING') return;
    if (typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase()) {
        if (!isTutorialCheckpointStep()) return;
    }
    ensurePlayerBoard(player);
    const ownerKey = ownerKeyForPlayer(player);
    if (!ownerKey) return;

    const board = worldBoards[boardIndexFromSector(player.boardSx, player.boardSy)];
    if (!board || !Array.isArray(board.checkpoints)) return;
    if (board.owner) return;
    let changed = false;
    for (const cp of board.checkpoints) {
        if (!isPlayerOnCheckpointCell(player, cp)) continue;
        if (cp.owner === ownerKey) continue;
        cp.owner = ownerKey;
        changed = true;
        SFX.play('button', 0.55);
        evaluateBoardCapture(board);
    }
    if (changed) {
        updateBoardOwnershipHud();
        try { if (typeof sendHostWorldSnapshot === 'function') sendHostWorldSnapshot(); } catch (_) { /* ignore */ }
    }
}

function checkCheckpointClaims() {
    if (gameState !== 'PLAYING' || !worldBoards.length) return;
    if (typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase()) {
        if (typeof isTutorialCheckpointStep !== 'function' || !isTutorialCheckpointStep()) return;
        if (p1 && !p1.isDead) tryClaimCheckpointsAt(p1);
        return;
    }
    if (p1 && !p1.isDead) tryClaimCheckpointsAt(p1);
    if (p2 && !p2.isDead) tryClaimCheckpointsAt(p2);
}

function areAllBoardsClaimed() {
    return worldBoards.length >= 9 && worldBoards.every((b) => b.owner);
}

function usesBoardControlMatchRules() {
    if (typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase()) return false;
    return worldBoards.length >= 9;
}

function respawnPlayerAfterDeath(player) {
    if (!player || !player.isDead) return;
    const { ox, oy } = middleBoardOrigin();
    const midY = oy + Math.floor(GRID_COUNT / 2);
    const isP1 = player === p1 || getPlayerBaseId(player.id) === '1';
    player.boardSx = MIDDLE_BOARD_SX;
    player.boardSy = MIDDLE_BOARD_SY;
    player.x = isP1 ? ox + 1 : ox + GRID_COUNT - 2;
    player.y = isP1 ? midY - 1 : midY + 1;
    player.prevX = player.x;
    player.prevY = player.y;
    player.dir = isP1 ? { x: 1, y: 0 } : { x: -1, y: 0 };
    player.trail = [];
    player.moveBuffer = [];
    player.isDead = false;
    player.deathAnimTicks = 0;
    player.deathType = null;
    player.deathPos = null;
    player.isImmune = false;
    player.immuneTimer = 0;
    player._spawnGraceTicks = 0;
    player.isCharging = false;
    player.chargeAnimTicks = 0;
    player.isDashing = false;
    player.dashAnimTicks = 0;
    notePlayerBoardPresence(player);
    updateViewBoard();
    updateBoardOwnershipHud();
}

function evaluateBoardCapture(board) {
    if (!board) return;
    if (board.owner) return;
    const counts = { player: 0, enemy: 0 };
    board.checkpoints.forEach(cp => {
        if (cp.owner === 'player') counts.player++;
        else if (cp.owner === 'enemy') counts.enemy++;
    });
    let newOwner = null;
    // Must claim ALL 3 checkpoints — 2 does not count
    if (counts.player >= CHECKPOINTS_PER_BOARD) newOwner = 'player';
    else if (counts.enemy >= CHECKPOINTS_PER_BOARD) newOwner = 'enemy';
    if (newOwner) {
        board.owner = newOwner;
        board.captureColor = getOwnerCaptureColor(newOwner);
        board.checkpoints.forEach((cp) => { cp.owner = newOwner; });
        boardCaptureFlash = 18;
        SFX.play('win', 0.45);
        if (newOwner === 'player') {
            try {
                const st = loadPlayerStats();
                st.boardsClaimed = (st.boardsClaimed || 0) + 1;
                savePlayerStats(st);
            } catch (_) { /* ignore */ }
        }
        updateBoardOwnershipHud();
        if (newOwner === 'player' && typeof notifyFirstBoardCapture === 'function') {
            notifyFirstBoardCapture();
        }
        checkTicTacToeBoardWin();
    }
}

function countOwnedBoards() {
    let player = 0, enemy = 0;
    worldBoards.forEach(b => {
        if (b.owner === 'player') player++;
        else if (b.owner === 'enemy') enemy++;
    });
    return { player, enemy };
}

/** Winning line of 3 owned boards (row / column / diagonal), or null. */
function findTicTacToeWinner() {
    if (!worldBoards || worldBoards.length < 9) return null;
    for (let li = 0; li < BOARD_TTT_LINES.length; li++) {
        const line = BOARD_TTT_LINES[li];
        const a = worldBoards[line[0]]?.owner;
        if (!a) continue;
        if (a === worldBoards[line[1]]?.owner && a === worldBoards[line[2]]?.owner) {
            return { owner: a, line };
        }
    }
    return null;
}

/** Win one round with a tic-tac-toe line; match still first-to-MATCH_TARGET rounds. */
function checkTicTacToeBoardWin() {
    if (gameState !== 'PLAYING' || !p1 || !p2) return;
    if (typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase()) return;
    if (!usesBoardControlMatchRules()) return;
    if (roundOutcomeScored) return;
    // Guest mirrors host score packet — don't double-award TTT locally
    if (isOnline && onlineRole === 'guest') return;
    const win = findTicTacToeWinner();
    if (!win) return;

    roundOutcomeScored = true;
    lastBoardWinReason = 'ttt';
    roundsCompletedThisMatch++;
    if (win.owner === 'player') {
        p1Score++;
        if (!isSpectateMode && !(typeof isTutorialMatch !== 'undefined' && isTutorialMatch)) {
            sessionTttRoundWins++;
        }
    } else {
        p2Score++;
    }
    matchesPlayed++;
    updateScoreboard();
    updateBoardOwnershipHud();
    if (isOnline && onlineRole === 'host' && conn && conn.open) {
        try {
            sendOnlineSealed({
                type: 'round-score',
                p1Score,
                p2Score,
                roundsCompletedThisMatch,
                lastBoardWinReason: 'ttt',
                outcome: win.owner === 'player' ? 'p1' : 'p2'
            });
        } catch (_) { /* ignore */ }
    }

    const target = getEffectiveMatchTarget();
    if (p1Score >= target || p2Score >= target) {
        gameState = 'GAME_OVER';
    } else {
        gameState = 'ROUND_OVER';
    }
    scheduleRoundEndTransition();
}

/** @deprecated — kept for AI/compat; all-boards win no longer ends the match. */
function checkAllBoardsClaimedWin() {
    checkTicTacToeBoardWin();
}

function notePlayerBoardPresence(player) {
    if (!player || (player !== p1 && player !== p2)) return;
    if (!worldBoards.length) return;
    ensurePlayerBoard(p1);
    ensurePlayerBoard(p2);
    const key = `${p1 ? p1.boardSx : -1}_${p1 ? p1.boardSy : -1}_${p2 ? p2.boardSx : -1}_${p2 ? p2.boardSy : -1}`;
    if (key === _hudFocusBoardKey) return;
    _hudFocusBoardKey = key;
    updateViewBoard();
    updateBoardOwnershipHud();
}

function colorWithAlpha(color, alpha) {
    if (!color) return `rgba(255,255,255,${alpha})`;
    const m = String(color).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
    const hex = String(color).trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
        let h = hex.slice(1);
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
}

function updateBoardOwnershipHud() {
    const root = document.getElementById('board-ownership-hud');
    if (!root || !worldBoards.length) return;
    if (p1) ensurePlayerBoard(p1);
    if (p2) ensurePlayerBoard(p2);

    const p1Color = getOwnerCaptureColor('player') || (p1 && p1.color) || '#ff4d6a';
    const p2Color = getOwnerCaptureColor('enemy') || (p2 && p2.color) || '#4da3ff';
    root.style.setProperty('--board-fill-p1', colorWithAlpha(p1Color, 0.78));
    root.style.setProperty('--board-fill-p2', colorWithAlpha(p2Color, 0.78));
    root.style.setProperty('--board-outline-p1', p1Color);
    root.style.setProperty('--board-outline-p2', p2Color);

    const counts = countOwnedBoards();
    const cellParts = [];
    worldBoards.forEach((board, i) => {
        const pCount = board.checkpoints.filter(c => c.owner === 'player').length;
        const eCount = board.checkpoints.filter(c => c.owner === 'enemy').length;
        const isP1Here = !!(p1 && board.sx === p1.boardSx && board.sy === p1.boardSy);
        const isP2Here = !!(p2 && board.sx === p2.boardSx && board.sy === p2.boardSy);
        cellParts.push([
            board.owner || '-',
            pCount,
            eCount,
            isP1Here ? 1 : 0,
            isP2Here ? 1 : 0,
            p1Color,
            p2Color
        ].join(':'));
    });
    const hash = `${cellParts.join('|')}|${counts.player}/${counts.enemy}`;
    if (hash === _boardHudCache) return;
    _boardHudCache = hash;

    const cells = root.querySelectorAll('.board-hud-cell');
    const ttt = findTicTacToeWinner();
    const winSet = ttt ? new Set(ttt.line) : null;
    worldBoards.forEach((board, i) => {
        const cell = cells[i];
        if (!cell) return;
        const progress = board.owner ? CHECKPOINTS_PER_BOARD : 0;
        cell.dataset.owner = board.owner || '';
        cell.dataset.cp = String(progress);
        const isP1Here = !!(p1 && board.sx === p1.boardSx && board.sy === p1.boardSy);
        const isP2Here = !!(p2 && board.sx === p2.boardSx && board.sy === p2.boardSy);
        // Fill = captured by that player; outline = who is currently on the board
        cell.classList.toggle('board-captured', !!board.owner);
        cell.classList.toggle('board-p1-here', isP1Here);
        cell.classList.toggle('board-p2-here', isP2Here);
        // Keep legacy classes for tutorial styling
        cell.classList.toggle('board-current', isP1Here);
        cell.classList.toggle('board-current-enemy', isP2Here && !isP1Here);
        cell.classList.toggle('board-current-both', isP1Here && isP2Here);
        cell.classList.toggle('board-ttt-win', !!(winSet && winSet.has(i)));
    });
    const label = document.getElementById('board-ownership-label');
    if (label) label.textContent = `${counts.player} / ${counts.enemy}`;
    syncTutorialBoardMapMirror();
}

function getTutorialLiveBoardMapHtml() {
    const cells = Array.from({ length: 9 }, (_, i) =>
        `<div class="board-hud-cell" data-board="${i}"></div>`
    ).join('');
    return `<div id="tutorial-live-board-map" class="tutorial-live-board-map" aria-label="Board map">
        <div class="board-hud-meta">
            <span class="board-hud-label">map</span>
            <span class="tutorial-board-map-label">0 / 0</span>
        </div>
        <div class="board-hud-grid tutorial-board-hud-grid">${cells}</div>
    </div>`;
}

function syncTutorialBoardMapMirror() {
    const mirror = document.getElementById('tutorial-live-board-map');
    if (!mirror) return;
    const src = document.getElementById('board-ownership-hud');
    if (src) {
        ['--board-fill-p1', '--board-fill-p2', '--board-outline-p1', '--board-outline-p2'].forEach((k) => {
            const v = src.style.getPropertyValue(k);
            if (v) mirror.style.setProperty(k, v);
        });
    }
    const srcCells = document.querySelectorAll('#board-ownership-hud .board-hud-cell');
    const dstCells = mirror.querySelectorAll('.board-hud-cell');
    srcCells.forEach((srcCell, i) => {
        const dst = dstCells[i];
        if (!dst) return;
        dst.dataset.owner = srcCell.dataset.owner || '';
        dst.dataset.cp = srcCell.dataset.cp || '';
        dst.className = srcCell.className;
        if (!dst.classList.contains('board-hud-cell')) dst.classList.add('board-hud-cell');
    });
    const srcLabel = document.getElementById('board-ownership-label');
    const dstLabel = mirror.querySelector('.tutorial-board-map-label');
    if (srcLabel && dstLabel) dstLabel.textContent = srcLabel.textContent;
}

function showTutorialTravelArrival() {
    if (!p1) return;
    p1._tutorialTravelArrivalAt = Date.now();
    const lang = getTutorialLang();
    const t = translations[lang] || translations['en'];
    const textEl = document.getElementById('tutorial-text');
    if (textEl) {
        textEl.textContent = t['TUTORIAL_MSG_4_ARRIVAL'] || 'You changed boards — map shows where you are';
    }
    const mirror = document.getElementById('tutorial-live-board-map');
    if (mirror) {
        mirror.classList.remove('tutorial-board-arrival-flash');
        void mirror.offsetWidth;
        mirror.classList.add('tutorial-board-arrival-flash');
    }
    _hudFocusBoardKey = '';
    notePlayerBoardPresence(p1);
    boardCaptureFlash = 22;
    SFX.play('button', 0.5);
    _boardHudCache = '';
    updateBoardOwnershipHud();
}

let _ownTintCacheKey = '';
let _ownTintPts = null;

function drawBoardOwnershipTints(ctxRef) {
    const tutorialBoardLesson = typeof isTutorialMapStep === 'function' && isTutorialMapStep();
    if (typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase() && !tutorialBoardLesson) return;
    if (typeof isTutorialFightWaiting === 'function' && isTutorialFightWaiting()) return;
    // Only tint the currently viewed board — other boards live on the minimap
    if (!worldBoards.length || !ctxRef) return;
    const board = worldBoards[boardIndexFromSector(viewBoardSx, viewBoardSy)];
    if (!board || !board.owner || !board.captureColor) {
        if (boardCaptureFlash > 0) boardCaptureFlash--;
        _ownTintCacheKey = '';
        _ownTintPts = null;
        return;
    }
    const tintKey = [
        viewBoardSx, viewBoardSy, board.owner, board.captureColor,
        boardCaptureFlash > 0 ? 1 : 0, viewW, viewH, cachedThemeColorKey
    ].join('|');
    let c1, c2, c3, c4;
    if (_ownTintCacheKey === tintKey && _ownTintPts) {
        ({ c1, c2, c3, c4 } = _ownTintPts);
    } else {
        const dim = GRID_COUNT * GRID_SIZE;
        c1 = project(0, 0, 0);
        c2 = project(dim, 0, 0);
        c3 = project(dim, dim, 0);
        c4 = project(0, dim, 0);
        _ownTintCacheKey = tintKey;
        _ownTintPts = { c1, c2, c3, c4 };
    }
    ctxRef.save();
    ctxRef.beginPath();
    ctxRef.moveTo(c1.x, c1.y);
    ctxRef.lineTo(c2.x, c2.y);
    ctxRef.lineTo(c3.x, c3.y);
    ctxRef.lineTo(c4.x, c4.y);
    ctxRef.closePath();
    const flash = boardCaptureFlash > 0 ? 0.12 : 0;
    ctxRef.fillStyle = board.captureColor;
    ctxRef.globalAlpha = 0.18 + flash;
    ctxRef.fill();
    ctxRef.globalAlpha = 1;
    ctxRef.restore();
    if (boardCaptureFlash > 0) boardCaptureFlash--;
}

function drawCheckpointSlab(ctxRef, cpX, cpY, color, zLift, alpha, inset = 0.4, rotation = 0) {
    const cx = cpX * GRID_SIZE + GRID_SIZE / 2;
    const cy = cpY * GRID_SIZE + GRID_SIZE / 2;
    const half = GRID_SIZE * inset;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const corners = [
        { x: -half, y: -half },
        { x: half, y: -half },
        { x: half, y: half },
        { x: -half, y: half }
    ].map((c) => {
        const rx = c.x * cos - c.y * sin;
        const ry = c.x * sin + c.y * cos;
        return project(cx + rx, cy + ry, zLift);
    });
    ctxRef.save();
    ctxRef.globalAlpha = alpha;
    ctxRef.fillStyle = color;
    ctxRef.beginPath();
    ctxRef.moveTo(corners[0].x, corners[0].y);
    ctxRef.lineTo(corners[1].x, corners[1].y);
    ctxRef.lineTo(corners[2].x, corners[2].y);
    ctxRef.lineTo(corners[3].x, corners[3].y);
    ctxRef.closePath();
    ctxRef.fill();
    ctxRef.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctxRef.lineWidth = 1;
    ctxRef.stroke();
    ctxRef.restore();
}

/** Minecraft beacon: sky column. Unclaimed = 2+ rainbow hues; claimed = cube color, locked.
 *  Light per-theme flavor — same silhouette, slightly different beam character. */
function getCheckpointBeamThemeKey() {
    try {
        const theme = (typeof themes !== 'undefined' && themes[currentThemeIndex]) || '';
        if (theme.indexOf('pixel') >= 0) return 'pixel';
        if (theme.indexOf('ronk') >= 0) return 'ronk';
        if (theme.indexOf('hacker') >= 0) return 'hacker';
        if (theme.indexOf('pink') >= 0) return 'pink';
        if (theme.indexOf('white-black') >= 0) return 'bap';
    } catch (_) { /* ignore */ }
    return 'default';
}

function drawCheckpointLightPillar(ctxRef, cpX, cpY, color, t, idx, fullDetail) {
    if (!ctxRef || !fullDetail) return;
    const geom = getCachedPillarGeom(cpX, cpY);
    const bot = { x: geom.botX, y: geom.botY };
    const topX = geom.topX;
    const topY = geom.topY;
    const px = geom.px;
    const py = geom.py;
    const low = isPerformanceMode();
    const themeKey = getCheckpointBeamThemeKey();
    let outerW = low ? 11 : 16;
    let midW = low ? 5.5 : 8;
    let coreW = low ? 1.8 : 2.6;
    // Slight theme flavor (width / softness) — design stays beacon-like
    if (themeKey === 'pixel') {
        outerW = low ? 10 : 14;
        midW = low ? 6 : 8;
        coreW = low ? 2 : 3;
    } else if (themeKey === 'ronk') {
        outerW = low ? 10 : 15;
        midW = low ? 5 : 7.5;
        coreW = low ? 1.6 : 2.4;
    } else if (themeKey === 'hacker') {
        outerW = low ? 12 : 17;
        midW = low ? 5 : 7;
        coreW = low ? 1.5 : 2.2;
    } else if (themeKey === 'pink') {
        outerW = low ? 13 : 18;
        midW = low ? 6.5 : 9;
        coreW = low ? 2.2 : 3;
    } else if (themeKey === 'bap') {
        outerW = low ? 11 : 15;
        midW = low ? 5 : 7;
        coreW = low ? 1.5 : 2.2;
    }
    const claimed = !!(color && color !== '#ffffff');

    const ribbon = (half) => [
        { x: bot.x - px * half, y: bot.y - py * half },
        { x: bot.x + px * half, y: bot.y + py * half },
        { x: topX + px * half, y: topY + py * half },
        { x: topX - px * half, y: topY - py * half }
    ];

    const fillRibbon = (pts, fill, alpha) => {
        ctxRef.globalAlpha = alpha;
        ctxRef.fillStyle = fill;
        ctxRef.beginPath();
        ctxRef.moveTo(pts[0].x, pts[0].y);
        ctxRef.lineTo(pts[1].x, pts[1].y);
        ctxRef.lineTo(pts[2].x, pts[2].y);
        ctxRef.lineTo(pts[3].x, pts[3].y);
        ctxRef.closePath();
        ctxRef.fill();
    };

    // Pixel theme: stepped voxel segments (same beam, more blocky)
    const fillPixelBeam = (half, fill, alpha) => {
        const steps = low ? 6 : 10;
        ctxRef.globalAlpha = alpha;
        ctxRef.fillStyle = fill;
        const snap = (v) => Math.round(v);
        for (let s = 0; s < steps; s++) {
            const a0 = s / steps;
            const a1 = (s + 1) / steps;
            const x0 = bot.x + (topX - bot.x) * a0;
            const y0 = bot.y + (topY - bot.y) * a0;
            const x1 = bot.x + (topX - bot.x) * a1;
            const y1 = bot.y + (topY - bot.y) * a1;
            // Quantize width per step so it reads as pixel art
            const w = Math.max(1, Math.round(half * (1 - a0 * 0.15)));
            const pts = [
                { x: snap(x0 - px * w), y: snap(y0 - py * w) },
                { x: snap(x0 + px * w), y: snap(y0 + py * w) },
                { x: snap(x1 + px * w), y: snap(y1 + py * w) },
                { x: snap(x1 - px * w), y: snap(y1 - py * w) }
            ];
            ctxRef.beginPath();
            ctxRef.moveTo(pts[0].x, pts[0].y);
            ctxRef.lineTo(pts[1].x, pts[1].y);
            ctxRef.lineTo(pts[2].x, pts[2].y);
            ctxRef.lineTo(pts[3].x, pts[3].y);
            ctxRef.closePath();
            ctxRef.fill();
        }
    };

    ctxRef.save();
    if (themeKey === 'pixel') {
        ctxRef.imageSmoothingEnabled = false;
        if (claimed) {
            fillPixelBeam(outerW, color, 0.2);
            fillPixelBeam(midW, color, 0.4);
            fillPixelBeam(coreW, color, 0.95);
        } else {
            const time = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            // Coarser hue steps = more "8-bit" rainbow
            const hue = (Math.floor(((time * 0.00012) + (idx || 0) * 0.18) * 8) / 8) % 1;
            const colorA = `hsl(${hue * 360}, 100%, 58%)`;
            const colorB = `hsl(${((hue + 0.5) % 1) * 360}, 100%, 58%)`;
            fillPixelBeam(outerW, colorA, 0.2);
            fillPixelBeam(midW * 0.7, colorB, 0.38);
            fillPixelBeam(coreW, colorA, 0.95);
        }
        ctxRef.restore();
        return;
    }

    if (claimed) {
        let outerA = 0.18;
        let midA = 0.36;
        let coreA = 0.92;
        let fillOuter = color;
        let fillMid = color;
        let fillCore = color;
        if (themeKey === 'ronk') {
            outerA = 0.22;
            midA = 0.4;
            // faint hot rim without changing cube color identity
            fillOuter = color;
        } else if (themeKey === 'hacker') {
            outerA = 0.14;
            midA = 0.32;
            coreA = 0.88;
        } else if (themeKey === 'pink') {
            outerA = 0.24;
            midA = 0.4;
        } else if (themeKey === 'bap') {
            // Claimed beams stay cube-colored; darken so they read on Bap marble
            outerA = 0.28;
            midA = 0.48;
            coreA = 0.98;
        }
        fillRibbon(ribbon(outerW), fillOuter, outerA);
        fillRibbon(ribbon(midW), fillMid, midA);
        fillRibbon(ribbon(coreW), fillCore, coreA);
        // Hacker: thin scanline ticks along the beam
        if (themeKey === 'hacker' && !low) {
            ctxRef.globalAlpha = 0.35;
            ctxRef.strokeStyle = color;
            ctxRef.lineWidth = 1;
            for (let s = 0; s < 5; s++) {
                const a = (s + 0.5) / 5;
                const x = bot.x + (topX - bot.x) * a;
                const y = bot.y + (topY - bot.y) * a;
                ctxRef.beginPath();
                ctxRef.moveTo(x - px * midW, y - py * midW);
                ctxRef.lineTo(x + px * midW, y + py * midW);
                ctxRef.stroke();
            }
        }
    } else {
        // Two apple-rainbow hues, side by side, cycling. Claimed beams stay cube color.
        const time = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        let hueSpeed = 0.00015;
        let sat = 100;
        let lit = 62;
        let litCore = 78;
        if (themeKey === 'ronk') { sat = 95; lit = 58; litCore = 72; }
        else if (themeKey === 'hacker') { sat = 100; lit = 55; litCore = 70; hueSpeed = 0.00012; }
        else if (themeKey === 'pink') { sat = 90; lit = 68; litCore = 82; }
        else if (themeKey === 'bap') { sat = 0; lit = 6; litCore = 14; } // black unclaimed beams (not white)
        const hue = ((time * hueSpeed) + (idx || 0) * 0.18) % 1;
        const colorA = themeKey === 'bap'
            ? `hsl(0, 0%, ${lit}%)`
            : `hsl(${hue * 360}, ${sat}%, ${lit}%)`;
        const colorB = themeKey === 'bap'
            ? `hsl(0, 0%, ${Math.min(22, lit + 10)}%)`
            : `hsl(${((hue + 0.5) % 1) * 360}, ${sat}%, ${lit}%)`;
        const coreA = themeKey === 'bap'
            ? `hsl(0, 0%, ${litCore}%)`
            : `hsl(${hue * 360}, ${sat}%, ${litCore}%)`;
        const coreB = themeKey === 'bap'
            ? `hsl(0, 0%, ${Math.min(28, litCore + 8)}%)`
            : `hsl(${((hue + 0.5) % 1) * 360}, ${sat}%, ${litCore}%)`;
        const stripe = (from, to) => [
            { x: bot.x + px * from, y: bot.y + py * from },
            { x: bot.x + px * to, y: bot.y + py * to },
            { x: topX + px * to, y: topY + py * to },
            { x: topX + px * from, y: topY + py * from }
        ];
        fillRibbon(stripe(-outerW, 0), colorA, themeKey === 'pink' ? 0.26 : 0.22);
        fillRibbon(stripe(0, outerW), colorB, themeKey === 'pink' ? 0.26 : 0.22);
        fillRibbon(stripe(-midW, 0), colorA, 0.42);
        fillRibbon(stripe(0, midW), colorB, 0.42);
        fillRibbon(stripe(-coreW, 0), coreA, 0.95);
        fillRibbon(stripe(0, coreW), coreB, 0.95);
    }
    ctxRef.restore();
}

function drawCheckpoints(ctxRef) {
    if (!worldBoards.length || !ctxRef) return;
    if (typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase()) {
        if (typeof isTutorialCheckpointStep !== 'function' || !isTutorialCheckpointStep()) return;
    }

    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.002;

    const drawCpOnBoard = (board, ox, oy, bounds) => {
        if (!board?.checkpoints?.length) return;
        board.checkpoints.forEach((cp, idx) => {
            if (bounds && (cp.x < bounds.x0 || cp.x > bounds.x1 || cp.y < bounds.y0 || cp.y > bounds.y1)) {
                return;
            }
            const color = cp.owner === 'player'
                ? (p1?.color || '#ff4466')
                : cp.owner === 'enemy'
                    ? (p2?.color || '#44aaff')
                    : '#ffffff';
            const bob = Math.sin(t + (cp.pulse || 0) + idx * 0.65) * (GRID_SIZE * 0.04);
            const dir = (idx % 2 === 0) ? 1 : -1;
            const spin = (t * 1.25 + (cp.pulse || 0)) * dir;

            const fullDetail = (ox === 0 && oy === 0);
            withBoardWorldOffset(ox, oy, () => {
                if (fullDetail) drawCheckpointLightPillar(ctxRef, cp.x, cp.y, color, t, idx, true);
                drawCheckpointSlab(ctxRef, cp.x, cp.y, color, bob, 0.94, 0.42, spin);
            });
        });
    };

    if (typeof forEachVisibleBoardSurface === 'function') {
        forEachVisibleBoardSurface(({ sx, sy, ox, oy, bounds, ndx, ndy }) => {
            const board = worldBoards[boardIndexFromSector(sx, sy)];
            // Full board for view; peek-cell filter for neighbors
            drawCpOnBoard(board, ox, oy, (ndx === 0 && ndy === 0) ? null : bounds);
        });
        return;
    }

    const board = worldBoards[boardIndexFromSector(viewBoardSx, viewBoardSy)];
    if (!board) return;
    drawCpOnBoard(board, 0, 0, null);
}

function drawSectorBorders(_ctxRef) {
    // No mega-world sector gaps — only one board is drawn full-screen
}

const SKILL_TYPES = {
    INFINITE_CHARGE: 'infinite-charge',
    CLONES: 'clones',
    INVISIBLE: 'invisible',
    INFINITE_TRAILS: 'infinite-trails',
    LASER: 'laser'
};

function isPassiveSkill(skillId) {
    return skillId === SKILL_TYPES.INFINITE_TRAILS;
}

function getSkillHudLabel(skillId) {
    const skill = SKILL_DATA.find((s) => s.id === skillId);
    return skill ? skill.name : String(skillId).toUpperCase().replace(/-/g, ' ');
}

function getBoundActionKey(action, fallback) {
    try {
        const saved = getRonkControlsParsed();
        const raw = saved[action] || fallback;
        return String(raw).toUpperCase();
    } catch (_) {
        return String(fallback).toUpperCase();
    }
}

/** HUD label with keybind for the local human (gamepad face buttons when pad is active). */
function formatLocalActionHudLabel(action, baseLabel) {
    const pad = !!usingGamepadInput;
    if (pad) {
        const face = action === 'dash' ? 'A' : action === 'charge' ? 'B' : 'X';
        return `${face} · ${baseLabel}`;
    }
    const key = action === 'dash' ? getBoundActionKey('dash', 'f')
        : action === 'charge' ? getBoundActionKey('charge', 'c')
            : getBoundActionKey('skill', 'y');
    return `${key} · ${baseLabel}`;
}

/** Root owner for invis (clones inherit the owner's cloak). */
function getInvisibleSkillOwner(player) {
    if (!player) return null;
    if (!player.isClone) return player;
    const playerBase = typeof getPlayerBaseId === 'function' ? getPlayerBaseId(player.id) : player.id;
    if (p1 && (player.ownerId === getPlayerBaseId(p1.id) || playerBase === getPlayerBaseId(p1.id))) return p1;
    if (p2 && (player.ownerId === getPlayerBaseId(p2.id) || playerBase === getPlayerBaseId(p2.id))) return p2;
    return player;
}

/** Passive trail cloak is on (Invisible skill equipped). Cube cloak is activate-only. */
function playerHasPassiveInvisibleTrail(player) {
    const owner = getInvisibleSkillOwner(player);
    if (!owner && !player) return false;
    return !!(
        owner?.selectedSkill === SKILL_TYPES.INVISIBLE
        || owner?.hasInvisibleTrail
        || player?.hasInvisibleTrail
    );
}

function playerHasActiveFullInvisibility(player) {
    const owner = getInvisibleSkillOwner(player);
    return !!(owner?.fullInvisibleActive || player?.fullInvisibleActive);
}

/** Very light tint of the cube colour (red → light red) for self/spectate cloak feedback. */
function getInvisibleSelfFeedbackColor(baseColor, playerRef) {
    const hex = baseColor || '#ffffff';
    if (playerRef && typeof playerRef.adjustColor === 'function') {
        return playerRef.adjustColor(hex, 72);
    }
    if (typeof adjustLoadoutHex === 'function') {
        return adjustLoadoutHex(hex, 72);
    }
    return hex;
}

/** True if the local viewer should draw this player's trail/cube.
 *  Invisible:
 *    - trail cloak is PASSIVE (enemies never see trail)
 *    - full cube+trail cloak is ACTIVATE (enemies lose the cube too)
 *  Owner / allies / spectators still see visuals (trail uses a light tint as feedback).
 *  AI fog-of-war is handled separately in ai_logic.
 */
function canLocalViewerSeePlayerVisuals(player, part) {
    if (!player) return false;
    if (typeof isSpectateMode !== 'undefined' && isSpectateMode) return true;

    const localSide = typeof getLocalPlayerSide === 'function' ? getLocalPlayerSide() : 1;
    const localPlayer = localSide === 2 ? p2 : p1;
    const playerBase = typeof getPlayerBaseId === 'function' ? getPlayerBaseId(player.id) : player.id;
    const localBase = localPlayer && typeof getPlayerBaseId === 'function'
        ? getPlayerBaseId(localPlayer.id)
        : localPlayer?.id;

    const isAlly = !!localPlayer && (
        player === localPlayer
        || playerBase === localBase
        || (player.isClone && (player.ownerId === localBase || playerBase === localBase))
    );

    // Shared-screen local PVP: always draw both so each human can see themselves
    if (isMultiplayer && !isOnline) return true;

    if (isAlly) return true;

    const cloaked = playerHasPassiveInvisibleTrail(player);
    if (!cloaked) return true;

    if (part === 'trail') return false; // enemy never sees cloaked trail
    if (part === 'cube') {
        // Cube hide only during ACTIVATE (full invis) — not from passive trail cloak
        return !playerHasActiveFullInvisibility(player);
    }
    return true;
}

function applyPassiveSkillLoadout(player) {
    if (!player?.selectedSkill) return;
    if (player.selectedSkill === SKILL_TYPES.INFINITE_TRAILS) {
        // Passive: trail never decays — every cell you paint stays for the match
        player.infiniteTrailsActive = true;
    }
    if (player.selectedSkill === SKILL_TYPES.INVISIBLE) {
        player.hasInvisibleTrail = true;
        player.fullInvisibleActive = false;
    }
}
const USE_FLAT = false;
const MATCH_TARGET = 6;
let matchesPlayed = 0;
let hasVotedContinue = false;
let enemyVotedContinue = false;

// Match-specific skill tracking
let p1SelectedSkillForMatch = null;
let p2SelectedSkillForMatch = null;

// --- STATE ---
let p1Score = 0;
let p2Score = 0;
let p1MatchColor = null;
let p2MatchColor = null;
/** TTT round wins this match (for challenges — not only match-ending TTT). */
let sessionTttRoundWins = 0;

function resetMatchScoreState() {
    p1Score = 0;
    p2Score = 0;
    matchesPlayed = 0;
    sessionTttRoundWins = 0;
    roundsCompletedThisMatch = 0;
    roundOutcomeScored = false;
    lastBoardWinReason = null;
    matchEndUiShown = false;
    clearRoundEndTimer();
    window.RonkSteamAchievements?.resetMatchCounters?.();
    if (typeof updateScoreboard === 'function') updateScoreboard();
}

/** Near-simultaneous mutual KO → draw; otherwise first death loses. */
function resolveKillRoundOutcome() {
    if (!p1 || !p2) return null;
    if (p1.isDead && p2.isDead) {
        const t1 = p1.deathAnimTicks || 0;
        const t2 = p2.deathAnimTicks || 0;
        const simulWindow = Math.max(2, Math.round(0.12 * TICK_RATE));
        if (Math.abs(t1 - t2) <= simulWindow) return 'draw';
        // Higher deathAnimTicks = died earlier → the other player wins the round
        return t1 > t2 ? 'p2' : 'p1';
    }
    if (p1.isDead) return 'p2';
    if (p2.isDead) return 'p1';
    return null;
}

function awardKillRoundOutcome(outcome) {
    if (roundOutcomeScored || !outcome) return false;
    roundOutcomeScored = true;
    roundsCompletedThisMatch++;
    if (outcome === 'draw') {
        lastBoardWinReason = 'draw';
    } else if (outcome === 'p2') {
        lastBoardWinReason = 'kill';
        p2Score++;
        matchesPlayed++;
    } else {
        lastBoardWinReason = 'kill';
        p1Score++;
        matchesPlayed++;
    }
    updateScoreboard();
    if (isOnline && onlineRole === 'host' && conn && conn.open) {
        try {
            conn.send(sealOnlinePacket({
                type: 'round-score',
                p1Score,
                p2Score,
                roundsCompletedThisMatch,
                lastBoardWinReason,
                outcome
            }));
        } catch (_) { /* ignore */ }
    }
    return true;
}

let lastFrameTime = 0;
let accumulator = 0;
const tickDuration = 1000 / TICK_RATE;

function ticksForCountdownStep(seconds) {
    return Math.max(4, Math.round(TICK_RATE * seconds));
}

let p1, p2;
let keys = {};
let isSpectateMode = false;
let isMultiplayer = false;
let currentGamemode = 'normal'; // 'normal' or 'simplistic'
let currentBotDifficulty = localStorage.getItem('ronk_botDifficulty') || 'medium';
window.currentBotDifficulty = currentBotDifficulty;
window.usesBoardControlMatchRules = usesBoardControlMatchRules;
window.areAllBoardsClaimed = areAllBoardsClaimed;
window.findTicTacToeWinner = findTicTacToeWinner;
window.BOARD_TTT_LINES = BOARD_TTT_LINES;

const PROGRESSION_STORAGE_KEY = 'ronk_unlock_progress';
const PLAY_UNLOCK_HINT_KEY = 'ronk_play_unlock_hint_seen';
const TUTORIAL_COMPLETE_KEY = 'ronk_tutorial_v2_complete';
let unlockProgressCache = { skills: [], jokers: [] };
let unlockProgressHydrated = false;
let unlockProgressTamperWarned = false;
let lastSealedUnlockProgress = null;
const PLAYER_PREFS_CLOUD_FILE = 'ronk_player_prefs.dat';
function getLocalPlayerPrefs() {
    return {
        tutorialComplete: localStorage.getItem(TUTORIAL_COMPLETE_KEY) === 'true',
        playUnlockHintSeen: localStorage.getItem(PLAY_UNLOCK_HINT_KEY) === 'true'
    };
}

function applyPlayerPrefs(prefs) {
    if (prefs.tutorialComplete) {
        localStorage.setItem(TUTORIAL_COMPLETE_KEY, 'true');
    } else if (Object.prototype.hasOwnProperty.call(prefs, 'tutorialComplete')) {
        localStorage.setItem(TUTORIAL_COMPLETE_KEY, 'false');
    }
    if (prefs.playUnlockHintSeen) {
        localStorage.setItem(PLAY_UNLOCK_HINT_KEY, 'true');
    }
}

function savePlayerPrefs(prefs = {}) {
    const merged = {
        tutorialComplete: Object.prototype.hasOwnProperty.call(prefs, 'tutorialComplete')
            ? !!prefs.tutorialComplete
            : isTutorialComplete(),
        playUnlockHintSeen: Object.prototype.hasOwnProperty.call(prefs, 'playUnlockHintSeen')
            ? !!prefs.playUnlockHintSeen
            : hasSeenPlayUnlockHint()
    };
    if (merged.tutorialComplete) {
        localStorage.setItem(TUTORIAL_COMPLETE_KEY, 'true');
    } else if (Object.prototype.hasOwnProperty.call(prefs, 'tutorialComplete')) {
        localStorage.setItem(TUTORIAL_COMPLETE_KEY, 'false');
    }
    if (merged.playUnlockHintSeen) {
        localStorage.setItem(PLAY_UNLOCK_HINT_KEY, 'true');
    }
    if (!steamBridge?.writeProgressCloud) return;
    const payload = JSON.stringify({ v: 1, ...merged });
    Promise.resolve(steamBridge.writeProgressCloud(payload, PLAYER_PREFS_CLOUD_FILE)).catch(() => {});
}

function markTutorialComplete() {
    tutorialReplayActive = false;
    if (isTutorialComplete()) return;
    localStorage.setItem(TUTORIAL_COMPLETE_KEY, 'true');
    savePlayerPrefs({ tutorialComplete: true });
    if (steamBridge?.activateAchievement) {
        steamBridge.activateAchievement('ACH_TUTORIAL_COMPLETE');
    }
    if (typeof enqueueGameNotification === 'function') {
        enqueueGameNotification({
            seenId: 'tutorial_complete',
            kickerKey: 'NOTIFY_TUTORIAL_DONE_TITLE',
            titleKey: 'NOTIFY_TUTORIAL_DONE_TITLE',
            bodyKey: 'NOTIFY_TUTORIAL_DONE_BODY',
            icon: '✓',
            duration: 4200
        });
    }
    refreshTutorialGateState();
}

function refreshTutorialGateState() {
    if (!isTutorialComplete()) return;
    hideTutorialGate();
    if (introFinished && !document.body.classList.contains('in-game') && !isOverlayScreenActive()) {
        showMainMenu();
        resetToMainTier();
        setThemeBtnVisible(true);
    }
}

async function syncPlayerPrefsFromCloud() {
    const localPrefs = getLocalPlayerPrefs();
    const localTutorialRaw = localStorage.getItem(TUTORIAL_COMPLETE_KEY);
    const localTutorialExplicit = localTutorialRaw === 'true' || localTutorialRaw === 'false';
    let cloudPrefs = { tutorialComplete: false, playUnlockHintSeen: false };
    let cloudRaw = null;

    if (steamBridge?.readProgressCloud) {
        cloudRaw = await steamBridge.readProgressCloud(PLAYER_PREFS_CLOUD_FILE);
        if (cloudRaw) {
            try {
                const parsed = JSON.parse(cloudRaw);
                cloudPrefs.tutorialComplete = !!parsed.tutorialComplete;
                cloudPrefs.playUnlockHintSeen = !!parsed.playUnlockHintSeen;
            } catch (_) {}
        }
    }

    const merged = {
        // Explicit local false (replay / reset) must beat cloud true
        tutorialComplete: localTutorialExplicit
            ? localTutorialRaw === 'true'
            : (localPrefs.tutorialComplete || cloudPrefs.tutorialComplete),
        playUnlockHintSeen: localPrefs.playUnlockHintSeen || cloudPrefs.playUnlockHintSeen
    };
    applyPlayerPrefs(merged);

    const changed = merged.tutorialComplete !== localPrefs.tutorialComplete
        || merged.playUnlockHintSeen !== localPrefs.playUnlockHintSeen;
    const shouldSeedCloud = !cloudRaw && (merged.tutorialComplete || merged.playUnlockHintSeen);
    if (changed || shouldSeedCloud) {
        savePlayerPrefs(merged);
    }
}

const TUTORIAL_MATCH_TARGET = 3;
const CLONES_PER_SKILL_USE = 2;
const MAX_CLONES_ALIVE = 2; // clone cubes only — owner cube + 2 clones = 3 friendly cubes max
const MAX_FRIENDLY_CUBES_WITH_CLONES = MAX_CLONES_ALIVE + 1;
const TUTORIAL_FINAL_STEP = 8;
const TUTORIAL_STEP_COUNT = 9;
let isTutorialMatch = false;
let tutorialPracticeActive = false;
let tutorialFightWaitingForStart = false;
let tutorialObjectiveDone = false;
let tutorialAdvanceTimer = null;
let lastOpponentLoadout = null;
let opponentLoadoutForUnlock = null;
let enemySelectedSkill = null;
let enemySelectedJokers = [];
let returnToMenuAfterGameOver = false;

function getLocalPlayerSide() {
    if (isOnline && onlineRole === 'guest') return 2;
    return 1;
}

function getLocalHumanPlayer() {
    return getLocalPlayerSide() === 2 ? p2 : p1;
}

/** Short HUD line so phantom KOs are explainable (local human only). */
function formatDeathCauseLabel(type, cause) {
    const c = String(cause || '');
    if (c.indexOf('enemy-wall') >= 0) return 'WALL';
    if (c.indexOf('enemy-trail') >= 0) return 'ENEMY TRAIL';
    if (c.indexOf('laser') >= 0) return 'LASER';
    if (c.indexOf('head-on') >= 0 || c.indexOf('charge-swap') >= 0) return 'HEAD-ON';
    if (type === 'fall' || c.indexOf('fall') >= 0 || c.indexOf('oob') >= 0 || c.indexOf('resolveSector') >= 0) {
        return 'FALL';
    }
    if (type === 'hunger') return 'HUNGER';
    if (type === 'shatter') return 'SHATTER';
    if (c) return c.toUpperCase().slice(0, 28);
    return String(type || 'HIT').toUpperCase();
}

function notifyLocalDeathCause(player, type, cause) {
    if (!player || player.isAI || player.isClone) return;
    const local = typeof getLocalHumanPlayer === 'function' ? getLocalHumanPlayer() : p1;
    if (player !== local) return;
    if (typeof isSpectateMode !== 'undefined' && isSpectateMode) return;
    const label = formatDeathCauseLabel(type, cause);
    const body = 'KILLED BY: ' + label;
    try {
        if (typeof enqueueGameNotification === 'function') {
            enqueueGameNotification({
                kicker: 'Death',
                title: body,
                body: cause ? String(cause) : '',
                duration: 2200
            });
        } else if (typeof showAntiCheatToast === 'function') {
            showAntiCheatToast(body, false);
        }
    } catch (_) { /* ignore */ }
}

function isOnlineRemotePlayer(player) {
    if (!isOnline || !player) return false;
    const local = getLocalHumanPlayer();
    return !!(local && player !== local && (player === p1 || player === p2));
}

function getOpponentPlayerForUnlock() {
    return getLocalPlayerSide() === 2 ? p1 : p2;
}

function normalizeJokerIds(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    // Legacy id rename: slow-enemy → double-effective
    return list.map((id) => (id === 'slow-enemy' ? 'double-effective' : id)).filter(Boolean);
}

function buildOpponentLoadoutFromMatchSelections() {
    const localSide = getLocalPlayerSide();
    if (isOnline) {
        const syncedSkill = enemySelectedSkill ?? null;
        const syncedJokers = normalizeJokerIds(enemySelectedJokers);
        if (localSide === 2) {
            const jokers = normalizeJokerIds(p1SelectedJoker);
            return {
                skill: p1SelectedSkillForMatch || syncedSkill || null,
                jokers: jokers.length ? jokers : syncedJokers
            };
        }
        const jokers = normalizeJokerIds(p2SelectedJoker);
        return {
            skill: p2SelectedSkillForMatch || syncedSkill || null,
            jokers: jokers.length ? jokers : syncedJokers
        };
    }
    return {
        skill: localSide === 2
            ? (p1SelectedSkillForMatch || null)
            : (p2SelectedSkillForMatch || null),
        jokers: localSide === 2
            ? normalizeJokerIds(p1SelectedJoker)
            : normalizeJokerIds(p2SelectedJoker)
    };
}

function captureOpponentLoadoutForUnlock() {
    const raw = buildOpponentLoadoutFromMatchSelections();
    const skill = raw.skill && VALID_SKILL_IDS.has(raw.skill) ? raw.skill : null;
    const jokers = normalizeJokerIds(raw.jokers)
        .filter((id) => VALID_JOKER_IDS.has(id))
        .slice(0, 2);
    opponentLoadoutForUnlock = { skill, jokers };
    lastOpponentLoadout = { skill, jokers: [...jokers] };
}

function getOpponentLoadoutSnapshot() {
    if (opponentLoadoutForUnlock) {
        return {
            skill: opponentLoadoutForUnlock.skill,
            jokers: [...opponentLoadoutForUnlock.jokers]
        };
    }
    return buildOpponentLoadoutFromMatchSelections();
}

function didLocalPlayerWinMatch(matchTarget) {
    // Pure AI spectate never grants progression unlocks
    if (isSpectateMode) return false;
    if (getLocalPlayerSide() === 2) return p2Score >= matchTarget;
    return p1Score >= matchTarget;
}

/**
 * True when the local human's side won the match.
 * Used so unlocks still fire if UI is on the game-over / "spectate-like" end screen
 * while the cube they controlled took the win.
 */
function didHumanControlledSideWinMatch(matchTarget) {
    if (isSpectateMode) return false;
    return didLocalPlayerWinMatch(matchTarget);
}

function defeatedOpponentQualifiesForUnlock() {
    if (isSpectateMode || isTutorialMatch || !isTutorialComplete()) return false;
    const opponent = getOpponentPlayerForUnlock();
    if (opponent?.isAI) {
        return botDifficultyQualifiesForUnlock(currentBotDifficulty);
    }
    return !!(isMultiplayer || isOnline);
}

function cloneUnlockProgress(progress) {
    return {
        skills: Array.isArray(progress?.skills) ? [...progress.skills] : [],
        jokers: Array.isArray(progress?.jokers) ? [...progress.jokers] : []
    };
}

function validateUnlockProgress(progress) {
    const skills = Array.isArray(progress?.skills)
        ? [...new Set(progress.skills.filter((id) => VALID_SKILL_IDS.has(id)))]
        : [];
    const jokers = Array.isArray(progress?.jokers)
        ? [...new Set(
            progress.jokers
                .map((id) => (id === 'slow-enemy' ? 'double-effective' : id))
                .filter((id) => VALID_JOKER_IDS.has(id))
        )]
        : [];
    return { skills, jokers };
}

function unionUnlockProgress(...progressList) {
    const skills = new Set();
    const jokers = new Set();
    progressList.forEach((progress) => {
        const validated = validateUnlockProgress(progress);
        validated.skills.forEach((id) => skills.add(id));
        validated.jokers.forEach((id) => jokers.add(id));
    });
    return { skills: [...skills], jokers: [...jokers] };
}

function extractTrustedUnlockProgress(parsed) {
    if (!parsed || parsed.tampered) return null;
    return validateUnlockProgress(parsed);
}

function recoverValidatedUnlockProgress(parsed) {
    if (!parsed) return { skills: [], jokers: [] };
    return validateUnlockProgress(parsed);
}

function countUnlockItems(progress) {
    return (progress?.skills?.length || 0) + (progress?.jokers?.length || 0);
}

function parseUnlockRaw(raw) {
    if (window.RonkProtection?.parseUnlockProgress) {
        const parsed = RonkProtection.parseUnlockProgress(raw);
        return {
            skills: parsed.skills || [],
            jokers: parsed.jokers || [],
            tampered: !!parsed.tampered,
            legacy: !!parsed.legacy
        };
    }
    if (!raw) return { skills: [], jokers: [], tampered: false, legacy: false };
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.data && (Array.isArray(parsed.data.skills) || Array.isArray(parsed.data.jokers))) {
            return {
                skills: Array.isArray(parsed.data.skills) ? parsed.data.skills : [],
                jokers: Array.isArray(parsed.data.jokers) ? parsed.data.jokers : [],
                tampered: false,
                legacy: false
            };
        }
        return {
            skills: Array.isArray(parsed.skills) ? parsed.skills : [],
            jokers: Array.isArray(parsed.jokers) ? parsed.jokers : [],
            tampered: false,
            legacy: false
        };
    } catch (_) {
        return { skills: [], jokers: [], tampered: true, legacy: false };
    }
}

function unlockProgressChanged(a, b) {
    const skillsA = [...(a.skills || [])].sort().join('|');
    const skillsB = [...(b.skills || [])].sort().join('|');
    const jokersA = [...(a.jokers || [])].sort().join('|');
    const jokersB = [...(b.jokers || [])].sort().join('|');
    return skillsA !== skillsB || jokersA !== jokersB;
}

function warnUnlockTamperOnce() {
    if (unlockProgressTamperWarned || typeof showAntiCheatToast !== 'function') return;
    unlockProgressTamperWarned = true;
    showAntiCheatToast('Save data tamper detected — re-sealing unlock progress.', true);
}

function hydrateUnlockProgressFromStorage() {
    if (unlockProgressHydrated) return unlockProgressCache;
    const raw = localStorage.getItem(PROGRESSION_STORAGE_KEY);
    const parsed = parseUnlockRaw(raw);
    if (parsed.tampered) warnUnlockTamperOnce();
    unlockProgressCache = validateUnlockProgress(cloneUnlockProgress(parsed));
    if (raw) lastSealedUnlockProgress = raw;
    unlockProgressHydrated = true;
    return unlockProgressCache;
}

function loadUnlockProgress() {
    hydrateUnlockProgressFromStorage();
    return cloneUnlockProgress(unlockProgressCache);
}

function flushUnlockProgressToCloud() {
    const sealed = lastSealedUnlockProgress || localStorage.getItem(PROGRESSION_STORAGE_KEY);
    if (!sealed) return false;
    if (steamBridge?.writeProgressCloudSync) {
        return steamBridge.writeProgressCloudSync(sealed);
    }
    if (steamBridge?.writeProgressCloud) {
        Promise.resolve(steamBridge.writeProgressCloud(sealed)).catch(() => {});
    }
    return false;
}

function saveUnlockProgress(progress) {
    const payload = validateUnlockProgress(cloneUnlockProgress(progress));
    const sealed = window.RonkProtection?.sealUnlockProgress
        ? RonkProtection.sealUnlockProgress(payload)
        : JSON.stringify(payload);
    unlockProgressCache = payload;
    unlockProgressHydrated = true;
    lastSealedUnlockProgress = sealed;
    localStorage.setItem(PROGRESSION_STORAGE_KEY, sealed);
    if (steamBridge?.writeProgressCloud) {
        Promise.resolve(steamBridge.writeProgressCloud(sealed)).catch(() => {});
    }
}

function refreshUnlockProgressUI() {
    sanitizeStoredLoadout();
    if (typeof updateSkillPreview === 'function') updateSkillPreview();
    if (typeof renderJokersGrid === 'function') renderJokersGrid();
    if (typeof updateSkillProgressUI === 'function') updateSkillProgressUI();
    if (typeof updateJokerProgressUI === 'function') updateJokerProgressUI();
    if (typeof updateLoadoutSummary === 'function') updateLoadoutSummary();
}

async function syncUnlockProgressFromCloud() {
    hydrateUnlockProgressFromStorage();
    const cacheData = validateUnlockProgress(unlockProgressCache);
    const localRaw = localStorage.getItem(PROGRESSION_STORAGE_KEY);
    const localParsed = parseUnlockRaw(localRaw);
    const localData = recoverValidatedUnlockProgress(localParsed);
    const localRawValidated = validateUnlockProgress(cloneUnlockProgress(localParsed));
    if (localParsed.tampered) warnUnlockTamperOnce();

    let cloudRaw = null;
    let cloudParsed = { skills: [], jokers: [], tampered: false, legacy: false };
    if (steamBridge?.readProgressCloud) {
        cloudRaw = await steamBridge.readProgressCloud();
        cloudParsed = parseUnlockRaw(cloudRaw);
        if (cloudParsed.tampered) warnUnlockTamperOnce();
    }
    const cloudData = recoverValidatedUnlockProgress(cloudParsed);

    const trustedParts = [
        extractTrustedUnlockProgress(localParsed),
        extractTrustedUnlockProgress(cloudParsed)
    ].filter(Boolean);

    let merged;
    if (trustedParts.length > 0) {
        merged = unionUnlockProgress(cacheData, ...trustedParts);
    } else if (countUnlockItems(localData) > 0 || countUnlockItems(cloudData) > 0) {
        merged = countUnlockItems(localData) >= countUnlockItems(cloudData) ? localData : cloudData;
    } else {
        merged = { skills: [], jokers: [] };
    }
    merged = validateUnlockProgress(merged);

    const needsSave = unlockProgressChanged(cacheData, merged)
        || unlockProgressChanged(localRawValidated, merged)
        || unlockProgressChanged(localData, merged)
        || (!localRaw && cloudRaw && countUnlockItems(cloudData) > 0)
        || localParsed.legacy
        || localParsed.tampered
        || cloudParsed.tampered;

    if (needsSave) {
        saveUnlockProgress(merged);
        return;
    }

    unlockProgressCache = merged;
    unlockProgressHydrated = true;

    if (localRaw && !cloudRaw && countUnlockItems(merged) > 0) {
        flushUnlockProgressToCloud();
    }
}

function resolveMatchEndUnlockLoadout() {
    // Prefer snapshot; if missing (edge cases / late skill swap), rebuild from live opponent
    let skill = opponentLoadoutForUnlock?.skill || null;
    let jokers = normalizeJokerIds(opponentLoadoutForUnlock?.jokers);
    if (!skill || !jokers.length) {
        const live = buildOpponentLoadoutFromMatchSelections();
        const opp = getOpponentPlayerForUnlock();
        if (!skill) {
            skill = live.skill || opp?.selectedSkill || null;
        }
        if (!jokers.length) {
            jokers = normalizeJokerIds(live.jokers);
            if (!jokers.length && opp) {
                jokers = normalizeJokerIds(opp.activeJokers);
            }
        }
    }
    const skillId = skill && VALID_SKILL_IDS.has(skill) ? skill : null;
    jokers = normalizeJokerIds(jokers)
        .filter((id) => VALID_JOKER_IDS.has(id))
        .slice(0, 2);
    return { skill: skillId, jokers };
}

function installUnlockProgressPersistenceHooks() {
    if (installUnlockProgressPersistenceHooks._installed) return;
    installUnlockProgressPersistenceHooks._installed = true;
    window.addEventListener('pagehide', () => flushUnlockProgressToCloud());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushUnlockProgressToCloud();
    });
}

hydrateUnlockProgressFromStorage();
installUnlockProgressPersistenceHooks();

function isTutorialComplete() {
    return localStorage.getItem(TUTORIAL_COMPLETE_KEY) === 'true';
}

function isTutorialPracticePhase() {
    return tutorialAllowsPractice() && tutorialStep < TUTORIAL_FINAL_STEP;
}

function isTutorialChargePracticeStep() {
    return isTutorialPracticePhase() && tutorialStep === 2;
}

function isTutorialTrailDemoStep() {
    return isTutorialPracticePhase() && tutorialStep === 3;
}

function isTutorialBoardTravelStep() {
    return isTutorialPracticePhase() && tutorialStep === 4;
}

function isTutorialCheckpointStep() {
    return isTutorialPracticePhase() && tutorialStep === 5;
}

function isTutorialSkillPracticeStep() {
    return isTutorialPracticePhase() && tutorialStep === 6;
}

function isTutorialHungerStep() {
    return isTutorialPracticePhase() && tutorialStep === 7;
}

function isTutorialMapStep() {
    return isTutorialBoardTravelStep() || isTutorialCheckpointStep();
}

function isTutorialScoreboardLessonStep() {
    return isTutorialMapStep();
}

/** Hide rival cube during lessons that are not about fighting them. */
function shouldHideTutorialRival() {
    if (!isTutorialPracticePhase()) return false;
    return tutorialStep !== 2 && tutorialStep !== 3;
}

function parkTutorialRivalOffscreen() {
    if (!p2) return;
    p2.boardSx = wrapBoardIndex(MIDDLE_BOARD_SX + 1);
    p2.boardSy = wrapBoardIndex(MIDDLE_BOARD_SY + 1);
    p2.x = 1;
    p2.y = 1;
    p2.prevX = p2.x;
    p2.prevY = p2.y;
    p2.trail = [];
    p2.tutorialFrozen = true;
    p2.isDead = false;
}

function isTutorialFightPhase() {
    return tutorialAllowsPractice() && tutorialStep >= TUTORIAL_FINAL_STEP;
}

function isTutorialFightWaiting() {
    return isTutorialFightPhase() && tutorialFightWaitingForStart;
}

function isTutorialBareMatch() {
    return tutorialAllowsPractice();
}

function stripTutorialLoadouts() {
    p1SelectedSkillForMatch = null;
    p2SelectedSkillForMatch = null;
    p1SelectedJoker = [];
    p2SelectedJoker = [];
}

function shouldEnforceUnlockLocks() {
    return isTutorialComplete()
        && currentGamemode !== 'simplistic'
        && !isSpectateMode
        && !isTutorialMatch;
}

function isUnlockProgressionEnabled() {
    return shouldEnforceUnlockLocks();
}

function sanitizeStoredLoadout() {
    if (!shouldEnforceUnlockLocks()) return;
    const unlockedSkills = getUnlockedSkills();
    const savedSkill = localStorage.getItem('ronk_selectedSkill');
    if (savedSkill && !unlockedSkills.includes(savedSkill)) {
        if (unlockedSkills.length) {
            localStorage.setItem('ronk_selectedSkill', unlockedSkills[0]);
        } else {
            localStorage.removeItem('ronk_selectedSkill');
        }
    }
    let jokers = [];
    try {
        jokers = JSON.parse(localStorage.getItem('ronk_selectedJoker') || '[]');
    } catch (_) {
        jokers = [];
    }
    if (!Array.isArray(jokers)) jokers = jokers ? [jokers] : [];
    jokers = jokers.filter(id => isJokerUnlocked(id)).slice(0, 2);
    localStorage.setItem('ronk_selectedJoker', JSON.stringify(jokers));
    p1SelectedJoker = jokers;
}

function getUnlockedSkills() {
    return loadUnlockProgress().skills || [];
}

function getUnlockedJokers() {
    return loadUnlockProgress().jokers || [];
}

function isSkillUnlocked(skillId) {
    if (!skillId) return false;
    if (!isTutorialComplete()) return false;
    if (!shouldEnforceUnlockLocks()) {
        return currentGamemode === 'simplistic' || isSpectateMode;
    }
    return getUnlockedSkills().includes(skillId);
}

function isJokerUnlocked(jokerId) {
    if (!jokerId) return false;
    if (!isTutorialComplete()) return false;
    if (!shouldEnforceUnlockLocks()) {
        return currentGamemode === 'simplistic' || isSpectateMode;
    }
    return getUnlockedJokers().includes(jokerId);
}

function getLoadoutLockHint(t) {
    if (!isTutorialComplete()) {
        return t['COMPLETE_TUTORIAL_TO_UNLOCK'] || 'Finish the tutorial first — then beat bots to unlock skills and jokers';
    }
    return t['BEAT_BOTS_TO_UNLOCK'] || 'Win vs easy, medium, hard, or elite bots — or beat a player online — to unlock their skill & jokers';
}

function getUnlockedSkillIndices() {
    if (!isTutorialComplete()) return [];
    if (!shouldEnforceUnlockLocks()) {
        if (currentGamemode === 'simplistic' || isSpectateMode) {
            return SKILL_DATA.map((_, index) => index);
        }
        return [];
    }
    return SKILL_DATA.map((skill, index) => index).filter(index => isSkillUnlocked(SKILL_DATA[index].id));
}

function getEffectiveMatchTarget() {
    return isTutorialMatch ? TUTORIAL_MATCH_TARGET : MATCH_TARGET;
}

function botDifficultyQualifiesForUnlock(difficulty) {
    return difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard' || difficulty === 'invincible';
}

/** High-contrast spectate palette — avoids near-duplicate reds in neonColors. */
const SPECTATE_DISTINCT_COLORS = ['#ff2d55', '#00f2ff', '#39ff14', '#ffff00', '#ff5e00', '#b967ff', '#ffffff'];

function colorsLookTooSimilar(a, b) {
    const parse = (hex) => {
        const h = String(hex || '').replace('#', '');
        if (h.length !== 6) return null;
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16)
        };
    };
    const ca = parse(a);
    const cb = parse(b);
    if (!ca || !cb) return String(a || '').toLowerCase() === String(b || '').toLowerCase();
    const dr = ca.r - cb.r;
    const dg = ca.g - cb.g;
    const db = ca.b - cb.b;
    return (dr * dr + dg * dg + db * db) < 14000; // ~similar hue / brightness
}

function pickDistinctSpectateColors(avoidColor = null) {
    const pool = SPECTATE_DISTINCT_COLORS.slice();
    // Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let c1 = pool.find((c) => !avoidColor || !colorsLookTooSimilar(c, avoidColor)) || pool[0];
    let c2 = pool.find((c) => !colorsLookTooSimilar(c, c1) && (!avoidColor || !colorsLookTooSimilar(c, avoidColor))) || pool[1];
    if (colorsLookTooSimilar(c1, c2)) {
        c2 = pool.find((c) => !colorsLookTooSimilar(c, c1)) || '#00f2ff';
    }
    return { p1: c1, p2: c2 };
}

function getBotMatchColor(playerColor) {
    const standardPool = neonColors.slice(0, neonColors.length - 1);
    const normalizedPlayer = (playerColor || '').toLowerCase();
    const distinct = standardPool.filter(color =>
        color.toLowerCase() !== normalizedPlayer && !colorsLookTooSimilar(color, playerColor)
    );
    if (distinct.length === 0) {
        const fallback = standardPool.filter(color => color.toLowerCase() !== normalizedPlayer);
        return fallback[0] || '#00f2ff';
    }
    const playerIdx = neonColors.findIndex(color => color.toLowerCase() === normalizedPlayer);
    const start = playerIdx >= 0 ? (playerIdx + 1) % standardPool.length : 0;
    for (let i = 0; i < standardPool.length; i++) {
        const candidate = standardPool[(start + i) % standardPool.length];
        if (candidate.toLowerCase() !== normalizedPlayer && !colorsLookTooSimilar(candidate, playerColor)) {
            return candidate;
        }
    }
    return distinct[0];
}

function pickRandomUnlockedSkill() {
    const all = SKILL_DATA.map(s => s.id);
    if (!isTutorialComplete()) return null;
    if (!shouldEnforceUnlockLocks()) {
        if (currentGamemode === 'simplistic' || isSpectateMode) {
            return all[Math.floor(Math.random() * all.length)];
        }
        return null;
    }
    const unlocked = getUnlockedSkills();
    if (!unlocked.length) return null;
    return unlocked[Math.floor(Math.random() * unlocked.length)];
}

function pickRandomUnlockedJokers(count = 2) {
    const all = JOKER_DATA.map(j => j.id);
    if (!isTutorialComplete()) return [];
    if (!shouldEnforceUnlockLocks()) {
        if (currentGamemode === 'simplistic' || isSpectateMode) {
            const picked = [];
            while (picked.length < count) {
                const id = all[Math.floor(Math.random() * all.length)];
                if (!picked.includes(id)) picked.push(id);
            }
            return picked;
        }
        return [];
    }
    const unlocked = getUnlockedJokers();
    const picked = [];
    let guard = 0;
    while (picked.length < count && unlocked.length > 0 && guard++ < 50) {
        const id = unlocked[Math.floor(Math.random() * unlocked.length)];
        if (!picked.includes(id)) picked.push(id);
    }
    return picked;
}

function getLocalPlayerLoadoutForSync() {
    const load = resolvePlayerMatchLoadout(SKILL_DATA.map(s => s.id));
    let jokers = load.jokers;
    if (!jokers) {
        try {
            jokers = JSON.parse(localStorage.getItem('ronk_selectedJoker') || '[]');
        } catch (_) {
            jokers = [];
        }
    }
    if (!Array.isArray(jokers)) jokers = jokers ? [jokers] : [];
    jokers = jokers.filter(id => isJokerUnlocked(id)).slice(0, 2);
    return { skill: load.skill, jokers };
}

function unlockOpponentLoadout(skillId, jokerIds) {
    if (!isTutorialComplete()) return;
    const jokers = normalizeJokerIds(jokerIds)
        .filter((id) => VALID_JOKER_IDS.has(id))
        .slice(0, 2);
    const skillToUnlock = skillId && VALID_SKILL_IDS.has(skillId) ? skillId : null;
    if (!skillToUnlock && jokers.length === 0) return;

    const progress = loadUnlockProgress();
    let changed = false;
    const newlyUnlocked = [];

    if (skillToUnlock && !progress.skills.includes(skillToUnlock)) {
        progress.skills.push(skillToUnlock);
        newlyUnlocked.push({ kind: 'skill', id: skillToUnlock });
        changed = true;
    }
    jokers.forEach((jokerId) => {
        if (jokerId && !progress.jokers.includes(jokerId)) {
            progress.jokers.push(jokerId);
            newlyUnlocked.push({ kind: 'joker', id: jokerId });
            changed = true;
        }
    });
    if (!changed) return;
    saveUnlockProgress(progress);
    flushUnlockProgressToCloud();
    newlyUnlocked.forEach((entry) => enqueueUnlockNotification(entry.kind, entry.id));
    refreshUnlockProgressUI();
    window.RonkSteamAchievements?.onLoadoutProgress?.(
        progress.skills || [],
        progress.jokers || [],
        SKILL_DATA.length,
        JOKER_DATA.length
    );
}

/** Unlock every skill + joker for playtesting. */
function unlockAllSkillsAndJokersForTest() {
    try {
        if (localStorage.getItem(TUTORIAL_COMPLETE_KEY) !== 'true') {
            localStorage.setItem(TUTORIAL_COMPLETE_KEY, 'true');
            if (typeof savePlayerPrefs === 'function') {
                savePlayerPrefs({ tutorialComplete: true });
            }
        }
        const progress = loadUnlockProgress();
        const allSkills = SKILL_DATA.map((s) => s.id);
        const allJokers = JOKER_DATA.map((j) => j.id);
        let changed = false;
        allSkills.forEach((id) => {
            if (!progress.skills.includes(id)) {
                progress.skills.push(id);
                changed = true;
            }
        });
        allJokers.forEach((id) => {
            if (!progress.jokers.includes(id)) {
                progress.jokers.push(id);
                changed = true;
            }
        });
        if (changed) {
            saveUnlockProgress(progress);
            flushUnlockProgressToCloud();
        }
        if (!localStorage.getItem('ronk_selectedSkill')) {
            localStorage.setItem('ronk_selectedSkill', 'infinite-charge');
        }
        let jokers = [];
        try {
            jokers = JSON.parse(localStorage.getItem('ronk_selectedJoker') || '[]');
        } catch (_) {
            jokers = [];
        }
        if (!Array.isArray(jokers)) jokers = jokers ? [jokers] : [];
        jokers = jokers.filter((id) => VALID_JOKER_IDS.has(id));
        if (!jokers.includes('border-safe')) jokers.unshift('border-safe');
        jokers = jokers.slice(0, 2);
        localStorage.setItem('ronk_selectedJoker', JSON.stringify(jokers));
        p1SelectedJoker = jokers;
        if (typeof refreshUnlockProgressUI === 'function') refreshUnlockProgressUI();
        if (typeof updateLoadoutSummary === 'function') updateLoadoutSummary();
        if (typeof renderJokersGrid === 'function') renderJokersGrid();
        if (typeof updateSkillPreview === 'function') updateSkillPreview();
        console.log('[Test] All skills & jokers unlocked.', {
            skills: progress.skills.length,
            jokers: progress.jokers.length,
            equipped: jokers
        });
    } catch (err) {
        console.warn('[Test] Full unlock failed:', err);
    }
}

/** First-time & milestone notifications (skills, jokers, tutorial, board capture, etc.) */
const NOTIFY_SEEN_KEY = 'ronk_notify_seen';
const gameNotifyQueue = [];
let gameNotifyBusy = false;
let gameNotifyTimer = null;

function loadSeenNotifications() {
    try {
        const raw = localStorage.getItem(NOTIFY_SEEN_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (_) {
        return {};
    }
}

function markNotificationSeen(id) {
    if (!id) return;
    const seen = loadSeenNotifications();
    seen[id] = Date.now();
    localStorage.setItem(NOTIFY_SEEN_KEY, JSON.stringify(seen));
}

function hasSeenNotification(id) {
    return !!loadSeenNotifications()[id];
}

function getNotifyLang() {
    return localStorage.getItem('ronk_language') || 'en';
}

function tNotify(key, fallback) {
    const t = translations[getNotifyLang()] || translations['en'];
    return (key && t[key]) || fallback || key || '';
}

function enqueueGameNotification(opts) {
    if (!opts) return;
    if (typeof document !== 'undefined' && document.body.classList.contains('in-game')
        && typeof gameState !== 'undefined' && (gameState === 'PLAYING' || gameState === 'COUNTDOWN')) {
        return;
    }
    gameNotifyQueue.push(opts);
    pumpGameNotifications();
}

function pumpGameNotifications() {
    if (gameNotifyBusy || unlockNotifyBusy) return;
    const next = gameNotifyQueue.shift();
    if (!next) return;
    gameNotifyBusy = true;
    showGameNotification(next, () => {
        gameNotifyBusy = false;
        setTimeout(() => {
            pumpGameNotifications();
            pumpUnlockNotifications();
        }, 220);
    });
}

function showGameNotification(opts, onDone) {
    const el = document.getElementById('unlock-notify');
    if (!el) {
        if (onDone) onDone();
        return;
    }
    const seenId = opts.seenId || opts.id;
    const firstTime = seenId ? !hasSeenNotification(seenId) : !!opts.firstTime;
    if (seenId) markNotificationSeen(seenId);

    const kicker = el.querySelector('.unlock-notify-kicker');
    const nameEl = el.querySelector('.unlock-notify-name');
    const descEl = el.querySelector('.unlock-notify-desc');
    const hintEl = el.querySelector('.unlock-notify-hint');
    const iconEl = el.querySelector('.unlock-notify-icon');
    const frame = el.querySelector('.unlock-notify-frame');

    const kickerText = opts.kicker || (opts.kickerKey ? tNotify(opts.kickerKey, opts.kickerKey) : '');
    const titleText = opts.title || (opts.titleKey ? tNotify(opts.titleKey, opts.titleKey) : '');
    const bodyText = opts.body || (opts.bodyKey ? tNotify(opts.bodyKey, opts.bodyKey) : '');
    const hintText = opts.hint || (opts.hintKey ? tNotify(opts.hintKey, opts.hintKey) : '');

    if (kicker) kicker.textContent = kickerText;
    if (nameEl) nameEl.textContent = titleText;
    if (descEl) descEl.textContent = bodyText;
    if (hintEl) {
        hintEl.textContent = hintText;
        hintEl.style.display = hintText ? 'block' : 'none';
    }
    if (iconEl) iconEl.textContent = opts.icon || '★';
    if (frame) {
        frame.classList.toggle('unlock-notify-first', firstTime);
        frame.classList.toggle('unlock-notify-skill', opts.kind === 'skill');
        frame.classList.toggle('unlock-notify-joker', opts.kind === 'joker');
        frame.classList.toggle('unlock-notify-milestone', !!opts.milestone);
    }

    el.classList.remove('hidden', 'unlock-notify-out');
    el.classList.add('unlock-notify-in');
    clearTimeout(gameNotifyTimer);
    const duration = opts.duration || (firstTime ? 4800 : 3600);
    gameNotifyTimer = setTimeout(() => {
        el.classList.remove('unlock-notify-in');
        el.classList.add('unlock-notify-out');
        setTimeout(() => {
            el.classList.add('hidden');
            el.classList.remove('unlock-notify-out');
            if (frame) {
                frame.classList.remove('unlock-notify-first', 'unlock-notify-skill', 'unlock-notify-joker', 'unlock-notify-milestone');
            }
            if (onDone) onDone();
        }, 320);
    }, duration);
}

function notifyFirstBoardCapture() {
    if (typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase()) return;
    if (isTutorialMatch && tutorialAllowsPractice()) return;
    enqueueGameNotification({
        seenId: 'first_board_capture',
        kickerKey: 'NOTIFY_FIRST_BOARD_TITLE',
        titleKey: 'NOTIFY_FIRST_BOARD_TITLE',
        bodyKey: 'NOTIFY_FIRST_BOARD_BODY',
        icon: '◼',
        milestone: true,
        duration: 4000
    });
}

function notifyFirstSkillUsedInMatch(skillId) {
    notifySkillActivatedInMatch(skillId, p1);
}

/** Same toast text can show at most this many times (lifetime), then never again. */
const NOTIFY_SPAM_CAP = 4;
const NOTIFY_COUNTS_KEY = 'ronk_notify_counts';

function loadNotifyShowCounts() {
    try {
        const raw = localStorage.getItem(NOTIFY_COUNTS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (_) {
        return {};
    }
}

function getNotifyShowCount(messageId) {
    if (!messageId) return 0;
    const counts = loadNotifyShowCounts();
    return Number(counts[messageId]) || 0;
}

function bumpNotifyShowCount(messageId) {
    if (!messageId) return 0;
    const counts = loadNotifyShowCounts();
    const next = (Number(counts[messageId]) || 0) + 1;
    counts[messageId] = next;
    try {
        localStorage.setItem(NOTIFY_COUNTS_KEY, JSON.stringify(counts));
    } catch (_) { /* ignore */ }
    return next;
}

/** Returns false once this message has already shown NOTIFY_SPAM_CAP times. */
function canShowCappedNotify(messageId) {
    return getNotifyShowCount(messageId) < NOTIFY_SPAM_CAP;
}

/** Skill / joker activation toasts — capped so the same tip isn't spammed forever. */
let _lastSkillNotifyAt = 0;
let _lastSkillNotifyId = '';
function notifySkillActivatedInMatch(skillId, player) {
    if (!skillId || isTutorialMatch) return;
    if (typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase()) return;

    // Cap identical "skill activated" spam (all skills share one lifetime budget of 4)
    const spamKey = 'skill_activated_toast';
    if (!canShowCappedNotify(spamKey)) return;

    const now = Date.now();
    const key = `${skillId}_${player?.id || ''}`;
    if (key === _lastSkillNotifyId && now - _lastSkillNotifyAt < 2200) return;
    _lastSkillNotifyId = key;
    _lastSkillNotifyAt = now;

    const skill = SKILL_DATA.find((entry) => entry.id === skillId);
    const t = translations[getNotifyLang()] || translations['en'];
    const isHuman = player && !player.isAI;
    const who = isSpectateMode
        ? (player === p1 ? 'AI 1' : 'AI 2')
        : (isHuman ? '' : 'Rival');
    const shownBefore = getNotifyShowCount(spamKey);
    bumpNotifyShowCount(spamKey);

    enqueueGameNotification({
        kicker: who
            ? `${who} · ${tNotify('NOTIFY_FIRST_SKILL_USE_TITLE', 'Skill activated')}`
            : tNotify('NOTIFY_FIRST_SKILL_USE_TITLE', 'Skill activated'),
        title: skill ? (t[skill.name] || skill.name) : String(skillId),
        body: skill ? (t[skill.desc] || skill.desc || '') : '',
        // How-to hint only the very first time — never again
        hint: (shownBefore === 0 && isHuman && !isSpectateMode)
            ? tNotify('NOTIFY_FIRST_SKILL_USE_HINT', 'Press Y during a match to use your equipped skill')
            : '',
        icon: skill?.icon || '⚡',
        kind: 'skill',
        duration: shownBefore === 0 ? 3800 : 2600
    });
}

function notifyJokerLoadoutInMatch(player, jokerIds) {
    if (!player || isTutorialMatch || currentGamemode === 'simplistic') return;
    const ids = normalizeJokerIds(jokerIds).slice(0, 2);
    if (!ids.length) return;

    const spamKey = isSpectateMode ? 'joker_loadout_spectate' : 'joker_loadout_rival';
    if (!canShowCappedNotify(spamKey)) return;
    bumpNotifyShowCount(spamKey);

    const t = translations[getNotifyLang()] || translations['en'];
    const names = ids.map((id) => {
        const j = JOKER_DATA.find((entry) => entry.id === id);
        return j ? (t[j.name] || j.name) : id;
    });
    const who = isSpectateMode
        ? (player === p1 ? 'AI 1' : 'AI 2')
        : (player.isAI ? 'Rival' : 'You');
    enqueueGameNotification({
        kicker: `${who} · Jokers`,
        title: names.join(' + '),
        body: ids.map((id) => {
            const j = JOKER_DATA.find((entry) => entry.id === id);
            return j ? (t[j.desc] || j.desc || '') : '';
        }).filter(Boolean).join(' · '),
        icon: '🃏',
        kind: 'joker',
        duration: 2800
    });
}

/** Queue one on-brand unlock notice per skill/joker — never batch into one toast. */
const unlockNotifyQueue = [];
let unlockNotifyBusy = false;

function enqueueUnlockNotification(kind, id) {
    if (!kind || !id) return;
    // One toast per unlock; caller only sends newly granted ids.
    // Still show the final unlock that completes the collection.
    if (unlockNotifyQueue.some((e) => e.kind === kind && e.id === id)) return;
    unlockNotifyQueue.push({ kind, id });
    pumpUnlockNotifications();
}

function areAllSkillsAndJokersUnlocked() {
    try {
        const progress = loadUnlockProgress();
        const allSkills = (typeof SKILL_DATA !== 'undefined' ? SKILL_DATA : []).map(s => s.id);
        const allJokers = (typeof JOKER_DATA !== 'undefined' ? JOKER_DATA : []).map(j => j.id);
        return allSkills.every(id => progress.skills.includes(id))
            && allJokers.every(id => progress.jokers.includes(id));
    } catch (_) {
        return false;
    }
}

function pumpUnlockNotifications() {
    if (unlockNotifyBusy || gameNotifyBusy) return;
    const next = unlockNotifyQueue.shift();
    if (!next) return;
    unlockNotifyBusy = true;
    showUnlockNotification(next.kind, next.id, () => {
        unlockNotifyBusy = false;
        // Small gap between stacked unlocks
        setTimeout(() => {
            pumpUnlockNotifications();
            pumpGameNotifications();
        }, 220);
    });
}

function showUnlockNotification(kind, id, onDone) {
    const savedLanguage = getNotifyLang();
    const t = translations[savedLanguage] || translations['en'];
    const seenId = `unlock_${kind}_${id}`;
    const firstTime = !hasSeenNotification(seenId);
    markNotificationSeen(seenId);

    let name = id;
    let desc = '';
    let icon = kind === 'skill' ? '⚡' : '🃏';
    let kicker = '';
    let hint = '';

    if (kind === 'skill') {
        const skill = SKILL_DATA.find(entry => entry.id === id);
        name = skill ? (t[skill.name] || skill.name) : id;
        desc = skill ? (t[skill.desc] || skill.desc || '') : '';
        icon = skill?.icon || '⚡';
        kicker = firstTime
            ? (t['NOTIFY_FIRST_SKILL_KICKER'] || 'First skill unlocked')
            : (t['NOTIFY_SKILL_KICKER'] || 'Skill unlocked');
        hint = firstTime ? (t['NOTIFY_SKILL_HINT'] || 'Equip in Loadout → Skills before your next match') : '';
    } else {
        const joker = JOKER_DATA.find(entry => entry.id === id);
        name = joker ? (t[joker.name] || joker.name) : id;
        desc = joker ? (t[joker.desc] || joker.desc || '') : '';
        icon = joker?.icon || '🃏';
        kicker = firstTime
            ? (t['NOTIFY_FIRST_JOKER_KICKER'] || 'First joker unlocked')
            : (t['NOTIFY_JOKER_KICKER'] || 'Joker unlocked');
        hint = firstTime ? (t['NOTIFY_JOKER_HINT'] || 'Equip in Loadout → Jokers (pick up to 2)') : '';
    }

    showGameNotification({
        kicker,
        title: name,
        body: desc,
        hint,
        icon,
        kind,
        firstTime,
        duration: firstTime ? 5200 : 3800
    }, onDone);
}

function showUnlockToast(skillId, jokerIds) {
    // Legacy single-line fallback (anti-cheat toast). Prefer enqueueUnlockNotification.
    const toast = document.getElementById('anti-cheat-toast');
    if (!toast) return;
    const savedLanguage = localStorage.getItem('ronk_language') || 'en';
    const t = translations[savedLanguage] || translations['en'];
    const parts = [];
    if (skillId) {
        const skill = SKILL_DATA.find(entry => entry.id === skillId);
        parts.push(skill ? (t[skill.name] || skill.name) : skillId);
    }
    (jokerIds || []).forEach((id) => {
        const joker = JOKER_DATA.find(entry => entry.id === id);
        parts.push(joker ? (t[joker.name] || joker.name) : id);
    });
    if (!parts.length) return;
    toast.textContent = `${t['UNLOCKED'] || 'UNLOCKED'}: ${parts.join(' + ')}`;
    toast.classList.remove('hidden');
    clearTimeout(showUnlockToast._timer);
    showUnlockToast._timer = setTimeout(() => toast.classList.add('hidden'), 4500);
}

function resolvePlayerMatchLoadout(allSkillIds) {
    if (isTutorialMatch || isTutorialBareMatch()) {
        return { skill: null, jokers: [] };
    }
    if (!isTutorialComplete()) {
        return { skill: null, jokers: [] };
    }

    const readSelectedJokers = () => {
        let jokers = [];
        try {
            jokers = JSON.parse(localStorage.getItem('ronk_selectedJoker') || '[]');
        } catch (_) {
            jokers = [];
        }
        if (!Array.isArray(jokers)) jokers = jokers ? [jokers] : [];
        if (shouldEnforceUnlockLocks()) {
            jokers = jokers.filter((id) => isJokerUnlocked(id));
        }
        return jokers.filter(Boolean).slice(0, 2);
    };

    if (shouldEnforceUnlockLocks()) {
        const unlockedSkills = getUnlockedSkills();
        const savedSkill = localStorage.getItem('ronk_selectedSkill');
        // Skills and jokers unlock independently — empty skills must NOT wipe jokers
        const skill = savedSkill && unlockedSkills.includes(savedSkill)
            ? savedSkill
            : (unlockedSkills[0] || null);
        return { skill, jokers: readSelectedJokers() };
    }
    if (currentGamemode === 'simplistic') {
        return { skill: null, jokers: [] };
    }
    return {
        skill: localStorage.getItem('ronk_selectedSkill') || allSkillIds[0] || null,
        jokers: readSelectedJokers()
    };
}

function launchTutorialMatch() {
    // Replay keeps unlocks — only first-time players are "incomplete"
    tutorialReplayActive = isTutorialComplete();
    isTutorialMatch = true;
    isTutorialActive = true;
    tutorialStep = 0;
    tutorialPracticeActive = true;
    tutorialFightWaitingForStart = false;
    tutorialObjectiveDone = false;
    opponentLoadoutForUnlock = null;
    isSpectateMode = false;
    isMultiplayer = false;
    isOnline = false;
    currentGamemode = 'normal';
    setBotDifficulty('medium');
    resetMatchScoreState();
    try {
        initGame();
    } catch (error) {
        console.error('Failed to start tutorial:', error);
        isTutorialMatch = false;
        tutorialReplayActive = false;
        showMainMenu();
        resetToMainTier();
    }
}

const BOT_DIFFICULTY_KEYS = ['easy', 'medium', 'hard', 'invincible'];

function setBotDifficulty(level) {
    if (!BOT_DIFFICULTY_KEYS.includes(level)) return;
    currentBotDifficulty = level;
    window.currentBotDifficulty = level;
    localStorage.setItem('ronk_botDifficulty', level);
    updateBotDifficultyUI();
    if (level === 'invincible' && typeof EliteBrain !== 'undefined' && EliteBrain.ensureReady) {
        try { EliteBrain.ensureReady(); } catch (_) { /* ignore */ }
    }
}

function updateBotDifficultyUI() {
    const startBtnEl = document.getElementById('start-btn');
    // Only rewrite classic single-line PLAY; pinkcore stacked labels are owned by applyLanguage.
    if (startBtnEl && !document.body.classList.contains('theme-pinkcore')) {
        const lang = localStorage.getItem('ronk_language') || 'en';
        const t = (typeof translations !== 'undefined' && translations[lang]) || {};
        startBtnEl.textContent = t['PLAY'] || 'PLAY';
    }

    BOT_DIFFICULTY_KEYS.forEach((key) => {
        const btn = document.getElementById(`bot-${key}-btn`);
        if (btn) btn.classList.toggle('bot-difficulty-selected', key === currentBotDifficulty);
    });
}

function getRivalBotName() {
    const label = typeof getBotDifficultyLabel === 'function'
        ? getBotDifficultyLabel(currentBotDifficulty)
        : (currentBotDifficulty || 'medium').toUpperCase();
    return `BOT (${label})`;
}

function showSpectateFriendNotice() {
    startSpectateFriendFlow();
}

function getMatchWinnerMessage() {
    const target = getEffectiveMatchTarget();
    const boardWin = lastBoardWinReason === 'ttt' || lastBoardWinReason === 'boards';
    const byKill = lastBoardWinReason === 'kill';
    if (isSpectateMode) {
        return p1Score >= target ? 'AI 1 WINS THE MATCH' : 'AI 2 WINS THE MATCH';
    }
    if (isMultiplayer && !isOnline) {
        if (p1Score >= target) {
            if (boardWin) return 'YOU WIN — TIC-TAC-TOE ROUND';
            return 'YOU WIN THE MATCH';
        }
        if (boardWin) return 'RIVAL WINS — TIC-TAC-TOE ROUND';
        return 'RIVAL WINS THE MATCH';
    }
    if (isTutorialMatch) {
        if (p1Score >= target) {
            return boardWin ? 'TUTORIAL COMPLETE — TIC-TAC-TOE ROUND!' : 'TUTORIAL COMPLETE!';
        }
        if (boardWin) return 'RIVAL WON A TIC-TAC-TOE ROUND';
        return 'RIVAL WON ON KILLS';
    }
    if (p1Score >= target) {
        if (boardWin) return 'YOU WIN — TIC-TAC-TOE ROUND';
        return 'YOU WIN THE MATCH';
    }
    if (boardWin) return 'BOT WINS — TIC-TAC-TOE ROUND';
    return 'BOT WINS THE MATCH';
}

function getMatchOverHint(wasTutorialMatch, playerWonMatch) {
    const lang = localStorage.getItem('ronk_language') || 'en';
    const t = translations[lang] || translations['en'];
    if (wasTutorialMatch && playerWonMatch) {
        return t['TUTORIAL_UNLOCK_HINT']
            || 'Skills and jokers are locked — beat bots or online players to unlock their loadouts first.';
    }
    if (wasTutorialMatch && !playerWonMatch) {
        return t['NOTIFY_LOSS_BOARDS']
            || 'Tip: claim 3 boards in a line to win the round — or get 1 kill. First to 6 rounds wins.';
    }
    if (!playerWonMatch && usesBoardControlMatchRules()) {
        if (lastBoardWinReason === 'kill') {
            return t['NOTIFY_LOSS_KILLS']
                || 'Tip: win a round with 1 kill — or connect 3 boards. First to 6 rounds wins.';
        }
        return t['NOTIFY_LOSS_BOARDS']
            || 'Tip: claim 3 boards in a line to win the round — or get 1 kill. First to 6 rounds wins.';
    }
    return '';
}
let isOnline = false;
let isPaused = false;
let settingsOpenedFromPause = false;
/** Navigation snapshot before opening Settings from menus/loadout */
let settingsReturnState = null;
let persistGameSettings = null;


function readVolumePref(key, fallback) {
    try {
        const saved = JSON.parse(localStorage.getItem('ronk_volume') || '{}');
        const n = Number(saved[key]);
        return Number.isFinite(n) ? n : fallback;
    } catch (_) {
        return fallback;
    }
}

function applySavedVolumePrefs() {
    const masterValue = readVolumePref('master', 70) / 100;
    const sfxValue = readVolumePref('sfx', 80) / 100;
    SFX.volume = masterValue * sfxValue;
}
let isResuming = false;
let resumeCountdownValue = 3;
let resumeCountdownTicks = 0;
let isTutorialActive = false;
let tutorialStep = 0;

function getTutorialLang() {
    return localStorage.getItem('ronk_language') || 'en';
}

function renderTutorialVisual(step) {
    const visual = document.getElementById('tutorial-visual');
    if (!visual) return;
    if (step >= TUTORIAL_FINAL_STEP) {
        visual.classList.add('tutorial-visual-hidden');
        visual.innerHTML = '';
        return;
    }
    visual.classList.remove('tutorial-visual-hidden');
    const demos = ['move', 'dash', 'charge', 'trails', 'boards', 'checkpoints', 'skills', 'hunger', 'fight'];
    const demo = demos[step] || 'move';
    const p1Cube = '<div class="tutorial-demo-cube p1"></div>';
    const p2Cube = '<div class="tutorial-demo-cube p2"></div>';
    let demoContent = '';
    switch (demo) {
        case 'move':
            demoContent = p1Cube;
            break;
        case 'dash':
        case 'charge':
            demoContent = `${p1Cube}<div class="tutorial-demo-trail"></div>`;
            break;
        case 'trails':
            demoContent = `${p1Cube}${p2Cube}<div class="tutorial-demo-trail"></div>`;
            break;
        case 'boards':
            demoContent = getTutorialLiveBoardMapHtml();
            break;
        case 'checkpoints':
            demoContent = `${getTutorialLiveBoardMapHtml()}<div class="tutorial-demo-cp-stack tutorial-cp-white"><span></span><span></span><span></span></div>`;
            break;
        case 'skills':
            demoContent = `${p1Cube}<div class="tutorial-demo-clone a"></div><div class="tutorial-demo-clone b"></div>`;
            break;
        case 'hunger':
            demoContent = `${p1Cube}<div class="tutorial-demo-apple"></div><div class="tutorial-demo-hunger-bar"><div class="tutorial-demo-hunger-fill"></div></div>`;
            break;
        case 'fight':
            demoContent = `${p1Cube}${p2Cube}`;
            break;
        default:
            demoContent = p1Cube;
    }
    visual.innerHTML = `
        <div class="tutorial-demo-grid"></div>
        <div class="tutorial-demo-${demo}">
            ${demoContent}
        </div>`;
    if (demo === 'boards' || demo === 'checkpoints') syncTutorialBoardMapMirror();
}

function shouldShowTutorialOverlay() {
    return tutorialAllowsPractice();
}

function hideTutorialOverlay() {
    const overlay = document.getElementById('tutorial-overlay');
    if (overlay) overlay.classList.add('hidden');
    tutorialPracticeActive = false;
    tutorialFightWaitingForStart = false;
    tutorialObjectiveDone = false;
}

function updateTutorialUI(step = tutorialStep) {
    if (!shouldShowTutorialOverlay()) {
        hideTutorialOverlay();
        return;
    }
    const lang = getTutorialLang();
    const t = translations[lang] || translations['en'];
    const overlay = document.getElementById('tutorial-overlay');
    const textEl = document.getElementById('tutorial-text');
    const keysEl = document.getElementById('tutorial-keys');
    const nextBtn = document.getElementById('tutorial-next');
    const dots = document.querySelectorAll('#tutorial-progress-dots .dot');

    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.classList.toggle('tutorial-practice', step < TUTORIAL_FINAL_STEP);
        overlay.classList.toggle('tutorial-fight-brief', step >= TUTORIAL_FINAL_STEP);
        overlay.classList.toggle('tutorial-step-done', tutorialObjectiveDone);
    }
    dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === step);
        dot.classList.toggle('done', i < step || (i === step && tutorialObjectiveDone));
    });

    renderTutorialVisual(step);

    if (typeof syncTutorialHudVisibility === 'function') syncTutorialHudVisibility();

    const pad = typeof usingGamepadInput !== 'undefined' && usingGamepadInput;
    const steps = pad ? [
        {
            message: t['TUTORIAL_MSG_0_PAD'] || 'Left stick / D-Pad to move',
            keys: '<span class="key pad">LS</span><span class="key pad">D-PAD</span>'
        },
        {
            message: t['TUTORIAL_MSG_1_PAD'] || 'A to dash',
            keys: '<span class="key pad">A</span>'
        },
        {
            message: t['TUTORIAL_MSG_2_PAD'] || 'B to charge',
            keys: '<span class="key pad">B</span>'
        },
        {
            message: t['TUTORIAL_MSG_3'] || 'Enemy trails kill',
            keys: ''
        },
        {
            message: t['TUTORIAL_MSG_4_PAD'] || 'Dash off the edge · watch the map move',
            keys: '<span class="key pad">A</span><span class="key pad">B</span>'
        },
        {
            message: t['TUTORIAL_MSG_5'] || 'Claim all 3 white squares to own this board',
            keys: ''
        },
        {
            message: t['TUTORIAL_MSG_6_PAD'] || 'X for skill',
            keys: '<span class="key pad">X</span>'
        },
        {
            message: t['TUTORIAL_MSG_7'] || 'Eat apples',
            keys: ''
        },
        {
            message: t['TUTORIAL_MSG_13'] || 'Match: first to 3',
            keys: ''
        }
    ] : [
        {
            message: t['TUTORIAL_MSG_0'] || 'WASD to move',
            keys: '<span class="key" data-key="w">W</span><span class="key" data-key="a">A</span><span class="key" data-key="s">S</span><span class="key" data-key="d">D</span>'
        },
        {
            message: t['TUTORIAL_MSG_1'] || 'F to dash',
            keys: '<span class="key" data-key="f">F</span>'
        },
        {
            message: t['TUTORIAL_MSG_2'] || 'C to charge',
            keys: '<span class="key" data-key="c">C</span>'
        },
        {
            message: t['TUTORIAL_MSG_3'] || 'Enemy trails kill',
            keys: ''
        },
        {
            message: t['TUTORIAL_MSG_4'] || 'Dash off the edge · watch the map move',
            keys: '<span class="key" data-key="f">F</span><span class="key" data-key="c">C</span>'
        },
        {
            message: t['TUTORIAL_MSG_5'] || 'Claim all 3 white squares to own this board',
            keys: ''
        },
        {
            message: t['TUTORIAL_MSG_6'] || 'Y for skill',
            keys: '<span class="key" data-key="y">Y</span>'
        },
        {
            message: t['TUTORIAL_MSG_7'] || 'Eat apples',
            keys: ''
        },
        {
            message: t['TUTORIAL_MSG_13'] || 'Match: first to 3',
            keys: ''
        }
    ];
    const cfg = steps[step] || steps[0];
    if (textEl) {
        let message = cfg.message;
        if (step === 4 && p1 && (p1.boardSx !== MIDDLE_BOARD_SX || p1.boardSy !== MIDDLE_BOARD_SY)) {
            message = t['TUTORIAL_MSG_4_ARRIVAL'] || 'You changed boards — map shows where you are';
        }
        textEl.textContent = tutorialObjectiveDone ? '✓' : message;
        textEl.classList.toggle('done', tutorialObjectiveDone);
    }
    if (keysEl) {
        keysEl.innerHTML = tutorialObjectiveDone ? '' : cfg.keys;
        keysEl.style.display = cfg.keys ? 'flex' : 'none';
    }

    const showFightStart = step >= TUTORIAL_FINAL_STEP && isTutorialFightWaiting();
    if (nextBtn) {
        if (showFightStart) {
            nextBtn.textContent = t['START'] || 'START';
            nextBtn.classList.remove('hidden');
            nextBtn.disabled = false;
            nextBtn.style.display = '';
        } else {
            nextBtn.classList.add('hidden');
            nextBtn.disabled = true;
            nextBtn.style.display = 'none';
        }
    }
}

function updateTutorialText(step, lang) {
    updateTutorialUI(step);
}

function showTutorialPanel() {
    if (!shouldShowTutorialOverlay()) {
        hideTutorialOverlay();
        return;
    }
    beginTutorialPracticeStep();
}

function markTutorialObjectiveComplete() {
    if (tutorialObjectiveDone || !isTutorialPracticePhase()) return;
    tutorialObjectiveDone = true;
    updateTutorialUI(tutorialStep);
    SFX.play('win', 0.35);
    clearTimeout(tutorialAdvanceTimer);
    tutorialAdvanceTimer = setTimeout(() => advanceTutorialStep(), 900);
}

function advanceTutorialStep() {
    clearTimeout(tutorialAdvanceTimer);
    tutorialObjectiveDone = false;
    tutorialStep++;

    if (tutorialStep >= TUTORIAL_FINAL_STEP) {
        tutorialPracticeActive = false;
        tutorialFightWaitingForStart = true;
        if (p1) {
            p1.selectedSkill = null;
            p1.infiniteChargeActive = false;
            p1.activeSkill = null;
            p1.skillTimer = 0;
        }
        if (p2) p2.tutorialFrozen = true;
        resetTutorialPracticePositions();
        gameState = 'TUTORIAL_WAIT';
        showTutorialFightBrief();
        return;
    }

    if (p2) p2.tutorialFrozen = true;
    beginTutorialPracticeStep();
}

function showTutorialFightBrief() {
    if (!shouldShowTutorialOverlay()) {
        hideTutorialOverlay();
        return;
    }
    tutorialFightWaitingForStart = true;
    gameState = 'TUTORIAL_WAIT';
    updateTutorialUI(TUTORIAL_FINAL_STEP);
    const overlay = document.getElementById('tutorial-overlay');
    if (overlay) overlay.classList.remove('hidden');
    clearTimeout(tutorialAdvanceTimer);
}

function spawnMatchApples() {
    apples = [];
    for (let sy = 0; sy < BOARDS_PER_SIDE; sy++) {
        for (let sx = 0; sx < BOARDS_PER_SIDE; sx++) {
            for (let i = 0; i < APPLES_PER_BOARD; i++) {
                spawnAppleOnBoard(sx, sy, 'player');
            }
        }
    }
}

function startTutorialFight() {
    if (!isTutorialFightWaiting()) return;
    tutorialFightWaitingForStart = false;
    resetMatchScoreState();
    resetTutorialPracticePositions();
    if (p1) {
        p1.growTrailBonus = 0;
        p1.hungerTimer = 0;
    }
    if (p2) {
        p2.growTrailBonus = 0;
        p2.hungerTimer = 0;
        p2.tutorialFrozen = false;
    }
    spawnMatchApples();
    const overlay = document.getElementById('tutorial-overlay');
    if (overlay) overlay.classList.add('hidden');
    updateScoreboard();
    syncTutorialHudVisibility();
    gameState = 'COUNTDOWN';
    countdownValue = 3;
    countdownTicks = 0;
    if (roundAnnouncerEl) roundAnnouncerEl.classList.remove('hidden');
    if (p1HudEl) p1HudEl.classList.remove('visible');
    if (p2HudEl) p2HudEl.classList.remove('visible');
    if (hungerBarsContainer) hungerBarsContainer.style.display = 'none';
}

function applyTutorialStep0WaitForInput() {
    if (!p1 || !isTutorialPracticePhase() || tutorialStep !== 0) return;
    p1.dir = { x: 0, y: 0 };
    p1._tutorialStartDir = { x: 0, y: 0 };
    p1.moveBuffer = [];
    p1.rollProgress = 0;
}

function applyTutorialTrailDemoFreeze() {
    if (!p1 || !isTutorialTrailDemoStep()) return;
    p1.dir = { x: 0, y: 0 };
    p1.moveBuffer = [];
    p1.rollProgress = 0;
    p1._tutorialTrailTicks = 0;
}

function resetTutorialChargeStepPositions() {
    if (!p1 || !p2) return;
    const { ox, oy } = middleBoardOrigin();
    const cy = oy + Math.floor(BOARD_SIZE / 2);
    const midX = ox + Math.floor(BOARD_SIZE / 2);
    const chargeDist = Math.min(6, Math.floor(BOARD_SIZE / 2) - 1);
    p1.boardSx = MIDDLE_BOARD_SX; p1.boardSy = MIDDLE_BOARD_SY;
    p2.boardSx = MIDDLE_BOARD_SX; p2.boardSy = MIDDLE_BOARD_SY;
    p1.x = midX - chargeDist;
    p1.y = cy;
    p2.x = midX;
    p2.y = cy;
    p1.prevX = p1.x; p1.prevY = p1.y;
    p2.prevX = p2.x; p2.prevY = p2.y;
    p1.dir = { x: 1, y: 0 };
    p2.dir = { x: -1, y: 0 };
    p1.trail = []; p2.trail = [];
    p1.isDead = false; p2.isDead = false;
    p1.moveBuffer = []; p2.moveBuffer = [];
    p1.hungerTimer = 0; p2.hungerTimer = 0;
    p1.isCharging = false; p2.isCharging = false;
    p1.isDashing = false; p2.isDashing = false;
    p1.chargeAnimTicks = 0; p2.chargeAnimTicks = 0;
    p1.dashAnimTicks = 0; p2.dashAnimTicks = 0;
    p1.lastCharge = 0;
    p1._tutorialChargeWhiffPending = false;
    clones = [];
    laserLines = [];
}

function resetTutorialTrailStepPositions() {
    if (!p1 || !p2) return;
    const { ox, oy } = middleBoardOrigin();
    const cx = ox + Math.floor(BOARD_SIZE / 2);
    const cy = oy + Math.floor(BOARD_SIZE / 2);
    const trailTop = oy + 2;
    const trailBottom = oy + BOARD_SIZE - 3;
    p1.boardSx = MIDDLE_BOARD_SX; p1.boardSy = MIDDLE_BOARD_SY;
    p2.boardSx = MIDDLE_BOARD_SX; p2.boardSy = MIDDLE_BOARD_SY;
    p1.x = ox + 2;
    p1.y = cy;
    p2.x = ox + BOARD_SIZE - 3;
    p2.y = cy;
    p1.prevX = p1.x; p1.prevY = p1.y;
    p2.prevX = p2.x; p2.prevY = p2.y;
    p1.dir = { x: 1, y: 0 };
    p2.dir = { x: -1, y: 0 };
    p1.trail = [];
    p2.trail = [];
    for (let y = trailTop; y <= trailBottom; y++) {
        p2.trail.push({ x: cx, y, boardSx: MIDDLE_BOARD_SX, boardSy: MIDDLE_BOARD_SY });
    }
    p1.isDead = false; p2.isDead = false;
    p1.isImmune = false; p2.isImmune = false;
    p1.moveBuffer = []; p2.moveBuffer = [];
    p1.hungerTimer = 0; p2.hungerTimer = 0;
    p1._tutorialTrailTicks = 0;
    clones = [];
    laserLines = [];
}

function applyTutorialHungerStepWait() {
    if (!p1 || !isTutorialHungerStep()) return;
    p1.dir = { x: 0, y: 0 };
    p1.moveBuffer = [];
    p1.rollProgress = 0;
}

function resetTutorialHungerStepPositions() {
    if (!p1 || !p2) return;
    const { ox, oy } = middleBoardOrigin();
    const cy = oy + Math.floor(BOARD_SIZE / 2);
    p1.boardSx = MIDDLE_BOARD_SX; p1.boardSy = MIDDLE_BOARD_SY;
    p2.boardSx = MIDDLE_BOARD_SX; p2.boardSy = MIDDLE_BOARD_SY;
    p1.x = ox + 2;
    p1.y = cy;
    p2.x = ox + BOARD_SIZE - 3;
    p2.y = cy;
    p1.prevX = p1.x; p1.prevY = p1.y;
    p2.prevX = p2.x; p2.prevY = p2.y;
    p1.dir = { x: 0, y: 0 };
    p2.dir = { x: -1, y: 0 };
    p1.trail = []; p2.trail = [];
    p1.isDead = false; p2.isDead = false;
    p1.isImmune = false; p2.isImmune = false;
    p1.moveBuffer = []; p2.moveBuffer = [];
    p1.growTrailBonus = 0;
    p2.growTrailBonus = 0;
    p1.hungerTimer = Math.round(p1.hungerDuration * 0.55);
    p2.hungerTimer = 0;
    p1.selectedSkill = null;
    p1.activeSkill = null;
    p1.skillTimer = 0;
    clones = [];
    laserLines = [];
    clearMiddleBoardCheckpointState();
    spawnTutorialApple();
    applyTutorialHungerStepWait();
}

function spawnTutorialApple() {
    apples = [];
    if (!p1) return;
    const { ox, oy } = middleBoardOrigin();
    const cy = oy + Math.floor(BOARD_SIZE / 2);
    let ax = p1.x + 4;
    let ay = cy;
    if (ax >= ox + BOARD_SIZE - 1) ax = p1.x + 2;
    apples.push({
        x: ax,
        y: ay,
        boardSx: MIDDLE_BOARD_SX,
        boardSy: MIDDLE_BOARD_SY,
        owner: 'player',
        spawnTime: Date.now(),
        bobOffset: Math.random() * Math.PI * 2,
        scale: 1,
        eaten: false
    });
}

function syncTutorialHungerBars() {
    if (!hungerBarsContainer) return;
    if (isTutorialHungerStep()) {
        hungerBarsContainer.style.display = 'flex';
    } else if (isTutorialPracticePhase()) {
        hungerBarsContainer.style.display = 'none';
    }
}

function resetTutorialTravelStepPositions() {
    if (!p1 || !p2) return;
    const cy = Math.floor(GRID_COUNT / 2);
    p1.boardSx = MIDDLE_BOARD_SX;
    p1.boardSy = MIDDLE_BOARD_SY;
    p2.boardSx = MIDDLE_BOARD_SX;
    p2.boardSy = MIDDLE_BOARD_SY;
    p1.x = GRID_COUNT - 2;
    p1.y = cy;
    p2.x = 2;
    p2.y = cy;
    p1.prevX = p1.x;
    p1.prevY = p1.y;
    p2.prevX = p2.x;
    p2.prevY = p2.y;
    p1.dir = { x: 1, y: 0 };
    p2.dir = { x: -1, y: 0 };
    p1.trail = [];
    p2.trail = [];
    p1.isDead = false;
    p2.isDead = false;
    p1.moveBuffer = [];
    p2.moveBuffer = [];
    p1.hungerTimer = 0;
    p2.hungerTimer = 0;
    p2.tutorialFrozen = true;
    clones = [];
    laserLines = [];
}

function clearMiddleBoardCheckpointState() {
    const board = worldBoards[boardIndexFromSector(MIDDLE_BOARD_SX, MIDDLE_BOARD_SY)];
    if (!board) return;
    board.owner = null;
    board.captureColor = null;
    board.checkpoints.forEach((cp) => { cp.owner = null; });
    _boardHudCache = '';
    updateBoardOwnershipHud();
}

function setupTutorialBoardTravelStep() {
    if (!p1 || !p2) return;
    p1._tutorialTravelArrivalShown = false;
    p1._tutorialTravelArrivalAt = 0;
    const midY = Math.floor(GRID_COUNT / 2);
    worldBoards.forEach((board) => {
        board.owner = null;
        board.captureColor = null;
        const occupied = new Set();
        if (board.sx === MIDDLE_BOARD_SX && board.sy === MIDDLE_BOARD_SY) {
            occupied.add(`1_${midY}`);
            occupied.add(`${GRID_COUNT - 2}_${midY}`);
        }
        board.checkpoints = buildCheckpointsForBoard(board.sx, board.sy, occupied);
    });
    resetTutorialTravelStepPositions();
    parkTutorialRivalOffscreen();
    _boardHudCache = '';
    _hudFocusBoardKey = '';
    updateBoardOwnershipHud();
    if (typeof updateViewBoard === 'function') updateViewBoard();
}

function setupTutorialBoardCheckpointStep() {
    if (!p1 || !p2) return;
    const destSx = Number.isInteger(p1.boardSx) && (p1.boardSx !== MIDDLE_BOARD_SX || p1.boardSy !== MIDDLE_BOARD_SY)
        ? p1.boardSx
        : wrapBoardIndex(MIDDLE_BOARD_SX + 1);
    const destSy = Number.isInteger(p1.boardSy) && (p1.boardSx !== MIDDLE_BOARD_SX || p1.boardSy !== MIDDLE_BOARD_SY)
        ? p1.boardSy
        : MIDDLE_BOARD_SY;
    worldBoards.forEach((board) => {
        board.owner = null;
        board.captureColor = null;
        board.checkpoints = buildCheckpointsForBoard(board.sx, board.sy, new Set());
    });
    const board = worldBoards[boardIndexFromSector(destSx, destSy)];
    const cy = Math.floor(GRID_COUNT / 2);
    const cx = Math.floor(GRID_COUNT / 2);
    if (board) {
        board.checkpoints = [
            { x: cx - 3, y: cy, boardSx: destSx, boardSy: destSy, owner: null, pulse: 0 },
            { x: cx, y: cy, boardSx: destSx, boardSy: destSy, owner: null, pulse: 1.2 },
            { x: cx + 3, y: cy, boardSx: destSx, boardSy: destSy, owner: null, pulse: 2.4 }
        ];
    }
    p1.boardSx = destSx;
    p1.boardSy = destSy;
    p1.x = cx - 6;
    p1.y = cy;
    p1.prevX = p1.x;
    p1.prevY = p1.y;
    p1.dir = { x: 1, y: 0 };
    p1.trail = [];
    p1.isDead = false;
    p1.moveBuffer = [];
    p1.hungerTimer = 0;
    parkTutorialRivalOffscreen();
    clones = [];
    laserLines = [];
    _boardHudCache = '';
    _hudFocusBoardKey = '';
    updateBoardOwnershipHud();
    if (typeof updateViewBoard === 'function') updateViewBoard();
}

function setupTutorialCheckpointLayout(board) {
    if (!board) return;
    const midY = Math.floor(GRID_COUNT / 2);
    const occupied = new Set();
    if (board.sx === MIDDLE_BOARD_SX && board.sy === MIDDLE_BOARD_SY) {
        occupied.add(`1_${midY}`);
        occupied.add(`${GRID_COUNT - 2}_${midY}`);
    }
    board.checkpoints = buildCheckpointsForBoard(board.sx, board.sy, occupied);
    board.owner = null;
    board.captureColor = null;
}

function resetTutorialCheckpointStepPositions() {
    if (!p1 || !p2) return;
    const board = worldBoards[boardIndexFromSector(MIDDLE_BOARD_SX, MIDDLE_BOARD_SY)];
    setupTutorialCheckpointLayout(board);
    const cy = Math.floor(GRID_COUNT / 2);
    const cx = Math.floor(GRID_COUNT / 2);
    p1.boardSx = MIDDLE_BOARD_SX;
    p1.boardSy = MIDDLE_BOARD_SY;
    p2.boardSx = MIDDLE_BOARD_SX;
    p2.boardSy = MIDDLE_BOARD_SY;
    p1.x = cx - 6;
    p1.y = cy;
    p2.x = 1;
    p2.y = cy;
    p1.prevX = p1.x;
    p1.prevY = p1.y;
    p2.prevX = p2.x;
    p2.prevY = p2.y;
    p1.dir = { x: 1, y: 0 };
    p2.dir = { x: -1, y: 0 };
    p1.trail = [];
    p2.trail = [];
    p1.isDead = false;
    p2.isDead = false;
    p1.moveBuffer = [];
    p2.moveBuffer = [];
    p1.hungerTimer = 0;
    p2.hungerTimer = 0;
    p2.tutorialFrozen = true;
    clones = [];
    laserLines = [];
    _boardHudCache = '';
    if (typeof updateViewBoard === 'function') updateViewBoard();
    updateBoardOwnershipHud();
}

function resetTutorialSkillStepState() {
    if (!p1) return;
    p1.selectedSkill = SKILL_TYPES.CLONES;
    p1.activeSkill = null;
    p1.skillTimer = 0;
    p1.infiniteChargeActive = false;
    p1.lastSkillUsed = 0;
    clones = [];
    laserLines = [];
}

function resetTutorialPracticePositions() {
    if (isTutorialPracticePhase() && tutorialStep === 2) {
        resetTutorialChargeStepPositions();
        return;
    }
    if (isTutorialPracticePhase() && tutorialStep === 0) {
        if (!p1 || !p2) return;
        p1.boardSx = MIDDLE_BOARD_SX; p1.boardSy = MIDDLE_BOARD_SY;
        p2.boardSx = MIDDLE_BOARD_SX; p2.boardSy = MIDDLE_BOARD_SY;
        p1.x = 0; p1.y = 0;
        p2.x = GRID_COUNT - 1; p2.y = GRID_COUNT - 1;
        p1.prevX = p1.x; p1.prevY = p1.y;
        p2.prevX = p2.x; p2.prevY = p2.y;
        p2.dir = { x: -1, y: 0 };
        p1.trail = []; p2.trail = [];
        p1.isDead = false; p2.isDead = false;
        p1.moveBuffer = []; p2.moveBuffer = [];
        p1.hungerTimer = 0; p2.hungerTimer = 0;
        clones = [];
        laserLines = [];
        applyTutorialStep0WaitForInput();
        return;
    }
    if (!p1 || !p2) return;
    p1.boardSx = MIDDLE_BOARD_SX; p1.boardSy = MIDDLE_BOARD_SY;
    p2.boardSx = MIDDLE_BOARD_SX; p2.boardSy = MIDDLE_BOARD_SY;
    p1.x = 0; p1.y = 0;
    p2.x = GRID_COUNT - 1; p2.y = GRID_COUNT - 1;
    p1.prevX = p1.x; p1.prevY = p1.y;
    p2.prevX = p2.x; p2.prevY = p2.y;
    p1.dir = { x: 1, y: 0 };
    p2.dir = { x: -1, y: 0 };
    p1.trail = []; p2.trail = [];
    p1.isDead = false; p2.isDead = false;
    p1.moveBuffer = []; p2.moveBuffer = [];
    p1.hungerTimer = 0; p2.hungerTimer = 0;
    p1._tutorialStartDir = { x: 1, y: 0 };
    clones = [];
    laserLines = [];
}

function tickTutorialPractice() {
    if (!isTutorialPracticePhase() || !p1 || tutorialObjectiveDone) return;

    if (tutorialStep === 0 && p1._tutorialStartDir) {
        if (p1.dir.x !== p1._tutorialStartDir.x || p1.dir.y !== p1._tutorialStartDir.y) {
            markTutorialObjectiveComplete();
        }
    } else if (tutorialStep === 1) {
        if (p1.isDashing || p1.dashAnimTicks > 0 || p1.lastDash > (p1._tutorialStepStartMs || 0)) {
            markTutorialObjectiveComplete();
        }
    } else if (tutorialStep === 2) {
        if (p2.isDead && !p1.isDead) {
            markTutorialObjectiveComplete();
        } else if (p1._tutorialChargeWhiffPending && !p1.isCharging && p1.chargeAnimTicks === 0) {
            p1._tutorialChargeWhiffPending = false;
            resetTutorialChargeStepPositions();
        }
    } else if (tutorialStep === 3) {
        if (p1.isDead) {
            if (p1.deathAnimTicks >= Math.round(1.8 * TICK_RATE)) {
                markTutorialObjectiveComplete();
            }
            return;
        }
    } else if (tutorialStep === 4) {
        const traveled = p1.boardSx !== MIDDLE_BOARD_SX || p1.boardSy !== MIDDLE_BOARD_SY;
        if (!traveled) return;
        if (!p1._tutorialTravelArrivalShown) {
            p1._tutorialTravelArrivalShown = true;
            showTutorialTravelArrival();
        }
        const arrivedAt = p1._tutorialTravelArrivalAt || 0;
        if (arrivedAt && Date.now() - arrivedAt > 1200) {
            markTutorialObjectiveComplete();
        }
    } else if (tutorialStep === 5) {
        const board = worldBoards[boardIndexFromSector(p1.boardSx, p1.boardSy)];
        if (!board) return;
        if (typeof tryClaimCheckpointsAt === 'function') tryClaimCheckpointsAt(p1);
        const claimed = board.checkpoints.filter((c) => c.owner === 'player').length;
        if (claimed >= CHECKPOINTS_PER_BOARD && !board.owner) {
            evaluateBoardCapture(board);
        }
        if (board.owner === 'player') {
            markTutorialObjectiveComplete();
        }
    }
}

function beginTutorialPracticeStep() {
    if (!p1 || tutorialStep >= TUTORIAL_FINAL_STEP) {
        updateTutorialUI(tutorialStep);
        return;
    }
    if (tutorialStep !== 7) {
        apples = [];
    }
    p1._tutorialStepStartMs = Date.now();
    if (tutorialStep === 0) {
        applyTutorialStep0WaitForInput();
        parkTutorialRivalOffscreen();
    } else if (tutorialStep === 1) {
        resetTutorialPracticePositions();
        parkTutorialRivalOffscreen();
    } else if (tutorialStep === 2) {
        resetTutorialChargeStepPositions();
    } else if (tutorialStep === 3) {
        resetTutorialTrailStepPositions();
        applyTutorialTrailDemoFreeze();
    } else if (tutorialStep === 4) {
        setupTutorialBoardTravelStep();
    } else if (tutorialStep === 5) {
        setupTutorialBoardCheckpointStep();
    } else if (tutorialStep === 6) {
        clearMiddleBoardCheckpointState();
        resetTutorialPracticePositions();
        resetTutorialSkillStepState();
        parkTutorialRivalOffscreen();
    } else if (tutorialStep === 7) {
        clearMiddleBoardCheckpointState();
        resetTutorialHungerStepPositions();
        parkTutorialRivalOffscreen();
    }
    syncTutorialHungerBars();
    tutorialObjectiveDone = false;
    updateTutorialUI(tutorialStep);
}

function notifyTutorialMoveInput() {
    if (!isTutorialPracticePhase() || tutorialStep !== 0 || tutorialObjectiveDone) return;
    markTutorialObjectiveComplete();
}

function notifyTutorialDash() {
    if (!isTutorialPracticePhase() || tutorialStep !== 1 || tutorialObjectiveDone) return;
    markTutorialObjectiveComplete();
}

function notifyTutorialChargeHit() {
    if (!isTutorialPracticePhase() || tutorialStep !== 2 || tutorialObjectiveDone) return;
    markTutorialObjectiveComplete();
}

function notifyTutorialSkillUsed() {
    if (!isTutorialPracticePhase() || tutorialStep !== 6 || tutorialObjectiveDone) return;
    markTutorialObjectiveComplete();
}

function notifyTutorialAppleEaten() {
    if (!isTutorialHungerStep() || tutorialObjectiveDone) return;
    markTutorialObjectiveComplete();
}

function flashTutorialKey(key) {
    const keysEl = document.getElementById('tutorial-keys');
    if (!keysEl) return;
    keysEl.querySelectorAll('.key').forEach(el => {
        if (el.dataset.key === key) {
            el.classList.add('pressed');
            setTimeout(() => el.classList.remove('pressed'), 180);
        }
    });
}

let gameState = 'LOBBY'; 
let gameHasStarted = false;
let countdownValue = 3;
let countdownTicks = 0;
let menuTimer = null;
let endTimerStarted = false;
/** One-shot guard so deaths don't award score every tick (board-control bug). */
let roundOutcomeScored = false;
/** Finished small rounds this match (includes draws) — drives ROUND N display. */
let roundsCompletedThisMatch = 0;

function canPauseGameplay() {
    // Online human vs human: no pause / no quit mid-match (fairness + desync)
    if (isOnline) return false;
    return (gameState === 'PLAYING' || gameState === 'COUNTDOWN' || gameState === 'ROUND_OVER' || gameState === 'TUTORIAL_WAIT')
        && gameUi && !gameUi.classList.contains('hidden')
        && !isResuming;
}

function isInActiveGameView() {
    return (gameState === 'PLAYING' || gameState === 'COUNTDOWN' || gameState === 'ROUND_OVER' || gameState === 'GAME_OVER')
        && gameUi && !gameUi.classList.contains('hidden');
}

function setGamePaused(paused, startResumeCountdown = false, opts = null) {
    // Hard block: never pause an online PvP match (local or remote packet)
    if (isOnline) {
        isPaused = false;
        document.body.classList.remove('game-paused');
        if (pauseMenu) {
            pauseMenu.classList.add('hidden');
            pauseMenu.style.display = 'none';
        }
        syncGameplayCursor();
        return;
    }
    isPaused = paused;
    if (!paused) settingsOpenedFromPause = false;
    if (activeNavigation.screen === 'in-game') {
        activeNavigation.paused = paused;
    }
    if (!opts?.fromRemote && typeof sendOnlinePauseState === 'function') {
        sendOnlinePauseState(paused);
    }
    const roundAnnouncer = document.getElementById('round-announcer');
    if (pauseMenu) {
        if (paused) {
            pauseMenu.classList.remove('hidden');
            pauseMenu.style.display = 'flex';
            document.body.classList.add('game-paused');
            if (typeof updatePauseControlsHint === 'function') updatePauseControlsHint();
            if (roundAnnouncer) roundAnnouncer.classList.add('hidden');
            // Cut short one-shot SFX; theme music keeps playing through pause
            SFX.stopAll();
            // Auto-focus Resume whenever a pad is in use (or Start just opened pause)
            requestAnimationFrame(() => {
                const resumeBtn = document.getElementById('resume-btn');
                if (usingGamepadInput || document.body.classList.contains('using-gamepad')) {
                    if (resumeBtn) focusGamepadNavButton(resumeBtn);
                    else ensureGamepadMenuFocus();
                } else if (resumeBtn) {
                    try { resumeBtn.blur(); } catch (_) { /* ignore */ }
                    resumeBtn.classList.remove('ronk-pad-focus');
                }
            });
        } else {
            pauseMenu.classList.add('hidden');
            pauseMenu.style.display = 'none';
            document.body.classList.remove('game-paused');
            pauseMenu.querySelectorAll('.ronk-pad-focus').forEach((el) => el.classList.remove('ronk-pad-focus'));
            if (startResumeCountdown) {
                isResuming = true;
                resumeCountdownValue = 3;
                resumeCountdownTicks = 0;
                // Music was never paused — leave it alone through the countdown
            }
            // Do not Music.resume() here: music keeps playing on pause, and
            // resume()/play() can restart or double-stack the track.
        }
    } else if (paused) {
        document.body.classList.add('game-paused');
        SFX.stopAll();
    } else {
        document.body.classList.remove('game-paused');
    }
    syncGameplayCursor();
}

function forcePauseOnLeave() {
    if (!canPauseGameplay() || isPaused) return;
    setGamePaused(true);
}

function clearRoundEndTimer() {
    if (menuTimer) {
        clearTimeout(menuTimer);
        menuTimer = null;
    }
    endTimerStarted = false;
}

function scheduleRoundEndTransition() {
    if (endTimerStarted) return;
    endTimerStarted = true;
    if (menuTimer) clearTimeout(menuTimer);

    const matchAlreadyWon = (typeof getEffectiveMatchTarget === 'function')
        && (p1Score >= getEffectiveMatchTarget() || p2Score >= getEffectiveMatchTarget());
    if (matchAlreadyWon) gameState = 'GAME_OVER';
    screenShake = 0;

    // Flash round result so draws aren't mistaken for "score didn't count"
    if (roundAnnouncerEl && (gameState === 'ROUND_OVER' || gameState === 'GAME_OVER')) {
        roundAnnouncerEl.classList.remove('hidden');
        roundAnnouncerEl.classList.remove('go-phase');
        if (roundTextEl) {
            if (gameState === 'GAME_OVER') roundTextEl.textContent = 'MATCH OVER';
            else if (lastBoardWinReason === 'draw') roundTextEl.textContent = 'DRAW';
            else if (lastBoardWinReason === 'ttt') roundTextEl.textContent = 'TIC-TAC-TOE';
            else roundTextEl.textContent = 'ROUND WIN';
        }
        if (countdownTextEl) {
            countdownTextEl.textContent = `${p1Score} - ${p2Score}`;
        }
    }

    // Match over: show the end window quickly. Mid-match rounds keep a short beat.
    const delayMs = gameState === 'GAME_OVER'
        ? 700
        : (usesBoardControlMatchRules() ? 1100 : 1800);
    menuTimer = setTimeout(() => {
        endTimerStarted = false;
        menuTimer = null;
        if (gameState === 'GAME_OVER'
            || p1Score >= getEffectiveMatchTarget()
            || p2Score >= getEffectiveMatchTarget()) {
            gameState = 'GAME_OVER';
            try {
                endGame();
            } catch (err) {
                console.error('endGame failed — forcing game-over UI', err);
                forceShowGameOverUi();
            }
        } else if (gameState === 'ROUND_OVER') {
            // Yield two frames so the freeze pose paints, then reset without a canvas realloc hitch
            const startNext = () => {
                try { initGame(); } catch (err) {
                    console.error('next round init failed', err);
                }
            };
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => requestAnimationFrame(startNext));
            } else {
                startNext();
            }
        }
    }, delayMs);
}

function releaseGameplayMemory() {
    releaseOffscreenGrid();
    if (typeof releaseRoundFreezeScene === 'function') releaseRoundFreezeScene();
    ronkScanlineCache = null;
    ronkScanlineCacheKey = '';
    if (typeof colorCache !== 'undefined' && colorCache && colorCache.clear) colorCache.clear();
    if (typeof gradientCache !== 'undefined' && gradientCache && gradientCache.clear) gradientCache.clear();
    clones = [];
    laserLines = [];
    friendWalls = [];
    apples = [];
    if (p1) {
        if (typeof clearPlayerTrailState === 'function') clearPlayerTrailState(p1);
        else { p1.trail = []; p1._trailOccSet = null; }
    }
    if (p2) {
        if (typeof clearPlayerTrailState === 'function') clearPlayerTrailState(p2);
        else { p2.trail = []; p2._trailOccSet = null; }
    }
    // Shrink game canvas while in menu — full buffer rebuilds on next match
    if (canvas && gameState === 'LOBBY') {
        try {
            canvas.width = 1;
            canvas.height = 1;
        } catch (_) { /* ignore */ }
    }
    // Keep only the active theme track decoded
    try {
        if (typeof Music !== 'undefined' && Music._evictIdleTracks) {
            Music._evictIdleTracks(Music.currentFilename);
        }
    } catch (_) { /* ignore */ }
    releaseLoadoutCubeMemory();
}

function returnToLobbyState({ stopLoop = true } = {}) {
    gameState = 'LOBBY';
    gameHasStarted = false;
    isPaused = false;
    isResuming = false;
    try { window.RonkSteamAchievements?.flushPendingSteamUnlocks?.(); } catch (_) { /* ignore */ }
    gamepadRebindLocked = false;
    SFX.stopAll();
    if (!isTutorialMatch) {
        hideTutorialOverlay();
    }
    clearRoundEndTimer();
    roundOutcomeScored = false;
    // Spectate/AI kits must never stick on the player's saved loadout
    if (typeof restorePlayerPersistentLoadout === 'function') {
        const wasSpectate = isSpectateMode;
        isSpectateMode = false;
        restorePlayerPersistentLoadout();
        if (wasSpectate) {
            p1MatchJokers = [];
            p2MatchJokers = [];
            p1SelectedSkillForMatch = null;
            p2SelectedSkillForMatch = null;
        }
    }
    if (stopLoop && animLoop) {
        cancelAnimationFrame(animLoop);
        animLoop = null;
    }
    try { scheduleGamepadPoll(); } catch (_) { /* ignore */ }
    releaseGameplayMemory();
}

let screenShake = 0;
const SHAKE_TABLE = [
    { x: 0.42, y: -0.38 }, { x: -0.35, y: 0.44 }, { x: 0.28, y: 0.31 },
    { x: -0.48, y: -0.22 }, { x: 0.15, y: -0.46 }, { x: -0.26, y: 0.36 },
    { x: 0.47, y: 0.18 }, { x: -0.18, y: -0.41 }
];
let ambiencePhase = 0;
let deathCounter = 0;
const themes = ['theme-ronk', 'theme-white-black', 'theme-pinkcore', 'theme-hacker', 'theme-pixel'];
let currentThemeIndex = 0; 

function getPlayerBaseId(id) {
    return String(id).split('_')[0];
}

/** Friend Walls: owner + their clones share the wall (not strict object identity). */
function isFriendlyWallOwner(wall, player) {
    if (!wall || !player) return false;
    const wId = wall.ownerId != null ? String(wall.ownerId) : (wall.owner ? getPlayerBaseId(wall.owner.id) : '');
    const pBase = getPlayerBaseId(player.id);
    if (wId && pBase && wId === pBase) return true;
    if (wall.owner === player) return true;
    if (!wall.owner) return false;
    const wBase = getPlayerBaseId(wall.owner.id);
    if (wBase && pBase && wBase === pBase) return true;
    if (player.ownerId != null && String(player.ownerId) === String(wId || wBase)) return true;
    if (wall.owner.ownerId != null && String(wall.owner.ownerId) === String(pBase)) return true;
    return false;
}

/** Same army = you, your clones, your owner. Never lethal to each other via laser/trail/wall. */
function isSameArmy(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const aBase = getPlayerBaseId(a.id);
    const bBase = getPlayerBaseId(b.id);
    if (aBase && bBase && aBase === bBase) return true;
    if (a.ownerId != null && String(a.ownerId) === String(bBase)) return true;
    if (b.ownerId != null && String(b.ownerId) === String(aBase)) return true;
    return false;
}

/** Own / same-army lasers never kill you (owner object or ownerId). */
function isFriendlyLaserOwner(laser, player) {
    if (!laser || !player) return false;
    if (laser.owner && isSameArmy(laser.owner, player)) return true;
    const oId = laser.ownerId != null && laser.ownerId !== ''
        ? String(laser.ownerId)
        : (laser.owner ? getPlayerBaseId(laser.owner.id) : '');
    if (!oId) return false;
    const pBase = getPlayerBaseId(player.id);
    if (oId && pBase && oId === pBase) return true;
    if (player.ownerId != null && String(player.ownerId) === oId) return true;
    return false;
}

/** True when a laser may kill this player (valid enemy owner required). */
function isEnemyLaserLethalTo(laser, player) {
    if (!laser || !player) return false;
    const oId = laser.ownerId != null && laser.ownerId !== ''
        ? String(laser.ownerId)
        : (laser.owner ? getPlayerBaseId(laser.owner.id) : '');
    // Orphan / unowned beams: draw OK, never lethal (stops phantom row kills)
    if (!oId && !laser.owner) return false;
    if (isFriendlyLaserOwner(laser, player)) return false;
    if (laser.owner && typeof isSameArmy === 'function' && isSameArmy(laser.owner, player)) return false;
    if (oId) {
        const pBase = getPlayerBaseId(player.id);
        if (oId === pBase) return false;
        if (player.ownerId != null && String(player.ownerId) === oId) return false;
        // Owner must be a real cube army — reject garbage / desync ids
        const p1b = (typeof p1 !== 'undefined' && p1) ? getPlayerBaseId(p1.id) : '';
        const p2b = (typeof p2 !== 'undefined' && p2) ? getPlayerBaseId(p2.id) : '';
        if (p1b && p2b && oId !== p1b && oId !== p2b) return false;
    }
    return true;
}

/** Resolve laser beam color for draw even when owner object was GC'd / desynced. */
function getLaserDrawColor(laser) {
    if (laser && laser.owner && laser.owner.color) return laser.owner.color;
    if (laser && laser.color) return laser.color;
    const oid = laser && laser.ownerId != null ? String(laser.ownerId) : '';
    if (oid && p1 && getPlayerBaseId(p1.id) === oid && p1.color) return p1.color;
    if (oid && p2 && getPlayerBaseId(p2.id) === oid && p2.color) return p2.color;
    return '#ffffff';
}

if (typeof window !== 'undefined') {
    window.isFriendlyWallOwner = isFriendlyWallOwner;
    window.isFriendlyLaserOwner = isFriendlyLaserOwner;
    window.isEnemyLaserLethalTo = isEnemyLaserLethalTo;
    window.isSameArmy = isSameArmy;
    window.getPlayerBaseId = getPlayerBaseId;
}

function getPlayerVisualPos(p) {
    const t = Number.isFinite(p.rollProgress) ? p.rollProgress : 1;
    const fromX = Number.isFinite(p.prevX) ? p.prevX : p.x;
    const fromY = Number.isFinite(p.prevY) ? p.prevY : p.y;
    return {
        x: fromX + (p.x - fromX) * t,
        y: fromY + (p.y - fromY) * t
    };
}

/** True when the cube occupies the wall's grid cell (not visual lerp — that caused phantom kills). */
function playerTouchesEnemyWall(p, wall) {
    if (!p || p.isDead || p.isImmune || !wall) return false;
    if (p._spawnGraceTicks > 0 || p._landGraceTicks > 0) return false;
    if (p.isCharging || p.isDashing || p.chargeAnimTicks > 0 || p.dashAnimTicks > 0) return false;
    // Orphan walls never lethal
    const wId = wall.ownerId != null ? String(wall.ownerId) : '';
    if (!wId && !wall.owner) return false;
    if (!Number.isInteger(wall.boardSx) || !Number.isInteger(wall.boardSy)) return false;
    if (typeof sameBoardCoords === 'function' && !sameBoardCoords(p, wall)) return false;
    if (isFriendlyWallOwner(wall, p)) return false;
    const px = Math.floor(Number(p.x));
    const py = Math.floor(Number(p.y));
    const wx = Math.floor(Number(wall.x));
    const wy = Math.floor(Number(wall.y));
    return px === wx && py === wy;
}

function checkFriendWallTouches() {
    if (gameState !== 'PLAYING' || !friendWalls.length) return;
    const allPlayers = [p1, p2, ...(typeof clones !== 'undefined' ? clones : [])];
    allPlayers.forEach((p) => {
        if (!p || p.isDead) return;
        if (typeof ensurePlayerBoard === 'function') ensurePlayerBoard(p);
        if (typeof isOnline !== 'undefined' && isOnline && p._netRemoteDriven) return;
        for (let i = 0; i < friendWalls.length; i++) {
            if (playerTouchesEnemyWall(p, friendWalls[i])) {
                p.die('hit', 'enemy-wall');
                return;
            }
        }
    });
}

function countAliveClonesFor(player) {
    const baseId = getPlayerBaseId(player.id);
    return clones.filter(c => c && !c.isDead && (c.ownerId === baseId || getPlayerBaseId(c.id) === baseId)).length;
}

function countFriendlyCubesFor(player) {
    if (!player || player.isDead || player.isClone) return countAliveClonesFor(player);
    return 1 + countAliveClonesFor(player);
}

// --- SPECIAL SKILLS STATE ---
let clones = [];
let laserLines = [];
let friendWalls = [];

// --- APPLE COLLECTIBLES ---
let apples = [];
const APPLE_SIZE = 60;
const APPLE_SPAWN_INTERVAL = 500;
const APPLE_SCORE = 1;
const APPLES_PER_BOARD = 5;
const APPLES_PER_PLAYER = 3;
let appleSpawnTimer = 0;

function spawnAppleOnBoard(boardSx, boardSy, owner = 'player') {
    const midY = Math.floor(GRID_COUNT / 2);
    let x, y;
    let attempts = 0;
    do {
        x = Math.floor(matchRandom() * GRID_COUNT);
        y = Math.floor(matchRandom() * GRID_COUNT);
        attempts++;
        const isPlayerStart = (boardSx === MIDDLE_BOARD_SX && boardSy === MIDDLE_BOARD_SY && x === 1 && y === midY);
        const isEnemyStart = (boardSx === MIDDLE_BOARD_SX && boardSy === MIDDLE_BOARD_SY && x === GRID_COUNT - 2 && y === midY);
        if (isPlayerStart || isEnemyStart) continue;
        const board = worldBoards[boardIndexFromSector(boardSx, boardSy)];
        if (board?.checkpoints?.some((cp) => Math.abs(cp.x - x) + Math.abs(cp.y - y) <= 1)) continue;
    } while (
        attempts < 120 &&
        (isOccupied(x, y, null, boardSx, boardSy) ||
            apples.some((a) => !a.eaten && a.x === x && a.y === y && a.boardSx === boardSx && a.boardSy === boardSy))
    );
    if (attempts >= 120) return false;
    apples.push({
        x,
        y,
        boardSx,
        boardSy,
        owner,
        spawnTime: Date.now(),
        bobOffset: matchRandom() * Math.PI * 2,
        scale: 1,
        eaten: false
    });
    return true;
}

function replenishBoardApples() {
    if (gameState !== 'PLAYING') return;
    if (typeof isTutorialPracticePhase === 'function' && isTutorialPracticePhase()) return;
    if (typeof isTutorialHungerStep === 'function' && isTutorialHungerStep()) return;
    for (let sy = 0; sy < BOARDS_PER_SIDE; sy++) {
        for (let sx = 0; sx < BOARDS_PER_SIDE; sx++) {
            let onBoard = apples.filter((a) => !a.eaten && a.boardSx === sx && a.boardSy === sy).length;
            while (onBoard < APPLES_PER_BOARD) {
                if (!spawnAppleOnBoard(sx, sy, 'player')) break;
                onBoard++;
            }
        }
    }
}

function spawnApple(owner) {
    const boardSx = Math.floor(Math.random() * BOARDS_PER_SIDE);
    const boardSy = Math.floor(Math.random() * BOARDS_PER_SIDE);
    spawnAppleOnBoard(boardSx, boardSy, owner);
}

function isOccupied(x, y, player = null, boardSx = null, boardSy = null) {
    const onBoard = (ent) => {
        if (boardSx == null || boardSy == null) return true;
        if (!ent) return false;
        const esx = Number.isInteger(ent.boardSx) ? ent.boardSx : MIDDLE_BOARD_SX;
        const esy = Number.isInteger(ent.boardSy) ? ent.boardSy : MIDDLE_BOARD_SY;
        return esx === boardSx && esy === boardSy;
    };
    if (p1 && !p1.isDead && onBoard(p1) && p1.x === x && p1.y === y) return true;
    if (p2 && !p2.isDead && onBoard(p2) && p2.x === x && p2.y === y) return true;
    if (p1 && p1.trail.some(t => t.x === x && t.y === y && onBoard(t))) return true;
    if (p2 && p2.trail.some(t => t.x === x && t.y === y && onBoard(t))) return true;
    // Joker 7 (friend-blocks): friendly for owner + their clones (not identity-only)
    if (player) {
        return friendWalls.some(wall => wall.x === x && wall.y === y && onBoard(wall) && !isFriendlyWallOwner(wall, player));
    }
    // Without player, consider all walls as occupied
    return friendWalls.some(wall => wall.x === x && wall.y === y && onBoard(wall));
}

function updateApples() {
    const now = Date.now();
    
    for (let i = apples.length - 1; i >= 0; i--) {
        const apple = apples[i];
        const age = now - apple.spawnTime;
        
        if (!apple.eaten) {
            apple.scale = 1 + Math.sin(age * 0.005 + apple.bobOffset) * 0.15;
        }
        
        if (apple.eaten && now - apple.eatenTime > 500) {
            apples.splice(i, 1);
        }
    }
    
    // Keep at least APPLES_PER_BOARD apples on every board
    replenishBoardApples();
}

function checkAppleCollision() {
    if (gameState !== 'PLAYING') return;
    
    for (let i = 0; i < apples.length; i++) {
        const apple = apples[i];
        if (apple.eaten) continue;
        
        // Player 1 can eat ANY apple (rainbow apples are shared)
        if (p1 && !p1.isDead && sameBoardCoords(p1, apple) && p1.x === apple.x && p1.y === apple.y) {
            apple.eaten = true;
            apple.eatenTime = Date.now();
            // Reset hunger timer
            p1.hungerTimer = 0;
            p1.lastAppleEaten = Date.now();
            // Grow trail permanently for this round (capped at map size — same feel, bounded RAM)
            p1.growTrailBonus = Math.min(getMaxTrailPoints(), (p1.growTrailBonus || 0) + 1);
            if (typeof notifyTutorialAppleEaten === 'function') notifyTutorialAppleEaten();
            if (!p1.isAI) window.RonkSteamAchievements?.onAppleEaten?.();
            // Spawn a new apple to replace this one
            if (!isTutorialHungerStep()) spawnAppleOnBoard(apple.boardSx, apple.boardSy, 'player');
            SFX.play('apple', 0.35);
            try { if (typeof sendHostWorldSnapshot === 'function') sendHostWorldSnapshot(); } catch (_) { /* ignore */ }
        }
        
        // Player 2 (enemy) can eat ANY apple (rainbow apples are shared)
        if (p2 && !p2.isDead && sameBoardCoords(p2, apple) && p2.x === apple.x && p2.y === apple.y) {
            apple.eaten = true;
            apple.eatenTime = Date.now();
            // Reset hunger timer
            p2.hungerTimer = 0;
            p2.lastAppleEaten = Date.now();
            // Grow trail permanently for this round (capped at map size — same feel, bounded RAM)
            p2.growTrailBonus = Math.min(getMaxTrailPoints(), (p2.growTrailBonus || 0) + 1);
            // Spawn a new apple to replace this one
            spawnAppleOnBoard(apple.boardSx, apple.boardSy, 'player');
            SFX.play('apple', 0.35);
            try { if (typeof sendHostWorldSnapshot === 'function') sendHostWorldSnapshot(); } catch (_) { /* ignore */ }
        }
    }
}

function drawApple(apple, time) {
    const bobPhase = (time * 0.003 + apple.bobOffset) % (Math.PI * 2);
    const bobY = Math.sin(bobPhase) * (wantsFullThemeVisuals() ? 6 : 4);
    const bobEase = wantsFullThemeVisuals() ? Math.abs(Math.sin(bobPhase * 0.5)) * 3 : 0;
    const hue = ((time * 0.00015) + apple.bobOffset * 0.5) % 1;
    const rainbowColor = `hsl(${hue * 360}, 100%, 60%)`;

    if (!wantsFullThemeVisuals()) {
        // Same cube shape / rainbow, skip glow + multi-axis spin cost
        if (p1) {
            p1.drawCube(apple.x, apple.y, rainbowColor, false, null, 1.0, bobY, 0.7, 0);
        }
        return;
    }

    const timeOffset = apple.bobOffset * 1000;
    
    // Multi-axis rotation for more dynamic spin
    const rotY = Math.sin(time * 0.0015 + apple.bobOffset) * 0.3; // Gentle Y rotation
    const rotX = Math.cos(time * 0.002 + apple.bobOffset) * 0.15; // Subtle X tilt
    const rotZ = Math.sin(time * 0.001 + apple.bobOffset) * 0.1; // Very subtle Z spin
    
    // Pulsing glow effect
    const glowIntensity = 0.3 + Math.sin(time * 0.005 + apple.bobOffset) * 0.2;
    
    // Scale breathing effect
    const scaleBreath = 1 + Math.sin(time * 0.004 + apple.bobOffset) * 0.05;
    
    ctx.save();
    
    if (apple.eaten) {
        const eatenAge = time - apple.eatenTime;
        const progress = eatenAge / 500;
        ctx.globalAlpha = 1 - progress;
        ctx.translate(viewW / 2, viewH / 2);
        ctx.scale(1 + progress * 2, 1 + progress * 2);
        ctx.translate(-viewW / 2, -viewH / 2);
    }
    
    const scale = apple.scale * (APPLE_SIZE / GRID_SIZE) * 0.8 * scaleBreath;
    
    // Create glow effect behind apple
    const gx = apple.x * GRID_SIZE + GRID_SIZE / 2;
    const gy = apple.y * GRID_SIZE + GRID_SIZE / 2 + bobY + bobEase - GRID_SIZE / 2;
    
    if (!blinkBrowser && !isPerformanceMode()) {
        ctx.shadowColor = rainbowColor;
        ctx.shadowBlur = 15 * glowIntensity;
    } else {
        ctx.shadowBlur = 0;
    }
    
    // Apply combined rotations
    const combinedRotation = rotY; // Use Y rotation as main rotation
    
    if (p1) {
        p1.drawCube(apple.x, apple.y, rainbowColor, false, null, 1.0, bobY + bobEase, scale, combinedRotation);
    }
    
    ctx.restore();
}

function drawApples() {
    const time = Date.now();
    apples.forEach(apple => {
        if (apple.eaten) return;
        if (typeof isEntityVisibleFromView === 'function') {
            if (!isEntityVisibleFromView(apple)) return;
            const off = getBoardVisualOffset(apple.boardSx, apple.boardSy);
            if (!off.visible) return;
            withBoardWorldOffset(off.ox, off.oy, () => drawApple(apple, time));
        } else if (isOnViewBoard(apple)) {
            drawApple(apple, time);
        }
    });
}

// Ensure exactly one catalog theme class (never stack themes[0] on top of another)
(() => {
    const hasCatalogTheme = themes.some((t) => t && document.body.classList.contains(t));
    if (!hasCatalogTheme) applyBodyThemeClass(themes[0] || 'theme-ronk');
    else applyBodyThemeClass(themes.find((t) => document.body.classList.contains(t)) || themes[0]);
})();
let viewW = window.innerWidth;
let viewH = window.innerHeight;
let projCenterX = (GRID_COUNT * GRID_SIZE) / 2;
let projCenterY = projCenterX;
let projViewHalfW = viewW / 2;
let projViewHalfY = viewH / 2;
let resizeCanvasTimer = null;

const DEFAULT_RESOLUTION = '1080p';

function getResolutionScale(resolution) {
    return RESOLUTION_SCALES[resolution] ?? RESOLUTION_SCALES[DEFAULT_RESOLUTION];
}

function normalizeResolution(resolution) {
    if (forceLowGfxLaunch) return '480p';
    const key = resolution || getDefaultResolutionForDevice();
    if (key === '5k' || key === '8k') return '4k';
    if (!(key in RESOLUTION_SCALES)) return getDefaultResolutionForDevice();
    return key;
}

function applyCanvasQuality(context) {
    if (!context) return;
    // Keep smoothing on in low gfx so cubes don’t look broken at low res
    context.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in context) {
        const isPixel = typeof document !== 'undefined'
            && document.body.classList.contains('theme-pixel');
        // Blink/Electron: use 'high' when FPS budget is healthy (same look, sharper edges)
        const budgetOk = typeof getFrameBudgetTier === 'function' && getFrameBudgetTier() !== 'low';
        const wantHigh = wantsFullThemeVisuals() && !isPixel
            && (!blinkBrowser || (budgetOk && !isPerformanceMode()));
        context.imageSmoothingQuality = wantHigh ? 'high' : 'medium';
    }
}

/** Rolling frame budget — adaptive sharpness without changing theme art. */
const FRAME_BUDGET_SAMPLES = 45;
const _frameBudgetRing = new Float32Array(FRAME_BUDGET_SAMPLES);
let _frameBudgetIdx = 0;
let _frameBudgetFilled = 0;
let _frameBudgetTier = 'ok'; // 'low' | 'ok' | 'high'
let _frameBudgetLastApplyMs = 0;
let _frameBudgetTargetFps = 60;
/** Liquid WebGL adaptive params (read by liquid loop; look unchanged). */
let liquidAdaptiveDpr = 0.7;
let liquidAdaptiveFrameSkipInMatch = 1;

function estimateDisplayRefreshHz() {
    try {
        if (/Electron/i.test(navigator.userAgent || '')) return 120;
        if (typeof window !== 'undefined' && window.screen && window.screen.refreshRate > 0) {
            return Math.min(165, Math.max(60, window.screen.refreshRate));
        }
    } catch (_) { /* ignore */ }
    return 60;
}

function getFrameBudgetTier() {
    return _frameBudgetTier;
}

function syncGfxBoostClass() {
    try {
        const inGame = document.body.classList.contains('in-game');
        const full = typeof wantsFullThemeVisuals === 'function' && wantsFullThemeVisuals();
        // gfx-smooth: ok + high → fluid theme backdrops for ALL themes
        // gfx-boost: high only → slightly snappier motion + higher DPR headroom
        const smooth = inGame && full && _frameBudgetTier !== 'low';
        const boost = inGame && full && _frameBudgetTier === 'high';
        document.body.classList.toggle('gfx-smooth', !!smooth);
        document.body.classList.toggle('gfx-boost', !!boost);
    } catch (_) { /* ignore */ }
}

function syncLiquidBudgetParams() {
    const perf = typeof wantsFullThemeVisuals === 'function' && !wantsFullThemeVisuals();
    const tier = _frameBudgetTier;
    // BapBap marble needs higher buffer + near-every-frame draws or it feels laggy when upscaled
    let dpr = perf ? 0.35 : Math.min(0.85, window.devicePixelRatio || 1);
    try {
        if (/Electron/i.test(navigator.userAgent || '')) dpr = Math.min(dpr, 0.75);
        if (typeof blinkBrowser !== 'undefined' && blinkBrowser) dpr = Math.min(dpr, 0.75);
    } catch (_) { /* ignore */ }
    if (!perf && tier === 'high') {
        dpr = Math.min(0.85, window.devicePixelRatio || 1);
    } else if (!perf && tier === 'ok') {
        dpr = Math.min(Math.max(dpr, 0.65), 0.75);
    } else if (!perf && tier === 'low') {
        dpr = Math.min(dpr, 0.45);
    }
    liquidAdaptiveDpr = dpr;
    // 1 = every display frame (smooth). Only skip under low/perf.
    liquidAdaptiveFrameSkipInMatch = perf
        ? 6
        : (typeof isPerformanceMode === 'function' && isPerformanceMode()
            ? 8
            : (tier === 'low' ? 2 : 1));
}

function tickFrameBudget(deltaMs) {
    if (!(deltaMs > 0) || !(deltaMs < 100)) return;
    _frameBudgetRing[_frameBudgetIdx] = deltaMs;
    _frameBudgetIdx = (_frameBudgetIdx + 1) % FRAME_BUDGET_SAMPLES;
    if (_frameBudgetFilled < FRAME_BUDGET_SAMPLES) _frameBudgetFilled++;
    if (_frameBudgetFilled < 12) return;

    let sum = 0;
    for (let i = 0; i < _frameBudgetFilled; i++) sum += _frameBudgetRing[i];
    const avg = sum / _frameBudgetFilled;
    const fps = 1000 / Math.max(1, avg);
    const target = Math.min(120, estimateDisplayRefreshHz());
    _frameBudgetTargetFps = target;

    let next = _frameBudgetTier;
    if (_frameBudgetTier === 'high') {
        if (fps < target * 0.72) next = 'ok';
        if (fps < target * 0.55) next = 'low';
    } else if (_frameBudgetTier === 'ok') {
        if (fps >= target * 0.82) next = 'high';
        if (fps < target * 0.55) next = 'low';
    } else {
        if (fps >= target * 0.68) next = 'ok';
        if (fps >= target * 0.86) next = 'high';
    }

    if (next === _frameBudgetTier) return;
    const upgrading = (_frameBudgetTier === 'low' && next !== 'low')
        || (_frameBudgetTier === 'ok' && next === 'high');
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const debounceMs = upgrading ? 180 : 650;
    if (now - _frameBudgetLastApplyMs < debounceMs) return;
    _frameBudgetLastApplyMs = now;
    _frameBudgetTier = next;
    try {
        syncLiquidBudgetParams();
        syncGfxBoostClass();
        const prevDpr = effectiveDpr;
        if (typeof updateEffectiveDpr === 'function') updateEffectiveDpr();
        const dprChanged = Math.abs(effectiveDpr - prevDpr) > 0.025;
        if (dprChanged && typeof resizeCanvas === 'function') resizeCanvas();
        try { if (dprChanged) document.querySelector('.liquid-container canvas')?.__ronkResize?.(); } catch (_) { /* ignore */ }
        if (typeof applyCanvasQuality === 'function' && typeof ctx !== 'undefined') applyCanvasQuality(ctx);
    } catch (_) { /* ignore */ }
}

function updateEffectiveDpr() {
    const deviceDpr = window.devicePixelRatio || 1;
    const tier = typeof getFrameBudgetTier === 'function' ? getFrameBudgetTier() : 'ok';
    const isUltraScale = renderScale > 1.0 && renderScale < 1.7; // ultra = 1.35
    let maxEffective = 2.25;
    if (renderScale <= 0.5) maxEffective = 1.15;
    else if (renderScale <= 0.75) maxEffective = 1.55;
    else if (renderScale <= 1.0) maxEffective = 1.85;
    else if (isUltraScale) maxEffective = 2.0;
    else if (renderScale <= 1.85) maxEffective = 2.1;
    else maxEffective = 2.35;
    if (forceLowGfxLaunch) maxEffective = 1;
    try {
        const ua = navigator.userAgent || '';
        if (/Electron|Chrome|Chromium|Edg|CriOS|Firefox/i.test(ua)) {
            maxEffective = Math.min(maxEffective, isUltraScale || renderScale >= 1.85 ? 2.0 : 1.85);
        } else {
            maxEffective = Math.min(maxEffective, 2.1);
        }
    } catch (_) { /* ignore */ }
    // In-match: adaptive caps — raise when FPS has headroom, step down before hitching
    if (document.body.classList.contains('in-game')) {
        const isPixel = document.body.classList.contains('theme-pixel');
        let inGameCap;
        if (isPixel) {
            inGameCap = blinkBrowser
                ? (renderScale <= 0.75 ? 1.25 : 1.55)
                : (renderScale <= 0.75 ? 1.4 : 1.75);
        } else {
            inGameCap = blinkBrowser
                ? (renderScale <= 0.75 ? 1.15 : (isUltraScale ? 1.5 : 1.35))
                : (renderScale <= 0.75 ? 1.25 : (isUltraScale ? 1.7 : 1.55));
        }
        if (tier === 'high') {
            if (renderScale >= 1.85) inGameCap += 0.35;
            else if (isUltraScale) inGameCap += 0.25;
            else if (renderScale >= 1.0) inGameCap += 0.2;
            else inGameCap += 0.1;
        } else if (tier === 'low') {
            inGameCap -= 0.15;
        }
        // Ultra floor: elevated sharpness when not struggling
        if (isUltraScale && tier !== 'low') {
            inGameCap = Math.max(inGameCap, blinkBrowser ? 1.5 : 1.7);
        }
        if (renderScale >= 1.85 && tier === 'high') {
            inGameCap = Math.max(inGameCap, blinkBrowser ? 1.85 : 2.0);
        }
        maxEffective = Math.min(maxEffective, Math.max(0.85, inGameCap));
    }
    effectiveDpr = Math.max(0.5, Math.min(maxEffective, deviceDpr * renderScale));
}

function isPerformanceMode() {
    // Engine throttles only — does NOT gate theme looks (see wantsFullThemeVisuals)
    return forceLowGfxLaunch || ultraLowDevice || renderScale <= 0.5 || (trailerBatchHQ && trailerGameplayPerfActive);
}

/** Full theme FX unless the player explicitly chose Low / 480p / --ronk-low-gfx */
function wantsFullThemeVisuals() {
    return !(forceLowGfxLaunch || renderScale <= 0.5);
}

function shouldDisableLiquidBackground() {
    return forceLowGfxLaunch;
}

/** Keep HTML theme backdrops alive on menu, loadout, and in-match. */
function syncThemeBackdrop() {
    const themeClass = themes[currentThemeIndex];
    if (!themeClass) return;
    if (!themeBackgroundReady(themeClass)) {
        initThemeBackground(themeClass, { force: false });
    }
    const liquid = document.querySelector('.liquid-container');
    const isBapbap = themeClass === 'theme-white-black';
    liquid?.classList.toggle('liquid-active', isBapbap);
    if (isBapbap) {
        initLiquidBackground({ reuse: true });
        try {
            liquid?.querySelector('canvas')?.__ronkResize?.();
            liquid?.querySelector('canvas')?.__ronkLiquidRestart?.();
        } catch (_) { /* ignore */ }
    }
}

function notifyResolutionChange(resolution) {
    const key = normalizeResolution(resolution);
    const copy = {
        '480p': {
            titleKey: 'NOTIFY_RES_480_TITLE',
            title: '480p — Low (Performance)',
            bodyKey: 'NOTIFY_RES_480_BODY',
            body: 'Render scale drops to half. Performance mode turns on: cheaper effects, no fancy liquid wave, lighter GPU use. Gameplay rules stay the same — you just get more FPS on weak PCs.',
            hintKey: 'NOTIFY_RES_480_HINT',
            hint: 'Switch back anytime in Settings → Resolution',
            duration: 5200
        },
        '720p': {
            titleKey: 'NOTIFY_RES_720_TITLE',
            title: '720p — Balanced',
            bodyKey: 'NOTIFY_RES_720_BODY',
            body: 'Medium render scale. Good mix of sharpness and speed.',
            duration: 3200
        },
        '1080p': {
            titleKey: 'NOTIFY_RES_1080_TITLE',
            title: '1080p — Standard',
            bodyKey: 'NOTIFY_RES_1080_BODY',
            body: 'Full HD render scale. Auto-adaptive sharpness when FPS has headroom.',
            duration: 3200
        },
        'ultra': {
            titleKey: 'NOTIFY_RES_ULTRA_TITLE',
            title: 'Ultra — High sharpness',
            bodyKey: 'NOTIFY_RES_ULTRA_BODY',
            body: 'Higher internal buffer for strong PCs. Auto-adaptive still scales down if FPS drops.',
            duration: 3600
        },
        '2k': {
            titleKey: 'NOTIFY_RES_2K_TITLE',
            title: '2K — Sharp',
            bodyKey: 'NOTIFY_RES_2K_BODY',
            body: 'Higher internal resolution. Needs a stronger GPU.',
            duration: 3200
        },
        '4k': {
            titleKey: 'NOTIFY_RES_4K_TITLE',
            title: '4K — Ultra',
            bodyKey: 'NOTIFY_RES_4K_BODY',
            body: 'Maximum sharpness. Heavy on GPU and memory.',
            duration: 3200
        }
    };
    const msg = copy[key] || copy['1080p'];
    if (typeof enqueueGameNotification === 'function') {
        enqueueGameNotification({
            // No seenId — show every time they pick a resolution
            kickerKey: 'NOTIFY_RES_KICKER',
            kicker: 'Display',
            titleKey: msg.titleKey,
            title: msg.title,
            bodyKey: msg.bodyKey,
            body: msg.body,
            hintKey: msg.hintKey,
            hint: msg.hint || '',
            milestone: true,
            duration: msg.duration
        });
        return;
    }
    showAntiCheatToast(`${msg.title}: ${msg.body}`, false);
}

function applyResolution(resolution) {
    const key = normalizeResolution(resolution);
    renderScale = getResolutionScale(key);
    if (!forceLowGfxLaunch && key !== (resolution || localStorage.getItem('ronk_resolution'))) {
        localStorage.setItem('ronk_resolution', key);
    }
    document.body.classList.toggle('performance-mode', isPerformanceMode());
    // Cancel any debounced resize so the switch is instant
    if (resizeCanvasTimer) {
        clearTimeout(resizeCanvasTimer);
        resizeCanvasTimer = null;
    }
    try { syncLiquidBudgetParams(); } catch (_) { /* ignore */ }
    try { syncGfxBoostClass(); } catch (_) { /* ignore */ }
    updateEffectiveDpr();
    offscreenGrid = null;
    lastGridCacheKey = '';
    ronkScanlineCache = null;
    ronkScanlineCacheKey = '';
    resizeCanvas();
    document.querySelector('.liquid-container canvas')?.__ronkResize?.();
    // Force an immediate redraw if a match is on screen
    if (typeof draw === 'function' && gameState !== 'LOBBY' && ctx) {
        try { draw(); } catch (_) { /* ignore */ }
    }
}

let floorQuadCacheEpoch = '';
let floorQuadMain = null;
let floorQuadPeekBoards = new Map();
let pillarGeomCache = new Map();
let pillarGeomCacheEpoch = '';
let mainBoardGridCache = null;

function updateProjectConstants() {
    const boardDim = GRID_COUNT * GRID_SIZE;
    projCenterX = boardDim / 2;
    projCenterY = boardDim / 2;
    projViewHalfW = viewW / 2;
    // Center the isometric board in the viewport (was +70, which sat it too low)
    projViewHalfY = viewH / 2;
    floorQuadCacheEpoch = '';
    floorQuadMain = null;
    floorQuadPeekBoards = new Map();
    pillarGeomCacheEpoch = '';
    pillarGeomCache = new Map();
    mainBoardGridCache = null;
}

function resizeCanvas() {
    if (!canvas || !ctx) return;
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    updateProjectConstants();
    updateEffectiveDpr();
    const bufferW = Math.max(1, Math.round(viewW * effectiveDpr));
    const bufferH = Math.max(1, Math.round(viewH * effectiveDpr));
    // Reassigning canvas.width wipes the GPU buffer and hitchs a frame — skip when unchanged
    const sizeChanged = canvas.width !== bufferW || canvas.height !== bufferH;
    if (sizeChanged) {
        canvas.width = bufferW;
        canvas.height = bufferH;
        ronkScanlineCache = null;
        ronkScanlineCacheKey = '';
        neighborPeekCache = null;
    }
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(effectiveDpr, effectiveDpr);
    applyCanvasQuality(ctx);

    if (sizeChanged && gameState !== 'LOBBY') {
        prerenderGrid();
    }
}

function scheduleResizeCanvas() {
    if (resizeCanvasTimer) clearTimeout(resizeCanvasTimer);
    resizeCanvasTimer = setTimeout(() => {
        resizeCanvasTimer = null;
        resizeCanvas();
    }, 100);
}

function getCachedRgba(hex, opacity) {
    if (hex.startsWith('rgba')) return hex;
    const key = `${hex}_${opacity}`;
    if (colorCache.has(key)) return colorCache.get(key);
    let r = 0, g = 0, b = 0;
    if (hex.startsWith('#')) {
        if (hex.length === 4) { r = parseInt(hex[1] + hex[1], 16); g = parseInt(hex[2] + hex[2], 16); b = parseInt(hex[3] + hex[3], 16); }
        else if (hex.length === 7) { r = parseInt(hex.slice(1, 3), 16); g = parseInt(hex.slice(3, 5), 16); b = parseInt(hex.slice(5, 7), 16); }
    }
    const rgba = `rgba(${r}, ${g}, ${b}, ${opacity})`;
    colorCache.set(key, rgba);
    if (colorCache.size > 1024) {
        colorCache.clear();
        colorCache.set(key, rgba);
    }
    return rgba;
}

const FOV = 1000;
const CAM_Z = 4000;
const ANGLE_RAD = -42 * Math.PI / 180;
const CAM_TILT = Math.sin(ANGLE_RAD);
const CAM_COS_TILT = Math.cos(ANGLE_RAD);

/** Temporary world offset while drawing peek-neighbor entities (pixels). */
let projBoardOx = 0;
let projBoardOy = 0;

function withBoardWorldOffset(ox, oy, fn) {
    const prevX = projBoardOx;
    const prevY = projBoardOy;
    projBoardOx = ox || 0;
    projBoardOy = oy || 0;
    try {
        return fn();
    } finally {
        projBoardOx = prevX;
        projBoardOy = prevY;
    }
}

function project(x, y, z, out = null) {
    const px = x + projBoardOx;
    const py = y + projBoardOy;
    let ty = py * CAM_COS_TILT - z * CAM_TILT;
    let tz = py * CAM_TILT + z * CAM_COS_TILT;
    const scale = FOV / (FOV + CAM_Z + tz);
    const xOut = (px - projCenterX) * scale + projViewHalfW;
    const yOut = (ty - (projCenterY * CAM_COS_TILT)) * scale + projViewHalfY;
    // Never return a pooled object unless the caller passed `out` — holding a
    // pooled corner and then calling project() again mutates the outline (ghost X).
    if (out) {
        out.x = xOut;
        out.y = yOut;
        return out;
    }
    return { x: xOut, y: yOut };
}

function makeFloorQuad(ix, iy) {
    const q = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
    const x0 = ix * GRID_SIZE + 2;
    const y0 = iy * GRID_SIZE + 2;
    const x1 = ix * GRID_SIZE + GRID_SIZE - 2;
    const y1 = iy * GRID_SIZE + GRID_SIZE - 2;
    project(x0, y0, 0, q[0]);
    project(x1, y0, 0, q[1]);
    project(x1, y1, 0, q[2]);
    project(x0, y1, 0, q[3]);
    return q;
}

function ensureFloorQuadMain() {
    const epoch = `${viewW}|${viewH}|${GRID_COUNT}|${GRID_SIZE}`;
    if (floorQuadCacheEpoch !== epoch) {
        floorQuadCacheEpoch = epoch;
        floorQuadMain = null;
        floorQuadPeekBoards = new Map();
    }
    if (floorQuadMain) return;
    const prevX = projBoardOx;
    const prevY = projBoardOy;
    projBoardOx = 0;
    projBoardOy = 0;
    const n = GRID_COUNT * GRID_COUNT;
    floorQuadMain = new Array(n);
    for (let iy = 0; iy < GRID_COUNT; iy++) {
        for (let ix = 0; ix < GRID_COUNT; ix++) {
            floorQuadMain[iy * GRID_COUNT + ix] = makeFloorQuad(ix, iy);
        }
    }
    projBoardOx = prevX;
    projBoardOy = prevY;
}

/** Same pixels as four project() calls — reused for painted floor / trails. */
function getCachedFloorQuad(gx, gy) {
    const ix = gx | 0;
    const iy = gy | 0;
    if (ix < 0 || iy < 0 || ix >= GRID_COUNT || iy >= GRID_COUNT) return null;
    ensureFloorQuadMain();
    const idx = iy * GRID_COUNT + ix;
    if (projBoardOx === 0 && projBoardOy === 0) return floorQuadMain[idx];
    const bkey = projBoardOx + ',' + projBoardOy;
    let arr = floorQuadPeekBoards.get(bkey);
    if (!arr) {
        arr = new Array(GRID_COUNT * GRID_COUNT);
        floorQuadPeekBoards.set(bkey, arr);
    }
    let q = arr[idx];
    if (!q) {
        q = makeFloorQuad(ix, iy);
        arr[idx] = q;
    }
    return q;
}

function fillCachedFloorCells(ctxRef, cells, color, opacity) {
    if (!ctxRef || !cells || !cells.length) return;
    ctxRef.fillStyle = getCachedRgba(color, opacity);
    ctxRef.beginPath();
    for (let i = 0; i < cells.length; i++) {
        const q = getCachedFloorQuad(cells[i].x, cells[i].y);
        if (!q) continue;
        ctxRef.moveTo(q[0].x, q[0].y);
        ctxRef.lineTo(q[1].x, q[1].y);
        ctxRef.lineTo(q[2].x, q[2].y);
        ctxRef.lineTo(q[3].x, q[3].y);
        ctxRef.closePath();
    }
    ctxRef.fill();
}

function getCachedPillarGeom(cpX, cpY) {
    const epoch = `${viewW}|${viewH}|${GRID_SIZE}`;
    if (pillarGeomCacheEpoch !== epoch) {
        pillarGeomCacheEpoch = epoch;
        pillarGeomCache = new Map();
    }
    const key = `${projBoardOx}|${projBoardOy}|${cpX}|${cpY}`;
    let g = pillarGeomCache.get(key);
    if (g) return g;
    const cx = cpX * GRID_SIZE + GRID_SIZE / 2;
    const cy = cpY * GRID_SIZE + GRID_SIZE / 2;
    const z0 = -GRID_SIZE * 0.04;
    const bot = project(cx, cy, z0);
    const upSample = project(cx, cy, z0 - GRID_SIZE * 8);
    let vx = upSample.x - bot.x;
    let vy = upSample.y - bot.y;
    const mag = Math.hypot(vx, vy) || 1;
    vx /= mag;
    vy /= mag;
    const reach = Math.max(viewH || 1080, viewW || 1920) * 2.4;
    g = {
        botX: bot.x,
        botY: bot.y,
        topX: bot.x + vx * reach,
        topY: bot.y + vy * reach,
        px: -vy,
        py: vx
    };
    pillarGeomCache.set(key, g);
    return g;
}

let cachedThemeColorKey = '';
function updateThemeColors() {
    const themeKey = themes[currentThemeIndex];
    const inGame = document.body.classList.contains('in-game');
    const cacheKey = `${themeKey}|${inGame ? '1' : '0'}`;
    if (cacheKey === cachedThemeColorKey && themeColors.gridColor) return;
    cachedThemeColorKey = cacheKey;

    const style = getComputedStyle(document.body);

    // copoeric.com white-black — liquid shader behind transparent canvas
    if (themeKey === 'theme-white-black') {
        themeColors.canvasBg = 'transparent';
        themeColors.gridColor = style.getPropertyValue('--grid-color').trim() || 'rgba(196, 196, 196, 0.18)';
        themeColors.borderColor = style.getPropertyValue('--border-color').trim() || 'rgba(196, 196, 196, 0.42)';
        themeColors.boardFill = '';
        themeColors.neighborGridColor = 'rgba(160, 160, 160, 0.14)';
        themeColors.neighborFill = 'rgba(0, 0, 0, 0.35)';
        themeColors.neighborBorder = 'rgba(160, 160, 160, 0.28)';
    } else if (inGame && themeKey === 'theme-ronk') {
        // Mid-bright grid + dark-red plate (was neon-pink lines on empty void)
        themeColors.canvasBg = 'transparent';
        themeColors.gridColor = 'rgba(190, 55, 65, 0.48)';
        themeColors.borderColor = 'rgba(210, 70, 80, 0.72)';
        themeColors.boardFill = 'rgba(95, 18, 28, 0.52)';
        themeColors.neighborGridColor = 'rgba(150, 40, 50, 0.32)';
        themeColors.neighborFill = 'rgba(55, 10, 16, 0.55)';
        themeColors.neighborBorder = 'rgba(160, 45, 55, 0.4)';
    } else if (inGame && (themeKey === 'theme-pinkcore' || themeKey === 'theme-pixel' || themeKey === 'theme-hacker')) {
        themeColors.canvasBg = 'transparent';
        themeColors.gridColor = style.getPropertyValue('--grid-color').trim() || 'rgba(255, 255, 255, 0.3)';
        themeColors.borderColor = style.getPropertyValue('--border-color').trim() || 'rgba(255, 255, 255, 0.8)';
        themeColors.boardFill = '';
        themeColors.neighborGridColor = themeColors.gridColor;
        themeColors.neighborFill = 'rgba(0, 0, 0, 0.25)';
        themeColors.neighborBorder = themeColors.borderColor;
    } else {
        themeColors.canvasBg = style.getPropertyValue('--canvas-bg').trim() || 'rgba(0, 0, 0, 0.95)';
        themeColors.gridColor = style.getPropertyValue('--grid-color').trim() || 'rgba(255, 255, 255, 0.3)';
        themeColors.borderColor = style.getPropertyValue('--border-color').trim() || 'rgba(255, 255, 255, 0.8)';
        themeColors.boardFill = '';
        themeColors.neighborGridColor = themeColors.gridColor;
        themeColors.neighborFill = '';
        themeColors.neighborBorder = themeColors.borderColor;
    }
}
let themeColors = {
    canvasBg: '',
    gridColor: '',
    borderColor: '',
    boardFill: '',
    neighborGridColor: '',
    neighborFill: '',
    neighborBorder: ''
};

// --- THEME INITIALIZERS ---
function initRonkBackground() {
    const container = document.querySelector('.ronk-container');
    if (!container) return;
    // Never wipe a live Tron scene — rebuild flashes black for a frame (menu heal / sync)
    if (container.querySelector('.ronk-tron-scene')) return;

    container.innerHTML = '';

    const full = wantsFullThemeVisuals();
    const inGame = document.body.classList.contains('in-game');

    // Tron tunnel: floor + ceiling grids, slight roll (like the tilted stock shot)
    const scene = document.createElement('div');
    scene.className = 'ronk-tron-scene';
    scene.setAttribute('aria-hidden', 'true');

    const sky = document.createElement('div');
    sky.className = 'ronk-tron-sky';
    scene.appendChild(sky);

    const makePlane = (side) => {
        const wrap = document.createElement('div');
        wrap.className = `ronk-tron-plane-wrap is-${side}`;
        if (full) {
            const glow = document.createElement('div');
            glow.className = 'ronk-tron-plane-glow';
            wrap.appendChild(glow);
        }
        const plane = document.createElement('div');
        plane.className = 'ronk-tron-plane';
        wrap.appendChild(plane);
        return wrap;
    };

    scene.appendChild(makePlane('ceiling'));
    scene.appendChild(makePlane('floor'));

    const horizon = document.createElement('div');
    horizon.className = 'ronk-tron-horizon';
    scene.appendChild(horizon);

    container.appendChild(scene);

    // Sparse red embers — in-match only; menu keeps static Tron tunnel (no opacity cycling)
    if (full && !forceLowGfxLaunch && inGame) {
        const embers = document.createElement('div');
        embers.className = 'ronk-embers';
        embers.setAttribute('aria-hidden', 'true');
        const count = 10;
        for (let i = 0; i < count; i++) {
            const ember = document.createElement('span');
            ember.className = 'ronk-ember';
            const size = 1.6 + Math.random() * 1.8;
            ember.style.width = `${size}px`;
            ember.style.height = `${size}px`;
            ember.style.left = `${Math.random() * 100}%`;
            ember.style.bottom = `${-4 - Math.random() * 18}%`;
            ember.style.setProperty('--drift-x', `${(Math.random() - 0.5) * 48}px`);
            ember.style.animationDuration = `${10 + Math.random() * 14}s`;
            ember.style.animationDelay = `${-Math.random() * 14}s`;
            ember.style.opacity = String(0.35 + Math.random() * 0.35);
            embers.appendChild(ember);
        }
        container.appendChild(embers);
    }

    const vignette = document.createElement('div');
    vignette.className = 'ronk-vignette';
    vignette.setAttribute('aria-hidden', 'true');
    container.appendChild(vignette);

    // Keep scanlines in low gfx so Ronk still looks like Ronk (menus only via CSS)
    const scanlines = document.createElement('div');
    scanlines.className = 'ronk-scanlines';
    container.appendChild(scanlines);

    // Menu/loadout: no lightning/noise/hud/corners — stable Tron tunnel only (title flickers via h1 CSS)
}

const RONK_LIGHT_FLICKER = ['ronk-flicker-dim', 'ronk-flicker-half', 'ronk-flicker-wobble', 'ronk-flicker-bright'];
const RONK_HEAVY_FLICKER = ['ronk-flicker-out', 'ronk-flicker-dead'];
const RONK_FLICKER_CLASSES = [...RONK_LIGHT_FLICKER, ...RONK_HEAVY_FLICKER];
let ronkTitleFlickerTimer = null;
let ronkSparkTimer = null;
let ronkTitleFlickerActive = false;

function clearRonkTitleFlicker() {
    ronkTitleFlickerActive = false;
    if (ronkTitleFlickerTimer) {
        clearTimeout(ronkTitleFlickerTimer);
        ronkTitleFlickerTimer = null;
    }
    if (ronkSparkTimer) {
        clearTimeout(ronkSparkTimer);
        ronkSparkTimer = null;
    }
    const title = document.querySelector('#menu h1');
    if (!title) return;
    RONK_FLICKER_CLASSES.forEach(c => title.classList.remove(c));
    title.classList.remove('ronk-glitch-slice');
    const burst = title.querySelector('.ronk-spark-burst');
    if (burst) burst.replaceChildren();
}

function ensureRonkSparkBurst(title) {
    let burst = title.querySelector('.ronk-spark-burst');
    if (!burst) {
        burst = document.createElement('span');
        burst.className = 'ronk-spark-burst';
        burst.setAttribute('aria-hidden', 'true');
        title.appendChild(burst);
    }
    return burst;
}

function spawnRonkSpark(burst, titleWidth, titleHeight, sideBias) {
    const isWide = Math.random() > 0.72;
    const isFork = Math.random() < 0.28;
    const spark = document.createElement('span');
    spark.className = 'ronk-spark';
    if (isWide) spark.classList.add('ronk-spark-wide');
    if (isFork) spark.classList.add('ronk-spark-fork');

    const sideRoll = sideBias != null ? sideBias : Math.random();
    let spawnX;
    let spawnY;
    let vx;

    if (sideRoll < 0.5) {
        spawnX = -titleWidth * (0.42 + Math.random() * 0.08);
        spawnY = (Math.random() - 0.5) * titleHeight * 0.72;
        vx = -(35 + Math.random() * 85);
    } else {
        spawnX = titleWidth * (0.42 + Math.random() * 0.08);
        spawnY = (Math.random() - 0.5) * titleHeight * 0.72;
        vx = 35 + Math.random() * 85;
    }

    const gravity = 320 + Math.random() * 120;
    const vy0 = -20 + Math.random() * 45;
    const dur = 0.5 + Math.random() * 0.45;
    const endX = vx * dur * 0.9;
    const endY = vy0 * dur + 0.5 * gravity * dur * dur;
    const vyEnd = vy0 + gravity * dur;
    const tilt = Math.atan2(vyEnd, vx) * (180 / Math.PI) + 90;
    const len = isWide ? 2 + Math.random() * 4 : 5 + Math.random() * 16;
    const opacity = 0.28 + Math.random() * 0.28;

    spark.style.left = spawnX + 'px';
    spark.style.top = spawnY + 'px';
    spark.style.setProperty('--spark-vx-end', endX + 'px');
    spark.style.setProperty('--spark-vy-end', endY + 'px');
    spark.style.setProperty('--spark-tilt', tilt + 'deg');
    spark.style.setProperty('--spark-len', len + 'px');
    spark.style.setProperty('--spark-dur', dur + 's');
    spark.style.setProperty('--spark-delay', (Math.random() * 0.08) + 's');
    spark.style.setProperty('--spark-opacity', opacity.toFixed(2));
    burst.appendChild(spark);
}

function triggerRonkElectricBurst(title, sideOnly = false) {
    const burst = ensureRonkSparkBurst(title);
    burst.replaceChildren();
    const w = title.offsetWidth || 320;
    const h = title.offsetHeight || 72;
    const count = wantsFullThemeVisuals() ? (sideOnly ? 10 : 14) : 6;
    for (let i = 0; i < count; i++) {
        const bias = sideOnly ? Math.random() * 0.76 : null;
        spawnRonkSpark(burst, w, h, bias);
    }
    setTimeout(() => burst.replaceChildren(), 1100);
}

function triggerRonkGlitchSlice(title) {
    title.classList.remove('ronk-glitch-slice');
    void title.offsetWidth;
    title.classList.add('ronk-glitch-slice');
    setTimeout(() => title.classList.remove('ronk-glitch-slice'), 130);
}

function scheduleRonkSparks(title) {
    if (!ronkTitleFlickerActive) return;
    ronkSparkTimer = setTimeout(() => {
        if (!ronkTitleFlickerActive) return;
        const roll = Math.random();
        // Rare sparks — was ~every 0.7–1.8s with high chance
        if (roll < 0.14) {
            triggerRonkElectricBurst(title, true);
        } else if (roll < 0.22) {
            triggerRonkElectricBurst(title, false);
        }
        scheduleRonkSparks(title);
    }, 3200 + Math.random() * 4800);
}

function scheduleRonkTitleFlicker(title) {
    if (!ronkTitleFlickerActive) return;
    // Quieter title: longer gaps, fewer heavy kills
    const delay = 5200 + Math.random() * 7000;
    ronkTitleFlickerTimer = setTimeout(() => {
        if (!ronkTitleFlickerActive) return;
        RONK_FLICKER_CLASSES.forEach(c => title.classList.remove(c));
        const roll = Math.random();
        if (roll < 0.28) {
            const cls = RONK_LIGHT_FLICKER[Math.floor(Math.random() * RONK_LIGHT_FLICKER.length)];
            title.classList.add(cls);
            if (Math.random() < 0.25) triggerRonkGlitchSlice(title);
            setTimeout(() => title.classList.remove(cls), 70 + Math.random() * 80);
        } else if (roll < 0.36) {
            const cls = RONK_HEAVY_FLICKER[Math.floor(Math.random() * RONK_HEAVY_FLICKER.length)];
            title.classList.add(cls);
            triggerRonkGlitchSlice(title);
            triggerRonkElectricBurst(title);
            setTimeout(() => title.classList.remove(cls), 55 + Math.random() * 60);
        } else if (roll < 0.44) {
            title.classList.add('ronk-flicker-out');
            setTimeout(() => {
                title.classList.remove('ronk-flicker-out');
                title.classList.add('ronk-flicker-bright');
                setTimeout(() => title.classList.remove('ronk-flicker-bright'), 50);
            }, 45);
        }
        scheduleRonkTitleFlicker(title);
    }, delay);
}

function initRonkTitleFlicker() {
    clearRonkTitleFlicker();
    if (!wantsFullThemeVisuals()) return;
    const title = document.querySelector('#menu h1');
    if (!title) return;
    ensureRonkSparkBurst(title);
    ronkTitleFlickerActive = true;
    // Title flicker = CSS ronk-flicker-main only; JS adds sparks, not extra bg-style flashes
    scheduleRonkSparks(title);
}

function initClouds() {
    const container = document.querySelector('.clouds-container');
    if (!container) return;
    container.innerHTML = '';
    if (!wantsFullThemeVisuals() && forceLowGfxLaunch) return;
    const isPinkcore = document.body.classList.contains('theme-pinkcore');
    const cloudCount = wantsFullThemeVisuals() ? 8 : 4;
    // Min Euclidean distance in left/top % space so BG puffs don't spawn stacked.
    // CSS cloud-drift loops back to these same anchors — no separate JS respawn.
    const MIN_CLOUD_SEP = isPinkcore ? 22 : 18;
    const placed = [];

    function pickSeparatedCloudPos(leftMin, leftSpan, topSpan) {
        let best = null;
        let bestMinDist = -1;
        for (let attempt = 0; attempt < 48; attempt++) {
            const left = Math.random() * leftSpan + leftMin;
            const top = Math.random() * topSpan;
            let minDist = Infinity;
            for (const p of placed) {
                const dx = left - p.left;
                const dy = top - p.top;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < minDist) minDist = d;
            }
            if (placed.length === 0 || minDist >= MIN_CLOUD_SEP) {
                const pos = { left, top };
                placed.push(pos);
                return pos;
            }
            if (minDist > bestMinDist) {
                bestMinDist = minDist;
                best = { left, top };
            }
        }
        // Fallback: nudge farthest candidate away from its nearest neighbor
        const pos = best || {
            left: Math.random() * leftSpan + leftMin,
            top: Math.random() * topSpan
        };
        if (placed.length) {
            let nearest = placed[0];
            let minDist = Infinity;
            for (const p of placed) {
                const dx = pos.left - p.left;
                const dy = pos.top - p.top;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < minDist) {
                    minDist = d;
                    nearest = p;
                }
            }
            if (minDist > 0 && minDist < MIN_CLOUD_SEP) {
                const dx = pos.left - nearest.left;
                const dy = pos.top - nearest.top;
                const scale = MIN_CLOUD_SEP / minDist;
                pos.left = nearest.left + dx * scale;
                pos.top = nearest.top + dy * scale;
            } else if (minDist === 0) {
                pos.left += MIN_CLOUD_SEP;
                pos.top += MIN_CLOUD_SEP * 0.4;
            }
            pos.left = Math.max(leftMin, Math.min(leftMin + leftSpan, pos.left));
            pos.top = Math.max(0, Math.min(topSpan, pos.top));
        }
        placed.push(pos);
        return pos;
    }

    for (let i = 0; i < cloudCount; i++) {
        const cloud = document.createElement('div');
        cloud.className = 'cloud';
        if (isPinkcore) {
            // Soft PNG family puffs — varied size / phase / tint (not identical clones)
            // ~×1.10 from prior ~73–220px range → ~80–242px
            const size = Math.random() * 162 + 80;
            const pos = pickSeparatedCloudPos(-30, 150, 88);
            cloud.style.width = size + 'px';
            cloud.style.height = (size * (0.36 + Math.random() * 0.1)) + 'px';
            cloud.style.top = pos.top + '%';
            cloud.style.left = pos.left + '%';
            cloud.style.animationDuration = (Math.random() * 55 + 40) + 's';
            cloud.style.animationDelay = (Math.random() * -120) + 's';
            const hue = Math.round(Math.random() * 22 - 11);
            const bright = (0.94 + Math.random() * 0.14).toFixed(2);
            const opac = (0.38 + Math.random() * 0.28).toFixed(2);
            cloud.style.filter = `drop-shadow(0 10px 18px rgba(200, 70, 130, 0.12)) hue-rotate(${hue}deg) brightness(${bright})`;
            cloud.style.opacity = opac;
        } else {
            const size = Math.random() * 250 + 150;
            const pos = pickSeparatedCloudPos(-20, 140, 100);
            cloud.style.width = size + 'px';
            cloud.style.height = (size * 0.5) + 'px';
            cloud.style.top = pos.top + '%';
            cloud.style.left = pos.left + '%';
            cloud.style.animationDuration = (Math.random() * 40 + 30) + 's';
            cloud.style.animationDelay = (Math.random() * -100) + 's';
        }
        container.appendChild(cloud);
    }
}

function initMatrix() {
    const container = document.querySelector('.matrix-container');
    const codeLayer = document.querySelector('.matrix-code-layer');
    if (!container) return;
    if (!wantsFullThemeVisuals() && forceLowGfxLaunch) {
        // Keep a solid CRT plate so low-gfx matches aren't an empty black void
        container.innerHTML = '';
        if (codeLayer) codeLayer.innerHTML = '';
        const fb = document.createElement('div');
        fb.className = 'matrix-fallback';
        fb.setAttribute('aria-hidden', 'true');
        fb.style.cssText = 'position:absolute;inset:0;background:#020904;pointer-events:none;';
        container.appendChild(fb);
        return;
    }
    container.innerHTML = '';
    if (codeLayer) codeLayer.innerHTML = '';

    const codeSnippets = [
        'const x = 10101;',
        'if (hack) { win(); }',
        'system.override();',
        'root@ronk:~$',
        '01001011 0101',
        'while(true) { push(); }',
        'ERROR: ACCESS DENIED',
        'CONNECTING...',
        'DECRYPTING...',
        'p1.charge();',
        'canvas.draw();',
        'peer.connect(id);'
    ];

    const lineCount = wantsFullThemeVisuals() ? 10 : 4;
    for (let i = 0; i < lineCount; i++) {
        const line = document.createElement('div');
        line.className = 'matrix-line';
        line.textContent = codeSnippets[Math.floor(Math.random() * codeSnippets.length)];
        const duration = Math.random() * 15 + 15;
        line.style.left = Math.random() * 100 + '%';
        line.style.animationDuration = duration + 's';
        line.style.animationDelay = (Math.random() * -30) + 's';
        line.style.fontSize = (Math.random() * 0.4 + 0.7) + 'rem';
        line.style.opacity = Math.random() * 0.35 + 0.35;
        container.appendChild(line);
    }
}

let pixelFlappyRaf = null;
let pixelFlappyBirdEl = null;
let pixelFlappyRestart = null;

function stopPixelFlappyBird() {
    if (pixelFlappyRaf != null) {
        cancelAnimationFrame(pixelFlappyRaf);
        pixelFlappyRaf = null;
    }
    pixelFlappyBirdEl = null;
    pixelFlappyRestart = null;
}

/** Resume Flappy RAF if pipes/bird exist but the loop died (tab hide / race). */
function ensurePixelFlappyRunning() {
    if (!document.body.classList.contains('theme-pixel')) return;
    const container = document.querySelector('.pixel-bg-container');
    if (!container) return;
    const bird = container.querySelector('.pixel-flappy-bird');
    const hasPipe = !!container.querySelector('.pixel-pipe');
    if (!hasPipe || !bird) {
        initPixelBg();
        return;
    }
    pixelFlappyBirdEl = bird;
    if (pixelFlappyRaf == null && typeof pixelFlappyRestart === 'function') {
        pixelFlappyRestart();
    } else if (pixelFlappyRaf == null) {
        // Restart callback lost (hot reload / partial wipe) — full rebuild
        initPixelBg();
    }
}

function initPixelBg() {
    stopPixelFlappyBird();
    const container = document.querySelector('.pixel-bg-container');
    if (!container) return;
    container.innerHTML = '';
    // Always keep a sky plate under decor so a failed rebuild can't black-screen
    const sky = document.createElement('div');
    sky.className = 'pixel-fallback';
    sky.setAttribute('aria-hidden', 'true');
    sky.style.cssText = 'position:absolute;inset:0;background:#70c5ce;pointer-events:none;z-index:0;';
    container.appendChild(sky);
    const cloudPositions = [8, 12, 18, 22, 26, 30];
    const cloudCount = wantsFullThemeVisuals() ? 6 : 3;
    for (let i = 0; i < cloudCount; i++) {
        const cloud = document.createElement('div');
        cloud.className = 'pixel-cloud';
        cloud.style.top = cloudPositions[i] + '%';
        cloud.style.left = (i * 18 - 5) + '%';
        cloud.style.animationDuration = '35s';
        cloud.style.animationDelay = (i * -6) + 's';
        cloud.style.zIndex = '1';
        container.appendChild(cloud);
    }

    // Pipes are JS-scrolled (not CSS pixelScroll). CSS left% + translateX animation
    // clustered tubes and left empty stretches that looked like random vanishing.
    const GAP_CYCLE = [28, 36, 42, 32, 38, 34];
    const PIPE_W = 80;
    const PIPE_LIP = 10;
    const pipeCount = wantsFullThemeVisuals() ? 4 : 3;
    const pipePairs = [];
    for (let i = 0; i < pipeCount; i++) {
        const gapPos = GAP_CYCLE[i % GAP_CYCLE.length];
        const topPipe = document.createElement('div');
        topPipe.className = 'pixel-pipe top';
        topPipe.style.height = gapPos + '%';
        topPipe.style.zIndex = '1';
        const botPipe = document.createElement('div');
        botPipe.className = 'pixel-pipe bottom';
        botPipe.style.height = (85 - gapPos) + '%';
        botPipe.style.zIndex = '1';
        container.appendChild(topPipe);
        container.appendChild(botPipe);
        pipePairs.push({ top: topPipe, bot: botPipe, gapPos: gapPos, x: 0 });
    }

    // Flawless Flappy Bird — gravity + flap arcs, always clears gaps
    const bird = document.createElement('div');
    bird.className = 'pixel-flappy-bird';
    bird.setAttribute('aria-hidden', 'true');
    bird.innerHTML =
        '<span class="pixel-flappy-beak"></span>' +
        '<span class="pixel-flappy-body"></span>' +
        '<span class="pixel-flappy-wing"></span>' +
        '<span class="pixel-flappy-eye"></span>';
    bird.style.zIndex = '2';
    container.appendChild(bird);
    pixelFlappyBirdEl = bird;

    const BIRD_X_FRAC = 0.22;
    const BIRD_H = 24;
    const BIRD_W = 36;
    const GRAVITY = 2100;
    const FLAP_VY = -520;
    const MAX_FALL = 780;
    const GAP_PAD = 10;
    const initVw = typeof window !== 'undefined' ? window.innerWidth || 800 : 800;
    const initVh = typeof window !== 'undefined' ? window.innerHeight || 600 : 600;
    let birdY = initVh * 0.42;
    let birdVy = 0;
    let lastTs = 0;
    let gapCycleIdx = pipeCount;
    let pipesReady = false;

    function applyGap(pair, gapPos) {
        pair.gapPos = gapPos;
        pair.top.style.height = gapPos + '%';
        pair.bot.style.height = (85 - gapPos) + '%';
    }

    function applyPipeX(pair) {
        const xPx = Math.round(pair.x);
        pair.top.style.transform = 'translate3d(' + xPx + 'px,0,0)';
        pair.bot.style.transform = 'translate3d(' + xPx + 'px,0,0)';
    }

    function layoutPipes(vw) {
        const spacing = Math.max(260, Math.min(420, vw * 0.34));
        const start = vw * 0.55;
        for (let i = 0; i < pipePairs.length; i++) {
            pipePairs[i].x = start + i * spacing;
            applyGap(pipePairs[i], GAP_CYCLE[i % GAP_CYCLE.length]);
            applyPipeX(pipePairs[i]);
        }
        pipesReady = true;
        return spacing;
    }

    function placeBird() {
        const birdX = initVw * BIRD_X_FRAC;
        bird.style.transform =
            'translate3d(' + Math.round(birdX) + 'px,' +
            Math.round(birdY - BIRD_H * 0.5) + 'px,0) rotate(0deg)';
    }

    let pipeSpacing = layoutPipes(initVw);
    placeBird();

    function tick(ts) {
        if (!pixelFlappyBirdEl || pixelFlappyBirdEl !== bird || !bird.isConnected) {
            pixelFlappyRaf = null;
            return;
        }
        if (!document.body.classList.contains('theme-pixel')) {
            stopPixelFlappyBird();
            return;
        }

        // Pause while tab hidden — keep handle so ensurePixelFlappyRunning can resume
        if (document.hidden) {
            pixelFlappyRaf = null;
            lastTs = 0;
            return;
        }

        const vw = window.innerWidth || 1;
        const vh = window.innerHeight || 1;
        const birdX = vw * BIRD_X_FRAC;
        const birdLeft = birdX;
        const birdRight = birdX + BIRD_W;
        // Cap decorative Flappy bg to ~30 FPS
        if (lastTs && (ts - lastTs) < 32) {
            pixelFlappyRaf = requestAnimationFrame(tick);
            return;
        }
        const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
        lastTs = ts;

        const nextSpacing = Math.max(260, Math.min(420, vw * 0.34));
        if (!pipesReady || Math.abs(nextSpacing - pipeSpacing) > 40) {
            pipeSpacing = layoutPipes(vw);
        } else {
            pipeSpacing = nextSpacing;
        }

        // Scroll pipes left; wrap off-screen tubes back to the right (no CSS teleport gaps)
        const scrollSpeed = Math.max(110, Math.min(200, vw * 0.12));
        for (let i = 0; i < pipePairs.length; i++) {
            const pair = pipePairs[i];
            pair.x -= scrollSpeed * dt;
            if (pair.x < -PIPE_W - PIPE_LIP - 24) {
                let maxX = -Infinity;
                for (let j = 0; j < pipePairs.length; j++) {
                    if (pipePairs[j].x > maxX) maxX = pipePairs[j].x;
                }
                pair.x = maxX + pipeSpacing;
                applyGap(pair, GAP_CYCLE[gapCycleIdx % GAP_CYCLE.length]);
                gapCycleIdx++;
            }
            applyPipeX(pair);
        }

        // Aim at next live gap (scripted % if pipes are display:none in perf mode)
        let aimY = vh * 0.42;
        let gapTop = 0;
        let gapBot = vh;
        let overlapping = false;
        let found = false;
        let bestLeft = Infinity;

        for (let i = 0; i < pipePairs.length; i++) {
            const pair = pipePairs[i];
            if (!pair.top.isConnected || !pair.bot.isConnected) continue;
            const left = pair.x - PIPE_LIP;
            const right = pair.x + PIPE_W + PIPE_LIP;
            if (right < birdLeft - 8) continue;

            const topH = (pair.gapPos / 100) * vh;
            const botH = ((85 - pair.gapPos) / 100) * vh;
            const gTop = topH;
            const gBot = vh - botH;
            const gapCenter = (gTop + gBot) * 0.5;

            if (birdRight >= left && birdLeft <= right) {
                aimY = gapCenter;
                gapTop = gTop;
                gapBot = gBot;
                overlapping = true;
                found = true;
                break;
            }
            if (left < bestLeft) {
                bestLeft = left;
                aimY = gapCenter;
                gapTop = gTop;
                gapBot = gBot;
                found = true;
            }
        }

        if (!found) {
            aimY = vh * (0.40 + 0.035 * Math.sin(ts * 0.002));
            gapTop = vh * 0.2;
            gapBot = vh * 0.75;
        }

        // Approach slightly above gap center when far — creates room for flap arcs
        const dist = found && Number.isFinite(bestLeft) && !overlapping
            ? Math.max(0, bestLeft - birdRight)
            : (overlapping ? 0 : 400);
        const lead = Math.min(1, dist / 380);
        aimY -= 22 * lead;

        // Gravity + flap impulses (not lerp tracking)
        birdVy = Math.min(MAX_FALL, birdVy + GRAVITY * dt);
        birdY += birdVy * dt;

        const flapLine = aimY + 6;
        if (birdY > flapLine && birdVy > FLAP_VY * 0.35) {
            birdVy = FLAP_VY;
        }

        // Soft ceiling/floor so it never flies off-screen between tubes
        const minHover = vh * 0.12;
        const maxHover = vh * 0.82;
        if (birdY < minHover) {
            birdY = minHover;
            if (birdVy < 0) birdVy = 0;
        }
        if (birdY > maxHover) {
            birdY = maxHover;
            birdVy = FLAP_VY;
        }

        // Hard safety while inside a pipe column — never clip tubes
        if (overlapping || (found && dist < 40)) {
            const minY = gapTop + BIRD_H * 0.5 + GAP_PAD;
            const maxY = gapBot - BIRD_H * 0.5 - GAP_PAD;
            if (maxY > minY) {
                if (birdY < minY) {
                    birdY = minY;
                    if (birdVy < 0) birdVy *= 0.2;
                }
                if (birdY > maxY) {
                    birdY = maxY;
                    birdVy = FLAP_VY;
                }
            }
        }

        const angle = Math.max(-32, Math.min(48, birdVy * 0.055));

        bird.style.transform =
            'translate3d(' + Math.round(birdX) + 'px,' +
            Math.round(birdY - BIRD_H * 0.5) + 'px,0) rotate(' +
            angle.toFixed(1) + 'deg)';

        pixelFlappyRaf = requestAnimationFrame(tick);
    }

    pixelFlappyRestart = () => {
        if (pixelFlappyRaf != null) return;
        if (!bird.isConnected) return;
        lastTs = 0;
        pixelFlappyRaf = requestAnimationFrame(tick);
    };

    pixelFlappyRaf = requestAnimationFrame(tick);
}

let liquidBgCleanup = null;

function destroyLiquidBackground() {
    if (typeof liquidBgCleanup === 'function') {
        try { liquidBgCleanup(); } catch (_) { /* ignore */ }
        liquidBgCleanup = null;
    }
    const container = document.querySelector('.liquid-container');
    if (container) {
        container.innerHTML = '';
        container.style.background = '';
    }
}

function initLiquidBackground(opts = {}) {
    const reuse = !!opts.reuse;
    // Reuse existing WebGL context across match start / theme re-init — same look, no recreate churn
    if (reuse && liquidBgCleanup && document.querySelector('.liquid-container canvas')) {
        const liveCanvas = document.querySelector('.liquid-container canvas');
        try {
            syncLiquidBudgetParams();
            liveCanvas?.__ronkResize?.();
            liveCanvas?.__ronkLiquidRestart?.();
        } catch (_) { /* ignore */ }
        return;
    }
    destroyLiquidBackground();
    const container = document.querySelector('.liquid-container');
    if (!container) return;
    container.innerHTML = '';
    container.style.background = '';

    // Ultra-low / forced low-gfx: skip WebGL wave (big GPU/RAM saver). Normal play keeps the marble effect.
    if (shouldDisableLiquidBackground()) {
        container.style.background = 'linear-gradient(180deg, #05040a 0%, #120f1a 100%)';
        return;
    }

    const perf = !wantsFullThemeVisuals();
    // Keep the wave — cheaper on Electron / low gfx so themes stay rendered without melting FPS
    try { syncLiquidBudgetParams(); } catch (_) { /* ignore */ }
    let liquidDpr = liquidAdaptiveDpr;
    if (!(liquidDpr > 0)) {
        liquidDpr = perf
            ? 0.35
            : Math.min(0.75, window.devicePixelRatio || 1);
        try {
            if (/Electron/i.test(navigator.userAgent || '')) {
                liquidDpr = Math.min(liquidDpr, 0.45);
            }
            if (blinkBrowser) {
                liquidDpr = Math.min(liquidDpr, 0.45);
            }
        } catch (_) { /* ignore */ }
    }
    const LIQUID_TIME_SCALE = 0.38; // slower drift — spatial wave pattern unchanged
    const LIQUID_FRAME_SKIP = perf ? 2 : 1; // menus: every frame when full graphics

    const canvas = document.createElement('canvas');
    canvas.style.transform = 'translateZ(0)';
    canvas.style.imageRendering = 'auto';
    container.appendChild(canvas);

    const budgetOk = typeof getFrameBudgetTier === 'function' && getFrameBudgetTier() !== 'low';
    const powerPref = (!perf && budgetOk) ? 'high-performance' : 'low-power';
    const gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        powerPreference: powerPref,
        preserveDrawingBuffer: false,
        desynchronized: true
    }) || canvas.getContext('experimental-webgl');
    if (!gl) {
        console.error('WebGL not supported, falling back to basic background');
        container.style.background = '#05040a';
        return;
    }
    gl.clearColor(0.02, 0.016, 0.04, 1.0);

    let width, height;
    let alive = true;
    function resize() {
        if (!alive) return;
        const dpr = (liquidAdaptiveDpr > 0) ? liquidAdaptiveDpr : liquidDpr;
        width = canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
        height = canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
        canvas.style.width = window.innerWidth + 'px';
        canvas.style.height = window.innerHeight + 'px';
        gl.viewport(0, 0, width, height);
    }
    canvas.__ronkResize = resize;
    window.addEventListener('resize', resize);
    resize();

    const vsSource = `
        attribute vec2 position;
        void main() {
            gl_Position = vec4(position, 0.0, 1.0);
        }
    `;

    const fsSource = `
        precision mediump float;
        uniform vec2 resolution;
        uniform float time;

        float random(in vec2 st) {
            return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
        }

        float noise(in vec2 st) {
            vec2 i = floor(st);
            vec2 f = fract(st);
            float a = random(i);
            float b = random(i + vec2(1.0, 0.0));
            float c = random(i + vec2(0.0, 1.0));
            float d = random(i + vec2(1.0, 1.0));
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        float fbm(in vec2 st) {
            float value = 0.0;
            float amplitude = 0.5;
            for (int i = 0; i < ${perf ? 3 : 4}; i++) {
                value += amplitude * noise(st);
                st *= 2.0;
                amplitude *= 0.5;
            }
            return value;
        }

        void main() {
            vec2 uv = gl_FragCoord.xy / resolution.xy;
            uv.x *= resolution.x / resolution.y;

            vec2 q = vec2(0.0);
            q.x = fbm(uv * 1.5 + 0.05 * time);
            q.y = fbm(uv * 1.5 + vec2(1.0));

            vec2 r = vec2(0.0);
            r.x = fbm(uv * 2.0 + 1.0 * q + vec2(1.7, 9.2) + 0.15 * time);
            r.y = fbm(uv * 2.0 + 1.0 * q + vec2(8.3, 2.8) + 0.126 * time);

            float f = fbm(uv * 2.0 + r * 2.0);

            // copoeric.com marble — no time in brightness (stops global flicker)
            float colorVal = sin(f * 15.0) * 0.5 + 0.5;
            colorVal = smoothstep(0.2, 0.8, colorVal);

            vec3 darkGray = vec3(0.04, 0.03, 0.08);
            vec3 lightGray = vec3(0.12, 0.08, 0.20);
            vec3 color = mix(darkGray, lightGray, colorVal);

            float highlight = smoothstep(0.88, 1.0, colorVal);
            color += highlight * vec3(0.04, 0.03, 0.05);

            vec2 center = vec2(0.5 * resolution.x / resolution.y, 0.5);
            float dist = length(uv - center);
            color *= 1.0 - smoothstep(0.45, 1.15, dist) * 0.55;

            gl_FragColor = vec4(color, 1.0);
        }
    `;

    function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compile failed:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    const vertexShader = compileShader(gl.VERTEX_SHADER, vsSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vertexShader || !fragmentShader) {
        container.style.background = '#05040a';
        return;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.useProgram(program);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
        -1.0,  1.0,
        -1.0,  1.0,
         1.0, -1.0,
         1.0,  1.0
    ]), gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const resolutionLocation = gl.getUniformLocation(program, 'resolution');
    const timeLocation = gl.getUniformLocation(program, 'time');

    let startTime = performance.now();
    let liquidFrame = 0;
    let liquidRaf = 0;
    let liquidWaitTimer = 0;
    const clearLiquidWait = () => {
        if (liquidWaitTimer) {
            clearTimeout(liquidWaitTimer);
            liquidWaitTimer = 0;
        }
    };
    function animate() {
        if (!alive) return;
        if (document.hidden) {
            liquidRaf = 0;
            clearLiquidWait();
            return;
        }
        if (!document.body.classList.contains('theme-white-black')) {
            liquidRaf = 0;
            clearLiquidWait();
            return;
        }
        if (isPaused && document.body.classList.contains('in-game')) {
            // Pause: keep last frame, poll slowly instead of every display frame
            liquidRaf = 0;
            clearLiquidWait();
            liquidWaitTimer = setTimeout(() => {
                liquidWaitTimer = 0;
                if (!alive) return;
                liquidRaf = requestAnimationFrame(animate);
            }, 200);
            return;
        }

        liquidFrame++;
        const inMatch = document.body.classList.contains('in-game');
        // Prefer every-display-frame draws — setTimeout wakes made the marble feel laggy
        const frameSkip = inMatch
            ? Math.max(1, liquidAdaptiveFrameSkipInMatch || (isPerformanceMode() ? 4 : (perf ? 3 : 1)))
            : LIQUID_FRAME_SKIP;
        const shouldDraw = (liquidFrame % frameSkip) === 0;

        if (shouldDraw) {
            const currentTime = performance.now();
            const time = ((currentTime - startTime) / 1000.0) * LIQUID_TIME_SCALE;
            gl.uniform2f(resolutionLocation, width, height);
            gl.uniform1f(timeLocation, time);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        // Always stay on RAF (never setTimeout) so motion stays display-synced
        liquidRaf = requestAnimationFrame(animate);
    }
    canvas.__ronkLiquidRestart = () => {
        if (!alive || liquidRaf) return;
        clearLiquidWait();
        liquidRaf = requestAnimationFrame(animate);
    };
    canvas.__ronkLiquidRestart();

    liquidBgCleanup = () => {
        alive = false;
        clearLiquidWait();
        if (liquidRaf) cancelAnimationFrame(liquidRaf);
        liquidRaf = 0;
        window.removeEventListener('resize', resize);
        try {
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
        } catch (_) { /* ignore */ }
        canvas.width = 0;
        canvas.height = 0;
    };
}

// --- COLOR SELECTION ---
function updateColorPreview() {
    const color = neonColors[currentColorIndex];
    syncCubePreviewElement(colorPreview, document.getElementById('custom-upload-overlay'));
    syncLoadoutCube3D();

    if (prevColorBtn) {
        prevColorBtn.style.color = color;
        prevColorBtn.style.textShadow = `0 0 15px ${color}`;
    }
    if (nextColorBtn) {
        nextColorBtn.style.color = color;
        nextColorBtn.style.textShadow = `0 0 15px ${color}`;
    }
    if (loadoutPrevColorBtn) {
        loadoutPrevColorBtn.style.color = color;
        loadoutPrevColorBtn.style.textShadow = `0 0 15px ${color}`;
    }
    if (loadoutNextColorBtn) {
        loadoutNextColorBtn.style.color = color;
        loadoutNextColorBtn.style.textShadow = `0 0 15px ${color}`;
    }

    if (colorPreview) {
        colorPreview.classList.remove('cube-animate');
        void colorPreview.offsetWidth;
        colorPreview.classList.add('cube-animate');
    }

    const waitingRoom = document.getElementById('waiting-room');
    if (waitingRoom && !waitingRoom.classList.contains('hidden')) {
        updateWaitingRoomPreviews();
        syncSettings();
    }
}

function refreshFeaturedRooms() {
    const featuredList = document.getElementById('featured-rooms');
    if (!featuredList) return;
    
    const possibleRooms = ["BATTLE", "PRO_ROOM", "RONK_CENTRAL", "DUEL", "SPEED_ZONE", "NEON_FIGHT", "VOID_LOBBY"];
    
    // Generate room data with prioritized player counts
    const rooms = possibleRooms.map(name => {
        // Prioritize 1/2 players (70% chance) vs 0/2 or 2/2 (30% chance)
        const rand = Math.random();
        let current;
        if (rand < 0.7) {
            current = 1; // Prioritize joinable but not empty
        } else if (rand < 0.85) {
            current = 0; // Empty
        } else {
            current = 2; // Full
        }
        return { name, current };
    });

    // Sort: 1/2 first, then 0/2, then 2/2 (full)
    rooms.sort((a, b) => {
        if (a.current === 1 && b.current !== 1) return -1;
        if (a.current !== 1 && b.current === 1) return 1;
        if (a.current === 0 && b.current === 2) return -1;
        if (a.current === 2 && b.current === 0) return 1;
        return 0;
    });

    // Take top 4 and render
    featuredList.innerHTML = rooms.slice(0, 4).map(room => {
        const isFull = room.current === 2;
        return `<div class="room-item ${isFull ? 'full' : ''}">${room.name} <span class="player-count">${room.current}/2</span></div>`;
    }).join('');
}

function updateRecentRoomsList() {
    const recentRoomsEl = document.getElementById('recent-rooms');
    if (!recentRoomsEl) return;
    
    const recent = JSON.parse(localStorage.getItem('ronk_recent_rooms')) || [];
    if (recent.length === 0) {
        recentRoomsEl.innerHTML = '<div class="room-item empty">NO RECENT ROOMS</div>';
    } else {
        recentRoomsEl.innerHTML = recent.map(room => `<div class="room-item">${room.toUpperCase()}</div>`).join('');
    }
}

function saveRecentRoom(name) {
    if (!name) return;
    let recent = JSON.parse(localStorage.getItem('ronk_recent_rooms')) || [];
    // Remove if already exists and add to top
    recent = recent.filter(r => r !== name);
    recent.unshift(name);
    // Keep only last 5
    if (recent.length > 5) recent.pop();
    localStorage.setItem('ronk_recent_rooms', JSON.stringify(recent));
    updateRecentRoomsList();
}

// --- ANTI-CHEAT ---
function showAntiCheatToast(message, isError) {
    const toast = document.getElementById('anti-cheat-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    toast.classList.toggle('anti-cheat-error', !!isError);
    clearTimeout(showAntiCheatToast._timer);
    showAntiCheatToast._timer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

function kickFromOnlineCheat(reason) {
    logLobby(`ANTI-CHEAT: ${reason}`, '#ff0040');
    showAntiCheatToast(`CHEAT DETECTED — MATCH ENDED (${reason})`, true);
    alert(`Anti-cheat: suspicious activity detected (${reason}). Returning to menu.`);
    if (steamBridge) steamBridge.leaveLobby();
    if (conn) conn.close();
    if (peer) peer.destroy();
    gameState = 'LOBBY';
    isOnline = false;
    isMultiplayer = false;
    updateReportButtonsVisibility();
    showMainMenu();
    resetToMainTier();
}

function initProtectionHandlers() {
    if (!window.RonkProtection) return;

    window.onRonkProtectionViolation = (reason) => {
        showAntiCheatToast(`PROTECTION: ${reason}`, true);
        if (isOnline) kickFromOnlineCheat(reason);
    };

    window.onAntiCheatDevTools = () => {
        // Warn only — never auto-kick from window heuristics (removed)
        showAntiCheatToast('Developer tools are disabled in retail builds.', false);
    };
}

function initAntiCheatHandlers() {
    if (!window.RonkAntiCheat) return;

    window.onAntiCheatViolation = (reason, strikes) => {
        if (!isOnline) return;
        showAntiCheatToast(`ANTI-CHEAT WARNING ${strikes}/${RonkAntiCheat.MAX_STRIKES}: ${reason}`, true);
        if (strikes >= RonkAntiCheat.MAX_STRIKES) {
            kickFromOnlineCheat(reason);
        }
    };

    // Warn only — never fake-kick via DevTools size heuristics
    window.onAntiCheatDevTools = () => {
        showAntiCheatToast('Developer tools are disabled in retail builds.', false);
    };
}

function validateIncomingPacket(data) {
    if (!window.RonkAntiCheat || !isOnline) return true;

    if (data && (data.t === 's' || data.type === 'sync' || data.type === 'settings'
        || data.type === 'world-snapshot' || data.type === 'game-start' || data.type === 'fx-event'
        || data.type === 'skill-activate' || data.type === 'laser-spawn' || data.type === 'round-score'
        || data.type === 'resync-request')) {
        if (data.sig && !RonkAntiCheat.verifySealedPacket(data)) {
            kickFromOnlineCheat('TAMPER');
            return false;
        }
    }

    const auth = RonkAntiCheat.validateAuthorizedPacket(data, onlineRole);
    if (!auth.valid) {
        if (auth.kick) kickFromOnlineCheat(auth.reason || 'FORGED_PACKET');
        return false;
    }

    if (data && data.type === 'settings') {
        const settingsResult = RonkAntiCheat.validateSettingsPacket(data);
        if (!settingsResult.valid) {
            if (settingsResult.kick) kickFromOnlineCheat(settingsResult.reason || 'INVALID_SETTINGS');
            return false;
        }
    }

    if (data && (data.t === 's' || data.type === 'sync')) {
        return validateIncomingSync(data);
    }

    return true;
}

function validateIncomingSync(data) {
    if (!window.RonkAntiCheat || !isOnline) return true;
    const result = RonkAntiCheat.validateSyncPacket(data, GRID_COUNT);
    if (!result.valid) {
        if (result.kick) kickFromOnlineCheat(result.reason || 'INVALID_MOVE');
        return false;
    }
    return true;
}

function sealOnlinePacket(packet) {
    if (window.RonkAntiCheat && isOnline) {
        return RonkAntiCheat.sealPacket(packet);
    }
    return packet;
}

function markOnlineRemoteDriven() {
    if (!isOnline || !p1 || !p2) return;
    // Host drives p1 locally; guest drives p2 locally — remote is packet-driven
    if (onlineRole === 'host') {
        p1._netRemoteDriven = false;
        p2._netRemoteDriven = true;
    } else {
        p1._netRemoteDriven = true;
        p2._netRemoteDriven = false;
    }
}

function compactPlayerPoseForSnapshot(player) {
    if (!player) return null;
    return {
        x: player.x,
        y: player.y,
        bsx: player.boardSx,
        bsy: player.boardSy,
        dx: player.dir ? player.dir.x : 0,
        dy: player.dir ? player.dir.y : 0,
        dead: !!player.isDead
    };
}

function compactTrailForSnapshot(player, maxLen = 64) {
    if (!player || !Array.isArray(player.trail) || !player.trail.length) return [];
    const start = Math.max(0, player.trail.length - maxLen);
    const defSx = player.boardSx;
    const defSy = player.boardSy;
    return player.trail.slice(start).map((t) => ({
        x: Math.floor(Number(t.x)),
        y: Math.floor(Number(t.y)),
        bsx: Number.isInteger(t.boardSx) ? t.boardSx : defSx,
        bsy: Number.isInteger(t.boardSy) ? t.boardSy : defSy
    }));
}

function applySnapshotPlayerPose(snap, player) {
    if (!snap || !player) return;
    if (Number.isFinite(snap.x)) player.x = snap.x;
    if (Number.isFinite(snap.y)) player.y = snap.y;
    if (Number.isInteger(snap.bsx)) player.boardSx = snap.bsx;
    if (Number.isInteger(snap.bsy)) player.boardSy = snap.bsy;
    if (Number.isFinite(snap.dx) && Number.isFinite(snap.dy)) {
        player.dir = { x: snap.dx, y: snap.dy };
    }
    if (snap.dead) player.isDead = true;
}

function applySnapshotTrail(trailData, player) {
    if (!player || !Array.isArray(trailData)) return;
    player.trail = trailData.map((t) => ({
        x: t.x,
        y: t.y,
        boardSx: t.bsx,
        boardSy: t.bsy
    }));
    syncPlayerTrailOccSet(player);
    player._trailGen = (player._trailGen || 0) + 1;
}

function hostAcceptRemoteSkillActivate(remotePlayer, data) {
    if (!remotePlayer || remotePlayer.isDead || remotePlayer.isAI) return false;
    const skill = data && data.skill;
    if (!skill || skill !== remotePlayer.selectedSkill) return false;
    const cd = getSkillCooldownMs(remotePlayer) * (remotePlayer.jokerCooldownReduce || 1);
    const usedAt = Number(data.usedAt);
    const last = remotePlayer.lastSkillUsed || 0;
    const hostElapsed = Date.now() - last;
    const senderElapsed = Number.isFinite(usedAt) ? usedAt - last : hostElapsed;
    if (hostElapsed < cd * 0.82 && senderElapsed < cd * 0.82) return false;
    return true;
}

function buildWorldSnapshotPacket() {
    const boards = (worldBoards || []).map((b) => ({
        sx: b.sx,
        sy: b.sy,
        owner: b.owner || null,
        cps: (b.checkpoints || []).map((c) => ({
            x: c.x, y: c.y, o: c.owner || null
        }))
    }));
    const appleSnap = (apples || []).filter((a) => a && !a.eaten).map((a) => ({
        x: a.x, y: a.y, bsx: a.boardSx, bsy: a.boardSy, owner: a.owner || 'player'
    }));
    return {
        type: 'world-snapshot',
        matchSeed,
        boards,
        apples: appleSnap,
        p1Score,
        p2Score,
        friendWalls: (friendWalls || []).map((w) => ({
            x: w.x, y: w.y, bsx: w.boardSx, bsy: w.boardSy,
            oid: w.ownerId != null ? String(w.ownerId) : (w.owner ? getPlayerBaseId(w.owner.id) : '')
        })),
        p1: compactPlayerPoseForSnapshot(p1),
        p2: compactPlayerPoseForSnapshot(p2),
        p1Trail: compactTrailForSnapshot(p1),
        p2Trail: compactTrailForSnapshot(p2)
    };
}

function applyWorldSnapshot(data) {
    if (!data) return;
    if (data.matchSeed != null) setMatchSeed(data.matchSeed);
    if (Array.isArray(data.boards) && worldBoards?.length) {
        for (let i = 0; i < data.boards.length && i < worldBoards.length; i++) {
            const src = data.boards[i];
            const dst = worldBoards[i];
            if (!src || !dst) continue;
            dst.owner = src.owner || null;
            if (Array.isArray(src.cps) && Array.isArray(dst.checkpoints)) {
                for (let j = 0; j < src.cps.length && j < dst.checkpoints.length; j++) {
                    dst.checkpoints[j].owner = src.cps[j]?.o || null;
                    if (Number.isFinite(src.cps[j]?.x)) dst.checkpoints[j].x = src.cps[j].x;
                    if (Number.isFinite(src.cps[j]?.y)) dst.checkpoints[j].y = src.cps[j].y;
                }
            }
        }
        if (typeof updateBoardOwnershipHud === 'function') updateBoardOwnershipHud();
    }
    if (Array.isArray(data.apples)) {
        apples = data.apples.map((a) => ({
            x: a.x, y: a.y,
            boardSx: a.bsx, boardSy: a.bsy,
            owner: a.owner || 'player',
            spawnTime: Date.now(),
            bobOffset: matchRandom() * Math.PI * 2,
            scale: 1,
            eaten: false
        }));
    }
    if (Array.isArray(data.friendWalls)) {
        friendWalls = data.friendWalls.map((w) => ({
            x: w.x, y: w.y,
            boardSx: w.bsx, boardSy: w.bsy,
            ownerId: w.oid,
            owner: (String(w.oid) === '1') ? p1 : p2
        }));
    }
    if (typeof data.p1Score === 'number') p1Score = data.p1Score;
    if (typeof data.p2Score === 'number') p2Score = data.p2Score;
    if (data.p1) applySnapshotPlayerPose(data.p1, p1);
    if (data.p2) applySnapshotPlayerPose(data.p2, p2);
    if (Array.isArray(data.p1Trail)) applySnapshotTrail(data.p1Trail, p1);
    if (Array.isArray(data.p2Trail)) applySnapshotTrail(data.p2Trail, p2);
}

function sendOnlineSealed(packet, { includePeer = true, includeSpectate = true } = {}) {
    const sealed = sealOnlinePacket(packet);
    if (includePeer && conn && conn.open) {
        try { conn.send(sealed); } catch (_) { /* ignore */ }
    }
    if (includeSpectate && spectateConn && spectateConn.open) {
        try { spectateConn.send(sealed); } catch (_) { /* ignore */ }
    }
    return sealed;
}

function forwardToSpectator(data) {
    if (onlineRole !== 'host' || !spectateConn || !spectateConn.open || !data) return;
    try { spectateConn.send(data); } catch (_) { /* ignore */ }
}

function sendHostWorldSnapshot() {
    if (!isOnline || onlineRole !== 'host') return;
    sendOnlineSealed(buildWorldSnapshotPacket());
}

function sendHostFxEvent(evt) {
    if (!isOnline || onlineRole !== 'host' || !evt) return;
    sendOnlineSealed({ type: 'fx-event', ...evt, t: Date.now() });
}

/** Broadcast a laser beam so the peer can draw + collide without dual-sim. */
function sendOnlineLaserSpawn(shot) {
    if (!isOnline || !shot || !conn || !conn.open) return;
    if (onlineSpectateRole === 'spectator') return;
    const packet = {
        type: 'laser-spawn',
        oid: shot.ownerId != null ? String(shot.ownerId) : '',
        color: shot.color || '#ffffff',
        h: shot.isHorizontal ? 1 : 0,
        pos: shot.pos,
        bsx: shot.boardSx,
        bsy: shot.boardSy,
        warn: shot.warningTicks || Math.round(TICK_RATE * 0.5),
        role: onlineRole
    };
    sendOnlineSealed(packet);
    if (onlineRole === 'host') {
        forwardToSpectator(sealOnlinePacket({
            type: 'fx-event',
            fx: 'laser-spawn',
            oid: packet.oid,
            color: packet.color,
            h: packet.h,
            pos: packet.pos,
            bsx: packet.bsx,
            bsy: packet.bsy,
            warn: packet.warn,
            role: 'host',
            t: Date.now()
        }));
    }
}

function applyRemoteLaserSpawn(data) {
    if (!data || typeof laserLines === 'undefined') return;
    const oid = data.oid != null ? String(data.oid) : '';
    // Empty owner → still drawable, but collision will refuse to kill
    const owner = (p1 && oid && getPlayerBaseId(p1.id) === oid) ? p1
        : ((p2 && oid && getPlayerBaseId(p2.id) === oid) ? p2 : null);
    const isH = !!data.h;
    const pos = Math.max(0, Math.min(GRID_COUNT - 1, Math.floor(Number(data.pos) || 0)));
    const bsx = Number.isInteger(data.bsx) ? data.bsx : MIDDLE_BOARD_SX;
    const bsy = Number.isInteger(data.bsy) ? data.bsy : MIDDLE_BOARD_SY;
    // Dedupe sync stacks: same board/pos/axis/owner within a few ticks
    const dedupeWindow = Math.max(3, Math.round(TICK_RATE * 0.25));
    for (let i = 0; i < laserLines.length; i++) {
        const L = laserLines[i];
        if (!L) continue;
        const Loid = L.ownerId != null ? String(L.ownerId) : '';
        if (L.isHorizontal === isH
            && Math.floor(Number(L.pos)) === pos
            && L.boardSx === bsx && L.boardSy === bsy
            && Loid === oid
            && (L.ticks || 0) <= dedupeWindow) {
            return;
        }
    }
    laserLines.push({
        isHorizontal: isH,
        pos,
        boardSx: bsx,
        boardSy: bsy,
        owner,
        ownerId: oid,
        color: data.color || (owner && owner.color) || '#ffffff',
        ticks: 0,
        warningTicks: Number.isFinite(data.warn) ? data.warn : Math.round(TICK_RATE * 0.5)
    });
}

function handleOnlineDisconnect(reason, opts = {}) {
    const force = !!opts.force;
    // Soft reconnect once on PeerJS drop during an active match (not spectator)
    if (!force && !onlineReconnectAttempted && gameHasStarted && isOnline
        && lastOnlineRoomId && onlineRole && onlineSpectateRole !== 'spectator') {
        onlineReconnectAttempted = true;
        pendingSoftReconnect = true;
        try {
            enqueueGameNotification({
                kicker: 'Online',
                title: 'RECONNECTING…',
                body: 'Connection dropped — trying once to rejoin.',
                duration: 3200
            });
        } catch (_) { /* ignore */ }
        attemptOnlineSoftReconnect(reason);
        return;
    }
    pendingSoftReconnect = false;
    const msg = reason || 'CONNECTION LOST — OPPONENT LEFT';
    try { alert(msg); } catch (_) { /* ignore */ }
    try {
        if (conn) {
            try { conn.close(); } catch (_) { /* ignore */ }
        }
        if (spectateConn) {
            try { spectateConn.close(); } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }
    conn = null;
    spectateConn = null;
    isOnline = false;
    isMultiplayer = false;
    onlineRole = null;
    onlineSpectateRole = null;
    lastOnlineRoomId = null;
    try {
        returnToLobbyState({ stopLoop: false });
        showMainMenu();
        resetToMainTier();
    } catch (e) {
        console.error('Disconnect cleanup failed', e);
        try { window.location.reload(); } catch (_) { /* ignore */ }
    }
}

function attemptOnlineSoftReconnect(reason) {
    const room = lastOnlineRoomId;
    const role = onlineRole;
    try {
        if (conn) { try { conn.close(); } catch (_) { /* ignore */ } }
    } catch (_) { /* ignore */ }
    conn = null;

    if (role === 'guest' && room) {
        initPeer(null);
        let tries = 0;
        const maxTries = 3;
        const attempt = () => {
            if (!pendingSoftReconnect) return;
            tries++;
            waitForPeerOpen(8000).then(() => {
                if (!pendingSoftReconnect) return;
                const connection = peer.connect(room, { reliable: true, metadata: { role: 'player' } });
                setupConnection(connection);
                onlineRole = 'guest';
                setTimeout(() => {
                    if (pendingSoftReconnect && (!conn || !conn.open) && tries < maxTries) {
                        attempt();
                    } else if (pendingSoftReconnect && (!conn || !conn.open)) {
                        pendingSoftReconnect = false;
                        handleOnlineDisconnect(reason || 'RECONNECT FAILED', { force: true });
                    }
                }, 4000);
            }).catch(() => {
                if (tries < maxTries) {
                    setTimeout(attempt, 500);
                } else {
                    pendingSoftReconnect = false;
                    handleOnlineDisconnect(reason || 'RECONNECT FAILED', { force: true });
                }
            });
        };
        attempt();
        setTimeout(() => {
            if (pendingSoftReconnect && (!conn || !conn.open)) {
                pendingSoftReconnect = false;
                handleOnlineDisconnect(reason || 'RECONNECT FAILED', { force: true });
            }
        }, 16000);
        return;
    }

    // Host: Peer room stays up — wait briefly for guest to reconnect
    setTimeout(() => {
        if (pendingSoftReconnect && (!conn || !conn.open)) {
            pendingSoftReconnect = false;
            handleOnlineDisconnect(reason || 'RECONNECT FAILED', { force: true });
        } else {
            pendingSoftReconnect = false;
            try { sendHostWorldSnapshot(); } catch (_) { /* ignore */ }
        }
    }, 14000);
}

// --- PEERJS ---
let peer = null; let conn = null; let spectateConn = null; let myPeerId = null; let onlineRole = null;
/** 'player' | 'spectator' — spectator receives snapshots only */
let onlineSpectateRole = null;
let lastOnlineRoomId = null;
let onlineReconnectAttempted = false;
let pendingSoftReconnect = false;
let steamBridge = null;
let matchmakingCancelled = false;
let steamLobbyUnsub = null;
let enemySteamId = null;
let onlineMatchMode = null;

try {
    steamBridge = require('./steam-bridge.js');
} catch (err) {
    if (typeof window !== 'undefined' && window.__ronkSteamBridge) {
        steamBridge = window.__ronkSteamBridge;
    } else {
        console.warn('Steam bridge not loaded:', err.message);
    }
}
if (steamBridge?.isAvailable?.()) {
    bindSteamLobbyEvents();
    try {
        window.RonkSteamAchievements?.syncFromLocalProgress?.();
    } catch (_) { /* ignore */ }
}

function isSteamOnline() {
    return steamBridge && steamBridge.isAvailable();
}

function isSteamOwnershipBlocked() {
    try {
        if (typeof window !== 'undefined' && window.__ronkSteamOwnershipBlocked) return true;
        if (steamBridge?.isOwnershipBlocked?.()) return true;
    } catch (_) { /* ignore */ }
    return false;
}

function assertSteamOnlineAllowed() {
    if (!isSteamOwnershipBlocked()) return true;
    const msg = 'Launch RonkBonk via Steam to use online multiplayer.';
    try {
        enqueueGameNotification({
            kicker: 'Steam',
            title: 'LAUNCH VIA STEAM',
            body: msg,
            duration: 5000
        });
    } catch (_) {
        try { alert(msg); } catch (__) { /* ignore */ }
    }
    return false;
}

function getSteamUnavailableMessage() {
    const lang = (typeof currentLanguage !== 'undefined' && currentLanguage)
        || localStorage.getItem('ronk_language')
        || 'en';
    const t = translations[lang] || translations.en;
    const fallback = t['STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.']
        || 'STEAM IS REQUIRED FOR FRIEND LOBBIES. Launch the game through Steam.';
    if (!steamBridge) return fallback;
    const err = steamBridge.getInitError && steamBridge.getInitError();
    if (err) return `${fallback} (${err})`;
    return fallback;
}

function updateSteamOnlineStatus(panel) {
    const isMatchmake = panel === onlineMatchmakePanel;
    const statusEl = document.getElementById(isMatchmake ? 'matchmake-status' : 'friend-status');
    const inviteBtn = document.getElementById('steam-invite-btn');
    if (isSteamOnline()) {
        if (statusEl && steamBridge.getLocalName()) {
            statusEl.textContent = ('STEAM: ' + steamBridge.getLocalName()).toUpperCase();
        }
        return;
    }
    const msg = getSteamUnavailableMessage();
    if (statusEl) statusEl.textContent = msg;
    if (inviteBtn) inviteBtn.classList.add('hidden');
    if (isMatchmake) {
        logLobby('STEAM OFFLINE — USING PEER MATCHMAKE', '#ffaa00');
    } else {
        logLobby('STEAM OFFLINE — ROOM CODE STILL WORKS', '#ffaa00');
    }
}

function ensurePeerJsLoaded() {
    if (typeof Peer === 'undefined') {
        const msg = 'PEERJS FAILED TO LOAD — REINSTALL OR RESTART THE GAME';
        logLobby(msg, '#ff0040');
        alert(msg);
        return false;
    }
    return true;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureOnlineNickname() {
    syncNicknameFromInputs();
    if (!nickname) {
        alert("PLEASE ENTER A NICKNAME FIRST!");
        return false;
    }
    return true;
}

async function hostFriendRoom() {
    if (!assertSteamOnlineAllowed()) return;
    if (!ensureOnlineNickname()) return;
    onlineMatchMode = 'friends';
    onlineLogTarget = 'friend';
    bindSteamLobbyEvents();

    let roomName = joinIdInput && joinIdInput.value.trim().toLowerCase();
    if (!roomName) {
        roomName = `ronk-${(nickname || 'friend').replace(/\s+/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
        if (joinIdInput) joinIdInput.value = roomName;
    }

    saveRecentRoom(roomName);
    initPeer(roomName);

    const hostBtn = document.getElementById('host-btn');
    const friendStatus = document.getElementById('friend-status');
    if (hostBtn) {
        hostBtn.disabled = true;
        hostBtn.textContent = 'WAITING...';
    }
    if (friendStatus) friendStatus.textContent = 'HOSTING: ' + roomName.toUpperCase();
    logLobby('WAITING FOR FRIEND...', '#00ff41');

    const copyBtn = document.getElementById('copy-link-btn');
    if (copyBtn) {
        copyBtn.classList.remove('hidden');
        copyBtn.onclick = () => {
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomName);
            navigator.clipboard.writeText(url.toString()).then(() => {
                copyBtn.textContent = 'COPIED!';
                setTimeout(() => copyBtn.textContent = 'COPY JOIN LINK', 2000);
            });
        };
    }

    if (steamBridge && steamBridge.isAvailable()) {
        const lobby = await steamBridge.createFriendsLobby();
        if (lobby) {
            try {
                await waitForPeerOpen();
                steamBridge.setPeerRoomOnLobby(roomName);
            } catch (_) { /* peer may still be connecting */ }
            if (!steamBridge.inviteFriends()) {
                logLobby('COULD NOT OPEN STEAM INVITE', '#ff0040');
            } else {
                logLobby('STEAM INVITE OPENED', '#00ff41');
            }
            const inviteBtn = document.getElementById('steam-invite-btn');
            if (inviteBtn) inviteBtn.classList.remove('hidden');
        }
    } else {
        logLobby('PEER ROOM READY — SHARE CODE OR LINK', '#00ff41');
    }
}

function resetMatchmakingUI() {
    const findBtn = document.getElementById('find-match-btn');
    const cancelBtn = document.getElementById('cancel-match-btn');
    if (findBtn) {
        findBtn.disabled = false;
        findBtn.textContent = 'FIND MATCH';
    }
    if (cancelBtn) cancelBtn.classList.add('hidden');
}

function showSteamFriendButton() {
    if (steamBridge && steamBridge.isAvailable()) {
        enemySteamId = enemySteamId || steamBridge.getOpponentSteamId();
    }
    const btn = document.getElementById('add-steam-friend-btn');
    const gameOverBtn = document.getElementById('gameover-add-steam-friend-btn');
    if (enemySteamId && steamBridge && steamBridge.isAvailable()) {
        if (btn) btn.classList.remove('hidden');
        if (gameOverBtn) gameOverBtn.classList.remove('hidden');
    }
    updateReportButtonsVisibility();
}

const REPORT_REASON_LABELS = {
    hack: 'Hack / Cheat',
    nsfw: '18+ / Inappropriate image',
    harassment: 'Harassment / Toxic',
    other: 'Other'
};

function canReportOnlineRival() {
    return !!(isOnline && (enemyNickname || enemySteamId || conn));
}

function updateReportButtonsVisibility() {
    const show = canReportOnlineRival();
    ['lobby-report-btn', 'hud-report-btn', 'gameover-report-btn'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('hidden', !show);
    });
}

function closeReportModal() {
    const modal = document.getElementById('report-modal');
    if (modal) modal.classList.add('hidden');
}

function openReportModal() {
    if (!canReportOnlineRival()) {
        if (typeof showAntiCheatToast === 'function') {
            showAntiCheatToast(tUi('REPORT_NO_RIVAL', 'No online rival to report.'), true);
        }
        return;
    }
    const modal = document.getElementById('report-modal');
    if (!modal) return;
    const lang = localStorage.getItem('ronk_language') || 'en';
    const t = translations[lang] || translations['en'];
    const title = document.getElementById('report-modal-title');
    const sub = document.getElementById('report-modal-sub');
    if (title) title.textContent = t['REPORT RIVAL'] || 'REPORT RIVAL';
    if (sub) sub.textContent = t['REPORT_MODAL_SUB'] || 'Choose a reason. False reports may be ignored.';
    modal.querySelectorAll('.report-reason-btn').forEach((btn) => {
        const reason = btn.getAttribute('data-reason');
        const key = {
            hack: 'REPORT_HACK',
            nsfw: 'REPORT_NSFW',
            harassment: 'REPORT_HARASSMENT',
            other: 'REPORT_OTHER'
        }[reason];
        if (key && t[key]) btn.textContent = t[key];
    });
    const cancel = document.getElementById('report-modal-cancel');
    if (cancel) cancel.textContent = t['CANCEL'] || 'CANCEL';
    modal.classList.remove('hidden');
}

function loadPlayerReports() {
    try {
        const raw = localStorage.getItem('ronk_player_reports');
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function savePlayerReports(list) {
    try {
        localStorage.setItem('ronk_player_reports', JSON.stringify(list.slice(-80)));
    } catch (_) { /* ignore quota */ }
}

function submitPlayerReport(reason) {
    if (!canReportOnlineRival()) return;
    const label = REPORT_REASON_LABELS[reason] || reason;
    const report = {
        v: 1,
        reason: String(reason || 'other'),
        reasonLabel: label,
        reportedName: enemyNickname || 'RIVAL',
        reportedSteamId: enemySteamId || null,
        reporterName: nickname || 'PLAYER',
        reporterSteamId: (steamBridge && steamBridge.isAvailable && steamBridge.isAvailable())
            ? (steamBridge.getLocalSteamId?.() || null)
            : null,
        room: typeof roomName !== 'undefined' ? roomName : null,
        at: Date.now(),
        imagePresent: !!(
            (onlineRole === 'host' && p2 && p2.customImage) ||
            (onlineRole === 'guest' && p1 && p1.customImage)
        )
    };

    const reports = loadPlayerReports();
    // Prevent spam: same rival + reason within 2 minutes
    const recent = reports.find((r) =>
        r && r.reason === report.reason
        && (r.reportedSteamId && report.reportedSteamId
            ? r.reportedSteamId === report.reportedSteamId
            : r.reportedName === report.reportedName)
        && (Date.now() - (r.at || 0)) < 120000
    );
    if (recent) {
        closeReportModal();
        if (typeof showAntiCheatToast === 'function') {
            showAntiCheatToast(tUi('REPORT_ALREADY', 'Already reported this rival recently.'), true);
        }
        return;
    }

    reports.push(report);
    savePlayerReports(reports);
    closeReportModal();

    // Soft-notify peer (does not kick); useful for logging / future moderation server
    try {
        if (conn && conn.open && typeof sealOnlinePacket === 'function') {
            conn.send(sealOnlinePacket({
                type: 'player-report-notice',
                reason: report.reason
            }));
        }
    } catch (_) { /* ignore */ }

    console.info('[Report]', report);
    const submitted = tUi('REPORT_SUBMITTED', 'Report submitted. Thanks for keeping RonkBonk safe.');
    if (typeof showAntiCheatToast === 'function') {
        showAntiCheatToast(submitted, false);
    } else {
        alert(submitted);
    }
}

function initReportSystemUI() {
    const openIds = ['lobby-report-btn', 'hud-report-btn', 'gameover-report-btn'];
    openIds.forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn || btn._ronkReportBound) return;
        btn._ronkReportBound = true;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof SFX !== 'undefined' && SFX.play) SFX.play('button');
            openReportModal();
        });
    });

    const modal = document.getElementById('report-modal');
    if (modal && !modal._ronkReportBound) {
        modal._ronkReportBound = true;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeReportModal();
        });
        modal.querySelectorAll('.report-reason-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (typeof SFX !== 'undefined' && SFX.play) SFX.play('button');
                submitPlayerReport(btn.getAttribute('data-reason') || 'other');
            });
        });
        const cancel = document.getElementById('report-modal-cancel');
        if (cancel) {
            cancel.addEventListener('click', (e) => {
                e.preventDefault();
                closeReportModal();
            });
        }
    }
    updateReportButtonsVisibility();
}

function updateSteamFriendUI() { /* no-op: simplified online flow */ }

function setOnlineModeTab() { /* removed */ }

function waitForPeerOpen(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (peer && peer.open) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                reject(new Error('Peer connection timed out'));
            }
        }, 100);
    });
}

function waitForPeerRoomFromLobby(timeoutMs = 30000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (matchmakingCancelled) {
                clearInterval(timer);
                resolve(null);
                return;
            }
            const room = steamBridge && steamBridge.getPeerRoomFromLobby();
            if (room) {
                clearInterval(timer);
                resolve(room);
            } else if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                resolve(null);
            }
        }, 400);
    });
}

function setMatchmakingWaitingUI() {
    const findBtn = document.getElementById('find-match-btn');
    const cancelBtn = document.getElementById('cancel-match-btn');
    if (findBtn) {
        findBtn.disabled = true;
        findBtn.textContent = 'WAITING...';
    }
    if (cancelBtn) cancelBtn.classList.remove('hidden');
}

function bindSteamLobbyEvents() {
    if (!steamBridge || steamLobbyUnsub) return;
    steamLobbyUnsub = steamBridge.onLobbyEvent(async (type, data) => {
        if (type === 'join-requested' && data && data.lobby_steam_id) {
            logLobby('STEAM INVITE RECEIVED', '#00ff41');
            onlineMatchMode = 'friends';
            onlineLogTarget = 'friend';
            if (onlineFriendsPanel) openOnlinePanel(onlineFriendsPanel, 'friend');
            const lobby = await steamBridge.joinLobbyById(data.lobby_steam_id.toString());
            if (!lobby) return;
            if (!steamBridge.isLobbyOwner()) {
                const room = await waitForPeerRoomFromLobby();
                if (room) joinRoom(room, { logTarget: 'friend' });
            }
        }
        if (type === 'chat' || type === 'data') {
            const lobby = steamBridge.getActiveLobby();
            if (!lobby || Number(lobby.getMemberCount()) < 2) return;
            if (onlineMatchMode !== 'matchmaking' && onlineMatchMode !== 'friends') return;
            showSteamFriendButton();
            if (!steamBridge.isLobbyOwner()) {
                const room = steamBridge.getPeerRoomFromLobby();
                if (room && (!conn || !conn.open)) {
                    const logTarget = onlineMatchMode === 'matchmaking' ? 'matchmake' : 'friend';
                    joinRoom(room, { logTarget });
                }
            } else if (onlineMatchMode === 'matchmaking') {
                setMatchmakingWaitingUI();
            }
        }
    });
}

function tryJoinQuickMatch(roomName, timeoutMs = 2500) {
    return new Promise((resolve) => {
        if (!peer || !peer.open) {
            resolve(false);
            return;
        }
        let settled = false;
        const connection = peer.connect(roomName, { reliable: true });
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try { connection.close(); } catch (_) { /* ignore */ }
                resolve(false);
            }
        }, timeoutMs);

        connection.on('open', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            setupConnection(connection);
            onlineRole = 'guest';
            resolve(true);
        });

        connection.on('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(false);
        });
    });
}

function hostQuickMatchRoom(roomName) {
    return new Promise((resolve, reject) => {
        if (peer) {
            peer.destroy();
            peer = null;
        }
        initPeer(roomName);
        const started = Date.now();
        const timer = setInterval(() => {
            if (peer && peer.open) {
                clearInterval(timer);
                onlineRole = 'host';
                resolve();
            } else if (Date.now() - started > 10000) {
                clearInterval(timer);
                reject(new Error('Host timed out'));
            }
        }, 100);
        if (peer) {
            peer.once('error', (err) => {
                if (err.type === 'unavailable-id') {
                    clearInterval(timer);
                    reject(err);
                }
            });
        }
    });
}

async function startPeerQuickMatch() {
    matchmakingCancelled = false;
    logLobby('SEARCHING PUBLIC QUEUES...', '#00ff41');
    initPeer(null);
    try {
        await waitForPeerOpen();
    } catch (_) {
        logLobby('NETWORK ERROR — CHECK CONNECTION / RETRY', '#ff0040');
        resetMatchmakingUI();
        return;
    }

    const QM_SLOTS = 64;
    let h = 2166136261;
    const seedStr = String(myPeerId || '');
    for (let i = 0; i < seedStr.length; i++) {
        h ^= seedStr.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const slotSeed = h >>> 0;

    for (let i = 0; i < QM_SLOTS && !matchmakingCancelled; i++) {
        const slot = (slotSeed + i) % QM_SLOTS;
        const roomName = `ronkbonk-qm-${slot}`;
        logLobby(`SCANNING QUEUE ${i + 1}/${QM_SLOTS} — LOOKING FOR PLAYERS...`, '#00ff41');
        const joined = await tryJoinQuickMatch(roomName);
        if (joined) {
            resetMatchmakingUI();
            logLobby('OPPONENT FOUND!', '#00ff41');
            return;
        }
    }

    logLobby('NO ONE IN QUEUE — HOSTING A ROOM...', '#ffaa00');
    for (let i = 0; i < QM_SLOTS && !matchmakingCancelled; i++) {
        const slot = (slotSeed + i) % QM_SLOTS;
        const roomName = `ronkbonk-qm-${slot}`;
        try {
            await hostQuickMatchRoom(roomName);
            resetMatchmakingUI();
            logLobby('WAITING FOR OPPONENT (ROOM OPEN)...', '#00ff41');
            return;
        } catch (_) {
            /* try next slot */
        }
    }

    logLobby('MATCHMAKE FAILED — TRY STEAM OR PLAY WITH FRIEND', '#ff0040');
    resetMatchmakingUI();
}

async function startSteamMatchmaking() {
    matchmakingCancelled = false;

    while (!matchmakingCancelled) {
        let lobby = null;
        try {
            lobby = await steamBridge.findOrCreatePublicLobby();
        } catch (err) {
            console.warn('[Steam] Matchmaking lobby error:', err);
            logLobby('STEAM MATCHMAKE ERROR', '#ff0040');
            resetMatchmakingUI();
            return;
        }
        if (matchmakingCancelled || !lobby) {
            logLobby('STEAM MATCHMAKE UNAVAILABLE', '#ff0040');
            resetMatchmakingUI();
            return;
        }

        const roomName = `ronk-steam-${lobby.id.toString()}`;
        if (steamBridge.isLobbyOwner()) {
            logLobby('WAITING FOR PLAYER...', '#00ff41');
            initPeer(roomName);
            try {
                await waitForPeerOpen();
                steamBridge.setPeerRoomOnLobby(roomName);
                setMatchmakingWaitingUI();
                return;
            } catch (_) {
                logLobby('MATCH TIMED OUT', '#ff0040');
                steamBridge.leaveLobby();
                resetMatchmakingUI();
                return;
            }
        }

        logLobby('JOINING MATCH...', '#00ff41');
        const room = await waitForPeerRoomFromLobby(15000);
        if (room) {
            joinRoom(room, { logTarget: 'matchmake' });
            setMatchmakingWaitingUI();
            return;
        }

        steamBridge.leaveLobby();
        if (matchmakingCancelled) {
            resetMatchmakingUI();
            return;
        }
        logLobby('SEARCHING FOR OPPONENT...', '#00ff41');
        await sleep(2000);
    }

    resetMatchmakingUI();
}

async function startMatchmaking() {
    if (!assertSteamOnlineAllowed()) return;
    if (!ensureOnlineNickname()) return;
    onlineMatchMode = 'matchmaking';
    onlineLogTarget = 'matchmake';
    window.RonkSteamAchievements?.onOnlineMatchmakingStarted?.();

    const findBtn = document.getElementById('find-match-btn');
    const cancelBtn = document.getElementById('cancel-match-btn');
    if (findBtn) {
        findBtn.disabled = true;
        findBtn.textContent = 'SEARCHING...';
    }
    if (cancelBtn) cancelBtn.classList.remove('hidden');

    bindSteamLobbyEvents();

    if (steamBridge && steamBridge.isAvailable()) {
        logLobby('STEAM MATCHMAKE — SEARCHING LOBBIES...', '#66c0f4');
        await startSteamMatchmaking();
    } else {
        logLobby('STEAM OFFLINE — PEER QUEUE (MAY BE EMPTY)', '#ffaa00');
        await startPeerQuickMatch();
    }
}

function cancelMatchmaking() {
    matchmakingCancelled = true;
    if (steamBridge) steamBridge.leaveLobby();
    if (peer) {
        peer.destroy();
        peer = null;
    }
    resetMatchmakingUI();
    logLobby('MATCHMAKING CANCELLED', '#ff0040');
}

async function startSteamFriendLobby() {
    await hostFriendRoom();
}

function addSteamFriendFromMatch() {
    if (!enemySteamId) {
        enemySteamId = steamBridge && steamBridge.getOpponentSteamId();
    }
    if (!enemySteamId || !steamBridge) {
        alert('NO STEAM PLAYER FOUND FOR THIS MATCH.');
        return;
    }
    if (steamBridge.openAddFriendDialog(enemySteamId)) {
        logLobby('OPENING STEAM ADD FRIEND...', '#66c0f4');
    } else {
        alert('COULD NOT OPEN STEAM FRIEND DIALOG.');
    }
}

function logLobby(msg, color = "#ff0040") {
    const logId = onlineLogTarget === 'friend' ? 'friend-log' : 'matchmake-log';
    const logEl = document.getElementById(logId);
    if (logEl) {
        logEl.textContent = "LOG: " + msg.toUpperCase();
        logEl.style.color = color;
    }
}

function initPeer(customId = null) {
    if (peer && !peer.destroyed) {
        try { peer.destroy(); } catch (_) { /* ignore */ }
        peer = null;
        conn = null;
    }
    
    logLobby("INITIALIZING CONNECTION...", "#00ff41");
    
    if (!ensureOnlineNickname()) {
        return;
    }
    if (!ensurePeerJsLoaded()) {
        return;
    }

    // Enhanced ICE: multiple STUN + Metered TURN (env override via window.RONK_TURN)
    const turnFromEnv = (typeof window !== 'undefined' && window.RONK_TURN && typeof window.RONK_TURN === 'object')
        ? window.RONK_TURN
        : null;
    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        turnFromEnv || {
            urls: [
                'turn:openrelay.metered.ca:80',
                'turn:openrelay.metered.ca:443',
                'turn:openrelay.metered.ca:443?transport=tcp'
            ],
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ];

    peer = new Peer(customId, {
        debug: 1,
        config: {
            iceServers,
            sdpSemantics: 'unified-plan',
            iceTransportPolicy: 'all'
        }
    });
    // Keep DataChannel reliable (ordered). Forcing UDP-style dropped game-start,
    // settings, and round-score packets so guests never started / scores desynced.
    
    peer.on('open', (id) => { 
        myPeerId = id;
        if (!lastOnlineRoomId && customId) lastOnlineRoomId = customId;
        // Keep Steam lobby peer_room fresh whenever Peer id is ready
        try {
            if (steamBridge && steamBridge.isAvailable() && steamBridge.isLobbyOwner && steamBridge.isLobbyOwner()) {
                steamBridge.setPeerRoomOnLobby(id);
            }
        } catch (_) { /* ignore */ }
        const lobbyStatus = document.getElementById(
            onlineMatchMode === 'friends' ? 'friend-status' : 'matchmake-status'
        );
        if (customId) {
            logLobby("ROOM ACTIVE - WAITING FOR FRIEND", "#00ff41");
            if (lobbyStatus) lobbyStatus.textContent = "ROOM: " + id.toUpperCase();
        } else {
            logLobby("READY TO JOIN", "#00ff41");
        }
    });
    
    peer.on('connection', (connection) => {
        logLobby("GUEST CONNECTED!", "#00ff41");
        if (conn && conn.open) {
            connection.close();
            return;
        }
        setupConnection(connection);
        onlineRole = 'host';
        if (myPeerId) lastOnlineRoomId = myPeerId;
        onlineReconnectAttempted = false;

        connection.on('open', () => {
            if (pendingSoftReconnect) {
                pendingSoftReconnect = false;
                logLobby("GUEST RECONNECTED!", "#00ff41");
                try { sendHostWorldSnapshot(); } catch (_) { /* ignore */ }
                return;
            }
            enterWaitingRoom();
        });
    });

    peer.on('error', (err) => {
        console.error("Connection Error:", err.type);
        if (gameHasStarted && isOnline && onlineRole && onlineSpectateRole !== 'spectator') {
            handleOnlineDisconnect(err.type || 'network');
            return;
        }
        let errorMsg = err.type;
        if (err.type === 'peer-unavailable') errorMsg = "ROOM NOT FOUND (HOST ISN'T ONLINE)";
        else if (err.type === 'unavailable-id') errorMsg = "ROOM NAME ALREADY TAKEN!";
        else if (err.type === 'network') errorMsg = "NETWORK ERROR - CHECK WIFI";
        
        logLobby(errorMsg, "#ff0040");
        alert("CONNECTION FAILED: " + errorMsg);
        
        const hostBtn = document.getElementById('host-btn');
        if (hostBtn) { hostBtn.disabled = false; hostBtn.textContent = "HOST ROOM"; }
        if (connectBtn) { connectBtn.textContent = "JOIN ROOM"; connectBtn.disabled = false; }
        const lobbyStatus = document.getElementById('matchmake-status');
        if (lobbyStatus) lobbyStatus.textContent = "READY TO PLAY";
        
        if (peer) { peer.destroy(); peer = null; }
    });
}

function enterWaitingRoom() {
    hideOverlayPanel(onlineMatchmakePanel);
    hideOverlayPanel(onlineFriendsPanel);
    const waitingRoom = document.getElementById('waiting-room');
    if (waitingRoom) showOverlayPanel(waitingRoom);
    
    updateWaitingRoomPreviews();
    syncSettings();
    showSteamFriendButton();
}

function updateWaitingRoomPreviews() {
    const selfPreview = document.getElementById('self-preview');
    const selfName = document.getElementById('self-name');
    const enemyPreview = document.getElementById('enemy-preview');
    const enemyName = document.getElementById('enemy-name');
    const enemyReadyIndicator = document.getElementById('enemy-ready');

    if (selfName) selfName.textContent = nickname.toUpperCase();
    if (selfPreview) {
        const myColor = neonColors[currentColorIndex];
        selfPreview.style.backgroundColor = myColor;
        selfPreview.style.color = myColor;
        if (currentColorIndex === neonColors.length - 1 && playerImage) {
            selfPreview.style.backgroundImage = `url(${playerImage.src})`;
        } else {
            selfPreview.style.backgroundImage = 'none';
        }
    }

    if (enemyName && enemyNickname) {
        enemyName.textContent = enemyNickname.toUpperCase();
    }
    if (enemyPreview && enemyColor) {
        enemyPreview.style.backgroundColor = enemyColor;
        enemyPreview.style.color = enemyColor;
        if (enemyImage) {
            enemyPreview.style.backgroundImage = `url(${enemyImage})`;
        } else {
            enemyPreview.style.backgroundImage = 'none';
        }
    }
    
    if (enemyReadyIndicator) {
        enemyReadyIndicator.textContent = enemyReady ? "READY" : "NOT READY";
        enemyReadyIndicator.classList.toggle('is-ready', enemyReady);
    }
}

function checkBothReady() {
    if (isReady && enemyReady && onlineRole === 'host') {
        matchesPlayed = 0; // Reset session matches
        startOnlineGame();
    }
}

function checkBothVoted() {
    if (hasVotedContinue && enemyVotedContinue && onlineRole === 'host') {
        hasVotedContinue = false;
        enemyVotedContinue = false;
        resetMatchScoreState();
        conn.send(sealOnlinePacket({ type: 'continue-confirm' }));
        startOnlineGame();
    }
}

function applyFxEvent(data) {
    if (!data || !data.fx) return;
    if (data.fx === 'skill-activate') {
        const who = data.role === 'host' ? p1 : p2;
        if (who && data.skill) {
            if (who.selectedSkill !== data.skill) who.selectedSkill = data.skill;
            who.lastSkillUsed = 0;
            who.activateSkill({ fromRemote: true });
        }
        return;
    }
    if (data.fx === 'laser-spawn') {
        applyRemoteLaserSpawn(data);
        return;
    }
    if (data.fx === 'friend-walls' && Array.isArray(data.walls)) {
        friendWalls = data.walls.map((w) => ({
            x: w.x, y: w.y,
            boardSx: w.bsx, boardSy: w.bsy,
            ownerId: w.oid,
            owner: (String(w.oid) === '1') ? p1 : p2
        }));
    }
}

function setupSpectateFanout(connection) {
    // Live friend spectate (Phase 3) reverted — reject extra peers
    try { connection.close(); } catch (_) { /* ignore */ }
}

function setupConnection(connection) {
    conn = connection;
    
    conn.on('open', () => {
        if (window.RonkAntiCheat) RonkAntiCheat.resetSession();
        logLobby("MATCH SYNCED!", "#00ff41");
        if (pendingSoftReconnect) {
            pendingSoftReconnect = false;
            logLobby("RECONNECTED!", "#00ff41");
            try {
                enqueueGameNotification({
                    kicker: 'Online',
                    title: 'RECONNECTED',
                    body: 'Match link restored.',
                    duration: 2800
                });
            } catch (_) { /* ignore */ }
            if (gameHasStarted && isOnline) {
                if (onlineRole === 'guest' && conn && conn.open) {
                    try {
                        conn.send(sealOnlinePacket({ type: 'resync-request', t: Date.now() }));
                    } catch (_) { /* ignore */ }
                }
                if (onlineRole === 'host') {
                    try { sendHostWorldSnapshot(); } catch (_) { /* ignore */ }
                }
            }
            return;
        }
        if (onlineRole === 'guest') {
            if (connectBtn) connectBtn.textContent = "CONNECTED!";
            enterWaitingRoom();
        }
        showSteamFriendButton();
        // Send initial settings to the other player
        syncSettings();
    });

    conn.on('data', (data) => {
        if (!validateIncomingPacket(data)) return;

        if (data.type === 'game-start') {
            isOnline = true; 
            isMultiplayer = true;
            onlineSpectateRole = data.spectateRole === 'spectator' ? 'spectator' : 'player';
            opponentLoadoutForUnlock = null;
            resetMatchScoreState();
            if (data.matchSeed != null) setMatchSeed(data.matchSeed);
            if (data.sessionSecret && window.RonkAntiCheat?.setSessionSecret) {
                RonkAntiCheat.setSessionSecret(data.sessionSecret);
            }
            if (data.skill !== undefined) enemySelectedSkill = data.skill;
            if (data.jokers) {
                enemySelectedJokers = Array.isArray(data.jokers) ? [...data.jokers] : [];
            }
            if (data.color) enemyColor = data.color;
            if (data.nickname) enemyNickname = data.nickname;
            if (data.image) {
                loadPeerCustomImage(data.image, (img) => {
                    if (p1 && onlineRole === 'guest') p1.customImage = img;
                    if (p2 && onlineRole === 'host') p2.customImage = img;
                    updateWaitingRoomPreviews();
                });
            }
            const waitingRoom = document.getElementById('waiting-room');
            if (waitingRoom) hideOverlayPanel(waitingRoom);
            try {
                initGame();
                markOnlineRemoteDriven();
                if (onlineSpectateRole === 'spectator') {
                    isSpectateMode = true;
                    if (p1) p1.isAI = true;
                    if (p2) p2.isAI = true;
                }
            } catch (error) {
                console.error('Failed to start game from host signal:', error);
                alert('Could not start the online match. Please try again.');
                showMainMenu();
                resetToMainTier();
            }
        }
        else if (data.type === 'world-snapshot') {
            applyWorldSnapshot(data);
            if (typeof updateScoreboard === 'function') updateScoreboard();
            if (onlineRole === 'host') forwardToSpectator(data);
        }
        else if (data.type === 'resync-request') {
            if (onlineRole === 'host' && gameHasStarted) {
                sendHostWorldSnapshot();
            }
        }
        else if (data.type === 'fx-event') {
            applyFxEvent(data);
            if (onlineRole === 'host') forwardToSpectator(data);
        }
        else if (data.type === 'laser-spawn') {
            applyRemoteLaserSpawn(data);
            if (onlineRole === 'host') {
                forwardToSpectator(sealOnlinePacket({
                    type: 'fx-event',
                    fx: 'laser-spawn',
                    oid: data.oid,
                    color: data.color,
                    h: data.h,
                    pos: data.pos,
                    bsx: data.bsx,
                    bsy: data.bsy,
                    warn: data.warn,
                    role: data.role || 'guest',
                    t: Date.now()
                }));
            }
        }
        else if (data.t === 's' || data.type === 'sync') {
            const remotePlayer = onlineRole === 'host' ? p2 : p1;
            if (remotePlayer) {
                const isOpt = data.t === 's';
                
                const syncX = isOpt ? data.x : data.x;
                const syncY = isOpt ? data.y : data.y;
                const syncDx = isOpt ? data.dx : data.dir.x;
                const syncDy = isOpt ? data.dy : data.dir.y;
                
                // Always apply remote pose (remote is packet-driven, not dual-sim)
                remotePlayer.x = syncX;
                remotePlayer.y = syncY;
                remotePlayer.prevX = isOpt ? data.px : data.prevX;
                remotePlayer.prevY = isOpt ? data.py : data.prevY;
                if (Number.isInteger(data.bsx)) remotePlayer.boardSx = data.bsx;
                if (Number.isInteger(data.bsy)) remotePlayer.boardSy = data.bsy;
                remotePlayer.dir = { x: syncDx, y: syncDy };
                remotePlayer._netRemoteDriven = true;
                
                if (isOpt) {
                    (data.tr || []).forEach(p => {
                        const pt = {
                            x: p.x,
                            y: p.y,
                            boardSx: Number.isInteger(p.boardSx) ? p.boardSx
                                : (Number.isInteger(p.bsx) ? p.bsx : remotePlayer.boardSx),
                            boardSy: Number.isInteger(p.boardSy) ? p.boardSy
                                : (Number.isInteger(p.bsy) ? p.bsy : remotePlayer.boardSy)
                        };
                        if (typeof pushPlayerTrailCell === 'function') {
                            pushPlayerTrailCell(remotePlayer, pt.x, pt.y, pt.boardSx, pt.boardSy);
                        } else {
                            const exists = remotePlayer.trail.some(t =>
                                t.x === pt.x && t.y === pt.y
                                && (t.boardSx ?? remotePlayer.boardSx) === pt.boardSx
                                && (t.boardSy ?? remotePlayer.boardSy) === pt.boardSy
                            );
                            if (!exists) remotePlayer.trail.push(pt);
                        }
                    });
                } else {
                    remotePlayer.trail = data.trail;
                    if (remotePlayer._trailPaintSet) {
                        remotePlayer._trailPaintSet.clear();
                        (remotePlayer.trail || []).forEach((t) => {
                            if (!t) return;
                            remotePlayer._trailPaintSet.add(trailPaintKey(
                                t.x, t.y, t.boardSx ?? remotePlayer.boardSx, t.boardSy ?? remotePlayer.boardSy
                            ));
                        });
                    }
                }

                remotePlayer.isDead = isOpt ? (data.id === 1) : data.isDead;
                remotePlayer.isDashing = isOpt ? (data.ds === 1) : data.isDashing;
                remotePlayer.isCharging = isOpt ? (data.ch === 1) : data.isCharging;
                remotePlayer.dashAnimTicks = isOpt ? data.da : data.dashAnimTicks;
                remotePlayer.chargeAnimTicks = isOpt ? data.ca : data.chargeAnimTicks;
                // Let local simulation handle rollProgress for smoothness
            }
            if (onlineRole === 'host') forwardToSpectator(data);
        }
        else if (data.type === 'settings') {
            enemyNickname = data.nickname || "RIVAL";
            enemyColor = data.color;
            enemyImage = data.image;
            enemyReady = !!data.ready;
            enemyVotedContinue = !!data.voteContinue;
            if (data.skill !== undefined) enemySelectedSkill = data.skill;
            if (data.jokers) {
                enemySelectedJokers = Array.isArray(data.jokers) ? [...data.jokers] : [];
            }
            if (isOnline && (p1Score === 0 && p2Score === 0)) {
                captureOpponentLoadoutForUnlock();
            } else {
                lastOpponentLoadout = getOpponentLoadoutSnapshot();
            }
            if (data.steamId) {
                enemySteamId = data.steamId;
                showSteamFriendButton();
            }
            updateReportButtonsVisibility();
            
            if (onlineRole === 'host') {
                p2MatchColor = data.color;
                if (data.image) {
                    loadPeerCustomImage(data.image, (img) => {
                        if (p2) p2.customImage = img;
                        updateWaitingRoomPreviews();
                    });
                } else {
                    if (p2) p2.customImage = null;
                    updateWaitingRoomPreviews();
                }
            } else {
                p1MatchColor = data.color;
                if (data.image) {
                    loadPeerCustomImage(data.image, (img) => {
                        if (p1) p1.customImage = img;
                        updateWaitingRoomPreviews();
                    });
                } else {
                    if (p1) p1.customImage = null;
                    updateWaitingRoomPreviews();
                }
            }
            
            // Check if both ready whenever settings (ready state) update
            checkBothReady();
            checkBothVoted();

            // Update UI for vote status if in game over screen
            const statusEl = document.getElementById('vote-status');
            if (statusEl) statusEl.textContent = enemyVotedContinue ? "RIVAL WANTS TO CONTINUE!" : "WAITING FOR RIVAL...";

            // Update scores UI to reflect colors
            const p1ScoreEl = document.getElementById('p1-score-val');
            const p2ScoreEl = document.getElementById('p2-score-val');
            if (p1ScoreEl && p1MatchColor) p1ScoreEl.style.color = p1MatchColor;
            if (p2ScoreEl && p2MatchColor) p2ScoreEl.style.color = p2MatchColor;
        }
        else if (data.type === 'round-score') {
            // Host-authoritative round result — guest mirrors scoreboard
            if (onlineRole === 'guest' && data && typeof data.p1Score === 'number') {
                p1Score = data.p1Score;
                p2Score = data.p2Score;
                if (typeof data.roundsCompletedThisMatch === 'number') {
                    roundsCompletedThisMatch = data.roundsCompletedThisMatch;
                }
                if (data.lastBoardWinReason) lastBoardWinReason = data.lastBoardWinReason;
                roundOutcomeScored = true;
                updateScoreboard();
                const target = getEffectiveMatchTarget();
                if (p1Score >= target || p2Score >= target) {
                    gameState = 'GAME_OVER';
                } else if (gameState === 'PLAYING') {
                    gameState = 'ROUND_OVER';
                }
                scheduleRoundEndTransition();
            }
        }
        else if (data.type === 'continue-confirm') {
            hasVotedContinue = false;
            enemyVotedContinue = false;
            resetMatchScoreState();
            if (gameOverDiv) gameOverDiv.classList.add('hidden');
            initGame();
        }
        else if (data.type === 'pause-sync') {
            // Online PvP has no pause — ignore peer pause packets
        }
        else if (data.type === 'skill-activate') {
            const remotePlayer = onlineRole === 'host' ? p2 : p1;
            if (onlineRole === 'host' && !hostAcceptRemoteSkillActivate(remotePlayer, data)) {
                return;
            }
            if (remotePlayer && data.skill) {
                if (remotePlayer.selectedSkill !== data.skill) {
                    remotePlayer.selectedSkill = data.skill;
                }
                remotePlayer.lastSkillUsed = 0;
                remotePlayer.activateSkill({ fromRemote: true });
            }
            if (onlineRole === 'host') {
                forwardToSpectator(data);
                sendHostFxEvent({ fx: 'skill-activate', skill: data.skill, role: data.role || 'guest' });
            }
        }
        else if (data.type === 'player-report-notice') {
            // Peer was reported — no UI spam; keep for future moderation hooks
            console.info('[Report] Peer sent report-notice:', data.reason);
        }
    });

    conn.on('close', () => {
        if (gameHasStarted && isOnline) {
            handleOnlineDisconnect('CONNECTION LOST — OPPONENT LEFT');
            return;
        }
        handleOnlineDisconnect('CONNECTION LOST — OPPONENT LEFT', { force: true });
    });
    conn.on('error', () => {
        if (gameHasStarted && isOnline) {
            handleOnlineDisconnect('CONNECTION ERROR — RECONNECTING…');
            return;
        }
        handleOnlineDisconnect('CONNECTION ERROR — RETURNING TO MENU', { force: true });
    });
}
function getSafePlayerImageForSync() {
    const src = playerImage && playerImage.src ? String(playerImage.src) : '';
    if (!src.startsWith('data:image/')) return null;
    // Accept JPEG / PNG / WebP peer cubes (was JPEG-only and dropped valid uploads)
    if (!(src.startsWith('data:image/jpeg')
        || src.startsWith('data:image/png')
        || src.startsWith('data:image/webp'))) {
        return null;
    }
    if (src.length > 900000) return null;
    return src;
}

function sendOnlinePauseState(paused) {
    // Online matches do not support pause — never sync it
    return;
}

function sendOnlineSkillActivate(player) {
    if (!isOnline || !player) return;
    // Only sync the local human's skill press (host=p1, guest=p2)
    const localHuman = onlineRole === 'host' ? p1 : p2;
    if (player !== localHuman || player.isAI) return;
    if (onlineSpectateRole === 'spectator') return;
    try {
        const packet = {
            type: 'skill-activate',
            skill: player.selectedSkill,
            role: onlineRole,
            usedAt: Date.now()
        };
        if (conn && conn.open) conn.send(sealOnlinePacket(packet));
        if (onlineRole === 'host') {
            sendHostFxEvent({ fx: 'skill-activate', skill: player.selectedSkill, role: 'host' });
        }
    } catch (_) { /* ignore */ }
}

/** Deterministic 0..1 for online DISABLE so both peers pick the same target. */
function seededUnit(seedStr) {
    let h = 2166136261 >>> 0;
    const s = String(seedStr || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
}

function pickDisabledJokerId(pool, seedKey) {
    if (!pool || !pool.length) return null;
    if (isOnline) {
        const u = seededUnit(`${seedKey}|${roundsCompletedThisMatch}|${p1Score}|${p2Score}|${(p1MatchJokers || []).join(',')}|${(p2MatchJokers || []).join(',')}`);
        return pool[Math.floor(u * pool.length) % pool.length];
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

function syncSettings() { 
    if (conn && conn.open) { 
        const loadout = getLocalPlayerLoadoutForSync();
        const payload = sealOnlinePacket({ 
            type: 'settings', 
            nickname: nickname,
            ready: isReady,
            voteContinue: hasVotedContinue,
            role: onlineRole,
            color: neonColors[currentColorIndex],
            image: getSafePlayerImageForSync(),
            skill: loadout.skill,
            jokers: loadout.jokers
        });
        if (steamBridge && steamBridge.isAvailable()) {
            payload.steamId = steamBridge.getLocalSteamId();
        }
        conn.send(payload); 
    } 
}

function startOnlineGame() { 
    if (conn) { 
        isOnline = true;
        isMultiplayer = true;
        onlineSpectateRole = 'player';
        onlineReconnectAttempted = false;
        if (myPeerId) lastOnlineRoomId = myPeerId;
        opponentLoadoutForUnlock = null;
        resetMatchScoreState();
        resetGamepadPlayerSlots();
        setMatchSeed(Math.floor(Math.random() * 0xffffffff));
        const sessionSecret = [
            steamBridge?.getCurrentLobbyId?.() || myPeerId || 'peer',
            steamBridge?.getLocalSteamId?.() || nickname || 'host',
            String(matchSeed)
        ].join('|');
        if (window.RonkAntiCheat?.setSessionSecret) {
            RonkAntiCheat.setSessionSecret(sessionSecret);
        }
        const waitingRoom = document.getElementById('waiting-room');
        if (waitingRoom) hideOverlayPanel(waitingRoom);
        syncSettings();
        const startLoadout = getLocalPlayerLoadoutForSync();
        sendOnlineSealed({
            type: 'game-start',
            nickname: nickname,
            color: neonColors[currentColorIndex],
            skill: startLoadout.skill,
            jokers: startLoadout.jokers,
            image: getSafePlayerImageForSync(),
            matchSeed,
            sessionSecret,
            spectateRole: 'player'
        }, { includeSpectate: false });
        try {
            initGame();
            markOnlineRemoteDriven();
            syncGamepadPlayerBindings();
            sendHostWorldSnapshot();
            if (friendWalls?.length) {
                sendHostFxEvent({
                    fx: 'friend-walls',
                    walls: friendWalls.map((w) => ({
                        x: w.x, y: w.y, bsx: w.boardSx, bsy: w.boardSy,
                        oid: w.ownerId != null ? String(w.ownerId) : ''
                    }))
                });
            }
        } catch (error) {
            console.error('Failed to start online game:', error);
            alert('Could not start the online match. Please try again.');
            showMainMenu();
            resetToMainTier();
        }
    } 
}

// --- GAME LOGIC ---
function hideGameplayUI() {
    if (gameUi) {
        gameUi.classList.add('hidden');
        gameUi.style.display = 'none';
        gameUi.classList.remove('fade-in');
    }
    if (p1HudEl) p1HudEl.classList.remove('visible');
    if (p2HudEl) p2HudEl.classList.remove('visible');
    if (pauseMenu) {
        pauseMenu.classList.add('hidden');
        pauseMenu.style.display = 'none';
    }
    if (gameOverDiv) gameOverDiv.classList.add('hidden');
    if (gameOverHintEl) {
        gameOverHintEl.textContent = '';
        gameOverHintEl.classList.add('hidden');
    }
    if (roundAnnouncerEl) roundAnnouncerEl.classList.add('hidden');
    if (!isTutorialMatch) hideTutorialOverlay();
}

function showOverlayPanel(el, displayMode) {
    if (!el) return;
    el.classList.remove('hidden');
    el.style.display = displayMode || 'flex';
    el.style.visibility = 'visible';
    el.style.opacity = '1';
    el.style.pointerEvents = 'auto';
    syncOverlayScreenClass();
    syncThemeBackdrop();
    if (introFinished && !document.body.classList.contains('intro-active')) {
        setThemeBtnVisible(true);
    }
}

function hideOverlayPanel(el) {
    if (!el) return;
    if (el === loadoutPage) releaseLoadoutCubeMemory();
    el.classList.add('hidden');
    el.style.display = 'none';
    el.style.visibility = 'hidden';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    syncOverlayScreenClass();
}

function showMainMenu() {
    // Theme switches briefly set isThemeSwitching; defer instead of dropping the reveal
    // (finishIntro used to hit this and leave a permanent black screen).
    if (isThemeSwitching) {
        requestAnimationFrame(() => showMainMenu());
        return;
    }
    hideTutorialGate();
    returnToLobbyState();
    hideGameplayUI();
    settingsReturnState = null;
    settingsOpenedFromPause = false;
    if (loadoutPage) loadoutPage.classList.remove('loadout-picker-open');
    document.body.classList.remove('loadout-picker-open');
    if (loadoutSkillPanel) loadoutSkillPanel.classList.add('hidden');
    if (loadoutJokerPanel) loadoutJokerPanel.classList.add('hidden');
    [customPage, onlineMatchmakePanel, onlineFriendsPanel, loadoutPage, settingsPage].forEach(hideOverlayPanel);
    const waitingRoom = document.getElementById('waiting-room');
    if (waitingRoom) hideOverlayPanel(waitingRoom);
    document.body.classList.remove('in-game');
    document.body.classList.remove('gfx-boost');
    document.body.classList.remove('gfx-smooth');
    document.body.classList.remove('cursor-hidden');
    cachedThemeColorKey = '';
    updateThemeColors();
    updateEffectiveDpr();
    if (canvas && ctx) resizeCanvas();
    const menuWasHidden = menu && menu.classList.contains('hidden');
    if (menu) {
        menu.classList.remove('hidden');
        menu.style.display = 'flex';
        menu.style.visibility = 'visible';
        menu.style.opacity = '1';
        menu.style.pointerEvents = 'auto';
        // One-shot fade only when returning from another screen — avoid replaying forever
        if (menuWasHidden) {
            menu.classList.remove('menu-enter');
            void menu.offsetWidth;
            menu.classList.add('menu-enter');
        }
    }
    if (introFinished && !document.body.classList.contains('intro-active')) {
        document.body.classList.add('main-menu-visible');
        setThemeBtnVisible(true);
    } else {
        setThemeBtnVisible(false);
    }
    setActiveNavigation('menu', { menuTier: getVisibleMenuTierId() });
    syncThemeBackdrop();
    try { healThemeBackgroundIfNeeded(); } catch (_) { /* ignore */ }
    try {
        if (themes[currentThemeIndex] === 'theme-pixel') ensurePixelFlappyRunning();
    } catch (_) { /* ignore */ }
    // Re-arm Ronk title flicker/sparks whenever the main menu is shown
    if (themes[currentThemeIndex] === 'theme-ronk') {
        initRonkTitleFlicker();
    }
}

function hideAllMenuPanels() {
    const panels = [menu, customPage, onlineMatchmakePanel, onlineFriendsPanel, loadoutPage, settingsPage];
    panels.forEach(hideOverlayPanel);
    const waitingRoom = document.getElementById('waiting-room');
    if (waitingRoom) hideOverlayPanel(waitingRoom);
    // Never hide intro here — theme init runs during intro; killing it breaks the opening animation
}

function syncGameplayThemeFx() {
    if (!document.body.classList.contains('in-game')) return;
    syncThemeBackdrop();
    cachedThemeColorKey = '';
    updateThemeColors();
}

function showGameScreen() {
    hideTutorialGate();
    hideAllMenuPanels();
    if (typeof stopLoadoutCubeRender === 'function') stopLoadoutCubeRender();
    if (typeof releaseLoadoutCubeMemory === 'function') releaseLoadoutCubeMemory();
    if (typeof clearRonkTitleFlicker === 'function') clearRonkTitleFlicker();
    document.body.classList.remove('main-menu-visible', 'intro-active');
    document.body.classList.add('in-game');
    syncBlinkPerfClass();
    try { syncLiquidBudgetParams(); } catch (_) { /* ignore */ }
    try { syncGfxBoostClass(); } catch (_) { /* ignore */ }
    setActiveNavigation('in-game', { paused: false });
    syncGameplayCursor();
    const introOverlay = document.getElementById('intro-overlay');
    if (introOverlay) {
        introOverlay.style.display = 'none';
        introOverlay.style.pointerEvents = 'none';
    }
    if (gameUi) {
        gameUi.classList.remove('hidden');
        gameUi.style.display = 'block';
        gameUi.style.visibility = 'visible';
        gameUi.style.opacity = '1';
        gameUi.style.pointerEvents = 'none';
    }
    if (themeBtn) {
        setThemeBtnVisible(introFinished);
    }
    syncGameplayThemeFx();
    cachedThemeColorKey = '';
    updateThemeColors();
    updateEffectiveDpr();
    if (canvas && ctx) resizeCanvas();
    if (typeof Music !== 'undefined' && Music.enabled && introFinished) {
        try { Music.ensurePlaying(); } catch (_) { /* ignore */ }
    }
}

function launchGameMode({ spectate = false, multiplayer = false, botDifficulty = null } = {}) {
    isTutorialMatch = false;
    tutorialPracticeActive = false;
    tutorialFightWaitingForStart = false;
    tutorialObjectiveDone = false;
    opponentLoadoutForUnlock = null;
    hideTutorialOverlay();
    isSpectateMode = spectate;
    isMultiplayer = multiplayer;
    isOnline = false;
    // Fresh pad slots for the match; sync after players exist so P1/P2 keep stable indices
    resetGamepadPlayerSlots();
    if (spectate) {
        setBotDifficulty(botDifficulty || 'invincible');
    } else if (botDifficulty) {
        setBotDifficulty(botDifficulty);
    }
    resetMatchScoreState();
    const start = () => {
        try {
            initGame();
            syncGamepadPlayerBindings();
        } catch (error) {
            console.error('Failed to start game:', error);
            alert('Could not start the game. Please refresh the page and try again.');
            returnToLobbyState({ stopLoop: true });
            showMainMenu();
            resetToMainTier();
        }
    };
    start();
}

function initGame() {
    // Never start a new round if the match is already decided — show end UI instead
    try {
        const target = typeof getEffectiveMatchTarget === 'function' ? getEffectiveMatchTarget() : 6;
        if (p1Score >= target || p2Score >= target) {
            gameState = 'GAME_OVER';
            if (!matchEndUiShown || (gameOverDiv && gameOverDiv.classList.contains('hidden'))) {
                endGame();
            }
            return;
        }
    } catch (_) { /* continue into normal init */ }

    // Offline / local: fresh seed each round. Online guest keeps host matchSeed.
    if (!isOnline || onlineRole === 'host' || !matchSeed) {
        if (!isOnline) setMatchSeed(Math.floor(Math.random() * 0xffffffff));
        else if (onlineRole === 'host' && !matchSeed) setMatchSeed(Math.floor(Math.random() * 0xffffffff));
    } else {
        // Guest: re-seed from locked matchSeed so board rebuild matches host
        setMatchSeed(matchSeed);
    }

    const alreadyInGame = document.body.classList.contains('in-game')
        && gameUi && !gameUi.classList.contains('hidden');
    if (!alreadyInGame) {
        showGameScreen();
    } else {
        SFX.init();
    }
    if (!alreadyInGame) {
        lastP1JokersKey = '';
        lastP2JokersKey = '';
    }
    if (typeof releaseRoundFreezeScene === 'function') releaseRoundFreezeScene();
    deathCounter = 0;
    isReady = false; 
    enemyReady = false;
    isPaused = false;
    isResuming = false;
    document.body.classList.remove('game-paused');
    if (!isTutorialMatch) {
        isTutorialActive = false;
    }
    if (pauseMenu) {
        pauseMenu.classList.add('hidden');
        pauseMenu.style.display = 'none';
    }
    const readyBtn = document.getElementById('ready-btn');
    if (readyBtn) readyBtn.textContent = "READY";
    const indicator = document.getElementById('self-ready');
    if (indicator) { indicator.textContent = "NOT READY"; indicator.classList.remove('is-ready'); }

    const startTutorialOverlay = tutorialAllowsPractice();
    if (tutorialAllowsPractice()) {
        if (tutorialStep < TUTORIAL_FINAL_STEP) {
            gameState = 'PLAYING';
            gameHasStarted = true;
            countdownValue = 3;
            countdownTicks = 0;
        } else if (tutorialFightWaitingForStart) {
            gameState = 'TUTORIAL_WAIT';
            gameHasStarted = false;
            countdownValue = 3;
            countdownTicks = 0;
        } else {
            gameState = 'COUNTDOWN';
            gameHasStarted = false;
            countdownValue = 3;
            countdownTicks = 0;
        }
    } else if (!startTutorialOverlay) {
        gameState = 'COUNTDOWN';
        gameHasStarted = false;
        countdownValue = 3;
        countdownTicks = 0;
    }
    keys = {};
    clearRoundEndTimer();
    roundOutcomeScored = false;
    // Fresh empty 9-board map + newly randomized checkpoints every small round
    initWorldBoards();

    const allSkillIds = SKILL_DATA.map(s => s.id);
    const pickAISkill = (difficulty) => (typeof selectAISkillForDifficulty === 'function'
        ? selectAISkillForDifficulty(difficulty)
        : allSkillIds[Math.floor(Math.random() * allSkillIds.length)]);
    const pickAIJokers = (skillId, difficulty) => {
        if (typeof selectAIJokersForSkill === 'function') {
            return selectAIJokersForSkill(skillId, difficulty);
        }
        const jokerIds = JOKER_DATA.map(j => j.id);
        const picked = [];
        while (picked.length < 2) {
            const jokerId = jokerIds[Math.floor(Math.random() * jokerIds.length)];
            if (!picked.includes(jokerId)) picked.push(jokerId);
        }
        return picked;
    };
    const pickBestLoadout = (difficulty, rank = 0) => {
        if (typeof selectBestAILoadout === 'function') {
            const effectiveRank = difficulty === 'invincible'
                ? (typeof matchesPlayed === 'number' ? matchesPlayed : 0) + rank
                : rank;
            return selectBestAILoadout(difficulty, effectiveRank);
        }
        return {
            skill: pickAISkill(difficulty),
            jokers: pickAIJokers(null, difficulty)
        };
    };
    
    // Determine colors and skills for this match set
    if (p1Score === 0 && p2Score === 0) {
        // Human P1 settings
        p1MatchColor = neonColors[currentColorIndex] || '#ff2d55';
        
        if (isSpectateMode) {
            // Spectate: invincible AI vs invincible AI — never same / near-same colour
            const cols = pickDistinctSpectateColors(
                neonColors[currentColorIndex] // also avoid player's last cube colour
            );
            p1MatchColor = cols.p1;
            p2MatchColor = cols.p2;
            
            if (currentGamemode !== 'simplistic') {
                // Fresh fair bag each match so skill odds stay equal over time
                if (typeof resetEliteSkillDealBag === 'function') resetEliteSkillDealBag();
                const load1 = pickBestLoadout('invincible', 0);
                const load2 = pickBestLoadout('invincible', 1);
                p1SelectedSkillForMatch = load1.skill;
                p2SelectedSkillForMatch = load2.skill;
                // Match-only — do NOT touch p1SelectedJoker (player's saved loadout)
                p1MatchJokers = [...load1.jokers];
                p2MatchJokers = [...load2.jokers];
                if (trailerSpectateLaser) {
                    p1SelectedSkillForMatch = 'laser';
                    p2SelectedSkillForMatch = 'laser';
                    // Trailer demo — still no border-safe crutch
                    p1MatchJokers = ['extra-life', 'friend-blocks'];
                    p2MatchJokers = ['extra-life', 'rage-joker'];
                }
            } else {
                p1SelectedSkillForMatch = null;
                p2SelectedSkillForMatch = null;
                p1MatchJokers = [];
                p2MatchJokers = [];
            }
        } else {
            // Human vs AI or Local Multiplayer
            if (currentGamemode !== 'simplistic') {
                sanitizeStoredLoadout();
                const playerLoadout = resolvePlayerMatchLoadout(allSkillIds);
                p1SelectedSkillForMatch = playerLoadout.skill;
                p1SelectedJoker = Array.isArray(playerLoadout.jokers) ? [...playerLoadout.jokers] : [];
                p1MatchJokers = [...p1SelectedJoker];
            } else {
                p1SelectedSkillForMatch = null;
                p1MatchJokers = [];
            }

            const p2IsAI = !isMultiplayer;
            if (p2IsAI) {
                p2MatchColor = getBotMatchColor(p1MatchColor);
                if (p2MatchColor.toLowerCase() === (p1MatchColor || '').toLowerCase()) {
                    p2MatchColor = getBotMatchColor(p2MatchColor);
                }
                if (currentGamemode !== 'simplistic') {
                    if (currentBotDifficulty === 'invincible'
                        && typeof resetEliteSkillDealBag === 'function') {
                        resetEliteSkillDealBag();
                    }
                    const load = pickBestLoadout(currentBotDifficulty, 0);
                    p2SelectedSkillForMatch = load.skill;
                    p2SelectedJoker = [...load.jokers];
                    p2MatchJokers = [...load.jokers];
                } else {
                    p2SelectedSkillForMatch = null;
                    p2MatchJokers = [];
                }
            } else if (isOnline) {
                p2MatchColor = enemyColor || getBotMatchColor(p1MatchColor);
                if (currentGamemode !== 'simplistic') {
                    p2SelectedSkillForMatch = enemySelectedSkill || pickRandomUnlockedSkill();
                    p2SelectedJoker = Array.isArray(enemySelectedJokers) && enemySelectedJokers.length
                        ? [...enemySelectedJokers]
                        : pickRandomUnlockedJokers(2);
                    p2MatchJokers = [...p2SelectedJoker];
                } else {
                    p2SelectedSkillForMatch = null;
                    p2SelectedJoker = [];
                    p2MatchJokers = [];
                }
                // Guest is the right-side cube. Keep saved p1SelectedJoker as THIS player's kit.
                if (onlineRole === 'guest') {
                    const localColor = p1MatchColor;
                    const localSkill = p1SelectedSkillForMatch;
                    const localJokers = Array.isArray(p1SelectedJoker) ? [...p1SelectedJoker] : [...(p1MatchJokers || [])];
                    p1MatchColor = enemyColor || p2MatchColor || getBotMatchColor(localColor);
                    p2MatchColor = localColor;
                    p1SelectedSkillForMatch = enemySelectedSkill || p2SelectedSkillForMatch;
                    p2SelectedSkillForMatch = localSkill;
                    p1MatchJokers = Array.isArray(enemySelectedJokers) && enemySelectedJokers.length
                        ? [...enemySelectedJokers]
                        : [...(p2MatchJokers || [])];
                    p2MatchJokers = localJokers;
                    p2SelectedJoker = [...p2MatchJokers];
                }
            } else if (isMultiplayer && !isOnline) {
                let savedP2ColorIdx = parseInt(localStorage.getItem('ronk_p2_colorIndex'), 10);
                if (!Number.isFinite(savedP2ColorIdx) || savedP2ColorIdx < 0 || savedP2ColorIdx >= neonColors.length) {
                    savedP2ColorIdx = (neonColors.indexOf(p1MatchColor) + 1 + neonColors.length) % Math.max(1, neonColors.length - 1);
                }
                p2MatchColor = neonColors[savedP2ColorIdx] || getBotMatchColor(p1MatchColor);
                if ((p2MatchColor || '').toLowerCase() === (p1MatchColor || '').toLowerCase()
                    && savedP2ColorIdx < neonColors.length - 1) {
                    const nextIdx = (savedP2ColorIdx + 1) % Math.max(1, neonColors.length - 1);
                    p2MatchColor = neonColors[nextIdx];
                }
                if (currentGamemode !== 'simplistic') {
                    const savedSkill = localStorage.getItem('ronk_p2_selectedSkill');
                    p2SelectedSkillForMatch = (savedSkill && isSkillUnlocked(savedSkill))
                        ? savedSkill
                        : pickRandomUnlockedSkill();
                    try {
                        const raw = JSON.parse(localStorage.getItem('ronk_p2_selectedJoker') || '[]');
                        p2SelectedJoker = (Array.isArray(raw) ? raw : []).filter((id) => isJokerUnlocked(id)).slice(0, 2);
                    } catch (_) {
                        p2SelectedJoker = [];
                    }
                    if (!p2SelectedJoker.length) p2SelectedJoker = pickRandomUnlockedJokers(2);
                    p2MatchJokers = [...p2SelectedJoker];
                } else {
                    p2SelectedSkillForMatch = null;
                    p2SelectedJoker = [];
                    p2MatchJokers = [];
                }
            } else {
                p2MatchColor = getBotMatchColor(p1MatchColor);
                p2SelectedSkillForMatch = currentGamemode !== 'simplistic' ? allSkillIds[Math.floor(Math.random() * allSkillIds.length)] : null;
            }
        }
    }

    // Start on middle board — opposite edges, offset lanes so auto-slide doesn't head-on KO
    const { ox, oy } = middleBoardOrigin();
    const midY = oy + Math.floor(GRID_COUNT / 2);
    let p1StartX = ox + 1, p1StartY = midY - 1;
    let p2StartX = ox + GRID_COUNT - 2, p2StartY = midY + 1;

    // --- GAMEMODE SETTINGS ---
    if (currentGamemode === 'simplistic') {
        // In simplistic mode: disable only jokers and skills (keep dash, charge, and hunger)
        p1SelectedJoker = [];
        p2SelectedJoker = [];
        p1SelectedSkillForMatch = null;
        p2SelectedSkillForMatch = null;
        apples = []; // Reset apples
    } else if (isTutorialMatch) {
        stripTutorialLoadouts();
        apples = [];
    } else {
        // Normal mode: reset apples
        apples = [];
    }
    
    // --- RESET SPECIAL SKILLS ---
    clones = [];
    laserLines = [];
    friendWalls = [];
    appleSpawnTimer = 0;
    if (typeof clearPlayerTrailState === 'function') {
        if (p1) clearPlayerTrailState(p1);
        if (p2) clearPlayerTrailState(p2);
    }
    // Spawn match apples (tutorial practice spawns apples on the hunger step only)
    if (!isTutorialMatch) {
        spawnMatchApples();
    }

    // Get custom controls from localStorage
    const getCustomControls = () => {
        const savedControls = JSON.parse(localStorage.getItem('ronk_controls') || '{}');
        return {
            up: (savedControls.up || 'w').toLowerCase(),
            down: (savedControls.down || 's').toLowerCase(),
            left: (savedControls.left || 'a').toLowerCase(),
            right: (savedControls.right || 'd').toLowerCase(),
            dash: (savedControls.dash || 'f').toLowerCase(),
            charge: (savedControls.charge || 'c').toLowerCase()
        };
    };

    // If spectating, p2 MUST be AI regardless of multiplayer flag
    const p2IsAI = isSpectateMode ? true : (isMultiplayer ? false : true);
    const p2Controls = { up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', dash: 'enter', charge: 'shift', skill: 'control' };
    const reusePlayers = alreadyInGame && p1 && p2 && !p1.isClone && !p2.isClone
        && p1.id === 1 && p2.id === 2 && typeof p1.resetForNewRound === 'function';
    if (reusePlayers) {
        p1.resetForNewRound(p1StartX, p1StartY, p1MatchColor, getCustomControls(), isSpectateMode);
        p2.resetForNewRound(p2StartX, p2StartY, p2MatchColor, p2Controls, p2IsAI);
    } else {
        p1 = new Player(p1StartX, p1StartY, p1MatchColor, getCustomControls(), 1, isSpectateMode);
        p2 = new Player(p2StartX, p2StartY, p2MatchColor, p2Controls, 2, p2IsAI);
    }
    p1._revived = false;
    p1.boardSx = MIDDLE_BOARD_SX;
    p1.boardSy = MIDDLE_BOARD_SY;
    
    // Assign match skill to p1
    p1.selectedSkill = p1SelectedSkillForMatch;
    
    p2._revived = false;
    p2.boardSx = MIDDLE_BOARD_SX;
    p2.boardSy = MIDDLE_BOARD_SY;
    
    // Assign match skill to p2
    p2.selectedSkill = p2SelectedSkillForMatch;
    if (isSpectateMode) {
        p1.isAI = true;
        p2.isAI = true;
        p1.aiDifficulty = 'invincible';
        p2.aiDifficulty = 'invincible';
    } else if (p2IsAI) {
        p2.aiDifficulty = currentBotDifficulty;
    }
    if (typeof assignMainAIPlaybook === 'function') {
        if (p1?.isAI) assignMainAIPlaybook(p1, p1.aiDifficulty || 'invincible');
        if (p2?.isAI) assignMainAIPlaybook(p2, p2.aiDifficulty || currentBotDifficulty);
    }
    if (isOnline && onlineRole) {
        if (onlineRole === 'host') { p2.isAI = false; p1.isAI = false; syncSettings(); }
        else { p1.isAI = false; p2.isAI = false; }
        if (onlineRole === 'guest' && p2) {
            p2.controls = getCustomControls();
        }
        const localCube = onlineRole === 'guest' ? p2 : p1;
        const remoteCube = onlineRole === 'guest' ? p1 : p2;
        if (localCube && playerImage && currentColorIndex === neonColors.length - 1) {
            localCube.customImage = playerImage;
        }
        if (remoteCube && enemyImage) {
            loadPeerCustomImage(enemyImage, (img) => {
                if (remoteCube) remoteCube.customImage = img;
            });
        }
    } else if (isMultiplayer && !isOnline) {
        if (p1 && playerImage && currentColorIndex === neonColors.length - 1) {
            p1.customImage = playerImage;
        }
        const p2Idx = parseInt(localStorage.getItem('ronk_p2_colorIndex'), 10);
        if (p2 && playerImageP2 && p2Idx === neonColors.length - 1) {
            p2.customImage = playerImageP2;
        }
    }
    
    // Reset move buffers
    p1.moveBuffer = [];
    if (p2) {
        p2.moveBuffer = [];
        p2.aiThinkTicks = 0;
    }
    if (p1) p1.aiThinkTicks = 0;
    if (p1) p1._skillsUsed = 0;
    if (p2) p2._skillsUsed = 0;

    const spawnDirToward = (sx, sy, tx, ty) => {
        if (sx < tx) return { x: 1, y: 0 };
        if (sx > tx) return { x: -1, y: 0 };
        if (sy < ty) return { x: 0, y: 1 };
        return { x: 0, y: -1 };
    };

    p1.dir = spawnDirToward(p1StartX, p1StartY, p2StartX, p2StartY);
    p2.dir = spawnDirToward(p2StartX, p2StartY, p1StartX, p1StartY);
    
    // --- RESET JOKER PROPERTIES BEFORE APPLYING ---
    // Reset all joker-related properties for both players
    p1.jokerChargeBonus = 0;
    p1.jokerCooldownReduce = 1;
    p1.jokerNoHunger = false;
    p1.jokerTrailGrowth = false;
    p1.jokerTrailGrowthRate = 1;
    p1.jokerDashNoCooldown = false;
    p1.jokerDashBonus = 0;
    p1.jokerBorderSafe = false;
    p1.jokerDoubleEffective = false;
    p1.hasExtraLife = false;
    p1.extraLives = 1;
    p1.usedExtraLife = false;
    
    p2.jokerChargeBonus = 0;
    p2.jokerCooldownReduce = 1;
    p2.jokerNoHunger = false;
    p2.jokerTrailGrowth = false;
    p2.jokerTrailGrowthRate = 1;
    p2.jokerDashNoCooldown = false;
    p2.jokerDashBonus = 0;
    p2.jokerBorderSafe = false;
    p2.jokerDoubleEffective = false;
    p2.hasExtraLife = false;
    p2.extraLives = 1;
    p2.usedExtraLife = false;
    
    // --- APPLY JOKER EFFECTS ---
    function applyJokerEffects() {
        const jokerIds = JOKER_DATA.map(j => j.id);
        const prevP1Jokers = JSON.stringify(p1SelectedJoker);
        const prevP2Jokers = JSON.stringify(p2SelectedJoker);
        
        // CRITICAL: Prevent joker SELECTION from being changed during the game
        // But effects MUST be applied every round (they reset player stats)
        
        // Only block joker SELECTION changes, not effect application
        // Joker effects need to be applied EVERY round to reset player stats!
        const isMatchInProgress = p1Score > 0 || p2Score > 0;
        const shouldBlockSelection = (typeof gameHasStarted !== 'undefined' && gameHasStarted) || isMatchInProgress;
        
        if (shouldBlockSelection) {
        } else {
        }
        
        // Make WORKING COPIES of the jokers so we never modify the original arrays!
        // Spectate uses p1MatchJokers/p2MatchJokers so the player's saved kit stays untouched.
        let p1Jokers = isSpectateMode
            ? (Array.isArray(p1MatchJokers) ? [...p1MatchJokers] : [])
            : (Array.isArray(p1SelectedJoker) ? [...p1SelectedJoker] : (p1SelectedJoker ? [p1SelectedJoker] : []));
        let p2Jokers = isSpectateMode
            ? (Array.isArray(p2MatchJokers) ? [...p2MatchJokers] : [])
            : (Array.isArray(p2SelectedJoker) ? [...p2SelectedJoker] : (p2SelectedJoker ? [p2SelectedJoker] : []));
        
        // Load p1's jokers from player selection only when the human is P1 (not spectate / not online guest)
        if (!isSpectateMode && !(isOnline && onlineRole === 'guest')) {
            p1Jokers = Array.isArray(p1SelectedJoker) ? [...p1SelectedJoker] : [];
            if (shouldEnforceUnlockLocks()) {
                p1Jokers = p1Jokers.filter(id => isJokerUnlocked(id));
                p1SelectedJoker = [...p1Jokers];
                p1MatchJokers = [...p1Jokers];
            } else if (isTutorialMatch) {
                p1Jokers = Array.isArray(p1SelectedJoker) ? [...p1SelectedJoker] : [];
            }
        }
        
        const isMatchStart = p1Score === 0 && p2Score === 0;
        const isRoundStart = p1.isDead || p2.isDead;
        
        if (isMatchStart) {
            if (isTutorialBareMatch()) {
                p1Jokers = [];
                p2Jokers = [];
                p1MatchJokers = [];
                p2MatchJokers = [];
                p1SelectedSkillForMatch = null;
                p2SelectedSkillForMatch = null;
            } else if (currentGamemode !== 'simplistic') {
                if (isSpectateMode) {
                    // Keep using match kits only — never rewrite p1SelectedJoker
                    if (!p1MatchJokers.length) {
                        p1MatchJokers = [...pickBestLoadout('invincible', 0).jokers];
                    }
                    if (!p2MatchJokers.length) {
                        p2MatchJokers = [...pickBestLoadout('invincible', 1).jokers];
                    }
                    p1Jokers = [...p1MatchJokers];
                    p2Jokers = [...p2MatchJokers];
                } else {
                    // P1 is player — invincible gets curated combos; easy/medium/hard get random loadouts
                    p2Jokers = [];
                    if (Array.isArray(p2SelectedJoker) && p2SelectedJoker.length) {
                        p2Jokers = [...p2SelectedJoker];
                    } else if (Array.isArray(p2MatchJokers) && p2MatchJokers.length) {
                        p2Jokers = [...p2MatchJokers];
                    } else {
                        const load = pickBestLoadout(currentBotDifficulty, 0);
                        p2Jokers = [...load.jokers];
                        if (!p2SelectedSkillForMatch) p2SelectedSkillForMatch = load.skill;
                    }
                    p2SelectedJoker = [...p2Jokers];
                    p2MatchJokers = [...p2Jokers];
                    if (!(isOnline && onlineRole === 'guest')) {
                        p1MatchJokers = Array.isArray(p1SelectedJoker) ? [...p1SelectedJoker] : [];
                    }
                }
            } else {
                p1Jokers = [];
                p2Jokers = [];
            }
        }
        
        // Ensure p2SelectedJoker is set if not already (for non-spectate mode where it's not set above)
        // Only assign jokers in normal mode (not simplistic)
        if ((!p2SelectedJoker || !Array.isArray(p2SelectedJoker) || p2SelectedJoker.length === 0)
            && currentGamemode !== 'simplistic' && !isTutorialBareMatch()) {
            if (!isMultiplayer) {
                const load = pickBestLoadout(currentBotDifficulty, 0);
                p2SelectedJoker = [...load.jokers];
                if (!p2SelectedSkillForMatch) p2SelectedSkillForMatch = load.skill;
            } else {
                p2SelectedJoker = pickRandomUnlockedJokers(2);
            }
            p2Jokers = [...p2SelectedJoker];
        }
        
        // Safety check: empty persistent kit is fine — never overwrite spectate match kits
        if (isOnline && onlineRole === 'guest' && !isSpectateMode) {
            p1Jokers = Array.isArray(p1MatchJokers) ? [...p1MatchJokers] : normalizeJokerIds(enemySelectedJokers);
            p2Jokers = Array.isArray(p1SelectedJoker) ? [...p1SelectedJoker] : [];
            p2MatchJokers = [...p2Jokers];
        } else if (!isSpectateMode) {
            if (!p1SelectedJoker || !Array.isArray(p1SelectedJoker) || p1SelectedJoker.length === 0) {
                p1SelectedJoker = [];
                p1Jokers = [];
            } else {
                p1Jokers = [...p1SelectedJoker];
            }
        } else {
            p1Jokers = Array.isArray(p1MatchJokers) ? [...p1MatchJokers] : [];
            p2Jokers = Array.isArray(p2MatchJokers) ? [...p2MatchJokers] : [];
        }
        
        // Apply jokers in correct order:
        // 1. First, determine which jokers are disabled by DISABLE
        // 2. Second, apply all joker effects (excluding those that were disabled)
        // This ensures DISABLE actually works!
        
        // Make WORKING COPIES for effect application so the original selections stay intact!
        let p1JokersForEffect = [...p1Jokers];
        let p2JokersForEffect = [...p2Jokers];

        // AI never gets border-safe — edge survival is learned movement, not a joker
        const stripAiBorderSafe = (list) => (Array.isArray(list) ? list.filter((id) => id !== 'border-safe') : []);
        if (isSpectateMode || (p1 && p1.isAI)) {
            p1JokersForEffect = stripAiBorderSafe(p1JokersForEffect);
            if (isSpectateMode) p1MatchJokers = stripAiBorderSafe(p1MatchJokers);
        }
        if (isSpectateMode || (p2 && p2.isAI) || !isMultiplayer) {
            p2JokersForEffect = stripAiBorderSafe(p2JokersForEffect);
            p2MatchJokers = stripAiBorderSafe(p2MatchJokers);
            if (Array.isArray(p2SelectedJoker)) {
                p2SelectedJoker = stripAiBorderSafe(p2SelectedJoker);
            }
        }
        p1DisabledJokers = [];
        p2DisabledJokers = [];
        
        // PRE-PASS: Handle DISABLE jokers FIRST (before applying any effects)
        // P2's DISABLE affects P1's jokers
        const p2HasDisable = p2Jokers.includes('disable-enemy');
        const p1HasDisable = p1Jokers.includes('disable-enemy');
        
        if (p2HasDisable && p1JokersForEffect.length > 0) {
            // Only disable non-DISABLE jokers when possible
            const candidates = p1JokersForEffect.filter((id) => id !== 'disable-enemy');
            const pool = candidates.length ? candidates : p1JokersForEffect;
            const disabledJoker = pickDisabledJokerId(pool, 'p2-disable-p1');
            if (disabledJoker) {
                p1DisabledJokers.push(disabledJoker);
                p1JokersForEffect = p1JokersForEffect.filter((id) => id !== disabledJoker);
            }
        }
        
        if (p1HasDisable && p2JokersForEffect.length > 0) {
            const candidates = p2JokersForEffect.filter((id) => id !== 'disable-enemy');
            const pool = candidates.length ? candidates : p2JokersForEffect;
            const disabledJoker = pickDisabledJokerId(pool, 'p1-disable-p2');
            if (disabledJoker) {
                p2DisabledJokers.push(disabledJoker);
                p2JokersForEffect = p2JokersForEffect.filter((id) => id !== disabledJoker);
            }
        }

        // Trail growth does nothing with Infinite Trails (already infinite)
        if (p1.selectedSkill === SKILL_TYPES.INFINITE_TRAILS || p1SelectedSkillForMatch === 'infinite-trails') {
            p1JokersForEffect = p1JokersForEffect.filter((id) => id !== 'trail-growth');
        }
        if (p2.selectedSkill === SKILL_TYPES.INFINITE_TRAILS || p2SelectedSkillForMatch === 'infinite-trails') {
            p2JokersForEffect = p2JokersForEffect.filter((id) => id !== 'trail-growth');
        }
        
        // Now apply all remaining joker effects (DISABLE has already removed the jokers to disable)
        // P1 joker effects
        p1JokersForEffect.forEach(joker => {
            if (joker === 'charge-plus') {
                p1.jokerChargeBonus = 2;
            } else if (joker === 'no-hunger') {
                p1.jokerNoHunger = true;
            } else if (joker === 'rage-joker') {
                p1.jokerCooldownReduce = 0.5; // 50% cooldown reduction
            } else if (joker === 'dash-cooldown') {
                p1.jokerDashNoCooldown = true;
            } else if (joker === 'border-safe') {
                p1.jokerBorderSafe = true;
            } else if (joker === 'double-effective') {
                p1.jokerDoubleEffective = true;
            } else if (joker === 'trail-growth') {
                p1.jokerTrailGrowth = true;
            } else if (joker === 'extra-life') {
                p1.hasExtraLife = true;
                p1.extraLives = 1;
            }
        });
        
        // P2 joker effects
        p2JokersForEffect.forEach(joker => {
            if (joker === 'charge-plus') {
                p2.jokerChargeBonus = 2;
            } else if (joker === 'no-hunger') {
                p2.jokerNoHunger = true;
            } else if (joker === 'rage-joker') {
                p2.jokerCooldownReduce = 0.5; // 50% cooldown reduction
            } else if (joker === 'dash-cooldown') {
                p2.jokerDashNoCooldown = true;
            } else if (joker === 'border-safe') {
                p2.jokerBorderSafe = true;
            } else if (joker === 'double-effective') {
                p2.jokerDoubleEffective = true;
            } else if (joker === 'trail-growth') {
                p2.jokerTrailGrowth = true;
            } else if (joker === 'extra-life') {
                p2.hasExtraLife = true;
                p2.extraLives = 1;
            }
        });
        
        // DOUBLE EFFECTIVE enhancement pass (after all jokers are applied)
        // If P1 has double-effective, enhance their other jokers
        if (p1.jokerDoubleEffective) {
            if (p1JokersForEffect.includes('rage-joker')) {
                p1.jokerCooldownReduce = 0.25; // 75% cooldown reduction instead of 50%
            }
            if (p1JokersForEffect.includes('trail-growth')) {
                p1.jokerTrailGrowthRate = 2; // Double growth rate
            }
            if (p1JokersForEffect.includes('extra-life')) {
                p1.extraLives = 2; // 2 extra lives instead of 1!
            }
            if (p1JokersForEffect.includes('charge-plus')) {
                p1.jokerChargeBonus = 4; // +4 grids instead of +2
            }
            if (p1JokersForEffect.includes('dash-cooldown')) {
                p1.jokerDashBonus = 2; // 6-tile dash instead of 4
            }
        }
        
        // If P2 has double-effective, enhance their other jokers
        if (p2.jokerDoubleEffective) {
            if (p2JokersForEffect.includes('rage-joker')) {
                p2.jokerCooldownReduce = 0.25; // 75% cooldown reduction instead of 50%
            }
            if (p2JokersForEffect.includes('trail-growth')) {
                p2.jokerTrailGrowthRate = 2; // Double growth rate
            }
            if (p2JokersForEffect.includes('extra-life')) {
                p2.extraLives = 2; // 2 extra lives instead of 1!
            }
            if (p2JokersForEffect.includes('charge-plus')) {
                p2.jokerChargeBonus = 4;
            }
            if (p2JokersForEffect.includes('dash-cooldown')) {
                p2.jokerDashBonus = 2;
            }
        }
        
        // FRIEND WALLS: Spawn friend walls (after double-effective is determined)
        // Manhattan ≥ 6 from owners + clones on the owner's board only
        const wallTooCloseToSpawn = (x, y, owner) => {
            const minManhattan = 6;
            const near = (ent) => {
                if (!ent || ent.isDead) return false;
                if (typeof sameBoardCoords === 'function' && !sameBoardCoords(ent, owner)) return false;
                const ex = Math.floor(Number(ent.x));
                const ey = Math.floor(Number(ent.y));
                return Math.abs(x - ex) + Math.abs(y - ey) < minManhattan;
            };
            if (near(p1) || near(p2)) return true;
            if (typeof clones !== 'undefined' && Array.isArray(clones)) {
                for (let i = 0; i < clones.length; i++) {
                    if (near(clones[i])) return true;
                }
            }
            return false;
        };
        const trySpawnFriendWall = (owner) => {
            let x, y;
            let attempts = 0;
            let ok = false;
            do {
                x = Math.floor(Math.random() * GRID_COUNT);
                y = Math.floor(Math.random() * GRID_COUNT);
                attempts++;
                ok = !isOccupied(x, y, null, owner.boardSx, owner.boardSy) && !wallTooCloseToSpawn(x, y, owner);
            } while (attempts < 120 && !ok);
            if (!ok) return; // never place a bad wall after exhausted attempts
            friendWalls.push({
                x, y, owner,
                ownerId: getPlayerBaseId(owner.id),
                boardSx: owner.boardSx, boardSy: owner.boardSy
            });
        };
        if (p1JokersForEffect.includes('friend-blocks')) {
            const p1WallCount = p1.jokerDoubleEffective ? 4 : 2;
            for (let i = 0; i < p1WallCount; i++) trySpawnFriendWall(p1);
        }
        
        if (p2JokersForEffect.includes('friend-blocks')) {
            const p2WallCount = p2.jokerDoubleEffective ? 4 : 2;
            for (let i = 0; i < p2WallCount; i++) trySpawnFriendWall(p2);
        }
        
        // Show full selected loadout; disabled jokers stay visible but grayed in HUD
        p1DisplayJokers = [...p1Jokers];
        p2DisplayJokers = [...p2Jokers];
        p1.activeJokers = [...p1JokersForEffect];
        p2.activeJokers = [...p2JokersForEffect];
        lastP1JokersKey = '';
        lastP2JokersKey = '';
    }
    
    applyJokerEffects();
    applyPassiveSkillLoadout(p1);
    applyPassiveSkillLoadout(p2);

    if (p1) {
        p1._spawnGraceTicks = 0;
        p1.hungerTimer = 0;
    }
    if (p2) {
        p2._spawnGraceTicks = 0;
        p2.hungerTimer = 0;
    }

    // Announce equipped jokers once at match start (spectate AI kits are the main ask)
    if (p1Score === 0 && p2Score === 0 && !isTutorialBareMatch() && currentGamemode !== 'simplistic') {
        if (typeof notifyJokerLoadoutInMatch === 'function') {
            if (isSpectateMode) {
                notifyJokerLoadoutInMatch(p1, p1MatchJokers);
                notifyJokerLoadoutInMatch(p2, p2MatchJokers);
            } else if (p2 && p2.isAI) {
                notifyJokerLoadoutInMatch(p2, p2MatchJokers.length ? p2MatchJokers : p2SelectedJoker);
            }
        }
    }

    if (isTutorialBareMatch()) {
        stripTutorialLoadouts();
        if (p1) {
            p1.selectedSkill = null;
            p1.activeJokers = [];
        }
        if (p2) {
            p2.selectedSkill = null;
            p2.activeJokers = [];
        }
        p1DisplayJokers = [];
        p2DisplayJokers = [];
        p1DisabledJokers = [];
        p2DisabledJokers = [];
    }

    if (p1Score === 0 && p2Score === 0 && !isSpectateMode && !isTutorialBareMatch()) {
        captureOpponentLoadoutForUnlock();
    } else if (opponentLoadoutForUnlock) {
        lastOpponentLoadout = getOpponentLoadoutSnapshot();
    }

    if (!tutorialAllowsPractice()) {
        hideTutorialOverlay();
    }

    if (tutorialAllowsPractice()) {
        if (tutorialStep < TUTORIAL_FINAL_STEP) {
            tutorialPracticeActive = true;
            showTutorialPanel();
        } else if (tutorialFightWaitingForStart) {
            tutorialPracticeActive = false;
            gameState = 'TUTORIAL_WAIT';
            showTutorialFightBrief();
        } else {
            tutorialPracticeActive = false;
        }
        isTutorialActive = true;
    }

    if (p2) p2.tutorialFrozen = isTutorialPracticePhase() || tutorialFightWaitingForStart;

    if (isTutorialPracticePhase() && tutorialStep === 0) {
        applyTutorialStep0WaitForInput();
    }

    // Tutorial bot match (step 6+): spawn apples every round — initGame skips them for practice steps
    if (isTutorialMatch && isTutorialFightPhase() && !tutorialFightWaitingForStart) {
        spawnMatchApples();
    }

    // Update Scoreboard UI immediately
    updateScoreboard();

    if (gameOverDiv) gameOverDiv.classList.add('hidden');
    if (gameOverHintEl) {
        gameOverHintEl.textContent = '';
        gameOverHintEl.classList.add('hidden');
    }
    if (roundAnnouncerEl) roundAnnouncerEl.classList.add('hidden');

    // Hide HUDs initially for countdown
    if (p1HudEl) p1HudEl.classList.remove('visible');
    if (p2HudEl) p2HudEl.classList.remove('visible');

    updateScoreboard();
    updateCooldownUI();
    syncTutorialHudVisibility();
    if (!alreadyInGame) {
        resizeCanvas();
        prerenderGrid();
    } else {
        updateProjectConstants();
    }

    syncGamepadPlayerBindings();

    lastFrameTime = performance.now();
    accumulator = 0;
    if (!animLoop) {
        animate(lastFrameTime);
    }
}

function syncTutorialHudVisibility() {
    const strip = isTutorialMatch;
    const skillPractice = isTutorialPracticePhase() && tutorialStep === 6;
    const showBoardLesson = typeof isTutorialMapStep === 'function' && isTutorialMapStep();
    const showScoreboardLesson = typeof isTutorialScoreboardLessonStep === 'function' && isTutorialScoreboardLessonStep();
    const hideScoreboard = tutorialAllowsPractice()
        && ((isTutorialPracticePhase() && !showScoreboardLesson) || isTutorialFightWaiting());
    document.body.classList.toggle('tutorial-board-lesson', !!(showBoardLesson && isTutorialPracticePhase()));
    const scoreboardEl = document.getElementById('scoreboard-container');
    if (scoreboardEl) scoreboardEl.style.display = hideScoreboard ? 'none' : '';
    const boardHudEl = document.getElementById('board-ownership-hud');
    if (boardHudEl) boardHudEl.style.display = (hideScoreboard && !showBoardLesson) ? 'none' : '';
    if (p1JokerContainer) p1JokerContainer.style.display = strip ? 'none' : '';
    if (p2JokerContainer) p2JokerContainer.style.display = strip ? 'none' : '';
    [p1SkillLetter, p2SkillLetter].forEach((el) => {
        if (el?.parentElement) el.parentElement.style.display = (strip && !skillPractice) ? 'none' : '';
    });
}

function updateScoreboard() {
    if (!p1ScoreEl) p1ScoreEl = document.getElementById('p1-score-val');
    if (!p2ScoreEl) p2ScoreEl = document.getElementById('p2-score-val');
    if (!p1NameTag) p1NameTag = document.getElementById('p1-name-tag');
    if (!p2NameTag) p2NameTag = document.getElementById('p2-name-tag');

    const target = typeof getEffectiveMatchTarget === 'function' ? getEffectiveMatchTarget() : 6;
    const targetEl = document.getElementById('score-match-target');
    if (targetEl) {
        const label = `FIRST TO ${target}`;
        if (targetEl.textContent !== label) targetEl.textContent = label;
        targetEl.setAttribute('title', `Win ${target} rounds to take the match`);
        targetEl.setAttribute('aria-label', `Match target: first to ${target}`);
    }

    const spectateHint = document.getElementById('spectate-cam-hint');
    if (spectateHint) {
        spectateHint.hidden = !isSpectateMode;
        spectateHint.style.display = isSpectateMode ? '' : 'none';
    }

    const p1Label = document.getElementById('score-p1-label');
    const p2Label = document.getElementById('score-p2-label');

    let p1Name = isSpectateMode ? 'AI 1' : (nickname || 'P1');
    let p2Name = 'RIVAL';
    if (isSpectateMode) p2Name = 'AI 2';
    else if (isMultiplayer && !isOnline) p2Name = 'P2';
    else if (isOnline) p2Name = enemyNickname || 'RIVAL';
    else p2Name = getRivalBotName();

    const modeBanner = document.getElementById('match-mode-banner');
    if (modeBanner) {
        const showBanner = document.body.classList.contains('theme-pinkcore');
        modeBanner.hidden = !showBanner;
        modeBanner.style.display = showBanner ? '' : 'none';
        if (showBanner) {
            let modeText = 'VS BOT';
            if (isSpectateMode) modeText = 'SPECTATE';
            else if (isOnline) modeText = 'ONLINE PVP';
            else if (isMultiplayer) modeText = 'LOCAL PVP · SAME SCREEN';
            if (modeBanner.textContent !== modeText) modeBanner.textContent = modeText;
            modeBanner.classList.toggle('is-online', !!isOnline);
            modeBanner.classList.toggle('is-local-pvp', !!(isMultiplayer && !isOnline));
            modeBanner.classList.toggle('is-bot', !isMultiplayer && !isOnline && !isSpectateMode);
        }
    }

    if (p1NameTag) {
        let fullP1 = isSpectateMode ? 'AI 1 (ELITE)' : (nickname || 'PLAYER 1');
        if (isMultiplayer && !isOnline) fullP1 = 'PLAYER 1';
        if (p1NameTag.textContent !== fullP1) p1NameTag.textContent = fullP1;
        if (p1 && p1NameTag.style.color !== p1.color) p1NameTag.style.color = p1.color;
    }
    if (p2NameTag) {
        let fullP2 = 'RIVAL';
        if (isSpectateMode) fullP2 = 'AI 2 (ELITE)';
        else if (isMultiplayer && !isOnline) fullP2 = 'PLAYER 2';
        else if (isOnline) fullP2 = enemyNickname || 'ONLINE RIVAL';
        else fullP2 = getRivalBotName();
        if (p2NameTag.textContent !== fullP2) p2NameTag.textContent = fullP2;
        if (p2 && p2NameTag.style.color !== p2.color) p2NameTag.style.color = p2.color;
    }

    if (p1Label) {
        if (p1Label.textContent !== p1Name) p1Label.textContent = p1Name;
        if (p1) p1Label.style.color = p1.color;
    }
    if (p2Label) {
        if (p2Label.textContent !== p2Name) p2Label.textContent = p2Name;
        if (p2) p2Label.style.color = p2.color;
    }

    const p1ScoreStr = String(p1Score);
    if (p1ScoreEl) { 
        if (p1ScoreEl.textContent !== p1ScoreStr) {
            p1ScoreEl.textContent = p1ScoreStr;
            p1ScoreEl.classList.remove('score-pop');
            void p1ScoreEl.offsetWidth;
            p1ScoreEl.classList.add('score-pop');
        }
        const p1Color = p1 ? p1.color : '#fff';
        if (p1ScoreEl.style.color !== p1Color) p1ScoreEl.style.color = p1Color;
    }
    const p2ScoreStr = String(p2Score);
    if (p2ScoreEl) { 
        if (p2ScoreEl.textContent !== p2ScoreStr) {
            p2ScoreEl.textContent = p2ScoreStr;
            p2ScoreEl.classList.remove('score-pop');
            void p2ScoreEl.offsetWidth;
            p2ScoreEl.classList.add('score-pop');
        }
        const p2Color = p2 ? p2.color : '#fff';
        if (p2ScoreEl.style.color !== p2Color) p2ScoreEl.style.color = p2Color;
    }

    const board = document.getElementById('scoreboard');
    if (board) {
        board.classList.toggle('score-p1-lead', p1Score > p2Score);
        board.classList.toggle('score-p2-lead', p2Score > p1Score);
        board.classList.toggle('score-tied', p1Score === p2Score);
    }
}

let offscreenGrid = null;
let lastGridCacheKey = '';

/** Draw board grid from a Path2D rebuilt only when size/theme change — same pixels, no extra canvas. */
function drawBoardGrid(targetCtx) {
    if (!targetCtx) return;
    const cacheKey = [
        viewW, viewH,
        cachedThemeColorKey,
        themeColors.boardFill || '',
        themeColors.gridColor || '',
        themeColors.borderColor || '',
        GRID_COUNT, GRID_SIZE,
        wantsFullThemeVisuals() ? 1 : 0,
        'maingridpath'
    ].join('|');
    if (!mainBoardGridCache || mainBoardGridCache.key !== cacheKey) {
        const prevX = projBoardOx;
        const prevY = projBoardOy;
        projBoardOx = 0;
        projBoardOy = 0;
        const boardDim = GRID_COUNT * GRID_SIZE;
        const fillPath = new Path2D();
        const c1 = project(0, 0, 0);
        const c2 = project(boardDim, 0, 0);
        const c3 = project(boardDim, boardDim, 0);
        const c4 = project(0, boardDim, 0);
        fillPath.moveTo(c1.x, c1.y);
        fillPath.lineTo(c2.x, c2.y);
        fillPath.lineTo(c3.x, c3.y);
        fillPath.lineTo(c4.x, c4.y);
        fillPath.closePath();
        const gridPath = new Path2D();
        const midI = GRID_COUNT / 2;
        for (let i = 0; i <= GRID_COUNT; i++) {
            if (i === midI) continue;
            const v1 = project(i * GRID_SIZE, 0, 0);
            const v2 = project(i * GRID_SIZE, boardDim, 0);
            gridPath.moveTo(v1.x, v1.y);
            gridPath.lineTo(v2.x, v2.y);
        }
        for (let j = 0; j <= GRID_COUNT; j++) {
            const h1 = project(0, j * GRID_SIZE, 0);
            const h2 = project(boardDim, j * GRID_SIZE, 0);
            gridPath.moveTo(h1.x, h1.y);
            gridPath.lineTo(h2.x, h2.y);
        }
        const borderPath = new Path2D();
        borderPath.moveTo(c1.x, c1.y);
        borderPath.lineTo(c2.x, c2.y);
        borderPath.lineTo(c3.x, c3.y);
        borderPath.lineTo(c4.x, c4.y);
        borderPath.closePath();
        const wbTheme = String(cachedThemeColorKey).startsWith('theme-white-black');
        const ronkTheme = String(cachedThemeColorKey).startsWith('theme-ronk');
        mainBoardGridCache = {
            key: cacheKey,
            fillPath,
            gridPath,
            borderPath,
            hasFill: !!themeColors.boardFill,
            fill: themeColors.boardFill || '',
            grid: themeColors.gridColor,
            border: themeColors.borderColor,
            borderW: wbTheme ? 5 : (ronkTheme ? 4.5 : 8),
            innerStroke: (!wbTheme && wantsFullThemeVisuals())
                ? (ronkTheme ? 'rgba(220, 90, 100, 0.35)' : 'rgba(255,255,255,0.35)')
                : '',
            innerW: ronkTheme ? 1.75 : 3
        };
        projBoardOx = prevX;
        projBoardOy = prevY;
    }
    const pack = mainBoardGridCache;
    targetCtx.save();
    targetCtx.lineJoin = 'round';
    targetCtx.lineCap = 'round';
    if (pack.hasFill) {
        targetCtx.fillStyle = pack.fill;
        targetCtx.fill(pack.fillPath);
    }
    targetCtx.strokeStyle = pack.grid;
    targetCtx.lineWidth = 1.35;
    targetCtx.stroke(pack.gridPath);
    targetCtx.strokeStyle = pack.border;
    targetCtx.lineWidth = pack.borderW;
    targetCtx.shadowBlur = 0;
    targetCtx.stroke(pack.borderPath);
    if (pack.innerStroke) {
        targetCtx.strokeStyle = pack.innerStroke;
        targetCtx.lineWidth = pack.innerW;
        targetCtx.stroke(pack.borderPath);
    }
    targetCtx.restore();
}

/** How many cells of each neighbor board to peek (spatial awareness without minimap). */
const NEIGHBOR_EDGE_CELLS = 5;
/** Visual gap between platforms — close, but clearly separated. */
const BOARD_PLATFORM_GAP = Math.round(GRID_SIZE * 2.25);

/**
 * Draw a local-rect strip of a board shifted by world offset (ox, oy).
 * Local coords are on the neighbor board: x0..x1, y0..y1 in world pixels.
 * Uses the SAME grid/fill/border as the main board (no alternate peek palette).
 */
function drawBoardGridRegion(targetCtx, ox, oy, x0, y0, x1, y1, opts = {}) {
    if (!targetCtx || x1 <= x0 || y1 <= y0) return;
    const fill = opts.fill !== undefined ? opts.fill : (themeColors.boardFill || '');
    const grid = opts.grid || themeColors.gridColor;
    const border = opts.border || themeColors.borderColor;
    const lineW = opts.lineWidth || 1.35;
    const borderW = opts.borderWidth || 4.5;

    const p = (lx, ly) => project(lx + ox, ly + oy, 0);

    if (fill) {
        const a = p(x0, y0);
        const b = p(x1, y0);
        const c = p(x1, y1);
        const d = p(x0, y1);
        targetCtx.beginPath();
        targetCtx.moveTo(a.x, a.y);
        targetCtx.lineTo(b.x, b.y);
        targetCtx.lineTo(c.x, c.y);
        targetCtx.lineTo(d.x, d.y);
        targetCtx.closePath();
        targetCtx.fillStyle = fill;
        targetCtx.fill();
    }

    targetCtx.strokeStyle = grid;
    targetCtx.lineWidth = lineW;
    targetCtx.beginPath();
    const i0 = Math.floor(x0 / GRID_SIZE);
    const i1 = Math.ceil(x1 / GRID_SIZE);
    const j0 = Math.floor(y0 / GRID_SIZE);
    const j1 = Math.ceil(y1 / GRID_SIZE);
    const midI = GRID_COUNT / 2;
    for (let i = i0; i <= i1; i++) {
        const x = i * GRID_SIZE;
        if (x < x0 - 0.5 || x > x1 + 0.5) continue;
        // Same camera-axis hairline on north/south peeks (ox === 0).
        if (ox === 0 && i === midI) continue;
        const v1 = p(x, y0);
        const v2 = p(x, y1);
        targetCtx.moveTo(v1.x, v1.y);
        targetCtx.lineTo(v2.x, v2.y);
    }
    for (let j = j0; j <= j1; j++) {
        const y = j * GRID_SIZE;
        if (y < y0 - 0.5 || y > y1 + 0.5) continue;
        const h1 = p(x0, y);
        const h2 = p(x1, y);
        targetCtx.moveTo(h1.x, h1.y);
        targetCtx.lineTo(h2.x, h2.y);
    }
    targetCtx.stroke();

    // Outer rim — same language as main board border
    targetCtx.strokeStyle = border;
    targetCtx.lineWidth = borderW;
    const a = p(x0, y0);
    const b = p(x1, y0);
    const c = p(x1, y1);
    const d = p(x0, y1);
    targetCtx.beginPath();
    targetCtx.moveTo(a.x, a.y);
    targetCtx.lineTo(b.x, b.y);
    targetCtx.lineTo(c.x, c.y);
    targetCtx.lineTo(d.x, d.y);
    targetCtx.closePath();
    targetCtx.stroke();
    if (opts.innerStroke) {
        targetCtx.strokeStyle = opts.innerStroke;
        targetCtx.lineWidth = opts.innerWidth || 1.75;
        targetCtx.stroke();
    }
}

/** Cached neighbor-board peeks — same look, redraw only when view/theme/size changes. */
let neighborPeekCache = null; // { key, canvas }

/**
 * Peek neighbor boards (no wrap). Same grid design as the main board.
 */
function drawNeighborBoardEdges(targetCtx) {
    if (!targetCtx || !worldBoards.length) return;
    if (typeof viewBoardSx !== 'number' || typeof viewBoardSy !== 'number') return;
    // Low gfx / hitchy devices: skip expensive full-buffer neighbor peek redraws
    if (isPerformanceMode()) return;
    updateThemeColors();
    const boardDim = GRID_COUNT * GRID_SIZE;
    const edge = NEIGHBOR_EDGE_CELLS * GRID_SIZE;
    const stride = boardDim + BOARD_PLATFORM_GAP;
    const wbTheme = String(cachedThemeColorKey).startsWith('theme-white-black');
    const ronkTheme = String(cachedThemeColorKey).startsWith('theme-ronk');
    const borderW = wbTheme ? 5 : (ronkTheme ? 4.5 : 8);
    const innerStroke = (!wbTheme && wantsFullThemeVisuals())
        ? (ronkTheme ? 'rgba(220, 90, 100, 0.35)' : 'rgba(255,255,255,0.35)')
        : '';
    const innerWidth = ronkTheme ? 1.75 : 3;
    const dpr = effectiveDpr || 1;
    // Quantize DPR so minor adaptive steps don't thrash the neighbor peek cache
    const dprQ = (Math.round(dpr * 4) / 4).toFixed(2);
    const cacheKey = [
        viewBoardSx, viewBoardSy, viewW, viewH, dprQ,
        cachedThemeColorKey, themeColors.boardFill || '', themeColors.gridColor || '',
        themeColors.borderColor || '', BOARD_PLATFORM_GAP, NEIGHBOR_EDGE_CELLS, borderW, innerStroke,
        'nocentergrid'
    ].join('|');

    const bufW = Math.max(1, Math.round(viewW * dpr));
    const bufH = Math.max(1, Math.round(viewH * dpr));
    if (!neighborPeekCache || neighborPeekCache.key !== cacheKey
        || neighborPeekCache.canvas.width !== bufW || neighborPeekCache.canvas.height !== bufH) {
        const off = (neighborPeekCache && neighborPeekCache.canvas) || document.createElement('canvas');
        off.width = bufW;
        off.height = bufH;
        const octx = off.getContext('2d');
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, bufW, bufH);
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        octx.lineJoin = 'round';
        octx.lineCap = 'round';
        octx.globalAlpha = 1;

        for (let ndx = -1; ndx <= 1; ndx++) {
            for (let ndy = -1; ndy <= 1; ndy++) {
                if (ndx === 0 && ndy === 0) continue;
                const nsx = viewBoardSx + ndx;
                const nsy = viewBoardSy + ndy;
                // Absolute 3×3 bounds — no toroidal wrap for peeks
                if (nsx < 0 || nsx >= BOARDS_PER_SIDE || nsy < 0 || nsy >= BOARDS_PER_SIDE) continue;

                const ox = ndx * stride;
                const oy = ndy * stride;

                let x0 = 0;
                let x1 = boardDim;
                let y0 = 0;
                let y1 = boardDim;

                if (ndx === 1) {
                    x0 = 0;
                    x1 = edge;
                } else if (ndx === -1) {
                    x0 = boardDim - edge;
                    x1 = boardDim;
                }
                if (ndy === 1) {
                    y0 = 0;
                    y1 = edge;
                } else if (ndy === -1) {
                    y0 = boardDim - edge;
                    y1 = boardDim;
                }

                drawBoardGridRegion(octx, ox, oy, x0, y0, x1, y1, {
                    fill: themeColors.boardFill || '',
                    grid: themeColors.gridColor,
                    border: themeColors.borderColor,
                    lineWidth: 1.35,
                    borderWidth: borderW,
                    innerStroke,
                    innerWidth
                });
            }
        }
        neighborPeekCache = { key: cacheKey, canvas: off };
    }

    targetCtx.save();
    // Draw in current ctx space (CSS px + screen-shake) — cache is buffer-resolution
    targetCtx.drawImage(neighborPeekCache.canvas, 0, 0, viewW, viewH);
    targetCtx.restore();
}

function releaseOffscreenGrid() {
    if (offscreenGrid) {
        offscreenGrid.width = 0;
        offscreenGrid.height = 0;
        offscreenGrid = null;
    }
    lastGridCacheKey = '';
    if (neighborPeekCache?.canvas) {
        neighborPeekCache.canvas.width = 0;
        neighborPeekCache.canvas.height = 0;
    }
    neighborPeekCache = null;
    mainBoardGridCache = null;
}

/** @deprecated Kept as a no-op so old call sites stay safe — grid is drawn live now. */
function prerenderGrid() {
    releaseOffscreenGrid();
}

function update() {
    if (isPaused || !p1 || !p2) return;

    if (gameState === 'COUNTDOWN') {
        // Hide hunger bars during countdown
        if (hungerBarsContainer) {
            hungerBarsContainer.style.display = 'none';
        }
        
        if (roundAnnouncerEl) {
            roundAnnouncerEl.classList.remove('hidden');
            roundAnnouncerEl.classList.toggle('go-phase', countdownValue <= 0);
        }
        if (roundTextEl) roundTextEl.textContent = `ROUND ${Math.max(1, (roundsCompletedThisMatch || 0) + 1)}`;
        
        const currentCountdownDisplay = countdownValue > 0 ? countdownValue : 'GO!';
        if (countdownTextEl && countdownTextEl.textContent !== String(currentCountdownDisplay)) {
            countdownTextEl.textContent = currentCountdownDisplay;
            // Restart pop without offsetHeight reflow (that hitchs the cube at round start)
            countdownTextEl.style.animation = 'none';
            countdownTextEl.style.animation = '';
        }

        const countdownStepTicks = countdownValue === 0
            ? ticksForCountdownStep(ROUND_COUNTDOWN_GO_SEC)
            : ticksForCountdownStep(ROUND_COUNTDOWN_NUMBER_SEC);

        countdownTicks++;
        if (countdownTicks >= countdownStepTicks) {
            countdownTicks = 0;
            countdownValue--;
            if (countdownValue > 0) {
                SFX.play('move', 0.5);
            } else if (countdownValue === 0) {
                SFX.play('win', 0.5);
            } else if (countdownValue < 0) {
                gameState = 'PLAYING';
                gameHasStarted = true; // Lock jokers once game starts
                // Keep held WASD through GO — wiping keys made spawn feel dead until re-press
                const roundStartGrace = Math.round(0.35 * TICK_RATE);
                if (p1 && !p1.isDead) {
                    p1.hungerTimer = 0;
                    p1._spawnGraceTicks = Math.max(p1._spawnGraceTicks || 0, roundStartGrace);
                }
                if (p2 && !p2.isDead) {
                    p2.hungerTimer = 0;
                    p2._spawnGraceTicks = Math.max(p2._spawnGraceTicks || 0, roundStartGrace);
                }
                if (roundAnnouncerEl) {
                    roundAnnouncerEl.classList.add('hidden');
                    roundAnnouncerEl.classList.remove('go-phase');
                }
                
                // Show HUDs after countdown
                if (p1HudEl) p1HudEl.classList.add('visible');
                if (p2HudEl) p2HudEl.classList.add('visible');
                
                // Show hunger bars after countdown
                if (hungerBarsContainer) {
                    hungerBarsContainer.style.display = (isTutorialPracticePhase() && !isTutorialHungerStep()) ? 'none' : 'flex';
                }
                if (isTutorialPracticePhase()) {
                    showTutorialPanel();
                } else if (isTutorialFightWaiting()) {
                    showTutorialFightBrief();
                } else {
                    hideTutorialOverlay();
                }
                if (typeof checkAllBoardsClaimedWin === 'function') {
                    checkAllBoardsClaimedWin();
                }
            }
        }
        return;
    }

    tickTutorialPractice();

    // Allow updates during death animation even if not in PLAYING state
    if (gameState !== 'PLAYING' && gameState !== 'ROUND_OVER' && gameState !== 'GAME_OVER') return;

    // Round/match freeze: keep death shards ticking, skip apples/AI/collisions (stops cube hitch)
    if (gameState === 'ROUND_OVER' || gameState === 'GAME_OVER') {
        const targetNow = getEffectiveMatchTarget();
        if ((p1Score >= targetNow || p2Score >= targetNow)
            && (!matchEndUiShown || (gameOverDiv && gameOverDiv.classList.contains('hidden')))) {
            gameState = 'GAME_OVER';
            if (!endTimerStarted) {
                try { endGame(); } catch (err) {
                    console.error('Recovered endGame failed', err);
                    forceShowGameOverUi();
                }
            }
        }
        if (p1) p1.update();
        if (p2) p2.update();
        if (clones && clones.length) {
            for (let i = 0; i < clones.length; i++) clones[i].update();
            let w = 0;
            for (let i = 0; i < clones.length; i++) {
                if (!clones[i].isDead) clones[w++] = clones[i];
            }
            clones.length = w;
        }
        return;
    }

    // --- UPDATE SPECIAL SKILLS ---
    // Update Lasers
    for (let i = laserLines.length - 1; i >= 0; i--) {
        const laser = laserLines[i];
        laser.ticks++;
        if (laser.ticks > laser.warningTicks + Math.round(TICK_RATE * 0.5)) {
            laserLines.splice(i, 1);
        }
    }

    // Stuck match recovery: score already decided but end window never appeared
    if (gameState === 'GAME_OVER' || gameState === 'PLAYING' || gameState === 'ROUND_OVER') {
        const targetNow = getEffectiveMatchTarget();
        if ((p1Score >= targetNow || p2Score >= targetNow)
            && (!matchEndUiShown || (gameOverDiv && gameOverDiv.classList.contains('hidden')))) {
            gameState = 'GAME_OVER';
            if (!endTimerStarted) {
                try { endGame(); } catch (err) {
                    console.error('Recovered endGame failed', err);
                    forceShowGameOverUi();
                }
            }
        }
    }

    if (gameState === 'PLAYING' && typeof RonkAI !== 'undefined') {
        RonkAI.beginFrame();
    }
    
    // Update Apples
    updateApples();
    checkAppleCollision();
    if (typeof checkCheckpointClaims === 'function') checkCheckpointClaims();

    // Update Clones
    if (clones && clones.length) {
        for (let i = 0; i < clones.length; i++) clones[i].update();
        let w = 0;
        for (let i = 0; i < clones.length; i++) {
            if (!clones[i].isDead) clones[w++] = clones[i];
        }
        clones.length = w;
    }

    // Held keys → dir in the same logic tick as movement (no 74ms render lag)
    if (gameState === 'PLAYING') {
        pollKeyboardHeldInput();
    }

    const p1OldX = p1.x; const p1OldY = p1.y;
    const p2OldX = p2.x; const p2OldY = p2.y;
    
    // Always update both players locally for smooth dead-reckoning
    p1.update(); 
    p2.update();
    
    hungerBarFrame++;
    if (!isPerformanceMode() || hungerBarFrame % 2 === 0) {
        updateHungerBars();
    }

    if (isOnline) {
        if (onlineRole === 'host') { 
            syncState(p1);
            if (typeof window.syncCounter === 'undefined') window.syncCounter = 0;
            window.syncCounter++;
            if (window.syncCounter % 12 === 0) sendHostWorldSnapshot();
        } else if (onlineSpectateRole !== 'spectator') { 
            syncState(p2); 
            if (typeof window.syncCounter === 'undefined') window.syncCounter = 0;
            window.syncCounter++;
            if (window.syncCounter % 60 === 0) syncSettings();
            // Safety net: guest asks host for full resync ~every 35s during play
            if (gameState === 'PLAYING' && window.syncCounter % 480 === 0 && conn && conn.open) {
                try {
                    conn.send(sealOnlinePacket({ type: 'resync-request', t: Date.now() }));
                } catch (_) { /* ignore */ }
            }
        }
    }

    if (isOnline && window.RonkAntiCheat) {
        const logicCheck = RonkAntiCheat.tickLogicFrame();
        if (!logicCheck.valid) {
            // Hitch-class speed flags: warn + resync — never end the match
            if (logicCheck.reason === 'LOGIC_SPEED_HACK') {
                try { showAntiCheatToast('SYNC: hitch detected — resyncing…', false); } catch (_) { /* ignore */ }
                try { if (onlineRole === 'host') sendHostWorldSnapshot(); } catch (_) { /* ignore */ }
            } else if (logicCheck.kick) {
                kickFromOnlineCheat(logicCheck.reason || 'LOGIC_SPEED_HACK');
                return;
            }
        }
    }

    if (gameState === 'PLAYING' && (p1.isCharging || p1.chargeAnimTicks > 0) && (p2.isCharging || p2.chargeAnimTicks > 0)
        && (typeof sameBoardCoords !== 'function' || sameBoardCoords(p1, p2))) {
        const sameSquare = p1.x === p2.x && p1.y === p2.y;
        const swappedX = (p1OldY === p2OldY && p1.y === p2.y) && ((p1OldX < p2OldX && p1.x >= p2.x) || (p1OldX > p2OldX && p1.x <= p2.x));
        const swappedY = (p1OldX === p2OldX && p1.x === p2.x) && ((p1OldY < p2OldY && p1.y >= p2.y) || (p1OldY > p2OldY && p1.y <= p2.y));
        if (sameSquare || swappedX || swappedY) {
             p1.isCharging = false; p2.isCharging = false; p1.chargeAnimTicks = 0; p2.chargeAnimTicks = 0;
             p1.chargeEffect = 3.0; p2.chargeEffect = 3.0;
             if (swappedX || (sameSquare && p1.dir.x !== 0)) { const midX = Math.floor((p1OldX + p2OldX) / 2); p1.x = midX - p1.dir.x; p2.x = midX + p1.dir.x; }
             else if (swappedY || (sameSquare && p1.dir.y !== 0)) { const midY = Math.floor((p1OldY + p2OldY) / 2); p1.y = midY - p1.dir.y; p2.y = midY + p1.dir.y; }
             p1.dir = { x: 0, y: 0 }; p2.dir = { x: 0, y: 0 };
             // True head-on same cell: mutual KO. Crossing lanes: clash stun only (no dual death).
             if (sameSquare) {
                 if (!p1.isImmune) p1.die('hit', 'charge-swap-mutual');
                 if (!p2.isImmune) p2.die('hit', 'charge-swap-mutual');
             } else {
                 const stun = Math.round(0.55 * TICK_RATE);
                 p1.isImmune = true; p1.immuneTimer = Math.max(p1.immuneTimer || 0, stun);
                 p2.isImmune = true; p2.immuneTimer = Math.max(p2.immuneTimer || 0, stun);
                 p1._spawnGraceTicks = Math.max(p1._spawnGraceTicks || 0, stun);
                 p2._spawnGraceTicks = Math.max(p2._spawnGraceTicks || 0, stun);
                 try { SFX.play('hit', 0.55); } catch (_) { /* ignore */ }
             }
        }
    }

    if (gameState === 'PLAYING') {
        checkCollisions();
        try { checkFriendWallTouches(); } catch (_) { /* ignore */ }

        if (p1.isDead || p2.isDead) {
            // Revival Logic: If a player dies but has a clone, transfer control to the clone
            let revivedThisFrame = false;
            if (p1.isDead) {
                const p1Clone = clones.find(c => c && c.isClone && !c.isDead && getPlayerBaseId(c.id) === getPlayerBaseId(p1.id));
                if (p1Clone) {
                    p1.isDead = false;
                    p1.x = p1Clone.x; p1.y = p1Clone.y;
                    p1.prevX = p1Clone.prevX; p1.prevY = p1Clone.prevY;
                    p1.dir = { ...p1Clone.dir };
                    p1.trail = [ ...p1Clone.trail ];
                    p1.boardSx = Number.isInteger(p1Clone.boardSx) ? p1Clone.boardSx : p1.boardSx;
                    p1.boardSy = Number.isInteger(p1Clone.boardSy) ? p1Clone.boardSy : p1.boardSy;
                    if (typeof ensurePlayerBoard === 'function') ensurePlayerBoard(p1);
                    if (typeof rebuildPlayerTrailOcc === 'function') rebuildPlayerTrailOcc(p1);
                    else if (typeof syncPlayerTrailOccSet === 'function') syncPlayerTrailOccSet(p1);
                    else if (p1._trailOccSet) {
                        p1._trailOccSet = new Set();
                        for (const t of p1.trail) {
                            p1._trailOccSet.add(trailOccKey(t.x, t.y, t.boardSx, t.boardSy));
                        }
                    }
                    p1._spawnGraceTicks = Math.max(p1._spawnGraceTicks || 0, Math.round(1.2 * TICK_RATE));
                    p1.isImmune = true;
                    p1.immuneTimer = Math.max(p1.immuneTimer || 0, Math.round(1.0 * TICK_RATE));
                    p1Clone.die('hit');
                    revivedThisFrame = true;
                }
            }
            if (p2.isDead) {
                const p2Clone = clones.find(c => c && c.isClone && !c.isDead && getPlayerBaseId(c.id) === getPlayerBaseId(p2.id));
                if (p2Clone) {
                    p2.isDead = false;
                    p2.x = p2Clone.x; p2.y = p2Clone.y;
                    p2.prevX = p2Clone.prevX; p2.prevY = p2Clone.prevY;
                    p2.dir = { ...p2Clone.dir };
                    p2.trail = [ ...p2Clone.trail ];
                    p2.boardSx = Number.isInteger(p2Clone.boardSx) ? p2Clone.boardSx : p2.boardSx;
                    p2.boardSy = Number.isInteger(p2Clone.boardSy) ? p2Clone.boardSy : p2.boardSy;
                    if (typeof ensurePlayerBoard === 'function') ensurePlayerBoard(p2);
                    if (typeof rebuildPlayerTrailOcc === 'function') rebuildPlayerTrailOcc(p2);
                    else if (typeof syncPlayerTrailOccSet === 'function') syncPlayerTrailOccSet(p2);
                    else if (p2._trailOccSet) {
                        p2._trailOccSet = new Set();
                        for (const t of p2.trail) {
                            p2._trailOccSet.add(trailOccKey(t.x, t.y, t.boardSx, t.boardSy));
                        }
                    }
                    p2._spawnGraceTicks = Math.max(p2._spawnGraceTicks || 0, Math.round(1.2 * TICK_RATE));
                    p2.isImmune = true;
                    p2.immuneTimer = Math.max(p2.immuneTimer || 0, Math.round(1.0 * TICK_RATE));
                    p2Clone.die('hit');
                    revivedThisFrame = true;
                }
            }
            if (revivedThisFrame) {
                updateScoreboard();
                return;
            }

            if (isTutorialPracticePhase()) {
                if (tutorialStep === 2 && p2.isDead && !p1.isDead) {
                    return;
                }
                if (tutorialStep === 3 && p1.isDead) {
                    return;
                }
                if (tutorialStep === 7 && p1.isDead) {
                    resetTutorialHungerStepPositions();
                    gameState = 'PLAYING';
                    return;
                }
                resetTutorialPracticePositions();
                gameState = 'PLAYING';
                return;
            }

            // Online guest waits for host round-score packet (avoids desync / double-count).
            if (isOnline && onlineRole === 'guest') {
                return;
            }

            // One kill = one round win. Match = first to MATCH_TARGET rounds.
            // Wait for a short death beat so the KO reads before the round banner.
            // IMPORTANT: if the other player dies later during that beat, do NOT convert
            // a clear first-kill into a draw (that was dropping scoreboard points).
            const deathBeat = Math.round(0.55 * TICK_RATE);
            if (p1.isDead && p2.isDead) {
                const older = Math.max(p1.deathAnimTicks || 0, p2.deathAnimTicks || 0);
                if (older < deathBeat) return;
            } else {
                const deadP = p1.isDead ? p1 : p2;
                if (!deadP || (deadP.deathAnimTicks || 0) < deathBeat) return;
            }

            if (!roundOutcomeScored) {
                const outcome = resolveKillRoundOutcome();
                if (!outcome) return;
                awardKillRoundOutcome(outcome);
            }

            if (p1Score >= getEffectiveMatchTarget() || p2Score >= getEffectiveMatchTarget()) {
                gameState = 'GAME_OVER';
            } else {
                // Next round: wipe boards + reshuffle so TTT / kill both reset cleanly
                gameState = 'ROUND_OVER';
            }
            scheduleRoundEndTransition();
        }
    }
}

let lastP1JokersKey = '';
let lastP2JokersKey = '';
let canvasPauseFilter = '';
let cachedCooldownTheme = '';
let cachedCooldownBackground = 'linear-gradient(135deg, #333, #222)';
let hungerBarsVisible = null;
let lastP1HungerWidth = '';
let lastP2HungerWidth = '';
let lastP1HungerLow = false;
let lastP2HungerLow = false;
let lastP1HungerStyleKey = '';
let lastP2HungerStyleKey = '';

function clearCooldownLetterInlineChrome(el) {
    if (!el) return;
    el.style.background = '';
    el.style.backgroundImage = '';
    el.style.border = '';
    el.style.borderRadius = '';
    el.style.boxShadow = '';
    el.style.color = '';
    el.style.webkitTextFillColor = '';
    el.style.textShadow = '';
    el.style.padding = '';
    el.style.fontSize = '';
    el.style.fontWeight = '';
    el.style.fontFamily = '';
    el.style.letterSpacing = '';
    el.style.backdropFilter = '';
    el.style.webkitBackdropFilter = '';
    el.style.clipPath = '';
    el.style.minWidth = '';
    el.style.width = '';
    el.style.maxWidth = '';
    el.style.overflow = '';
    el.style.textOverflow = '';
    el.style.textAlign = '';
    el.style.display = '';
    el.style.alignItems = '';
    el.style.justifyContent = '';
    el.style.filter = '';
    el.style.position = '';
    el.style.transition = '';
}

const _cdLetterVisual = new WeakMap();
const _hudAccentCache = new WeakMap();

function styleCooldownLetter(el, progress, playerColor) {
    if (!el) return;
    const ready = progress >= 1;
    const q = ready ? 1 : Math.min(1, Math.floor(progress * 32) / 32);
    const prev = _cdLetterVisual.get(el);
    if (prev && prev.q === q && prev.ready === ready && prev.colorKey === playerColor) return;
    _cdLetterVisual.set(el, { q, ready, colorKey: playerColor });
    const theme = themes[currentThemeIndex];
    const isPinkcore = theme === 'theme-pinkcore';
    const isRonk = theme === 'theme-ronk';
    // CSS theme-windows owns chip chrome for these — don't fight with inline fills
    const cssOwnedChip = isPinkcore
        || theme === 'theme-hacker'
        || theme === 'theme-pixel'
        || theme === 'theme-white-black';

    el.classList.toggle('ready', ready);

    if (isPinkcore) {
        // Candy 3D chips: punchy light face + deep lip (matches reference coral/cyan)
        const mid = playerColor.startsWith('#') ? playerColor : '#ff4d7a';
        const light = adjustLoadoutHex(mid, 38);
        const dark = adjustLoadoutHex(mid, -28);
        const shadow = adjustLoadoutHex(mid, -48);
        const edge = adjustLoadoutHex(mid, 10);

        // Drive CSS chip chrome on BOTH HUDs (same format L/R via --hud-accent)
        const hud = el.closest('.player-hud');
        if (hud) {
            const prevHud = _hudAccentCache.get(hud);
            if (!prevHud || prevHud.mid !== mid) {
                hud.style.setProperty('--hud-accent', mid);
                hud.style.setProperty('--hud-accent-light', light);
                hud.style.setProperty('--hud-accent-dark', dark);
                hud.style.setProperty('--hud-accent-edge', edge);
                hud.style.setProperty('--hud-accent-shadow', shadow);
                _hudAccentCache.set(hud, { mid });
            }
        }

        clearCooldownLetterInlineChrome(el);
        return;
    }

    if (cssOwnedChip) {
        clearCooldownLetterInlineChrome(el);
        return;
    }

    if (isRonk) {
        const mid = playerColor.startsWith('#') ? playerColor : '#ff4444';
        // Classic dark Ronk: neon text + scanline texture (not bright solid plates)
        const classicClip = 'polygon(5% 0, 100% 0, 100% 70%, 95% 100%, 0 100%, 0 30%)';
        const scan = 'var(--ronk-btn-scanlines)';

        el.style.fontFamily = "'Orbitron', sans-serif";
        el.style.borderRadius = '0';
        el.style.padding = '0.55rem 1.35rem';
        el.style.fontSize = '1.35rem';
        el.style.fontWeight = '900';
        el.style.letterSpacing = '0.18em';
        el.style.minWidth = '11.5rem';
        el.style.width = '';
        el.style.maxWidth = '';
        el.style.overflow = '';
        el.style.textOverflow = '';
        el.style.textAlign = 'center';
        el.style.display = 'inline-flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.backdropFilter = 'none';
        el.style.webkitBackdropFilter = 'none';
        el.style.clipPath = classicClip;
        el.style.border = 'none';
        el.style.webkitTextFillColor = '';
        el.style.transition = '';
        el.style.filter = 'none';
        el.style.position = 'relative';

        if (ready) {
            el.style.color = mid;
            el.style.textShadow = `0 0 14px ${getCachedRgba(mid, 0.85)}, 0 0 28px ${getCachedRgba(mid, 0.45)}`;
            el.style.background = `${scan}, linear-gradient(135deg, ${mid}99, ${mid}55)`;
            el.style.boxShadow = `0 0 18px ${getCachedRgba(mid, 0.35)}`;
        } else {
            el.style.color = getCachedRgba(mid, 0.42);
            el.style.textShadow = 'none';
            el.style.background = `${scan}, linear-gradient(135deg, #2a2a2a, #161616)`;
            el.style.boxShadow = 'none';
        }
        return;
    }

    const dimColor = progress >= 1
        ? playerColor
        : getCachedRgba(playerColor, 0.3 + (q * 0.4));
    el.style.color = dimColor;
    el.style.border = '';
    el.style.borderRadius = '';
    el.style.padding = '';
    el.style.fontSize = '';
    el.style.fontWeight = '';
    el.style.fontFamily = '';
    el.style.letterSpacing = '';
    el.style.backdropFilter = '';
    el.style.webkitBackdropFilter = '';
    el.style.clipPath = '';
    el.style.minWidth = '';
    el.style.width = '';
    el.style.maxWidth = '';
    el.style.overflow = '';
    el.style.textOverflow = '';
    el.style.textAlign = '';
    el.style.display = '';
    el.style.alignItems = '';
    el.style.justifyContent = '';
    el.style.webkitTextFillColor = '';
    el.style.filter = '';
    el.style.position = '';

    if (ready) {
        el.style.textShadow = `0 0 15px ${getCachedRgba(playerColor, 0.7)}`;
        el.style.background = `linear-gradient(135deg, ${playerColor}80, ${playerColor}40)`;
        el.style.boxShadow = '';
    } else {
        el.style.textShadow = 'none';
        el.style.background = cachedCooldownBackground;
        el.style.boxShadow = '';
    }
}

function updateActionPromptLabels() {
    const lang = (typeof getUiLang === 'function')
        ? getUiLang()
        : (localStorage.getItem('ronk_language') || 'en');
    const t = (typeof translations !== 'undefined' && translations[lang]) ? translations[lang] : (translations?.en || {});
    const pad = !!usingGamepadInput;
    let dashKey = 'F';
    let chargeKey = 'C';
    let skillKey = 'Y';
    try {
        const saved = JSON.parse(localStorage.getItem('ronk_controls') || '{}');
        dashKey = String(saved.dash || 'f').toUpperCase();
        chargeKey = String(saved.charge || 'c').toUpperCase();
        skillKey = String(saved.skill || 'y').toUpperCase();
    } catch (_) { /* defaults */ }
    const dash = pad ? 'A · DASH' : `${dashKey} · ${(t['Dash'] || 'DASH')}`;
    const charge = pad ? 'B · CHARGE' : `${chargeKey} · ${(t['Charge'] || 'CHARGE')}`;
    const skill = pad ? 'X · SKILL' : `${skillKey} · ${(t['Skill'] || 'SKILL')}`;
    const ids = [
        ['p1-dash-letter', dash],
        ['p2-dash-letter', dash],
        ['p1-charge-letter', charge],
        ['p2-charge-letter', charge],
        ['p1-skill-letter', skill],
        ['p2-skill-letter', skill]
    ];
    for (const [id, text] of ids) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }
}

function updateCooldownUI() {
    if (!p1 || !p2) return;
    const now = Date.now();

    const currentTheme = themes[currentThemeIndex];
    if (currentTheme !== cachedCooldownTheme) {
        cachedCooldownTheme = currentTheme;
        cachedCooldownBackground = currentTheme === 'theme-pinkcore'
            ? 'rgba(255, 255, 255, 0.24)'
            : currentTheme === 'theme-ronk'
                ? '#141414'
                : 'linear-gradient(135deg, #333, #222)';
    }

    // Player 1
    const p1DashProgress = Math.min(1, (now - p1.lastDash) / (DASH_COOLDOWN * p1.jokerCooldownReduce));
    const p1ChargeCooldown = (p1.infiniteChargeActive || isTutorialChargePracticeStep())
        ? 1
        : CHARGE_COOLDOWN * p1.jokerCooldownReduce;
    const p1ChargeProgress = Math.min(1, (now - p1.lastCharge) / p1ChargeCooldown);
    const p1SkillProgress = Math.min(1, (now - p1.lastSkillUsed) / (getSkillCooldownMs(p1) * p1.jokerCooldownReduce));

    styleCooldownLetter(p1DashLetter, p1DashProgress, p1.color);
    styleCooldownLetter(p1ChargeLetter, p1ChargeProgress, p1.color);
    if (p1DashLetter) {
        const dashLabel = (!isSpectateMode && !(isOnline && onlineRole === 'guest'))
            ? formatLocalActionHudLabel('dash', 'DASH')
            : 'DASH';
        if (p1DashLetter.textContent !== dashLabel) p1DashLetter.textContent = dashLabel;
    }
    if (p1ChargeLetter) {
        const chargeLabel = (!isSpectateMode && !(isOnline && onlineRole === 'guest'))
            ? formatLocalActionHudLabel('charge', 'CHARGE')
            : 'CHARGE';
        if (p1ChargeLetter.textContent !== chargeLabel) p1ChargeLetter.textContent = chargeLabel;
    }
    if (p1SkillLetter) {
        if (!p1.selectedSkill || currentGamemode === 'simplistic') {
            p1SkillLetter.style.display = 'none';
        } else {
            p1SkillLetter.style.display = '';
            const p1IsPassive = isPassiveSkill(p1.selectedSkill);
            styleCooldownLetter(p1SkillLetter, p1IsPassive ? 1 : p1SkillProgress, p1.color);
            const skillName = getSkillHudLabel(p1.selectedSkill);
            const skillLabel = (!isSpectateMode && !(isOnline && onlineRole === 'guest') && !p1IsPassive)
                ? formatLocalActionHudLabel('skill', skillName)
                : skillName;
            if (p1SkillLetter.textContent !== skillLabel) {
                p1SkillLetter.textContent = skillLabel;
            }
        }
    }

    // Update Joker displays for P1
    if (p1JokerContainer && p1Joker1 && p1Joker2) {
        const p1Jokers = Array.isArray(p1DisplayJokers) ? p1DisplayJokers : (p1DisplayJokers ? [p1DisplayJokers] : []);
        const p1Disabled = Array.isArray(p1DisabledJokers) ? p1DisabledJokers : [];
        const p1JokersKey = p1Jokers.join(',') + '|d:' + p1Disabled.join(',');
        if (p1JokersKey !== lastP1JokersKey) {
            lastP1JokersKey = p1JokersKey;
            if (p1Jokers.length > 0) {
                p1JokerContainer.style.display = 'flex';
                p1Joker1.textContent = jokerIconMap[p1Jokers[0]] || '';
                p1Joker2.textContent = p1Jokers[1] ? (jokerIconMap[p1Jokers[1]] || '') : '';
                p1Joker1.classList.toggle('joker-disabled', p1Disabled.includes(p1Jokers[0]));
                p1Joker2.classList.toggle('joker-disabled', !!(p1Jokers[1] && p1Disabled.includes(p1Jokers[1])));
            } else {
                p1JokerContainer.style.display = 'none';
                p1Joker1.classList.remove('joker-disabled');
                p1Joker2.classList.remove('joker-disabled');
            }
        }
    }

    // Player 2
    const p2DashProgress = Math.min(1, (now - p2.lastDash) / (DASH_COOLDOWN * p2.jokerCooldownReduce));
    const p2ChargeProgress = Math.min(1, (now - p2.lastCharge) / (p2.infiniteChargeActive ? 1 : CHARGE_COOLDOWN * p2.jokerCooldownReduce));
    const p2SkillProgress = Math.min(1, (now - p2.lastSkillUsed) / (getSkillCooldownMs(p2) * p2.jokerCooldownReduce));

    styleCooldownLetter(p2DashLetter, p2DashProgress, p2.color);
    styleCooldownLetter(p2ChargeLetter, p2ChargeProgress, p2.color);
    if (p2DashLetter) {
        const dashLabel = (isOnline && onlineRole === 'guest')
            ? formatLocalActionHudLabel('dash', 'DASH')
            : ((isMultiplayer && !isOnline) ? formatLocalActionHudLabel('dash', 'DASH') : 'DASH');
        // Local P2 (same-screen) shares keys; guest online uses right HUD as "you"
        if (isOnline && onlineRole === 'guest') {
            if (p2DashLetter.textContent !== dashLabel) p2DashLetter.textContent = dashLabel;
        } else if (isMultiplayer && !isOnline) {
            // Keep P2 labels as action names only (P1 already shows binds)
            if (p2DashLetter.textContent !== 'DASH') p2DashLetter.textContent = 'DASH';
        }
    }
    if (p2ChargeLetter && isOnline && onlineRole === 'guest') {
        const chargeLabel = formatLocalActionHudLabel('charge', 'CHARGE');
        if (p2ChargeLetter.textContent !== chargeLabel) p2ChargeLetter.textContent = chargeLabel;
    }
    if (p2SkillLetter) {
        if (!p2.selectedSkill) {
            p2SkillLetter.style.display = 'none';
        } else {
            p2SkillLetter.style.display = '';
            const p2IsPassive = isPassiveSkill(p2.selectedSkill);
            styleCooldownLetter(p2SkillLetter, p2IsPassive ? 1 : p2SkillProgress, p2.color);
            const skillName = getSkillHudLabel(p2.selectedSkill);
            const skillLabel = (isOnline && onlineRole === 'guest' && !p2IsPassive)
                ? formatLocalActionHudLabel('skill', skillName)
                : skillName;
            if (p2SkillLetter.textContent !== skillLabel) {
                p2SkillLetter.textContent = skillLabel;
            }
        }
    }

    // Update Joker displays for P2
    if (p2JokerContainer && p2Joker1 && p2Joker2) {
        const p2Jokers = Array.isArray(p2DisplayJokers) ? p2DisplayJokers : (p2DisplayJokers ? [p2DisplayJokers] : []);
        const p2Disabled = Array.isArray(p2DisabledJokers) ? p2DisabledJokers : [];
        const p2JokersKey = p2Jokers.join(',') + '|d:' + p2Disabled.join(',');
        if (p2JokersKey !== lastP2JokersKey) {
            lastP2JokersKey = p2JokersKey;
            if (p2Jokers.length > 0) {
                p2JokerContainer.style.display = 'flex';
                p2Joker1.textContent = jokerIconMap[p2Jokers[0]] || '';
                p2Joker2.textContent = p2Jokers[1] ? (jokerIconMap[p2Jokers[1]] || '') : '';
                p2Joker1.classList.toggle('joker-disabled', p2Disabled.includes(p2Jokers[0]));
                p2Joker2.classList.toggle('joker-disabled', !!(p2Jokers[1] && p2Disabled.includes(p2Jokers[1])));
            } else {
                p2JokerContainer.style.display = 'none';
                p2Joker1.classList.remove('joker-disabled');
                p2Joker2.classList.remove('joker-disabled');
            }
        }
    }
}

function syncState(player) {
    if (!isOnline) return;
    // Optimized sync packet: Use shorter keys and round decimals
    const syncData = {
        t: 's', // type: sync
        x: player.x,
        y: player.y,
        px: player.prevX,
        py: player.prevY,
        bsx: player.boardSx ?? MIDDLE_BOARD_SX,
        bsy: player.boardSy ?? MIDDLE_BOARD_SY,
        dx: player.dir.x,
        dy: player.dir.y,
        tr: player.trail.slice(-3), // Only sync the last 3 points of the trail to reduce payload
        id: player.isDead ? 1 : 0,
        ds: player.isDashing ? 1 : 0,
        ch: player.isCharging ? 1 : 0,
        da: player.dashAnimTicks,
        ca: player.chargeAnimTicks
    };
    sendOnlineSealed(syncData);
}

let animUiFrame = 0;
let gamepadPollFrame = 0;
let hungerBarFrame = 0;
let lastTicksThisFrame = 0;
let _lastDrawViewSx = null;
let _lastDrawViewSy = null;

function animate(currentTime) {
    gamepadPollFrame++;
    const throttlePadInMatch = document.body.classList.contains('in-game')
        && gameState === 'PLAYING' && !isPaused && !isResuming;
    if (!throttlePadInMatch || (gamepadPollFrame & 1) === 0) {
        pollGamepadInput();
    }

    if (document.hidden) {
        lastFrameTime = currentTime;
        if (animLoop) {
            cancelAnimationFrame(animLoop);
            animLoop = null;
        }
        return;
    }

    // Only execute logic if enough time has passed to prevent spiral of death and unnecessary frame processing
    const deltaTime = currentTime - lastFrameTime;
    
    // Tighter spike cap = smoother motion (same look, less hitch stretch)
    const cappedDelta = Math.min(40, deltaTime);
    lastFrameTime = currentTime;
    try { tickFrameBudget(cappedDelta); } catch (_) { /* ignore */ }

    if (isOnline && window.RonkAntiCheat) {
        const renderCheck = RonkAntiCheat.tickRenderFrame(cappedDelta);
        if (!renderCheck.valid) {
            if (renderCheck.reason === 'RENDER_SPEED_HACK') {
                try { showAntiCheatToast('SYNC: render hitch — ignoring speed flag', false); } catch (_) { /* ignore */ }
                try { if (onlineRole === 'host') sendHostWorldSnapshot(); } catch (_) { /* ignore */ }
            } else if (renderCheck.kick) {
                kickFromOnlineCheat(renderCheck.reason || 'RENDER_SPEED_HACK');
                animLoop = requestAnimationFrame(animate);
                return;
            }
        }
    }

    if (isPaused) {
        // Keep RAF alive for input, but don't redraw the board under the pause menu
        animLoop = requestAnimationFrame(animate);
        return;
    }

    if (isResuming) {
        updateResumeCountdown();
        draw();
        animLoop = requestAnimationFrame(animate);
        return;
    }
    
    accumulator += cappedDelta;

    // Fixed Time Step loop for consistent logic execution regardless of frame rate
    let ticksThisFrame = 0;
    // Never catch up more than 1 logic tick per frame — extra ticks hitch the UI
    const maxTicksPerFrame = 1;
    // Hard cap max ticks to prevent freezing the main thread entirely on slow devices/servers
    while (accumulator >= tickDuration && ticksThisFrame < maxTicksPerFrame) {
        try {
            update();
        } catch (e) {
            console.error("Critical error in update loop, attempting to recover...", e);
        }
        accumulator -= tickDuration;
        ticksThisFrame++;
    }
    lastTicksThisFrame = ticksThisFrame;
    
    // If we're so far behind that we hit the tick cap, just drop the accumulated time to stay real-time
    // This prevents the game from getting stuck in an infinite update loop while the music plays
    if (accumulator >= tickDuration) {
        accumulator = accumulator % tickDuration;
    }

    // Always interpolate between ticks — snapping to 1.0 on catch-up frames causes hitching
    const alpha = accumulator / tickDuration;
    const renderAlpha = isNaN(alpha) ? 1.0 : Math.max(0, Math.min(1.0, alpha));
    // During freeze / countdown, never lerp — stops neighbor-tile flicker on round end
    const snapPose = (typeof gameState !== 'undefined'
        && (gameState === 'ROUND_OVER' || gameState === 'GAME_OVER' || gameState === 'COUNTDOWN'));
    const applyRoll = (ent) => {
        if (!ent) return;
        if (snapPose || ent.isDead) {
            ent.prevX = ent.x;
            ent.prevY = ent.y;
            ent.rollProgress = 1;
        } else {
            ent.rollProgress = renderAlpha;
        }
    };
    applyRoll(p1);
    applyRoll(p2);
    clones.forEach(applyRoll);

    // Friend-wall kills run in update()/checkCollisions path only — never every RAF
    // (visual-lerp checks here caused phantom mid-slide deaths)
    
    // Update UI elements (throttle on low-end render settings)
    animUiFrame++;
    const cdUiEvery = isPerformanceMode() ? 4 : 2;
    if ((animUiFrame % cdUiEvery) === 0) {
        updateCooldownUI();
    }
    // Heal suspended audio quietly — same volume/SFX, just keeps A/V locked after tab focus hiccups
    if ((animUiFrame & 127) === 0) {
        try { if (typeof SFX !== 'undefined') SFX.resumeCtx(); } catch (_) { /* ignore */ }
        try {
            if (typeof Music !== 'undefined' && Music.enabled) Music.ensurePlaying?.();
        } catch (_) { /* ignore */ }
    }
    
    try {
        if (gameState === 'PLAYING' || gameState === 'COUNTDOWN' || gameState === 'ROUND_OVER' || gameState === 'GAME_OVER' || gameState === 'TUTORIAL') {
            draw();
        }
    } catch (e) {
        console.error("Critical error in draw loop, attempting to recover...", e);
    }
    animLoop = requestAnimationFrame(animate);
}

function updateHungerBars() {
    if (!p1 || !p2) return;
    
    if (hungerBarsContainer) {
        const tutorialHideHunger = typeof isTutorialPracticePhase === 'function'
            && isTutorialPracticePhase()
            && !(typeof isTutorialHungerStep === 'function' && isTutorialHungerStep());
        const shouldShow = gameState !== 'COUNTDOWN' && !tutorialHideHunger;
        if (hungerBarsVisible !== shouldShow) {
            hungerBarsContainer.style.display = shouldShow ? 'flex' : 'none';
            hungerBarsVisible = shouldShow;
        }
        if (!shouldShow) return;
    }
    
    if (p1HungerBarFill) {
        if (p1.jokerNoHunger) {
            const styleKey = 'no-hunger';
            if (lastP1HungerStyleKey !== styleKey) {
                lastP1HungerStyleKey = styleKey;
                lastP1HungerWidth = '100%';
                p1HungerBarFill.style.width = '100%';
                p1HungerBarFill.classList.remove('low');
                p1HungerBarFill.style.background = 'linear-gradient(90deg, #00ff00, #00ff00)';
                p1HungerBarFill.style.boxShadow = '0 0 10px #00ff00';
            }
        } else {
            const p1HungerProgress = 1 - (p1.hungerTimer / p1.hungerDuration);
            const width = `${Math.max(0, p1HungerProgress * 100)}%`;
            const isLow = p1HungerProgress < 0.2;
            if (width !== lastP1HungerWidth) {
                lastP1HungerWidth = width;
                p1HungerBarFill.style.width = width;
            }
            if (isLow !== lastP1HungerLow) {
                lastP1HungerLow = isLow;
                p1HungerBarFill.classList.toggle('low', isLow);
            }
            if (p1.color) {
                const styleKey = p1.color;
                if (lastP1HungerStyleKey !== styleKey) {
                    lastP1HungerStyleKey = styleKey;
                    p1HungerBarFill.style.background = `linear-gradient(90deg, ${p1.color}, ${adjustLoadoutHex(p1.color, -12)})`;
                    p1HungerBarFill.style.boxShadow = 'none';
                }
            }
        }
    }
    
    if (p2HungerBarFill) {
        if (p2.jokerNoHunger) {
            const styleKey = 'no-hunger';
            if (lastP2HungerStyleKey !== styleKey) {
                lastP2HungerStyleKey = styleKey;
                lastP2HungerWidth = '100%';
                p2HungerBarFill.style.width = '100%';
                p2HungerBarFill.classList.remove('low');
                p2HungerBarFill.style.background = 'linear-gradient(90deg, #00ff00, #00ff00)';
                p2HungerBarFill.style.boxShadow = '0 0 10px #00ff00';
            }
        } else {
            const p2HungerProgress = 1 - (p2.hungerTimer / p2.hungerDuration);
            const width = `${Math.max(0, p2HungerProgress * 100)}%`;
            const isLow = p2HungerProgress < 0.2;
            if (width !== lastP2HungerWidth) {
                lastP2HungerWidth = width;
                p2HungerBarFill.style.width = width;
            }
            if (isLow !== lastP2HungerLow) {
                lastP2HungerLow = isLow;
                p2HungerBarFill.classList.toggle('low', isLow);
            }
            if (p2.color) {
                const styleKey = p2.color;
                if (lastP2HungerStyleKey !== styleKey) {
                    lastP2HungerStyleKey = styleKey;
                    p2HungerBarFill.style.background = `linear-gradient(90deg, ${p2.color}, ${adjustLoadoutHex(p2.color, -12)})`;
                    p2HungerBarFill.style.boxShadow = 'none';
                }
            }
        }
    }
}

function updateResumeCountdown() {
    if (roundAnnouncerEl) {
        roundAnnouncerEl.classList.remove('hidden');
        roundAnnouncerEl.classList.toggle('go-phase', resumeCountdownValue <= 0);
    }
    if (roundTextEl && roundTextEl.textContent !== 'RESUMING...') roundTextEl.textContent = 'RESUMING...';
    const resumeDisplay = resumeCountdownValue > 0 ? String(resumeCountdownValue) : 'GO!';
    if (countdownTextEl && countdownTextEl.textContent !== resumeDisplay) countdownTextEl.textContent = resumeDisplay;

    const resumeStepTicks = resumeCountdownValue === 0
        ? ticksForCountdownStep(RESUME_COUNTDOWN_GO_SEC)
        : ticksForCountdownStep(RESUME_COUNTDOWN_NUMBER_SEC);

    resumeCountdownTicks++;
    if (resumeCountdownTicks >= resumeStepTicks) {
        resumeCountdownTicks = 0;
        resumeCountdownValue--;
        if (resumeCountdownValue > 0) {
            SFX.play('move', 0.5);
        } else if (resumeCountdownValue === 0) {
            SFX.play('win', 0.5);
        } else if (resumeCountdownValue < 0) {
            isResuming = false;
            if (roundAnnouncerEl) {
                roundAnnouncerEl.classList.add('hidden');
                roundAnnouncerEl.classList.remove('go-phase');
            }
            // Music continues through pause/countdown — no resume/restart needed.
        }
    }
}

function checkCollisions() {
    const allPlayers = [p1, p2, ...(typeof clones !== 'undefined' ? clones : [])];
    allPlayers.forEach(p => {
        if (!p || p.isDead) return;
        // Online: remote cube deaths come from sync packets — don't dual-sim lethal logic
        if (typeof isOnline !== 'undefined' && isOnline && p._netRemoteDriven) return;
        if (typeof ensurePlayerBoard === 'function') ensurePlayerBoard(p);

        // Skip collision checks if currently in the middle of a leap (charge/dash)
        // to prevent dying to trails that the player is meant to be "jumping" over
        if (p.isCharging || p.isDashing) return;

        // Clones and Main Player need to check against each other correctly
        const opponents = allPlayers.filter(other => {
            if (other === p) return false;
            
            // Ensure ID is treated as a string before calling split
            const pIdStr = String(p.id);
            const otherIdStr = String(other.id);
            
            const pBaseId = pIdStr.split('_')[0];
            const otherBaseId = otherIdStr.split('_')[0];
            if (pBaseId === otherBaseId) return false;
            
            return true;
        });

        opponents.forEach(opponent => {
            if (opponent.isDead) return;
            if (typeof ensurePlayerBoard === 'function') ensurePlayerBoard(opponent);
            if (typeof sameBoardCoords === 'function' && !sameBoardCoords(p, opponent)) return;

            // 1. Head-on Collisions (integer cells only — no lerp phantom overlap)
            const px = Math.floor(Number(p.x));
            const py = Math.floor(Number(p.y));
            const ox = Math.floor(Number(opponent.x));
            const oy = Math.floor(Number(opponent.y));
            if (px === ox && py === oy
                && !(p._spawnGraceTicks > 0) && !(p._landGraceTicks > 0)
                && !(opponent._spawnGraceTicks > 0) && !(opponent._landGraceTicks > 0)) {
                // Charging beats non-charging
                const pIsCharging = p.isCharging || p.chargeAnimTicks > 0;
                const oppIsCharging = opponent.isCharging || opponent.chargeAnimTicks > 0;

                if (pIsCharging && !oppIsCharging) {
                    if (!opponent.isImmune) opponent.die('hit', 'head-on-charged-by-' + String(p.id));
                }
                else if (!pIsCharging && oppIsCharging) {
                    if (!p.isImmune) p.die('hit', 'head-on-hit-by-charger-' + String(opponent.id));
                }
                else {
                    if (!p.isImmune) p.die('hit', 'head-on-mutual-' + String(opponent.id));
                    if (!opponent.isImmune) opponent.die('hit', 'head-on-mutual-' + String(p.id));
                }
            }
            
            if (!p.isCharging && !p.isDashing && !p.isImmune
                && !(p.chargeAnimTicks > 0) && !(p.dashAnimTicks > 0)
                && !(p._spawnGraceTicks > 0) && !(p._landGraceTicks > 0)) {
                // Charge/dash pierce cages; don't die on the cell you just landed on
                // Invisible trails still collide — stealth traps, not ghost walls
                const psx = p.boardSx;
                const psy = p.boardSy;
                if (typeof isSameArmy === 'function' && isSameArmy(p, opponent)) {
                    /* same army never lethal via trail */
                } else if (playerTrailOccupiesCell(opponent, p.x, p.y, psx, psy)) {
                    p.die('hit', 'enemy-trail:' + String(opponent.id));
                }
            }

            if (!p.isCharging && !p.isDashing && p.chargeAnimTicks === 0 && p.dashAnimTicks === 0) {
                const psx = p.boardSx;
                const psy = p.boardSy;
                const onOwnTrail = playerTrailOccupiesCell(p, p.x, p.y, psx, psy);
                const onPrevTrail = playerTrailOccupiesCell(p, p.prevX, p.prevY, psx, psy);
                
                if (onOwnTrail) {
                    // Player is on their own trail
                    const touchKey = `${p.x}_${p.y}`;
                    p.jokerTrailTouchCount[touchKey] = true;
                } else if (onPrevTrail) {
                    // Player just left their own trail
                    const touchKey = `${p.prevX}_${p.prevY}`;
                    if (p.jokerTrailTouchCount[touchKey]) {
                        // Player touched and left, now add +1 to trail length
                        if (p.jokerTrailBonusLength === undefined) p.jokerTrailBonusLength = 0;
                        p.jokerTrailBonusLength++;
                        p.jokerTrailTouchCount[touchKey] = false;
                    }
                }
            }
        });

        // NEVER die to own / same-army trail (you, your clones, your paint).
        // Enemy trails still kill via the opponent loop above.

        // 3. Laser Collisions (board-local when boardSx/boardSy set)
        if (typeof laserLines !== 'undefined' && !p.isImmune
            && !(p._spawnGraceTicks > 0) && !(p._landGraceTicks > 0)
            && !p.isCharging && !p.isDashing
            && !(p.chargeAnimTicks > 0) && !(p.dashAnimTicks > 0)) {
            laserLines.forEach(laser => {
                if (laser.ticks < laser.warningTicks) return;
                // Valid enemy owner only — orphan / friendly beams never lethal
                if (typeof isEnemyLaserLethalTo === 'function') {
                    if (!isEnemyLaserLethalTo(laser, p)) return;
                } else if (typeof isFriendlyLaserOwner === 'function'
                    ? isFriendlyLaserOwner(laser, p)
                    : (laser.owner === p || (laser.owner && getPlayerBaseId(laser.owner.id) === getPlayerBaseId(p.id)))) {
                    return;
                }
                if (!Number.isInteger(laser.boardSx) || !Number.isInteger(laser.boardSy)) return;
                ensurePlayerBoard(p);
                if (p.boardSx !== laser.boardSx || p.boardSy !== laser.boardSy) return;
                const px = Math.floor(Number(p.x));
                const py = Math.floor(Number(p.y));
                const pos = Math.floor(Number(laser.pos));
                if (laser.isHorizontal) {
                    if (py === pos) p.die('hit', 'laser-h');
                } else if (px === pos) {
                    p.die('hit', 'laser-v');
                }
            });
        }

        // 4. Fall off board (dash/charge cross boards; border-safe slides on the rim)
        if (p.x < 0 || p.x >= GRID_COUNT || p.y < 0 || p.y >= GRID_COUNT) {
            const fx = Math.max(0, Math.min(GRID_COUNT - 1, Number.isFinite(p.prevX) ? p.prevX : p.x));
            const fy = Math.max(0, Math.min(GRID_COUNT - 1, Number.isFinite(p.prevY) ? p.prevY : p.y));
            if (p.isCharging || p.isDashing) {
                if (typeof resolveSectorMove === 'function') {
                    resolveSectorMove(p, fx, fy, true);
                } else {
                    p.x = fx;
                    p.y = fy;
                }
            } else if (p.jokerBorderSafe) {
                if (typeof resolveSectorMove === 'function') {
                    resolveSectorMove(p, fx, fy, false);
                } else {
                    p.x = Math.max(0, Math.min(GRID_COUNT - 1, p.x));
                    p.y = Math.max(0, Math.min(GRID_COUNT - 1, p.y));
                }
            } else {
                p.die('fall', 'oob-checkCollisions');
            }
        }
    });
}

let ambienceFrame = 0;

function drawThemeAmbience() {
    // Round/match freeze: don't paint extra canvas washes behind the board
    if (gameState === 'ROUND_OVER' || gameState === 'GAME_OVER') return;
    const theme = themes[currentThemeIndex];
    // In-match: HTML/CSS theme backdrops sit behind the transparent canvas — skip canvas washes
    if (document.body.classList.contains('in-game')) return;
    ambienceFrame++;
    const full = wantsFullThemeVisuals();
    // Low gfx only: update every other frame
    if (!full && (ambienceFrame & 1) === 1) return;
    ambiencePhase += full ? 0.022 : 0.044;
    const inGame = document.body.classList.contains('in-game');
    const perf = !full;

    ctx.save();

    if (theme === 'theme-ronk') {
        if (!inGame) {
        const pulse = 0.12 + Math.sin(ambiencePhase * 1.8) * 0.05;
        const deepPulse = 0.06 + Math.sin(ambiencePhase * 3.2) * 0.03;
        const grad = ctx.createRadialGradient(viewW * 0.5, viewH * 0.5, viewH * 0.04, viewW * 0.5, viewH * 0.5, viewH * 0.92);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(0.45, `rgba(80, 20, 20, ${pulse * 0.35})`);
        grad.addColorStop(1, `rgba(40, 10, 10, ${pulse + deepPulse})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, viewW, viewH);

        const scanStep = perf ? 12 : 8;
        const scanAlpha = 0.035;
        ctx.fillStyle = `rgba(70, 18, 18, ${scanAlpha + Math.sin(ambiencePhase * 7) * 0.012})`;
        for (let y = 0; y < viewH; y += scanStep) {
            ctx.fillRect(0, y, viewW, 1);
        }

        if (!perf && ambienceFrame % 6 === 0 && Math.sin(ambiencePhase * 5.5) > 0.88) {
            ctx.fillStyle = `rgba(120, 25, 25, ${0.05 + Math.random() * 0.035})`;
            ctx.fillRect(0, 0, viewW, viewH);
        }

        if (!perf && ambienceFrame % 8 === 0 && Math.sin(ambiencePhase * 11) > 0.94) {
            ctx.fillStyle = `rgba(0, 220, 255, ${0.012 + Math.random() * 0.01})`;
            ctx.fillRect(2, 0, viewW, viewH);
            ctx.fillStyle = `rgba(255, 0, 90, ${0.01 + Math.random() * 0.008})`;
            ctx.fillRect(-2, 0, viewW, viewH);
        }

        if (ambienceFrame % 4 === 0) {
            const bracketLen = Math.min(viewW, viewH) * 0.06;
            const margin = 8;
            ctx.strokeStyle = `rgba(160, 35, 35, ${0.22 + Math.sin(ambiencePhase * 2) * 0.1})`;
            ctx.lineWidth = 1.5;
            const corners = [
                [margin, margin + bracketLen, margin, margin, margin + bracketLen, margin],
                [viewW - margin, margin + bracketLen, viewW - margin, margin, viewW - margin - bracketLen, margin],
                [margin, viewH - margin - bracketLen, margin, viewH - margin, margin + bracketLen, viewH - margin],
                [viewW - margin, viewH - margin - bracketLen, viewW - margin, viewH - margin, viewW - margin - bracketLen, viewH - margin]
            ];
            corners.forEach(([x1, y1, x2, y2, x3, y3]) => {
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x3, y3);
                ctx.stroke();
            });
        }
        }
    } else if (theme === 'theme-hacker') {
        ctx.fillStyle = 'rgba(0, 255, 65, 0.05)';
        ctx.fillRect(0, 0, viewW, viewH);
    } else if (theme === 'theme-white-black') {
        /* Liquid shader behind canvas — no pulsing canvas wash */
    } else if (theme === 'theme-pinkcore') {
        const pulse = 0.08 + Math.sin(ambiencePhase * 1.4) * 0.04;
        const grad = ctx.createRadialGradient(viewW * 0.3, viewH * 0.2, viewH * 0.05, viewW * 0.5, viewH * 0.5, viewH * 0.95);
        grad.addColorStop(0, `rgba(255, 255, 255, ${pulse * 0.35})`);
        grad.addColorStop(0.5, `rgba(255, 105, 180, ${pulse * 0.2})`);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, viewW, viewH);
    } else if (theme === 'theme-pixel') {
        const skyGlow = ctx.createLinearGradient(0, 0, 0, viewH);
        skyGlow.addColorStop(0, 'rgba(112, 197, 206, 0.12)');
        skyGlow.addColorStop(1, 'transparent');
        ctx.fillStyle = skyGlow;
        ctx.fillRect(0, 0, viewW, viewH);
    }

    ctx.restore();
}

let roundFreezeScene = null;

function roundFreezeCacheKey() {
    return [
        gameState,
        viewBoardSx, viewBoardSy,
        viewW, viewH,
        (effectiveDpr || 1).toFixed(3),
        currentThemeIndex
    ].join('|');
}

function releaseRoundFreezeScene() {
    if (roundFreezeScene && roundFreezeScene.canvas) {
        roundFreezeScene.canvas.width = 1;
        roundFreezeScene.canvas.height = 1;
    }
    roundFreezeScene = null;
}

function captureRoundFreezeScene() {
    if (!canvas) return;
    const off = (roundFreezeScene && roundFreezeScene.canvas) || document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, off.width, off.height);
    octx.drawImage(canvas, 0, 0);
    roundFreezeScene = { canvas: off, key: roundFreezeCacheKey() };
}

function blitRoundFreezeScene() {
    if (!roundFreezeScene || !roundFreezeScene.canvas) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(roundFreezeScene.canvas, 0, 0);
    ctx.restore();
}

function drawFrozenDeathAnims() {
    const paint = (ent) => {
        if (!ent || !ent.isDead) return;
        ent.draw('body');
    };
    paint(p1);
    if (typeof shouldHideTutorialRival === 'function' ? !shouldHideTutorialRival() : true) paint(p2);
    if (clones && clones.length) clones.forEach(paint);
}

function dropFrozenTrailsForGc() {
    if (typeof isSpectateMode !== 'undefined' && isSpectateMode) return;
    const drop = (ent) => {
        if (ent && Array.isArray(ent.trail) && ent.trail.length) ent.trail.length = 0;
    };
    drop(p1);
    drop(p2);
    if (clones && clones.length) clones.forEach(drop);
}

function draw() {
    // Performance optimization: Skip drawing if not in a game state
    if (gameState !== 'PLAYING' && gameState !== 'COUNTDOWN' && gameState !== 'ROUND_OVER' && gameState !== 'GAME_OVER' && gameState !== 'TUTORIAL') return;
    if (!p1 || !p2 || !ctx) return;
    projIdx = 0;
    const freezePose = gameState === 'ROUND_OVER' || gameState === 'GAME_OVER';
    const freezeKey = freezePose ? roundFreezeCacheKey() : '';
    if (freezePose && roundFreezeScene && roundFreezeScene.key === freezeKey) {
        ctx.clearRect(0, 0, viewW, viewH);
        blitRoundFreezeScene();
        drawFrozenDeathAnims();
        return;
    }
    if (typeof isSpectateMode !== 'undefined' && isSpectateMode) {
        updateViewBoard();
    } else if (p1) {
        ensurePlayerBoard(p1);
        if (p1.boardSx !== _lastDrawViewSx || p1.boardSy !== _lastDrawViewSy) {
            updateViewBoard();
            _lastDrawViewSx = p1.boardSx;
            _lastDrawViewSy = p1.boardSy;
        }
    } else {
        updateViewBoard();
    }
    if (!themeColors.canvasBg) updateThemeColors();
    ctx.clearRect(0, 0, viewW, viewH);
    
    ctx.save();
    // Never set canvas.style.filter — CSS filters on the full canvas hitch Chrome/Firefox hard
    if (canvasPauseFilter) {
        if (canvas.style.filter !== 'none') canvas.style.filter = 'none';
        canvasPauseFilter = '';
    }
    
    if (!freezePose && screenShake > 0) {
        const shakeAmt = isPerformanceMode() ? screenShake * 5 : screenShake * 10;
        const shakeIdx = animUiFrame & 7;
        ctx.translate(SHAKE_TABLE[shakeIdx].x * shakeAmt, SHAKE_TABLE[shakeIdx].y * shakeAmt);
        screenShake *= 0.9;
        if (screenShake < 0.1) screenShake = 0;
    }
    if (themeColors.canvasBg && themeColors.canvasBg !== 'transparent') {
        ctx.fillStyle = themeColors.canvasBg;
        ctx.fillRect(0, 0, viewW, viewH);
    }

    if (!document.body.classList.contains('in-game')) {
        drawThemeAmbience();
    }
    drawNeighborBoardEdges(ctx);
    drawBoardGrid(ctx);
    drawBoardOwnershipTints(ctx);

    // Optimization: Draw pre-rendered grid instead of hundreds of lines
    friendWalls.forEach(wall => {
        if (!wall.owner) return;
        if (typeof isEntityVisibleFromView === 'function') {
            if (!isEntityVisibleFromView(wall, wall.x, wall.y)) return;
            const off = getBoardVisualOffset(wall.boardSx, wall.boardSy);
            if (!off.visible) return;
            withBoardWorldOffset(off.ox, off.oy, () => {
                wall.owner.drawCube(wall.x, wall.y, wall.owner.color, false, null, 0.6);
            });
            return;
        }
        if (typeof isOnViewBoard === 'function' && !isOnViewBoard(wall)) return;
        wall.owner.drawCube(wall.x, wall.y, wall.owner.color, false, null, 0.6);
    });

    drawCheckpoints(ctx);
    if (freezePose) {
        p1.draw('trails');
        if (!p1.isDead) p1.draw('body');
        if (!shouldHideTutorialRival()) {
            p2.draw('trails');
            if (!p2.isDead) p2.draw('body');
        }
    } else {
        p1.draw();
        if (!shouldHideTutorialRival()) p2.draw();
    }
    
    // --- DRAW APPLES ---
    drawApples();

    // --- DRAW SPECIAL SKILLS (CLONES LAST) ---
    if (freezePose) {
        clones.forEach(clone => {
            clone.draw('trails');
            if (!clone.isDead) clone.draw('body');
        });
    } else {
        clones.forEach(clone => clone.draw());
    }

    // --- DRAW LASERS (ABSOLUTE LAST LAYER) — view board + visible neighbor peeks ---
    if (!freezePose && typeof laserLines !== 'undefined' && laserLines.length > 0) {
        laserLines.forEach(laser => {
            if (!laser) return;
            const hasBoard = Number.isInteger(laser.boardSx) && Number.isInteger(laser.boardSy);
            const lsx = hasBoard ? laser.boardSx : viewBoardSx;
            const lsy = hasBoard ? laser.boardSy : viewBoardSy;
            const off = typeof getBoardVisualOffset === 'function'
                ? getBoardVisualOffset(lsx, lsy)
                : { ox: 0, oy: 0, ndx: 0, ndy: 0, visible: lsx === viewBoardSx && lsy === viewBoardSy };
            if (!off.visible) return;

            const bounds = typeof getPeekCellBounds === 'function'
                ? getPeekCellBounds(off.ndx, off.ndy)
                : { x0: 0, x1: GRID_COUNT - 1, y0: 0, y1: GRID_COUNT - 1 };

            let cellMin;
            let cellMax;
            if (laser.isHorizontal) {
                if (laser.pos < bounds.y0 || laser.pos > bounds.y1) return;
                cellMin = bounds.x0;
                cellMax = bounds.x1 + 1;
            } else {
                if (laser.pos < bounds.x0 || laser.pos > bounds.x1) return;
                cellMin = bounds.y0;
                cellMax = bounds.y1 + 1;
            }

            const warnTicks = laser.warningTicks || Math.round(TICK_RATE * 0.5);
            const isWarning = laser.ticks < warnTicks;
            const laserLife = (laser.ticks - warnTicks) / (Math.round(TICK_RATE * 0.5));
            // Classic look: faint warning strip, then brief solid flash that fades out
            const alpha = isWarning
                ? (0.22 + 0.12 * (0.5 + 0.5 * Math.sin(laser.ticks * 0.9)))
                : Math.max(0, 1 - laserLife);
            const pad = 2;
            const beamColor = typeof getLaserDrawColor === 'function'
                ? getLaserDrawColor(laser)
                : (laser.owner && laser.owner.color) || laser.color || '#ffffff';

            withBoardWorldOffset(off.ox, off.oy, () => {
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.fillStyle = beamColor;

                let p1_p, p2_p, p3_p, p4_p;
                if (laser.isHorizontal) {
                    const y = laser.pos * GRID_SIZE + pad;
                    const x0 = cellMin * GRID_SIZE;
                    const x1 = cellMax * GRID_SIZE;
                    p1_p = project(x0, y, 0);
                    p2_p = project(x1, y, 0);
                    p3_p = project(x1, y + GRID_SIZE - pad * 2, 0);
                    p4_p = project(x0, y + GRID_SIZE - pad * 2, 0);
                } else {
                    const x = laser.pos * GRID_SIZE + pad;
                    const y0 = cellMin * GRID_SIZE;
                    const y1 = cellMax * GRID_SIZE;
                    p1_p = project(x, y0, 0);
                    p2_p = project(x + GRID_SIZE - pad * 2, y0, 0);
                    p3_p = project(x + GRID_SIZE - pad * 2, y1, 0);
                    p4_p = project(x, y1, 0);
                }
                ctx.beginPath();
                ctx.moveTo(p1_p.x, p1_p.y);
                ctx.lineTo(p2_p.x, p2_p.y);
                ctx.lineTo(p3_p.x, p3_p.y);
                ctx.lineTo(p4_p.x, p4_p.y);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            });
        });
    }

    if (freezePose) {
        drawRonkInGameScanlines();
        ctx.restore();
        captureRoundFreezeScene();
        drawFrozenDeathAnims();
        return;
    }

    drawRonkInGameScanlines();
    
    ctx.restore();
}

let ronkScanlineCache = null;
let ronkScanlineCacheKey = '';

function drawRonkInGameScanlines() {
    // CSS body::after handles CRT lines in-game — skip per-frame canvas loop (smoother).
    // Keep this no-op; do not reintroduce getImageData/putImageData scanline passes.
    return;
}

function forceShowGameOverUi() {
    gameState = 'GAME_OVER';
    try { SFX.stopAll(); } catch (_) { /* ignore */ }
    if (roundAnnouncerEl) {
        roundAnnouncerEl.classList.add('hidden');
        roundAnnouncerEl.classList.remove('go-phase');
    }
    if (!gameOverDiv) gameOverDiv = document.getElementById('game-over');
    if (!winnerMsg) winnerMsg = document.getElementById('winner-msg');
    if (!gameOverHintEl) gameOverHintEl = document.getElementById('game-over-hint');
    if (!restartBtn) restartBtn = document.getElementById('restart-btn');
    if (typeof showOverlayPanel === 'function' && gameOverDiv) {
        showOverlayPanel(gameOverDiv);
    } else if (gameOverDiv) {
        gameOverDiv.classList.remove('hidden');
        gameOverDiv.style.display = 'flex';
        gameOverDiv.style.visibility = 'visible';
        gameOverDiv.style.opacity = '1';
        gameOverDiv.style.pointerEvents = 'auto';
    }
    if (winnerMsg) {
        try {
            winnerMsg.textContent = getMatchWinnerMessage();
        } catch (_) {
            winnerMsg.textContent = isSpectateMode ? 'MATCH OVER' : 'MATCH OVER';
        }
    }
    if (restartBtn) {
        restartBtn.classList.remove('hidden');
        restartBtn.style.display = '';
    }
    matchEndUiShown = true;
    syncGameplayCursor();
}

let matchEndUiShown = false;

function endGame() {
    const matchTarget = getEffectiveMatchTarget();
    const isMatchOver = p1Score >= matchTarget || p2Score >= matchTarget;

    // Always paint the scoreboard first so FIRST TO N can't look "stuck" without UI
    try { updateScoreboard(); } catch (_) { /* ignore */ }

    // SHOW MATCH UI BEFORE any AI training — training used to throw and skip the window
    if (isMatchOver) {
        const alreadyShown = matchEndUiShown && gameOverDiv && !gameOverDiv.classList.contains('hidden');
        if (alreadyShown) {
            // UI already up — still run learning below, skip duplicate unlocks / button wiring
        } else {
        forceShowGameOverUi();

        const playerWonMatch = didLocalPlayerWinMatch(matchTarget);
        const wasTutorialMatch = isTutorialMatch;
        const humanWon = didHumanControlledSideWinMatch(matchTarget);

        try {
            if (humanWon && !isSpectateMode && isTutorialComplete()) {
                if (defeatedOpponentQualifiesForUnlock()) {
                    captureOpponentLoadoutForUnlock();
                    const loadout = resolveMatchEndUnlockLoadout();
                    const skillId = loadout.skill;
                    const jokerIds = [...loadout.jokers];
                    setTimeout(() => {
                        unlockOpponentLoadout(skillId, jokerIds);
                    }, 450);
                    opponentLoadoutForUnlock = null;
                }
            }

            if (wasTutorialMatch) {
                if (humanWon) {
                    markTutorialComplete();
                    isTutorialMatch = false;
                    hideTutorialOverlay();
                    returnToMenuAfterGameOver = true;
                }
            } else if (humanWon) {
                grantSteamAchievementsOnMatchEnd(humanWon, wasTutorialMatch);
            }
        } catch (err) {
            console.error('Match-end unlock/achievements failed', err);
        }

        if (winnerMsg) {
            try { winnerMsg.textContent = getMatchWinnerMessage(); } catch (_) { /* keep prior */ }
        }

        if (gameOverHintEl) {
            try {
                const hint = getMatchOverHint(wasTutorialMatch, playerWonMatch);
                if (hint) {
                    gameOverHintEl.textContent = hint;
                    gameOverHintEl.classList.remove('hidden');
                } else {
                    gameOverHintEl.textContent = '';
                    gameOverHintEl.classList.add('hidden');
                }
            } catch (_) {
                gameOverHintEl.classList.add('hidden');
            }
        }

        if (isOnline) {
            matchesPlayed++;
            if (restartBtn) restartBtn.classList.add('hidden');
            const voteContainer = document.getElementById('multiplayer-vote-container');
            if (voteContainer) {
                voteContainer.classList.remove('hidden');
                const continueBtn = document.getElementById('continue-btn');
                if (continueBtn) {
                    continueBtn.disabled = false;
                    continueBtn.textContent = 'CONTINUE';
                }
                const statusEl = document.getElementById('vote-status');
                if (statusEl) statusEl.textContent = 'WAITING FOR RIVAL...';
            }
            hasVotedContinue = false;
            enemyVotedContinue = false;
        } else {
            if (restartBtn) {
                restartBtn.classList.remove('hidden');
                restartBtn.textContent = returnToMenuAfterGameOver
                    ? ((translations[localStorage.getItem('ronk_language') || 'en'] || translations['en'])['CONTINUE'] || 'CONTINUE')
                    : (wasTutorialMatch && !playerWonMatch ? 'TRY AGAIN' : 'NEW MATCH');
            }
            const voteContainer = document.getElementById('multiplayer-vote-container');
            if (voteContainer) voteContainer.classList.add('hidden');
        }

        try { updateScoreboard(); } catch (_) { /* ignore */ }
        } // end !alreadyShown
        try { window.RonkSteamAchievements?.flushPendingSteamUnlocks?.(); } catch (_) { /* ignore */ }
    } else {
        // Mid-match round — next board after a short beat
        setTimeout(initGame, 1000);
    }
}

function showTier(tierId) {
    if (!menuTiers || menuTiers.length === 0) menuTiers = document.querySelectorAll('.menu-tier');
    menuTiers.forEach(tier => {
        if (tier.id === tierId) {
            tier.classList.remove('hidden');
            tier.style.display = 'flex';
        } else {
            tier.classList.add('hidden');
            tier.style.display = 'none';
        }
    });
    if (!isThemeSwitching && activeNavigation.screen === 'menu') {
        activeNavigation.menuTier = tierId;
    }
    // Do NOT re-apply body theme on every click — forces full style recalc / blank flash in Chrome
}

function resetToMainTier() {
    if (isThemeSwitching || isOverlayScreenActive() || isInActiveGameView()) return;
    setActiveNavigation('menu', { menuTier: 'main-menu-tier' });
    if (menu) { 
        menu.style.display = 'flex'; 
        menu.style.visibility = 'visible'; 
        menu.style.opacity = '1'; 
        menu.classList.remove('hidden'); 
        menu.style.pointerEvents = 'auto';
    }
    if (themeBtn) {
        setThemeBtnVisible(introFinished);
    }
    showTier('main-menu-tier');
}

/** Hooks for browser Steam-store capture / local tooling — same live match objects. */
if (typeof globalThis !== 'undefined') {
    globalThis.__ronkGet = function () {
        return {
            p1, p2, apples, worldBoards, clones,
            gameState, p1Score, p2Score, isPaused, gameHasStarted, isSpectateMode,
            GRID_COUNT, MATCH_TARGET, currentGamemode, currentBotDifficulty,
            countdownValue, introFinished, animLoop, lastBoardWinReason,
            update, initGame, launchGameMode, draw, changeTheme, initThemeBackground,
            showMainMenu, resetToMainTier, showLoadoutPage, SFX, Music
        };
    };
    globalThis.__ronkSet = function (k, v) {
        if (k === 'gameState') gameState = v;
        else if (k === 'gameHasStarted') gameHasStarted = v;
        else if (k === 'countdownValue') countdownValue = v;
        else if (k === 'isPaused') isPaused = v;
        else if (k === 'animLoop') animLoop = v;
        else if (k === 'introFinished') introFinished = v;
        else if (k === 'p1Score') p1Score = v;
        else if (k === 'p2Score') p2Score = v;
        else if (k === 'matchEndUiShown') matchEndUiShown = v;
        else if (k === 'endTimerStarted') endTimerStarted = v;
        else if (k === 'roundsCompletedThisMatch') roundsCompletedThisMatch = v;
    };
}
