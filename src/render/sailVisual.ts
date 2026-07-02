import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { TUN } from "../core/tunables";
import type { ShipBuild } from "../sim/shipwright";
import type { VoxelGrid } from "../sim/voxelGrid";
import { SUN_DIR } from "./sky";
import {
  billowFactor,
  buildOccupancy,
  sheetBounds,
  sheetTouchesChunk,
  splitSheets,
  type RigCell,
  type SheetBounds,
} from "./sailMath";

/**
 * Round-12 SP1: CLOTH SAILS over voxel truth. The CANVAS voxels stay in the grid (bore,
 * sever, sailIntegrity, topweight — all unchanged); the hull mesher just no longer draws
 * them as cubes (render/shipVisual.ts excludes material 14 via the meshChunk predicate)
 * and THIS module draws each sail sheet as one subdivided plane with the recovered
 * billow shader (git 9411ce9^): yard-pinned belly `sin(uv.y·π)`, throttle inflation
 * `uFill`, time flutter, backlit translucency. Damage rides an R8 occupancy texture
 * (one texel per stamped canvas cell, rebuilt from the LIVE grid when a dirty chunk
 * touches the sheet): the fragment shader discards dead texels with a noise-warped rim
 * (jagged tears), the vertex shader sags the belly where canvas is gone, and the sheet
 * hides once no cloth survives — so what you SEE always matches the thrust nerf.
 */

/** Plane subdivision (spec: ~16×12). u spans the sheet's z (beam) extent, v its height. */
const SEG_U = 16;
const SEG_V = 12;
/** Belly depth per meter of sheet width — the old rig's aBelly = footWidth · 0.17. */
const BELLY_PER_M = 0.17;
/** Sheets thinner than this many cells are degenerate slivers — skip them. */
const MIN_SHEET_CELLS = 4;
/** Draped (felled-rig) droop depth per meter of sheet width — deeper than the taut standing
 *  belly (BELLY_PER_M) since a fallen sheet has lost its lacing tension. */
const DROOP_PER_M = 0.3;
/** Waterlogged canvas tint for felled-rig debris — no shader, no sun glow, just a flat,
 *  desaturated, darker cloth so it reads as dead weight, not a working sail. */
const DRAPED_COLOR = 0x5c5f4e;

/** Minimal wind shape (matches game/sailing.ts `Wind` — dir = blows TOWARD, unit-ish). */
export interface WindLike {
  dirX: number;
  dirZ: number;
  speed: number;
}

interface SheetRec {
  cells: RigCell[];
  bounds: SheetBounds;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  tex: THREE.DataTexture;
  mask: Uint8Array;
  dirty: boolean;
  alive: number;
}

export class SailVisual {
  readonly group = new THREE.Group();
  private sheets: SheetRec[] = [];
  private grid: VoxelGrid;
  /** Shared live uniforms — one set per ship, referenced by every sheet material. */
  private shared = {
    uTime: { value: 0 },
    uFill: { value: 1 },
    uLuff: { value: 0 },
    uSailTrans: { value: TUN.gfx.sail.glow },
    uSunDirW: { value: SUN_DIR.clone() },
    uSailSun: { value: new THREE.Color(1.0, 0.84, 0.62) },
  };
  private tmpFwd = new THREE.Vector3();

  /** Shared weathered-canvas photo (one texture for every ship's sails). */
  private static sailTex: THREE.Texture | null = null;
  private static loadSailTex(): THREE.Texture {
    if (!SailVisual.sailTex) {
      SailVisual.sailTex = new THREE.TextureLoader().load("assets/textures/sail.jpg", (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.repeat.set(3, 2.2);
      });
    }
    return SailVisual.sailTex;
  }

  constructor(build: ShipBuild) {
    this.grid = build.grid;
    const sailVoxels = build.sailVoxels ?? [];
    for (const mastCells of sailVoxels) {
      for (const cells of splitSheets(mastCells)) {
        if (cells.length < MIN_SHEET_CELLS) continue;
        const bounds = sheetBounds(cells)!;
        this.sheets.push(this.buildSheet(cells, bounds));
      }
    }
  }

