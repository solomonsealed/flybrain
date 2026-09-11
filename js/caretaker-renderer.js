(function() {
  // Draws Claude's caretaker presence over the garden. Attention and effects
  // are stored in world coordinates (BL) and projected through the current
  // camera every frame, so they stay attached to the garden while the view
  // pans, zooms or follows the fly.
  var cursorImg = null;
  var cursorLoaded = false;
  var attention = null;        // {x, z} world, eased toward attentionTarget
  var attentionTarget = null;
  var trail = [];
  var TRAIL_MAX = 40;
  var TRAIL_LIFETIME = 2000;

  var activeEffects = [];

  var idleStart = 0;
  var lastCommandTime = 0;
  var caretakerConnected = false;

  var CURSOR_SIZE = 20;
  var CLAUDE_ORANGE = 'rgba(227, 115, 75, ';

  function init() {
    cursorImg = new Image();
    cursorImg.src = './svg/claude-cursor.svg';
    cursorImg.onload = function() { cursorLoaded = true; };
    cursorImg.onerror = function() {
      console.warn('[caretaker-renderer] Failed to load cursor SVG');
    };
  }

  function flyPoint() {
    var st = window.FlyWorldApp ? window.FlyWorldApp.getState() : null;
    var f = st ? (window.FlyWorldApp.focusRec ? window.FlyWorldApp.focusRec().fly : st.fly) : null;
    return f ? { x: f.x, z: f.z } : { x: 0, z: 0 };
  }

  // Screen position (overlay-canvas CSS px) of a world point.
  function project(p) {
    var a = window.FlyWorldApp;
    if (!a || !a.renderer) return null;
    var s = a.worldToScreen(p.x, 0.3, p.z);
    var c = document.getElementById('canvas');
    var r = c ? c.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: s.x - r.left, y: s.y - r.top };
  }

  // `at` is the resolved world point of the command, if any.
  function onCommand(action, params, at) {
    lastCommandTime = Date.now();
    var target = at || flyPoint();
    switch (action) {
      case 'place_food':
        activeEffects.push({ type: 'ripple', p: target, startTime: Date.now() });
        highlightToolbar('fruit');
        break;
      case 'touch':
        activeEffects.push({ type: 'ring', p: target, startTime: Date.now() });
        highlightToolbar('touch');
        break;
      case 'blow_wind':
        activeEffects.push({ type: 'arrow', p: target, startTime: Date.now(), params: { strength: params.strength || 0.5, direction: params.direction || 0 } });
        highlightToolbar('air');
        break;
      case 'set_light':
        highlightToolbar('light');
        break;
      case 'set_temp':
        highlightToolbar('temp');
        break;
      case 'clear_food':
        highlightToolbar('fruit');
        break;
    }
    attentionTarget = { x: target.x, z: target.z };
    if (!attention) attention = { x: target.x, z: target.z };
  }

  function setConnected(isConnected) {
    caretakerConnected = isConnected;
    if (isConnected) {
      if (idleStart === 0) idleStart = Date.now();
      if (!attention) { attention = flyPoint(); attentionTarget = flyPoint(); }
    } else {
      attention = null;
      trail = [];
      activeEffects = [];
    }
  }

  function highlightToolbar(toolName) {
    var btn = document.querySelector('.tool-btn[data-tool="' + toolName + '"]');
    if (btn === null) return;
    btn.classList.add('claude-highlight');
    setTimeout(function() { btn.classList.remove('claude-highlight'); }, 1500);
  }

  function update(dt) {
    if (!caretakerConnected) return;
    // Only show cursor when Claude recently acted (within 3s of a command)
    var idleTime = Date.now() - lastCommandTime;
    if (lastCommandTime === 0 || idleTime > 3000) {
      attention = null;
      trail = [];
      return;
    }
    if (!attention || !attentionTarget) return;
    var lerpSpeed = 0.08;
    attention.x += (attentionTarget.x - attention.x) * lerpSpeed;
    attention.z += (attentionTarget.z - attention.z) * lerpSpeed;
    if (trail.length === 0 || Math.hypot(attention.x - trail[trail.length - 1].x, attention.z - trail[trail.length - 1].z) > 0.3) {
      trail.push({ x: attention.x, z: attention.z, time: Date.now() });
    }
    while (trail.length > 0 && Date.now() - trail[0].time > TRAIL_LIFETIME) trail.shift();
    while (trail.length > TRAIL_MAX) trail.shift();
    var i, elapsed;
    for (i = activeEffects.length - 1; i >= 0; i--) {
      elapsed = Date.now() - activeEffects[i].startTime;
      if (activeEffects[i].type === 'ripple' && elapsed > 800) { activeEffects.splice(i, 1); }
      else if (activeEffects[i].type === 'ring' && elapsed > 600) { activeEffects.splice(i, 1); }
      else if (activeEffects[i].type === 'arrow' && elapsed > 1200) { activeEffects.splice(i, 1); }
    }
  }

  function drawOverlay(ctx) {
    if (!caretakerConnected) return;
    drawEffects(ctx);
    if (attention) {
      drawTrail(ctx);
      drawCursor(ctx);
    }
  }

  function drawTrail(ctx) {
    if (trail.length < 2) return;
    var now = Date.now();
    var i, age, alpha, a, b;
    for (i = 1; i < trail.length; i++) {
      age = now - trail[i].time;
      alpha = (1 - age / TRAIL_LIFETIME) * 0.25;
      if (alpha <= 0) continue;
      a = project(trail[i - 1]); b = project(trail[i]);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = CLAUDE_ORANGE + alpha.toFixed(3) + ')';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function drawCursor(ctx) {
    var p = attention ? project(attention) : null;
    if (!p) return;
    if (cursorLoaded) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(cursorImg, p.x - CURSOR_SIZE / 2, p.y - CURSOR_SIZE / 2, CURSOR_SIZE, CURSOR_SIZE);
      ctx.globalAlpha = 1.0;
    } else {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 8);
      ctx.lineTo(p.x + 6, p.y);
      ctx.lineTo(p.x, p.y + 8);
      ctx.lineTo(p.x - 6, p.y);
      ctx.closePath();
      ctx.fillStyle = CLAUDE_ORANGE + '0.85)';
      ctx.fill();
    }
  }

  function drawEffects(ctx) {
    var now = Date.now();
    var i, e, q, elapsed, p, p1, r1, a1, p2, r2, a2, r, a, angle, len, ex, ey, headLen;
    for (i = 0; i < activeEffects.length; i++) {
      e = activeEffects[i];
      q = project(e.p);
      if (!q) continue;
      elapsed = now - e.startTime;
      if (e.type === 'ripple') {
        p1 = elapsed / 800;
        r1 = p1 * 35;
        a1 = (1 - p1) * 0.6;
        if (p1 <= 1) {
          ctx.beginPath();
          ctx.arc(q.x, q.y, r1, 0, Math.PI * 2);
          ctx.strokeStyle = CLAUDE_ORANGE + a1.toFixed(3) + ')';
          ctx.lineWidth = 2 * (1 - p1);
          ctx.stroke();
        }
        p2 = Math.max(0, (elapsed - 200)) / 800;
        r2 = p2 * 35;
        a2 = (1 - p2) * 0.4;
        if (p2 > 0 && p2 <= 1) {
          ctx.beginPath();
          ctx.arc(q.x, q.y, r2, 0, Math.PI * 2);
          ctx.strokeStyle = CLAUDE_ORANGE + a2.toFixed(3) + ')';
          ctx.lineWidth = 2 * (1 - p2);
          ctx.stroke();
        }
      } else if (e.type === 'ring') {
        p = elapsed / 600;
        r = 8 + p * 20;
        a = (1 - p) * 0.7;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = CLAUDE_ORANGE + a.toFixed(3) + ')';
        ctx.lineWidth = 2.5 * (1 - p);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(q.x, q.y, 6 * (1 - p), 0, Math.PI * 2);
        ctx.fillStyle = CLAUDE_ORANGE + (a * 0.3).toFixed(3) + ')';
        ctx.fill();
      } else if (e.type === 'arrow') {
        // direction degrees in the world frame (0 = east, 90 = south),
        // drawn by projecting a world-space arrow
        p = elapsed / 1200;
        angle = e.params.direction * Math.PI / 180;
        len = 6 * e.params.strength;
        var tip = project({ x: e.p.x + Math.cos(angle) * len, z: e.p.z + Math.sin(angle) * len });
        if (!tip) continue;
        ex = tip.x; ey = tip.y;
        a = (1 - p) * 0.6;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = CLAUDE_ORANGE + a.toFixed(3) + ')';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        var sa = Math.atan2(ey - q.y, ex - q.x);
        headLen = 8;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(sa - 0.4) * headLen, ey - Math.sin(sa - 0.4) * headLen);
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(sa + 0.4) * headLen, ey - Math.sin(sa + 0.4) * headLen);
        ctx.strokeStyle = CLAUDE_ORANGE + a.toFixed(3) + ')';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
  }

  init();

  window.CaretakerRenderer = {
    onCommand: onCommand,
    setConnected: setConnected,
    update: update,
    drawOverlay: drawOverlay
  };
})();
