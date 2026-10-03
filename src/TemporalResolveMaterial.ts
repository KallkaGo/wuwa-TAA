import { DataTexture, FloatType, GLSL3, Matrix4, NoBlending, RedFormat, ShaderMaterial, Vector2 } from 'three';

// Runtime port of RolePage/Shaders/Post/TemporalAntialiasing.hlsl.
// WebGL uses bottom-left UV and [-1, 1] clip Z; motion RG is unjittered UV,
// B is the velocity-writer validity bit. History alpha retains that bit.
export function createTemporalResolveMaterial(): ShaderMaterial {
  const zeroStencil = new DataTexture(new Float32Array([0]), 1, 1, RedFormat, FloatType);
  zeroStencil.needsUpdate = true;
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    blending: NoBlending, depthTest: false, depthWrite: false,
    uniforms: {
      tColor: { value: null }, tDepth: { value: null }, tVelocity: { value: null },
      tHistory: { value: null }, tStencil: { value: zeroStencil },
      uInvTexSize: { value: new Vector2() },
      uCurrentClipToPreviousClip: { value: new Matrix4() },
      uCurrentFrameWeight: { value: 0.25 }, uExposure: { value: 1 },
      uFirstFrame: { value: true }, uFrameIndex: { value: 0 },
      uUseBicubicHistorySampling: { value: true }, uDebugMode: { value: 0 },
    },
    vertexShader: `
      out vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp int;
      uniform sampler2D tColor, tDepth, tVelocity, tHistory, tStencil;
      uniform vec2 uInvTexSize;
      uniform mat4 uCurrentClipToPreviousClip;
      uniform float uCurrentFrameWeight, uExposure;
      uniform bool uFirstFrame, uUseBicubicHistorySampling;
      uniform int uFrameIndex, uDebugMode;
      in vec2 vUv;
      out vec4 resolvedColor;

      vec3 toYCoCg(vec3 c) {
        return vec3(c.r + 2.0*c.g + c.b, 2.0*c.r - 2.0*c.b, -c.r + 2.0*c.g - c.b);
      }
      vec3 fromYCoCg(vec3 c) {
        return vec3(c.x+c.y-c.z, c.x+c.z, c.x-c.y-c.z)*0.25;
      }
      ivec2 bounded(ivec2 p) { return clamp(p, ivec2(0), textureSize(tColor, 0)-1); }
      float depthAt(ivec2 p) { return texelFetch(tDepth, bounded(p), 0).r; }
      vec3 velocityAt(ivec2 p) { return texelFetch(tVelocity, bounded(p), 0).rgb; }

      vec4 historyAt(vec2 uv) {
        vec2 limits = uInvTexSize * 0.5;
        uv = clamp(uv, limits, 1.0-limits);
        if (!uUseBicubicHistorySampling) return texture(tHistory, uv);
        vec2 p = uv/uInvTexSize;
        vec2 i = floor(p-0.5), center = i+0.5, f = p-center;
        vec2 f2 = f*f, f3 = f2*f;
        vec2 w0 = f2-0.5*(f3+f);
        vec2 w1 = 1.0+1.5*f3-2.5*f2;
        vec2 w3 = 0.5*f*(f2-f);
        vec2 w12 = 1.0-w3-w0, w2 = w12-w1;
        vec2 uv0 = (i-0.5)*uInvTexSize;
        vec2 uv12 = (center+w2/w12)*uInvTexSize;
        vec2 uv3 = (i+2.5)*uInvTexSize;
        vec4 value = texture(tHistory, vec2(uv12.x,max(uv0.y,limits.y)))*(w12.x*w0.y)
          + texture(tHistory, vec2(max(uv0.x,limits.x),uv12.y))*(w12.y*w0.x)
          + texture(tHistory, uv12)*(w12.x*w12.y)
          + texture(tHistory, vec2(min(uv3.x,1.0-limits.x),uv12.y))*(w12.y*w3.x)
          + texture(tHistory, vec2(uv12.x,min(uv3.y,1.0-limits.y)))*(w12.x*w3.y);
        float sum = w12.x*(w3.y+w0.y)+w12.y*w0.x+w12.x*w12.y+w12.y*w3.x;
        // Keep signed alpha and RGB overshoot until the reference rejection/clamp.
        return value/sum;
      }
      float dither(uvec2 pixel, uint frame) {
        uint x = pixel.x*1664525u+1013904223u;
        uint y = pixel.y*1664525u+1013904223u;
        uint z = frame*1664525u+1013904223u;
        x += z*y; y += x*z; z += y*x; x += z*y;
        return fract(float(x >> 16u)*1.52587890625e-5);
      }
      void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        vec2 ndc = vUv*2.0-1.0;
        // Match the reference's top-left tie order, flipped for WebGL UV.
        float centerDepth = depthAt(pixel);
        float a = -depthAt(pixel+ivec2(-2, 2));
        float b = -depthAt(pixel+ivec2( 2, 2));
        float c = -depthAt(pixel+ivec2(-2,-2));
        float d = -depthAt(pixel+ivec2( 2,-2));
        bool upper = max(a,b)>max(c,d);
        bool left = upper ? a>b : c>d;
        float closest = max(max(a,b),max(c,d));
        ivec2 offset = ivec2(0);
        if (closest > -centerDepth) {
          centerDepth = -closest;
          offset = ivec2(left ? -2 : 2, upper ? 2 : -2);
        }
        vec4 previousClip = uCurrentClipToPreviousClip*vec4(ndc, centerDepth*2.0-1.0, 1.0);
        bool behindCamera = previousClip.w <= 0.000001;
        vec2 motion = behindCamera ? vec2(0.0) : ndc-previousClip.xy/previousClip.w;
        vec3 objectMotion = velocityAt(pixel+offset);
        if (objectMotion.b > 0.5) { motion = objectMotion.rg*2.0; behindCamera = false; }
        vec2 historyNdc = ndc-motion;
        bool offscreen = max(abs(historyNdc.x),abs(historyNdc.y)) >= 1.0 || behindCamera;
        float magnitude = length(motion/uInvTexSize); // NDC*size, deliberately no .5.

        const ivec2 crossOffsets[5] = ivec2[5](ivec2(0,1),ivec2(-1,0),ivec2(0),ivec2(1,0),ivec2(0,-1));
        vec3 minColor = vec3(3.402823466e+38), maxColor = -minColor;
        bool anyValid = false;
        bool centerValid = velocityAt(pixel).b > 0.5;
        // Runtime reference weights are exactly (0,0,1,0,0). All taps still
        // contribute to bounds and validity; no variance or chroma shrink.
        vec3 current = toYCoCg(texelFetch(tColor, pixel, 0).rgb);
        for (int k=0; k<5; ++k) {
          ivec2 p = pixel+crossOffsets[k];
          vec3 tap = toYCoCg(texelFetch(tColor, bounded(p), 0).rgb);
          minColor = min(minColor,tap); maxColor = max(maxColor,tap);
          anyValid = anyValid || velocityAt(p).b>0.5;
        }
        // Never read uninitialized history on a reset.
        vec4 history = uFirstFrame ? vec4(fromYCoCg(current),0.0) : historyAt(historyNdc*0.5+0.5);
        vec3 historyY = toYCoCg(history.rgb);
        bool reject = offscreen || uFirstFrame || (history.a>0.0 && !anyValid);
        vec3 clipped = clamp(historyY,minColor,maxColor);
        float amount = mix(uCurrentFrameWeight,0.2,clamp(magnitude*0.025,0.0,1.0));
        // Define black/black (0/0 in the DXIL) as zero boost; positive/0 -> 1.
        float difference = abs(current.x-historyY.x);
        float boost = difference>0.0 ? clamp(historyY.x*0.01/difference,0.0,1.0)
          : (historyY.x>0.0 ? 1.0 : 0.0);
        amount = max(amount,boost);
        bool responsive = (uint(round(texture(tStencil,vUv).r)) & 8u) != 0u;
        if (responsive) amount = 0.25;
        if (uFirstFrame) amount = 1.0;
        if (reject) clipped = current;
        float wh = (1.0-amount)/(clipped.x*uExposure+4.0);
        float wc = amount/(current.x*uExposure+4.0);
        vec3 combined = (wh*clipped+wc*current)/(wh+wc);
        vec3 rgb = clamp(fromYCoCg(combined),0.0,65504.0);
        uvec2 ditherPixel = uvec2(pixel.x,textureSize(tColor,0).y-1-pixel.y);
        rgb += dither(ditherPixel,uint(uFrameIndex))*rgb/1024.0;
        if (uDebugMode == 1) rgb = vec3(abs(motion)*25.0,0.0);
        if (uDebugMode == 2) rgb = vec3(length(fromYCoCg(current)-fromYCoCg(clipped))*10.0);
        resolvedColor = vec4(rgb,centerValid ? 1.0 : 0.0);
      }
    `,
  });
  material.addEventListener('dispose', () => zeroStencil.dispose());
  return material;
}
