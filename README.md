# wuwa TAA

参考 **鸣潮（Wuthering Waves）TAA** 实现的 Three.js / WebGL2 示例。

项目依据鸣潮的 RenderDoc 帧捕获，分析 shader、常量缓冲和跨帧采样行为，在 Web 端复现核心 TAA 流程。运动向量、坐标约定和资源管理针对 Three.js 做了适配。这是基于捕获分析的参考实现，不是游戏官方源码，也不代表鸣潮在所有画质设置下的完整渲染方案。

## 运行

```sh
npm install
npm run dev
```

打开终端显示的本地地址。页面包含场景动画、TAA 参数和调试视图。
青色细柱是三骨骼蒙皮示例：物体变换保持不动，骨骼持续弯曲。开启 Show Motion Vectors 可以观察其速度，暂停场景动画后速度归零，但运动写入标记保持有效。
粉色球是半透明测试物体，不透明度为 40%，在棋盘和其他物体前左右移动。它参与颜色融合，但不写入深度或运动向量。用 Pink Transparent Sphere 开关显示它，用 Enable TAA 对照效果；Toggle Auto-Rotate 同时暂停它的运动。运动向量视图显示的是球后方表面的数据，而不是球自身速度。

```sh
npm run build    # TypeScript 检查和生产打包
npm run preview  # 预览构建结果
```

需要支持 WebGL2 和浮点渲染目标的浏览器。

## 每帧流程

1. **偏移采样位置。** 按四相位 jitter 修改相机投影，渲染当前帧颜色和深度。
2. **计算运动向量。** 使用当前帧和上一帧的变换及蒙皮姿态，计算不透明刚体和蒙皮网格的屏幕位移。运动数值不包含 jitter。
3. **找到历史颜色。** 静态区域使用深度和相机矩阵重投影；有物体运动的区域使用运动向量。通过五次双线性采样的 Catmull–Rom 近似重建历史颜色。
4. **限制历史颜色。** 将颜色转为 YCoCg，用当前像素及上下左右邻居的颜色范围限制历史。越界、历史重置或运动有效性不匹配时拒绝历史。
5. **融合当前与历史。** 根据运动和亮度差调整当前帧权重，再进行曝光相关的亮度加权融合。转回 RGB 后加入少量颜色 dither。
6. **保存结果。** 交换两张历史纹理，记录当前变换，并恢复相机原始投影，供下一帧使用。

历史纹理采用 RGBA16F。RGB 保存颜色，alpha 保存运动写入有效性标记。运动向量和历史差异的调试画面单独输出，不写入历史。

## 四相位 jitter

像素单位的偏移依次为：

```ts
const jitter = [
  [-0.125, -0.375],
  [ 0.375, -0.125],
  [ 0.125,  0.375],
  [-0.375,  0.125],
];
```

这组数值已通过鸣潮的八份连续捕获 `wuwa_taa_01` 至 `wuwa_taa_08` 核对：原始帧号为 **6983–6990**，相位按 `0 → 1 → 2 → 3` 重复两轮，且每帧均与投影矩阵中的偏移一致。

捕获中的像素 Y 方向向下。应用到 WebGL 投影时，偏移转换为：

```ts
ndcX =  2 * jitterX / width;
ndcY = -2 * jitterY / height;
```

上述结果确认了该段捕获使用的采样序列，不能据此确定游戏 CPU 端是查表还是通过公式生成偏移。投影 jitter 与输出颜色 dither 是不同操作。

## 参数与交互

| 控制项 | 默认值 | 作用 |
| --- | --- | --- |
| Enable TAA | 开启 | 启用时间抗锯齿 |
| Current Frame Weight | 0.25 | 当前帧的基础权重；实际融合比例还受运动和亮度影响 |
| Jitter Scale | 1.0 | 缩放子像素偏移幅度 |
| Bicubic History Sampling | 开启 | 使用 Catmull–Rom 历史重建；关闭后使用双线性采样 |
| Show Motion Vectors | 关闭 | 显示运动向量 |
| Show History Diff | 关闭 | 显示当前颜色与受限历史颜色的差异 |
| Reset History | — | 清空时间累积状态 |
| Toggle Auto-Rotate | 动画开启 | 暂停或恢复场景动画 |

拖动鼠标旋转视角，滚轮缩放。按 **G** 导出地板棋盘纹理。

代码中还提供：

- `TAAEffect.exposure`：默认 `1`，用于融合时的亮度权重。
- `TAAEffect.responsiveMask`：可选浮点纹理，保存整数 stencil 值；掩码 `8` 对应的位用于触发响应式权重。
- `mesh.userData.taaMotionWriter = true`：将已知动态网格标记为运动向量写入对象。自动检测到运动的网格在停止后也会保留该身份。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 应用入口、相机交互和场景动画 |
| `src/SceneBuilder.ts` | 演示场景、材质与光源 |
| `src/TaaUi.ts` | 参数面板 |
| `src/TAAEffect.ts` | 后处理接入、参数转发和最终 gamma 输出 |
| `src/TemporalReprojectPass.ts` | jitter、相机历史、渲染目标和历史纹理交换 |
| `src/VelocityPass.ts` | 不透明刚体和蒙皮网格的运动向量、骨骼历史与有效性 |
| `src/SkinnedDemo.ts` | 物体变换固定的三骨骼动画示例 |
| `src/TemporalResolveMaterial.ts` | 历史采样、颜色限制、权重计算和融合 shader |

## 适配范围

本项目复现的是 TAA 的核心处理流程。场景、材质、光照和输出处理由示例提供，因此不能作为鸣潮画面的逐像素复现。

当前运动向量实现支持不透明刚体网格和标准 Three.js `SkinnedMesh` 骨骼动画（每顶点最多四个骨骼权重，支持 attached / detached 绑定模式）。当前帧沿用 Three.js 的蒙皮 shader；上一帧使用独立骨骼矩阵纹理、绑定矩阵、绑定逆矩阵和物体矩阵重新计算顶点位置。蒙皮对象自动成为运动写入对象，无需设置 `taaMotionWriter`。

首次出现、历史重置、隐藏后重新出现、更换几何体或骨架/骨骼映射时，该对象的旧姿态失效；正常帧在速度渲染后保存姿态。形态动画（包括同时含 morph 的蒙皮网格）、实例化、透明、alpha cutout 和自定义顶点变形仍需额外处理。

实现参考 Unity `Toon Shading/Assets/RolePage` 的上一帧顶点流契约，以及捕获导出 shader 的 `PreviousBones` / `Bones`。`kati_intro.rdc` EID 820 的 VS 有独立 `VELOCITY_PREV_POS` 输出；本次回放接口无法读取实际缓冲绑定值，因此不将此视为骨骼数据已逐值核对的证明。

相机突变、分辨率变化、TAA 开关、采样方式或 jitter 幅度变化时会重置历史。示例每个动画帧只执行一次 TAA，以保持历史和变换一致。
