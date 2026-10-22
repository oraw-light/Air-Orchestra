// Canvas, camera element and screen size shared by every module
export const canvas = document.getElementById("stage");
export const ctx = canvas.getContext("2d");
export const video = document.getElementById("video");
export const view = { W: 0, H: 0, DPR: 1, vignette: null };

function resize() {
  view.DPR = Math.min(window.devicePixelRatio || 1, 1.5); // capped to keep 30+ fps on high-DPI screens
  view.W = window.innerWidth; view.H = window.innerHeight;
  const { W, H, DPR } = view;
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  view.vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
  view.vignette.addColorStop(0, "rgba(0,0,0,0)");
  view.vignette.addColorStop(1, "rgba(0,0,0,0.75)");
}
window.addEventListener("resize", resize);
resize();

// "cover" fit of the video into the canvas; returns mapping used for both drawing and landmarks
export function coverRect() {
  const { W, H } = view;
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.max(W / vw, H / vh);
  const dw = vw * s, dh = vh * s;
  return { ox: (W - dw) / 2, oy: (H - dh) / 2, dw, dh };
}
