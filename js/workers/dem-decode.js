'use strict';
let canvas, ctx;
self.onmessage = async function (e) {
  const { id, blob } = e.data;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    if (!canvas) {
      canvas = new OffscreenCanvas(256, 256);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (bitmap.width !== 256 || bitmap.height !== 256) throw new Error('Invalid DEM tile dimensions');
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, 256, 256).data;
    const heights = new Float32Array(256 * 256);
    for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
      heights[i] = rgba[p] * 256 + rgba[p+1] + rgba[p+2] / 256 - 32768;
    }
    self.postMessage({ id: id, buffer: heights.buffer }, [heights.buffer]);
  } catch (err) { self.postMessage({ id: id, error: String(err) }); }
  finally { if (bitmap) bitmap.close(); }
};
