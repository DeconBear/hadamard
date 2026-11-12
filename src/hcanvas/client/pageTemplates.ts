import type { HcBlock } from '../types.js';
import { esc, genId } from './utils.js';

export interface HcClientPagePreset {
  id: string;
  title: string;
  mode: 'html' | 'canvas' | 'infinite';
  width: number;
  height: number;
  background: string;
  hint: string;
  template?: string;
  markdown?: string;
}

/** Primary page-creation presets: one generic canvas surface per size, not use-case templates. */
export const CANVAS_PAGE_PRESETS: HcClientPagePreset[] = [
  { id: 'canvas-16-9', title: 'Canvas · 16:9', mode: 'canvas', width: 1280, height: 720, background: '#fbfaf7', hint: 'Slides & presentations' },
  { id: 'canvas-a4', title: 'Canvas · A4', mode: 'canvas', width: 794, height: 1123, background: '#ffffff', hint: 'Documents, resumes & printables' },
  { id: 'canvas-4-5', title: 'Canvas · 4:5', mode: 'canvas', width: 1080, height: 1350, background: '#f6f4ef', hint: 'Posters & social' },
  { id: 'canvas-square', title: 'Canvas · 1:1', mode: 'canvas', width: 1080, height: 1080, background: '#fbfaf7', hint: 'Square graphics' },
  { id: 'canvas-wide', title: 'Canvas · 16:9 wide', mode: 'canvas', width: 1920, height: 1080, background: '#ffffff', hint: 'Full-HD presentations' },
  { id: 'infinite', title: 'Infinite canvas', mode: 'infinite', width: 4800, height: 3200, background: '#f8f6f1', hint: 'No bounds · pan & zoom' },
  { id: 'html-page', title: 'HTML page', mode: 'html', width: 1280, height: 720, background: '#ffffff', hint: 'Directly editable HTML / CSS' },
  { id: 'markdown-a4', title: 'Markdown · A4', mode: 'html', width: 794, height: 1123, background: '#ffffff', hint: 'Markdown document · rendered + source editing', markdown: '# Untitled document\n\nStart writing in Markdown.\n\n## Section\n\n- Point one\n- Point two\n' },
];

