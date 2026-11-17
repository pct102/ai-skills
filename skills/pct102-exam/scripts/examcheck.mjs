#!/usr/bin/env node
// examcheck.mjs: the exam's acceptance gate. No dependencies, Node 18+.
//   node examcheck.mjs check  <exam.json> [--json]       exit 1 on any FAIL, 0 otherwise (WARN does not fail)
//   node examcheck.mjs render <exam.json> <outdir> [--force]   writes de-thi.md, dap-an.md, ma-tran.md (refuses on FAIL)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EPS = 1e-6;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const fmt = (n) => String(Math.round(n * 1000) / 1000).replace('.', ','); // Vietnamese decimal comma
const TYPES = ['mcq', 'short', 'essay'];

export function check(exam) {
  const meta = exam.meta || {}, items = exam.items || [], levels = exam.levels || [], matrix = exam.matrix || [];
  const nOpt = meta.options || 4;
  const tol = exam.tolerance ?? 0.1;               // allowed gap between a level's share of points and its target
  const lenMax = exam.option_length_ratio ?? 1.6;  // longest option / shortest option, per question
  const posTol = exam.answer_position_tolerance ?? 0.15;
  const letters = 'ABCDEFGH'.slice(0, nOpt).split('');
  const total = meta.total_points;
  const mcq = items.filter((i) => i.type === 'mcq');

  const checks = [
    ['cấu trúc', () => {
      const p = []; const seen = new Set();
      if (!(total > 0)) p.push('meta.total_points phải là số dương');
      if (!levels.length) p.push('thiếu danh sách levels');
      for (const i of items) {
        if (!i.id || seen.has(i.id)) p.push(`id trống hoặc trùng: ${i.id}`); seen.add(i.id);
        if (!TYPES.includes(i.type)) p.push(`${i.id}: type phải là ${TYPES.join('|')}`);
        if (!levels.includes(i.level)) p.push(`${i.id}: level "${i.level}" không có trong levels`);
        if (!i.topic) p.push(`${i.id}: thiếu topic`);
        if (!(i.points > 0)) p.push(`${i.id}: points phải > 0`);
        if (!norm(i.stem)) p.push(`${i.id}: thiếu đề (stem)`);
      }
      return p.map((m) => ['FAIL', m]);
    }],
    ['tổng điểm', () => {
      const s = sum(items.map((i) => i.points || 0));
      return Math.abs(s - total) > EPS ? [['FAIL', `tổng điểm các câu = ${fmt(s)}, đề khai báo ${fmt(total)}`]] : [];
    }],
    ['khớp ma trận', () => {
      const p = []; const act = new Map();
      for (const i of items) {
        const k = `${i.topic}|${i.level}`; const a = act.get(k) || { n: 0, pts: 0 };
        a.n++; a.pts += i.points || 0; act.set(k, a);
      }
      for (const r of matrix) {
        const a = act.get(`${r.topic}|${r.level}`) || { n: 0, pts: 0 };
        if (a.n !== r.items || Math.abs(a.pts - r.points) > EPS)
          p.push(`${r.topic} / ${r.level}: ma trận ${r.items} câu ${fmt(r.points)}đ, thực tế ${a.n} câu ${fmt(a.pts)}đ`);
        act.delete(`${r.topic}|${r.level}`);
      }
      for (const k of act.keys()) p.push(`câu hỏi nằm ngoài ma trận: ${k.replace('|', ' / ')}`);
      if (Math.abs(sum(matrix.map((r) => r.points)) - total) > EPS) p.push('tổng điểm ma trận khác tổng điểm đề');
      return p.map((m) => ['FAIL', m]);
    }],
    ['tỉ lệ mức độ', () => {
      const t = exam.targets; if (!t) return [['WARN', 'chưa khai báo targets, bỏ qua kiểm tra tỉ lệ']];
      const p = [];
      if (Math.abs(sum(Object.values(t)) - 1) > 0.01) p.push(['WARN', 'targets không cộng đủ 100%']);
      for (const lv of levels) {
        const share = sum(items.filter((i) => i.level === lv).map((i) => i.points)) / total;
        if (Math.abs(share - (t[lv] ?? 0)) > tol)
          p.push(['FAIL', `${lv}: ${Math.round(share * 100)}% điểm, mục tiêu ${Math.round((t[lv] ?? 0) * 100)}% (±${Math.round(tol * 100)}%)`]);
      }
      return p;
    }],
    ['trắc nghiệm', () => {
      const p = [];
      for (const i of mcq) {
        const o = i.options || [];
        if (o.length !== nOpt) p.push(['FAIL', `${i.id}: cần đúng ${nOpt} phương án, có ${o.length}`]);
        if (new Set(o.map(norm)).size !== o.length) p.push(['FAIL', `${i.id}: có hai phương án giống nhau`]);
        if (!letters.includes(i.answer)) p.push(['FAIL', `${i.id}: answer phải là ${letters.join('/')}`]);
        if (!norm(i.explanation)) p.push(['WARN', `${i.id}: thiếu lời giải (explanation)`]);
      }
      return p;
    }],
    ['tự luận / rubric', () => {
      const p = [];
      for (const i of items.filter((x) => x.type !== 'mcq')) {
        if (!norm(i.answer_text)) p.push(['FAIL', `${i.id}: thiếu đáp án mẫu (answer_text)`]);
        const r = i.rubric || [];
        if (i.type === 'essay' && !r.length) p.push(['FAIL', `${i.id}: tự luận cần rubric`]);
        if (r.length && Math.abs(sum(r.map((c) => c.points)) - i.points) > EPS)
          p.push(['FAIL', `${i.id}: rubric cộng ${fmt(sum(r.map((c) => c.points)))}đ, câu ${fmt(i.points)}đ`]);
      }
      return p;
    }],
    ['phân bố đáp án', () => {
      if (mcq.length < 8) return [['WARN', `chỉ ${mcq.length} câu trắc nghiệm, bỏ qua phân bố đáp án (cần >= 8)`]];
      const p = []; const cnt = Object.fromEntries(letters.map((l) => [l, 0]));
      for (const i of mcq) cnt[i.answer]++;
      for (const l of letters) if (cnt[l] / mcq.length > 1 / nOpt + posTol)
        p.push(['FAIL', `đáp án ${l} chiếm ${Math.round((cnt[l] / mcq.length) * 100)}% (${cnt[l]}/${mcq.length})`]);
      let run = 1;
      for (let k = 1; k < mcq.length; k++) {
        run = mcq[k].answer === mcq[k - 1].answer ? run + 1 : 1;
        if (run === 4) p.push(['FAIL', `4 câu liên tiếp cùng đáp án ${mcq[k].answer} (kết thúc ở ${mcq[k].id})`]);
      }
      return p;
    }],
    ['độ dài đáp án', () => {
      const p = []; let long = 0, strict = 0;
      for (const i of mcq) {
        const L = (i.options || []).map((o) => String(o).trim().length); if (!L.length) continue;
        const mx = Math.max(...L), mn = Math.min(...L);
        if (mx < 20) continue; // short answers (numbers, formulas) carry no length clue
        long++;
        if (mx / Math.max(mn, 1) > lenMax) p.push(['FAIL', `${i.id}: phương án dài/ngắn = ${(mx / Math.max(mn, 1)).toFixed(1)} (tối đa ${lenMax})`]);
        const k = letters.indexOf(i.answer);
        if (L[k] === mx && L.filter((x) => x === mx).length === 1) strict++;
      }
      if (long >= 5 && strict / long > 0.4)
        p.push(['FAIL', `đáp án đúng là phương án dài nhất ở ${strict}/${long} câu: lộ đáp án`]);
      return p;
    }],
    ['trùng câu hỏi', () => {
      const seen = new Map(), p = [];
      for (const i of items) { const k = norm(i.stem); if (seen.has(k)) p.push(['FAIL', `${i.id} trùng đề với ${seen.get(k)}`]); else seen.set(k, i.id); }
      return p;
    }],
  ];

  const results = [];
  for (const [name, fn] of checks) {
    const p = fn().map((x) => (Array.isArray(x) ? x : ['FAIL', x]));
    if (!p.length) results.push({ name, sev: 'PASS', msg: '' });
    for (const [sev, msg] of p) results.push({ name, sev, msg });
  }
  return results;
}

