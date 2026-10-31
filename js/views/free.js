import { store } from '../store.js';
import { ACCENTS } from '../data.js';
import { html, icon, plural, segmented, onSegmented } from '../ui.js';
import { aiReady, wordCount, AiError } from '../ai.js';
import { chatTurn, OPENER } from '../learn/freechat.js';
import { aiSettings, writeOptions, runCheck } from './write.js';
import { addMistakes } from '../learn/mistakes.js';

const MIN_WORDS = 8;
const LEVELS = ['A1', 'A2', 'B1'];
const STRICT = [{ value: 'gentle', label: 'Gentle' }, { value: 'normal', label: 'Normal' }, { value: 'strict', label: 'Strict' }];
const FEEDBACK = [{ value: 'en', label: 'English' }, { value: 'cs', label: 'Czech' }, { value: 'fr', label: 'French' }];
const MODES = [{ value: 'chat', label: 'Talk with me' }, { value: 'check', label: 'Just correct me' }];

export const freeTopic = level => ({
  id: 'free', free: true, level, kind: 'free', title: 'Free writing',
  task: 'Write about anything you like. Only your French is judged, not the subject.',
  must: [], phrases: [], grammar: [],
});

const savedOptions = () => ({ freeMode: 'chat', freeLevel: 'A1', live: true, ...writeOptions() });

function persistChat(session) {
  store.write.chat = { opts: session.opts, messages: session.messages };
  store.save('write');
}

export function openFreeWriting(app) {
  let o = savedOptions();
  const draft = store.write.topics.free?.draft?.text;
  const chat = store.write.chat;
  const save = patch => {
    store.settings.write = { ...writeOptions(), ...patch };
    store.save('settings');
    o = savedOptions();
  };

  app.sheet({
    title: 'Free writing',
    body: html`
      <p class="sheet-text">Write about anything. Choose whether the AI chats with you or only corrects what you write.</p>
      <div class="field-label">The AI should</div>
      ${segmented('freeMode', MODES, o.freeMode)}
      <p class="muted small w-range" data-mode-hint></p>
      <div class="field-label">Your level</div>
      ${segmented('freeLevel', LEVELS.map(l => ({ value: l, label: l })), o.freeLevel)}
      <div class="field-label">How strict should the check be?</div>
      ${segmented('strict', STRICT, o.strict)}
      <div class="field-label">Feedback language</div>
      ${segmented('feedback', FEEDBACK, o.feedback)}
      <div data-live-box>
        <div class="field-label">Corrections while chatting</div>
        ${segmented('live', [{ value: 'on', label: 'After each message' }, { value: 'off', label: 'Only at the end' }], o.live ? 'on' : 'off')}
      </div>
      <button class="btn btn-primary btn-block btn-lg" data-start>${icon('play')}<span data-start-label></span></button>`,
    onMount(body, close) {
      const label = body.querySelector('[data-start-label]');
      const hint = body.querySelector('[data-mode-hint]');
      const refresh = () => {
        const chatting = o.freeMode === 'chat';
        body.querySelector('[data-live-box]').hidden = !chatting;
        hint.textContent = chatting
          ? 'The AI answers like a pen pal: it reacts, asks questions and shares opinions. You get a full check when you finish.'
          : 'You write one text. The AI corrects it, marks the mistakes and suggests more natural phrasing.';
        label.textContent = chatting ? (chat?.messages?.length > 1 ? 'Continue the conversation' : 'Start chatting') : (draft ? 'Continue your draft' : 'Start writing');
      };
      refresh();
      onSegmented(body, (name, value) => {
        save({ [name]: name === 'live' ? value === 'on' : value });
        refresh();
      });
      body.querySelector('[data-start]').addEventListener('click', () => {
        close();
        const opts = { level: o.freeLevel, strict: o.strict, feedback: o.feedback, live: o.live, length: 'medium', hints: false };
        if (o.freeMode === 'chat') {
          app.chatSession = chat?.messages?.length > 1
            ? { opts, messages: chat.messages, busy: false, error: '' }
            : { opts, messages: [{ role: 'ai', text: OPENER }], busy: false, error: '' };
          app.go('chat');
        } else {
          app.writeSession = { topic: freeTopic(opts.level), topicId: 'free', opts, text: draft || '', stage: 'edit', result: null, error: '' };
          app.go('writing');
        }
      });
    },
  });
}

const accentBar = () => html`<div class="accent-bar">${ACCENTS.fr.split(' ').map(ch => html`<button type="button" tabindex="-1" data-char="${ch}">${ch}</button>`)}</div>`;

