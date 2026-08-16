'use strict';
/* Loads the REAL app.js (unmodified, not retyped) into a minimal sandboxed
   environment so its pure functions can be called and verified from Node
   with node-canvas, per the project spec's verification methodology (§9). */

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createCanvas, Image } = require('canvas');

function loadApp() {
  const sandbox = {
    console,
    Math, Date, Promise, JSON, Object, Array, String, Number, RegExp, Boolean,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Image,
    document: {
      createElement(tag) {
        if (tag === 'canvas') return createCanvas(2, 2);
        return { style: {}, click() {}, remove() {}, classList: { add() {}, remove() {}, toggle() {} } };
      },
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    window: { addEventListener() {}, innerWidth: 390, innerHeight: 844 },
    navigator: {},
    screen: {},
    localStorage: { getItem() { return null; }, setItem() {} },
    fetch: () => Promise.resolve({ ok: false }),
    indexedDB: undefined,
  };
  sandbox.global = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  return sandbox;
}

module.exports = { loadApp, createCanvas, Image };
