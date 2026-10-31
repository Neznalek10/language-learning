import { pickerView, openSetup } from './write.js';
import { openGenerate } from './generate.js';
import { openFreeWriting } from './free.js';

export function writeView(app, params) {
  return pickerView(app, params, {
    mode: 'write',
    title: 'Write',
    noun: 'writing',
    notebook: true,
    open: openSetup,
    banner: 'AI checking is not set up. You can still write and keep drafts.',
    actions: [
      { label: 'Free writing', icon: 'write', run: openFreeWriting },
      { label: 'Generate new topic', icon: 'bulb', run: a => openGenerate(a, 'write', t => openSetup(a, t)) },
    ],
  });
}
