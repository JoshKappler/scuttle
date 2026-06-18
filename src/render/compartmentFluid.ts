import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { buildFillCurve, fillHeightLocal, type Compartment, type FillCurve } from "../sim/compartments";
import { getOceanLook, type OceanLook } from "./ocean";

/**
 * Flooded-hold water. The brief (user, verbatim, across many rounds): "it's not syrup, it's water — it's
 * gonna slosh around"; "this is still the same water that was outside, just inside the ship now"; "give the
 * water in here the same texture as the water outside"; "the brick of flooded water is pinned straight
 * upright, not tracking with the pitch of the ship … it clips through ship components instead of staying
 * neatly within the compartment." So two hard constraints that LOOK contradictory but aren't:
 *
 *  • THE SURFACE SLOSHES — it stays WORLD-HORIZONTAL (water finds its level), so as she heels the pool
 *    slides to the low end of the hold instead of tilting glued to the deck (the old "syrup").
 *
 *  • THE BODY STAYS IN THE COMPARTMENT — its side walls stay PARALLEL to the (tilted) bulkheads, so it can
 *    never poke through a heeled wall into the next hold (the round-9 regression: extruding the columns
 *    straight up in WORLD space made the tops jut `h·sin(heel)` sideways past the tilted bulkhead).
 *
 *  THE FIX (both at once): each hold's footprint collapses to per-(x,z) COLUMNS. A column is a prism whose
 *  SIDES are ship-vertical (parallel to the bulkheads) but whose TOP is solved, per corner, to land on the
 *  hold's world-flat surface plane: we pick the SHIP-LOCAL top-Y such that `modelMatrix * top == level` in
 *  world Y (see VERT). Same ship-local (x,z) as the floor ⇒ sides track the hull's tilt (no clip-through);
 *  top lands on the world level ⇒ a flat sheet that sloshes over the tilted floor. A column whose solved top
 *  falls below its own floor is dry (the high side empties under heel); one whose top exceeds its ceiling is
 *  full (clamped to the hold roof).
 *
 *  • THE LOOK — the lid CLONES the open-sea surface shader (getOceanLook): the same view-dependent
 *    shallow→deep water colour, the same clamped env-cube sky reflection, the same broad sun glint — so the
 *    pool reads as "the sea continuing into the room". A cheap procedural ripple gives it a real wave NORMAL,
 *    which scatters the reflection into glints; a FLAT normal + fresnel was the old "sheet of blue silk".
 *    The body below the surface is one solid deep-sea colour (the same deep tint the open ocean shows
 *    looking straight down), so lid and sides are visibly the same body of water.
 *
 *  • ONE merged mesh, ONE material, ONE draw call. Per-vertex `aCompId` indexes the world-level uniform
 *    array `uLevels[NCOMP]`; `aFloorY`/`aCeilY` carry each column's floor/ceiling (ship-local m); `aTop`
 *    marks the surface lid. OPAQUE + depthWrite + DoubleSide so the cut cross-section reads as a filled slab
 *    and nothing can alpha-flicker; polygonOffset nudges it just behind the hull so coincident water/hull
 *    faces never z-fight, and the lid sits a hair BELOW the sea so a flooded hold's surface never z-fights
 *    the external ocean (the "black flickering speckle"). Clipping is kept so the X-cutaway slices it flush
 *    with the hull. Render-only — never feeds sim/.
 */

const FALLBACK_SHALLOW = new THREE.Color(0x1d5170);
const FALLBACK_DEEP = new THREE.Color(0x0a2840);
const FALLBACK_SKY = new THREE.Color(0x9fc4d4);
const FALLBACK_SUN = new THREE.Color(0xfff2d6);

// a dry hold's level — far below the world so every column collapses to zero height (invisible).
const DRY_LEVEL = -1e4;

