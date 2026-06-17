import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { buildFillCurve, fillHeightLocal, type Compartment, type FillCurve } from "../sim/compartments";

/**
 * Flooded-compartment water rendered as an ANIMATED FREE SURFACE (replaces the round-14 clipped
 * plane AND the stacked translucent voxel cubes the player read as "light blue voxels … not truly
 * fluid").
 *
 * The pool's free surface is a world-HORIZONTAL plane: as the hull rolls and pitches the surface
 * stays level to gravity (that's what reads as a real liquid — and flooding is what makes her heel).
 *
 * The fill LEVEL is derived from the compartment's current waterVolume via the same STATIC cumulative
 * volume↔height curve the sim uses (`sim/compartments.buildFillCurve` / `fillHeightLocal`) — O(log
 * layers), built once. This REPLACED the old per-rebuild "rotate every cell into world-Y and sort
 * them" pass (the heat-map look came from the glossy lit material, the cost from that per-cell sort).
 * The level is a ship-LOCAL-horizontal fill; it draws WORLD-horizontal by counter-rotating each tile
 * with the inverse of the ship pose (the mesh is parented under the ship group). Exact upright, a
 * close approximation under heel — safe because the list physics is independent (floodBallastLocal).
 *
 * Material: UNLIT (MeshBasicMaterial) in the ocean's own deep-navy tones, so the inside water reads as
 * the sea continuing into the hull — no warm sun specular, no red/teal "heat-map" blobs. A subtle
 * scrolling shimmer + a soft foam line where the water meets the hull keep it water-like without
 * reintroducing hot spots. One InstancedMesh per compartment (one draw call).
 */

// Ocean navy tones (ocean.ts uShallowColor / uDeepColor) so the flood reads as the same sea, not teal.
const WATER_SHALLOW = 0x07223a; // ocean.ts uShallowColor — navy
const WATER_DEEP = 0x02060e; // ocean.ts uDeepColor — near-black deep

interface CF {
  curve: FillCurve;
  /** per voxel-COLUMN (one tile each): footprint center + floor + foam flag. */
  cols: number;
  colX: Float32Array; // local x centre of the column (m)
  colZ: Float32Array; // local z centre of the column (m)
  colFloorY: Float32Array; // local y of the column's LOWEST cell centre (m) — column wets above this
  colEdge: Float32Array; // 1 if the column touches the hull wall (foam)
  cx: number; // compartment footprint centre, local x (m) — where we sample the surface height
  cz: number;
  surf: THREE.InstancedMesh;
  aEdge: THREE.InstancedBufferAttribute;
  lastFill: number;
  lastTiltKey: number;
  frames: number;
}

export class CompartmentFluid {
  readonly group = new THREE.Group();
  private comps = new Map<number, CF>();
  private nx: number;
  private ny: number;
  private nz: number;
  private mat: THREE.MeshBasicMaterial;
  private uTime = { value: 0 };

  // scratch — reused every rebuild, no per-frame allocation
  private pos = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private qInv = new THREE.Quaternion();
  private scl = new THREE.Vector3();
  private v = new THREE.Vector3();
  private d = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private m4 = new THREE.Matrix4();

