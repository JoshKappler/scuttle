import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import type { Compartment } from "../sim/compartments";

/**
 * Flooded-compartment water rendered as an ANIMATED FREE SURFACE (replaces the round-14 clipped
 * plane AND the stacked translucent voxel cubes the player read as "light blue voxels … not truly
 * fluid").
 *
 * The pool's free surface is a world-HORIZONTAL plane: as the hull rolls and pitches the surface
 * stays level to gravity (that's what reads as a real liquid — and flooding is exactly what makes
 * her heel). We build it from the wet compartment cells:
 *   • rank the interior cells by world-Y, wet the lowest `fill · n` (volume-exact, equal cells);
 *   • the pool surface sits at the top of that wet set (`poolY`, world);
 *   • emit one up-facing tile per wet voxel-COLUMN at `poolY`, oriented world-up via the inverse
 *     of the ship pose (the mesh is parented under the ship group, so we counter-rotate each
 *     instance to cancel the heel). Footprint-exact by construction — no stencil/clip needed.
 *
 * The surface shader adds a gentle slosh bob, a scrolling shimmer, and a FOAM line where the water
 * meets the hull (precomputed per-cell footprint-boundary flag). One InstancedMesh per compartment
 * (one draw call). Recomputed only when the fill or the ship's attitude actually changes.
 */

const WATER_COLOR = 0x1a6a72; // EXACTLY ocean.ts uShallowColor, so the flood reads as the same sea

interface CF {
  n: number;
  cells: Int32Array; // packed grid index per cell
  lx: Float32Array;
  ly: Float32Array;
  lz: Float32Array;
  colKey: Int32Array; // x*nz+z per cell — the voxel column it belongs to (for surface dedupe)
  edge: Float32Array; // 1 if the cell is on the compartment footprint boundary (hull contact → foam)
  worldY: Float32Array; // scratch (rotated y per cell, for ranking)
  order: Int32Array; // scratch (cell slots sorted by world-Y)
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
  private mat: THREE.MeshStandardMaterial;
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
  private seenCols = new Set<number>();

  constructor(compartments: Compartment[], dims: [number, number, number]) {
    this.nx = dims[0];
    this.ny = dims[1];
    this.nz = dims[2];
    // a translucent, wet, slightly reflective surface in the ocean's own shallow tone. depthWrite
    // off so coplanar tiles don't z-fight; the opaque hull still occludes it (depthTest on).
    this.mat = new THREE.MeshStandardMaterial({
      color: WATER_COLOR,
      emissive: new THREE.Color(0x0a3340), // ocean deep tone — reads below decks without a light
      emissiveIntensity: 0.16,
      roughness: 0.1,
      metalness: 0.0,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.installSurfaceShader(this.mat);
    for (const c of compartments) this.add(c);
  }

  /** Add slosh bob + scrolling shimmer + a hull-contact foam line to a standard water material. */
  private installSurfaceShader(mat: THREE.MeshStandardMaterial): void {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uTime;
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
  transformed.y += 0.025 * sin(uTime * 1.5 + _ph);
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
uniform float uTime;`,
        )
        .replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
  float shimmer = 0.06 * sin(uTime * 2.0 + vWPos.x * 0.7 + vWPos.z * 0.6)
                + 0.04 * sin(uTime * 3.3 - vWPos.x * 0.5 + vWPos.z * 0.9);
  gl_FragColor.rgb += shimmer;
  float foam = clamp(vEdge, 0.0, 1.0) * (0.5 + 0.5 * sin(uTime * 3.0 + vWPos.x * 1.7 + vWPos.z * 1.3));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.82, 0.9, 0.93), clamp(foam, 0.0, 1.0) * 0.7);`,
        );
    };
  }

