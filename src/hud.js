import { clamp } from './core/rng.js';

const $ = (id) => document.getElementById(id);

/**
 * HUD lives in the DOM, deliberately: if it were drawn into the 3D scene the
 * post chain would put film grain, chromatic aberration and bloom on top of the
 * text, which is exactly how a UI stops looking crisp.
 */
export class HUD {
  constructor() {
    this.root = $('hud');
    this.cross = {
      t: $('ch-t'), b: $('ch-b'), l: $('ch-l'), r: $('ch-r'), dot: $('ch-dot'),
    };
    this.hit = $('hitmarker');
    this.ammo = $('ammo');
    this.ammoRes = $('ammo-res');
    this.wname = $('weapon-name');
    this.hpFill = $('hp-fill');
    this.hpNum = $('hp-num');
    this.killfeed = $('killfeed');
    this.score = $('score');
    this.wave = $('wave');
    this.toast = $('toast');
    this.vignette = $('dmg-vignette');
    this.mini = $('minimap');
    this.miniCtx = this.mini ? this.mini.getContext('2d') : null;
    this.dirs = $('dmg-dirs');
    this.hitT = 0;
    this.hitKill = false;
    this.dmgT = 0;
    this.indicators = [];
    this.lastAmmo = -1;
  }

  setCrosshair(spreadPx, hidden) {
    const gap = clamp(spreadPx, 3, 90);
    const len = 7;
    const o = this.cross;
    if (!o.t) return;
    const vis = hidden ? 'none' : 'block';
    for (const k of ['t', 'b', 'l', 'r', 'dot']) o[k].style.display = vis;
    if (hidden) return;
    o.t.style.transform = `translate(-50%, -50%) translateY(${-gap - len}px)`;
    o.b.style.transform = `translate(-50%, -50%) translateY(${gap}px)`;
    o.l.style.transform = `translate(-50%, -50%) translateX(${-gap - len}px)`;
    o.r.style.transform = `translate(-50%, -50%) translateX(${gap}px)`;
  }

  hitmark(kill) {
    this.hitT = kill ? 0.42 : 0.24;
    this.hitKill = kill;
    this.hit.classList.toggle('kill', kill);
  }

  damageFrom(angleDeg) {
    this.dmgT = 0.9;
    const el = document.createElement('div');
    el.className = 'dmg-dir';
    el.style.transform = `rotate(${angleDeg}deg)`;
    this.dirs.appendChild(el);
    this.indicators.push({ el, t: 1.1 });
  }

  setAmmo(mag, reserve, name, reloading) {
    if (mag !== this.lastAmmo) {
      this.ammo.textContent = String(mag).padStart(2, '0');
      this.ammo.classList.toggle('low', mag <= 5);
      this.lastAmmo = mag;
    }
    this.ammoRes.textContent = reserve;
    this.wname.textContent = reloading ? `${name} · RELOADING` : name;
    this.wname.classList.toggle('warn', reloading);
  }

  setHealth(hp) {
    const k = clamp(hp / 100, 0, 1);
    this.hpFill.style.width = `${k * 100}%`;
    this.hpFill.style.background = k > 0.55 ? '#d8e2ea' : k > 0.25 ? '#e8b23c' : '#e0463c';
    this.hpNum.textContent = Math.max(0, Math.round(hp));
  }

  setScore(score, alive, wave) {
    this.score.textContent = score;
    this.wave.textContent = `WAVE ${wave} · ${alive} HOSTILE${alive === 1 ? '' : 'S'}`;
  }

  kill(text, cls = '') {
    const row = document.createElement('div');
    row.className = `kf ${cls}`;
    row.innerHTML = text;
    this.killfeed.appendChild(row);
    setTimeout(() => row.classList.add('out'), 3200);
    setTimeout(() => row.remove(), 3800);
    while (this.killfeed.children.length > 5) this.killfeed.firstChild.remove();
  }

  say(text, ms = 1600) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.toast.classList.remove('show'), ms);
  }

  drawMinimap(player, yaw, bots, boxes) {
    const ctx = this.miniCtx;
    if (!ctx) return;
    const W = this.mini.width;
    const H = this.mini.height;
    const R = 34; // metres shown
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.beginPath();
    ctx.arc(0, 0, W / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(9,12,15,0.62)';
    ctx.fillRect(-W, -H, W * 2, H * 2);
    ctx.rotate(-yaw);
    const s = (W / 2) / R;
    ctx.strokeStyle = 'rgba(150,170,185,0.55)';
    ctx.lineWidth = 1;
    for (const b of boxes) {
      if (b.tag === 'ground' || b.max[1] - b.min[1] < 0.9) continue;
      const x0 = (b.min[0] - player[0]) * s;
      const z0 = (b.min[2] - player[2]) * s;
      const w = (b.max[0] - b.min[0]) * s;
      const h = (b.max[2] - b.min[2]) * s;
      if (Math.abs(x0) > W || Math.abs(z0) > H) continue;
      ctx.strokeRect(x0, z0, w, h);
    }
    for (const bot of bots) {
      if (bot.state === 'dead') continue;
      const x = (bot.pos[0] - player[0]) * s;
      const z = (bot.pos[2] - player[2]) * s;
      if (x * x + z * z > (W / 2) * (W / 2)) continue;
      ctx.fillStyle = '#e0463c';
      ctx.beginPath();
      ctx.arc(x, z, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // player arrow, always up
    ctx.fillStyle = '#dfe8ee';
    ctx.beginPath();
    ctx.moveTo(W / 2, H / 2 - 5);
    ctx.lineTo(W / 2 - 3.6, H / 2 + 4);
    ctx.lineTo(W / 2 + 3.6, H / 2 + 4);
    ctx.closePath();
    ctx.fill();
  }

  update(dt) {
    if (this.hitT > 0) {
      this.hitT -= dt;
      const k = clamp(this.hitT / (this.hitKill ? 0.42 : 0.24), 0, 1);
      this.hit.style.opacity = k;
      this.hit.style.transform = `translate(-50%,-50%) scale(${1.35 - k * 0.35})`;
    }
    if (this.dmgT > 0) {
      this.dmgT -= dt;
      this.vignette.style.opacity = clamp(this.dmgT / 0.9, 0, 1) * 0.85;
    }
    for (let i = this.indicators.length - 1; i >= 0; i--) {
      const ind = this.indicators[i];
      ind.t -= dt;
      ind.el.style.opacity = clamp(ind.t, 0, 1);
      if (ind.t <= 0) {
        ind.el.remove();
        this.indicators.splice(i, 1);
      }
    }
  }
}