  /** Per-frame: clock + throttle + wind response. `sailSet` is the live helm value
   *  (−0.5..1); `wind` may be null (menu/no-wind) → neutral drape; `shipQuat` turns
   *  the ship's local +x bow into world for the wind-vs-heading factor. */
  update(time: number, sailSet: number, wind: WindLike | null, shipQuat: THREE.Quaternion): void {
    if (this.sheets.length === 0) return;
    this.shared.uTime.value = time;
    let fill = 1;
    let luff = 0;
    if (wind) {
      const f = this.tmpFwd.set(1, 0, 0).applyQuaternion(shipQuat);
      const bf = billowFactor(wind.dirX, wind.dirZ, f.x, f.z);
      fill = bf.fill;
      luff = bf.luff;
    }
    // throttle inflation exactly as the old rig (uFill = 0.35 + 0.65·sailSet), scaled by
    // the wind-vs-heading fill so a head-to-wind ship LUFFS (belly → 0, flutter up).
    this.shared.uFill.value = (0.35 + 0.65 * sailSet) * fill;
    this.shared.uLuff.value = luff;
    this.shared.uSailTrans.value = TUN.gfx.sail.glow; // live dev-panel knob
  }

  /** Mark every sheet whose voxel AABB intersects a freshly-dirty chunk. Called by
   *  ShipVisual.refresh() with the grid's dirty set BEFORE it is cleared. */
  notifyDirtyChunks(keys: Set<string>): void {
    if (this.sheets.length === 0 || keys.size === 0) return;
    for (const key of keys) {
      const [cx, cy, cz] = key.split(",").map(Number);
      for (const s of this.sheets) {
        if (!s.dirty && sheetTouchesChunk(s.bounds, cx, cy, cz)) s.dirty = true;
      }
    }
  }

  /** Force a full mask rebuild (construction / port repair / whole-hull remesh). */
  markAllDirty(): void {
    for (const s of this.sheets) s.dirty = true;
  }

  /** Rebuild the occupancy textures of the marked sheets from the LIVE grid (cheap —
   *  a few hundred grid reads per touched sheet, damage-flush cadence ~10 Hz worst
   *  case). A sheet with no surviving canvas hides — matching sailIntegrity = 0. */
  refreshDamage(): void {
    for (const s of this.sheets) {
      if (!s.dirty) continue;
      s.dirty = false;
      const { alive } = buildOccupancy(this.grid, s.cells, s.bounds, s.mask);
      s.alive = alive;
      s.tex.needsUpdate = true;
      s.mesh.visible = alive > 0;
    }
  }

  /** Cutaway parity with the cannon meshes: the smooth cloth is clipped by the same
   *  live plane (the hull voxels use the mesher cull predicate instead). */
  setClipPlane(plane: THREE.Plane | null): void {
    const planes = plane ? [plane] : null;
    for (const s of this.sheets) {
      s.material.clippingPlanes = planes;
      s.material.needsUpdate = true;
    }
  }

