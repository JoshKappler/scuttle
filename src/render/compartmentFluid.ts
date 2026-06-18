import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { buildFillCurve, fillHeightLocal, type Compartment, type FillCurve } from "../sim/compartments";
import { getOceanLook, type OceanLook } from "./ocean";

/**
 * Flooded-hold water. The brief (user, verbatim, across many rounds): "it's not syrup, it's water — it's
 * gonna slosh around"; "steal what the ocean looks like on a calm day … put that at wherever the water
 * level is in each compartment, then color it underneath so it's all ONE SOLID COLOR"; "this is still the
 * same water that was outside, just inside the ship now"; "where the water is is as simple as where the
 * voxels aren't." So:
 *
 *  • PER COMPARTMENT, the hold's real interior footprint (its cells) collapsed to per-(x,z) COLUMNS. Each
 *    hold fills to its OWN world level — separate reservoirs (see sim/compartments sill overflow).
 *
 *  • THE SLOSH — the heart of the fix, and what every prior round got subtly wrong. Each column is drawn
 *    as a vertical prism of water rising in WORLD space from its OWN floor cell straight up to the hold's
 *    world surface level. The top is `max(level, columnFloorY)`, so as she heels the columns on the HIGH
 *    side fall below the level and COLLAPSE (go dry) while the LOW side fills — the pool slides to the low
 *    end and the surface stays dead world-horizontal. It SLOSHES. Crucially the prism is extruded from the
 *    FLOOR, not clamped down from a tall ship-local ceiling: clamping a tall box only in world-Y let the
 *    high ceiling vertices rotate far sideways under heel, shearing the surface out of the hold and "right
 *    through into the next compartment" (the user's report). Extruding from the floor pins each column's
 *    water over its own cell, so it can never leave the hold.
 *
 *  • THE LOOK — a calm-day sea surface on TOP, ONE solid colour everywhere below. The lid clones the live
 *    ocean tint (getOceanLook) + a faint ripple, shaded VIEW-INDEPENDENT (no fresnel/sky-mirror — that
 *    grazing reflection WAS the "sheet of blue silk" that survived ~12 attempts). The body is a single flat
 *    deep-navy; no depth-to-black gradient (the old gradient crushed deep water near-black at the edges,
 *    which read as "black flickering" where it z-fought the hull).
 *
 *  • ONE merged mesh, ONE material, ONE draw call. Per-vertex `aCompId` indexes the world-level uniform
 *    array `uLevels[NCOMP]`; `aFloorY` carries each column's floor; `aTop` marks the surface lid. OPAQUE +
 *    depthWrite + DoubleSide so the cut cross-section reads as a filled slab and nothing can alpha-flicker;
 *    polygonOffset nudges it just behind the hull so coincident water/hull faces never z-fight. Clipping is
 *    kept so the X-cutaway plane slices the body flush with the hull. Render-only — never feeds sim/.
 */

const FALLBACK_SHALLOW = new THREE.Color(0x1d5170);
const FALLBACK_DEEP = new THREE.Color(0x0a2840);
const FALLBACK_SKY = new THREE.Color(0x9fc4d4);

// a dry hold's level — far below the world so every column collapses to zero height (invisible).
const DRY_LEVEL = -1e4;

