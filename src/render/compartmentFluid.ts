import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { TUN } from "../core/tunables";
import { buildFillCurve, fillHeightLocal, type Compartment, type FillCurve } from "../sim/compartments";
import { getOceanLook, type OceanLook } from "./ocean";

/**
 * Flooded-compartment water — a SOLID body of dark water filling the TRUE interior room shape of the
 * hull (tapered bow, curved sides, L-shaped holds), from the compartment floor up to the live flood
 * level. It reads as a filled slab floor→waterline, never a thin top "sheet of silk".
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY ~10 PRIOR ATTEMPTS FAILED, AND HOW THIS REWRITE KILLS EACH SYMPTOM
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * Every prior version built ONE merged HOLLOW boundary-SKIN mesh per compartment (only the faces on
 * the compartment boundary), rendered TRANSLUCENT (`transparent:true`) + DoubleSide + depthWrite,
 * and faked a "top surface vs body" from that single skin via an `isTop` fragment branch, applying
 * the water LEVEL as a per-fragment `discard` above the fill height. That exact combination produced
 * every reported symptom:
 *   (1) flickering TV-static  ← translucent + depthWrite on a self-overlapping double-sided skin:
 *       blended faces fight for the same depth, order-dependent → static.
 *   (2) dark-top / light-bottom z-fight ("meshing and messing")  ← the isTop branch shading coincident
 *       geometry right at the waterline gave two coplanar translucent surfaces fighting.
 *   (3) blocks randomly not rendering  ← a hollow translucent shell racing the depth buffer drops
 *       faces depending on draw order.
 *   (4) "thin sheet of blue silk", not a filled volume  ← a hollow skin has no interior; you see the
 *       lid and nothing behind it.
 *   (5) under the X cutaway the water is NOT cut / shows transparent nothing  ← a hollow skin opened by
 *       the clip plane reveals the empty inside; there is no cross-section to show.
 *
 * THE FIX — a SOLID OPAQUE volume, level cut in the VERTEX shader:
 *   • GEOMETRY (buildBodyGeometry): for each occupied (x,z) COLUMN of the compartment, emit ONE full
 *     CLOSED box from the column's floor to its ceiling. The union of columns follows the real
 *     (tapered / curved / L-shaped) footprint exactly and is gap-free; interior shared faces are fine
 *     (they're occluded). A per-vertex `aTop` attribute marks each column's TOP-cap vertices (1.0) so
 *     the shader can give ONLY the lid a surface/sky term. → kills (4): a real solid body.
 *   • LEVEL CUT in the VERTEX shader: clamp every vertex `y = min(y, uFillLocalY)`. The top caps
 *     collapse onto a single flat lid exactly at the live water line (ONE real top surface — no
 *     coincident pair), side walls below stay solid, geometry above the line is degenerate (zero
 *     area). → kills (2): no two coplanar surfaces at the waterline; the old fragment `discard` and
 *     `isTop` two-path coincident shading are GONE.
 *   • MATERIAL: OPAQUE — `transparent:false`, `depthWrite:true`, `depthTest:true`, DoubleSide. Opaque
 *     DoubleSide does NOT z-fight (depthWrite resolves the nearest fragment unambiguously with no
 *     blending). → kills (1) and (3): no alpha sort, no blend race, nearest wins.
 *   • DoubleSide is the key to the cutaway: when the clip plane slices the near wall of a box away, the
 *     box's FAR inner wall shows as dark water, so the cross-section reads as a FILLED slab — no
 *     stencil/cap pass needed. → kills (5): the cut now shows solid dark water.
 *
 * The hull mesh is OPAQUE and occludes the water box, so the water is only ever visible through real
 * shot holes + the cutaway cross-section — exactly right (no water bleeds through intact planking).
 *
 * Clipping is wired the same as before and KEPT: the material is `clipping:true`, the shaders carry the
 * THREE `clipping_planes_*` GLSL includes, and `clippingPlanes` is fed the SHARED world-space plane
 * main.ts mutates in place each frame (via setClipPlane), so the cut tracks the live hull pose.
 *
 * The body is parented under the ship group, so it heels/pitches/heaves WITH the hull — correct,
 * because the room is part of the hull and the sim fills a ship-LOCAL-horizontal layer (buildFillCurve
 * / fillHeightLocal), so a constant ship-local clamp plane is exactly the layer the sim filled to.
 *
 * The LOOK (navy body colour, sun/sky colours, the shared clock) is read LIVE from render/ocean.ts
 * (getOceanLook, READ-ONLY) so the inside water matches the sea and follows dev-panel ocean tuning.
 *
 * Render-only: this does THREE work but never feeds sim/ (determinism — THE LAW #1). Geometry is built
 * ONCE per compartment (cells never change after build); `update` only writes the fill-level / camera /
 * opacity uniforms and toggles mesh.visible — no per-frame allocations.
 */