const VERT = (ncomp: number) => /* glsl */ `
uniform float uLevels[${ncomp}];   // world-Y of each compartment's pool surface (the live waterline)
attribute float aCompId;            // which compartment this vertex belongs to (0..NCOMP-1)
attribute float aTop;               // 1.0 on a column's TOP-cap vertices (the surface lid), else 0.0
attribute float aFloorY;            // ship-local Y (m) of THIS vertex's column floor
attribute float aCeilY;             // ship-local Y (m) of THIS vertex's column ceiling (the hold roof)
varying float vTop;                 // interpolated lid marker
varying vec3 vWorldPos;
#include <clipping_planes_pars_vertex>
void main() {
  int ci = int(aCompId + 0.5);
  // a hair below the sea: a flooded hold equalises to the outside waterline, so its lid would otherwise be
  // coplanar with the external ocean and z-fight it (dark navy speckle). Drop it 3 cm so the hull/ocean win
  // the tie cleanly; with the matched ocean look the offset is invisible.
  float level = uLevels[ci] - 0.03;
  vec3 localPos;
  if (position.y > aFloorY + 0.001) {
    // TOP vertex. Choose the SHIP-LOCAL Y so that, once posed by the live hull matrix, this corner lands
    // exactly on the WORLD-horizontal surface plane y = level. Because the column keeps its own ship-local
    // (x,z), its side walls stay PARALLEL to the tilted bulkheads — the water can't poke through a heeled
    // wall into the next hold — while the lid is still a flat world-level sheet that SLOSHES to the low side
    // over the tilted floor. Solve modelMatrix row-Y: level = M[0].y·x + M[1].y·y + M[2].y·z + M[3].y.
    float my = modelMatrix[1].y; // deck-up component; > 0 for any non-capsized hull
    float localTopY = (level - modelMatrix[0].y * position.x - modelMatrix[2].y * position.z - modelMatrix[3].y) / my;
    localTopY = clamp(localTopY, aFloorY, aCeilY); // dry if below its floor; full if above the hold roof
    localPos = vec3(position.x, localTopY, position.z);
  } else {
    localPos = vec3(position.x, aFloorY, position.z); // floor stays on the posed hull floor
  }
  vec4 wp4 = modelMatrix * vec4(localPos, 1.0);
  vWorldPos = wp4.xyz;
  vTop = aTop;
  vec4 mvPosition = viewMatrix * wp4;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uSkyColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform samplerCube uSkyEnv;
uniform float uHasEnv;
uniform float uReflStrength;
uniform float uReflClamp;
uniform float uTime;
varying float vTop;
varying vec3 vWorldPos;
#include <clipping_planes_pars_fragment>

void main() {
  // honour the cutaway clip FIRST: discard the cut-away side so the body is sliced flush with the hull.
  #include <clipping_planes_fragment>

  // BODY: the deep sea volume — the same deep colour the open ocean shows looking straight down, lifted a
  // hair so it reads as a clear body of water rather than a black void. One solid colour, view-independent.
  vec3 col = mix(uDeepColor, uShallowColor, 0.14);

  if (vTop > 0.5) {
    // SURFACE LID — clone the open ocean's own surface shading so the pool reads as "the sea continuing
    // into the room". The cheap procedural ripple gives the surface a real wave NORMAL, which scatters the
    // sky reflection into moving glints instead of one flat mirror sheet (flat normal + fresnel == silk).
    float t = uTime;
    vec2 p = vWorldPos.xz;
    float dHdx = 0.9 * cos(p.x * 0.9 + t * 1.1) + 0.5 * cos(p.x * 0.5 - p.y * 0.4 + t * 0.7);
    float dHdz = 0.8 * cos(p.y * 0.8 - t * 0.9) + 0.5 * cos(-p.x * 0.4 + p.y * 0.5 + t * 0.7);
    vec3 N = normalize(vec3(-dHdx * 0.10, 1.0, -dHdz * 0.10));
    vec3 V = normalize(cameraPosition - vWorldPos);

    // base water colour: deep looking straight down, lighter at grazing — exactly the open sea's law.
    float facing = max(dot(N, V), 0.0);
    vec3 water = mix(uShallowColor, uDeepColor, facing);

    // fresnel reflection of the SAME sky env cube the ocean samples, HDR-clamped (no white blowout) and at
    // reduced strength for the dim interior. Broken up by the ripple normal so it reads as water sheen.
    float fresnel = pow(1.0 - facing, 5.0);
    vec3 R = reflect(-V, N); R.y = max(R.y, 0.02);
    vec3 skyRefl = (uHasEnv > 0.5) ? textureCube(uSkyEnv, R).rgb : uSkyColor;
    skyRefl = min(skyRefl, vec3(uReflClamp));
    float reflF = clamp((fresnel * 0.85 + 0.05) * uReflStrength * 0.6, 0.0, 1.0);
    col = mix(water, skyRefl, reflF);

    // broad sun glint path — the same wide lobes as the open sea (never a pinpoint that strobes).
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);
    float ndh = max(dot(N, H), 0.0);
    col += uSunColor * (pow(ndh, 48.0) * 0.15 + pow(ndh, 14.0) * 0.04);
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

  /** Live ocean look (lazy — the ocean may be created after the first ship), or a navy fallback. Returns the
   *  SAME live uniform OBJECTS the sea shader reads, so a dev-panel colour/reflection tweak flows through. */
  private oceanColors() {
    const look = (this.look ??= getOceanLook());
    if (look) {
      return {
        uShallowColor: look.uShallowColor,
        uDeepColor: look.uDeepColor,
        uSkyColor: look.uSkyColor,
        uSunColor: look.uSunColor,
        uSunDir: look.uSunDir,
        uSkyEnv: look.uSkyEnv,
        uHasEnv: look.uHasEnv,
        uReflStrength: look.uReflStrength,
        uReflClamp: look.uReflClamp,
        uTime: look.uTime,
      };
    }
    return {
      uShallowColor: { value: FALLBACK_SHALLOW.clone() },
      uDeepColor: { value: FALLBACK_DEEP.clone() },
      uSkyColor: { value: FALLBACK_SKY.clone() },
      uSunColor: { value: FALLBACK_SUN.clone() },
      uSunDir: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
      uSkyEnv: { value: null as THREE.CubeTexture | THREE.Texture | null },
      uHasEnv: { value: 0 },
      uReflStrength: { value: 0.22 },
      uReflClamp: { value: 1.5 },
      uTime: { value: 0 },
    };
  }

  /**
   * ONE merged geometry for ALL holds. For each compartment, collapse its cells to per-(x,z) COLUMNS and
   * emit one box per column from the column FLOOR up to a nominal ceiling. The vertex shader replaces the top
   * vertices with the ship-local Y that lands on the live world surface level (clamped to the column's own
   * floor/ceiling), so the box's nominal ceiling height is arbitrary (just needs to mark the top vertices).
   * Every vertex carries `aCompId` (its hold), `aFloorY`/`aCeilY` (its column floor/ceiling in m), `aTop`.
   */
  private build(compartments: Compartment[]): void {
    if (compartments.length === 0) return;
    const nx = this.nx, ny = this.ny, s = VOXEL_SIZE;
    const ceilY = (this.deckY + 4) * s; // nominal box ceiling (m); the shader sets the real top per column

    const pos: number[] = [];
    const top: number[] = [];
    const cid: number[] = [];
    const floor: number[] = [];
    const ceil: number[] = [];
    const idx: number[] = [];
    let base = 0;
    const quad = (
      isTop: number, ci: number, fy: number, cy: number,
      ax: number, ay: number, az: number, bx: number, by: number, bz: number,
      cx: number, cyy: number, cz: number, dx: number, dy: number, dz: number,
    ) => {
      pos.push(ax, ay, az, bx, by, bz, cx, cyy, cz, dx, dy, dz);
      for (let i = 0; i < 4; i++) { top.push(isTop); cid.push(ci); floor.push(fy); ceil.push(cy); }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    };

    for (const c of compartments) {
      // per-(x,z) column floor (lowest occupied cell) + ceiling (highest occupied cell + 1). One solid prism
      // floor→surface reads as a body of water; the ceiling caps a full column at the hold roof.
      const colMinY = new Map<number, number>();
      const colMaxY = new Map<number, number>();
      for (const p of c.cells) {
        const x = p % nx;
        const y = Math.floor(p / nx) % ny;
        const z = Math.floor(p / (nx * ny));
        const key = x + nx * z;
        const lo = colMinY.get(key);
        if (lo === undefined || y < lo) colMinY.set(key, y);
        const hi = colMaxY.get(key);
        if (hi === undefined || y > hi) colMaxY.set(key, y);
      }
      const ci = c.id;
      for (const [key, yLo] of colMinY) {
        const x = key % nx, z = Math.floor(key / nx);
        const x0 = x * s, x1 = (x + 1) * s, z0 = z * s, z1 = (z + 1) * s;
        const y0 = yLo * s, y1 = ceilY;
        const fy = y0;                              // this column's floor (m) → aFloorY for every vertex
        const cy = ((colMaxY.get(key) ?? yLo) + 1) * s; // this column's ceiling (m) → aCeilY
        // full closed box; only +y carries aTop=1 (the lid). DoubleSide shows the far inner wall in a cut.
        quad(0, ci, fy, cy, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0); // −x
        quad(0, ci, fy, cy, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1); // +x
        quad(0, ci, fy, cy, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1); // −y floor
        quad(1, ci, fy, cy, x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0); // +y lid
        quad(0, ci, fy, cy, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0); // −z
        quad(0, ci, fy, cy, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1); // +z
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
    geo.setAttribute("aCeilY", new THREE.BufferAttribute(new Float32Array(ceil), 1));
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
   *  uLevels[id]; the vertex shader lands each hold's column tops on it. Dry holds get DRY_LEVEL. */
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
        u.uSunColor = this.look.uSunColor;
        u.uSunDir = this.look.uSunDir;
        u.uSkyEnv = this.look.uSkyEnv;
        u.uHasEnv = this.look.uHasEnv;
        u.uReflStrength = this.look.uReflStrength;
        u.uReflClamp = this.look.uReflClamp;
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
