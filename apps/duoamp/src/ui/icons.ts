/**
 * Transport and UI icons, drawn for this project as pixel-grid SVG
 * (shape-rendering: crispEdges). Coordinates are in icon pixels.
 */
const S = (w: number, h: number, body: string) =>
  `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges" fill="currentColor">${body}</svg>`;

function fromRows(rows: string[]): string {
  let out = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === '#') {
        let e = x;
        while (e < row.length && row[e] === '#') e++;
        out += `<rect x="${x}" y="${y}" width="${e - x}" height="1"/>`;
        x = e;
      } else x++;
    }
  });
  return S(rows[0].length, rows.length, out);
}

export const ICONS = {
  prev: fromRows([
    '##....#....#',
    '##...##...##',
    '##..###..###',
    '##.####.####',
    '##..###..###',
    '##...##...##',
    '##....#....#',
  ]),
  play: fromRows([
    '#.....',
    '##....',
    '###...',
    '####..',
    '#####.',
    '####..',
    '###...',
    '##....',
    '#.....',
  ]),
  pause: fromRows([
    '###.###',
    '###.###',
    '###.###',
    '###.###',
    '###.###',
    '###.###',
    '###.###',
    '###.###',
    '###.###',
  ]),
  stop: fromRows([
    '########',
    '########',
    '########',
    '########',
    '########',
    '########',
    '########',
    '########',
  ]),
  next: fromRows([
    '#....#....##',
    '##...##...##',
    '###..###..##',
    '####.####.##',
    '###..###..##',
    '##...##...##',
    '#....#....##',
  ]),
  eject: fromRows([
    '.....##.....',
    '....####....',
    '...######...',
    '..########..',
    '.##########.',
    '############',
    '............',
    '############',
    '############',
  ]),
  menu: fromRows([
    '#######',
    '.......',
    '#######',
    '.......',
    '#######',
    '.......',
    '#######',
  ]),
  close: fromRows([
    '##...##',
    '.##.##.',
    '..###..',
    '.##.##.',
    '##...##',
  ]),
};
