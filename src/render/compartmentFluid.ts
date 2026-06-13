import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import type { Compartment } from "../sim/compartments";

/**
 * Real flooded-compartment fluid (round 14, replaces the emissive blue cubes
 * `shipVisual.addWaterPlanes`/`updateWater` used to draw). Per compartment ONE
 * subdivided horizontal plane parented under the ship group; unlike the old
 * boxes — whose tops were Y-scaled in SHIP-LOCAL space and so stayed parallel
 * to the tilted deck — this surface is COUNTER-ROTATED by the inverse of the
 * ship's orientation so it holds WORLD-UP-LEVEL. Flooded water then visibly
 * pools to the listing/trimming low side, because a level plane intersected
 * against the heeled (rotated) compartment box wets the low corner first. The
 * plane is clipped to the real compartment volume by six world-space clipping
 * planes rebuilt from the bbox each frame, and shaded like water (translucent
 * blue-green, fresnel + Beer–Lambert depth darkening) keyed to the ocean
 * palette, rather than as a self-lit slab.
 */

const DEEP = new THREE.Color(0x0a3340); // matches ocean.ts uDeepColor
const SHALLOW = new THREE.Color(0x1a6a72); // matches ocean.ts uShallowColor

interface CompFluid {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** Six clip planes (world space), rebuilt each frame from the bbox. */
  planes: THREE.Plane[];
  /** Local-space AABB faces (constant): normal + signed distance for the box. */
  localPlanes: THREE.Plane[];
  /** Ship-local box extents in meters. */
  boxMinY: number;
  boxHeight: number;
  centerX: number;
  centerZ: number;
  /** Slosh oscillator state: small tilt (rad) + rate about the roll & pitch axes. */
  sloshRoll: number;
  sloshRollV: number;
  sloshPitch: number;
  sloshPitchV: number;
  /** Previous ship roll/pitch, to drive slosh off the CHANGE in attitude. */
  prevRoll: number;
  prevPitch: number;
  inited: boolean;
}

const VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  #include <clipping_planes_vertex>
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uCameraPos;
uniform float uFloorY;     // world Y of the compartment floor
uniform float uSurfaceY;   // world Y of this surface
uniform float uOpacity;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 N = normalize(vWorldNormal);
  if (dot(N, V) < 0.0) N = -N; // double-sided: always face the viewer
  float facing = clamp(dot(N, V), 0.0, 1.0);

  // Beer–Lambert-ish depth darkening: the deeper the water column beneath this
  // surface point, the darker/greener it reads (light is absorbed on the way
  // down and back). Shallow film near the floor stays brighter.
  float depth = max(uSurfaceY - uFloorY, 0.0);
  float absorb = 1.0 - exp(-depth * 0.85);
  vec3 base = mix(uShallow, uDeep, absorb);
  // grazing angles look deeper too (less of the bright floor shows through)
  base = mix(uShallow, base, mix(0.55, 1.0, 1.0 - facing));

  // fresnel sky-ish lift at glancing angles so the surface reads as water, not
  // a flat gel; kept subtle so it stays legible through the cutaway.
  float fres = pow(1.0 - facing, 4.0);
  vec3 col = mix(base, vec3(0.62, 0.78, 0.82), fres * 0.5);

  float alpha = clamp(uOpacity + fres * 0.25, 0.0, 0.95);
  gl_FragColor = vec4(col, alpha);
}
`;

export class CompartmentFluid {
  /** Parent for every compartment surface. ShipVisual adds this UNDER its own
   *  group, so it inherits the ship's world transform automatically; the
   *  surfaces below counter-rotate against that to hold world-level. */
  readonly group = new THREE.Group();
  private comps = new Map<number, CompFluid>();
  private tmpNormalMat = new THREE.Matrix3();
  private shipPos = new THREE.Vector3();
  private shipQuat = new THREE.Quaternion();
  private shipScale = new THREE.Vector3();
  private invShipQuat = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  private tmpEuler = new THREE.Euler(0, 0, 0, "ZYX");
  private tmpV = new THREE.Vector3();

  constructor(compartments: Compartment[]) {
    for (const c of compartments) this.add(c);
  }

  private add(c: Compartment): void {
    const minX = c.bboxMin[0] * VOXEL_SIZE;
    const maxX = (c.bboxMax[0] + 1) * VOXEL_SIZE;
    const minY = c.bboxMin[1] * VOXEL_SIZE;
    const maxY = (c.bboxMax[1] + 1) * VOXEL_SIZE;
    const minZ = c.bboxMin[2] * VOXEL_SIZE;
    const maxZ = (c.bboxMax[2] + 1) * VOXEL_SIZE;
    const w = maxX - minX;
    const d = maxZ - minZ;

    // the plane must still cover the box footprint once it is counter-rotated
    // off-axis, so size it to the box DIAGONAL (a square big enough that the
    // level surface always spans the wet region before the clip trims it).
    const span = Math.hypot(w, d) * 1.5;
    const geo = new THREE.PlaneGeometry(span, span, 8, 8);
    geo.rotateX(-Math.PI / 2); // lay flat: normal points +Y

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uDeep: { value: DEEP.clone() },
        uShallow: { value: SHALLOW.clone() },
        uCameraPos: { value: new THREE.Vector3() },
        uFloorY: { value: 0 },
        uSurfaceY: { value: 0 },
        uOpacity: { value: 0.6 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      clipping: true, // compile in the clipping-plane chunks
    });
    // six clip planes in world space, bounding the rotated box (rebuilt/frame)
    mat.clippingPlanes = [
      new THREE.Plane(),
      new THREE.Plane(),
      new THREE.Plane(),
      new THREE.Plane(),
      new THREE.Plane(),
      new THREE.Plane(),
    ];

    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false; // small, and the clip already bounds it
    mesh.renderOrder = 3; // draw after opaque hull + ocean
    this.group.add(mesh);

    // local-space AABB faces (point inward via negative normals at the max
    // face): three.js keeps the half-space where distanceToPoint >= 0.
    const localPlanes = [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -minX), // x >= minX
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), maxX), // x <= maxX
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -minY), // y >= minY
      new THREE.Plane(new THREE.Vector3(0, -1, 0), maxY), // y <= maxY
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -minZ), // z >= minZ
      new THREE.Plane(new THREE.Vector3(0, 0, -1), maxZ), // z <= maxZ
    ];

    this.comps.set(c.id, {
      mesh,
      mat,
      planes: mat.clippingPlanes,
      localPlanes,
      boxMinY: minY,
      boxHeight: maxY - minY,
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2,
      sloshRoll: 0,
      sloshRollV: 0,
      sloshPitch: 0,
      sloshPitchV: 0,
      prevRoll: 0,
      prevPitch: 0,
      inited: false,
    });
  }

  /**
   * Reflect current flooding. Call once per frame at the seam the old
   * `updateWater` used, AFTER the ship group's transform is synced (this reads
   * the parent's world matrix). `cameraPos` (optional) shades the view-dependent
   * fresnel rim; when absent the surface is shaded as if viewed from straight
   * above (the common cutaway/inspection angle), which keeps it stable and
   * readable. `dt` advances the slosh. The depth darkening needs no camera.
   */
  update(compartments: Compartment[], cameraPos: THREE.Vector3 | undefined, dt: number): void {
    // the parent (ship) group already carries the ship's world transform; pull
    // it so the clip planes (world space) and counter-rotation can use it.
    this.group.updateWorldMatrix(true, false);
    const shipMatrix = this.group.matrixWorld;
    shipMatrix.decompose(this.shipPos, this.shipQuat, this.shipScale);
    const q = this.shipQuat;
    this.invShipQuat.copy(q).invert();
    this.tmpNormalMat.getNormalMatrix(shipMatrix);

    // ship roll (about fore-aft +x) and pitch (about beam +z), for slosh + the
    // counter-rotation. Euler order ZYX: extract independent of yaw(y).
    this.tmpEuler.setFromQuaternion(q, "ZYX");
    const shipRoll = this.tmpEuler.x; // bank
    const shipPitch = this.tmpEuler.z; // trim
    const clampDt = Math.min(Math.max(dt, 0), 0.05);

    for (const c of compartments) {
      const cf = this.comps.get(c.id);
      if (!cf) continue;
      const fill = c.volume > 0 ? c.waterVolume / c.volume : 0;
      if (fill < 0.01) {
        cf.mesh.visible = false;
        cf.inited = false; // reset slosh so a refill doesn't kick from stale state
        continue;
      }
      cf.mesh.visible = true;

      // fill→height reconciliation: `fill` is waterVolume / TRUE-cell-volume, so
      // a brim-full compartment (waterVolume == volume) puts the surface at the
      // very top of its real cells. Mapping that true fraction onto the bbox
      // height makes solid cells inside the box raise the level faster than a
      // naive waterVolume/bboxArea would (the displaced solid has nowhere to
      // put the water but UP), which is the correct reconciliation.
      const surfaceLocalY = cf.boxMinY + fill * cf.boxHeight;

      // --- slosh: a small critically-damped 1-DOF tilt per axis, FORCED by the
      // change in ship attitude (so a roll kicks the pool, then it settles). ---
      if (!cf.inited) {
        cf.prevRoll = shipRoll;
        cf.prevPitch = shipPitch;
        cf.sloshRoll = 0;
        cf.sloshRollV = 0;
        cf.sloshPitch = 0;
        cf.sloshPitchV = 0;
        cf.inited = true;
      }
      const dRoll = shipRoll - cf.prevRoll;
      const dPitch = shipPitch - cf.prevPitch;
      cf.prevRoll = shipRoll;
      cf.prevPitch = shipPitch;

      // critically-damped spring (ζ=1): ẍ = -ω²x - 2ω·ẋ ; the ship's angular
      // VELOCITY (Δangle/dt) drives it, so the fluid lags the hull then levels.
      const omega = 7.0; // rad/s — a quick, stable rock
      const drive = 14.0; // how hard attitude change kicks the pool
      const stepSlosh = (x: number, v: number, forcing: number): [number, number] => {
        const a = -omega * omega * x - 2 * omega * v + forcing;
        const vNew = v + a * clampDt;
        const xNew = x + vNew * clampDt; // semi-implicit Euler: stable
        // hard clamp keeps a pathological dt from ever blowing up the tilt
        const xC = Math.min(Math.max(xNew, -0.18), 0.18);
        return [xC, vNew];
      };
      const rollForce = clampDt > 1e-6 ? (dRoll / clampDt) * drive : 0;
      const pitchForce = clampDt > 1e-6 ? (dPitch / clampDt) * drive : 0;
      [cf.sloshRoll, cf.sloshRollV] = stepSlosh(cf.sloshRoll, cf.sloshRollV, rollForce);
      [cf.sloshPitch, cf.sloshPitchV] = stepSlosh(cf.sloshPitch, cf.sloshPitchV, pitchForce);

      // world-level orientation + slosh: the desired WORLD quaternion of the
      // surface is a small tilt (slosh) about the world axes; counter-rotate by
      // the parent (ship) so groupQuat * localQuat == worldLevelQuat.
      // worldLevelQuat = rotX(sloshRoll) * rotZ(sloshPitch)
      this.tmpEuler.set(cf.sloshRoll, 0, cf.sloshPitch, "ZYX");
      const worldLevel = this.tmpQ2.setFromEuler(this.tmpEuler);
      // localQuat = inverse(groupQuat) * worldLevel
      cf.mesh.quaternion.copy(this.invShipQuat).multiply(worldLevel);

      // anchor the surface at the box-center XZ and the reconciled local height.
      cf.mesh.position.set(cf.centerX, surfaceLocalY, cf.centerZ);

      // world Y of floor + surface for the depth-darkening shader. The ship
      // rotation tilts the box, so the floor/surface world height under the box
      // center moves with attitude — apply q (+ ship translate) to each.
      this.tmpV.set(cf.centerX, cf.boxMinY, cf.centerZ).applyQuaternion(q);
      cf.mat.uniforms.uFloorY.value = this.shipPos.y + this.tmpV.y;
      this.tmpV.set(cf.centerX, surfaceLocalY, cf.centerZ).applyQuaternion(q);
      const surfWorldY = this.shipPos.y + this.tmpV.y;
      cf.mat.uniforms.uSurfaceY.value = surfWorldY;
      const camU = cf.mat.uniforms.uCameraPos.value as THREE.Vector3;
      if (cameraPos) {
        camU.copy(cameraPos);
      } else {
        // no camera available at this seam: shade as if viewed from straight
        // above the surface centre (V points up → minimal fresnel, deep look).
        this.tmpV.set(cf.centerX, surfaceLocalY, cf.centerZ).applyQuaternion(q);
        camU.set(this.shipPos.x + this.tmpV.x, surfWorldY + 30, this.shipPos.z + this.tmpV.z);
      }

      // rebuild the six world-space clip planes from the (constant) local box
      // faces through the live ship world matrix, so they track the heeled hull
      // while the surface above counter-rotates to stay level.
      for (let i = 0; i < 6; i++) {
        cf.planes[i].copy(cf.localPlanes[i]).applyMatrix4(shipMatrix, this.tmpNormalMat);
      }
    }
  }

  dispose(): void {
    for (const cf of this.comps.values()) {
      cf.mesh.geometry.dispose();
      cf.mat.dispose();
    }
    this.comps.clear();
  }
}
