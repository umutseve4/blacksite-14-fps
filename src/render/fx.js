import * as THREE from 'three';
import { clamp } from '../core/rng.js';

/**
 * All transient visuals: impact decals, sparks, dust, smoke, tracers, shells,
 * explosions. Everything is pooled — no allocation during a firefight.
 */
export class FX {
  constructor(scene, lib, quality) {
    this.scene = scene;
    this.lib = lib;
    this.q = quality;
    this.time = 0;

    // ---------------- decals (pooled quads, oriented to the surface normal)
    this.decalMat = new THREE.MeshStandardMaterial({
      map: lib.decal,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.FrontSide,
    });
    this.decals = [];
    this.decalIdx = 0;
    const dgeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < quality.decals; i++) {
      const m = new THREE.Mesh(dgeo, this.decalMat.clone());
      m.visible = false;
      m.renderOrder = 2;
      scene.add(m);
      this.decals.push({ mesh: m, life: 0 });
    }

    // ---------------- sparks (one Points cloud, GPU-side additive)
    const SP = quality.sparks;
    this.sparkGeo = new THREE.BufferGeometry();
    this.sparkPos = new Float32Array(SP * 3);
    this.sparkVel = new Float32Array(SP * 3);
    this.sparkLife = new Float32Array(SP);
    this.sparkSize = new Float32Array(SP);
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    this.sparkGeo.setAttribute('size', new THREE.BufferAttribute(this.sparkSize, 1));
    this.sparkGeo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(SP), 1));
    this.sparkPoints = new THREE.Points(
      this.sparkGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uScale: { value: 400 } },
        vertexShader: /* glsl */ `
          attribute float size; attribute float alpha;
          varying float vA;
          uniform float uScale;
          void main() {
            vA = alpha;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * uScale / max(0.001, -mv.z);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          varying float vA;
          void main() {
            vec2 d = gl_PointCoord - 0.5;
            float r = length(d);
            if (r > 0.5) discard;
            float core = smoothstep(0.5, 0.0, r);
            // hot white core fading to ember orange
            vec3 c = mix(vec3(3.0, 0.55, 0.08), vec3(6.0, 4.4, 2.6), core * core);
            gl_FragColor = vec4(c * vA, vA * core);
          }`,
      })
    );
    this.sparkPoints.frustumCulled = false;
    this.sparkCursor = 0;
    scene.add(this.sparkPoints);

    // ---------------- smoke / dust puffs (pooled sprites)
    this.puffs = [];
    for (let i = 0; i < quality.puffs; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: lib.smoke,
          transparent: true,
          depthWrite: false,
          opacity: 0,
          color: 0xcbbfa8,
        })
      );
      s.visible = false;
      scene.add(s);
      this.puffs.push({ sprite: s, life: 0, ttl: 1, vel: new THREE.Vector3(), spin: 0, size0: 1, size1: 2 });
    }
    this.puffIdx = 0;

    // ---------------- tracers
    this.tracers = [];
    const tgeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 5, 1, true);
    tgeo.translate(0, -0.5, 0);
    tgeo.rotateX(Math.PI / 2); // now points down -Z with origin at the muzzle
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(
        tgeo,
        new THREE.MeshBasicMaterial({
          color: 0xffbb55,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        })
      );
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }
    this.tracerIdx = 0;

    // ---------------- shell casings
    this.shells = [];
    const sgeo = new THREE.CylinderGeometry(0.0045, 0.005, 0.021, 6);
    const smat = new THREE.MeshStandardMaterial({ color: 0xb98a3c, metalness: 1.0, roughness: 0.32 });
    for (let i = 0; i < 28; i++) {
      const m = new THREE.Mesh(sgeo, smat);
      m.visible = false;
      m.castShadow = false;
      scene.add(m);
      this.shells.push({ mesh: m, life: 0, vel: new THREE.Vector3(), spin: new THREE.Vector3() });
    }
    this.shellIdx = 0;

    // ---------------- dynamic muzzle light (one, reused)
    this.muzzleLight = new THREE.PointLight(0xffd39a, 0, 14, 2);
    this.muzzleLight.castShadow = false;
    scene.add(this.muzzleLight);

    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  impact(point, normal, matName = 'concrete') {
    // decal
    const d = this.decals[this.decalIdx = (this.decalIdx + 1) % this.decals.length];
    const n = new THREE.Vector3(normal[0], normal[1], normal[2]);
    d.mesh.position.set(point[0], point[1], point[2]).addScaledVector(n, 0.012);
    d.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    d.mesh.rotateZ(Math.random() * Math.PI * 2);
    const sc = 0.12 + Math.random() * 0.09;
    d.mesh.scale.set(sc, sc, sc);
    d.mesh.material.opacity = 1;
    d.mesh.visible = true;
    d.life = 14;

    const isMetal = matName === 'metal' || matName === 'container' || matName === 'barrel';
    const count = isMetal ? 16 : 9;
    for (let i = 0; i < count; i++) {
      this._spark(point, normal, isMetal ? 5.5 : 2.6, isMetal ? 0.5 : 0.28);
    }
    this._puff(point, normal, isMetal ? 0.16 : 0.30, isMetal ? 0.35 : 0.75);
  }

  bloodMist(point, dir) {
    for (let i = 0; i < 10; i++) this._spark(point, [-dir[0], -dir[1], -dir[2]], 2.0, 0.22, true);
    const p = this.puffs[(this.puffIdx = (this.puffIdx + 1) % this.puffs.length)];
    p.sprite.material.color.setHex(0x7a1410);
    p.sprite.position.set(point[0], point[1], point[2]);
    p.sprite.visible = true;
    p.life = 0;
    p.ttl = 0.45;
    p.size0 = 0.18;
    p.size1 = 0.55;
    p.vel.set(dir[0] * 0.6, 0.2, dir[2] * 0.6);
    p.spin = 0;
  }

  _spark(point, normal, speed, size, blood = false) {
    const i = (this.sparkCursor = (this.sparkCursor + 1) % this.sparkLife.length);
    const i3 = i * 3;
    this.sparkPos[i3] = point[0];
    this.sparkPos[i3 + 1] = point[1];
    this.sparkPos[i3 + 2] = point[2];
    const s = speed * (0.4 + Math.random() * 0.9);
    this.sparkVel[i3] = (normal[0] + (Math.random() - 0.5) * 1.5) * s;
    this.sparkVel[i3 + 1] = (normal[1] + (Math.random() - 0.5) * 1.5) * s + 0.6;
    this.sparkVel[i3 + 2] = (normal[2] + (Math.random() - 0.5) * 1.5) * s;
    this.sparkLife[i] = blood ? 0.25 : 0.30 + Math.random() * 0.45;
    this.sparkSize[i] = size * (0.5 + Math.random());
  }

  _puff(point, normal, size0, size1) {
    const p = this.puffs[(this.puffIdx = (this.puffIdx + 1) % this.puffs.length)];
    p.sprite.material.color.setHex(0xcbbfa8);
    p.sprite.position.set(point[0] + normal[0] * 0.05, point[1] + normal[1] * 0.05, point[2] + normal[2] * 0.05);
    p.sprite.visible = true;
    p.life = 0;
    p.ttl = 0.55 + Math.random() * 0.5;
    p.size0 = size0;
    p.size1 = size1;
    p.vel.set(normal[0] * 0.35, normal[1] * 0.35 + 0.35, normal[2] * 0.35);
    p.spin = (Math.random() - 0.5) * 1.5;
  }

  tracer(from, to) {
    const t = this.tracers[(this.tracerIdx = (this.tracerIdx + 1) % this.tracers.length)];
    const a = new THREE.Vector3(from[0], from[1], from[2]);
    const b = new THREE.Vector3(to[0], to[1], to[2]);
    const len = a.distanceTo(b);
    t.mesh.position.copy(a);
    t.mesh.lookAt(b);
    t.mesh.scale.set(1, 1, len);
    t.mesh.material.opacity = 0.85;
    t.mesh.visible = true;
    t.life = 0.055;
  }

  shell(pos, right, up, forward) {
    const s = this.shells[(this.shellIdx = (this.shellIdx + 1) % this.shells.length)];
    s.mesh.position.copy(pos);
    s.mesh.visible = true;
    s.life = 2.4;
    s.vel
      .copy(right).multiplyScalar(1.9 + Math.random() * 0.8)
      .addScaledVector(up, 1.3 + Math.random() * 0.5)
      .addScaledVector(forward, -0.4);
    s.spin.set(Math.random() * 22 - 11, Math.random() * 22 - 11, Math.random() * 22 - 11);
  }

  muzzleFlash(pos, intensity = 1) {
    this.muzzleLight.position.copy(pos);
    this.muzzleLight.intensity = 26 * intensity;
    this._flashT = 0.055;
  }

  explosion(point) {
    for (let i = 0; i < 40; i++) this._spark(point, [0, 1, 0], 9, 0.7);
    for (let i = 0; i < 6; i++) {
      const n = [Math.random() - 0.5, Math.random() * 0.6 + 0.4, Math.random() - 0.5];
      this._puff(point, n, 0.5, 3.4);
    }
    this.muzzleLight.position.set(point[0], point[1] + 0.6, point[2]);
    this.muzzleLight.intensity = 260;
    this._flashT = 0.22;
  }

  update(dt, camera) {
    this.time += dt;
    // decals
    for (const d of this.decals) {
      if (d.life > 0) {
        d.life -= dt;
        if (d.life < 1.2) d.mesh.material.opacity = clamp(d.life / 1.2, 0, 1);
        if (d.life <= 0) d.mesh.visible = false;
      }
    }
    // sparks
    const alpha = this.sparkGeo.attributes.alpha.array;
    let any = false;
    for (let i = 0; i < this.sparkLife.length; i++) {
      if (this.sparkLife[i] <= 0) {
        alpha[i] = 0;
        continue;
      }
      any = true;
      this.sparkLife[i] -= dt;
      const i3 = i * 3;
      this.sparkVel[i3 + 1] -= 15 * dt;
      this.sparkVel[i3] *= 1 - 2.4 * dt;
      this.sparkVel[i3 + 2] *= 1 - 2.4 * dt;
      this.sparkPos[i3] += this.sparkVel[i3] * dt;
      this.sparkPos[i3 + 1] += this.sparkVel[i3 + 1] * dt;
      this.sparkPos[i3 + 2] += this.sparkVel[i3 + 2] * dt;
      if (this.sparkPos[i3 + 1] < 0.02) {
        this.sparkPos[i3 + 1] = 0.02;
        this.sparkVel[i3 + 1] *= -0.28;
      }
      alpha[i] = clamp(this.sparkLife[i] * 2.4, 0, 1);
    }
    if (any || this._sparkDirty !== false) {
      this.sparkGeo.attributes.position.needsUpdate = true;
      this.sparkGeo.attributes.alpha.needsUpdate = true;
      this.sparkGeo.attributes.size.needsUpdate = true;
      this._sparkDirty = any;
    }
    // puffs
    for (const p of this.puffs) {
      if (!p.sprite.visible) continue;
      p.life += dt;
      const k = p.life / p.ttl;
      if (k >= 1) {
        p.sprite.visible = false;
        continue;
      }
      p.vel.y += 0.35 * dt;
      p.vel.multiplyScalar(1 - 1.6 * dt);
      p.sprite.position.addScaledVector(p.vel, dt);
      const s = p.size0 + (p.size1 - p.size0) * Math.pow(k, 0.55);
      p.sprite.scale.setScalar(s);
      p.sprite.material.rotation += p.spin * dt;
      p.sprite.material.opacity = (1 - k) * 0.55;
    }
    // tracers
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        t.mesh.material.opacity = clamp(t.life / 0.055, 0, 1) * 0.85;
        if (t.life <= 0) t.mesh.visible = false;
      }
    }
    // shells
    for (const s of this.shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.vel.y -= 12 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      if (s.mesh.position.y < 0.01) {
        s.mesh.position.y = 0.01;
        s.vel.y *= -0.32;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
        s.spin.multiplyScalar(0.5);
      }
      if (s.life <= 0) s.mesh.visible = false;
    }
    // muzzle light decay
    if (this._flashT > 0) {
      this._flashT -= dt;
      this.muzzleLight.intensity *= Math.pow(0.0008, dt);
      if (this._flashT <= 0) this.muzzleLight.intensity = 0;
    }
  }
}