// ---- render: Markdown that the docx / pdf skills turn into files ----
const byType = (exam) => TYPES.map((t) => [t, exam.items.filter((i) => i.type === t)]).filter(([, a]) => a.length);
const TITLES = { mcq: 'PHẦN I. TRẮC NGHIỆM', short: 'PHẦN II. TRẢ LỜI NGẮN', essay: 'PHẦN III. TỰ LUẬN' };

export function renderExam(exam) {
  const m = exam.meta; let n = 0;
  const L = [`# ${m.title}`, '', `**Môn:** ${m.subject}  **Lớp:** ${m.grade}  **Thời gian:** ${m.duration_min} phút  **Tổng điểm:** ${fmt(m.total_points)}`, '', 'Họ và tên: ................................  Lớp: ........', ''];
  for (const [t, arr] of byType(exam)) {
    L.push(`## ${TITLES[t]} (${fmt(sum(arr.map((i) => i.points)))} điểm)`, '');
    for (const i of arr) {
      n++; i.no = n;
      L.push(`**Câu ${n}.** (${fmt(i.points)} điểm) ${i.stem}`, '');
      if (t === 'mcq') (i.options).forEach((o, k) => L.push(`${'ABCDEFGH'[k]}. ${o}`, ''));
    }
  }
  return L.join('\n');
}

