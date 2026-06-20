/**
 * tools/mp-server/shims.js
 *
 * Headless shim layer for running the stock Kinky Dungeon bundle (out/main.js)
 * in plain Node.js — no browser, no jsdom. Hand-stubs PIXI / DOM / WebGL / Audio.
 *
 * Regenerated from the documented shim surface in task KD-067 (PoC verified
 * 2026-06-19). Keep this small and tracking the bundle's PIXI/DOM surface.
 *
 * Usage:  require('./shims').install()   // BEFORE loading out/main.js
 *
 * Real libraries (loaded by node-boot, not stubbed): LZString, m4.
 *
 * The bundle calls PIXI.RenderTexture.create(...) and builds Containers at
 * top-level module-eval time, so every PIXI class referenced must exist and be
 * newable before main.js is required.
 */
'use strict';

function noop() {}
function returnThis() { return this; }

// A generic chainable display-object base. Most KD render code only needs the
// object to exist, accept children, and expose position/scale/pivot with .set().
function makePoint(x = 0, y = 0) {
	const p = {
		x, y,
		set(nx = 0, ny) { this.x = nx; this.y = (ny === undefined ? nx : ny); return this; },
		copyFrom(o) { this.x = o.x; this.y = o.y; return this; },
		clone() { return makePoint(this.x, this.y); },
	};
	return p;
}

class Rectangle {
	constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.width = w; this.height = h; }
	clone() { return new Rectangle(this.x, this.y, this.width, this.height); }
	contains() { return false; }
	copyFrom(r) { this.x = r.x; this.y = r.y; this.width = r.width; this.height = r.height; return this; }
}

class Point {
	constructor(x = 0, y = 0) { this.x = x; this.y = y; }
	set(x = 0, y) { this.x = x; this.y = (y === undefined ? x : y); return this; }
	copyFrom(p) { this.x = p.x; this.y = p.y; return this; }
	clone() { return new Point(this.x, this.y); }
}

class Matrix {
	constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.tx = 0; this.ty = 0; }
	identity() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.tx = 0; this.ty = 0; return this; }
	clone() { const m = new Matrix(); m.a = this.a; m.b = this.b; m.c = this.c; m.d = this.d; m.tx = this.tx; m.ty = this.ty; return m; }
	apply(p) { return p; }
	applyInverse(p) { return p; }
	translate(x, y) { this.tx += x; this.ty += y; return this; }
	scale(x, y) { this.a *= x; this.d *= y; return this; }
	append() { return this; }
	prepend() { return this; }
	set(a, b, c, d, tx, ty) { this.a = a; this.b = b; this.c = c; this.d = d; this.tx = tx; this.ty = ty; return this; }
	copyFrom(m) { this.a = m.a; this.b = m.b; this.c = m.c; this.d = m.d; this.tx = m.tx; this.ty = m.ty; return this; }
}

class DisplayObject {
	constructor() {
		this.children = [];
		this.position = makePoint();
		this.scale = makePoint(1, 1);
		this.pivot = makePoint();
		this.anchor = makePoint();
		this.skew = makePoint();
		this.filters = null;
		this.visible = true;
		this.renderable = true;
		this.alpha = 1;
		this.rotation = 0;
		this.zIndex = 0;
		this.width = 0;
		this.height = 0;
		this.tint = 0xffffff;
		this.blendMode = 0;
		this.parent = null;
		this.worldTransform = new Matrix();
		this.transform = { localTransform: new Matrix(), worldTransform: new Matrix() };
		this._bounds = new Rectangle();
		this.cacheAsBitmap = false;
		this.interactive = false;
		this.buttonMode = false;
		this.eventMode = 'none';
	}
	get x() { return this.position.x; } set x(v) { this.position.x = v; }
	get y() { return this.position.y; } set y(v) { this.position.y = v; }
	addChild(...c) { for (const ch of c) { if (ch) { ch.parent = this; this.children.push(ch); } } return c[0]; }
	addChildAt(ch, i) { if (ch) { ch.parent = this; this.children.splice(i, 0, ch); } return ch; }
	removeChild(...c) { for (const ch of c) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); if (ch) ch.parent = null; } return c[0]; }
	removeChildAt(i) { return this.children.splice(i, 1)[0]; }
	removeChildren() { const r = this.children; this.children = []; return r; }
	getChildAt(i) { return this.children[i]; }
	setParent(p) { if (p && p.addChild) p.addChild(this); return p; }
	destroy() { this.children = []; }
	updateTransform() {}
	getBounds() { return this._bounds; }
	getLocalBounds() { return this._bounds; }
	toGlobal(p) { return p; }
	toLocal(p) { return p; }
	setTransform() { return this; }
	on() { return this; } once() { return this; } off() { return this; } emit() { return this; }
	render() {}
}

