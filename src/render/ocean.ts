import * as THREE from "three";
import type { Wave } from "../sim/gerstner";
import { physicsWaves, surfaceHeight } from "../sim/gerstner";
import type { OceanField } from "./oceanField";
import { MAXVIS } from "../core/constants";

/**
 * SHARED OCEAN LOOK — the live appearance the flood-water surface clones so the interior pool reads as
 * "the ocean continuing into the room" rather than a separate material (render/compartmentFluid.ts).
 *
 * These are the SAME live uniform objects the open-sea ShaderMaterial uses (body colour gradient, the
 * sky+cloud reflection cube, sun colour/direction, reflection strength/clamp, and the shared clock), so
 * when the dev panel tunes the ocean's colour or reflection the flood follows automatically — no copy,
 * no drift. Plus the analytic SWELL wave set + a CPU sampler, so the flood can read the LOCAL sea height
 * at a breach to fade its side skirt out when the interior level equalises to the sea (big-hole case).
 * Populated once by createOcean(); consumers read it via getOceanLook() (null before the ocean exists).
 */
export interface OceanLook {
  uShallowColor: { value: THREE.Color };
  uDeepColor: { value: THREE.Color };
  uSunColor: { value: THREE.Color };
  uSkyColor: { value: THREE.Color };
  uSkyEnv: { value: THREE.CubeTexture | THREE.Texture };
  uHasEnv: { value: number };
  uReflStrength: { value: number };
  uReflClamp: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uTime: { value: number };
  /** the analytic swell wave set the open-sea surface (and physics) ride. */
  swell: Wave[];
  /** local sea-surface world-Y at (x,z) on the analytic swell, at the shared clock time. */
  seaHeight(x: number, z: number): number;
}

let sharedOceanLook: OceanLook | null = null;
export function getOceanLook(): OceanLook | null {
  return sharedOceanLook;
}

/**
 * Ocean surface: a camera-centered POLAR grid whose vertex shader evaluates
 * the SAME Gerstner equations as src/sim/gerstner.ts, from the same Wave
 * parameters. Per-wave uniforms are precomputed so GPU and CPU agree:
 *   uWaveA[i] = (dirX, dirZ, amplitude, k)
 *   uWaveB[i] = (qa, omega)  with qa = Q·amplitude, omega = k·phaseSpeed
 *
 * Round 8 rebuild: the old 1200 m uniform plane had 3 m vertices — too
 * coarse to show the bow swell at all — and snapped to a 10 m grid as the
 * camera moved, re-sampling every wave against a shifted lattice (the
 * "stuttering"). The polar grid puts ~0.8 m vertices beside the hull and
 * 40 m ones at the horizon, follows the camera CONTINUOUSLY (the surface is
 * world-anchored, so a sliding lattice samples a smooth field smoothly), and
 * fades each wave out before the local vertex spacing can alias it.
 */

const R_NEAR = 0.8; // m — innermost ring
// The sea reaches the horizon. Fog fades the surface to the sky's HORIZON_COLOR well before this
// radius, so distant islands sit on (hazy) water instead of floating over a void; bumping the radius
// is nearly free — it covers the same screen pixels (the disk already fills down to the horizon line),
// it just makes the water "real" much further out. Fog hides the coarser far rings.
const R_FAR = 2400; // m — horizon ring
const RINGS = 156;
const SECTORS = 160;
// The underwater-backdrop bowl's rim depth (world Y), used as the FALLBACK floor when the live sea
// surface isn't known yet. In update() the rim is raised every frame to sit just under the LOCAL sea
// surface near the camera (see RIM_TROUGH_MARGIN) so the navy wall climbs as close to the waterline as
// possible — backing near-horizontal sightlines through a holed hull — while always staying below the
// deepest near-field wave trough, so the OPAQUE near surface still hides it on open water (the bowl is
// only ever seen DOWN through a transparent/cut/holed patch of sea, never as a horizon wall/ring).
const BOWL_RIM_Y = -6;
// How far BELOW the local sea surface the bowl rim is held above water. The near surface chops/swells
// down to roughly -3 m in a trough; keeping the rim a little below that guarantees the opaque near
// surface is always IN FRONT of the bowl wall, so raising the rim this close can never bleed navy onto
// the open sea — it only ever fills the transparent gaps (a submerged deck, a holed bow, the cutaway).
const RIM_TROUGH_MARGIN = 3.5;

export interface Ocean {
  mesh: THREE.Mesh;
  /** Opaque NAVY body UNDER the surface: what shows through wherever the sea goes translucent or is cut
   *  away (a submerged deck, the shallows, a holed bow at the waterline, the cutaway wedge) so the sea
   *  reads as a SOLID body of water, never a thin sheet over a void of sky. A camera-centred downward
   *  bowl whose rim is held just under the local surface; when the camera dips under, it raises to fully
   *  enclose the lens in navy. Add it to the scene alongside `mesh`; it follows the camera in `update`. */
  backdrop: THREE.Mesh;
  update(time: number, cameraPos: THREE.Vector3): void;
  /** Tell the ocean whether the camera is BELOW the sea surface this frame (main.ts samples the Gerstner
   *  swell at the camera — see report). When on, the navy backdrop is raised to fully ENCLOSE the camera
   *  and its colour deepens so the whole view reads as being submerged in a solid navy body, never the
   *  sky dome. main.ts must ALSO swap scene.fog to the dense navy underwater fog (it already does). */
  setUnderwater(on: boolean): void;
  /** Cutaway support (playtest rounds 2–4): discard the sea (a) inside the
   *  ship's footprint, so the hull never reads "full of ocean", and (b) in a
   *  BOUNDED wedge on the camera side of the cut plane, so the exterior sea
   *  can't occlude the view into the hull from low angles. Unlike clip
   *  planes this never splits the ocean to the horizon. */
  setCutaway(on: boolean): void;
  /** Size the cutaway hole/wedge for the ship being inspected (half-length,
   *  half-beam in meters — the brig and the sloop differ). */
  setFootprint(halfL: number, halfB: number): void;
  updateCutaway(shipPos: THREE.Vector3, fwdX: number, fwdZ: number, cutPlane: THREE.Plane): void;
  /** Feed a ship's state once per frame (slot 0 = player, 1 = enemy): drives
   *  the bow swell (the sea genuinely lifts at the stem), the white water
   *  shouldered along the forward flanks, and a stern trail the foam laces
   *  between — a wake that follows the actual path sailed, curves and all
   *  (round 6: the old white water "appeared painted onto the ship"). */
  updateShipWake(
    slot: number,
    centerX: number,
    centerZ: number,
    fwdX: number,
    fwdZ: number,
    speed: number,
    halfL: number,
    halfB: number,
    time: number,
    /** World-Y of the keel bottom and the deck top: the sea is removed only
     *  within the footprint AND between these (round 10) — no white void under
     *  a lifted hull, no ocean in the hold. */
    keelWorldY: number,
    deckWorldY: number,
  ): void;
  /** P4: bind a hull's per-column keel/deck profile (built once from the voxel grid via
   *  buildHullProfile) and its local span into the per-slot atlas band, activating that slot's
   *  voxel-accurate cut. `data` is nx*nz*3 floats [keelYLocal, deckYLocal, sealFlag]; works for ANY slot. */
  setHullProfile(slot: number, data: Float32Array, nx: number, nz: number, sizeX: number, sizeZ: number): void;
  /** P4: feed a hull's live world→local rotation (inverse of the body quaternion)
   *  and world translation each frame, per slot, so its cut tracks heave/pitch/roll.
   *  `seaY` is the live Gerstner surface world-Y at the hull's centre — the waterline the
   *  open-breach cut tests against (cutout task): the cut is drawn over an intact deck above
   *  this level, and over an OPEN hole only where it straddles this level. */
  updateHullPose(slot: number, invRot: THREE.Matrix3, trans: THREE.Vector3, seaY: number): void;
  /** Free a per-ship slot so the shader skips it (sets halfL<0.5 + profileOn=0). */
  clearSlot(slot: number): void;
  /** Clear the stern-trail ribbon for a premium slot (0|1) on reassignment. */
  resetTrail(slot: number): void;
  /** P5: bind the dynamic-wave interaction field (src/render/dynamicWaves.ts). Its
   *  R-channel height is summed onto the surface in VERT and the legacy analytic
   *  collar/bow mounds cross-fade down where it is active. Pass the field texture, its
   *  world-space window size (m) and its current snapped origin (window min-corner XZ)
   *  each frame. Call with on=false to disable (falls back to the analytic mounds). */
  setDynamicField(tex: THREE.Texture | null, windowSize: number, originX: number, originZ: number, on: boolean, scale?: number): void;
  /** dev-panel chop controls: overall strength (0 = pure swell) + crest-pinch choppiness. */
  setChop(strength: number, choppiness: number): void;
  /** Bind the live sky+cloud reflection cube (render/sky.ts envCube.texture). The
   *  surface then mirrors the real sky gradient, sun and clouds (Fresnel-weighted). */
  setSkyEnv(tex: THREE.Texture): void;
  /** dev-panel reflection strength (0 = matte water, 1 = full Fresnel reflection) +
   *  the HDR clamp on the reflected sky (caps a bright sky from whiting out the sea). */
  setReflStrength(strength: number, clamp?: number): void;
  /** dev-panel underwater-visibility controls: how many metres of water you can see
   *  down before the sea is fully opaque (`visibility`), and how see-through the
   *  shallow band gets (`clarity` 0 = off/current look, 1 = max). */
  setWaterDepth(visibility: number, clarity: number): void;
  /** Set the distance-fog colour. main.ts feeds the sky's HORIZON_COLOR so the far sea
   *  fades into the sky's horizon band seamlessly — no void box, no floating islands. */
  setFogColor(color: THREE.Color): void;
  /** Bind the static land-height field (src/game/islandField.ts buildLandField) so the
   *  surface shoals — wave displacement tapers to flat at each coast (no waves clipping
   *  through islands) — and a surf-foam line draws where the sea meets land. `min`/`size`
   *  give the field's world-XZ origin + extent. Call once at startup. */
  setLandField(tex: THREE.Texture, minX: number, minZ: number, sizeX: number, sizeZ: number): void;
}