export function renderKey(exam) {
  const m = exam.meta; renderExam(exam); // assigns i.no
  const L = [`# Đáp án và hướng dẫn chấm: ${m.title}`, ''];
  const mc = exam.items.filter((i) => i.type === 'mcq');
  if (mc.length) {
    L.push('## Trắc nghiệm', '', '| Câu | Đáp án | Lời giải |', '| --- | --- | --- |');
    for (const i of mc) L.push(`| ${i.no} | ${i.answer} | ${String(i.explanation || '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
    L.push('');
  }
  for (const i of exam.items.filter((x) => x.type !== 'mcq')) {
    L.push(`## Câu ${i.no} (${fmt(i.points)} điểm)`, '', i.answer_text, '');
    if (i.rubric?.length) {
      L.push('| Tiêu chí | Điểm |', '| --- | --- |');
      for (const c of i.rubric) L.push(`| ${c.criterion} | ${fmt(c.points)} |`);
      L.push('');
    }
  }
  return L.join('\n');
}

export function renderMatrix(exam) {
  const { levels, matrix, meta } = exam;
  const topics = [...new Set(matrix.map((r) => r.topic))];
  const cell = (t, lv) => { const r = matrix.find((x) => x.topic === t && x.level === lv); return r ? `${r.items} câu (${fmt(r.points)}đ)` : ''; };
  const L = [`# Ma trận đề: ${meta.title}`, '', `| Chủ đề | ${levels.join(' | ')} | Tổng |`, `| --- | ${levels.map(() => '---').join(' | ')} | --- |`];
  for (const t of topics) {
    const rows = matrix.filter((r) => r.topic === t);
    L.push(`| ${t} | ${levels.map((lv) => cell(t, lv)).join(' | ')} | ${sum(rows.map((r) => r.items))} câu (${fmt(sum(rows.map((r) => r.points)))}đ) |`);
  }
  const lv = (l) => matrix.filter((r) => r.level === l);
  L.push(`| **Tổng** | ${levels.map((l) => `${sum(lv(l).map((r) => r.items))} câu (${fmt(sum(lv(l).map((r) => r.points)))}đ)`).join(' | ')} | ${sum(matrix.map((r) => r.items))} câu (${fmt(meta.total_points)}đ) |`);
  L.push(`| **Tỉ lệ** | ${levels.map((l) => `${Math.round((sum(lv(l).map((r) => r.points)) / meta.total_points) * 100)}%`).join(' | ')} | 100% |`);
  return L.join('\n');
}

function main(argv) {
  const [cmd, file, outdir] = argv; const flags = argv.filter((a) => a.startsWith('--'));
  if (!['check', 'render'].includes(cmd) || !file) { console.error('usage: examcheck.mjs check <exam.json> [--json] | render <exam.json> <outdir> [--force]'); return 2; }
  const exam = JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = check(exam); const fails = res.filter((r) => r.sev === 'FAIL');
  if (flags.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else { for (const r of res) console.log(`${r.sev.padEnd(4)} ${r.name}${r.msg ? ': ' + r.msg : ''}`); console.log(fails.length ? `\nEXAM: FAIL (${fails.length})` : '\nEXAM: PASS'); }
  if (cmd === 'check') return fails.length ? 1 : 0;
  if (fails.length && !flags.includes('--force')) { console.error('không xuất file khi còn FAIL (dùng --force để bỏ qua)'); return 1; }
  if (!outdir || outdir.startsWith('--')) { console.error('thiếu <outdir>'); return 2; }
  fs.mkdirSync(outdir, { recursive: true });
  const w = (f, s) => { fs.writeFileSync(path.join(outdir, f), s + '\n'); console.log('wrote', path.join(outdir, f)); };
  w('de-thi.md', renderExam(exam)); w('dap-an.md', renderKey(exam)); w('ma-tran.md', renderMatrix(exam));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
