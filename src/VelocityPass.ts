import {
  Color,
  DataTexture,
  FloatType,
  HalfFloatType,
  Matrix4,
  Mesh,
  NearestFilter,
  NoBlending,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SkinnedMesh,
  WebGLRenderTarget,
  type Material,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { Pass } from 'postprocessing';

class VelocityMaterial extends ShaderMaterial {
  constructor() {
    super({
      blending: NoBlending,
      depthWrite: true,
      depthTest: true,
      toneMapped: false,
      uniforms: {
        uJitteredViewProj: { value: new Matrix4() },
        uCurrentViewProj: { value: new Matrix4() },
        uPreviousViewProj: { value: new Matrix4() },
        uPreviousWorld: { value: new Matrix4() },
        uPreviousBoneTexture: { value: null },
        uPreviousBindMatrix: { value: new Matrix4() },
        uPreviousBindMatrixInverse: { value: new Matrix4() },
        uHistoryValid: { value: 0.0 },
        uMotionWriter: { value: 0.0 },
      },
      vertexShader: /* glsl */ `
        uniform mat4 uJitteredViewProj;
        uniform mat4 uCurrentViewProj;
        uniform mat4 uPreviousViewProj;
        uniform mat4 uPreviousWorld;
        varying vec4 vCurrentClip;
        varying vec4 vPreviousClip;

        #include <skinning_pars_vertex>
        #ifdef USE_SKINNING
          uniform highp sampler2D uPreviousBoneTexture;
          uniform mat4 uPreviousBindMatrix;
          uniform mat4 uPreviousBindMatrixInverse;

          mat4 previousBoneMatrix(float index) {
            int size = textureSize(uPreviousBoneTexture, 0).x;
            int j = int(index) * 4;
            ivec2 p = ivec2(j % size, j / size);
            return mat4(
              texelFetch(uPreviousBoneTexture, p, 0),
              texelFetch(uPreviousBoneTexture, p + ivec2(1, 0), 0),
              texelFetch(uPreviousBoneTexture, p + ivec2(2, 0), 0),
              texelFetch(uPreviousBoneTexture, p + ivec2(3, 0), 0)
            );
          }
        #endif

        void main() {
          vec3 transformed = position;
          #include <skinbase_vertex>
          #include <skinning_vertex>
          vec4 localPosition = vec4(transformed, 1.0);
          vec4 previousLocalPosition = vec4(position, 1.0);
          #ifdef USE_SKINNING
            vec4 previousSkinVertex = uPreviousBindMatrix * previousLocalPosition;
            vec4 previousSkinned =
              previousBoneMatrix(skinIndex.x) * previousSkinVertex * skinWeight.x +
              previousBoneMatrix(skinIndex.y) * previousSkinVertex * skinWeight.y +
              previousBoneMatrix(skinIndex.z) * previousSkinVertex * skinWeight.z +
              previousBoneMatrix(skinIndex.w) * previousSkinVertex * skinWeight.w;
            previousLocalPosition = vec4((uPreviousBindMatrixInverse * previousSkinned).xyz, 1.0);
          #endif
          vec4 worldPosition = modelMatrix * localPosition;
          gl_Position = uJitteredViewProj * worldPosition;
          vCurrentClip = uCurrentViewProj * worldPosition;
          vPreviousClip = uPreviousViewProj * uPreviousWorld * previousLocalPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uHistoryValid;
        uniform float uMotionWriter;
        varying vec4 vCurrentClip;
        varying vec4 vPreviousClip;

        void main() {
          if (uHistoryValid < 0.5 || vCurrentClip.w <= 1e-6 || vPreviousClip.w <= 1e-6) {
            gl_FragColor = vec4(0.0);
            return;
          }

          vec2 currentUV = vCurrentClip.xy / vCurrentClip.w * 0.5 + 0.5;
          vec2 previousUV = vPreviousClip.xy / vPreviousClip.w * 0.5 + 0.5;
          // B marks an object-motion writer; the resolver reconstructs camera-only motion.
          gl_FragColor = vec4(currentUV - previousUV, uMotionWriter, 1.0);
        }
      `,
    });
  }
}

interface MotionEntry {
  proxy: Mesh;
  materials: VelocityMaterial[];
  previousWorld: Matrix4;
  hasHistory: boolean;
  motionWriter: boolean;
  skinHistory?: {
    skeleton: SkinnedMesh['skeleton'];
    bones: SkinnedMesh['skeleton']['bones'];
    texture: DataTexture;
    matrices: Float32Array;
    bindMatrix: Matrix4;
    bindMatrixInverse: Matrix4;
  };
}

/**
 * Motion for opaque rigid and skinned meshes. Shares geometry without replacing source objects.
 * Morphs, instancing and cutouts are skipped; custom vertex deformation is unsupported.
 * RG is current-minus-previous unjittered UV; B identifies an explicit object-motion writer.
 * A writer stays valid when it stops moving. Rasterization alone uses the jittered projection.
 */
export class VelocityPass extends Pass {
  private readonly previousViewProj = new Matrix4();
  private readonly currentViewProj = new Matrix4();
  private readonly jitteredViewProj = new Matrix4();
  private hasHistory = false;
  private hasFrameData = false;
  private rt: WebGLRenderTarget | null = null;
  private readonly motionScene = new Scene();
  private readonly rasterCamera = new PerspectiveCamera();
  private readonly entries = new Map<Mesh, MotionEntry>();
  private readonly clearColor = new Color();

  constructor() {
    super('VelocityPass');
    this.needsSwap = false;
    this.rasterCamera.matrixAutoUpdate = false;
    this.rasterCamera.matrixWorldAutoUpdate = false;
  }

  setSize(width: number, height: number): void {
    this.rt?.dispose();
    this.rt = new WebGLRenderTarget(width, height, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      type: HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.reset();
  }

  get texture(): Texture | null {
    return this.rt?.texture ?? null;
  }

  reset(): void {
    this.hasHistory = false;
    this.hasFrameData = false;
    this.previousViewProj.identity();
    for (const entry of this.entries.values()) entry.hasHistory = false;
  }

  // Call after the color render, when source matrixWorld values represent the current frame.
  setFrameData(
    scene: Scene,
    camera: PerspectiveCamera,
    currentNonJitteredVP: Matrix4,
    jitteredVP: Matrix4,
  ): void {
    this.currentViewProj.copy(currentNonJitteredVP);
    this.jitteredViewProj.copy(jitteredVP);
    this.rasterCamera.copy(camera, false);
    this.rasterCamera.matrixAutoUpdate = false;
    this.rasterCamera.matrixWorldAutoUpdate = false;
    // Derive the culling projection from the captured VP, independent of later clearViewOffset().
    this.rasterCamera.projectionMatrix.multiplyMatrices(jitteredVP, camera.matrixWorld);
    this.rasterCamera.projectionMatrixInverse.copy(this.rasterCamera.projectionMatrix).invert();

    const activeMeshes = new Set<Mesh>();
    scene.traverseVisible((object) => {
      if (!(object instanceof Mesh) || !object.layers.test(camera.layers)) return;
      const specialized = object as Mesh & { isInstancedMesh?: boolean };
      if (specialized.isInstancedMesh ||
          Object.keys(object.geometry.morphAttributes).length > 0) return;

      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      if (!sourceMaterials.some(isSupportedMaterial)) return;
      activeMeshes.add(object);
      let entry = this.entries.get(object);
      const skin = object instanceof SkinnedMesh ? object : null;
      // A different vertex layout or bone mapping has no corresponding previous pose.
      if (entry && (entry.proxy.geometry !== object.geometry ||
          (skin && (!entry.skinHistory || entry.skinHistory.skeleton !== skin.skeleton ||
            entry.skinHistory.bones.length !== skin.skeleton.bones.length ||
            entry.skinHistory.bones.some((bone, i) => bone !== skin.skeleton.bones[i]))))) {
        this.removeEntry(object, entry);
        entry = undefined;
      }
      if (!entry) {
        const proxy = skin ? new SkinnedMesh(object.geometry, []) : new Mesh(object.geometry, []);
        proxy.matrixAutoUpdate = false;
        proxy.matrixWorldAutoUpdate = false;
        entry = {
          proxy,
          materials: [],
          previousWorld: new Matrix4(),
          hasHistory: false,
          motionWriter: !!skin || object.userData.taaMotionWriter === true,
        };
        if (skin) {
          const size = Math.max(4, Math.ceil(Math.sqrt(skin.skeleton.bones.length * 4) / 4) * 4);
          const matrices = new Float32Array(size * size * 4);
          const texture = new DataTexture(matrices, size, size, undefined, FloatType);
          texture.needsUpdate = true;
          entry.skinHistory = {
            skeleton: skin.skeleton, bones: skin.skeleton.bones.slice(), texture, matrices,
            bindMatrix: new Matrix4(), bindMatrixInverse: new Matrix4(),
          };
        }
        this.entries.set(object, entry);
        this.motionScene.add(proxy);
      }

      while (entry.materials.length > sourceMaterials.length) entry.materials.pop()!.dispose();
      while (entry.materials.length < sourceMaterials.length) entry.materials.push(new VelocityMaterial());
      entry.proxy.geometry = object.geometry;
      entry.proxy.material = Array.isArray(object.material) ? entry.materials : entry.materials[0];
      entry.proxy.matrix.copy(object.matrixWorld);
      entry.proxy.matrixWorld.copy(object.matrixWorld);
      entry.proxy.layers.mask = object.layers.mask;
      entry.proxy.frustumCulled = object.frustumCulled;
      entry.proxy.renderOrder = object.renderOrder;
      if (skin && entry.proxy instanceof SkinnedMesh) {
        entry.proxy.skeleton = skin.skeleton;
        entry.proxy.bindMode = skin.bindMode;
        entry.proxy.bindMatrix.copy(skin.bindMatrix);
        entry.proxy.bindMatrixInverse.copy(skin.bindMatrixInverse);
        // Match the color pass's skinned bounds, rather than the undeformed geometry bounds.
        entry.proxy.boundingSphere = skin.boundingSphere;
        // Also capture a fresh pose when the source was outside the color pass's frustum.
        if (!skin.skeleton.boneTexture) skin.skeleton.computeBoneTexture();
        skin.skeleton.update();
      }

      const validHistory = this.hasHistory && entry.hasHistory;
      const objectMoved = validHistory && !entry.previousWorld.equals(object.matrixWorld);
      // Keep a dynamic object's writer identity through stationary frames and history resets.
      entry.motionWriter ||= objectMoved || object.userData.taaMotionWriter === true;
      for (let i = 0; i < sourceMaterials.length; i += 1) {
        const source = sourceMaterials[i];
        const material = entry.materials[i];
        material.visible = isSupportedMaterial(source);
        material.side = source.side;
        const wireframeSource = source as Material & { wireframe?: boolean; wireframeLinewidth?: number };
        material.wireframe = wireframeSource.wireframe ?? false;
        material.wireframeLinewidth = wireframeSource.wireframeLinewidth ?? 1;
        material.polygonOffset = source.polygonOffset;
        material.polygonOffsetFactor = source.polygonOffsetFactor;
        material.polygonOffsetUnits = source.polygonOffsetUnits;
        material.uniforms.uJitteredViewProj.value.copy(this.jitteredViewProj);
        material.uniforms.uCurrentViewProj.value.copy(this.currentViewProj);
        material.uniforms.uPreviousViewProj.value.copy(this.previousViewProj);
        material.uniforms.uPreviousWorld.value.copy(validHistory ? entry.previousWorld : object.matrixWorld);
        material.uniforms.uHistoryValid.value = validHistory ? 1.0 : 0.0;
        material.uniforms.uMotionWriter.value = validHistory && entry.motionWriter ? 1.0 : 0.0;
        if (skin && entry.skinHistory) {
          material.uniforms.uPreviousBoneTexture.value = validHistory
            ? entry.skinHistory.texture : skin.skeleton.boneTexture;
          material.uniforms.uPreviousBindMatrix.value.copy(validHistory
            ? entry.skinHistory.bindMatrix : skin.bindMatrix);
          material.uniforms.uPreviousBindMatrixInverse.value.copy(validHistory
            ? entry.skinHistory.bindMatrixInverse : skin.bindMatrixInverse);
        }
      }
    });

    // Dropping invisible or removed objects also prevents stale motion when they reappear.
    for (const [source, entry] of this.entries) {
      if (!activeMeshes.has(source)) {
        this.removeEntry(source, entry);
      }
    }
    this.hasFrameData = true;
  }

  render(
    renderer: WebGLRenderer,
    _inputBuffer: WebGLRenderTarget | null = null,
    _outputBuffer: WebGLRenderTarget | null = null,
    _deltaTime?: number,
    _stencilTest?: boolean,
  ): void {
    if (!this.rt || !this.hasFrameData) return;

    const previousTarget = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipLevel = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear;
    const clearAlpha = renderer.getClearAlpha();
    const xrEnabled = renderer.xr.enabled;
    renderer.getClearColor(this.clearColor);
    try {
      renderer.autoClear = false;
      renderer.xr.enabled = false;
      // The target supplies its own full-size viewport and disabled scissor, including at DPR > 1.
      renderer.setRenderTarget(this.rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      // Static non-writer meshes write depth and B=0 too, so they occlude moving meshes correctly.
      renderer.render(this.motionScene, this.rasterCamera);
    } finally {
      renderer.setRenderTarget(previousTarget, cubeFace, mipLevel);
      renderer.setClearColor(this.clearColor, clearAlpha);
      renderer.autoClear = autoClear;
      renderer.xr.enabled = xrEnabled;
    }

    this.previousViewProj.copy(this.currentViewProj);
    for (const entry of this.entries.values()) {
      entry.previousWorld.copy(entry.proxy.matrixWorld);
      if (entry.skinHistory && entry.proxy instanceof SkinnedMesh) {
        const history = entry.skinHistory;
        history.matrices.set(history.skeleton.boneMatrices.subarray(0, history.bones.length * 16));
        history.texture.needsUpdate = true;
        history.bindMatrix.copy(entry.proxy.bindMatrix);
        history.bindMatrixInverse.copy(entry.proxy.bindMatrixInverse);
      }
      entry.hasHistory = true;
    }
    this.hasHistory = true;
    this.hasFrameData = false;
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
    for (const [source, entry] of this.entries) this.removeEntry(source, entry);
    this.motionScene.clear();
    this.hasFrameData = false;
    // Shared source geometries belong to the original scene and are not disposed here.
    super.dispose();
  }

  private removeEntry(source: Mesh, entry: MotionEntry): void {
    this.motionScene.remove(entry.proxy);
    for (const material of entry.materials) material.dispose();
    entry.skinHistory?.texture.dispose();
    this.entries.delete(source);
  }
}

function isSupportedMaterial(material: Material): boolean {
  return material.visible && !material.transparent && material.alphaTest === 0 && !material.alphaHash;
}
