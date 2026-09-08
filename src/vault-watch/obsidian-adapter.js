'use strict';

function createApplyPath(adapter, normalizePath, isAlive = () => true, onApplied = () => {}) {
  if (!adapter || !['getBasePath', 'queue', 'reconcileFile'].every(key => typeof adapter[key] === 'function') ||
      typeof normalizePath !== 'function') {
    throw new Error('This Obsidian version does not expose the required file adapter methods.');
  }
  return async (relative, context = { isCurrent: () => true }) => {
    if (!isAlive() || !context.isCurrent()) return;
    return adapter.queue(async () => {
      // Obsidian's own queue can be busy when a disconnect or unload arrives.
      if (!isAlive() || !context.isCurrent()) return;
      await adapter.reconcileFile(relative, normalizePath(relative), true);
      onApplied(relative);
    });
  };
}

module.exports = { createApplyPath };
