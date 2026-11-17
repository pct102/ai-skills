// node --test skills/pct102-exam/scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { check, renderExam, renderKey, renderMatrix } from './examcheck.mjs';

const load = () => JSON.parse(fs.readFileSync(new URL('../templates/exam.example.json', import.meta.url), 'utf8'));
const fails = (e) => check(e).filter((r) => r.sev === 'FAIL').map((r) => r.name);

test('the shipped example passes with no FAIL', () => assert.deepEqual(fails(load()), []));

const bad = {
  'tổng điểm': (e) => { e.meta.total_points = 11; },
  'khớp ma trận': (e) => { e.matrix[0].items = 5; },
  'tỉ lệ mức độ': (e) => { e.targets = { 'Nhận biết': 0.7, 'Thông hiểu': 0.1, 'Vận dụng': 0.1, 'Vận dụng cao': 0.1 }; },
  'trắc nghiệm': (e) => { e.items[0].answer = 'Z'; },
  'tự luận / rubric': (e) => { e.items.find((i) => i.id === 'E3').rubric[0].points = 1; },
  'phân bố đáp án': (e) => { e.items.filter((i) => i.type === 'mcq').forEach((i) => { i.answer = 'A'; }); },
  'độ dài đáp án': (e) => { Object.assign(e.items[0], { options: ['một phương án rất rất dài dòng', 'ngắn', 'vừa', 'hai'] }); },
  'trùng câu hỏi': (e) => { e.items[1].stem = e.items[0].stem; },
};
for (const [name, mutate] of Object.entries(bad)) {
  test(`detects: ${name}`, () => { const e = load(); mutate(e); assert.ok(fails(e).includes(name), `expected FAIL in "${name}", got ${fails(e)}`); });
}

test('render numbers questions and keeps answers out of the paper', () => {
  const e = load();
  const paper = renderExam(e), key = renderKey(e), matrix = renderMatrix(e);
  assert.match(paper, /\*\*Câu 14\./);
  assert.doesNotMatch(paper, /Lời giải|Đáp án/);
  assert.match(key, /\| 1 \| C \|/);
  assert.match(matrix, /100%/);
});
