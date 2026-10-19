/**
 * Loads every STscript command module and Quick Replies (they register themselves), once the app
 * starts.
 */

import './commands/characters.ts';
import './commands/chat.ts';
import './commands/generation.ts';
import './commands/quickreplies.ts';
import './commands/settings.ts';
import './commands/worldinfo.ts';
import '../quickreplies/store.svelte.ts';
