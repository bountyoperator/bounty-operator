#!/usr/bin/env node
// Re-edit Spec's existing Higgsfield animation with the confirmed-Critical example.
// node scripts/render-spec-film.mjs /path/to/film-inputs
// Inputs: spec-source.mp4, narration.mp3, review-capture.png.
// No generation, upload or publishing happens here. The output stays in the input directory.
import { execFileSync, execSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2]) throw new Error('Pass the directory containing the film inputs.');
const directory = path.resolve(process.argv[2]);
const output = path.join(directory, 'spec-strongest-case.mp4');
const poster = path.join(directory, 'spec-strongest-case-poster.png');
const SIZE = 1080;
const DURATION = 18;
const FPS = 30;
const INK = '#18232d';
const font = pathToFileURL(path.join(ROOT, 'web/public/fonts/archivo-latin-wdth.woff2')).href;
const review = `data:image/png;base64,${(await readFile(path.join(directory, 'review-capture.png'))).toString('base64')}`;
const source = await readFile(path.join(ROOT, 'web/public/examples/confirmed-critical/src/HalyardTreasury.sol'), 'utf8');
const sourceLine = source.split(/\r?\n/)[78].trim();
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Measured from Higgsfield narration ed3770b5-cb5e-42da-9ed7-725040b8fedd,
// including the film's 300ms opening offset; verified with offline transcription.
const CUES = [
  [0.300, 2.680, 'Make your strongest case\nbefore you submit.'],
  [3.100, 7.680, 'Bounty Operator checks your report against\nthe code and proof, with citations.'],
  [7.980, 11.620, 'In this invented example,\nthe evidence supports Critical.'],
  [12.080, 15.640, 'Try the public example at\nbountyoperator.com.'],
];
const stamp = (seconds, separator = '.') => `00:00:${seconds.toFixed(3).padStart(6, '0').replace('.', separator)}`;

const CSS = `
@font-face { font-family: Archivo; src: url('${font}') format('woff2'); font-weight: 100 900; font-stretch: 62% 125%; }
* { box-sizing: border-box; }
html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; }
body { color: #f6e7cc; font-family: Archivo, sans-serif; }
.stage { position: relative; width: ${SIZE}px; height: ${SIZE}px; overflow: hidden; }
.solid { background: ${INK}; }
h1, p { margin: 0; }
h1 { font-weight: 820; font-stretch: 96%; letter-spacing: -2.5px; }
.wordmark { position: absolute; top: 35px; left: 64px; font-size: 23px; line-height: 32px; font-weight: 700; letter-spacing: 2px; }
.opening h1 { position: absolute; top: 92px; left: 64px; width: 952px; text-align: center; font-size: 92px; line-height: 98px; }
.opening .sub { position: absolute; top: 311px; left: 64px; width: 952px; text-align: center; font-size: 36px; line-height: 44px; }
.review h1 { position: absolute; top: 113px; left: 64px; width: 952px; font-size: 83px; line-height: 89px; }
.review .sub { position: absolute; top: 318px; left: 64px; font-size: 38px; line-height: 48px; }
.review img { position: absolute; top: 420px; left: 58px; width: 964px; height: auto; }
.review .resolved { position: absolute; top: 730px; left: 64px; width: 952px; font-size: 39px; line-height: 50px; color: #a8dac2; }
.disclosure { position: absolute; left: 64px; width: 952px; font-size: 28px; line-height: 50px; color: #c3beb4; }
.disclosure strong { font-size: 40px; font-weight: 700; color: #f6e7cc; }
.review .disclosure { top: 798px; }
.caption { position: absolute; left: 64px; top: 864px; width: 952px; font-size: 36px; line-height: 44px; font-weight: 500; }
.proof h1 { position: absolute; top: 116px; left: 64px; width: 952px; font-size: 90px; line-height: 94px; }
.proof h1 strong { color: #fb91a1; font-weight: inherit; }
.proof .sub { position: absolute; top: 342px; left: 64px; width: 952px; font-size: 42px; line-height: 50px; }
.code { position: absolute; top: 455px; left: 64px; width: 952px; padding: 30px 28px 36px; border: 1px solid #65717a; border-radius: 10px; }
.filename { margin-bottom: 31px; color: #c3beb4; font-size: 27px; line-height: 34px; }
.code-line { display: flex; gap: 28px; align-items: baseline; white-space: nowrap; }
.line-number { font-family: Consolas, monospace; color: #a8b0b7; font-size: 29px; }
code { font-family: Consolas, monospace; font-size: 34px; line-height: 46px; color: #f6e7cc; }
.proof .required { position: absolute; top: 710px; left: 64px; width: 952px; font-size: 40px; line-height: 50px; }
.proof .disclosure { top: 798px; }
.closing h1 { position: absolute; top: 120px; left: 64px; width: 952px; text-align: center; font-size: 80px; line-height: 89px; }
.url { position: absolute; top: 330px; left: 64px; width: 952px; color: #f6e7cc; font-size: 66px; line-height: 82px; font-weight: 780; text-align: center; letter-spacing: -1px; }
.closing .disclosure { top: 995px; text-align: center; }
`;
const brand = '<p class="wordmark" data-fit>BOUNTY OPERATOR</p>';
const disclosure = '<p class="disclosure" data-fit>HALYARD EXAMPLE · <strong>Invented protocol</strong></p>';
const scenes = {
  opening: `${brand}<h1 data-fit>Make your<br>strongest case.</h1><p class="sub" data-fit>Before you submit.</p>`,
  review: `${brand}<h1 data-fit>Code. Proof.<br>Citations.</h1><p class="sub" data-fit>Back every claim.</p><img src="${review}" alt="Actual saved review: Submit, one Critical finding"><p class="resolved" data-fit>All 27 cited locations resolve.</p>${disclosure}<p class="caption" data-fit>Bounty Operator checks your report against<br>the code and proof, with citations.</p>`,
  proof: `${brand}<h1 data-fit><strong>Critical,</strong><br>supported.</h1><p class="sub" data-fit>One valid owner signature.<br>Counted three times.</p><div class="code"><p class="filename" data-fit>HalyardTreasury.sol</p><div class="code-line" data-fit><span class="line-number">79</span><code>${escape(sourceLine)}</code></div></div><p class="required" data-fit>3-of-5 threshold bypassed.</p>${disclosure}<p class="caption" data-fit>In this invented example,<br>the evidence supports Critical.</p>`,
  closing: `${brand}<h1 data-fit>Try the public<br>example at</h1><p class="url" data-fit>bountyoperator.com</p><p class="disclosure" data-fit>EXPLORE THE SAVED REVIEW · NO LOGIN REQUIRED</p>`,
};

