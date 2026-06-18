import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { buildFillCurve, fillHeightLocal, type Compartment, type FillCurve } from "../sim/compartments";
import { getOceanLook, type OceanLook } from "./ocean";

/**
 * Flooded-hold water — round 8 rewrite. The brief (user, verbatim): "it's not syrup, it's water — it's
 * gonna slosh around"; "put [the calm-ocean surface] at wherever the water level is in EACH compartment …
 * color it underneath so it's all one solid color"; "where the water is is as simple as where the voxels
 * aren't." So:
 *
 *  • PER COMPARTMENT, ONE solid body filling that hold's real interior footprint (its cells), floor→deck.
 *    Each hold fills to its OWN level — the holds are separate reservoirs (see sim/compartments sill
 *    overflow), so the render shows real per-hold water, not one global slab.
 *
 *  • THE SLOSH — the heart of the fix. The water level is clamped in WORLD space in the vertex shader
 *    (`wp = modelMatrix·position; wp.y = min(wp.y, level)`), NOT in ship-local space. So the surface stays
 *    dead LEVEL as she pitches/heels and the water pools to the low end — it sloshes. (The prior build
 *    clamped in local space → the surface tilted with the deck = the "syrup" the user reported.)
 *
 *  • THE LOOK — a calm-day sea surface on TOP, one solid dark colour BELOW. The lid is shaded VIEW-
 *    INDEPENDENT (a calm tint + a faint ripple, NO sky-mirror fresnel) — that view-dependent reflection
 *    at grazing angles WAS the "sheet of blue silk" that survived ~12 attempts. The body darkens with
 *    depth so it reads as a solid volume, and (being opaque) it cannot flicker.
 *
 *  • ONE merged mesh, ONE material, ONE draw call. A per-vertex compartment id (`aCompId`) indexes a
 *    uniform array of world levels (`uLevels[NCOMP]`) so every hold gets its own surface in one pass.
 *    Dry holds get a level far below the world → their geometry collapses out of sight.
 *
 * OPAQUE (`transparent:false`, depthWrite, DoubleSide): the nearest fragment wins unambiguously (no alpha
 * sort / blend race), DoubleSide shows the cut cross-section as a filled slab. The opaque hull occludes
 * the water, so it's only ever seen through real shot holes + the X cutaway — exactly right. Clipping is
 * kept (the cutaway plane slices the body flush with the hull cut). Geometry is built ONCE; per frame we
 * only write the per-hold level uniforms. Render-only — never feeds sim/ (determinism, THE LAW #1).
 */

const FALLBACK_SHALLOW = new THREE.Color(0x123a52);
const FALLBACK_DEEP = new THREE.Color(0x081726);
const FALLBACK_SKY = new THREE.Color(0x9fc4d4);

// body tone at the floor (× the deep colour) and the depth (m) over which it darkens to that — a solid
// body of water dims downward. Module render constants; promote to TUN.flood.render if a knob is wanted.
const WALL_FLOOR_DARKEN = 0.45;
const DEPTH_DARKEN_M = 3.0;
// a dry hold's level — far below the world so its (still-built) geometry collapses to a sliver beyond the
// far clip plane and is never seen. (min(y, −1e4) pulls every vertex down to −10 km.)
const DRY_LEVEL = -1e4;

