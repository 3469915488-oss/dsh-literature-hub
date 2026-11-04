import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPdfMarks, locateTextAnchor } from '../reader/annotation.js';

// Only the SVG DOM operations used by the public annotation renderer are emulated.
// Pointer coordinates and viewport geometry are supplied independently by each test.
class SvgNode {
  constructor(tag) { this.tagName = tag; this.attributes = new Map(); this.children = []; this.listeners = new Map(); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(child) { child.parentNode = this; this.children.push(child); }
  remove() { const siblings = this.parentNode?.children; if (siblings) siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setPointerCapture(id) { this.capturedPointer = id; }
  getBoundingClientRect() { return this.parentNode.getBoundingClientRect(); }
  dispatch(name, properties) {
    const event = { preventDefault() { this.defaultPrevented = true; }, ...properties };
    this.listeners.get(name)?.(event);
    return event;
  }
}

function pageAt(rect, number = 3) {
  return {
    dataset: { page: String(number) }, children: [], rect,
    append(child) { child.parentNode = this; this.children.push(child); },
    querySelector(selector) { return selector === '.page-mark-layer' ? this.children.find(n => n.getAttribute('class') === 'page-mark-layer') ?? null : null; },
    closest(selector) { return selector === '.drawing' ? this : null; },
    getBoundingClientRect() { return this.rect; },
  };
}
function installSvgDom(t) {
  const previous = globalThis.document;
  globalThis.document = {
    createElementNS(_namespace, tag) { return new SvgNode(tag); },
    querySelector(selector) { assert.equal(selector, '#mark-color'); return { value: '#e3ac00' }; },
  };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
}
function nearly(actual, expected, message) { assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: expected ${expected}, got ${actual}`); }
function screenPoint(layer, x, y) {
  const [minX, minY, width, height] = layer.getAttribute('viewBox').split(/\s+/).map(Number);
  const bounds = layer.getBoundingClientRect();
  return { x: bounds.left + (Number(x) - minX) / width * bounds.width, y: bounds.top + (Number(y) - minY) / height * bounds.height };
}
function assertPoint(actual, expected, label) { nearly(actual.x, expected.x, `${label} x`); nearly(actual.y, expected.y, `${label} y`); }

test('drawing pointer events save page-relative coordinates, clamp overflow and ignore another pointer', t => {
  installSvgDom(t);
  const page = pageAt({ left: 100, top: 200, width: 400, height: 600 });
  const saved = [];
  const layer = renderPdfMarks(page, [], stroke => saved.push(stroke));
  const down = layer.dispatch('pointerdown', { pointerId: 7, clientX: 180, clientY: 320 });
  assert.equal(down.defaultPrevented, true);
  assert.equal(layer.capturedPointer, 7);
  layer.dispatch('pointermove', { pointerId: 99, clientX: 0, clientY: 0 });
  layer.dispatch('pointerup', { pointerId: 99, clientX: 0, clientY: 0 });
  assert.equal(saved.length, 0, 'an unrelated pointer cannot end the stroke');
  layer.dispatch('pointermove', { pointerId: 7, clientX: 300, clientY: 500 });
  layer.dispatch('pointermove', { pointerId: 7, clientX: 550, clientY: 100 });
  layer.dispatch('pointerup', { pointerId: 7, clientX: 550, clientY: 100 });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].page, 3);
  assert.deepEqual(saved[0].points, [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }]);
  layer.dispatch('pointermove', { pointerId: 7, clientX: 100, clientY: 200 });
  layer.dispatch('pointerup', { pointerId: 7, clientX: 100, clientY: 200 });
  assert.equal(saved.length, 1, 'a completed stroke cannot be saved twice');
});

test('saved highlight, underline and freehand geometry stay anchored after zoom and viewport relocation', t => {
  installSvgDom(t);
  const page = pageAt({ left: 100, top: 200, width: 400, height: 600 });
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.04 };
  const annotations = [
    { id: 'h', page: 3, type: 'highlight', color: '#e3ac00', rects: [rect] },
    { id: 'u', page: 3, type: 'underline', color: '#be502f', rects: [rect] },
    { id: 'd', page: 3, type: 'draw', color: '#be502f', points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }] },
    { id: 'other-page', page: 4, type: 'highlight', rects: [rect] },
  ];
  const original = renderPdfMarks(page, annotations, () => {});
  assert.equal(original.getAttribute('viewBox'), '0 0 1000 1000');
  assert.equal(original.getAttribute('preserveAspectRatio'), 'none');
  assert.equal(original.children.length, 3, 'annotations from other pages are excluded');
  const firstHighlight = original.children.find(n => n.tagName === 'rect');
  assertPoint(screenPoint(original, firstHighlight.getAttribute('x'), firstHighlight.getAttribute('y')), { x: 140, y: 320 }, 'initial highlight');
  const sourceGeometry = original.children.map(node => Object.fromEntries(node.attributes));

  page.rect = { left: 50, top: 75, width: 800, height: 1200 };
  const replay = renderPdfMarks(page, annotations, () => {});
  assert.equal(page.children.length, 1, 'repainting replaces the old overlay');
  assert.equal(replay.getAttribute('viewBox'), '0 0 1000 1000');
  assert.equal(replay.getAttribute('preserveAspectRatio'), 'none');
  assert.deepEqual(replay.children.map(node => Object.fromEntries(node.attributes)), sourceGeometry, 'stored SVG geometry is independent of viewport size and position');

  const highlight = replay.children.find(n => n.tagName === 'rect');
  assertPoint(screenPoint(replay, highlight.getAttribute('x'), highlight.getAttribute('y')), { x: 130, y: 315 }, 'zoomed highlight start');
  const highlightEnd = screenPoint(replay, Number(highlight.getAttribute('x')) + Number(highlight.getAttribute('width')), Number(highlight.getAttribute('y')) + Number(highlight.getAttribute('height')));
  assertPoint(highlightEnd, { x: 370, y: 363 }, 'zoomed highlight end');
  const underline = replay.children.find(n => n.tagName === 'line');
  assertPoint(screenPoint(replay, underline.getAttribute('x1'), underline.getAttribute('y1')), { x: 130, y: 363 }, 'zoomed underline start');
  assertPoint(screenPoint(replay, underline.getAttribute('x2'), underline.getAttribute('y2')), { x: 370, y: 363 }, 'zoomed underline end');
  const stroke = replay.children.find(n => n.tagName === 'polyline');
  const points = stroke.getAttribute('points').split(' ').map(p => p.split(',').map(Number));
  assertPoint(screenPoint(replay, ...points[0]), { x: 210, y: 315 }, 'zoomed freehand start');
  assertPoint(screenPoint(replay, ...points[1]), { x: 450, y: 675 }, 'zoomed freehand end');
  assert.equal(stroke.getAttribute('vector-effect'), 'non-scaling-stroke', 'zoom preserves stroke legibility');
  assert.equal(underline.getAttribute('vector-effect'), 'non-scaling-stroke');
});


test('DOCX text selections use paragraph IDs through repeated and cross-block text',()=>{
  const blocks=[{id:'first',text:'重复句子'},{blockId:'second',text:'重复句子'},{id:'third',text:'结束'}];
  const second=locateTextAnchor({start:6,end:10,quote:'重复句子'},blocks);
  assert.equal(second.blockId,'second');
  assert.deepEqual(locateTextAnchor({start:8,end:14,quote:'句子\n\n结束'},blocks).blockIds,['second','third']);
  assert.deepEqual(locateTextAnchor({quote:'没有字符位置'},blocks),{quote:'没有字符位置'});
});
