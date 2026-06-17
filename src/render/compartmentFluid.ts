import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { TUN } from "../core/tunables";
import { buildFillCurve, fillHeightLocal, type Compartment, type FillCurve } from "../sim/compartments";
import { getOceanLook, type OceanLook } from "./ocean";

/**
 * Flooded-compartment water — rendered as a SOLID, FILLED BODY of water that fills the room from the
 * compartment FLOOR up to the live flood level, NOT a sheet floating on thin air.
 *
 * 4th-attempt rework (items 11+12). The prior version drew ONE top sheet + a SHORT side skirt whose
 * height + opacity FADED OUT (uExposure) as the interior level neared the sea level. When the inside
 * rose above the sea the skirt was hidden entirely → just a flat square of texture levitating with
 * nothing beneath it (the user's "ugly, roughly fitted, flat square" / "water floating on thin air").
 *
 * Now the water is a CLOSED VOLUME:
 *   • ONE continuous TOP sheet — a single plane sized to the compartment footprint, drawn WORLD-
 *     horizontal at the gravity-level pool surface (the mesh is counter-rotated by the inverse ship
 *     pose, so as the hull heels/pitches the water stays level — what reads as a real liquid). A gentle
 *     Gerstner-style shimmer gives it life without reading as the open sea.
 *   • FULL SIDE WALLS — four vertical walls from the surface ALL THE WAY DOWN to the compartment FLOOR
 *     (no short fading skirt). The walls carry the deep navy body tone, darkening toward the floor, so
 *     the room reads as filled with a solid body of water from any visible angle.
 *   • A FLOOR quad closing the bottom of the box, so an above-deck view down into a holed hold still
 *     sees water all the way down, not through to a void.
 *
 * CLIP-TO-THE-HOLE (item 12): the opaque hull mesh writes depth and is drawn first; this water uses
 * depthWrite:false + depthTest on, so it is only VISIBLE through the actual openings/holes the carve
 * cut in the hull — exactly the way the sea is cut around a breach. We LEAN INTO that occlusion: the
 * box fills the WHOLE compartment and the intact hull clips it to the hole, with NO uExposure gap that
 * used to expose the void at the waterline. The footprint is inset a touch so the box never pokes
 * visibly outside the hull and floats over open sea at a breach (and the hull occludes any sliver).
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

// How dark the body wall goes from just-under-the-surface (1.0×) down to the floor. A solid body of
// water dims with depth; the floor is the darkest. Module-local render constant — REPORT to the lead
// for promotion to TUN.flood.render if a dev-panel knob is wanted.
const WALL_FLOOR_DARKEN = 0.4;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uShimmer;
varying vec3 vWorldPos;
varying float vEdge;   // 0 at the surface → 1 at the floor (darken downward on the walls/floor)
varying float vIsTop;  // 1 for the top sheet, 0 for the walls/floor
attribute float aEdge;
attribute float aTop;
void main() {
  vec3 p = position;
  vEdge = aEdge;
  vIsTop = aTop;
  // gentle Gerstner-ish shimmer on the TOP sheet only — small crossing ripples so the pool has life
  // without reading as the open sea. The walls/floor stay still (a body wall doesn't ripple).
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
uniform float uBodyOpacity;     // walls + floor opacity (the solid body)
uniform float uWallFloorDarken; // wall/floor tone at the floor (×uDeepColor)
varying vec3 vWorldPos;
varying float vEdge;
varying float vIsTop;

void main() {
  vec3 V = normalize(uCameraPos - vWorldPos);
  // The flood pool is calm: the TOP sheet uses a mostly-up normal with a slow ripple so the sky
  // reflection + body gradient read like the open sea's, distorted just a little. The WALLS face
  // outward toward the viewer (a horizontal-ish normal), so they pick up the deep body colour, not the
  // sky — that's what reads as the dim solid body of water filling the room.
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
    // WALL / FLOOR: the dim solid INTERIOR of the body of water — almost no sky reflection (water
    // under the surface barely catches the sky), darkening from just-under-the-surface down to the
    // floor. Reads as a filled volume of water, not a glass panel. vEdge: 0 at the surface → 1 floor.
    vec3 bodyTop = uDeepColor;                       // just under the surface: the deep body tone
    vec3 bodyBot = uDeepColor * uWallFloorDarken;    // toward/at the floor: darkest
    col = mix(bodyTop, bodyBot, clamp(vEdge, 0.0, 1.0));
    // a whisper of sky sheen at the very top of the wall so it ties into the surface, fading out fast
    float sheen = (1.0 - clamp(vEdge, 0.0, 1.0)) * 0.08 * uReflStrength;
    col = mix(col, min(uSkyColor, vec3(uReflClamp)), sheen);
  }

  // a faint foam line where the surface sheet meets the hull wall (the rim of the top sheet)
  float topRim = vIsTop * clamp(vEdge, 0.0, 1.0);
  float foam = topRim * (0.4 + 0.4 * sin(uTime * 2.2 + vWorldPos.x * 1.4 + vWorldPos.z * 1.1));
  col = mix(col, vec3(0.7, 0.8, 0.84), clamp(foam, 0.0, 1.0) * 0.3);

  // opacity: the top sheet is mostly opaque; the walls + floor form the solid body at uBodyOpacity, so
  // the room reads as filled with water from any angle and looking straight down a holed hold sees the
  // body all the way to the floor (not a window to the void).
  float alpha = (vIsTop > 0.5) ? uTopOpacity : uBodyOpacity;
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
  floorLocalY: number; // local-Y of the compartment floor (m) — the bottom of the solid body
  top: THREE.Mesh; // one continuous surface sheet
  body: THREE.Mesh; // four full-height walls + a floor (the solid volume)
  mat: THREE.ShaderMaterial;
  uTopOpacity: { value: number };
  uBodyOpacity: { value: number };
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
  private scratchFloor = new THREE.Vector3();

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

    // footprint rectangle in local meters, inset a touch so the box never pokes outside the hull at
    // a curved end and floats over open sea at a breach (the opaque hull mesh occludes any overhang
    // anyway, but the inset is cleaner — item 12).
    const inset = VOXEL_SIZE * 0.25;
    const minX = (c.bboxMin[0]) * VOXEL_SIZE + inset;
    const maxX = (c.bboxMax[0] + 1) * VOXEL_SIZE - inset;
    const minZ = (c.bboxMin[2]) * VOXEL_SIZE + inset;
    const maxZ = (c.bboxMax[2] + 1) * VOXEL_SIZE - inset;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const floorLocalY = c.bboxMin[1] * VOXEL_SIZE; // bottom of the lowest cell layer

    const oc = this.oceanUniforms();
    const uTopOpacity = { value: TUN.flood.render.topOpacity };
    const uBodyOpacity = { value: TUN.flood.render.skirtOpacity };
    const uShimmer = { value: TUN.flood.render.shimmer };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false, // sits inside the hull; the opaque hull occludes it via depthTest → clip-to-hole
      side: THREE.DoubleSide,
      uniforms: {
        ...oc,
        uCameraPos: { value: new THREE.Vector3() },
        uTopOpacity,
        uBodyOpacity,
        uShimmer,
        uWallFloorDarken: { value: WALL_FLOOR_DARKEN },
      },
    });

    // TOP sheet: a unit XZ quad ([-0.5,0.5] in x/z, y=0). Per frame we scale it to the footprint, set
    // its position to the world pool surface and counter-rotate to world-up. aTop=1, aEdge=0.35
    // (a faint uniform rim foam — with a 1×1 plane all 4 verts are corners).
    const topGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
    topGeo.rotateX(-Math.PI / 2); // lie flat in XZ (normal +Y)
    {
      const n = topGeo.attributes.position.count;
      const aTop = new Float32Array(n).fill(1);
      const aEdge = new Float32Array(n).fill(0.35);
      topGeo.setAttribute("aTop", new THREE.BufferAttribute(aTop, 1));
      topGeo.setAttribute("aEdge", new THREE.BufferAttribute(aEdge, 1));
    }
    const top = new THREE.Mesh(topGeo, mat);
    top.frustumCulled = false;
    top.renderOrder = 4;
    this.group.add(top);

    // BODY: a CLOSED box of four FULL-HEIGHT walls + a floor (no top — the sheet is the surface). Built
    // as a unit box in local space [-0.5,0.5] in x/z and [0,1] in y (y=1 at the surface, y=0 at the
    // floor). Per frame we scale x/z to the footprint and y to the full fill depth (surface→floor), and
    // counter-rotate so it hangs gravity-down from the surface. aEdge encodes depth (0 surface → 1
    // floor) to darken downward; aTop=0. This is the solid body of water (items 11+12).
    const bodyGeo = this.makeBodyGeometry();
    const body = new THREE.Mesh(bodyGeo, mat);
    body.frustumCulled = false;
    body.renderOrder = 4;
    this.group.add(body);

    this.comps.set(c.id, {
      curve, minX, maxX, minZ, maxZ, cx, cz, floorLocalY,
      top, body, mat, uTopOpacity, uBodyOpacity, uShimmer,
      lastFill: -1, frames: 99,
    });
  }

  /** A closed box body: four full-height vertical wall quads + a floor quad (NO top — the surface sheet
   *  is the lid). Local: x,z ∈ [-0.5,0.5], y ∈ [0,1] (y=1 the surface, y=0 the floor). aEdge = 1 - y
   *  (0 at surface → 1 at floor) for depth-darkening; aTop = 0 (this is the solid body). */
  private makeBodyGeometry(): THREE.BufferGeometry {
    const half = 0.5;
    // 8 corners: floor (y=0) then surface (y=1)
    const c = [
      [-half, 0, -half], [half, 0, -half], [half, 0, half], [-half, 0, half], // floor 0..3
      [-half, 1, -half], [half, 1, -half], [half, 1, half], [-half, 1, half], // surface 4..7
    ];
    // four side walls (open at top/bottom) + the floor quad (closes the bottom of the body)
    const quads = [
      [0, 1, 5, 4], // -z wall
      [1, 2, 6, 5], // +x wall
      [2, 3, 7, 6], // +z wall
      [3, 0, 4, 7], // -x wall
      [3, 2, 1, 0], // floor (wound so its outward normal faces down; DoubleSide draws it either way)
    ];
    const pos: number[] = [];
    const edge: number[] = [];
    const topA: number[] = [];
    const idx: number[] = [];
    let base = 0;
    for (const [a, b, d, e] of quads) {
      for (const ci of [a, b, d, e]) {
        pos.push(c[ci][0], c[ci][1], c[ci][2]);
        edge.push(1 - c[ci][1]); // y=0 floor → 1, y=1 surface → 0
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
      cf.uBodyOpacity.value = TUN.flood.render.skirtOpacity;
      if (cameraPos) (cf.mat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);

      const fill = c.volume > 0 ? c.waterVolume / c.volume : 0;
      if (fill < 0.005) {
        cf.top.visible = false;
        cf.body.visible = false;
        cf.lastFill = 0;
        continue;
      }
      // pose changes every frame (heel/pitch/heave), so update the transforms each frame; it's two
      // mesh transforms per compartment — cheap. The fill curve itself never changes.
      this.place(cf, c.waterVolume);
      cf.lastFill = fill;
    }
  }

  /** Position the continuous top sheet + the solid body box for the current flood level. The surface is
   *  drawn WORLD-horizontal (counter-rotated by the inverse ship pose) at the gravity-level pool
   *  height; the body box fills from that surface straight DOWN to the compartment floor — a closed,
   *  filled volume (NO exposure fade — the hull occludes it to the hole). */
  private place(cf: CF, waterVolume: number): void {
    const q = this.q, pos = this.pos;
    const localFillY = fillHeightLocal(cf.curve, waterVolume);

    // world position of the free surface at the footprint centre (ship-local fill height → world).
    this.v.set(cf.cx, localFillY, cf.cz).applyQuaternion(q).add(pos);
    const surfWorld = this.scratchSurf.copy(this.v);

    const width = cf.maxX - cf.minX;
    const depthXZ = cf.maxZ - cf.minZ;

    // The top/body are CHILDREN of this.group (which carries the ship pose). We want them drawn at a
    // fixed WORLD position + WORLD-up orientation, so we convert the desired world transform into the
    // group's LOCAL frame: localPos = qInv·(worldPos − pos); localQuat = qInv (cancels the ship pose →
    // world-up). (Setting a child's .position to a world coord would double-apply the parent matrix.)

    // --- TOP sheet: world-horizontal plane at the pool surface, sized to the footprint ---
    cf.top.visible = true;
    this.worldToLocal(surfWorld, cf.top.position);
    cf.top.quaternion.copy(this.qInv);
    cf.top.scale.set(width, 1, depthXZ);

    // --- BODY: a CLOSED filled box from the surface DOWN to the compartment floor (full depth) ---
    // The body fills the entire wet column: from the pool surface down to the LOCAL floor of the
    // compartment, transformed to a WORLD vertical depth. We place the mesh ORIGIN at the world FLOOR
    // point (surface, dropped straight down by the fill depth) and scale Y by that depth so local y=1 →
    // surface, y=0 → floor. NO exposure fade: the box is always the full solid body; the hull occludes
    // it to the visible hole (item 12). A wholly-above-water level (no fill) was already culled in
    // update() by the fill<0.005 gate.
    const fillDepthLocal = Math.max(0, localFillY - cf.floorLocalY);
    if (fillDepthLocal <= 1e-3) {
      cf.body.visible = false;
      return;
    }
    // The floor sits at the local floor height directly under the surface footprint centre. Because the
    // ship can heel/pitch, "straight down in world" is NOT the local floor direction — but the body box
    // is drawn WORLD-vertical (counter-rotated), so its floor must sit at the WORLD-Y of the local floor
    // point. Transform the local floor point (cx, floorLocalY, cz) to world to get that Y, then the box
    // height is the world vertical distance from there up to the surface.
    this.v.set(cf.cx, cf.floorLocalY, cf.cz).applyQuaternion(q).add(pos);
    const floorWorldY = this.v.y;
    const bodyDepthWorld = Math.max(1e-3, surfWorld.y - floorWorldY);

    cf.body.visible = true;
    this.scratchFloor.copy(surfWorld);
    this.scratchFloor.y = floorWorldY; // box origin at the floor, directly under the surface centre
    this.worldToLocal(this.scratchFloor, cf.body.position);
    cf.body.quaternion.copy(this.qInv);
    cf.body.scale.set(width, bodyDepthWorld, depthXZ);
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
      cf.body.geometry.dispose();
      cf.mat.dispose();
    }
    this.comps.clear();
  }
}