class Container extends DisplayObject {
	constructor() { super(); this.sortableChildren = false; }
	sortChildren() {}
	calculateBounds() {}
}

class Graphics extends Container {
	constructor() { super(); this.geometry = { graphicsData: [] }; this.line = {}; this.currentPath = null; this.fill = {}; }
	clear() { return this; }
	beginFill() { return this; }
	beginTextureFill() { return this; }
	endFill() { return this; }
	lineStyle() { return this; }
	lineTextureStyle() { return this; }
	moveTo() { return this; }
	lineTo() { return this; }
	bezierCurveTo() { return this; }
	quadraticCurveTo() { return this; }
	arc() { return this; }
	arcTo() { return this; }
	drawRect() { return this; }
	drawRoundedRect() { return this; }
	drawCircle() { return this; }
	drawEllipse() { return this; }
	drawPolygon() { return this; }
	drawShape() { return this; }
	closePath() { return this; }
	setMatrix() { return this; }
	beginHole() { return this; }
	endHole() { return this; }
}

class Sprite extends Container {
	constructor(texture) { super(); this.texture = texture || Texture.WHITE; this.anchor = makePoint(); }
	static from() { return new Sprite(Texture.WHITE); }
}

class Text extends Sprite {
	constructor(text = '', style = {}) { super(); this.text = text; this.style = style; this.resolution = 1; }
	updateText() {}
}

class SimplePlane extends Container {
	constructor(texture, vertsW, vertsH) {
		super();
		this.texture = texture || Texture.WHITE;
		this.verticesX = vertsW || 2;
		this.verticesY = vertsH || 2;
		const size = (this.verticesX * this.verticesY) * 2;
		const buf = { data: new Float32Array(size), update: noop };
		this.geometry = {
			buffers: [buf],
			getBuffer() { return buf; },
			getAttribute() { return { buffer: buf }; },
			getIndex() { return { data: new Uint16Array(0) }; },
			update: noop,
		};
		this.shader = null;
	}
}

class BaseTexture {
	constructor(resource, options = {}) {
		this.resource = resource || null;
		this.width = (options && options.width) || 1;
		this.height = (options && options.height) || 1;
		this.realWidth = this.width;
		this.realHeight = this.height;
		this.valid = true;
		this.scaleMode = 0;
		this.mipmap = 0;
		this.wrapMode = 0;
		this.cacheId = null;
	}
	static from() { return new BaseTexture(); }
	on() { return this; } once() { return this; } off() { return this; }
	update() {} destroy() {} dispose() {}
	setSize() { return this; }
	setResolution() { return this; }
}
BaseTexture.defaultOptions = { scaleMode: 0, mipmap: 0, wrapMode: 0, anisotropicLevel: 0, alphaMode: 0 };

class Texture {
	constructor(baseTexture, frame) {
		this.baseTexture = baseTexture || new BaseTexture();
		this.frame = frame || new Rectangle(0, 0, this.baseTexture.width, this.baseTexture.height);
		this.orig = this.frame;
		this.trim = null;
		this.valid = true;
		this.width = this.frame.width;
		this.height = this.frame.height;
		this.uvs = { x0: 0, y0: 0, x1: 1, y1: 0, x2: 1, y2: 1, x3: 0, y3: 1 };
		this.defaultAnchor = makePoint();
	}
	static from() { return new Texture(new BaseTexture()); }
	update() {} destroy() {} clone() { return new Texture(this.baseTexture, this.frame); }
	on() { return this; } once() { return this; } off() { return this; }
}
Texture.WHITE = new Texture(new BaseTexture(null, { width: 16, height: 16 }));
Texture.EMPTY = new Texture(new BaseTexture());

class RenderTexture extends Texture {
	static create(options = {}) {
		const w = options.width || 1, h = options.height || 1;
		return new RenderTexture(new BaseTexture(null, { width: w, height: h }));
	}
	resize() {}
}

