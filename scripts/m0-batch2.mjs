// Batch 2 probes: merged table, two-column CJK, mixed EN/CH, large Korean
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.MOOCR_SERVER || 'http://127.0.0.1:8091';

const P = {
  document:
    'Extract all information from the main body of the document image and represent it in markdown format, ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should be represented using LATEX format, and the parsing should be organized according to the reading order.',
  text: 'Extract the text in the image.',
  table: 'Parse the table in the image into OTSL.',
};

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function dataUri(file) {
  const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

async function call(img, prompt, maxTokens) {
  const body = {
    model: 'x',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri(img) } },
        ],
      },
    ],
    max_tokens: maxTokens,
    temperature: 0,
    seed: 42,
    stream: false,
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  return {
    wall: (Date.now() - t0) / 1000,
    text: j.choices?.[0]?.message?.content ?? '',
    finish: j.choices?.[0]?.finish_reason,
    inTok: j.timings?.prompt_n,
    outTok: j.timings?.predicted_n,
  };
}

const CASES = [
  ['table-merged', 'fixtures/synth/table-merged.png', P.table, 1024],
  ['zh-two-col', 'fixtures/synth/zh-two-col.png', P.document, 3072],
  ['mix-en-zh', 'fixtures/synth/mix-en-zh.png', P.document, 2048],
  ['ko-large', 'fixtures/synth/ko-large.png', P.text, 768],
];

fs.mkdirSync('docs/batch2', { recursive: true });
for (const [name, img, prompt, max] of CASES) {
  const r = await call(img, prompt, max);
  fs.writeFileSync(`docs/batch2/${name}.txt`, r.text);
  console.log(`--- ${name}  in=${r.inTok} out=${r.outTok} ${r.wall.toFixed(2)}s finish=${r.finish}`);
  console.log(r.text.slice(0, 700));
  console.log();
}