/** Legacy decorated templates, kept for existing documents/API compatibility. New UI uses CANVAS_PAGE_PRESETS. */
export const PAGE_PRESETS: HcClientPagePreset[] = [
  { id: 'slide-html', title: 'HTML slide', mode: 'html', width: 1280, height: 720, background: '#ffffff', hint: '16:9 · blank editable HTML' },
  { id: 'slide-cover', title: 'Slide · Cover', mode: 'html', width: 1280, height: 720, background: '#f6f4ef', hint: '16:9 · title slide', template: 'cover' },
  { id: 'slide-section', title: 'Slide · Section', mode: 'html', width: 1280, height: 720, background: '#171923', hint: '16:9 · dark section divider', template: 'section' },
  { id: 'slide-two-col', title: 'Slide · Two columns', mode: 'html', width: 1280, height: 720, background: '#ffffff', hint: '16:9 · content + sidebar', template: 'two-col' },
  { id: 'slide-quote', title: 'Slide · Quote', mode: 'html', width: 1280, height: 720, background: '#f1f5ff', hint: '16:9 · big quote', template: 'quote' },
  { id: 'slide-agenda', title: 'Slide · Agenda', mode: 'html', width: 1280, height: 720, background: '#fbfaf7', hint: '16:9 · numbered agenda', template: 'agenda' },
  { id: 'a4-html', title: 'HTML A4', mode: 'html', width: 794, height: 1123, background: '#ffffff', hint: 'A4 · blank document' },
  { id: 'resume-classic', title: 'Résumé · Classic', mode: 'html', width: 794, height: 1123, background: '#ffffff', hint: 'A4 · ATS-friendly', template: 'resume-classic' },
  { id: 'resume-modern', title: 'Résumé · Modern', mode: 'html', width: 794, height: 1123, background: '#f8f6f1', hint: 'A4 · visual two-column', template: 'resume-modern' },
  { id: 'resume-ats', title: 'Résumé · ATS minimal', mode: 'html', width: 794, height: 1123, background: '#ffffff', hint: 'A4 · plain text-first', template: 'resume-ats' },
  { id: 'poster-html', title: 'HTML poster', mode: 'html', width: 1080, height: 1350, background: '#ffffff', hint: '4:5 · blank' },
  { id: 'poster-event', title: 'Poster · Event', mode: 'html', width: 1080, height: 1350, background: '#171923', hint: '4:5 · bold event poster', template: 'poster-event' },
  { id: 'poster-product', title: 'Poster · Product', mode: 'html', width: 1080, height: 1350, background: '#f6f4ef', hint: '4:5 · product / campaign', template: 'poster-product' },
  { id: 'slide-canvas', title: 'Canvas slide', mode: 'canvas', width: 1280, height: 720, background: '#fbfaf7', hint: '16:9 · blocks' },
  { id: 'canvas-cover', title: 'Canvas · PPT cover', mode: 'canvas', width: 1280, height: 720, background: '#f6f4ef', hint: '16:9 · editable PowerPoint', template: 'canvas-cover' },
  { id: 'canvas-content', title: 'Canvas · PPT content', mode: 'canvas', width: 1280, height: 720, background: '#ffffff', hint: '16:9 · editable PowerPoint', template: 'canvas-content' },
  { id: 'a4-canvas', title: 'Canvas A4', mode: 'canvas', width: 794, height: 1123, background: '#ffffff', hint: 'A4 · blocks' },
  { id: 'square-canvas', title: 'Canvas square', mode: 'canvas', width: 1080, height: 1080, background: '#fbfaf7', hint: '1:1 · blocks' },
  { id: 'infinite', title: 'Infinite canvas', mode: 'infinite', width: 4800, height: 3200, background: '#f8f6f1', hint: 'No bounds · pan & zoom' },
];

export function starterHtml(title: string): string {
  return [
    '<style>',
    '  .hc-start { box-sizing:border-box; width:100%; height:100%; padding:72px 80px; background:#f7f5f0; color:#1f2430; font-family:Inter,ui-sans-serif,system-ui,sans-serif; }',
    '  .hc-start .tag { display:inline-block; margin-bottom:26px; font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:#7c3aed; }',
    '  .hc-start h1 { margin:0 0 16px; max-width:760px; font-family:Georgia,serif; font-weight:500; font-size:58px; line-height:1.04; letter-spacing:-.04em; }',
    '  .hc-start p { margin:0; max-width:620px; font-size:18px; line-height:1.6; color:#5d584e; }',
    '</style>',
    '<div class="hc-start">',
    '  <div class="tag">HTML page · editable</div>',
    '  <h1>' + esc(title || 'Start with a beautiful page.') + '</h1>',
    '  <p>Double-click text to edit in place. Toggle source mode to change HTML and CSS. Agent tools patch this page through stable data-hc-id selectors.</p>',
    '</div>',
  ].join('');
}