class Color {
	constructor(value) { this.value = value; this._value = value; }
	toHex() { return '#000000'; }
	toNumber() { return typeof this.value === 'number' ? this.value : 0; }
	toRgba() { return { r: 0, g: 0, b: 0, a: 1 }; }
	toArray() { return [0, 0, 0, 1]; }
	setValue(v) { this.value = v; return this; }
	get red() { return 0; } get green() { return 0; } get blue() { return 0; } get alpha() { return 1; }
}
Color.shared = new Color(0xffffff);

class Filter {
	constructor(vert, frag, uniforms) { this.vertexSrc = vert; this.fragmentSrc = frag; this.uniforms = uniforms || {}; this.enabled = true; this.padding = 0; this.resolution = 1; this.blendMode = 0; }
	apply() {}
	static get defaultVertexSrc() { return ''; }
	static get defaultFragmentSrc() { return ''; }
}

class Geometry {
	constructor() { this.buffers = []; this.attributes = {}; this.indexBuffer = null; }
	addAttribute() { return this; }
	addIndex() { return this; }
	getBuffer() { return { data: new Float32Array(0), update: noop }; }
	getAttribute() { return { buffer: this.getBuffer() }; }
	getIndex() { return { data: new Uint16Array(0) }; }
	interleave() { return this; }
}

class Buffer {
	constructor(data) { this.data = data || new Float32Array(0); }
	update() {}
}

class Shader {
	constructor(program, uniforms) { this.program = program; this.uniforms = uniforms || {}; }
	static from() { return new Shader(); }
}

class Ticker {
	constructor() { this.started = false; this.deltaTime = 1; this.deltaMS = 16; this.elapsedMS = 16; this.lastTime = 0; this.speed = 1; this.FPS = 60; }
	add() { return this; } addOnce() { return this; } remove() { return this; }
	start() { this.started = true; } stop() { this.started = false; }
	update() {}
}
Ticker.shared = new Ticker();

class Application {
	constructor(options = {}) {
		this.stage = new Container();
		this.ticker = new Ticker();
		this.screen = new Rectangle(0, 0, (options && options.width) || 800, (options && options.height) || 600);
		this.renderer = makeRenderer(options);
		this.view = (options && options.view) || { width: 800, height: 600, style: {}, addEventListener: noop };
		this.loader = makeLoader();
	}
	render() {}
	destroy() {}
	get stageView() { return this.view; }
}

function makeRenderer(options = {}) {
	return {
		width: (options && options.width) || 800,
		height: (options && options.height) || 600,
		resolution: 1,
		screen: new Rectangle(0, 0, 800, 600),
		view: { width: 800, height: 600, style: {} },
		plugins: { interaction: { on: noop, off: noop, destroy: noop } },
		render: noop,
		resize: noop,
		destroy: noop,
		generateTexture() { return RenderTexture.create({ width: 1, height: 1 }); },
		extract: { canvas: () => ({ toDataURL: () => '' }), pixels: () => new Uint8Array(4) },
		on: noop, off: noop, once: noop,
		clear: noop,
		reset: noop,
		texture: { bind: noop },
		gl: makeWebGLContext(),
	};
}

function makeLoader() {
	const loader = {
		resources: {},
		add() { return loader; },
		load(cb) { if (cb) cb(loader, loader.resources); return loader; },
		pre() { return loader; },
		use() { return loader; },
		reset() { return loader; },
		on() { return loader; }, once() { return loader; },
		onComplete: { add: noop }, onError: { add: noop }, onProgress: { add: noop }, onLoad: { add: noop },
		destroy: noop,
	};
	return loader;
}

class Spritesheet {
	constructor(baseTexture, data) { this.baseTexture = baseTexture; this.data = data || {}; this.textures = {}; this.animations = {}; }
	parse(cb) { if (typeof cb === 'function') cb(this.textures); return Promise.resolve(this.textures); }
	destroy() {}
}

// PIXI.Assets — async asset manager. Returns stub textures/spritesheets.
const Assets = {
	cache: {
		_map: new Map(),
		has(k) { return this._map.has(k); },
		get(k) { return this._map.get(k); },
		set(k, v) { this._map.set(k, v); },
		reset() { this._map.clear(); },
	},
	init() { return Promise.resolve(); },
	add() {},
	load(urls) {
		// KD loads texture atlases via Assets.load(url).then(sheet => …). The
		// callback iterates sheet.linkedSheets, so resolve to a spritesheet-shaped
		// stub (not a bare Texture) to avoid an async unhandled rejection.
		const sheetStub = () => ({ textures: {}, animations: {}, linkedSheets: {}, baseTexture: Texture.WHITE.baseTexture, data: { frames: {} } });
		if (Array.isArray(urls)) { const out = {}; for (const u of urls) out[u] = sheetStub(); return Promise.resolve(out); }
		return Promise.resolve(sheetStub());
	},
	get(k) { return Assets.cache.get(k) || Texture.WHITE; },
	unload() { return Promise.resolve(); },
	reset() { Assets.cache.reset(); },
	setPreferences() {},
	resolver: { addManifest: noop, add: noop },
};

