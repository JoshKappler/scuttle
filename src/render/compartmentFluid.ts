import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { TUN } from "../core/tunables";
import { buildFillCurve, fillHeightLocal, type Compartment, type FillCurve } from "../sim/compartments";
import { getOceanLook, type OceanLook } from "./ocean";

/**
 * Flooded-compartment water — a CLONE of the open-SEA surface sitting at the compartment's own (lower)
 * flood level, so the interior reads as "the ocean continuing into the room", not a separate material.
 *
 * 3rd-attempt rework (the prior per-column BoxGeometry grid read as "vertical tiles that glitch" — many
 * overlapping prisms with depthWrite-off + DoubleSide → z-fighting, tile seams, a grid look). Replaced by:
 *
 *   • ONE continuous TOP sheet per flooded compartment — a single plane sized to the compartment
 *     footprint, drawn WORLD-horizontal at the gravity-level pool surface (the mesh is counter-rotated
 *     by the inverse ship pose, so as the hull heels/pitches the water stays level — what reads as a
 *     real liquid). No tiles → no seams, no z-fight.
 *   • A short SIDE SKIRT — four vertical walls hanging from the surface rim down a tunable depth — so
 *     the water has visible VOLUME/substance (a body filling the room), not a floating skin.
 *   • The skirt FADES OUT (height + opacity → 0) as the interior level rises to the LOCAL SEA level: a
 *     big hole equalises fast so inside ≈ outside and there's no jarring exposed wall at the breach; the
 *     wall only shows for a SMALL hole (interior well below the sea) or transiently while filling.
 *
 * The LOOK is shared LIVE from render/ocean.ts (getOceanLook): the same body-colour gradient, the same
 * sky+cloud reflection cube (Fresnel-weighted, clamped), the same sun colour/direction and the same
 * clock — so the inside water matches the sea's colour/shimmer and follows any dev-panel ocean tuning.
 *
 * The fill LEVEL comes from the STATIC cumulative volume↔height curve the sim uses (buildFillCurve /
 * fillHeightLocal) — O(log layers), built once. NO per-tick world-Y cell sort (that was the old perf
 * sink). Render-only: this does THREE work but never feeds sim/ (determinism — THE LAW #1).
 */

// Fallback navy tones if the ocean look isn't bound yet (it always is by the time water shows).
const FALLBACK_SHALLOW = new THREE.Color(0x0c2a45);
const FALLBACK_DEEP = new THREE.Color(0x0a1a2e);