const VERT = (ncomp: number) => /* glsl */ `
uniform float uLevels[${ncomp}];   // world-Y of each compartment's pool surface (the live waterline)
attribute float aCompId;            // which compartment this vertex belongs to (0..NCOMP-1)
attribute float aTop;               // 1.0 on a column's TOP-cap vertices (the surface lid), else 0.0
varying float vDepth;               // metres BELOW this hold's surface (0 at the lid)
varying float vTop;                 // interpolated lid marker
varying vec3 vWorldPos;
#include <clipping_planes_pars_vertex>
void main() {
  int ci = int(aCompId + 0.5);
  float level = uLevels[ci];
  vec4 wp = modelMatrix * vec4(position, 1.0);   // ship-local metres → WORLD
  // WORLD-space level cut: clamp every vertex down to this hold's world waterline. The top caps collapse
  // onto a single flat lid exactly at the level (one real surface), the walls below stay solid, anything
  // above is degenerate. Because the clamp is in WORLD space the surface is world-horizontal → it stays
  // level and SLOSHES as the hull pitches/heels, instead of tilting glued to the deck.
  wp.y = min(wp.y, level);
  vDepth = level - wp.y;             // ≥ 0; 0 at the surface, grows toward the floor
  vTop = aTop;
  vWorldPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uSkyColor;
uniform float uWallFloorDarken;
uniform float uDepthDarkenM;
uniform float uTime;
varying float vDepth;
varying float vTop;
varying vec3 vWorldPos;
#include <clipping_planes_pars_fragment>

void main() {
  // honour the cutaway clip FIRST: discard the cut-away side so the body is sliced flush with the hull.
  #include <clipping_planes_fragment>

  // SOLID BODY: dark navy, darkening with depth below the surface so it reads as a real volume of water
  // (not a glass panel). Reads the same dark from ANY angle — no view-dependent mirror.
  float depthF = clamp(vDepth / max(uDepthDarkenM, 0.001), 0.0, 1.0);
  vec3 col = mix(uDeepColor, uDeepColor * uWallFloorDarken, depthF);

  if (vTop > 0.5) {
    // SURFACE LID — a CALM-DAY sea: the sea's own shallow tint lifted a touch toward the sky, plus a
    // faint ripple shimmer. VIEW-INDEPENDENT on purpose: the old grazing-angle sky reflection was the
    // "sheet of blue silk". A flooded hold is an enclosed body of water, so this is a quiet matte surface.
    vec3 surf = mix(uShallowColor, uSkyColor, 0.14);
    float rip = 0.5 + 0.5 * sin(uTime * 1.1 + vWorldPos.x * 0.8 + vWorldPos.z * 0.6)
              + 0.35 * sin(uTime * 0.7 - vWorldPos.x * 0.5 + vWorldPos.z * 1.0);
    surf *= 0.93 + 0.07 * clamp(rip, 0.0, 1.0);
    col = mix(col, surf, 0.7);
  }

  gl_FragColor = vec4(col, 1.0);   // opaque
}
`;

export class CompartmentFluid {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private uLevels: Float32Array;
  /** per compartment (indexed by id): the static fill curve + horizontal centre (local m) used to derive
   *  the world surface level each frame. Built once — cells are static after build. */
  private holds: { curve: FillCurve; cx: number; cz: number }[] = [];
  private nx: number;
  private ny: number;
  private deckY: number;
  private look: OceanLook | null = null;
  private clipPlane: THREE.Plane | null = null;
  private tmp = new THREE.Vector3();

  constructor(compartments: Compartment[], dims: [number, number, number], deckY: number) {
    this.nx = dims[0];
    this.ny = dims[1];
    this.deckY = deckY;
    this.uLevels = new Float32Array(Math.max(1, compartments.length)).fill(DRY_LEVEL);
    this.build(compartments);
  }

  /** Live ocean look (lazy — the ocean may be created after the first ship), or a navy fallback. */
  private oceanColors() {
    const look = (this.look ??= getOceanLook());
    if (look) {
      return {
        uShallowColor: look.uShallowColor,
        uDeepColor: look.uDeepColor,
        uSkyColor: look.uSkyColor,
        uTime: look.uTime,
      };
    }
    return {
      uShallowColor: { value: FALLBACK_SHALLOW.clone() },
      uDeepColor: { value: FALLBACK_DEEP.clone() },
      uSkyColor: { value: FALLBACK_SKY.clone() },
      uTime: { value: 0 },
    };
  }

