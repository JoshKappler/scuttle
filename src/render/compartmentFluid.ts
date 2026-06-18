import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { TUN } from "../core/tunables";
import { buildFillCurve, fillHeightLocal, type Compartment, type FillCurve } from "../sim/compartments";
import { getOceanLook, type OceanLook } from "./ocean";

/**
 * Flooded-compartment water — a SOLID body of water that fills the TRUE interior room shape of the
 * hull (tapered bow, curved sides, L-shaped holds), from the compartment floor up to the live flood
 * level.
 *
 * 5th-attempt rework — the REAL root-cause fix.
 *
 *   WHY THE PRIOR FOUR ATTEMPTS FAILED (the "messy rectangles" the user kept reporting):
 *   every previous version (commits f944aae, ed33c86, f8a912e, e6ded56) built the water as ONE
 *   axis-aligned RECTANGULAR box, scaled to the compartment's BOUNDING-BOX footprint
 *   (maxX−minX × maxZ−minZ), then RELIED on the opaque hull mesh's depth buffer to clip that
 *   rectangle down to the real hull shape. A compartment is NOT a rectangle — the bow narrows, the
 *   sides curve — so the box corners stick OUT past the hull. The hull is a thin, double-sided shell,
 *   so its depth-occlusion clip is unreliable (z-fighting / grazing sightlines / the cutaway opening),
 *   and the box's overhang shows through as ugly rectangles poking outside the hull. Every prior "fix"
 *   only re-skinned the SHADER (colours, skirt, walls, reflections) — none changed the GEOMETRY away
 *   from a bounding rectangle, so the shape bug never changed.
 *
 *   THE FIX (shape-accurate by construction, not by occlusion luck):
 *   we have the EXACT voxel shape in `Compartment.cells` (packed cell indices x + nx·(y + ny·z)). We
 *   build the water body's geometry FROM those cells — one small box per occupied (x,z) grid column,
 *   spanning that column's floor→top — and MERGE them into one static BufferGeometry. The mesh
 *   footprint is therefore the real (tapered/curved/L-shaped) compartment outline. NOTHING is drawn
 *   outside the occupied columns, so no rectangle can poke out of the hull regardless of how the hull
 *   shell occludes. The geometry is built ONCE (cells never change after build).
 *
 *   The live flood SURFACE is a fragment-shader cut: each frame we pass the current ship-local fill
 *   height as a uniform and DISCARD fragments above it, so the body fills the room only up to the live
 *   water level and the solid water sits below. No per-frame geometry rebuild, no per-cell sort.
 *
 * The body is parented under the ship group, so it heels/pitches/heaves WITH the hull — correct,
 * because the room is part of the hull, and the sim models the fill as a ship-LOCAL-horizontal layer
 * fill (see buildFillCurve / fillHeightLocal), so a constant ship-local cut plane is exactly the layer
 * the sim filled to. The surface reads as the room's waterline.
 *
 * The LOOK is shared LIVE from render/ocean.ts (getOceanLook): the same body-colour gradient, the same
 * sky+cloud reflection cube (Fresnel-weighted, clamped), the same sun colour/direction and the same
 * clock — so the inside water matches the sea's colour/shimmer and follows any dev-panel ocean tuning.
 *
 * The fill LEVEL comes from the STATIC cumulative volume↔height curve the sim uses (buildFillCurve /
 * fillHeightLocal) — O(log layers), built once. Render-only: this does THREE work but never feeds sim/
 * (determinism — THE LAW #1).
 */

// Fallback navy tones if the ocean look isn't bound yet (it always is by the time water shows).
const FALLBACK_SHALLOW = new THREE.Color(0x0c2a45);
const FALLBACK_DEEP = new THREE.Color(0x0a1a2e);

// How dark the body goes from just-under-the-surface (1.0×) down to the floor. A solid body of water
// dims with depth; the floor is the darkest. Module-local render constant — REPORT to the lead for
// promotion to TUN.flood.render if a dev-panel knob is wanted.
const WALL_FLOOR_DARKEN = 0.4;