  private buildSheet(cells: RigCell[], bounds: SheetBounds): SheetRec {
    const geo = SailVisual.sheetGeometry(bounds);
    const widthM = bounds.w * VOXEL_SIZE;
    const { mask, alive } = buildOccupancy(this.grid, cells, bounds);
    const tex = new THREE.DataTexture(mask, bounds.w, bounds.h, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.unpackAlignment = 1; // R8 rows are w bytes — not 4-aligned for arbitrary w
    tex.needsUpdate = true;

    const material = new THREE.MeshStandardMaterial({
      color: 0xe8dfc8,
      map: SailVisual.loadSailTex(),
      roughness: 0.95,
      side: THREE.DoubleSide,
    });
    const shared = this.shared;
    const own = {
      uOcc: { value: tex },
      uBelly: { value: widthM * BELLY_PER_M },
      uTexel: { value: new THREE.Vector2(1 / bounds.w, 1 / bounds.h) },
    };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = shared.uTime;
      shader.uniforms.uFill = shared.uFill;
      shader.uniforms.uLuff = shared.uLuff;
      shader.uniforms.uSailTrans = shared.uSailTrans;
      shader.uniforms.uSunDirW = shared.uSunDirW;
      shader.uniforms.uSailSun = shared.uSailSun;
      shader.uniforms.uOcc = own.uOcc;
      shader.uniforms.uBelly = own.uBelly;
      shader.uniforms.uTexel = own.uTexel;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uTime;
          uniform float uFill;
          uniform float uLuff;
          uniform float uBelly;
          uniform sampler2D uOcc;
          varying vec3 vSailWN;
          varying vec2 vSailUv;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          {
            // uv.y: 0 at the lower yard → 1 at the upper (both laced — sin(uv.y·π) pins
            // belly AND flutter to the spars); uv.x: 0..1 across the beam. Local +x is
            // FORWARD (the bow), so the canvas bellies ahead of the mast plane.
            float yardPin = sin(uv.y * 3.14159);
            // local surviving-canvas fraction: shot-away cloth stops carrying belly → sag.
            float occV = texture2D(uOcc, uv).r;
            float sag = smoothstep(0.35, 0.95, occV);
            float belly = yardPin * (0.35 + 0.65 * sin(uv.x * 3.14159)) * uBelly * uFill * sag;
            // luffing (head-to-wind): the belly collapses (uFill → 0) while the flogging
            // amplitude + rate RISE with uLuff.
            float flap = (0.04 + uBelly * 0.03) * (0.35 + 0.65 * max(uFill, 0.0)) + uLuff * (0.05 + uBelly * 0.06);
            float flutter = sin(uTime * (4.6 + uLuff * 6.0) + uv.x * 8.0 + uv.y * 5.0) * flap * yardPin;
            transformed.x += belly + flutter;
          }
          vSailWN = normalize(mat3(modelMatrix) * normal);
          vSailUv = uv;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vSailWN;
          varying vec2 vSailUv;
          uniform sampler2D uOcc;
          uniform vec2 uTexel;
          uniform vec3 uSunDirW;
          uniform vec3 uSailSun;
          uniform float uSailTrans;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          {
            // 3-state occupancy (render/sailMath.ts): 1.0 alive, ~0.5 shot away, 0 never-cloth
            // (the taper margin of the bounding rect). Hard-cut the never-cloth margin, then
            // re-test with a warped uv so a shot hole's rim tears jagged, not a clean bilinear oval.
            float occ0 = texture2D(uOcc, vSailUv).r;
            if (occ0 < 0.20) discard;
            vec2 warp = vec2(
              sin(vSailUv.y * 97.0 + vSailUv.x * 31.0),
              sin(vSailUv.x * 83.0 - vSailUv.y * 41.0)
            ) * uTexel * 1.4;
            float occW = texture2D(uOcc, vSailUv + warp).r;
            if (occW < 0.72) discard;
          }`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          // back-lit translucency (recovered from 9411ce9^): when the sun strikes the FAR
          // side of the thin canvas the light leaks through — warm ADDITIVE glow, cloth
          // stays opaque, weave modulates it. Injected at emissivemap_fragment (the same
          // safe pre-lighting point the hull's shade floor uses).
          `#include <emissivemap_fragment>
          {
            vec3 wnf = normalize(vSailWN);
            if (!gl_FrontFacing) wnf = -wnf;
            float backlit = max(dot(-wnf, normalize(uSunDirW)), 0.0);
            backlit = pow(backlit, 0.8);
            float texL = dot(diffuseColor.rgb, vec3(0.3333));
            totalEmissiveRadiance += uSailSun * (uSailTrans * backlit * (0.45 + 0.55 * texL));
          }`,
        );
    };

    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.visible = alive > 0;
    this.group.add(mesh);
    return { cells, bounds, mesh, material, tex, mask, dirty: false, alive };
  }

  /** One subdivided plane in SHIP-LOCAL METERS (parents straight onto the ship group,
   *  like the chunk meshes): x = the canvas plane's centre, u → z ascending, v → y
   *  ascending — the SAME row-major layout buildOccupancy writes, so uv IS the mask
   *  coordinate. Constant +x normal (DoubleSide material lights the back). */
  private static sheetGeometry(b: SheetBounds): THREE.BufferGeometry {
    const nu = SEG_U + 1;
    const nv = SEG_V + 1;
    const positions = new Float32Array(nu * nv * 3);
    const normals = new Float32Array(nu * nv * 3);
    const uvs = new Float32Array(nu * nv * 2);
    const x = (b.x + 0.5) * VOXEL_SIZE;
    for (let iv = 0; iv < nv; iv++) {
      const v = iv / SEG_V;
      const y = (b.y0 + v * b.h) * VOXEL_SIZE;
      for (let iu = 0; iu < nu; iu++) {
        const u = iu / SEG_U;
        const i = iv * nu + iu;
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = (b.z0 + u * b.w) * VOXEL_SIZE;
        normals[i * 3] = 1;
        uvs[i * 2] = u;
        uvs[i * 2 + 1] = v;
      }
    }
    const indices = new Uint16Array(SEG_U * SEG_V * 6);
    let k = 0;
    for (let iv = 0; iv < SEG_V; iv++) {
      for (let iu = 0; iu < SEG_U; iu++) {
        const a = iv * nu + iu;
        const bb = a + 1;
        const c = a + nu;
        const d = c + 1;
        indices[k++] = a; indices[k++] = bb; indices[k++] = d;
        indices[k++] = a; indices[k++] = d; indices[k++] = c;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    return geo;
  }
}

/**
 * FELLED-RIG debris (spec SP1 item 5a): a limp, DRAPED variant of the sail sheets for a
 * severed mast/canvas island (`game/debris.ts spawnMast`). No throttle shader, no wind billow,
 * no occupancy mask (a severed island's cells are fixed at spawn — whatever CANVAS survived the
 * sever is all there ever will be) — just a baked-in droop (deeper + asymmetric vs the taut
 * standing belly, since the lacing tension is gone) and a flat waterlogged tint. `cells` are
 * ALREADY re-based to the debris body's own local grid origin (island cells minus its bbox
 * min, like `meshChunk`'s regrid in `spawnMast`) — same coordinate convention as the standing
 * rig, so the returned meshes parent directly into the debris group alongside the cube mesh.
 * One shared material (no textures/uniforms) keeps a big derelict cheap to draw.
 */
export function buildDrapedSheets(cells: RigCell[]): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  const material = new THREE.MeshStandardMaterial({
    color: DRAPED_COLOR,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  for (const sheetCells of splitSheets(cells)) {
    if (sheetCells.length < MIN_SHEET_CELLS) continue;
    const bounds = sheetBounds(sheetCells);
    if (!bounds) continue;
    const mesh = new THREE.Mesh(drapedGeometry(bounds), material);
    mesh.castShadow = true;
    meshes.push(mesh);
  }
  return meshes;
}

/** Like `SailVisual.sheetGeometry` but the belly is BAKED into the vertex positions (no
 *  shader/uniforms) and hangs from the TOP edge (v=1, sag ∝ (1−v)) rather than being pinned taut
 *  at both yards — reads as a loose sheet dangling off a broken spar. */
function drapedGeometry(b: SheetBounds): THREE.BufferGeometry {
  const nu = SEG_U + 1;
  const nv = SEG_V + 1;
  const positions = new Float32Array(nu * nv * 3);
  const normals = new Float32Array(nu * nv * 3);
  const widthM = b.w * VOXEL_SIZE;
  const droop = widthM * DROOP_PER_M;
  for (let iv = 0; iv < nv; iv++) {
    const v = iv / SEG_V;
    const y = (b.y0 + v * b.h) * VOXEL_SIZE;
    const hang = 1 - v; // 0 at the top edge (still pinned), 1 at the loose bottom
    for (let iu = 0; iu < nu; iu++) {
      const u = iu / SEG_U;
      const i = iv * nu + iu;
      const sag = droop * hang * Math.sin(u * Math.PI);
      positions[i * 3] = (b.x + 0.5) * VOXEL_SIZE + sag;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = (b.z0 + u * b.w) * VOXEL_SIZE;
      normals[i * 3] = 1;
    }
  }
  const indices = new Uint16Array(SEG_U * SEG_V * 6);
  let k = 0;
  for (let iv = 0; iv < SEG_V; iv++) {
    for (let iu = 0; iu < SEG_U; iu++) {
      const a = iv * nu + iu;
      const bb = a + 1;
      const c = a + nu;
      const d = c + 1;
      indices[k++] = a; indices[k++] = bb; indices[k++] = d;
      indices[k++] = a; indices[k++] = d; indices[k++] = c;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals(); // the baked sag bends the surface — normals must follow it
  return geo;
}
