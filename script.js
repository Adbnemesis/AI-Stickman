/**
 * game.js - Final working version with:
 * - MediaPipe Hands (automatic calibration)
 * - Smooth hand-mapped movement + gestures (shield, fist, hold special)
 * - Boss, extra life, powerups, particles, screen shake
 * - Leaderboard, How to Play, Debug dot
 * - Fix: game loop never permanently stops; restart resets state cleanly
 */

/* ---------------- DOM & canvas ---------------- */
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
let W = canvas.width, H = canvas.height;

const DOM = {
  score: document.getElementById('score'),
  lives: document.getElementById('lives'),
  bossTimer: document.getElementById('bossTimer'),
  shieldStatus: document.getElementById('shieldStatus'),
  howBtn: document.getElementById('howBtn'),
  leaderBtn: document.getElementById('leaderBtn'),
  muteBtn: document.getElementById('muteBtn'),
  startBtn: document.getElementById('startBtn'),
  debugToggle: document.getElementById('debugToggle'),
  bossBanner: document.getElementById('bossWarningBanner'),
  camPreview: document.getElementById('camPreview')
};

let running = false;        // overall RAF loop alive
let playing = false;        // "in a play session" (not paused/gameover)
let muted = false;
let showDebug = false;

/* --------------- Player & world -------------- */
const player = {
  x: W*0.5, y: H - 140,
  w: 56, h: 120,
  targetX: W*0.5, targetY: H-140,
  frame:0, frameTimer:0,
  shieldActive:false, shieldCooldown:false,
  holdTimer:0, specialCooldown:0, fistCooldown:0,
  lives:3, doublePoints:false
};

let enemies = [], powerups = [], particles = [];
let spawnTimer = 0, spawnInterval = 900, difficultyTimer = 0;
let elapsedMs = 0;
let score = 0;

/* Boss */
let boss = null, inBoss = false, bossIntro = false;
const BOSS_AFTER_MS = 60000; // 60s
const BOSS_WARN_SEC = 5;
let bossWarnShown = false;

/* Calibration & smoothing */
const SMOOTH_N = 6;
let wristBuffer = [];
let calibration = { running:false, samples:[], durationMs:1500, neutral:null, neutralScreenY:null };

/* MediaPipe shared */
let latestHands = null;

/* Audio (WebAudio synth) */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain(); masterGain.gain.value = 1; masterGain.connect(audioCtx.destination);
let musicNode = null;

/* Leaderboard key */
const LB_KEY = 'stickman_final_lb_v1';

/* Screen shake */
let screenShake = 0;

/* ---------------- Audio helpers ---------------- */
function playTone(freq=440, time=0.08, gain=0.08, type='sine'){ if (muted) return; const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.type = type; o.frequency.value = freq; g.gain.value = gain; o.connect(g); g.connect(masterGain); o.start(); o.stop(audioCtx.currentTime + time); }
function playHit(){ playTone(170,0.12,0.12,'sawtooth'); }
function playPower(){ playTone(620,0.12,0.12,'triangle'); }
function playCoin(){ playTone(920,0.06,0.08,'sine'); }
function playBossRoar(){ if (muted) return; const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.type='sawtooth'; o.frequency.value=110; g.gain.value=0.22; o.connect(g); g.connect(masterGain); o.start(); o.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime+1.0); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime+1.0); setTimeout(()=>{ try{o.stop()}catch(e){} },1100); }
function startMusic(){ if (muted || musicNode) return; const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.type='sine'; o.frequency.value=110; g.gain.value=0.02; const lfo = audioCtx.createOscillator(); const lfg = audioCtx.createGain(); lfo.frequency.value=0.07; lfo.type='sine'; lfg.gain.value=0.02; lfo.connect(lfg); lfg.connect(g.gain); o.connect(g); g.connect(masterGain); o.start(); lfo.start(); musicNode = {o,g,lfo}; }
function stopMusic(){ if (!musicNode) return; try{ musicNode.o.stop(); musicNode.lfo.stop(); }catch(e){} musicNode = null; }