const VERT = /* glsl */ `
uniform float uTime;
uniform float uShimmer;
varying vec3 vWorldPos;
varying float vEdge;   // 1 on the skirt's bottom rim → darken toward the floor
varying float vIsTop;  // 1 for the top sheet, 0 for the skirt walls
attribute float aEdge;
attribute float aTop;
void main() {
  vec3 p = position;
  vEdge = aEdge;
  vIsTop = aTop;
  // gentle Gerstner-ish shimmer on the TOP sheet only — small crossing ripples so the pool has life
  // without reading as the open sea. The skirt walls stay still (a wall doesn't ripple).
  vec4 wp = modelMatrix * vec4(p, 1.0);
  if (aTop > 0.5) {
    float s = sin(uTime * 1.3 + wp.x * 0.9 + wp.z * 0.7)
            + 0.6 * sin(uTime * 0.8 - wp.x * 0.5 + wp.z * 1.1);
    wp.y += uShimmer * s;
  }
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform samplerCube uSkyEnv;
uniform float uHasEnv;
uniform float uReflStrength;
uniform float uReflClamp;
uniform vec3 uSunDir;
uniform vec3 uCameraPos;
uniform float uTime;
uniform float uTopOpacity;
uniform float uSkirtOpacity;
uniform float uExposure;   // skirt fade (1 = fully shown, 0 = hidden when inside == sea level)
varying vec3 vWorldPos;
varying float vEdge;
varying float vIsTop;

void main() {
  vec3 V = normalize(uCameraPos - vWorldPos);
  // The flood pool is calm: the TOP sheet uses a mostly-up normal with a slow ripple so the sky
  // reflection + body gradient read like the open sea's, distorted just a little. The SKIRT walls face
  // outward toward the viewer (a horizontal-ish normal), so they pick up the deep body colour, not the
  // sky — that's what reads as the dim underside/wall of a body of water.
  vec3 N;
  if (vIsTop > 0.5) {
    float nx = 0.12 * sin(uTime * 1.1 + vWorldPos.x * 0.8 + vWorldPos.z * 0.6);
    float nz = 0.12 * sin(uTime * 0.9 - vWorldPos.x * 0.5 + vWorldPos.z * 0.9);
    N = normalize(vec3(nx, 1.0, nz));
  } else {
    vec3 horiz = vec3(V.x, 0.0, V.z);
    N = normalize(vec3(0.0, 0.2, 0.0) + (length(horiz) > 1e-3 ? normalize(horiz) : vec3(0.0, 0.0, 1.0)));
  }

  // body colour: the SAME shallow→deep gradient the sea uses, by view angle (deep looking straight down)
  float facing = max(dot(N, V), 0.0);
  vec3 water = mix(uShallowColor, uDeepColor, facing);

  vec3 col;
  if (vIsTop > 0.5) {
    // TOP sheet: the SAME sea body colour + a clone of the sea's Fresnel sky-env reflection, so it
    // matches the open water — BUT the pool sits down inside a (shadowed) hold, and a perfectly FLAT
    // plane catches the sun/sky as one uniform white sheet (the open sea breaks it up with chop). So
    // the reflection + grazing fresnel are held well DOWN here, and the body is biased a touch deeper,
    // so the interior water reads as dim sea — not a bright mirror panel.
    float fresnel = pow(1.0 - facing, 5.0);
    vec3 Rr = reflect(-V, N);
    Rr.y = max(Rr.y, 0.02);
    vec3 skyRefl = (uHasEnv > 0.5) ? textureCube(uSkyEnv, Rr).rgb : uSkyColor;
    skyRefl = min(skyRefl, vec3(uReflClamp));
    // cap the grazing fresnel (a flat sheet would otherwise mirror the whole sky at its far edge) and
    // scale the sea's reflection strength down for the enclosed pool.
    float reflF = clamp((min(fresnel, 0.35) * 0.6 + 0.04) * uReflStrength * 0.6, 0.0, 0.22);
    col = mix(water * 0.82, skyRefl, reflF);
    // a faint, narrow sun glint only — the flat sheet would otherwise glint edge-to-edge at once.
    vec3 H = normalize(normalize(uSunDir) + V);
    float ndh = max(dot(N, H), 0.0);
    col += uSunColor * pow(ndh, 60.0) * 0.05;
  } else {
    // SKIRT WALL: the dim UNDERSIDE of the body of water — almost no sky reflection (a wall under the
    // surface barely catches the sky), darkening toward the floor. Reads as water depth, not a glass
    // panel. vEdge: 0 at the surface rim → 1 at the bottom.
    vec3 wallTop = uDeepColor;            // just under the surface: the deep body tone
    vec3 wallBot = uDeepColor * 0.45;     // toward the floor: darker still
    col = mix(wallTop, wallBot, clamp(vEdge, 0.0, 1.0));
    // a whisper of sky sheen at the very top of the wall so it ties into the surface, fading out fast
    float sheen = (1.0 - clamp(vEdge, 0.0, 1.0)) * 0.08 * uReflStrength;
    col = mix(col, min(uSkyColor, vec3(uReflClamp)), sheen);
  }

  // a faint foam line where the surface sheet meets the hull wall (the rim of the top sheet)
  float topRim = vIsTop * clamp(vEdge, 0.0, 1.0);
  float foam = topRim * (0.4 + 0.4 * sin(uTime * 2.2 + vWorldPos.x * 1.4 + vWorldPos.z * 1.1));
  col = mix(col, vec3(0.7, 0.8, 0.84), clamp(foam, 0.0, 1.0) * 0.3);

  // opacity: the top sheet is mostly opaque; the skirt is a touch lighter AND faded by uExposure so it
  // VANISHES when the interior level reaches the sea level (no exposed wall at a big breach).
  float alpha = (vIsTop > 0.5) ? uTopOpacity : (uSkirtOpacity * uExposure);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
}
`;