export function resumeTemplateHtml(template: string, title: string): string {
  const name = esc(title || 'Alex Morgan');
  const ats = template === 'resume-ats';
  const modern = template === 'resume-modern';
  const accent = ats ? '#111111' : modern ? '#5b21b6' : '#1f2430';
  const body = ats ? '#111111' : '#2e2a24';
  const muted = ats ? '#111111' : '#6b6459';
  const background = ats ? '#ffffff' : modern ? '#f8f6f1' : '#ffffff';
  const experience = '<section style="margin-top:26px"><h2 style="margin:0 0 10px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:' + accent + ';border-bottom:1px solid ' + (ats ? '#111' : '#d9d2c5') + ';padding-bottom:6px">Experience</h2>' +
    '<div style="margin-bottom:18px"><div style="display:flex;justify-content:space-between;gap:20px;align-items:baseline"><h3 style="margin:0;font-size:16px;font-weight:650;color:' + body + '">Senior Product Designer</h3><span style="font-size:11px;color:' + muted + '">2022 — Now</span></div><div style="font-size:12px;color:' + muted + ';margin:2px 0 8px">Northstar Labs</div><ul style="margin:0;padding-left:17px;color:' + body + ';font-size:12.5px;line-height:1.6"><li>Led the redesign of a B2B analytics workspace used by 40k operators.</li><li>Built a design system that cut feature delivery time by 35%.</li><li>Partnered with research and engineering to ship a zero-to-one AI assistant.</li></ul></div>' +
    '<div style="margin-bottom:18px"><div style="display:flex;justify-content:space-between;gap:20px;align-items:baseline"><h3 style="margin:0;font-size:16px;font-weight:650;color:' + body + '">Product Designer</h3><span style="font-size:11px;color:' + muted + '">2019 — 2022</span></div><div style="font-size:12px;color:' + muted + ';margin:2px 0 8px">Acme Studio</div><ul style="margin:0;padding-left:17px;color:' + body + ';font-size:12.5px;line-height:1.6"><li>Shipped the mobile onboarding flow, improving activation by 18%.</li><li>Facilitated cross-functional design sprints for enterprise clients.</li></ul></div></section>';
  const education = '<section style="margin-top:22px"><h2 style="margin:0 0 10px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:' + accent + ';border-bottom:1px solid ' + (ats ? '#111' : '#d9d2c5') + ';padding-bottom:6px">Education</h2><div style="display:flex;justify-content:space-between;gap:20px"><div><div style="font-size:14px;font-weight:600;color:' + body + '">BFA, Interaction Design</div><div style="font-size:12px;color:' + muted + '">Rhode Island School of Design</div></div><div style="font-size:11px;color:' + muted + '">2015 — 2019</div></div></section>';
  const skills = '<section style="margin-top:22px"><h2 style="margin:0 0 10px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:' + accent + ';border-bottom:1px solid ' + (ats ? '#111' : '#d9d2c5') + ';padding-bottom:6px">Skills</h2><p style="margin:0;font-size:12.5px;line-height:1.7;color:' + body + '">Product strategy · Interaction design · Design systems · Prototyping · HTML/CSS · AI-native workflows · Figma · User research</p></section>';
  if (ats) {
    return '<style>html,body{margin:0;width:100%;height:100%;background:#fff}*{box-sizing:border-box}article{font-family:Arial,Helvetica,sans-serif;color:#111;padding:52px 58px;width:100%;height:100%;background:#fff}</style>' +
      '<article><header style="border-bottom:2px solid #111;padding-bottom:14px"><h1 style="margin:0;font-size:30px;letter-spacing:-.02em">' + name + '</h1><div style="margin-top:4px;font-size:13px">Senior Product Designer</div><div style="margin-top:6px;font-size:11px;color:#111">alex.morgan@example.com · +1 555 010 2030 · Portland, OR · linkedin.com/in/alexmorgan</div></header>' +
      '<section style="margin-top:22px"><h2 style="margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase">Summary</h2><p style="margin:0;font-size:12.5px;line-height:1.6">Product designer with 8+ years shipping data-heavy B2B and AI products. Comfortable owning research, interaction, design systems, and front-end prototypes.</p></section>' +
      experience + education + skills + '</article>';
  }
  return '<style>html,body{margin:0;width:100%;height:100%;background:' + background + '}*{box-sizing:border-box}article{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:' + body + ';width:100%;height:100%;background:' + background + ';padding:' + (modern ? '56px 54px' : '52px 58px') + '}</style>' +
    '<article><header style="display:' + (modern ? 'grid;grid-template-columns:1.25fr .75fr;gap:28px;align-items:end' : 'block') + ';border-bottom:1px solid ' + (modern ? '#d9d2c5' : '#d9d2c5') + ';padding-bottom:18px">' +
    '<div><div style="font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:' + accent + ';margin-bottom:10px">Résumé · 2026</div><h1 style="margin:0;font-family:Georgia,serif;font-weight:500;font-size:44px;line-height:1;letter-spacing:-.04em;color:' + accent + '">' + name + '</h1><div style="margin-top:8px;font-size:14px;color:' + muted + '">Senior Product Designer</div></div>' +
    '<div style="font-size:11px;line-height:1.85;color:' + muted + ';text-align:left"><div>alex.morgan@example.com</div><div>+1 555 010 2030</div><div>Portland, OR</div><div>linkedin.com/in/alexmorgan</div></div></header>' + experience + education + skills + '</article>';
}

