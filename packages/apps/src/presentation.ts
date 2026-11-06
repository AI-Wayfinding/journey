// Only fixed, local SVG paths are returned. Caller text never becomes markup.
const paths: Record<string, string> = {
  markdown: 'M4 5h16v14H4z M7 15V9l3 3 3-3v6 M16 9v6m-2-2 2 2 2-2',
  html: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
  pdf: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6m-6 4h6',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
  image: 'M3 4h18v16H3z M3 17l6-7 5 5 3-3 4 5 M15 8h.01',
  video: 'M3 5h18v14H3z m7 4 5 3-5 3z',
  audio: 'M9 18V5l11-2v13 M9 8l11-2 M9 18c0 4-6 4-6 1s6-4 6-1 M20 16c0 4-6 4-6 1s6-4 6-1',
  data: 'M3 4h18v16H3z M3 9h18M3 14h18M9 4v16',
  link: 'm10 13 4-4 M8 16H6a4 4 0 0 1 0-8h4 M14 8h4a4 4 0 0 1 0 8h-4',
  skill: 'm12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z',
  prompt: 'M4 4h16v13H9l-5 4z M8 8h8m-8 4h5',
  agent: 'M5 7h14v13H5z M12 3v4 M9 12h.01M15 12h.01 M9 16h6 M2 11v5m20-5v5',
  applet: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  other: 'M6 3h8l4 4v14H6z M14 3v5h4',
};
export function kindPath(kind: string): string { return paths[kind] ?? paths.other!; }
export function kindIcon(kind: string): string {
  return `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[kind] ?? paths.other}"/></svg>`;
}
export const roundStages = ['planned', 'open', 'synthesising', 'closed'] as const;