// A fragment within this many metres of the live surface is treated as the TOP face (the sea-look
// surface sheet); below it the fragment is solid body wall/floor. Roughly one voxel.
const SURFACE_BAND = VOXEL_SIZE;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uShimmer;
uniform float uFillLocalY;   // live flood surface, ship-LOCAL Y (m); fragments above are discarded
uniform float uFloorLocalY;  // compartment floor, ship-LOCAL Y (m) — for depth darkening
varying vec3 vWorldPos;
varying float vLocalY;       // ship-local Y of this fragment (m)
// THREE clipping support (the cutaway "X" plane slices the flood body flush with the hull cut).
// This is a fully custom ShaderMaterial, so the clip is NOT automatic: the material must have
// clipping:true (injects NUM_CLIPPING_PLANES + the clippingPlanes uniform) AND these includes.
#include <clipping_planes_pars_vertex>
void main() {
  vec3 p = position;          // already ship-local meters (geometry built in local space)
  vLocalY = p.y;
  // gentle Gerstner-ish shimmer applied near the live surface only, so the pool top has life without
  // the body below it wobbling. Applied in LOCAL space (the body rides the hull pose).
  if (uShimmer > 0.0 && abs(p.y - uFillLocalY) < ${SURFACE_BAND.toFixed(3)}) {
    float s = sin(uTime * 1.3 + p.x * 0.9 + p.z * 0.7)
            + 0.6 * sin(uTime * 0.8 - p.x * 0.5 + p.z * 1.1);
    p.y += uShimmer * s;
  }
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  // <clipping_planes_vertex> reads a view-space vec4 named mvPosition — provide it explicitly.
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
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
uniform float uBodyOpacity;     // body (below the surface) opacity — the solid volume
uniform float uWallFloorDarken; // body tone at the floor (×uDeepColor)
uniform float uFillLocalY;      // live flood surface, ship-LOCAL Y (m)
uniform float uFloorLocalY;     // compartment floor, ship-local Y (m)
varying vec3 vWorldPos;
varying float vLocalY;
// THREE clipping support — pairs with the vertex include (see VERT). Needs clipping:true on the mat.
#include <clipping_planes_pars_fragment>

void main() {
  // Honour the cutaway clip FIRST: discard fragments on the cut-away side so the flood body is sliced
  // flush with the hull cut instead of the whole half's water floating in the opened interior.
  #include <clipping_planes_fragment>
  // CUT TO THE LIVE WATER LEVEL: the body geometry spans floor→column-top, but the pool only fills up
  // to the current flood height. Discard everything above the surface so the water surface sits at the
  // live level and the room above it reads as empty (timber / void) — the real waterline in the room.
  if (vLocalY > uFillLocalY + ${SURFACE_BAND.toFixed(3)}) discard;

  // depth fraction: 0 at the surface → 1 at the floor (darken the body downward)
  float span = max(uFillLocalY - uFloorLocalY, 1e-3);
  float depthF = clamp((uFillLocalY - vLocalY) / span, 0.0, 1.0);
  // is this fragment AT the surface (the thin top band)? → render the sea-look surface sheet.
  bool isTop = vLocalY > uFillLocalY - ${SURFACE_BAND.toFixed(3)};

  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 N;
  if (isTop) {
    // calm pool surface: a mostly-up normal with a slow ripple so the sky reflection + body gradient
    // read like the open sea's, distorted just a little.
    float nx = 0.12 * sin(uTime * 1.1 + vWorldPos.x * 0.8 + vWorldPos.z * 0.6);
    float nz = 0.12 * sin(uTime * 0.9 - vWorldPos.x * 0.5 + vWorldPos.z * 0.9);
    N = normalize(vec3(nx, 1.0, nz));
  } else {
    // body: face outward toward the viewer (a horizontal-ish normal) so it picks up the deep body
    // colour, not the sky — that's what reads as the dim solid body of water filling the room.
    vec3 horiz = vec3(V.x, 0.0, V.z);
    N = normalize(vec3(0.0, 0.2, 0.0) + (length(horiz) > 1e-3 ? normalize(horiz) : vec3(0.0, 0.0, 1.0)));
  }

  float facing = max(dot(N, V), 0.0);
  vec3 water = mix(uShallowColor, uDeepColor, facing);

  vec3 col;
  float alpha;
  if (isTop) {
    // TOP surface: the SAME sea body colour + a clone of the sea's Fresnel sky-env reflection, held
    // well down (a flat enclosed pool in a shadowed hold would otherwise read as a bright mirror).
    float fresnel = pow(1.0 - facing, 5.0);
    vec3 Rr = reflect(-V, N);
    Rr.y = max(Rr.y, 0.02);
    vec3 skyRefl = (uHasEnv > 0.5) ? textureCube(uSkyEnv, Rr).rgb : uSkyColor;
    skyRefl = min(skyRefl, vec3(uReflClamp));
    float reflF = clamp((min(fresnel, 0.35) * 0.6 + 0.04) * uReflStrength * 0.6, 0.0, 0.22);
    col = mix(water * 0.82, skyRefl, reflF);
    vec3 H = normalize(normalize(uSunDir) + V);
    float ndh = max(dot(N, H), 0.0);
    col += uSunColor * pow(ndh, 60.0) * 0.05;
    // a faint foam line right at the waterline
    float foam = 0.4 + 0.4 * sin(uTime * 2.2 + vWorldPos.x * 1.4 + vWorldPos.z * 1.1);
    col = mix(col, vec3(0.7, 0.8, 0.84), clamp(foam, 0.0, 1.0) * 0.18);
    alpha = uTopOpacity;
  } else {
    // BODY: the dim solid interior of the volume, darkening from just-under-the-surface down to the
    // floor. Reads as filled water, not a glass panel.
    vec3 bodyTop = uDeepColor;
    vec3 bodyBot = uDeepColor * uWallFloorDarken;
    col = mix(bodyTop, bodyBot, depthF);
    float sheen = (1.0 - depthF) * 0.08 * uReflStrength;
    col = mix(col, min(uSkyColor, vec3(uReflClamp)), sheen);
    alpha = uBodyOpacity;
  }

  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
}
`;

interface CF {
  curve: FillCurve;
  floorLocalY: number; // local-Y of the compartment floor (m)
  mesh: THREE.Mesh; // ONE merged body following the true cell footprint
  mat: THREE.ShaderMaterial;
  uTopOpacity: { value: number };
  uBodyOpacity: { value: number };
  uShimmer: { value: number };
  uFillLocalY: { value: number };
  uFloorLocalY: { value: number };
}

export class CompartmentFluid {
  readonly group = new THREE.Group();
  private comps = new Map<number, CF>();
  private nx: number;
  private ny: number;
  private look: OceanLook | null = null;
  /** The active cutaway clip plane (null = off), stored so compartments ADDED later inherit it and
   *  so a (re)created fluid (hull swap) can be re-seeded. This is the SAME shared Plane reference
   *  main.ts mutates in place each frame — store the reference, never a copy. */
  private clipPlane: THREE.Plane | null = null;

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

  /**
   * Build ONE merged BufferGeometry for the water body straight from the compartment's cell set, in
   * ship-LOCAL meters. We emit only the OUTWARD-facing skin: for each interior-air cell, a face is
   * emitted on a side only where the neighbouring voxel is NOT part of this compartment. The result is
   * a clean closed shell whose silhouette EXACTLY follows the true (tapered/curved/L-shaped) cell shape
   * — no geometry exists outside a real cell, so nothing can poke out of the hull (the prior bounding-
   * rectangle bug). Built once — cells never change after build. The fill level is applied later as a
   * fragment-shader cut, not by reshaping this geometry.
   */
  private buildBodyGeometry(c: Compartment): THREE.BufferGeometry {
    const nx = this.nx;
    const ny = this.ny;
    const has = (x: number, y: number, z: number): boolean =>
      x >= 0 && z >= 0 && y >= 0 && x < nx && c.cells.has(x + nx * (y + ny * z));
    const s = VOXEL_SIZE;
    const pos: number[] = [];
    const idx: number[] = [];
    let base = 0;
    const quad = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
      dx: number, dy: number, dz: number,
    ) => {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    };
    for (const p of c.cells) {
      const x = p % nx;
      const y = Math.floor(p / nx) % ny;
      const z = Math.floor(p / (nx * ny));
      const x0 = x * s, x1 = (x + 1) * s;
      const y0 = y * s, y1 = (y + 1) * s;
      const z0 = z * s, z1 = (z + 1) * s;
      // Emit a face only where the neighbour is OUTSIDE the compartment → the outer skin only.
      if (!has(x - 1, y, z)) quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0); // -x
      if (!has(x + 1, y, z)) quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1); // +x
      if (!has(x, y - 1, z)) quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1); // -y (floor)
      if (!has(x, y + 1, z)) quad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0); // +y (ceiling)
      if (!has(x, y, z - 1)) quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0); // -z
      if (!has(x, y, z + 1)) quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1); // +z
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    return g;
  }

  private add(c: Compartment): void {
    const curve = buildFillCurve(c, this.nx, this.ny);
    const floorLocalY = c.bboxMin[1] * VOXEL_SIZE; // bottom of the lowest cell layer

    const oc = this.oceanUniforms();
    const uTopOpacity = { value: TUN.flood.render.topOpacity };
    const uBodyOpacity = { value: TUN.flood.render.skirtOpacity };
    const uShimmer = { value: TUN.flood.render.shimmer };
    const uFillLocalY = { value: floorLocalY };
    const uFloorLocalY = { value: floorLocalY };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      // SOLID BODY (BUG-2): WRITE DEPTH. The body USED to lean on the opaque hull's depth buffer to
      // hide its own overlapping faces (depthWrite:false); but where the cutaway clips the near hull
      // away, that occlusion is gone exactly where you look in, so the double-sided front/back faces
      // + the top "surface" band z-fought (coincident depth, order-dependent alpha blend) → flicker +
      // a thin "no body" sheet. With depthWrite the NEAREST face wins and occludes the ones behind it,
      // so the body reads as a SOLID filled volume in the open cut — independent of uCameraPos (which
      // the world seam never feeds, so a FrontSide-only cull would risk holes: the cells emit an
      // OUTWARD skin, so the kept-half walls present their BACK faces to a camera looking into the
      // cut; DoubleSide keeps those visible while depthWrite removes the flicker).
      depthWrite: true,
      side: THREE.DoubleSide,
      // make the fully-custom shader HONOUR the cutaway clip plane: injects NUM_CLIPPING_PLANES +
      // the clippingPlanes uniform array that the clipping_planes_* includes consume. Without this,
      // assigning mat.clippingPlanes silently no-ops on a raw ShaderMaterial.
      clipping: true,
      uniforms: {
        ...oc,
        uCameraPos: { value: new THREE.Vector3() },
        uTopOpacity,
        uBodyOpacity,
        uShimmer,
        uWallFloorDarken: { value: WALL_FLOOR_DARKEN },
        uFillLocalY,
        uFloorLocalY,
      },
    });

    // inherit the active cutaway clip so a compartment created AFTER setClipPlane() (or after a hull
    // swap that re-seeds it in the constructor) is sliced flush with the hull cut from birth.
    if (this.clipPlane) {
      mat.clippingPlanes = [this.clipPlane];
      mat.needsUpdate = true;
    }

    // ONE merged body following the TRUE cell footprint, in ship-local meters. Parented under the ship
    // group, so it heels/pitches/heaves WITH the hull (the room is part of the hull). No per-frame
    // scaling/repositioning — only the fill-level uniform changes.
    const geo = this.buildBodyGeometry(c);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    this.group.add(mesh);

    this.comps.set(c.id, {
      curve, floorLocalY, mesh, mat,
      uTopOpacity, uBodyOpacity, uShimmer, uFillLocalY, uFloorLocalY,
    });
  }

  /** Reflect current flooding. Called once per frame AFTER the ship group transform is synced. */
  update(compartments: Compartment[], cameraPos: THREE.Vector3 | undefined, dt: number): void {
    void dt;
    // (re)bind the ocean look the first time it becomes available after this ship was built
    if (!this.look) this.look = getOceanLook();

    // The body geometry is ship-local and parented under the ship group, so its modelMatrix already
    // carries the live hull pose — nothing to transform per frame except the fill-level uniform. The
    // shader's view math runs in WORLD space (vWorldPos), so uCameraPos is the WORLD camera, passed
    // straight through below.
    this.group.updateWorldMatrix(true, false);

    for (const c of compartments) {
      const cf = this.comps.get(c.id);
      if (!cf) continue;

      // keep the shared shimmer/opacity uniforms live with the dev panel
      cf.uShimmer.value = TUN.flood.render.shimmer;
      cf.uTopOpacity.value = TUN.flood.render.topOpacity;
      cf.uBodyOpacity.value = TUN.flood.render.skirtOpacity;
      if (cameraPos) (cf.mat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);

      const fill = c.volume > 0 ? c.waterVolume / c.volume : 0;
      if (fill < 0.005) {
        cf.mesh.visible = false;
        continue;
      }
      // Per-frame work is just the fill-level uniform — the geometry is static and already the right
      // shape. The shader discards everything above this level, so the body fills the room only up to
      // the live waterline.
      cf.mesh.visible = true;
      cf.uFillLocalY.value = fillHeightLocal(cf.curve, c.waterVolume);
      cf.uFloorLocalY.value = cf.floorLocalY;
    }
  }

  /** Cutaway: clip the flood body against the same world-space plane as the hull (null disables), so
   *  the interior water is sliced flush with the centerline half-cut instead of the whole cut-away
   *  half's water floating in the opened hull. Pass the SHARED plane reference main.ts mutates in
   *  place each frame (stored, not copied), so every frame's live pose is honoured. Applies to every
   *  existing compartment material AND is remembered so compartments added later inherit it. The
   *  shader only honours this because the material is built with clipping:true + the clipping
   *  includes — a bare clippingPlanes assignment on a custom ShaderMaterial is a silent no-op. */
  setClipPlane(plane: THREE.Plane | null): void {
    this.clipPlane = plane;
    const planes = plane ? [plane] : null;
    for (const cf of this.comps.values()) {
      cf.mat.clippingPlanes = planes;
      cf.mat.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const cf of this.comps.values()) {
      cf.mesh.geometry.dispose();
      cf.mat.dispose();
    }
    this.comps.clear();
  }
}
