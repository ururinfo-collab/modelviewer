// Undo / redo for everything that changes what the model looks like: hide, see-through, isolate,
// tags, categories, scene visibility, moving / rotating / resetting objects.
// Each step stores the whole (small) state before the change, so undo puts that state back.
const MAX = 60;

export class History {
  constructor(app) {
    this.app = app;
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  snapshot() {
    const v = this.app.viewer, m = this.app.move;
    return {
      hidden: v.ents.filter(E => E.hidden).map(E => E.id),
      ghost: v.ents.filter(E => E.ghost).map(E => E.id),
      tags: [...v.tags.values()].filter(t => !t.visible).map(t => t.name),
      cats: [...v.categories.values()].filter(c => !c.visible).map(c => c.name),
      iso: v.isolated ? { ids: [...v.isolated].map(E => E.id), key: v.isolated.__key } : null,
      moved: [...m.original.keys()].map(E => [E.id, E.obj.matrix.clone()]),
    };
  }

  // call just before a change
  record(label) {
    if (!this.app.viewer.root) return;
    this.undoStack.push({ label, s: this.snapshot() });
    if (this.undoStack.length > MAX) this.undoStack.shift();
    this.redoStack = [];
    this.onChange?.();
  }

  restore(s) {
    const v = this.app.viewer, m = this.app.move;
    const hidden = new Set(s.hidden), ghost = new Set(s.ghost), tags = new Set(s.tags), cats = new Set(s.cats);
    for (const E of v.ents) { E.hidden = hidden.has(E.id); E.ghost = ghost.has(E.id); }
    for (const t of v.tags.values()) t.visible = !tags.has(t.name);
    for (const c of v.categories.values()) c.visible = !cats.has(c.name);
    v.isolated = s.iso ? new Set(s.iso.ids.map(id => v.ents[id])) : null;
    if (v.isolated && s.iso.key) v.isolated.__key = s.iso.key;
    const moved = new Map(s.moved);
    for (const [E, orig] of m.original) m.setMatrix(E, moved.get(E.id) || orig);
    if (m.E) m.placeProxy();
    v.refreshMaterials();
    v.updateVisibility();
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push({ label: step.label, s: this.snapshot() });
    this.restore(step.s);
    this.onChange?.();
    return step.label;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push({ label: step.label, s: this.snapshot() });
    this.restore(step.s);
    this.onChange?.();
    return step.label;
  }

  // the last recorded step changed nothing
  dropLast() {
    this.undoStack.pop();
    this.onChange?.();
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange?.();
  }
}
