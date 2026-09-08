import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Spring } from '../core/recoil.js';
import { clamp, lerp } from '../core/rng.js';

const bx = (w, h, d, r = 0.004) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.4));

/**
 * Procedural first-person weapon. Rendered by its own camera at a narrower FOV
 * so raising the world FOV does not stretch the gun, and after a depth clear so
 * it can never clip into geometry.
 */
export class ViewModel {
  constructor(lib) {
    this.lib = lib;
    this.scene = new THREE.Scene();
    this.root = new THREE.Group();       // sway/bob/ads carrier
    this.gunRoot = new THREE.Group();    // recoil carrier
    this.root.add(this.gunRoot);
    this.scene.add(this.root);

    // dedicated 3-point rig; the world sun does not light the viewmodel
    const key = new THREE.DirectionalLight(0xfff2dc, 2.6);
    key.position.set(0.6, 1.2, 0.9);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.85);
    fill.position.set(-0.9, 0.2, 0.6);
    const rim = new THREE.DirectionalLight(0xbcd8ff, 1.5);
    rim.position.set(-0.4, 0.5, -1.0);
    this.scene.add(key, fill, rim, new THREE.AmbientLight(0x30384a, 0.5));

    // The viewmodel gets its own camera with a narrower FOV and a very close
    // near plane. This is why the gun never clips through a wall and why it
    // does not distort at the edge of a 103-degree world FOV.
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.005, 12);
    this.scene.add(this.camera);

    // one reused flash sprite, parented to the gun so it tracks recoil
    this.flashSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: lib.flash,
        color: 0xffd9a8,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    this.flashSprite.visible = false;
    this.flashSprite.renderOrder = 10;
    this.gunRoot.add(this.flashSprite);
    this.flashT = 0;

    this.models = {};
    this.current = null;

    this.adsSpring = new Spring(0.075, 0);
    this.kick = new Spring(0.085, 0);       // backward translation
    this.pitchKick = new Spring(0.10, 0);   // muzzle rise of the model
    this.rollKick = new Spring(0.11, 0);
    this.swayX = new Spring(0.09, 0);
    this.swayY = new Spring(0.09, 0);
    this.lowerSpring = new Spring(0.11, 0); // sprint / reload lowering
    this.bobPhase = 0;
    this.reload = null;

    this.basePos = new THREE.Vector3(0.185, -0.155, -0.36);
    this.adsPos = new THREE.Vector3(0, -0.062, -0.24);
  }

  /** Builds all three weapons once; switching just toggles visibility. */
  build() {
    for (const id of ['ar', 'smg', 'dmr']) {
      const m = this._make(id);
      m.visible = false;
      this.gunRoot.add(m);
      this.models[id] = m;
    }
    return this;
  }

  _make(id) {
    const gun = this.lib.get('gun');
    const poly = this.lib.get('polymer');
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      g.add(m);
      return m;
    };

    const long = id === 'dmr' ? 1.0 : id === 'ar' ? 0.86 : 0.7;

    // receiver
    add(bx(0.062, 0.082, 0.30), gun, 0, 0, -0.02);
    // upper rail with individual slots — reads as machined, not a smooth block
    for (let i = 0; i < 11; i++) {
      add(bx(0.05, 0.008, 0.012), gun, 0, 0.047, -0.14 + i * 0.026);
    }
    // handguard
    const hg = add(bx(0.056, 0.058, long * 0.42), poly, 0, -0.004, -0.13 - long * 0.21);
    // cooling slots
    for (let i = 0; i < 6; i++) {
      const s = add(bx(0.058, 0.012, 0.02), gun, 0, -0.004, -0.16 - i * 0.05);
      s.scale.setScalar(0.999);
    }
    // barrel + flash hider
    add(new THREE.CylinderGeometry(0.011, 0.011, long * 0.5, 12), gun, 0, 0.006, -0.14 - long * 0.3, Math.PI / 2);
    const muzzle = add(new THREE.CylinderGeometry(0.019, 0.016, 0.052, 12), gun, 0, 0.006, -0.14 - long * 0.55, Math.PI / 2);
    // gas block
    add(bx(0.026, 0.03, 0.04), gun, 0, 0.026, -0.14 - long * 0.36);
    // magazine (curved, in three segments)
    const magGrp = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(bx(0.03, 0.058, 0.052), poly);
      m.position.set(0, -0.03 - i * 0.052, 0.004 + i * 0.012);
      m.rotation.x = -0.12 * i;
      magGrp.add(m);
    }
    magGrp.position.set(0, -0.035, -0.02);
    g.add(magGrp);
    // pistol grip
    const grip = add(bx(0.03, 0.10, 0.05), poly, 0, -0.072, 0.06, 0.30);
    // stock
    add(bx(0.036, 0.05, 0.10), poly, 0, 0.004, 0.145);
    add(bx(0.05, 0.085, 0.032), poly, 0, -0.004, 0.205);
    // charging handle
    const charge = add(bx(0.05, 0.014, 0.03), gun, 0, 0.03, 0.10);
    // optic: tube, mount, glass
    add(bx(0.04, 0.02, 0.05), gun, 0, 0.058, -0.03);
    const tube = add(new THREE.CylinderGeometry(0.019, 0.019, id === 'dmr' ? 0.16 : 0.10, 16), gun, 0, 0.079, -0.03, Math.PI / 2);
    const glass = new THREE.Mesh(
      new THREE.CircleGeometry(0.0165, 20),
      new THREE.MeshPhysicalMaterial({
        color: 0x0b1a24, roughness: 0.08, metalness: 0.0,
        transmission: 0.55, thickness: 0.01, ior: 1.5,
        emissive: 0x000000, envMapIntensity: 1.4,
      })
    );
    glass.position.set(0, 0.079, id === 'dmr' ? 0.05 : 0.021);
    glass.rotation.y = Math.PI;
    g.add(glass);
    // reticle: emissive dot that survives tone mapping and blooms slightly
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.0016, 12),
      new THREE.MeshBasicMaterial({ color: 0xff3b2f, toneMapped: false })
    );
    dot.position.set(0, 0.079, id === 'dmr' ? 0.049 : 0.020);
    dot.rotation.y = Math.PI;
    g.add(dot);

    // gloved support hand (blocky but silhouetted, better than a floating gun)
    const glove = this.lib.get('polymer');
    const hand = new THREE.Group();
    hand.add(new THREE.Mesh(bx(0.055, 0.05, 0.10, 0.02), glove));
    const thumb = new THREE.Mesh(bx(0.02, 0.055, 0.03, 0.008), glove);
    thumb.position.set(0.02, 0.03, 0.01);
    thumb.rotation.z = -0.4;
    hand.add(thumb);
    hand.position.set(0.005, -0.05, -0.13 - long * 0.16);
    hand.rotation.set(0.2, 0, 0.15);
    g.add(hand);

    const rear = new THREE.Group();
    rear.add(new THREE.Mesh(bx(0.05, 0.05, 0.085, 0.018), glove));
    rear.position.set(0.004, -0.085, 0.055);
    rear.rotation.set(0.25, 0, 0.1);
    g.add(rear);
    // forearm sleeve
    const sleeve = new THREE.Mesh(bx(0.062, 0.062, 0.16, 0.02), this.lib.get('crate'));
    sleeve.position.set(0.02, -0.115, 0.15);
    sleeve.rotation.set(0.22, 0.1, 0.08);
    g.add(sleeve);

    g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });

    g.userData.muzzleLocal = new THREE.Vector3(0, 0.006, -0.14 - long * 0.58);
    g.userData.magGroup = magGrp;
    g.userData.charge = charge;
    g.userData.dot = dot;
    return g;
  }

  select(id) {
    for (const k in this.models) this.models[k].visible = k === id;
    this.current = this.models[id];
    return this.current;
  }

  muzzleWorld(out = new THREE.Vector3()) {
    if (!this.current) return out.set(0, 0, 0);
    return out.copy(this.current.userData.muzzleLocal).applyMatrix4(this.current.matrixWorld);
  }

  setAspect(aspect, fovDeg) {
    this.camera.aspect = aspect;
    if (fovDeg) this.camera.fov = fovDeg;
    this.camera.updateProjectionMatrix();
  }

  /** One shot's worth of impulse. */
  applyShot(weapon) {
    this.kick.target += weapon.kickBack;
    this.pitchKick.target += weapon.recoil.pitchBase * 0.028;
    this.rollKick.target += (Math.random() - 0.5) * 0.012;
    if (this.current) {
      const m = this.current.userData.muzzleLocal;
      this.flashSprite.position.copy(m).add(this.current.position);
      this.flashSprite.scale.setScalar(0.10 + Math.random() * 0.06);
      this.flashSprite.material.rotation = Math.random() * Math.PI * 2;
      this.flashSprite.visible = true;
      this.flashT = weapon.muzzleFlashMs / 1000;
    }
  }

  startReload(ms, empty) {
    this.reload = { t: 0, dur: ms / 1000, empty };
  }

  update(dt, st) {
    const s = this;
    if (s.flashT > 0) {
      s.flashT -= dt;
      if (s.flashT <= 0) s.flashSprite.visible = false;
    }
    // --- ADS -------------------------------------------------------------
    s.adsSpring.setHalfLife(st.ads ? st.adsMs / 1000 / 3.2 : st.unAdsMs / 1000 / 3.2);
    s.adsSpring.target = st.ads ? 1 : 0;
    const a = clamp(s.adsSpring.step(dt), 0, 1);
    s.adsAmount = a;

    // --- springs ---------------------------------------------------------
    s.kick.target *= Math.pow(0.0009, dt);
    s.pitchKick.target *= Math.pow(0.0009, dt);
    s.rollKick.target *= Math.pow(0.002, dt);
    const kick = s.kick.step(dt);
    const pk = s.pitchKick.step(dt);
    const rk = s.rollKick.step(dt);

    // --- sway (rotational lag behind the mouse) ---------------------------
    const swayScale = lerp(1, 0.32, a);
    s.swayX.target = clamp(-st.lookDx * 0.9, -0.06, 0.06) * swayScale;
    s.swayY.target = clamp(-st.lookDy * 0.9, -0.05, 0.05) * swayScale;
    const sx = s.swayX.step(dt);
    const sy = s.swayY.step(dt);

    // --- bob (two frequencies, phase-offset; abs() on the vertical) -------
    const speed = st.speed;
    const moving = speed > 0.4 && st.onGround;
    const freq = st.sprinting ? 2.85 : st.crouched ? 1.25 : 1.85;
    if (moving) s.bobPhase += dt * freq * Math.PI * 2;
    else s.bobPhase = lerp(s.bobPhase, Math.round(s.bobPhase / Math.PI) * Math.PI, 1 - Math.pow(0.001, dt));
    const bobAmp = (st.sprinting ? 0.032 : st.crouched ? 0.009 : 0.016) * clamp(speed / 5, 0, 1) * lerp(1, 0.4, a);
    const bobX = Math.sin(s.bobPhase) * bobAmp;
    const bobY = Math.abs(Math.cos(s.bobPhase)) * bobAmp * 0.75;
    // breathing never stops, even standing still
    const breath = Math.sin(performance.now() * 0.0011) * (a > 0.5 ? 0.0016 : 0.0035);

    // --- lowering (sprint / reload) --------------------------------------
    s.lowerSpring.target = st.sprinting ? 1 : 0;
    const low = s.lowerSpring.step(dt);

    // --- compose ---------------------------------------------------------
    const p = s.root.position;
    const bp = s.basePos;
    const ap = s.adsPos;
    p.set(
      lerp(bp.x, ap.x, a) + bobX + sx,
      lerp(bp.y, ap.y, a) + bobY + sy + breath - low * 0.075,
      lerp(bp.z, ap.z, a) + kick
    );
    s.root.rotation.set(
      -sy * 1.6 + pk + low * 0.30 + bobY * 0.6,
      -sx * 1.9 + low * 0.42,
      rk + bobX * 0.9 * lerp(1, 0.3, a) - low * 0.35
    );

    // --- reload animation -------------------------------------------------
    if (s.reload && s.current) {
      const r = s.reload;
      r.t += dt;
      const k = clamp(r.t / r.dur, 0, 1);
      const mag = s.current.userData.magGroup;
      // out (0-0.35), swap (0.35-0.6), in (0.6-0.85), charge (0.85-1)
      const drop = k < 0.35 ? k / 0.35 : k < 0.6 ? 1 : k < 0.85 ? 1 - (k - 0.6) / 0.25 : 0;
      mag.position.y = -0.035 - drop * 0.16;
      mag.rotation.x = drop * 0.5;
      const tilt = Math.sin(k * Math.PI) ;
      s.root.rotation.x += tilt * 0.42;
      s.root.rotation.z += tilt * 0.30;
      s.root.position.y -= tilt * 0.085;
      s.root.position.x -= tilt * 0.03;
      if (r.empty && s.current.userData.charge) {
        const c = clamp((k - 0.85) / 0.15, 0, 1);
        s.current.userData.charge.position.z = 0.10 + Math.sin(c * Math.PI) * 0.05;
      }
      if (k >= 1) {
        mag.position.y = -0.035;
        mag.rotation.x = 0;
        s.reload = null;
      }
    }
    return a;
  }
}
