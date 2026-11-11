export interface PdfWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfPage {
  page: number;
  width: number;
  height: number;
  url: string;
  words: PdfWord[];
}

interface PdfAnnotation {
  id: string;
  page: number;
  type: 'highlight' | 'underline';
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  text: string;
  createdAt: string;
}

export interface PdfPreviewOptions {
  rootId: string;
  path: string;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  fallbackUrl: string;
  toast(message: string, kind?: 'success' | 'error' | 'info'): void;
}

function loadAnnotations(key: string): PdfAnnotation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]') as PdfAnnotation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveAnnotations(key: string, annotations: PdfAnnotation[]): void {
  try { localStorage.setItem(key, JSON.stringify(annotations)); } catch { /* storage is best effort */ }
}

export async function mountPdfPreview(host: HTMLElement, options: PdfPreviewOptions): Promise<void> {
  const key = 'hcanvas:pdf-annotations:' + options.rootId + ':' + options.path;
  let annotations = loadAnnotations(key);
  let mode: 'highlight' | 'underline' = 'highlight';

  host.innerHTML = '<div class="pdf-loading">Loading PDF pages…</div>';
  let pages: PdfPage[];
  try {
    const result = await options.request<{ pages: PdfPage[] }>('/api/files/pdf-preview?root=' + encodeURIComponent(options.rootId) + '&path=' + encodeURIComponent(options.path));
    pages = result.pages || [];
    if (!pages.length) throw new Error('No PDF pages returned');
  } catch (error) {
    host.innerHTML = '<div class="pdf-fallback-note">Rich PDF preview needs Poppler (pdftoppm/pdftotext). Showing the browser PDF viewer instead.</div>';
    const frame = document.createElement('iframe');
    frame.className = 'file-html-frame';
    frame.title = options.path;
    frame.setAttribute('src', options.fallbackUrl);
    host.appendChild(frame);
    options.toast(error instanceof Error ? error.message : String(error), 'error');
    return;
  }

  host.innerHTML = '';
  const toolbar = document.createElement('div');
  toolbar.className = 'pdf-annotation-toolbar';
  toolbar.innerHTML = '<span class="pdf-toolbar-label">PDF</span><button type="button" class="btn tiny active" data-pdf-mode="highlight">Highlight</button><button type="button" class="btn tiny" data-pdf-mode="underline">Underline</button><button type="button" class="btn tiny" data-pdf-clear>Clear annotations</button><span class="pdf-toolbar-hint">Select text on the page</span>';
  const pagesHost = document.createElement('div');
  pagesHost.className = 'pdf-pages';
  host.appendChild(toolbar);
  host.appendChild(pagesHost);

  const toolbarButtons = toolbar.querySelectorAll<HTMLButtonElement>('[data-pdf-mode]');
  toolbarButtons.forEach(button => {
    button.addEventListener('click', () => {
      mode = button.dataset.pdfMode === 'underline' ? 'underline' : 'highlight';
      toolbarButtons.forEach(item => item.classList.toggle('active', item === button));
    });
  });
  toolbar.querySelector<HTMLButtonElement>('[data-pdf-clear]')?.addEventListener('click', () => {
    if (!annotations.length) return;
    if (!window.confirm('Clear all PDF annotations for this file?')) return;
    annotations = [];
    saveAnnotations(key, annotations);
    renderAnnotations();
    options.toast('PDF annotations cleared', 'success');
  });

  function renderAnnotations(): void {
    pagesHost.querySelectorAll('.pdf-page').forEach(pageElement => {
      const pageNumber = Number((pageElement as HTMLElement).dataset.pdfPage || '0');
      const layer = pageElement.querySelector<HTMLElement>('.pdf-annotations');
      if (!layer) return;
      layer.innerHTML = '';
      for (const annotation of annotations.filter(item => item.page === pageNumber)) {
        for (const rect of annotation.rects) {
          const overlay = document.createElement('div');
          overlay.className = 'pdf-annotation ' + annotation.type;
          overlay.style.left = (rect.x * 100) + '%';
          overlay.style.top = (rect.y * 100) + '%';
          overlay.style.width = (rect.w * 100) + '%';
          overlay.style.height = (rect.h * 100) + '%';
          overlay.title = annotation.text;
          layer.appendChild(overlay);
        }
      }
    });
  }

  function addAnnotation(pageElement: HTMLElement, page: PdfPage): void {
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!pageElement.contains(range.commonAncestorContainer)) return;
    const pageRect = pageElement.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter(rect => rect.width > 1 && rect.height > 1)
      .map(rect => ({ x: (rect.left - pageRect.left) / pageRect.width, y: (rect.top - pageRect.top) / pageRect.height, w: rect.width / pageRect.width, h: rect.height / pageRect.height }))
      .filter(rect => rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 1.02 && rect.y + rect.h <= 1.02);
    const text = selection.toString().trim();
    if (!rects.length || !text) return;
    annotations.push({ id: 'pdf_' + Date.now().toString(36), page: page.page, type: mode, rects, text, createdAt: new Date().toISOString() });
    saveAnnotations(key, annotations);
    renderAnnotations();
    selection.removeAllRanges();
    options.toast((mode === 'highlight' ? 'Highlighted' : 'Underlined') + ' ' + text.slice(0, 80), 'success');
  }

  for (const page of pages) {
    const pageElement = document.createElement('div');
    pageElement.className = 'pdf-page';
    pageElement.dataset.pdfPage = String(page.page);
    pageElement.style.aspectRatio = page.width + ' / ' + page.height;
    const image = document.createElement('img');
    image.className = 'pdf-page-image';
    image.src = page.url;
    image.alt = 'PDF page ' + page.page;
    image.loading = 'lazy';
    const textLayer = document.createElement('div');
    textLayer.className = 'pdf-text-layer';
    const annotationLayer = document.createElement('div');
    annotationLayer.className = 'pdf-annotations';
    pageElement.appendChild(image);
    pageElement.appendChild(textLayer);
    pageElement.appendChild(annotationLayer);
    pagesHost.appendChild(pageElement);

    for (const word of page.words) {
      const span = document.createElement('span');
      span.textContent = word.text;
      span.style.left = (word.x * 100) + '%';
      span.style.top = (word.y * 100) + '%';
      span.style.width = (word.w * 100) + '%';
      span.style.height = (word.h * 100) + '%';
      span.style.fontSize = Math.max(5, word.h * page.width * 1.2) + 'px';
      textLayer.appendChild(span);
    }
    pageElement.addEventListener('mouseup', () => addAnnotation(pageElement, page));
  }

  renderAnnotations();
  const resizeObserver = new ResizeObserver(() => {
    pagesHost.querySelectorAll<HTMLElement>('.pdf-page').forEach(pageElement => {
      const width = pageElement.clientWidth;
      const page = pages.find(item => item.page === Number(pageElement.dataset.pdfPage));
      if (!page) return;
      const height = width * page.height / page.width;
      pageElement.querySelectorAll<HTMLElement>('.pdf-text-layer span').forEach((span, index) => {
        const word = page.words[index];
        if (word) span.style.fontSize = Math.max(5, word.h * height * 1.1) + 'px';
      });
    });
  });
  if (typeof ResizeObserver !== 'undefined') resizeObserver.observe(pagesHost);
}
