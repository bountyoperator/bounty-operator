// The moving field behind a page head: lines of a draft report and of the code
// it cites, set small. Lights drift over them, and now and then the red pen
// strikes a line. Built here, one per .page-field, so a page without script
// simply shows the black page.
//
// Nothing is drawn per frame. The text is drawn once to a canvas. The lights
// are holes in a shade that lies over the text: a small picture, drawn once,
// stretched, and moved by a CSS animation of its transform, which the browser
// runs off the main thread. A pen strike is one short element animated the
// same way. Scrolling and typing never wait on this file.

const LINES = [
  '## Summary',
  'stake() skips settlement, so a fresh staker claims the reward reserve',
  'Severity: Critical',
  'function stake(uint256 amount) external {',
  '    if (amount == 0) revert ZeroAmount();',
  '    _updateGlobal();',
  '    balanceOf[msg.sender] += amount;',
  'input-1/src/TesseraStaking.sol:87-94',
  '## Proof of concept',
  'forge test --match-test test_reserveDrain -vv',
  'assertGt(stolen, 0);',
  'C3 | overstated | rewards are capped at rewardReserve',
  '## Impact',
  'Theft of unclaimed yield',
  'N-1: exit() reverts when the reserve is short (known issue)',
  'earned = balance * (rewardPerToken() - paidPerToken[account])',
  '1. Stake 1,166,666 TSR in the block the reward lands',
  '2. Call claim()',
  '3. Withdraw: principal is untouched',
  'C4 | contradicted | input-1/src/TesseraStaking.sol:115',
  'Impact in scope: Medium, theft of unclaimed rewards',
  'Verdict: rewrite-then-submit',
  'function claim() external nonReentrant {',
  '    if (reward > rewardReserve) revert ReserveShort();',
  'Already reported? docs/known-issues.md:13',
  'vm.prank(attacker); staking.stake(1_166_666e18);',
  '## Recommended fix',
  'Call _settle(msg.sender) before the balance changes',
];

const CELL = 19; // row height in CSS px
const FONT = '11px ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';
const INK = 'rgba(244, 241, 234, 0.38)'; // the text under a light
const SHADE = 'rgba(9, 9, 10, 0.87)'; // the page's black, over the text at rest
const SHADE_WIDTH = 320; // the shade is a small picture, stretched: it is all soft edges
const STRIKE_MS = 5200;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