  private add(c: Compartment): void {
    const n = c.cells.size;
    const cells = new Int32Array(n);
    const lx = new Float32Array(n), ly = new Float32Array(n), lz = new Float32Array(n);
    const colKey = new Int32Array(n);
    const edge = new Float32Array(n);
    const nx = this.nx, ny = this.ny, nz = this.nz, layer = nx * ny;
    let i = 0;
    for (const p of c.cells) {
      cells[i] = p;
      const x = p % nx, y = Math.floor(p / nx) % ny, z = Math.floor(p / layer);
      lx[i] = (x + 0.5) * VOXEL_SIZE;
      ly[i] = (y + 0.5) * VOXEL_SIZE;
      lz[i] = (z + 0.5) * VOXEL_SIZE;
      colKey[i] = x * nz + z;
      // footprint boundary: a horizontal neighbour (±x / ±z) that is NOT a compartment cell means
      // the water meets the hull wall here → draw foam. (Grid-edge neighbours aren't in the set
      // either, which is correctly a boundary.)
      const wall =
        !c.cells.has(p - 1) || !c.cells.has(p + 1) || !c.cells.has(p - layer) || !c.cells.has(p + layer);
      edge[i] = wall ? 1 : 0;
      i++;
    }
    // a flat tile lying in the XZ plane (normal +Y), per-instance counter-rotated to world-up
    const geo = new THREE.PlaneGeometry(VOXEL_SIZE, VOXEL_SIZE);
    geo.rotateX(-Math.PI / 2);
    const aEdge = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(n, 1)), 1);
    geo.setAttribute("aEdge", aEdge);
    const surf = new THREE.InstancedMesh(geo, this.mat, Math.max(n, 1));
    surf.count = 0;
    surf.frustumCulled = false;
    surf.castShadow = false;
    surf.receiveShadow = false;
    surf.renderOrder = 4; // after opaque hull + ocean
    this.group.add(surf);
    this.comps.set(c.id, {
      n, cells, lx, ly, lz, colKey, edge,
      worldY: new Float32Array(n),
      order: new Int32Array(n),
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
    // quantized tilt key: rebuild the surface when the ship rolls/pitches enough that the pool
    // should slosh to a new low side (the quaternion's x/z carry roll+pitch).
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
      this.rebuild(cf, fill);
    }
  }

  /** Build the world-level surface: one up-facing tile per wet voxel-column, at the pool height. */
  private rebuild(cf: CF, fill: number): void {
    const n = cf.n;
    const wy = cf.worldY, ord = cf.order;
    const q = this.q, pos = this.pos;
    for (let i = 0; i < n; i++) {
      // rotated y of the cell centre (the constant ship-Y cancels for ranking; we add pos.y below)
      const vx = cf.lx[i], vy = cf.ly[i], vz = cf.lz[i];
      const tx = 2 * (q.y * vz - q.z * vy);
      const ty = 2 * (q.z * vx - q.x * vz);
      const tz = 2 * (q.x * vy - q.y * vx);
      wy[i] = vy + q.w * ty + (q.z * tx - q.x * tz);
      ord[i] = i;
    }
    (ord as unknown as { sort(cmp: (a: number, b: number) => number): void }).sort((a, b) => wy[a] - wy[b]);

    const wetCount = Math.min(n, Math.max(0, Math.round(fill * n)));
    if (wetCount === 0) {
      cf.surf.count = 0;
      return;
    }
    const poolRotY = wy[ord[wetCount - 1]]; // rotated y of the topmost wet cell
    const poolWorldY = poolRotY + pos.y + VOXEL_SIZE * 0.5; // world height of the free surface
    const band = VOXEL_SIZE * 1.2; // cells within ~a voxel of the top are "at the surface"
    const qInv = this.qInv.copy(q).invert();
    const seen = this.seenCols;
    seen.clear();

    let s = 0;
    // walk the wet cells from the TOP down; the first cell seen in each voxel column is its free
    // surface (one tile per column → no coplanar overlap). Stop once we drop below the surface band.
    for (let k = wetCount - 1; k >= 0; k--) {
      const i = ord[k];
      if (wy[i] < poolRotY - band) break;
      const ck = cf.colKey[i];
      if (seen.has(ck)) continue;
      seen.add(ck);
      // full world x,z of this cell, then place the tile at (worldX, poolWorldY, worldZ) world-up.
      this.v.set(cf.lx[i], cf.ly[i], cf.lz[i]).applyQuaternion(q).add(pos);
      this.d.set(this.v.x - pos.x, poolWorldY - pos.y, this.v.z - pos.z).applyQuaternion(qInv);
      this.m4.compose(this.d, qInv, this.one);
      cf.surf.setMatrixAt(s, this.m4);
      cf.aEdge.setX(s, cf.edge[i]);
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