/* ---------------- util ---------------- */
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function lerp(a,b,t){ return a + (b-a)*t; }
function now(){ return performance.now(); }
function rand(min,max){ return Math.random()*(max-min)+min; }

/* ---------------- MediaPipe Hands setup ---------------- */
const hands = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
hands.setOptions({ modelComplexity:1, maxNumHands:2, minDetectionConfidence:0.6, minTrackingConfidence:0.6 });
hands.onResults(results => {
  latestHands = (results.multiHandLandmarks && results.multiHandLandmarks.length) ? results.multiHandLandmarks : null;
});

/* Camera helper (MediaPipe's Camera) */
let mpCamera = null;
async function startCamera(){
  if (mpCamera) return;
  const video = DOM.camPreview;
  mpCamera = new Camera(video, { onFrame: async ()=>{ await hands.send({ image: video }); }, width:640, height:480 });
  await mpCamera.start(); // await ensures camera started
}

/* ---------------- Gesture helpers & smoothing ---------------- */
function wristToNorm(hand){ const w = hand[0]; return { x: w.x, y: w.y }; }
function isOpenPalm(hand){
  const wrist = hand[0]; const tips = [4,8,12,16,20]; let sum=0; for (let i of tips){ const p = hand[i]; sum += Math.hypot(p.x - wrist.x, p.y - wrist.y); } const avg = sum / tips.length; const handW = Math.hypot(hand[8].x - hand[20].x, hand[8].y - hand[20].y) + 1e-6; return (avg / handW) > 1.85;
}
function detectFist(hand){
  const wrist = hand[0]; const tips=[4,8,12,16,20]; let sum=0; for (let i of tips){ const p = hand[i]; sum += Math.hypot(p.x - wrist.x, p.y - wrist.y); } const avg = sum / tips.length; const handW = Math.hypot(hand[8].x - hand[20].x, hand[8].y - hand[20].y) + 1e-6; return (avg / handW) < 1.5;
}
function pushWrist(px,py){ wristBuffer.push({x:px,y:py,t:now()}); if (wristBuffer.length>SMOOTH_N) wristBuffer.shift(); }
function getSmoothedWrist(){ if (!wristBuffer.length) return null; let sx=0, sy=0; for (const p of wristBuffer){ sx+=p.x; sy+=p.y; } return { x: sx / wristBuffer.length, y: sy / wristBuffer.length }; }

/* ---------------- Spawns / particles / powerups ---------------- */
function spawnEnemy(){ const x = Math.random()*(W-160)+80; const r = Math.random()*26 + 18; const vy = Math.random()*1.2 + 2.2 + Math.min(2.8, difficultyTimer/12000); enemies.push({x,y:-40,r,vy,color:`hsl(${Math.random()*40+10},85%,55%)`,swing:Math.random()<0.28,seed:Math.random()*1000}); }
function spawnPowerup(){ const x = Math.random()*(W-180)+90; const t = Math.random(); const type = t < 0.02 ? 'life' : (t < 0.18 ? 'shield' : (t < 0.34 ? 'slow' : 'double')); powerups.push({x,y:-40,vy:1.6,type,age:0}); }
function spawnParticles(x,y,count,clr){ for (let i=0;i<count;i++){ particles.push({x,y,vx:(Math.random()-0.5)*4,vy:-Math.random()*3 - 0.4,life:900+Math.random()*600,size:Math.random()*3+2,color:clr||'#ffd166'}); } }

/* ---------------- Boss ---------------- */
function startBoss(){
  boss = {x:W*0.5,y:-320,w:420,h:320,hp:200,maxHp:200,phase:1,timer:0,state:'intro'};
  inBoss = true; bossIntro = true; bossWarnShown = false; showBossBanner(false); playBossRoar();
}
function bossTakeDamage(d){ if (!boss) return; boss.hp -= d; spawnParticles(boss.x,boss.y,12,'#ff7b7b'); playHit(); if (boss.hp <= 0){ boss.state='dead'; spawnParticles(boss.x,boss.y,60,'#ffd166'); applySlowMotion(0.5,1500); setTimeout(()=>{ endBoss(); },1400); } else { if (boss.hp < boss.maxHp*0.1) boss.phase=3; else if (boss.hp < boss.maxHp*0.5) boss.phase=2; } }
function endBoss(){ score += 250; boss=null; inBoss=false; bossIntro=false; }

