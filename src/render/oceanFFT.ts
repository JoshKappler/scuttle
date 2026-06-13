import * as THREE from "three";
import { G } from "../core/constants";
import { makeOceanSpectrum, type OceanSpectrum } from "../sim/oceanSpectrum";
import type { OceanField, OceanFieldOptions } from "./oceanField";

/**
 * WebGL2 ocean field backend (Route 1).
 *
 * Implements the {@link OceanField} contract by evolving the band-limited chop
 * spectrum on the GPU and inverting it with a SEPARABLE INVERSE DFT (two
 * fragment passes — sum over columns, then over rows). The math is identical to
 * the CPU reference `OceanSpectrum.heightField(t)` (which uses `ifft2d`), so the
 * GPU output can be checked texel-for-texel against it via the `readbackHeight`
 * hook the controller's oracle uses in Task 7.
 *
 * Layout convention (matches oceanSpectrum.ts / fft.ts):
 *   - The complex spectrum H[m,n] is stored row-major as idx = m*N + n.
 *   - m is the kx (row) index, n is the kz (column) index.
 *   - Wavenumbers: kx = 2π(m - N/2)/L,  kz = 2π(n - N/2)/L.  (k=0 at index N/2)
 *   - The inverse transform applies +i twiddles and divides by N²; we keep the
 *     real part. There is NO fftshift — raw array indices are transformed.
 *
 * Separable inverse DFT (equals ifft2d):
 *   h[i,j] = (1/N²) Σ_m Σ_n H[m,n] · e^{+i 2π (i·m + j·n)/N}    (real part)
 *   Pass 1 (rows, sum over n):  T[m,j] = Σ_n H[m,n] · e^{+i 2π j n / N}
 *   Pass 2 (cols, sum over m):  h[i,j] = (1/N²) Σ_m T[m,j] · e^{+i 2π i m / N}
 */

const DEFAULT_N = 128;

interface Pass {
  scene: THREE.Scene;
  cam: THREE.Camera;
  mat: THREE.ShaderMaterial;
}

/** Full-screen quad pass. The vertex shader maps the [-1,1] plane directly to
 *  clip space and forwards uv in [0,1] (texel j has uv.x = (j+0.5)/N). */
function makePass(frag: string, uniforms: Record<string, THREE.IUniform>): Pass {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  const cam = new THREE.Camera();
  return { scene, cam, mat };
}

/** A float RT used for the exact intermediate FFT passes: NearestFilter so the
 *  shader's `texture()`/`texelFetch`-style sampling reads exact texels, no wrap. */
