// 探针：证明 cobe 2.0.1 是否有内部 rAF 循环 / 是否回调 onRender
const glStub = new Proxy({}, {
  get(_t, k) {
    if (k === 'COMPILE_STATUS' || k === 'LINK_STATUS') return 1;
    return (...a) => {
      if (k === 'getShaderParameter' || k === 'getProgramParameter') return true;
      if (k === 'createProgram' || k === 'createShader' || k === 'createBuffer' || k === 'createTexture') return { id: k };
      if (k === 'getUniformLocation') return { u: a[1] };
      if (k === 'getAttribLocation') return 0;
      if (k === 'getExtension') return null;
      if (k === 'drawArrays') drawCalls.push('drawArrays');
      if (k === 'texImage2D') texUploads.push(a.length);
      return undefined;
    };
  },
});
const drawCalls = [];
const texUploads = [];

const el = () => ({ style: { cssText: '', setProperty(){} }, textContent: '', append(){}, appendChild(){}, insertBefore(){}, remove(){}, parentElement: null });
globalThis.document = { createElement: el, head: el(), body: el() };
let imageInstances = 0;
globalThis.Image = class { constructor(){ imageInstances++; } set src(v){ this._src = v; srcLen = v.length; } get src(){ return this._src; } };
let srcLen = 0;
let rafCalls = 0;
globalThis.requestAnimationFrame = () => { rafCalls++; return 1; };
globalThis.cancelAnimationFrame = () => {};

const canvas = { width: 0, height: 0, style: { cssText: '' }, getContext: () => glStub, parentElement: el(), isConnected: true };

const createGlobe = (await import('./public/vendor/cobe.esm.js')).default;
let onRenderCalls = 0;
const g = createGlobe(canvas, {
  devicePixelRatio: 2, width: 280 * 2, height: 280 * 2,
  phi: 0, theta: 0.25, dark: 0, diffuse: 0.4,
  mapSamples: 16000, mapBrightness: 1.2,
  baseColor: [1,1,1], markerColor: [.85,.47,.34], glowColor: [1,1,1],
  markers: [{ location: [31.2, 121.4], size: 0.05 }],
  onRender(state) { onRenderCalls++; state.phi = 0; },
});
console.log('canvas.width  =', canvas.width, '(传入 width=560, dpr=2)');
console.log('canvas.height =', canvas.height);
console.log('requestAnimationFrame 调用次数 =', rafCalls);
console.log('onRender 调用次数 =', onRenderCalls);
console.log('drawArrays 次数 =', drawCalls.length);
console.log('texImage2D 次数 =', texUploads.length, '(参数个数:', texUploads.join(','), ')');
console.log('new Image() 次数 =', imageInstances, ' map data-url 长度 =', srcLen);
console.log('返回对象 keys =', Object.keys(g));
await new Promise(r => setTimeout(r, 300));
console.log('300ms 后 onRender 调用次数 =', onRenderCalls, ' rAF =', rafCalls);