/* ---------------- Slow motion & collisions ---------------- */
let slowFactor = 1.0;
function applySlowMotion(f, dur){ slowFactor = f; setTimeout(()=>{ slowFactor = 1.0; }, dur); }
function circleRectCollision(cx,cy,cr,rx,ry,rw,rh){ const dx=Math.abs(cx-rx), dy=Math.abs(cy-ry); if (dx > rw/2 + cr) return false; if (dy > rh/2 + cr) return false; if (dx <= rw/2) return true; if (dy <= rh/2) return true; const dx2=dx-rw/2, dy2=dy-rh/2; return dx2*dx2 + dy2*dy2 <= cr*cr; }

/* ---------------- Draw helpers ---------------- */
function drawBackground(t){
  ctx.fillStyle = '#071428'; ctx.fillRect(0,0,W,H);
  ctx.fillStyle = 'rgba(255,255,255,0.05)'; for (let i=0;i<6;i++){ const cx = ((t/600)+i*220)%(W+300)-150; ctx.beginPath(); ctx.ellipse(cx,90+18*Math.sin(i + t/1600),120,30,0,0,Math.PI*2); ctx.fill(); }
  ctx.fillStyle = '#0d2333'; ctx.fillRect(0, H-120, W, 120);
  ctx.fillStyle = 'rgba(255,255,255,0.02)'; for (let i=0;i<W;i+=40) ctx.fillRect(i, H-100, 12, 5);
}
function drawPlayer(){
  const x = player.x, y = player.y;
  ctx.save(); ctx.translate(x,y); ctx.lineWidth = 3; ctx.strokeStyle = '#f4f7fb';
  ctx.beginPath(); ctx.arc(0,-56,14,0,Math.PI*2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,-44); ctx.lineTo(0,-8); ctx.stroke();
  const f = player.frame % 6; const armSwing = (f<3)? f*6 : (6-f)*6;
  ctx.beginPath(); ctx.moveTo(0,-36); ctx.lineTo(-20 - armSwing/3, -16 + armSwing/12); ctx.moveTo(0,-36); ctx.lineTo(20 + armSwing/2, -16 - armSwing/12); ctx.stroke();
  const legSwing = (f<3)? f*8 : (6-f)*8; ctx.beginPath(); ctx.moveTo(0,-8); ctx.lineTo(-18 - legSwing/2, 36 + legSwing/6); ctx.moveTo(0,-8); ctx.lineTo(18 + legSwing/2, 36 - legSwing/6); ctx.stroke();
  if (player.shieldActive){ ctx.beginPath(); ctx.strokeStyle='rgba(120,200,255,0.75)'; ctx.lineWidth=4; ctx.arc(0,-30,46,Math.PI*1.05,Math.PI*1.95); ctx.stroke(); ctx.lineWidth=3; ctx.strokeStyle='#f4f7fb'; }
  ctx.restore();
}

