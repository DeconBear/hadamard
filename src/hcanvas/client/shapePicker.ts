import type { HcShape } from '../types.js';
import { HCANVAS_SHAPES, HCANVAS_SHAPE_CATEGORIES, shapeSvgMarkup, type HcShapeCategory } from '../shapes.js';

export interface ShapePickerOptions {
  onChoose(shape: HcShape): void;
}

export interface ShapePicker {
  open(): void;
  hide(): void;
}

const VISIBLE_SHAPES = HCANVAS_SHAPES.filter(shape => !shape.hidden);

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

import { getLanguage, translatePhrase } from './i18n.js';

const CATEGORY_ZH: Record<string, string> = {
  Basic: '基础',
  Lines: '线条',
  Flowchart: '流程图',
  'Stars & Banners': '星形与横幅',
  Callouts: '标注',
  'Action Buttons': '操作按钮',
};

const SHAPE_LABEL_ZH: Record<string, string> = {
  Rectangle: '矩形', 'Rounded rectangle': '圆角矩形', Ellipse: '椭圆', Triangle: '三角形', 'Right triangle': '直角三角形',
  Diamond: '菱形', Parallelogram: '平行四边形', Trapezoid: '梯形', Pentagon: '五边形', Hexagon: '六边形', Octagon: '八边形',
  Cross: '十字', Plus: '加号', Minus: '减号', Multiply: '乘号', Divide: '除号', Equals: '等号', 'Not equal': '不等号',
  Heart: '心形', Cloud: '云形', Cylinder: '圆柱', Cube: '立方体', Note: '便签', 'Arrow right': '右箭头', 'Arrow left': '左箭头',
  Chevron: 'V 形箭头', Home: '主页', Pie: '饼图', Donut: '环形图', Arc: '弧形', Frame: '画框',
  Line: '直线', 'Double arrow': '双向箭头', 'Arc line': '弧线', Polyline: '折线', 'Elbow connector': '直角连接线', 'Curve line': '曲线',
  Process: '流程', Decision: '判断', Terminator: '开始/结束', Data: '数据', Document: '文档', Database: '数据库',
  'Manual input': '手动输入', Preparation: '准备', Star: '星形', '4-point star': '四角星', '5-point star': '五角星', '6-point star': '六角星',
  '8-point star': '八角星', '12-point star': '十二角星', '16-point star': '十六角星', '24-point star': '二十四角星', '32-point star': '三十二角星',
  Ribbon: '横幅', Explosion: '爆炸形', 'Rectangle callout': '矩形标注', 'Rounded callout': '圆角标注', 'Cloud callout': '云形标注', Thought: '思考框',
  'Play button': '播放按钮', 'Next button': '下一项按钮', 'Previous button': '上一项按钮', 'Home button': '主页按钮', 'Info button': '信息按钮', 'Help button': '帮助按钮', Polygon: '多边形',
};

function shapeLabel(label: string): string {
  return getLanguage() === 'zh' ? (SHAPE_LABEL_ZH[label] || label) : label;
}

function categoryLabel(category: string): string {
  return getLanguage() === 'zh' ? (CATEGORY_ZH[category] || category) : category;
}

function countLabel(count: number): string {
  return getLanguage() === 'zh' ? count + ' 个形状' : count + ' shape' + (count === 1 ? '' : 's');
}

function shapeInsertLabel(label: string): string {
  return getLanguage() === 'zh' ? '插入' + label : 'Insert ' + label;
}

