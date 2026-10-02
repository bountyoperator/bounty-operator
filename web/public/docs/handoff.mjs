// Sends a worked example from a docs page into the workbench.
//
// The contract with the workbench: write sessionStorage["bo:handoff"] as JSON
// { files: [{ name, content }], profile, focus, context } and go to /#workspace.
//
// A control opts in with data-handoff="<example id>". It is an ordinary link to
// the workbench, so it still works when this script or session storage is not
// available: the workbench opens with the profile selected and no files.
//
// File contents are read from code blocks already on the page. Nothing is
// fetched and nothing leaves the browser.

const STORAGE_KEY = 'bo:handoff';
const WORKBENCH = '/#workspace';

/** The text of the code block inside the element with this id. */
function codeText(id) {
  const block = document.querySelector(`#${id} pre`);
  if (!block) return '';
  // Each rendered line ends with a line feed; the last one is not part of the source.
  return block.textContent.replace(/\n$/, '');
}

const EXAMPLES = {
  'guide-example': () => ({
    files: [
      { name: 'src/HarborVault.sol', content: codeText('guide-contract') },
      { name: 'draft-report.md', content: codeText('guide-draft') },
    ],
    profile: 'report',
    focus:
      'Check every claim in draft-report.md against src/HarborVault.sol. List the claims the code does not support and the evidence each one still needs.',
    context: {
      target: 'HarborVault, the report guide example',
      scope: 'src/HarborVault.sol',
      version: '',
      proof: 'none',
      prior: 'unchecked',
      notes: 'Invented contract and first draft from bountyoperator.com/guide.',
    },
  }),
};

function onClick(event) {
  // A modified click opens a new tab, which does not share this tab's session storage.
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const trigger = event.target instanceof Element ? event.target.closest('[data-handoff]') : null;
  if (!trigger) return;
  const build = EXAMPLES[trigger.getAttribute('data-handoff')];
  if (!build) return;

  const payload = build();
  if (payload.files.some((file) => !file.content)) return;

  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage is blocked. Follow the plain link instead.
    return;
  }
  event.preventDefault();
  window.location.assign(WORKBENCH);
}

document.addEventListener('click', onClick);