  /**
   * ONE merged geometry for ALL holds. For each compartment, collapse its cells to per-(x,z) COLUMNS and
   * emit one solid box per column from the column FLOOR up to a common ceiling well ABOVE the deck (so the
   * world-space level clamp always forms a clean flat top, even under heel). Every vertex carries `aCompId`
   * (its hold, to index uLevels) and `aTop` (1 on the +y cap = the surface lid). The union of columns
   * follows each hold's true tapered/curved footprint exactly and is gap-free.
   */
  private build(compartments: Compartment[]): void {
    if (compartments.length === 0) return;
    const nx = this.nx, ny = this.ny, s = VOXEL_SIZE;
    const ceilY = (this.deckY + 4) * s; // common box ceiling (m), above any possible waterline

    const pos: number[] = [];
    const top: number[] = [];
    const cid: number[] = [];
    const idx: number[] = [];
    let base = 0;
    const quad = (
      isTop: number, ci: number,
      ax: number, ay: number, az: number, bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    ) => {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      for (let i = 0; i < 4; i++) { top.push(isTop); cid.push(ci); }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    };

    for (const c of compartments) {
      // per-(x,z) column floor (lowest occupied cell). One solid box floor→ceiling reads as a body of
      // water; a non-contiguous notch in a column would be submerged interior anyway.
      const colMinY = new Map<number, number>();
      for (const p of c.cells) {
        const x = p % nx;
        const y = Math.floor(p / nx) % ny;
        const z = Math.floor(p / (nx * ny));
        const key = x + nx * z;
        const lo = colMinY.get(key);
        if (lo === undefined || y < lo) colMinY.set(key, y);
      }
      const ci = c.id;
      for (const [key, yLo] of colMinY) {
        const x = key % nx, z = Math.floor(key / nx);
        const x0 = x * s, x1 = (x + 1) * s, z0 = z * s, z1 = (z + 1) * s;
        const y0 = yLo * s, y1 = ceilY;
        // full closed box; only +y carries aTop=1 (the lid). DoubleSide shows the far inner wall in a cut.
        quad(0, ci, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0); // −x
        quad(0, ci, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1); // +x
        quad(0, ci, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1); // −y floor
        quad(1, ci, x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0); // +y lid
        quad(0, ci, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0); // −z
        quad(0, ci, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1); // +z
      }
      // remember the curve + horizontal centre for the per-frame world-level derivation
      this.holds[ci] = {
        curve: buildFillCurve(c, nx, ny),
        cx: ((c.bboxMin[0] + c.bboxMax[0]) / 2 + 0.5) * s,
        cz: ((c.bboxMin[2] + c.bboxMax[2]) / 2 + 0.5) * s,
      };
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("aTop", new THREE.BufferAttribute(new Float32Array(top), 1));
    geo.setAttribute("aCompId", new THREE.BufferAttribute(new Float32Array(cid), 1));
    geo.setIndex(idx);

    const oc = this.oceanColors();
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT(this.uLevels.length),
      fragmentShader: FRAG,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      clipping: true, // honour the cutaway plane (needs clipping:true + the clipping includes)
      uniforms: {
        ...oc,
        uLevels: { value: this.uLevels },
        uWallFloorDarken: { value: WALL_FLOOR_DARKEN },
        uDepthDarkenM: { value: DEPTH_DARKEN_M },
      },
    });
    if (this.clipPlane) {
      mat.clippingPlanes = [this.clipPlane];
      mat.needsUpdate = true;
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.visible = false; // shown only when there's real water aboard
    this.group.add(mesh);
    this.mesh = mesh;
    this.mat = mat;
  }

  /** Reflect current flooding. Called once per frame AFTER the ship group transform is synced (the body is
   *  parented under it, so its world matrix carries the live hull pose). For each hold we derive the WORLD-Y
   *  of its pool surface from `waterVolume` via the static fill curve + the live pose, and write it to
   *  uLevels[id]; the vertex shader clamps that hold's box to it. Dry holds get DRY_LEVEL (collapse away). */
  update(compartments: Compartment[], _cameraPos: THREE.Vector3 | undefined, _dt: number): void {
    void _cameraPos; void _dt;
    const mesh = this.mesh;
    if (!mesh) return;
    if (!this.look) {
      // (re)bind the live ocean look the first time it exists after this ship was built
      this.look = getOceanLook();
      if (this.look && this.mat) {
        const u = this.mat.uniforms;
        u.uShallowColor = this.look.uShallowColor;
        u.uDeepColor = this.look.uDeepColor;
        u.uSkyColor = this.look.uSkyColor;
        u.uTime = this.look.uTime;
        this.mat.needsUpdate = true;
      }
    }

    this.group.updateWorldMatrix(true, false);
    const m = this.group.matrixWorld;

    let anyWater = false;
    for (const c of compartments) {
      const hold = this.holds[c.id];
      if (!hold) continue;
      if (c.waterVolume <= 1e-4) { this.uLevels[c.id] = DRY_LEVEL; continue; }
      anyWater = true;
      // local fill height (ship-Y, m) from the static curve, at the hold's horizontal centre → world Y.
      const lyH = fillHeightLocal(hold.curve, c.waterVolume);
      this.tmp.set(hold.cx, lyH, hold.cz).applyMatrix4(m);
      this.uLevels[c.id] = this.tmp.y;
    }
    mesh.visible = anyWater;
    // uLevels IS the uniform's .value (bound by reference at build), and THREE re-uploads float-array
    // uniforms every frame, so mutating it in place above is all that's needed.
  }

  /** Cutaway: clip the flood body against the same world-space plane as the hull (null disables). Pass the
   *  SHARED plane reference main.ts mutates in place each frame (stored, not copied). Honoured only because
   *  the material is built with clipping:true + the clipping includes. */
  setClipPlane(plane: THREE.Plane | null): void {
    this.clipPlane = plane;
    if (this.mat) {
      this.mat.clippingPlanes = plane ? [plane] : null;
      this.mat.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.group.remove(this.mesh);
      this.mesh = null;
      this.mat = null;
    }
  }
}