const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
const { chromium } = createRequire(`${globalRoot}${path.sep}`)('playwright');
const work = await mkdtemp(path.join(os.tmpdir(), 'bo-spec-film-'));
try {
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--mute-audio'] });
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    for (const [name, content] of Object.entries(scenes)) {
      const html = path.join(work, `${name}.html`);
      const solid = name === 'review' || name === 'proof';
      await writeFile(html, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Spec film: ${name}</title><style>${CSS}</style><main class="stage ${name}${solid ? ' solid' : ''}">${content}</main></html>`);
      await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const failures = await page.evaluate(() => {
        const problems = [];
        if (![...document.fonts].some((font) => font.family === 'Archivo' && font.status === 'loaded')) problems.push('Archivo did not load');
        for (const element of document.querySelectorAll('[data-fit]')) {
          const rect = element.getBoundingClientRect();
          if (rect.left < 0 || rect.top < 0 || rect.right > 1080 || rect.bottom > 1080 || element.scrollWidth > element.clientWidth + 1) problems.push(element.textContent);
        }
        if ([...document.images].some((image) => !image.complete || !image.naturalWidth)) problems.push('An image did not load');
        return problems;
      });
      if (failures.length) throw new Error(`${name}: ${failures.join('; ')}`);
      await page.screenshot({ path: path.join(work, `${name}.png`), omitBackground: true });
    }
  } finally {
    await browser.close();
  }

  const filter = [
    '[0:v]split=2[specIn][specOut]',
    '[specIn]trim=start=0:end=3.2,setpts=PTS-STARTPTS,scale=820:820,crop=820:630:0:90,fps=30,setsar=1[openSpec]',
    'color=c=0x18232d:s=1080x1080:r=30:d=3.2[openBg]',
    '[openBg][openSpec]overlay=x=130:y=374:shortest=1[openVideo]',
    '[openVideo][1:v]overlay=shortest=1,format=yuv420p,settb=1/30[opening]',
    '[2:v]trim=duration=5.2,setpts=PTS-STARTPTS,fps=30,format=yuv420p,settb=1/30[review]',
    '[3:v]trim=duration=4.2,setpts=PTS-STARTPTS,fps=30,format=yuv420p,settb=1/30[proof]',
    '[specOut]trim=start=3,setpts=PTS-STARTPTS,scale=500:500,fps=30,tpad=stop_mode=clone:stop_duration=6,trim=duration=6,setsar=1[closeSpec]',
    'color=c=0x18232d:s=1080x1080:r=30:d=6[closeBg]',
    '[closeBg][closeSpec]overlay=x=290:y=446:shortest=1[closeVideo]',
    '[closeVideo][4:v]overlay=shortest=1,format=yuv420p,settb=1/30[closing]',
    '[opening][review]xfade=transition=fade:duration=0.2:offset=3[first]',
    '[first][proof]xfade=transition=fade:duration=0.2:offset=8[second]',
    '[second][closing]xfade=transition=fade:duration=0.2:offset=12[video]',
    '[5:a]loudnorm=I=-16:TP=-2:LRA=9,adelay=300:all=1,apad=whole_dur=18,atrim=duration=18[audio]',
  ].join(';');
  const args = ['-hide_banner', '-loglevel', 'warning', '-filter_complex_threads', '2', '-y', '-i', path.join(directory, 'spec-source.mp4')];
  for (const name of Object.keys(scenes)) args.push('-loop', '1', '-framerate', String(FPS), '-i', path.join(work, `${name}.png`));
  args.push('-i', path.join(directory, 'narration.mp3'), '-filter_complex', filter,
    '-map', '[video]', '-map', '[audio]', '-t', String(DURATION),
    '-c:v', 'libx264', '-preset', 'medium', '-threads', '4', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart',
    '-metadata', 'title=Bounty Operator — Make your strongest case',
    '-metadata', 'comment=Higgsfield Spec animation and Cillian narration. Halyard Treasury is an invented protocol.', output);
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '9', '-i', output, '-frames:v', '1', poster], { stdio: 'inherit' });
  await writeFile(path.join(directory, 'spec-strongest-case.vtt'),
    `WEBVTT\n\n${CUES.map(([start, end, text]) => `${stamp(start)} --> ${stamp(end)}\n${text}\n`).join('\n')}`);
  await writeFile(path.join(directory, 'spec-strongest-case.srt'),
    CUES.map(([start, end, text], index) => `${index + 1}\n${stamp(start, ',')} --> ${stamp(end, ',')}\n${text}\n`).join('\n'));
  console.log(`Rendered ${output} (${DURATION}s, ${SIZE}×${SIZE}, ${FPS}fps)`);
  console.log(`Poster ${poster}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
