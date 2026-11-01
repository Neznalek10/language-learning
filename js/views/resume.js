import { store } from '../store.js';
import { wordCount } from '../ai.js';
import { backupDue, continueItems } from '../learn/resume.js';
import { folderActive } from '../folder.js';
import { learnParts, partStates, nextStep } from '../learn/course.js';
import { activeMistakes } from '../learn/mistakes.js';
import { findTopic, writeOptions, startWriting } from './write.js';
import { freeTopic } from './free.js';
import { lessonHref, unitHref } from './lesson.js';

function latestDraft(app) {
  const drafts = Object.entries(store.write.topics)
    .filter(([, e]) => e.draft?.text?.trim())
    .sort((a, b) => b[1].draft.at - a[1].draft.at);
  if (!drafts.length) return null;
  const [id, e] = drafts[0];
  const topic = id === 'free' ? freeTopic('A1') : findTopic(app, 'write', id);
  return topic ? { id, title: topic.title, words: wordCount(e.draft.text) } : null;
}

function nextLearnStep(app) {
  const parts = learnParts(app);
  if (!parts.length) return null;
  const step = nextStep(parts, partStates(parts, store.learn), store.learn);
  if (!step) return null;
  const { part, lesson } = step;
  return lesson
    ? { href: lessonHref(part, lesson), title: `Lesson ${lesson.index + 1}: ${lesson.title}`, sub: `Learn · ${part.id} ${part.title}` }
    : { href: unitHref(part.unitId), title: `Take the test for ${part.id}`, sub: `Learn · ${part.title}` };
}

export function homeContinue(app) {
  return continueItems({
    chat: store.write.chat ? { count: store.write.chat.messages?.length || 0 } : null,
    draft: latestDraft(app),
    step: nextLearnStep(app),
    openMistakes: activeMistakes(store.write.mistakes || []).length,
    backup: !folderActive() && backupDue({ words: Object.keys(store.progress).length, lastBackup: store.settings.lastBackup }),
  });
}

// Opens a saved draft or chat where you left it.
export function resume(app, item) {
  if (item.kind === 'chat') {
    const saved = store.write.chat;
    app.chatSession = { opts: saved.opts, messages: saved.messages, busy: false, error: '' };
    app.go('chat');
    return;
  }
  const entry = store.write.topics[item.id];
  const opts = { ...writeOptions(), ...(item.id === 'free' ? { level: writeOptions().freeLevel || 'A1' } : {}), hints: item.id !== 'free' && writeOptions().hints };
  if (item.id === 'free') {
    app.writeSession = { topic: freeTopic(opts.level), topicId: 'free', opts, text: entry.draft.text, stage: 'edit', result: null, error: '' };
    app.go('writing');
  } else {
    startWriting(app, findTopic(app, 'write', item.id), opts, entry.draft.text);
  }
}