export function posterTemplateHtml(template: string, title: string): string {
  const heading = esc(title || (template === 'poster-event' ? 'The Future of Making' : 'A better way to build'));
  if (template === 'poster-event') {
    return '<style>html,body{margin:0;width:100%;height:100%}*{box-sizing:border-box}.poster{position:relative;width:100%;height:100%;padding:70px 64px 56px;background:#171923;color:#f8f7f3;font-family:Inter,sans-serif;overflow:hidden}.poster .orb{position:absolute;right:-120px;top:-80px;width:560px;height:560px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#8b5cf6,#312e81 62%,transparent 70%);opacity:.8}.poster .eyebrow{position:relative;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#a78bfa}.poster h1{position:relative;margin:34px 0 18px;max-width:820px;font-family:Georgia,serif;font-weight:500;font-size:92px;line-height:.95;letter-spacing:-.055em}.poster .lede{position:relative;max-width:540px;font-size:20px;line-height:1.5;color:#c7cbd5}.poster .meta{position:absolute;left:64px;right:64px;bottom:52px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px;border-top:1px solid rgba(255,255,255,.18);padding-top:20px}.poster .meta b{display:block;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#8b93a3;margin-bottom:6px}.poster .meta span{font-size:16px;color:#f8f7f3}.poster .mark{position:relative;margin-top:28px;display:inline-flex;align-items:center;gap:10px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#c7cbd5}.poster .dotmark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(135deg,#7c3aed,#2563eb)}</style>' +
      '<div class="poster"><div class="orb"></div><div class="eyebrow">Conference · 2026</div><h1>' + heading + '</h1><p class="lede">A one-day gathering for designers, engineers, and researchers building the next generation of creative tools.</p><div class="mark"><span class="dotmark">H</span> Hadamard Studio</div><div class="meta"><div><b>Date</b><span>18 September 2026</span></div><div><b>Location</b><span>Portland, OR</span></div><div><b>Seats</b><span>Limited · 120</span></div></div></div>';
  }
  return '<style>html,body{margin:0;width:100%;height:100%}*{box-sizing:border-box}.poster{width:100%;height:100%;padding:76px 64px 60px;background:#f6f4ef;color:#1f2430;font-family:Inter,sans-serif;display:flex;flex-direction:column;overflow:hidden}.poster .eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#8a8276}.poster h1{margin:22px 0 12px;max-width:850px;font-family:Georgia,serif;font-weight:500;font-size:96px;line-height:.94;letter-spacing:-.055em}.poster p{margin:0;max-width:600px;font-size:21px;line-height:1.5;color:#5d584e}.poster .art{flex:1;margin:34px 0 26px;min-height:250px;border-radius:28px;background:radial-gradient(circle at 70% 30%,#c4b5fd,#a78bfa 38%,#7c3aed 70%,#4c1d95);position:relative;overflow:hidden}.poster .art:before{content:"";position:absolute;inset:28px;border:1px solid rgba(255,255,255,.4);border-radius:20px}.poster .art:after{content:"↗";position:absolute;right:44px;bottom:32px;font-size:54px;color:rgba(255,255,255,.85)}.poster .foot{display:flex;justify-content:space-between;align-items:end;gap:20px;border-top:1px solid #d9d2c5;padding-top:18px;font-size:12px;color:#8a8276}.poster .foot b{display:block;color:#1f2430;font-size:15px;margin-bottom:3px}.poster .cta{padding:11px 18px;border-radius:999px;background:#1f2430;color:#fff;font-size:12px;letter-spacing:.04em}</style>' +
    '<div class="poster"><div class="eyebrow">Product · 2026</div><h1>' + heading + '</h1><p>An AI-native canvas for ideas, documents, and the people who make them.</p><div class="art"></div><div class="foot"><div><b>Hadamard Canvas</b>One canvas. Humans and agents.</div><div class="cta">Start creating →</div></div></div>';
}

