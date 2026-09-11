(function() {
  // Caretaker WebSocket bridge. State and commands use the garden's world
  // coordinates (coordinateVersion "world-bl-v1": body lengths, x east,
  // z south). Legacy screen-coordinate commands ({x, y} in CSS pixels) are
  // still accepted and converted through the current camera.
  var WS_URL = 'ws://' + (location.hostname || 'localhost') + ':7600';
  var STATE_INTERVAL = 1000;
  var RECONNECT_DELAY = 3000;
  var ws = null, stateTimer = null, reconnectTimer = null, connected = false;

  function app() { return window.FlyWorldApp; }

  // The most recent cause of defensive activity, so web-caused fear is not
  // blamed on a caretaker action that happened to precede it.
  var DEFENSIVE_EVENTS = { 'silk-contact': 1, touch: 1, wind: 1, 'web-placed': 1 };
  function fearAttribution(st) {
    for (var i = st.events.length - 1; i >= 0; i--) {
      var e = st.events[i];
      if (st.time - e.t > 10) break;
      if (DEFENSIVE_EVENTS[e.type]) {
        return { source: e.source === 'world' ? 'web' : e.source, event: e.type, simTime: e.t, secondsAgo: st.time - e.t };
      }
      if (e.type === 'behavior' && e.data.to === 'startle' && /threat/.test(e.data.reason || '')) {
        return { source: 'web', event: 'visual-threat', simTime: e.t, secondsAgo: st.time - e.t };
      }
    }
    return null;
  }

  function legacyBehaviorName(b) {
    return b === 'snagged' ? 'startle' : b;
  }

  // The single-fly fields (drives, behavior, position) describe the focused
  // fly; `flies` lists every adult and `population` counts every stage.
  function getState() {
    var a = app();
    var st = a.getState(), cfg = a.config, rec = a.focusRec(), fly = rec.fly;
    var scr = a.worldToScreen(fly.x, fly.y, fly.z) || { x: 0, y: 0 };
    var food = [];
    var canopy = 0;
    for (var i = 0; i < st.fruits.length; i++) {
      var f = st.fruits[i];
      if (f.stage === 'attached') { canopy++; continue; }
      if (!WorldState.isEdible(f)) continue;   // only reachable, edible fruit counts
      var fs = a.worldToScreen(f.x, 0, f.z) || { x: 0, y: 0 };
      food.push({ id: f.id, x: f.x, z: f.z, species: f.species, stage: f.stage,
        remaining: f.amount, eaten: 1 - f.amount, radius: f.radius, source: f.source, screen: { x: fs.x, y: fs.y } });
    }
    var enterAgo = st.time - rec.behavior.enterTime;
    return {
      coordinateVersion: cfg.coordinateVersion,
      world: { bounds: cfg.bounds, units: 'body_lengths', axes: 'x east, z south, altitude up; heading 0 = east, counter-clockwise seen from above' },
      simTime: st.time,
      brain: { kind: a.brain.kind, steering: a.run.mode },
      fly: { id: rec.id, sex: rec.sex },
      drives: { hunger: rec.drives.hunger, fear: rec.drives.fear, fatigue: rec.drives.fatigue,
        curiosity: rec.drives.curiosity, groom: rec.drives.groom },
      behavior: { current: legacyBehaviorName(rec.behavior.current), state: rec.behavior.current,
        enterTime: Date.now() - enterAgo * 1000, simEnterTime: rec.behavior.enterTime, groomLocation: rec.behavior.groomLocation },
      position: { x: fly.x, z: fly.z, altitude: fly.y, heading: fly.heading, facingDir: fly.heading, speed: fly.speed,
        screen: { x: scr.x, y: scr.y } },
      flies: st.flies.map(function (r) {
        return { id: r.id, sex: r.sex, x: r.fly.x, z: r.fly.z, behavior: r.behavior.current, hunger: r.drives.hunger,
          matings: r.repro.matings, carryingEggs: r.repro.eggs };
      }),
      population: WorldLife.census(st),
      firingStats: { firedNeurons: BRAIN.workerFiredNeurons || 0 },
      food: food,
      canopyFruit: canopy,
      webs: st.webs.map(function (w) { return { id: w.id, x: w.x, z: w.z, source: w.source, contacts: w.contacts }; }),
      fearAttribution: fearAttribution(st),
      environment: { lightLevel: a.lightIndex(), temperature: a.tempIndex() }
    };
  }

  function sendState() {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'state', data: getState() }));
  }

  // Resolves {x, z} in world BL from world params or legacy screen params.
  function worldPoint(params) {
    if (params.coords === 'world' || params.z !== undefined) {
      if (!isFinite(params.x) || !isFinite(params.z)) return null;
      return { x: params.x, z: params.z };
    }
    if (isFinite(params.x) && isFinite(params.y)) return app().screenToGround(params.x, params.y);
    return null;
  }

  function executeCommand(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) {
      console.warn('[caretaker] Bad JSON from server:', e.message);
      return;
    }
    if (msg.type !== 'command') return;
    var a = app();
    if (!a) return;
    var action = msg.action, params = msg.params || {};
    var lightMap = { bright: 0, dim: 1, dark: 2 };
    var tempMap = { neutral: 0, warm: 1, cool: 2 };
    var result = { ok: true }, at = null;
    switch (action) {
      case 'place_food':
        at = worldPoint(params);
        if (!at) { result = { ok: false, error: 'place_food: point is outside the garden' }; break; }
        result = a.command({ type: 'placeFruit', params: { x: at.x, z: at.z }, source: 'caretaker' });
        break;
      case 'set_light':
        var li = lightMap.hasOwnProperty(params.level) ? lightMap[params.level] : params.level;
        if (typeof li === 'number' && li >= 0 && li <= 2) a.setLightIndex(li, 'caretaker');
        else result = { ok: false, error: 'set_light: unknown level' };
        break;
      case 'set_temp':
        var ti = tempMap.hasOwnProperty(params.level) ? tempMap[params.level] : params.level;
        if (typeof ti === 'number' && ti >= 0 && ti <= 2) a.setTempIndex(ti, 'caretaker');
        else result = { ok: false, error: 'set_temp: unknown level' };
        break;
      case 'touch':
        // params.fly: a fly id (default: the focused fly)
        var touched = (params.fly && WorldState.findFly(a.getState(), params.fly)) || a.focusRec();
        result = a.command({ type: 'touch', params: { fly: touched.id, location: params.location || 'thorax', side: params.side || 'both' }, source: 'caretaker' });
        at = { x: touched.fly.x, z: touched.fly.z };
        break;
      case 'blow_wind':
        // direction in degrees, world frame: 0 = toward east (+x), 90 = toward south (+z)
        var deg = Number(params.direction) || 0;
        var rad = deg * Math.PI / 180;
        result = a.command({ type: 'wind', params: { dirX: Math.cos(rad), dirZ: Math.sin(rad),
          strength: Math.min(1, Math.max(0, params.strength === undefined ? 0.5 : params.strength)), duration: 2 }, source: 'caretaker' });
        at = { x: a.focusRec().fly.x, z: a.focusRec().fly.z };
        break;
      case 'clear_food':
        result = a.command({ type: 'clearFruit', source: 'caretaker' });
        break;
      default:
        console.warn('[caretaker] Unknown action:', action);
        result = { ok: false, error: 'unknown action' };
    }
    if (!result.ok) console.warn('[caretaker] ' + action + ' rejected: ' + result.error);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'command_result', action: action, ok: result.ok, error: result.error || null }));
    }
    if (typeof CaretakerRenderer !== 'undefined' && result.ok) {
      CaretakerRenderer.onCommand(action, params, at);
    }
  }

  function connect() {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { ws = new WebSocket(WS_URL); } catch (e) {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
      return;
    }
    ws.onopen = function() {
      connected = true;
      if (typeof CaretakerRenderer !== 'undefined') { CaretakerRenderer.setConnected(true); }
      var statusEl = document.getElementById('claudeStatus');
      if (statusEl) statusEl.style.display = '';
      console.log('[caretaker] Connected to ' + WS_URL);
      stateTimer = setInterval(sendState, STATE_INTERVAL);
      sendState();
    };
    ws.onmessage = function(event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === 'command') {
        executeCommand(event.data);
      } else if (typeof CaretakerSidebar !== 'undefined') {
        if (msg.type === 'activity_action') {
          CaretakerSidebar.onAction(msg);
        } else if (msg.type === 'activity_incident') {
          CaretakerSidebar.onIncident(msg);
        } else if (msg.type === 'activity_history') {
          CaretakerSidebar.onHistory(msg);
        }
      }
    };
    ws.onclose = function() {
      connected = false;
      if (typeof CaretakerRenderer !== 'undefined') { CaretakerRenderer.setConnected(false); }
      var statusEl = document.getElementById('claudeStatus');
      if (statusEl) statusEl.style.display = 'none';
      if (stateTimer !== null) { clearInterval(stateTimer); stateTimer = null; }
      console.log('[caretaker] Disconnected, reconnecting in ' + (RECONNECT_DELAY / 1000) + 's');
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
    };
    ws.onerror = function() {};
  }

  function init() {
    if (location.protocol === 'file:') {
      console.log('[caretaker] Skipping WebSocket connection in file:// context (iOS/local)');
      return;
    }
    if (window.FlyWorldApp) { connect(); return; }
    setTimeout(init, 500);
  }

  init();
  window.caretakerBridge = { getState: getState, connect: connect, executeCommand: executeCommand,
    isConnected: function() { return connected; } };
})();