// PIXI.filters namespace (from pixi-filters.js). KD references many; stub as
// no-op Filter subclasses with permissive constructors.
function makeFilterClass() {
	return class extends Filter {
		constructor() { super('', '', {}); }
	};
}
const filters = new Proxy({}, {
	get(target, prop) {
		if (prop in target) return target[prop];
		if (typeof prop === 'symbol') return undefined;
		const cls = makeFilterClass();
		target[prop] = cls;
		return cls;
	},
});

const utils = {
	EventEmitter: class { on() { return this; } once() { return this; } off() { return this; } emit() { return this; } removeListener() { return this; } removeAllListeners() { return this; } },
	isWebGLSupported() { return true; },
	hex2rgb(hex, out) { out = out || []; out[0] = ((hex >> 16) & 0xff) / 255; out[1] = ((hex >> 8) & 0xff) / 255; out[2] = (hex & 0xff) / 255; return out; },
	rgb2hex(rgb) { return ((rgb[0] * 255) << 16) + ((rgb[1] * 255) << 8) + (rgb[2] * 255); },
	hex2string(hex) { return '#' + ('000000' + (hex >>> 0).toString(16)).slice(-6); },
	string2hex(s) { return parseInt(s.replace('#', ''), 16) || 0; },
	premultiplyTint(t) { return t; },
	uid() { return ++utils._uid; },
	_uid: 0,
	clearTextureCache: noop,
	destroyTextureCache: noop,
	TextureCache: {},
	BaseTextureCache: {},
	skipHello: noop,
	deprecation: noop,
	sayHello: noop,
};

const settings = {
	SCALE_MODE: 0,
	MIPMAP_TEXTURES: 0,
	WRAP_MODE: 0,
	RESOLUTION: 1,
	FILTER_RESOLUTION: 1,
	ANISOTROPIC_LEVEL: 0,
	RETINA_PREFIX: /@([0-9\.]+)x/,
	FAIL_IF_MAJOR_PERFORMANCE_CAVEAT: false,
	ADAPTER: {
		createCanvas(w, h) { return makeCanvas(w, h); },
		getCanvasRenderingContext2D() { return makeCanvas().getContext('2d').constructor || Object; },
		getWebGLRenderingContext() { return Object; },
		getNavigator() { return globalThis.navigator; },
		getBaseUrl() { return ''; },
		getFontFaceSet() { return globalThis.document.fonts; },
		fetch(url, opts) { return globalThis.fetch(url, opts); },
		parseXML(xml) { return {}; },
	},
};

const ExtensionType = {
	Application: 'application',
	RendererPlugin: 'renderer-webgl-plugin',
	Asset: 'asset',
	LoadParser: 'load-parser',
	ResolveParser: 'resolve-parser',
	CacheParser: 'cache-parser',
	DetectionParser: 'detection-parser',
	TextureSource: 'texture-source',
};

const LoaderParserPriority = { Low: 0, Normal: 1, High: 2 };

const extensions = {
	add() { return extensions; },
	remove() { return extensions; },
	handle() { return extensions; },
	handleByList() { return extensions; },
	handleByMap() { return extensions; },
	handleByNamedList() { return extensions; },
	mixin() { return extensions; },
};

const SCALE_MODES = { NEAREST: 0, LINEAR: 1 };
const MIPMAP_MODES = { OFF: 0, POW2: 1, ON: 2 };
const WRAP_MODES = { CLAMP: 33071, REPEAT: 10497, MIRRORED_REPEAT: 33648 };
const BLEND_MODES = { NORMAL: 0, ADD: 1, MULTIPLY: 2, SCREEN: 3, NORMAL_NPM: 17 };
const MSAA_QUALITY = { NONE: 0, LOW: 2, MEDIUM: 4, HIGH: 8 };

