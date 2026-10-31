const BACKUP_EVERY_DAYS = 14;
const BACKUP_AFTER_WORDS = 20;

// Is a backup reminder due? Only once there is something worth losing.
export function backupDue({ words, lastBackup, now = Date.now() }) {
  if (words < BACKUP_AFTER_WORDS) return false;
  return !lastBackup || now - lastBackup > BACKUP_EVERY_DAYS * 86400000;
}

// What to offer on Home, most pressing first. Each input is optional.
export function continueItems({ chat, draft, step, openMistakes, backup }, limit = 3) {
  const items = [];
  if (chat && chat.count > 1) items.push({ kind: 'chat', icon: 'write', title: 'Continue your chat', sub: `${chat.count} messages so far` });
  if (draft) items.push({ kind: 'draft', icon: 'write', id: draft.id, title: `Finish your draft: ${draft.title}`, sub: `${draft.words} words written` });
  if (step) items.push({ kind: 'learn', icon: 'learn', href: step.href, title: step.title, sub: step.sub });
  if (openMistakes > 0) items.push({ kind: 'mistakes', icon: 'alert', href: '#/mistakes', title: `Review ${openMistakes} ${openMistakes === 1 ? 'mistake' : 'mistakes'}`, sub: 'From your checked texts' });
  if (backup) items.push({ kind: 'backup', icon: 'download', href: '#/settings', title: 'Back up your progress', sub: 'It only lives in this browser' });
  return items.slice(0, limit);
}
