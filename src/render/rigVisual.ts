import * as THREE from "three";
import { type Rig, LinkKind, NodeFlag } from "../sim/rigLattice";

/**
 * RigPieceVisual — draws a live rig lattice (sim/rigLattice) as VOXELS, the way the rest of the
 * ship is voxels: every WOOD link is a beam (a box spanning its two nodes) and every CLOTH node is
 * a flat canvas voxel. Both are InstancedMeshes (one draw each), re-posed from the node positions
 * every frame; a broken (dead) link / detached node collapses its instance to zero scale so a
 * snapped spar visibly separates and a torn sail loses its cells. Used for a felled mast (Phase 3)
 * and, later, standing-rig tearing. No mesh topology needed — chunky by design.
 */
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Vector3(0, 0, 0);
const _ident = new THREE.Quaternion();

export class RigPieceVisual {
  readonly group = new THREE.Group();
  private woodLinks: number[] = []; // indices into rig.links that are WOOD (beam per link)
  private clothNodes: number[] = []; // indices into rig.nodes that are CLOTH (voxel per node)
  private wood: THREE.InstancedMesh;
  private cloth: THREE.InstancedMesh;

  constructor(private rig: Rig) {
    for (let i = 0; i < rig.links.length; i++) if (rig.links[i].kind === LinkKind.WOOD) this.woodLinks.push(i);
    for (let i = 0; i < rig.nodes.length; i++) if (rig.nodes[i].flags & NodeFlag.CLOTH) this.clothNodes.push(i);

    const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a4128, roughness: 0.85 });
    const clothMat = new THREE.MeshStandardMaterial({ color: 0xe8dfc8, roughness: 0.95, side: THREE.DoubleSide });
    // unit box on +Z so a beam scales along its length in Z (see setFromUnitVectors(_up→dir) below
    // uses Z as the beam axis); cloth is a thin flat tile.
    const beamGeo = new THREE.BoxGeometry(0.18, 0.18, 1);
    const tileGeo = new THREE.BoxGeometry(0.55, 0.55, 0.06);
    this.wood = new THREE.InstancedMesh(beamGeo, woodMat, Math.max(1, this.woodLinks.length));
    this.cloth = new THREE.InstancedMesh(tileGeo, clothMat, Math.max(1, this.clothNodes.length));
    this.wood.castShadow = this.cloth.castShadow = true;
    this.wood.frustumCulled = this.cloth.frustumCulled = false; // it moves far from its origin as it falls
    this.group.add(this.wood, this.cloth);
    this.update();
  }

  /** Re-pose every instance from the current node positions (call once per rendered frame). */
  update(): void {
    const rig = this.rig;
    for (let k = 0; k < this.woodLinks.length; k++) {
      const lk = rig.links[this.woodLinks[k]];
      if (!lk.alive) { this.wood.setMatrixAt(k, _m.compose(_zero, _ident, _zero)); continue; }
      const a = rig.nodes[lk.a].pos, b = rig.nodes[lk.b].pos;
      _p.set(a.x, a.y, a.z); _q.set(b.x, b.y, b.z);
      _mid.addVectors(_p, _q).multiplyScalar(0.5);
      _dir.subVectors(_q, _p);
      const len = _dir.length();
      if (len < 1e-5) { this.wood.setMatrixAt(k, _m.compose(_zero, _ident, _zero)); continue; }
      _quat.setFromUnitVectors(_up, _dir.multiplyScalar(1 / len));
      // beam geometry's long axis is Z; rotate the up-aligned quat so Z points along dir:
      _quat.multiply(_zRot);
      _scl.set(1, 1, len);
      this.wood.setMatrixAt(k, _m.compose(_mid, _quat, _scl));
    }
    this.wood.instanceMatrix.needsUpdate = true;
    this.wood.count = this.woodLinks.length;

    const attached = this.clothNodes.length ? rigAttached(rig) : null;
    for (let k = 0; k < this.clothNodes.length; k++) {
      const ni = this.clothNodes[k];
      // a fully-detached cloth voxel (no link path to an anchor) collapses — it has blown away
      if (attached && !attached[ni]) { this.cloth.setMatrixAt(k, _m.compose(_zero, _ident, _zero)); continue; }
      const n = rig.nodes[ni].pos;
      _mid.set(n.x, n.y, n.z);
      this.cloth.setMatrixAt(k, _m.compose(_mid, _ident, _one));
    }
    this.cloth.instanceMatrix.needsUpdate = true;
    this.cloth.count = this.clothNodes.length;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.wood.geometry.dispose();
    (this.wood.material as THREE.Material).dispose();
    this.wood.dispose();
    this.cloth.geometry.dispose();
    (this.cloth.material as THREE.Material).dispose();
    this.cloth.dispose();
  }
}

const _one = new THREE.Vector3(1, 1, 1);
// rotate +Y onto +Z so a unit box (long axis Z) aligns after setFromUnitVectors(up, dir)
const _zRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

/** Connectivity over alive links from anchor nodes — but a felled mast has NO pinned anchors, so
 *  for the falling piece "attached" means reachable from any WOOD node (the spar holds the cloth).
 *  A cloth island cut off from all wood has blown free. */
function rigAttached(rig: Rig): boolean[] {
  const n = rig.nodes.length;
  const seen = new Array<boolean>(n).fill(false);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const lk of rig.links) { if (!lk.alive) continue; adj[lk.a].push(lk.b); adj[lk.b].push(lk.a); }
  const stack: number[] = [];
  for (let i = 0; i < n; i++) if (rig.nodes[i].flags & NodeFlag.WOOD) { seen[i] = true; stack.push(i); }
  while (stack.length) { const i = stack.pop()!; for (const j of adj[i]) if (!seen[j]) { seen[j] = true; stack.push(j); } }
  return seen;
}