function checkExtension() { return true; }
function checkDataUrl() { return false; }
function createTexture() { return Texture.WHITE; }
function loadImageBitmap() { return Promise.resolve(Texture.WHITE); }

const PIXI = {
	Container, Graphics, Sprite, Text, SimplePlane,
	Texture, BaseTexture, RenderTexture,
	Rectangle, Point, Matrix, Color,
	Filter, Geometry, Buffer, Shader,
	Ticker, Application, Spritesheet, Assets,
	filters, utils, settings, extensions,
	ExtensionType, LoaderParserPriority,
	SCALE_MODES, MIPMAP_MODES, WRAP_MODES, BLEND_MODES, MSAA_QUALITY,
	checkExtension, checkDataUrl, createTexture, loadImageBitmap,
	Loader: class { constructor() { return makeLoader(); } static get shared() { return makeLoader(); } },
	autoDetectRenderer: makeRenderer,
	VERSION: '7.4.2',
};

// ---------------------------------------------------------------------------
// Minimal WebGL context — only the entry points PIXI/KD touch during boot.
// ---------------------------------------------------------------------------
function makeWebGLContext() {
	const gl = new Proxy({
		canvas: { width: 800, height: 600 },
		drawingBufferWidth: 800,
		drawingBufferHeight: 600,
		getParameter() { return 4096; },
		getExtension() { return null; },
		getShaderPrecisionFormat() { return { precision: 23, rangeMin: 127, rangeMax: 127 }; },
		createBuffer() { return {}; },
		createFramebuffer() { return {}; },
		createTexture() { return {}; },
		createProgram() { return {}; },
		createShader() { return {}; },
		getContextAttributes() { return { stencil: true }; },
	}, {
		get(target, prop) {
			if (prop in target) return target[prop];
			if (typeof prop === 'string' && prop === prop.toUpperCase()) return 0; // GL constants
			return noop;
		},
	});
	return gl;
}

// ---------------------------------------------------------------------------
// Canvas / DOM element stubs
// ---------------------------------------------------------------------------
function make2DContext() {
	return new Proxy({
		canvas: null,
		fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, font: '10px sans-serif',
		textAlign: 'left', textBaseline: 'alphabetic', lineWidth: 1, globalCompositeOperation: 'source-over',
		measureText(t) { return { width: (t ? t.length : 0) * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }; },
		getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }; },
		createImageData(w, h) { return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }; },
		putImageData() {},
		createLinearGradient() { return { addColorStop: noop }; },
		createRadialGradient() { return { addColorStop: noop }; },
		createPattern() { return {}; },
	}, { get(t, p) { return (p in t) ? t[p] : noop; }, set(t, p, v) { t[p] = v; return true; } });
}

function makeCanvas(w = 300, h = 150) {
	const ctx2d = make2DContext();
	const gl = makeWebGLContext();
	const canvas = {
		width: w, height: h, style: {},
		nodeName: 'CANVAS',
		getContext(type) { const c = (type === '2d') ? ctx2d : gl; c.canvas = canvas; return c; },
		toDataURL() { return 'data:image/png;base64,'; },
		toBlob(cb) { if (cb) cb(new globalThis.Blob([])); },
		addEventListener: noop, removeEventListener: noop,
		getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h }; },
		setAttribute: noop, getAttribute: () => null,
		appendChild(c) { return c; }, removeChild(c) { return c; },
		focus: noop, blur: noop,
		parentNode: null,
		classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
	};
	return canvas;
}

function makeElement(tag) {
	tag = (tag || 'div').toLowerCase();
	if (tag === 'canvas') return makeCanvas();
	const el = {
		tagName: tag.toUpperCase(), nodeName: tag.toUpperCase(),
		style: {}, dataset: {}, children: [], childNodes: [],
		innerHTML: '', innerText: '', textContent: '', value: '', className: '',
		id: '', width: 0, height: 0, clientWidth: 0, clientHeight: 0,
		offsetWidth: 0, offsetHeight: 0,
		appendChild(c) { this.children.push(c); this.childNodes.push(c); if (c) c.parentNode = el; return c; },
		removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
		insertBefore(c) { this.children.push(c); return c; },
		setAttribute(k, v) { this.dataset[k] = v; }, getAttribute() { return null; }, removeAttribute: noop,
		hasAttribute() { return false; },
		addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
		getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
		querySelector: () => null, querySelectorAll: () => [],
		focus: noop, blur: noop, click: noop, remove: noop,
		getContext() { return make2DContext(); },
		classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
		parentNode: null,
		append: noop, prepend: noop,
	};
	return el;
}

