import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import type { Compartment } from "../sim/compartments";

/**
 * Per-VOXEL flooded-compartment fluid (replaces the round-14 clipped plane, which the
 * player saw as "weird blue rectangles … not bound to the inside of the ship, not truly
 * fluid").
 *
 * Each compartment's interior air cells are real voxels. The flooded water is the
 * `round(fill · cellCount)` cells with the LOWEST world-Y — because every cell has equal
 * volume that is exact volume conservation, and "lowest world-Y" makes the water pool to
 * the low side when she lists and rise as she floods, all while staying strictly inside
 * the hull (we only ever fill compartment cells). Rendered as one InstancedMesh of cubes
 * per compartment (one draw call), so it reads as water filling the hull voxel-by-voxel.
 *
 * The mesh lives UNDER the ship group (ShipVisual parents it), so the cubes inherit the
 * hull's world pose for free; we recompute the wet SET only when the fill or the ship's
 * attitude actually changes (most frames are a no-op).
 */

const WATER_COLOR = 0x1a6a72; // EXACTLY ocean.ts uShallowColor, so flood reads as the same sea

interface CF {
  n: number;
  cells: Int32Array; // packed grid index per local instance slot
  lx: Float32Array;
  ly: Float32Array;
  lz: Float32Array;
  mesh: THREE.InstancedMesh;
  worldY: Float32Array; // scratch
  order: Int32Array; // scratch (instance slots sorted by worldY)
  lastFill: number;
  lastTiltKey: number;
  frames: number;
}

export class CompartmentFluid {
  readonly group = new THREE.Group();
  private comps = new Map<number, CF>();
  private nx: number;
  private ny: number;
  private mat: THREE.MeshStandardMaterial;
  private q = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private scl = new THREE.Vector3();
  private m4 = new THREE.Matrix4();

  constructor(compartments: Compartment[], dims: [number, number, number]) {
    this.nx = dims[0];
    this.ny = dims[1];
    // slightly emissive so the water reads inside the dark hold without needing a light to
    // reach below decks; translucent with depthWrite so the fill occludes itself cleanly
    // (no transparent-overdraw mush) yet still blends against the hull behind it.
    this.mat = new THREE.MeshStandardMaterial({
      color: WATER_COLOR,
      emissive: new THREE.Color(0x0a3340), // ocean deep tone — just enough self-light to read below decks
      emissiveIntensity: 0.18,
      roughness: 0.15, // wet, slightly reflective like the sea surface
      metalness: 0.0,
      transparent: true,
      opacity: 0.8,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    for (const c of compartments) this.add(c);
  }

  private add(c: Compartment): void {
    const n = c.cells.size;
    const cells = new Int32Array(n);
    const lx = new Float32Array(n), ly = new Float32Array(n), lz = new Float32Array(n);
    const nx = this.nx, ny = this.ny, layer = this.nx * this.ny;
    let i = 0;
    for (const p of c.cells) {
      cells[i] = p;
      const x = p % nx, y = Math.floor(p / nx) % ny, z = Math.floor(p / layer);
      lx[i] = (x + 0.5) * VOXEL_SIZE;
      ly[i] = (y + 0.5) * VOXEL_SIZE;
      lz[i] = (z + 0.5) * VOXEL_SIZE;
      i++;
    }
    const geo = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);
    const mesh = new THREE.InstancedMesh(geo, this.mat, Math.max(n, 1));
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 3; // after opaque hull + ocean
    this.group.add(mesh);
    this.comps.set(c.id, {
      n, cells, lx, ly, lz, mesh,
      worldY: new Float32Array(n),
      order: new Int32Array(n),
      lastFill: -1,
      lastTiltKey: 1e9,
      frames: 99,
    });
  }

  /** Reflect current flooding. Called once per frame AFTER the ship group transform is
   *  synced. `cameraPos`/`dt` are accepted for API compatibility (unused now). */
  update(compartments: Compartment[], _cameraPos: THREE.Vector3 | undefined, _dt: number): void {
    this.group.updateWorldMatrix(true, false);
    this.group.matrixWorld.decompose(this.pos, this.q, this.scl);
    // quantized tilt key: recompute the wet set when the ship rolls/pitches enough that the
    // pool should slosh to a new low side (the quaternion's x/z carry roll+pitch).
    const tiltKey = Math.round(this.q.x * 40) * 6151 + Math.round(this.q.z * 40);

    for (const c of compartments) {
      const cf = this.comps.get(c.id);
      if (!cf) continue;
      const fill = c.volume > 0 ? c.waterVolume / c.volume : 0;
      if (fill < 0.005) {
        if (cf.mesh.count !== 0) cf.mesh.count = 0;
        cf.lastFill = 0;
        continue;
      }
      cf.frames++;
      // recompute only on a meaningful change, and at most ~every 4 frames (cheap when idle)
      if (cf.frames < 4 || (Math.abs(fill - cf.lastFill) < 0.004 && tiltKey === cf.lastTiltKey)) continue;
      cf.frames = 0;
      cf.lastFill = fill;
      cf.lastTiltKey = tiltKey;
      this.rebuildWet(cf, fill);
    }
  }

  /** Pick the wetCount lowest-world-Y cells and write their instance transforms. */
  private rebuildWet(cf: CF, fill: number): void {
    const n = cf.n;
    const wy = cf.worldY, ord = cf.order;
    const q = this.q;
    for (let i = 0; i < n; i++) {
      // world-Y of the cell centre = (R · localCentre).y. The constant ship-Y offset cancels
      // when ranking, so we only need the rotated y-component (standard quaternion-rotate).
      const vx = cf.lx[i], vy = cf.ly[i], vz = cf.lz[i];
      const tx = 2 * (q.y * vz - q.z * vy);
      const ty = 2 * (q.z * vx - q.x * vz);
      const tz = 2 * (q.x * vy - q.y * vx);
      wy[i] = vy + q.w * ty + (q.z * tx - q.x * tz);
      ord[i] = i;
    }
    const order = ord as unknown as { sort(cmp: (a: number, b: number) => number): void };
    order.sort((a, b) => wy[a] - wy[b]);
    const wetCount = Math.min(n, Math.max(0, Math.round(fill * n)));
    const m4 = this.m4;
    for (let k = 0; k < wetCount; k++) {
      const i = ord[k];
      m4.makeTranslation(cf.lx[i], cf.ly[i], cf.lz[i]);
      cf.mesh.setMatrixAt(k, m4);
    }
    cf.mesh.count = wetCount;
    cf.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const cf of this.comps.values()) cf.mesh.geometry.dispose();
    this.mat.dispose();
    this.comps.clear();
  }
}
