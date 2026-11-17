# Spec: Tiếng Việt lớp 1, Bài <n> — <tên bài>

Issue: #<issue> · Spec by pct102-lead-spec · <YYYY-MM-DD>

## 1. Bài này dạy gì

- Vần / chữ: <…>
- Loại bài (theo `docs/VIETNAMESE-G1-ACTIVITY-PACK.md` §1): vần-chữ cái / truyện / thơ / thông tin / ôn tập
- Nguồn: `docs/lessonData/grade1/vietnamese-TAP1-NOTES.md` dòng <…>, SGK trang <…> (chỉ đọc, nội dung tự diễn đạt)
- Bài ôn tập: các bài được ôn <…> (thêm tag của các bài đó, §6)

## 2. Từ dùng trong bài (đã kiểm từ điển)

| Vần | Từ | Gợi ý nghĩa (dùng cho câu điền, không chứa từ) | Vẽ được? |
|---|---|---|---|
| uôc | luộc rau | nấu rau trong nước sôi | có |

Kết quả kiểm từ điển: `all real` (dán output lệnh).

## 3. Lỗi trẻ hay nhầm (nguồn duy nhất cho distractor)

| Đúng | Nhầm thành | Vì sao |
|---|---|---|
| luộc | luột | nhầm uôc / uôt |

## 4. Bài đọc (chép nguyên văn vào code, nối bằng `join(' ')`)

1. <câu 1>
2. <câu 2>

## 5. Generator (10–15 khoá) và ma trận mức độ

Tái dùng hay mới (generator-create Bước 1–2): <kết luận + lý do>.

| # | Khoá | Factory | Hỏi gì | Bank (≥10) | Mức | Rule áp dụng |
|---|---|---|---|---|---|---|
| 1 | `VIET_G1_BAI<n>_CHU_CAI_PICK` | `makeVietG1ChuCaiPick` | Tiếng “…” có vần nào? | 10 từ ở mục 2 | Nhận biết | `pick-wrong-rhyme`, CT-4 |
| 2 | `VIET_G1_BAI<n>_CHU_CAI_FILL` | `makeVietG1ChuCaiFill` | Điền vần còn thiếu: “l_” (<gợi ý nghĩa>) | … | Thông hiểu | CT-2 |

Nhận biết: <k> khoá · Thông hiểu: <k> · Vận dụng: <k> (cần ≥2 khoá từ Thông hiểu trở lên).

## 6. Câu mẫu (đã giải lại độc lập)

| # | Khoá | Câu hỏi | Đáp án | Giải lại không nhìn đáp án | Khớp |
|---|---|---|---|---|---|
| 1 | … | … | … | … | ✓ |

## 7. Ảnh (chỉ khi có `_IMAGE_PICK`)

| Từ | File | Đã nhìn ảnh | Ghi vào `words.json` |
|---|---|---|---|
| luộc rau | `bai<n>-luoc-rau.jpg` | ✓ | ✓ |

## 8. Bài học liên quan

CT-1, CT-2, … (từ `.muga/lessons/INDEX.md`)

## 9. Xong khi

- [ ] Đủ các khoá ở mục 5, mỗi bank ≥10 item, nội dung đúng mục 2–4.
- [ ] `npm run validate:generator -- --lesson <n>` thoát 0 (dán output vào PR).
- [ ] `npx tsc --noEmit` sạch.
- [ ] Tag `tv1-bai-<n>` trong `src/scripts/lessonTags/grade1.ts` (bài ôn: thêm tag các bài được ôn).
- [ ] PR in 10 câu mẫu sinh từ code (không chép mục 6) để so với mục 6.
- [ ] PR có generator mới → comment nhắc @pct102 chạy `npm run lessons:tag` trên dev.