function waveUniforms(waves: Wave[]) {
  const a: THREE.Vector4[] = [];
  const b: THREE.Vector2[] = [];
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    // steepness IS the per-wave Q — identical to sim/gerstner.ts displace()
    const q = Math.min(w.steepness, 1);
    a.push(new THREE.Vector4(w.dirX, w.dirZ, w.amplitude, k));
    b.push(new THREE.Vector2(q * w.amplitude, k * w.phaseSpeed));
  }
  return { a, b };
}

/** Camera-centered polar grid: exponential ring spacing, fine in close. */
function makePolarGrid(): THREE.BufferGeometry {
  const positions = new Float32Array((RINGS * SECTORS + 1) * 3);
  let vi = 1; // index 0 is the center vertex at the origin
  for (let j = 0; j < RINGS; j++) {
    const r = R_NEAR * Math.pow(R_FAR / R_NEAR, j / (RINGS - 1));
    for (let s = 0; s < SECTORS; s++) {
      const ang = (s / SECTORS) * Math.PI * 2;
      positions[vi * 3] = Math.cos(ang) * r;
      positions[vi * 3 + 2] = Math.sin(ang) * r;
      vi++;
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < SECTORS; s++) {
    idx.push(0, 1 + ((s + 1) % SECTORS), 1 + s); // center fan
  }
  for (let j = 0; j < RINGS - 1; j++) {
    const r0 = 1 + j * SECTORS;
    const r1 = r0 + SECTORS;
    for (let s = 0; s < SECTORS; s++) {
      const s1 = (s + 1) % SECTORS;
      idx.push(r0 + s, r0 + s1, r1 + s1, r0 + s, r1 + s1, r1 + s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(idx);
  return geo;
}

const VERT = /* glsl */ `
#include <clipping_planes_pars_vertex>
uniform float uTime;
uniform vec4 uWaveA[NWAVES]; // dirX, dirZ, amplitude, k
uniform vec2 uWaveB[NWAVES]; // qa, omega
uniform vec4 uShipA[MAXVIS]; // bow x, bow z, fwdX, fwdZ
uniform vec4 uShipB[MAXVIS]; // speed, halfL, halfB, 0
uniform sampler2D uCascadeDisp[NCASC]; // per-cascade chop displacement (RGB = Dx, height, Dz)
uniform float uCascadeTile[NCASC]; // per-cascade world tile size (m)
uniform float uCascadeChop[NCASC]; // per-cascade horizontal choppiness λ
uniform float uFftOn; // 1 when the cascade backend is live, else 0
uniform float uChopScale; // dev: overall chop height/strength (0 = pure swell)
uniform float uChoppiness; // dev: crest-pinch (horizontal choppiness) multiplier

// SHORE shoaling field (src/game/islandField.ts): R = terrain-top world-Y (m), deep sea ≈ -100,
// bled outward a little past each coast for a smooth ramp. Used to taper the visual wave
// displacement to ~0 as the seabed shoals up to the beach, so the sea meets land cleanly
// instead of crests/troughs clipping straight through the island. VISUAL ONLY (physics never
// samples this mesh — it rides the analytic swell), so THE LAW #1 holds.
uniform sampler2D uLandTex;
uniform vec2 uLandMin;  // world XZ of the field's min corner
uniform vec2 uLandSize; // world XZ extent the field spans
uniform float uLandOn;  // 1 when a land field is bound

// P5 dynamic-wave interaction field (Crest/Atlas FDTD ping-pong, src/render/
// dynamicWaves.ts). A camera-centred height/velocity field the ships stamp their
// waterline footprint into — the bow push, the side bulge, the stern contrail.
// R = surface height (m). Sampled at (worldXZ − origin)/window. VISUAL ONLY: the
// hull still floats on the analytic swell (physics never samples this).
uniform sampler2D uDynDisp; // R = dynamic-wave height (m)
uniform vec2 uDynOrigin; // window min-corner world XZ
uniform float uDynWindow; // window size (m)
uniform float uDynOn; // 1 when the dynamic-wave field is live, else 0
uniform float uDynScale; // dev-tunable strength of the field's surface displacement

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCrest;

void main() {
  vec3 rest = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 p = rest;
  float nx = 0.0;
  float nz = 0.0;
  float ny = 1.0;
  float crest = 0.0;
  // distance from the camera (the mesh is camera-centered, so the LOCAL
  // radius is exactly it) — used to fade each wave out before the ring
  // spacing under-samples it into shimmer
  float rDist = length(position.xz);

  for (int i = 0; i < NWAVES; i++) {
    vec2 dir = vec2(uWaveA[i].x, uWaveA[i].y);
    float k = uWaveA[i].w;
    float lam = 6.28318530718 / k;
    float fade = 1.0 - smoothstep(lam * 6.0, lam * 14.0, rDist);
    if (fade <= 0.001) continue;
    float amp = uWaveA[i].z * fade;
    float qa = uWaveB[i].x * fade;
    float omega = uWaveB[i].y;

    float phase = k * dot(dir, rest.xz) - omega * uTime;
    float c = cos(phase);
    float s = sin(phase);

    p.x += dir.x * qa * c;
    p.z += dir.y * qa * c;
    p.y += amp * s;

    nx -= dir.x * k * amp * c;
    nz -= dir.y * k * amp * c;
    ny -= k * qa * s;
    crest += (s * 0.5 + 0.5) * amp;
  }

  // Round 14: sum the MULTI-CASCADE FFT chop on top of the analytic swell. Each
  // cascade is its own band-windowed Tessendorf tile at a non-commensurate size
  // (~40/18/7 m), so the sum never tiles into a grid, and each band moves at its
  // own physically-correct speed. Per-cascade choppiness λ pinches crests sharp
  // and crossing — the AC4 / Sea-of-Thieves "crashing waves" look. The cascades
  // are band-split BELOW the analytic swell, so the hull stays welded to the swell
  // it floats on (physics samples only the analytic swell, never these).
  // UNROLLED with CONSTANT sampler indices: ANGLE (Windows) rejects indexing a
  // sampler array with a loop variable in GLSL ES 1.00 — a for-loop here silently
  // invalidates the WHOLE ocean program (the sea vanishes). Constant [0]/[1]/[2],
  // #if-guarded by NCASC. Adding a 4th cascade means adding a block here + below.
  if (uFftOn > 0.5) {
    // dev chop knobs: uChopScale scales the whole cascade contribution (0 = pure
    // swell, the player's "play with the chop" + jitter-bisect tool); uChoppiness
    // scales only the horizontal crest-pinch (sharpness) without changing height.
    float chopFade = (1.0 - smoothstep(120.0, 280.0, rDist)) * uChopScale;
    float cz = uChoppiness;
    vec3 d;
    d = texture2D(uCascadeDisp[0], rest.xz / uCascadeTile[0]).xyz;
    p.x += d.x * chopFade * uCascadeChop[0] * cz; p.z += d.z * chopFade * uCascadeChop[0] * cz; p.y += d.y * chopFade; crest += max(d.y, 0.0) * chopFade;
    #if NCASC > 1
    d = texture2D(uCascadeDisp[1], rest.xz / uCascadeTile[1]).xyz;
    p.x += d.x * chopFade * uCascadeChop[1] * cz; p.z += d.z * chopFade * uCascadeChop[1] * cz; p.y += d.y * chopFade; crest += max(d.y, 0.0) * chopFade;
    #endif
    #if NCASC > 2
    d = texture2D(uCascadeDisp[2], rest.xz / uCascadeTile[2]).xyz;
    p.x += d.x * chopFade * uCascadeChop[2] * cz; p.z += d.z * chopFade * uCascadeChop[2] * cz; p.y += d.y * chopFade; crest += max(d.y, 0.0) * chopFade;
    #endif
  }

  // P5: sum the DYNAMIC-WAVE interaction height (the GPU FDTD field the ships stamp
  // their footprint into — bow push, side bulge, stern contrail) on top of the swell
  // + cascades, AFTER the cascade sum. Sampled at (worldXZ − origin)/window from the
  // camera-centred field. dynMix fades to 0 toward the window edge (and is 0 when the
  // field is off), and ALSO cross-fades the legacy analytic collar/bow Gaussians DOWN
  // (below) so the two systems don't double-count the hull's bulge — the dynamic field
  // takes over near the ship, the analytic mounds fade out.
  float dynMix = 0.0;
  if (uDynOn > 0.5) {
    vec2 duv = (rest.xz - uDynOrigin) / uDynWindow;
    if (duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) {
      vec2 dEdge = min(duv, 1.0 - duv);
      dynMix = smoothstep(0.0, 0.04, min(dEdge.x, dEdge.y));
      float dynH = texture2D(uDynDisp, duv).r * uDynScale;
      p.y += dynH * dynMix;
      crest += max(dynH, 0.0) * dynMix;
    }
  }

  // the hull's effect on the sea: a STANDING displacement collar at all times
  // (round 9: "real boats have an effect on the water … make it bulge as it
  // displaces it"), plus the speed-driven bow wave on top.
  for (int s2 = 0; s2 < MAXVIS; s2++) {
    float hL = uShipB[s2].y;
    if (hL < 0.5) continue; // unused/uninitialised slot
    float hB = uShipB[s2].z;
    float spd = uShipB[s2].x;
    vec2 bow = uShipA[s2].xy;
    vec2 f2 = uShipA[s2].zw;
    vec2 rel = p.xz - (bow - f2 * hL); // from hull center
    float along = dot(rel, f2);
    float across = dot(rel, vec2(-f2.y, f2.x));

    // displacement collar: rr = 1 at the waterline-ellipse edge; the sea
    // mounds in a ridge just OUTSIDE it (inside is discarded as the dry hull)
    // and falls away both directions — the water the hull shoves aside has to
    // pile up somewhere, moving or not.
    // P5 cross-fade: where the dynamic-wave field is active (dynMix→1) the GPU FDTD
    // field now carries the hull's bulge, so fade these legacy analytic mounds DOWN
    // to avoid double-counting (the field is gated OFF → aMix=1 → unchanged look).
    float aMix = 1.0 - dynMix;
    float rr = sqrt((along / hL) * (along / hL) + (across / hB) * (across / hB));
    float collar = exp(-pow((rr - 1.08) / 0.17, 2.0));
    p.y += collar * 0.22 * aMix;
    crest += collar * 0.18 * aMix;

    // bow wave: the stem physically shoulders water aside — a mound at the
    // cutting point spilling into a ridge down the forward flanks, which the
    // fragment stage froths into the wake (round 6.5, beefed up round 8:
    // "the front of the ship actually pushing up and bulging the water")
    if (spd < 1.0) continue;
    float sF = clamp(spd / 8.0, 0.0, 1.2);
    float bd2 = dot(p.xz - bow, p.xz - bow);
    p.y += sF * 1.05 * exp(-bd2 / 5.5) * aMix;
    float ridge = exp(-pow((abs(across) - (hB + 0.4)) / 1.5, 2.0));
    float span = smoothstep(-hL * 0.35, hL * 0.55, along) * (1.0 - smoothstep(hL * 0.8, hL * 1.1, along));
    p.y += sF * 0.5 * ridge * span * aMix;
    // the GEOMETRY is the show now — foam only laces it (the first cut
    // painted the whole bow quarter white)
    crest += sF * (0.45 * exp(-bd2 / 5.5) + 0.28 * ridge * span) * aMix;
  }

  // SHORE SHOALING: as the seabed rises toward a coast, taper the wave displacement back to
  // the rest (flat sea-level) position so the surface goes calm-and-flat at the beach instead
  // of waves cutting through the island. shoal = 1 in deep water → 0 at the shoreline.
  if (uLandOn > 0.5) {
    vec2 luv = (rest.xz - uLandMin) / uLandSize;
    if (luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) {
      float landY = texture2D(uLandTex, luv).r * 160.0 - 100.0; // decode terrain-top world-Y (m); deep sea ≈ -100
      // GRADUAL shoaling: the swell eases down to calm over a ~4.5 m depth band approaching each coast,
      // instead of the 1.3 m hard ring that "abruptly cut off" the waves at the island edge (playtest).
      // Full waves by ~4.5 m of depth → glassy-calm right at the wet sand. The water is OPAQUE now (the
      // see-through void was fixed), so the calmed band reads as a sheltered shore, not a flat navy moat.
      // Paired with the deleted shore surf-foam line (no white ring) in the fragment stage.
      float shoal = clamp((0.0 - landY) / 4.5, 0.0, 1.0); // 0 at the waterline … 1 by 4.5 m depth
      shoal = shoal * shoal * (3.0 - 2.0 * shoal);   // smootherstep so the calming eases in
      p = mix(rest, p, shoal);                       // pull the surface back to flat near land
      crest *= shoal;
      nx *= shoal;
      nz *= shoal;
    }
  }

  vWorldPos = p;
  vNormal = normalize(vec3(nx, ny, nz));
  vCrest = crest;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  #include <clipping_planes_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAG = /* glsl */ `
#include <clipping_planes_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSkyColor;
uniform samplerCube uSkyEnv;   // live sky+cloud reflection cube (render/sky.ts)
uniform float uHasEnv;         // 1 when uSkyEnv is bound, else fall back to uSkyColor
uniform float uReflStrength;   // dev: overall reflection strength
uniform float uReflClamp;      // dev: cap on reflected HDR (stops a bright sky → white water)
uniform float uWaterVis;     // metres of water column visible before fully opaque
uniform float uWaterClarity; // 0 = depth-murk OFF (current look), 1 = maximally see-through
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogStart;   // metres of crystal-clear water before the distance haze begins
uniform float uAmpTotal;
uniform vec3 uCameraPos;
uniform float uTime;
uniform sampler2D uCascadeNormal[NCASC]; // per-cascade surface normal (RGB = normal*0.5+0.5)
uniform sampler2D uCascadeFoam[NCASC]; // per-cascade Jacobian foam (R)
uniform float uCascadeTile[NCASC]; // per-cascade world tile size (m)
uniform float uFftOn; // 1 when the cascade backend is live, else 0
// P5: the dynamic-wave interaction field again (FRAG side), for its FOAM channel —
// the whitewater the ships churn up (bow/side/stern) and where GPU spray lands. B =
// foam coverage. Sampled at (worldXZ − origin)/window, gated by uDynOn.
uniform sampler2D uDynDisp; // B = dynamic-wave foam coverage
uniform vec2 uDynOrigin;
uniform float uDynWindow;
uniform float uDynOn;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCrest;

// cheap value noise for foam break-up
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

uniform float uCutOn;
uniform vec2 uShipPos; // world xz of the cutaway ship
uniform vec2 uFwd; // unit fore-aft axis, world xz
uniform vec2 uHalf; // half-length, half-beam of the footprint
uniform vec4 uCutPlane; // xyz = normal, w = constant (THREE.Plane form)
uniform vec4 uShipA[MAXVIS]; // bow x, bow z, fwdX, fwdZ
uniform vec4 uShipB[MAXVIS]; // speed, halfL, halfB, 0
uniform vec2 uShipC[MAXVIS]; // keel world-Y, deck-top world-Y (hull vertical span)
uniform vec4 uTrail[64]; // stern-path points: x, z, age (s), strength

// P4 voxel-accurate, attitude-aware in-hull cut — for EVERY ship (player + all enemies; they are
// the same class of object, so they cut the sea the same way). Each live slot poses the sea fragment
// into THAT hull's LOCAL frame and tests a per-column keel/deck height-field — so every hull cuts
// the sea by its true voxel plan AND heave/pitch/roll, and no ship falls back to the flat analytic
// ellipse. The per-ship keel/deck textures are packed into ONE atlas banded vertically by slot (band
// s occupies uv.y∈[s,s+1]/MAXVIS); a single sampler2D read at a COMPUTED coordinate sidesteps GLSL
// ES 1.00's no-dynamic-sampler-index rule (the non-sampler arrays below are loop-indexed fine, as
// uShipA/uShipB already are).
uniform float uProfileOn[MAXVIS];    // 1 per slot when that hull's profile cut is live
uniform sampler2D uProfileAtlas;     // RGB = keelYLocal, deckYLocal, sealYLocal (m); band s = slot s's hull profile
uniform mat3 uProfileInvRot[MAXVIS]; // world→local rotation per slot (inverse body quat)
uniform vec3 uProfileTrans[MAXVIS];  // body world translation per slot (= local origin)
uniform vec2 uProfileSize[MAXVIS];   // local span (m) per slot (uv = localXZ / size)
uniform float uProfileSeaY[MAXVIS];  // live Gerstner surface world-Y at each hull's centre (the waterline)

// shore shoaling field (same texture as the vertex stage) — drives the surf-foam line.
uniform sampler2D uLandTex;
uniform vec2 uLandMin;
uniform vec2 uLandSize;
uniform float uLandOn;

void main() {
  #include <clipping_planes_fragment>

  // world-Y of the SHALLOWEST solid beneath this fragment (a submerged hull/deck from the
  // cut loops below, or the island seabed). Stays very low where nothing is in range (open
  // deep water) so the depth-murk at the end leaves those fragments fully opaque, unchanged.
  // It drives the translucent depth-fade so a sinking hull DISSOLVES into the sea (no void).
  float floorY = -1000.0;

  // dry bilges, ALWAYS: the sea does not exist inside an intact hull. The
  // surface is discarded within each ship's waterline ellipse so the hold
  // shows timber, not "the wake and the water flowing by" through the hatch
  // (round 7). uShipB[s].w fades to 0 as she floods — the sea closes back in.
  // P4: any slot with a live voxel-accurate profile is cut below instead, so skip
  // its analytic ellipse here. Both ships now carry a profile — the ellipse is only
  // a fallback for a slot whose profile failed to bind.
  for (int s0 = 0; s0 < MAXVIS; s0++) {
    if (uProfileOn[s0] > 0.5) continue;
    float keelY = uShipC[s0].x;
    float deckY = uShipC[s0].y;
    if (deckY <= keelY) continue; // unused slot
    vec2 f0 = uShipA[s0].zw;
    vec2 ctr = uShipA[s0].xy - f0 * uShipB[s0].y;
    vec2 rel0 = vWorldPos.xz - ctr;
    float al0 = dot(rel0, f0) / max(uShipB[s0].y * 0.97, 0.1);
    float ac0 = dot(rel0, vec2(-f0.y, f0.x)) / max(uShipB[s0].z * 0.92, 0.1);
    // remove ONLY the sea that is genuinely inside the hull volume: within the
    // waterline footprint AND between the keel and the deck (round 10). A flat
    // 2D cut showed the white void under a lifted hull and let ocean waves into
    // the hold while sinking; the vertical gate fixes both — below the keel the
    // sea shows under the hull (no void), the hold never shows ocean (flooding
    // is the separate water-box system), and the sea closes over a sunk wreck.
    // Upper bound is deckY + freeboard, NOT deckY: a wave crest taller than the
    // instantaneous deck height used to escape this gate and render right through
    // the planking (the "ocean clipping through the deck" green-water bug — worse
    // now the chop is rougher). The +3 m ceiling clears the tallest chop while a
    // hull that has SUNK well below the sea still lets the water close over it.
    // taper the cut to the actual hull PLAN (pointed bow/stern), not a fat ellipse.
    // A full-width ellipse discarded sea OUTSIDE the narrow stem, leaving the void
    // crescents at the bow ("the void is visible from directly above, and a few other
    // angles"). beamProfile narrows the cut toward the ends so it follows the timber.
    float along2 = al0 * al0;
    float beamProfile = (1.0 - along2) * (0.5 + 0.5 * (1.0 - along2));
    if (along2 < 1.0 && ac0 * ac0 < beamProfile && vWorldPos.y > keelY && vWorldPos.y < deckY + 2.0) {
      if (deckY > uProfileSeaY[s0]) discard; // dry deck → cut the sea (no ocean in the hold)
      else floorY = max(floorY, deckY);      // submerged → record the deck top as the column floor
    }
  }

  // P4 voxel-accurate cut — EVERY hull. Pose this fragment into each live hull's LOCAL frame and
  // decide, PER COLUMN, whether to cut the sea. The full inverse transform folds in heave/pitch/roll,
  // so no void reveals as a ship bobs, and the per-column profile follows the true voxel plan (the
  // pointed bow). Every live slot reads its own band of the profile atlas, so all ships cut identically.
  //
  // CUTOUT TASK (2026-06-16): the cut is restricted to where it is actually needed instead of the whole
  // above-water silhouette. Per column the atlas carries keel (R), deck (G), and a SEAL FLAG (B): B is
  // the deck-Y for a SEALED column (the deck planking still caps it) and a large negative sentinel for
  // an OPEN one (the deck/upper skin over that column is carved away). Using the live waterline
  // uProfileSeaY[s] at the hull centre:
  //   • SEALED column, deck ABOVE water → cut (discard): no ocean washing over the sound, sealed deck.
  //   • SEALED column, deck SUBMERGED   → don't cut; the sea closes over it (depth-fade), as before.
  //   • OPEN column → never cut: let the sea render straight into the hole (it fades over the surviving
  //     floor). So a hole above water shows air, a hole at/under the waterline shows the sea continuing
  //     in, and a hole fully under just submerges. The intact deck spanning a sinking ship's U of open
  //     breaches still cuts (SEALED rule), so the whole U reads as one clean cutout — the user's U-shape
  //     exception falls out with no special case. (A SIDE hole under an intact deck plank stays SEALED,
  //     so it shows the hull side / submerges and gets no spurious cutout — "underwater just goes under".)
  for (int s = 0; s < MAXVIS; s++) {
    if (uProfileOn[s] < 0.5) continue;
    vec3 lp = uProfileInvRot[s] * (vWorldPos - uProfileTrans[s]);
    vec2 puv = vec2(lp.x / uProfileSize[s].x, lp.z / uProfileSize[s].y);
    if (puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) {
      vec3 kds = texture2D(uProfileAtlas, vec2(puv.x, (puv.y + float(s)) / float(MAXVIS))).rgb; // keel, deck, sealFlag
      float keelL = kds.x, deckL = kds.y, sealFlag = kds.z;
      if (deckL > keelL && lp.y > keelL) {
        // world height of this column's deck top (local→world Y = trans.y + dot(R⁻¹'s y-row, localPt)).
        float deckWY = uProfileTrans[s].y + dot(uProfileInvRot[s][1], vec3(lp.x, deckL, lp.z));
        float seaY = uProfileSeaY[s];
        bool open = sealFlag < -500.0; // HULL_PROFILE_OPEN sentinel (≈ -1000) → the deck here is carved away
        if (open) {
          // OPEN breach: the deck/upper skin over this column is gone, but the hull SIDES below may
          // still stand. The exterior sea is only physically continuous with the hull interior UP TO
          // the waterline — above it, that interior volume belongs to the (separate, dark) flood pool
          // and the surviving timber. So CUT the open ocean wherever this fragment sits ABOVE the live
          // waterline inside the footprint: that band is the "strip of bright open-ocean wave surface
          // floating above the flood line / poking through the hull sides" the playtest reported (the
          // displaced swell + crests rising over seaY, framed by the intact upper hull). Below the
          // waterline the sea legitimately flows into the breach — keep it, and record the surviving
          // floor so it depth-fades into the interior as before.
          if (vWorldPos.y > seaY) discard; // crest/surface above the waterline inside the hull → no bleed-through strip
          else if (deckWY <= seaY) floorY = max(floorY, deckWY);
        } else {
          // SEALED deck: cut above the waterline, fade when submerged (the original behaviour).
          if (deckWY > seaY) discard;
          else floorY = max(floorY, deckWY);
        }
      }
    }
  }

  // (REMOVED 2026-06-16) island SEABED contributor to the water column. It raised floorY from the
  // BLED land-field in a wide apron AROUND each island — far beyond the island's actual underwater
  // mesh — so the depth-fade turned the sea TRANSLUCENT there with NO geometry behind it, revealing
  // the sky backdrop: the "light see-through void cutout" ringing every island (verified real-GPU A/B
  // on clarity). The sea near islands is now OPAQUE ("coloured underneath", as intended). Submerged
  // HULLS still dissolve — their floorY comes from the per-hull profile cut above, which is REAL
  // geometry the translucent water is actually in front of. The land-field still drives the VERTEX
  // shoaling (waves taper to the shore) and the surf-foam line below; only this see-through floor is gone.

  // cutaway: the sea over the hull footprint is removed outright (the hold
  // is air, not water); the bounded wedge on the camera side of the cut
  // goes TRANSLUCENT — "make the ocean transparent … so that you can see
  // down to where the water level is" (playtest), with no black void
  float cutAlpha = 1.0;
  if (uCutOn > 0.5) {
    vec2 rel = vWorldPos.xz - uShipPos;
    float along = dot(rel, uFwd);
    float across = dot(rel, vec2(-uFwd.y, uFwd.x));
    if (abs(along) < uHalf.x) {
      if (abs(across) < uHalf.y) discard;
      if (abs(across) < uHalf.y * 4.5 &&
          dot(vWorldPos, uCutPlane.xyz) + uCutPlane.w < 0.0) {
        cutAlpha = 0.22;
      }
    }
  }

  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 L = normalize(uSunDir);

  // Round 14: the shading normal (drives the sun specular) = the smooth analytic
  // swell normal N + the summed slopes of the FFT CASCADES — the REAL surface
  // normal now, not the value-noise hack. Three non-commensurate cascade tiles
  // never align their texel lattices, so the glints scatter organically and the
  // grid that plagued a single 1 m/texel normal map is gone by construction. The
  // detail fades out by distance so the far field doesn't moiré. r1/r2 are kept
  // for the foam-detail breakup below.
  mat2 r1 = mat2(0.878, -0.479, 0.479, 0.878);   // ~0.50 rad
  mat2 r2 = mat2(-0.737, -0.675, 0.675, -0.737); // ~2.40 rad
  vec3 nSum = vec3(0.0);
  if (uFftOn > 0.5) {
    float dCam = length(uCameraPos - vWorldPos);
    float nFade = 1.0 - smoothstep(70.0, 240.0, dCam);
    // grazing fade: a tiled normal under a sharp specular ALWAYS shows its texel
    // lattice at grazing incidence (the near-field crosshatch). Fade the normal
    // detail to 0 as the view grazes — there the water is a near-mirror of the sky
    // anyway, so it reads correct, and the grid foreground is gone.
    float graze = smoothstep(0.04, 0.32, max(dot(N, V), 0.0));
    nFade *= graze;
    // per-cascade weights: the COARSE tile's normal is safe (0.31 m/texel), but the
    // FINER tiles (0.14 / 0.055 m/texel) catch the grazing specular as a crosshatch
    // lattice — the grid nemesis. Downweight the fine cascades hard for SHADING;
    // their chop SHAPE is already in the geometry, so the sea still reads sharp.
    // PERF: the cascade-normal detail is scaled by nFade, which is 0 for the far/grazing water that
    // fills most of the screen — so skip the 3 dependent texture fetches there entirely (output is
    // bit-identical, they were multiplied to ~0 anyway). Pure fill savings on the dominant ocean pass.
    if (nFade > 0.001) {
      vec3 cn;
      cn = texture2D(uCascadeNormal[0], vWorldPos.xz / uCascadeTile[0]).xyz * 2.0 - 1.0; nSum += vec3(cn.x, 0.0, cn.z) * 1.0;
      #if NCASC > 1
      cn = texture2D(uCascadeNormal[1], vWorldPos.xz / uCascadeTile[1]).xyz * 2.0 - 1.0; nSum += vec3(cn.x, 0.0, cn.z) * 0.55;
      #endif
      #if NCASC > 2
      cn = texture2D(uCascadeNormal[2], vWorldPos.xz / uCascadeTile[2]).xyz * 2.0 - 1.0; nSum += vec3(cn.x, 0.0, cn.z) * 0.28;
      #endif
      nSum *= nFade * 0.7;
    }
  }
  vec3 Nd = normalize(N + nSum);

  // base water color: deeper where we look straight down, lighter at grazing
  float facing = max(dot(N, V), 0.0);
  vec3 water = mix(uShallowColor, uDeepColor, facing);

  // fresnel reflection of the REAL sky: reflect the view across the wave-detailed
  // normal Nd and sample the sky+cloud env cube (render/sky.ts), so the sea mirrors
  // the actual sky gradient, sun and drifting clouds — distorted by the swell. The
  // flat uSkyColor constant is the fallback when the cube isn't bound yet.
  float fresnel = pow(1.0 - facing, 5.0);
  vec3 R = reflect(-V, Nd);
  R.y = max(R.y, 0.02); // keep the reflected ray in the sky hemisphere
  vec3 skyRefl = (uHasEnv > 0.5) ? textureCube(uSkyEnv, R).rgb : uSkyColor;
  // cap the reflected HDR: the sky env cube runs far past 1 near the sun, and a
  // near-mirror grazing surface would otherwise reflect a sheet of white "liquid
  // metal". Clamping keeps a bright sky reading as a bright sheen, not a blowout.
  skyRefl = min(skyRefl, vec3(uReflClamp));
  float reflF = clamp((fresnel * 0.85 + 0.05) * uReflStrength, 0.0, 1.0);
  vec3 col = mix(water, skyRefl, reflF);

  // sun glints — a BROAD glitter path, never a pinpoint. A tight pow-220 highlight
  // on the animated chop normal lit one texel and not its neighbour and flipped
  // every frame: that is the "checkerboard" lattice that read as the whole ocean
  // vibrating. Wide lobes (pow 38/11) spread the energy across many texels so it
  // reads as a smooth sun-on-water path that holds still in motion.
  vec3 H = normalize(L + V);
  float ndh = max(dot(Nd, H), 0.0);
  float spec = pow(ndh, 48.0) * 0.15 + pow(ndh, 14.0) * 0.04;
  col += uSunColor * spec;

  // subsurface light through wave crests facing the sun
  float sss = pow(max(dot(V, -L), 0.0), 3.0) * smoothstep(0.3, 1.0, vCrest / uAmpTotal);
  col += vec3(0.05, 0.18, 0.16) * sss;

  // THE CAMO LIVED HERE. This block whitened every wave whose crest passed a height
  // threshold (crestF > 0.62), broken up by low-frequency value-noise — which is, by
  // construction, a camouflage pattern. That is the "solid texture that gets applied
  // after the waves reach a certain height" the playtest kept rejecting. Removed
  // outright. Open water carries NO height-triggered foam now; whitewater comes only
  // from the ship wake below and the breaking-crest spray particles.

  // ship wash: (a) churned white along the forward hull flanks where the
  // stem shoulders the sea aside, (b) a turbulent trail laced between the
  // recorded stern-path points — it follows the actual track, curves and
  // all, widening and fading as it ages (round 6: "leaving a wake behind")
  float wash = 0.0;
  for (int s = 0; s < MAXVIS; s++) {
    float spd = uShipB[s].x;
    if (spd < 1.0) continue;
    vec2 fwd2 = uShipA[s].zw;
    vec2 bow = uShipA[s].xy;
    float hL = uShipB[s].y;
    float hB = uShipB[s].z;
    vec2 rel = vWorldPos.xz - (bow - fwd2 * hL);
    float along = dot(rel, fwd2);
    float across = dot(rel, vec2(-fwd2.y, fwd2.x));
    float sF = clamp(spd / 8.0, 0.0, 1.2);
    // froth grows continuously from a sliver at the stem to a full churned
    // band by the stern — no hard cutoffs (round 6.5: the froth "abruptly
    // cuts off slightly ahead of the ship and at the halfway mark")
    float inHull = smoothstep(hL * 1.25, hL * 0.95, along) * smoothstep(-hL * 1.35, -hL * 0.6, along);
    float devel = 1.0 - smoothstep(-hL * 0.55, hL * 1.1, along); // 0 at stem → 1 astern
    float taper = 1.0 - 0.5 * smoothstep(hL * 0.3, hL * 1.05, along);
    float edge = abs(across) - (hB * taper + 0.2);
    float bandW = mix(0.5, hB * 0.9, devel);
    wash += sF * (0.3 + 0.7 * devel) * inHull * exp(-pow(max(edge, 0.0) / bandW, 2.0));
  }

  // (REMOVED 2026-06-16, round 2) the ALWAYS-ON white waterline foam RING around every hull. It traced
  // a bright white line hugging the hull-cutout edge that the player said "appears white and totally
  // negates all of the work we did to make a nice hole cutout" — so the sea now meets the clean cut with
  // NO ring. Cutting it also drops up to MAXVIS×5 profile-atlas texture taps + a per-slot ellipse pass
  // PER ocean fragment (a real, free fill saving on the whole sea plane). The hull mesh fills the hole;
  // a subtle NON-white wet darkening could be re-added later, but the player wants the hole read clean.

  // (REMOVED 2026-06-16) the shore surf-foam line. It drew a bright white ring in the shallow band
  // around every coast — the "white line of wake that abruptly cuts off" the waves at the island edge
  // (playtest: "if we just got rid of that white wake it would go a long way"). The sea now eases to
  // calm at the shore by the VERTEX shoaling alone (gradual, no ring), and dropping it saves a
  // per-near-island texture tap. Whitewater still comes from the ship wake above.

  for (int i = 0; i < 63; i++) {
    if (i == 31) continue; // slot boundary: don't lace ship 0's tail to ship 1's head
    vec4 A = uTrail[i];
    vec4 B = uTrail[i + 1];
    if (A.w <= 0.0 || B.w <= 0.0) continue;
    vec2 ab = B.xy - A.xy;
    float L2 = dot(ab, ab);
    if (L2 < 0.04 || L2 > 400.0) continue;
    float h = clamp(dot(vWorldPos.xz - A.xy, ab) / L2, 0.0, 1.0);
    float dseg = length(vWorldPos.xz - (A.xy + ab * h));
    float ageM = mix(A.z, B.z, h);
    // the wake leaves the stern at FULL ship beam and spreads as it ages;
    // fresh segments RAMP IN over a third of a second instead of popping
    // into existence at full strength (round 8: "the wake … is not very
    // smooth and is also stuttering") — the hull-flank wash band covers the
    // first meters astern while they fade up
    float hb2 = i < 32 ? uShipB[0].z : uShipB[1].z;
    // r17: a feathering displacement wake — width grows gently (0.35/s, was 0.75 = a
    // spreading delta) and the foam fades fast (e^-0.5·age, was 0.24) so the tail tapers
    // to nothing within ~1 hull length instead of trailing wide and bright like a planing
    // speedboat. Fresh segments still ramp in over a third of a second (no popping).
    float width = hb2 + 0.3 + ageM * 0.35;
    wash += exp(-pow(dseg / width, 2.0)) * exp(-ageM * 0.5) * mix(A.w, B.w, h)
          * smoothstep(0.0, 0.35, ageM);
  }
  // break the wash up so it reads as churned water, not paint
  wash *= 0.5 + 0.5 * noise(vWorldPos.xz * 1.6 + uTime * 0.45);

  // r16: ALL open-water foam REMOVED — the cascade Jacobian "crestFoam" and the
  // dynamic-field "dynFoam" both gone (the player: "the foam mechanic is awful, remove
  // it completely and re-implement later"). Only the ship WASH (wake flanks + waterline
  // lace + stern trail, built above) whitens the sea now, so the open ocean reads clean
  // and the wake still reads as white water. The cascade/dyn foam textures still exist
  // upstream; they are simply no longer sampled into the surface colour.
  col = mix(col, vec3(0.92, 0.96, 0.95), clamp(wash * 0.6, 0.0, 0.95));

  // exponential-squared fog toward the horizon, with a CLEAR-ZONE: the near/mid sea (and the islands
  // you sail up to) stays crisp, and haze only builds past uFogStart, fading the far sea into the
  // sky's HORIZON_COLOR by the horizon. (Was an immediate exp² from the camera → a veil over the
  // mid-field islands the playtest called "too intense ... should only be a thing in the far distance".)
  float dist = length(uCameraPos - vWorldPos);
  float fogD = max(dist - uFogStart, 0.0);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * fogD * fogD);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

  // UNDERWATER VISIBILITY — depth-absorption translucency (no additive colour → NO waterline rim).
  // columnDepth = metres of water over the shallowest solid beneath this fragment. The sea is a body
  // you see DOWN into: shallow water over a solid (the sandy shelf, a submerged deck) is translucent so
  // the bottom shows through and DISSOLVES into the opaque deep-water colour by uWaterVis metres down —
  // carried by ALPHA ALONE. A dark deck therefore reads DARKER through the water, never the LIGHTER
  // one-voxel rim the old additive murk-mix produced (its tint was brighter than the deep
  // water, and the veil peaked in the thinnest shallow band at the waterline). Deep / open water
  // (floorY very low → visFrac 1) stays fully opaque, unchanged. clarity 0 → shallowAlpha 1, an exact no-op.
  float columnDepth = vWorldPos.y - floorY;
  float visFrac = clamp(columnDepth / max(uWaterVis, 0.05), 0.0, 1.0);
  float shallowAlpha = mix(1.0, 0.38, uWaterClarity); // how see-through the shallowest water gets; clarity 0 → opaque
  float seaAlpha = mix(shallowAlpha, 1.0, visFrac);    // shallow translucent → deep opaque (MONOTONIC → no rim)
  gl_FragColor = vec4(col, min(cutAlpha, seaAlpha));
}
`;

export function createOcean(waves: Wave[], sunDir: THREE.Vector3, field: OceanField): Ocean {
  const geo = makePolarGrid();

  // The analytic base is the SWELL subset, so the mesh's Gerstner sum equals
  // the physics field exactly — the ship stays welded to the swell it floats
  // on, and the FFT chop/normal/foam is added on top (band-limited).
  const swell = physicsWaves(waves);
  const { a, b } = waveUniforms(swell);
  const ampTotal = swell.reduce((s, w) => s + w.amplitude, 0);

  // Round 14: gather the cascade layers the shader sums. A live cascade field
  // exposes `cascades`; a legacy single FFT exposes the singletons (wrapped as one
  // layer); the null fallback exposes nothing (NCASC stays 1, gated off by uFftOn).
  const layers =
    field.cascades ??
    (field.active && field.displacement && field.normal && field.foam
      ? [
          {
            displacement: field.displacement,
            normal: field.normal,
            foam: field.foam,
            tileSize: field.tileSize,
            choppiness: 1.3,
          },
        ]
      : []);
  const NCASC = Math.max(1, layers.length);
  const dummyTex: THREE.Texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  dummyTex.needsUpdate = true;

  // Per-ship hull-profile ATLAS for the in-hull sea-cut: one float texture banded vertically by slot
  // (MAXVIS bands of PROF_W×PROF_H). Each ship's per-column keel/deck field (buildHullProfile) is
  // resampled into its band; the fragment shader reads band s at uv.y∈[s,s+1]/MAXVIS. RG = keel, deck
  // (m). Nearest filtering keeps the cut edges voxel-crisp. One sampler for all ships sidesteps GLSL
  // ES 1.00's no-dynamic-sampler-index limit that used to cap the cut at two named samplers.
  const PROF_W = 256, PROF_H = 64;
  const profileAtlasData = new Float32Array(PROF_W * PROF_H * MAXVIS * 4);
  const profileAtlas = new THREE.DataTexture(profileAtlasData, PROF_W, PROF_H * MAXVIS, THREE.RGBAFormat, THREE.FloatType);
  profileAtlas.minFilter = profileAtlas.magFilter = THREE.NearestFilter;
  profileAtlas.wrapS = profileAtlas.wrapT = THREE.ClampToEdgeWrapping;
  profileAtlas.flipY = false;
  profileAtlas.needsUpdate = true;
  // Resample a hull's nx×nz keel/deck/seal field (src idx (z*nx+x)*3) into band `slot`
  // (nearest, fills the cell). RGB = keelYLocal, deckYLocal, sealYLocal (the open-breach
  // signal: seal < deck ⟺ the deck planking over this column is gone → an open hole).
  const stampProfile = (slot: number, data: Float32Array, nx: number, nz: number): void => {
    const band = slot * PROF_H;
    for (let ty = 0; ty < PROF_H; ty++) {
      const sz = Math.min(nz - 1, Math.floor((ty / PROF_H) * nz));
      for (let tx = 0; tx < PROF_W; tx++) {
        const sx = Math.min(nx - 1, Math.floor((tx / PROF_W) * nx));
        const si = (sz * nx + sx) * 3;
        const di = ((band + ty) * PROF_W + tx) * 4;
        profileAtlasData[di] = data[si];         // keelYLocal → R
        profileAtlasData[di + 1] = data[si + 1]; // deckYLocal → G
        profileAtlasData[di + 2] = data[si + 2]; // sealYLocal → B
        profileAtlasData[di + 3] = 1;
      }
    }
    profileAtlas.needsUpdate = true;
  };
  // placeholder cube so the samplerCube is always bound before setSkyEnv() runs
  // (uHasEnv gates whether it is actually sampled).
  const dummyCube = new THREE.CubeTexture(
    Array.from({ length: 6 }, () => {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      return c;
    }),
  );
  dummyCube.needsUpdate = true;
  function padTex(arr: THREE.Texture[]): THREE.Texture[] {
    const out = arr.slice();
    while (out.length < NCASC) out.push(dummyTex);
    return out;
  }
  function padNum(arr: number[], fill: number): number[] {
    const out = arr.slice();
    while (out.length < NCASC) out.push(fill);
    return out;
  }
  const cascDisp = padTex(layers.map((l) => l.displacement));
  const cascNormal = padTex(layers.map((l) => l.normal));
  const cascFoam = padTex(layers.map((l) => l.foam));
  const cascTile = padNum(
    layers.map((l) => l.tileSize),
    1,
  );
  const cascChop = padNum(
    layers.map((l) => l.choppiness),
    0,
  );

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: { NWAVES: swell.length, NCASC, MAXVIS },
    clipping: true,
    transparent: true, // the cutaway wedge fades to glass; alpha 1 elsewhere
    depthWrite: true,
    side: THREE.DoubleSide, // a submerged camera must see the surface above
    // it, not a missing polygon that cuts straight to the skybox (playtest)
    // stencil seam mask: the SeamMask pre-pass writes 1 into every hull-
    // silhouette pixel; the ocean draws only where stencil != 1, so no sea
    // lands on the deck, in an open hold, or as a void at the curved bow.
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
    uniforms: {
      uTime: { value: 0 },
      uWaveA: { value: a },
      uWaveB: { value: b },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.78, 0.55) },
      // a DARKER teal→navy body (round-2 tune: "the water needs to be a bit darker
      // and slightly more matte"); the (now weaker) sky reflection only adds a sheen.
      // The body color is a baked gradient (shallow→deep by view angle) with NO ambient/sky
      // light term, so whatever sits here IS the water's brightness. uDeepColor shows when you
      // look STRAIGHT DOWN (facing→1, Fresnel→0, so no sky reflection lifts it) — at near-black
      // 0x02060e the whole sea went pitch-black from above. Lifted to a real lit deep-navy so a
      // top-down view reads as dark water, not a void, while still clearly "deep" vs the shallows.
      uDeepColor: { value: new THREE.Color(0x0a1a2e) },   // lit deep navy (was near-black 0x02060e)
      uShallowColor: { value: new THREE.Color(0x0c2a45) }, // navy body at grazing angles (lifted a touch)
      uSkyColor: { value: new THREE.Color(0x9fc4d4) }, // fresnel fallback only
      uSkyEnv: { value: dummyCube },
      uHasEnv: { value: 0 },
      uReflStrength: { value: 0.22 },
      uReflClamp: { value: 1.6 },
      // underwater visibility (depth-absorption translucency). Defaults match TUN.gfx.water;
      // main.ts overwrites uWaterVis/uWaterClarity every frame via setWaterDepth. The veil is
      // alpha-only now (no colour added), so there is no separate murk-tint uniform.
      uWaterVis: { value: 2.5 },
      uWaterClarity: { value: 0.85 },
      uFogColor: { value: new THREE.Color(0xc4d6d6) },
      uFogDensity: { value: 0.0016 },
      uFogStart: { value: 520 }, // crystal-clear out to ~520 m, then haze builds toward the horizon
      uAmpTotal: { value: ampTotal },
      uCameraPos: { value: new THREE.Vector3() },
      uCutOn: { value: 0 },
      uShipPos: { value: new THREE.Vector2() },
      uFwd: { value: new THREE.Vector2(1, 0) },
      uHalf: { value: new THREE.Vector2(12.9, 3.7) },
      uCutPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
      uShipA: { value: Array.from({ length: MAXVIS }, () => new THREE.Vector4()) },
      uShipB: { value: Array.from({ length: MAXVIS }, () => new THREE.Vector4()) },
      uShipC: { value: Array.from({ length: MAXVIS }, () => new THREE.Vector2(0, -1)) },
      uTrail: { value: Array.from({ length: 64 }, () => new THREE.Vector4()) },
      uProfileOn: { value: Array.from({ length: MAXVIS }, () => 0) },
      uProfileAtlas: { value: profileAtlas },
      uProfileInvRot: { value: Array.from({ length: MAXVIS }, () => new THREE.Matrix3()) },
      uProfileTrans: { value: Array.from({ length: MAXVIS }, () => new THREE.Vector3()) },
      uProfileSize: { value: Array.from({ length: MAXVIS }, () => new THREE.Vector2(1, 1)) },
      uProfileSeaY: { value: Array.from({ length: MAXVIS }, () => 0) },
      // Cascade field (round 14): displacement is summed in the vertex stage, the
      // normal + foam in the fragment stage, one set of textures per band. uFftOn
      // gates every use so the null fallback (dummy textures) renders the
      // Gerstner-only look.
      uCascadeDisp: { value: cascDisp },
      uCascadeNormal: { value: cascNormal },
      uCascadeFoam: { value: cascFoam },
      uCascadeTile: { value: cascTile },
      uCascadeChop: { value: cascChop },
      uFftOn: { value: field.active ? 1 : 0 },
      uChopScale: { value: 1 },
      uChoppiness: { value: 1 },
      // shore shoaling land field (bound once via setLandField from the IslandField)
      uLandTex: { value: dummyTex },
      uLandMin: { value: new THREE.Vector2() },
      uLandSize: { value: new THREE.Vector2(1, 1) },
      uLandOn: { value: 0 },
      // P5 dynamic-wave interaction field (off until setDynamicField binds it).
      uDynDisp: { value: dummyTex },
      uDynOrigin: { value: new THREE.Vector2() },
      uDynWindow: { value: 1 },
      uDynOn: { value: 0 },
      uDynScale: { value: 1 },
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;

  // Publish the shared ocean look for the flood-water surface to clone (render/compartmentFluid.ts).
  // We hand it the SAME live uniform OBJECTS the sea shader reads, so any dev-panel colour/reflection
  // tweak flows through to the interior pool with no copy. seaHeight rides the analytic swell at the
  // live clock — the flood uses it to fade its skirt out as the interior level reaches the sea level.
  const u = mat.uniforms;
  sharedOceanLook = {
    uShallowColor: u.uShallowColor as { value: THREE.Color },
    uDeepColor: u.uDeepColor as { value: THREE.Color },
    uSunColor: u.uSunColor as { value: THREE.Color },
    uSkyColor: u.uSkyColor as { value: THREE.Color },
    uSkyEnv: u.uSkyEnv as { value: THREE.CubeTexture | THREE.Texture },
    uHasEnv: u.uHasEnv as { value: number },
    uReflStrength: u.uReflStrength as { value: number },
    uReflClamp: u.uReflClamp as { value: number },
    uSunDir: u.uSunDir as { value: THREE.Vector3 },
    uTime: u.uTime as { value: number },
    swell,
    seaHeight: (x: number, z: number) => surfaceHeight(swell, x, z, u.uTime.value as number),
  };

  // Underwater backdrop — the fix for "the ocean is just a sheet over the void". The surface mesh is
  // transparent (its alpha fades from ~opaque in deep water to see-through over a shallow floor); in
  // open water it's fully opaque so this never shows, but where the sea goes translucent or is cut —
  // the sea closing over a submerged deck, looking down/through a holed bow, the centreline cutaway —
  // what used to show THROUGH was the sky dome in the background scene, whose below-horizon band reads
  // a dark navy + drifting clouds (the "void of light beneath the sea"). The backdrop fills every such
  // gap with SOLID NAVY of the same body-of-water colour, so the sea reads as a solid volume.
  //
  // It used to be a single FLAT disc — but a flat plane only seals view rays that point straight DOWN.
  // An ANGLED sightline (a holed bow tilting forward → you look down-and-forward through the gap) passes
  // OVER the rim of a flat disc and escapes to the sky. So the backdrop is a downward BOWL (the lower
  // hemisphere of a big sphere, BackSide so we see its inner wall) centred under the camera: any ray
  // crossing below the surface terminates on the bowl's navy inner wall, never the sky.
  //
  // RIM HEIGHT (the old weak point): the rim used to sit a fixed −6 m below the surface, leaving a 6 m
  // open band just under the waterline through which near-horizontal rays escaped to the sky. The rim
  // is now raised EVERY FRAME (update()) to sit just under the LOCAL sea surface near the camera — only
  // RIM_TROUGH_MARGIN below it — so the navy wall climbs right up toward the waterline and backs the
  // shallow-angle sightlines a hole exposes. This is SAFE because the bowl is drawn at renderOrder −1,
  // BEFORE the transparent surface: where the near surface is opaque (all of open water) it composites
  // OVER the bowl and hides it; the bowl only ever shows through a transparent/cut/holed patch, which is
  // exactly where we want navy. Holding it a margin below the deepest near trough guarantees the opaque
  // near surface is always in front, so the higher rim can never read as a navy ring/wall on open water.
  // (Every bowl point has y ≤ rim < camera.y, so the bowl never projects above the horizon onto the sky.)
  //
  // Geometry: a sphere with thetaStart=π/2, thetaLength=π/2 gives only the lower cap (an upward-opening
  // bowl). Radius < the ocean's R_FAR (2400) so it can never poke past the horizon. Colour = the live
  // deep-water navy (shared uDeepColor, so a dev-panel water-colour tweak carries through and the body
  // and its backing always match); fog:true so the far rim melts into the same horizon haze as the sea.
  const BOWL_RADIUS = 2350;
  const backdropMat = new THREE.MeshBasicMaterial({
    color: (u.uDeepColor.value as THREE.Color).clone(),
    fog: true,
    side: THREE.BackSide,
  });
  const backdrop = new THREE.Mesh(
    new THREE.SphereGeometry(BOWL_RADIUS, 64, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    backdropMat,
  );
  backdrop.position.y = BOWL_RIM_Y; // initial; update() raises the rim to just under the surface
  backdrop.renderOrder = -1; // draw before the transparent surface composites over it
  backdrop.frustumCulled = false;

  // UNDERWATER CEILING CAP: the bowl is only the lower hemisphere (so it never paints over the sky
  // above water). That leaves the view OVERHEAD open — fine above water, but when the camera is SUBMERGED
  // and the bowl is raised to enclose it, an upward sightline would still see the transparent surface and
  // the sky dome through it ("never the sky" — the user's explicit ask). This UPPER-hemisphere cap, a
  // child of the bowl (so it follows + main.ts still only adds `backdrop`), is hidden above water and
  // shown only when submerged, closing the bowl into a FULL navy sphere around the camera. Together with
  // the dense underwater fog, the whole submerged view reads as a solid navy body in every direction.
  const ceilingCap = new THREE.Mesh(
    new THREE.SphereGeometry(BOWL_RADIUS, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2), // upper cap (object y ≥ 0)
    backdropMat,
  );
  ceilingCap.renderOrder = -1;
  ceilingCap.frustumCulled = false;
  ceilingCap.visible = false; // only enclose overhead when submerged
  backdrop.add(ceilingCap); // child: rides the bowl's position; cap's object-space y=0 = the bowl rim

  // tracks the camera-submerged state (main.ts → setUnderwater): when under, the rim is raised to fully
  // enclose the camera and the colour deepens so the whole view reads as a solid navy body, not the sky.
  let underwater = false;

  // stern-path ring buffers (one per ship slot): points are laid every few
  // meters of travel and age out; the fragment shader laces foam between them
  const trails: { x: number; z: number; t: number; w: number }[][] = [[], []];

  return {
    mesh,
    backdrop,
    setCutaway(on) {
      mat.uniforms.uCutOn.value = on ? 1 : 0;
    },
    setFootprint(halfL, halfB) {
      (mat.uniforms.uHalf.value as THREE.Vector2).set(halfL, halfB);
    },
    updateShipWake(slot, centerX, centerZ, fwdX, fwdZ, speed, halfL, halfB, time, keelWorldY, deckWorldY) {
      const a = (mat.uniforms.uShipA.value as THREE.Vector4[])[slot];
      const b = (mat.uniforms.uShipB.value as THREE.Vector4[])[slot];
      const c = (mat.uniforms.uShipC.value as THREE.Vector2[])[slot];
      a.set(centerX + fwdX * halfL, centerZ + fwdZ * halfL, fwdX, fwdZ);
      b.set(speed, halfL, halfB, 0);
      c.set(keelWorldY, deckWorldY);

      // stern ribbon only for the PREMIUM pair (slots 0,1 = the two uTrail halves).
      // Cheap slots (2..) get collar/bow/flank-wash above but no trailing ribbon.
      if (slot < 2) {
        const trail = trails[slot];
        const sx = centerX - fwdX * (halfL + 0.8);
        const sz = centerZ - fwdZ * (halfL + 0.8);
        const last = trail[trail.length - 1];
        // r17: tighter 1.2 m spacing (was 2.4) → twice as many points = a SMOOTH continuous
        // ribbon instead of a lace that pops a blob every ~0.25 s, and 31 points now span
        // only ~37 m (~1 hull length, was ~74 m) so the tail no longer reads as a speedboat.
        if (speed > 1.5 && (!last || Math.hypot(sx - last.x, sz - last.z) > 1.2)) {
          trail.push({ x: sx, z: sz, t: time, w: Math.min(speed / 8, 0.9) });
        }
        // and a 7 s age cap (was 16) so a slow displacement hull leaves only a short stub.
        while (trail.length > 31 || (trail.length > 0 && time - trail[0].t > 7)) trail.shift();

        const u = mat.uniforms.uTrail.value as THREE.Vector4[];
        const base = slot * 32;
        for (let i = 0; i < 32; i++) {
          const pt = trail[i];
          if (pt) u[base + i].set(pt.x, pt.z, time - pt.t, pt.w);
          else u[base + i].set(0, 0, 0, 0);
        }
      }
    },
    setHullProfile(slot, data, nx, nz, sizeX, sizeZ) {
      stampProfile(slot, data, nx, nz);
      (mat.uniforms.uProfileSize.value as THREE.Vector2[])[slot].set(sizeX, sizeZ);
      (mat.uniforms.uProfileOn.value as number[])[slot] = 1;
    },

    clearSlot(slot) {
      (mat.uniforms.uShipB.value as THREE.Vector4[])[slot].set(0, 0, 0, 0); // halfL=0 → collar/bow/wash skip
      (mat.uniforms.uShipC.value as THREE.Vector2[])[slot].set(0, -1); // deck<=keel → ellipse cut skips
      (mat.uniforms.uProfileOn.value as number[])[slot] = 0;
    },
    resetTrail(slot) {
      trails[slot] = [];
      const u = mat.uniforms.uTrail.value as THREE.Vector4[];
      const base = slot * 32;
      for (let i = 0; i < 32; i++) u[base + i].set(0, 0, 0, 0);
    },
    updateHullPose(slot, invRot, trans, seaY) {
      (mat.uniforms.uProfileInvRot.value as THREE.Matrix3[])[slot].copy(invRot);
      (mat.uniforms.uProfileTrans.value as THREE.Vector3[])[slot].copy(trans);
      (mat.uniforms.uProfileSeaY.value as number[])[slot] = seaY;
    },
    setDynamicField(tex, windowSize, originX, originZ, on, scale = 1) {
      if (tex) mat.uniforms.uDynDisp.value = tex;
      mat.uniforms.uDynWindow.value = windowSize;
      (mat.uniforms.uDynOrigin.value as THREE.Vector2).set(originX, originZ);
      mat.uniforms.uDynOn.value = on && tex ? 1 : 0;
      mat.uniforms.uDynScale.value = scale;
    },
    setChop(strength, choppiness) {
      mat.uniforms.uChopScale.value = strength;
      mat.uniforms.uChoppiness.value = choppiness;
    },
    setSkyEnv(tex) {
      mat.uniforms.uSkyEnv.value = tex;
      mat.uniforms.uHasEnv.value = 1;
    },
    setReflStrength(strength, clamp) {
      mat.uniforms.uReflStrength.value = strength;
      if (clamp !== undefined) mat.uniforms.uReflClamp.value = clamp;
    },
    setWaterDepth(visibility, clarity) {
      mat.uniforms.uWaterVis.value = visibility;
      mat.uniforms.uWaterClarity.value = clarity;
    },
    setFogColor(color) {
      (mat.uniforms.uFogColor.value as THREE.Color).copy(color);
    },
    setUnderwater(on) {
      underwater = on;
    },
    setLandField(tex, minX, minZ, sizeX, sizeZ) {
      mat.uniforms.uLandTex.value = tex;
      (mat.uniforms.uLandMin.value as THREE.Vector2).set(minX, minZ);
      (mat.uniforms.uLandSize.value as THREE.Vector2).set(sizeX, sizeZ);
      mat.uniforms.uLandOn.value = 1;
    },
    updateCutaway(shipPos, fwdX, fwdZ, cutPlane) {
      (mat.uniforms.uShipPos.value as THREE.Vector2).set(shipPos.x, shipPos.z);
      (mat.uniforms.uFwd.value as THREE.Vector2).set(fwdX, fwdZ);
      (mat.uniforms.uCutPlane.value as THREE.Vector4).set(
        cutPlane.normal.x,
        cutPlane.normal.y,
        cutPlane.normal.z,
        cutPlane.constant,
      );
    },
    update(time, cameraPos) {
      mat.uniforms.uTime.value = time;
      mat.uniforms.uCameraPos.value.copy(cameraPos);
      // follow the camera CONTINUOUSLY: the displacement field is anchored
      // to world coordinates, so a smoothly sliding lattice samples it
      // smoothly. The old 10 m snap re-sampled every wave against a jumped
      // grid — the round-8 "stuttering".
      mesh.position.x = cameraPos.x;
      mesh.position.z = cameraPos.z;
      // The underwater-backdrop bowl follows in XZ so solid navy is always under the player.
      backdrop.position.x = cameraPos.x;
      backdrop.position.z = cameraPos.z;

      // Live LOCAL sea surface at the camera's XZ on the analytic swell (the same field the physics and
      // the open-sea vertex shader ride). The bowl rim tracks it so the navy wall climbs right up toward
      // the waterline regardless of swell state, never a fixed depth that leaves a gap below the crests.
      const seaY = surfaceHeight(swell, cameraPos.x, cameraPos.z, time);

      if (underwater) {
        // Camera BELOW the surface: raise the rim ABOVE the camera so the lens is INSIDE the bowl, and
        // SHOW the ceiling cap so the bowl closes into a full navy sphere — fully enclosed in navy in
        // EVERY direction, including overhead (no sky through the surface). The dense navy underwater fog
        // main.ts swaps in melts the far walls into one uniform navy body. Clamp the rim to at least just
        // over the local surface so a camera hovering right at the waterline is still enclosed.
        backdrop.position.y = Math.max(cameraPos.y + 2, seaY + 2);
        ceilingCap.visible = true;
        // deepen toward a denser navy so the submerged view reads as being INSIDE the water body.
        (backdropMat.color as THREE.Color).copy(u.uDeepColor.value as THREE.Color).multiplyScalar(0.7);
      } else {
        // Above water: hold the rim just under the LOCAL surface (RIM_TROUGH_MARGIN below it) so it backs
        // shallow-angle sightlines through a holed hull at the waterline, yet stays below the deepest near
        // trough so the opaque near surface always hides it on open water. Cap it below the camera as a
        // hard safety so the bowl can never project above the horizon onto the sky, and HIDE the ceiling
        // cap so the real sky shows overhead.
        backdrop.position.y = Math.min(seaY - RIM_TROUGH_MARGIN, cameraPos.y - 1.5);
        ceilingCap.visible = false;
        (backdropMat.color as THREE.Color).copy(u.uDeepColor.value as THREE.Color);
      }
    },
  };
}
