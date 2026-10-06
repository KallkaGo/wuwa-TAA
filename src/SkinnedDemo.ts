import {
  Bone, CylinderGeometry, Float32BufferAttribute, MeshStandardMaterial,
  Skeleton, SkinnedMesh, Uint16BufferAttribute,
} from 'three';

/** A small three-bone strip whose pose changes while its object transform stays fixed. */
export function buildSkinnedDemo(): { mesh: SkinnedMesh; animate: (time: number) => void } {
  const geometry = new CylinderGeometry(0.16, 0.16, 2.4, 8, 24);
  const indices: number[] = [];
  const weights: number[] = [];
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i += 1) {
    const height = Math.max(0, Math.min(2, (positions.getY(i) + 1.2) / 1.2));
    const lower = Math.min(1, Math.floor(height));
    const weight = height - lower;
    indices.push(lower, lower + 1, 0, 0);
    weights.push(1 - weight, weight, 0, 0);
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color: 0x44ddff, roughness: 0.4 }));
  mesh.position.set(-3.1, 0, -1.6);
  const root = new Bone();
  const middle = new Bone();
  const tip = new Bone();
  root.position.y = -1.2;
  middle.position.y = tip.position.y = 1.2;
  root.add(middle);
  middle.add(tip);
  mesh.add(root);
  mesh.bind(new Skeleton([root, middle, tip]));
  // The sample can bend beyond its bind-pose bounds. Let clip-space clipping handle it.
  mesh.frustumCulled = false;
  return {
    mesh,
    animate: (time) => {
      middle.rotation.z = Math.sin(time * 1.4) * 0.6;
      tip.rotation.z = Math.sin(time * 1.9 + 0.8) * 0.7;
    },
  };
}