  constructor(compartments: Compartment[], dims: [number, number, number]) {
    this.nx = dims[0];
    this.ny = dims[1];
    this.nz = dims[2];
    // UNLIT so the warm sun can't blow a hot specular on it (the old MeshStandardMaterial at
    // roughness 0.1 read as red/teal "heat-map" blobs through ACES + bloom). depthWrite off so
    // coplanar tiles don't z-fight; the opaque hull still occludes it (depthTest on). The deep/
    // shallow tone + shimmer come from the shader so it still reads as moving water.
    this.mat = new THREE.MeshBasicMaterial({
      color: WATER_SHALLOW,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.installSurfaceShader(this.mat);
    for (const c of compartments) this.add(c);
  }

  /** Unlit navy water: depth-darken toward the deep tone, a faint scrolling shimmer, and a soft
   *  foam line where the water meets the hull. No lighting term → immune to the warm sun. */
  private installSurfaceShader(mat: THREE.MeshBasicMaterial): void {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uTime;
      sh.uniforms.uDeep = { value: new THREE.Color(WATER_DEEP) };
      sh.vertexShader = sh.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
attribute float aEdge;
varying float vEdge;
varying vec3 vWPos;
uniform float uTime;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
#ifdef USE_INSTANCING
  float _ph = instanceMatrix[3].x * 0.5 + instanceMatrix[3].z * 0.4;
  transformed.y += 0.02 * sin(uTime * 1.4 + _ph);
  vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif
  vEdge = aEdge;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying float vEdge;
varying vec3 vWPos;
uniform float uTime;
uniform vec3 uDeep;`,
        )
        .replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
  // darken toward the deep-navy tone with a slow ripple so it reads as depth, not a flat slab
  float depthMix = 0.35 + 0.25 * sin(uTime * 0.8 + vWPos.x * 0.5 + vWPos.z * 0.6);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uDeep, clamp(depthMix, 0.0, 1.0));
  // faint scrolling shimmer (small + cool, never a hot spot)
  gl_FragColor.rgb += 0.03 * sin(uTime * 2.0 + vWPos.x * 0.7 + vWPos.z * 0.6);
  // soft foam where the water meets the hull wall
  float foam = clamp(vEdge, 0.0, 1.0) * (0.45 + 0.45 * sin(uTime * 2.4 + vWPos.x * 1.5 + vWPos.z * 1.2));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.55, 0.66, 0.72), clamp(foam, 0.0, 1.0) * 0.45);`,
        );
    };
  }