// Fallback navy tones if the ocean look isn't bound yet (it always is by the time water shows).
const FALLBACK_SHALLOW = new THREE.Color(0x0c2a45);
const FALLBACK_DEEP = new THREE.Color(0x0a1a2e);

// How dark the body goes from just-under-the-surface (1.0×) down to the floor. A solid body of water
// dims with depth; the floor is the darkest. Module-local render constant — REPORT to the lead for
// promotion to TUN.flood.render if a dev-panel knob is wanted.
const WALL_FLOOR_DARKEN = 0.4;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uShimmer;
uniform float uFillLocalY;   // live flood surface, ship-LOCAL Y (m); vertices are CLAMPED to it
uniform float uFloorLocalY;  // compartment floor, ship-LOCAL Y (m) — for depth darkening
attribute float aTop;        // 1.0 on a column's top-cap vertices, 0.0 on side/floor — lid marker
varying vec3 vWorldPos;
varying float vLocalY;        // ship-local Y of this fragment (m), AFTER the level clamp
varying float vTop;          // interpolated lid marker (≈1 on the surface lid)
// THREE clipping support (the cutaway "X" plane slices the flood body flush with the hull cut).
// This is a fully custom ShaderMaterial, so the clip is NOT automatic: the material must have
// clipping:true (injects NUM_CLIPPING_PLANES + the clippingPlanes uniform) AND these includes.
#include <clipping_planes_pars_vertex>
void main() {
  vec3 p = position;          // already ship-local meters (geometry built in local space)
  // LEVEL CUT in the vertex stage: clamp every vertex to the live water line. The column top caps
  // collapse onto a single flat lid exactly at uFillLocalY (ONE real top surface — no z-fight), the
  // side walls below stay solid, and anything that was above the line becomes degenerate (zero area,
  // nothing to draw). Replaces the old per-fragment discard-above-level (which left a hollow look).
  p.y = min(p.y, uFillLocalY);
  // gentle shimmer on the surface LID only, so the pool top has a little life without the solid body
  // below it wobbling. Applied in LOCAL space (the body rides the hull pose).
  if (uShimmer > 0.0 && aTop > 0.5) {
    float s = sin(uTime * 1.3 + p.x * 0.9 + p.z * 0.7)
            + 0.6 * sin(uTime * 0.8 - p.x * 0.5 + p.z * 1.1);
    p.y += uShimmer * s;
  }
  vLocalY = p.y;
  vTop = aTop;
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
uniform float uBodyOpacity;     // body opacity (kept for the dev knob; material is opaque so 1.0 reads)
uniform float uWallFloorDarken; // body tone at the floor (×uDeepColor)
uniform float uFillLocalY;      // live flood surface, ship-LOCAL Y (m)
uniform float uFloorLocalY;     // compartment floor, ship-local Y (m)
varying vec3 vWorldPos;
varying float vLocalY;
varying float vTop;
// THREE clipping support — pairs with the vertex include (see VERT). Needs clipping:true on the mat.
#include <clipping_planes_pars_fragment>

void main() {
  // Honour the cutaway clip FIRST: discard fragments on the cut-away side so the flood body is sliced
  // flush with the hull cut (the kept-half's far inner walls then read as the dark-water cross-section).
  #include <clipping_planes_fragment>

  // DEPTH below the waterline: 0 at the surface → 1 at the floor. The body darkens downward so it
  // reads as a real solid volume of water, not a glass panel.
  float span = max(uFillLocalY - uFloorLocalY, 1e-3);
  float depthF = clamp((uFillLocalY - vLocalY) / span, 0.0, 1.0);

  // Is this the surface LID? vTop comes from the per-vertex aTop marker; on the clamped top caps it is
  // ~1 and only there. (No screen-depth-coincident branch — that was the old z-fight.)
  bool isLid = vTop > 0.5;

  vec3 V = normalize(uCameraPos - vWorldPos);

  // base body water tone: dark navy, darkening with depth toward the floor.
  vec3 bodyTop = uDeepColor;
  vec3 bodyBot = uDeepColor * uWallFloorDarken;
  vec3 col = mix(bodyTop, bodyBot, depthF);

  if (isLid) {
    // SURFACE LID: a subtle sky/Fresnel surface term on top of the body tone, so the waterline reads as
    // a calm pool top catching a little sky — held well down (an enclosed shadowed hold is not a mirror).
    float nx = 0.10 * sin(uTime * 1.1 + vWorldPos.x * 0.8 + vWorldPos.z * 0.6);
    float nz = 0.10 * sin(uTime * 0.9 - vWorldPos.x * 0.5 + vWorldPos.z * 0.9);
    vec3 N = normalize(vec3(nx, 1.0, nz));
    float facing = max(dot(N, V), 0.0);
    float fresnel = pow(1.0 - facing, 5.0);
    vec3 Rr = reflect(-V, N);
    Rr.y = max(Rr.y, 0.02);
    vec3 skyRefl = (uHasEnv > 0.5) ? textureCube(uSkyEnv, Rr).rgb : uSkyColor;
    skyRefl = min(skyRefl, vec3(uReflClamp));
    float reflF = clamp((min(fresnel, 0.35) * 0.6 + 0.05) * uReflStrength * 0.6, 0.0, 0.22);
    // shallow-tinted top water, then a touch of sky reflection, then a faint sun glint.
    vec3 lidWater = mix(uDeepColor, uShallowColor, 0.35);
    col = mix(lidWater, skyRefl, reflF);
    vec3 H = normalize(normalize(uSunDir) + V);
    col += uSunColor * pow(max(dot(N, H), 0.0), 60.0) * 0.05;
    // a faint foam shimmer right at the waterline
    float foam = 0.4 + 0.4 * sin(uTime * 2.2 + vWorldPos.x * 1.4 + vWorldPos.z * 1.1);
    col = mix(col, vec3(0.7, 0.8, 0.84), clamp(foam, 0.0, 1.0) * 0.12);
  }

  // opaque body — uBodyOpacity is kept live for the dev knob, but the material does not blend, so this
  // is effectively 1.0 (a translucent body is what z-fought before). Clamp away any sub-1 surprise.
  gl_FragColor = vec4(col, max(uBodyOpacity, 1.0));
}
`;

export class CompartmentFluid {
  readonly group = new THREE.Group();
  /** ONE merged water body spanning EVERY compartment, filled to a SINGLE global level. (Was one box
   *  PER watertight compartment, each at its own level — ~10 segmented dark cuboids stair-stepped at
   *  the bulkheads. The whole ship's water is one connected pool to the eye, so it's one slab now.) */
  private body: {
    curve: FillCurve;          // ship-wide cumulative volume↔height curve (union of all cells)
    floorLocalY: number;       // local-Y of the LOWEST compartment floor (m)
    mesh: THREE.Mesh;
    mat: THREE.ShaderMaterial;
    uBodyOpacity: { value: number };
    uShimmer: { value: number };
    uFillLocalY: { value: number };
    uFloorLocalY: { value: number };
  } | null = null;
  private nx: number;
  private ny: number;
  private look: OceanLook | null = null;
  /** The active cutaway clip plane (null = off), stored so a (re)created fluid (hull swap) can be
   *  re-seeded. This is the SAME shared Plane reference main.ts mutates in place each frame — store
   *  the reference, never a copy. */
  private clipPlane: THREE.Plane | null = null;

  constructor(compartments: Compartment[], dims: [number, number, number]) {
    this.nx = dims[0];
    this.ny = dims[1];
    this.build(compartments);
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
   * Build ONE merged BufferGeometry for the WHOLE-SHIP water body from the UNION of every
   * compartment's cell set, in ship-LOCAL meters, as a SOLID FILLED VOLUME (not a hollow boundary
   * skin — that was the root bug; not one box per compartment — that was the segmentation bug).
   *
   * For each occupied (x,z) COLUMN across ALL compartments we emit ONE full CLOSED box spanning that
   * column's floor→ceiling (the lowest occupied cell's bottom to the highest occupied cell's top).
   * The union of columns follows the real (tapered/curved/L-shaped) interior footprint EXACTLY and is
   * gap-free — no geometry exists outside an occupied column, so nothing pokes out of the hull, and
   * there is no hollow interior to reveal under the cutaway: the box's far inner wall shows as a
   * dark-water cross-section. Interior shared faces are fine — occluded (opaque, depthWrite). Because
   * it's ONE column map for the whole ship, the bulkhead seams between adjacent compartments merge
   * into one continuous slab (no inter-box steps).
   *
   * A per-vertex `aTop` attribute is 1.0 on each box's TOP-cap vertices and 0.0 elsewhere, so the
   * vertex shader can clamp+identify the surface lid and the fragment shader can give ONLY the lid a
   * surface/sky term. Built ONCE — cells never change after build; the live water LEVEL is applied as a
   * vertex-stage clamp (y = min(y, uFillLocalY)), not by reshaping this geometry.
   */
  private buildBodyGeometry(cells: Iterable<number>): THREE.BufferGeometry {
    const nx = this.nx;
    const ny = this.ny;
    const s = VOXEL_SIZE;

    // Collapse the UNION cell set to per-(x,z) column extents: [yMin, yMax] inclusive of occupied
    // cells. A column may be non-contiguous (a notch); a single solid box floor→top is the right read
    // for a body of water (the gap would be submerged interior anyway), and keeps the volume gap-free.
    const colMin = new Map<number, number>(); // key = x + nx*z  → min occupied y
    const colMax = new Map<number, number>(); // key = x + nx*z  → max occupied y
    for (const p of cells) {
      const x = p % nx;
      const y = Math.floor(p / nx) % ny;
      const z = Math.floor(p / (nx * ny));
      const key = x + nx * z;
      const lo = colMin.get(key);
      if (lo === undefined || y < lo) colMin.set(key, y);
      const hi = colMax.get(key);
      if (hi === undefined || y > hi) colMax.set(key, y);
    }

    const pos: number[] = [];
    const top: number[] = []; // aTop per vertex (1 on the top cap, 0 elsewhere)
    const idx: number[] = [];
    let base = 0;
    // push one quad (a,b,c,d CCW) with a uniform aTop flag for its 4 verts
    const quad = (
      isTop: number,
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
      dx: number, dy: number, dz: number,
    ) => {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      top.push(isTop, isTop, isTop, isTop);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    };

    for (const [key, yLo] of colMin) {
      const yHi = colMax.get(key)!;
      const x = key % nx;
      const z = Math.floor(key / nx);
      const x0 = x * s, x1 = (x + 1) * s;
      const z0 = z * s, z1 = (z + 1) * s;
      const y0 = yLo * s;          // column floor
      const y1 = (yHi + 1) * s;    // column ceiling (top of the highest cell)
      // FULL CLOSED BOX (all 6 faces). Only the +y face carries aTop=1 (the surface lid). Winding is
      // outward-facing, but the material is DoubleSide so the far walls show through the cut regardless.
      // −x
      quad(0, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
      // +x
      quad(0, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1);
      // −y (floor)
      quad(0, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
      // +y (ceiling) — the SURFACE LID after the vertex clamp
      quad(1, x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0);
      // −z
      quad(0, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
      // +z
      quad(0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("aTop", new THREE.BufferAttribute(new Float32Array(top), 1));
    g.setIndex(idx);
    return g;
  }

  /** Build the ONE merged whole-ship water body from the union of every compartment's cells. */
  private build(compartments: Compartment[]): void {
    if (compartments.length === 0) return;
    // UNION of every compartment's interior cells → one footprint, one fill curve, one body.
    const union = new Set<number>();
    let floorLocalY = Infinity; // lowest compartment floor (m)
    for (const c of compartments) {
      for (const p of c.cells) union.add(p);
      floorLocalY = Math.min(floorLocalY, c.bboxMin[1] * VOXEL_SIZE);
    }
    if (union.size === 0) return;
    if (!Number.isFinite(floorLocalY)) floorLocalY = 0;
    // ship-wide cumulative volume↔height curve from the union (buildFillCurve only reads `.cells`, so a
    // synthetic compartment carrying just the union set is exactly what it needs — pure + footprint-
    // agnostic). The single global fill height = fillHeightLocal(this curve, totalWaterAboard).
    const curve = buildFillCurve({ cells: union } as Compartment, this.nx, this.ny);

    const oc = this.oceanUniforms();
    const uBodyOpacity = { value: TUN.flood.render.skirtOpacity };
    const uShimmer = { value: TUN.flood.render.shimmer };
    const uFillLocalY = { value: floorLocalY };
    const uFloorLocalY = { value: floorLocalY };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      // OPAQUE SOLID BODY — the heart of the fix. The prior versions were `transparent:true` on a
      // self-overlapping DoubleSide skin: blended faces fought for the same depth, order-dependent →
      // TV-static + a two-tone waterline z-fight + dropped faces + a hollow "silk sheet" look. An
      // opaque body with depthWrite makes the NEAREST fragment win unambiguously (no alpha sort, no
      // blend race), so the volume reads SOLID and stable. DoubleSide so the cutaway's far inner wall
      // shows as a dark-water cross-section (no stencil/cap pass needed); opaque DoubleSide does NOT
      // z-fight because depthWrite resolves nearest with no blending.
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      // make the fully-custom shader HONOUR the cutaway clip plane: injects NUM_CLIPPING_PLANES +
      // the clippingPlanes uniform array that the clipping_planes_* includes consume. Without this,
      // assigning mat.clippingPlanes silently no-ops on a raw ShaderMaterial.
      clipping: true,
      uniforms: {
        ...oc,
        uCameraPos: { value: new THREE.Vector3() },
        uBodyOpacity,
        uShimmer,
        uWallFloorDarken: { value: WALL_FLOOR_DARKEN },
        uFillLocalY,
        uFloorLocalY,
      },
    });

    // inherit the active cutaway clip so a body (re)created after a hull swap that re-seeds it in the
    // constructor is sliced flush with the hull cut from birth.
    if (this.clipPlane) {
      mat.clippingPlanes = [this.clipPlane];
      mat.needsUpdate = true;
    }

    // ONE merged SOLID body following the TRUE whole-ship interior footprint, in ship-local meters.
    // Parented under the ship group, so it heels/pitches/heaves WITH the hull (the room is part of the
    // hull). No per-frame scaling/repositioning — only the single fill-level uniform changes.
    const geo = this.buildBodyGeometry(union);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.visible = false; // shown only when there's real water aboard (set in update)
    this.group.add(mesh);

    this.body = {
      curve, floorLocalY, mesh, mat,
      uBodyOpacity, uShimmer, uFillLocalY, uFloorLocalY,
    };
  }

  /** Reflect current flooding. Called once per frame AFTER the ship group transform is synced. The
   *  ONE merged body fills to a SINGLE global level driven by the TOTAL water aboard (Σ waterVolume) —
   *  so the whole ship's water reads as one connected pool, not per-compartment stair-steps. */
  update(compartments: Compartment[], cameraPos: THREE.Vector3 | undefined, dt: number): void {
    void dt;
    const body = this.body;
    if (!body) return;
    // (re)bind the ocean look the first time it becomes available after this ship was built
    if (!this.look) this.look = getOceanLook();

    // The body geometry is ship-local and parented under the ship group, so its modelMatrix already
    // carries the live hull pose — nothing to transform per frame except the fill-level uniform. The
    // shader's view math runs in WORLD space (vWorldPos), so uCameraPos is the WORLD camera.
    this.group.updateWorldMatrix(true, false);

    // keep the shared shimmer/opacity uniforms live with the dev panel
    body.uShimmer.value = TUN.flood.render.shimmer;
    body.uBodyOpacity.value = TUN.flood.render.skirtOpacity;
    if (cameraPos) (body.mat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);

    // total water + total capacity across ALL compartments → one global fill fraction + one level.
    let totalWater = 0;
    let totalVol = 0;
    for (const c of compartments) {
      totalWater += c.waterVolume;
      totalVol += c.volume;
    }
    const fill = totalVol > 0 ? totalWater / totalVol : 0;
    if (fill < 0.005) {
      body.mesh.visible = false;
      return;
    }
    // Per-frame work is just the single fill-level uniform — the geometry is static and already the
    // right shape. The vertex shader clamps every vertex to this level, so the solid body fills the
    // whole interior up to the live waterline and the lid sits exactly on it.
    body.mesh.visible = true;
    body.uFillLocalY.value = fillHeightLocal(body.curve, totalWater);
    body.uFloorLocalY.value = body.floorLocalY;
  }

  /** Cutaway: clip the flood body against the same world-space plane as the hull (null disables), so
   *  the interior water is sliced flush with the centerline half-cut instead of the whole cut-away
   *  half's water floating in the opened hull. Pass the SHARED plane reference main.ts mutates in
   *  place each frame (stored, not copied), so every frame's live pose is honoured. Remembered so a
   *  body (re)built after a hull swap inherits it. The shader only honours this because the material
   *  is built with clipping:true + the clipping includes — a bare clippingPlanes assignment on a
   *  custom ShaderMaterial is a silent no-op. */
  setClipPlane(plane: THREE.Plane | null): void {
    this.clipPlane = plane;
    const planes = plane ? [plane] : null;
    if (this.body) {
      this.body.mat.clippingPlanes = planes;
      this.body.mat.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.body) {
      this.body.mesh.geometry.dispose();
      this.body.mat.dispose();
      this.group.remove(this.body.mesh);
      this.body = null;
    }
  }
}