// ---------------------------------------------------------------------------
// install() — set up all globals on globalThis, then the bundle can be required.
// ---------------------------------------------------------------------------
function install(opts = {}) {
	const g = globalThis;

	g.PIXI = PIXI;

	// ---- document ----
	const elementsById = {};
	const mainCanvas = makeCanvas(800, 600);
	elementsById['MainCanvas'] = mainCanvas;
	const fontFaceSet = {
		_set: new Set(),
		add(f) { this._set.add(f); return this; },
		delete() { return true; },
		has() { return false; },
		forEach(cb) { this._set.forEach(cb); },
		ready: Promise.resolve(),
		check() { return true; },
		load() { return Promise.resolve([]); },
		addEventListener: noop, removeEventListener: noop,
		get size() { return this._set.size; },
	};
	const documentObj = {
		fonts: fontFaceSet,
		body: makeElement('body'),
		documentElement: makeElement('html'),
		head: makeElement('head'),
		readyState: 'complete',
		cookie: '',
		hidden: false,
		visibilityState: 'visible',
		getElementById(id) { return elementsById[id] || null; },
		getElementsByTagName() { return []; },
		getElementsByClassName() { return []; },
		querySelector() { return null; },
		querySelectorAll() { return []; },
		createElement(tag) { return makeElement(tag); },
		createElementNS(ns, tag) { return makeElement(tag); },
		createTextNode(t) { return { textContent: t, nodeValue: t }; },
		addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
		execCommand: noop,
		hasFocus: () => true,
		elementFromPoint: () => null,
		createEvent() { return { initEvent: noop }; },
	};
	g.document = documentObj;

	// ---- window / navigator / location etc. ----
	const navigatorObj = {
		userAgent: 'KD-headless-node',
		language: 'en', languages: ['en'],
		platform: 'node', vendor: '', appName: 'Netscape',
		onLine: true, hardwareConcurrency: 4, maxTouchPoints: 0,
		clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
		getGamepads: () => [],
		mediaDevices: { getUserMedia: () => Promise.reject(new Error('no media')) },
		serviceWorker: undefined,
	};
	const locationObj = {
		href: 'http://localhost/', protocol: 'http:', host: 'localhost', hostname: 'localhost',
		port: '', pathname: '/', search: '', hash: '', origin: 'http://localhost',
		reload: noop, assign: noop, replace: noop, toString() { return this.href; },
	};
	const localStorageObj = (() => {
		const store = new Map();
		return {
			getItem(k) { return store.has(k) ? store.get(k) : null; },
			setItem(k, v) { store.set(k, String(v)); },
			removeItem(k) { store.delete(k); },
			clear() { store.clear(); },
			key(i) { return Array.from(store.keys())[i] ?? null; },
			get length() { return store.size; },
		};
	})();

	const windowObj = g;
	g.window = windowObj;
	// navigator/location may be read-only on globalThis in Node — define carefully.
	try { Object.defineProperty(g, 'navigator', { value: navigatorObj, configurable: true, writable: true }); }
	catch (e) { g.navigator = navigatorObj; }
	try { Object.defineProperty(g, 'location', { value: locationObj, configurable: true, writable: true }); }
	catch (e) { g.location = locationObj; }
	g.localStorage = localStorageObj;
	g.sessionStorage = localStorageObj;
	g.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080, colorDepth: 24, orientation: { type: 'landscape-primary', angle: 0 } };
	g.devicePixelRatio = 1;
	g.innerWidth = 800; g.innerHeight = 600;
	g.outerWidth = 800; g.outerHeight = 600;
	g.scrollX = 0; g.scrollY = 0;
	g.performance = g.performance || { now: () => 0, mark: noop, measure: noop, getEntriesByName: () => [], getEntriesByType: () => [] };

	// timers / RAF
	g.requestAnimationFrame = g.requestAnimationFrame || ((cb) => setTimeout(() => cb(0), 0));
	g.cancelAnimationFrame = g.cancelAnimationFrame || ((id) => clearTimeout(id));
	g.addEventListener = noop; g.removeEventListener = noop; g.dispatchEvent = () => true;
	g.matchMedia = () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop });
	g.getComputedStyle = () => ({ getPropertyValue: () => '' });
	g.alert = noop; g.confirm = () => false; g.prompt = () => null;
	g.open = () => null; g.close = noop; g.focus = noop; g.blur = noop;
	g.scrollTo = noop; g.scroll = noop;

	// ---- browser APIs ----
	class FontFace {
		constructor(family, source, descriptors) { this.family = family; this.source = source; this.descriptors = descriptors || {}; this.status = 'unloaded'; }
		load() { this.status = 'loaded'; return Promise.resolve(this); }
	}
	g.FontFace = FontFace;

	class ImageStub {
		constructor() { this.width = 0; this.height = 0; this.src = ''; this.crossOrigin = null; this.complete = true; this.onload = null; this.onerror = null; }
		addEventListener(type, cb) { if (type === 'load' && cb) setTimeout(() => cb({}), 0); }
		removeEventListener() {}
		set onload(cb) { this._onload = cb; if (cb) setTimeout(() => cb({}), 0); }
		get onload() { return this._onload; }
	}
	g.Image = ImageStub;
	g.HTMLImageElement = ImageStub;
	g.HTMLCanvasElement = function HTMLCanvasElement() {};
	g.HTMLElement = function HTMLElement() {};

	class AudioStub {
		constructor(src) { this.src = src || ''; this.volume = 1; this.loop = false; this.currentTime = 0; this.paused = true; this.muted = false; }
		play() { return Promise.resolve(); }
		pause() {} load() {}
		canPlayType() { return ''; }
	}
	AudioStub.prototype.addEventListener = noop;
	AudioStub.prototype.removeEventListener = noop;
	g.Audio = AudioStub;

	class AudioContextStub {
		constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.sampleRate = 44100; this.listener = { setPosition: noop, setOrientation: noop, positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } }; }
		createGain() { return { gain: { value: 1, setValueAtTime: noop, linearRampToValueAtTime: noop }, connect: noop, disconnect: noop }; }
		createOscillator() { return { frequency: { value: 440 }, connect: noop, disconnect: noop, start: noop, stop: noop }; }
		createBufferSource() { return { buffer: null, connect: noop, disconnect: noop, start: noop, stop: noop, loop: false }; }
		createBuffer() { return { getChannelData: () => new Float32Array(0) }; }
		createPanner() { return { connect: noop, disconnect: noop, setPosition: noop }; }
		createMediaElementSource() { return { connect: noop, disconnect: noop }; }
		createDynamicsCompressor() { return { connect: noop, disconnect: noop, threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } }; }
		decodeAudioData() { return Promise.resolve({ getChannelData: () => new Float32Array(0) }); }
		resume() { return Promise.resolve(); }
		suspend() { return Promise.resolve(); }
		close() { return Promise.resolve(); }
	}
	g.AudioContext = AudioContextStub;
	g.webkitAudioContext = AudioContextStub;

	// fetch — file-backed for local resource paths (translations, CSV, JSON under
	// the repo). No network. Maps the URL pathname to a file under __KD_REPO_ROOT;
	// anything unresolved returns a benign empty 200 so loaders complete without
	// throwing an async unhandled rejection.
	const _fs = require('fs');
	const _path = require('path');
	const _Buffer = require('buffer').Buffer;
	const repoRoot = (typeof g.__KD_REPO_ROOT === 'string') ? g.__KD_REPO_ROOT : process.cwd();
	function makeResponse(body, ok = true, status = 200) {
		const buf = _Buffer.isBuffer(body) ? body : _Buffer.from(body || '');
		return {
			ok, status, statusText: ok ? 'OK' : 'Not Found', url: '',
			headers: { get: () => null, has: () => false },
			text: () => Promise.resolve(buf.toString('utf8')),
			json: () => { try { return Promise.resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { return Promise.reject(e); } },
			arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
			blob: () => Promise.resolve(new g.Blob([buf])),
			clone() { return makeResponse(buf, ok, status); },
		};
	}
	g.fetch = function fetchShim(url) {
		try {
			let p = String((url && url.url) || url || '');
			if (p.startsWith('http')) { try { p = new (require('url').URL)(p).pathname; } catch (e) {} }
			p = p.replace(/^\.?\//, '').split('?')[0].split('#')[0];
			const full = _path.join(repoRoot, decodeURIComponent(p));
			if (full.startsWith(repoRoot) && _fs.existsSync(full) && _fs.statSync(full).isFile()) {
				return Promise.resolve(makeResponse(_fs.readFileSync(full), true, 200));
			}
		} catch (e) { /* fall through to empty */ }
		return Promise.resolve(makeResponse('', false, 404));
	};
	if (!g.Blob) g.Blob = class Blob { constructor(parts) { this.parts = parts || []; this.size = 0; this.type = ''; } slice() { return new g.Blob([]); } text() { return Promise.resolve(''); } arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); } };
	if (!g.URL) g.URL = require('url').URL;
	if (!g.URL.createObjectURL) g.URL.createObjectURL = () => 'blob:headless';
	if (!g.URL.revokeObjectURL) g.URL.revokeObjectURL = noop;

	class XHRStub {
		constructor() { this.readyState = 0; this.status = 0; this.response = null; this.responseText = ''; this.onload = null; this.onerror = null; this.onreadystatechange = null; }
		open() { this.readyState = 1; }
		setRequestHeader() {}
		send() { this.readyState = 4; this.status = 0; if (this.onerror) this.onerror({}); }
		abort() {}
		addEventListener() {} removeEventListener() {}
		getAllResponseHeaders() { return ''; }
		getResponseHeader() { return null; }
	}
	g.XMLHttpRequest = XHRStub;

	class WebSocketStub {
		constructor() { this.readyState = 0; this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null; }
		send() {} close() {}
		addEventListener() {} removeEventListener() {}
	}
	WebSocketStub.CONNECTING = 0; WebSocketStub.OPEN = 1; WebSocketStub.CLOSING = 2; WebSocketStub.CLOSED = 3;
	g.WebSocket = WebSocketStub;

	g.createImageBitmap = () => Promise.resolve({ width: 1, height: 1, close: noop });
	g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
	g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
	g.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };

	class WorkerStub {
		constructor() { this.onmessage = null; this.onerror = null; }
		postMessage() {} terminate() {}
		addEventListener() {} removeEventListener() {}
	}
	g.Worker = WorkerStub;

	// IndexedDB — stub that "opens" successfully with an empty store, so KD's
	// async save/mod DB loads resolve cleanly (resolve null = no save) instead of
	// throwing an unhandled rejection on a missing db.
	const makeRequest = (result) => {
		const req = { result, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
		setTimeout(() => { if (req.onsuccess) req.onsuccess({ target: req }); }, 0);
		return req;
	};
	const makeStore = () => ({
		get() { return makeRequest(undefined); },
		put() { return makeRequest(undefined); },
		add() { return makeRequest(undefined); },
		delete() { return makeRequest(undefined); },
		getAll() { return makeRequest([]); },
		clear() { return makeRequest(undefined); },
		createIndex: noop,
	});
	const makeDB = () => ({
		objectStoreNames: { contains: () => true, length: 1 },
		transaction() {
			const tx = { objectStore: () => makeStore(), oncomplete: null, onerror: null, onabort: null, abort: noop };
			setTimeout(() => { if (tx.oncomplete) tx.oncomplete({}); }, 0);
			return tx;
		},
		createObjectStore() { return makeStore(); },
		close: noop,
	});
	g.indexedDB = {
		open() {
			const db = makeDB();
			const req = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
			setTimeout(() => {
				if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
				if (req.onsuccess) req.onsuccess({ target: req });
			}, 0);
			return req;
		},
		deleteDatabase() { return makeRequest(undefined); },
	};

	if (!g.crypto) g.crypto = require('crypto').webcrypto || { getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; } };

	// guessLanguage stub (real one needs _languageData global; KD only calls it for UI)
	if (!g.guessLanguage) g.guessLanguage = { detect: (text, cb) => { if (cb) cb('en'); }, info: () => ['en', 'English', ''] };
	if (!g.m4) g.m4 = makeM4Stub();

	return { document: documentObj, window: windowObj, PIXI };
}

// Minimal m4 (4x4 matrix math) — KD's webgl background uses it. Stub to identity-ish.
function makeM4Stub() {
	const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	return {
		identity: ident,
		multiply: (a) => a || ident(),
		translation: ident, translate: (a) => a || ident(),
		scaling: ident, scale: (a) => a || ident(),
		xRotation: ident, yRotation: ident, zRotation: ident,
		xRotate: (a) => a || ident(), yRotate: (a) => a || ident(), zRotate: (a) => a || ident(),
		orthographic: ident, perspective: ident,
		inverse: (a) => a || ident(),
		transpose: (a) => a || ident(),
		copy: (a) => (a ? a.slice() : ident()),
	};
}

module.exports = { install, PIXI };
