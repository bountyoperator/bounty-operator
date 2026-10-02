// /mcp: counts, by name only, that an install command was copied.
//
// The copying itself is done by /theme.js for every [data-copy] button. This
// module listens on the install block and reports the one event name through
// /tools/ping.mjs: the request carries no command text and nothing else.

import { ping } from '../tools/ping.mjs';

document.querySelector('.install')?.addEventListener('click', (event) => {
  if (event.target.closest?.('[data-copy]')) ping('mcp_command_copied');
});
