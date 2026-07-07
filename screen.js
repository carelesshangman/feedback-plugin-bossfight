/*
 * feedBack plugin: bossfight
 *
 * A "type": "visualization" plugin implementing the setRenderer contract
 * (window.feedBackViz_bossfight) with contextType 'webgl2'. It replaces the
 * built-in 2D highway with a Three.js scene: a 3D note highway in the
 * foreground and a boss arena as the background. Consecutive correct notes
 * build a streak; every 5-streak milestone hurls a rock at the boss.
 *
 * Hit/miss verdicts come from bundle.getNoteState(note, chartTime) — i.e.
 * whatever scorer plugin (note_detect, virtuoso, ...) has registered a
 * note-state provider. When no scorer is active, the "Auto-hit" per-instance
 * setting (default on) judges every note a hit so the fight is watchable
 * without a mic.
 */
(function () {
    'use strict';

    var PLUGIN_ID = 'bossfight';

    // ------------------------------------------------------------------
    // three.js loader — vendored ES module under assets/. Resolve relative
    // to this script's own URL first (works in host and in demo/), then fall
    // back to the sandboxed plugin asset route.
    // ------------------------------------------------------------------
    var _scriptSrc = (document.currentScript && document.currentScript.src) || '';
    var _threeCandidates = [];
    if (_scriptSrc) {
        try { _threeCandidates.push(new URL('assets/three.module.js', _scriptSrc).href); } catch (e) { /* ignore */ }
    }
    _threeCandidates.push('/api/plugins/' + PLUGIN_ID + '/assets/three.module.js');

    var _threePromise = (function tryLoad(i) {
        if (i >= _threeCandidates.length) {
            return Promise.reject(new Error('[bossfight] could not load three.module.js'));
        }
        return import(_threeCandidates[i]).catch(function () { return tryLoad(i + 1); });
    })(0);
    _threePromise.catch(function (err) { console.error(err); });

    // ------------------------------------------------------------------
    // Tunables
    // ------------------------------------------------------------------
    var LANE_W = 1.5;          // world units per string lane
    var SPEED = 13;            // world units per second of chart time
    var VIEW_AHEAD = 4.5;      // seconds of upcoming notes rendered
    var VIEW_BEHIND = 0.6;     // seconds of past notes kept visible
    var GRACE = 0.4;           // seconds after note time before a silent scorer means "miss"
    var ROCK_FLIGHT = 0.8;     // seconds a rock spends in the air
    var STREAK_STEP = 5;       // rock thrown every N consecutive hits
    var BOSS_Z = -46;
    var BOSS_BASE_HP = 100;

    // Rocksmith-style string colours, low string (s=0) upward.
    var STRING_COLORS = [0xef4444, 0xfacc15, 0x3b82f6, 0xf97316, 0x22c55e, 0xa855f7, 0x14b8a6, 0xe879f9];

    function lowerBound(events, t) {
        var lo = 0, hi = events.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (events[mid].t < t) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    // ==================================================================
    // BossFightGame — owns the Three.js scene, HUD DOM and game state.
    // ==================================================================
    function BossFightGame(THREE, canvas) {
        this.THREE = THREE;
        this.canvas = canvas;
        this.settings = { autohit: true, shake: true };

        this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
        this.renderer.setClearColor(0x080810, 1);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x0a0a16, 30, 95);

        this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
        this.camera.position.set(0, 7.5, 13);
        this.camera.lookAt(0, 2.5, -20);
        this._camBase = this.camera.position.clone();

        this._disposables = [];
        this._shake = 0;

        // chart / judging state
        this.events = [];          // flattened note events sorted by t
        this._notesRef = null;
        this._chordsRef = null;
        this._judgeIdx = 0;        // first event not yet resolved
        this._lastNow = -1e9;
        this._sawScorer = false;

        // combat state
        this.streak = 0;
        this.bestStreak = 0;
        this.level = 1;
        this.bossMaxHp = BOSS_BASE_HP;
        this.bossHp = BOSS_BASE_HP;
        this.bossState = 'alive';  // alive | dying | spawning
        this._bossStateT = 0;
        this._bossFlash = 0;

        this.rocks = [];
        this._lanes = 6;

        // beat-synced boss attack (boulder thrown AT the player)
        this.attack = null;
        this._beatsRef = null;
        this._beatIdx = 0;         // pointer for beat-pulse tracking
        this._attackScanIdx = 0;   // pointer for attack scheduling
        this._beatPulse = 0;

        this._buildLights();
        this._buildArena();
        this._buildBoss();
        this._buildHighway(6);
        this._buildNotePool();
        this._buildParticles();
        this._buildHud();
    }

    BossFightGame.prototype._track = function (obj) {
        this._disposables.push(obj);
        return obj;
    };

    BossFightGame.prototype._mat = function (opts) {
        return this._track(new this.THREE.MeshStandardMaterial(opts));
    };

    // ---------------- scene construction ----------------

    BossFightGame.prototype._buildLights = function () {
        var THREE = this.THREE;
        this.scene.add(new THREE.AmbientLight(0x445566, 2.4));
        var key = new THREE.DirectionalLight(0x8899ff, 2.0);
        key.position.set(-6, 20, 8);
        this.scene.add(key);
        this.bossLight = new THREE.PointLight(0xff5522, 90, 70, 1.6);
        this.bossLight.position.set(0, 8, BOSS_Z + 6);
        this.scene.add(this.bossLight);
        var cool = new THREE.PointLight(0x4455ff, 30, 50, 1.8);
        cool.position.set(10, 4, -20);
        this.scene.add(cool);
    };

    BossFightGame.prototype._buildArena = function () {
        var THREE = this.THREE;
        var groundGeo = this._track(new THREE.PlaneGeometry(240, 240));
        var ground = new THREE.Mesh(groundGeo, this._mat({ color: 0x0d0d18, roughness: 1 }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.05;
        this.scene.add(ground);

        // jagged pillars ringing the boss
        var pillarGeo = this._track(new THREE.ConeGeometry(2.2, 16, 5));
        var pillarMat = this._mat({ color: 0x1a1a2c, roughness: 0.9, flatShading: true });
        for (var i = 0; i < 9; i++) {
            var a = (i / 9) * Math.PI * 2 + 0.4;
            var p = new THREE.Mesh(pillarGeo, pillarMat);
            var r = 26 + (i % 3) * 6;
            var x = Math.sin(a) * r;
            if (Math.abs(x) < 9) x = x < 0 ? -9 - i : 9 + i; // keep the view corridor to the boss clear
            p.position.set(x, 8 - (i % 2) * 3, BOSS_Z + Math.cos(a) * r * 0.6 - 6);
            p.rotation.z = Math.sin(i * 7) * 0.12;
            p.scale.setScalar(0.7 + (i % 4) * 0.25);
            this.scene.add(p);
        }
    };

    BossFightGame.prototype._buildBoss = function () {
        var THREE = this.THREE;
        var boss = new THREE.Group();

        this._bossBodyMat = this._mat({ color: 0x3d2a55, roughness: 0.65, flatShading: true, emissive: 0x000000 });
        var body = new THREE.Mesh(this._track(new THREE.IcosahedronGeometry(4.2, 1)), this._bossBodyMat);
        body.position.y = 6.5;
        body.scale.y = 1.25;
        boss.add(body);

        var head = new THREE.Mesh(this._track(new THREE.IcosahedronGeometry(1.9, 0)), this._bossBodyMat);
        head.position.y = 12.2;
        boss.add(head);

        var hornGeo = this._track(new THREE.ConeGeometry(0.5, 2.6, 4));
        var hornMat = this._mat({ color: 0x181820, roughness: 0.4, flatShading: true });
        var hl = new THREE.Mesh(hornGeo, hornMat);
        hl.position.set(-1.3, 13.8, 0);
        hl.rotation.z = 0.5;
        boss.add(hl);
        var hr = new THREE.Mesh(hornGeo, hornMat);
        hr.position.set(1.3, 13.8, 0);
        hr.rotation.z = -0.5;
        boss.add(hr);

        this._eyeMat = this._mat({ color: 0x220a00, emissive: 0xff7722, emissiveIntensity: 2.2 });
        var eyeGeo = this._track(new THREE.SphereGeometry(0.32, 10, 10));
        var el = new THREE.Mesh(eyeGeo, this._eyeMat);
        el.position.set(-0.7, 12.4, 1.55);
        boss.add(el);
        var er = new THREE.Mesh(eyeGeo, this._eyeMat);
        er.position.set(0.7, 12.4, 1.55);
        boss.add(er);

        // orbiting debris for menace
        this._debris = [];
        var debGeo = this._track(new THREE.DodecahedronGeometry(0.55, 0));
        var debMat = this._mat({ color: 0x2a2a3e, roughness: 0.9, flatShading: true });
        for (var i = 0; i < 6; i++) {
            var d = new THREE.Mesh(debGeo, debMat);
            d.userData.phase = (i / 6) * Math.PI * 2;
            boss.add(d);
            this._debris.push(d);
        }

        boss.position.set(0, 0, BOSS_Z);
        this.scene.add(boss);
        this.boss = boss;
    };

    BossFightGame.prototype._buildHighway = function (lanes) {
        var THREE = this.THREE;
        if (this.highwayGroup) this.scene.remove(this.highwayGroup);
        this._lanes = lanes;

        var g = new THREE.Group();
        var width = lanes * LANE_W;
        var length = (VIEW_AHEAD + VIEW_BEHIND) * SPEED;

        var deck = new THREE.Mesh(
            this._track(new THREE.PlaneGeometry(width, length)),
            this._mat({ color: 0x11121f, roughness: 0.95, transparent: true, opacity: 0.92 })
        );
        deck.rotation.x = -Math.PI / 2;
        deck.position.set(0, 0.01, (VIEW_BEHIND * SPEED) - length / 2);
        g.add(deck);

        var lineGeo = this._track(new THREE.PlaneGeometry(0.05, length));
        var lineMat = this._mat({ color: 0x2e3050, roughness: 1 });
        for (var i = 0; i <= lanes; i++) {
            var line = new THREE.Mesh(lineGeo, lineMat);
            line.rotation.x = -Math.PI / 2;
            line.position.set((i - lanes / 2) * LANE_W, 0.02, deck.position.z);
            g.add(line);
        }

        // strike line at z = 0 (pulses on the beat)
        this._strikeMat = this._mat({ color: 0xffffff, emissive: 0x8899ff, emissiveIntensity: 1.2 });
        var strike = new THREE.Mesh(
            this._track(new THREE.PlaneGeometry(width + 0.6, 0.28)),
            this._strikeMat
        );
        strike.rotation.x = -Math.PI / 2;
        strike.position.set(0, 0.03, 0);
        g.add(strike);

        // beat-line pool
        this._beatLines = [];
        var beatGeo = this._track(new THREE.PlaneGeometry(width, 0.07));
        var beatMat = this._mat({ color: 0x3a3d66, transparent: true, opacity: 0.55 });
        for (var b = 0; b < 40; b++) {
            var bl = new THREE.Mesh(beatGeo, beatMat);
            bl.rotation.x = -Math.PI / 2;
            bl.visible = false;
            g.add(bl);
            this._beatLines.push(bl);
        }

        this.scene.add(g);
        this.highwayGroup = g;
    };

    BossFightGame.prototype._buildNotePool = function () {
        var THREE = this.THREE;
        this._noteGeo = this._track(new THREE.BoxGeometry(LANE_W * 0.72, 0.5, 0.5));
        this._tailGeo = this._track(new THREE.BoxGeometry(LANE_W * 0.22, 0.14, 1)); // scaled per sustain
        this._noteMats = [];
        for (var c = 0; c < STRING_COLORS.length; c++) {
            this._noteMats.push(this._mat({
                color: STRING_COLORS[c], roughness: 0.35,
                emissive: STRING_COLORS[c], emissiveIntensity: 0.35,
                transparent: true
            }));
        }
        this._notePool = [];
        for (var i = 0; i < 120; i++) {
            var gem = new THREE.Mesh(this._noteGeo, this._noteMats[0]);
            gem.visible = false;
            var tail = new THREE.Mesh(this._tailGeo, this._noteMats[0]);
            tail.visible = false;
            this.scene.add(gem);
            this.scene.add(tail);
            this._notePool.push({ gem: gem, tail: tail });
        }
    };

    BossFightGame.prototype._buildParticles = function () {
        var THREE = this.THREE;
        var N = 240;
        this._pN = N;
        this._pPos = new Float32Array(N * 3);
        this._pVel = new Float32Array(N * 3);
        this._pLife = new Float32Array(N);
        for (var i = 0; i < N; i++) this._pPos[i * 3 + 1] = -999;
        var geo = this._track(new THREE.BufferGeometry());
        geo.setAttribute('position', new THREE.BufferAttribute(this._pPos, 3));
        var mat = this._track(new THREE.PointsMaterial({
            color: 0xffcc88, size: 0.35, transparent: true, opacity: 0.95, depthWrite: false
        }));
        var pts = new THREE.Points(geo, mat);
        pts.frustumCulled = false;
        this.scene.add(pts);
        this._points = pts;
        this._pCursor = 0;
    };

    BossFightGame.prototype._burst = function (x, y, z, count, spread, up) {
        for (var i = 0; i < count; i++) {
            var idx = this._pCursor;
            this._pCursor = (this._pCursor + 1) % this._pN;
            this._pPos[idx * 3] = x;
            this._pPos[idx * 3 + 1] = y;
            this._pPos[idx * 3 + 2] = z;
            this._pVel[idx * 3] = (Math.random() - 0.5) * spread;
            this._pVel[idx * 3 + 1] = Math.random() * up + 2;
            this._pVel[idx * 3 + 2] = (Math.random() - 0.5) * spread;
            this._pLife[idx] = 0.6 + Math.random() * 0.5;
        }
    };

    // ---------------- HUD (DOM overlay, refs cached — never queried per frame) ----------------

    BossFightGame.prototype._buildHud = function () {
        var host = this.canvas.parentElement || document.body;
        if (host !== document.body && !host.style.position) host.style.position = 'relative';

        var hud = document.createElement('div');
        hud.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;' +
            'font-family:system-ui,sans-serif;color:#e8e8f2;user-select:none;';

        hud.innerHTML =
            '<div style="position:absolute;top:12px;left:50%;transform:translateX(-50%);text-align:center;width:min(420px,70%);">' +
              '<div data-bf="bossname" style="font-size:15px;letter-spacing:3px;font-weight:700;text-shadow:0 0 8px #f52;">THE GRAVELORD</div>' +
              '<div style="margin-top:5px;height:10px;background:#1c1626;border:1px solid #553;border-radius:5px;overflow:hidden;">' +
                '<div data-bf="hp" style="height:100%;width:100%;background:linear-gradient(90deg,#c1121f,#ff6d00);transition:width .15s;"></div>' +
              '</div>' +
            '</div>' +
            '<div style="position:absolute;left:18px;bottom:16px;">' +
              '<div data-bf="streak" style="font-size:34px;font-weight:800;color:#9aa0ff;text-shadow:0 0 10px #55f;">0</div>' +
              '<div style="font-size:11px;letter-spacing:2px;opacity:.7;">STREAK</div>' +
            '</div>' +
            '<div data-bf="toast" style="position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);' +
              'font-size:40px;font-weight:900;letter-spacing:2px;opacity:0;transition:opacity .25s;text-shadow:0 0 14px #fa0;"></div>' +
            '<div data-bf="flash" style="position:absolute;inset:0;opacity:0;transition:opacity .12s;' +
              'background:radial-gradient(ellipse at center,rgba(220,30,20,0) 35%,rgba(220,30,20,.75) 100%);"></div>' +
            '<div data-bf="auto" style="position:absolute;right:14px;top:12px;display:none;' +
              'font-size:11px;letter-spacing:1.5px;padding:3px 8px;border:1px solid #666;border-radius:4px;' +
              'color:#aab;background:rgba(10,10,22,.6);">AUTO-HIT · no note detection</div>';

        host.appendChild(hud);
        this._hud = hud;
        this._hudHp = hud.querySelector('[data-bf="hp"]');
        this._hudStreak = hud.querySelector('[data-bf="streak"]');
        this._hudToast = hud.querySelector('[data-bf="toast"]');
        this._hudBossName = hud.querySelector('[data-bf="bossname"]');
        this._hudFlash = hud.querySelector('[data-bf="flash"]');
        this._hudAuto = hud.querySelector('[data-bf="auto"]');
        this._hudAutoVal = null;
        this._hudStreakVal = -1;
        this._hudHpVal = -1;
        this._toastTimer = 0;
        this._flashTimer = 0;
    };

    BossFightGame.prototype._toast = function (text, color) {
        this._hudToast.textContent = text;
        this._hudToast.style.color = color || '#ffd166';
        this._hudToast.style.opacity = '1';
        this._toastTimer = 1.1;
    };

    BossFightGame.prototype.setHudVisible = function (v) {
        if (this._hud) this._hud.style.display = v ? '' : 'none';
    };

    // ---------------- chart ingestion & judging ----------------

    BossFightGame.prototype._rebuildEvents = function (notes, chords) {
        var evs = [];
        var i;
        if (notes) {
            for (i = 0; i < notes.length; i++) {
                var n = notes[i];
                evs.push({ t: n.t, s: n.s || 0, sus: n.sus || 0, note: n, chordTime: n.t });
            }
        }
        if (chords) {
            for (i = 0; i < chords.length; i++) {
                var ch = chords[i];
                var cn = ch.notes || [];
                for (var k = 0; k < cn.length; k++) {
                    evs.push({ t: ch.t, s: cn[k].s || 0, sus: cn[k].sus || 0, note: cn[k], chordTime: ch.t });
                }
            }
        }
        evs.sort(function (a, b) { return a.t - b.t; });
        this.events = evs;
        this._judgeIdx = 0;
        this._pending = [];
    };

    BossFightGame.prototype._resetJudging = function (now) {
        this._judgeIdx = lowerBound(this.events, now);
        this._pending = [];
        this.streak = 0;
        for (var i = 0; i < this.rocks.length; i++) this.scene.remove(this.rocks[i].mesh);
        this.rocks.length = 0;
        this._clearAttack();
        this._attackScanIdx = 0;
        this._beatIdx = 0;
        for (var j = 0; j < this.events.length; j++) {
            if (this.events[j].t >= now) delete this.events[j].judged;
        }
    };

    BossFightGame.prototype._laneX = function (s, mirrored) {
        var lane = mirrored ? (this._lanes - 1 - s) : s;
        return (lane - (this._lanes - 1) / 2) * LANE_W;
    };

    BossFightGame.prototype._onHit = function (ev, mirrored) {
        this.streak++;
        if (this.streak > this.bestStreak) this.bestStreak = this.streak;
        var x = this._laneX(ev.s, mirrored);
        this._burst(x, 0.5, 0, 8, 4, 3);
        if (this.attack && this.attack.mesh && ev.t >= this.attack.launchTime) this.attack.hits++;
        if (this.streak % STREAK_STEP === 0 && this.bossState === 'alive') {
            this._throwRock(x, 1 + Math.min(2, this.streak / 25));
            this._toast(this.streak + ' STREAK!', '#ffd166');
        }
    };

    BossFightGame.prototype._onMiss = function (ev) {
        if (this.streak >= STREAK_STEP) this._toast('STREAK BROKEN', '#ef4444');
        this.streak = 0;
        if (this.attack && this.attack.mesh && ev && ev.t >= this.attack.launchTime) this.attack.misses++;
        this._eyeMat.emissiveIntensity = 5;   // boss eyes flare
        if (this.settings.shake) this._shake = Math.max(this._shake, 0.25);
    };

    BossFightGame.prototype._judge = function (now, getNoteState, mirrored) {
        // move newly-due events into the pending window
        while (this._judgeIdx < this.events.length && this.events[this._judgeIdx].t <= now) {
            this._pending.push(this.events[this._judgeIdx]);
            this._judgeIdx++;
        }
        // resolve pending events
        for (var i = this._pending.length - 1; i >= 0; i--) {
            var ev = this._pending[i];
            var state = null;
            if (getNoteState) {
                var raw = getNoteState(ev.note, ev.chordTime);
                if (raw) {
                    state = typeof raw === 'string' ? raw : raw.state;
                    if (state) this._sawScorer = true;
                }
            }
            var resolved = null;
            if (state === 'hit' || state === 'active') resolved = 'hit';
            else if (state === 'miss') resolved = 'miss';
            else if (!this._sawScorer && this.settings.autohit) resolved = 'hit';
            else if (now - ev.t > GRACE) resolved = 'miss';

            if (resolved) {
                this._pending.splice(i, 1);
                ev.judged = resolved;
                if (resolved === 'hit') this._onHit(ev, mirrored); else this._onMiss(ev);
            }
        }
    };

    // ---------------- rocks & boss ----------------

    BossFightGame.prototype._throwRock = function (fromX, power) {
        var THREE = this.THREE;
        if (!this._rockGeo) {
            this._rockGeo = this._track(new THREE.DodecahedronGeometry(0.8, 0));
            this._rockMat = this._mat({ color: 0x8a7f70, roughness: 0.9, flatShading: true });
        }
        var mesh = new THREE.Mesh(this._rockGeo, this._rockMat);
        var s = 0.8 + power * 0.35;
        mesh.scale.setScalar(s);
        this.scene.add(mesh);
        this.rocks.push({
            mesh: mesh, t: 0, power: power,
            from: new THREE.Vector3(fromX, 0.6, 0),
            to: new THREE.Vector3((Math.random() - 0.5) * 2, 8 + Math.random() * 4, BOSS_Z + 2)
        });
    };

    BossFightGame.prototype._damageBoss = function (amount) {
        if (this.bossState !== 'alive') return;
        this.bossHp = Math.max(0, this.bossHp - amount);
        this._bossFlash = 1;
        if (this.settings.shake) this._shake = Math.max(this._shake, 0.5);
        if (this.bossHp <= 0) {
            this.bossState = 'dying';
            this._bossStateT = 0;
            this._toast('BOSS DOWN!', '#22c55e');
        }
    };

    BossFightGame.prototype._updateBoss = function (dt, now) {
        var b = this.boss;
        var t = now;
        if (this.bossState === 'alive') {
            b.position.y = Math.sin(t * 1.3) * 0.6;
            b.rotation.y = Math.sin(t * 0.4) * 0.25;
            b.scale.setScalar(1);
        } else if (this.bossState === 'dying') {
            this._bossStateT += dt;
            var k = Math.min(1, this._bossStateT / 2.2);
            b.rotation.z = k * 0.9;
            b.position.y = -k * 9;
            if (k >= 1) {
                this.level++;
                this.bossMaxHp = Math.round(this.bossMaxHp * 1.3);
                this.bossHp = this.bossMaxHp;
                this.bossState = 'spawning';
                this._bossStateT = 0;
                this._hudBossName.textContent = 'THE GRAVELORD  ✦ LV ' + this.level;
            }
        } else { // spawning
            this._bossStateT += dt;
            var k2 = Math.min(1, this._bossStateT / 1.4);
            b.rotation.z = 0;
            b.position.y = -9 + k2 * 9;
            if (k2 >= 1) this.bossState = 'alive';
        }

        // damage flash
        this._bossFlash = Math.max(0, this._bossFlash - dt * 3);
        this._bossBodyMat.emissive.setRGB(this._bossFlash * 0.9, this._bossFlash * 0.1, this._bossFlash * 0.05);

        // eye pulse decays back to base
        this._eyeMat.emissiveIntensity += (2.2 - this._eyeMat.emissiveIntensity) * Math.min(1, dt * 4);
        this.bossLight.intensity = 85 + Math.sin(t * 7) * 12 + this._bossFlash * 120;

        for (var i = 0; i < this._debris.length; i++) {
            var d = this._debris[i];
            var a = t * 0.7 + d.userData.phase;
            d.position.set(Math.cos(a) * 7, 7 + Math.sin(a * 1.7) * 2.5, Math.sin(a) * 5);
            d.rotation.x = a;
            d.rotation.y = a * 1.3;
        }
    };

    // chartDt (chart-time delta) keeps projectiles in sync with the song —
    // they pause when playback pauses and stay beat-consistent under frame hitches.
    BossFightGame.prototype._updateRocks = function (dt, chartDt) {
        for (var i = this.rocks.length - 1; i >= 0; i--) {
            var r = this.rocks[i];
            r.t += chartDt / ROCK_FLIGHT;
            if (r.t >= 1) {
                this._burst(r.to.x, r.to.y, r.to.z, 26, 9, 6);
                this._damageBoss(6 * r.power);
                this.scene.remove(r.mesh);
                this.rocks.splice(i, 1);
                continue;
            }
            var k = r.t;
            var m = r.mesh.position;
            m.lerpVectors(r.from, r.to, k);
            m.y += Math.sin(k * Math.PI) * 9; // arc apex
            r.mesh.rotation.x += dt * 9;
            r.mesh.rotation.y += dt * 7;
        }
    };

    // ---------------- beat-synced boss attack ----------------
    // On a measure boundary (every ATTACK_MEASURES measures) the boss winds up
    // and hurls a boulder at the player. It launches on the downbeat and lands
    // exactly 4 beats later. Play that riff cleanly (no miss, enough hits) and
    // the boulder is deflected back into the boss for heavy damage; flub it and
    // you get crushed: screen flash, big shake, streak gone.

    BossFightGame.prototype._scheduleAttack = function (beats, now) {
        if (!beats || beats.length < 8 || this.bossState !== 'alive') return;
        var ATTACK_MEASURES = 8;
        var i = this._attackScanIdx;
        while (i < beats.length - 4) {
            var b = beats[i];
            if (b.time > now + 1.0) {
                var measure = (typeof b.measure === 'number') ? b.measure : -1;
                var onBoundary = measure >= 0 ? (measure > 0 && measure % ATTACK_MEASURES === 0 && (i === 0 || beats[i - 1].measure !== measure))
                                              : (i % (ATTACK_MEASURES * 4) === 0);
                if (onBoundary) {
                    this.attack = {
                        windupTime: b.time - 1.4,
                        launchTime: b.time,
                        impactTime: beats[i + 4].time, // lands on the downbeat, 4 beats later
                        windupShown: false,
                        mesh: null,
                        hits: 0,
                        misses: 0
                    };
                    this._attackScanIdx = i + 4;
                    return;
                }
            }
            i++;
        }
        this._attackScanIdx = i;
    };

    BossFightGame.prototype._clearAttack = function () {
        if (this.attack && this.attack.mesh) this.scene.remove(this.attack.mesh);
        this.attack = null;
    };

    BossFightGame.prototype._updateAttack = function (beats, now, dt) {
        var THREE = this.THREE;
        if (!this.attack) {
            this._scheduleAttack(beats, now);
            return;
        }
        var a = this.attack;

        if (!a.windupShown && now >= a.windupTime) {
            a.windupShown = true;
            this._eyeMat.emissiveIntensity = 6;
            this._toast('⚠ INCOMING RIFF', '#f97316');
        }

        if (!a.mesh && now >= a.launchTime) {
            if (!this._boulderGeo) {
                this._boulderGeo = this._track(new THREE.DodecahedronGeometry(1.6, 1));
                this._boulderMat = this._mat({ color: 0x6b5f52, roughness: 0.85, flatShading: true, emissive: 0xff3300, emissiveIntensity: 0.25 });
            }
            a.mesh = new THREE.Mesh(this._boulderGeo, this._boulderMat);
            a.from = new THREE.Vector3(this.boss.position.x, 11, BOSS_Z + 3);
            a.to = new THREE.Vector3(0, 2.4, 9); // just in front of the camera
            this.scene.add(a.mesh);
            if (this.settings.shake) this._shake = Math.max(this._shake, 0.2);
        }

        if (a.mesh && now < a.impactTime) {
            var k = Math.max(0, Math.min(1, (now - a.launchTime) / Math.max(0.001, a.impactTime - a.launchTime)));
            a.mesh.position.lerpVectors(a.from, a.to, k);
            a.mesh.position.y += Math.sin(k * Math.PI) * 7;
            a.mesh.rotation.x += dt * 5;
            a.mesh.rotation.y += dt * 4;
            var grow = 1 + k * 0.8;
            a.mesh.scale.setScalar(grow);
        }

        if (now >= a.impactTime) {
            // how many notes fell inside the riff window?
            var expected = lowerBound(this.events, a.impactTime) - lowerBound(this.events, a.launchTime);
            var success = a.misses === 0 && (expected === 0 || a.hits >= Math.ceil(expected * 0.5));
            if (a.mesh) {
                if (success) {
                    this._burst(a.mesh.position.x, a.mesh.position.y, a.mesh.position.z, 30, 10, 7);
                    this._toast('DEFLECTED!', '#22c55e');
                    // send it back for heavy counter damage
                    this.rocks.push({
                        mesh: a.mesh, t: 0, power: 4,
                        from: a.mesh.position.clone(),
                        to: new THREE.Vector3(0, 9, BOSS_Z + 2)
                    });
                    a.mesh = null; // ownership handed to rocks
                } else {
                    this._toast('CRUSHED!', '#ef4444');
                    this.streak = 0;
                    this._flashTimer = 0.6;
                    this._hudFlash.style.opacity = '1';
                    if (this.settings.shake) this._shake = Math.max(this._shake, 1.0);
                    this.scene.remove(a.mesh);
                }
            }
            this._clearAttack();
        }
    };

    BossFightGame.prototype._updateParticles = function (dt) {
        for (var i = 0; i < this._pN; i++) {
            if (this._pLife[i] <= 0) continue;
            this._pLife[i] -= dt;
            if (this._pLife[i] <= 0) { this._pPos[i * 3 + 1] = -999; continue; }
            this._pVel[i * 3 + 1] -= 14 * dt; // gravity
            this._pPos[i * 3] += this._pVel[i * 3] * dt;
            this._pPos[i * 3 + 1] += this._pVel[i * 3 + 1] * dt;
            this._pPos[i * 3 + 2] += this._pVel[i * 3 + 2] * dt;
        }
        this._points.geometry.attributes.position.needsUpdate = true;
    };

    // ---------------- per-frame note rendering ----------------

    BossFightGame.prototype._drawNotes = function (now, mirrored) {
        var start = lowerBound(this.events, now - VIEW_BEHIND);
        var poolIdx = 0;
        for (var i = start; i < this.events.length && poolIdx < this._notePool.length; i++) {
            var ev = this.events[i];
            if (ev.t > now + VIEW_AHEAD) break;
            var slot = this._notePool[poolIdx++];
            var gem = slot.gem, tail = slot.tail;
            var mat = this._noteMats[ev.s % this._noteMats.length];
            var x = this._laneX(ev.s, mirrored);
            var z = -(ev.t - now) * SPEED;

            gem.visible = true;
            gem.material = mat;
            gem.position.set(x, 0.35, z);

            // NOTE: materials are shared per string — animate transform only.
            if (ev.judged === 'hit' && ev.t <= now) {
                // pop at the strike line: quick grow, then gone
                var age = (now - ev.t) / 0.22;
                if (age >= 1) { gem.visible = false; slot.tail.visible = false; continue; }
                gem.position.z = 0;
                gem.scale.setScalar(1 + age * 1.4);
            } else if (ev.judged === 'miss' && ev.t <= now) {
                // sink and shrink through the deck
                var age2 = (now - ev.t) / 0.45;
                if (age2 >= 1) { gem.visible = false; slot.tail.visible = false; continue; }
                gem.scale.setScalar(Math.max(0.05, 1 - age2 * 0.9));
                gem.position.y = 0.35 - age2 * 0.8;
            } else {
                gem.scale.setScalar(1);
            }

            if (ev.sus > 0.05 && !ev.judged) {
                var len = ev.sus * SPEED;
                tail.visible = true;
                tail.material = mat;
                tail.scale.set(1, 1, len);
                tail.position.set(x, 0.2, z - len / 2);
            } else {
                tail.visible = false;
            }
        }
        for (; poolIdx < this._notePool.length; poolIdx++) {
            this._notePool[poolIdx].gem.visible = false;
            this._notePool[poolIdx].tail.visible = false;
        }
    };

    BossFightGame.prototype._drawBeats = function (beats, now) {
        var used = 0;
        if (beats && beats.length) {
            var lo = 0, hi = beats.length;
            while (lo < hi) { var mid = (lo + hi) >> 1; if (beats[mid].time < now - VIEW_BEHIND) lo = mid + 1; else hi = mid; }
            for (var i = lo; i < beats.length && used < this._beatLines.length; i++) {
                if (beats[i].time > now + VIEW_AHEAD) break;
                var bl = this._beatLines[used++];
                bl.visible = true;
                bl.position.z = -(beats[i].time - now) * SPEED;
            }
        }
        for (; used < this._beatLines.length; used++) this._beatLines[used].visible = false;
    };

    // ---------------- main tick ----------------

    BossFightGame.prototype.frame = function (bundle, dt) {
        var now = bundle.currentTime || 0;
        var mirrored = !!(bundle.lefty || bundle.inverted);

        // chart swap (array references change when data changes)
        if (bundle.notes !== this._notesRef || bundle.chords !== this._chordsRef) {
            this._notesRef = bundle.notes;
            this._chordsRef = bundle.chords;
            this._rebuildEvents(bundle.notes, bundle.chords);
            this._resetJudging(now);
            var sc = bundle.stringCount || 6;
            if (sc !== this._lanes) this._buildHighway(sc);
        }
        if (bundle.beats !== this._beatsRef) {
            this._beatsRef = bundle.beats;
            this._attackScanIdx = 0;
            this._beatIdx = 0;
            this._clearAttack();
        }
        // seek (backwards, or a big forward jump) → don't batch-judge skipped notes
        if (now < this._lastNow - 0.75 || now > this._lastNow + 2) this._resetJudging(now);
        var chartDt = Math.max(0, Math.min(0.5, now - this._lastNow));
        this._lastNow = now;

        if (bundle.isReady !== false) {
            this._judge(now, bundle.getNoteState, mirrored);
        }

        // beat pulse on the strike line
        var beats = bundle.beats;
        if (beats && beats.length) {
            while (this._beatIdx < beats.length && beats[this._beatIdx].time <= now) {
                this._beatPulse = 1;
                this._beatIdx++;
            }
            if (this._beatIdx > 0 && beats[this._beatIdx - 1].time > now) this._beatIdx = 0; // seek back
        }
        this._beatPulse = Math.max(0, this._beatPulse - dt * 4);
        if (this._strikeMat) this._strikeMat.emissiveIntensity = 1.0 + this._beatPulse * 1.8;

        this._updateBoss(dt, now);
        this._updateAttack(beats, now, dt);
        this._updateRocks(dt, chartDt);
        this._updateParticles(dt);
        this._drawNotes(now, mirrored);
        this._drawBeats(beats, now);

        // HUD (write only on change)
        var autoActive = !!this.settings.autohit && !this._sawScorer;
        if (autoActive !== this._hudAutoVal) {
            this._hudAutoVal = autoActive;
            this._hudAuto.style.display = autoActive ? '' : 'none';
        }
        if (this.streak !== this._hudStreakVal) {
            this._hudStreakVal = this.streak;
            this._hudStreak.textContent = String(this.streak);
        }
        var hpPct = Math.round((this.bossHp / this.bossMaxHp) * 100);
        if (hpPct !== this._hudHpVal) {
            this._hudHpVal = hpPct;
            this._hudHp.style.width = hpPct + '%';
        }
        if (this._toastTimer > 0) {
            this._toastTimer -= dt;
            if (this._toastTimer <= 0) this._hudToast.style.opacity = '0';
        }
        if (this._flashTimer > 0) {
            this._flashTimer -= dt;
            if (this._flashTimer <= 0) this._hudFlash.style.opacity = '0';
        }

        // camera shake
        this._shake = Math.max(0, this._shake - dt * 1.6);
        var sh = this._shake * this._shake;
        this.camera.position.set(
            this._camBase.x + (Math.random() - 0.5) * sh * 1.4,
            this._camBase.y + (Math.random() - 0.5) * sh * 1.0,
            this._camBase.z
        );

        this.renderer.render(this.scene, this.camera);
    };

    BossFightGame.prototype.resize = function (w, h) {
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / Math.max(1, h);
        this.camera.updateProjectionMatrix();
    };

    BossFightGame.prototype.dispose = function () {
        if (this._hud && this._hud.parentElement) this._hud.parentElement.removeChild(this._hud);
        this._hud = null;
        for (var i = 0; i < this._disposables.length; i++) {
            if (this._disposables[i].dispose) this._disposables[i].dispose();
        }
        this._disposables.length = 0;
        this.renderer.dispose();
    };

    // ==================================================================
    // setRenderer contract — window.feedBackViz_bossfight
    // ==================================================================
    window['feedBackViz_' + PLUGIN_ID] = function () {
        var game = null;
        var canvas = null;
        var destroyed = false;
        var lastFrame = 0;
        var pendingSize = null;
        var settings = { autohit: true, shake: true };
        var visHandler = null;

        return {
            contextType: 'webgl2',

            init: function (cnv) {
                canvas = cnv;
                destroyed = false;
                lastFrame = 0;
                _threePromise.then(function (THREE) {
                    if (destroyed || game) return;
                    game = new BossFightGame(THREE, canvas);
                    game.settings = settings;
                    if (pendingSize) game.resize(pendingSize[0], pendingSize[1]);
                    else game.resize(canvas.width || canvas.clientWidth || 800, canvas.height || canvas.clientHeight || 450);
                    if (window.feedBack && window.feedBack.on) {
                        visHandler = function (event) {
                            var d = event && event.detail;
                            if (d && d.canvas === canvas && game) game.setHudVisible(!!d.visible);
                        };
                        window.feedBack.on('highway:visibility', visHandler);
                    }
                });
            },

            draw: function (bundle) {
                if (!game) return;
                var t = performance.now();
                var dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 0.016;
                lastFrame = t;
                game.frame(bundle, dt);
            },

            resize: function (w, h) {
                pendingSize = [w, h];
                if (game) game.resize(w, h);
            },

            applySetting: function (key, value) {
                settings[key] = value;
                if (game) game.settings = settings;
            },

            getSetting: function (key) {
                return settings[key];
            },

            destroy: function () {
                destroyed = true;
                if (visHandler && window.feedBack && window.feedBack.off) {
                    window.feedBack.off('highway:visibility', visHandler);
                    visHandler = null;
                }
                if (game) {
                    game.dispose();
                    game = null;
                }
                canvas = null;
            }
        };
    };
})();
