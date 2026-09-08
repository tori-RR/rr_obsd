'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../src/modules/floating-new-note.js');
const moduleMock = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  module: moduleMock,
  require(id) {
    assert.equal(id, 'obsidian');
    return { setIcon: (element, icon) => { element.icon = icon; }, getIconIds: () => [] };
  },
  console, setTimeout, clearTimeout,
}, { filename });
const { FloatingNewNoteModule } = moduleMock.exports;

class Element {
  constructor(className = '') {
    this.className = className;
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.properties = new Map();
    this.style = { setProperty: (name, value) => this.properties.set(name, value) };
  }
  createDiv({ cls }) {
    const child = new Element(cls);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.className.split(' ').includes(selector.slice(1))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  async click() {
    await this.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
  }
}

function fixture({ active = { parent: { path: '/' } }, settings = {}, existing = [] } = {}) {
  const container = new Element();
  const created = [], opened = [], folders = [];
  const files = new Set(existing);
  const callbacks = new Map();
  let ready;
  const workspace = {
    on: (event, callback) => { callbacks.set(event, callback); return { event }; },
    onLayoutReady: callback => { ready = callback; },
    getLeavesOfType: () => [{ containerEl: container }],
    getActiveFile: () => active,
    getLeaf: () => ({ openFile: async file => { opened.push(file.path); } }),
  };
  const host = {
    registerEvent() {},
    app: { workspace, vault: {
      getAbstractFileByPath: filePath => files.has(filePath) ? { path: filePath } : null,
      createFolder: async folder => { folders.push(folder); files.add(folder); },
      create: async (filePath, content) => {
        created.push({ path: filePath, content });
        files.add(filePath);
        return { path: filePath };
      },
    } },
  };
  const options = { enabled: true, targetFolderMode: 'active', targetFolder: 'New',
    icon: 'pen-box', opacity: 0, btnOpacity: 1, hoverBlend: 0.4, ...settings };
  const plugin = new FloatingNewNoteModule(host, options, async () => {});
  return { plugin, container, created, opened, folders, callbacks, options, workspace,
    ready: () => ready(), click: () => container.querySelector('.fab-btn').click() };
}

test('same-level creation in the vault root does not fall back to New', async () => {
  for (const rootPath of ['/', '']) {
    const f = fixture({ active: { parent: { path: rootPath } }, existing: ['Untitled.md'] });
    await f.plugin.onload();
    f.ready();
    await f.click();
    assert.deepEqual(f.created, [{ path: 'Untitled 1.md', content: '' }]);
    assert.deepEqual(f.opened, ['Untitled 1.md']);
    assert.deepEqual(f.folders, []);
  }
});

test('same-level creation retains the active nested folder', async () => {
  const f = fixture({ active: { parent: { path: 'Work/项目' } }, existing: ['Work/项目'] });
  await f.plugin.onload();
  f.ready();
  await f.click();
  assert.equal(f.created[0].path, 'Work/项目/Untitled.md');
  assert.deepEqual(f.folders, []);
});

test('missing active note uses the configured fallback folder', async () => {
  const f = fixture({ active: null });
  await f.plugin.onload();
  f.ready();
  await f.click();
  assert.equal(f.created[0].path, 'New/Untitled.md');
  assert.deepEqual(f.folders, ['New']);
});

test('static mode uses the configured folder or an explicitly empty root', async () => {
  for (const targetFolder of ['/Fixed/', '']) {
    const f = fixture({ active: { parent: { path: 'Active' } },
      settings: { targetFolderMode: 'static', targetFolder } });
    await f.plugin.onload();
    f.ready();
    await f.click();
    assert.equal(f.created[0].path, targetFolder ? 'Fixed/Untitled.md' : 'Untitled.md');
  }
});

test('late layout-ready and workspace events cannot recreate buttons after unload', async () => {
  const f = fixture();
  await f.plugin.onload();
  f.plugin.onunload();
  f.ready();
  f.callbacks.get('layout-change')();
  f.callbacks.get('resize')();
  assert.equal(f.container.children.length, 0);
  assert.equal(f.plugin.buttons.size, 0);
});

test('disabling or unloading only removes this module\'s own buttons', async () => {
  const f = fixture();
  const foreign = f.container.createDiv({ cls: 'fab-container' });
  await f.plugin.onload();
  f.ready();
  const own = f.plugin.buttons.get(f.container);
  assert.notEqual(own, foreign);
  assert.equal(foreign.properties.size, 0);
  f.plugin.injectAll();
  assert.equal(f.container.children.length, 2);
  f.options.enabled = false;
  f.plugin.injectAll();
  assert.deepEqual(f.container.children, [foreign]);
  f.options.enabled = true;
  f.plugin.injectAll();
  f.plugin.onunload();
  assert.deepEqual(f.container.children, [foreign]);
});

test('closed leaves release their owned buttons and detached click handlers stay inactive', async () => {
  const f = fixture();
  await f.plugin.onload();
  f.ready();
  const oldButton = f.container.querySelector('.fab-btn');
  f.workspace.getLeavesOfType = () => [];
  f.plugin.injectAll();
  assert.equal(f.container.children.length, 0);
  assert.equal(f.plugin.buttons.size, 0);
  f.plugin.onunload();
  await oldButton.click();
  assert.deepEqual(f.created, []);
});