  private add(c: Compartment): void {
    const nx = this.nx, ny = this.ny, nz = this.nz, layer = nx * ny;
    // collapse the compartment cells into voxel COLUMNS (x,z): each draws ONE surface tile. Track the
    // column floor (lowest cell) so we only wet columns whose floor is below the fill level, and a
    // foam flag if any cell in the column touches a hull wall.
    const colFloor = new Map<number, number>(); // colKey → lowest local-y voxel index
    const colWall = new Map<number, boolean>();
    for (const p of c.cells) {
      const x = p % nx, y = Math.floor(p / nx) % ny, z = Math.floor(p / layer);
      const ck = x * nz + z;
      const cur = colFloor.get(ck);
      if (cur === undefined || y < cur) colFloor.set(ck, y);
      const wall =
        !c.cells.has(p - 1) || !c.cells.has(p + 1) || !c.cells.has(p - layer) || !c.cells.has(p + layer);
      if (wall) colWall.set(ck, true);
    }
    const cols = colFloor.size;
    const colX = new Float32Array(cols);
    const colZ = new Float32Array(cols);
    const colFloorY = new Float32Array(cols);
    const colEdge = new Float32Array(cols);
    let i = 0;
    for (const [ck, fy] of colFloor) {
      const x = Math.floor(ck / nz);
      const z = ck % nz;
      colX[i] = (x + 0.5) * VOXEL_SIZE;
      colZ[i] = (z + 0.5) * VOXEL_SIZE;
      colFloorY[i] = (fy + 0.5) * VOXEL_SIZE;
      colEdge[i] = colWall.get(ck) ? 1 : 0;
      i++;
    }

    const curve = buildFillCurve(c, nx, ny);
    const cx = ((c.bboxMin[0] + c.bboxMax[0]) / 2 + 0.5) * VOXEL_SIZE;
    const cz = ((c.bboxMin[2] + c.bboxMax[2]) / 2 + 0.5) * VOXEL_SIZE;

    // a flat tile lying in the XZ plane (normal +Y), per-instance counter-rotated to world-up
    const geo = new THREE.PlaneGeometry(VOXEL_SIZE, VOXEL_SIZE);
    geo.rotateX(-Math.PI / 2);
    const aEdge = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(cols, 1)), 1);
    geo.setAttribute("aEdge", aEdge);
    const surf = new THREE.InstancedMesh(geo, this.mat, Math.max(cols, 1));
    surf.count = 0;
    surf.frustumCulled = false;
    surf.castShadow = false;
    surf.receiveShadow = false;
    surf.renderOrder = 4; // after opaque hull + ocean
    this.group.add(surf);
    this.comps.set(c.id, {
      curve, cols, colX, colZ, colFloorY, colEdge, cx, cz,
      surf, aEdge,
      lastFill: -1,
      lastTiltKey: 1e9,
      frames: 99,
    });
  }

  /** Reflect current flooding. Called once per frame AFTER the ship group transform is synced. */
  update(compartments: Compartment[], _cameraPos: THREE.Vector3 | undefined, dt: number): void {
    this.uTime.value += Math.min(Math.max(dt, 0), 0.1);
    this.group.updateWorldMatrix(true, false);
    this.group.matrixWorld.decompose(this.pos, this.q, this.scl);
    // quantized tilt key: rebuild the surface when the ship rolls/pitches enough that the world-level
    // surface (and which columns sit under it) shifts (the quaternion's x/z carry roll+pitch).
    const tiltKey = Math.round(this.q.x * 40) * 6151 + Math.round(this.q.z * 40);

    for (const c of compartments) {
      const cf = this.comps.get(c.id);
      if (!cf) continue;
      const fill = c.volume > 0 ? c.waterVolume / c.volume : 0;
      if (fill < 0.005) {
        if (cf.surf.count !== 0) cf.surf.count = 0;
        cf.lastFill = 0;
        continue;
      }
      cf.frames++;
      // recompute on a meaningful change, at most ~every 4 frames (cheap when idle); but if the
      // surface is currently empty (e.g. just crossed the threshold) rebuild now so it appears.
      if (cf.surf.count > 0 && cf.frames < 4 && Math.abs(fill - cf.lastFill) < 0.004 && tiltKey === cf.lastTiltKey)
        continue;
      cf.frames = 0;
      cf.lastFill = fill;
      cf.lastTiltKey = tiltKey;
      this.rebuild(cf, c.waterVolume);
    }
  }

  /** Build the world-level surface: one up-facing tile per wet voxel-column, at the pool height.
   *  The fill level comes from the static curve (no per-cell sort); columns whose floor sits below
   *  that level are wet and get a tile at the world-horizontal pool height. */
  private rebuild(cf: CF, waterVolume: number): void {
    const q = this.q, pos = this.pos;
    // ship-local fill height (m) → the world Y of the free surface at the compartment centre.
    const localFillY = fillHeightLocal(cf.curve, waterVolume);
    this.v.set(cf.cx, localFillY, cf.cz).applyQuaternion(q).add(pos);
    const poolWorldY = this.v.y;
    const qInv = this.qInv.copy(q).invert();

    let s = 0;
    for (let i = 0; i < cf.cols; i++) {
      // a column is wet if its floor sits below the (local) fill surface
      if (cf.colFloorY[i] > localFillY) continue;
      // world x,z of this column, place the tile at (worldX, poolWorldY, worldZ) world-up.
      this.v.set(cf.colX[i], cf.colFloorY[i], cf.colZ[i]).applyQuaternion(q).add(pos);
      this.d.set(this.v.x - pos.x, poolWorldY - pos.y, this.v.z - pos.z).applyQuaternion(qInv);
      this.m4.compose(this.d, qInv, this.one);
      cf.surf.setMatrixAt(s, this.m4);
      cf.aEdge.setX(s, cf.colEdge[i]);
      s++;
    }
    cf.surf.count = s;
    cf.surf.instanceMatrix.needsUpdate = true;
    cf.aEdge.needsUpdate = true;
  }

  dispose(): void {
    for (const cf of this.comps.values()) cf.surf.geometry.dispose();
    this.mat.dispose();
    this.comps.clear();
  }
}