export function createShapePicker(options: ShapePickerOptions): ShapePicker {
  let popover: HTMLDivElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let activeCategory: HcShapeCategory = 'Basic';
  let pinned = false;
  const anchor = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-block="shape"]');
  const button = anchor();

  const clearHideTimer = (): void => {
    if (!hideTimer) return;
    clearTimeout(hideTimer);
    hideTimer = undefined;
  };

  const position = (): void => {
    if (!popover || popover.classList.contains('hidden')) return;
    const button = anchor();
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(424, Math.max(320, window.innerWidth - 20));
    popover.style.width = width + 'px';
    const height = popover.offsetHeight || 480;
    let left = rect.right + 12;
    if (left + width > window.innerWidth - 10) left = Math.max(10, rect.left - width - 12);
    const top = Math.max(10, Math.min(rect.top - 6, window.innerHeight - height - 10));
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  };

  const hide = (restoreFocus = false): void => {
    clearHideTimer();
    pinned = false;
    if (!popover) return;
    popover.classList.add('hidden');
    popover.setAttribute('aria-hidden', 'true');
    button?.setAttribute('aria-expanded', 'false');
    if (popover.contains(document.activeElement)) {
      if (restoreFocus) anchor()?.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement).blur();
    }
  };

  const scheduleHide = (): void => {
    if (pinned) return;
    clearHideTimer();
    hideTimer = setTimeout(() => { hideTimer = undefined; hide(); }, 260);
  };

  const localizeChrome = (node: HTMLDivElement): void => {
    const head = node.querySelector<HTMLElement>('.shape-popover-head strong');
    const total = node.querySelector<HTMLElement>('.shape-popover-head span');
    if (head) head.textContent = translatePhrase('Shapes');
    if (total) total.textContent = countLabel(VISIBLE_SHAPES.length);
    const close = node.querySelector<HTMLButtonElement>('.shape-popover-close');
    if (close) { close.setAttribute('aria-label', translatePhrase('Close shape library')); close.title = translatePhrase('Close (Esc)'); }
    const search = node.querySelector<HTMLInputElement>('[data-shape-search]');
    if (search) { search.placeholder = translatePhrase('Find a shape…'); search.setAttribute('aria-label', translatePhrase('Search shapes')); }
    const clear = node.querySelector<HTMLButtonElement>('[data-shape-search-clear]');
    if (clear) { clear.setAttribute('aria-label', translatePhrase('Clear shape search')); clear.title = translatePhrase('Clear search'); }
    node.querySelector<HTMLElement>('.shape-category-tabs')?.setAttribute('aria-label', translatePhrase('Shape categories'));
    const emptyTitle = node.querySelector<HTMLElement>('.shape-empty strong');
    const emptyText = node.querySelector<HTMLElement>('.shape-empty span');
    if (emptyTitle) emptyTitle.textContent = translatePhrase('No matching shapes');
    if (emptyText) emptyText.textContent = translatePhrase('Try a different name or category.');
    const foot = node.querySelector<HTMLElement>('.shape-popover-foot span');
    if (foot) foot.textContent = translatePhrase('Click a shape, then click or drag on the canvas');
  };

  const renderChoices = (): void => {
    if (!popover) return;
    localizeChrome(popover);
    const search = popover.querySelector<HTMLInputElement>('[data-shape-search]');
    const grid = popover.querySelector<HTMLDivElement>('.shape-popover-grid');
    const heading = popover.querySelector<HTMLElement>('[data-shape-grid-title]');
    const count = popover.querySelector<HTMLElement>('[data-shape-result-count]');
    const clear = popover.querySelector<HTMLButtonElement>('[data-shape-search-clear]');
    if (!search || !grid || !heading || !count || !clear) return;
    const query = search.value.trim().toLocaleLowerCase();
    const shapes = VISIBLE_SHAPES.filter(shape => {
      if (!query) return shape.category === activeCategory;
      return (shape.label + ' ' + shape.hint + ' ' + shape.category + ' ' + categoryLabel(shape.category) + ' ' + shapeLabel(shape.label)).toLocaleLowerCase().includes(query);
    });
    popover.querySelectorAll<HTMLButtonElement>('[data-shape-category]').forEach(button => {
      const active = !query && button.dataset.shapeCategory === activeCategory;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = query || active ? 0 : -1;
      button.querySelector('span')!.textContent = categoryLabel(button.dataset.shapeCategory || '');
    });
    heading.textContent = query ? translatePhrase('Search results') : categoryLabel(activeCategory);
    count.textContent = countLabel(shapes.length);
    clear.classList.toggle('hidden', !query);
    grid.setAttribute('aria-label', query ? translatePhrase('Shape search results') : categoryLabel(activeCategory) + ' ' + translatePhrase('shapes'));
    grid.innerHTML = shapes.map(shape => {
      const preview = shapeSvgMarkup({ shape: shape.id, style: { fill: '#e8e9ed', stroke: '#626975', strokeWidth: 1.35, radius: 10 } })
        .replace('preserveAspectRatio="none"', 'preserveAspectRatio="xMidYMid meet"');
      return '<button type="button" class="shape-choice" data-shape-choice="' + shape.id + '" aria-label="' + escapeHtml(shapeInsertLabel(shapeLabel(shape.label))) + '" title="' + escapeHtml(shapeLabel(shape.label) + ' — ' + shape.hint) + '">' +
        '<span class="shape-choice-preview">' + preview + '</span>' +
        '<span class="shape-choice-label">' + escapeHtml(shapeLabel(shape.label)) + '</span></button>';
    }).join('');
    popover.querySelector('.shape-empty')?.classList.toggle('hidden', shapes.length > 0);
    grid.classList.toggle('hidden', shapes.length === 0);
  };

  const chooseCategory = (category: HcShapeCategory): void => {
    if (!popover) return;
    activeCategory = category;
    const search = popover.querySelector<HTMLInputElement>('[data-shape-search]');
    if (search) search.value = '';
    const grid = popover.querySelector<HTMLElement>('.shape-popover-grid');
    if (grid) grid.scrollTop = 0;
    renderChoices();
  };

  const ensure = (): HTMLDivElement => {
    if (popover) return popover;
    popover = document.createElement('div');
    popover.className = 'shape-popover hidden';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Shape library');
    popover.setAttribute('aria-hidden', 'true');
    popover.innerHTML = '<div class="shape-popover-head"><div><strong>' + translatePhrase('Shapes') + '</strong><span>' + countLabel(VISIBLE_SHAPES.length) + '</span></div>' +
      '<button type="button" class="shape-popover-close" aria-label="' + translatePhrase('Close shape library') + '" title="' + translatePhrase('Close (Esc)') + '">×</button></div>' +
      '<div class="shape-search"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25"/><path d="m12.5 12.5 4 4"/></svg>' +
      '<input type="search" data-shape-search placeholder="' + translatePhrase('Find a shape…') + '" aria-label="' + translatePhrase('Search shapes') + '" autocomplete="off" spellcheck="false" />' +
      '<button type="button" class="shape-search-clear hidden" data-shape-search-clear aria-label="' + translatePhrase('Clear shape search') + '" title="' + translatePhrase('Clear search') + '">×</button></div>' +
      '<div class="shape-popover-body"><div class="shape-category-tabs" role="tablist" aria-label="' + translatePhrase('Shape categories') + '" aria-orientation="vertical">' +
      HCANVAS_SHAPE_CATEGORIES.map((category, index) => {
        const total = VISIBLE_SHAPES.filter(shape => shape.category === category).length;
        return '<button type="button" id="shape-category-' + index + '" role="tab" class="shape-category-tab" data-shape-category="' + escapeHtml(category) + '" aria-selected="false" aria-controls="shape-picker-grid" tabindex="-1"><span>' + escapeHtml(categoryLabel(category)) + '</span><small>' + total + '</small></button>';
      }).join('') + '</div>' +
      '<div class="shape-library"><div class="shape-library-meta"><span data-shape-grid-title></span><small><span data-shape-result-count></span> shapes</small></div>' +
      '<div class="shape-popover-grid" id="shape-picker-grid" role="tabpanel" tabindex="-1"></div>' +
      '<div class="shape-empty hidden"><strong>' + translatePhrase('No matching shapes') + '</strong><span>' + translatePhrase('Try a different name or category.') + '</span></div></div></div>' +
      '<div class="shape-popover-foot"><span>' + translatePhrase('Click a shape, then click or drag on the canvas') + '</span><kbd>esc</kbd></div>';
    popover.addEventListener('pointerenter', clearHideTimer);
    popover.addEventListener('pointerleave', scheduleHide);
    popover.addEventListener('focusin', clearHideTimer);
    popover.addEventListener('focusout', event => {
      if (!popover?.contains(event.relatedTarget as Node | null)) scheduleHide();
    });
    popover.querySelector('[data-shape-search]')?.addEventListener('input', () => {
      const grid = popover?.querySelector<HTMLElement>('.shape-popover-grid');
      if (grid) grid.scrollTop = 0;
      renderChoices();
    });
    popover.querySelector('[data-shape-search]')?.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown') return;
      const first = popover?.querySelector<HTMLButtonElement>('[data-shape-choice]');
      if (!first) return;
      event.preventDefault();
      event.stopPropagation();
      first.focus();
    });
    popover.querySelector('[data-shape-search-clear]')?.addEventListener('click', () => {
      const search = popover?.querySelector<HTMLInputElement>('[data-shape-search]');
      if (!search) return;
      search.value = '';
      renderChoices();
      search.focus();
    });
    popover.querySelector('.shape-popover-close')?.addEventListener('click', () => hide(true));
    popover.querySelectorAll<HTMLButtonElement>('[data-shape-category]').forEach((button, index, buttons) => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        chooseCategory(button.dataset.shapeCategory as HcShapeCategory);
      });
      button.addEventListener('keydown', event => {
        let next = index;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % buttons.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault();
        event.stopPropagation();
        const target = buttons[next]!;
        chooseCategory(target.dataset.shapeCategory as HcShapeCategory);
        target.focus();
      });
    });
    popover.querySelector('.shape-popover-grid')?.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-shape-choice]');
      const shape = button?.dataset.shapeChoice as HcShape | undefined;
      if (!shape) return;
      hide();
      options.onChoose(shape);
    });
    popover.querySelector('.shape-popover-grid')?.addEventListener('keydown', event => {
      const current = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-shape-choice]');
      if (!current || !popover) return;
      const choices = Array.from(popover.querySelectorAll<HTMLButtonElement>('[data-shape-choice]'));
      const index = choices.indexOf(current);
      const columns = Math.max(1, getComputedStyle(popover.querySelector('.shape-popover-grid')!).gridTemplateColumns.split(' ').length);
      let next = index;
      if (event.key === 'ArrowLeft') next = index - 1;
      else if (event.key === 'ArrowRight') next = index + 1;
      else if (event.key === 'ArrowUp') next = index - columns;
      else if (event.key === 'ArrowDown') next = index + columns;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = choices.length - 1;
      else return;
      event.preventDefault();
      event.stopPropagation();
      const target = choices[Math.max(0, Math.min(choices.length - 1, next))];
      target?.focus();
      target?.scrollIntoView({ block: 'nearest' });
    });
    document.body.appendChild(popover);
    renderChoices();
    return popover;
  };

  const show = (pin: boolean): void => {
    clearHideTimer();
    const wasPinned = pinned;
    if (pin) pinned = true;
    const node = ensure();
    const wasHidden = node.classList.contains('hidden');
    node.classList.remove('hidden');
    node.setAttribute('aria-hidden', 'false');
    const trigger = anchor();
    trigger?.setAttribute('aria-expanded', 'true');
    trigger?.setAttribute('aria-controls', 'shape-picker-grid');
    if (wasHidden) {
      const search = node.querySelector<HTMLInputElement>('[data-shape-search]');
      if (search) search.value = '';
      renderChoices();
    }
    position();
    if (pinned && !wasPinned) node.querySelector<HTMLInputElement>('[data-shape-search]')?.focus({ preventScroll: true });
  };

  const open = (): void => show(true);
  button?.setAttribute('aria-haspopup', 'dialog');
  button?.setAttribute('aria-expanded', 'false');
  button?.addEventListener('pointerenter', () => { if (!pinned) show(false); });
  button?.addEventListener('pointerleave', scheduleHide);
  window.addEventListener('resize', position, { passive: true });
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !popover || popover.classList.contains('hidden')) return;
    hide(true);
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener('pointerdown', event => {
    if (!popover || popover.classList.contains('hidden')) return;
    const target = event.target as Node;
    if (popover.contains(target) || button?.contains(target)) return;
    hide();
  }, true);

  return { open, hide: () => hide() };
}
