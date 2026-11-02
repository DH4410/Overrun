/**
 * One pictogram per game mode, drawn as solid shapes so they read at tile size.
 * `.o` is an outline, `.d` a dimmed second element, `.s` a thick stroke, `.k` a cut-out (the page's dark).
 * Colour comes from the tile's CSS, so the home picker and the online lobby share the same drawings.
 */
export const MODE_ICON = {
  dm: '<circle class="o" cx="12" cy="12" r="8"/><path d="M11 1h2v6h-2zM11 17h2v6h-2zM1 11h6v2H1zM17 11h6v2h-6z"/><circle cx="12" cy="12" r="2.8"/>',
  tdm: '<circle cx="8" cy="7" r="3.4"/><path d="M2 21c0-4.4 2.7-7 6-7s6 2.6 6 7z"/><g class="d"><circle cx="17" cy="8" r="2.8"/><path d="M12.5 21c.3-3.4 2.1-5.6 4.5-5.6 3 0 5 2.2 5 5.6z"/></g>',
  hp: '<ellipse class="o" cx="12" cy="19" rx="9" ry="3.2"/><ellipse class="d" cx="12" cy="19" rx="5" ry="1.6"/><path d="M11 3h1.6v14H11z"/><path d="M12.6 3.5h8l-2.6 3 2.6 3h-8z"/>',
  gg: '<path d="M6 2.5l1.2 2.5 2.8.4-2 2 .5 2.7L6 8.7 3.5 10.1l.5-2.7-2-2 2.8-.4z"/><path d="M2 21v-4h5v-4h5V9h5V5h5v16z"/>',
  duel: '<path class="s2" d="M4 3.5l11 11M20 3.5l-11 11"/><path class="s" d="M12.4 17.2l5.2-5.2M11.6 17.2L6.4 12M15.5 15l4 4M8.5 15l-4 4"/><circle cx="20.6" cy="20.6" r="1.5"/><circle cx="3.4" cy="20.6" r="1.5"/>',
  ctf: '<path d="M5 2h2v20H5z"/><path d="M7 3h13l-3.5 4.5L20 12H7z"/><path class="d" d="M3 21h8v1.5H3z"/>',
  war: '<path d="M3 15a9 9 0 0 1 18 0v2H3z"/><path class="d" d="M2 18.5h20V21H2z"/><path class="k" d="M12 6.5l1.2 2.6 2.8.3-2.1 1.9.6 2.8-2.5-1.4-2.5 1.4.6-2.8L8 9.4l2.8-.3z"/>',
  sv: '<path d="M12 21S3 15.5 3 9a4.8 4.8 0 0 1 9-2.3A4.8 4.8 0 0 1 21 9c0 6.5-9 12-9 12z"/><path class="kl" d="M5 12h4l1.5-3 3 6 1.5-3h4"/>',
  zombie: '<path d="M12 2c4.4 0 7 3 7 7v5c0 1-.5 2-1.5 2.5V21h-3v-2h-5v2h-3v-4.5C5.5 16 5 15 5 14V9c0-4 2.6-7 7-7z"/><circle class="k" cx="9" cy="10" r="2"/><circle class="k" cx="15" cy="10" r="1.4"/><path class="kl" d="M8.5 15h7M10.5 14v2M13.5 14v2"/>',
};
MODE_ICON.survival = MODE_ICON.sv;

export const modeSvg = (id) => `<svg viewBox="0 0 24 24">${MODE_ICON[id] ?? MODE_ICON.dm}</svg>`;