/* ---------------- Main loop (RAF always running) ---------------- */
let lastTS = now();
function mainLoop(ts){
  const dtRaw = ts - lastTS; lastTS = ts;
  const dt = dtRaw * slowFactor;

  // Start RAF loop once (keeps running even on gameover to avoid freeze)
  if (!running){ running = true; requestAnimationFrame(mainLoop); return; }

  // Only progress world if playing; otherwise UI still responsive and hands still read
  if (playing){
    elapsedMs += dtRaw; difficultyTimer += dtRaw;
    // boss timer HUD
    const remaining = Math.max(0, BOSS_AFTER_MS - elapsedMs);
    DOM.bossTimer.textContent = inBoss ? '0' : Math.ceil(remaining/1000);
    if (!inBoss && remaining <= BOSS_WARN_SEC*1000 && !bossWarnShown){
      bossWarnShown = true; showBossBanner(true);
      setTimeout(()=>{ showBossBanner(false); startBoss(); }, BOSS_WARN_SEC*1000);
    }

    // process gestures (latestHands)
    if (latestHands && latestHands.length > 0){
      const hand = latestHands[0];
      const n = wristToNorm(hand); // 0..1
      let mappedX, mappedY;
      if (calibration.neutral){
        const dx = (n.x - calibration.neutral.x);
        const dy = (n.y - calibration.neutral.y);
        const sensX = 1.2;
        mappedX = clamp(W*0.5 + dx * sensX * W, 60, W-60);
        mappedY = clamp(calibration.neutralScreenY + dy * H, 120, H-80);
      } else {
        mappedX = clamp(n.x * W, 60, W-60);
        mappedY = clamp(n.y * H, 120, H-80);
      }
      pushWrist(mappedX, mappedY);

      // two-hand shield
      if (latestHands.length >= 2){
        const bothOpen = isOpenPalm(latestHands[0]) && isOpenPalm(latestHands[1]);
        if (bothOpen && !player.shieldActive && !player.shieldCooldown) activateShield();
      }
      // fist = boss damage
      if (detectFist(hand) && inBoss && boss && boss.state === 'active' && (!player.fistCooldown || player.fistCooldown <= 0)){
        bossTakeDamage(4); player.fistCooldown = 400;
      }
    }

    // apply smoothed wrist
    const sm = getSmoothedWrist();
    if (sm){
      player.targetX = sm.x;
      player.targetY = sm.y + 50;
      if (calibration.neutral){
        if (sm.y < calibration.neutralScreenY - 60) player.holdTimer += dtRaw; else player.holdTimer = 0;
      } else {
        if (sm.y < H * 0.28) player.holdTimer += dtRaw; else player.holdTimer = 0;
      }
    } else {
      player.targetX = lerp(player.targetX, W*0.5, 0.02);
      player.targetY = lerp(player.targetY, H-140, 0.02);
      player.holdTimer = 0;
    }

    // movement smoothing
    player.x = lerp(player.x, player.targetX, 0.15 + 0.03 * Math.min(1, difficultyTimer/12000));
    player.y = lerp(player.y, player.targetY, 0.12);

    // special (hold) release
    if (player.holdTimer > 2000 && !player.specialCooldown && inBoss && boss && boss.state === 'active'){
      player.holdTimer = 0; player.specialCooldown = 6000; bossTakeDamage(28); spawnParticles(player.x, player.y-40, 28, '#ffd166'); applySlowMotion(0.5,400); playPower();
    }
    if (player.specialCooldown) player.specialCooldown = Math.max(0, player.specialCooldown - dtRaw);
    if (player.fistCooldown) player.fistCooldown = Math.max(0, player.fistCooldown - dtRaw);

    // animation
    player.frameTimer += dtRaw; if (player.frameTimer > 80){ player.frame = (player.frame + 1) % 6; player.frameTimer = 0; }

    // spawns
    spawnTimer += dtRaw;
    const effectiveSpawn = spawnInterval - Math.min(500, difficultyTimer/25);
    if (spawnTimer > effectiveSpawn){ spawnTimer = 0; if (!inBoss && Math.random() < 0.92) spawnEnemy(); if (!inBoss && Math.random() < 0.12) spawnPowerup(); }

    // update enemies
    for (let i = enemies.length-1;i>=0;i--){
      const e = enemies[i]; e.y += e.vy * (dt/16);
      if (e.swing) e.x += Math.sin((ts + e.seed)/300) * 0.7;
      const collided = circleRectCollision(e.x, e.y, e.r, player.x, player.y - player.h/2 + 6, player.w*0.8, player.h*0.9);
      if (collided){
        enemies.splice(i,1);
        if (player.shieldActive){
          player.shieldActive = false; player.shieldCooldown = true; DOM.shieldStatus.textContent = 'Cooldown';
          setTimeout(()=>{ player.shieldCooldown = false; DOM.shieldStatus.textContent = 'Ready'; }, 3000);
          spawnParticles(player.x, player.y-30, 10, '#7fd1ff'); playPower();
        } else {
          player.lives -= 1; DOM.lives.textContent = player.lives; spawnParticles(player.x, player.y-20, 16, '#ff8a8a'); playHit(); screenShake = 14;
          if (player.lives <= 0){
            // safe game over: toggle playing false and show modal; keep RAF alive
            playing = false; showGameOverModal();
          }
        }
      } else if (e.y > H + 60) enemies.splice(i,1);
    }

    // update powerups
    for (let i = powerups.length-1;i>=0;i--){
      const p = powerups[i]; p.y += p.vy * (dt/16); p.age += dt;
      const picked = circleRectCollision(p.x,p.y,20, player.x, player.y - player.h/2 + 6, player.w*0.8, player.h*0.9);
      if (picked){
        if (p.type === 'shield'){ player.shieldActive = true; player.shieldCooldown = false; DOM.shieldStatus.textContent = 'Active'; spawnParticles(player.x, player.y-20, 16, '#7fd1ff'); playPower(); }
        else if (p.type === 'slow'){ applySlowMotion(0.6,4500); spawnParticles(player.x, player.y-20, 12, '#a0d1ff'); playPower(); }
        else if (p.type === 'double'){ player.doublePoints = true; setTimeout(()=>{ player.doublePoints = false; }, 8000); spawnParticles(player.x, player.y-20, 14, '#ffd166'); playPower(); }
        else if (p.type === 'life'){ player.lives += 1; DOM.lives.textContent = player.lives; spawnParticles(player.x, player.y-20, 22, '#ff9bcf'); playCoin(); }
        powerups.splice(i,1); continue;
      }
      if (p.y > H + 40) powerups.splice(i,1);
    }

    // boss logic
    if (boss){
      if (boss.state === 'intro'){ boss.y = lerp(boss.y, 120, 0.02); if (Math.abs(boss.y - 120) < 6){ boss.state = 'active'; boss.timer = 0; playTone(220,0.12,0.09); } spawnParticles(boss.x + (Math.random()-0.5)*200, boss.y+40, 2, '#ff7b7b'); }
      else if (boss.state === 'active'){
        boss.timer += dt;
        if (boss.phase === 1 && boss.timer > 1200){ boss.timer = 0; for (let i=0;i<3;i++) enemies.push({x: boss.x + (i-1)*80, y: boss.y + 140, r:26, vy:2.6 + Math.random()*0.6, swing:false}); playTone(200,0.08,0.12); }
        else if (boss.phase === 2 && boss.timer > 900){ boss.timer = 0; const dir = (player.x < boss.x) ? -1 : 1; const px = boss.x + dir*60; enemies.push({x:px, y: boss.y + 140, r:34, vy:3.6 + Math.random()*1.2, swing:true, seed: Math.random()*1000}); playTone(160,0.09,0.15); }
        else if (boss.phase === 3 && boss.timer > 700){ boss.timer = 0; for (let i=0;i<6;i++){ const sx = 60 + i*(W-120)/5; enemies.push({x:sx, y: boss.y + 100, r: 26 + Math.random()*8, vy: 3.5 + Math.random()*1.8, swing:false}); } playTone(120,0.12,0.18); screenShake = 10; }
        boss.x = lerp(boss.x, player.x, 0.01);
      }
    }

    // particles
    for (let i = particles.length-1;i>=0;i--){ const p = particles[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.life -= dt; ctx.fillStyle = p.color; ctx.globalAlpha = Math.max(0, p.life/1500); ctx.beginPath(); ctx.arc(p.x,p.y,p.size,0,Math.PI*2); ctx.fill(); ctx.globalAlpha = 1; if (p.life <= 0) particles.splice(i,1); }

    // scoring over time
    score += (dtRaw / 1000) * (player.doublePoints ? 2 : 1);
    DOM.score.textContent = Math.floor(score);

    // screen shake apply
    if (screenShake > 0){ const sx = (Math.random()-0.5) * screenShake; const sy = (Math.random()-0.5) * screenShake; canvas.style.transform = `translate(${sx}px, ${sy}px)`; screenShake = Math.max(0, screenShake - 0.6); } else canvas.style.transform = '';
  } // end playing

  // draw frame (even if not playing, so UI overlays remain consistent)
  ctx.clearRect(0,0,W,H);
  drawBackground(lastTS);
  for (const e of enemies){ ctx.beginPath(); ctx.fillStyle = e.color || '#ff7b7b'; ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 12; ctx.arc(e.x, e.y, e.r, 0, Math.PI*2); ctx.fill(); ctx.shadowBlur = 0; }
  for (const p of powerups){ ctx.save(); ctx.translate(p.x,p.y); ctx.fillStyle = p.type==='shield' ? '#7fd1ff' : (p.type==='slow' ? '#a0d1ff' : (p.type==='life' ? '#ff9bcf' : '#ffd166')); ctx.beginPath(); ctx.arc(0,0,18,0,Math.PI*2); ctx.fill(); ctx.restore(); }
  if (boss){ ctx.save(); ctx.translate(boss.x,boss.y); ctx.fillStyle = 'rgba(255,80,80,0.06)'; ctx.beginPath(); ctx.ellipse(0,60,boss.w*0.9,boss.h*0.4,0,0,Math.PI*2); ctx.fill(); ctx.lineWidth=6; ctx.strokeStyle='#ff6b6b'; ctx.beginPath(); ctx.arc(0,-40,60,0,Math.PI*2); ctx.stroke(); ctx.restore(); const hpW = Math.max(0,(boss.hp/boss.maxHp)*560); ctx.fillStyle='#2b2f3a'; ctx.fillRect(W/2 - 280, 12, 560, 18); ctx.fillStyle='#ff6b6b'; ctx.fillRect(W/2 - 280, 12, hpW, 18); ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.strokeRect(W/2 - 280, 12, 560, 18); }
  drawPlayer();

  // debug dot
  if (showDebug){
    const el = document.querySelector('.debugDot') || (()=>{ const d=document.createElement('div'); d.className='debugDot'; document.body.appendChild(d); return d; })();
    const s = getSmoothedWrist();
    if (s){ const rect = canvas.getBoundingClientRect(); el.style.left = `${rect.left + (s.x / W) * rect.width}px`; el.style.top = `${rect.top + (s.y / H) * rect.height}px`; el.style.display = 'block'; } else el.style.display = 'none';
  } else { const d=document.querySelector('.debugDot'); if (d) d.style.display = 'none'; }

  // HUD updates
  DOM.lives.textContent = player.lives;
  DOM.shieldStatus.textContent = player.shieldActive ? 'Active' : (player.shieldCooldown ? 'Cooldown' : 'Ready');

  requestAnimationFrame(mainLoop);
}

/* ---------------- UI & modals ---------------- */
function showHowTo(){
  const bd = document.createElement('div'); bd.className='backdrop';
  bd.innerHTML = `<div class="modal"><h2>How to Play</h2><div class="muted">Use your webcam. Best in good lighting.</div>
    <div class="rows" style="margin-top:12px;">
      <div style="flex:1"><div class="kbd">Move</div><div class="muted">Move your hand left/right & up/down to control the stickman.</div></div>
      <div style="flex:1"><div class="kbd">Shield</div><div class="muted">Open both palms in view to activate shield or pick shield power-up.</div></div>
      <div style="flex:1"><div class="kbd">Special</div><div class="muted">Hold your hand high for 2s during boss for a powerful attack.</div></div>
    </div>
    <div style="text-align:right;margin-top:14px;"><button id="startCalBtn">Start & Calibrate</button><button id="closeBtn">Close</button></div></div>`;
  document.body.appendChild(bd);
  bd.querySelector('#closeBtn').onclick = ()=>bd.remove();
  bd.querySelector('#startCalBtn').onclick = async ()=>{ bd.remove(); await initAndStartSequence(); };
}
function showLeaderboard(){
  const arr = loadLB();
  const bd = document.createElement('div'); bd.className='backdrop';
  bd.innerHTML = `<div class="modal"><h2>Leaderboard</h2><div id="leaderList">${ arr.length ? '<ol>' + arr.map(x=>`<li>${x.name} — ${x.pts}</li>`).join('') + '</ol>' : '<div class="muted">No scores yet</div>' }</div><div style="text-align:right;margin-top:12px;"><button id="closeLb">Close</button><button id="clearLb">Clear</button></div></div>`;
  document.body.appendChild(bd);
  bd.querySelector('#closeLb').onclick = ()=>bd.remove();
  bd.querySelector('#clearLb').onclick = ()=>{ localStorage.removeItem(LB_KEY); bd.remove(); showLeaderboard(); };
}
function showBossBanner(show){ DOM.bossBanner.style.display = show ? 'block' : 'none'; }
function showGameOverModal(){
  const bd = document.createElement('div'); bd.className='backdrop';
  bd.innerHTML = `<div class="modal"><h2>Game Over</h2><div class="muted">Score: <strong>${Math.floor(score)}</strong></div>
    <div style="margin-top:10px;"><input id="nameInput" placeholder="Enter name (12 chars)" style="width:60%;padding:8px;border-radius:8px;border:none;"></div>
    <div style="text-align:right;margin-top:12px;"><button id="saveBtn">Save</button><button id="restartBtn">Restart</button></div></div>`;
  document.body.appendChild(bd);
  bd.querySelector('#saveBtn').onclick = ()=>{ const nm = (bd.querySelector('#nameInput').value || 'You').substring(0,12); addLB(nm, Math.floor(score)); bd.remove(); showLeaderboard(); };
  bd.querySelector('#restartBtn').onclick = ()=>{ bd.remove(); restartPlay(); };
}

/* ---------------- Controls binding ---------------- */
DOM.howBtn.onclick = showHowTo;
DOM.leaderBtn.onclick = showLeaderboard;
DOM.muteBtn.onclick = ()=>{ muted = !muted; DOM.muteBtn.textContent = muted ? 'Unmute' : 'Mute'; masterGain.gain.value = muted ? 0 : 1; if (muted) stopMusic(); else startMusic(); };
DOM.startBtn.onclick = async ()=>{ DOM.startBtn.disabled = true; DOM.startBtn.textContent = 'Starting...'; try{ await initAndStartSequence(); }catch(e){ alert('Start failed: ' + (e && e.message ? e.message : e)); console.error(e); } DOM.startBtn.disabled = false; DOM.startBtn.textContent = 'Start (Calibrate)'; };
DOM.debugToggle.onchange = (e)=>{ showDebug = e.target.checked; };

/* keyboard fallback */
window.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft' || e.key === 'a') player.targetX -= 60;
  if (e.key === 'ArrowRight' || e.key === 'd') player.targetX += 60;
  if (e.key === ' ') activateShield();
  if (e.key === 'l') showLeaderboard();
});

