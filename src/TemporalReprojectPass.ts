import {
  DepthFormat, DepthTexture, FloatType, HalfFloatType, LinearFilter, Matrix4,
  Mesh, NearestFilter, OrthographicCamera, PerspectiveCamera, PlaneGeometry,
  Quaternion, Scene, Vector2, Vector3, WebGLRenderTarget,
  type Texture, type WebGLRenderer,
} from 'three';
import { Pass } from 'postprocessing';
import type { VelocityPass } from './VelocityPass';
import { createTemporalResolveMaterial } from './TemporalResolveMaterial';

// Captured phases, also used by RolePage's TemporalAntialiasingCamera.
export const CAPTURE_JITTER = [[-.125, -.375], [.375, -.125], [.125, .375], [-.375, .125]] as const;

export class TemporalReprojectPass extends Pass {
  taaEnabled = true;
  blendFactor = 0.25;
  jitterScale = 1.0;
  exposure = 1.0;
  // Optional float texture of integer stencil values (responsive bit 8).
  responsiveMask: Texture | null = null;
  showVelocity = false;
  showDiff = false;
  useBicubicHistorySampling = true;
  frame = 0;
  private width = 0;
  private height = 0;
  private readonly currViewProj = new Matrix4();
  private readonly prevViewProj = new Matrix4();
  private readonly jitteredViewProj = new Matrix4();
  private readonly savedProjection = new Matrix4();
  private readonly prevProjection = new Matrix4();
  private readonly jitterMatrix = new Matrix4();
  private readonly prevPosition = new Vector3();
  private readonly prevRotation = new Quaternion();
  private readonly worldPosition = new Vector3();
  private readonly worldRotation = new Quaternion();
  private hasHistory = false;
  private lastJitterScale = 1;
  private sceneTarget: WebGLRenderTarget | null = null;
  private histA: WebGLRenderTarget | null = null;
  private histB: WebGLRenderTarget | null = null;
  private debugTarget: WebGLRenderTarget | null = null;
  private outputTexture: Texture | null = null;
  private readonly resolveMat = createTemporalResolveMaterial();
  private readonly defaultStencil = this.resolveMat.uniforms.tStencil.value;
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.resolveMat);
  private readonly fsScene = new Scene();
  private readonly fsCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(private readonly sceneRef: Scene, private readonly cameraRef: PerspectiveCamera,
    private readonly velocityPass: VelocityPass) {
    super('TemporalReprojectPass');
    this.needsSwap = false;
    this.fsScene.add(this.quad);
  }

  get texture(): Texture | null { return this.outputTexture; }

  setSize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height) return;
    this.width = width; this.height = height;
    this.sceneTarget?.dispose(); this.histA?.dispose(); this.histB?.dispose(); this.debugTarget?.dispose();
    const depthTex = new DepthTexture(width, height, FloatType);
    depthTex.format = DepthFormat;
    depthTex.minFilter = depthTex.magFilter = NearestFilter;
    this.sceneTarget = new WebGLRenderTarget(width, height, {
      minFilter: NearestFilter, magFilter: NearestFilter, type: HalfFloatType, depthTexture: depthTex,
    });
    const options = { minFilter: LinearFilter, magFilter: LinearFilter, type: HalfFloatType, depthBuffer: false };
    this.histA = new WebGLRenderTarget(width, height, options);
    this.histB = new WebGLRenderTarget(width, height, options);
    this.debugTarget = new WebGLRenderTarget(width, height, options);
    this.velocityPass.setSize(width, height);
    this.outputTexture = this.sceneTarget.texture;
    this.reset();
  }

  reset(): void { this.frame = 0; this.hasHistory = false; this.velocityPass.reset(); }

  setTaaEnabled(enabled: boolean): void {
    if (this.taaEnabled === enabled) return;
    this.taaEnabled = enabled;
    this.reset();
  }

  setUseBicubicHistorySampling(enabled: boolean): void {
    if (this.useBicubicHistorySampling === enabled) return;
    this.useBicubicHistorySampling = enabled;
    this.reset();
  }

  render(renderer: WebGLRenderer, _inputBuffer: WebGLRenderTarget | null = null,
    _outputBuffer: WebGLRenderTarget | null = null, _deltaTime?: number, _stencilTest?: boolean): void {
    if (!this.sceneTarget || !this.histA || !this.histB || !this.debugTarget) return;
    const oldTarget = renderer.getRenderTarget(), oldAutoClear = renderer.autoClear;
    this.cameraRef.updateMatrixWorld();
    this.savedProjection.copy(this.cameraRef.projectionMatrix);
    this.cameraRef.getWorldPosition(this.worldPosition);
    this.cameraRef.getWorldQuaternion(this.worldRotation);
    let projectionDifference = 0;
    for (let i = 0; i < 16; ++i) projectionDifference = Math.max(projectionDifference,
      Math.abs(this.savedProjection.elements[i] - this.prevProjection.elements[i]));
    // Runtime cut policies from the custom Unity adapter.
    if (this.hasHistory && (this.worldPosition.distanceTo(this.prevPosition) > 1
      || this.worldRotation.angleTo(this.prevRotation) > Math.PI / 6
      || projectionDifference > .01 || this.jitterScale !== this.lastJitterScale)) this.reset();
    this.currViewProj.multiplyMatrices(this.savedProjection, this.cameraRef.matrixWorldInverse);
    try {
      renderer.autoClear = true;
      if (this.taaEnabled) {
        const [jx, jy] = CAPTURE_JITTER[this.frame & 3];
        // D3D pixel Y points down. A clip-space shift preserves existing view offsets.
        this.jitterMatrix.makeTranslation(2*jx*this.jitterScale/this.width, -2*jy*this.jitterScale/this.height, 0);
        this.cameraRef.projectionMatrix.multiplyMatrices(this.jitterMatrix, this.savedProjection);
        this.cameraRef.projectionMatrixInverse.copy(this.cameraRef.projectionMatrix).invert();
      }
      this.jitteredViewProj.multiplyMatrices(this.cameraRef.projectionMatrix, this.cameraRef.matrixWorldInverse);
      renderer.setRenderTarget(this.sceneTarget);
      renderer.clear(true, true, true);
      renderer.render(this.sceneRef, this.cameraRef);
      if (!this.taaEnabled) {
        this.outputTexture = this.sceneTarget.texture;
        this.hasHistory = false;
        return;
      }
      this.velocityPass.setFrameData(this.sceneRef, this.cameraRef, this.currViewProj, this.jitteredViewProj);
      this.velocityPass.render(renderer, null, null);
      const u = this.resolveMat.uniforms;
      u.tColor.value = this.sceneTarget.texture;
      u.tDepth.value = this.sceneTarget.depthTexture;
      u.tVelocity.value = this.velocityPass.texture;
      u.tHistory.value = this.histA.texture;
      u.tStencil.value = this.responsiveMask ?? this.defaultStencil;
      (u.uInvTexSize.value as Vector2).set(1/this.width, 1/this.height);
      (u.uCurrentClipToPreviousClip.value as Matrix4).copy(this.currViewProj).invert().premultiply(this.prevViewProj);
      if (!this.hasHistory) (u.uCurrentClipToPreviousClip.value as Matrix4).identity();
      u.uCurrentFrameWeight.value = Math.max(0, Math.min(1, this.blendFactor));
      u.uExposure.value = Math.max(0, this.exposure);
      u.uFirstFrame.value = !this.hasHistory;
      u.uFrameIndex.value = this.frame & 7;
      u.uUseBicubicHistorySampling.value = this.useBicubicHistorySampling;
      u.uDebugMode.value = 0;
      renderer.setRenderTarget(this.histB);
      renderer.render(this.fsScene, this.fsCam);
      this.outputTexture = this.histB.texture;
      // Diagnostic colors never enter temporal history.
      if (this.showVelocity || this.showDiff) {
        u.uDebugMode.value = this.showVelocity ? 1 : 2;
        renderer.setRenderTarget(this.debugTarget);
        renderer.render(this.fsScene, this.fsCam);
        this.outputTexture = this.debugTarget.texture;
      }
      [this.histA, this.histB] = [this.histB, this.histA];
      this.prevViewProj.copy(this.currViewProj);
      this.prevProjection.copy(this.savedProjection);
      this.prevPosition.copy(this.worldPosition);
      this.prevRotation.copy(this.worldRotation);
      this.lastJitterScale = this.jitterScale;
      this.hasHistory = true;
      this.frame += 1;
    } finally {
      this.cameraRef.projectionMatrix.copy(this.savedProjection);
      this.cameraRef.projectionMatrixInverse.copy(this.savedProjection).invert();
      renderer.autoClear = oldAutoClear;
      renderer.setRenderTarget(oldTarget);
    }
  }

  dispose(): void {
    // Dispose owned resources explicitly: Pass.dispose() also walks these same fields.
    this.sceneTarget?.dispose(); this.histA?.dispose(); this.histB?.dispose(); this.debugTarget?.dispose();
    this.resolveMat.dispose(); this.quad.geometry.dispose(); this.velocityPass.dispose();
    this.outputTexture = null;
  }
}
