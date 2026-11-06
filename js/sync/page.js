/**
 * Page entry for syncing: starts the engine on the real browser objects.
 *
 * Responsibility: be the only sync file that touches window, localStorage and sessionStorage. It builds the
 * API client, hands everything to startSync and swallows every error, so a problem in sync (storage blocked,
 * server odd, bug) can never stop the page it is loaded on.
 * Where it fits: loaded as a non-blocking `<script type="module">` by index.html after the app's own script; it uses js/sync/engine.js and js/sync/client.js.
 * Invariant: this module never throws and never rejects; failures are reported with console.warn only.
 */
import { startSync } from './engine.js';
import { createClient } from './client.js';

/**
 * Starts syncing for this page. Errors are logged as a warning and otherwise ignored.
 *
 * @returns {Promise<void>} Always resolves.
 */
async function boot() {
  try {
    await startSync({
      storage: localStorage,
      client: createClient(),
      win: window,
      session: sessionStorage,
    });
  } catch (error) {
    // Reading localStorage can throw when the browser blocks storage; the app then runs without sync.
    console.warn('Saving to the data file is unavailable on this page:', error);
  }
}

boot();