interface CF {
  curve: FillCurve;
  /** footprint rectangle (local meters), slightly inset to stay inside the hull. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cx: number; // footprint centre, local x — where the surface height is sampled
  cz: number;
  floorLocalY: number; // local-Y of the compartment floor (m) — caps the skirt depth
  top: THREE.Mesh; // one continuous surface sheet
  skirt: THREE.Mesh; // four vertical walls hanging from the rim
  mat: THREE.ShaderMaterial;
  uExposure: { value: number };
  uTopOpacity: { value: number };
  uSkirtOpacity: { value: number };
  uShimmer: { value: number };
  lastFill: number;
  frames: number;
}

export class CompartmentFluid {
  readonly group = new THREE.Group();
  private comps = new Map<number, CF>();
  private nx: number;
  private ny: number;
  private look: OceanLook | null = null;

  // scratch — reused, no per-frame allocation
  private pos = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private qInv = new THREE.Quaternion();
  private scl = new THREE.Vector3();
  private v = new THREE.Vector3();
  private scratchSurf = new THREE.Vector3();
  private scratchSkirt = new THREE.Vector3();

  constructor(compartments: Compartment[], dims: [number, number, number]) {
    this.nx = dims[0];
    this.ny = dims[1];
    for (const c of compartments) this.add(c);
  }

  /** Build (or rebuild) the shared ShaderMaterial uniforms from the live ocean look (lazy: the ocean
   *  may be created after the first ship). Returns the bound uniform set or the fallback. */
  private oceanUniforms() {
    const look = (this.look ??= getOceanLook());
    if (look) {
      return {
        uShallowColor: look.uShallowColor,
        uDeepColor: look.uDeepColor,
        uSunColor: look.uSunColor,
        uSkyColor: look.uSkyColor,
        uSkyEnv: look.uSkyEnv,
        uHasEnv: look.uHasEnv,
        uReflStrength: look.uReflStrength,
        uReflClamp: look.uReflClamp,
        uSunDir: look.uSunDir,
        uTime: look.uTime,
      };
    }
    return {
      uShallowColor: { value: FALLBACK_SHALLOW.clone() },
      uDeepColor: { value: FALLBACK_DEEP.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.78, 0.55) },
      uSkyColor: { value: new THREE.Color(0x9fc4d4) },
      uSkyEnv: { value: new THREE.CubeTexture() },
      uHasEnv: { value: 0 },
      uReflStrength: { value: 0.22 },
      uReflClamp: { value: 1.6 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.4).normalize() },
      uTime: { value: 0 },
    };
  }

  private add(c: Compartment): void {
    const curve = buildFillCurve(c, this.nx, this.ny);

    // footprint rectangle in local meters, inset a touch so the sheet never pokes outside the hull at
    // a curved end (the opaque hull mesh would occlude an overhang anyway, but the inset is cleaner).
    const inset = VOXEL_SIZE * 0.25;
    const minX = (c.bboxMin[0]) * VOXEL_SIZE + inset;
    const maxX = (c.bboxMax[0] + 1) * VOXEL_SIZE - inset;
    const minZ = (c.bboxMin[2]) * VOXEL_SIZE + inset;
    const maxZ = (c.bboxMax[2] + 1) * VOXEL_SIZE - inset;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const floorLocalY = c.bboxMin[1] * VOXEL_SIZE; // bottom of the lowest cell layer

    const oc = this.oceanUniforms();
    const uExposure = { value: 1 };
    const uTopOpacity = { value: TUN.flood.render.topOpacity };
    const uSkirtOpacity = { value: TUN.flood.render.skirtOpacity };
    const uShimmer = { value: TUN.flood.render.shimmer };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false, // sits inside the hull; the opaque hull occludes it via depthTest
      side: THREE.DoubleSide,
      uniforms: {
        ...oc,
        uCameraPos: { value: new THREE.Vector3() },
        uTopOpacity,
        uSkirtOpacity,
        uShimmer,
        uExposure,
      },
    });

    // TOP sheet: a unit XZ quad ([-0.5,0.5] in x/z, y=0). Per frame we scale it to the footprint, set
    // its position to the world pool surface and counter-rotate to world-up. aTop=1, aEdge=0 (centre)
    // → the four corners carry aEdge=1 so the rim foams. Use a small subdivided plane so the rim
    // attribute interpolates a thin foam band rather than the whole sheet.
    const topGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
    topGeo.rotateX(-Math.PI / 2); // lie flat in XZ (normal +Y)
    {
      const n = topGeo.attributes.position.count;
      const aTop = new Float32Array(n).fill(1);
      // foam only in a thin band at the very edge: with a 1×1 plane all 4 verts are corners, so a flat
      // small edge value reads as a faint uniform rim — acceptable and cheap. Set a low edge so the
      // foam line is subtle.
      const aEdge = new Float32Array(n).fill(0.35);
      topGeo.setAttribute("aTop", new THREE.BufferAttribute(aTop, 1));
      topGeo.setAttribute("aEdge", new THREE.BufferAttribute(aEdge, 1));
    }
    const top = new THREE.Mesh(topGeo, mat);
    top.frustumCulled = false;
    top.renderOrder = 4;
    this.group.add(top);

    // SKIRT: four vertical walls forming an open box rim. Built as a unit box's SIDE quads in local
    // space [-0.5,0.5] in x/z and [0,1] in y (y=1 at the surface rim, y=0 at the bottom). Per frame we
    // scale x/z to the footprint and y to the skirt depth, and counter-rotate so it hangs gravity-down
    // from the surface. aEdge encodes depth (0 at the rim → 1 at the bottom) to darken downward; aTop=0.
    const skirtGeo = this.makeSkirtGeometry();
    const skirt = new THREE.Mesh(skirtGeo, mat);
    skirt.frustumCulled = false;
    skirt.renderOrder = 4;
    this.group.add(skirt);

    this.comps.set(c.id, {
      curve, minX, maxX, minZ, maxZ, cx, cz, floorLocalY,
      top, skirt, mat, uExposure, uTopOpacity, uSkirtOpacity, uShimmer,
      lastFill: -1, frames: 99,
    });
  }

  /** Four vertical wall quads (an open box, no top/bottom). Local: x,z ∈ [-0.5,0.5], y ∈ [0,1]
   *  (y=1 the surface rim, y=0 the bottom). aEdge = 1 - y (0 at rim → 1 at bottom) for depth-darkening;
   *  aTop = 0 (these are walls). */
  private makeSkirtGeometry(): THREE.BufferGeometry {
    const half = 0.5;
    // 8 corners: bottom (y=0) then top (y=1)
    const c = [
      [-half, 0, -half], [half, 0, -half], [half, 0, half], [-half, 0, half], // bottom 0..3
      [-half, 1, -half], [half, 1, -half], [half, 1, half], [-half, 1, half], // top 4..7
    ];
    const quads = [
      [0, 1, 5, 4], // -z wall
      [1, 2, 6, 5], // +x wall
      [2, 3, 7, 6], // +z wall
      [3, 0, 4, 7], // -x wall
    ];
    const pos: number[] = [];
    const edge: number[] = [];
    const topA: number[] = [];
    const idx: number[] = [];
    let base = 0;
    for (const [a, b, d, e] of quads) {
      for (const ci of [a, b, d, e]) {
        pos.push(c[ci][0], c[ci][1], c[ci][2]);
        edge.push(1 - c[ci][1]); // y=0 bottom → 1, y=1 rim → 0
        topA.push(0);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("aEdge", new THREE.BufferAttribute(new Float32Array(edge), 1));
    g.setAttribute("aTop", new THREE.BufferAttribute(new Float32Array(topA), 1));
    g.setIndex(idx);
    return g;
  }

  /** Reflect current flooding. Called once per frame AFTER the ship group transform is synced. */
  update(compartments: Compartment[], cameraPos: THREE.Vector3 | undefined, dt: number): void {
    void dt;
    // (re)bind the ocean look the first time it becomes available after this ship was built
    if (!this.look) this.look = getOceanLook();
    this.group.updateWorldMatrix(true, false);
    this.group.matrixWorld.decompose(this.pos, this.q, this.scl);
    this.qInv.copy(this.q).invert();

    for (const c of compartments) {
      const cf = this.comps.get(c.id);
      if (!cf) continue;

      // keep the shared shimmer/opacity uniforms live with the dev panel
      cf.uShimmer.value = TUN.flood.render.shimmer;
      cf.uTopOpacity.value = TUN.flood.render.topOpacity;
      cf.uSkirtOpacity.value = TUN.flood.render.skirtOpacity;
      if (cameraPos) (cf.mat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);

      const fill = c.volume > 0 ? c.waterVolume / c.volume : 0;
      if (fill < 0.005) {
        cf.top.visible = false;
        cf.skirt.visible = false;
        cf.lastFill = 0;
        continue;
      }
      // pose changes every frame (heel/pitch/heave), so update the transforms each frame; it's two
      // mesh transforms per compartment — cheap. The fill curve itself never changes.
      this.place(cf, c.waterVolume);
      cf.lastFill = fill;
    }
  }

  /** Position the continuous top sheet + the side skirt for the current flood level. The surface is
   *  drawn WORLD-horizontal (counter-rotated by the inverse ship pose) at the gravity-level pool
   *  height; the skirt hangs straight down from it. The skirt's height + opacity fade out as the
   *  interior level approaches the local sea level (big-hole equalisation → no exposed wall). */
  private place(cf: CF, waterVolume: number): void {
    const q = this.q, qInv = this.qInv, pos = this.pos;
    const localFillY = fillHeightLocal(cf.curve, waterVolume);

    // world position of the free surface at the footprint centre (ship-local fill height → world).
    this.v.set(cf.cx, localFillY, cf.cz).applyQuaternion(q).add(pos);
    const surfWorld = this.scratchSurf.copy(this.v);
    const poolWorldY = surfWorld.y;

    const width = cf.maxX - cf.minX;
    const depthXZ = cf.maxZ - cf.minZ;

    // The top/skirt are CHILDREN of this.group (which carries the ship pose). We want them drawn at a
    // fixed WORLD position + WORLD-up orientation, so we convert the desired world transform into the
    // group's LOCAL frame: localPos = qInv·(worldPos − pos); localQuat = qInv (cancels the ship pose →
    // world-up). (Setting a child's .position to a world coord would double-apply the parent matrix —
    // the bug the old per-column code avoided by this same conversion.)

    // --- TOP sheet: world-horizontal plane at the pool surface, sized to the footprint ---
    cf.top.visible = true;
    this.worldToLocal(surfWorld, cf.top.position);
    cf.top.quaternion.copy(qInv);
    cf.top.scale.set(width, 1, depthXZ);

    // --- SKIRT: how deep is the body, and how exposed is the wall? ---
    const fillDepthLocal = Math.max(0, localFillY - cf.floorLocalY);
    const skirtDepth = Math.min(TUN.flood.render.skirtDepth, fillDepthLocal);

    // EXPOSURE: fade the skirt out as the interior pool level reaches the LOCAL SEA level. When inside
    // ≈ outside (large hole equalised) the wall would be a jarring step → hide it; when the interior is
    // well below the sea (small hole) show the full wall. Below the sea by ≥ blendBand → fully shown.
    let exposure = 1;
    if (this.look) {
      const seaY = this.look.seaHeight(surfWorld.x, surfWorld.z);
      const below = seaY - poolWorldY; // how far the interior sits below the sea (m)
      const band = Math.max(0.05, TUN.flood.render.blendBand);
      exposure = Math.min(1, Math.max(0, below / band));
    }
    cf.uExposure.value = exposure;

    if (skirtDepth <= 1e-3 || exposure <= 0.01) {
      cf.skirt.visible = false;
      return;
    }
    cf.skirt.visible = true;
    // skirt geometry spans y∈[0,1] (1 = surface rim). We want the rim at the surface and the bottom at
    // (surface − skirtDepth) in WORLD. So place the mesh ORIGIN at world (surface − skirtDepth) and
    // scale Y by skirtDepth: local y=1 → origin + skirtDepth = surface; y=0 → origin = surface − depth.
    this.scratchSkirt.copy(surfWorld);
    this.scratchSkirt.y -= skirtDepth;
    this.worldToLocal(this.scratchSkirt, cf.skirt.position);
    cf.skirt.quaternion.copy(qInv);
    cf.skirt.scale.set(width, skirtDepth, depthXZ);
  }

  /** Convert a WORLD point to this.group's LOCAL frame: local = qInv·(world − pos). (The group has unit
   *  scale; if it ever didn't, scl would divide here.) Writes into `out` and returns it. */
  private worldToLocal(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.copy(world).sub(this.pos).applyQuaternion(this.qInv);
    return out;
  }

  dispose(): void {
    for (const cf of this.comps.values()) {
      cf.top.geometry.dispose();
      cf.skirt.geometry.dispose();
      cf.mat.dispose();
    }
    this.comps.clear();
  }
}