// A small seeded generator: the same lights for the same size of field.
function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function field(host) {
  const root = document.createElement('div');
  root.className = 'field';
  root.setAttribute('aria-hidden', 'true');
  const text = document.createElement('canvas');
  text.className = 'field__text';
  const shade = document.createElement('canvas');
  shade.className = 'field__shade';
  const fade = document.createElement('div');
  fade.className = 'field__fade';
  root.append(text, shade, fade);
  host.prepend(root);

  let width = 0;
  let height = 0;
  let rows = [];
  let running = false;
  let onScreen = false;
  let timer = 0;

  function drawText() {
    // Sharp on a dense screen, within a fixed budget of pixels.
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4.5e6 / (width * height)));
    text.width = Math.round(width * ratio);
    text.height = Math.round(height * ratio);
    const ctx = text.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.font = FONT;
    ctx.fillStyle = INK;
    ctx.textBaseline = 'alphabetic';
    // Each row is one line of the pool, repeated to the right edge and started
    // at its own offset, so that no two rows line up.
    rows = [];
    const count = Math.ceil(height / CELL);
    for (let row = 0; row < count; row += 1) {
      const line = LINES[(row * 11 + 3) % LINES.length];
      const gap = 88;
      const step = ctx.measureText(line).width + gap;
      const start = -((row * 137) % Math.max(1, Math.round(step)));
      const y = row * CELL + 14;
      const runs = [];
      for (let x = start; x < width; x += step) {
        ctx.fillText(line, x, y);
        runs.push([x, x + step - gap]);
      }
      rows.push({ y, runs });
    }
  }

  function drawShade() {
    // The shade covers twice the field each way, so it can drift without
    // showing an edge. Its picture keeps the field's proportions, so a light
    // stays round when the picture is stretched.
    const scale = SHADE_WIDTH / (2 * width);
    shade.width = SHADE_WIDTH;
    shade.height = Math.max(1, Math.round(2 * height * scale));
    const ctx = shade.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = SHADE;
    ctx.fillRect(0, 0, shade.width, shade.height);
    // The lights: holes cut out of the shade, on a loose grid.
    ctx.globalCompositeOperation = 'destination-out';
    const radius = Math.max(150, Math.min(340, width * 0.21));
    const pitch = radius * 2.7;
    const random = seeded(Math.round(width) * 31 + Math.round(height));
    for (let y = pitch * 0.35; y < 2 * height + pitch * 0.5; y += pitch) {
      for (let x = pitch * 0.35; x < 2 * width + pitch * 0.5; x += pitch) {
        const skip = random() < 0.22;
        const cx = (x + (random() - 0.5) * pitch * 0.7) * scale;
        const cy = (y + (random() - 0.5) * pitch * 0.7) * scale;
        const r = radius * (0.8 + random() * 0.5) * scale;
        if (skip) continue;
        const light = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        light.addColorStop(0, 'rgba(0, 0, 0, 1)');
        light.addColorStop(0.45, 'rgba(0, 0, 0, 0.55)');
        light.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = light;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
    }
  }

  /** A line of the field for the pen: its left end, its length and its height on the field. */
  function pick(random = Math.random) {
    const row = rows[Math.floor(random() * rows.length)];
    if (!row || !row.runs.length) return null;
    const [from, to] = row.runs[Math.floor(random() * row.runs.length)];
    // Side by side, the words of the head are on the left: the pen keeps to the
    // right of them, or to the top and foot of the field.
    const clear = width < 960 || row.y < height * 0.14 || row.y > height * 0.84;
    const start = Math.max(clear ? 8 : width * 0.47, from);
    const end = Math.min(width - 8, to);
    if (end - start < 60) return null;
    return { left: start, top: row.y - 4.5, length: end - start };
  }

  function line(place) {
    const stroke = document.createElement('i');
    stroke.className = 'field__strike';
    stroke.style.left = `${place.left}px`;
    stroke.style.top = `${place.top}px`;
    stroke.style.width = `${place.length}px`;
    root.insertBefore(stroke, fade);
    return stroke;
  }

  // The pen: a stroke drawn left to right, held, then let go.
  function strike() {
    const place = pick();
    if (!place) return;
    const stroke = line(place);
    const tilt = `rotate(${((Math.random() - 0.5) * 3 / place.length) * 57.3}deg)`;
    const drawn = stroke.animate(
      [
        { transform: `${tilt} scaleX(0)`, opacity: 0.85, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        { transform: `${tilt} scaleX(1)`, opacity: 0.85, offset: 0.08 },
        { transform: `${tilt} scaleX(1)`, opacity: 0.85, offset: 0.7 },
        { transform: `${tilt} scaleX(1)`, opacity: 0 },
      ],
      { duration: STRIKE_MS, fill: 'forwards' },
    );
    drawn.onfinish = () => stroke.remove();
    drawn.oncancel = () => stroke.remove();
  }

  function clearStrikes() {
    for (const stroke of root.querySelectorAll('.field__strike')) stroke.remove();
  }

  function still() {
    // For a visitor who asked for less motion: the lights where they start,
    // two lines already struck.
    clearStrikes();
    const random = seeded(7);
    for (let tries = 0, made = 0; tries < 24 && made < 2; tries += 1) {
      const place = pick(random);
      if (place) {
        line(place);
        made += 1;
      }
    }
  }

  function loop() {
    if (!running) return;
    strike();
    timer = window.setTimeout(loop, 900 + Math.random() * 1700);
  }

  function sync() {
    const want = onScreen && !document.hidden && !reduced.matches;
    root.toggleAttribute('data-paused', !want);
    if (want && !running) {
      running = true;
      clearStrikes();
      timer = window.setTimeout(loop, 600);
    } else if (!want && running) {
      running = false;
      window.clearTimeout(timer);
    }
    if (reduced.matches) still();
  }

  function layout() {
    // The field spans the window, wherever the head sits in it.
    const box = host.getBoundingClientRect();
    const nextWidth = Math.max(1, document.documentElement.clientWidth);
    const nextHeight = Math.max(1, Math.round(box.height));
    root.style.left = `${-box.left}px`;
    root.style.width = `${nextWidth}px`;
    if (nextWidth === width && nextHeight === height) return;
    width = nextWidth;
    height = nextHeight;
    clearStrikes();
    drawText();
    drawShade();
    if (reduced.matches) still();
  }

  let pending = 0;
  const relayout = () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(layout, 150);
  };
  new ResizeObserver(relayout).observe(host);
  window.addEventListener('resize', relayout);
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    sync();
  }).observe(host);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);

  layout();
  root.dataset.ready = '';
}

for (const host of document.querySelectorAll('.page-field')) field(host);