export function canvasTemplateBlocks(template: string, width: number, height: number): HcBlock[] {
  const blocks: HcBlock[] = [];
  const push = (block: HcBlock): void => { blocks.push({ ...block, id: genId('block'), z: blocks.length }); };
  if (template === 'canvas-cover') {
    push({ id: '', type: 'shape', x: width - 360, y: 0, w: 360, h: height, z: 0, name: 'Accent panel', shape: 'rect', style: { fill: '#efe9ff' } });
    push({ id: '', type: 'text', x: 72, y: 190, w: 800, h: 190, z: 1, name: 'Title', text: 'A clear idea,\ntold well.', style: { fontSize: 72, fontWeight: 600, color: '#1f2430', fontFamily: 'Georgia, serif' } });
    push({ id: '', type: 'text', x: 76, y: 410, w: 640, h: 90, z: 2, name: 'Subtitle', text: 'Double-click to edit this subtitle. Export as editable PowerPoint from the Export menu.', style: { fontSize: 20, color: '#5d584e' } });
    push({ id: '', type: 'text', x: 76, y: 640, w: 400, h: 36, z: 3, name: 'Footer', text: 'HADAMARD CANVAS · 2026', style: { fontSize: 12, fontWeight: 600, color: '#a39b8c' } });
    return blocks;
  }
  push({ id: '', type: 'shape', x: 0, y: 0, w: width, h: 78, z: 0, name: 'Top band', shape: 'rect', style: { fill: '#1f2430' } });
  push({ id: '', type: 'text', x: 64, y: 130, w: 860, h: 90, z: 1, name: 'Title', text: 'A practical framework', style: { fontSize: 50, fontWeight: 600, color: '#1f2430', fontFamily: 'Georgia, serif' } });
  push({ id: '', type: 'text', x: 64, y: 250, w: 680, h: 290, z: 2, name: 'Body', text: '• Replace this text with the argument.\n• Keep one idea per slide.\n• Use speaker notes for the narrative.\n• Export to PowerPoint to keep text editable.', style: { fontSize: 22, color: '#3f4552' } });
  push({ id: '', type: 'shape', x: 820, y: 190, w: 360, h: 360, z: 3, name: 'Card', shape: 'rect', style: { fill: '#f3e8ff', stroke: '#a855f7', strokeWidth: 1, radius: 24 } });
  push({ id: '', type: 'text', x: 850, y: 230, w: 300, h: 280, z: 4, name: 'Card copy', text: 'Key takeaway\n\nSmall visual systems beat one-off slides.', style: { fontSize: 20, color: '#4c1d95' } });
  return blocks;
}

export function pageTemplateHtml(template: string, title: string): string {
  if (template.startsWith('resume-')) return resumeTemplateHtml(template, title);
  if (template.startsWith('poster-')) return posterTemplateHtml(template, title);
  return slideTemplateHtml(template, title);
}

