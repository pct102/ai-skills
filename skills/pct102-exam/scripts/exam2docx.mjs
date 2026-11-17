#!/usr/bin/env node
// exam2docx.mjs <exam.json> <outdir>: writes de-thi.docx, dap-an.docx, ma-tran.docx (A4, Times New Roman 13pt).
// Needs the `docx` npm package (`npm install docx` anywhere, then NODE_PATH=<dir>/node_modules). Run examcheck.mjs first.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

let D;
try { D = createRequire(import.meta.url)('docx'); }
catch { console.error('Missing npm package "docx". Run: npm install docx, then set NODE_PATH=<that dir>/node_modules'); process.exit(2); }
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, TabStopType, Tab, TableLayoutType } = D;

const [file, outdir] = process.argv.slice(2);
if (!file || !outdir) { console.error('usage: exam2docx.mjs <exam.json> <outdir>'); process.exit(2); }
const exam = JSON.parse(fs.readFileSync(file, 'utf8'));
const m = exam.meta, TOTAL_W = 9638; // A4 minus 2 cm margins, in DXA
const fmt = (n) => String(Math.round(n * 1000) / 1000).replace('.', ',');
const sum = (a) => a.reduce((s, x) => s + x, 0);

const P = (runs, o = {}) => new Paragraph({ spacing: { after: 100 }, ...o, children: (Array.isArray(runs) ? runs : [runs]).map((r) => (typeof r === 'string' ? new TextRun(r) : r)) });
const B = (t) => new TextRun({ text: t, bold: true });
const title = (t) => P(new TextRun({ text: t, bold: true, size: 30 }), { alignment: AlignmentType.CENTER, spacing: { after: 160 } });
const section = (t) => P(B(t), { spacing: { before: 240, after: 120 }, keepNext: true });
const cell = (t, w, bold) => new TableCell({ width: { size: w, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 100, right: 100 },
  children: [P(bold ? B(String(t)) : String(t), { spacing: { after: 0 } })] });
const table = (widths, rows, header = true) => new Table({ layout: TableLayoutType.FIXED, width: { size: sum(widths), type: WidthType.DXA }, columnWidths: widths,
  rows: rows.map((r, i) => new TableRow({ tableHeader: header && i === 0, cantSplit: true, children: r.map((c, k) => cell(c, widths[k], header && i === 0)) })) });
const doc = (children) => new Document({
  styles: { default: { document: { run: { font: 'Times New Roman', size: 26 } } } },
  sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
});

const TITLES = { mcq: 'PHẦN I. TRẮC NGHIỆM', short: 'PHẦN II. TRẢ LỜI NGẮN', essay: 'PHẦN III. TỰ LUẬN / THỰC HÀNH' };
const groups = ['mcq', 'short', 'essay'].map((t) => [t, exam.items.filter((i) => i.type === t)]).filter(([, a]) => a.length);
let n = 0; for (const [, arr] of groups) for (const i of arr) i.no = ++n;

function paper() {
  const c = [title(m.title),
    P(`Môn: ${m.subject}    Lớp: ${m.grade}    Thời gian: ${m.duration_min} phút    Tổng điểm: ${fmt(m.total_points)}`, { alignment: AlignmentType.CENTER }),
    P('Họ và tên: .....................................................    Lớp: ..........', { spacing: { before: 120, after: 200 } })];
  for (const [t, arr] of groups) {
    c.push(section(`${TITLES[t]} (${fmt(sum(arr.map((i) => i.points)))} điểm)`));
    for (const i of arr) {
      c.push(P([B(`Câu ${i.no}. `), `(${fmt(i.points)} điểm) ${i.stem}`], { keepNext: i.type === 'mcq' }));
      if (i.type === 'mcq') {
        const L = i.options.map((o, k) => `${'ABCDEFGH'[k]}. ${o}`);
        if (L.every((x) => x.length <= 18)) // short options: one row
          c.push(P(new TextRun({ children: L.flatMap((x, k) => (k ? [new Tab(), x] : [x])) }), { indent: { left: 360 }, tabStops: [1, 2, 3].map((k) => ({ type: TabStopType.LEFT, position: 360 + k * 2100 })) }));
        else L.forEach((x) => c.push(P(x, { indent: { left: 360 }, spacing: { after: 40 } })));
      } else if (i.type === 'short') c.push(P('Trả lời: ................................................................................'));
      else for (let k = 0; k < 6; k++) c.push(P('', { spacing: { after: 220 } })); // answer space
    }
  }
  return doc(c);
}

function key() {
  const c = [title(`Đáp án và hướng dẫn chấm: ${m.title}`)];
  const mc = exam.items.filter((i) => i.type === 'mcq');
  if (mc.length) {
    c.push(section('Trắc nghiệm'));
    c.push(table([900, 1300, TOTAL_W - 2200], [['Câu', 'Đáp án', 'Lời giải'], ...mc.map((i) => [i.no, i.answer, i.explanation || ''])]));
  }
  for (const i of exam.items.filter((x) => x.type !== 'mcq')) {
    c.push(section(`Câu ${i.no} (${fmt(i.points)} điểm)`), P(i.answer_text));
    if (i.rubric?.length) c.push(table([TOTAL_W - 1500, 1500], [['Tiêu chí', 'Điểm'], ...i.rubric.map((r) => [r.criterion, fmt(r.points)])]));
  }
  return doc(c);
}

function matrix() {
  const { levels, matrix: mx } = exam;
  const topics = [...new Set(mx.map((r) => r.topic))];
  const cellOf = (t, lv) => { const r = mx.find((x) => x.topic === t && x.level === lv); return r ? `${r.items} câu (${fmt(r.points)}đ)` : ''; };
  const lvRows = (l) => mx.filter((r) => r.level === l);
  const first = 2000, last = 1500, mid = Math.floor((TOTAL_W - first - last) / levels.length);
  const widths = [first, ...levels.map(() => mid), TOTAL_W - first - mid * levels.length];
  const rows = [['Chủ đề', ...levels, 'Tổng'],
    ...topics.map((t) => { const r = mx.filter((x) => x.topic === t); return [t, ...levels.map((l) => cellOf(t, l)), `${sum(r.map((x) => x.items))} câu (${fmt(sum(r.map((x) => x.points)))}đ)`]; }),
    ['Tổng', ...levels.map((l) => `${sum(lvRows(l).map((r) => r.items))} câu (${fmt(sum(lvRows(l).map((r) => r.points)))}đ)`), `${sum(mx.map((r) => r.items))} câu (${fmt(m.total_points)}đ)`],
    ['Tỉ lệ', ...levels.map((l) => `${Math.round((sum(lvRows(l).map((r) => r.points)) / m.total_points) * 100)}%`), '100%']];
  return doc([title(`Ma trận đề: ${m.title}`), table(widths, rows)]);
}

fs.mkdirSync(outdir, { recursive: true });
for (const [name, d] of [['de-thi', paper()], ['dap-an', key()], ['ma-tran', matrix()]]) {
  const f = path.join(outdir, `${name}.docx`);
  fs.writeFileSync(f, await Packer.toBuffer(d)); console.log('wrote', f);
}
