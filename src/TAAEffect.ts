import { BlendFunction, Effect } from 'postprocessing';
import { Uniform, type PerspectiveCamera, type Scene, type Texture, type WebGLRenderTarget, type WebGLRenderer } from 'three';
import type { VelocityPass } from './VelocityPass';
import { TemporalReprojectPass } from './TemporalReprojectPass';

const taaComposeFragmentShader = /* glsl */ `
  uniform sampler2D accumulatedTexture;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 color = texture2D(accumulatedTexture, uv).rgb;
    color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
    outputColor = vec4(color, 1.0);
  }
`;

export class TAAEffect extends Effect {
  private readonly sceneRef: Scene;
  private readonly cameraRef: PerspectiveCamera;
  private readonly velocityPass: VelocityPass;

  taaEnabled = true;
  blendFactor = 0.25;
  jitterScale = 1.0;
  exposure = 1.0;
  responsiveMask: Texture | null = null;
  showVelocity = false;
  showDiff = false;
  useBicubicHistorySampling = true;

  private temporalReprojectPass: TemporalReprojectPass | null = null;
  private pendingReset = false;
  private width = 0;
  private height = 0;

  constructor(scene: Scene, camera: PerspectiveCamera, velocityPass: VelocityPass) {
    super('TAAEffect', taaComposeFragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([['accumulatedTexture', new Uniform(null)]]),
    });

    this.sceneRef = scene;
    this.cameraRef = camera;
    this.velocityPass = velocityPass;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.temporalReprojectPass?.setSize(width, height);
  }

  resetHistory(): void {
    if (this.temporalReprojectPass) {
      this.temporalReprojectPass.reset();
      return;
    }

    this.pendingReset = true;
  }

  update(renderer: WebGLRenderer, inputBuffer?: WebGLRenderTarget): void {
    this.ensureTemporalPass(inputBuffer);
    if (!this.temporalReprojectPass) {
      return;
    }

    if (inputBuffer && (inputBuffer.width !== this.width || inputBuffer.height !== this.height)) {
      this.setSize(inputBuffer.width, inputBuffer.height);
    }

    this.temporalReprojectPass.setTaaEnabled(this.taaEnabled);
    this.temporalReprojectPass.blendFactor = this.blendFactor;
    this.temporalReprojectPass.jitterScale = this.jitterScale;
    this.temporalReprojectPass.exposure = this.exposure;
    this.temporalReprojectPass.responsiveMask = this.responsiveMask;
    this.temporalReprojectPass.showVelocity = this.showVelocity;
    this.temporalReprojectPass.showDiff = this.showDiff;
    this.temporalReprojectPass.setUseBicubicHistorySampling(this.useBicubicHistorySampling);

    if (this.pendingReset) {
      this.temporalReprojectPass.reset();
      this.pendingReset = false;
    }

    this.temporalReprojectPass.render(renderer, inputBuffer ?? null, null);
    this.uniforms.get('accumulatedTexture')!.value = this.temporalReprojectPass.texture;
  }

  dispose(): void {
    // Effect.dispose() would also dispose the pass, its velocity child and a
    // caller-owned responsive texture via a shallow property walk.
    if (this.temporalReprojectPass) this.temporalReprojectPass.dispose();
    else this.velocityPass.dispose();
    this.temporalReprojectPass = null;
    this.uniforms.get('accumulatedTexture')!.value = null;
    this.pendingReset = false;
  }

  private ensureTemporalPass(inputBuffer?: WebGLRenderTarget): void {
    if (this.temporalReprojectPass) {
      return;
    }

    this.temporalReprojectPass = new TemporalReprojectPass(this.sceneRef, this.cameraRef, this.velocityPass);

    const targetWidth = inputBuffer?.width ?? this.width;
    const targetHeight = inputBuffer?.height ?? this.height;

    if (targetWidth > 0 && targetHeight > 0) {
      this.temporalReprojectPass.setSize(targetWidth, targetHeight);
      this.width = targetWidth;
      this.height = targetHeight;
    }
  }
}