export function slideTemplateHtml(template: string, title: string): string {
  const head = '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}*{box-sizing:border-box}.tpl{width:100%;height:100%;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#1f2430}.kicker{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#8a8276}.serif{font-family:Georgia,"Times New Roman",serif;font-weight:500;letter-spacing:-.04em}';
  if (template === 'cover') {
    return head + '</style><div class="tpl" style="padding:74px 82px;display:flex;flex-direction:column;background:#f6f4ef"><div class="kicker">Hadamard Canvas · presentation</div><h1 class="serif" style="margin:auto 0 0;max-width:860px;font-size:72px;line-height:1.02;color:#1f2430">' + esc(title || 'A clear idea, told well.') + '</h1><p style="margin:22px 0 0;max-width:620px;font-size:19px;line-height:1.6;color:#5d584e">Double-click to edit this subtitle. Use the source tab for custom HTML and CSS.</p><div style="margin-top:auto;display:flex;justify-content:space-between;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#a39b8c"><span>Hadamard Canvas</span><span>2026</span></div></div>';
  }
  if (template === 'section') {
    return head + '</style><div class="tpl" style="padding:74px 82px;display:flex;flex-direction:column;justify-content:space-between;background:#171923;color:#f8f7f3"><div class="kicker" style="color:#a78bfa">Section 02</div><h1 class="serif" style="margin:0;font-size:88px;line-height:.98;max-width:900px">' + esc(title || 'The next section') + '</h1><div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#8b93a3">Hadamard Canvas · presentation</div></div>';
  }
  if (template === 'two-col') {
    return head + '</style><div class="tpl" style="padding:64px 72px;display:flex;flex-direction:column;background:#ffffff"><div class="kicker">A practical framework</div><h1 class="serif" style="margin:10px 0 30px;font-size:52px;line-height:1.02">' + esc(title || 'What we will cover') + '</h1><div style="display:grid;grid-template-columns:1.35fr .8fr;gap:42px;flex:1"><div style="font-size:17px;line-height:1.75;color:#4b5160"><p style="margin:0 0 14px">Replace this paragraph with the argument. Keep one idea per slide, then use the speaker notes for the narrative.</p><p style="margin:14px 0"><strong style="color:#1f2430">Direct manipulation:</strong> click text to edit, use the style panel for type and color.</p><p style="margin:0"><strong style="color:#1f2430">Agent access:</strong> hcanvas read/patch keeps the same document in sync.</p></div><div style="padding:24px;border:1px solid #e7e0d2;border-radius:16px;background:#fbfaf7"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8a8276;margin-bottom:12px">Key takeaway</div><p style="margin:0;font-size:18px;line-height:1.5;color:#2e2a24">Small visual systems beat one-off slides.</p></div></div></div>';
  }
  if (template === 'quote') {
    return head + '</style><div class="tpl" style="padding:80px 100px;display:flex;flex-direction:column;justify-content:center;background:#f1f5ff"><div class="serif" style="font-size:130px;line-height:.6;color:#c7d2fe">“</div><p class="serif" style="margin:30px 0 22px;max-width:990px;font-size:52px;line-height:1.15;color:#1e3a8a">The best tools disappear into the work.</p><div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#64748b">— A design principle</div></div>';
  }
  return head + '</style><div class="tpl" style="padding:64px 76px;display:flex;flex-direction:column;background:#fbfaf7"><div class="kicker">Agenda</div><h1 class="serif" style="margin:10px 0 26px;font-size:54px;line-height:1.02">' + esc(title || 'What we will cover') + '</h1><ol style="margin:0;padding:0;list-style:none;display:grid;gap:12px;font-size:19px;color:#2e2a24"><li style="display:grid;grid-template-columns:54px 1fr;gap:14px;border-top:1px solid #e7e0d2;padding-top:12px"><span style="font-family:Georgia,serif;color:#7c3aed">01</span><span>The problem</span></li><li style="display:grid;grid-template-columns:54px 1fr;gap:14px;border-top:1px solid #e7e0d2;padding-top:12px"><span style="font-family:Georgia,serif;color:#7c3aed">02</span><span>The approach</span></li><li style="display:grid;grid-template-columns:54px 1fr;gap:14px;border-top:1px solid #e7e0d2;padding-top:12px"><span style="font-family:Georgia,serif;color:#7c3aed">03</span><span>What changes</span></li><li style="display:grid;grid-template-columns:54px 1fr;gap:14px;border-top:1px solid #e7e0d2;padding-top:12px"><span style="font-family:Georgia,serif;color:#7c3aed">04</span><span>Next steps</span></li></ol></div>';
}