const VERT = (ncomp: number) => /* glsl */ `
uniform float uLevels[${ncomp}];   // world-Y of each compartment's pool surface (the live waterline)
attribute float aCompId;            // which compartment this vertex belongs to (0..NCOMP-1)
attribute float aTop;               // 1.0 on a column's TOP-cap vertices (the surface lid), else 0.0
attribute float aFloorY;            // ship-local Y (m) of THIS vertex's column floor
varying float vTop;                 // interpolated lid marker
varying vec3 vWorldPos;
#include <clipping_planes_pars_vertex>
void main() {
  int ci = int(aCompId + 0.5);
  float level = uLevels[ci];
  // FLOOR of this column in WORLD space (carries the live hull pose — rotates + translates with her).
  vec4 floorWP = modelMatrix * vec4(position.x, aFloorY, position.z, 1.0);
  // Surface top of THIS column: the hold's world level, never below the column's own floor. A column whose
  // floor sits above the level has zero height → it's dry. So as she heels the high side empties and the
  // low side fills: the pool slides to the low end and the lid stays world-horizontal. That IS the slosh.
  float topY = max(level, floorWP.y);
  vec3 wp;
  if (position.y > aFloorY + 0.001) {
    // a wall-top / lid vertex: extrude straight UP in WORLD space from the floor to the surface. Extruding
    // from the FLOOR (not clamping a tall ship-local box) is what keeps the prism over its own cell and
    // stops the surface shearing into the next hold under heel.
    wp = vec3(floorWP.x, topY, floorWP.z);
  } else {
    wp = floorWP.xyz; // floor vertex stays on the (posed) hull floor
  }
  vWorldPos = wp;
  vTop = aTop;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uSkyColor;
uniform float uTime;
varying float vTop;
varying vec3 vWorldPos;
#include <clipping_planes_pars_fragment>

void main() {
  // honour the cutaway clip FIRST: discard the cut-away side so the body is sliced flush with the hull.
  #include <clipping_planes_fragment>

  // ONE SOLID COLOUR for the whole body of water below the surface (the user's "color it underneath so
  // it's all one solid color"). A deep sea navy, the same hue as the open ocean's deep colour, lifted a
  // hair off pure-deep so it reads as a clear volume rather than a black void. No view-dependent term, so
  // it's the same colour from every angle and through the cutaway.
  vec3 col = mix(uDeepColor, uShallowColor, 0.22);

  if (vTop > 0.5) {
    // SURFACE LID — the calm-day sea: the ocean's own shallow tint lifted toward the sky + a faint ripple
    // shimmer. VIEW-INDEPENDENT on purpose (the grazing-angle sky reflection was the silk sheet).
    vec3 surf = mix(uShallowColor, uSkyColor, 0.18);
    float rip = 0.5 + 0.5 * sin(uTime * 1.1 + vWorldPos.x * 0.8 + vWorldPos.z * 0.6)
              + 0.35 * sin(uTime * 0.7 - vWorldPos.x * 0.5 + vWorldPos.z * 1.0);
    surf *= 0.92 + 0.08 * clamp(rip, 0.0, 1.0);
    col = surf;
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
   * emit one box per column from the column FLOOR up to a nominal ceiling. The vertex shader then extrudes
   * each column world-vertically from its floor to the live surface level, so the box's ceiling height is
   * arbitrary (just needs to be above the floor to give the shader distinct top vertices). Every vertex
   * carries `aCompId` (its hold), `aFloorY` (its column floor in m), and `aTop` (1 on the +y lid).
   */
  private build(compartments: Compartment[]): void {
    if (compartments.length === 0) return;
    const nx = this.nx, ny = this.ny, s = VOXEL_SIZE;
    const ceilY = (this.deckY + 4) * s; // nominal box ceiling (m); the shader sets the real top per column

    const pos: number[] = [];
    const top: number[] = [];
    const cid: number[] = [];
    const floor: number[] = [];
    const idx: number[] = [];
    let base = 0;
    const quad = (
      isTop: number, ci: number, fy: number,
      ax: number, ay: number, az: number, bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    ) => {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      for (let i = 0; i < 4; i++) { top.push(isTop); cid.push(ci); floor.push(fy); }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    };

    for (const c of compartments) {
      // per-(x,z) column floor (lowest occupied cell). One solid prism floor→surface reads as a body of
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
        const fy = y0; // this column's floor (m) → aFloorY for every vertex of the box
        // full closed box; only +y carries aTop=1 (the lid). DoubleSide shows the far inner wall in a cut.
        quad(0, ci, fy, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0); // −x
        quad(0, ci, fy, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1); // +x
        quad(0, ci, fy, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1); // −y floor
        quad(1, ci, fy, x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0); // +y lid
        quad(0, ci, fy, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0); // −z
        quad(0, ci, fy, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1); // +z
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
    geo.setAttribute("aFloorY", new THREE.BufferAttribute(new Float32Array(floor), 1));
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
      // nudge the water a hair BEHIND the opaque hull in depth so coincident water/hull faces resolve in
      // the hull's favour every frame instead of z-fighting (the "black flickering around the edges").
      polygonOffset: true,
      polygonOffsetFactor: 1.0,
      polygonOffsetUnits: 1.0,
      uniforms: {
        ...oc,
        uLevels: { value: this.uLevels },
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
   *  uLevels[id]; the vertex shader extrudes that hold's columns up to it. Dry holds get DRY_LEVEL. */
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