function messageMarkup(m, live) {
  if (m.role === 'ai') return html`<div class="chat-msg is-ai" lang="fr">${m.text}</div>`;
  return html`<div class="chat-msg is-me" lang="fr">${m.text}
    ${live && m.corrections?.length ? html`<div class="chat-fix">${m.corrections.map(c => html`<div><s>${c.wrong}</s> ${icon('chevronRight')} <strong>${c.right}</strong><small>${c.why}</small></div>`)}</div>` : ''}
  </div>`;
}

export function chatView(app) {
  const session = app.chatSession;
  if (!session) return { redirect: 'write' };

  const body = html`
    <section class="card chat-card"><div class="chat-log" data-log aria-live="polite"></div></section>
    <section class="card">
      <div data-error></div>
      <textarea class="input textarea w-text chat-input" lang="fr" rows="3" spellcheck="false" autocapitalize="sentences" autocomplete="off"
        placeholder="Écris ton message ici..." aria-label="Your message"></textarea>
      ${accentBar()}
      <button class="btn btn-primary btn-block btn-lg" data-send>${icon('check')}<span>Send</span></button>
      <button class="btn btn-secondary btn-block" data-finish>${icon('trophy')}Finish and get feedback</button>
    </section>
    <p class="muted small w-hint">Level ${session.opts.level}. The conversation is saved on this device until you finish.</p>`;

  return {
    title: 'Free writing',
    back: 'write',
    tab: 'write',
    hideLang: true,
    body,
    mount(root) {
      const log = root.querySelector('[data-log]');
      const area = root.querySelector('.chat-input');
      const errorBox = root.querySelector('[data-error]');
      const send = root.querySelector('[data-send]');
      const renderLog = () => {
        log.innerHTML = [
          ...session.messages.map(m => messageMarkup(m, session.opts.live)),
          session.busy ? html`<div class="chat-msg is-ai is-typing" aria-label="Thinking"><span></span><span></span><span></span></div>` : '',
        ].map(x => (x.s ?? x)).join('');
        log.lastElementChild?.scrollIntoView({ block: 'nearest' });
      };
      const showError = text => {
        errorBox.innerHTML = text ? html`<div class="notice notice-bad">${icon('alert')}<span>${text}</span></div>`.s : '';
      };
      renderLog();
      showError(session.error);

      root.querySelector('.accent-bar').addEventListener('click', e => {
        const btn = e.target.closest('[data-char]');
        if (!btn) return;
        const { selectionStart: s0, selectionEnd: s1, value } = area;
        area.value = value.slice(0, s0) + btn.dataset.char + value.slice(s1);
        area.setSelectionRange(s0 + 1, s0 + 1);
        area.focus();
      });

      const submit = async () => {
        const text = area.value.trim();
        if (!text || session.busy) return;
        if (!aiReady(aiSettings())) {
          app.toast('Set up the AI in Settings first.', { kind: 'error' });
          return;
        }
        const mine = { role: 'me', text, corrections: [] };
        session.messages.push(mine);
        session.busy = true;
        session.error = '';
        area.value = '';
        send.disabled = true;
        showError('');
        renderLog();
        try {
          const turn = await chatTurn(aiSettings(), { opts: session.opts, messages: session.messages });
          mine.corrections = turn.corrections;
          addMistakes((store.write.mistakes ??= []), turn.corrections, { source: 'chat', topic: 'Free writing' });
          session.messages.push({ role: 'ai', text: turn.reply });
          persistChat(session);
        } catch (e) {
          session.messages.pop();
          area.value = text;
          session.error = e instanceof AiError ? e.message : 'Something went wrong. Your message is still in the box.';
          showError(session.error);
        }
        session.busy = false;
        send.disabled = false;
        if (location.hash.startsWith('#/chat') && app.chatSession === session) renderLog();
      };
      send.addEventListener('click', submit);
      area.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      });

      root.querySelector('[data-finish]').addEventListener('click', async () => {
        const text = session.messages.filter(m => m.role === 'me').map(m => m.text).join('\n\n');
        if (wordCount(text) < MIN_WORDS) {
          app.toast(`Write at least ${MIN_WORDS} words in total first (you have ${plural(wordCount(text), 'word')}).`);
          return;
        }
        if (!aiReady(aiSettings())) {
          app.toast('Set up the AI in Settings first.', { kind: 'error' });
          return;
        }
        const topic = freeTopic(session.opts.level);
        const writeSession = { topic, topicId: 'free', fromChat: true, opts: session.opts, text, stage: 'edit', result: null, error: '' };
        app.writeSession = writeSession;
        app.go('writing');
        await runCheck(app, writeSession, topic);
        if (writeSession.stage === 'result') {
          store.write.chat = null;
          store.save('write');
          app.chatSession = null;
        }
      });
    },
  };
}
