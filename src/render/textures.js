import * as THREE from 'three';
import * as gen from '../core/texgen.js';

function dataTex(buf, size, { srgb = false, repeat = 1, aniso = 8 } = {}) {
  const t = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * Builds every material in the game from synthesised bytes. No image files,
 * no network fetches: `MaterialLibrary.build()` is the whole art pipeline.
 */
export class MaterialLibrary {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.q = quality;
    this.aniso = Math.min(quality.aniso, renderer.capabilities.getMaxAnisotropy());
    this.materials = {};
    this.textures = {};
  }

  _set(name, maps, opts) {
    const size = maps.size;
    const rep = opts.repeat ?? 1;
    const tex = {
      map: dataTex(maps.albedo, size, { srgb: true, repeat: rep, aniso: this.aniso }),
      normalMap: dataTex(maps.normal, size, { repeat: rep, aniso: this.aniso }),
      roughnessMap: dataTex(maps.rough, size, { repeat: rep, aniso: this.aniso }),
      aoMap: dataTex(maps.ao, size, { repeat: rep, aniso: this.aniso }),
    };
    if (maps.metal) tex.metalnessMap = dataTex(maps.metal, size, { repeat: rep, aniso: this.aniso });
    this.textures[name] = tex;
    const mat = new THREE.MeshStandardMaterial({
      ...tex,
      color: opts.color ?? 0xffffff,
      roughness: opts.roughness ?? 1.0,
      metalness: opts.metalness ?? 0.0,
      normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
      envMapIntensity: opts.env ?? 1.0,
      dithering: true,
    });
    mat.name = name;
    this.materials[name] = mat;
    return mat;
  }

  build() {
    const S = this.q.texSize;
    this._set('sand', gen.sand(S, 31), { repeat: 26, normalScale: 0.75, env: 0.7 });
    this._set('concrete', gen.concrete(S, 11), { repeat: 2.6, normalScale: 1.0, env: 0.8 });
    this._set('concreteFloor', gen.concrete(S, 17), { repeat: 6, normalScale: 0.9, env: 0.75 });
    this._set('metal', gen.paintedMetal(S, 57, [0.30, 0.31, 0.30]), {
      repeat: 1.4, metalness: 1.0, normalScale: 1.0, env: 1.0,
    });
    this._set('container', gen.paintedMetal(S, 63, [0.40, 0.22, 0.18]), {
      repeat: 1.0, metalness: 1.0, normalScale: 1.1, env: 1.0,
    });
    this._set('barrel', gen.paintedMetal(Math.min(S, 256), 71, [0.24, 0.26, 0.22]), {
      repeat: 1.0, metalness: 1.0, normalScale: 1.0,
    });
    this._set('crate', gen.fabric(Math.min(S, 256), 83, [0.30, 0.23, 0.14]), {
      repeat: 1.0, normalScale: 0.9, env: 0.6,
    });
    this._set('sandbag', gen.fabric(Math.min(S, 256), 77, [0.36, 0.32, 0.22]), {
      repeat: 2.0, normalScale: 1.3, env: 0.5,
    });
    this._set('gun', gen.gunMetal(256, 91), { repeat: 1, metalness: 1.0, normalScale: 0.9, env: 1.1 });
    this._set('polymer', gen.fabric(256, 97, [0.085, 0.09, 0.085]), {
      repeat: 3, normalScale: 0.5, roughness: 0.62, env: 0.8,
    });

    // container variants are tinted clones sharing one texture set (cheap variety)
    this.decal = dataTex(gen.bulletDecal(128, 5).albedo, 128, { srgb: true, repeat: 1, aniso: 4 });
    this.decal.wrapS = this.decal.wrapT = THREE.ClampToEdgeWrapping;
    this.smoke = dataTex(gen.radialSprite(128, 1.7, 3).albedo, 128, { srgb: true, aniso: 2 });
    this.smoke.wrapS = this.smoke.wrapT = THREE.ClampToEdgeWrapping;
    this.flash = dataTex(gen.radialSprite(128, 3.4, 9).albedo, 128, { srgb: true, aniso: 2 });
    this.flash.wrapS = this.flash.wrapT = THREE.ClampToEdgeWrapping;
    return this;
  }

  get(name) {
    return this.materials[name] || this.materials.concrete;
  }

  tinted(name, tint) {
    const key = `${name}_${tint.join('_')}`;
    if (!this.materials[key]) {
      const m = this.get(name).clone();
      m.color = new THREE.Color(tint[0], tint[1], tint[2]).convertSRGBToLinear();
      m.name = key;
      this.materials[key] = m;
    }
    return this.materials[key];
  }

  setEnvironment(env) {
    for (const m of Object.values(this.materials)) {
      m.envMap = env;
      m.needsUpdate = true;
    }
  }
}