/* ---------------- Shield logic ---------------- */
function activateShield(){
  if (player.shieldActive || player.shieldCooldown) return;
  player.shieldActive = true; DOM.shieldStatus.textContent = 'Active'; setTimeout(()=>{ player.shieldActive = false; player.shieldCooldown = true; DOM.shieldStatus.textContent = 'Cooldown'; setTimeout(()=>{ player.shieldCooldown = false; DOM.shieldStatus.textContent = 'Ready'; },3000); },2200);
}

/* ---------------- Calibration & Start flow (async robust) ---------------- */
async function initAndStartSequence(){
  try{ if (audioCtx.state === 'suspended') await audioCtx.resume(); } catch(e){}
  try { await startCamera(); } catch(e){ alert('Camera error: please allow camera access'); throw e; }

  // wait short for first frames/detection
  const maxWait = 3000; const start = now();
  while (now() - start < maxWait){
    if (latestHands) break;
    await new Promise(r => setTimeout(r, 80));
  }

  // calibration sampling
  calibration.running = true; calibration.samples = [];
  const calModal = document.createElement('div'); calModal.className='backdrop'; calModal.innerHTML = `<div class="modal"><h2>Calibrating...</h2><div class="muted">Hold your dominant hand where you'd like the neutral center (~1.5s).</div></div>`; document.body.appendChild(calModal);
  const calStart = now();
  while (now() - calStart < calibration.durationMs){
    if (latestHands && latestHands.length > 0){ const n = wristToNorm(latestHands[0]); calibration.samples.push(n); }
    await new Promise(r => setTimeout(r, 60));
  }
  if (calibration.samples.length > 0){
    let sx=0, sy=0; for (const s of calibration.samples){ sx += s.x; sy += s.y; }
    calibration.neutral = { x: sx / calibration.samples.length, y: sy / calibration.samples.length };
    calibration.neutralScreenY = calibration.neutral.y * H;
  } else {
    calibration.neutral = { x:0.5, y:0.5 }; calibration.neutralScreenY = 0.5 * H;
  }
  calibration.running = false; document.body.removeChild(calModal);

  // try fullscreen (optional)
  try { const root = document.getElementById('uiRoot'); if (root.requestFullscreen) await root.requestFullscreen(); } catch(e){}

  // start playing session
  resetAll(); playing = true; startMusic();
}

