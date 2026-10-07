/**
 * Marker glyphs, drawn as strokes in a 16-unit box so they stay crisp at any
 * device pixel ratio. Each glyph is a tiny drawing routine; the marker
 * sprite cache rasterises them once per colour.
 */

type Glyph = (g: CanvasRenderingContext2D) => void;

const line = (g: CanvasRenderingContext2D, points: [number, number][]): void => {
  g.beginPath();
  points.forEach(([x, y], index) => (index === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.stroke();
};

const rect = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void => {
  g.strokeRect(x, y, w, h);
};

const circle = (g: CanvasRenderingContext2D, x: number, y: number, r: number, fill = false): void => {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  if (fill) g.fill();
  else g.stroke();
};

export const GLYPHS: Readonly<Record<string, Glyph>> = {
  fork: (g) => { line(g, [[5, 3], [5, 13]]); line(g, [[3, 3], [3, 6], [7, 6], [7, 3]]); line(g, [[11, 3], [11, 13]]); g.beginPath(); g.ellipse(11, 5.5, 1.6, 2.6, 0, 0, Math.PI * 2); g.stroke(); },
  burger: (g) => { g.beginPath(); g.arc(8, 8, 5, Math.PI, 0); g.stroke(); line(g, [[3, 9.5], [13, 9.5]]); line(g, [[3.5, 12], [12.5, 12]]); },
  cup: (g) => { rect(g, 3, 6, 8, 6); g.beginPath(); g.arc(12, 9, 2, -Math.PI / 2, Math.PI / 2); g.stroke(); line(g, [[5, 3], [5, 4.5]]); line(g, [[8, 3], [8, 4.5]]); },
  glass: (g) => { line(g, [[3, 3], [13, 3], [8, 9], [3, 3]]); line(g, [[8, 9], [8, 13]]); line(g, [[5, 13], [11, 13]]); },
  bread: (g) => { g.beginPath(); g.ellipse(8, 9, 6, 4, -0.3, 0, Math.PI * 2); g.stroke(); line(g, [[5, 8], [6.5, 10]]); line(g, [[8, 7], [9.5, 9]]); line(g, [[11, 6.5], [12, 8]]); },
  meat: (g) => { g.beginPath(); g.ellipse(7, 8, 4.5, 3.5, 0.5, 0, Math.PI * 2); g.stroke(); line(g, [[10, 10], [13.5, 13.5]]); },
  cart: (g) => { line(g, [[2, 3], [4, 3], [6, 10], [13, 10], [14, 5], [5, 5]]); circle(g, 7, 13, 1.1, true); circle(g, 12, 13, 1.1, true); },
  basket: (g) => { line(g, [[2.5, 7], [13.5, 7], [12, 13], [4, 13], [2.5, 7]]); line(g, [[5, 7], [8, 3], [11, 7]]); },
  bottle: (g) => { line(g, [[7, 2], [9, 2]]); line(g, [[7, 2], [7, 5], [5.5, 7], [5.5, 14], [10.5, 14], [10.5, 7], [9, 5], [9, 2]]); },
  leaf: (g) => { g.beginPath(); g.moveTo(3, 13); g.quadraticCurveTo(3, 3, 13, 3); g.quadraticCurveTo(13, 13, 3, 13); g.stroke(); line(g, [[3, 13], [10, 6]]); },
  cross: (g) => { g.lineWidth *= 1.6; line(g, [[8, 3], [8, 13]]); line(g, [[3, 8], [13, 8]]); },
  plus: (g) => { line(g, [[8, 4], [8, 12]]); line(g, [[4, 8], [12, 8]]); },
  stethoscope: (g) => { line(g, [[4, 3], [4, 7]]); line(g, [[9, 3], [9, 7]]); g.beginPath(); g.arc(6.5, 7, 2.5, 0, Math.PI); g.stroke(); line(g, [[6.5, 9.5], [6.5, 12]]); g.beginPath(); g.arc(9.5, 12, 3, Math.PI, 0, true); g.stroke(); circle(g, 12.5, 9, 1.4); },
  tooth: (g) => { g.beginPath(); g.moveTo(4, 4); g.quadraticCurveTo(8, 2, 12, 4); g.lineTo(11, 13); g.lineTo(9, 9); g.lineTo(7, 9); g.lineTo(5, 13); g.closePath(); g.stroke(); },
  hospital: (g) => { rect(g, 2.5, 2.5, 11, 11); g.lineWidth *= 1.4; line(g, [[8, 5], [8, 11]]); line(g, [[5, 8], [11, 8]]); },
  paw: (g) => { circle(g, 8, 10.5, 2.6); circle(g, 4.5, 6.5, 1.2, true); circle(g, 7, 4.5, 1.2, true); circle(g, 9.5, 4.5, 1.2, true); circle(g, 12, 6.5, 1.2, true); },
  home: (g) => { line(g, [[2.5, 8], [8, 3], [13.5, 8]]); line(g, [[4, 7], [4, 13], [12, 13], [12, 7]]); },
  flask: (g) => { line(g, [[6, 2.5], [6, 7], [3, 13], [13, 13], [10, 7], [10, 2.5]]); line(g, [[5, 2.5], [11, 2.5]]); },
  shield: (g) => { g.beginPath(); g.moveTo(8, 2.5); g.lineTo(13, 4.5); g.lineTo(12.5, 9); g.quadraticCurveTo(11, 12.5, 8, 14); g.quadraticCurveTo(5, 12.5, 3.5, 9); g.lineTo(3, 4.5); g.closePath(); g.stroke(); },
  flame: (g) => { g.beginPath(); g.moveTo(8, 2.5); g.quadraticCurveTo(13, 7, 11.5, 11); g.quadraticCurveTo(10, 14, 8, 14); g.quadraticCurveTo(6, 14, 4.5, 11); g.quadraticCurveTo(3.5, 8, 6, 6); g.quadraticCurveTo(7, 9, 8, 9); g.quadraticCurveTo(7, 6, 8, 2.5); g.stroke(); },
  bed: (g) => { line(g, [[2.5, 4], [2.5, 13]]); line(g, [[2.5, 10], [13.5, 10], [13.5, 13]]); line(g, [[6, 10], [6, 7], [13.5, 7], [13.5, 10]]); circle(g, 4.3, 7.7, 1); },
  tent: (g) => { line(g, [[2, 13], [8, 3], [14, 13], [2, 13]]); line(g, [[8, 13], [8, 8]]); },
  fuel: (g) => { rect(g, 3, 3, 6, 10); line(g, [[3, 7], [9, 7]]); line(g, [[9, 5], [12, 7], [12, 11], [13, 11], [13, 6]]); },
  bolt: (g) => { line(g, [[9, 2], [4, 9], [8, 9], [7, 14], [12, 7], [8, 7], [9, 2]]); },
  parking: (g) => { g.font = "bold 11px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("P", 8, 8.5); },
  wrench: (g) => { line(g, [[4, 12], [10, 6]]); g.beginPath(); g.arc(11, 5, 2.5, 0.6, 5.2); g.stroke(); circle(g, 4, 12, 1.2, true); },
  car: (g) => { line(g, [[2.5, 10], [2.5, 8], [4.5, 5], [11.5, 5], [13.5, 8], [13.5, 10], [2.5, 10]]); circle(g, 5, 11.5, 1.3, true); circle(g, 11, 11.5, 1.3, true); },
  train: (g) => { rect(g, 4, 2.5, 8, 9); line(g, [[4, 7], [12, 7]]); line(g, [[5, 14], [6.5, 11.5]]); line(g, [[11, 14], [9.5, 11.5]]); },
  bus: (g) => { rect(g, 3, 2.5, 10, 9.5); line(g, [[3, 7.5], [13, 7.5]]); circle(g, 5.5, 13.5, 1, true); circle(g, 10.5, 13.5, 1, true); },
  plane: (g) => { line(g, [[8, 2], [8, 14]]); line(g, [[2, 9], [8, 6], [14, 9]]); line(g, [[5.5, 14], [8, 12], [10.5, 14]]); },
  bank: (g) => { line(g, [[2, 6], [8, 2.5], [14, 6], [2, 6]]); line(g, [[4, 7], [4, 12]]); line(g, [[8, 7], [8, 12]]); line(g, [[12, 7], [12, 12]]); line(g, [[2, 13.5], [14, 13.5]]); },
  cash: (g) => { rect(g, 2, 4.5, 12, 7); circle(g, 8, 8, 2); },
  umbrella: (g) => { g.beginPath(); g.arc(8, 8, 6, Math.PI, 0); g.closePath(); g.stroke(); line(g, [[8, 8], [8, 13], [6.5, 13]]); },
  mail: (g) => { rect(g, 2.5, 4, 11, 8); line(g, [[2.5, 4], [8, 9], [13.5, 4]]); },
  flag: (g) => { line(g, [[4, 2.5], [4, 14]]); line(g, [[4, 3], [13, 3], [11, 6], [13, 9], [4, 9]]); },
  school: (g) => { line(g, [[1.5, 6], [8, 3], [14.5, 6], [8, 9], [1.5, 6]]); line(g, [[4.5, 7.5], [4.5, 11], [8, 13], [11.5, 11], [11.5, 7.5]]); },
  child: (g) => { circle(g, 8, 4.5, 2); line(g, [[8, 6.5], [8, 10.5]]); line(g, [[4.5, 8], [11.5, 8]]); line(g, [[8, 10.5], [5.5, 14]]); line(g, [[8, 10.5], [10.5, 14]]); },
  book: (g) => { line(g, [[8, 4], [8, 13]]); line(g, [[8, 4], [2.5, 3], [2.5, 12], [8, 13], [13.5, 12], [13.5, 3], [8, 4]]); },
  museum: (g) => { line(g, [[2, 6], [8, 2.5], [14, 6]]); line(g, [[3.5, 7], [3.5, 12]]); line(g, [[6.5, 7], [6.5, 12]]); line(g, [[9.5, 7], [9.5, 12]]); line(g, [[12.5, 7], [12.5, 12]]); line(g, [[2, 13.5], [14, 13.5]]); },
  film: (g) => { rect(g, 2.5, 3, 11, 10); line(g, [[5, 3], [5, 13]]); line(g, [[11, 3], [11, 13]]); },
  mask: (g) => { g.beginPath(); g.moveTo(2.5, 4); g.lineTo(13.5, 4); g.quadraticCurveTo(13.5, 13, 8, 13); g.quadraticCurveTo(2.5, 13, 2.5, 4); g.stroke(); circle(g, 5.5, 7.5, 1, true); circle(g, 10.5, 7.5, 1, true); },
  church: (g) => { line(g, [[8, 1.5], [8, 5]]); line(g, [[6.5, 3], [9.5, 3]]); line(g, [[4, 14], [4, 8], [8, 5], [12, 8], [12, 14], [4, 14]]); },
  grave: (g) => { g.beginPath(); g.moveTo(4, 14); g.lineTo(4, 6); g.arc(8, 6, 4, Math.PI, 0); g.lineTo(12, 14); g.closePath(); g.stroke(); line(g, [[8, 7], [8, 11]]); line(g, [[6.5, 8.5], [9.5, 8.5]]); },
  star: (g) => { line(g, [[8, 2], [9.8, 6.2], [14.2, 6.4], [10.8, 9.2], [12, 13.6], [8, 11], [4, 13.6], [5.2, 9.2], [1.8, 6.4], [6.2, 6.2], [8, 2]]); },
  castle: (g) => { line(g, [[2.5, 14], [2.5, 4], [4.5, 4], [4.5, 6], [6.5, 6], [6.5, 4], [9.5, 4], [9.5, 6], [11.5, 6], [11.5, 4], [13.5, 4], [13.5, 14], [2.5, 14]]); line(g, [[7, 14], [7, 10], [9, 10], [9, 14]]); },
  monument: (g) => { line(g, [[6.5, 13], [7.3, 2.5], [8.7, 2.5], [9.5, 13]]); line(g, [[4, 13.5], [12, 13.5]]); },
  info: (g) => { circle(g, 8, 4, 1.1, true); line(g, [[8, 7], [8, 13]]); line(g, [[6.5, 13], [9.5, 13]]); },
  tree: (g) => { circle(g, 8, 6.5, 4.5); line(g, [[8, 11], [8, 14.5]]); },
  ball: (g) => { circle(g, 8, 8, 5.5); g.beginPath(); g.arc(2, 8, 5.5, -0.9, 0.9); g.stroke(); g.beginPath(); g.arc(14, 8, 5.5, Math.PI - 0.9, Math.PI + 0.9); g.stroke(); },
  swim: (g) => { circle(g, 11, 4.5, 1.6, true); line(g, [[3, 8.5], [9, 6.5], [11, 9]]); g.beginPath(); for (let x = 2; x <= 14; x += 0.5) { const y = 12 + Math.sin(x * 1.3); if (x === 2) g.moveTo(x, y); else g.lineTo(x, y); } g.stroke(); },
  dumbbell: (g) => { line(g, [[4, 8], [12, 8]]); rect(g, 2, 5, 2.5, 6); rect(g, 11.5, 5, 2.5, 6); },
  scissors: (g) => { circle(g, 5, 11.5, 2); circle(g, 11, 11.5, 2); line(g, [[6.3, 10], [12, 2.5]]); line(g, [[9.7, 10], [4, 2.5]]); },
  sparkle: (g) => { line(g, [[8, 2], [8, 14]]); line(g, [[2, 8], [14, 8]]); line(g, [[4.5, 4.5], [11.5, 11.5]]); line(g, [[11.5, 4.5], [4.5, 11.5]]); },
  shirt: (g) => { line(g, [[5.5, 2.5], [2, 5], [3.5, 8], [5, 7], [5, 14], [11, 14], [11, 7], [12.5, 8], [14, 5], [10.5, 2.5], [8, 4.5], [5.5, 2.5]]); },
  shoe: (g) => { line(g, [[2.5, 5], [6, 5], [7.5, 9], [13, 10.5], [13.5, 13], [2.5, 13], [2.5, 5]]); },
  flower: (g) => { circle(g, 8, 6, 1.5, true); circle(g, 5.5, 4.5, 1.8); circle(g, 10.5, 4.5, 1.8); circle(g, 5.5, 7.5, 1.8); circle(g, 10.5, 7.5, 1.8); line(g, [[8, 8], [8, 14]]); },
  key: (g) => { circle(g, 5, 8, 2.8); line(g, [[7.8, 8], [14, 8]]); line(g, [[11.5, 8], [11.5, 10.5]]); line(g, [[13.5, 8], [13.5, 10]]); },
  scale: (g) => { line(g, [[8, 2.5], [8, 13.5]]); line(g, [[3, 5], [13, 5]]); line(g, [[5, 13.5], [11, 13.5]]); g.beginPath(); g.arc(3, 9, 2, 0, Math.PI); g.stroke(); g.beginPath(); g.arc(13, 9, 2, 0, Math.PI); g.stroke(); line(g, [[1, 9], [3, 5], [5, 9]]); line(g, [[11, 9], [13, 5], [15, 9]]); },
  chart: (g) => { line(g, [[2.5, 2.5], [2.5, 13.5], [13.5, 13.5]]); line(g, [[4, 11], [7, 7], [9.5, 9], [13, 4]]); },
  ruler: (g) => { line(g, [[2.5, 13.5], [13.5, 2.5], [13.5, 13.5], [2.5, 13.5]]); line(g, [[9, 13.5], [9, 11]]); line(g, [[11.5, 13.5], [11.5, 11]]); },
  chip: (g) => { rect(g, 4, 4, 8, 8); for (const p of [6, 8, 10]) { line(g, [[p, 2], [p, 4]]); line(g, [[p, 12], [p, 14]]); line(g, [[2, p], [4, p]]); line(g, [[12, p], [14, p]]); } },
  briefcase: (g) => { rect(g, 2.5, 5, 11, 8); line(g, [[6, 5], [6, 3], [10, 3], [10, 5]]); line(g, [[2.5, 8.5], [13.5, 8.5]]); },
  hammer: (g) => { line(g, [[3, 13.5], [9.5, 7]]); line(g, [[7.5, 3], [13, 8.5]]); line(g, [[7.5, 3], [9.5, 2.5], [13.5, 6.5], [13, 8.5]]); },
  factory: (g) => { line(g, [[2, 14], [2, 7], [6, 9.5], [6, 7], [10, 9.5], [10, 3], [13, 3], [13, 14], [2, 14]]); },
  box: (g) => { rect(g, 3, 5, 10, 8.5); line(g, [[3, 5], [5, 2.5], [11, 2.5], [13, 5]]); line(g, [[8, 5], [8, 8]]); },
  bag: (g) => { rect(g, 3, 5.5, 10, 8.5); g.beginPath(); g.arc(8, 5.5, 2.5, Math.PI, 0); g.stroke(); },
  sofa: (g) => { line(g, [[2.5, 12], [2.5, 7], [4.5, 7], [4.5, 9], [11.5, 9], [11.5, 7], [13.5, 7], [13.5, 12], [2.5, 12]]); line(g, [[4.5, 7], [4.5, 4.5], [11.5, 4.5], [11.5, 7]]); },
  glasses: (g) => { circle(g, 4.5, 9, 2.6); circle(g, 11.5, 9, 2.6); line(g, [[7.1, 9], [8.9, 9]]); line(g, [[1.9, 9], [1.5, 5.5]]); line(g, [[14.1, 9], [14.5, 5.5]]); },
  gem: (g) => { line(g, [[4, 3], [12, 3], [14.5, 6.5], [8, 14], [1.5, 6.5], [4, 3]]); line(g, [[1.5, 6.5], [14.5, 6.5]]); },
  gift: (g) => { rect(g, 2.5, 6, 11, 8); line(g, [[8, 6], [8, 14]]); line(g, [[2.5, 9], [13.5, 9]]); line(g, [[8, 6], [5, 3], [4.5, 5.5], [8, 6], [11, 3], [11.5, 5.5], [8, 6]]); },
  drop: (g) => { g.beginPath(); g.moveTo(8, 2); g.quadraticCurveTo(13, 9, 11.5, 11.5); g.arc(8, 10.5, 3.7, 0.3, Math.PI - 0.3); g.quadraticCurveTo(3, 9, 8, 2); g.stroke(); },
  peak: (g) => { line(g, [[1.5, 13.5], [6.5, 4.5], [9, 8.5], [10.5, 6.5], [14.5, 13.5], [1.5, 13.5]]); },
  tower: (g) => { line(g, [[5, 14], [6.5, 6], [9.5, 6], [11, 14]]); rect(g, 4.5, 2.5, 7, 3.5); },
  dot: (g) => { circle(g, 8, 8, 2.4, true); },
};

export function drawGlyph(g: CanvasRenderingContext2D, glyph: string, x: number, y: number, size: number, color: string): void {
  const draw = GLYPHS[glyph] ?? GLYPHS.dot!;
  g.save();
  g.translate(x - size / 2, y - size / 2);
  g.scale(size / 16, size / 16);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 1.5;
  g.lineCap = "round";
  g.lineJoin = "round";
  draw(g);
  g.restore();
}
