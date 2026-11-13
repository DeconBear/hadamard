/** Interactive range input used by the built-in Slider component. */
export interface SliderWidgetOptions {
  onCommit(value: number): void;
}

export function bindSliderWidget(input: HTMLInputElement, wrap: HTMLElement, options: SliderWidgetOptions): void {
  const hit = wrap.querySelector<HTMLElement>('.block-hit');
  const track = input.closest<HTMLElement>('[data-hc-slider-track]');
  if (!hit || !track) return;
  const knob = track.querySelector<HTMLElement>('[data-hc-slider-knob]');
  const valueLabel = wrap.querySelector<HTMLElement>('[data-hc-slider-value]');
  const min = Number(track.dataset.min) || 0;
  const max = Number(track.dataset.max) || 100;
  const accent = track.dataset.accent || '#7c3aed';
  const trackColor = track.dataset.track || '#e9e3f5';
  const paint = (value: number): void => {
    const percent = Math.max(0, Math.min(100, (value - min) / (max - min || 1) * 100));
    track.style.background = 'linear-gradient(to right,' + accent + ' 0%,' + accent + ' ' + percent + '%,' + trackColor + ' ' + percent + '%,' + trackColor + ' 100%)';
    if (knob) knob.style.left = percent + '%';
    if (valueLabel) valueLabel.textContent = String(value);
    track.dataset.value = String(value);
  };
  const setByX = (clientX: number): number => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const value = Math.round(min + ratio * (max - min));
    input.value = String(value);
    paint(value);
    return value;
  };
  let moved = false;
  hit.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = track.getBoundingClientRect();
    if (event.clientY < rect.top - 16 || event.clientY > rect.bottom + 16) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const previous = Number(input.value);
    moved = setByX(event.clientX) !== previous;
    const move = (moveEvent: PointerEvent): void => { moved = true; setByX(moveEvent.clientX); };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!moved) return;
      options.onCommit(Number(input.value));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, true);
  input.addEventListener('input', () => paint(Number(input.value)));
  input.addEventListener('change', () => paint(Number(input.value)));
  for (const eventName of ['pointerdown', 'click', 'dblclick', 'keydown']) {
    input.addEventListener(eventName, event => event.stopPropagation());
  }

}