/* ---------------- Reset/restart ---------------- */
function resetAll(){
  enemies=[]; powerups=[]; particles=[]; boss=null; inBoss=false; bossIntro=false; bossWarnShown=false;
  spawnTimer=0; spawnInterval=900; difficultyTimer=0; elapsedMs=0; score=0;
  player.x = W*0.5; player.y = H - 140; player.targetX = player.x; player.targetY = player.y;
  player.shieldActive=false; player.shieldCooldown=false; player.holdTimer=0; player.specialCooldown=0; player.fistCooldown=0;
  player.lives = 3; player.doublePoints = false;
  DOM.score.textContent = '0'; DOM.lives.textContent = player.lives; DOM.bossTimer.textContent = Math.ceil(BOSS_AFTER_MS/1000);
  screenShake = 0;
}
function restartPlay(){
  // small "get ready" delay
  const readyModal = document.createElement('div'); readyModal.className='backdrop'; readyModal.innerHTML = `<div class="modal"><h2>Get Ready...</h2><div class="muted">Resuming in 1.2s</div></div>`; document.body.appendChild(readyModal);
  setTimeout(()=>{ document.body.removeChild(readyModal); resetAll(); playing = true; startMusic(); }, 1200);
}

/* ---------------- Leaderboard helpers ---------------- */
function loadLB(){ try{ return JSON.parse(localStorage.getItem(LB_KEY) || '[]'); }catch(e){ return []; } }
function saveLB(arr){ localStorage.setItem(LB_KEY, JSON.stringify(arr)); }
function addLB(name, pts){ const arr = loadLB(); arr.push({name, pts}); arr.sort((a,b)=>b.pts - a.pts); saveLB(arr.slice(0,5)); }

/* ---------------- Start MediaPipe Camera (await) ---------------- */
async function startCamera(){
  if (mpCamera) return;
  const video = DOM.camPreview;
  mpCamera = new Camera(video, { onFrame: async ()=>{ await hands.send({ image: video }); }, width:640, height:480 });
  await mpCamera.start();
}

/* ---------------- Start RAF loop once ---------------- */
requestAnimationFrame(mainLoop); // RAF started (mainLoop handles playing state)

/* ---------------- Initial HowTo on load ---------------- */
showHowTo();

/* ---------------- Helper: show debug dot toggle value ---------------- */
DOM.debugToggle.checked = false;

/* ---------------- Utility: small helpers previously used ---------------- */
// Note: functions like isOpenPalm, detectFist, pushWrist, getSmoothedWrist are defined above

/* ---------------- Expose for console debug (optional) ---------------- */
window._stickman = { startCamera, hands, latestHands, calibration };

/* End of game.js */
