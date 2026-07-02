import * as THREE from "three";
import type { Ship } from "../game/ship";
import type { Ocean } from "./ocean";

// cutaway damage view (X): a FIXED half-cut of the PLAYER ship. The plane is the
// ship's LONGITUDINAL CENTERLINE (a vertical plane through the keel, normal = the
// hull's beam axis), so she's sliced in half down her length and the whole interior
// — decks, compartments, flooding — reads as a clean cross-section. The plane is
// STATIC RELATIVE TO THE SHIP: clipping planes are world-space, so each frame we
// transform that fixed local plane by the live ship pose (it rides the centerline as
// she turns) — NOT the old camera-driven sweep, which playtested as "too hard to deal
// with". The ocean gets a box hole around the player so the hold reads as air, not sea.
//
// CUTAWAY SEA BACKING: a downward sightline through the cut hole must land on deep water, never the white
// sky/void. The old fix was a separate 70 m navy BOWL centred under the ship — but its flat rim sat just
// under the sea and the swell is NOT flat, so the rim poked through the waves as a hard "circular cutout
// ring around the ship" (and where the cut reached past the hull you saw the bowl as a flat-blue "void").
// DELETED. The ocean already carries a huge (r≈2350) seamless underwater backdrop shell that follows the
// camera and holds its rim just under the live surface (render/ocean.ts) — it backs every downward cut
// sightline with the SAME deep navy as the open sea, with no near rim to ring and no second disc to read
// as void. So the cutaway now relies on that one shared backdrop; there is no ship-local bowl.
//
// INTERIOR FILL — "the inside of the ship is always well lit and visible". The sun +
// hemisphere only graze the deck; the hold, the lower deck, and anything seen through a
// breach / open hatch / the cutaway sit in shadow and crush near-black. A soft point
// light parked at the player hull's centre (short range, so it's a LOCAL fill that lifts
// the interior timber + flood water without touching the bright ocean/exterior) keeps the
// inside readable at all times — under the deck, through shot holes, and in the cutaway.
// No shadow casting (it's a fill, and the inside has no sun-shadow to honour).
// Intensity is deliberately LOW (was 2.4): parked at the hull COM only a few cells above the bilge, a
// bright point light blew the nearest below-deck cap faces past 1.0 → tonemapped to a pale WHITE wash that
// read as "the ballast is white and bleeds into the bulkheads" in the cutaway. 0.9 keeps the interior
// readable (the cutaway `shadeFloor` ambient does the lifting) while the iron reads as dark charcoal.

export interface CutawayDeps {
  scene: THREE.Scene;
  camera: THREE.Camera;
  ocean: Pick<Ocean, "setCutaway" | "updateCutaway">;
  getShip(): Ship;
}

export class CutawayController {
  private on = false;
  private readonly cutPlane = new THREE.Plane();
  // the ship-local beam axis (+Z) and a point on the keel centerline, reused each frame
  // to rebuild the world-space centerline cut plane from the live hull pose.
  private readonly cutNormalWorld = new THREE.Vector3();
  private readonly cutPointWorld = new THREE.Vector3();
  private readonly interiorFill: THREE.PointLight;
  private readonly holeQ = new THREE.Quaternion();
  private readonly holeFwd = new THREE.Vector3();
  private readonly holeCenter = new THREE.Vector3();

  constructor(private readonly d: CutawayDeps) {
    this.interiorFill = new THREE.PointLight(0xfff0d8, 0.9, 26, 1.6);
    this.interiorFill.castShadow = false;
    d.scene.add(this.interiorFill);
  }

  get enabled(): boolean {
    return this.on;
  }

  /** X hotkey. Only the PLAYER ship is cut — the plane is HER centerline (the camera
   *  follows her). Enemy hulls stay whole; they're inspected from afar. */
  toggle(): void {
    this.on = !this.on;
    this.d.getShip().visual.setCutaway(this.on ? this.cutPlane : null);
    this.d.ocean.setCutaway(this.on);
  }

  /** If the cutaway is on, carry it onto the freshly-built hull (the plane is the player's
   *  centerline; update() keeps it tracking the new ship's pose). Call AFTER the swap has
   *  re-pointed the live ship reference. */
  onShipSwapped(): void {
    if (this.on) this.d.getShip().visual.setCutaway(this.cutPlane);
  }

  /** Keep the interior fill at the player hull's centre of mass — it rides inside the
   *  hold so it lights the lower deck / compartments / flood water (seen via cutaway or
   *  a breach) at all times, then falls off well before reaching the open sea. */
  updateInteriorFill(): void {
    const com = this.d.getShip().body.worldCom();
    this.interiorFill.position.set(com.x, com.y, com.z);
  }

  private updateHole(ship: Ship): void {
    const rotS = ship.body.rotation();
    this.holeQ.set(rotS.x, rotS.y, rotS.z, rotS.w);
    this.holeFwd.set(1, 0, 0).applyQuaternion(this.holeQ);
    this.holeFwd.y = 0;
    this.holeFwd.normalize();
    const fp = ship.build.footprint;
    ship.localToWorld([(fp.minX + fp.maxX) / 2, 2, fp.zC], this.holeCenter);
    this.d.ocean.updateCutaway(this.holeCenter, this.holeFwd.x, this.holeFwd.z, this.cutPlane);
  }

  /** Per-frame while on: STATIC half-cut, fixed to the SHIP — rebuild the world-space
   *  centerline plane from the live pose, flip the normal to face away from the camera
   *  (the near half clips), refresh the sea hole, and re-cull the hull half as the
   *  camera orbits. THREE clips away the NEGATIVE side, so we point the normal at the
   *  half FACING AWAY from the camera → the near half is removed and we look straight
   *  down the open interior, full length. */
  update(): void {
    if (!this.on) return;
    const ship = this.d.getShip();
    const rotS = ship.body.rotation();
    this.holeQ.set(rotS.x, rotS.y, rotS.z, rotS.w);
    // ship-local +Z is the beam (centerline normal); keep it horizontal so the cut is
    // a clean vertical slice regardless of heel/pitch.
    this.cutNormalWorld.set(0, 0, 1).applyQuaternion(this.holeQ);
    this.cutNormalWorld.y = 0;
    this.cutNormalWorld.normalize();
    // a point ON the centerline: the hull footprint's z-center, mid-length, at deck level.
    const fp = ship.build.footprint;
    ship.localToWorld([(fp.minX + fp.maxX) / 2, 2, fp.zC], this.cutPointWorld);
    // flip the normal to face away from the camera so the near (camera-side) half clips.
    if (
      this.cutNormalWorld.x * (this.d.camera.position.x - this.cutPointWorld.x) +
        this.cutNormalWorld.z * (this.d.camera.position.z - this.cutPointWorld.z) >
      0
    ) {
      this.cutNormalWorld.negate();
    }
    this.cutPlane.setFromNormalAndCoplanarPoint(this.cutNormalWorld, this.cutPointWorld);
    this.updateHole(ship);
    // re-cull the HULL half every frame as the camera orbits (the cannons' clip plane already follows
    // for free). refresh() — which also does this — is only called on damage, so without this the open
    // hull half never swapped when you dragged to the other side; only the cannons flipped.
    this.d.getShip().visual.updateCutawayCull();
    // (no ship-local backing bowl any more — the ocean's own shared underwater backdrop backs the cut
    //  hole's downward view with seamless deep navy, with no near rim to read as a ring. See ocean.ts.)
  }
}