function makeComputeRT(N: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(N, N, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

/** A final output RT the ocean mesh samples in world space: Linear + Repeat so
 *  the tile blends and wraps seamlessly across the sea. */
function makeOutputRT(N: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(N, N, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

// ---------------------------------------------------------------------------
// Shaders. NRES is #define-injected so the summation loops have a compile-time
// bound (required by GLSL ES 3.0 for-loops over a texture).
// ---------------------------------------------------------------------------

/** Evolution pass: builds H(k,t) and the choppy-displacement spectra from h0.
 *  Outputs to a single RGBA texel: RG = Re,Im of H;  BA = Re,Im of a packed
 *  displacement helper is NOT used — instead we emit three separate spectra by
 *  running this pass with a `uChannel` selector so one shader serves all three.
 *
 *  uChannel: 0 → H (height), 1 → Dx spectrum, 2 → Dz spectrum.
 *  All three are written as RG = (Re, Im) of the chosen complex spectrum. */
const EVOLUTION_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uH0;     // RG = h0Re, h0Im   (NearestFilter, N×N)
uniform float uN;
uniform float uL;
uniform float uT;
uniform float uG;
uniform int uChannel;      // 0=H, 1=Dx, 2=Dz

void main() {
  float N = uN;
  // Texel index (m = row, n = col). vUv maps texel center (idx+0.5)/N → idx.
  float m = floor(vUv.y * N);
  float n = floor(vUv.x * N);

  float kx = (2.0 * 3.14159265358979323846 * (m - N * 0.5)) / uL;
  float kz = (2.0 * 3.14159265358979323846 * (n - N * 0.5)) / uL;
  float kLen = sqrt(kx * kx + kz * kz);

  if (kLen < 1e-6) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // h0 at (m,n) and conjugate-mirror h0 at ((N-m)%N, (N-n)%N).
  float mm = mod(N - m, N);
  float nm = mod(N - n, N);
  vec2 a = texture2D(uH0, vec2((n + 0.5) / N, (m + 0.5) / N)).rg;   // h0(k)
  vec2 b = texture2D(uH0, vec2((nm + 0.5) / N, (mm + 0.5) / N)).rg; // h0(-k)

  float w = sqrt(uG * kLen) * uT;
  float c = cos(w);
  float s = sin(w);

  // H = a·e^{+iw} + conj(b)·e^{-iw}     (same as oceanSpectrum.heightField)
  // a·e^{iw}    = (a.r·c - a.i·s,  a.r·s + a.i·c)
  // conj(b)     = (b.r, -b.i)
  // conj(b)·e^{-iw} = (b.r·c + (-b.i)·(-s)?) — expand carefully:
  //   conj(b)·e^{-iw}: real = b.r·c + (-b.i)·s ... use (br - i bi)(c - i s)
  //     = (br·c - bi·s) - i(br·s + bi·c)  → real = br·c - bi·s, imag = -(br·s + bi·c)
  // Cross-check vs CPU: re = (aRe·c - aIm·s) + (bRe·c + bIm·s) with bIm = -h0Im[j].
  // With our b = (br, bi) = h0(-k): CPU bIm := -bi, so bRe·c + bIm·s = br·c - bi·s. ✓
  // imag: CPU = (aRe·s + aIm·c) + (-bRe·s + bIm·c) = (a.r·s + a.i·c) + (-br·s - bi·c). ✓
  // NOTE: a,b are vec2 (RG = Re,Im). The imaginary part is .g — NOT ".i",
  // which is an illegal swizzle that silently failed to compile on ANGLE.
  float hRe = (a.r * c - a.g * s) + (b.r * c - b.g * s);
  float hIm = (a.r * s + a.g * c) + (-b.r * s - b.g * c);

  vec2 spec = vec2(hRe, hIm);

  if (uChannel == 1) {
    // Dx(k) = -i·(kx/|k|)·H.  (-i·s)·(Re,Im) = (s·Im, -s·Re), s = kx/|k|.
    float sx = kx / kLen;
    spec = vec2(sx * hIm, -sx * hRe);
  } else if (uChannel == 2) {
    float sz = kz / kLen;
    spec = vec2(sz * hIm, -sz * hRe);
  }

  gl_FragColor = vec4(spec, 0.0, 1.0);
}
`;

/** Inverse-DFT pass 1: sum over n (columns), i.e. over uv.x of the input.
 *  Input RG = complex spectrum H[m,n]. Output RG = complex T[m,j]. */
const IDFT_ROW_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uN;
void main() {
  float N = uN;
  float m = floor(vUv.y * N);  // row preserved
  float j = floor(vUv.x * N);  // output column (spatial x index)
  vec2 acc = vec2(0.0);
  for (int nn = 0; nn < NRES; nn++) {
    float n = float(nn);
    vec2 H = texture2D(uSrc, vec2((n + 0.5) / N, (m + 0.5) / N)).rg;
    // range-reduce j*n mod N before scaling: e^{i2π·jn/N} is N-periodic in jn,
    // and j*n (≤127²) is exact in float32, so the cos/sin argument stays under
    // 2π at full highp precision (else ~791 rad loses ~4 digits → drift off the
    // CPU oracle).
    float ang = 2.0 * 3.14159265358979323846 * mod(j * n, N) / N; // +i twiddle (inverse)
    float c = cos(ang);
    float s = sin(ang);
    // complex multiply H · e^{+i ang}
    acc.x += H.x * c - H.y * s;
    acc.y += H.x * s + H.y * c;
  }
  gl_FragColor = vec4(acc, 0.0, 1.0);
}
`;

/** Inverse-DFT pass 2: sum over m (rows), i.e. over uv.y of the input.
 *  Input RG = T[m,j]. Output: real part / N² written to `uOutChannel`. */
const IDFT_COL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uPrev;   // existing displacement RT contents to preserve
uniform float uN;
uniform int uOutChannel;   // 0→R, 1→G, 2→B
void main() {
  float N = uN;
  float i = floor(vUv.y * N);  // output row (spatial y index)
  float j = floor(vUv.x * N);  // column preserved
  vec2 acc = vec2(0.0);
  for (int mm = 0; mm < NRES; mm++) {
    float m = float(mm);
    vec2 T = texture2D(uSrc, vec2((j + 0.5) / N, (m + 0.5) / N)).rg;
    float ang = 2.0 * 3.14159265358979323846 * mod(i * m, N) / N; // +i twiddle (range-reduced, see row pass)
    float c = cos(ang);
    float s = sin(ang);
    acc.x += T.x * c - T.y * s;
    acc.y += T.x * s + T.y * c;
  }
  // FFTSHIFT CORRECTION (the round-15 jitter fix). The spectrum centers the
  // wavenumber at index N/2 (kx = 2π(m − N/2)/L, see EVOLUTION_FRAG) but this
  // inverse DFT sums the RAW index i·m, omitting the e^{−iπ(i+j)} that the −N/2
  // offset implies. The recovered field is therefore the physical surface
  // MODULATED by (−1)^(i+j): a per-texel checkerboard. The mesh samples this
  // displacement texture with bilinear filtering, and the checkerboard beats
  // against the sampling lattice into the "vibrating sand / jitter" the playtests
  // kept reporting — we were tuning amplitude/damping/foam around a structural FFT
  // bug for rounds. Undo it here (applies to height + both choppiness channels,
  // which all pass through this stage). MEASURED in-browser before/after:
  // opposite-sign-adjacent texels 0.98 → 0.02, high-frequency energy 1.0 → 0.002.
  float shift = mod(i + j, 2.0) < 0.5 ? 1.0 : -1.0;
  float val = shift * acc.x / (N * N); // real part, normalized by 1/N², de-checkerboarded

  vec4 prev = texture2D(uPrev, vUv);
  vec4 outc = prev;
  if (uOutChannel == 0) outc.r = val;
  else if (uOutChannel == 1) outc.g = val;
  else outc.b = val;
  outc.a = 1.0;
  gl_FragColor = outc;
}
`;

/** Normal pass: central differences of the displacement RT (RGB = Dx, h, Dz)
 *  over grid spacing dx = L/N. We build the displaced surface gradient and take
 *  its cross product. Encodes normal*0.5+0.5 into RGB. RepeatWrapping on the
 *  source lets the differences wrap at the tile seam. */
const NORMAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uDisp;  // RGB = Dx, height, Dz
uniform float uN;
uniform float uL;
void main() {
  float N = uN;
  float texel = 1.0 / N;
  float dx = uL / N;

  vec3 dR = texture2D(uDisp, vUv + vec2(texel, 0.0)).rgb;
  vec3 dL = texture2D(uDisp, vUv - vec2(texel, 0.0)).rgb;
  vec3 dU = texture2D(uDisp, vUv + vec2(0.0, texel)).rgb;
  vec3 dD = texture2D(uDisp, vUv - vec2(0.0, texel)).rgb;

  // Tangent along +x: world position = (x + Dx, h, z + Dz).
  vec3 tx = vec3(2.0 * dx + (dR.x - dL.x), dR.y - dL.y, dR.z - dL.z);
  // Tangent along +z:
  vec3 tz = vec3(dU.x - dD.x, dU.y - dD.y, 2.0 * dx + (dU.z - dD.z));

  vec3 nrm = normalize(cross(tz, tx));
  if (nrm.y < 0.0) nrm = -nrm; // keep up-facing
  gl_FragColor = vec4(nrm * 0.5 + 0.5, 1.0);
}
`;

/** Foam pass: folding Jacobian of the horizontal displacement, accumulated with
 *  decay. J = (1+∂Dx/∂x)(1+∂Dz/∂z) − (∂Dx/∂z)(∂Dz/∂x). Folds where J<1.
 *  foam = max(foamInstant, prevFoam*0.96), ping-ponged via uPrevFoam. */
const FOAM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uDisp;     // RGB = Dx, height, Dz
uniform sampler2D uPrevFoam; // R = previous foam
uniform float uN;
uniform float uL;
void main() {
  float N = uN;
  float texel = 1.0 / N;
  float dx = uL / N;

  vec3 dR = texture2D(uDisp, vUv + vec2(texel, 0.0)).rgb;
  vec3 dL = texture2D(uDisp, vUv - vec2(texel, 0.0)).rgb;
  vec3 dU = texture2D(uDisp, vUv + vec2(0.0, texel)).rgb;
  vec3 dD = texture2D(uDisp, vUv - vec2(0.0, texel)).rgb;

  float dDxdx = (dR.x - dL.x) / (2.0 * dx);
  float dDxdz = (dU.x - dD.x) / (2.0 * dx);
  float dDzdx = (dR.z - dL.z) / (2.0 * dx);
  float dDzdz = (dU.z - dD.z) / (2.0 * dx);

  float J = (1.0 + dDxdx) * (1.0 + dDzdz) - dDxdz * dDzdx;
  // foam ONLY where the surface genuinely folds (J well below 1 = compression /
  // breaking). The old clamp(-(J-1)) fired for ANY compression (J<1), smearing
  // foam over most of the sea — which, sampled from a ~1 m/texel mask, magnified
  // into the low-res "camo" blobs. A steep ramp from J=0.55 down to J=−0.1 keeps
  // foam on the sparse breaking-crest cores; the fragment stage laces those into
  // whitewater with high-frequency detail.
  float foamInstant = smoothstep(0.55, -0.1, J);

  float prev = texture2D(uPrevFoam, vUv).r;
  float foam = max(foamInstant, prev * 0.95);
  gl_FragColor = vec4(foam, 0.0, 0.0, 1.0);
}
`;

export function createOceanFFT(renderer: THREE.WebGLRenderer, opts: OceanFieldOptions): OceanField {
  const N = opts.N && opts.N > 0 ? opts.N : DEFAULT_N;
  const L = opts.L;

  // Build the spectrum once. KEEP it for the controller's GPU-vs-CPU oracle.
  const spectrum: OceanSpectrum = makeOceanSpectrum(opts.rng, { ...opts, N });

  // --- h0 data texture (RG = h0Re, h0Im), exact texel fetch -----------------
  // The DataTexture stores RGBA float; pack h0Re→R, h0Im→G. Row-major idx=m*N+n
  // matches uv (uv.x = (n+0.5)/N, uv.y = (m+0.5)/N) given flipY=false below.
  const h0Data = new Float32Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    h0Data[i * 4 + 0] = spectrum.h0Re[i];
    h0Data[i * 4 + 1] = spectrum.h0Im[i];
    h0Data[i * 4 + 2] = 0;
    h0Data[i * 4 + 3] = 1;
  }
  const h0Tex = new THREE.DataTexture(h0Data, N, N, THREE.RGBAFormat, THREE.FloatType);
  h0Tex.minFilter = THREE.NearestFilter;
  h0Tex.magFilter = THREE.NearestFilter;
  h0Tex.wrapS = THREE.ClampToEdgeWrapping;
  h0Tex.wrapT = THREE.ClampToEdgeWrapping;
  h0Tex.flipY = false; // texel (n,m) ↔ array idx m*N+n, no vertical flip
  h0Tex.generateMipmaps = false;
  h0Tex.needsUpdate = true;

  // --- render targets -------------------------------------------------------
  const specRT = makeComputeRT(N); // RG = complex spectrum for the active channel
  const tmpRT = makeComputeRT(N); // RG = T[m,j] after IDFT row pass
  const displacementRT = makeOutputRT(N); // RGB = Dx, height, Dz
  const dispScratchRT = makeOutputRT(N); // read-source while writing displacementRT
  const normalRT = makeOutputRT(N); // RGB = normal*0.5+0.5
  const foamRT = makeOutputRT(N); // R = foam (STABLE: mesh samples this every frame)
  const foamScratchRT = makeOutputRT(N); // read-source while writing foamRT (RMW)

  // --- passes ---------------------------------------------------------------
  const define = { NRES: N };

  const evoPass = makePass(EVOLUTION_FRAG, {
    uH0: { value: h0Tex },
    uN: { value: N },
    uL: { value: L },
    uT: { value: 0 },
    uG: { value: G },
    uChannel: { value: 0 },
  });

  const rowPass = makePass(IDFT_ROW_FRAG, {
    uSrc: { value: specRT.texture },
    uN: { value: N },
  });
  rowPass.mat.defines = { ...define };

  const colPass = makePass(IDFT_COL_FRAG, {
    uSrc: { value: tmpRT.texture },
    uPrev: { value: dispScratchRT.texture },
    uN: { value: N },
    uOutChannel: { value: 1 },
  });
  colPass.mat.defines = { ...define };

  const normalPass = makePass(NORMAL_FRAG, {
    uDisp: { value: displacementRT.texture },
    uN: { value: N },
    uL: { value: L },
  });

  const foamPass = makePass(FOAM_FRAG, {
    uDisp: { value: displacementRT.texture },
    uPrevFoam: { value: foamScratchRT.texture },
    uN: { value: N },
    uL: { value: L },
  });

  function renderTo(rt: THREE.WebGLRenderTarget, pass: Pass): void {
    renderer.setRenderTarget(rt);
    renderer.render(pass.scene, pass.cam);
  }

  /** Run evolution(channel) → IDFT row → IDFT col into `outChannel` of the
   *  displacement RT. We copy the current displacement into a scratch RT first
   *  so the col pass can read the other channels while writing this one (a RT
   *  cannot be sampled and written simultaneously). */
  function transformChannel(channel: number, outChannel: number): void {
    evoPass.mat.uniforms.uChannel.value = channel;
    renderTo(specRT, evoPass);

    rowPass.mat.uniforms.uSrc.value = specRT.texture;
    renderTo(tmpRT, rowPass);

    // Preserve existing displacement channels: copy displacement → scratch,
    // then the col pass reads scratch (uPrev) and writes the merged result.
    blit(displacementRT.texture, dispScratchRT);

    colPass.mat.uniforms.uSrc.value = tmpRT.texture;
    colPass.mat.uniforms.uPrev.value = dispScratchRT.texture;
    colPass.mat.uniforms.uOutChannel.value = outChannel;
    renderTo(displacementRT, colPass);
  }

  // Simple texture copy pass (scratch needs the live displacement contents).
  const copyPass = makePass(
    /* glsl */ `
      precision highp float; varying vec2 vUv; uniform sampler2D uSrc;
      void main(){ gl_FragColor = texture2D(uSrc, vUv); }
    `,
    { uSrc: { value: null } },
  );
  function blit(src: THREE.Texture, dst: THREE.WebGLRenderTarget): void {
    copyPass.mat.uniforms.uSrc.value = src;
    renderTo(dst, copyPass);
  }

  function update(t: number): void {
    evoPass.mat.uniforms.uT.value = t;

    // Height → G, Dx → R, Dz → B of the displacement RT.
    transformChannel(0, 1); // height
    transformChannel(1, 0); // Dx
    transformChannel(2, 2); // Dz

    // Normal from displacement central differences.
    renderTo(normalRT, normalPass);

    // Foam read-modify-write into ONE stable RT (mirrors the displacement RMW):
    // copy current foam → scratch, read scratch, write foamRT. The mesh captured
    // foamRT.texture once and samples that same stable reference every frame, so
    // the foam no longer flickers at half rate from an alternating buffer.
    blit(foamRT.texture, foamScratchRT); // copy current foam → scratch
    foamPass.mat.uniforms.uPrevFoam.value = foamScratchRT.texture;
    renderTo(foamRT, foamPass); // read scratch, write stable foamRT

    renderer.setRenderTarget(null);
  }

  function dispose(): void {
    specRT.dispose();
    tmpRT.dispose();
    displacementRT.dispose();
    dispScratchRT.dispose();
    normalRT.dispose();
    foamRT.dispose();
    foamScratchRT.dispose();
    h0Tex.dispose();
    for (const p of [evoPass, rowPass, colPass, normalPass, foamPass, copyPass]) {
      p.mat.dispose();
      p.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
  }

  const field: OceanField = {
    update,
    get displacement() {
      return displacementRT.texture;
    },
    get normal() {
      return normalRT.texture;
    },
    get foam() {
      // Foam lives in ONE stable RT now (read-modify-write via foamScratchRT),
      // so this reference never alternates — the mesh samples it every frame.
      return foamRT.texture;
    },
    tileSize: L,
    active: true,
    dispose,
  };

  // --- verification hooks for the controller's GPU-vs-CPU oracle (Task 7) ---
  // __spectrum: the CPU reference; readbackHeight(): the GPU height (G channel)
  // read back from the displacement RT, to compare against spectrum.heightField.
  (field as unknown as { __spectrum: OceanSpectrum }).__spectrum = spectrum;
  (field as unknown as { readbackHeight: () => Float32Array }).readbackHeight = (): Float32Array => {
    const buf = new Float32Array(N * N * 4);
    renderer.readRenderTargetPixels(displacementRT, 0, 0, N, N, buf);
    const h = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) h[i] = buf[i * 4 + 1]; // G channel = height
    return h;
  };

  return field;
}
