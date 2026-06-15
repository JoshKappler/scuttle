import * as THREE from "three";
import { meshGrid } from "./voxelMesher";
import type { VoxelGrid } from "../sim/voxelGrid";
import { TUN } from "../core/tunables";

/**
 * Static voxel terrain: one merged greedy mesh under a scaled THREE.Group at a
 * world position. The island analogue of ShipVisual, but built ONCE and never
 * remeshed (islands don't move or take damage in this pass).
 *
 * Visual-pass-1: the plain vertex-color material gets TRIPLANAR PROCEDURAL GRIT
 * injected via onBeforeCompile — world-space FBM that darkens crevices, varies
 * each face's tone, and stipples a fine speckle, so the (now darker) voxels read
 * as weathered rock/sand/earth instead of flat bright Minecraft blocks. It only
 * modulates SHADE, never geometry, so the crisp voxel silhouettes are preserved.
 * Strength is the shared, live-tunable `islandGritUniforms` (TUN.gfx.islandGrit).
 *
 * Also exposes the (scaled) merged vertices/indices so the IslandField can hand
 * them straight to a Rapier static trimesh collider.
 */

/** Shared across every island material so the dev panel tunes all of them at once
 *  (main.ts pushes TUN.gfx.islandGrit.strength here each frame). */
export const islandGritUniforms = {
  uGritStrength: { value: TUN.gfx.islandGrit.strength },
};

export class IslandVisual {
  readonly group = new THREE.Group();
  readonly colliderVerts: Float32Array; // local metres, already × scale
  readonly colliderIndices: Uint32Array;

  constructor(grid: VoxelGrid, world: { x: number; y: number; z: number }, scale: number) {
    const mesh = meshGrid(grid);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.97,
      metalness: 0.0,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGritStrength = islandGritUniforms.uGritStrength; // shared ref

      // vertex: carry the WORLD position (group scale + translation folded in) so
      // the grit noise is stable in world space and matches across chunks.
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vGritWorld;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvGritWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );

      // fragment: 3D value-noise FBM modulating the albedo after vertex colours.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          /* glsl */ `#include <common>
          varying vec3 vGritWorld;
          uniform float uGritStrength;
          float gHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
          float gNoise(vec3 p) {
            vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(gHash(i + vec3(0,0,0)), gHash(i + vec3(1,0,0)), f.x),
                           mix(gHash(i + vec3(0,1,0)), gHash(i + vec3(1,1,0)), f.x), f.y),
                       mix(mix(gHash(i + vec3(0,0,1)), gHash(i + vec3(1,0,1)), f.x),
                           mix(gHash(i + vec3(0,1,1)), gHash(i + vec3(1,1,1)), f.x), f.y), f.z);
          }
          float gFbm(vec3 p) {
            float v = 0.0, a = 0.5;
            for (int i = 0; i < 4; i++) { v += a * gNoise(p); p *= 2.03; a *= 0.5; }
            return v;
          }`,
        )
        .replace(
          "#include <color_fragment>",
          /* glsl */ `#include <color_fragment>
          {
            float g = gFbm(vGritWorld * 0.35);      // large-scale weathering / tonal blotches
            float speck = gNoise(vGritWorld * 2.6);  // fine grit stipple
            float m = mix(1.0 - uGritStrength * 0.55, 1.0 + uGritStrength * 0.22, g);
            m *= 1.0 - uGritStrength * 0.22 * (1.0 - speck); // darken the stipple specks
            diffuseColor.rgb *= clamp(m, 0.35, 1.3);
          }`,
        );
    };

    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
    this.group.position.set(world.x, world.y, world.z);
    this.group.scale.setScalar(scale);

    // collider geometry: same verts pre-scaled (the Rapier body carries the translation)
    this.colliderVerts = new Float32Array(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i++) this.colliderVerts[i] = mesh.positions[i] * scale;
    this.colliderIndices = mesh.indices;
  }
}
