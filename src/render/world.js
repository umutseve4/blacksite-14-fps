import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PROPS, ARENA } from '../core/level.js';

/**
 * Box geometry whose UVs are world-space scaled, so a 16 m wall and a 1 m crate
 * show the same texel density. Uniform 0..1 box UVs are the single most common
 * reason hand-built WebGL levels look like stretched cardboard.
 */
export function worldUvBox(sx, sy, sz, scale = 1, radius = 0) {
  const g = radius > 0
    ? new RoundedBoxGeometry(sx, sy, sz, 2, radius)
    : new THREE.BoxGeometry(sx, sy, sz, 1, 1, 1);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let u;
    let v;
    if (nx >= ny && nx >= nz) {
      u = z; v = y;
    } else if (ny >= nz) {
      u = x; v = z;
    } else {
      u = x; v = y;
    }
    uv.setXY(i, u * scale, v * scale);
  }
  uv.needsUpdate = true;
  return g;
}

function barrelMesh(lib) {
  const g = new THREE.CylinderGeometry(0.32, 0.32, 0.95, 24, 1, false);
  const mat = lib.get('barrel');
  const m = new THREE.Mesh(g, mat);
  const rib = new THREE.TorusGeometry(0.325, 0.028, 6, 24);
  for (const y of [-0.22, 0.0, 0.22]) {
    const r = new THREE.Mesh(rib, mat);
    r.rotation.x = Math.PI / 2;
    r.position.y = y;
    r.castShadow = true;
    m.add(r);
  }
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.335, 0.05, 24), mat);
  lid.position.y = 0.475;
  m.add(lid);
  return m;
}

/** Assembles the whole compound. Returns { group, shadowCasters }. */
export function buildWorld(scene, lib, quality) {
  const group = new THREE.Group();
  group.name = 'world';

  // ------------------------------------------------------------ ground
  const groundMat = lib.get('sand');
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 4, ARENA * 4, 1, 1), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);

  // a subtly displaced inner apron so the ground is not a mathematically flat plane
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA, ARENA, 48, 48),
    groundMat.clone()
  );
  const pa = apron.geometry.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i);
    const y = pa.getY(i);
    const d = Math.hypot(x, y);
    const h = Math.sin(x * 0.13) * Math.cos(y * 0.11) * 0.06 + Math.sin(d * 0.4) * 0.015;
    pa.setZ(i, h);
  }
  apron.geometry.computeVertexNormals();
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = 0.012;
  apron.receiveShadow = true;
  group.add(apron);

  // ------------------------------------------------------------ props
  const shadowCasters = [];
  const byProp = new Map();
  const bevel = quality.bevel;
  for (const p of PROPS) {
    let mesh;
    if (p.kind === 'box') {
      const scale = p.mat === 'sandbag' ? 0.9 : p.mat === 'crate' ? 0.9 : 0.42;
      const r = bevel && Math.min(p.sx, p.sy, p.sz) > 0.5 ? Math.min(0.045, Math.min(p.sx, p.sy, p.sz) * 0.06) : 0;
      const g = worldUvBox(p.sx, p.sy, p.sz, scale, r);
      const mat = p.tint ? lib.tinted(p.mat, p.tint) : lib.get(p.mat);
      mesh = new THREE.Mesh(g, mat);
      mesh.position.set(p.x, p.y, p.z);
    } else if (p.kind === 'barrel') {
      mesh = barrelMesh(lib);
      mesh.position.set(p.x, p.y + 0.475, p.z);
      mesh.rotation.y = (p.x * 0.7 + p.z * 1.3) % Math.PI;
      if (p.explosive) {
        const band = new THREE.Mesh(
          new THREE.CylinderGeometry(0.33, 0.33, 0.18, 20),
          new THREE.MeshStandardMaterial({ color: 0x8a1f10, roughness: 0.6, metalness: 0.3 })
        );
        band.position.y = 0.1;
        mesh.add(band);
      }
    } else if (p.kind === 'mast') {
      mesh = new THREE.Group();
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.09, p.h, 8),
        lib.get('metal')
      );
      pole.position.y = p.h / 2;
      mesh.add(pole);
      for (let i = 0; i < 3; i++) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 0.03), lib.get('metal'));
        arm.position.set(0, p.h * (0.55 + i * 0.15), 0);
        arm.rotation.y = i * 0.9;
        mesh.add(arm);
      }
      mesh.position.set(p.x, p.y, p.z);
    }
    if (!mesh) continue;
    mesh.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    mesh.userData.tag = p.tag || p.mat;
    group.add(mesh);
    shadowCasters.push(mesh);
    byProp.set(p, mesh);
  }

  scene.add(group);
  return { group, shadowCasters, byProp };
}
