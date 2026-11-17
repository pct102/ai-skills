---
name: markitdown
description: Converts PDF, DOCX, PPTX, XLSX, EPUB, HTML, CSV/JSON/XML, images, and audio into Markdown so a model without native file reading can understand the content. Use when asked to read, summarize, quote, or extract from a PDF or office document, or when a model cannot open a document directly.
---

# MarkItDown

Turn binary documents into Markdown text that any model can read. MarkItDown is Microsoft's
converter built for LLM pipelines: headings, lists, tables, and links survive as Markdown.

## Reality check

Do not promise more than the tool does:

| Input | Offline result |
| --- | --- |
| PDF with a text layer | Good text, tables roughly preserved |
| Scanned/image-only PDF | **Empty or garbage** — needs OCR |
| DOCX, PPTX, XLSX, EPUB | Good |
| HTML, CSV, JSON, XML, ZIP | Good |
| Images (jpg/png) | Only EXIF/metadata — **not a description** |
| Audio | Metadata only; transcription needs a web service |
| YouTube URL | Transcript, needs network |

So: "PDF → Markdown" works only when the PDF already contains text. For photos and scans the
model still needs its own vision or an OCR step. Say this plainly instead of converting and
pretending the output is complete.

## Setup

```bash
uv tool install 'markitdown[all]'     # installs ~/.local/bin/markitdown, no sudo
export PATH="$HOME/.local/bin:$PATH"  # if not already on PATH
markitdown --version
```

Partial installs: `uv tool install 'markitdown[pdf,docx,xlsx]'`.

## Use

```bash
markitdown document.pdf > document.md          # stdout
markitdown document.pdf -o document.md         # file
cat scanned.pdf | markitdown                   # pipe
```

Batch wrapper included in this skill:

```bash
bash scripts/mdconvert.sh report.pdf slides.pptx notes.docx -o .md/
bash scripts/mdconvert.sh --plugins scan.pdf     # enable plugins
```

The wrapper writes `<name>.md` next to each input (or into `-o`) and warns when a file
produced almost no text, which almost always means a scanned PDF or an image.

## Agent workflow

1. Convert first, then read the Markdown file. Never dump a binary into context.
2. If the output is under ~40 characters, treat it as "no extractable text", not as "empty document".
3. Large result: read in slices, or search it (`rg`) instead of loading the whole file.
4. Keep the `.md` beside the source so later turns do not re-convert.

## Scanned PDFs and images

Pick one, cheapest first:

1. **Model vision** — if the current model accepts images, convert pages to PNG and pass them directly.
2. **Local OCR** — `brew install tesseract ocrmypdf`, then:
   ```bash
   ocrmypdf --skip-text input.pdf ocr.pdf && markitdown ocr.pdf -o input.md
   ```
3. **`markitdown-ocr` plugin** — OCR via a vision LLM, needs an OpenAI-compatible client:
   ```bash
   uv pip install markitdown-ocr openai
   ```
   Then call the Python API with `enable_plugins=True, llm_client=..., llm_model=...`.
4. **Azure Document Intelligence / Content Understanding** — best quality for scans, tables,
   forms, audio and video, but billable per call:
   ```bash
   markitdown scan.pdf --use-docintel --endpoint "$MARKITDOWN_DOCINTEL_ENDPOINT"
   markitdown scan.pdf --use-cu --cu-endpoint "$MARKITDOWN_CU_ENDPOINT"
   ```

Image captioning also needs `llm_client` + `llm_model`; without it a JPEG yields EXIF only.

## Safety

MarkItDown performs I/O with the current process's privileges and will fetch URLs. Convert
local files only; do not pass untrusted paths or remote URIs. In Python prefer
`convert_local()` or `convert_stream()` over the permissive `convert()`.

## Troubleshooting

- `command not found` → prepend `~/.local/bin` to `PATH`.
- `MissingDependencyException` → install the matching extra (`[pdf]`, `[docx]`, ...).
- Empty output → scanned PDF or unsupported format; use OCR or a converter-specific extra.
- Wrong encoding in CSV → pass `--charset` or re-encode to UTF-8 first.
