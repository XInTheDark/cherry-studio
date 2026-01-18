Knowledge Base "Full Files" Mode (Design Notes)

Goal
- Add a KB option so that *full file contents* are sent to the model (preferably once at thread start),
  instead of retrieving N chunks per message.
- UX: integrate into existing Knowledge Base "Requested Document Chunks" slider:
  far-right value => "Full files".
- UI citations: show snippets only, but show an indicator that full files mode is enabled.

Current Behavior (Jan 17, 2026)
- KB indexing happens at add-time:
  - Main process: src/main/services/KnowledgeService.ts calls addFileLoader(...) which uses embedjs loaders.
  - embedjs chunks the extracted text and embeds it; vectors stored in a per-KB sqlite db (LibSQL).
  - Renderer: src/renderer/src/services/KnowledgeService.ts calls window.api.knowledgeBase.search(...) to retrieve chunks.
  - Retrieved chunks become KnowledgeReference[] and are injected into the user message via REFERENCE_PROMPT.

Important Detail: Are full extracted texts stored?
- Not as a single "document text" blob.
- The libsql vector table stores chunk texts as vectors.pageContent with metadata per chunk.
- This storage is not suitable to reliably reconstruct full documents because:
  - chunk ordering is not explicitly stored (chunk id is `${uniqueLoaderId}_${i}` and needs numeric sort),
  - chunkOverlap causes repeated content,
  - and `pageContent` is UNIQUE with INSERT OR IGNORE, which can drop duplicate chunks across files.

Implication
- For "Full files" mode we should NOT rely on reading back `vectors.pageContent` to reconstruct full documents.
- Better: re-extract from the original file OR (preferred) store the extracted full text at index time
  in a separate table keyed by loader/file id for later reuse.

Proposed Implementation (pending approval)
- Add a sentinel slider value e.g. KNOWLEDGE_DOCUMENT_COUNT_FULL_FILES.
- Provide full-file injection to model via a system-prefix mechanism (not via the user message),
  to avoid duplicating it and to keep message editing sane.
- UI citations still show snippets + add an indicator banner in citations panel.

